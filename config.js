/**
 * Configuration for the Stremio AI Subtitles add-on v3
 * Web UI + Background translation + Cache-only Stremio handler
 */

require('dotenv').config();

module.exports = {
  // ─── GitHub Models API (Primary translation engine) ────
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_MODELS_URL: 'https://models.github.ai/inference',
  GITHUB_MODELS_QUEUE: ['openai/gpt-4.1', 'openai/gpt-4o', 'openai/gpt-5-mini', 'openai/gpt-4o-mini'],

  // ─── Gemini API (Fallback) ─────────────────────────────
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models',

  // ─── TMDB API (Movie search + posters) ─────────────────
  TMDB_API_KEY: process.env.TMDB_API_KEY || '',
  TMDB_API_TOKEN: process.env.TMDB_API_TOKEN || '',
  TMDB_BASE_URL: 'https://api.themoviedb.org/3',
  TMDB_IMAGE_URL: 'https://image.tmdb.org/t/p',

  // ─── OpenSubtitles API ─────────────────────────────────
  OPENSUBTITLES_API_KEY: process.env.OPENSUBTITLES_API_KEY || '',
  OPENSUBTITLES_USERNAME: process.env.OPENSUBTITLES_USERNAME || '',
  OPENSUBTITLES_PASSWORD: process.env.OPENSUBTITLES_PASSWORD || '',
  OPENSUBTITLES_API_URL: 'https://api.opensubtitles.com/api/v1',
  OPENSUBTITLES_USER_AGENT: 'StremioAISubtitles v3.1.0',

  // ─── SubDL API ─────────────────────────────────────────
  SUBDL_API_KEY: process.env.SUBDL_API_KEY || '',
  SUBDL_API_URL: 'https://api.subdl.com/api/v1',

  // ─── Server ─────────────────────────────────────────────
  PORT: process.env.PORT || 7000,

  // ─── Translation Settings ──────────────────────────────
  TRANSLATION_BATCH_SIZE: 200,
  BATCH_DELAY_MS: 3000,
  MAX_RETRIES: 5,

  // ─── Supported Languages ──────────────────────────────
  SUPPORTED_LANGUAGES: [
    { code: 'heb', iso: 'he', name: 'Hebrew', displayName: 'עברית', rtl: true },
  ],

  // ─── Cache ─────────────────────────────────────────────
  CACHE_MAX_AGE: 3600 * 24 * 30,    // 30 days
  STALE_REVALIDATE: 3600 * 24,

  // ─── Add-on Identity ───────────────────────────────────
  ADDON_ID: 'com.community.ai-subtitles',
  ADDON_VERSION: '3.1.0',
  ADDON_NAME: 'AI Translated Subtitles',
  ADDON_DESCRIPTION: 'כתוביות בעברית מתורגמות ע"י AI. מוריד כתוביות אנגליות מ-OpenSubtitles ומתרגם לעברית עם סנכרון מושלם.',
};
