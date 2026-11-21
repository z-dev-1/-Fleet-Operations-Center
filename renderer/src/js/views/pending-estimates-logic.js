/**
 * pending-estimates-logic.js — pure helpers for the Fleet-tab "⏳ Pending Estimates"
 * overlay (pending-estimates-panel.js). No DOM, no bridge: unit-tested directly.
 *
 * A work order is PENDING APPROVAL when (findings §1):
 *   - the fact set says the latest estimate event is a submission with no later
 *     approve/reject (row.estimateStatus === 'submitted'; primary WR only), or
 *   - AAP says so: WO status ESTIMATE_PENDING_APPROVAL, or a pending-approval cost > 0
 *     (row.estimatePendingCost; a secondary WR carries it as totalCost).
 * The submitted time is row.estimateSubmittedAt (wo-facts mirror of the estimate
 * event time). Sync / scrape times are never used as a stand-in; AAP-only pending
 * WOs show "submitted time unknown".
 *
 * DTNA work orders are excluded (findings §2). Scope is whatever rows the fleet
 * slice holds (the user's settings.domiciles build); nothing here widens it.
 *
 * Upgrade (team-wide): mergeTeamRows joins those v1 items with the main-process team
 * scan rows (window.pendingEst, src/scrapers/pending_est_sources.js) on the WR id.
 * The scan is team-wide; the Owner control (Mine / Everyone / All) and the filter bar
 * only filter the merged items for display (applyFilters), they never change the pull.
 * row.mine comes from main: dbr_pull._loadMySitesAndCarriers + _rowIsMine.
 */
import { vendorWoOf, vendorWoChipHtml } from './id-links.js';

export const PENDING_STATE = 'ESTIMATE_PENDING_APPROVAL';
export const HVE_TARGET = 'MCS_HIGH_VALUE_ESTIMATE';
export const STALE_MS = 24 * 3600 * 1000;
export const DTNA_VENDOR_KEYS = ['FREIGHTLINER', 'DAIMLER'];
export const DTNA_HOST_RE = /^https?:\/\/dtna\.my\.site\.com\//i;

const WR_UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Same escaping as relay-actions.js escAttr.
function escAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Same normaliser as relay-actions.js _norm.
function _norm(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function _num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '') || NaN) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function _ms(v) {
  if (v == null || v === '') return null;
  const m = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(m) ? m : null;
}

// Same rule as relay-actions.js aaidOf.
function _aaid(unit) {
  const u = unit || {};
  if (u.aaid) return String(u.aaid).trim();
  const m = String(u.assetUrl || '').match(/\/v2\/asset\/([^/?#]+)/);
  return m ? m[1] : '';
}

// Same open rule as relay-actions.js _wrIsOpen (WR cards only offer Escalate on open WRs).
function _isOpen(w) {
  return !w.completed && !/complet|closed|cancel/i.test(String(w.serviceState || ''));
}

function _vendorIsDtna(v) {
  const toks = _norm(v).split('_');
  return DTNA_VENDOR_KEYS.some((k) => toks.includes(k));
}

/** DTNA when the unit or WR has a DTNA case source / case URL, or a Freightliner/Daimler vendor. */
export function isDtna(unit, wr) {
  const list = [unit || {}, wr || {}];
  for (const x of list) {
    if (String(x.asistSource || '').toLowerCase() === 'dtna') return true;
    for (const k of ['offsiteShopEventUrl', 'savedOffsiteUrl', 'asistSrUrl']) {
      if (DTNA_HOST_RE.test(String(x[k] || '').trim())) return true;
    }
    if (_vendorIsDtna(x.vendor)) return true;
  }
  return false;
}

/** { pending, source: 'relay'|'aap'|'both'|null } for one WR entry. */
export function pendingSignal(entry, { primary } = {}) {
  const e = entry || {};
  const relay = !!primary && String(e.estimateStatus || '') === 'submitted';
  const cost = _num(primary ? e.estimatePendingCost : e.totalCost);
  const aap = _norm(e.serviceState) === PENDING_STATE || (cost != null && cost > 0);
  let source = null;
  if (relay && aap) source = 'both';
  else if (relay) source = 'relay';
  else if (aap) source = 'aap';
  return { pending: relay || aap, source };
}

export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'submitted time unknown';
  const t = Math.max(0, ms);
  if (t < DAY_MS) return 'submitted ' + Math.floor(t / HOUR_MS) + 'h ' + Math.floor((t % HOUR_MS) / 60000) + 'm ago';
  return 'submitted ' + Math.floor(t / DAY_MS) + 'd ago';
}

export function formatDown(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const t = Math.max(0, ms);
  return Math.floor(t / DAY_MS) + 'd ' + Math.floor((t % DAY_MS) / HOUR_MS) + 'h';
}

export function formatMoney(n) {
  const v = _num(n);
  if (v == null) return '\u2014';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAsOf(iso) {
  const ms = _ms(iso);
  if (ms == null) return 'unknown';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function _item(row, entry, primary, sig, now, fleetSyncedMs) {
  const wrId = String(entry.workRequestId || '').trim();
  const submittedAt = primary && sig.source !== 'aap' ? String(row.estimateSubmittedAt || '') : '';
  const submittedMs = _ms(submittedAt);
  let amount = primary ? _num(row.estimateSubmittedAmount) : null;
  if (amount == null) amount = _num(primary ? row.estimatePendingCost : entry.totalCost);
  const createdMs = _ms(entry.created);
  const downMs = createdMs != null ? Math.max(0, now - createdMs) : null;
  let downText = formatDown(downMs);
  if (!downText && primary) downText = String(row.workDuration || '');
  const factEvidence = sig.source !== 'aap';
  const evidenceAt = factEvidence ? String(row.extractedAt || '') : (fleetSyncedMs != null ? new Date(fleetSyncedMs).toISOString() : '');
  const evidenceMs = _ms(evidenceAt);
  return {
    unitId: String(row.equipmentId || ''),
    unit: row,
    wrId,
    primary,
    vendor: String(entry.dealerName || entry.subVendor || entry.vendor || (primary ? '' : row.vendor) || ''),
    amount,
    submittedAt,
    submittedMs,
    ageText: formatAge(submittedMs != null ? now - submittedMs : null),
    downMs,
    downText,
    source: sig.source,
    evidenceAt,
    stale: evidenceMs != null && now - evidenceMs > STALE_MS,
    freshnessUnknown: evidenceMs == null,
    canEscalate: WR_UUID_RE.test(wrId) && !!_aaid(row),
  };
}

function _cmp(a, b) {
  const at = a.submittedMs != null; const bt = b.submittedMs != null;
  if (at !== bt) return at ? -1 : 1;
  if (at && a.submittedMs !== b.submittedMs) return a.submittedMs - b.submittedMs;
  if (!at) {
    const ad = a.downMs != null ? a.downMs : -1; const bd = b.downMs != null ? b.downMs : -1;
    if (ad !== bd) return bd - ad;
  }
  return a.unitId.localeCompare(b.unitId) || a.wrId.localeCompare(b.wrId);
}

/**
 * collectPendingEstimates(rows, { now, fleetSyncedAt }) -> { items, excludedDtna }
 * Walks each row's primary WR plus its planned/secondary WRs (deduped by WR id).
 */
export function collectPendingEstimates(rows, { now, fleetSyncedAt } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const syncedMs = _ms(fleetSyncedAt);
  const items = [];
  let excludedDtna = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const seen = new Set();
    const entries = [{ e: row, primary: true }];
    const extra = [row._plannedWRData].concat(Array.isArray(row._secondaryWRs) ? row._secondaryWRs : []);
    for (const e of extra) if (e && typeof e === 'object') entries.push({ e, primary: false });
    for (const { e, primary } of entries) {
      const id = String(e.workRequestId || '').trim().toLowerCase();
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      } else if (!primary) continue;
      if (!_isOpen(e)) continue;
      const sig = pendingSignal(e, { primary });
      if (!sig.pending) continue;
      if (isDtna(row, primary ? null : e)) { excludedDtna++; continue; }
      items.push(_item(row, e, primary, sig, t, syncedMs));
    }
  }
  items.sort(_cmp);
  return { items, excludedDtna };
}

function _freshHtml(it) {
  if (it.freshnessUnknown) return '<span class="pe-stale" title="No evidence time for this estimate">freshness unknown</span>';
  if (it.stale) return '<span class="pe-stale" title="Estimate data as of ' + escAttr(formatAsOf(it.evidenceAt)) + '">\u26A0 stale</span>';
  return '<span class="pe-fresh" title="Estimate data as of ' + escAttr(formatAsOf(it.evidenceAt)) + '">' + escAttr(formatAsOf(it.evidenceAt)) + '</span>';
}

const SOURCE_LABEL = { relay: 'Relay/offsite estimate', aap: 'AAP status / pending cost', both: 'Relay/offsite estimate + AAP' };

// ── Team merge (upgrade) ─────────────────────────────────────────────────────

export const OWNER_VALUES = ['mine', 'everyone', 'all'];
export const UNKNOWN = '__unknown__';
export const MISMATCH_LABEL = '\u2714 Done offsite \u00B7 RG WO still open';
export const SORT_KEYS = ['default', 'mismatch', 'updated', 'total', 'unit', 'fas'];
const SRC_LABEL = { rg: 'RG', decisiv: 'Decisiv', both: 'both' };
const VENDOR_OPTIONS = [['volvo', 'Volvo'], ['paccar', 'PACCAR'], ['other', 'Other']];

const _lc = (s) => String(s == null ? '' : s).trim().toLowerCase();
const _str = (s) => (s == null ? '' : String(s).trim());

// Volvo / PACCAR from the Decisiv host of the unit's offsite URL, else the vendor text.
function _vendorKindOfUnit(unit) {
  const u = unit || {};
  for (const k of ['offsiteShopEventUrl', 'savedOffsiteUrl', 'asistSrUrl']) {
    const s = String(u[k] || '');
    if (/^https?:\/\/volvopg\.asist\.decisiv\.net\//i.test(s)) return 'volvo';
    if (/^https?:\/\/(pssmfleet|paccarpg)\.decisiv\.net\//i.test(s)) return 'paccar';
  }
  const toks = _norm(u.vendor).split('_');
  if (toks.includes('VOLVO')) return 'volvo';
  if (['KENWORTH', 'PETERBILT', 'PACCAR'].some((k) => toks.includes(k))) return 'paccar';
  return 'other';
}

/** 'Xh ago' (under a day) / 'Xd ago' / '—' when unknown. */
export function formatUpdated(ms, now) {
  if (ms == null || !Number.isFinite(ms)) return '\u2014';
  const t = Math.max(0, (Number.isFinite(now) ? now : Date.now()) - ms);
  if (t < DAY_MS) return Math.floor(t / HOUR_MS) + 'h ago';
  return Math.floor(t / DAY_MS) + 'd ago';
}

function _mmdd(v) {
  const ms = _ms(v);
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '/' + p(d.getDate());
}

function _offsiteFields(offsite, now) {
  const o = offsite && typeof offsite === 'object' ? offsite : {};
  const stageBits = [_str(o.stage), _str(o.stageStatus)].filter(Boolean).join(' \u00B7 ');
  const since = _mmdd(o.stageSince);
  const updatedAt = _str(o.updatedAt);
  const updatedMs = _ms(updatedAt);
  return {
    fleetStatus: _str(o.fleetStatus),
    repairStatus: _str(o.repairStatus) || _str(o.stageStatus),
    offsiteStageText: stageBits ? stageBits + (since ? ' since ' + since : '') : '',
    total: _num(o.total),
    updatedAt,
    updatedMs,
    updatedText: formatUpdated(updatedMs, now),
  };
}

// Vendor WO of the WR this item lists: the primary WR -> the unit itself; a planned /
// secondary WR -> that entry (owning the unit's offsite per the _offsiteWrId rule).
function _vendorWoOfItem(it) {
  const unit = it.unit || {};
  const id = _lc(it.wrId);
  if (!it.primary && id) {
    const extra = [unit._plannedWRData].concat(Array.isArray(unit._secondaryWRs) ? unit._secondaryWRs : []);
    const e = extra.find((x) => x && typeof x === 'object' && _lc(x.workRequestId) === id);
    if (e) return vendorWoOf(e, unit);
  }
  return vendorWoOf(unit);
}

function _teamUnit(r) {
  const wrId = _str(r.workRequestId);
  const url = _str(r.offsiteShopEventUrl);
  return {
    equipmentId: _str(r.equipmentId),
    workRequestId: wrId,
    serviceUrl: _str(r.serviceUrl),
    assetUrl: _str(r.assetUrl),
    aaid: _str(r.aaid),
    vendor: _str(r.vendor),
    created: _str(r.created),
    offsiteShopEventUrl: url,
    vendorWorkOrderId: _str(r.vendorWorkOrderId),
    estimatePendingCost: _num(r.rgPendingCost),
    domicileSite: _str(r.domicileSite),
    _offsiteWrId: url && wrId ? wrId : '',
  };
}

function _teamItem(r, now, asOf) {
  const unit = _teamUnit(r);
  const off = r.offsite && typeof r.offsite === 'object' ? r.offsite : {};
  const createdMs = _ms(unit.created);
  const downMs = createdMs != null ? Math.max(0, now - createdMs) : null;
  const evidenceAt = _str(off.scrapedAt) || _str(asOf);
  const evidenceMs = _ms(evidenceAt);
  return {
    unitId: unit.equipmentId,
    unit,
    wrId: unit.workRequestId,
    primary: true,
    vendor: _str(off.dealerName) || unit.vendor,
    amount: _num(r.rgPendingCost),
    submittedAt: '',
    submittedMs: null,
    ageText: formatAge(null),
    downMs,
    downText: formatDown(downMs),
    source: r.rgPending ? 'aap' : null,
    evidenceAt,
    stale: evidenceMs != null && now - evidenceMs > STALE_MS,
    freshnessUnknown: evidenceMs == null,
    canEscalate: WR_UUID_RE.test(unit.workRequestId) && !!_aaid(unit),
  };
}

/**
 * mergeTeamRows(v1Items, scanRows, { now, asOf }) -> overlay items (plan §1.3).
 * A v1 item and a scan row with the same WR id merge (the scan supplies offsite, FAS,
 * mine, flags); v1-only items are mine (they come from the user's own fleet slice);
 * scan-only rows become items with a fleet-row-like unit so Escalate works unchanged.
 */
export function mergeTeamRows(v1Items, scanRows, { now, asOf } = {}) {
  const t = Number.isFinite(now) ? now : Date.now();
  const scan = (Array.isArray(scanRows) ? scanRows : []).filter((r) => r && typeof r === 'object');
  const byWr = new Map(); const fasByEq = new Map();
  for (const r of scan) {
    const id = _lc(r.workRequestId);
    if (id && !byWr.has(id)) byWr.set(id, r);
    const eq = _str(r.equipmentId);
    if (eq && r.fas && !fasByEq.has(eq)) fasByEq.set(eq, _str(r.fas));
  }
  const used = new Set();
  const keys = new Set();
  const out = [];
  const uniq = (k) => { let x = k; let n = 2; while (keys.has(x)) x = k + '#' + (n++); keys.add(x); return x; };
  const finish = (it, r) => {
    const f = _offsiteFields(r && r.offsite, t);
    Object.assign(it, f);
    // Same order as the drafter (relay-action-draft collectFacts + _withOffsite): the WR's
    // own Decisiv estimate, then the scan row's estimate for this WR, then the RG Vendor WO.
    const own = _vendorWoOfItem(it);
    const fromScan = r ? vendorWoOf(_teamUnit(r)) : null;
    it.vendorWo = (own && own.kind === 'decisiv') ? own : ((fromScan && fromScan.kind === 'decisiv') ? fromScan : (own || fromScan));
    return it;
  };
  for (const v of Array.isArray(v1Items) ? v1Items : []) {
    if (!v || typeof v !== 'object') continue;
    const id = _lc(v.wrId);
    const r = id ? byWr.get(id) : null;
    const it = Object.assign({}, v);
    if (r && !used.has(r)) {
      used.add(r);
      it.key = uniq(r.key || 'wr:' + v.wrId);
      it.mine = r.mine === true;
      it.fas = _str(r.fas);
      // Main's own source (both = RG-pending AND offsite; decisiv = offsite only).
      it.src = SRC_LABEL[r.source] ? r.source : (r.offsite || r.offsiteShopEventUrl ? 'both' : 'rg');
      it.vendorKind = r.vendorKind || _vendorKindOfUnit(v.unit);
      it.offsiteDone = !!r.offsiteDone;
      it.statusMismatch = !!r.statusMismatch;
      it.notInRg = !!r.notInRg;
      out.push(finish(it, r));
    } else {
      it.key = uniq(v.wrId ? 'wr:' + v.wrId : 'unit:' + (v.unitId || ''));
      it.mine = true;
      it.fas = fasByEq.get(_str(v.unitId)) || '';
      it.src = 'rg';
      it.vendorKind = _vendorKindOfUnit(v.unit);
      it.offsiteDone = false;
      it.statusMismatch = false;
      it.notInRg = false;
      out.push(finish(it, null));
    }
  }
  for (const r of scan) {
    if (used.has(r)) continue;
    used.add(r);
    const it = _teamItem(r, t, asOf);
    it.key = uniq(r.key || (r.workRequestId ? 'wr:' + r.workRequestId : 'unit:' + it.unitId));
    it.mine = r.mine === true;
    it.fas = _str(r.fas);
    it.src = SRC_LABEL[r.source] ? r.source : (r.offsite || r.offsiteShopEventUrl ? 'decisiv' : 'rg');
    it.vendorKind = r.vendorKind || _vendorKindOfUnit(it.unit);
    it.offsiteDone = !!r.offsiteDone;
    it.statusMismatch = !!r.statusMismatch;
    it.notInRg = !!r.notInRg;
    out.push(finish(it, r));
  }
  return out;
}

// ── Filters / sort ───────────────────────────────────────────────────────────

export function defaultFilters() {
  return { owner: 'mine', source: '', fleetStatus: '', repairStatus: '', mismatch: false, vendor: '', fas: '' };
}

function _distinct(items, k) {
  const vals = new Set(); let unknown = false;
  for (const it of items) { const v = _str(it[k]); if (v) vals.add(v); else unknown = true; }
  const out = [...vals].sort((a, b) => a.localeCompare(b));
  if (unknown) out.push(UNKNOWN);
  return out;
}

/** Distinct sorted Fleet Status / Repair Status / FAS values (+ UNKNOWN when any item lacks one). */
export function filterOptions(items) {
  const list = Array.isArray(items) ? items : [];
  return { fleetStatus: _distinct(list, 'fleetStatus'), repairStatus: _distinct(list, 'repairStatus'), fas: _distinct(list, 'fas') };
}

function _valueMatch(want, have) {
  if (!want) return true; // Any: passes every row, unknown values included
  if (want === UNKNOWN) return !_str(have);
  return _str(have) === want;
}

/** AND of every set filter. '' = Any; UNKNOWN matches an empty value; Owner scopes mine / everyone / all. */
export function applyFilters(items, filters) {
  const f = Object.assign(defaultFilters(), filters || {});
  return (Array.isArray(items) ? items : []).filter((it) => {
    if (f.owner === 'mine' && it.mine !== true) return false;
    if (f.owner === 'everyone' && it.mine !== false) return false;
    if (f.source && it.src !== f.source) return false;
    if (!_valueMatch(f.fleetStatus, it.fleetStatus)) return false;
    if (!_valueMatch(f.repairStatus, it.repairStatus)) return false;
    if (!_valueMatch(f.fas, it.fas)) return false;
    if (f.vendor && it.vendorKind !== f.vendor) return false;
    if (f.mismatch && it.statusMismatch !== true) return false;
    return true;
  });
}

// Nulls / empties always sort last, whatever the direction.
function _nullsLast(a, b, dir, cmp) {
  const an = a == null || a === ''; const bn = b == null || b === '';
  if (an || bn) return an === bn ? 0 : (an ? 1 : -1);
  const c = cmp(a, b);
  return dir === 'desc' ? -c : c;
}

/** sortItems(items, { key, dir }): default = v1 order; mismatch = flagged first; updated, total, unit, fas. */
export function sortItems(items, { key, dir } = {}) {
  const k = SORT_KEYS.includes(key) ? key : 'default';
  const d = dir === 'desc' ? 'desc' : 'asc';
  const num = (a, b) => a - b;
  const txt = (a, b) => String(a).localeCompare(String(b));
  const by = {
    default: (a, b) => (d === 'desc' ? -_cmp(a, b) : _cmp(a, b)),
    mismatch: (a, b) => {
      const c = (b.statusMismatch === true ? 1 : 0) - (a.statusMismatch === true ? 1 : 0);
      return (d === 'desc' ? -c : c) || _cmp(a, b);
    },
    updated: (a, b) => _nullsLast(a.updatedMs, b.updatedMs, d, num) || _cmp(a, b),
    total: (a, b) => _nullsLast(a.total, b.total, d, num) || _cmp(a, b),
    unit: (a, b) => _nullsLast(a.unitId, b.unitId, d, txt) || _cmp(a, b),
    fas: (a, b) => _nullsLast(a.fas, b.fas, d, txt) || _cmp(a, b),
  }[k];
  return (Array.isArray(items) ? items : []).slice().sort(by);
}

// ── Filter bar ───────────────────────────────────────────────────────────────

function _select(name, label, current, opts) {
  return '<label class="pe-f"><span class="pe-f__k">' + escAttr(label) + '</span>' +
    '<select data-pe-filter="' + name + '" aria-label="' + escAttr(label) + '">' +
    opts.map(([v, t]) => '<option value="' + escAttr(v) + '"' + (v === current ? ' selected' : '') + '>' + escAttr(t) + '</option>').join('') +
    '</select></label>';
}

const _valOpts = (vals) => [['', 'Any']].concat((vals || []).map((v) => [v, v === UNKNOWN ? 'Unknown' : v]));

/** Owner segmented control + stackable filters (AND). counts: { mismatch, mine, everyone, all }. */
export function filterBarHtml(filters, options, counts) {
  const f = Object.assign(defaultFilters(), filters || {});
  const o = options || {};
  const c = counts || {};
  const ownerLabel = { mine: 'Mine', everyone: 'Everyone', all: 'All' };
  const owner = '<div class="pe-owner" role="group" aria-label="Owner">' + OWNER_VALUES.map((v) =>
    '<button type="button" data-pe-owner="' + v + '" aria-pressed="' + (f.owner === v ? 'true' : 'false') + '"' +
    (c[v] != null ? ' title="' + escAttr(String(c[v])) + ' rows"' : '') + '>' + ownerLabel[v] + '</button>').join('') + '</div>';
  return owner +
    _select('source', 'Source', f.source, [['', 'Any'], ['rg', 'RG'], ['decisiv', 'Decisiv'], ['both', 'both']]) +
    _select('fleetStatus', 'Fleet Status', f.fleetStatus, _valOpts(o.fleetStatus)) +
    _select('repairStatus', 'Repair Status', f.repairStatus, _valOpts(o.repairStatus)) +
    _select('vendor', 'Vendor', f.vendor, [['', 'Any']].concat(VENDOR_OPTIONS)) +
    _select('fas', 'FAS', f.fas, _valOpts(o.fas)) +
    '<label class="pe-f pe-f--mismatch"><input type="checkbox" data-pe-filter="mismatch"' + (f.mismatch ? ' checked' : '') + '> ' +
      MISMATCH_LABEL + ' (' + escAttr(String(c.mismatch || 0)) + ')</label>' +
    '<button type="button" class="pe-clear" data-pe-clear="1">Clear filters</button>';
}

// ── Rows / table ─────────────────────────────────────────────────────────────

const _dash = (s) => escAttr(_str(s) || '\u2014');

export function rowHtml(item) {
  const it = item || {};
  const why = it.canEscalate ? '' : (!WR_UUID_RE.test(String(it.wrId || '')) ? 'No Relay WR id for this work order' : 'No AAP asset id for this unit');
  const esc = '<button type="button" class="dp-escalate__btn dp-ra-btn pe-esc" data-pe-escalate="' + escAttr(it.key || it.wrId) + '"' +
    (it.canEscalate ? ' title="Escalate (MCS High Value Estimate)"' : ' disabled title="' + escAttr(why) + '"') + '>\u26A0 Escalate</button>';
  const submittedTitle = it.submittedAt ? 'Submitted ' + formatAsOf(it.submittedAt) : 'No submit time in the data';
  const badges = (it.statusMismatch ? '<span class="pe-badge pe-badge--mismatch" title="Repair status is complete offsite while the RG work order is still open">' +
      MISMATCH_LABEL + '</span>' : '') +
    (it.notInRg ? '<span class="pe-badge pe-badge--norg">Not in RG</span>' : '');
  const vw = vendorWoChipHtml(it.vendorWo);
  const stage = it.offsiteStageText ? '<div class="pe-sub2">' + escAttr(it.offsiteStageText) + '</div>' : '';
  return '<tr class="pe-row' + (it.stale ? ' pe-row--stale' : '') + (it.statusMismatch ? ' pe-row--mismatch' : '') + '" data-pe-wr="' + escAttr(it.wrId) + '"' +
      (it.key ? ' data-pe-key="' + escAttr(it.key) + '"' : '') + '>' +
    '<td><button type="button" class="pe-unit" data-pe-unit="' + escAttr(it.unitId) + '">' + escAttr(it.unitId) + '</button>' + badges + '</td>' +
    '<td>' + escAttr(it.vendor || '\u2014') + '</td>' +
    '<td>' + (vw || '\u2014') + '</td>' +
    '<td>' + escAttr(SRC_LABEL[it.src] || '\u2014') + '</td>' +
    '<td>' + _dash(it.fas) + '</td>' +
    '<td>' + _dash(it.fleetStatus) + '</td>' +
    '<td>' + _dash(it.repairStatus) + stage + '</td>' +
    '<td class="pe-amt">' + escAttr(formatMoney(it.total)) + '</td>' +
    '<td class="pe-amt">' + escAttr(formatMoney(it.amount)) + '</td>' +
    '<td title="' + escAttr(submittedTitle + ' \u00B7 ' + (SOURCE_LABEL[it.source] || '')) + '">' + escAttr(it.ageText) + '</td>' +
    '<td' + (it.updatedAt ? ' title="Updated ' + escAttr(formatAsOf(it.updatedAt)) + '"' : '') + '>' + escAttr(it.updatedText || '\u2014') + '</td>' +
    '<td>' + escAttr(it.downText || '\u2014') + '</td>' +
    '<td>' + _freshHtml(it) + '</td>' +
    '<td>' + esc + '</td>' +
  '</tr>';
}

export function metaHtml({ count, excludedDtna, asOf, cached, shown, total, mismatch, teamAsOf, scanning, teamCached, teamError } = {}) {
  const hasTeam = shown != null || total != null;
  let h = '<span class="pe-asof">as of ' + escAttr(formatAsOf(asOf)) + (cached ? ' (cached)' : '') + '</span>';
  if (hasTeam) h += ' \u00B7 <span class="pe-count">' + escAttr(String(shown || 0)) + ' shown of ' + escAttr(String(total || 0)) + '</span>';
  else h += ' \u00B7 <span class="pe-count">' + escAttr(String(count || 0)) + ' pending</span>';
  if (mismatch != null) h += ' \u00B7 <span class="pe-mismatch">' + escAttr(String(mismatch || 0)) + ' done offsite / RG open</span>';
  h += ' \u00B7 <span class="pe-dtna">' + escAttr(String(excludedDtna || 0)) + ' DTNA excluded</span>';
  if (teamAsOf) h += ' \u00B7 <span class="pe-team">team as of ' + escAttr(formatAsOf(teamAsOf)) + (teamCached ? ' (cached)' : '') + '</span>';
  if (teamError) h += ' \u00B7 <span class="pe-stale">team scan: ' + escAttr(teamError) + '</span>';
  if (scanning) h += ' \u00B7 <span class="pe-scanning">scanning\u2026</span>';
  return h;
}

const _th = (label, key, sort) => {
  if (!key) return '<th>' + label + '</th>';
  const s = sort || {};
  const on = s.key === key;
  const title = key === 'mismatch' ? 'Sort: ' + MISMATCH_LABEL + ' first' : 'Sort by ' + label;
  return '<th data-pe-sort="' + key + '"' + (on ? ' aria-sort="' + (s.dir === 'desc' ? 'descending' : 'ascending') + '"' : '') +
    ' title="' + escAttr(title) + '">' + label + (on ? (s.dir === 'desc' ? ' \u25BC' : ' \u25B2') : '') + '</th>';
};

export function listHtml(items, opts) {
  const o = opts || {};
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return o.filtered ? '<p class="pe-empty">No rows match the current filters.</p>'
      : '<p class="pe-empty">No pending estimates in your domiciles.</p>';
  }
  return '<table class="pe-table"><thead><tr>' +
    _th('Unit', 'unit', o.sort) + _th('Vendor / dealer') + _th('Vendor WO') + _th('Source') + _th('FAS', 'fas', o.sort) +
    _th('Fleet Status') + _th('Repair Status', 'mismatch', o.sort) + _th('Total', 'total', o.sort) +
    '<th>Est amount</th><th>Submitted</th>' + _th('Updated', 'updated', o.sort) + '<th>Down</th><th>Data</th><th></th>' +
    '</tr></thead><tbody>' + list.map(rowHtml).join('') + '</tbody></table>';
}

export function overlayHtml({ items, excludedDtna, asOf, cached, filtered, sort, meta } = {}) {
  const list = Array.isArray(items) ? items : [];
  return '<div id="pe-meta" class="pe-meta">' + metaHtml(Object.assign({ count: list.length, excludedDtna, asOf, cached }, meta || {})) + '</div>' +
    '<div id="pe-list" class="pe-list">' + listHtml(list, { filtered, sort }) + '</div>';
}

