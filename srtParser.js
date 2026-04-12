/**
 * SRT Parser & Builder
 * ====================
 * Parses SRT subtitle files into structured blocks and rebuilds them.
 * Key principle: Timestamps are NEVER modified — only text is translated.
 */

/**
 * Parse an SRT string into an array of subtitle blocks
 * @param {string} srtContent - Raw SRT file content
 * @returns {Array<{index: number, startTime: string, endTime: string, text: string}>}
 */
function parse(srtContent) {
  const blocks = [];

  // Normalize line endings
  const normalized = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Split into blocks by double newline (or more)
  const rawBlocks = normalized.split(/\n\s*\n/);

  for (const rawBlock of rawBlocks) {
    const lines = rawBlock.trim().split('\n');
    if (lines.length < 2) continue;

    // Line 1: Index number
    const indexLine = lines[0].trim();
    const index = parseInt(indexLine, 10);
    if (isNaN(index)) continue;

    // Line 2: Timestamps (HH:MM:SS,mmm --> HH:MM:SS,mmm)
    const timeLine = lines[1].trim();
    const timeMatch = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!timeMatch) continue;

    const startTime = timeMatch[1];
    const endTime = timeMatch[2];

    // Lines 3+: Subtitle text (can be multi-line)
    const text = lines.slice(2).join('\n').trim();
    if (!text) continue;

    blocks.push({ index, startTime, endTime, text });
  }

  return blocks;
}

/**
 * Build an SRT string from subtitle blocks
 * Re-indexes blocks sequentially for clean output
 * @param {Array<{index: number, startTime: string, endTime: string, text: string}>} blocks
 * @returns {string} Valid SRT content
 */
function build(blocks) {
  return blocks
    .map((block, i) => {
      const idx = i + 1;
      return `${idx}\n${block.startTime} --> ${block.endTime}\n${block.text}`;
    })
    .join('\n\n') + '\n';
}

/**
 * Extract only the text portions from parsed blocks
 * @param {Array} blocks - Parsed SRT blocks
 * @returns {string[]} Array of text strings
 */
function extractTexts(blocks) {
  return blocks.map(b => b.text);
}

/**
 * Replace text in parsed blocks with translated text
 * @param {Array} blocks - Parsed SRT blocks
 * @param {string[]} translatedTexts - Translated text strings (same length as blocks)
 * @returns {Array} New blocks with translated text and original timestamps
 */
function replaceTexts(blocks, translatedTexts) {
  if (blocks.length !== translatedTexts.length) {
    console.warn(`[SRT] Block count mismatch: ${blocks.length} blocks vs ${translatedTexts.length} translations. Using min.`);
  }

  const count = Math.min(blocks.length, translatedTexts.length);
  const result = [];

  for (let i = 0; i < count; i++) {
    result.push({
      index: blocks[i].index,
      startTime: blocks[i].startTime,
      endTime: blocks[i].endTime,
      text: translatedTexts[i] || blocks[i].text, // fallback to original if empty
    });
  }

  return result;
}

/**
 * Validate basic SRT structure
 * @param {string} srtContent
 * @returns {{ valid: boolean, blockCount: number, error?: string }}
 */
function validate(srtContent) {
  try {
    const blocks = parse(srtContent);
    if (blocks.length === 0) {
      return { valid: false, blockCount: 0, error: 'No valid subtitle blocks found' };
    }
    return { valid: true, blockCount: blocks.length };
  } catch (err) {
    return { valid: false, blockCount: 0, error: err.message };
  }
}

module.exports = { parse, build, extractTexts, replaceTexts, validate };
