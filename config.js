/**
 * Configuration for the Stremio AI Subtitles add-on v2
 * Now with OpenSubtitles integration for real subtitle translation
 * All secrets loaded from environment variables (see .env file)
 */

require('dotenv').config();

module.exports = {
  // ─── Gemini API ─────────────────────────────────────────
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
  TRANSLATION_BATCH_SIZE: 200,      // subtitle lines per Gemini API call (larger = fewer API calls)
  BATCH_DELAY_MS: 4500,             // delay between batches to respect rate limits (15 RPM)
  MAX_RETRIES: 3,                   // retry count on 429 rate limit errors

  // ─── Supported Languages ──────────────────────────────
  // Default: Hebrew + English only (to stay within free API limits)
  // English = direct passthrough (no translation needed)
  // Each additional language = ~7 extra Gemini API calls per movie
  SUPPORTED_LANGUAGES: [
    { code: 'heb', iso: 'he', name: 'Hebrew',  displayName: 'עברית',    rtl: true },
    { code: 'eng', iso: 'en', name: 'English', displayName: 'English',  rtl: false },
    { code: 'ara', iso: 'ar', name: 'Arabic',  displayName: 'العربية',  rtl: true },
    { code: 'rus', iso: 'ru', name: 'Russian', displayName: 'Русский',  rtl: false },
  ],

  // ─── Cache ─────────────────────────────────────────────
  CACHE_MAX_AGE: 3600 * 24 * 7,     // 7 days (translated subs don't change)
  STALE_REVALIDATE: 3600 * 24,      // 1 day

  // ─── Add-on Identity ───────────────────────────────────
  ADDON_ID: 'com.community.ai-subtitles-gemini',
  ADDON_VERSION: '2.0.0',
  ADDON_NAME: 'AI Translated Subtitles',
  ADDON_DESCRIPTION: 'Real subtitles translated by Gemini AI. Downloads original English subtitles from OpenSubtitles and translates them to your language with perfect synchronization.',
};
