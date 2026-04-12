/**
 * Configuration for the Stremio AI Subtitles add-on
 */

module.exports = {
  // Gemini API Configuration  
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'AIzaSyDQLmPD2Rlyjk2NI4aEr_q1TUhs-wTPejI',
  GEMINI_MODEL: 'gemini-3-flash-preview',
  GEMINI_API_URL: 'https://generativelanguage.googleapis.com/v1beta/models',

  // Server Configuration
  PORT: process.env.PORT || 7000,

  // Supported languages with display names
  SUPPORTED_LANGUAGES: [
    { code: 'heb', name: 'Hebrew',  displayName: 'עברית' },
    { code: 'eng', name: 'English', displayName: 'English' },
    { code: 'ara', name: 'Arabic',  displayName: 'العربية' },
    { code: 'rus', name: 'Russian', displayName: 'Русский' },
    { code: 'fre', name: 'French',  displayName: 'Français' },
    { code: 'spa', name: 'Spanish', displayName: 'Español' },
    { code: 'ger', name: 'German',  displayName: 'Deutsch' },
  ],

  // Cache settings
  CACHE_MAX_AGE: 3600 * 24,       // 24 hours
  STALE_REVALIDATE: 3600 * 6,     // 6 hours

  // Add-on identity
  ADDON_ID: 'com.community.ai-subtitles-gemini',
  ADDON_VERSION: '1.0.0',
  ADDON_NAME: 'AI Subtitles (Gemini)',
  ADDON_DESCRIPTION: 'AI-generated subtitles powered by Gemini 3 Flash. Generates contextual subtitles in multiple languages using Google AI.',
};
