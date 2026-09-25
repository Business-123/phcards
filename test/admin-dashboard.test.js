const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Admin test server did not start.');
}

test('admin session can read operations views without exposing secrets', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-admin-test-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  // Build fixture data through the real API so the test never depends on a local data/ file.
  const signup = async (name, phone) => {
    const response = await fetch(`${baseUrl}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, phone, email: `${phone}@gmail.com`, password: 'simple' }) });
    assert.equal(response.status, 201);
    return (await response.json()).user;
  };
  const seeded = [await signup('Admin Fixture One', '0241234567'), await signup('Admin Fixture Two', '0241234568')];
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  seeded.forEach((user, index) => db.transactions.push({ id: `seed_${index}`, userId: user.id, type: 'credit', amount: 10, account: 'wallet', reference: `SEED_${index}`, status: 'completed', reason: 'Deposit', related: {}, createdAt: new Date().toISOString() }));
  // A card payment that was charged but could not be issued (sold out after the window closed).
  db.cardPayments.push({ id: 'cpay_review', transactionId: 'CARD_REVIEW_1', reference: 'CPAY_REVIEW_1', userId: seeded[0].id, cardId: 'CARD-0002', amount: 48, amountMinor: 4800, currency: 'GHS', purpose: 'CARD_PURCHASE', status: 'PAID_UNFULFILLED', authorizationUrl: 'https://checkout.example/secret', callbackUrl: 'https://app.example/?x=1', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  fs.writeFileSync(dataFile, JSON.stringify(db));
  let cookie = '';
  const request = async (pathname, options = {}) => {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, data: await response.json().catch(() => ({})) };
  };
  const unauthenticated = await request('/api/admin/summary');
  assert.equal(unauthenticated.response.status, 401);
  const login = await request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(login.response.status, 200);
  assert.equal(login.data.admin.role, 'owner');
  const summary = await request('/api/admin/summary');
  assert.equal(summary.response.status, 200);
  assert.ok(summary.data.metrics.users > 0);
  assert.equal(summary.data.metrics.paymentsNeedingReview, 1, 'paid-but-unissued card payments are flagged for a refund review');
  assert.equal(summary.data.settings.minDeposit, undefined);
  const flagged = await request('/api/admin/card-payments?status=PAID_UNFULFILLED');
  assert.equal(flagged.response.status, 200);
  assert.equal(flagged.data.items.length, 1);
  assert.equal(flagged.data.items[0].userName, 'Admin Fixture One');
  assert.equal(flagged.data.items[0].authorizationUrl, undefined, 'checkout links are not exposed');
  const users = await request('/api/admin/users?pageSize=2');
  assert.equal(users.response.status, 200);
  assert.equal(users.data.items.length, 2);
  assert.equal(users.data.items[0].passwordHash, undefined);
  assert.equal(users.data.items[0].pinHash, undefined);
  const transactions = await request('/api/admin/transactions?pageSize=2');
  assert.equal(transactions.response.status, 200);
  assert.equal(transactions.data.items[0].related.code, undefined);
  const page = await fetch(`${baseUrl}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /PHANTOM CARDS ADMIN/);
});
