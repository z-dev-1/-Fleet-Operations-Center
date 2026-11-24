'use strict';
/**
 * ipc/autopilot.js — Fleet Autopilot V1 (read-only / shadow mode) IPC channels (§B12.1).
 *
 *   autopilot:status        dashboard status (no ap_* SQL while the master switch is OFF)
 *   autopilot:cases         { state?, domicile?, reason?, q?, limit?, offset? } -> { ok, total, items }
 *   autopilot:case          { caseId, eventsOffset? } -> { ok, case, runs, findings, findingsBySource, conflicts, events, eventsTotal }
 *   autopilot:set-config    patch (plain object; writes.* -> LOCKED_V1)
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

function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _bad(field) { return { ok: false, code: 'INVALID_INPUT', field }; }

/** undefined -> dflt; an integer in [min, max] -> itself; anything else -> null. */
function _int(v, min, max, dflt) {
  if (v === undefined) return dflt;
  return Number.isInteger(v) && v >= min && v <= max ? v : null;
}

/** -> { ok:true, filter } | INVALID_INPUT */
function validateCasesFilter(input) {
  const f = input == null ? {} : input;
  if (!_isObj(f)) return _bad('filter');
  const known = new Set(['state', 'domicile', 'reason', 'q', 'limit', 'offset']);
  for (const k of Object.keys(f)) if (!known.has(k)) return _bad(k);
  const out = {};
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
  if (f.q !== undefined && f.q !== null && f.q !== '') {
    if (typeof f.q !== 'string') return _bad('q');
    const q = normUnit(f.q);
    if (q.length > Q_MAX) return _bad('q');
    if (q) out.q = q;   // matched as a literal prefix by the case store (no LIKE)
  }
  const limit = _int(f.limit, 1, 200, 50);
  if (limit == null) return _bad('limit');
  const offset = _int(f.offset, 0, OFFSET_MAX, 0);
  if (offset == null) return _bad('offset');
  out.limit = limit;
  out.offset = offset;
  return { ok: true, filter: out };
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
};
