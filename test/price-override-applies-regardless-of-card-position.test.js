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

// This reproduces the exact bug found in production: a live database contained several
// $4-tier cards, and the ₵45 override only applied to SOME of them (the ones whose card
// ID happened to sit at the array position makeCards() would naturally generate as $4)
// while others — genuinely $4 cards, sitting right next to the corrected ones in the same
// catalog — were silently left at the old ₵48 price forever, because the override check
// consulted a freshly regenerated template's positional guess instead of the card's own
// actual, currently-listed USD price.
test('the ₵45 override applies to every $4-tier card, not just ones whose ID matches a freshly generated template position', { timeout: 20000 }, async t => {
  const port = await freePort();
  const dataFile = path.join(os.tmpdir(), `phantom-price-drift-position-test-${process.pid}-${Date.now()}.json`);

  let server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile }, stdio: 'ignore' });
  await waitForHealth(`http://127.0.0.1:${port}`);
  server.kill();
  await new Promise(resolve => setTimeout(resolve, 200));

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  // Simulate exactly what happened in production: a card whose ID a freshly regenerated
  // template would now price at something other than $4 (here we pick a card the template
  // prices at $5), but which is actually recorded — and was actually sold — as a $4 card at
  // the old ₵48 rate. A correct fix must trust the card's own recorded $4 price, not the
  // template's positional guess of $5, and correct it to ₵45.
  const fiveDollarCard = db.cards.find(c => c.displayPriceUsd === 5);
  assert.ok(fiveDollarCard, 'fixture must contain a $5-tier card to simulate the template/card mismatch');
  const drifted = fiveDollarCard;
  drifted.displayPriceUsd = 4;
  drifted.priceGhs = 48;
  drifted.price = 48;
  fs.writeFileSync(dataFile, JSON.stringify(db));

  server = spawn(process.execPath, ['server.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: String(port), PHANTOM_DATA_FILE: dataFile }, stdio: 'ignore' });
  t.after(() => { server.kill(); fs.rmSync(dataFile, { force: true }); });
  await waitForHealth(`http://127.0.0.1:${port}`);

  const reloaded = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const corrected = reloaded.cards.find(c => c.id === drifted.id);
  assert.equal(corrected.priceGhs, 45, `${drifted.id} is recorded as a $4 card and must be corrected to ₵45, even though a freshly generated template would guess $5 for this ID`);
  assert.equal(corrected.displayPriceUsd, 4, 'the card must still be labeled as the $4 tier');

  // Every genuinely $4-tier card in the catalog must be at ₵45 — the fix must not be a
  // one-off patch that only helps the specific card this test drifted.
  const allFourDollarCards = reloaded.cards.filter(c => c.displayPriceUsd === 4);
  assert.ok(allFourDollarCards.length > 1, 'sanity check: catalog should contain multiple $4-tier cards');
  for (const card of allFourDollarCards) {
    assert.equal(card.priceGhs, 45, `${card.id} is listed as $4 but has priceGhs ${card.priceGhs}`);
  }
});
