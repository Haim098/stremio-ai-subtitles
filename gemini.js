/**
 * AI Translation Engine v3.0 — GitHub Models API
 * ================================================
 * Uses GitHub Models API (OpenAI-compatible) for subtitle translation.
 * Falls back through a model queue, then to Gemini if all GitHub models fail.
 * 
 * KEY FIXES (v3.0):
 * - gpt-5 family compatibility (max_completion_tokens, no temperature)
 * - Instant model-skip on 400/401/403/404/500 (not just 429)
 * - Per-batch model state reset prevention
 */

const fetch = require('node-fetch');
const config = require('./config');

// ─── State ──────────────────────────────────────────────
let activeEngine = null;
let activeGithubModelIndex = 0;
let activeGithubModel = null;
let currentOnProgress = null;
let progressBatchTracker = 0;

// ─── Helpers ────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logToUI(msg) {
  console.warn(msg);
  if (currentOnProgress) {
    currentOnProgress({ status: 'translating', log: msg, batch: progressBatchTracker });
  }
}

/**
 * Determine if a model belongs to the gpt-5 family
 * These models have different API constraints:
 *   - Use max_completion_tokens instead of max_tokens
 *   - Only support temperature=1 (default)
 */
function isGpt5Family(modelName) {
  return modelName && modelName.includes('gpt-5');
}

// ─── Prompts ────────────────────────────────────────────
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

function buildUserPrompt(textLines) {
  const numberedLines = textLines.map((line, i) => `${i + 1}| ${line}`).join('\n');
  return `Translate these ${textLines.length} subtitle lines to Hebrew. Return the same numbered format:\n\n${numberedLines}`;
}

// ─── Response Parser ────────────────────────────────────
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
          translations[i] = cleanLines[i].replace(/^\d+\s*[|.):\-]\s*/, '').trim();
        }
      }
    }
  }

  return translations;
}

// ═══════════════════════════════════════════════════════
//  GitHub Models API (Primary)
// ═══════════════════════════════════════════════════════

async function translateBatchGitHub(textLines) {
  const model = activeGithubModel || config.GITHUB_MODELS_QUEUE[0];
  const url = `${config.GITHUB_MODELS_URL}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90000); // 90s timeout

  try {
    // Build request body — adapt to model family
    const body = {
      model,
      messages: [
        { role: 'system', content: getSystemPrompt() },
        { role: 'user', content: buildUserPrompt(textLines) },
      ],
    };

    if (isGpt5Family(model)) {
      // gpt-5 family: no temperature override, use max_completion_tokens
      body.max_completion_tokens = 16384;
    } else {
      body.temperature = 0.3;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.GITHUB_TOKEN}`,
        'User-Agent': 'Stremio-AI-Subtitles/4.0',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // ── Handle non-OK responses ──
    if (!response.ok) {
      const errText = await response.text();
      const status = response.status;
      
      if (status === 429) {
        const retryAfter = response.headers.get('retry-after');
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 15000;
        throw { status: 429, retryDelay: delay, message: `Rate limited (429)` };
      }
      
      // Content filter
      if (status === 400 && errText.includes('content_filter')) {
        throw { status: 400, contentFilter: true, message: `Content filter (400)` };
      }

      // Any other error: model-level failure — trigger instant skip
      throw { 
        status, 
        modelFailure: true, 
        message: `GitHub API error ${status}: ${errText.slice(0, 200)}` 
      };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw { modelFailure: true, message: 'No content in GitHub response' };

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
    throw { status: 429, retryDelay: 15000, message: 'Gemini rate limited' };
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
//  Engine selection
// ═══════════════════════════════════════════════════════

function getEngine() {
  if (!activeGithubModel && config.GITHUB_TOKEN) {
    activeGithubModel = config.GITHUB_MODELS_QUEUE[activeGithubModelIndex];
  }
  if (activeEngine) return activeEngine;
  if (config.GITHUB_TOKEN) return activeEngine = 'github';
  if (config.GEMINI_API_KEY) return activeEngine = 'gemini';
  throw new Error('No AI API configured! Set GITHUB_TOKEN or GEMINI_API_KEY');
}

/**
 * Advance to the next GitHub model in the queue.
 * Returns true if a new model is available, false if queue is exhausted.
 */
function advanceGithubModel(reason) {
  activeGithubModelIndex++;
  if (activeGithubModelIndex < config.GITHUB_MODELS_QUEUE.length) {
    activeGithubModel = config.GITHUB_MODELS_QUEUE[activeGithubModelIndex];
    logToUI(`[AI] 🔄 Skipping failed model → now using: ${activeGithubModel} (reason: ${reason})`);
    return true;
  }
  
  // All GitHub models exhausted — try Gemini
  if (config.GEMINI_API_KEY) {
    logToUI('[AI] 🔄 All GitHub Models exhausted! Switching to Gemini engine.');
    activeEngine = 'gemini';
    return true;
  }
  
  logToUI('[AI] ❌ No models left in queue and no Gemini fallback configured!');
  return false;
}


// ═══════════════════════════════════════════════════════
//  Direct single-attempt translate (used by content filter micro-batches)
// ═══════════════════════════════════════════════════════

async function translateBatchDirect(textLines) {
  const engine = activeEngine || 'github';
  if (engine === 'github') {
    return await translateBatchGitHub(textLines);
  } else {
    return await translateBatchGemini(textLines);
  }
}

// ═══════════════════════════════════════════════════════
//  Unified translate with bulletproof fallback
// ═══════════════════════════════════════════════════════


async function translateBatch(textLines) {
  let engine = getEngine();
  const MAX_ATTEMPTS = 8; // generous to allow model-switches within

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (engine === 'github') {
        return await translateBatchGitHub(textLines);
      } else {
        return await translateBatchGemini(textLines);
      }
    } catch (error) {
      
      // ── Model-level failure (400/401/403/404/500/empty) ──
      // Instantly skip to the next model — no retries on the same broken model
      if (error.modelFailure) {
        logToUI(`[AI] ⚠️ Model failure on ${activeGithubModel}: ${error.message}`);
        if (engine === 'github' && advanceGithubModel(error.message)) {
          engine = activeEngine; // might have switched to 'gemini'
          continue; // retry immediately with next model
        }
        logToUI('[AI] ❌ All engines exhausted. Using original text for this batch.');
        return textLines;
      }

      // ── Rate limit (429) ──
      if (error.status === 429) {
        const delay = error.retryDelay || 15000;
        
        // Hard rate limit (>60s wait) → skip model
        if (delay > 60000) {
          logToUI(`[AI] 🚨 Hard rate limit (${Math.round(delay / 1000)}s). Skipping model...`);
          if (engine === 'github' && advanceGithubModel('Hard rate limit ' + delay + 'ms')) {
            engine = activeEngine;
            continue;
          }
          return textLines;
        }
        
        // Soft rate limit — wait and retry same model
        logToUI(`[AI] ⏳ Rate limited. Waiting ${Math.round(delay / 1000)}s (attempt ${attempt})...`);
        await sleep(delay + 1000);
        continue;
      }
      
      // ── Content filter ──
      if (error.contentFilter) {
        // If batch is already small (≤30 lines), give up on it
        if (textLines.length <= 30) {
          logToUI(`[AI] ⚠️ Content filter blocked micro-batch (${textLines.length} lines). Using originals.`);
          return textLines;
        }
        
        // Split into smaller sub-batches and retry each
        const SUB_SIZE = 25;
        const subBatches = [];
        for (let s = 0; s < textLines.length; s += SUB_SIZE) {
          subBatches.push(textLines.slice(s, s + SUB_SIZE));
        }
        
        logToUI(`[AI] 🔄 Content filter blocked ${textLines.length} lines. Splitting into ${subBatches.length} micro-batches of ~${SUB_SIZE}...`);
        
        const allResults = [];
        for (let si = 0; si < subBatches.length; si++) {
          try {
            logToUI(`[AI]   ↳ Micro-batch ${si + 1}/${subBatches.length} (${subBatches[si].length} lines)...`);
            const subResult = await translateBatchDirect(subBatches[si]);
            allResults.push(...subResult);
          } catch (subErr) {
            logToUI(`[AI]   ↳ ⚠️ Micro-batch ${si + 1} also blocked. Keeping originals for these ${subBatches[si].length} lines.`);
            allResults.push(...subBatches[si]); // use originals for this sub-batch only
          }
          await sleep(1500); // small delay between micro-batches
        }
        return allResults;
      }
      
      // ── Network / unknown error ──
      if (attempt >= 3) {
        // After 3 network failures, try next model instead of retrying forever
        logToUI(`[AI] ⚠️ Network error x${attempt}: ${error.message}. Trying next model...`);
        if (engine === 'github' && advanceGithubModel('Repeated network errors')) {
          engine = activeEngine;
          continue;
        }
        return textLines;
      }
      
      logToUI(`[AI] ⚠️ Error attempt ${attempt}: ${error.message || 'unknown'}. Retrying in 3s...`);
      await sleep(3000);
    }
  }
  
  return textLines; // Ultimate fallback to originals
}

// ═══════════════════════════════════════════════════════
//  Batch orchestrator
// ═══════════════════════════════════════════════════════

async function translateAllTexts(allTexts, targetLang, onProgress) {
  // Reset state for each new translation job
  activeEngine = null;
  activeGithubModelIndex = 0;
  activeGithubModel = null;
  currentOnProgress = onProgress;
  
  const engine = getEngine();
  const batchSize = config.TRANSLATION_BATCH_SIZE;
  const batchDelay = config.BATCH_DELAY_MS;
  const totalBatches = Math.ceil(allTexts.length / batchSize);
  const allTranslated = [];

  console.log(`[AI] Engine: ${engine === 'github' ? 'GitHub Models (' + activeGithubModel + ')' : 'Gemini (' + config.GEMINI_MODEL + ')'}`);
  console.log(`[AI] Model queue: ${config.GITHUB_MODELS_QUEUE.join(' → ')} → Gemini`);
  console.log(`[AI] Translating ${allTexts.length} lines in ${totalBatches} batches to ${targetLang}...`);

  if (onProgress) onProgress({ log: `🚀 Starting with: ${activeGithubModel || config.GEMINI_MODEL} | Queue: ${config.GITHUB_MODELS_QUEUE.join(' → ')}` });
  if (onProgress) onProgress({ batch: 0, totalBatches, status: 'translating', message: `מתרגם ${allTexts.length} שורות ב-${totalBatches} קבוצות...` });

  for (let i = 0; i < totalBatches; i++) {
    progressBatchTracker = i + 1;
    const start = i * batchSize;
    const end = Math.min(start + batchSize, allTexts.length);
    const batch = allTexts.slice(start, end);

    const currentModel = activeEngine === 'gemini' ? 'Gemini' : (activeGithubModel || '?');
    console.log(`[AI]   Batch ${i + 1}/${totalBatches} (lines ${start + 1}-${end}) via ${currentModel}...`);
    if (onProgress) onProgress({ batch: i + 1, totalBatches, status: 'translating', message: `מתרגם קבוצה ${i + 1} מתוך ${totalBatches} (${currentModel})...` });

    const translatedBatch = await translateBatch(batch);
    allTranslated.push(...translatedBatch);
    console.log(`[AI]   ✅ Batch ${i + 1} done`);

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
