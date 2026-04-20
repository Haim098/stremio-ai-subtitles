/**
 * OpenSubtitles.com Provider
 * ==========================
 * Wraps the existing OpenSubtitles REST API integration behind the
 * SubtitleProvider contract. Returns up to 5 candidates (previously
 * the legacy module only returned the single top result).
 */

const fetch = require('node-fetch');
const config = require('../config');
const { SubtitleProvider } = require('./base');

const MAX_CANDIDATES = 5;

let jwtToken = null;
let tokenExpiry = 0;

async function login() {
  if (jwtToken && Date.now() < tokenExpiry) return jwtToken;

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
  tokenExpiry = Date.now() + 22 * 60 * 60 * 1000;
  console.log('[OpenSubtitles] ✅ Logged in successfully');
  return jwtToken;
}

function mapCandidate(entry) {
  const fileId = entry.attributes.files?.[0]?.file_id;
  if (!fileId) return null;
  return {
    id: String(fileId),
    release: entry.attributes.release || entry.attributes.feature_details?.movie_name || '(ללא שם release)',
    downloadCount: entry.attributes.download_count ?? null,
    uploadDate: entry.attributes.upload_date || null,
    language: 'en',
    uploader: entry.attributes.uploader?.name || null,
    hearingImpaired: !!entry.attributes.hearing_impaired,
  };
}

async function searchMovie(imdbId) {
  const numericId = imdbId.replace(/^tt/, '');
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
  const items = data.data || [];
  return items.slice(0, MAX_CANDIDATES).map(mapCandidate).filter(Boolean);
}

async function searchSeries(imdbId, season, episode) {
  const numericId = imdbId.replace(/^tt/, '');
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
  const items = data.data || [];
  return items.slice(0, MAX_CANDIDATES).map(mapCandidate).filter(Boolean);
}

async function downloadSrt(fileId) {
  const token = await login();

  console.log(`[OpenSubtitles] Downloading file_id: ${fileId}...`);
  const response = await fetch(`${config.OPENSUBTITLES_API_URL}/download`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Api-Key': config.OPENSUBTITLES_API_KEY,
      'Authorization': `Bearer ${token}`,
      'User-Agent': config.OPENSUBTITLES_USER_AGENT,
    },
    body: JSON.stringify({ file_id: Number(fileId) }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[OpenSubtitles] Download request failed ${response.status}: ${errText}`);
    throw new Error(`OpenSubtitles download failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data.link) throw new Error('No download link in response');

  const fileResponse = await fetch(data.link);
  if (!fileResponse.ok) throw new Error(`File download failed: ${fileResponse.status}`);

  const srtContent = await fileResponse.text();
  console.log(`[OpenSubtitles] ✅ Downloaded ${srtContent.length} bytes`);
  return srtContent;
}

class OpenSubtitlesProvider extends SubtitleProvider {
  get name() { return 'opensubtitles'; }
  get displayName() { return 'OpenSubtitles'; }
  get enabled() {
    return !!(config.OPENSUBTITLES_API_KEY && config.OPENSUBTITLES_USERNAME && config.OPENSUBTITLES_PASSWORD);
  }

  async search(imdbId, type, season, episode) {
    console.log(`[OpenSubtitles] Searching: imdb=${imdbId} type=${type} S=${season} E=${episode}`);
    const isSeries = (type === 'series' || type === 'tv') && season && episode;
    let results = [];
    try {
      if (isSeries) {
        results = await searchSeries(imdbId, season, episode);
      }
      if (results.length === 0) {
        results = await searchMovie(imdbId);
      }
    } catch (err) {
      console.error(`[OpenSubtitles] search error: ${err.message}`);
      return [];
    }
    return results;
  }

  async download(variantId) {
    return await downloadSrt(variantId);
  }
}

module.exports = { OpenSubtitlesProvider };
