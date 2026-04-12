/**
 * OpenSubtitles.com API Integration
 * ===================================
 * Searches and downloads real subtitles from OpenSubtitles.com REST API.
 * Handles authentication, search by IMDB ID, and file download.
 */

const fetch = require('node-fetch');
const config = require('./config');

let jwtToken = null;
let tokenExpiry = 0;

/**
 * Login to OpenSubtitles API and obtain JWT Bearer token
 */
async function login() {
  // Reuse valid token
  if (jwtToken && Date.now() < tokenExpiry) {
    return jwtToken;
  }

  console.log('[OpenSubtitles] Logging in...');

  const response = await fetch(`${config.OPENSUBTITLES_API_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': config.OPENSUBTITLES_API_KEY,
      'User-Agent': config.OPENSUBTITLES_USER_AGENT,
    },
    body: JSON.stringify({
      username: config.OPENSUBTITLES_USERNAME,
      password: config.OPENSUBTITLES_PASSWORD,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[OpenSubtitles] Login failed ${response.status}: ${errText}`);
    throw new Error(`OpenSubtitles login failed: ${response.status}`);
  }

  const data = await response.json();
  jwtToken = data.token;
  // Token typically valid for 24h, refresh after 22h
  tokenExpiry = Date.now() + 22 * 60 * 60 * 1000;

  console.log('[OpenSubtitles] ✅ Logged in successfully');
  return jwtToken;
}

/**
 * Search for English subtitles by IMDB ID
 * @param {string} imdbId - IMDB ID (e.g., 'tt0133093' or '0133093')
 * @returns {Promise<Object|null>} Best matching subtitle result, or null
 */
async function searchSubtitles(imdbId) {
  // Clean IMDB ID - remove 'tt' prefix if present, API expects numeric
  const numericId = imdbId.replace(/^tt/, '');

  console.log(`[OpenSubtitles] Searching English subs for IMDB: ${numericId}...`);

  const url = new URL(`${config.OPENSUBTITLES_API_URL}/subtitles`);
  url.searchParams.set('imdb_id', numericId);
  url.searchParams.set('languages', 'en');
  url.searchParams.set('order_by', 'download_count');
  url.searchParams.set('order_direction', 'desc');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Api-Key': config.OPENSUBTITLES_API_KEY,
      'User-Agent': config.OPENSUBTITLES_USER_AGENT,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[OpenSubtitles] Search failed ${response.status}: ${errText}`);
    throw new Error(`OpenSubtitles search failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.data || data.data.length === 0) {
    console.log(`[OpenSubtitles] ❌ No English subtitles found for ${imdbId}`);
    return null;
  }

  // Pick the best result (first = highest download count)
  const best = data.data[0];
  const fileId = best.attributes.files[0]?.file_id;
  
  if (!fileId) {
    console.log('[OpenSubtitles] ❌ No file_id in best result');
    return null;
  }

  console.log(`[OpenSubtitles] ✅ Found: "${best.attributes.release}" (downloads: ${best.attributes.download_count}, file_id: ${fileId})`);

  return {
    fileId,
    release: best.attributes.release,
    downloadCount: best.attributes.download_count,
    uploadDate: best.attributes.upload_date,
  };
}

/**
 * Search for subtitles by IMDB ID for a specific season/episode
 * @param {string} imdbId - IMDB ID
 * @param {string|number} season - Season number
 * @param {string|number} episode - Episode number
 * @returns {Promise<Object|null>} Best matching subtitle result
 */
async function searchSeriesSubtitles(imdbId, season, episode) {
  const numericId = imdbId.replace(/^tt/, '');

  console.log(`[OpenSubtitles] Searching subs for IMDB: ${numericId} S${season}E${episode}...`);

  const url = new URL(`${config.OPENSUBTITLES_API_URL}/subtitles`);
  url.searchParams.set('parent_imdb_id', numericId);
  url.searchParams.set('season_number', String(season));
  url.searchParams.set('episode_number', String(episode));
  url.searchParams.set('languages', 'en');
  url.searchParams.set('order_by', 'download_count');
  url.searchParams.set('order_direction', 'desc');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Api-Key': config.OPENSUBTITLES_API_KEY,
      'User-Agent': config.OPENSUBTITLES_USER_AGENT,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[OpenSubtitles] Series search failed ${response.status}: ${errText}`);
    throw new Error(`OpenSubtitles search failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.data || data.data.length === 0) {
    console.log(`[OpenSubtitles] ❌ No subs found for ${imdbId} S${season}E${episode}`);
    return null;
  }

  const best = data.data[0];
  const fileId = best.attributes.files[0]?.file_id;

  if (!fileId) return null;

  console.log(`[OpenSubtitles] ✅ Found: "${best.attributes.release}" (file_id: ${fileId})`);

  return {
    fileId,
    release: best.attributes.release,
    downloadCount: best.attributes.download_count,
  };
}

/**
 * Download a subtitle file by file_id
 * @param {number} fileId - OpenSubtitles file ID
 * @returns {Promise<string>} SRT file content as text
 */
async function downloadSubtitle(fileId) {
  const token = await login();

  console.log(`[OpenSubtitles] Downloading file_id: ${fileId}...`);

  // Step 1: Request download link
  const response = await fetch(`${config.OPENSUBTITLES_API_URL}/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': config.OPENSUBTITLES_API_KEY,
      'Authorization': `Bearer ${token}`,
      'User-Agent': config.OPENSUBTITLES_USER_AGENT,
    },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[OpenSubtitles] Download request failed ${response.status}: ${errText}`);
    throw new Error(`OpenSubtitles download failed: ${response.status}`);
  }

  const data = await response.json();
  const downloadUrl = data.link;

  if (!downloadUrl) {
    throw new Error('No download link in response');
  }

  console.log(`[OpenSubtitles] Got download link, fetching file...`);

  // Step 2: Download the actual file
  const fileResponse = await fetch(downloadUrl);
  if (!fileResponse.ok) {
    throw new Error(`File download failed: ${fileResponse.status}`);
  }

  const srtContent = await fileResponse.text();
  console.log(`[OpenSubtitles] ✅ Downloaded ${srtContent.length} bytes`);

  return srtContent;
}

/**
 * Full pipeline: search and download English subtitles for content
 * @param {string} imdbId - IMDB ID
 * @param {string} type - 'movie' or 'series'
 * @param {string|null} season
 * @param {string|null} episode
 * @returns {Promise<string|null>} SRT content or null if not found
 */
async function getEnglishSubtitles(imdbId, type, season, episode) {
  try {
    let result;

    if (type === 'series' && season && episode) {
      result = await searchSeriesSubtitles(imdbId, season, episode);
    }
    
    if (!result) {
      result = await searchSubtitles(imdbId);
    }

    if (!result) return null;

    const srtContent = await downloadSubtitle(result.fileId);
    return srtContent;

  } catch (error) {
    console.error(`[OpenSubtitles] Pipeline error: ${error.message}`);
    return null;
  }
}

module.exports = { searchSubtitles, searchSeriesSubtitles, downloadSubtitle, getEnglishSubtitles, login };
