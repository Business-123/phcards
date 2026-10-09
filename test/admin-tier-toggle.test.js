const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

const tierOf = card => (card.displayPriceUsd <= 5 ? 'starter' : card.displayPriceUsd <= 10 ? 'core' : card.displayPriceUsd <= 20 ? 'premium' : 'vault');

test('admin can disable a tier: it vanishes for users, purchases are blocked, and enabling restores it', { timeout: 40000 }, async t => {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const user = await site.signup('Tier Toggler', '0241234590', 'tier.toggler@gmail.com');
  assert.equal(user.status, 201);
  const admin = await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(admin.status, 200);

  const before = await site.request('/api/state', {}, user.cookie);
  assert.deepEqual(before.data.disabledTiers, []);
  const core = before.data.cards.find(c => !c.isFreeGift && c.active && c.stock > 1 && tierOf(c) === 'core');
  assert.ok(core && before.data.cards.some(c => !c.isFreeGift && tierOf(c) === 'starter'));

  // Admin summary lists every tier, all on by default.
  const summary = await site.request('/api/admin/summary', {}, admin.cookie);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.data.settings.tiers.map(x => [x.key, x.enabled]), [['starter', true], ['core', true], ['premium', true], ['vault', true]]);

  // Only admins, and only real tier keys.
  const anon = await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledTiers: ['core'] }) });
  assert.equal(anon.status, 401);
  const bad = await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledTiers: ['nope'] }) }, admin.cookie);
  assert.equal(bad.status, 400);

  // Disable the core tier.
  const off = await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledTiers: ['core'], note: 'pause' }) }, admin.cookie);
  assert.equal(off.status, 200);
  assert.deepEqual(off.data.settings.disabledTiers, ['core']);
  let state = await site.request('/api/state', {}, user.cookie);
  assert.deepEqual(state.data.disabledTiers, ['core']);
  assert.equal(state.data.cards.filter(c => !c.isFreeGift && tierOf(c) === 'core').length, 0, 'tier is gone from the shop');
  assert.ok(state.data.cards.some(c => !c.isFreeGift && tierOf(c) === 'starter'), 'other tiers stay');
  const blocked = await site.startPurchase(user.cookie, core.id, 'tier_toggle_key_000001');
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /tier/i);
  assert.equal(site.readDb().settings.disabledTiers[0], 'core', 'persisted');

  // Enable it again.
  const on = await site.request('/api/admin/settings', { method: 'POST', body: JSON.stringify({ disabledTiers: [] }) }, admin.cookie);
  assert.equal(on.status, 200);
  state = await site.request('/api/state', {}, user.cookie);
  assert.deepEqual(state.data.disabledTiers, []);
  assert.ok(state.data.cards.some(c => !c.isFreeGift && tierOf(c) === 'core'));
  const ok = await site.startPurchase(user.cookie, core.id, 'tier_toggle_key_000002');
  assert.equal(ok.status, 201);
});
