const test = require('node:test');
const assert = require('node:assert/strict');
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
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Admin test server did not start.');
}

test('an admin can edit every detail on a user account, with balance changes recorded as audited transactions', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-admin-edit-test-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  function client() {
    let cookie = '';
    return async (pathname, options = {}) => {
      const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { response, data: await response.json().catch(() => ({})) };
    };
  }

  const asUser = client();
  const asAdmin = client();

  const signup = await asUser('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Editable User', phone: '0241234511', email: '0241234511@gmail.com', password: 'simple' }) });
  assert.equal(signup.response.status, 201);
  const userId = signup.data.user.id;

  assert.equal((await asAdmin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).response.status, 200);

  // Only admins can edit accounts.
  const anon = await fetch(`${baseUrl}/api/admin/users/${userId}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }) });
  assert.equal(anon.status, 401);

  // A reason or note is required, like every other admin action.
  const missingNote = await asAdmin(`/api/admin/users/${userId}/edit`, { method: 'POST', body: JSON.stringify({ name: 'New Name' }) });
  assert.equal(missingNote.response.status, 400);

  const edit = await asAdmin(`/api/admin/users/${userId}/edit`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Corrected Name',
      email: 'corrected.name@gmail.com',
      phone: '0241234512',
      walletBalance: 25,
      redeemedBalance: 300,
      kycStatus: 'VERIFIED',
      kycBypassCompleted: true,
      blocked: false,
      note: 'Manual correction requested by support',
    }),
  });
  assert.equal(edit.response.status, 200);
  assert.equal(edit.data.user.name, 'Corrected Name');
  assert.equal(edit.data.user.email, 'corrected.name@gmail.com');
  assert.equal(edit.data.user.phone, '0241234512');
  assert.equal(edit.data.user.walletBalance, 25);
  assert.equal(edit.data.user.redeemedBalance, 300);
  assert.equal(edit.data.user.kycStatus, 'VERIFIED');
  assert.ok(edit.data.user.kycVerifiedAt);
  assert.equal(edit.data.user.kycBypassCompleted, true);

  // Balance edits are represented as audited adjustment transactions, not silent overwrites.
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const walletAdj = db.transactions.find(item => item.userId === userId && item.account === 'wallet' && item.reason === 'Admin balance adjustment');
  const redeemedAdj = db.transactions.find(item => item.userId === userId && item.account === 'redeemed' && item.reason === 'Admin balance adjustment');
  assert.ok(walletAdj, 'wallet balance change is recorded as a transaction');
  assert.equal(walletAdj.type, 'credit');
  assert.equal(walletAdj.amount, 25);
  assert.ok(redeemedAdj, 'redeemed balance change is recorded as a transaction');
  assert.equal(redeemedAdj.type, 'credit');
  assert.equal(redeemedAdj.amount, 300);

  // The change is audited.
  const audit = await asAdmin('/api/admin/audit-logs?pageSize=5');
  assert.ok(audit.data.items.some(item => item.action === 'user.edit' && item.targetId === userId));

  // Verified-KYC users are exempt from the withdrawal KYC gate — verifying here
  // via the edit endpoint must have the same effect as the dedicated verify route.
  const stateAfter = await asUser('/api/state');
  assert.equal(stateAfter.data.user.kycStatus, 'VERIFIED');

  // The account can also be blocked from the same endpoint.
  const blockEdit = await asAdmin(`/api/admin/users/${userId}/edit`, { method: 'POST', body: JSON.stringify({ blocked: true, blockedReason: 'Manual review', note: 'Blocking for review' }) });
  assert.equal(blockEdit.response.status, 200);
  assert.equal(blockEdit.data.user.blocked, true);
  assert.equal(blockEdit.data.user.blockedReason, 'Manual review');
  const stateAfterBlock = await asUser('/api/state');
  assert.equal(stateAfterBlock.response.status, 401, 'blocking via edit also cuts off the active session');
});
