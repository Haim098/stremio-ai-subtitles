/**
 * Tests for multi-line subtitle flatten/unflatten and parseResponse.
 * Run with: node test-multiline.js
 *
 * Plain assert-style checks; exits non-zero on first failure.
 */

const assert = require('assert');
const srtParser = require('./srtParser');

function eq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`  ✅ ${label}`);
  } catch (e) {
    console.error(`  ❌ ${label}`);
    console.error(`     expected: ${JSON.stringify(expected)}`);
    console.error(`     actual:   ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

console.log('=== flattenForTranslation ===');

// Single-line blocks: flat = inputs, boundaries = singletons
{
  const inputs = ['Hello', 'Goodbye'];
  const { flat, boundaries } = srtParser.flattenForTranslation(inputs);
  eq(flat, ['Hello', 'Goodbye'], 'single-line: flat');
  eq(boundaries, [[0], [1]], 'single-line: boundaries');
}

// One multi-line block in the middle
{
  const inputs = ['A', '- B1\n- B2', 'C'];
  const { flat, boundaries } = srtParser.flattenForTranslation(inputs);
  eq(flat, ['A', '- B1', '- B2', 'C'], 'mixed: flat');
  eq(boundaries, [[0], [1, 2], [3]], 'mixed: boundaries');
}

// Three-line block
{
  const inputs = ['X\nY\nZ'];
  const { flat, boundaries } = srtParser.flattenForTranslation(inputs);
  eq(flat, ['X', 'Y', 'Z'], '3-line: flat');
  eq(boundaries, [[0, 1, 2]], '3-line: boundaries');
}

console.log('\n=== unflattenAfterTranslation ===');

// Pure roundtrip: same texts back when no translation happens
{
  const original = ['A', '- B1\n- B2', 'C'];
  const { flat, boundaries } = srtParser.flattenForTranslation(original);
  const restored = srtParser.unflattenAfterTranslation(flat, flat, boundaries);
  eq(restored, original, 'roundtrip: identity');
}

// Translation success: translated lines re-joined with \n
{
  const original = ['Hello', '- Hi\n- Bye', 'End'];
  const { flat, boundaries } = srtParser.flattenForTranslation(original);
  const translated = ['שלום', '- היי', '- ביי', 'סוף'];
  const result = srtParser.unflattenAfterTranslation(translated, flat, boundaries);
  eq(result, ['שלום', '- היי\n- ביי', 'סוף'], 'translated: rejoined');
}

// Per-line fallback: empty translated line falls back to original line
{
  const original = ['Hello', '- Hi\n- Bye', 'End'];
  const { flat, boundaries } = srtParser.flattenForTranslation(original);
  const translated = ['שלום', '- היי', '', 'סוף']; // 2nd line failed
  const result = srtParser.unflattenAfterTranslation(translated, flat, boundaries);
  eq(result, ['שלום', '- היי\n- Bye', 'סוף'], 'per-line fallback');
}

console.log('\n🎉 All multi-line tests passed.');
