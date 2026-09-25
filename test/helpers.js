// Shared test harness: spawns the real server against a temp data file and a mock Payment Hub.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const HUB_SECRET = 'hub-api-secret-for-tests';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw lastError || new Error('Test server did not start.');
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

// Minimal stand-in for the Payment Hub: initialize + verify.
async function startMockHub(t) {
  const port = await freePort();
  const initialized = [];
  const byReference = new Map();
  const hub = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && req.url === '/api/v1/transaction/initialize') {
      const payload = await readJson(req);
      const reference = `PCS_TEST_${initialized.length + 1}`;
      initialized.push(payload);
      byReference.set(reference, { payload, status: 'PENDING' });
      return send(201, { status: true, data: { reference, checkoutUrl: `http://127.0.0.1:${port}/checkout/${reference}` } });
    }
    const verify = /^\/api\/v1\/transaction\/verify\/([^/]+)$/.exec(req.url || '');
    if (req.method === 'GET' && verify) {
      const entry = byReference.get(decodeURIComponent(verify[1]));
      if (!entry) return send(404, { status: false, message: 'Unknown reference' });
      return send(200, { status: true, data: { reference: verify[1], status: entry.status, amount: entry.payload.amount, currency: entry.payload.currency } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => hub.listen(port, '127.0.0.1', error => (error ? reject(error) : resolve())));
  t.after(() => new Promise(resolve => hub.close(resolve)));
  return {
    port, initialized, byReference,
    setStatus(reference, status) { byReference.get(reference).status = status; },
    referenceFor(transactionId) { return [...byReference].find(([, entry]) => entry.payload.metadata.transactionId === transactionId)?.[0]; },
  };
}

// Starts the app + mock hub and returns request/signup/purchase helpers.
async function createSite(t, { env = {}, withHub = true } = {}) {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const hub = withHub ? await startMockHub(t) : null;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile,
      ...(hub ? { HUB_BASE_URL: `http://127.0.0.1:${hub.port}`, HUB_API_KEY: 'hub-api-key-for-tests', HUB_API_SECRET: HUB_SECRET } : {}),
      ...env,
    },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  const request = async (pathName, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathName}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const signup = (name, phone, email = `${phone}@gmail.com`) => request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name, phone, email, password: 'simple' }),
  });
  const readDb = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const writeDb = db => fs.writeFileSync(dataFile, JSON.stringify(db));

  // Starts a card payment (what tapping BUY does).
  const startPurchase = (cookie, cardId, idempotencyKey) => request('/api/purchases', {
    method: 'POST', body: JSON.stringify({ cardId, idempotencyKey }),
  }, cookie);
  // Delivers the hub's signed webhook for a started payment.
  const sendWebhook = async (transactionId, status = 'SUCCESS', overrides = {}) => {
    const reference = hub.referenceFor(transactionId);
    const { payload } = hub.byReference.get(reference);
    const raw = JSON.stringify({ event: 'transaction.completed', reference, status, amount: payload.amount, currency: payload.currency, metadata: payload.metadata, ...overrides });
    const signature = crypto.createHmac('sha512', HUB_SECRET).update(raw).digest('hex');
    return request('/api/webhooks/hub', { method: 'POST', body: raw, headers: { 'x-hub-signature': signature } });
  };
  // Tap BUY, pay at the hub, and return the finished purchase.
  const buyCard = async (cookie, cardId, idempotencyKey) => {
    const started = await startPurchase(cookie, cardId, idempotencyKey);
    assert.equal(started.status, 201, `payment starts: ${JSON.stringify(started.data)}`);
    const { transactionId } = started.data.payment;
    assert.equal((await sendWebhook(transactionId)).status, 200);
    const result = await request(`/api/card-payments/${encodeURIComponent(transactionId)}`, {}, cookie);
    assert.equal(result.status, 200);
    assert.equal(result.data.payment.status, 'SUCCESS');
    return { started, purchase: result.data.purchase, state: result.data.state, transactionId };
  };
  return { baseUrl, dataFile, hub, request, signup, readDb, writeDb, startPurchase, sendWebhook, buyCard };
}

module.exports = { HUB_SECRET, freePort, waitForHealth, startMockHub, createSite };
