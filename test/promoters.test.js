const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

test('promoter links track sign-ups and card purchases, and dashboards are private', { timeout: 30000 }, async t => {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const admin = (await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).cookie;
  const post = (p, body = {}) => site.request(p, { method: 'POST', body: JSON.stringify(body) }, admin);

  // Ordinary static files must still be served (regression guard).
  assert.equal((await fetch(`${site.baseUrl}/app.js`)).status, 200);
  assert.equal((await fetch(`${site.baseUrl}/admin`)).status, 200);
  assert.equal((await fetch(`${site.baseUrl}/admin.css`)).status, 200);

  // Only admins can manage promoters.
  assert.equal((await site.request('/api/admin/promoters')).status, 401);
  assert.equal((await site.request('/api/admin/promoters', { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status, 401);
  assert.equal((await post('/api/admin/promoters', { name: '  ' })).status, 400);

  const p1 = (await post('/api/admin/promoters', { name: 'Ama Promoter' })).data.promoter;
  const p2 = (await post('/api/admin/promoters', { name: 'Kofi Promoter' })).data.promoter;
  assert.equal(p1.number, 1); assert.equal(p2.number, 2);
  assert.match(p1.accessKey, /^[A-HJKMNP-Z2-9]{8}$/); assert.notEqual(p1.accessKey, p2.accessKey);

  // /1 shows the store, tags the visitor and counts one visit per visitor.
  const hit = await fetch(`${site.baseUrl}/1`);
  assert.equal(hit.status, 200);
  assert.match(await hit.text(), /<html/i);
  assert.match(hit.headers.get('set-cookie'), /phantom_ref=1/);
  await fetch(`${site.baseUrl}/1`, { headers: { cookie: 'phantom_ref=1' } });
  assert.equal(site.readDb().promoters.find(p => p.number === 1).clicks, 1, 'a returning visitor is not counted twice');
  const unknown = await fetch(`${site.baseUrl}/999`);
  assert.equal(unknown.status, 200); assert.equal(unknown.headers.get('set-cookie'), null, 'unknown number sets no tag');
  assert.equal((await fetch(`${site.baseUrl}/1/`, { redirect: 'manual' })).status, 302);

  // Sign-ups are attributed from the cookie.
  const a = await site.signup('Esi Mensah Owusu', '0241111111');
  const refA = await site.request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Esi Mensah Owusu', phone: '0242222222', email: 'esi@gmail.com', password: 'simple' }) }, 'phantom_ref=1');
  const refB = await site.request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Yaw Boateng', phone: '0243333333', email: 'yaw@gmail.com', password: 'simple' }) }, 'phantom_ref=2');
  const bogus = await site.request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Nobody', phone: '0244444444', email: 'nobody@gmail.com', password: 'simple' }) }, 'phantom_ref=77');
  assert.equal(a.status, 201); assert.equal(refA.status, 201); assert.equal(bogus.status, 201);
  const users = site.readDb().users;
  assert.equal(users.find(u => u.phone === '0241111111').promoterId, undefined);
  assert.equal(users.find(u => u.phone === '0242222222').promoterId, p1.id);
  assert.equal(users.find(u => u.phone === '0243333333').promoterId, p2.id);
  assert.equal(users.find(u => u.phone === '0244444444').promoterId, undefined);

  // Purchases: only the referred customer's card spend counts for promoter 1.
  const card = (await site.request('/api/state', {}, refA.cookie)).data.cards.find(c => !c.isFreeGift && c.active && c.stock > 0);
  await site.buyCard(refA.cookie, card.id, 'promoter_buy_key_00000001');
  const otherCard = (await site.request('/api/state', {}, a.cookie)).data.cards.find(c => !c.isFreeGift && c.active && c.stock > 0);
  await site.buyCard(a.cookie, otherCard.id, 'promoter_buy_key_00000002');

  const dash = (code, number = 1) => site.request('/api/partner/dashboard', { headers: { 'x-partner-number': String(number), 'x-partner-code': code } });
  const d1 = await dash(p1.accessKey);
  assert.equal(d1.status, 200);
  assert.equal(d1.data.promoter.name, 'Ama Promoter');
  assert.equal(d1.data.totalPurchased, card.priceGhs);
  assert.equal(d1.data.cardsPurchased, 1);
  assert.equal(d1.data.signups, 1); assert.equal(d1.data.buyers, 1); assert.equal(d1.data.clicks, 1);
  assert.equal(d1.data.users.length, 1);
  assert.equal(d1.data.users[0].name, 'Esi O.', 'customer names are shortened');
  assert.equal(JSON.stringify(d1.data).includes('0242222222'), false, 'no phone numbers leak');
  assert.equal(JSON.stringify(d1.data).includes('esi@gmail.com'), false, 'no emails leak');
  assert.equal(d1.data.trend.length, 14);
  assert.equal(d1.data.trend.reduce((n, x) => n + x.amount, 0), card.priceGhs);

  const d2 = await dash(p2.accessKey, 2);
  assert.equal(d2.data.totalPurchased, 0); assert.equal(d2.data.signups, 1); assert.equal(d2.data.buyers, 0);

  // Dashboard lives at /admin1, /admin2 ... and needs the promoter's own access code.
  assert.equal((await dash('WRONGCODE')).status, 401);
  assert.equal((await dash(p2.accessKey, 1)).status, 401, 'another promoter\'s code does not open this dashboard');
  assert.equal((await dash(p1.accessKey, 99)).status, 401);
  assert.equal((await site.request('/api/partner/dashboard')).status, 401);
  assert.equal((await dash(p1.accessKey.toLowerCase())).status, 200, 'code is not case sensitive');
  for (const n of [1, 2]) { const page = await fetch(`${site.baseUrl}/admin${n}`); assert.equal(page.status, 200); assert.match(await page.text(), /Promoter Dashboard/); }
  assert.equal((await fetch(`${site.baseUrl}/partner/${p1.accessKey}`)).status, 404, 'old link style is gone');

  // Admin overview adds up per promoter.
  const list = (await site.request('/api/admin/promoters', {}, admin)).data;
  assert.equal(list.items.length, 2);
  assert.equal(list.items.find(i => i.number === 1).totalPurchased, card.priceGhs);
  assert.equal(list.totals.totalPurchased, card.priceGhs);

  // Pausing stops tracking and the dashboard; resuming restores it.
  assert.equal((await post(`/api/admin/promoters/${p1.id}/toggle`, { active: false })).data.promoter.active, false);
  assert.equal((await dash(p1.accessKey)).status, 401, 'paused dashboard is locked');
  assert.equal((await fetch(`${site.baseUrl}/1`)).headers.get('set-cookie'), null);
  const late = await site.request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Late Joiner', phone: '0245555555', email: 'late@gmail.com', password: 'simple' }) }, 'phantom_ref=1');
  assert.equal(site.readDb().users.find(u => u.id === late.data.user.id).promoterId, undefined);
  await post(`/api/admin/promoters/${p1.id}/toggle`, { active: true });
  assert.equal((await dash(p1.accessKey)).status, 200);

  // A new access code kills the old one.
  const rekeyed = (await post(`/api/admin/promoters/${p1.id}/rekey`)).data.promoter;
  assert.notEqual(rekeyed.accessKey, p1.accessKey);
  assert.equal((await dash(p1.accessKey)).status, 401, 'old code stops working');
  assert.equal((await dash(rekeyed.accessKey)).data.totalPurchased, card.priceGhs);
});
