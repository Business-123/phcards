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

test('an admin can block a signed-in user, cutting off their session immediately, and unblock them later', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-admin-block-test-${process.pid}-${Date.now()}.json`);
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  // A separate cookie jar per "browser" (the customer vs. the admin console).
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

  const signup = await asUser('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Blockable User', phone: '0241234599', email: '0241234599@gmail.com', password: 'simple' }) });
  assert.equal(signup.response.status, 201);
  const userId = signup.data.user.id;

  // The user is signed in and can read their own state before anything happens.
  const stateBefore = await asUser('/api/state');
  assert.equal(stateBefore.response.status, 200);

  const login = await asAdmin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) });
  assert.equal(login.response.status, 200);

  const beforeBlock = await asAdmin(`/api/admin/users/${userId}`);
  assert.equal(beforeBlock.data.user.blocked, false);

  const block = await asAdmin(`/api/admin/users/${userId}/block`, { method: 'POST', body: JSON.stringify({ note: 'Suspected chargeback abuse' }) });
  assert.equal(block.response.status, 200);
  assert.equal(block.data.user.blocked, true);
  assert.equal(block.data.user.blockedReason, 'Suspected chargeback abuse');
  assert.ok(block.data.user.blockedAt);

  // The user's existing session is cut off immediately (their session is invalidated,
  // not just on their next login), so their very next request needs to sign in again.
  const stateAfterBlock = await asUser('/api/state');
  assert.equal(stateAfterBlock.response.status, 401);

  // A blocked user cannot log back in either.
  const blockedLogin = await client()('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: '0241234599@gmail.com', password: 'simple' }) });
  assert.equal(blockedLogin.response.status, 403);
  assert.match(blockedLogin.data.error, /blocked/i);

  // The block is recorded in the audit log.
  const auditLogs = await asAdmin('/api/admin/audit-logs?pageSize=5');
  assert.ok(auditLogs.data.items.some(item => item.action === 'user.block' && item.targetId === userId));

  const unblock = await asAdmin(`/api/admin/users/${userId}/unblock`, { method: 'POST', body: JSON.stringify({ note: 'False positive, cleared manually' }) });
  assert.equal(unblock.response.status, 200);
  assert.equal(unblock.data.user.blocked, false);
  assert.equal(unblock.data.user.blockedReason, null);

  const unblockedLogin = await client()('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: '0241234599@gmail.com', password: 'simple' }) });
  assert.equal(unblockedLogin.response.status, 200);

  // Only an authenticated admin can block or unblock anyone.
  const anonAttempt = await fetch(`${baseUrl}/api/admin/users/${userId}/block`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'no auth' }) });
  assert.equal(anonAttempt.status, 401);
});
