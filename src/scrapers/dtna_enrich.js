'use strict';
/**
 * scrapers/dtna_enrich.js — DTNA (Daimler/Freightliner) Servicetracker case
 * comment thread for the repair timeline, read from the local case cache.
 *
 * No network. The thread comes from the dtnaCaseCache store (src/dtna/store.js),
 * which only a user-initiated DTNA pull fills (unit "Pull DTNA" or the bulk
 * tool, through the in-app Aura client in src/dtna/). Deep scan and other
 * background callers can read what the user already pulled, but can never open
 * a DTNA window or call the portal.
 *
 * Returns: { ok, caseUrl, source:'dtna', scrapedAt, offsiteText, statusText,
 *            estimateComments, offsiteStage, bestUrl, bestLabel, error, rawThread }
 * A cache miss returns ok:false with error 'no DTNA pull yet'.
 * Opt out with DTNA_ENRICH=0.
 */

const DTNA_CASE_RE = /https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/([A-Za-z0-9]+)/i;

function _empty(caseUrl, err) {
  return { ok: false, caseUrl: caseUrl || '', source: caseUrl ? 'dtna' : 'none',
    scrapedAt: new Date().toISOString(), offsiteText: '', statusText: '',
    estimateComments: '', offsiteStage: '', error: err || null };
}

/**
 * enrichDtna(caseUrl) -> { ok, offsiteText, ... } — the cached thread of a
 * DTNA case. Same return shape as before (and as asist_enrich.enrichVolvoAsist)
 * so deep-scan treats it the same. Never throws.
 */
async function enrichDtna(caseUrl) {
  if (process.env.DTNA_ENRICH === '0') return _empty(caseUrl, 'dtna enrich disabled');
  const m = caseUrl ? DTNA_CASE_RE.exec(caseUrl) : null;
  if (!m) return _empty(caseUrl, 'not a DTNA Servicetracker case URL');
  let entry = null;
  try { entry = require('../dtna/store').get(m[1]); } catch (_) { entry = null; }
  if (!entry) return _empty(caseUrl, 'no DTNA pull yet');
  return {
    ok: true, caseUrl, source: 'dtna', scrapedAt: entry.pulledAt,
    offsiteText: entry.offsiteText, statusText: entry.offsiteText, estimateComments: entry.offsiteText,
    offsiteStage: entry.offsiteStage || '', bestUrl: caseUrl, bestLabel: 'DTNA Case', error: null,
    rawThread: entry.thread,
  };
}

module.exports = { enrichDtna, DTNA_CASE_RE };
