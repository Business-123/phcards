// Regression tests for "debited but card not credited": every confirmation path must
// settle a paid charge exactly once, even when the webhook is lost or the hub hiccups.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSite, HUB_SECRET } = require('./helpers');

async function begin(site, key = 'reconcile_test_key_0001') {
  const owner = await site.signup('Pay Tester', '0241112233');
  assert.equal(owner.status, 201);
  const state = await site.request('/api/state', {}, owner.cookie);
  const card = state.data.cards.find(item => !item.isFreeGift && item.active && item.stock > 0);
  const started = await site.startPurchase(owner.cookie, card.id, key);
  assert.equal(started.status, 201);
  const { transactionId } = started.data.payment;
  const reference = site.hub.referenceFor(transactionId);
  const poll = () => site.request(`/api/card-payments/${encodeURIComponent(transactionId)}`, {}, owner.cookie);
  return { owner, card, transactionId, reference, poll };
}
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return null; };

test('lost webhook: the status poll verifies with the hub and issues the card', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  assert.equal((await p.poll()).data.payment.status, 'PAYMENT_INITIALIZED', 'unpaid stays pending');
  site.hub.setStatus(p.reference, 'SUCCESS');             // customer paid, webhook never arrives
  await new Promise(r => setTimeout(r, 2600));            // status polls are throttled to one per ~2.5s
  const paid = await p.poll();
  assert.equal(paid.data.payment.status, 'SUCCESS');
  assert.ok(paid.data.purchase, 'card was issued without any webhook');
  assert.equal(site.readDb().purchases.length, 1);
});

test('lost webhook and closed tab: the background reconciler issues the card by itself', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '1' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  const db = await waitFor(() => { const d = site.readDb(); return d.purchases.length ? d : null; });
  assert.ok(db, 'reconciler credited the card with no webhook, return hop or poll');
  assert.equal(db.cardPayments[0].status, 'SUCCESS');
  assert.equal(db.cardPayments[0].settledBy === 'scheduler' || db.cardPayments[0].settledBy === 'startup', true);
  assert.equal(db.codes.length, 1);
});

test('a transient hub outage is retried instead of failing the confirmation', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  site.hub.failNextVerifies(1);
  const paid = await p.poll();
  assert.equal(paid.data.payment.status, 'SUCCESS', 'second attempt succeeded');
  assert.ok(site.hub.faults.verifyCalls >= 2);
});

test('hub fully unreachable: status stays pending (never "failed") and recovers on the next check', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  site.hub.failNextVerifies(50);
  const during = await p.poll();
  assert.equal(during.data.payment.status, 'PAYMENT_INITIALIZED', 'unknown outcome is not reported as failed');
  assert.equal(site.readDb().cardPayments[0].stockReserved, true, 'stock stays held while unsure');
  site.hub.failNextVerifies(0);
  await new Promise(r => setTimeout(r, 2600));              // status polls are throttled to one per ~2.5s
  assert.equal((await p.poll()).data.payment.status, 'SUCCESS');
});

test('signed webhook with incomplete metadata is still honoured (verified with the hub)', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  const res = await site.sendWebhook(p.transactionId, 'SUCCESS', { metadata: {}, amount: undefined });
  assert.equal(res.status, 200);
  assert.equal(site.readDb().purchases.length, 1, 'card issued even though the webhook body was incomplete');
});

test('webhook that arrives before our bookkeeping stored the hub reference still credits the card', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  const db = site.readDb(); delete db.cardPayments[0].paystackReference; db.cardPayments[0].status = 'PENDING'; site.writeDb(db);
  site.hub.setStatus(p.reference, 'SUCCESS');
  assert.equal((await site.sendWebhook(p.transactionId)).status, 200);
  const after = site.readDb();
  assert.equal(after.cardPayments[0].paystackReference, p.reference);
  assert.equal(after.purchases.length, 1);
});

test('hub down + valid signed SUCCESS webhook: credited from the signed event', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.failNextVerifies(50);
  assert.equal((await site.sendWebhook(p.transactionId)).status, 200);
  assert.equal(site.readDb().purchases.length, 1);
});

test('hub down + signed FAILED webhook frees the stock, and a later success is still credited', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.failNextVerifies(50);
  assert.equal((await site.sendWebhook(p.transactionId, 'FAILED')).status, 200);
  assert.equal(site.readDb().purchases.length, 0);
  assert.equal(site.readDb().cardPayments[0].status, 'FAILED');
  site.hub.failNextVerifies(0); site.hub.setStatus(p.reference, 'SUCCESS');   // it actually went through later
  await new Promise(r => setTimeout(r, 2600));
  assert.equal((await p.poll()).data.payment.status, 'SUCCESS', 'FAILED is never final while the hub can still say SUCCESS');
});

test('webhook we cannot verify and cannot trust (no metadata) asks the hub to retry (503)', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.failNextVerifies(50);
  const res = await site.sendWebhook(p.transactionId, 'SUCCESS', { metadata: { purpose: 'CARD_PURCHASE', transactionId: p.transactionId }, amount: 999 });
  assert.equal(res.status, 503);
  assert.equal(site.readDb().purchases.length, 0);
});

test('payment that completes after the session expired is still credited', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  const db = site.readDb(); db.cardPayments[0].expiresAt = new Date(Date.now() - 1000).toISOString(); site.writeDb(db);
  await site.request('/api/state', {}, p.owner.cookie);      // sweep marks it EXPIRED and frees the stock
  assert.equal(site.readDb().cardPayments[0].status, 'EXPIRED');
  site.hub.setStatus(p.reference, 'SUCCESS');                // customer finished paying late (e.g. mobile money)
  const paid = await p.poll();
  assert.equal(paid.data.payment.status, 'SUCCESS');
  assert.equal(site.readDb().purchases.length, 1);
});

test('webhook + status poll + return hop racing each other still issue exactly one card', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  await Promise.all([
    site.sendWebhook(p.transactionId), site.sendWebhook(p.transactionId), p.poll(), p.poll(),
    fetch(`${site.baseUrl}/api/payment/return?reference=${p.reference}`, { redirect: 'manual' }),
  ]);
  const db = site.readDb();
  assert.equal(db.purchases.length, 1);
  assert.equal(db.codes.length, 1);
  assert.equal(db.transactions.filter(x => x.reason === 'Card purchase').length, 1);
});

test('a charge for the wrong amount is flagged for review and never auto-issued', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS'); site.hub.setAmount(p.reference, 0.01);
  const res = await p.poll();
  assert.equal(res.data.payment.status, 'PAID_AMOUNT_MISMATCH');
  const db = site.readDb();
  assert.equal(db.purchases.length, 0);
  assert.equal(db.cards.find(c => c.id === p.card.id).stock, p.card.stock, 'held stock was released');
});

test('a genuinely failed charge releases the held stock', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'FAILED');
  assert.equal((await p.poll()).data.payment.status, 'FAILED');
  assert.equal(site.readDb().cards.find(c => c.id === p.card.id).stock, p.card.stock);
});

test('webhooks with a bad signature are rejected', { timeout: 20000 }, async t => {
  const site = await createSite(t, { env: { PAYMENT_RECONCILE_SECONDS: '0' } });
  const p = await begin(site);
  site.hub.setStatus(p.reference, 'SUCCESS');
  const raw = JSON.stringify({ event: 'transaction.completed', reference: p.reference, status: 'SUCCESS' });
  const bad = crypto.createHmac('sha512', HUB_SECRET + 'x').update(raw).digest('hex');
  const res = await site.request('/api/webhooks/hub', { method: 'POST', body: raw, headers: { 'x-hub-signature': bad } });
  assert.equal(res.status, 401);
  assert.equal(site.readDb().purchases.length, 0);
});
