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
 */

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

export function rowHtml(item) {
  const it = item || {};
  const why = it.canEscalate ? '' : (!WR_UUID_RE.test(String(it.wrId || '')) ? 'No Relay WR id for this work order' : 'No AAP asset id for this unit');
  const esc = '<button type="button" class="dp-escalate__btn dp-ra-btn pe-esc" data-pe-escalate="' + escAttr(it.wrId) + '"' +
    (it.canEscalate ? ' title="Escalate (MCS High Value Estimate)"' : ' disabled title="' + escAttr(why) + '"') + '>\u26A0 Escalate</button>';
  const submittedTitle = it.submittedAt ? 'Submitted ' + formatAsOf(it.submittedAt) : 'No submit time in the data';
  return '<tr class="pe-row' + (it.stale ? ' pe-row--stale' : '') + '" data-pe-wr="' + escAttr(it.wrId) + '">' +
    '<td><button type="button" class="pe-unit" data-pe-unit="' + escAttr(it.unitId) + '">' + escAttr(it.unitId) + '</button></td>' +
    '<td>' + escAttr(it.vendor || '\u2014') + '</td>' +
    '<td class="pe-amt">' + escAttr(formatMoney(it.amount)) + '</td>' +
    '<td title="' + escAttr(submittedTitle + ' \u00B7 ' + (SOURCE_LABEL[it.source] || '')) + '">' + escAttr(it.ageText) + '</td>' +
    '<td>' + escAttr(it.downText || '\u2014') + '</td>' +
    '<td>' + _freshHtml(it) + '</td>' +
    '<td>' + esc + '</td>' +
  '</tr>';
}

export function metaHtml({ count, excludedDtna, asOf, cached } = {}) {
  return '<span class="pe-asof">as of ' + escAttr(formatAsOf(asOf)) + (cached ? ' (cached)' : '') + '</span>' +
    ' \u00B7 <span class="pe-count">' + escAttr(String(count || 0)) + ' pending</span>' +
    ' \u00B7 <span class="pe-dtna">' + escAttr(String(excludedDtna || 0)) + ' DTNA excluded</span>';
}

export function listHtml(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '<p class="pe-empty">No pending estimates in your domiciles.</p>';
  return '<table class="pe-table"><thead><tr>' +
    '<th>Unit</th><th>Vendor / dealer</th><th>Est amount</th><th>Submitted</th><th>Down</th><th>Data</th><th></th>' +
    '</tr></thead><tbody>' + list.map(rowHtml).join('') + '</tbody></table>';
}

export function overlayHtml({ items, excludedDtna, asOf, cached } = {}) {
  const list = Array.isArray(items) ? items : [];
  return '<div id="pe-meta" class="pe-meta">' + metaHtml({ count: list.length, excludedDtna, asOf, cached }) + '</div>' +
    '<div id="pe-list" class="pe-list">' + listHtml(list) + '</div>';
}
