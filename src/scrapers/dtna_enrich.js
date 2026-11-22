'use strict';
/**
 * scrapers/dtna_enrich.js — DTNA (Daimler/Freightliner) Servicetracker case
 * comment thread for the repair timeline.
 *
 * The deep-scan offsite pass calls this exactly where and when it calls the
 * Decisiv live enrich (same OFFSITE_CACHE_FRESH_MS gate). The case is read
 * through src/dtna/auto.js: a live Aura read only while the user is signed in
 * to DTNA (session-gated, silent: never a sign-in window or auto-login), and a
 * cache entry younger than opts.freshMs is used with no call. Signed out, the
 * dtnaCaseCache entry (src/dtna/store.js) is returned as is.
 *
 * Returns: { ok, caseUrl, source:'dtna', scrapedAt, offsiteText, statusText,
 *            estimateComments, offsiteStage, offsiteStageDetail, offsiteStageSince,
 *            dtnaCaseNumber, bestUrl, bestLabel, error, rawThread }
 * No entry returns ok:false with error 'no DTNA pull yet' (signed in) or
 * 'DTNA signed out'. Opt out with DTNA_ENRICH=0.
 */

const DTNA_CASE_RE = /https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/([A-Za-z0-9]+)/i;

function _empty(caseUrl, err) {
  return { ok: false, caseUrl: caseUrl || '', source: caseUrl ? 'dtna' : 'none',
    scrapedAt: new Date().toISOString(), offsiteText: '', statusText: '',
    estimateComments: '', offsiteStage: '', error: err || null };
}

/**
 * enrichDtna(caseUrl, {freshMs}) -> { ok, offsiteText, ... } — the thread of a
 * DTNA case. Same return shape as asist_enrich.enrichVolvoAsist so deep-scan
 * treats it the same. Without freshMs it always tries live (like
 * enrichVolvoAsist). Never throws.
 */
async function enrichDtna(caseUrl, opts) {
  if (process.env.DTNA_ENRICH === '0') return _empty(caseUrl, 'dtna enrich disabled');
  const m = caseUrl ? DTNA_CASE_RE.exec(caseUrl) : null;
  if (!m) return _empty(caseUrl, 'not a DTNA Servicetracker case URL');
  let res = null;
  try { res = await require('../dtna/auto').pullIfStale(m[1], { freshMs: opts && opts.freshMs }); } catch (_) { res = null; }
  const entry = res && res.entry ? res.entry : null;
  if (!entry) return _empty(caseUrl, res && res.code === 'DTNA_AUTO_SIGNED_OUT' ? 'DTNA signed out' : 'no DTNA pull yet');
  return {
    ok: true, caseUrl, source: 'dtna', scrapedAt: entry.pulledAt,
    offsiteText: entry.offsiteText, statusText: entry.offsiteText, estimateComments: entry.offsiteText,
    offsiteStage: entry.offsiteStage || '', offsiteStageDetail: entry.caseStatus || '',
    offsiteStageSince: entry.stageSince || '', dtnaCaseNumber: entry.caseNumber || '',
    bestUrl: caseUrl, bestLabel: 'DTNA Case', error: null, rawThread: entry.thread,
  };
}

module.exports = { enrichDtna, DTNA_CASE_RE };
