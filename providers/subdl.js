/**
 * SubDL Provider
 * ==============
 * Integration for https://subdl.com via their REST API.
 *
 * API docs: https://subdl.com/api-doc
 *
 * Search endpoint:
 *   GET https://api.subdl.com/api/v1/subtitles
 *     ?api_key=<key>&imdb_id=<id>&languages=EN&type=movie|tv
 *     &season_number=<n>&episode_number=<n>&subs_per_page=10
 *
 * Response:
 *   { status, results:[...], subtitles:[ {release_name, lang, author,
 *     url, season, episode, download_link} ] }
 *
 * Downloads: `download_link` is a full URL pointing to a ZIP that
 * contains the .srt file (sometimes multiple). We fetch the zip,
 * extract the first .srt, and return its text content.
 */

const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const config = require('../config');
const { SubtitleProvider } = require('./base');

const MAX_CANDIDATES = 5;

async function searchSubdl({ imdbId, type, season, episode }) {
  if (!config.SUBDL_API_KEY) {
    throw new Error('SUBDL_API_KEY is not configured');
  }

  const url = new URL(`${config.SUBDL_API_URL}/subtitles`);
  url.searchParams.set('api_key', config.SUBDL_API_KEY);
  // SubDL expects imdb ids with the "tt" prefix
  url.searchParams.set('imdb_id', imdbId.startsWith('tt') ? imdbId : `tt${imdbId}`);
  url.searchParams.set('languages', 'EN');
  url.searchParams.set('type', type === 'series' || type === 'tv' ? 'tv' : 'movie');
  if (season) url.searchParams.set('season_number', String(season));
  if (episode) url.searchParams.set('episode_number', String(episode));
  url.searchParams.set('subs_per_page', '10');

  // Never log the full URL (contains api_key). Log a redacted version.
  const safeUrl = url.toString().replace(config.SUBDL_API_KEY, '***');
  console.log(`[SubDL] GET ${safeUrl}`);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error(`[SubDL] Search failed ${response.status}: ${errText}`);
    throw new Error(`SubDL search failed: ${response.status}`);
  }

  const data = await response.json();
  if (!data.status) {
    console.warn(`[SubDL] Non-success status from API: ${data.error || JSON.stringify(data).slice(0, 200)}`);
    return [];
  }

  return Array.isArray(data.subtitles) ? data.subtitles : [];
}

/**
 * Filter subtitles to those matching the desired season/episode for series.
 * SubDL sometimes returns season pack subtitles; we keep entries where
 * season/episode match, or where both fields are null (e.g. full-season packs
 * that the user may still want to try).
 */
function filterSeriesMatches(subs, season, episode) {
  if (!season || !episode) return subs;
  const seasonNum = Number(season);
  const episodeNum = Number(episode);
  const exact = subs.filter(s =>
    Number(s.season) === seasonNum && Number(s.episode) === episodeNum
  );
  if (exact.length > 0) return exact;
  // Fallback: also allow "season pack" entries (episode null) that the user may want
  const seasonPacks = subs.filter(s =>
    Number(s.season) === seasonNum && (s.episode == null || s.episode === 0)
  );
  if (seasonPacks.length > 0) return seasonPacks;
  return subs; // last resort — let user see them
}

function mapCandidate(entry) {
  // `download_link` is absolute; `url` is relative. Prefer download_link.
  const link = entry.download_link || (entry.url ? `https://dl.subdl.com${entry.url}` : null);
  if (!link) return null;
  return {
    id: link,               // entire URL is the variantId
    release: entry.release_name || entry.name || '(ללא שם release)',
    downloadCount: null,    // SubDL does not expose this
    uploadDate: null,       // Not provided by API
    language: (entry.lang || 'en').toString().toLowerCase().startsWith('en') ? 'en' : entry.lang,
    uploader: entry.author || null,
    hearingImpaired: entry.hi === true || entry.hi === 1,
    _season: entry.season ?? null,
    _episode: entry.episode ?? null,
  };
}

async function downloadSrtFromZip(zipUrl) {
  console.log(`[SubDL] Downloading zip: ${zipUrl}`);
  const response = await fetch(zipUrl);
  if (!response.ok) throw new Error(`SubDL download failed: ${response.status}`);

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`[SubDL] Got ${buffer.length} bytes zip, extracting...`);

  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch (err) {
    throw new Error(`Failed to parse ZIP from SubDL: ${err.message}`);
  }

  const entries = zip.getEntries();
  const srtEntry = entries.find(e => !e.isDirectory && /\.srt$/i.test(e.entryName));
  if (!srtEntry) {
    const names = entries.map(e => e.entryName).join(', ');
    throw new Error(`No .srt file inside SubDL ZIP. Contents: ${names}`);
  }

  // Try utf-8 first; if the file had a BOM or is in another encoding, it
  // will still decode as a string — the translator handles odd chars.
  const srtText = srtEntry.getData().toString('utf-8');
  console.log(`[SubDL] ✅ Extracted ${srtEntry.entryName} (${srtText.length} chars)`);
  return srtText;
}

class SubDLProvider extends SubtitleProvider {
  get name() { return 'subdl'; }
  get displayName() { return 'SubDL'; }
  get enabled() { return !!config.SUBDL_API_KEY; }

  async search(imdbId, type, season, episode) {
    console.log(`[SubDL] Searching: imdb=${imdbId} type=${type} S=${season} E=${episode}`);
    let subs;
    try {
      subs = await searchSubdl({ imdbId, type, season, episode });
    } catch (err) {
      console.error(`[SubDL] search error: ${err.message}`);
      return [];
    }

    const isSeries = (type === 'series' || type === 'tv') && season && episode;
    const filtered = isSeries ? filterSeriesMatches(subs, season, episode) : subs;

    return filtered.slice(0, MAX_CANDIDATES).map(mapCandidate).filter(Boolean);
  }

  async download(variantId) {
    return await downloadSrtFromZip(variantId);
  }
}

module.exports = { SubDLProvider };
