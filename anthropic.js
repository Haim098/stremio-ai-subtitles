/**
 * Anthropic (Claude) translation engine — user-supplied API key (BYOK).
 * ======================================================================
 * The viewer pastes their own Anthropic API key in the web UI and picks a
 * model. The key lives only in their browser; it is sent per request and
 * never stored on the server.
 */

const Anthropic = require('@anthropic-ai/sdk');

const KEY_RE = /^sk-ant-[A-Za-z0-9_\-]+$/;
const DEFAULT_MODEL = 'claude-opus-5-5';
const MAX_OUTPUT_TOKENS = 32000;
const REQUEST_TIMEOUT_MS = 180000;
// Opt-in server-side retry on another model if the chosen model declines a
// batch for policy reasons. "default" is safe on every model: models without
// fallback support simply run alone.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Shown when the live model list can't be loaded (network / Anthropic outage).
// Newest model of each line per Anthropic's models overview (checked Oct 2026).
// The live list from the user's key always wins when it loads.
const FALLBACK_MODELS = [
  { id: 'claude-opus-5-5',   displayName: 'Claude Opus 5.5',   line: 'opus',   recommended: true },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', line: 'sonnet', recommended: true },
  { id: 'claude-haiku-5-5',  displayName: 'Claude Haiku 5.5',  line: 'haiku',  recommended: true },
  { id: 'claude-fable-5-1',  displayName: 'Claude Fable 5.1',  line: 'fable',  recommended: true },
];

function looksLikeAnthropicKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

function createClient(apiKey) {
  return new Anthropic({ apiKey, maxRetries: 2, timeout: REQUEST_TIMEOUT_MS });
}

function supportsEffort(info, level) {
  const effort = info && info.capabilities && info.capabilities.effort;
  if (!effort) return null; // unknown — let the API decide
  return !!(effort.supported && effort[level] && effort[level].supported);
}

/**
 * List the models this key can use. Doubles as key validation: an invalid key
 * fails with 401, and listing models costs no tokens.
 *
 * Sorted newest first. The newest active model of each line (opus / sonnet /
 * haiku / ...) is marked `recommended`; retired models are dropped and
 * deprecated ones are flagged so the UI can push them to the bottom.
 */
async function listModels(apiKey) {
  const client = createClient(apiKey);
  const models = [];
  for await (const m of client.models.list({ limit: 100 })) {
    if (m.lifecycle === 'retired') continue;
    models.push({
      id: m.id,
      displayName: m.display_name || m.id,
      line: m.line || null,
      createdAt: m.created_at || null,
      deprecated: m.lifecycle === 'deprecated',
      retiresAt: m.retires_at || null,
    });
  }
  models.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const seenLines = new Set();
  for (const m of models) {
    m.recommended = false;
    if (m.deprecated) continue;
    const line = m.line || m.id; // a model with no line stands on its own
    if (!seenLines.has(line)) { seenLines.add(line); m.recommended = !!m.line; }
  }
  return models;
}

/**
 * Per-job settings, resolved once before the first batch. Reads the model's
 * capabilities so we only send parameters the model accepts.
 */
async function prepareJob(apiKey, model) {
  const client = createClient(apiKey);
  const job = {
    client,
    model: model || DEFAULT_MODEL,
    displayName: model || DEFAULT_MODEL,
    maxTokens: MAX_OUTPUT_TOKENS,
    useEffort: true,
    useFallbacks: true,
  };
  try {
    const info = await client.models.retrieve(job.model);
    job.displayName = info.display_name || job.model;
    if (info.max_tokens) job.maxTokens = Math.min(MAX_OUTPUT_TOKENS, info.max_tokens);
    const effortOk = supportsEffort(info, 'low');
    if (effortOk === false) job.useEffort = false;
  } catch (err) {
    throw mapError(err);
  }
  return job;
}

/**
 * Turn SDK errors into the plain error objects the batch loop in gemini.js
 * already understands (userTokenInvalid / fatal / 429 / generic).
 */
function mapError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return {
      status: err.status,
      userTokenInvalid: true,
      message: `מפתח ה-API של Anthropic לא תקין או ללא הרשאה (${err.status}). עדכן אותו בהגדרות.`,
    };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return {
      status: 404,
      fatal: true,
      message: 'המודל שנבחר לא זמין עבור המפתח הזה. בחר מודל אחר בהגדרות.',
    };
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfter = parseInt(err.headers && err.headers.get && err.headers.get('retry-after'), 10);
    return {
      status: 429,
      retryDelay: Number.isFinite(retryAfter) ? retryAfter * 1000 : 15000,
      message: 'Anthropic rate limited (429)',
    };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message || '');
    if (/credit balance/i.test(msg)) {
      return { status: 400, fatal: true, message: 'אין מספיק קרדיט בחשבון ה-Anthropic שלך. הטען קרדיט ונסה שוב.' };
    }
    return { status: 400, badRequest: true, fatal: true, message: `Anthropic API error 400: ${msg.slice(0, 200)}` };
  }
  if (err instanceof Anthropic.APIError) {
    // 5xx / overloaded / connection errors — retryable by the caller.
    return { status: err.status, message: `Anthropic API error ${err.status || ''}: ${String(err.message || '').slice(0, 200)}` };
  }
  return err;
}

function buildParams(job, systemPrompt, userPrompt) {
  const params = {
    model: job.model,
    max_tokens: job.maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  };
  // Subtitle translation is a simple, high-volume task: low effort keeps
  // each batch fast and cheap.
  if (job.useEffort) params.output_config = { effort: 'low' };
  if (job.useFallbacks) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

/**
 * Translate one batch. Returns the raw response text.
 * Throws { contentFilter: true } when the model declines the batch, so the
 * caller can split it into smaller pieces.
 */
async function translateText(job, systemPrompt, userPrompt) {
  // At most two extra tries, each dropping an optional parameter the model
  // rejected (effort / fallbacks) — then the error is real.
  for (let i = 0; i < 3; i++) {
    try {
      const params = buildParams(job, systemPrompt, userPrompt);
      const stream = params.betas
        ? job.client.beta.messages.stream(params)
        : job.client.messages.stream(params);
      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        throw { contentFilter: true, message: 'Claude declined this batch (refusal)' };
      }
      const text = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      if (!text) throw { message: 'No text in Claude response' };
      return text;
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        const msg = String(err.message || '');
        if (job.useEffort && /effort|output_config/i.test(msg)) { job.useEffort = false; continue; }
        if (job.useFallbacks && /fallback|anthropic-beta|beta/i.test(msg)) { job.useFallbacks = false; continue; }
      }
      throw mapError(err);
    }
  }
  throw { message: 'Claude request failed after parameter retries' };
}

module.exports = {
  DEFAULT_MODEL,
  FALLBACK_MODELS,
  looksLikeAnthropicKey,
  listModels,
  prepareJob,
  translateText,
  mapError,
};
