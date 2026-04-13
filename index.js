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

// ─── API: Get TV Series Seasons ─────────────────────────
app.get('/api/tv/:tmdbId', async (req, res) => {
  try {
    const url = `${config.TMDB_BASE_URL}/tv/${req.params.tmdbId}?language=he-IL`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.TMDB_API_TOKEN}` } });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'TV lookup failed' });
  }
});

// ─── API: Get TV Series Episodes for Season ─────────────
app.get('/api/tv/:tmdbId/season/:season_number', async (req, res) => {
  try {
    const url = `${config.TMDB_BASE_URL}/tv/${req.params.tmdbId}/season/${req.params.season_number}?language=he-IL`;
    const response = await fetch(url, { headers: { 'Authorization': `Bearer ${config.TMDB_API_TOKEN}` } });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Season lookup failed' });
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
  const { imdbId, type, title, poster, year, season, episode } = req.body;

  if (!imdbId) return res.status(400).json({ error: 'Missing imdbId' });
  
  const isSeries = type === 'tv' || type === 'series';
  const contentId = isSeries && season && episode ? `${imdbId}:${season}:${episode}` : imdbId;

  // If already generating, don't start again
  if (progressStore[contentId] && progressStore[contentId].status !== 'error' && progressStore[contentId].status !== 'done') {
    return res.json({ status: 'started' });
  }

  // Check cache FIRST (v3: memory + disk fallback)
  const cachedPath = cache.getCached(contentId, 'heb');
  if (cachedPath) {
    console.log(`[Stremio] WebUI Generate requested but already cached: ${contentId}`);
    return res.json({ status: 'exists', filename: cachedPath });
  }

  // Start generation in background
  activeJobs.add(contentId);
  progressStore[contentId] = { status: 'downloading', message: 'מוריד כתוביות מקוריות...', batch: 0, totalBatches: 0, logs: [] };
  res.json({ status: 'started' });

  // Background work
  (async () => {
    try {
      // Step 1: Download English subtitles
      const englishSrt = await getEnglishSubtitles(imdbId.replace('tt', ''), type || 'movie', season, episode);
      if (!englishSrt) {
        progressStore[contentId] = { status: 'error', message: 'לא נמצאו כתוביות אנגליות לסרט זה' };
        activeJobs.delete(contentId);
        return;
      }

      const validation = srtParser.validate(englishSrt);
      if (!validation.valid) {
        progressStore[contentId] = { status: 'error', message: 'קובץ כתוביות שגוי' };
        activeJobs.delete(contentId);
        return;
      }

      cache.setOriginalCached(contentId, englishSrt);
      
      // Step 2: Parse
      const blocks = srtParser.parse(englishSrt);
      const texts = srtParser.extractTexts(blocks);

      // Step 3: Translate with progress callback
      const onProgress = (update) => {
        progressStore[contentId].status = update.status || progressStore[contentId].status;
        progressStore[contentId].batch = update.batch;
        progressStore[contentId].totalBatches = update.totalBatches;
        progressStore[contentId].message = update.message;
        if (update.log) {
          progressStore[contentId].logs = progressStore[contentId].logs || [];
          progressStore[contentId].logs.push(update.log);
        }
      };
      const translatedTexts = await translateAllTexts(texts, 'heb', onProgress);

      // Step 4: Rebuild SRT
      const translatedBlocks = srtParser.replaceTexts(blocks, translatedTexts);
      const translatedSrt = srtParser.build(translatedBlocks);
      const filename = cache.setCached(contentId, 'heb', translatedSrt, contentId);

      // Step 5: Update library
      const library = loadLibrary();
      const displayTitle = isSeries ? `${title || imdbId} (S${season}E${episode})` : title || imdbId;
      const entry = { imdbId: contentId, title: displayTitle, poster: poster || null, year: year || '', createdAt: new Date().toISOString(), filename };
      const idx = library.findIndex(e => e.imdbId === contentId);
      if (idx >= 0) library[idx] = entry; else library.unshift(entry);
      saveLibrary(library);

      progressStore[contentId] = { status: 'done', batch: 0, totalBatches: 0, message: 'הכתוביות מוכנות! 🎉', filename, logs: progressStore[contentId].logs };
      console.log(`[Generate] ✅ ${displayTitle} — subtitles ready`);
    } catch (err) {
      console.error(`[Generate] ❌ ${contentId}:`, err.message);
      progressStore[contentId] = { status: 'error', message: `שגיאה: ${err.message}`, logs: progressStore[contentId].logs };
    } finally {
      activeJobs.delete(contentId);
    }
  })();
});

// ─── API: Progress SSE stream ───────────────────────────
app.get('/api/progress/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendData = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const progress = progressStore[imdbId] || { status: 'unknown' };
    sendData(progress);
    if (progress.status === 'done' || progress.status === 'error') {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

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
