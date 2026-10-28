// Admin "credit card" action: issue the card for a payment the automatic flow did not confirm.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

const ENV = { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password', PAYMENT_RECONCILE_SECONDS: '0' };

async function setup(t) {
  const site = await createSite(t, { env: ENV });
  const admin = await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(admin.status, 200);
  const owner = await site.signup('Credit Tester', '0241119988');
  const state = await site.request('/api/state', {}, owner.cookie);
  const card = state.data.cards.find(item => !item.isFreeGift && item.active && item.stock > 2);
  const started = await site.startPurchase(owner.cookie, card.id, 'admin_credit_key_000001');
  const { transactionId } = started.data.payment;
  const reference = site.hub.referenceFor(transactionId);
  const credit = (note = 'Confirmed in Paystack dashboard', id = transactionId) => site.request(`/api/admin/card-payments/${encodeURIComponent(id)}/credit`, { method: 'POST', body: JSON.stringify({ note }) }, admin.cookie);
  return { site, admin, owner, card, transactionId, reference, credit };
}

test('admin can credit a failed payment: one card issued, audited, stock and daily limit handled', { timeout: 20000 }, async t => {
  const { site, admin, owner, card, transactionId, reference, credit } = await setup(t);
  site.hub.setStatus(reference, 'FAILED');
  await site.request(`/api/card-payments/${transactionId}`, {}, owner.cookie);
  assert.equal(site.readDb().cardPayments[0].status, 'FAILED');
  assert.equal(site.readDb().purchases.length, 0);

  const res = await credit();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.payment.status, 'SUCCESS');
  assert.ok(res.data.purchase.orderId);

  const db = site.readDb();
  assert.equal(db.purchases.length, 1);
  assert.equal(db.codes.length, 1);
  assert.equal(db.codes[0].userId, db.users[0].id, 'card belongs to the paying customer');
  assert.equal(db.cards.find(c => c.id === card.id).stock, card.stock - 1, 'one unit of stock used, not two');
  assert.equal(db.dailyPurchaseCounts.length, 0, 'credit does not use up the daily purchase limit');
  assert.equal(db.cardPayments[0].adminCredit.note, 'Confirmed in Paystack dashboard');
  assert.equal(db.cardPayments[0].adminCredit.previousStatus, 'FAILED');
  const audit = db.adminAuditLogs.find(x => x.action === 'card-payment.credit');
  assert.ok(audit && audit.reason === 'Confirmed in Paystack dashboard' && audit.targetId === transactionId);

  const redeem = await site.request('/api/state', {}, owner.cookie);
  assert.equal(redeem.data.codes.length, 1, 'customer sees the card under Redeem');
});

test('a payment can only be credited once, and a later hub SUCCESS cannot issue a second card', { timeout: 20000 }, async t => {
  const { site, owner, transactionId, reference, credit } = await setup(t);
  assert.equal((await credit()).status, 200);
  const again = await credit('Trying a second time');
  assert.equal(again.status, 409);
  site.hub.setStatus(reference, 'SUCCESS');
  await site.sendWebhook(transactionId);
  await new Promise(r => setTimeout(r, 2600));
  await site.request(`/api/card-payments/${transactionId}`, {}, owner.cookie);
  assert.equal(site.readDb().purchases.length, 1, 'still exactly one card');
  assert.equal(site.readDb().codes.length, 1);
});

test('credit needs a written reason and an admin session', { timeout: 20000 }, async t => {
  const { site, owner, transactionId, credit } = await setup(t);
  assert.equal((await credit('')).status, 400);
  assert.equal((await credit('abc')).status, 400);
  const asCustomer = await site.request(`/api/admin/card-payments/${transactionId}/credit`, { method: 'POST', body: JSON.stringify({ note: 'I paid, trust me' }) }, owner.cookie);
  assert.ok([401, 403].includes(asCustomer.status));
  const anonymous = await site.request(`/api/admin/card-payments/${transactionId}/credit`, { method: 'POST', body: JSON.stringify({ note: 'I paid, trust me' }) });
  assert.equal(anonymous.status, 401);
  assert.equal(site.readDb().purchases.length, 0);
});

test('paid-but-sold-out payment can be credited by an admin without pushing stock below zero', { timeout: 20000 }, async t => {
  const { site, card, transactionId, credit } = await setup(t);
  const db = site.readDb();
  db.cardPayments[0].status = 'PAID_UNFULFILLED'; db.cardPayments[0].stockReserved = false;
  const target = db.cards.find(c => c.id === card.id); target.stock = 0; target.active = false;
  site.writeDb(db);
  const res = await credit('Customer paid after sell-out, honouring it');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const after = site.readDb();
  assert.equal(after.purchases.length, 1);
  assert.equal(after.cards.find(c => c.id === card.id).stock, 0);
  assert.equal(after.cardPayments[0].adminCredit.previousStatus, 'PAID_UNFULFILLED');
});

test('a payment with no hub reference (checkout never opened) can still be credited', { timeout: 20000 }, async t => {
  const { site, transactionId, credit } = await setup(t);
  const db = site.readDb(); delete db.cardPayments[0].paystackReference; site.writeDb(db);
  const res = await credit('Paid through the Paystack dashboard manually');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(site.readDb().purchases.length, 1);
});

test('admin payment list is paginated, searchable and flags which rows can be credited', { timeout: 20000 }, async t => {
  const { site, admin, transactionId, credit } = await setup(t);
  let list = await site.request('/api/admin/card-payments?search=Credit%20Tester', {}, admin.cookie);
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 1);
  assert.equal(list.data.items[0].canCredit, true);
  assert.equal(list.data.items[0].cardTitle.length > 0, true);
  assert.equal(list.data.items[0].authorizationUrl, undefined);
  await credit();
  list = await site.request('/api/admin/card-payments?status=SUCCESS', {}, admin.cookie);
  assert.equal(list.data.items[0].canCredit, false);
  assert.equal(list.data.items[0].adminCredit.by, 'admin@example.com');
  assert.equal((await site.request('/api/admin/card-payments?search=nomatch-xyz', {}, admin.cookie)).data.total, 0);
});
