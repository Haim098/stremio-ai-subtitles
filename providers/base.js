/**
 * Subtitle Provider — Base Contract
 * ==================================
 * All subtitle providers implement this contract. The consumer (index.js)
 * does not know which site the subtitles came from — only this interface.
 *
 * Variant shape returned from search():
 *   {
 *     id:            string   — opaque provider-specific identifier (used by download())
 *     release:       string   — release name (e.g. "The.Matrix.1999.BluRay.x264-SPARKS")
 *     downloadCount: number?  — OpenSubtitles has this; SubDL does not
 *     uploadDate:    string?  — ISO-ish date when available
 *     language:      string   — always 'en' here for now
 *     uploader:      string?  — author/user who uploaded
 *     provider:      string   — echo of this.name (set automatically)
 *   }
 */

class SubtitleProvider {
  /** @returns {string} internal id (e.g. 'opensubtitles', 'subdl') */
  get name() { throw new Error('name must be overridden'); }

  /** @returns {string} human-readable name (e.g. 'OpenSubtitles') */
  get displayName() { throw new Error('displayName must be overridden'); }

  /**
   * @returns {boolean} whether this provider is usable right now
   * (e.g., API key present in config)
   */
  get enabled() { return true; }

  /**
   * Search for English subtitle candidates.
   * @param {string} imdbId — e.g. 'tt0133093' or '0133093'
   * @param {string} type — 'movie' or 'series'
   * @param {string|number|null} season
   * @param {string|number|null} episode
   * @returns {Promise<Array<object>>} up to N candidates, best-first
   */
  async search(imdbId, type, season, episode) {
    throw new Error('search() must be overridden');
  }

  /**
   * Download the SRT content for the given variant id.
   * Must return plain SRT text (UTF-8), not ZIP, not HTML.
   * @param {string} variantId — the `id` field from a search result
   * @returns {Promise<string>} SRT content
   */
  async download(variantId) {
    throw new Error('download() must be overridden');
  }
}

module.exports = { SubtitleProvider };
