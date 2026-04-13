/**
 * Configuration for the Stremio AI Subtitles add-on v2.1
 * Now using GitHub Models API (OpenAI-compatible) for translation
 * All secrets loaded from environment variables (see .env file)
 */

require('dotenv').config();

module.exports = {
  // ─── GitHub Models API (Primary translation engine) ────
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_MODELS_URL: 'https://models.github.ai/inference',
  // gpt-4.1-mini = fast, accurate, free with Copilot Pro
  // Change to 'openai/gpt-5-mini' when it becomes stable on GitHub Models
  GITHUB_MODEL: process.env.GITHUB_MODEL || 'openai/gpt-4.1-mini',

  // ─── Gemini API (Fallback) ─────────────────────────────
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models',

  // ─── OpenSubtitles API ─────────────────────────────────
  OPENSUBTITLES_API_KEY: process.env.OPENSUBTITLES_API_KEY || '',
  OPENSUBTITLES_USERNAME: process.env.OPENSUBTITLES_USERNAME || '',
  OPENSUBTITLES_PASSWORD: process.env.OPENSUBTITLES_PASSWORD || '',
  OPENSUBTITLES_API_URL: 'https://api.opensubtitles.com/api/v1',
  OPENSUBTITLES_USER_AGENT: 'StremioAISubtitles v2.0.0',

  // ─── Server ─────────────────────────────────────────────
  PORT: process.env.PORT || 7000,

  // ─── Translation Settings ──────────────────────────────
  TRANSLATION_BATCH_SIZE: 200,      // subtitle lines per API call
  BATCH_DELAY_MS: 3000,             // 3s delay between batches (GitHub has generous limits)
  MAX_RETRIES: 5,                   // retry count on rate limit errors

  // ─── Supported Languages ──────────────────────────────
  // Hebrew only + English passthrough
  SUPPORTED_LANGUAGES: [
    { code: 'heb', iso: 'he', name: 'Hebrew',  displayName: 'עברית',    rtl: true },
    { code: 'eng', iso: 'en', name: 'English', displayName: 'English',  rtl: false },
  ],

  // ─── Cache ─────────────────────────────────────────────
  CACHE_MAX_AGE: 3600 * 24 * 7,     // 7 days
  STALE_REVALIDATE: 3600 * 24,      // 1 day

  // ─── Add-on Identity ───────────────────────────────────
  ADDON_ID: 'com.community.ai-subtitles-gemini',
  ADDON_VERSION: '2.1.0',
  ADDON_NAME: 'AI Translated Subtitles',
  ADDON_DESCRIPTION: 'Real subtitles translated by AI. Downloads original English subtitles from OpenSubtitles and translates them to Hebrew with perfect synchronization.',
};
