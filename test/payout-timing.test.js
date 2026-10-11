const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

// A KYC-verified user with a redeemed balance and every withdrawal pop-up off, so a
// withdrawal goes straight to PENDING and the only thing under test is the payout timing.
async function setup(t) {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const user = await site.signup('Payout Timer', '0241234700', 'payout.timer@gmail.com');
  assert.equal(user.status, 201);
  const method = await site.request('/api/methods', { method: 'POST', body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Payout Timer', phone: '0241234700', pin: '1234' }) }, user.cookie);
  assert.equal(method.status, 201);
  const admin = await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(admin.status, 200);
  const db = site.readDb();
  const u = db.users.find(x => x.email === 'payout.timer@gmail.com');
  u.redeemedBalance = 500; u.kycStatus = 'VERIFIED'; u.kycVerifiedAt = new Date().toISOString();
  db.transactions.push({ id: 'credit_seed', userId: u.id, type: 'credit', amount: 500, account: 'redeemed', reference: 'SEED_CREDIT', status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  site.writeDb(db);
  const settings = body => site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) }, admin.cookie);
  assert.equal((await settings({ disabledPopups: ['withdrawalLimit', 'cardsNeeded', 'oneMoreCard', 'redeemFiveCards'] })).status, 200);
  const withdraw = amount => site.request('/api/withdrawals', { method: 'POST', body: JSON.stringify({ amount, methodId: method.data.method.id, pin: '1234' }) }, user.cookie);
  const approve = ref => site.request(`/api/admin/withdrawals/${encodeURIComponent(ref)}/approve`, { method: 'POST', body: JSON.stringify({ note: 'ok' }) }, admin.cookie);
  const startInstant = ref => site.request(`/api/withdrawals/${encodeURIComponent(ref)}/instant-payout`, { method: 'POST', body: JSON.stringify({}) }, user.cookie);
  return { site, user, admin, settings, withdraw, approve, startInstant };
}

test('payout timing settings default to 7 days / GHS 100, are validated, and reach the user state', { timeout: 40000 }, async t => {
  const { site, user, admin, settings } = await setup(t);
  const summary = await site.request('/api/admin/summary', {}, admin.cookie);
  const s = summary.data.settings;
  assert.deepEqual([s.payoutWaitEnabled, s.payoutWaitDays, s.instantPayoutEnabled, s.instantPayoutFee], [true, 7, true, 100]);
  const state = (await site.request('/api/state', {}, user.cookie)).data;
  assert.deepEqual([state.payoutWaitEnabled, state.payoutWaitDays, state.instantPayoutEnabled, state.instantPayoutFee], [true, 7, true, 100]);
  const config = (await site.request('/api/config')).data;
  assert.deepEqual([config.payoutWaitDays, config.instantPayoutFee], [7, 100]);

  assert.equal((await settings({ payoutWaitDays: 0 })).status, 400, 'days must be at least 1 (switch the wait off instead)');
  assert.equal((await settings({ payoutWaitDays: 2.5 })).status, 400, 'whole days only');
  assert.equal((await settings({ instantPayoutFee: -5 })).status, 400);
  assert.equal((await settings({ payoutWaitEnabled: 'no' })).status, 400, 'switches are true/false');
  assert.equal((await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ payoutWaitDays: 3 }) })).status, 401, 'admins only');

  const saved = await settings({ payoutWaitDays: 3, instantPayoutFee: 150, instantPayoutEnabled: false, note: 'tune' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.data.settings.payoutWaitDays, saved.data.settings.instantPayoutFee, saved.data.settings.instantPayoutEnabled, saved.data.settings.payoutWaitEnabled], [3, 150, false, true]);
  assert.deepEqual([site.readDb().settings.payoutWaitDays, site.readDb().settings.instantPayoutFee], [3, 150], 'persisted');
  assert.ok(site.readDb().adminAuditLogs.some(l => l.action === 'settings.update' && l.reason === 'tune'), 'audited');
});

test('a new withdrawal waits out the pending period: admins cannot approve early, and can once the wait is off', { timeout: 40000 }, async t => {
  const { site, admin, settings, withdraw, approve } = await setup(t);
  const created = await withdraw(100);
  assert.equal(created.status, 201);
  const w = created.data.withdrawal;
  assert.equal(w.status, 'pending');
  const wait = Date.parse(w.payoutReleaseAt) - Date.now();
  assert.ok(Math.abs(wait - 7 * DAY) < 60 * 1000, 'release date is 7 days out');
  assert.equal(w.instantPayout, false);

  const early = await approve(w.reference);
  assert.equal(early.status, 409);
  assert.match(early.data.error, /pending payout period/);
  assert.equal(site.readDb().withdrawals.find(x => x.reference === w.reference).status, 'pending', 'still pending');

  const row = (await site.request('/api/admin/withdrawals', {}, admin.cookie)).data.items.find(x => x.reference === w.reference);
  assert.ok(row.payoutHoldMs > 6 * DAY, 'admin queue shows the hold');

  // Once the date passes, approval works (simulated by moving the stored release date back).
  const db = site.readDb();
  db.withdrawals.find(x => x.reference === w.reference).payoutReleaseAt = new Date(Date.now() - 1000).toISOString();
  site.writeDb(db);
  assert.equal((await approve(w.reference)).status, 200);

  // Switching the waiting period off releases withdrawals that are already waiting.
  const second = (await withdraw(100)).data.withdrawal;
  assert.equal((await approve(second.reference)).status, 409);
  assert.equal((await settings({ payoutWaitEnabled: false })).status, 200);
  assert.equal((await approve(second.reference)).status, 200);
  // ...and new withdrawals get no release date at all.
  const third = (await withdraw(100)).data.withdrawal;
  assert.equal(third.payoutReleaseAt, null);
  assert.equal((await approve(third.reference)).status, 200);
});

test('the number of days is admin-editable and applies to new withdrawals', { timeout: 40000 }, async t => {
  const { settings, withdraw } = await setup(t);
  assert.equal((await settings({ payoutWaitDays: 2 })).status, 200);
  const w = (await withdraw(100)).data.withdrawal;
  assert.ok(Math.abs((Date.parse(w.payoutReleaseAt) - Date.now()) - 2 * DAY) < 60 * 1000);
});

test('paying the instant payout fee lifts the hold, flags the withdrawal, and never approves it by itself', { timeout: 40000 }, async t => {
  const { site, admin, withdraw, approve, startInstant } = await setup(t);
  const w = (await withdraw(100)).data.withdrawal;

  const started = await startInstant(w.reference);
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.amount, 100);
  const sent = site.hub.initialized.at(-1);
  assert.equal(sent.amount, 100);
  assert.equal(sent.metadata.purpose, 'INSTANT_PAYOUT');
  assert.match(started.data.callbackUrl, /instant_payout_reference=/);

  // Tapping again reuses the live checkout rather than minting a second reference.
  const again = await startInstant(w.reference);
  assert.equal(again.status, 200);
  assert.equal(again.data.reference, started.data.reference);
  assert.equal(site.hub.initialized.length, 1);

  // Not paid yet: still locked, and the verify endpoint says so.
  assert.equal((await approve(w.reference)).status, 409);
  assert.equal((await site.request(`/api/instant-payout-payments/${started.data.reference}/verify`, { method: 'POST' }, (await site.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'payout.timer@gmail.com', password: 'simple' }) })).cookie)).status, 409);

  // A webhook for the wrong amount is ignored.
  const bad = await site.sendWebhook(started.data.reference, 'SUCCESS', { amount: 1 });
  assert.equal(bad.status, 200);
  assert.equal(site.readDb().withdrawals.find(x => x.reference === w.reference).instantPayout, false);

  // The real, signed success webhook (delivered twice: must apply once).
  assert.equal((await site.sendWebhook(started.data.reference)).status, 200);
  assert.equal((await site.sendWebhook(started.data.reference)).status, 200);
  const db = site.readDb();
  const after = db.withdrawals.find(x => x.reference === w.reference);
  assert.equal(after.status, 'pending', 'paying does not approve the withdrawal');
  assert.equal(after.instantPayout, true);
  assert.equal(after.instantPayoutFee, 100);
  assert.equal(after.instantPayoutReference, started.data.reference);
  assert.ok(Date.parse(after.payoutReleaseAt) <= Date.now(), 'hold lifted');
  assert.equal(db.transactions.filter(x => x.reference === started.data.reference).length, 1, 'fee is recorded once');
  assert.equal(db.transactions.find(x => x.reference === started.data.reference).account, 'external', 'the fee never touches the balance');
  assert.equal(db.receipts.find(x => x.reference === started.data.reference).type, 'instant_payout');
  assert.equal(db.users.find(x => x.email === 'payout.timer@gmail.com').redeemedBalance, 400, 'only the withdrawal was held');

  // Admin sees it flagged and can approve immediately.
  const row = (await site.request('/api/admin/withdrawals', {}, admin.cookie)).data.items.find(x => x.reference === w.reference);
  assert.equal(row.instantPayout, true);
  assert.equal(row.payoutHoldMs, 0);
  assert.equal((await approve(w.reference)).status, 200);

  // Can't pay twice, and an approved withdrawal can't buy it.
  assert.equal((await startInstant(w.reference)).status, 400);
});

test('instant payout can be switched off, is only offered while a withdrawal is waiting, and uses the admin fee', { timeout: 40000 }, async t => {
  const { site, user, settings, withdraw, startInstant } = await setup(t);
  const w = (await withdraw(100)).data.withdrawal;

  assert.equal((await settings({ instantPayoutEnabled: false })).status, 200);
  const off = await startInstant(w.reference);
  assert.equal(off.status, 403);
  assert.equal((await site.request('/api/state', {}, user.cookie)).data.instantPayoutEnabled, false);

  assert.equal((await settings({ instantPayoutEnabled: true, instantPayoutFee: 250 })).status, 200);
  const priced = await startInstant(w.reference);
  assert.equal(priced.status, 201);
  assert.equal(priced.data.amount, 250);
  assert.equal(site.hub.initialized.at(-1).amount, 250);

  // Someone else's withdrawal, or an unknown one, is not reachable.
  const other = await site.signup('Other Person', '0241234701', 'other.person@gmail.com');
  const foreign = await site.request(`/api/withdrawals/${encodeURIComponent(w.reference)}/instant-payout`, { method: 'POST', body: '{}' }, other.cookie);
  assert.equal(foreign.status, 404);

  // With the waiting period off there is nothing to buy.
  assert.equal((await settings({ payoutWaitEnabled: false })).status, 200);
  const nothing = await startInstant(w.reference);
  assert.equal(nothing.status, 400);
  assert.match(nothing.data.error, /no pending period left/);
});

test('an admin cannot reject a withdrawal while its instant payout checkout is awaiting confirmation', { timeout: 40000 }, async t => {
  const { site, admin, withdraw, startInstant } = await setup(t);
  const w = (await withdraw(100)).data.withdrawal;
  assert.equal((await startInstant(w.reference)).status, 201);
  const reject = await site.request(`/api/admin/withdrawals/${encodeURIComponent(w.reference)}/reject`, { method: 'POST', body: JSON.stringify({ note: 'no' }) }, admin.cookie);
  assert.notEqual(reject.status, 200);
  assert.match(reject.data.error, /instant payout checkout awaiting confirmation/);
});

test('returning from checkout re-verifies with the hub and applies the instant payout (no webhook needed)', { timeout: 40000 }, async t => {
  const { site, withdraw, startInstant } = await setup(t);
  const w = (await withdraw(100)).data.withdrawal;
  const started = await startInstant(w.reference);
  assert.equal(started.status, 201);
  const hubReference = site.hub.referenceFor(started.data.reference);

  // Customer closed checkout without paying: nothing changes.
  let res = await fetch(`${site.baseUrl}/api/payment/return?reference=${hubReference}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(site.readDb().withdrawals.find(x => x.reference === w.reference).instantPayout, false);

  // Paid at the hub: the browser's return is verified server-side, then redirected back into the app.
  site.hub.setStatus(hubReference, 'SUCCESS');
  res = await fetch(`${site.baseUrl}/api/payment/return?reference=${hubReference}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /instant_payout_reference=/);
  const db = site.readDb();
  assert.equal(db.withdrawals.find(x => x.reference === w.reference).instantPayout, true);
  assert.equal(db.withdrawals.find(x => x.reference === w.reference).status, 'pending');

  // The app then asks for the result.
  const login = await site.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'payout.timer@gmail.com', password: 'simple' }) });
  const verified = await site.request(`/api/instant-payout-payments/${started.data.reference}/verify`, { method: 'POST' }, login.cookie);
  assert.equal(verified.status, 200);
  assert.equal(verified.data.applied, true);
  assert.equal(verified.data.withdrawal.instantPayout, true);
  assert.equal(verified.data.receipt.type, 'instant_payout');
});
