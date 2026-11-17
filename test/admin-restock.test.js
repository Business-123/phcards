const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('admin can restock all cards in one tap without touching the free gift or reducing stock', { timeout: 20000 }, async t => {
  const site = await createSite(t, { withHub: false, env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const restock = (body, cookie) => site.request('/api/admin/cards/restock', { method: 'POST', body: JSON.stringify(body) }, cookie);
  assert.equal((await restock({ level: 50 })).status, 401, 'admins only');
  const admin = (await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).cookie;
  assert.equal((await restock({ level: 0 }, admin)).status, 400);
  assert.equal((await restock({ level: 2.5 }, admin)).status, 400);
  assert.equal((await restock({ level: 5000 }, admin)).status, 400);

  // Make one card sold out and one over-stocked.
  const db = site.readDb(); const paid = db.cards.filter(c => !c.isFreeGift);
  paid[0].stock = 0; paid[0].active = false; paid[1].stock = 80;
  const gift = db.cards.find(c => c.isFreeGift); const giftStock = gift.stock;
  site.writeDb(db);

  const res = await restock({ level: 50 }, admin);
  assert.equal(res.status, 200);
  const after = site.readDb();
  for (const c of after.cards.filter(c => !c.isFreeGift)) { assert.ok(c.stock >= 50, `${c.id} restocked`); assert.equal(c.active, true); }
  assert.equal(after.cards.find(c => c.id === paid[0].id).stock, 50, 'sold-out card is back in stock');
  assert.equal(after.cards.find(c => c.id === paid[1].id).stock, 80, 'higher stock is never reduced');
  assert.equal(after.cards.find(c => c.isFreeGift).stock, giftStock, 'free gift untouched');
  assert.ok(res.data.restocked > 0 && res.data.unitsAdded > 0);
  assert.ok(after.adminAuditLogs.some(l => l.action === 'cards.restock'));

  const again = await restock({ level: 50 }, admin);
  assert.equal(again.data.restocked, 0, 'a second tap changes nothing');
});
