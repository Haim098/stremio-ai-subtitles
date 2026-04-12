/**
 * Stremio AI Subtitles Add-on
 * ===========================
 * Generates AI-powered subtitles using Gemini 3 Flash Preview.
 * Supports multiple languages and caches results for performance.
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
const { generateSubtitles } = require('./gemini');
const { getCached, setCached, getStats, SUBS_DIR } = require('./subtitleCache');

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
  
  // Declare supported subtitle languages
  subtitlesLanguages: config.SUPPORTED_LANGUAGES.map(l => l.code),
  
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};

console.log('═══════════════════════════════════════════════════');
console.log('  🎬 Stremio AI Subtitles Add-on (Gemini)');
console.log('  📡 Model: ' + config.GEMINI_MODEL);
console.log('  🌐 Languages: ' + config.SUPPORTED_LANGUAGES.map(l => l.displayName).join(', '));
console.log('═══════════════════════════════════════════════════');

// ─── Build the Add-on ─────────────────────────────────────
const builder = new addonBuilder(manifest);

/**
 * Extract title from Stremio arguments
 * Uses filename from extra args, or falls back to the IMDB id
 */
function extractTitle(args) {
  // Try to get filename from extra params
  if (args.extra && args.extra.filename) {
    // Clean up filename: remove extension and common patterns
    let name = args.extra.filename;
    name = name.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm)$/i, '');
    name = name.replace(/\./g, ' ');
    name = name.replace(/\[.*?\]/g, '');
    name = name.replace(/\(.*?\)/g, '');
    name = name.replace(/\s{2,}/g, ' ');
    return name.trim();
  }
  
  return args.id;
}

/**
 * Extract season/episode from ID for series
 * Stremio ID format: tt1234567:1:2 (imdb:season:episode)
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
  // Use RENDER_EXTERNAL_URL if deployed on Render
  if (process.env.RENDER_EXTERNAL_URL) {
    return process.env.RENDER_EXTERNAL_URL;
  }
  return `http://localhost:${config.PORT}`;
}

// ─── Subtitles Handler ────────────────────────────────────
builder.defineSubtitlesHandler(async function(args) {
  console.log(`\n📥 Subtitle request: type=${args.type} id=${args.id}`);
  if (args.extra) {
    console.log(`   Extra: ${JSON.stringify(args.extra)}`);
  }

  const title = extractTitle(args);
  const { imdbId, season, episode } = extractSeriesInfo(args.id);
  const baseUrl = getBaseUrl();

  console.log(`   Title: "${title}" | IMDB: ${imdbId} | S${season || '-'}E${episode || '-'}`);

  const subtitles = [];

  // Generate subtitles for each supported language
  for (const langInfo of config.SUPPORTED_LANGUAGES) {
    try {
      // Check cache first
      let filename = getCached(args.id, langInfo.code);

      if (!filename) {
        // Generate new subtitles via Gemini
        console.log(`   🤖 Generating ${langInfo.name} subtitles...`);
        const srtText = await generateSubtitles(title, args.type, langInfo.code, season, episode);
        filename = setCached(args.id, langInfo.code, srtText, title);
      }

      subtitles.push({
        id: `gemini-ai-${langInfo.code}-${imdbId}`,
        url: `${baseUrl}/subs/${filename}`,
        lang: langInfo.code,
      });

    } catch (error) {
      console.error(`   ❌ Failed for ${langInfo.name}: ${error.message}`);
      // Continue with other languages even if one fails
    }
  }

  console.log(`   ✅ Returning ${subtitles.length} subtitle tracks`);
  
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

console.log(`\n🚀 Add-on ready!`);
console.log(`   Manifest:  http://localhost:${config.PORT}/manifest.json`);
console.log(`   Install:   Open Stremio → Add-ons → Add from URL`);
console.log(`              Paste: http://localhost:${config.PORT}/manifest.json\n`);

// Log cache stats periodically
setInterval(() => {
  const stats = getStats();
  console.log(`[Stats] Cache: ${stats.entriesInMemory} entries in memory, ${stats.filesOnDisk} files on disk`);
}, 300000); // Every 5 minutes
