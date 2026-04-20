/**
 * Subtitle Cache v4
 * ==================
 * Caches translated SRT files on disk + in memory.
 * Cache keys now include the subtitle provider, so the same movie may have
 * multiple translations side-by-side (one per source the user tried).
 *
 * Filename layout:
 *   <safeTitle>_<lang>_<provider>.srt     (v4, current)
 *   <safeTitle>_<lang>.srt                (v3, legacy — treated as opensubtitles)
 */

const fs = require('fs');
const path = require('path');

const SUBS_DIR = path.join(__dirname, 'public', 'subs');
const DEFAULT_LEGACY_PROVIDER = 'opensubtitles';
const KNOWN_PROVIDERS = ['opensubtitles', 'subdl'];

// Ensure subs directory exists
if (!fs.existsSync(SUBS_DIR)) {
  fs.mkdirSync(SUBS_DIR, { recursive: true });
}

// Cache for translated subtitles: key => { filename, createdAt }
const translatedCache = new Map();

// Cache for original English SRT content: key => srtText
const originalCache = new Map();

// ─── Original English SRT Cache ──────────────────────────

function originalKey(contentId, provider) {
  return provider ? `${contentId}:${provider}` : contentId;
}

function getOriginalCached(contentId, provider) {
  // New signature includes provider. Accept calls without it (falls back
  // to the first matching key to keep any transitional callers working).
  if (provider) return originalCache.get(originalKey(contentId, provider)) || null;
  for (const p of KNOWN_PROVIDERS) {
    const v = originalCache.get(originalKey(contentId, p));
    if (v) return v;
  }
  return originalCache.get(contentId) || null;
}

function setOriginalCached(contentId, srtText, provider) {
  const key = originalKey(contentId, provider);
  originalCache.set(key, srtText);
  console.log(`[Cache] Original English cached for: ${key} (${srtText.length} bytes)`);
}

// ─── Translated SRT Cache ────────────────────────────────

function getCacheKey(id, lang, provider) {
  return `${id}:${lang}:${provider || DEFAULT_LEGACY_PROVIDER}`;
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
}

/**
 * Check if translated subtitles exist in cache (memory + disk fallback)
 * @param {string} id - content id (e.g. tt1234567 or tt1234567:1:5)
 * @param {string} lang
 * @param {string} provider - e.g. 'opensubtitles' | 'subdl'
 * @returns {string|null} Filename if cached, null otherwise
 */
function getCached(id, lang, provider) {
  const prov = provider || DEFAULT_LEGACY_PROVIDER;
  const key = getCacheKey(id, lang, prov);
  const entry = translatedCache.get(key);

  if (entry) {
    const filePath = path.join(SUBS_DIR, entry.filename);
    if (fs.existsSync(filePath)) return entry.filename;
    translatedCache.delete(key);
  }

  // Disk fallback — try provider-qualified names first, then legacy names.
  const idClean = id.replace(/:/g, '_');
  const patterns = [
    `${idClean}_${lang}_${prov}.srt`,
    `${id}_${lang}_${prov}.srt`,
  ];
  if (prov === DEFAULT_LEGACY_PROVIDER) {
    patterns.push(`${idClean}_${lang}.srt`, `${id}_${lang}.srt`);
  }

  for (const pattern of patterns) {
    const filePath = path.join(SUBS_DIR, pattern);
    if (fs.existsSync(filePath)) {
      translatedCache.set(key, { filename: pattern, createdAt: Date.now() });
      console.log(`[Cache] Restored from disk: ${pattern}`);
      return pattern;
    }
  }

  // Broader scan — any matching file by safeId, provider-qualified.
  try {
    const safeId = sanitizeFilename(id);
    const all = fs.readdirSync(SUBS_DIR);
    const want = `_${lang}_${prov}.srt`;
    let candidates = all.filter(f => f.endsWith(want) && f.includes(safeId));
    if (candidates.length === 0 && prov === DEFAULT_LEGACY_PROVIDER) {
      // Legacy scan — no provider suffix
      candidates = all.filter(f => f.endsWith(`_${lang}.srt`) && f.includes(safeId) && !containsKnownProviderSuffix(f, lang));
    }
    if (candidates.length > 0) {
      translatedCache.set(key, { filename: candidates[0], createdAt: Date.now() });
      console.log(`[Cache] Found on disk via scan: ${candidates[0]}`);
      return candidates[0];
    }
  } catch (e) { /* ignore */ }

  return null;
}

function containsKnownProviderSuffix(filename, lang) {
  return KNOWN_PROVIDERS.some(p => filename.endsWith(`_${lang}_${p}.srt`));
}

/**
 * Store translated subtitle file
 * @param {string} id
 * @param {string} lang
 * @param {string} srtText
 * @param {string} title
 * @param {string} provider - 'opensubtitles' | 'subdl'
 * @returns {string} saved filename
 */
function setCached(id, lang, srtText, title, provider) {
  const prov = provider || DEFAULT_LEGACY_PROVIDER;
  const key = getCacheKey(id, lang, prov);
  const safeName = sanitizeFilename(title || id);
  const filename = `${safeName}_${lang}_${prov}.srt`;
  const filePath = path.join(SUBS_DIR, filename);

  fs.writeFileSync(filePath, srtText, 'utf-8');
  translatedCache.set(key, { filename, createdAt: Date.now() });

  console.log(`[Cache] Translated ${lang} (${prov}) saved: ${filename} (${srtText.length} bytes)`);
  return filename;
}

/**
 * List every cached (lang, provider) variant for a given contentId.
 * Used by the Stremio handler to expose all available variants.
 * @returns {Array<{lang: string, provider: string, filename: string}>}
 */
function listVariantsForContent(id) {
  const variants = [];
  for (const [key, entry] of translatedCache.entries()) {
    // key format: <id>:<lang>:<provider>
    const lastColonProv = key.lastIndexOf(':');
    if (lastColonProv < 0) continue;
    const provider = key.slice(lastColonProv + 1);
    const rest = key.slice(0, lastColonProv);
    const lastColonLang = rest.lastIndexOf(':');
    if (lastColonLang < 0) continue;
    const lang = rest.slice(lastColonLang + 1);
    const cid = rest.slice(0, lastColonLang);
    if (cid !== id) continue;

    const filePath = path.join(SUBS_DIR, entry.filename);
    if (fs.existsSync(filePath)) {
      variants.push({ lang, provider, filename: entry.filename });
    }
  }
  return variants;
}

/**
 * Rebuild memory cache from disk on startup. Understands both the new
 * "_<provider>.srt" suffix and the legacy "_<lang>.srt" format (mapped to
 * the opensubtitles provider so pre-upgrade libraries still resolve).
 */
function rebuildFromDisk() {
  try {
    const files = fs.readdirSync(SUBS_DIR).filter(f => f.endsWith('.srt'));
    let restored = 0;

    const langRe = '(heb|eng|ara|fre|spa|ger|rus)';
    const provRe = KNOWN_PROVIDERS.join('|');
    const newFormat = new RegExp(`^(.+)_${langRe}_(${provRe})\\.srt$`);
    const oldFormat = new RegExp(`^(.+)_${langRe}\\.srt$`);

    for (const file of files) {
      let idPart, lang, provider;

      const m1 = file.match(newFormat);
      if (m1) {
        idPart = m1[1];
        lang = m1[2];
        provider = m1[3];
      } else {
        const m2 = file.match(oldFormat);
        if (!m2) continue;
        idPart = m2[1];
        lang = m2[2];
        provider = DEFAULT_LEGACY_PROVIDER;
      }

      const seriesMatch = idPart.match(/(tt\d+)_(\d+)_(\d+)/);
      const movieMatch = idPart.match(/(tt\d+)/);

      let contentId;
      if (seriesMatch) {
        contentId = `${seriesMatch[1]}:${seriesMatch[2]}:${seriesMatch[3]}`;
      } else if (movieMatch) {
        contentId = movieMatch[1];
      } else {
        continue;
      }

      const key = getCacheKey(contentId, lang, provider);
      if (!translatedCache.has(key)) {
        translatedCache.set(key, { filename: file, createdAt: Date.now() });
        restored++;
      }
    }

    if (restored > 0) {
      console.log(`[Cache] ♻️ Restored ${restored} entries from disk`);
    }
  } catch (e) {
    console.error('[Cache] Rebuild error:', e.message);
  }
}

/**
 * Get cache statistics
 */
function getStats() {
  let filesOnDisk = 0;
  try {
    filesOnDisk = fs.readdirSync(SUBS_DIR).filter(f => f.endsWith('.srt')).length;
  } catch (e) { /* ignore */ }

  return {
    entriesInMemory: translatedCache.size,
    originalsInMemory: originalCache.size,
    filesOnDisk,
  };
}

// Rebuild cache from disk on module load
rebuildFromDisk();

module.exports = {
  getCached, setCached,
  getOriginalCached, setOriginalCached,
  listVariantsForContent,
  getStats, rebuildFromDisk,
  SUBS_DIR,
  DEFAULT_LEGACY_PROVIDER,
};
