const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

const tierOf = card => (card.displayPriceUsd <= 5 ? 'starter' : card.displayPriceUsd <= 10 ? 'core' : card.displayPriceUsd <= 20 ? 'premium' : 'vault');
const pickTier = (cards, tier, n) => cards.filter(c => !c.isFreeGift && c.active && c.stock > 4 && tierOf(c) === tier).slice(0, n);
// Move today's purchases to an earlier day so the separate daily cap doesn't get in the way.
const clearDailyCap = (site, userId) => {
  const db = site.readDb();
  db.purchases.filter(p => p.userId === userId).forEach(p => { p.createdAt = new Date(Date.now() - 2 * 86400000).toISOString(); });
  db.dailyPurchaseCounts = db.dailyPurchaseCounts.filter(d => d.userId !== userId);
  site.writeDb(db);
};

test('after two purchases in a price tier that tier never comes back, while other tiers stay', { timeout: 40000 }, async t => {
  const site = await createSite(t);
  const owner = await site.signup('Tier Buyer', '0241234580', 'tier.buyer@gmail.com');
  assert.equal(owner.status, 201);
  const before = await site.request('/api/state', {}, owner.cookie);
  assert.equal(before.data.purchaseLimits.tierMax, 2, 'default is two purchases per tier');
  assert.deepEqual(before.data.closedTiers, []);
  const [a, b, c] = pickTier(before.data.cards, 'starter', 3);
  const [other] = pickTier(before.data.cards, 'core', 1);
  assert.ok(a && b && c && other);

  await site.buyCard(owner.cookie, a.id, 'tier_card_a_key_0001');
  let state = await site.request('/api/state', {}, owner.cookie);
  assert.deepEqual(state.data.closedTiers, [], 'one purchase does not close the tier');
  assert.ok(state.data.cards.some(x => tierOf(x) === 'starter'));

  await site.buyCard(owner.cookie, b.id, 'tier_card_b_key_0001');
  state = await site.request('/api/state', {}, owner.cookie);
  assert.deepEqual(state.data.closedTiers, ['starter']);
  assert.equal(state.data.cards.filter(x => !x.isFreeGift && tierOf(x) === 'starter').length, 0, 'the whole tier is gone from the shop');
  assert.ok(state.data.cards.some(x => tierOf(x) === 'core'), 'other tiers are untouched');

  // Still gone on the next day and after a fresh load, and the server refuses it even if called directly.
  clearDailyCap(site, owner.data.user.id);
  state = await site.request('/api/state', {}, owner.cookie);
  assert.deepEqual(state.data.closedTiers, ['starter'], 'the daily reset does not reopen it');
  const direct = await site.startPurchase(owner.cookie, c.id, 'tier_card_c_key_0001');
  assert.equal(direct.status, 409);
  assert.match(direct.data.error, /tier/i);
  const stillOk = await site.startPurchase(owner.cookie, other.id, 'tier_other_key_0001');
  assert.equal(stillOk.status, 201, 'a different tier can still be bought');

  // It only affects this user.
  const stranger = await site.signup('Other Person', '0241234581', 'other.person@gmail.com');
  const strangerState = await site.request('/api/state', {}, stranger.cookie);
  assert.deepEqual(strangerState.data.closedTiers, []);
  assert.ok(strangerState.data.cards.some(x => tierOf(x) === 'starter'));
});

test('an in-flight checkout counts toward the tier cap so two payments cannot slip past it', { timeout: 30000 }, async t => {
  const site = await createSite(t);
  const owner = await site.signup('Racer', '0241234582', 'racer@gmail.com');
  const state = await site.request('/api/state', {}, owner.cookie);
  const [a, b, c] = pickTier(state.data.cards, 'starter', 3);
  await site.buyCard(owner.cookie, a.id, 'race_card_a_key_00001');
  const second = await site.startPurchase(owner.cookie, b.id, 'race_card_b_key_00001');
  assert.equal(second.status, 201, 'second checkout opens (one bought + none pending)');
  const third = await site.startPurchase(owner.cookie, c.id, 'race_card_c_key_00001');
  assert.equal(third.status, 409, 'third is blocked while the second is still open');
  assert.match(third.data.error, /tier/i);
});
