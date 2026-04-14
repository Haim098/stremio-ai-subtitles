/**
 * Subtitle Cache v3
 * ==================
 * Caches translated SRT files on disk + in memory.
 * Rebuilds memory cache from disk on startup (survives restarts).
 * Also loads library.json metadata on startup.
 */

const fs = require('fs');
const path = require('path');

const SUBS_DIR = path.join(__dirname, 'public', 'subs');

// Ensure subs directory exists
if (!fs.existsSync(SUBS_DIR)) {
  fs.mkdirSync(SUBS_DIR, { recursive: true });
}

// Cache for translated subtitles: key => { filename, createdAt }
const translatedCache = new Map();

// Cache for original English SRT content: contentId => srtText
const originalCache = new Map();

// ─── Original English SRT Cache ──────────────────────────

function getOriginalCached(contentId) {
  return originalCache.get(contentId) || null;
}

function setOriginalCached(contentId, srtText) {
  originalCache.set(contentId, srtText);
  console.log(`[Cache] Original English cached for: ${contentId} (${srtText.length} bytes)`);
}

// ─── Translated SRT Cache ────────────────────────────────

function getCacheKey(id, lang) {
  return `${id}:${lang}`;
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
}

/**
 * Check if translated subtitles exist in cache (memory + disk fallback)
 * @returns {string|null} Filename if cached, null otherwise
 */
function getCached(id, lang) {
  const key = getCacheKey(id, lang);
  const entry = translatedCache.get(key);

  // Check memory cache
  if (entry) {
    const filePath = path.join(SUBS_DIR, entry.filename);
    if (fs.existsSync(filePath)) {
      return entry.filename;
    }
    translatedCache.delete(key);
  }

  // Fallback: scan disk for matching file
  // Try common filename patterns: tt1234567_heb.srt
  const idClean = id.replace(/:/g, '_');
  const patterns = [
    `${idClean}_${lang}.srt`,
    `${id}_${lang}.srt`,
  ];

  for (const pattern of patterns) {
    const filePath = path.join(SUBS_DIR, pattern);
    if (fs.existsSync(filePath)) {
      // Restore to memory cache
      translatedCache.set(key, { filename: pattern, createdAt: Date.now() });
      console.log(`[Cache] Restored from disk: ${pattern}`);
      return pattern;
    }
  }

  // Also try broader scan - any file ending in _lang.srt that contains the safe ID
  try {
    const safeId = sanitizeFilename(id);
    const files = fs.readdirSync(SUBS_DIR).filter(f => f.endsWith(`_${lang}.srt`) && f.includes(safeId));
    if (files.length > 0) {
      translatedCache.set(key, { filename: files[0], createdAt: Date.now() });
      console.log(`[Cache] Found on disk via scan: ${files[0]}`);
      return files[0];
    }
  } catch (e) { /* ignore */ }

  return null;
}

/**
 * Store translated subtitle file
 * @returns {string} Filename of the saved subtitle file
 */
function setCached(id, lang, srtText, title) {
  const key = getCacheKey(id, lang);
  const safeName = sanitizeFilename(title || id);
  const filename = `${safeName}_${lang}.srt`;
  const filePath = path.join(SUBS_DIR, filename);

  fs.writeFileSync(filePath, srtText, 'utf-8');

  translatedCache.set(key, {
    filename,
    createdAt: Date.now(),
  });

  console.log(`[Cache] Translated ${lang} saved: ${filename} (${srtText.length} bytes)`);
  return filename;
}

/**
 * Rebuild memory cache from disk on startup
 * Scans existing .srt files and restores them to the memory map
 */
function rebuildFromDisk() {
  try {
    const files = fs.readdirSync(SUBS_DIR).filter(f => f.endsWith('.srt'));
    let restored = 0;

    for (const file of files) {
      // Parse filename: something_lang.srt
      const match = file.match(/^(.+)_(heb|eng|ara|fre|spa|ger|rus)\.srt$/);
      if (match) {
        const idPart = match[1]; // e.g. "tt1234567" or "tt1234567_1_5"
        const lang = match[2];

        // Try to extract IMDB ID + optional season/episode
        // Pattern: tt1234567_1_5 → tt1234567:1:5 (series episode)
        // Pattern: tt1234567     → tt1234567      (movie)
        const seriesMatch = idPart.match(/(tt\d+)_(\d+)_(\d+)/);
        const movieMatch = idPart.match(/(tt\d+)/);
        
        let contentId;
        if (seriesMatch) {
          // Series episode: reconstruct tt1234567:season:episode
          contentId = `${seriesMatch[1]}:${seriesMatch[2]}:${seriesMatch[3]}`;
        } else if (movieMatch) {
          // Movie: just tt1234567
          contentId = movieMatch[1];
        } else {
          continue; // skip files we can't parse
        }

        const key = getCacheKey(contentId, lang);
        if (!translatedCache.has(key)) {
          translatedCache.set(key, { filename: file, createdAt: Date.now() });
          restored++;
        }
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

module.exports = { getCached, setCached, getOriginalCached, setOriginalCached, getStats, SUBS_DIR, rebuildFromDisk };
