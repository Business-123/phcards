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
  throw new Error('Test server did not start.');
}

test('a $4-tier price override (₵45) still applies to a card that was already saved on disk with the old ₵48 price', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-price-drift-test-${process.pid}-${Date.now()}.json`);

  // Boot once just to create a real, fully-shaped data file, then shut down.
  let server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile }, stdio: 'ignore' });
  await waitForHealth(`http://127.0.0.1:${port}`);
  server.kill();
  await new Promise(resolve => setTimeout(resolve, 200));

  // Simulate a live database that predates the ₵45 override: the $4-tier card still
  // has its old ₵48 price saved on disk, exactly like a production deploy that only
  // shipped new code without anyone touching the persisted data file.
  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const drifted = db.cards.find(c => c.displayPriceUsd === 4);
  assert.ok(drifted, 'fixture must contain a $4-tier card');
  drifted.priceGhs = 48;
  drifted.price = 48;
  fs.writeFileSync(dataFile, JSON.stringify(db));

  // Reboot with the same data file — this is what a redeploy looks like in production.
  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile }, stdio: 'ignore' });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  await waitForHealth(`http://127.0.0.1:${port}`);

  const reloaded = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const corrected = reloaded.cards.find(c => c.id === drifted.id);
  assert.equal(corrected.priceGhs, 45, 'the saved ₵48 price must be corrected back to the ₵45 override on load, not left as-is');
  assert.equal(corrected.displayPriceUsd, 4, 'the card must still be labeled as the $4 tier');
});
