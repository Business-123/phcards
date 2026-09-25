const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('tapping buy opens a checkout for the exact card price and one payment yields one card', { timeout: 20000 }, async t => {
  const site = await createSite(t);
  const owner = await site.signup('Owner One', '0241234567');
  assert.equal(owner.status, 201);
  const state = await site.request('/api/state', {}, owner.cookie);
  const card = state.data.cards.find(item => item.active && item.stock > 0);
  assert.ok(card, 'a purchasable card is available');

  const key = 'purchase_test_key_000001';
  const started = await site.startPurchase(owner.cookie, card.id, key);
  assert.equal(started.status, 201);
  assert.match(started.data.payment.checkoutUrl, /^http:\/\/127\.0\.0\.1:\d+\/checkout\//);
  assert.equal(started.data.payment.amount, card.priceGhs, 'checkout is for exactly the card price');
  assert.equal(site.hub.initialized.length, 1);
  assert.equal(site.hub.initialized[0].amount, card.priceGhs);
  assert.equal(site.hub.initialized[0].metadata.purpose, 'CARD_PURCHASE');
  assert.equal(site.readDb().purchases.length, 0, 'nothing is issued before the payment is confirmed');
  assert.equal(site.readDb().cards.find(item => item.id === card.id).stock, card.stock - 1, 'one unit is held while paying');

  const again = await site.startPurchase(owner.cookie, card.id, key);
  assert.equal(again.status, 200, 'tapping again re-uses the open checkout');
  assert.equal(again.data.payment.checkoutUrl, started.data.payment.checkoutUrl);
  assert.equal(site.hub.initialized.length, 1, 'no second hub session was created');

  const { transactionId } = started.data.payment;
  assert.equal((await site.sendWebhook(transactionId)).status, 200);
  assert.equal((await site.sendWebhook(transactionId)).status, 200, 'a repeated webhook is harmless');
  const paid = await site.request(`/api/card-payments/${encodeURIComponent(transactionId)}`, {}, owner.cookie);
  assert.equal(paid.data.payment.status, 'SUCCESS');
  assert.equal(paid.data.purchase.cardId, card.id);
  assert.ok(paid.data.state.codes.every(code => code.code === undefined), 'ordinary state has no redeem codes');
  assert.ok(paid.data.state.transactions.every(tx => tx.related.code === undefined), 'purchase ledger response has no code');

  let db = site.readDb();
  assert.equal(db.purchases.length, 1, 'one payment creates one purchase');
  assert.equal(db.codes.length, 1, 'one payment creates one owned code');
  assert.equal(db.cards.find(item => item.id === card.id).stock, card.stock - 1, 'stock is decremented once');
  assert.equal(db.users.find(user => user.id === owner.data.user.id).walletBalance, 0, 'no wallet is involved');
  const ledger = db.transactions.find(tx => tx.reason === 'Card purchase');
  assert.equal(ledger.account, 'external');

  const duplicate = await site.startPurchase(owner.cookie, card.id, key);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
  assert.equal(duplicate.data.purchase.id, paid.data.purchase.id, 'the same key returns the finished purchase');
  assert.equal(site.hub.initialized.length, 1);

  const other = await site.signup('Owner Two', '0241234568');
  const forbidden = await site.request(`/api/purchases/${paid.data.purchase.id}/code`, { method: 'POST', body: '{}' }, other.cookie);
  assert.equal(forbidden.status, 404, 'another user cannot retrieve the code');
  const notTheirs = await site.request(`/api/card-payments/${encodeURIComponent(transactionId)}`, {}, other.cookie);
  assert.equal(notTheirs.status, 404, 'another user cannot read the payment');

  const reveal = await site.request(`/api/purchases/${paid.data.purchase.id}/code`, { method: 'POST', body: '{}' }, owner.cookie);
  assert.equal(reveal.status, 200);
  assert.match(reveal.data.code, /^[A-Z]{2}[A-Z0-9]{12}$/);
  const redeemed = await site.request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, owner.cookie);
  assert.equal(redeemed.status, 200);
  const redeemedAgain = await site.request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, owner.cookie);
  assert.equal(redeemedAgain.status, 409, 'a redeemed card cannot be redeemed twice');
  const revealAfterRedeem = await site.request(`/api/purchases/${paid.data.purchase.id}/code`, { method: 'POST', body: '{}' }, owner.cookie);
  assert.equal(revealAfterRedeem.status, 409, 'a redeemed card cannot be revealed again');
});

test('failed, wrong-amount and abandoned payments never issue a card and never keep stock', { timeout: 20000 }, async t => {
  const site = await createSite(t);
  const buyer = await site.signup('Payment Buyer', '0241234570');
  const state = await site.request('/api/state', {}, buyer.cookie);
  const card = state.data.cards.find(item => item.active && item.stock > 2);
  const stockOf = () => site.readDb().cards.find(item => item.id === card.id).stock;

  // Declined payment.
  const declined = await site.startPurchase(buyer.cookie, card.id, 'declined_payment_key_01');
  assert.equal(declined.status, 201);
  assert.equal(stockOf(), card.stock - 1);
  assert.equal((await site.sendWebhook(declined.data.payment.transactionId, 'FAILED')).status, 200);
  assert.equal(stockOf(), card.stock, 'a failed payment releases the held stock');
  assert.equal(site.readDb().purchases.length, 0);

  // A confirmation for the wrong amount is ignored.
  const wrong = await site.startPurchase(buyer.cookie, card.id, 'wrong_amount_key_0001');
  const mismatch = await site.sendWebhook(wrong.data.payment.transactionId, 'SUCCESS', { amount: 1 });
  assert.equal(mismatch.data.mismatched, true);
  assert.equal(site.readDb().purchases.length, 0, 'an under-payment never issues a card');

  // Abandoned checkout: the window closes, stock is released on the next request.
  let db = site.readDb();
  db.cardPayments.forEach(item => { item.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  site.writeDb(db);
  await site.request('/api/state', {}, buyer.cookie);
  assert.equal(stockOf(), card.stock, 'expired sessions do not hold stock');
  assert.equal(site.readDb().cardPayments.find(item => item.transactionId === wrong.data.payment.transactionId).status, 'EXPIRED');

  // Paying just after the window closes still gets the customer their card.
  const late = await site.sendWebhook(wrong.data.payment.transactionId, 'SUCCESS');
  assert.equal(late.status, 200);
  db = site.readDb();
  assert.equal(db.purchases.length, 1, 'a late confirmation is fulfilled while stock remains');
  assert.equal(stockOf(), card.stock - 1);

  // Returning through the browser reconciles against the hub, not the URL.
  const browser = await site.startPurchase(buyer.cookie, card.id, 'browser_return_key_001');
  const reference = site.hub.referenceFor(browser.data.payment.transactionId);
  const pending = await site.request(`/api/payments/${reference}/complete`, { method: 'POST', body: '{}' });
  assert.equal(pending.status, 202, 'unpaid sessions stay pending');
  site.hub.setStatus(reference, 'SUCCESS');
  const complete = await site.request(`/api/payments/${reference}/complete`, { method: 'POST', body: '{}' });
  assert.equal(complete.status, 200);
  assert.match(complete.data.redirect, /card_payment=1&transactionId=/);
  assert.equal(site.readDb().purchases.length, 2);
});

test('buying is unavailable when the payment hub is not configured or the visitor is signed out', { timeout: 15000 }, async t => {
  const site = await createSite(t, { withHub: false });
  const buyer = await site.signup('No Hub Buyer', '0241234571');
  const state = await site.request('/api/state', {}, buyer.cookie);
  const card = state.data.cards.find(item => item.active && item.stock > 0);
  const unconfigured = await site.startPurchase(buyer.cookie, card.id, 'no_hub_purchase_key_1');
  assert.equal(unconfigured.status, 503);
  const signedOut = await site.startPurchase('', card.id, 'signed_out_purchase_k1');
  assert.equal(signedOut.status, 401);
  assert.equal(site.readDb().cards.find(item => item.id === card.id).stock, card.stock, 'no stock is held');
});

test('the old deposit endpoints are gone', { timeout: 15000 }, async t => {
  const site = await createSite(t);
  const user = await site.signup('Former Depositor', '0241234572');
  const deposit = await site.request('/api/deposits', { method: 'POST', body: JSON.stringify({ amount: 30 }) }, user.cookie);
  assert.ok([404, 405].includes(deposit.status), `deposits are not served (got ${deposit.status})`);
  const config = await site.request('/api/config');
  assert.equal(config.data.minDeposit, undefined);
});

test('each exact USD price allows two Ghana-calendar-day purchases and resets at midnight', { timeout: 30000 }, async t => {
  const site = await createSite(t);
  const owner = await site.signup('Daily Buyer', '0241234577', 'daily.buyer@gmail.com');
  assert.equal(owner.status, 201);
  const initial = await site.request('/api/state', {}, owner.cookie);
  const cardA = initial.data.cards.find(item => item.active && item.stock > 4);
  const cardB = initial.data.cards.find(item => item.active && item.stock > 4 && item.id !== cardA.id && item.displayPriceUsd === cardA.displayPriceUsd);
  const cardC = initial.data.cards.find(item => item.active && item.stock > 4 && item.displayPriceUsd !== cardA.displayPriceUsd);
  assert.ok(cardA && cardB && cardC, 'same-price and different-price cards with enough stock are available');
  assert.match(initial.data.purchaseLimits.resetAt, /T00:00:00\.000Z$/, 'reset is at Ghana midnight/UTC midnight');

  await site.buyCard(owner.cookie, cardA.id, 'daily_card_a_key_01');
  await site.buyCard(owner.cookie, cardB.id, 'daily_card_b_key_01'); // a different card at the same price shares the quota
  const thirdA = await site.startPurchase(owner.cookie, cardA.id, 'daily_card_a_key_03');
  assert.equal(thirdA.status, 409, 'third purchase at the same price is rejected server-side');
  assert.match(thirdA.data.error, /limit.*reached/i);

  const rapidC = await Promise.all([
    site.startPurchase(owner.cookie, cardC.id, 'daily_card_c_key_01'),
    site.startPurchase(owner.cookie, cardC.id, 'daily_card_c_key_02'),
    site.startPurchase(owner.cookie, cardC.id, 'daily_card_c_key_03'),
  ]);
  assert.deepEqual(rapidC.map(result => result.status).sort(), [201, 201, 409], 'unfinished payments count toward the price limit');

  let db = site.readDb();
  assert.equal(db.purchases.filter(item => item.cardId === cardA.id).length, 1);
  assert.equal(db.purchases.filter(item => item.cardId === cardB.id).length, 1);

  // Move Card A/B purchases to an earlier calendar day: the limit is date-based, not a rolling 24 hours.
  const earlier = new Date(Date.now() - 2 * 86400000).toISOString();
  db.purchases.filter(item => [cardA.id, cardB.id].includes(item.cardId)).forEach(item => { item.createdAt = earlier; });
  site.writeDb(db);
  const resetState = await site.request('/api/state', {}, owner.cookie);
  assert.equal(resetState.data.purchaseLimits.counts[cardA.displayPriceUsd.toFixed(2)], undefined, 'the shared price quota resets on the new calendar day');
  const afterReset = await site.startPurchase(owner.cookie, cardB.id, 'daily_card_b_reset_02');
  assert.equal(afterReset.status, 201, 'a same-price card can be purchased again after the calendar reset');
});
