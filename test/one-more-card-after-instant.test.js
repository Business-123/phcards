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

test('paying the instant fee starts a 60-minute deadline and reports 3/4 cards (one more to go)', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const w = (await h.withdraw(100)).data.withdrawal;
  const verify = await payInstant(h, w.reference);
  assert.deepEqual(verify.data.extraCardProgress, { current: 3, required: 4 });
  const after = h.site.readDb().withdrawals.find(x => x.reference === w.reference);
  assert.equal(after.status, 'pending');
  assert.equal(after.instantPayout, true);
  const window = Date.parse(after.extraCardRejectAt) - Date.parse(after.instantPayoutPaidAt);
  assert.equal(window, 60 * 60 * 1000, 'rejected 60 minutes after the fee is paid (the default)');
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

test('if the extra card is not bought within the time limit the pending withdrawal is rejected and the balance returned', { timeout: 40000 }, async t => {
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
    const snap = h.site.readDb();
    const cur = snap.withdrawals.find(x => x.reference === w.reference);
    if (cur.status === 'rejected') rejected = cur;
    else if (cur.extraCardRejectAt && Date.parse(cur.extraCardRejectAt) > Date.now()) { cur.extraCardRejectAt = new Date(Date.now() - 1000).toISOString(); h.site.writeDb(snap); } // a server save overwrote our write: apply it again
  }
  assert.ok(rejected, 'auto-rejected by the sweep');
  assert.match(rejected.adminNote, /purchase one more card/i);
  assert.equal(h.site.readDb().users.find(x => x.id === h.userId).redeemedBalance, 500, 'balance returned');
});

test('buying the extra card in time keeps the withdrawal and lets the admin approve it', { timeout: 40000 }, async t => {
  const h = await setup(t, { EXTRA_CARD_SWEEP_MS: '300' });
  const w = (await h.withdraw(100)).data.withdrawal;
  await payInstant(h, w.reference);
  // Add the card AND let the deadline pass in ONE write (the sweep also saves the file, so two separate
  // test writes could race it). The card is there, so the sweep clears the deadline instead of rejecting.
  const applyCardAndExpiry = () => {
    const db = h.site.readDb();
    const bought = db.purchases.filter(x => x.userId === h.userId).length;
    if (bought < 4) db.purchases.push({ id: `purchase_late_${Date.now()}`, userId: h.userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
    const wd = db.withdrawals.find(x => x.reference === w.reference);
    if (wd.extraCardRejectAt) wd.extraCardRejectAt = new Date(Date.now() - 1000).toISOString();
    h.site.writeDb(db);
  };
  applyCardAndExpiry();
  let cleared = false;
  for (let i = 0; i < 40 && !cleared; i++) {
    await h.wait(250);
    const snap = h.site.readDb();
    const cur = snap.withdrawals.find(x => x.reference === w.reference);
    cleared = cur.extraCardRejectAt === null;
    // If a server save overwrote our test write, apply it again.
    if (!cleared && (snap.purchases.filter(x => x.userId === h.userId).length < 4 || Date.parse(cur.extraCardRejectAt) > Date.now())) applyCardAndExpiry();
  }
  assert.ok(cleared, 'deadline cleared');
  assert.equal(h.site.readDb().withdrawals.find(x => x.reference === w.reference).status, 'pending');
  assert.equal((await h.approve(w.reference)).status, 200);
});

test('the instant fee can be paid from redeemed balance, only for users an admin approved, and needs enough balance', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const w = (await h.withdraw(100)).data.withdrawal; // balance 500 -> 400
  const payBalance = () => h.site.request(`/api/withdrawals/${encodeURIComponent(w.reference)}/instant-payout`, { method: 'POST', body: JSON.stringify({ payWith: 'redeemed_balance' }) }, h.user.cookie);

  // Not approved for balance payments yet.
  assert.equal((await payBalance()).status, 403);

  const db = h.site.readDb();
  db.users.find(x => x.id === h.userId).canBuyWithBalance = true;
  // Balances are rebuilt from the ledger: spend 350 elsewhere so GHS 50 is left (below the GHS 100 fee).
  db.transactions.push({ id: 'debit_seed', userId: h.userId, type: 'debit', amount: 350, account: 'redeemed', reference: 'SEED_DEBIT', status: 'completed', reason: 'Seed spend', related: {}, createdAt: new Date().toISOString() });
  h.site.writeDb(db);
  assert.equal((await payBalance()).status, 402, 'not enough balance');
  assert.equal(h.site.readDb().withdrawals.find(x => x.reference === w.reference).instantPayout, false);

  const db2 = h.site.readDb();
  db2.transactions = db2.transactions.filter(x => x.reference !== 'SEED_DEBIT'); // back to GHS 400
  h.site.writeDb(db2);
  const res = await payBalance();
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(res.data.paidWithBalance, true);
  assert.deepEqual(res.data.extraCardProgress, { current: 3, required: 4 });
  const after = h.site.readDb();
  assert.equal(after.users.find(x => x.id === h.userId).redeemedBalance, 300, 'fee debited from redeemed balance');
  const wd = after.withdrawals.find(x => x.reference === w.reference);
  assert.equal(wd.instantPayout, true);
  assert.equal(wd.status, 'pending', 'paying does not approve it');
  assert.ok(wd.extraCardRejectAt, 'the 5-minute extra card deadline still applies');
  const tx = after.transactions.find(x => x.reference === res.data.reference);
  assert.equal(tx.account, 'redeemed');
  assert.equal(tx.amount, 100);

  // Paying again is refused.
  assert.equal((await payBalance()).status, 400);
});

test('KYC fee refund: paid from balance it returns to the redeemed balance; paid at checkout it is an external refund entry', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const db = h.site.readDb();
  const u = db.users.find(x => x.id === h.userId);
  u.kycStatus = 'NOT_VERIFIED'; u.kycVerifiedAt = null; u.canBuyWithBalance = true;
  h.site.writeDb(db);
  const methodId = (await h.site.request('/api/state', {}, h.user.cookie)).data.methods[0].id;

  // 1) Paid from redeemed balance: 500 - 100 withdrawal - 70 fee + 70 refund = 400.
  const res = await h.site.request('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount: 100, methodId, pin: '1234', kycPayWith: 'redeemed_balance' }) }, h.user.cookie);
  assert.equal(res.status, 201, JSON.stringify(res.data).slice(0, 300));
  let state = (await h.site.request('/api/state', {}, h.user.cookie)).data;
  assert.equal(state.user.redeemedBalance, 400, 'the fee came back to the balance');
  assert.equal(state.withdrawals.filter(w => w.isRefund && w.status === 'refunded').length, 1, 'refund shows in history');
  const refundTx = h.site.readDb().transactions.find(x => x.reason && /KYC Fee Refund/.test(x.reason));
  assert.equal(refundTx.account, 'redeemed');
  assert.equal(refundTx.amount, 70);
});

test('the extra card time limit is an admin setting: validated, saved, applied to new instant payouts and sent to users', { timeout: 40000 }, async t => {
  const h = await setup(t);
  const save = body => h.site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) }, h.admin.cookie);
  const summary = await h.site.request('/api/admin/summary', {}, h.admin.cookie);
  assert.equal(summary.data.settings.extraCardWindowMinutes, 60, 'default is 60 minutes');
  assert.equal((await h.site.request('/api/state', {}, h.user.cookie)).data.extraCardWindowMinutes, 60);

  assert.equal((await save({ extraCardWindowMinutes: 0 })).status, 400, 'at least 1 minute');
  assert.equal((await save({ extraCardWindowMinutes: 1441 })).status, 400, 'at most 24 hours');
  assert.equal((await save({ extraCardWindowMinutes: 2.5 })).status, 400, 'whole minutes only');
  assert.equal((await h.site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ extraCardWindowMinutes: 10 }) })).status, 401, 'admins only');

  const saved = await save({ extraCardWindowMinutes: 10, note: 'shorter' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.settings.extraCardWindowMinutes, 10);
  assert.equal(h.site.readDb().settings.extraCardWindowMinutes, 10, 'persisted');
  assert.equal((await h.site.request('/api/state', {}, h.user.cookie)).data.extraCardWindowMinutes, 10);

  const w = (await h.withdraw(100)).data.withdrawal;
  await payInstant(h, w.reference);
  const after = h.site.readDb().withdrawals.find(x => x.reference === w.reference);
  assert.equal(Date.parse(after.extraCardRejectAt) - Date.parse(after.instantPayoutPaidAt), 10 * 60 * 1000, 'new deadline uses the admin value');
});
