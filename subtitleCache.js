/**
 * In-memory + file-based cache for generated subtitles.
 * Prevents redundant API calls and serves subtitles as static files.
 */

const fs = require('fs');
const path = require('path');

const SUBS_DIR = path.join(__dirname, 'public', 'subs');

// Ensure subs directory exists
if (!fs.existsSync(SUBS_DIR)) {
  fs.mkdirSync(SUBS_DIR, { recursive: true });
  console.log(`[Cache] Created subtitle directory: ${SUBS_DIR}`);
}

// In-memory cache: key => { srtText, filename, createdAt }
const memoryCache = new Map();

/**
 * Generate a cache key from content identifiers
 */
function getCacheKey(id, lang) {
  return `${id}:${lang}`;
}

/**
 * Sanitize a string for use as a filename
 */
function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);
}

/**
 * Check if subtitles exist in cache  
 * @returns {string|null} Filename if cached, null otherwise
 */
function getCached(id, lang) {
  const key = getCacheKey(id, lang);
  const entry = memoryCache.get(key);
  
  if (entry) {
    const filePath = path.join(SUBS_DIR, entry.filename);
    if (fs.existsSync(filePath)) {
      console.log(`[Cache] Hit: ${key} -> ${entry.filename}`);
      return entry.filename;
    }
    // File was deleted, remove from memory cache
    memoryCache.delete(key);
  }
  
  return null;
}

/**
 * Store generated subtitles in cache
 * @returns {string} Filename of the saved subtitle file
 */
function setCached(id, lang, srtText, title) {
  const key = getCacheKey(id, lang);
  const safeName = sanitizeFilename(title || id);
  const filename = `${safeName}_${lang}_${Date.now()}.srt`;
  const filePath = path.join(SUBS_DIR, filename);

  // Write SRT file to disk
  fs.writeFileSync(filePath, srtText, 'utf-8');

  // Store in memory cache
  memoryCache.set(key, {
    srtText,
    filename,
    createdAt: Date.now(),
  });

  console.log(`[Cache] Stored: ${key} -> ${filename} (${srtText.length} bytes)`);
  return filename;
}

/**
 * Get stats about the cache
 */
function getStats() {
  return {
    entriesInMemory: memoryCache.size,
    filesOnDisk: fs.readdirSync(SUBS_DIR).length,
  };
}

module.exports = { getCached, setCached, getStats, SUBS_DIR };
