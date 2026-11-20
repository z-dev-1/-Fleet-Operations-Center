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
 *   5. DTNA is excluded entirely (dropped and counted).
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
const AAP_CONCURRENCY = 6;

const DECISIV_VENDORS = new Set(['VOLVO', 'KENWORTH', 'PETERBILT', 'PACCAR']);

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
    fleetRows: pick('fleetRows', () => () => {
      const fd = store.load('fleetData', {}) || {};
      return Array.isArray(fd.rows) ? fd.rows : [];
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

  // (c) open only; (e) DTNA dropped
  let excludedDtna = 0;
  const open = [];
  for (const wo of wos) {
    if (!_wrIdOf(wo) || !_isOpenWo(wo, d.woStatus)) continue;
    if (_isDtnaWo(wo, '')) { excludedDtna++; continue; }
    open.push(wo);
  }
  const openById = new Map(open.map((wo) => [_wrIdOf(wo), wo]));

  // (f) offsite discovery from WR comments (Volvo / PACCAR vendors only)
  const prevWrEst = (prev && prev.wrEst && typeof prev.wrEst === 'object') ? prev.wrEst : {};
  const wrEst = {};
  const wrOffsite = new Map();   // wrId -> estimate url
  const dtnaWr = new Set();
  const candidates = open.filter((wo) => DECISIV_VENDORS.has(_up(wo.vendor))).slice(0, MAX_SERVICE_CALLS);
  const needFetch = [];
  for (const wo of candidates) {
    const id = _wrIdOf(wo);
    const mod = String(wo.modifiedTimestamp == null ? '' : wo.modifiedTimestamp);
    const hit = prevWrEst[id];
    if (hit && hit.mod === mod) {
      wrEst[id] = { mod, url: hit.url || '', dtna: !!hit.dtna };
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
      if (off && off.source === 'estimate' && d.estimateIdFromUrl(off.url)) url = off.url;
      else if (off && off.source === 'dtna') dtna = true;
      wrEst[id] = { mod, url, dtna };
    } catch (e) {
      err('getService', codeOf(e, 'AAP_API_ERROR'));
      if (old) wrEst[id] = { mod: '', url: old.url || '', dtna: !!old.dtna };   // retry next scan
    }
  });
  for (const [id, v] of Object.entries(wrEst)) {
    if (v.dtna) { dtnaWr.add(id); continue; }
    if (v.url) wrOffsite.set(id, v.url);
  }
  if (dtnaWr.size) {
    excludedDtna += dtnaWr.size;
    for (const id of dtnaWr) openById.delete(id);
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
  for (const [estId, url] of caseUrls) {
    const hit = caseCache[estId];
    if (!force && hit && _ageOk(hit.scrapedAt, nowMs, CASE_TTL_MS)) { cases.set(estId, hit); continue; }
    if (caseN >= MAX_CASES) { if (hit) cases.set(estId, hit); continue; }
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
    rec = Object.assign({}, rec, { estimateId: estId, url: rec.url || url, scrapedAt: nowIso });
    caseCache[estId] = rec;
    cases.set(estId, rec);
  }
  try { d.store.save('decisivCaseCache', caseCache); } catch (e) { err('store', 'CASE_CACHE_SAVE'); }

  // Build the row candidates (j)
  const drafts = [];
  for (const wo of openById.values()) {
    const wrId = _wrIdOf(wo);
    const rgPending = _isRgPending(wo, d.woStatus);
    const url = wrOffsite.get(wrId) || '';
    if (!rgPending && !url) continue;
    drafts.push({ kind: 'wr', wo, wrId, rgPending, url, row: null });
  }
  for (const c of extraCases) drafts.push({ kind: 'est', wo: null, wrId: '', rgPending: false, url: c.url, row: c.row });

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
    const eq = dr.wo ? String(dr.wo.assetDisplayName || '') : String((dr.row && dr.row.equipmentId) || '');
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
  const counts = { rg: 0, decisiv: 0, both: 0, mismatch: 0, notInRg: 0 };
  for (const dr of drafts) {
    try {
      const wo = dr.wo;
      const estId = dr.url ? d.estimateIdFromUrl(dr.url) : '';
      const offsite = estId ? (cases.get(estId) || null) : null;
      const site = String((wo && wo.assetDomicileSite) || dr.site || '').trim();
      const operator = dr.operator || '';
      let fas = '';
      try { fas = d.fasFor(operator, site) || ''; } catch (_) { fas = ''; }
      let isMine = false;
      try { isMine = !!d.rowIsMine('scac', { scac: operator, domicile: site }, mine.mySites, mine.myCarriers); } catch (_) { isMine = false; }
      const rgOpen = dr.kind === 'wr';
      const hasOffsite = !!dr.url;
      const source = dr.rgPending && hasOffsite ? 'both' : (hasOffsite ? 'decisiv' : 'rg');
      const cls = d.classifyStatusMismatch({ offsite, rgOpen }) || {};
      const raw = wo ? wo.vendor : '';
      const vendorKind = (dr.url && d.vendorKindOfUrl(dr.url)) || _vendorKindOfRaw(raw) || 'other';
      const st = wo ? _woStatusOf(wo, d.woStatus) : null;
      const fr = dr.row || {};
      const wrId = wo ? dr.wrId : String(fr.workRequestId || '');
      const cost = wo ? Number(wo.totalEstimatePendingApprovalCost) : NaN;
      const row = {
        key: wo ? 'wr:' + dr.wrId : 'est:' + estId,
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
        offsiteShopEventUrl: dr.url || '',
        offsite,
        source,
        offsiteDone: !!cls.offsiteDone,
        statusMismatch: !!cls.statusMismatch,
        notInRg: !rgOpen,
      };
      rows.push(row);
      counts[source]++;
      if (row.statusMismatch) counts.mismatch++;
      if (row.notInRg) counts.notInRg++;
    } catch (e) { err('row', codeOf(e, 'ROW_BUILD_FAILED')); }
  }

  const errors = [...errCounts.entries()].map(([k, n]) => { const [stage, code] = k.split('|'); return { stage, code, n }; });
  const scan = { ok: true, asOf: nowIso, rows, excludedDtna, counts, errors, wrEst, assetCache };
  try { d.store.save('pendingEstScan', scan); } catch (_) { errors.push({ stage: 'store', code: 'SCAN_SAVE', n: 1 }); }
  d.log.info('[pending-est] team scan: ' + open.length + ' open WRs, ' + rows.length + ' rows (rg=' + counts.rg + ' decisiv=' + counts.decisiv
    + ' both=' + counts.both + ' mismatch=' + counts.mismatch + ' notInRg=' + counts.notInRg + '), dtna excluded=' + excludedDtna
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
