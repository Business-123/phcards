const test = require('node:test');
const assert = require('node:assert/strict');
const { createSite } = require('./helpers');

// Money paid out of a user's redeemed balance is not real income: it must be left out of every earnings stat,
// and both dashboards show "earned today" plus a separate "total earnings".
test('admin and promoter stats exclude redeemed-balance payments and show today + total earnings', { timeout: 40000 }, async t => {
  const site = await createSite(t, { env: { ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' } });
  const admin = (await site.request('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).cookie;
  const promoter = (await site.request('/api/admin/promoters', { method: 'POST', body: JSON.stringify({ name: 'Ama Promoter' }) }, admin)).data.promoter;
  const signup = await site.request('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Esi Mensah', phone: '0242222222', email: 'esi@gmail.com', password: 'simple' }) }, 'phantom_ref=1');
  assert.equal(signup.status, 201);

  const db = site.readDb();
  const userId = db.users.find(u => u.phone === '0242222222').id;
  const todayIso = new Date().toISOString();
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const purchase = (id, amount, createdAt, extra = {}) => db.purchases.push({ id, userId, cardId: 'CARD-0002', amount, amountPaid: amount, status: 'sealed', createdAt, ...extra });
  purchase('p_today_real', 36, todayIso);                                         // real money, today
  purchase('p_today_balance', 500, todayIso, { paidWith: 'redeemed_balance' });   // balance: excluded
  purchase('p_old_real', 12, old);                                                // real money, earlier
  purchase('p_old_balance', 200, old, { paidWith: 'redeemed_balance' });          // balance: excluded
  db.kycBypassPayments.push({ id: 'k1', userId, amount: 70, status: 'success', reference: 'KYC1', createdAt: todayIso, verifiedAt: todayIso });
  db.kycBypassPayments.push({ id: 'k2', userId, amount: 70, status: 'success', paidWith: 'redeemed_balance', reference: 'KYC2', createdAt: todayIso, verifiedAt: todayIso });
  db.instantPayoutPayments.push({ id: 'i1', userId, amount: 100, status: 'success', reference: 'INS1', createdAt: old, verifiedAt: old });
  db.instantPayoutPayments.push({ id: 'i2', userId, amount: 100, status: 'success', paidWith: 'redeemed_balance', reference: 'INS2', createdAt: todayIso, verifiedAt: todayIso });
  site.writeDb(db);

  // ---- Admin dashboard ----
  const m = (await site.request('/api/admin/summary', {}, admin)).data.metrics;
  assert.equal(m.earnedToday, 36 + 70, 'today: real card purchase + real KYC fee only');
  assert.equal(m.paymentsToday, 2);
  assert.equal(m.totalEarnings, 36 + 12 + 70 + 100, 'all time: real payments only');
  assert.equal(m.totalFromCards, 48);
  assert.equal(m.totalFromFees, 170);
  assert.equal(m.purchaseVolume, 48, 'card purchase volume excludes balance purchases');
  assert.equal(m.purchases, 2, 'purchase count excludes balance purchases');
  const spentOnTrend = (await site.request('/api/admin/summary', {}, admin)).data.trend.reduce((sum, d) => sum + d.spent, 0);
  assert.equal(spentOnTrend, 48 + 70 + 100, 'the daily chart excludes balance payments too');

  // ---- Promoter dashboard (card purchases of the promoter's own customers) ----
  const dash = await site.request('/api/partner/dashboard', { headers: { 'x-partner-number': String(promoter.number), 'x-partner-code': promoter.accessKey } });
  assert.equal(dash.status, 200, JSON.stringify(dash.data));
  assert.equal(dash.data.earnedToday, 36, 'today: the real card purchase only');
  assert.equal(dash.data.cardsToday, 1);
  assert.equal(dash.data.totalEarnings, 48, 'total: real purchases only');
  assert.equal(dash.data.totalPurchased, 48);
  assert.equal(dash.data.cardsPurchased, 2, 'balance-paid cards are not counted');
  assert.equal(dash.data.users[0].amount, 48);
  assert.equal(dash.data.trend.reduce((sum, d) => sum + d.amount, 0), 48, 'the 14-day chart excludes balance payments');
});
