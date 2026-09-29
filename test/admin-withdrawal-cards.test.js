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

test('admin can change how many redeemed cards a user needs before withdrawing, and it is enforced', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-withdraw-cards-${process.pid}-${Date.now()}.json`);
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
      const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { response, data: await response.json().catch(() => ({})) };
    };
  }
  const asUser = client(); const asAdmin = client();
  const signup = await asUser('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Withdraw Tester', phone: '0241234588', email: '0241234588@gmail.com', password: 'simple' }) });
  assert.equal(signup.response.status, 201);
  assert.equal(signup.data.withdrawalCardRequirement, 3, 'default requirement is 3 cards');
  assert.equal((await asAdmin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).response.status, 200);

  // Only admins can change it, and only to a sane whole number.
  const anon = await fetch(`${baseUrl}/api/admin/settings/withdrawal-cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 1 }) });
  assert.equal(anon.status, 401);
  for (const bad of [-1, 51, 1.5, 'abc', null]) {
    const res = await asAdmin('/api/admin/settings/withdrawal-cards', { method: 'POST', body: JSON.stringify({ count: bad }) });
    assert.equal(res.response.status, 400, `rejects ${bad}`);
  }

  const withdraw = () => asUser('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: 10, methodId: 'none', pin: '0000' }) });
  const before = await withdraw();
  assert.equal(before.response.status, 400);
  assert.match(before.data.error, /Withdrawals start at GHS 100\.00\. Purchase and redeem your first card/, 'the GHS limit is checked before the card requirement');

  // Below GHS 100 the limit notice wins; a user who has bought a card is told to purchase more instead.
  // Credit the user GHS 150 of redeemed balance so the card requirement is what we test next.
  // The card requirement counts purchased cards, not redeemed ones, so no purchases are added yet.
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  db.transactions.push({ id: 'credit_limit_test', userId: signup.data.user.id, type: 'credit', amount: 150, account: 'redeemed', reference: 'REDEMPTION_LIMIT_TEST', status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  fs.writeFileSync(dataFile, JSON.stringify(db));
  assert.match((await withdraw()).data.error, /Purchase 3 more cards/, 'with GHS 100+ the card requirement applies next');

  const set = await asAdmin('/api/admin/settings/withdrawal-cards', { method: 'POST', body: JSON.stringify({ count: 5, note: 'tighten' }) });
  assert.equal(set.response.status, 200);
  assert.equal(set.data.minRedeemedCardsForWithdrawal, 5);
  const summary = await asAdmin('/api/admin/summary');
  assert.equal(summary.data.settings.minRedeemedCardsForWithdrawal, 5);
  assert.match((await withdraw()).data.error, /Purchase 5 more cards/, 'server enforces the new number');
  assert.equal((await asUser('/api/state')).data.withdrawalCardRequirement, 5, 'users see the new number');

  await asAdmin('/api/admin/settings/withdrawal-cards', { method: 'POST', body: JSON.stringify({ count: 1 }) });
  assert.match((await withdraw()).data.error, /Purchase 1 more card to unlock/, 'singular wording');

  // With 0 the card gate is gone: the request now fails later, on the missing method instead.
  await asAdmin('/api/admin/settings/withdrawal-cards', { method: 'POST', body: JSON.stringify({ count: 0 }) });
  assert.match((await withdraw()).data.error, /saved withdrawal method/);

  const audit = await asAdmin('/api/admin/audit-logs?pageSize=10');
  assert.ok(audit.data.items.some(item => item.action === 'settings.withdrawalCards'), 'change is audited');
  assert.equal(JSON.parse(fs.readFileSync(dataFile, 'utf8')).settings.minRedeemedCardsForWithdrawal, 0, 'persisted to disk');
});
