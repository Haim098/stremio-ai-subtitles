/**
 * Stremio AI Subtitles Add-on v3.1
 * ==================================
 * Web UI for subtitle generation + Cache-only Stremio handler.
 * v3.1: multi-provider subtitle sources (OpenSubtitles + SubDL).
 * Users pick a source, then a specific variant; each variant is
 * cached separately so multiple translations coexist per title.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');

const config = require('./config');
const { listProviders, getProvider, hasAnyEnabled } = require('./providers');
const { translateAllTexts, CancelError } = require('./gemini');
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
// Unique key per library row — one row per (content, provider).
function libraryKey(imdbId, provider) {
  return `${imdbId}::${provider || cache.DEFAULT_LEGACY_PROVIDER}`;
}

// ─── Progress tracking (per (content, provider)) ────────
const progressStore = {};
const activeJobs = new Set();
// Jobs for which the user requested cancellation. The translation loop
// polls this set between batches; when the key is present it aborts.
const cancelRequests = new Set();
function jobKey(contentId, provider) {
  return `${contentId}::${provider}`;
}

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

  // Expose every cached (lang, provider) variant we have for this content.
  const variants = cache.listVariantsForContent(args.id);
  for (const v of variants) {
    const lang = config.SUPPORTED_LANGUAGES.find(l => l.code === v.lang);
    if (!lang) continue;
    subtitles.push({
      // Include provider in the id so Stremio treats them as distinct tracks
      id: `aisub-${v.lang}-${v.provider}-${imdbId}`,
      url: `${baseUrl}/public/subs/${v.filename}`,
      lang: v.lang,
      // Some Stremio clients surface this label; ignored by others.
      name: `${lang.displayName} (${v.provider})`,
    });
  }

  if (subtitles.length > 0) {
    console.log(`[Stremio] ✅ Serving ${subtitles.length} cached variants for ${args.id}`);
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

// ─── API: List subtitle providers ───────────────────────
app.get('/api/providers', (req, res) => {
  res.json({ providers: listProviders() });
});

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

// ─── API: List subtitle candidates from a provider ─────
app.get('/api/subtitles/candidates', async (req, res) => {
  const { imdbId, type, season, episode, provider: providerName } = req.query;
  if (!imdbId) return res.status(400).json({ error: 'Missing imdbId' });
  if (!providerName) return res.status(400).json({ error: 'Missing provider' });

  let provider;
  try {
    provider = getProvider(providerName);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!provider.enabled) {
    return res.status(400).json({ error: `Provider ${provider.displayName} is not configured (missing API key)` });
  }

  try {
    const candidates = await provider.search(
      imdbId,
      type || 'movie',
      season || null,
      episode || null
    );
    // Attach provider tag for UI convenience
    const enriched = candidates.map(c => ({ ...c, provider: provider.name }));
    res.json({ provider: provider.name, candidates: enriched });
  } catch (err) {
    console.error(`[/candidates] error for ${providerName}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Check subtitle status ─────────────────────────
app.get('/api/status/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  const providerName = req.query.provider || cache.DEFAULT_LEGACY_PROVIDER;
  const filename = cache.getCached(imdbId, 'heb', providerName);
  const pkey = jobKey(imdbId, providerName);
  const progress = progressStore[pkey];

  res.json({
    exists: !!filename,
    filename: filename || null,
    url: filename ? `${getBaseUrl()}/public/subs/${filename}` : null,
    generating: activeJobs.has(pkey),
    progress: progress || null,
  });
});

// ─── API: Start subtitle generation ─────────────────────
app.post('/api/generate', async (req, res) => {
  const { imdbId, type, title, poster, year, season, episode, force, provider: providerName, variantId, variantRelease } = req.body;

  if (!imdbId) return res.status(400).json({ error: 'Missing imdbId' });
  if (!providerName) return res.status(400).json({ error: 'Missing provider' });
  if (!variantId) return res.status(400).json({ error: 'Missing variantId' });

  let provider;
  try {
    provider = getProvider(providerName);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (!provider.enabled) {
    return res.status(400).json({ error: `Provider ${provider.displayName} is not configured` });
  }

  const isSeries = type === 'tv' || type === 'series';
  const contentId = isSeries && season && episode ? `${imdbId}:${season}:${episode}` : imdbId;
  const pkey = jobKey(contentId, provider.name);

  // If already generating, don't start again. 'cancelled' and 'error' and
  // 'done' are all terminal states that allow a fresh attempt.
  const existingStatus = progressStore[pkey]?.status;
  if (existingStatus && !['error', 'done', 'cancelled'].includes(existingStatus)) {
    return res.json({ status: 'started' });
  }

  // Check cache FIRST — per (content, provider)
  const cachedPath = cache.getCached(contentId, 'heb', provider.name);
  if (cachedPath && !force) {
    console.log(`[Gen] Already cached for ${contentId} via ${provider.name}: ${cachedPath}`);
    return res.json({ status: 'exists', filename: cachedPath, provider: provider.name });
  }

  // Start generation in background
  activeJobs.add(pkey);
  cancelRequests.delete(pkey); // clear any stale cancel flag from a previous run
  progressStore[pkey] = { status: 'downloading', message: 'מוריד כתוביות מקוריות...', batch: 0, totalBatches: 0, provider: provider.name, logs: [] };
  res.json({ status: 'started', provider: provider.name });

  // Background work
  (async () => {
    const checkCancelled = () => cancelRequests.has(pkey);
    const existingLogs = () => progressStore[pkey]?.logs || [];
    try {
      // Step 1: Download English subtitles from the chosen provider + variant
      const englishSrt = await provider.download(variantId);
      if (checkCancelled()) throw new CancelError();
      if (!englishSrt) {
        progressStore[pkey] = { status: 'error', message: 'לא התקבל תוכן כתוביות מהמקור', provider: provider.name };
        return;
      }

      const validation = srtParser.validate(englishSrt);
      if (!validation.valid) {
        progressStore[pkey] = { status: 'error', message: `קובץ כתוביות לא תקין: ${validation.error || 'unknown'}`, provider: provider.name };
        return;
      }

      cache.setOriginalCached(contentId, englishSrt, provider.name);

      // Step 2: Parse
      const blocks = srtParser.parse(englishSrt);
      const texts = srtParser.extractTexts(blocks);
      if (checkCancelled()) throw new CancelError();

      // Step 3: Translate with progress callback + cancellation checkpoint
      const onProgress = (update) => {
        if (!progressStore[pkey]) return;
        progressStore[pkey].status = update.status || progressStore[pkey].status;
        progressStore[pkey].batch = update.batch;
        progressStore[pkey].totalBatches = update.totalBatches;
        progressStore[pkey].message = update.message;
        if (update.log) {
          progressStore[pkey].logs = progressStore[pkey].logs || [];
          progressStore[pkey].logs.push(update.log);
        }
      };
      const translatedTexts = await translateAllTexts(texts, 'heb', onProgress, checkCancelled);

      // Step 4: Rebuild SRT
      const translatedBlocks = srtParser.replaceTexts(blocks, translatedTexts);
      const translatedSrt = srtParser.build(translatedBlocks);
      const filename = cache.setCached(contentId, 'heb', translatedSrt, contentId, provider.name);

      // Step 5: Update library (one row per (content, provider))
      const library = loadLibrary();
      const displayTitle = isSeries ? `${title || imdbId} (S${season}E${episode})` : (title || imdbId);
      const entry = {
        imdbId: contentId,
        libraryKey: libraryKey(contentId, provider.name),
        title: displayTitle,
        poster: poster || null,
        year: year || '',
        createdAt: new Date().toISOString(),
        filename,
        provider: provider.name,
        providerDisplayName: provider.displayName,
        variantRelease: variantRelease || null,
      };
      // Dedupe by libraryKey, falling back to the old (imdbId-only) shape
      // for rows created before v3.1.
      const idx = library.findIndex(e =>
        e.libraryKey ? e.libraryKey === entry.libraryKey
                     : (e.imdbId === contentId && (!e.provider || e.provider === provider.name))
      );
      if (idx >= 0) library[idx] = entry; else library.unshift(entry);
      saveLibrary(library);

      progressStore[pkey] = { status: 'done', batch: 0, totalBatches: 0, message: 'הכתוביות מוכנות! 🎉', filename, provider: provider.name, logs: existingLogs() };
      console.log(`[Generate] ✅ ${displayTitle} via ${provider.name} — subtitles ready`);
    } catch (err) {
      if (err && err.cancelled) {
        console.log(`[Generate] 🛑 Cancelled by user: ${pkey}`);
        progressStore[pkey] = { status: 'cancelled', message: 'התרגום בוטל על ידי המשתמש', provider: provider.name, logs: existingLogs() };
      } else {
        console.error(`[Generate] ❌ ${pkey}:`, err.message);
        progressStore[pkey] = { status: 'error', message: `שגיאה: ${err.message}`, provider: provider.name, logs: existingLogs() };
      }
    } finally {
      activeJobs.delete(pkey);
      cancelRequests.delete(pkey);
    }
  })();
});

// ─── API: Cancel an in-flight generation ───────────────
app.post('/api/cancel', (req, res) => {
  const { imdbId, provider: providerName, season, episode } = req.body || {};
  if (!imdbId || !providerName) {
    return res.status(400).json({ error: 'Missing imdbId or provider' });
  }
  const isSeries = !!(season && episode);
  const contentId = isSeries ? `${imdbId}:${season}:${episode}` : imdbId;
  const pkey = jobKey(contentId, providerName);

  if (!activeJobs.has(pkey)) {
    // Nothing to cancel — either never started or already finished.
    return res.json({ ok: false, reason: 'no_active_job' });
  }

  cancelRequests.add(pkey);
  console.log(`[Cancel] Requested for ${pkey}`);
  // Update message immediately so the SSE listener shows "cancelling..."
  if (progressStore[pkey]) {
    progressStore[pkey].message = 'מבטל...';
    progressStore[pkey].cancelling = true;
  }
  res.json({ ok: true });
});

// ─── API: Progress SSE stream ───────────────────────────
app.get('/api/progress/:imdbId', (req, res) => {
  const { imdbId } = req.params;
  const providerName = req.query.provider || cache.DEFAULT_LEGACY_PROVIDER;
  const pkey = jobKey(imdbId, providerName);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendData = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const interval = setInterval(() => {
    const progress = progressStore[pkey] || { status: 'unknown' };
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
  const aiEngine = config.GITHUB_TOKEN ? `GitHub Models (${config.GITHUB_MODELS_QUEUE.join(', ')})` : `Gemini (${config.GEMINI_MODEL})`;
  const providers = listProviders().map(p => `${p.displayName}${p.enabled ? '' : ' (disabled)'}`).join(', ');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  🎬 Stremio AI Translated Subtitles v3.1');
  console.log(`  📡 Translation: ${aiEngine}`);
  console.log(`  📥 Sources: ${providers}`);
  console.log('  🌐 Web UI: Enabled');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`\n🚀 Server ready at http://localhost:${config.PORT}`);
  console.log(`   Web UI:    http://localhost:${config.PORT}/`);
  console.log(`   Manifest:  http://localhost:${config.PORT}/manifest.json\n`);
  if (!hasAnyEnabled()) {
    console.warn('⚠️  No subtitle providers are enabled! Check your .env (OPENSUBTITLES_* / SUBDL_API_KEY).');
  }
});
