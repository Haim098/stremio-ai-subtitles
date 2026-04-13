/**
 * Stremio AI Subtitles Add-on v2
 * ===============================
 * Downloads real English subtitles from OpenSubtitles.com,
 * translates them with Gemini 3 Flash Preview,
 * and serves perfectly synchronized subtitles in multiple languages.
 */

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const path = require('path');
const fs = require('fs');

// Ensure public directories exist before any SDK calls
const publicDir = path.join(__dirname, 'public');
const subsDir = path.join(publicDir, 'subs');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(subsDir)) fs.mkdirSync(subsDir, { recursive: true });

const config = require('./config');
const { getEnglishSubtitles } = require('./opensubtitles');
const { translateAllTexts } = require('./gemini');
const srtParser = require('./srtParser');
const { getCached, setCached, getStats, getOriginalCached, setOriginalCached } = require('./subtitleCache');

// ─── Manifest ─────────────────────────────────────────────
const manifest = {
  id: config.ADDON_ID,
  version: config.ADDON_VERSION,
  name: config.ADDON_NAME,
  description: config.ADDON_DESCRIPTION,
  logo: 'https://i.imgur.com/wPMvobM.png',

  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],

  idPrefixes: ['tt'],
  subtitlesLanguages: config.SUPPORTED_LANGUAGES.map(l => l.code),

  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

console.log('═══════════════════════════════════════════════════════════');
console.log('  🎬 Stremio AI Translated Subtitles v2');
const aiEngine = config.GITHUB_TOKEN ? `GitHub Models (${config.GITHUB_MODEL})` : `Gemini (${config.GEMINI_MODEL})`;
console.log('  📡 Translation: ' + aiEngine);
console.log('  📥 Source: OpenSubtitles.com');
console.log('  🌐 Languages: ' + config.SUPPORTED_LANGUAGES.map(l => l.displayName).join(', '));
console.log('═══════════════════════════════════════════════════════════');

// ─── Build the Add-on ─────────────────────────────────────
const builder = new addonBuilder(manifest);

/**
 * Extract season/episode from Stremio ID
 * Format: tt1234567:1:2 (imdb:season:episode)
 */
function extractSeriesInfo(id) {
  const parts = id.split(':');
  if (parts.length >= 3) {
    return { imdbId: parts[0], season: parts[1], episode: parts[2] };
  }
  return { imdbId: parts[0], season: null, episode: null };
}

/**
 * Get the base URL for serving subtitle files
 */
function getBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  return `http://localhost:${config.PORT}`;
}

/**
 * Translate an SRT file from English to target language
 * @param {string} englishSrt - Original English SRT content
 * @param {string} targetLang - Target language code
 * @returns {Promise<string>} Translated SRT content
 */
async function translateSrt(englishSrt, targetLang) {
  // Skip translation for English
  if (targetLang === 'eng') return englishSrt;

  // 1. Parse SRT into blocks
  const blocks = srtParser.parse(englishSrt);
  if (blocks.length === 0) {
    throw new Error('Failed to parse SRT — no valid blocks found');
  }
  console.log(`   📝 Parsed ${blocks.length} subtitle blocks`);

  // 2. Extract text only
  const texts = srtParser.extractTexts(blocks);

  // 3. Translate all texts via Gemini
  const translatedTexts = await translateAllTexts(texts, targetLang);

  // 4. Rebuild SRT with original timestamps + translated text
  const translatedBlocks = srtParser.replaceTexts(blocks, translatedTexts);
  const translatedSrt = srtParser.build(translatedBlocks);

  return translatedSrt;
}

// ─── Subtitles Handler ────────────────────────────────────
builder.defineSubtitlesHandler(async function(args) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📥 Subtitle request: type=${args.type} id=${args.id}`);

  const { imdbId, season, episode } = extractSeriesInfo(args.id);
  const baseUrl = getBaseUrl();
  const subtitles = [];

  // ── Step 1: Get English source subtitles ──────────────
  let englishSrt = getOriginalCached(args.id);

  if (!englishSrt) {
    console.log(`   🔍 Searching OpenSubtitles for English subs...`);
    englishSrt = await getEnglishSubtitles(imdbId, args.type, season, episode);

    if (!englishSrt) {
      console.log(`   ⚠️ No English subtitles found on OpenSubtitles`);
      return { subtitles: [] };
    }

    // Validate SRT
    const validation = srtParser.validate(englishSrt);
    if (!validation.valid) {
      console.log(`   ⚠️ Invalid SRT: ${validation.error}`);
      return { subtitles: [] };
    }

    console.log(`   ✅ Found English subtitles (${validation.blockCount} blocks)`);
    setOriginalCached(args.id, englishSrt);
  } else {
    console.log(`   📦 Using cached English subtitles`);
  }

  // ── Step 2: Translate to each language ─────────────────
  for (const langInfo of config.SUPPORTED_LANGUAGES) {
    try {
      // Check if translation is already cached
      let filename = getCached(args.id, langInfo.code);

      if (!filename) {
        console.log(`   🤖 Translating to ${langInfo.name} (${langInfo.displayName})...`);

        const translatedSrt = await translateSrt(englishSrt, langInfo.code);
        filename = setCached(args.id, langInfo.code, translatedSrt, imdbId);

        console.log(`   ✅ ${langInfo.name} translation saved: ${filename}`);
      } else {
        console.log(`   📦 ${langInfo.name}: cached → ${filename}`);
      }

      subtitles.push({
        id: `aisub-${langInfo.code}-${imdbId}`,
        url: `${baseUrl}/public/subs/${filename}`,
        lang: langInfo.code,
      });

    } catch (error) {
      console.error(`   ❌ ${langInfo.name} failed: ${error.message}`);
    }
  }

  console.log(`   🏁 Returning ${subtitles.length} translated subtitle tracks`);
  console.log(`${'═'.repeat(60)}\n`);

  return {
    subtitles,
    cacheMaxAge: config.CACHE_MAX_AGE,
    staleRevalidate: config.STALE_REVALIDATE,
  };
});

// ─── Start the server ─────────────────────────────────────
const addonInterface = builder.getInterface();

serveHTTP(addonInterface, {
  port: config.PORT,
  static: '/public',
});

console.log(`\n🚀 Add-on v2 ready!`);
console.log(`   Manifest:  http://localhost:${config.PORT}/manifest.json`);
console.log(`   Install:   Paste into Stremio → Add-ons → Community`);
console.log(`              http://localhost:${config.PORT}/manifest.json\n`);

// Periodic stats
setInterval(() => {
  const stats = getStats();
  console.log(`[Stats] Cache: ${stats.entriesInMemory} translated, ${stats.originalsInMemory} originals, ${stats.filesOnDisk} files`);
}, 300000);
