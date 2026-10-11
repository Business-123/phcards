const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

const KEYS = ['withdrawalLimit', 'cardsNeeded', 'oneMoreCard', 'redeemFiveCards'];

async function setup(t) {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const user = await site.signup('Popup Toggler', '0241234591', 'popup.toggler@gmail.com');
  assert.equal(user.status, 201);
  const method = await site.request('/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Popup Toggler', phone: '0241234591', pin: '1234' }) }, user.cookie);
  assert.equal(method.status, 201);
  const admin = await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(admin.status, 200);
  const setPopups = (disabledPopups, extra = {}) => site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledPopups, ...extra }) }, admin.cookie);
  const withdraw = amount => site.request('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount, methodId: method.data.method.id, pin: '1234' }) }, user.cookie);
  return { site, user, admin, method, setPopups, withdraw };
}

test('admin lists every withdrawal pop-up, all on by default, and validates the switches', { timeout: 40000 }, async t => {
  const { site, user, admin, setPopups } = await setup(t);

  const summary = await site.request('/api/admin/summary', {}, admin.cookie);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data.settings.popups.map(x => [x.key, x.enabled]), KEYS.map(k => [k, true]));
  assert.ok(summary.data.settings.popups.every(x => x.label && x.description), 'each pop-up is labelled');
  assert.deepEqual(summary.data.settings.disabledPopups, []);

  const state = await site.request('/api/state', {}, user.cookie);
  assert.deepEqual(state.data.disabledPopups, []);

  // Only admins, only a list, only real pop-up keys.
  const anon = await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledPopups: ['oneMoreCard'] }) });
  assert.equal(anon.status, 401);
  assert.equal((await setPopups('oneMoreCard')).status, 400);
  assert.equal((await setPopups(['nope'])).status, 400);

  // Switch one off: reflected in the admin list, the user's state, and on disk.
  const off = await setPopups(['oneMoreCard'], { note: 'pause' });
  assert.equal(off.status, 200);
  assert.deepEqual(off.data.settings.disabledPopups, ['oneMoreCard']);
  assert.deepEqual(off.data.settings.popups.map(x => [x.key, x.enabled]), [['withdrawalLimit', true], ['cardsNeeded', true], ['oneMoreCard', false], ['redeemFiveCards', true]]);
  assert.deepEqual((await site.request('/api/state', {}, user.cookie)).data.disabledPopups, ['oneMoreCard']);
  assert.deepEqual(site.readDb().settings.disabledPopups, ['oneMoreCard'], 'persisted');
  assert.ok(site.readDb().adminAuditLogs.some(l => l.action === 'settings.popup.disable' && l.reason === 'pause'), 'audited');

  // Saving a tier switch afterwards must not reset the pop-up switches (and vice versa).
  assert.equal((await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledTiers: ['core'] }) }, admin.cookie)).status, 200);
  assert.deepEqual(site.readDb().settings.disabledPopups, ['oneMoreCard']);
  assert.equal((await setPopups([])).status, 200);
  assert.deepEqual(site.readDb().settings.disabledTiers, ['core']);
  assert.deepEqual((await site.request('/api/state', {}, user.cookie)).data.disabledPopups, []);
});

test('switching a pop-up off stops that requirement blocking withdrawals; switching it on restores it', { timeout: 40000 }, async t => {
  const { site, user, setPopups, withdraw } = await setup(t);

  // A KYC-verified user with GHS 50 redeemed, no purchased cards and no redeemed cards:
  // they trip every pop-up in turn.
  const db = site.readDb();
  const u = db.users.find(x => x.email === 'popup.toggler@gmail.com');
  u.redeemedBalance = 50; u.kycStatus = 'VERIFIED'; u.kycVerifiedAt = new Date().toISOString();
  // Balances are rebuilt from the ledger, so give the GHS 50 a matching credit entry.
  db.transactions.push({ id: 'credit_seed', userId: u.id, type: 'credit', amount: 50, account: 'redeemed', reference: 'SEED_CREDIT', status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  site.writeDb(db);

  // 1. Everything on: the withdrawal limit comes first.
  let r = await withdraw(20);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Withdrawals start at GHS/);

  // 2. Limit off: the card requirement is next (and there is no minimum amount any more).
  assert.equal((await setPopups(['withdrawalLimit'])).status, 200);
  r = await withdraw(20);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Purchase 3 more cards/);

  // 3. "N more cards" off: now the post-KYC "one more card" rejection.
  assert.equal((await setPopups(['withdrawalLimit', 'cardsNeeded'])).status, 200);
  r = await withdraw(20);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'NEEDS_ONE_MORE_CARD', JSON.stringify(r.data));

  // 4. "One more card" off: the final "redeem 5 cards" stage.
  assert.equal((await setPopups(['withdrawalLimit', 'cardsNeeded', 'oneMoreCard'])).status, 200);
  r = await withdraw(20);
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'NEEDS_FIVE_REDEEMED_CARDS');

  // 5. All off: nothing blocks the user, and the small amount goes through.
  assert.equal((await setPopups(KEYS)).status, 200);
  r = await withdraw(20);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.withdrawal.requestedAmount, 20);
  assert.equal(site.readDb().users.find(x => x.id === u.id).redeemedBalance, 30, 'balance debited');

  // 6. A zero amount is still refused even with the limit off.
  r = await withdraw(0);
  assert.equal(r.status, 400);

  // 7. Back on: the very first gate is enforced again.
  assert.equal((await setPopups([])).status, 200);
  r = await withdraw(20);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Withdrawals start at GHS/);
});
