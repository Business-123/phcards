const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('free gift card costs nothing, needs no payment, and can be claimed only once per account', { timeout: 20000 }, async t => {
  const site = await createSite(t);
  const owner = await site.signup('Gift Owner', '0241234567');
  assert.equal(owner.status, 201);
  const state = await site.request('/api/state', {}, owner.cookie);
  const gift = state.data.cards.find(card => card.isFreeGift);
  assert.ok(gift, 'the free gift card is listed in the shop');
  assert.equal(gift.id, 'CARD-0001');
  assert.equal(gift.price, 0);
  assert.equal(gift.priceGhs, 0);
  assert.equal(gift.active, true);

  // The paid checkout route must never be usable for the gift.
  const paid = await site.startPurchase(owner.cookie, gift.id, 'purchase_test_key_gift_0001');
  assert.equal(paid.status, 404);
  assert.equal(site.hub.initialized.length, 0, 'no payment session was opened');

  const claim = await site.request('/api/claim-gift', { method: 'POST', body: JSON.stringify({ cardId: gift.id }) }, owner.cookie);
  assert.equal(claim.status, 201);
  assert.equal(claim.data.purchase.amountPaid, 0);
  assert.equal(claim.data.purchase.isFreeGift, true);
  assert.equal(site.hub.initialized.length, 0, 'claiming never touches the payment hub');

  let db = site.readDb();
  assert.equal(db.purchases.length, 1);
  assert.equal(db.codes.length, 1);
  assert.ok(db.codes[0].rewardAmount > 0, 'the gift still carries a real reward');
  assert.equal(db.transactions.filter(tx => tx.reason === 'Card purchase').length, 0, 'no money movement is recorded');
  assert.equal(db.dailyPurchaseCounts.length, 0, 'a free gift does not use up the daily buy limit');

  const second = await site.request('/api/claim-gift', { method: 'POST', body: JSON.stringify({ cardId: gift.id }) }, owner.cookie);
  assert.equal(second.status, 409, 'a second claim by the same account is rejected');
  db = site.readDb();
  assert.equal(db.purchases.length, 1);
  assert.equal(db.codes.length, 1);

  // A different account can claim its own single gift.
  const other = await site.signup('Other Person', '0247654321', 'other@gmail.com');
  const otherClaim = await site.request('/api/claim-gift', { method: 'POST', body: JSON.stringify({ cardId: gift.id }) }, other.cookie);
  assert.equal(otherClaim.status, 201);

  // Non-gift cards cannot be claimed for free.
  const normal = state.data.cards.find(card => !card.isFreeGift && card.active && card.stock > 0);
  const bad = await site.request('/api/claim-gift', { method: 'POST', body: JSON.stringify({ cardId: normal.id }) }, owner.cookie);
  assert.equal(bad.status, 404);
});
