/**
 * AI Translation Engine v2.1 — GitHub Models API
 * ================================================
 * Uses GitHub Models API (OpenAI-compatible) for subtitle translation.
 * Falls back to Gemini if GitHub token is not configured.
 * Translates text in batches, preserving SRT structure.
 */

const fetch = require('node-fetch');
const config = require('./config');

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the system prompt for translation
 */
function getSystemPrompt() {
  return `You are a professional subtitle translator specializing in translating from English to Hebrew.

STRICT RULES:
1. Translate ONLY the text after the "| " separator on each line
2. Return EXACTLY the same number of lines as input
3. Each output line MUST start with its number and "| "
4. Keep translations concise — max 42 characters per line when possible
5. Translate text in [brackets] too (scene descriptions like [music playing] → [מוזיקה מתנגנת])
6. Preserve proper nouns, brand names, and character names
7. Maintain the tone, emotion, and style of the original dialogue
8. Do NOT add explanations, notes, or extra content
9. If a line contains only "..." or "♪", keep it as-is
10. Use natural spoken Hebrew, not formal/literary Hebrew`;
}

/**
 * Build the user prompt for a batch
 */
function buildUserPrompt(textLines) {
  const numberedLines = textLines.map((line, i) => `${i + 1}| ${line}`).join('\n');
  return `Translate these ${textLines.length} subtitle lines to Hebrew. Return the same numbered format:\n\n${numberedLines}`;
}

/**
 * Parse response — extract numbered translations
 */
function parseResponse(responseText, expectedCount) {
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

  // Fallback: unnumbered lines
  const filled = translations.filter(t => t.length > 0).length;
  if (filled < expectedCount * 0.7) {
    console.warn(`[AI] Only parsed ${filled}/${expectedCount}. Trying fallback...`);
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
 * Extract retry delay from error response
 */
function getRetryDelay(errorText) {
  try {
    const data = JSON.parse(errorText);
    const retryInfo = data?.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
    if (retryInfo?.retryDelay) {
      const seconds = parseFloat(retryInfo.retryDelay);
      if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
    }
  } catch (e) { /* ignore */ }
  return 15000; // default 15s
}

// ═══════════════════════════════════════════════════════
//  GitHub Models API (Primary)
// ═══════════════════════════════════════════════════════

async function translateBatchGitHub(textLines) {
  const url = `${config.GITHUB_MODELS_URL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        model: config.GITHUB_MODEL,
        messages: [
          { role: 'system', content: getSystemPrompt() },
          { role: 'user', content: buildUserPrompt(textLines) },
        ],
        temperature: 0.3,
        max_tokens: 16384,
      }),
      signal: controller.signal,
    });

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter ? parseInt(retryAfter) * 1000 : 15000;
      throw { status: 429, retryDelay: delay };
    }

    if (response.status === 400) {
      const errText = await response.text();
      console.error(`[GitHub] Content filter (400): ${errText.slice(0, 200)}`);
      throw { status: 400, contentFilter: true };
    }

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[GitHub] API Error ${response.status}: ${errText.slice(0, 300)}`);
      throw new Error(`GitHub Models API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('No content in GitHub response');

    return parseResponse(content, textLines.length);
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════════════
//  Gemini API (Fallback)
// ═══════════════════════════════════════════════════════

async function translateBatchGemini(textLines) {
  const prompt = `${getSystemPrompt()}\n\n${buildUserPrompt(textLines)}`;
  const url = `${config.GEMINI_API_URL}/${config.GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
    }),
  });

  if (response.status === 429) {
    const errText = await response.text();
    throw { status: 429, retryDelay: getRetryDelay(errText) };
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error: ${response.status}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error('Invalid Gemini response');

  return parseResponse(content, textLines.length);
}

// ═══════════════════════════════════════════════════════
//  Unified translate function with retry
// ═══════════════════════════════════════════════════════

/**
 * Determine which engine to use
 */
function getEngine() {
  if (config.GITHUB_TOKEN) return 'github';
  if (config.GEMINI_API_KEY) return 'gemini';
  throw new Error('No AI API configured! Set GITHUB_TOKEN or GEMINI_API_KEY');
}

/**
 * Translate a batch with retry logic
 */
async function translateBatch(textLines) {
  const engine = getEngine();
  const maxRetries = config.MAX_RETRIES;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (engine === 'github') {
        return await translateBatchGitHub(textLines);
      } else {
        return await translateBatchGemini(textLines);
      }
    } catch (error) {
      if (error.status === 429) {
        const delay = error.retryDelay || 15000;
        console.warn(`[AI] ⏳ Rate limited. Attempt ${attempt}/${maxRetries}. Waiting ${delay / 1000}s...`);
        await sleep(delay + 1000);
        continue;
      }
      // Content filter — skip this batch entirely, use originals
      if (error.contentFilter) {
        console.warn(`[AI] ⚠️ Content filter blocked batch (${textLines.length} lines). Using originals.`);
        return textLines;
      }
      if (attempt === maxRetries) throw error;
      console.warn(`[AI] Error on attempt ${attempt}: ${error.message || 'unknown'}. Retrying...`);
      await sleep(3000);
    }
  }
  throw new Error('Max retries exceeded');
}

/**
 * Translate all subtitle texts in batches
 */
async function translateAllTexts(allTexts, targetLang, onProgress) {
  const engine = getEngine();
  const batchSize = config.TRANSLATION_BATCH_SIZE;
  const batchDelay = config.BATCH_DELAY_MS;
  const totalBatches = Math.ceil(allTexts.length / batchSize);
  const allTranslated = [];

  console.log(`[AI] Engine: ${engine === 'github' ? 'GitHub Models (' + config.GITHUB_MODEL + ')' : 'Gemini (' + config.GEMINI_MODEL + ')'}`);
  console.log(`[AI] Translating ${allTexts.length} lines in ${totalBatches} batches to ${targetLang}...`);

  if (onProgress) onProgress({ batch: 0, totalBatches, status: 'translating', message: `מתרגם ${allTexts.length} שורות ב-${totalBatches} קבוצות...` });

  for (let i = 0; i < totalBatches; i++) {
    const start = i * batchSize;
    const end = Math.min(start + batchSize, allTexts.length);
    const batch = allTexts.slice(start, end);

    console.log(`[AI]   Batch ${i + 1}/${totalBatches} (lines ${start + 1}-${end})...`);
    if (onProgress) onProgress({ batch: i + 1, totalBatches, status: 'translating', message: `מתרגם קבוצה ${i + 1} מתוך ${totalBatches}...` });

    try {
      const translated = await translateBatch(batch);
      allTranslated.push(...translated);
      console.log(`[AI]   ✅ Batch ${i + 1} done`);
    } catch (error) {
      console.error(`[AI]   ❌ Batch ${i + 1} failed: ${error.message}. Using originals.`);
      allTranslated.push(...batch);
    }

    // Delay between batches
    if (i < totalBatches - 1) {
      await sleep(batchDelay);
    }
  }

  const translatedCount = allTranslated.filter((t, i) => t !== allTexts[i]).length;
  console.log(`[AI] ✅ Done: ${translatedCount}/${allTexts.length} lines translated`);

  return allTranslated;
}

module.exports = { translateBatch, translateAllTexts };
