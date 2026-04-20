/**
 * Provider Registry
 * =================
 * Central point to enumerate and resolve subtitle providers. Consumers
 * should never import provider classes directly — use listProviders()
 * and getProvider(name) so new providers can be added without changes
 * in index.js / UI.
 */

const { OpenSubtitlesProvider } = require('./opensubtitles');
const { SubDLProvider } = require('./subdl');

const instances = [
  new OpenSubtitlesProvider(),
  new SubDLProvider(),
];

const byName = new Map(instances.map(p => [p.name, p]));

/**
 * List all providers with their status. Safe to expose to the UI —
 * does NOT include credentials.
 */
function listProviders() {
  return instances.map(p => ({
    name: p.name,
    displayName: p.displayName,
    enabled: p.enabled,
  }));
}

/**
 * Resolve a provider instance by its internal `name`.
 * Throws if unknown; returns even disabled providers (caller decides).
 */
function getProvider(name) {
  const provider = byName.get(name);
  if (!provider) {
    throw new Error(`Unknown subtitle provider: ${name}`);
  }
  return provider;
}

/** @returns {boolean} true if there is at least one usable provider */
function hasAnyEnabled() {
  return instances.some(p => p.enabled);
}

module.exports = { listProviders, getProvider, hasAnyEnabled };
