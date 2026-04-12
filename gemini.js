/**
 * Gemini API integration v2.1 — Real Subtitle Translation
 * ========================================================
 * Translates existing SRT subtitle text using Gemini 3 Flash Preview.
 * Processes text in large batches with retry logic for rate limits.
 */

const fetch = require('node-fetch');
const config = require('./config');

/**
 * Build the translation prompt for a batch of subtitle lines
 */
function buildTranslationPrompt(textLines, targetLang) {
  const langInfo = config.SUPPORTED_LANGUAGES.find(l => l.code === targetLang);
  const langName = langInfo ? langInfo.name : 'Hebrew';
  const langDisplay = langInfo ? langInfo.displayName : 'עברית';

  // Number each line so Gemini returns them in order
  const numberedLines = textLines.map((line, i) => `${i + 1}| ${line}`).join('\n');

  return `You are a professional subtitle translator. Translate the following subtitle lines from English to ${langName} (${langDisplay}).

STRICT RULES:
1. Translate ONLY the text after the "| " separator
2. Return EXACTLY ${textLines.length} lines, each prefixed with its number and "| "
3. Keep translations concise — max 42 characters per line when possible
4. Translate text in [brackets] too (these are scene descriptions like [music playing])
5. Preserve any proper nouns, brand names, and character names
6. Maintain the tone, emotion, and style of the original dialogue
7. Do NOT add any explanations, notes, or extra content
8. If a line contains only symbols or non-translatable content (like "..." or "♪"), keep it as-is

INPUT LINES:
${numberedLines}

OUTPUT (same format, ${langName} translations):`;
}

/**
 * Parse Gemini's response back into an array of translated texts
 */
function parseTranslationResponse(responseText, expectedCount) {
  const lines = responseText.trim().split('\n');
  const translations = new Array(expectedCount).fill('');

  for (const line of lines) {
    const match = line.match(/^(\d+)\s*\|\s*(.+)$/);
    if (match) {
      const idx = parseInt(match[1], 10) - 1;
      if (idx >= 0 && idx < expectedCount) {
        translations[idx] = match[2].trim();
      }
    }
  }

  // Count how many we actually got
  const filled = translations.filter(t => t.length > 0).length;
  if (filled < expectedCount * 0.7) {
    console.warn(`[Gemini] Only parsed ${filled}/${expectedCount} translations. Trying fallback parse...`);
    const cleanLines = responseText.trim().split('\n').filter(l => l.trim().length > 0);
    if (cleanLines.length >= expectedCount) {
      for (let i = 0; i < expectedCount; i++) {
        if (!translations[i]) {
          translations[i] = cleanLines[i].replace(/^\d+\s*[|.):]\s*/, '').trim();
        }
      }
    }
  }

  return translations;
}

/**
 * Sleep function for delays
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract retry delay from a 429 error response
 */
function extractRetryDelay(errorText) {
  try {
    const data = JSON.parse(errorText);
    const retryInfo = data?.error?.details?.find(d =>
      d['@type']?.includes('RetryInfo')
    );
    if (retryInfo?.retryDelay) {
      const seconds = parseFloat(retryInfo.retryDelay);
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }
  } catch (e) { /* ignore */ }
  return 20000; // default 20s
}

/**
 * Translate a batch of subtitle text lines with retry logic
 * @param {string[]} textLines - Array of English subtitle text lines
 * @param {string} targetLang - Target language code (e.g., 'heb')
 * @returns {Promise<string[]>} Translated text lines
 */
async function translateBatch(textLines, targetLang) {
  const prompt = buildTranslationPrompt(textLines, targetLang);
  const url = `${config.GEMINI_API_URL}/${config.GEMINI_MODEL}:generateContent`;
  const maxRetries = config.MAX_RETRIES || 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': config.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: 16384,
            topP: 0.8,
          },
        }),
      });

      if (response.status === 429) {
        const errorText = await response.text();
        const retryDelay = extractRetryDelay(errorText);
        console.warn(`[Gemini] ⏳ Rate limited (429). Attempt ${attempt}/${maxRetries}. Waiting ${retryDelay / 1000}s...`);
        await sleep(retryDelay + 1000); // add 1s buffer
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Gemini] API Error ${response.status}: ${errorText.slice(0, 200)}`);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Invalid Gemini response structure');
      }

      const responseText = data.candidates[0].content.parts[0].text;
      return parseTranslationResponse(responseText, textLines.length);

    } catch (error) {
      if (attempt === maxRetries) throw error;
      if (!error.message.includes('429')) throw error; // only retry on rate limits
    }
  }

  throw new Error('Max retries exceeded');
}

/**
 * Translate all subtitle texts in batches with rate limiting
 * @param {string[]} allTexts - All subtitle text lines
 * @param {string} targetLang - Target language code
 * @returns {Promise<string[]>} All translated texts
 */
async function translateAllTexts(allTexts, targetLang) {
  const batchSize = config.TRANSLATION_BATCH_SIZE;
  const batchDelay = config.BATCH_DELAY_MS || 4500;
  const totalBatches = Math.ceil(allTexts.length / batchSize);
  const allTranslated = [];

  console.log(`[Gemini] Translating ${allTexts.length} lines in ${totalBatches} batches (${batchSize} lines/batch) to ${targetLang}...`);

  for (let i = 0; i < totalBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, allTexts.length);
    const batch = allTexts.slice(start, end);

    console.log(`[Gemini]   Batch ${i + 1}/${totalBatches} (lines ${start + 1}-${end})...`);

    try {
      const translated = await translateBatch(batch, targetLang);
      allTranslated.push(...translated);
      console.log(`[Gemini]   ✅ Batch ${i + 1} done`);
    } catch (error) {
      console.error(`[Gemini]   ❌ Batch ${i + 1} failed after retries: ${error.message}. Using originals.`);
      allTranslated.push(...batch);
    }

    // Delay between batches to avoid rate limiting
    if (i < totalBatches - 1) {
      console.log(`[Gemini]   ⏳ Waiting ${batchDelay / 1000}s before next batch...`);
      await sleep(batchDelay);
    }
  }

  const translatedCount = allTranslated.filter((t, i) => t !== allTexts[i]).length;
  console.log(`[Gemini] ✅ Translation complete: ${translatedCount}/${allTexts.length} lines translated to ${targetLang}`);

  return allTranslated;
}

module.exports = { translateBatch, translateAllTexts };
