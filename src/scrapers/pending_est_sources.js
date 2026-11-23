'use strict';
/**
 * scrapers/pending_est_sources.js — team-wide Pending Estimates collector.
 *
 * RG-driven (plan.md §2 decisions 1-5, 8, 11):
 *   1. One team pull of every OPEN RG work request with the exact Long Dwell
 *      scope (aap_longdwell.DEFAULT_SEARCH_REQUEST via aap_api.searchAllPages).
 *   2. RG-native pending is derived client-side (ESTIMATE_PENDING_APPROVAL or a
 *      pending-approval cost > 0).
 *   3. Volvo / PACCAR WRs: the Decisiv estimate URL is read from the WR comments
 *      (extractOffsiteFromComments) and the case page is scraped (getCasePage +
 *      parseCasePage) with the stage from getCaseStatusSummary.
 *   4. User fleet rows whose offsite estimate is not on an open WR in the pull
 *      are still listed, flagged notInRg.
 *   5. DTNA (findings §6b, §5.3): while the user is signed in to DTNA, cases named
 *      by WR comments / fleet rows / open-WR units are refreshed with the Decisiv
 *      case rules (CASE_TTL_MS, MAX_CASES, CASE_BATCH, stalest first) through the
 *      session-gated src/dtna/auto.js (never a sign-in); signed out, nothing is
 *      called. Rows then read the dtnaCaseCache. Cases
 *      join open WRs by unit (src/dtna/pending.joinCasesToWrs). DTNA has no
 *      estimate amount: total null, status from the case. An unjoined case that
 *      is not closed is listed notInRg. excludedDtna stays 0 (shape compat).
 *
 * Operator / FAS / "mine": operator from fleetData -> longDwellCsv -> getAsset;
 * fas = roster-lookup.fasFor(operator, site); mine = the existing DBR rule
 * dbr_pull._loadMySitesAndCarriers + _rowIsMine('scac', ...).
 *
 * READ-ONLY: no write-gate, Relay or AAP write calls anywhere in this module.
 * Never throws: failures come back as { ok:false, code } or are counted in
 * errors[].
 */

const SCAN_TTL_MS = 15 * 60 * 1000;
const CASE_TTL_MS = 15 * 60 * 1000;
const STAGE_FRESH_MS = 15 * 60 * 1000;
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const AAP_TIMEOUT_MS = 8000;
const DECISIV_TIMEOUT_MS = 20000;
const MAX_SERVICE_CALLS = 300;
const MAX_CASES = 250;
const CASE_BATCH = 10;
const CASE_BATCH_PAUSE_MS = 1500;
// DTNA refresh: these codes in a row DTNA_MAX_CONSECUTIVE times stop it for the scan.
const DTNA_HARD = new Set(['DTNA_NETWORK', 'DTNA_TIMEOUT', 'DTNA_CAPTURE_FAILED']);
const DTNA_MAX_CONSECUTIVE = 3;
const CASE_RETAIN_MS = 24 * 60 * 60 * 1000;   // the drafter ignores cases older than 24 h
const AAP_CONCURRENCY = 6;

const DECISIV_VENDORS = new Set(['VOLVO', 'KENWORTH', 'PETERBILT', 'PACCAR']);
const DTNA_VENDOR_RE = /FREIGHTLINER|DAIMLER/;

// Pure DTNA helpers (cache data only; neither module makes a network call).
const DP = require('../dtna/pending');
const DJ = require('../dtna/join');
const DC = require('../dtna/constants');
const { offsiteUrlOf } = require('../utils/offsite-owner');

let _inflight = null;

function _deps(d) {
  const x = d || {};
  const pick = (k, f) => (x[k] !== undefined ? x[k] : f());
  const aap = () => require('./aap_api');
  const dec = () => require('./decisiv_api');
  const page = () => require('./decisiv_case_page');
  const mapper = () => require('./aap_api_mapper');
  const store = pick('store', () => require('../store'));
  return {
    store,
    searchAllPages: pick('searchAllPages', () => aap().searchAllPages),
    getService: pick('getService', () => aap().getService),
    getAsset: pick('getAsset', () => aap().getAsset),
    getCasePage: pick('getCasePage', () => dec().getCasePage),
    getCaseStatusSummary: pick('getCaseStatusSummary', () => dec().getCaseStatusSummary),
    parseCasePage: pick('parseCasePage', () => page().parseCasePage),
    mergeCaseStatus: pick('mergeCaseStatus', () => page().mergeCaseStatus),
    classifyStatusMismatch: pick('classifyStatusMismatch', () => page().classifyStatusMismatch),
    estimateIdFromUrl: pick('estimateIdFromUrl', () => page().estimateIdFromUrl),
    vendorKindOfUrl: pick('vendorKindOfUrl', () => page().vendorKindOfUrl),
    extractOffsiteFromComments: pick('extractOffsiteFromComments', () => mapper().extractOffsiteFromComments),
    woStatus: pick('woStatus', () => mapper().woStatus),
    mapVendor: pick('mapVendor', () => mapper().mapVendor),
    fasFor: pick('fasFor', () => require('../orcha/fas/roster-lookup').fasFor),
    loadMine: pick('loadMine', () => require('./dbr_pull')._loadMySitesAndCarriers),
    rowIsMine: pick('rowIsMine', () => require('./dbr_pull')._rowIsMine),
    caseUrlOf: pick('caseUrlOf', () => require('../orcha/stage_refresh').caseUrlOf),
    now: pick('now', () => () => Date.now()),
    sleep: pick('sleep', () => (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t && t.unref) t.unref(); })),
    fleetRows: pick('fleetRows', () => () => {
      const fd = store.load('fleetData', {}) || {};
      return Array.isArray(fd.rows) ? fd.rows : [];
    }),
    // DTNA refresh: only through the session-gated sync-pass module (src/dtna/auto.js).
    dtnaGate: pick('dtnaGate', () => () => require('../dtna/auto').ensureSignedIn()),
    dtnaRefresh: pick('dtnaRefresh', () => (id, o) => require('../dtna/auto').pullIfStale(id, o)),
    dtnaDiscover: pick('dtnaDiscover', () => (o) => require('../dtna/auto').discover(o)),
    // DTNA cache read through the injected store.
    loadDtnaCases: pick('loadDtnaCases', () => () => {
      const ds = require('../dtna/store');
      const raw = store.load(ds.KEY, null);
      const cases = raw && typeof raw === 'object' && raw.cases && typeof raw.cases === 'object' ? Object.values(raw.cases) : [];
      return cases.map((e) => ds.sanitize(e)).filter(Boolean);
    }),
    log: pick('log', () => {
      try { const l = require('../utils/logger')('pending-est'); return { info: (m) => l.info(m), warn: (m) => l.warn(m) }; }
      catch (_) { return { info() {}, warn() {} }; }
    }),
  };
}

// ── small helpers ────────────────────────────────────────────────────────────
function _withTimeout(p, ms, code) {
  let t = null;
  return Promise.race([
    Promise.resolve().then(() => p),
    new Promise((_, rej) => {
      t = setTimeout(() => { const e = new Error(code || 'TIMEOUT'); e.code = code || 'TIMEOUT'; rej(e); }, ms);
      if (t && t.unref) t.unref();
    }),
  ]).finally(() => { if (t) clearTimeout(t); });
}

async function _pool(items, n, fn) {
  let i = 0;
  const workers = [];
  for (let w = 0; w < Math.min(n, items.length); w++) {
    workers.push((async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })());
  }
  await Promise.all(workers);
}

const _up = (s) => String(s == null ? '' : s).trim().toUpperCase();
const _wrIdOf = (wo) => String((wo && (wo.workRequestId || wo.id)) || '');
function _epochIso(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  try { return new Date(n).toISOString(); } catch (_) { return ''; }
}
function _ageOk(iso, nowMs, ttl) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) && nowMs - t >= 0 && nowMs - t < ttl;
}
function _strip(scan) {
  if (!scan || typeof scan !== 'object') return null;
  const out = Object.assign({}, scan);
  delete out.wrEst;
  delete out.assetCache;
  return out;
}

function _woStatusOf(wo, woStatus) {
  try { return woStatus(wo) || { value: '', displayText: '', type: '' }; }
  catch (_) { return { value: '', displayText: '', type: '' }; }
}

// ── exported predicates ──────────────────────────────────────────────────────
function _isOpenWo(wo, woStatus) {
  if (!wo) return false;
  if (wo.completedDateTime) return false;
  const st = _woStatusOf(wo, woStatus || require('./aap_api_mapper').woStatus);
  if (st.type === 'Complete') return false;
  if (/CANCEL|COMPLETE|CLOSED/i.test(st.value)) return false;
  return true;
}

function _isRgPending(wo, woStatus) {
  if (!wo) return false;
  const st = _woStatusOf(wo, woStatus || require('./aap_api_mapper').woStatus);
  return st.value === 'ESTIMATE_PENDING_APPROVAL' || Number(wo.totalEstimatePendingApprovalCost) > 0;
}

function _isDtnaWo(wo, offsiteUrl) {
  const v = _up(wo && wo.vendor);
  if (/FREIGHTLINER|DAIMLER/.test(v)) return true;
  return /dtna\.my\.site\.com/i.test(String(offsiteUrl || ''));
}

function _vendorKindOfRaw(raw) {
  const v = _up(raw);
  if (v === 'VOLVO') return 'volvo';
  if (v === 'KENWORTH' || v === 'PETERBILT' || v === 'PACCAR') return 'paccar';
  return '';
}

// ── last scan ────────────────────────────────────────────────────────────────
function _loadScan(store) {
  try {
    const s = store.load('pendingEstScan', null);
    return s && typeof s === 'object' && Array.isArray(s.rows) ? s : null;
  } catch (_) { return null; }
}

function getLastScan(deps) {
  const d = _deps(deps);
  return _strip(_loadScan(d.store));
}

// ── the scan ─────────────────────────────────────────────────────────────────
async function _scan(opts, d) {
  const force = !!(opts && opts.force);
  const nowMs = Number(d.now()) || Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const prev = _loadScan(d.store);

  // (a) throttle
  if (!force && prev && prev.ok !== false && _ageOk(prev.asOf, nowMs, SCAN_TTL_MS)) {
    return Object.assign(_strip(prev), { cached: true });
  }

  const errCounts = new Map();
  const err = (stage, code) => {
    const k = stage + '|' + (code || 'ERROR');
    errCounts.set(k, (errCounts.get(k) || 0) + 1);
  };
  const codeOf = (e, dflt) => String((e && (e.code || e.status)) || dflt || 'ERROR');

  // (b) team pull, same body as Long Dwell
  let wos;
  try {
    const ld = require('./aap_longdwell');
    wos = await d.searchAllPages(ld.DEFAULT_SEARCH_REQUEST, { maxPages: 50 });
    if (!Array.isArray(wos)) throw Object.assign(new Error('bad search result'), { code: 'AAP_SEARCH_BAD_RESULT' });
  } catch (e) {
    d.log.warn('[pending-est] team search failed: ' + codeOf(e, 'AAP_SEARCH_FAILED'));
    const base = _strip(prev) || { asOf: null, rows: [], excludedDtna: 0, counts: {}, errors: [] };
    return Object.assign(base, { ok: false, code: codeOf(e, 'AAP_SEARCH_FAILED'), cached: true });
  }

  // (c) open only; DTNA WRs are kept (tagged by vendor / case URL, never dropped)
  const excludedDtna = 0;
  const open = [];
  for (const wo of wos) {
    if (!_wrIdOf(wo) || !_isOpenWo(wo, d.woStatus)) continue;
    open.push(wo);
  }
  const openById = new Map(open.map((wo) => [_wrIdOf(wo), wo]));

  // (f) offsite discovery from WR comments (Volvo / PACCAR vendors first, then DTNA vendors)
  const prevWrEst = (prev && prev.wrEst && typeof prev.wrEst === 'object') ? prev.wrEst : {};
  const wrEst = {};
  const wrOffsite = new Map();   // wrId -> estimate url
  const wrDtnaCase = new Map();  // wrId -> DTNA case id named in its comments
  const candidates = open.filter((wo) => DECISIV_VENDORS.has(_up(wo.vendor)))
    .concat(open.filter((wo) => DTNA_VENDOR_RE.test(_up(wo.vendor))))
    .slice(0, MAX_SERVICE_CALLS);
  const needFetch = [];
  for (const wo of candidates) {
    const id = _wrIdOf(wo);
    const mod = String(wo.modifiedTimestamp == null ? '' : wo.modifiedTimestamp);
    const hit = prevWrEst[id];
    // A DTNA hit from before the case id was kept is re-read once.
    if (hit && hit.mod === mod && !(hit.dtna && hit.dtnaCase === undefined)) {
      wrEst[id] = { mod, url: hit.url || '', dtna: !!hit.dtna, dtnaCase: hit.dtnaCase || '' };
    } else {
      needFetch.push({ wo, id, mod, old: hit || null });
    }
  }
  await _pool(needFetch, AAP_CONCURRENCY, async ({ id, mod, old }) => {
    try {
      const detail = await _withTimeout(d.getService(id), AAP_TIMEOUT_MS, 'AAP_TIMEOUT');
      const off = d.extractOffsiteFromComments(detail);
      let url = '';
      let dtna = false;
      let dtnaCase = '';
      if (off && off.source === 'estimate' && d.estimateIdFromUrl(off.url)) url = off.url;
      else if (off && off.source === 'dtna') { dtna = true; dtnaCase = DJ.caseIdFromUrl(off.url); }
      wrEst[id] = { mod, url, dtna, dtnaCase };
    } catch (e) {
      err('getService', codeOf(e, 'AAP_API_ERROR'));
      if (old) wrEst[id] = { mod: '', url: old.url || '', dtna: !!old.dtna, dtnaCase: old.dtnaCase || '' };   // retry next scan
    }
  });
  for (const [id, v] of Object.entries(wrEst)) {
    if (v.dtna) { if (v.dtnaCase) wrDtnaCase.set(id, v.dtnaCase); continue; }
    if (v.url) wrOffsite.set(id, v.url);
  }

  // (g) user fleet rows: estimates not discovered above
  const fleet = (() => { try { const r = d.fleetRows(); return Array.isArray(r) ? r : []; } catch (_) { return []; } })();
  const discoveredIds = new Set();
  for (const url of wrOffsite.values()) discoveredIds.add(d.estimateIdFromUrl(url));
  const fleetByEst = new Map();
  const extraCases = [];   // { url, estId, row }
  for (const row of fleet) {
    if (!row) continue;
    const url = d.caseUrlOf(row);
    const estId = url ? d.estimateIdFromUrl(url) : '';
    if (!estId) continue;
    if (!fleetByEst.has(estId)) fleetByEst.set(estId, row);
    if (discoveredIds.has(estId)) continue;
    discoveredIds.add(estId);
    const wrId = String(row.workRequestId || '');
    if (wrId && openById.has(wrId) && !wrOffsite.has(wrId)) wrOffsite.set(wrId, url);
    else extraCases.push({ url, estId, row });
  }

  // (h) scrape each unique case
  const caseUrls = new Map();   // estId -> url
  for (const url of wrOffsite.values()) { const id = d.estimateIdFromUrl(url); if (id && !caseUrls.has(id)) caseUrls.set(id, url); }
  for (const c of extraCases) if (!caseUrls.has(c.estId)) caseUrls.set(c.estId, c.url);
  let caseCache = {};
  try { caseCache = d.store.load('decisivCaseCache', {}) || {}; } catch (_) { caseCache = {}; }
  const cases = new Map();
  let caseN = 0;
  // Never-scraped cases first, then the oldest scrape, so the MAX_CASES cap rotates
  // through every case across scans instead of re-scraping the same ones.
  const scrapedMs = (id) => { const t = Date.parse((caseCache[id] && caseCache[id].scrapedAt) || ''); return Number.isFinite(t) ? t : -Infinity; };
  const caseOrder = [...caseUrls].sort((a, b) => scrapedMs(a[0]) - scrapedMs(b[0]));
  for (const [estId, url] of caseOrder) {
    const hit = caseCache[estId];
    if (!force && hit && _ageOk(hit.scrapedAt, nowMs, CASE_TTL_MS)) { cases.set(estId, hit); continue; }
    if (caseN >= MAX_CASES) { if (hit) cases.set(estId, hit); continue; }
    // Every Decisiv call takes decisiv_api's global lock on its own; a short idle gap
    // after each batch lets stage_refresh and other Decisiv reads run between batches.
    if (caseN > 0 && caseN % CASE_BATCH === 0) { try { await d.sleep(CASE_BATCH_PAUSE_MS); } catch (_) {} }
    caseN++;
    let rec;
    let pageErr = null;
    try {
      const pg = await _withTimeout(d.getCasePage(estId, { srUrl: url }), DECISIV_TIMEOUT_MS, 'DECISIV_TIMEOUT');
      if (pg && pg.ok) rec = d.parseCasePage(pg.html, { estimateId: estId, now: nowIso, url });
      else pageErr = (pg && pg.code) || 'DECISIV_API_ERROR';
    } catch (e) { pageErr = codeOf(e, 'DECISIV_API_ERROR'); }
    if (pageErr) {
      err('getCasePage', pageErr);
      rec = d.parseCasePage('', { estimateId: estId, now: nowIso, url });
      rec.ok = false;
      rec.error = pageErr;
    }
    // A failed or empty scrape (e.g. an expired Decisiv session) keeps the last good
    // record and its scrapedAt, so the stalest-first order retries it next scan.
    const keep = rec.ok === false && hit && hit.ok !== false ? hit : null;
    if (keep) rec = Object.assign({}, keep, { lastError: rec.error || pageErr || 'DECISIV_PARSE_EMPTY', lastAttemptAt: nowIso });
    const fr = fleetByEst.get(estId);
    if (fr && fr.offsiteStage && _ageOk(fr._stageReadAt, nowMs, STAGE_FRESH_MS)) {
      rec = d.mergeCaseStatus(rec, { ok: true, stage: fr.offsiteStage, status: fr.offsiteStageDetail || '', since: fr.offsiteStageSince || '' }, { now: nowIso });
    } else {
      try {
        const s = await _withTimeout(d.getCaseStatusSummary(estId, { srUrl: url }), DECISIV_TIMEOUT_MS, 'DECISIV_TIMEOUT');
        if (s && s.ok) rec = d.mergeCaseStatus(rec, s, { now: nowIso });
        else err('getCaseStatusSummary', (s && s.code) || 'DECISIV_API_ERROR');
      } catch (e) { err('getCaseStatusSummary', codeOf(e, 'DECISIV_API_ERROR')); }
    }
    rec = Object.assign({}, rec, { estimateId: estId, url: rec.url || url, scrapedAt: keep ? keep.scrapedAt : nowIso });
    caseCache[estId] = rec;
    cases.set(estId, rec);
  }
  // Prune: keep the cases this scan references (team WRs + the user's fleet rows) and
  // anything scraped within CASE_RETAIN_MS; drop the rest so the store stays bounded.
  for (const id of Object.keys(caseCache)) {
    if (caseUrls.has(id)) continue;
    const rec = caseCache[id];
    if (!_ageOk(rec && rec.scrapedAt, nowMs, CASE_RETAIN_MS)) delete caseCache[id];
  }
  try { d.store.save('decisivCaseCache', caseCache); } catch (e) { err('store', 'CASE_CACHE_SAVE'); }

  // (h2) DTNA refresh while signed in, with the (h) rules: per-case CASE_TTL_MS, the shared MAX_CASES
  // budget, a pause after every CASE_BATCH live reads, stalest first. Signed out or expired, the gate
  // first tries one gated hidden background sign-in (src/dtna/auto.js ensureSignedIn); still signed
  // out: nothing is called. force (Refresh) is not passed on: the forced DTNA refresh is the manual "Pull DTNA".
  let dtnaAuto = 'ok';
  let dtnaLive = 0;
  let gateOk = false;
  try { const g = await d.dtnaGate(); gateOk = !!(g && g.ok); } catch (_) { gateOk = false; }
  if (!gateOk) dtnaAuto = 'signed-out';
  else {
    const signedOut = (c) => c === 'DTNA_AUTO_SIGNED_OUT' || c === 'DTNA_SIGNIN_REQUIRED' || c === 'DTNA_SESSION_EXPIRED';
    let known = [];
    try { const e = d.loadDtnaCases(); known = Array.isArray(e) ? e : []; } catch (_) { known = []; }
    const byId = new Map(known.map((e) => [e.caseId, e]));
    const openUnits = new Set([...openById.values()].map((w) => DJ.normUnit(w.assetDisplayName)).filter(Boolean));
    const ids = new Set(wrDtnaCase.values());
    for (const row of fleet) { const id = row ? DJ.caseIdFromUrl(offsiteUrlOf(row)) : ''; if (id) ids.add(id); }
    for (const e of known) if (openUnits.has(DJ.normUnit(e.unitId)) && !DP.isCaseClosed(e)) ids.add(e.caseId);
    const pulledMs = (id) => { const t = Date.parse((byId.get(id) && byId.get(id).pulledAt) || ''); return Number.isFinite(t) ? t : -Infinity; };
    const order = [...ids].filter((id) => DC.CASE_ID_RE.test(id)).sort((a, b) => pulledMs(a) - pulledMs(b));
    let streak = 0; // consecutive DTNA_HARD failures
    for (const id of order) {
      const hit = byId.get(id);
      if (hit && _ageOk(hit.pulledAt, nowMs, CASE_TTL_MS)) continue;
      if (caseN + dtnaLive >= MAX_CASES) break;
      if (dtnaLive > 0 && dtnaLive % CASE_BATCH === 0) { try { await d.sleep(CASE_BATCH_PAUSE_MS); } catch (_) {} }
      let r;
      try { r = await d.dtnaRefresh(id, { freshMs: CASE_TTL_MS }); } catch (_) { r = { ok: false, live: true, code: 'DTNA_NETWORK' }; }
      if (r && r.live) dtnaLive++;
      const code = r && r.ok ? '' : String((r && r.code) || 'DTNA_ERROR');
      if (signedOut(code)) { dtnaAuto = 'signed-out'; break; }
      if (code) err('dtna', code);
      // One slow or dropped case read is skipped; only DTNA_MAX_CONSECUTIVE network / timeout / capture
      // failures in a row stop the DTNA refresh for this scan (the next scan retries).
      if (DTNA_HARD.has(code)) streak++;
      else streak = 0;
      if (streak >= DTNA_MAX_CONSECUTIVE) { dtnaAuto = 'error'; break; }
    }
    // Open FREIGHTLINER / DAIMLER WRs whose unit has no case yet: one bounded discovery (unit-number join).
    if (dtnaAuto === 'ok' && caseN + dtnaLive < MAX_CASES) {
      let cached = [];
      try { const e = d.loadDtnaCases(); cached = Array.isArray(e) ? e : []; } catch (_) { cached = []; }
      const cachedUnits = new Set(cached.map((e) => DJ.normUnit(e.unitId)).filter(Boolean));
      const units = new Set();
      for (const w of openById.values()) {
        if (!DTNA_VENDOR_RE.test(_up(w.vendor)) || wrDtnaCase.has(_wrIdOf(w))) continue;
        const u = DJ.normUnit(w.assetDisplayName);
        if (u && !cachedUnits.has(u)) units.add(u);
      }
      if (units.size) {
        try {
          const r = await d.dtnaDiscover({ units: [...units], budget: MAX_CASES - caseN - dtnaLive });
          dtnaLive += Number(r && r.pulled) || 0;
          const code = String((r && r.code) || 'OK');
          if (signedOut(code)) dtnaAuto = 'signed-out';
          else if (code !== 'OK') err('dtna', code);
        } catch (_) { err('dtna', 'DTNA_DISCOVER'); }
      }
    }
  }

  // (g2) DTNA cases from the dtnaCaseCache (refreshed above and by the user's "Pull DTNA")
  let dtnaEntries = [];
  try { const e = d.loadDtnaCases(); dtnaEntries = Array.isArray(e) ? e : []; } catch (_) { err('dtna', 'DTNA_CACHE_READ'); dtnaEntries = []; }
  let dtnaJoin = { byWr: new Map(), unjoined: [] };
  try {
    dtnaJoin = DP.joinCasesToWrs({ entries: dtnaEntries, openWos: [...openById.values()], wrDtnaCase, blockedWrIds: new Set(wrOffsite.keys()), fleetRows: fleet });
  } catch (_) { err('dtna', 'DTNA_JOIN'); }

  // Build the row candidates (j)
  const drafts = [];
  for (const wo of openById.values()) {
    const wrId = _wrIdOf(wo);
    const rgPending = _isRgPending(wo, d.woStatus);
    const url = wrOffsite.get(wrId) || '';
    const dtna = url ? null : (dtnaJoin.byWr.get(wrId) || null);
    const dtnaUrl = !url && wrDtnaCase.has(wrId) ? DC.caseUrl(wrDtnaCase.get(wrId)) : '';
    if (!rgPending && !url && !dtna) continue;
    drafts.push({ kind: 'wr', wo, wrId, rgPending, url, row: null, dtna, dtnaUrl });
  }
  for (const c of extraCases) drafts.push({ kind: 'est', wo: null, wrId: '', rgPending: false, url: c.url, row: c.row });
  for (const entry of dtnaJoin.unjoined) {
    if (!DP.isAwaitingApproval(entry)) continue;
    const u = DJ.normUnit(entry.unitId);
    const vt = DJ.normUnit(entry.serial);
    const row = fleet.find((r) => r && u && DJ.normUnit(r.equipmentId) === u)
      || fleet.find((r) => r && vt && DJ.vinTail(r.vin) === vt) || null;
    drafts.push({ kind: 'dtna', wo: null, wrId: '', rgPending: false, url: '', row, dtna: entry, dtnaUrl: '' });
  }

  // (i) operator / site / fas / mine
  const prevAsset = (prev && prev.assetCache && typeof prev.assetCache === 'object') ? prev.assetCache : {};
  const assetCache = {};
  for (const [k, v] of Object.entries(prevAsset)) if (v && _ageOk(v.at, nowMs, ASSET_TTL_MS)) assetCache[k] = v;
  const fleetByAaid = new Map();
  const fleetByEq = new Map();
  for (const r of fleet) {
    if (!r) continue;
    const a = String(r.assetId || r.aaid || '');
    if (a && !fleetByAaid.has(a)) fleetByAaid.set(a, r);
    const q = _up(r.equipmentId);
    if (q && !fleetByEq.has(q)) fleetByEq.set(q, r);
  }
  const ldByUnit = new Map();
  try {
    const ld = d.store.load('longDwellCsv', { rows: {} }) || {};
    const rows = ld.rows && typeof ld.rows === 'object' ? Object.values(ld.rows) : [];
    for (const r of rows) {
      const k = _up(r && r.assetId);
      if (k && !ldByUnit.has(k)) ldByUnit.set(k, r);
    }
  } catch (_) {}

  const ident = (dr) => {
    const aaid = dr.wo ? String(dr.wo.aaid || '') : String((dr.row && (dr.row.assetId || dr.row.aaid)) || '');
    const eq = dr.wo ? String(dr.wo.assetDisplayName || '')
      : (dr.kind === 'dtna' ? String((dr.row && dr.row.equipmentId) || dr.dtna.unitId || '') : String((dr.row && dr.row.equipmentId) || ''));
    return { aaid, eq };
  };
  const needAsset = new Set();
  for (const dr of drafts) {
    const { aaid, eq } = ident(dr);
    const fr = dr.row || fleetByAaid.get(aaid) || fleetByEq.get(_up(eq));
    let operator = String((fr && fr.operator) || '').trim();
    let site = String((fr && (fr.domicileSite || fr.domicile)) || '').trim();
    if (!operator) {
      const ldr = ldByUnit.get(_up(eq));
      const csv = (ldr && ldr.csv) || {};
      operator = String(csv.SCAC || '').trim();
      if (!site) site = String(csv.Site || (ldr && ldr.site) || '').trim();
    }
    if (!operator && aaid) {
      const ac = assetCache[aaid];
      if (ac) { operator = ac.operator || ''; if (!site) site = ac.site || ''; }
      else needAsset.add(aaid);
    }
    dr.operator = operator;
    dr.site = site;
    dr.aaid = aaid;
    dr.equipmentId = eq;
  }
  await _pool([...needAsset], AAP_CONCURRENCY, async (aaid) => {
    try {
      const res = await _withTimeout(d.getAsset(aaid), AAP_TIMEOUT_MS, 'AAP_TIMEOUT');
      const at = (res && res.asset && res.asset.attributesText) || {};
      assetCache[aaid] = { at: nowIso, operator: String(at.operator || '').trim(), site: String(at.domicileSite || '').trim() };
    } catch (e) { err('getAsset', codeOf(e, 'AAP_API_ERROR')); }
  });
  for (const dr of drafts) {
    if (!dr.operator && dr.aaid && assetCache[dr.aaid]) {
      dr.operator = assetCache[dr.aaid].operator || '';
      if (!dr.site) dr.site = assetCache[dr.aaid].site || '';
    }
  }

  let mine = { mySites: new Set(), myCarriers: new Set() };
  try { mine = d.loadMine() || mine; } catch (e) { err('mine', 'LOAD_MINE_FAILED'); }

  const rows = [];
  const counts = { rg: 0, decisiv: 0, both: 0, dtna: 0, mismatch: 0, notInRg: 0 };
  for (const dr of drafts) {
    try {
      const wo = dr.wo;
      const estId = dr.url ? d.estimateIdFromUrl(dr.url) : '';
      const offsite = dr.dtna ? DP.offsiteRecord(dr.dtna) : (estId ? (cases.get(estId) || null) : null);
      const site = String((wo && wo.assetDomicileSite) || dr.site || '').trim();
      const operator = dr.operator || '';
      let fas = '';
      try { fas = d.fasFor(operator, site) || ''; } catch (_) { fas = ''; }
      let isMine = false;
      try { isMine = !!d.rowIsMine('scac', { scac: operator, domicile: site }, mine.mySites, mine.myCarriers); } catch (_) { isMine = false; }
      const rgOpen = dr.kind === 'wr';
      const hasOffsite = !!dr.url;
      const raw = wo ? wo.vendor : '';
      let source;
      let cls;
      let vendorKind;
      if (dr.dtna) {
        source = dr.rgPending ? 'both' : 'dtna';
        cls = DP.mismatch(dr.dtna, rgOpen);
        vendorKind = 'dtna';
      } else {
        source = dr.rgPending && hasOffsite ? 'both' : (hasOffsite ? 'decisiv' : 'rg');
        cls = d.classifyStatusMismatch({ offsite, rgOpen }) || {};
        vendorKind = (dr.url && d.vendorKindOfUrl(dr.url)) || (dr.dtnaUrl ? 'dtna' : '') || _vendorKindOfRaw(raw)
          || (wo && _isDtnaWo(wo, '') ? 'dtna' : '') || 'other';
      }
      const dtnaCaseId = dr.dtna ? String(dr.dtna.caseId) : '';
      const st = wo ? _woStatusOf(wo, d.woStatus) : null;
      const fr = dr.row || {};
      const wrId = wo ? dr.wrId : String(fr.workRequestId || '');
      const cost = wo ? Number(wo.totalEstimatePendingApprovalCost) : NaN;
      const row = {
        key: wo ? 'wr:' + dr.wrId : (dr.kind === 'dtna' ? 'dtna:' + dtnaCaseId : 'est:' + estId),
        workRequestId: wrId,
        aaid: dr.aaid,
        equipmentId: dr.equipmentId,
        assetUrl: wo ? (dr.aaid ? 'https://aap-na.corp.amazon.com/v2/asset/' + dr.aaid : '') : String(fr.assetUrl || ''),
        serviceUrl: wo ? 'https://aap-na.corp.amazon.com/v2/service/' + dr.wrId : String(fr.serviceUrl || ''),
        vendor: wo ? d.mapVendor(raw) : String(fr.vendor || ''),
        vendorKind,
        domicileSite: site,
        operator,
        fas,
        mine: isMine,
        rgOpen,
        rgPending: dr.rgPending,
        rgStatus: st ? (st.displayText || st.value || '') : '',
        rgPendingCost: Number.isFinite(cost) ? cost : null,
        created: wo ? _epochIso(wo.scheduledDateTime) : String(fr.created || ''),
        vendorWorkOrderId: wo ? (Array.isArray(wo.vendorWorkOrderIds) ? wo.vendorWorkOrderIds.join('; ') : '') : String(fr.vendorWorkOrderId || ''),
        offsiteShopEventUrl: dr.url || (dtnaCaseId ? DC.caseUrl(dtnaCaseId) : (dr.dtnaUrl || '')),
        offsite,
        source,
        offsiteDone: !!cls.offsiteDone,
        statusMismatch: !!cls.statusMismatch,
        notInRg: !rgOpen,
      };
      if (dr.dtna) {
        row.dtnaCaseId = dtnaCaseId;
        row.dtnaCaseNumber = String(dr.dtna.caseNumber || '');
      }
      rows.push(row);
      counts[source]++;
      if (row.statusMismatch) counts.mismatch++;
      if (row.notInRg) counts.notInRg++;
    } catch (e) { err('row', codeOf(e, 'ROW_BUILD_FAILED')); }
  }

  const errors = [...errCounts.entries()].map(([k, n]) => { const [stage, code] = k.split('|'); return { stage, code, n }; });
  const dtnaAsOf = DP.latestPulledAt(dtnaEntries);
  const scan = { ok: true, asOf: nowIso, rows, excludedDtna, dtnaAsOf, dtnaAuto, counts, errors, wrEst, assetCache };
  try { d.store.save('pendingEstScan', scan); } catch (_) { errors.push({ stage: 'store', code: 'SCAN_SAVE', n: 1 }); }
  d.log.info('[pending-est] team scan: ' + open.length + ' open WRs, ' + rows.length + ' rows (rg=' + counts.rg + ' decisiv=' + counts.decisiv
    + ' both=' + counts.both + ' dtna=' + counts.dtna + ' mismatch=' + counts.mismatch + ' notInRg=' + counts.notInRg + '), dtnaCases=' + dtnaEntries.length + ' dtnaLive=' + dtnaLive
    + (errors.length ? ', errors=' + errors.map((x) => x.stage + ':' + x.code + 'x' + x.n).join(',') : ''));
  return Object.assign(_strip(scan), { cached: false });
}

/**
 * scanTeamPending({ force } = {}, deps = {}) -> PendingEstScan (plan.md §1.2).
 * Throttled to once per 15 min unless force; concurrent callers share one run.
 */
function scanTeamPending(opts = {}, deps = {}) {
  if (_inflight) return _inflight;
  let d;
  try { d = _deps(deps); } catch (e) { return Promise.resolve({ ok: false, code: 'PENDING_EST_DEPS', rows: [], cached: true }); }
  _inflight = _scan(opts || {}, d)
    .catch((e) => {
      try { d.log.warn('[pending-est] scan failed: ' + (e && e.message)); } catch (_) {}
      const base = _strip(_loadScan(d.store)) || { asOf: null, rows: [], excludedDtna: 0, counts: {}, errors: [] };
      return Object.assign(base, { ok: false, code: 'PENDING_EST_SCAN_FAILED', cached: true });
    })
    .finally(() => { _inflight = null; });
  return _inflight;
}

function _resetForTests() { _inflight = null; }

module.exports = {
  scanTeamPending,
  getLastScan,
  DECISIV_VENDORS,
  _isOpenWo,
  _isRgPending,
  _isDtnaWo,
  _resetForTests,
};
