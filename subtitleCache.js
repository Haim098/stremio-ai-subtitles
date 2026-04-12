/**
 * Subtitle Cache v2
 * ==================
 * Caches both original English SRT content (in memory)
 * and translated SRT files (memory + disk).
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
 * Check if translated subtitles exist in cache
 * @returns {string|null} Filename if cached, null otherwise
 */
function getCached(id, lang) {
  const key = getCacheKey(id, lang);
  const entry = translatedCache.get(key);

  if (entry) {
    const filePath = path.join(SUBS_DIR, entry.filename);
    if (fs.existsSync(filePath)) {
      return entry.filename;
    }
    translatedCache.delete(key);
  }

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

module.exports = { getCached, setCached, getOriginalCached, setOriginalCached, getStats, SUBS_DIR };
