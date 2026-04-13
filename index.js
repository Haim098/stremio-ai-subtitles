/**
 * Stremio AI Subtitles Add-on v3
 * ===============================
 * Web UI for subtitle generation + Cache-only Stremio handler.
 * Users search movies, generate translations via web UI,
 * then subtitles appear automatically in Stremio.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const config = require('./config');
const { getEnglishSubtitles } = require('./opensubtitles');
const { translateAllTexts } = require('./gemini');
const srtParser = require('./srtParser');
const cache = require('./subtitleCache');

// ─── Ensure directories ─────────────────────────────────
const publicDir = path.join(__dirname, 'public');
const subsDir = path.join(publicDir, 'subs');
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });
if (!fs.existsSync(subsDir)) fs.mkdirSync(subsDir, { recursive: true });

// ─── Library metadata ────────────────────────────────────
const libraryPath = path.join(subsDir, 'library.json');
function loadLibrary() {
  try { return JSON.parse(fs.readFileSync(libraryPath, 'utf8')); } catch { return []; }
}
function saveLibrary(lib) {
  fs.writeFileSync(libraryPath, JSON.stringify(lib, null, 2));
}

// ─── Progress tracking ──────────────────────────────────
const progressStore = {};
const activeJobs = new Set();

// ─── Base URL ────────────────────────────────────────────
function getBaseUrl() {
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return `http://localhost:${config.PORT}`;
}

// ═══════════════════════════════════════════════════════════
//  Stremio Addon — CACHE ONLY (instant response)
// ═══════════════════════════════════════════════════════════

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
  behaviorHints: { configurable: false, configurationRequired: false },
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async function(args) {
  const { imdbId } = extractInfo(args.id);
  const baseUrl = getBaseUrl();
  const subtitles = [];

  for (const lang of config.SUPPORTED_LANGUAGES) {
    const filename = cache.getCached(args.id, lang.code);
    if (filename) {
      subtitles.push({
        id: `aisub-${lang.code}-${imdbId}`,
        url: `${baseUrl}/public/subs/${filename}`,
        lang: lang.code,
      });
    }
  }

  if (subtitles.length > 0) {
    console.log(`[Stremio] ✅ Serving ${subtitles.length} cached subs for ${args.id}`);
  }

  return { subtitles, cacheMaxAge: config.CACHE_MAX_AGE, staleRevalidate: config.STALE_REVALIDATE };
});

function extractInfo(id) {
  const parts = id.split(':');
  return { imdbId: parts[0], season: parts[1] || null, episode: parts[2] || null };
}

// ═══════════════════════════════════════════════════════════
//  Express App — Web UI + API
// ═══════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use('/public', express.static(publicDir));

// ─── API: Search movies via TMDB ─────────────────────────
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 2) return res.json({ results: [] });

  try {
    const url = `${config.TMDB_BASE_URL}/search/multi?query=${encodeURIComponent(query)}&language=he-IL&page=1&include_adult=false`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.TMDB_API_TOKEN}`, 'accept': 'application/json' }
    });
    const data = await response.json();

    const results = (data.results || [])
      .filter(r => (r.media_type === 'movie' || r.media_type === 'tv') && r.poster_path)
      .slice(0, 12)
      .map(r => ({
        tmdbId: r.id,
        type: r.media_type,
        title: r.title || r.name,
        originalTitle: r.original_title || r.original_name,
        year: (r.release_date || r.first_air_date || '').slice(0, 4),
        poster: `${config.TMDB_IMAGE_URL}/w342${r.poster_path}`,
        rating: r.vote_average ? r.vote_average.toFixed(1) : null,
        overview: r.overview ? r.overview.slice(0, 120) + '...' : '',
      }));

    res.json({ results });
  } catch (err) {
    console.error('[TMDB] Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ─── API: Get IMDB ID from TMDB ID ──────────────────────
app.get('/api/imdb/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const type = req.query.type || 'movie';

  try {
    const endpoint = type === 'tv' ? 'tv' : 'movie';
    const url = `${config.TMDB_BASE_URL}/${endpoint}/${tmdbId}/external_ids`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${config.TMDB_API_TOKEN}`, 'accept': 'application/json' }
    });
    const data = await response.json();
    const imdbId = data.imdb_id;
    if (!imdbId) return res.status(404).json({ error: 'IMDB ID not found' });
    res.json({ imdbId });
  } catch (err) {
    console.error('[TMDB] IMDB lookup error:', err.message);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// ─── API: Check subtitle status ─────────────────────────
app.get('/api/status/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  const filename = cache.getCached(imdbId, 'heb');
  const progress = progressStore[imdbId];
  
  res.json({
    exists: !!filename,
    filename: filename || null,
    url: filename ? `${getBaseUrl()}/public/subs/${filename}` : null,
    generating: activeJobs.has(imdbId),
    progress: progress || null,
  });
});

// ─── API: Start subtitle generation ─────────────────────
app.post('/api/generate', async (req, res) => {
  const { imdbId, type, title, poster, year } = req.body;

  if (!imdbId) return res.status(400).json({ error: 'Missing imdbId' });
  if (activeJobs.has(imdbId)) return res.json({ status: 'already_running' });

  // Check cache
  const existing = cache.getCached(imdbId, 'heb');
  if (existing) return res.json({ status: 'exists', filename: existing });

  // Start generation in background
  activeJobs.add(imdbId);
  progressStore[imdbId] = { status: 'starting', batch: 0, totalBatches: 0, message: 'מתחיל...' };
  res.json({ status: 'started' });

  // Background work
  (async () => {
    try {
      // Step 1: Download English subtitles
      progressStore[imdbId] = { status: 'downloading', batch: 0, totalBatches: 0, message: 'מוריד כתוביות מקוריות מ-OpenSubtitles...' };
      
      const englishSrt = await getEnglishSubtitles(imdbId.replace('tt', ''), type || 'movie');
      if (!englishSrt) {
        progressStore[imdbId] = { status: 'error', message: 'לא נמצאו כתוביות אנגליות לסרט זה' };
        activeJobs.delete(imdbId);
        return;
      }

      const validation = srtParser.validate(englishSrt);
      if (!validation.valid) {
        progressStore[imdbId] = { status: 'error', message: 'קובץ כתוביות שגוי' };
        activeJobs.delete(imdbId);
        return;
      }

      cache.setOriginalCached(imdbId, englishSrt);
      progressStore[imdbId] = { status: 'parsing', batch: 0, totalBatches: 0, message: `נמצאו ${validation.blockCount} בלוקים. מנתח...` };

      // Step 2: Parse
      const blocks = srtParser.parse(englishSrt);
      const texts = srtParser.extractTexts(blocks);

      // Step 3: Translate with progress callback
      const onProgress = (p) => { progressStore[imdbId] = p; };
      const translatedTexts = await translateAllTexts(texts, 'heb', onProgress);

      // Step 4: Rebuild SRT
      const translatedBlocks = srtParser.replaceTexts(blocks, translatedTexts);
      const translatedSrt = srtParser.build(translatedBlocks);
      const filename = cache.setCached(imdbId, 'heb', translatedSrt, imdbId);

      // Step 5: Update library
      const library = loadLibrary();
      const entry = { imdbId, title: title || imdbId, poster: poster || null, year: year || '', createdAt: new Date().toISOString(), filename };
      const idx = library.findIndex(e => e.imdbId === imdbId);
      if (idx >= 0) library[idx] = entry; else library.unshift(entry);
      saveLibrary(library);

      progressStore[imdbId] = { status: 'done', batch: 0, totalBatches: 0, message: 'הכתוביות מוכנות! 🎉', filename };
      console.log(`[Generate] ✅ ${title || imdbId} — subtitles ready`);
    } catch (err) {
      console.error(`[Generate] ❌ ${imdbId}:`, err.message);
      progressStore[imdbId] = { status: 'error', message: `שגיאה: ${err.message}` };
    } finally {
      activeJobs.delete(imdbId);
    }
  })();
});

// ─── API: Progress SSE stream ───────────────────────────
app.get('/api/progress/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const interval = setInterval(() => {
    const progress = progressStore[imdbId] || { status: 'unknown', message: 'אין מידע' };
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
    if (progress.status === 'done' || progress.status === 'error') {
      clearInterval(interval);
      setTimeout(() => res.end(), 1000);
    }
  }, 800);

  req.on('close', () => clearInterval(interval));
});

// ─── API: Library ───────────────────────────────────────
app.get('/api/library', (req, res) => {
  const library = loadLibrary();
  res.json({ library });
});

// ─── Serve index.html for root ───────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ─── Mount Stremio addon routes ──────────────────────────
const addonInterface = builder.getInterface();
app.use(getRouter(addonInterface));

// ─── Start server ────────────────────────────────────────
app.listen(config.PORT, () => {
  const aiEngine = config.GITHUB_TOKEN ? `GitHub Models (${config.GITHUB_MODEL})` : `Gemini (${config.GEMINI_MODEL})`;
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🎬 Stremio AI Translated Subtitles v3');
  console.log(`  📡 Translation: ${aiEngine}`);
  console.log('  📥 Source: OpenSubtitles.com');
  console.log('  🌐 Web UI: Enabled');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n🚀 Server ready at http://localhost:${config.PORT}`);
  console.log(`   Web UI:    http://localhost:${config.PORT}/`);
  console.log(`   Manifest:  http://localhost:${config.PORT}/manifest.json\n`);
});
