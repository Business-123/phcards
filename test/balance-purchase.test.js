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

test('admin can allow a user to buy cards with wallet balance, and it is enforced', { timeout: 25000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-balance-buy-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  function client() {
    let cookie = '';
    return async (pathname, options = {}) => {
      const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) } });
      const sc = response.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      return { response, data: await response.json().catch(() => ({})) };
    };
  }
  const asUser = client(); const asAdmin = client();
  const signup = await asUser('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Balance Buyer', phone: '0241234599', email: 'balance.buyer@gmail.com', password: 'simple' }) });
  assert.equal(signup.response.status, 201);
  const userId = signup.data.user.id;
  assert.equal(signup.data.user.canBuyWithBalance, false, 'off by default');
  assert.equal((await asAdmin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).response.status, 200);

  const cards = (await asUser('/api/state')).data.cards.filter(c => !c.isFreeGift);
  const card = cards[0];
  assert.ok(card, 'a paid card exists');
  const key = 'balance-test-key-0000000001';
  const buy = (k = key, cardId = card.id) => asUser('/api/purchases/balance', { method: 'POST', body: JSON.stringify({ cardId, idempotencyKey: k }) });

  // Not allowed yet.
  assert.equal((await buy()).response.status, 403);

  // Only admins can flip it, and it needs a boolean.
  assert.equal((await fetch(`${baseUrl}/api/admin/users/${userId}/balance-purchase`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status, 401);
  assert.equal((await asAdmin(`/api/admin/users/${userId}/balance-purchase`, { method: 'POST', body: JSON.stringify({ enabled: 'yes' }) })).response.status, 400);
  const on = await asAdmin(`/api/admin/users/${userId}/balance-purchase`, { method: 'POST', body: JSON.stringify({ enabled: true }) });
  assert.equal(on.response.status, 200);
  assert.equal(on.data.user.canBuyWithBalance, true);
  const list = await asAdmin('/api/admin/users');
  assert.equal(list.data.items.find(u => u.id === userId).canBuyWithBalance, true, 'shows in the admin user list');
  assert.equal((await asUser('/api/state')).data.user.canBuyWithBalance, true);

  // Allowed, but no money yet.
  const broke = await buy();
  assert.equal(broke.response.status, 402);

  // Give the user wallet balance through a completed ledger credit.
  const price = Number(card.priceGhs ?? card.price);
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  db.transactions.push({ id: 'wallet_credit_test', userId, type: 'credit', amount: price + 10, account: 'wallet', reference: 'WALLET_TEST_CREDIT', status: 'completed', reason: 'Deposit', related: {}, createdAt: new Date().toISOString() });
  db.users.find(u => u.id === userId).walletBalance = price + 10;
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const stockBefore = (await asUser('/api/state')).data.cards.find(c => c.id === card.id).stock;
  const ok = await buy();
  assert.equal(ok.response.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.state.user.walletBalance, 10, 'the card price came out of the wallet balance');
  assert.equal(ok.data.state.user.lifetimePurchasedCards, 1, 'counts toward the withdrawal card requirement');
  const stockAfter = ok.data.state.cards.find(c => c.id === card.id).stock;
  assert.equal(stockAfter, stockBefore - 1);
  const debit = ok.data.state.transactions.find(x => x.reference === ok.data.purchase.reference);
  assert.equal(debit.account, 'wallet');
  assert.equal(debit.type, 'debit');

  // Same key again is a no-op, not a second charge.
  const dup = await buy();
  assert.equal(dup.response.status, 200);
  assert.equal(dup.data.duplicate, true);
  assert.equal((await asUser('/api/state')).data.user.walletBalance, 10);

  // Switching it off stops balance purchases again.
  await asAdmin(`/api/admin/users/${userId}/balance-purchase`, { method: 'POST', body: JSON.stringify({ enabled: false }) });
  assert.equal((await buy('balance-test-key-0000000002')).response.status, 403);
  const audit = await asAdmin('/api/admin/audit-logs?pageSize=10');
  assert.ok(audit.data.items.some(item => item.action === 'user.balancePurchase.enable'), 'enable is audited');
  assert.ok(audit.data.items.some(item => item.action === 'user.balancePurchase.disable'), 'disable is audited');
});
