/**
 * Regression test: two translations running at the same time must each use
 * their own user's key and model.
 *
 * Starts a tiny local stand-in for the Anthropic API (no network, no real key),
 * runs two overlapping jobs with different keys/models, and checks that every
 * batch was sent with the right one.
 *
 * Run: node test-concurrency.js
 */

const assert = require('assert');
const http = require('http');

const requests = [];

function mockAnthropic(req, res) {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const key = req.headers['x-api-key'] || '';
    if (req.url.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.url.split('/')[3].split('?')[0]);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z',
        max_tokens: 128000, capabilities: { effort: { supported: true, low: { supported: true } } },
      }));
      return;
    }
    if (req.url.startsWith('/v1/messages')) {
      const params = JSON.parse(body);
      const prompt = params.messages[0].content;
      const lines = prompt.split('\n').filter(l => /^\d+\| /.test(l));
      requests.push({ key, model: params.model, firstLine: lines[0].replace(/^\d+\| /, '') });
      const text = lines.map(l => l.replace(/\| (.*)$/, '| HE:$1')).join('\n');
      // Small delay so the two jobs' batches interleave.
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        ev('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: params.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
        ev('message_stop', {});
        res.end();
      }, 100);
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

const server = http.createServer(mockAnthropic).listen(0, '127.0.0.1', async () => {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  const config = require('./config');
  config.BATCH_DELAY_MS = 200;
  config.TRANSLATION_BATCH_SIZE = 10;
  const { translateAllTexts } = require('./gemini');

  const texts = tag => Array.from({ length: 50 }, (_, i) => `${tag} line ${i}`);
  const quiet = () => {};
  const origWarn = console.warn, origLog = console.log;
  console.warn = console.log = quiet;

  let out;
  try {
    const jobA = translateAllTexts(texts('DANA'), 'heb', quiet, null,
      { userAnthropicKey: 'sk-ant-test-DANA', userAnthropicModel: 'claude-opus-5-5' });
    await new Promise(r => setTimeout(r, 500)); // second user starts mid-job
    const jobB = translateAllTexts(texts('YOSSI'), 'heb', quiet, null,
      { userAnthropicKey: 'sk-ant-test-YOSSI', userAnthropicModel: 'claude-haiku-5-5' });
    out = await Promise.all([jobA, jobB]);
  } finally {
    console.warn = origWarn;
    console.log = origLog;
    server.close();
  }

  console.log('\n=== concurrent jobs keep their own key + model ===');
  assert.ok(requests.length >= 10, `expected at least 10 batches, got ${requests.length}`);
  for (const r of requests) {
    const owner = r.firstLine.startsWith('DANA') ? 'DANA' : 'YOSSI';
    const model = owner === 'DANA' ? 'claude-opus-5-5' : 'claude-haiku-5-5';
    assert.ok(r.key.endsWith(owner), `${owner}'s batch was sent with key ${r.key}`);
    assert.strictEqual(r.model, model, `${owner}'s batch was sent with model ${r.model}`);
  }
  console.log(`  ✅ ${requests.length} batches, each sent with its own user's key and model`);

  assert.ok(out[0].every(t => t.startsWith('HE:DANA')), 'job A got foreign or missing lines');
  assert.ok(out[1].every(t => t.startsWith('HE:YOSSI')), 'job B got foreign or missing lines');
  console.log('  ✅ each job got back only its own translated lines');
  console.log('\n🎉 Concurrency test passed.');
});
