const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('future card redemptions use the backend x3.52-x4.42 reward range', { timeout: 30000 }, async t => {
  const site = await createSite(t);
  const signup = await site.signup('Reward User', '0241234501', 'reward-user@gmail.com');
  assert.equal(signup.status, 201);
  const state = await site.request('/api/state', {}, signup.cookie);
  const cards = [];
  for (const card of state.data.cards) {
    if (card.active && card.stock > 0 && !cards.some(item => item.displayPriceUsd === card.displayPriceUsd)) cards.push(card);
    if (cards.length === 3) break;
  }
  assert.equal(cards.length, 3);
  assert.ok(cards.every(card => card.rewardMinRate === 3.52 && card.rewardMaxRate === 4.42));

  for (const [index, card] of cards.entries()) {
    const { purchase } = await site.buyCard(signup.cookie, card.id, `reward_card_key_${index}_0001`);
    const reveal = await site.request(`/api/purchases/${encodeURIComponent(purchase.id)}/code`, { method: 'POST', body: '{}' }, signup.cookie);
    assert.equal(reveal.status, 200);
    const redeemed = await site.request('/api/redemptions', { method: 'POST', body: JSON.stringify({ code: reveal.data.code }) }, signup.cookie);
    assert.equal(redeemed.status, 200);
    const purchaseAmount = Number(redeemed.data.code.purchaseAmount);
    const rewardAmount = Number(redeemed.data.code.rewardAmount);
    const multiplier = Number(redeemed.data.code.rewardMultiplier);
    assert.ok(multiplier >= 3.52 && multiplier <= 4.42, `multiplier ${multiplier} is outside the new range`);
    assert.equal(rewardAmount, Math.round(purchaseAmount * multiplier * 100) / 100);
    assert.ok(rewardAmount > purchaseAmount, 'redemption must credit the calculated reward, not the purchase price');
    assert.equal(Number(redeemed.data.receipt.related.rewardMultiplier), multiplier);
  }
});

test('card checkout uses each user\'s own account email and every payment gets its own reference', { timeout: 20000 }, async t => {
  const site = await createSite(t);
  const first = await site.signup('Payment User One', '0241234511', 'real-one@gmail.com');
  const second = await site.signup('Payment User Two', '0241234512', 'real-two@gmail.com');
  for (const result of [first, second]) {
    assert.equal(result.status, 201);
    assert.ok(result.data.user.email.endsWith('@gmail.com'));
  }
  const state = await site.request('/api/state', {}, first.cookie);
  const [cardA, cardB] = state.data.cards.filter(card => card.active && card.stock > 2);

  const firstPayment = await site.startPurchase(first.cookie, cardA.id, 'payment_test_key_000001');
  const secondPayment = await site.startPurchase(first.cookie, cardB.id, 'payment_test_key_000002');
  const otherUser = await site.startPurchase(second.cookie, cardA.id, 'payment_test_key_000003');
  for (const result of [firstPayment, secondPayment, otherUser]) assert.equal(result.status, 201);
  assert.notEqual(firstPayment.data.payment.transactionId, secondPayment.data.payment.transactionId);
  assert.notEqual(firstPayment.data.payment.reference, secondPayment.data.payment.reference);
  assert.deepEqual(site.hub.initialized.map(payload => payload.email), [first.data.user.email, first.data.user.email, second.data.user.email]);
  assert.equal(site.hub.initialized[0].amount, cardA.priceGhs);
  assert.equal(site.hub.initialized[1].amount, cardB.priceGhs);

  // Only the confirmed payment turns into a card, no matter how often the hub repeats itself.
  assert.equal((await site.sendWebhook(firstPayment.data.payment.transactionId)).status, 200);
  assert.equal((await site.sendWebhook(firstPayment.data.payment.transactionId)).status, 200);
  const finalState = await site.request('/api/state', {}, first.cookie);
  assert.equal(finalState.data.purchases.length, 1);
  assert.equal(finalState.data.transactions.filter(tx => tx.reason === 'Card purchase').length, 1);
  const db = site.readDb();
  assert.equal(db.cardPayments.find(item => item.transactionId === firstPayment.data.payment.transactionId).status, 'SUCCESS');
  assert.equal(db.cardPayments.find(item => item.transactionId === secondPayment.data.payment.transactionId).status, 'PAYMENT_INITIALIZED');
});
