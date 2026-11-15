'use strict';
/**
 * repair-intel/wo-history.js — pure trend summary over one work request's Relay change
 * history (GET /serviceaggregates/{id}/history -> serviceChangeLogs[]).
 *
 * historyTrend(logs, { classify, now }) -> null for a missing/empty log, else a compact,
 * capped summary: ETC revisions (slip / pull-in), estimate $ revisions, approve/reject
 * decisions, vendor-assignment changes and time-in-state. Every entry carries its
 * provenance { at, by, source, side, snippet }. Decisiv-integrated dealers only emit
 * CREATE logs (createOnly) and many WRs never get an ETC field (etc.available false);
 * both are reported, never guessed. Malformed entries are skipped, never thrown.
 *
 * No I/O, no electron, no logging. `classify(requester)` is injected (wo-extract's
 * classifyRelayAuthor) so this module needs only the date helpers.
 */

const D = require('./wo-extract-dates');

const TREND_VERSION = 1;
const ETC_FIELDS = Object.freeze({
  'Expected completion date time': 'repairCompletion',
  'Expected technician arrival date time': 'techOnsite',
  'Expected start date time': 'start',
});
const VENDOR_FIELDS = Object.freeze(['Vendor', 'Supplier']);
const DECISION_STATES = Object.freeze({ ESTIMATE_APPROVED: 'approved', ESTIMATE_REJECTED: 'rejected' });
const REASON_FIELD_RE = /rejection reason|approval reason/i;
const WO_MESSAGE_RE = /work order/i;
const CAPS = Object.freeze({ etc: 20, estimate: 12, decisions: 12, vendor: 8, states: 20, seq: 20, snippet: 140, by: 60, reason: 120 });

function _str(v) { return v == null ? '' : String(v); }
function _clip(v, n) { const s = _str(v); return s.length > n ? s.slice(0, n) : s; }
function _iso(ms) { return ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString(); }
function _num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; }
function _tail(arr, n) { return arr.length > n ? arr.slice(arr.length - n) : arr; }
function _snippet(field, oldV, newV) {
  return _clip(field + ': ' + (oldV == null ? '(none)' : _str(oldV)) + ' -> ' + (newV == null ? '(none)' : _str(newV)), CAPS.snippet);
}

function _classifyWith(classify, requester) {
  let c = null;
  try { c = typeof classify === 'function' ? classify(requester) : null; } catch (_) { c = null; }
  return {
    source: c && c.source ? _str(c.source) : 'relay',
    side: c && c.side ? _str(c.side) : 'unknown',
  };
}

// Valid logs only, sorted by eventDateTime ascending (ties keep input order).
function _normalize(logs, classify) {
  const out = [];
  (Array.isArray(logs) ? logs : []).forEach((log, i) => {
    if (!log || typeof log !== 'object') return;
    const ms = D.parseTs(log.eventDateTime);
    if (ms == null) return;
    const who = _classifyWith(classify, log.requester);
    out.push({
      i, ms, at: _iso(ms),
      entity: _str(log.serviceEntityId),
      op: _str(log.operation).toUpperCase(),
      message: _str(log.message),
      prov: { at: _iso(ms), by: log.requester ? _clip(log.requester, CAPS.by) : null, source: who.source, side: who.side },
      details: (Array.isArray(log.serviceChangeDetails) ? log.serviceChangeDetails : [])
        .filter((d) => d && typeof d === 'object' && typeof d.field === 'string' && d.field),
    });
  });
  return out.sort((a, b) => (a.ms - b.ms) || (a.i - b.i));
}

function _etcRevision(L, det, kind) {
  const toMs = D.parseTs(det.newValue);
  if (toMs == null) return null;
  const fromMs = D.parseTs(det.oldValue);
  if (_str(det.oldValue) === _str(det.newValue) || (fromMs != null && fromMs === toMs)) return null;   // no-op
  const slipMs = fromMs == null ? null : toMs - fromMs;
  return Object.assign({
    field: det.field, kind,
    fromIso: _iso(fromMs), toIso: _iso(toMs), from: fromMs == null ? null : D.ymd(fromMs), to: D.ymd(toMs),
    slipMs, dir: fromMs == null ? 'set' : (slipMs > 0 ? 'slip' : 'pull-in'),
  }, L.prov, { snippet: _snippet(det.field, det.oldValue, det.newValue) });
}

/**
 * historyTrend(logs, { classify, now }) -> trend object | null (see module header).
 */
function historyTrend(logs, opts = {}) {
  if (!Array.isArray(logs) || !logs.length) return null;
  const list = _normalize(logs, opts.classify);
  if (!list.length) return null;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const etcRevs = [];
  const estRevs = [];
  const decisions = [];
  const vendorChanges = [];
  const woEntities = new Set();
  for (const L of list) if (L.entity && WO_MESSAGE_RE.test(L.message)) woEntities.add(L.entity);
  const openState = new Map();      // entity -> open state entry
  const states = [];
  let lastEstimate = null;

  for (const L of list) {
    let stateDecision = null;
    let reason = null;
    let reasonDet = null;
    for (const det of L.details) {
      const etcKind = ETC_FIELDS[det.field];
      if (etcKind) {
        const r = _etcRevision(L, det, etcKind);
        if (r) etcRevs.push(r);
      } else if (det.field === 'Estimate' && det.displayType === 'COST') {
        const to = _num(det.newValue);
        if (to == null || to === 0) continue;
        const from = _num(det.oldValue);
        if (from === to) continue;
        estRevs.push(Object.assign({ from, to }, L.prov, { snippet: _snippet(det.field, det.oldValue, det.newValue) }));
        lastEstimate = to;
      } else if (VENDOR_FIELDS.includes(det.field)) {
        if (_str(det.oldValue) === _str(det.newValue) || det.newValue == null) continue;
        vendorChanges.push(Object.assign({ field: det.field, from: det.oldValue == null ? null : _str(det.oldValue), to: _str(det.newValue), op: L.op || null },
          L.prov, { snippet: _snippet(det.field, det.oldValue, det.newValue) }));
      } else if (det.field === 'State') {
        const st = _str(det.newValue).trim();
        if (!st || st === _str(det.oldValue).trim()) continue;
        const prev = openState.get(L.entity);
        if (prev) { prev.leftAt = L.at; prev.ms = Math.max(0, L.ms - prev._ms); }
        const e = { entity: woEntities.has(L.entity) ? 'wo' : 'wr', state: st, enteredAt: L.at, leftAt: null, ms: null, _ms: L.ms };
        openState.set(L.entity, e);
        states.push(e);
        if (DECISION_STATES[st]) stateDecision = { outcome: DECISION_STATES[st], det };
      } else if (REASON_FIELD_RE.test(det.field) && det.newValue != null && _str(det.newValue).trim()) {
        reason = _clip(_str(det.newValue).trim(), CAPS.reason);
        reasonDet = det;
      }
    }
    if (stateDecision || L.op === 'SUBMIT_DECISION') {
      let outcome = stateDecision ? stateDecision.outcome : null;
      if (!outcome && reasonDet) outcome = /rejection/i.test(reasonDet.field) ? 'rejected' : 'approved';
      if (outcome) {
        const src = stateDecision ? stateDecision.det : reasonDet;
        decisions.push(Object.assign({ outcome, amount: lastEstimate, reason }, L.prov, { snippet: _snippet(src.field, src.oldValue, src.newValue) }));
      }
    }
  }
  for (const e of states) {
    if (e.leftAt == null) e.ms = Math.max(0, now - e._ms);
    delete e._ms;
  }

  const rc = etcRevs.filter((r) => r.kind === 'repairCompletion');
  const seq = [];
  if (rc.length && rc[0].fromIso) seq.push(rc[0].fromIso);
  for (const r of rc) if (seq[seq.length - 1] !== r.toIso) seq.push(r.toIso);
  const seqOut = _tail(seq, CAPS.seq);
  const slips = rc.filter((r) => r.dir === 'slip');
  const vendorOnly = vendorChanges.filter((v) => v.field === 'Vendor');

  return {
    v: TREND_VERSION,
    n: list.length,
    firstAt: list[0].at,
    lastAt: list[list.length - 1].at,
    createOnly: list.every((L) => L.op === 'CREATE'),
    etc: {
      available: etcRevs.length > 0,
      revisions: _tail(etcRevs, CAPS.etc),
      slipCount: slips.length,
      pullInCount: rc.filter((r) => r.dir === 'pull-in').length,
      seq: seqOut,
      firstIso: seqOut.length ? seqOut[0] : null,
      currentIso: seqOut.length ? seqOut[seqOut.length - 1] : null,
      totalSlipMs: slips.reduce((s, r) => s + r.slipMs, 0),
    },
    estimate: {
      revisions: _tail(estRevs, CAPS.estimate),
      decisions: _tail(decisions, CAPS.decisions),
      rejectCount: decisions.filter((d) => d.outcome === 'rejected').length,
      approveCount: decisions.filter((d) => d.outcome === 'approved').length,
    },
    vendor: {
      changes: _tail(vendorChanges, CAPS.vendor),
      current: vendorOnly.length ? vendorOnly[vendorOnly.length - 1].to : null,
    },
    states: _tail(states, CAPS.states),
  };
}

module.exports = { historyTrend, ETC_FIELDS, CAPS, TREND_VERSION };
