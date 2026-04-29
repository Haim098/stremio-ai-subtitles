/**
 * End-to-end shape test for the flatten/unflatten pipeline using a real
 * cached English SRT. Does NOT call any AI — only validates that
 *   parse → extractTexts → flatten → (identity) → unflatten → replaceTexts
 *     → build
 * preserves the exact subtitle structure (timestamps, multi-line blocks,
 * block count). Catches regressions in the data pipeline.
 *
 * Run with: node test-multiline-e2e.js
 */

const fs = require('fs');
const path = require('path');
const srtParser = require('./srtParser');

const subsDir = path.join(__dirname, 'public', 'subs');
const candidates = fs.readdirSync(subsDir).filter(f => f.endsWith('.srt'));
if (candidates.length === 0) {
  console.log('No cached SRT files in public/subs/ — skipping E2E test.');
  process.exit(0);
}

let totalBlocks = 0;
let totalMultiLine = 0;

for (const fileName of candidates) {
  const content = fs.readFileSync(path.join(subsDir, fileName), 'utf-8');
  const blocks = srtParser.parse(content);
  const texts = srtParser.extractTexts(blocks);
  const multiLine = texts.filter(t => t.includes('\n')).length;

  totalBlocks += blocks.length;
  totalMultiLine += multiLine;

  // Roundtrip
  const { flat, boundaries } = srtParser.flattenForTranslation(texts);
  const restored = srtParser.unflattenAfterTranslation(flat, flat, boundaries);

  // Block count preserved
  if (restored.length !== texts.length) {
    console.error(`❌ ${fileName}: block count changed ${texts.length} → ${restored.length}`);
    process.exit(1);
  }

  // Each block byte-identical (multi-line preserved)
  for (let i = 0; i < texts.length; i++) {
    if (restored[i] !== texts[i]) {
      console.error(`❌ ${fileName} block ${i}: roundtrip changed text`);
      console.error(`   expected: ${JSON.stringify(texts[i])}`);
      console.error(`   actual:   ${JSON.stringify(restored[i])}`);
      process.exit(1);
    }
  }

  // Final SRT byte-identical to one rebuilt from restored texts
  const replaced = srtParser.replaceTexts(blocks, restored);
  const rebuilt = srtParser.build(replaced);
  // We don't compare to `content` directly because srtParser.build re-indexes
  // and normalizes whitespace; instead compare to a build of the parsed
  // originals — that's the contract `replaceTexts` operates against anyway.
  const baseline = srtParser.build(blocks);
  if (rebuilt !== baseline) {
    console.error(`❌ ${fileName}: rebuilt SRT differs from baseline build`);
    process.exit(1);
  }

  console.log(`  ✅ ${fileName}: ${blocks.length} blocks (${multiLine} multi-line) — roundtrip clean`);
}

console.log(`\n🎉 E2E roundtrip clean: ${totalBlocks} blocks across ${candidates.length} files (${totalMultiLine} multi-line preserved).`);
