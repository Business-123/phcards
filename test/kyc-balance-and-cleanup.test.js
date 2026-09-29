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
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
}
async function boot(t, label) {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-${label}-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const client = () => {
    let cookie = '';
    return async (pathname, options = {}) => {
      const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
      const sc = response.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { response, data: await response.json().catch(() => ({})) };
    };
  };
  return { dataFile, client };
}
async function signupWithBalance(asUser, dataFile, phone, email, balance) {
  const signup = await asUser('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'KYC Balance User', phone, email, password: 'simple' }) });
  assert.equal(signup.response.status, 201);
  const userId = signup.data.user.id;
  const method = await asUser('/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'KYC Balance User', phone, pin: '1234' }) });
  assert.equal(method.response.status, 201);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  for (let i = 0; i < 3; i++) db.purchases.push({ id: `purchase_${userId}_${i}`, userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
  db.transactions.push({ id: `credit_${userId}`, userId, type: 'credit', amount: balance, account: 'redeemed', reference: `REDEMPTION_${userId}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  fs.writeFileSync(dataFile, JSON.stringify(db));
  return { userId, methodId: method.data.method.id };
}

test('approved users can pay the KYC fee from redeemed balance; others cannot', { timeout: 25000 }, async t => {
  const { dataFile, client } = await boot(t, 'kyc-balance');
  const asUser = client(); const asAdmin = client();
  const { userId, methodId } = await signupWithBalance(asUser, dataFile, '0241234511', 'kyc.balance.one@gmail.com', 300);
  assert.equal((await asAdmin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).response.status, 200);
  const withdraw = (amount = 100) => asUser('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount, methodId, pin: '1234', kycPayWith: 'redeemed_balance' }) });

  // Not approved by an admin yet.
  assert.equal((await withdraw()).response.status, 403);
  assert.equal((await asUser('/api/state')).data.user.redeemedBalance, 300, 'nothing charged when refused');

  assert.equal((await asAdmin(`/api/admin/users/${userId}/balance-purchase`, { method: 'POST', body: JSON.stringify({ enabled: true }) })).response.status, 200);

  // Needs withdrawal + fee: 300 covers 100 + 70, but 250 + 70 does not.
  assert.equal((await withdraw(250)).response.status, 402);
  assert.equal((await asUser('/api/state')).data.user.redeemedBalance, 300);

  const paid = await withdraw(100);
  assert.equal(paid.response.status, 201);
  assert.equal(paid.data.paidWithBalance, true);
  assert.equal(paid.data.withdrawal.status, 'pending');
  assert.equal(paid.data.state.user.redeemedBalance, 130, '300 - 100 withdrawal - 70 KYC fee');
  assert.equal(paid.data.state.user.kycStatus, 'VERIFIED');

  const state = (await asUser('/api/state')).data;
  assert.equal(state.user.redeemedBalance, 130, 'ledger rebuild agrees with the live balance');
  const feeTx = state.transactions.find(item => item.reason === 'KYC bypass fee (redeemed balance)');
  assert.ok(feeTx && feeTx.account === 'redeemed' && feeTx.amount === 70);
  assert.ok(state.withdrawals.some(item => item.isRefund && item.amount === 70), 'fee refund is recorded as a separate entry');

  // Verified now: the next withdrawal needs no KYC at all.
  const next = await asUser('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: 100, methodId, pin: '1234' }) });
  assert.equal(next.response.status, 201);
  assert.equal(next.data.withdrawal.kycRequired, false);
});

test('withdrawals stuck on pending KYC are removed and their money is reversed', { timeout: 25000 }, async t => {
  const { dataFile, client } = await boot(t, 'kyc-cleanup');
  const asUser = client();
  const { userId, methodId } = await signupWithBalance(asUser, dataFile, '0241234522', 'kyc.cleanup@gmail.com', 300);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const createdAt = new Date().toISOString();
  db.withdrawals.push({ id: 'wdl_stuck', userId, methodId, amount: 100, requestedAmount: 100, operationalCharge: 10, actualAmount: 90, reference: 'WDL_STUCK_1', status: 'PENDING_KYC_VERIFICATION', kycRequired: true, createdAt });
  db.transactions.push({ id: 'txn_stuck', userId, type: 'debit', amount: 100, account: 'redeemed', reference: 'WDL_STUCK_1', status: 'PENDING_KYC_VERIFICATION', reason: 'Withdrawal to MTN Mobile Money', related: { withdrawalId: 'wdl_stuck' }, createdAt });
  db.receipts.push({ id: 'rcpt_stuck', userId, type: 'withdrawal', amount: 100, account: 'redeemed', reference: 'WDL_STUCK_1', status: 'PENDING_KYC_VERIFICATION', related: {}, createdAt });
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const state = (await asUser('/api/state')).data;
  assert.equal(state.user.redeemedBalance, 300, 'the held 100 is given back');
  assert.equal(state.withdrawals.some(item => item.reference === 'WDL_STUCK_1'), false);
  assert.equal(state.transactions.some(item => item.reference === 'WDL_STUCK_1'), false);
  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.withdrawals.length, 0);
  assert.equal(saved.receipts.some(item => item.reference === 'WDL_STUCK_1'), false);
  assert.equal((await asUser('/api/state')).data.user.redeemedBalance, 300, 'idempotent on later loads');
});
