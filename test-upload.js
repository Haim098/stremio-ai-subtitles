/**
 * Integration test for the manual subtitle upload feature.
 * Boots the real Express app on a test port, POSTs to /api/upload, and asserts
 * the file is stored, served, and listed as an 'upload' variant. Also checks
 * that invalid payloads (VTT / missing content) are rejected.
 *
 * Run: node test-upload.js
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const TEST_PORT = 7099;
process.env.PORT = String(TEST_PORT);

const BASE = `http://localhost:${TEST_PORT}`;
const TEST_IMDB = 'tt0000099'; // fake id, cleaned up at the end

// Require AFTER setting PORT so the server binds to the test port.
const config = require('./config');
const cache = require('./subtitleCache');
require('./index'); // starts app.listen(config.PORT)

const SAMPLE_SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,000',
  'Hello world',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '- Line one',
  '- Line two',
  '',
  '3',
  '00:00:07,000 --> 00:00:09,000',
  'שלום עולם',
  '',
].join('\n');

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
}

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/manifest.json`);
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await new Promise(res => setTimeout(res, 100));
  }
  throw new Error('Server did not start in time');
}

function cleanup() {
  // Remove the test SRT file
  try {
    const f = path.join(cache.SUBS_DIR, `${TEST_IMDB}_heb_upload.srt`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch (e) { /* ignore */ }
  // Remove the test library row
  try {
    const libPath = path.join(cache.SUBS_DIR, 'library.json');
    if (fs.existsSync(libPath)) {
      const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
      const cleaned = lib.filter(e => e.imdbId !== TEST_IMDB);
      fs.writeFileSync(libPath, JSON.stringify(cleaned, null, 2));
    }
  } catch (e) { /* ignore */ }
}

(async () => {
  console.log('=== Manual Upload Integration Test ===\n');
  await waitForServer();

  try {
    // 1) Happy path — valid SRT for a movie
    const up = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imdbId: TEST_IMDB, type: 'movie', title: 'Upload Test Movie',
        srt: SAMPLE_SRT,
      }),
    });
    const upData = await up.json();
    check('upload returns 200', up.status === 200, `(got ${up.status})`);
    check('status is done', upData.status === 'done', JSON.stringify(upData));
    check('reports 3 blocks', upData.blocks === 3, `(got ${upData.blocks})`);
    check('provider is upload', upData.provider === 'upload');
    check('filename present', !!upData.filename);

    // 2) Served file is fetchable and contains the Hebrew line
    if (upData.filename) {
      const fileRes = await fetch(`${BASE}/public/subs/${upData.filename}`);
      const fileText = await fileRes.text();
      check('served file is 200', fileRes.status === 200);
      check('served file has Hebrew line', fileText.includes('שלום עולם'));
      check('served file kept multi-line dialog', fileText.includes('- Line one') && fileText.includes('- Line two'));
    }

    // 3) Cache lists it as an 'upload' variant
    const variants = cache.listVariantsForContent(TEST_IMDB);
    check('variant listed for content', variants.some(v => v.provider === 'upload' && v.lang === 'heb'),
      JSON.stringify(variants));

    // 4) Reject VTT
    const vtt = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imdbId: TEST_IMDB, type: 'movie', title: 'x', srt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhi' }),
    });
    check('VTT rejected with 400', vtt.status === 400, `(got ${vtt.status})`);

    // 5) Reject missing srt
    const noSrt = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imdbId: TEST_IMDB, type: 'movie', title: 'x' }),
    });
    check('missing srt rejected with 400', noSrt.status === 400, `(got ${noSrt.status})`);

    // 6) Reject missing imdbId
    const noId = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ srt: SAMPLE_SRT }),
    });
    check('missing imdbId rejected with 400', noId.status === 400, `(got ${noId.status})`);

  } catch (err) {
    failed++;
    console.error('\n  ❌ Test threw:', err.message);
  } finally {
    cleanup();
  }

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
})();
