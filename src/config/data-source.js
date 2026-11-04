'use strict';
/**
 * src/config/data-source.js — single source of truth for WHERE fleet data comes from.
 *
 * As of 2026-10-28 the direct AAP/Relay JSON API (src/scrapers/aap_api.js) is
 * the ONLY primary source for fleet data. The old AAP BrowserWindow scrape
 * (src/scrapers/aap.js + the startup/rescan scrape loops in src/window/index.js
 * + the scrape branch of src/sync/index.js runFullSync) is RETIRED:
 *
 *   - settings.dataSource === 'scrape' is IGNORED (legacy value, left on disk
 *     untouched — no data is deleted or rewritten).
 *   - fleet:set-data-source can no longer switch to 'scrape'.
 *   - The old scraper code stays in the repo as a DISABLED BACKUP. It can only
 *     be re-enabled for a developer emergency by launching with the environment
 *     variable FLEET_LEGACY_SCRAPE=1 (never set by the app, the UI, or any
 *     scheduler). Production/normal launches are always API-only.
 *
 * NOT covered by this switch (they have no API replacement and keep running):
 * Relay per-unit page refresh (relay:refresh-unit — vendor/offsite enrichment),
 * Uptake, QuickSight DBR, vendor portals (ASIST/DTNA/PACCAR/Decisiv),
 * Phonetool, OWA, SharePoint.
 */

function legacyScrapeEnabled() {
  return process.env.FLEET_LEGACY_SCRAPE === '1';
}

// true  → fleet data comes from the API (always, unless the dev backup is on).
function isApiMode() {
  return !legacyScrapeEnabled();
}

module.exports = { isApiMode, legacyScrapeEnabled };
