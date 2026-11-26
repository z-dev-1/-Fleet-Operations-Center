'use strict';
/**
 * autopilot/plan.js — per-case source plan (§B7.2, plan R7). Pure.
 *
 * planSources(input) -> { sources: [{ source, include, live, status, why }], bySource }
 *   include  the source is read in this run (cache or live)
 *   live     a warm-only live read is attempted (subject to the limiter at call time)
 *   status   'live' | 'cache' | 'cache_only:<why>' | 'skipped:<why>' |
 *            'skipped_not_relevant' | 'not_available_v1' | 'cache_empty'
 *
 * input: {
 *   row, features: { evidenceCollection, liveReads }, now,
 *   gate: { aap, decisiv }            live-read gates (cluster / midway / offline) at plan time
 *   aapWarm, decisivWarm              transport warmth at plan time (diagnostics; rechecked in-lock)
 *   newestAapCommentAt                ms of the newest AAP comment evidence, or null
 *   decisivStageAt                    ms the cached Decisiv stage was fetched, or null
 *   budget: { aap_live, decisiv }     limiter tokens left
 *   dtnaCount, hasEmail, hasFasCase, longDwellListed, aperiaCache (cached() result or null)
 *   dealerCases                       ap_case.dealer_cases_json (string, array or null); a linked
 *                                     decisiv / dtna case keeps that source relevant
 * }
 * OPERATIONAL_CADENCE values are scheduling constants, not SLAs.
 */

const { OPERATIONAL_CADENCE, SOURCES: S } = require('./constants');

const DTNA_URL_RE = /^https:\/\/dtna\.my\.site\.com\/Servicetracker\//i;
const DECISIV_HOST_RE = /^https:\/\/(?:volvopg\.asist|volvo\.asist|pssmfleet|paccarpg)\.decisiv\.net\//i;
const TIRE_RE = /tire|tyre|wheel|tpms|tread/i;

function _s(v) { return v == null ? '' : String(v).trim(); }

/** decisivRef(row) -> { estimateId, srUrl } (either may be null). */
function decisivRef(row) {
  const r = row || {};
  const urls = [r.asistSrUrl, r.offsiteShopEventUrl, r.savedOffsiteUrl].map(_s).filter((u) => DECISIV_HOST_RE.test(u));
  const srUrl = urls[0] || null;
  let estimateId = /^\d+$/.test(_s(r.decisivCaseId)) ? _s(r.decisivCaseId) : null;
  let urlId = null;
  if (srUrl) { const m = /\/fleet\/estimates\/(\d+)/i.exec(srUrl); if (m) urlId = m[1]; }
  if (!estimateId) estimateId = urlId;
  return { estimateId, srUrl, urlId };
}

function primaryWrId(row) {
  const r = row || {};
  return _s(r._serviceId) || _s(r.workRequestId) || null;
}

function isDtnaUrl(u) { return DTNA_URL_RE.test(_s(u)); }

function tireRelevant(row) {
  const r = row || {};
  return [r.lifecycleReason, r.issueSummary, r.level1, r.level2].some((v) => TIRE_RE.test(_s(v)));
}

function _offsiteUrl(r) { return _s(r.offsiteShopEventUrl) || _s(r.savedOffsiteUrl) || _s(r.asistSrUrl); }

/**
 * linkedDealerCases(v) -> { decisiv: [id], dtna: [id] } from ap_case.dealer_cases_json
 * (a JSON string, a parsed array, null or malformed; never throws).
 */
function linkedDealerCases(v) {
  const out = { decisiv: [], dtna: [] };
  let a = v;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = null; } }
  if (!Array.isArray(a)) return out;
  for (const x of a) {
    if (!x || typeof x !== 'object') continue;
    const k = _s(x.kind).toLowerCase();
    const id = _s(x.id);
    if (id && out[k] && !out[k].includes(id)) out[k].push(id);
  }
  return out;
}

/**
 * rowWithLinkedDecisiv(row, dealerCases) -> row, or a copy carrying decisivCaseId from the
 * case's linked Decisiv dealer case when the row itself has no Decisiv estimate id, so the
 * existing Decisiv cache read can find the entry.
 */
function rowWithLinkedDecisiv(row, dealerCases) {
  const r = row || {};
  if (decisivRef(r).estimateId) return row;
  const id = linkedDealerCases(dealerCases).decisiv.find((x) => /^\d+$/.test(x));
  return id ? Object.assign({}, r, { decisivCaseId: id }) : row;
}

function planSources(input) {
  const i = input || {};
  const row = i.row || {};
  const f = i.features || {};
  const evidenceOn = f.evidenceCollection !== false;
  const liveOn = f.liveReads === true;
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const gate = i.gate || {};
  const budget = i.budget || {};
  const out = [];
  const add = (source, include, live, status) => out.push({ source, include, live, status, why: status });
  const offEvidence = 'skipped:evidence_collection_off';

  add(S.AAP_CACHE, true, false, 'cache');
  add(S.CANONICAL, true, false, 'cache');

  if (!evidenceOn) {
    for (const s of [S.REPAIR_INTEL, S.AAP_LIVE, S.DTNA, S.DECISIV, S.LONG_DWELL, S.SLACK, S.EMAIL, S.VENDOR_INTEL, S.FAS_CASE, S.APERIA]) {
      add(s, false, false, offEvidence);
    }
    add(S.SHAREPOINT, false, false, 'not_available_v1');
    return _wrap(out);
  }

  add(S.REPAIR_INTEL, true, false, 'cache');

  // AAP warm-only live read of the primary WR.
  if (!primaryWrId(row)) add(S.AAP_LIVE, false, false, 'skipped_not_relevant');
  else {
    const age = i.newestAapCommentAt == null ? Infinity : now - i.newestAapCommentAt;
    let why = null;
    if (!liveOn) why = 'live_reads_off';
    else if (!gate.aap) why = 'gate_closed';
    else if (!i.aapWarm) why = 'not_warm';
    else if (age <= OPERATIONAL_CADENCE.aapLiveMinAgeMs) why = 'fresh';
    else if (budget.aap_live === false) why = 'budget';
    add(S.AAP_LIVE, true, !why, why ? 'cache_only:' + why : 'live');
  }

  // A dealer case linked on the case keeps that dealer source relevant.
  const linked = linkedDealerCases(i.dealerCases);

  // DTNA: cache only in V1 (D-1).
  if ((Number(i.dtnaCount) || 0) > 0 || isDtnaUrl(_offsiteUrl(row)) || linked.dtna.length) add(S.DTNA, true, false, 'cache_only:live_disabled_v1');
  else add(S.DTNA, false, false, 'skipped_not_relevant');

  // Decisiv: cache plus a warm-only live read.
  const ref = decisivRef(row);
  if (!ref.estimateId && !ref.srUrl && !linked.decisiv.length) add(S.DECISIV, false, false, 'skipped_not_relevant');
  else {
    const age = i.decisivStageAt == null ? Infinity : now - i.decisivStageAt;
    let why = null;
    if (!liveOn) why = 'live_reads_off';
    else if (!gate.decisiv) why = 'gate_closed';
    else if (!ref.srUrl) why = 'no_origin';
    else if (!ref.estimateId) why = 'no_estimate_id';
    else if (!i.decisivWarm) why = 'not_warm';
    else if (age <= OPERATIONAL_CADENCE.decisivLiveMinAgeMs) why = 'fresh';
    else if (budget.decisiv === false) why = 'budget';
    add(S.DECISIV, true, !why, why ? 'cache_only:' + why : 'live');
  }

  add(S.LONG_DWELL, !!i.longDwellListed, false, i.longDwellListed ? 'cache' : 'skipped_not_relevant');
  add(S.SLACK, true, false, 'cache');
  add(S.EMAIL, !!i.hasEmail, false, i.hasEmail ? 'cache' : 'skipped:no_entries');
  const vendorKnown = !!(_s(row.vendor) || _s(row.dealerName));
  add(S.VENDOR_INTEL, vendorKnown, false, vendorKnown ? 'cache' : 'skipped_not_relevant');
  add(S.FAS_CASE, !!i.hasFasCase, false, i.hasFasCase ? 'cache' : 'skipped_not_relevant');

  if (!tireRelevant(row)) add(S.APERIA, false, false, 'skipped_not_relevant');
  else if (i.aperiaCache == null) add(S.APERIA, false, false, 'cache_empty');
  else add(S.APERIA, true, false, 'cache_only:live_disabled_v1');

  add(S.SHAREPOINT, false, false, 'not_available_v1');
  return _wrap(out);
}

function _wrap(sources) {
  const bySource = {};
  for (const s of sources) bySource[s.source] = s;
  return { sources, bySource };
}

module.exports = { planSources, decisivRef, primaryWrId, tireRelevant, isDtnaUrl, linkedDealerCases, rowWithLinkedDecisiv };
