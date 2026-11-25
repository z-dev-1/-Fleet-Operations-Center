'use strict';
/**
 * ipc/autopilot.js — Fleet Autopilot V1 (read-only / shadow mode) IPC channels (§B12.1).
 *
 *   autopilot:status        dashboard status (no ap_* SQL while the master switch is OFF)
 *   autopilot:cases         { state?, domicile?, reason?, q?, limit?, offset?, V2: carrier?, scac?, vendor?, phase?,
 *                             downtimeMin?, downtimeMax?, priorityMin?, group?, aiPending?, tier?, sort? } -> { ok, total, items }
 *   autopilot:case          { caseId, eventsOffset? } -> { ok, case, runs, findings, findingsBySource, conflicts, events, eventsTotal,
 *                             steps, proposals, record, memory }
 *   autopilot:coverage      (no input) -> { ok, pass, reconcileOk, groups, queue, ai, sources } | { ok:true, enabled:false }
 *   autopilot:units         { coverage?, eligibility?, domicile?, scac?, q?, limit?, offset? } -> { ok, total, items }
 *   autopilot:deep-investigate { caseId } -> { ok:true, state:'QUEUED' } | { ok:false, code } (pushes autopilot:changed)
 *   autopilot:set-config    patch (plain object; writes.* -> LOCKED_V2)
 *   autopilot:control       { action: pause | resume | stop | run-now | enable-supervisor }
 *   autopilot:review        { caseId, decision: acknowledge | accept | rerun, note? }
 *   autopilot:harness-run   { runs? 20..30 (default 24) }
 *
 * Every input is validated here before any work; a rejected input returns
 * { ok:false, code:'INVALID_INPUT', field } and touches no store. Errors are
 * returned as { ok:false, code } and never thrown to the renderer. Logs carry
 * codes only. After the handlers are registered, autopilot.boot(ctx) registers
 * the supervised worker when the master switch, runState and the supervisor allow it.
 */

const { handle } = require('./_safe');
const { STATES, REASONS, normUnit } = require('../autopilot/constants');

let logger;
try { logger = require('../utils/logger')('ipc:autopilot'); } catch (_) { logger = { debug() {}, warn() {} }; }

const CASE_ID_RE = /^ap_[a-f0-9]{16}$/;
const DOMICILE_RE = /^[A-Z0-9]{2,10}$/;
const STATE_SET = new Set(Object.values(STATES));
const REASON_SET = new Set(Object.values(REASONS));
const ACTIONS = new Set(['pause', 'resume', 'stop', 'run-now', 'enable-supervisor']);
const DECISIONS = new Set(['acknowledge', 'accept', 'rerun']);
const Q_MAX = 40;
const NOTE_MAX = 500;
const OFFSET_MAX = 100000;
const HARNESS_RUNS = Object.freeze({ min: 20, max: 30, dflt: 24 });

// V2 (§10.1). The enum lists are literal copies (this file may require only the facade and
// constants); tests/autopilot-ipc.test.js pins them to classify.js / equipment.js / coverage.js.
const CASES_KEYS = new Set(['state', 'domicile', 'reason', 'q', 'limit', 'offset',
  'carrier', 'scac', 'vendor', 'phase', 'downtimeMin', 'downtimeMax', 'priorityMin', 'group', 'aiPending', 'tier', 'sort']);
const UNITS_KEYS = new Set(['coverage', 'eligibility', 'domicile', 'scac', 'q', 'limit', 'offset']);
const CARRIER_RE = /^[A-Za-z0-9 &.'-]{1,40}$/;
const SCAC_RE = /^[A-Z0-9]{2,10}$/;
const VENDOR_RE = /^[A-Za-z0-9 &.,'()/-]{1,60}$/;
const DOWNTIME_MAX = 3650;
const CANONICAL_STATUSES = Object.freeze(['available', 'down', 'in_repair', 'awaiting_parts', 'awaiting_estimate_approval', 'awaiting_vendor',
  'ready_for_pickup', 'in_transit', 'decommissioned', 'unknown']);
const STAGES = Object.freeze(['arrival', 'diagnosis', 'approval', 'repair', 'ready', 'none']);
const PHASE_SET = new Set([...CANONICAL_STATUSES, ...STAGES, 'unknown']);
const GROUPS = Object.freeze(['queued', 'reasoning', 'monitoring', 'waiting', 'review', 'resolved', 'paused', 'failed']);
const GROUP_SET = new Set(GROUPS);
const TIER_SET = new Set(['simple', 'standard', 'complex']);
const SORT_SET = new Set(['priority', 'downtime', 'queued', 'updated']);
const UNIT_COVERAGES = Object.freeze(['case_open', 'below_threshold', 'not_down', 'out_of_filter', 'feature_off', 'excluded', 'type_unknown', 'type_conflict', 'invalid']);
const UNIT_COVERAGE_SET = new Set(UNIT_COVERAGES);
const ELIGIBILITY_CLASSES = Object.freeze(['POWER_ELIGIBLE', 'EXCLUDED_TRAILER', 'EXCLUDED_HOSTLER', 'EXCLUDED_UNSUPPORTED', 'TYPE_UNKNOWN', 'TYPE_CONFLICT', 'INVALID_ROW']);
const ELIGIBILITY_SET = new Set(ELIGIBILITY_CLASSES);

function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _bad(field) { return { ok: false, code: 'INVALID_INPUT', field }; }

/** undefined -> dflt; an integer in [min, max] -> itself; anything else -> null. */
function _int(v, min, max, dflt) {
  if (v === undefined) return dflt;
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

const _given = (v) => v !== undefined && v !== null && v !== '';

/** A literal unit-prefix q (V1 rule): undefined -> absent; a string <= 40 after normUnit -> itself; else null. */
function _q(v) {
  if (!_given(v)) return undefined;
  if (typeof v !== 'string') return null;
  const q = normUnit(v);
  if (q.length > Q_MAX) return null;
  return q || undefined;   // matched as a literal prefix by the case store (substr, no LIKE: % and _ are plain characters)
}

/** -> { ok:true, filter } | INVALID_INPUT */
function validateCasesFilter(input) {
  const f = input == null ? {} : input;
  if (!_isObj(f)) return _bad('filter');
  for (const k of Object.keys(f)) if (!CASES_KEYS.has(k)) return _bad(k);
  const out = {};
  if (_given(f.state) && _given(f.group)) return _bad('group');
  if (f.state !== undefined && f.state !== null && f.state !== '') {
    if (typeof f.state !== 'string' || !STATE_SET.has(f.state)) return _bad('state');
    out.state = f.state;
  }
  if (f.domicile !== undefined && f.domicile !== null && f.domicile !== '') {
    if (typeof f.domicile !== 'string') return _bad('domicile');
    const d = normUnit(f.domicile);
    if (!DOMICILE_RE.test(d)) return _bad('domicile');
    out.domicile = d;
  }
  if (f.reason !== undefined && f.reason !== null && f.reason !== '') {
    if (typeof f.reason !== 'string' || !REASON_SET.has(f.reason)) return _bad('reason');
    out.reason = f.reason;
  }
  const q = _q(f.q);
  if (q === null) return _bad('q');
  if (q) out.q = q;
  // V2 keys (§10.1).
  if (_given(f.carrier)) {
    if (typeof f.carrier !== 'string' || !CARRIER_RE.test(f.carrier.trim())) return _bad('carrier');
    out.carrier = f.carrier.trim();
  }
  if (_given(f.scac)) {
    if (typeof f.scac !== 'string') return _bad('scac');
    const s = normUnit(f.scac);
    if (!SCAC_RE.test(s)) return _bad('scac');
    out.scac = s;
  }
  if (_given(f.vendor)) {
    if (typeof f.vendor !== 'string' || !VENDOR_RE.test(f.vendor.trim())) return _bad('vendor');
    out.vendor = f.vendor.trim();
  }
  if (_given(f.phase)) {
    if (typeof f.phase !== 'string' || !PHASE_SET.has(f.phase)) return _bad('phase');
    out.phase = f.phase;
  }
  for (const k of ['downtimeMin', 'downtimeMax']) {
    if (f[k] === undefined || f[k] === null) continue;
    if (typeof f[k] !== 'number' || !Number.isFinite(f[k]) || f[k] < 0 || f[k] > DOWNTIME_MAX) return _bad(k);
    out[k] = f[k];
  }
  if (out.downtimeMin !== undefined && out.downtimeMax !== undefined && out.downtimeMin > out.downtimeMax) return _bad('downtimeMax');
  if (f.priorityMin !== undefined && f.priorityMin !== null) {
    const p = _int(f.priorityMin, 0, 100, null);
    if (p == null) return _bad('priorityMin');
    out.priorityMin = p;
  }
  if (_given(f.group)) {
    if (typeof f.group !== 'string' || !GROUP_SET.has(f.group)) return _bad('group');
    out.group = f.group;
  }
  if (f.aiPending !== undefined && f.aiPending !== null) {
    if (typeof f.aiPending !== 'boolean') return _bad('aiPending');
    if (f.aiPending) out.aiPending = true;
  }
  if (_given(f.tier)) {
    if (typeof f.tier !== 'string' || !TIER_SET.has(f.tier)) return _bad('tier');
    out.tier = f.tier;
  }
  if (_given(f.sort)) {
    if (typeof f.sort !== 'string' || !SORT_SET.has(f.sort)) return _bad('sort');
    out.sort = f.sort;
  }
  const limit = _int(f.limit, 1, 200, 50);
  if (limit == null) return _bad('limit');
  const offset = _int(f.offset, 0, OFFSET_MAX, 0);
  if (offset == null) return _bad('offset');
  out.limit = limit;
  out.offset = offset;
  return { ok: true, filter: out };
}

/** autopilot:units -> { ok:true, filter } | INVALID_INPUT */
function validateUnitsFilter(input) {
  const f = input == null ? {} : input;
  if (!_isObj(f)) return _bad('filter');
  for (const k of Object.keys(f)) if (!UNITS_KEYS.has(k)) return _bad(k);
  const out = {};
  if (_given(f.coverage)) {
    if (typeof f.coverage !== 'string' || !UNIT_COVERAGE_SET.has(f.coverage)) return _bad('coverage');
    out.coverage = f.coverage;
  }
  if (_given(f.eligibility)) {
    if (typeof f.eligibility !== 'string' || !ELIGIBILITY_SET.has(f.eligibility)) return _bad('eligibility');
    out.eligibility = f.eligibility;
  }
  if (_given(f.domicile)) {
    if (typeof f.domicile !== 'string') return _bad('domicile');
    const d = normUnit(f.domicile);
    if (!DOMICILE_RE.test(d)) return _bad('domicile');
    out.domicile = d;
  }
  if (_given(f.scac)) {
    if (typeof f.scac !== 'string') return _bad('scac');
    const s = normUnit(f.scac);
    if (!SCAC_RE.test(s)) return _bad('scac');
    out.scac = s;
  }
  const q = _q(f.q);
  if (q === null) return _bad('q');
  if (q) out.q = q;
  const limit = _int(f.limit, 1, 200, 50);
  if (limit == null) return _bad('limit');
  const offset = _int(f.offset, 0, OFFSET_MAX, 0);
  if (offset == null) return _bad('offset');
  out.limit = limit;
  out.offset = offset;
  return { ok: true, filter: out };
}

/** autopilot:coverage takes no input: undefined, null or {} -> ok; anything else INVALID_INPUT. */
function validateCoverageInput(input) {
  if (input === undefined || input === null) return { ok: true };
  if (_isObj(input) && Object.keys(input).length === 0) return { ok: true };
  return _bad('input');
}

/** autopilot:deep-investigate -> { ok:true, caseId } | INVALID_INPUT */
function validateDeepInput(input) {
  if (!_isObj(input)) return _bad('caseId');
  for (const k of Object.keys(input)) if (k !== 'caseId') return _bad(k);
  if (typeof input.caseId !== 'string' || !CASE_ID_RE.test(input.caseId)) return _bad('caseId');
  return { ok: true, caseId: input.caseId };
}

/** -> { ok:true, caseId, eventsOffset } | INVALID_INPUT */
function validateCaseInput(input) {
  if (!_isObj(input)) return _bad('caseId');
  if (typeof input.caseId !== 'string' || !CASE_ID_RE.test(input.caseId)) return _bad('caseId');
  const eventsOffset = _int(input.eventsOffset, 0, OFFSET_MAX, 0);
  if (eventsOffset == null) return _bad('eventsOffset');
  return { ok: true, caseId: input.caseId, eventsOffset };
}

/** -> { ok:true, caseId, decision, note } | INVALID_INPUT */
function validateReviewInput(input) {
  if (!_isObj(input)) return _bad('caseId');
  if (typeof input.caseId !== 'string' || !CASE_ID_RE.test(input.caseId)) return _bad('caseId');
  if (typeof input.decision !== 'string' || !DECISIONS.has(input.decision)) return _bad('decision');
  let note;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string' || input.note.length > NOTE_MAX) return _bad('note');
    note = input.note;
  }
  return { ok: true, caseId: input.caseId, decision: input.decision, note };
}

/** -> { ok:true, action } | INVALID_INPUT */
function validateControlInput(input) {
  const action = _isObj(input) ? input.action : input;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return _bad('action');
  return { ok: true, action };
}

/** -> { ok:true, runs } | INVALID_INPUT */
function validateHarnessInput(input) {
  const i = input == null ? {} : input;
  if (!_isObj(i)) return _bad('runs');
  const runs = _int(i.runs, HARNESS_RUNS.min, HARNESS_RUNS.max, HARNESS_RUNS.dflt);
  if (runs == null) return _bad('runs');
  return { ok: true, runs };
}

/** Findings of the latest run grouped by source, plus the conflict groups. */
function _groupFindings(findings) {
  const bySource = {};
  const conflicts = {};
  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f) continue;
    const s = f.source || 'unknown';
    (bySource[s] || (bySource[s] = [])).push(f);
    if (f.conflict_group) (conflicts[f.conflict_group] || (conflicts[f.conflict_group] = [])).push(f.evidence_id);
  }
  return { bySource, conflicts };
}

function registerAutopilotIPC(ctx, deps) {
  const c = ctx || {};
  const ap = (deps && deps.autopilot) || require('../autopilot');

  const push = () => {
    try { if (typeof c.sendToWindow === 'function') c.sendToWindow('autopilot:changed', { at: Date.now(), source: 'user' }); } catch (_) {}
  };
  // Every handler resolves { ok:false, code } on an unexpected error instead of throwing.
  const guard = (channel, fn) => handle(channel, async (_e, arg) => {
    try { return await fn(arg); } catch (e) {
      const code = (e && typeof e.code === 'string' && e.code) || 'INTERNAL';
      try { logger.debug(channel + ' failed: ' + code); } catch (_) {}
      return { ok: false, code };
    }
  });

  guard('autopilot:status', () => ap.status());

  guard('autopilot:cases', (arg) => {
    const v = validateCasesFilter(arg);
    if (!v.ok) return v;
    return ap.listCases(v.filter);
  });

  guard('autopilot:case', (arg) => {
    const v = validateCaseInput(arg);
    if (!v.ok) return v;
    const r = ap.getCase(v.caseId, { eventsOffset: v.eventsOffset });
    if (!r || !r.ok || !r.case) return r;
    const g = _groupFindings(r.findings);
    return Object.assign({}, r, { findingsBySource: g.bySource, conflicts: g.conflicts });
  });

  guard('autopilot:set-config', (arg) => {
    if (!_isObj(arg)) return _bad('patch');
    const r = ap.setConfig(arg);
    if (r && r.ok) push();
    return r;
  });

  guard('autopilot:control', async (arg) => {
    const v = validateControlInput(arg);
    if (!v.ok) return v;
    const r = await ap.control(v.action);
    if (r && r.ok) push();
    return r;
  });

  guard('autopilot:review', (arg) => {
    const v = validateReviewInput(arg);
    if (!v.ok) return v;
    const r = ap.review(v.caseId, v.decision, v.note);
    if (r && r.ok) push();
    return r;
  });

  guard('autopilot:coverage', (arg) => {
    const v = validateCoverageInput(arg);
    if (!v.ok) return v;
    return ap.coverage();
  });

  guard('autopilot:units', (arg) => {
    const v = validateUnitsFilter(arg);
    if (!v.ok) return v;
    return ap.listUnits(v.filter);
  });

  guard('autopilot:deep-investigate', (arg) => {
    const v = validateDeepInput(arg);
    if (!v.ok) return v;
    const r = ap.deepInvestigate(v.caseId);
    if (r && r.ok) push();
    return r;
  });

  guard('autopilot:harness-run', async (arg) => {
    const v = validateHarnessInput(arg);
    if (!v.ok) return v;
    const r = await ap.harnessRun({ runs: v.runs });
    if (r && r.ok) push();
    return r;
  });

  try { ap.boot(c); } catch (e) {
    try { logger.warn('autopilot boot failed: ' + ((e && e.code) || (e && e.name) || 'error')); } catch (_) {}
  }
}

module.exports = {
  registerAutopilotIPC,
  validateCasesFilter, validateCaseInput, validateReviewInput, validateControlInput, validateHarnessInput,
  validateUnitsFilter, validateCoverageInput, validateDeepInput,
  ENUMS: Object.freeze({ CANONICAL_STATUSES, STAGES, GROUPS, UNIT_COVERAGES, ELIGIBILITY_CLASSES }),
};
