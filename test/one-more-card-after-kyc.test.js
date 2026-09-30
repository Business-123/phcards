const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(e => e ? reject(e) : resolve(port)); });
  });
}
async function waitForHealth(baseUrl) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Test server did not start.');
}

async function boot(t) {
  const port = await freePort();
  const hubPort = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-onemore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const hubApiSecret = 'test-hub-api-secret';
  const hub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/v1/transaction/initialize') {
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ status: true, data: { reference: 'PCS_ONEMORE_1', checkoutUrl: `http://127.0.0.1:${hubPort}/checkout/PCS_ONEMORE_1` } }));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => hub.listen(hubPort, '127.0.0.1', r));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, HUB_BASE_URL: `http://127.0.0.1:${hubPort}`, HUB_API_KEY: 'test-hub-api-key', HUB_API_SECRET: hubApiSecret, PAYSTACK_CURRENCY: 'GHS' },
    stdio: 'ignore',
  });
  t.after(async () => { server.kill(); await new Promise(r => hub.close(r)); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const request = async (pathname, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const signup = await request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'One More', phone: '0241234501', email: 'one.more@gmail.com', password: 'simple' }) });
  assert.equal(signup.status, 201);
  const method = await request('/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'One More', phone: '0241234501', pin: '1234' }) }, signup.cookie);
  assert.equal(method.status, 201);
  const userId = signup.data.user.id;
  // Three purchased + redeemed cards = the base requirement, GHS 300 redeemed balance.
  const seed = ({ verified }) => {
    const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    for (let i = 0; i < 3; i++) {
      db.purchases.push({ id: `purchase_${i}`, userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
      db.codes.push({ id: `redeemed_${i}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
      db.transactions.push({ id: `credit_${i}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `REDEMPTION_${i}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
    }
    if (verified) { const u = db.users.find(x => x.id === userId); u.kycStatus = 'VERIFIED'; u.kycVerifiedAt = new Date().toISOString(); }
    fs.writeFileSync(dataFile, JSON.stringify(db));
  };
  const addCard = () => {
    const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    db.purchases.push({ id: `purchase_extra_${Date.now()}`, userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
    fs.writeFileSync(dataFile, JSON.stringify(db));
  };
  return { request, signup, method, userId, dataFile, hubApiSecret, seed, addCard, baseUrl };
}

const body = (h, extra = {}) => JSON.stringify({ amount: 100, methodId: h.method.data.method.id, pin: '1234', ...extra });

test('a KYC-verified user with only the base cards is rejected and told to buy one more card', { timeout: 15000 }, async t => {
  const h = await boot(t);
  h.seed({ verified: true });
  const rejected = await h.request('/api/withdrawals', { method: 'POST', body: body(h) }, h.signup.cookie);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.data.code, 'NEEDS_ONE_MORE_CARD');
  assert.match(rejected.data.error, /purchase one more card/i);
  const state = await h.request('/api/state', {}, h.signup.cookie);
  assert.equal(state.data.user.redeemedBalance, 300, 'nothing is deducted');
  assert.equal(state.data.withdrawals.length, 0, 'no withdrawal record is created');

  h.addCard();
  const ok = await h.request('/api/withdrawals', { method: 'POST', body: body(h) }, h.signup.cookie);
  assert.equal(ok.status, 201, 'after buying one more card the withdrawal goes through');
  assert.equal(ok.data.withdrawal.status, 'pending');
});

test('paying the KYC fee verifies the user, refunds the fee and rejects the withdrawal until one more card is bought', { timeout: 15000 }, async t => {
  const h = await boot(t);
  h.seed({ verified: false });
  const started = await h.request('/api/withdrawals', { method: 'POST', body: body(h, { returnOrigin: h.baseUrl }) }, h.signup.cookie);
  assert.equal(started.status, 201);
  assert.equal(started.data.kycRequired, true, 'unverified users still go to KYC first');

  const payment = JSON.parse(fs.readFileSync(h.dataFile, 'utf8')).kycBypassPayments[0];
  const raw = JSON.stringify({ event: 'transaction.completed', reference: payment.paystackReference, status: 'SUCCESS', amount: 70, currency: 'GHS', metadata: { site: 'PHANTOM_CARDS', transactionId: payment.reference, userId: h.userId, purpose: 'KYC_BYPASS' } });
  const signature = crypto.createHmac('sha512', h.hubApiSecret).update(raw).digest('hex');
  const hook = await h.request('/api/webhooks/hub', { method: 'POST', body: raw, headers: { 'x-hub-signature': signature } });
  assert.equal(hook.status, 200);

  const state = await h.request('/api/state', {}, h.signup.cookie);
  assert.equal(state.data.user.kycStatus, 'VERIFIED', 'KYC is satisfied');
  assert.equal(state.data.user.redeemedBalance, 300, 'balance untouched');
  const rejectedList = state.data.withdrawals.filter(w => !w.isRefund);
  assert.equal(rejectedList.length, 1, 'the rejection is recorded so the user can still see it after closing the page');
  assert.equal(rejectedList[0].status, 'rejected');
  assert.match(rejectedList[0].adminNote, /purchase one more card/i);
  assert.equal(state.data.withdrawals.filter(w => w.isRefund).length, 1, 'the KYC fee is refunded');

  const verify = await h.request(`/api/kyc-bypass-payments/${encodeURIComponent(payment.reference)}/verify`, { method: 'POST' }, h.signup.cookie);
  assert.equal(verify.status, 200);
  assert.equal(verify.data.withdrawal, null);
  assert.equal(verify.data.rejection.code, 'NEEDS_ONE_MORE_CARD');
  assert.match(verify.data.rejection.message, /purchase one more card/i);

  // Now verified: an immediate retry is rejected too, until the extra card is bought.
  const retry = await h.request('/api/withdrawals', { method: 'POST', body: body(h) }, h.signup.cookie);
  assert.equal(retry.status, 400);
  assert.match(retry.data.error, /purchase one more card/i);
  h.addCard();
  const ok = await h.request('/api/withdrawals', { method: 'POST', body: body(h) }, h.signup.cookie);
  assert.equal(ok.status, 201);
  assert.equal(ok.data.withdrawal.status, 'pending');
});

test('balance-paid KYC settles the fee first, then rejects until one more card is bought', { timeout: 15000 }, async t => {
  const h = await boot(t);
  h.seed({ verified: false });
  const db = JSON.parse(fs.readFileSync(h.dataFile, 'utf8'));
  db.users.find(x => x.id === h.userId).canBuyWithBalance = true;
  fs.writeFileSync(h.dataFile, JSON.stringify(db));
  const res = await h.request('/api/withdrawals', { method: 'POST', body: body(h, { kycPayWith: 'redeemed_balance' }) }, h.signup.cookie);
  assert.equal(res.status, 200);
  assert.equal(res.data.rejection.code, 'NEEDS_ONE_MORE_CARD');
  const after = JSON.parse(fs.readFileSync(h.dataFile, 'utf8'));
  assert.equal(after.kycBypassPayments.length, 1, 'the KYC fee payment was recorded before the rejection');
  const state = await h.request('/api/state', {}, h.signup.cookie);
  assert.equal(state.data.user.kycStatus, 'VERIFIED');
  assert.equal(state.data.user.redeemedBalance, 300, 'balance untouched');
  assert.equal(state.data.withdrawals.filter(w => w.isRefund).length, 1, 'fee refunded');
  const rejectedList = state.data.withdrawals.filter(w => !w.isRefund);
  assert.equal(rejectedList.length, 1, 'the rejection is recorded in the withdrawals list');
  assert.equal(rejectedList[0].status, 'rejected');
  assert.match(rejectedList[0].adminNote, /purchase one more card/i);
});
