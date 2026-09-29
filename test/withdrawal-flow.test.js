const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
}

test('a confirmed GHS 70 KYC bypass leaves its withdrawal pending for admin approval', { timeout: 15000 }, async t => {
  const port = await freePort();
  const hubPort = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-withdrawal-test-${process.pid}-${Date.now()}.json`);
  const hubApiSecret = 'test-hub-api-secret';
  const paymentHub = require('node:http').createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/transaction/initialize') {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: true,
      data: { reference: 'PCS_TEST_PAYMENT_0001', checkoutUrl: `http://127.0.0.1:${hubPort}/checkout/PCS_TEST_PAYMENT_0001` },
    }));
  });
  await new Promise(resolve => paymentHub.listen(hubPort, '127.0.0.1', resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      PHANTOM_DATA_FILE: dataFile,
      HUB_BASE_URL: `http://127.0.0.1:${hubPort}`,
      HUB_API_KEY: 'test-hub-api-key',
      HUB_API_SECRET: hubApiSecret,
      PAYSTACK_CURRENCY: 'GHS',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    server.kill();
    await new Promise(resolve => paymentHub.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const request = async (pathname, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };

  const signup = await request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name: 'Withdrawal User', phone: '0241234577', email: 'withdrawal.user@gmail.com', password: 'simple' }),
  });
  assert.equal(signup.status, 201);
  const addMethod = await request('/api/methods', {
    method: 'POST',
    body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'Withdrawal User', phone: '0241234577', pin: '1234' }),
  }, signup.cookie);
  assert.equal(addMethod.status, 201);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const userId = signup.data.user.id;
  for (let index = 0; index < 3; index++) {
    db.purchases.push({ id: `purchase_${index}`, userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
    db.codes.push({ id: `redeemed_${index}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
    db.transactions.push({ id: `credit_${index}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `REDEMPTION_${index}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  }
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const before = await request('/api/state', {}, signup.cookie);
  assert.equal(before.data.user.redeemedBalance, 300);

  // Unverified user: the request goes straight to the KYC payment. Nothing is deducted
  // and no withdrawal (pending or otherwise) is created until the fee is paid.
  const withdrawalResult = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234', returnOrigin: `http://127.0.0.1:${port}` }),
  }, signup.cookie);
  assert.equal(withdrawalResult.status, 201);
  assert.equal(withdrawalResult.data.kycRequired, true);
  assert.ok(withdrawalResult.data.checkoutUrl);
  assert.equal(withdrawalResult.data.withdrawal, undefined, 'no withdrawal is created before the KYC fee is paid');
  assert.equal(withdrawalResult.data.state.user.redeemedBalance, 300, 'balance is not deducted before the KYC fee is paid');

  const unpaid = await request('/api/state', {}, signup.cookie);
  assert.equal(unpaid.data.user.redeemedBalance, 300);
  assert.equal(unpaid.data.withdrawals.length, 0, 'nothing shows in withdrawal history');
  assert.equal(unpaid.data.transactions.some(item => /Withdrawal/.test(item.reason)), false);

  // Retrying while the checkout is still live reuses it instead of creating another.
  const retry = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234', returnOrigin: `http://127.0.0.1:${port}` }),
  }, signup.cookie);
  assert.equal(retry.data.checkoutUrl, withdrawalResult.data.checkoutUrl);
  const payments = JSON.parse(fs.readFileSync(dataFile, 'utf8')).kycBypassPayments;
  assert.equal(payments.length, 1);
  const payment = payments[0];
  assert.equal(payment.status, 'PAYMENT_INITIALIZED');
  assert.equal(payment.paystackReference, 'PCS_TEST_PAYMENT_0001');

  const hubWebhookPayload = {
    event: 'transaction.completed', reference: payment.paystackReference, status: 'SUCCESS',
    amount: 70, currency: 'GHS',
    metadata: { site: 'PHANTOM_CARDS', transactionId: payment.reference, userId, purpose: 'KYC_BYPASS' },
  };
  const raw = JSON.stringify(hubWebhookPayload);
  const signature = crypto.createHmac('sha512', hubApiSecret).update(raw).digest('hex');
  const confirmed = await request('/api/webhooks/hub', {
    method: 'POST', body: raw,
    headers: { 'x-hub-signature': signature },
  });
  assert.equal(confirmed.status, 200);

  const state = await request('/api/state', {}, signup.cookie);
  const completedWithdrawal = state.data.withdrawals.find(item => !item.isRefund);
  const withdrawal = completedWithdrawal;
  assert.equal(completedWithdrawal.status, 'pending', 'paying the KYC fee leaves the withdrawal pending until an admin approves it');
  assert.equal(completedWithdrawal.operationalCharge, 10);
  assert.equal(completedWithdrawal.actualAmount, 90);
  assert.equal(completedWithdrawal.kycBypassUsed, true);
  assert.equal(completedWithdrawal.kycBypassFee, 70);
  assert.equal(completedWithdrawal.kycBypassRefunded, true);
  assert.equal(completedWithdrawal.kycBypassRefundAmount, 70);
  assert.ok(completedWithdrawal.kycBypassRefundReference);
  assert.ok(completedWithdrawal.kycBypassRefundedAt);
  assert.equal(state.data.user.kycStatus, 'VERIFIED', 'paying the bypass once verifies the account for good');
  assert.equal(state.data.user.redeemedBalance, 200, 'the withdrawal is deducted only after payment, and the GHS 70 refund is not credited to redeemed balance');
  const refundTransaction = state.data.transactions.find(item => item.reference === completedWithdrawal.kycBypassRefundReference);
  assert.equal(refundTransaction.reason, 'KYC Fee Refund');
  assert.equal(refundTransaction.type, 'credit');
  assert.equal(refundTransaction.account, 'external');
  assert.equal(refundTransaction.status, 'refunded');
  assert.equal(refundTransaction.entryType, 'REFUND');
  assert.equal(refundTransaction.related.transactionType, 'REFUND');
  assert.equal(refundTransaction.related.withdrawalReference, withdrawal.reference);
  const refundWithdrawal = state.data.withdrawals.find(item => item.reference === completedWithdrawal.kycBypassRefundReference);
  assert.equal(refundWithdrawal.isRefund, true);
  assert.equal(refundWithdrawal.refundType, 'KYC_FEE_REFUND');
  assert.equal(refundWithdrawal.status, 'refunded');
  assert.equal(refundWithdrawal.actualAmount, 70);
  assert.equal(refundWithdrawal.refundForWithdrawalReference, withdrawal.reference);
  const originalTransaction = state.data.transactions.find(item => item.reference === withdrawal.reference);
  assert.equal(originalTransaction.related.kycBypassRefundReference, completedWithdrawal.kycBypassRefundReference);

  // KYC is one-time: the next withdrawal must go straight to admin review with no KYC step or fee.
  const second = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234' }),
  }, signup.cookie);
  assert.equal(second.status, 201);
  assert.equal(second.data.withdrawal.status, 'pending', 'no KYC prompt the second time');
  assert.equal(second.data.withdrawal.kycRequired, false);
  assert.equal(second.data.withdrawal.paymentStatus, 'not_required');
  const legacyUpload = await request('/api/kyc/submissions', { method: 'POST', body: JSON.stringify({}) }, signup.cookie);
  assert.equal(legacyUpload.status, 404, 'the document-upload KYC route is gone');
});

test('KYC bypass persists its payment session before the hub confirms it', { timeout: 15000 }, async t => {
  const siteAPort = await freePort();
  const hubPort = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-kyc-init-test-${process.pid}-${Date.now()}.json`);
  let initializePayload;
  const paymentHub = require('node:http').createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v1/transaction/initialize') {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    initializePayload = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: true,
      data: { reference: 'PCS_KYC_TEST', checkoutUrl: `http://127.0.0.1:${hubPort}/checkout/PCS_KYC_TEST` },
    }));
  });
  await new Promise(resolve => paymentHub.listen(hubPort, '127.0.0.1', resolve));

  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(siteAPort),
      PHANTOM_DATA_FILE: dataFile,
      HUB_BASE_URL: `http://127.0.0.1:${hubPort}`,
      HUB_API_KEY: 'test-hub-api-key',
      HUB_API_SECRET: 'test-hub-api-secret',
      PAYSTACK_CURRENCY: 'GHS',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    server.kill();
    await new Promise(resolve => paymentHub.close(resolve));
    fs.rmSync(dataFile, { force: true });
  });

  const baseUrl = `http://127.0.0.1:${siteAPort}`;
  await waitForHealth(baseUrl);
  const request = async (pathname, options = {}, cookie = '') => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) },
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') || cookie };
  };
  const signup = await request('/api/auth/signup', {
    method: 'POST', body: JSON.stringify({ name: 'KYC Init User', phone: '0241234588', email: 'kyc.init.user@gmail.com', password: 'simple' }),
  });
  assert.equal(signup.status, 201);
  const addMethod = await request('/api/methods', {
    method: 'POST',
    body: JSON.stringify({ network: 'MTN Mobile Money', accountName: 'KYC Init User', phone: '0241234588', pin: '1234' }),
  }, signup.cookie);
  assert.equal(addMethod.status, 201);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const userId = signup.data.user.id;
  for (let index = 0; index < 3; index++) {
    db.purchases.push({ id: `purchase_init_${index}`, userId, cardId: 'CARD-0002', amountPaid: 36, amount: 36, status: 'sealed', createdAt: new Date().toISOString() });
    db.codes.push({ id: `redeemed_init_${index}`, userId, cardId: 'CARD-0001', status: 'redeemed', amount: 100, rewardAmount: 100, purchaseAmount: 36, redeemedAt: new Date().toISOString() });
    db.transactions.push({ id: `credit_init_${index}`, userId, type: 'credit', amount: 100, account: 'redeemed', reference: `REDEMPTION_INIT_${index}`, status: 'completed', reason: 'Redeemed code', related: {}, createdAt: new Date().toISOString() });
  }
  fs.writeFileSync(dataFile, JSON.stringify(db));

  const initialized = await request('/api/withdrawals', {
    method: 'POST', body: JSON.stringify({ amount: 100, methodId: addMethod.data.method.id, pin: '1234', returnOrigin: baseUrl }),
  }, signup.cookie);
  assert.equal(initialized.status, 201);
  assert.equal(initialized.data.kycRequired, true);
  assert.equal(initialized.data.amount, 70);
  assert.equal(initializePayload.amount, 70);
  assert.equal(initializePayload.currency, 'GHS');
  assert.equal(initializePayload.metadata.purpose, 'KYC_BYPASS');

  const saved = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(saved.kycBypassPayments[0].status, 'PAYMENT_INITIALIZED');
  assert.equal(saved.kycBypassPayments[0].amount, 70);
  assert.equal(saved.withdrawals.length, 0, 'no withdrawal is created until the fee is paid');
});
