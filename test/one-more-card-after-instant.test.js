const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

// A KYC-verified user who bought the base 3 cards (so "one more card" = 4 in total), GHS 500 redeemed.
async function setup(t, extraEnv = {}) {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password', ...extraEnv } });
  const user = await site.signup('Extra Card', '0241234800', 'extra.card@gmail.com');
  assert.equal(user.status, 201);
  const method = await site.request('/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Extra Card', phone: '0241234800', pin: '1234' }) }, user.cookie);
  assert.equal(method.status, 201);
  const admin = await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(admin.status, 200);
  const db = site.readDb();
  const u = db.users.find(x => x.email === 'extra.card@gmail.com');
  u.redeemedBalance = 500; u.kycStatus = 'VERIFIED'; u.kycVerifiedAt = new Date().toISOString();
  db.transactions.push({ id: 'credit_seed', userId: u.id, type: 'credit', amount: 500, account: 'redeemed', reference: 'SEED_CREDIT', status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  const addCardTo = (d, id) => d.purchases.push({ id: `purchase_${id}`, userId: u.id, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
  for (let i = 0; i < 3; i++) addCardTo(db, `base_${i}`);
  site.writeDb(db);
  const addCard = () => { const d = site.readDb(); addCardTo(d, `extra_${Date.now()}`); site.writeDb(d); };
  const withdraw = amount => site.request('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount, methodId: method.data.method.id, pin: '1234' }) }, user.cookie);
  const approve = ref => site.request(`/api/admin/withdrawals/${encodeURIComponent(ref)}/approve`, { method: 'POST', body: JSON.stringify({ note: 'ok' }) }, admin.cookie);
  const startInstant = ref => site.request(`/api/withdrawals/${encodeURIComponent(ref)}/instant-payout`, { method: 'POST', body: JSON.stringify({}) }, user.cookie);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  return { site, user, userId: u.id, admin, addCard, withdraw, approve, startInstant, wait };
}

// Pays the instant fee through the signed hub webhook and returns the verify response.
async function payInstant(h, ref) {
  const started = await h.startInstant(ref);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal((await h.site.sendWebhook(started.data.reference)).status, 200);
  const verify = await h.site.request(`/api/instant-payout-payments/${started.data.reference}/verify`, { method: 'POST' }, h.user.cookie);
  assert.equal(verify.status, 200, JSON.stringify(verify.data));
  return verify;
}

test('a verified user with only the base cards is no longer rejected at withdrawal time (no one-more-card, no redeem-5 stage)', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const res = await h.withdraw(100);
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.withdrawal.status, 'pending');
  assert.equal(res.data.withdrawal.extraCardRejectAt, null, 'no deadline until the instant fee is paid');
});

test('paying the instant fee starts a 5-minute deadline and reports 3/4 cards (one more to go)', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const w = (await h.withdraw(100)).data.withdrawal;
  const verify = await payInstant(h, w.reference);
  assert.deepEqual(verify.data.extraCardProgress, { current: 3, required: 4 });
  const after = h.site.readDb().withdrawals.find(x => x.reference === w.reference);
  assert.equal(after.status, 'pending');
  assert.equal(after.instantPayout, true);
  const window = Date.parse(after.extraCardRejectAt) - Date.parse(after.instantPayoutPaidAt);
  assert.equal(window, 5 * 60 * 1000, 'rejected 5 minutes after the fee is paid');
  assert.equal(verify.data.withdrawal.extraCardRejectAt, after.extraCardRejectAt, 'the client receives the deadline');
});

test('an admin cannot approve during the window while the extra card is missing', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const w = (await h.withdraw(100)).data.withdrawal;
  await payInstant(h, w.reference);
  const res = await h.approve(w.reference);
  assert.ok(res.status >= 400, 'approval refused');
  assert.match(res.data.error, /extra card/i);
  assert.equal(h.site.readDb().withdrawals.find(x => x.reference === w.reference).status, 'pending');
});

test('if the extra card is not bought within 5 minutes the pending withdrawal is rejected and the balance returned', { timeout: 40000 }, async t => {
  const h = await setup(t, { EXTRA_CARD_SWEEP_MS: '300' });
  const w = (await h.withdraw(100)).data.withdrawal;
  await payInstant(h, w.reference);
  assert.equal(h.site.readDb().users.find(x => x.id === h.userId).redeemedBalance, 400, 'debited while pending');

  // Fast-forward: the deadline has passed.
  const db = h.site.readDb();
  db.withdrawals.find(x => x.reference === w.reference).extraCardRejectAt = new Date(Date.now() - 1000).toISOString();
  h.site.writeDb(db);
  let rejected;
  for (let i = 0; i < 40 && !rejected; i++) {
    await h.wait(250);
    const cur = h.site.readDb().withdrawals.find(x => x.reference === w.reference);
    if (cur.status === 'rejected') rejected = cur;
  }
  assert.ok(rejected, 'auto-rejected by the sweep');
  assert.match(rejected.adminNote, /purchase one more card/i);
  assert.equal(h.site.readDb().users.find(x => x.id === h.userId).redeemedBalance, 500, 'balance returned');
});

test('buying the extra card in time keeps the withdrawal and lets the admin approve it', { timeout: 40000 }, async t => {
  const h = await setup(t, { EXTRA_CARD_SWEEP_MS: '300' });
  const w = (await h.withdraw(100)).data.withdrawal;
  await payInstant(h, w.reference);
  h.addCard();
  // Even if the deadline passes now, the card is there: the sweep clears it instead of rejecting.
  const db = h.site.readDb();
  db.withdrawals.find(x => x.reference === w.reference).extraCardRejectAt = new Date(Date.now() - 1000).toISOString();
  h.site.writeDb(db);
  let cleared = false;
  for (let i = 0; i < 40 && !cleared; i++) {
    await h.wait(250);
    cleared = h.site.readDb().withdrawals.find(x => x.reference === w.reference).extraCardRejectAt === null;
  }
  assert.ok(cleared, 'deadline cleared');
  assert.equal(h.site.readDb().withdrawals.find(x => x.reference === w.reference).status, 'pending');
  assert.equal((await h.approve(w.reference)).status, 200);
});
