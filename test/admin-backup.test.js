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
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${baseUrl}/api/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
}

test('admin can download a full backup and restore it, with safety checks', { timeout: 30000 }, async t => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-backup-test-'));
  const dataFile = path.join(dir, 'phantom-cards.json');
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'test-admin-password' },
    stdio: 'ignore',
  });
  t.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);

  function client() {
    let cookie = '';
    return async (pathname, options = {}) => {
      const response = await fetch(baseUrl + pathname, { ...options, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(options.headers || {}) } });
      const set = response.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return response;
    };
  }
  const admin = client(); const customer = client();
  assert.equal((await admin('/api/admin/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'test-admin-password' }) })).status, 200);

  // Not available without an admin session.
  assert.equal((await fetch(`${baseUrl}/api/admin/backup`)).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/admin/restore`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status, 401);

  // Create a customer and a fake KYC document on the volume.
  const signup = await customer('/api/auth/signup', { method: 'POST', body: JSON.stringify({ name: 'Backup Tester', email: 'backup.tester@gmail.com', phone: '0551234567', password: 'simple' }) });
  assert.ok(signup.status < 300, `signup failed: ${signup.status}`);
  const kycDir = path.join(dir, 'kyc-documents', 'user_test');
  fs.mkdirSync(kycDir, { recursive: true });
  fs.writeFileSync(path.join(kycDir, 'kyc_abc.bin'), Buffer.from('hello-kyc'));

  // Download.
  const download = await admin('/api/admin/backup');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /attachment; filename="phantom-cards-backup-.*\.json"/);
  const backup = await download.json();
  assert.equal(backup.format, 'phantom-cards-backup');
  assert.ok(backup.db.users.some(u => u.email === 'backup.tester@gmail.com'));
  assert.deepEqual(backup.db.sessions, []);
  assert.deepEqual(backup.db.adminSessions, []);
  assert.equal(backup.kycDocuments.length, 1);
  assert.equal(Buffer.from(backup.kycDocuments[0].content, 'base64').toString(), 'hello-kyc');

  // Without KYC.
  const slim = await (await admin('/api/admin/backup?kyc=0')).json();
  assert.equal(slim.kycDocuments.length, 0);

  // Wipe the data and the document, then restore.
  fs.rmSync(path.join(dir, 'kyc-documents'), { recursive: true, force: true });
  const wiped = JSON.parse(fs.readFileSync(dataFile, 'utf8')); wiped.users = []; fs.writeFileSync(dataFile, JSON.stringify(wiped));

  // Confirmation word is required; garbage is rejected; path traversal is rejected.
  assert.equal((await admin('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup })})).status, 400);
  assert.equal((await admin('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup: { hello: 1 }, confirm: 'RESTORE' }) })).status, 400);
  const evil = { ...backup, kycDocuments: [{ userId: '..', storageKey: 'x.bin', content: 'AAAA' }] };
  assert.equal((await admin('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup: evil, confirm: 'RESTORE' }) })).status, 400);

  const restored = await admin('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup, confirm: 'RESTORE' }) });
  assert.equal(restored.status, 200);
  const result = await restored.json();
  assert.ok(result.counts.users >= 1);
  assert.ok(fs.existsSync(path.join(dir, result.safetyCopy)), 'safety copy of the previous data is kept');

  const after = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.ok(after.users.some(u => u.email === 'backup.tester@gmail.com'));
  assert.equal(fs.readFileSync(path.join(kycDir, 'kyc_abc.bin'), 'utf8'), 'hello-kyc');
  assert.ok(after.adminAuditLogs.some(l => l.action === 'backup.restore'));
  // The admin is still signed in after restoring.
  assert.equal((await admin('/api/admin/auth/session')).status, 200);

  // A raw phantom-cards.json is accepted too.
  const raw = await admin('/api/admin/restore', { method: 'POST', body: JSON.stringify({ backup: backup.db, confirm: 'RESTORE' }) });
  assert.equal(raw.status, 200);
});
