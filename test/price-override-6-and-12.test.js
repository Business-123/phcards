const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('the $6 card costs GHS 75 and the $12 card costs GHS 145, including cards saved with the old prices', { timeout: 30000 }, async t => {
  const site = await createSite(t);
  const fresh = await site.signup('Price Checker', '0241234595', 'price.checker@gmail.com');
  const cards = (await site.request('/api/state', {}, fresh.cookie)).data.cards.filter(c => !c.isFreeGift);
  const six = cards.filter(c => c.displayPriceUsd === 6), twelve = cards.filter(c => c.displayPriceUsd === 12);
  assert.ok(six.length && twelve.length);
  assert.ok(six.every(c => c.priceGhs === 75 && c.price === 75), '$6 cards are GHS 75');
  assert.ok(twelve.every(c => c.priceGhs === 145 && c.price === 145), '$12 cards are GHS 145');
  assert.ok(cards.filter(c => c.displayPriceUsd === 7).every(c => c.priceGhs === 84), 'other prices unchanged');
});
