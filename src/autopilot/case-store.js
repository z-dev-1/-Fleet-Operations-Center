'use strict';
/**
 * autopilot/case-store.js — the ONLY writer of the ap_* tables (§B5).
 *
 * Write discipline (§B5.3):
 *   - sqlite_engine.tx() is BEGIN IMMEDIATE and NOT re-entrant. Every public
 *     write function opens exactly one transaction (through _tx) and never
 *     calls another public function.
 *   - Shared logic lives in private *_InTx helpers that never open one.
 *   - State changes only through _transitionInTx: lifecycle.canTransition plus
 *     the RESOLVED brand (resolution.isVerified). An illegal target throws
 *     ILLEGAL_TRANSITION / UNVERIFIED_RESOLUTION and the whole transaction,
 *     including column writes, rolls back.
 *   - SQLITE_BUSY: one retry after 250 ms, then ApError('STORE_BUSY').
 *   - All SQL is parameterized; write SQL names only ap_* tables.
 *
 * Plan R1: build-time columns (last_down_build_at / last_missing_build_at)
 * hold fleet-freshness lastOkAt. Plan R3: review_accepted_code.
 * Read functions (listCases, getCase, counts, getMeta, ...) use no transaction.
 */

const crypto = require('crypto');
const engine = require('../store/sqlite_engine');
const { STATES: S, LIMITS, RETENTION, ApError, normUnit } = require('./constants');
const { canTransition } = require('./lifecycle');
const resolution = require('./resolution');
const { strongestReason } = require('./priority');

const ISSUE_KEY = 'oos';

// Columns _updateCaseInTx may write. state / prev_state / state_changed_at /
// pause_reason / resolution_json change only through _transitionInTx.
const CASE_COLUMNS = new Set([
  'domicile', 'reasons_json', 'primary_reason', 'wo_ids_json', 'down_since', 'days_down',
  'last_down_build_at', 'repair_phase', 'last_vendor_update_at', 'last_vendor_update_source',
  'last_logged_update_at', 'eta_json', 'blockers_json', 'responsible_party', 'ai_findings_json',
  'recommendation_json', 'recommendation_hash', 'next_review_at', 'last_checked_at',
  'evidence_fp', 'ai_fp', 'cheap_fp', 'priority', 'attempts', 'next_attempt_at', 'last_error_code',
  'ai_defer_count', 'ai_reject_streak', 'ai_retry_at', 'review_status', 'review_note', 'reviewed_at',
  'review_accepted_code', 'lease_owner', 'lease_until', 'missing_syncs', 'last_missing_build_at',
]);
const CASE_JSON = ['reasons_json', 'wo_ids_json', 'eta_json', 'blockers_json', 'ai_findings_json', 'recommendation_json', 'resolution_json'];
const RUN_JSON = ['checkpoint_json', 'source_calls_json', 'plan_json'];
const RESUME_OUTCOMES = ['abandoned', 'aborted', 'deferred'];
const RESUME_STEPS = new Set(['evidence_done', 'ai_pending', 'analysis_done']);
const OPEN_ACTIVE = new Set([S.INVESTIGATING, S.ANALYZING]);

let _seq = 0;

// ── small helpers (no transactions) ─────────────────────────────────────────

function _now(m) { return m && Number.isFinite(m.now) ? m.now : Date.now(); }
function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _newId(prefix, parts) {
  _seq = (_seq + 1) % 1e9;
  return prefix + _sha1(parts.join('|') + '|' + _seq + '|' + crypto.randomBytes(4).toString('hex')).slice(0, 16);
}
function _v(x) {
  if (x === undefined) return null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (x !== null && typeof x === 'object') return JSON.stringify(x);
  return x;
}
function _json(x) { return x == null ? null : (typeof x === 'string' ? x : JSON.stringify(x)); }
function _parse(s) { if (s == null) return null; try { return JSON.parse(s); } catch (_) { return null; } }
function _get(sql, ...a) { return engine.prepare(sql).get(...a.map(_v)); }
function _all(sql, ...a) { return engine.prepare(sql).all(...a.map(_v)); }
function _run(sql, ...a) { return engine.prepare(sql).run(...a.map(_v)); }
function _isBusy(e) {
  const s = String((e && e.code) || '') + ' ' + String((e && e.errstr) || '') + ' ' + String((e && e.message) || '');
  return /SQLITE_BUSY|database is locked/i.test(s);
}
function _sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// The single transaction entry point for every public write function.
function _tx(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return engine.tx(fn);
    } catch (e) {
      if (!_isBusy(e)) throw e;
      if (attempt >= 1) throw new ApError('STORE_BUSY');
      _sleepSync(250);
    }
  }
}

function _reasonCodes(reasons) {
  return (reasons || []).map((r) => (r && typeof r === 'object' ? r.code : r)).filter(Boolean);
}
function _sameCodeSet(a, b) {
  const x = new Set(a); const y = new Set(b);
  if (x.size !== y.size) return false;
  for (const c of x) if (!y.has(c)) return false;
  return true;
}
function _defaultIsDown(row) {
  return String((row && (row.lifecycleState || row.atsState)) || '').toLowerCase().includes('unavail');
}
function _parseCase(row) {
  if (!row) return null;
  const out = Object.assign({}, row);
  for (const c of CASE_JSON) out[c.replace(/_json$/, '')] = _parse(row[c]);
  return out;
}
function _parseRun(row) {
  if (!row) return null;
  const out = Object.assign({}, row);
  for (const c of RUN_JSON) out[c.replace(/_json$/, '')] = _parse(row[c]);
  return out;
}

// ── private *_InTx helpers (never open a transaction) ───────────────────────

function _appendEventInTx(ev) {
  let detail = ev.detail == null ? null : JSON.stringify(ev.detail);
  if (detail && detail.length > LIMITS.eventDetailMaxBytes) detail = JSON.stringify({ truncated: true });
  _run('INSERT INTO ap_event (case_id, at, kind, from_state, to_state, actor, reason_code, detail_json, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ev.caseId == null ? null : ev.caseId, ev.at, ev.kind, ev.from == null ? null : ev.from, ev.to == null ? null : ev.to,
    ev.actor || 'autopilot', ev.reason == null ? null : String(ev.reason), detail, ev.runId == null ? null : ev.runId);
}

function _updateCaseInTx(caseId, fields, now) {
  const keys = Object.keys(fields || {});
  if (!keys.length) return 0;
  const sets = [];
  const vals = [];
  for (const k of keys) {
    if (!CASE_COLUMNS.has(k)) throw new ApError('INVALID_COLUMN', k);
    sets.push(k + ' = ?');
    vals.push(k.endsWith('_json') ? _json(fields[k]) : fields[k]);
  }
  sets.push('updated_at = ?', 'version = version + 1');
  vals.push(now, caseId);
  return _run('UPDATE ap_case SET ' + sets.join(', ') + ' WHERE case_id = ?', ...vals).changes;
}

function _transitionInTx(caseId, to, meta) {
  const m = meta || {};
  const cur = _get('SELECT state FROM ap_case WHERE case_id = ?', caseId);
  if (!cur) throw new ApError('NOT_FOUND', caseId);
  if (!canTransition(cur.state, to)) throw new ApError('ILLEGAL_TRANSITION', cur.state + '->' + to);
  const now = _now(m);
  if (to === S.RESOLVED) {
    if (!resolution.isVerified(m.resolution)) throw new ApError('UNVERIFIED_RESOLUTION');
    _run(`UPDATE ap_case SET state = ?, prev_state = ?, pause_reason = NULL, state_changed_at = ?, resolution_json = ?,
          review_accepted_code = NULL, lease_owner = NULL, lease_until = NULL, updated_at = ?, version = version + 1 WHERE case_id = ?`,
    to, cur.state, now, JSON.stringify(resolution.payloadOf(m.resolution)), now, caseId);
  } else {
    const pause = to === S.PAUSED ? (m.pauseReason || m.reason || null) : null;
    _run('UPDATE ap_case SET state = ?, prev_state = ?, pause_reason = ?, state_changed_at = ?, updated_at = ?, version = version + 1 WHERE case_id = ?',
      to, cur.state, pause, now, now, caseId);
  }
  _appendEventInTx({ caseId, at: now, kind: 'transition', from: cur.state, to, actor: m.actor, reason: m.reason, detail: m.detail, runId: m.runId });
  return cur.state;
}

function _writeRunInTx(run) {
  _run('INSERT INTO ap_run (run_id, case_id, started_at, trigger, step, resumed_from, job_id, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    run.runId, run.caseId, run.startedAt, run.trigger, run.step || 'evidence', run.resumedFrom || null, run.jobId || null, _json(run.plan));
}

function _closeRunInTx(runId, run, now) {
  if (!runId) return 0;
  const r = run || {};
  return _run(`UPDATE ap_run SET ended_at = ?, step = 'done', outcome = ?, ai_status = ?, ai_request_id = ?, ai_latency_ms = ?,
       ai_lane = ?, ai_model = ?, ai_isolated = ?, error_code = ?, cpu_ms = ?, duration_ms = ?,
       source_calls_json = COALESCE(?, source_calls_json), plan_json = COALESCE(?, plan_json), job_id = COALESCE(?, job_id)
       WHERE run_id = ?`,
  now, r.outcome || null, r.aiStatus || null, r.aiRequestId || null, r.aiLatencyMs == null ? null : r.aiLatencyMs,
  r.aiLane || null, r.aiModel || null, r.aiIsolated == null ? null : (r.aiIsolated ? 1 : 0), r.errorCode || null,
  r.cpuMs == null ? null : r.cpuMs, r.durationMs == null ? null : r.durationMs,
  _json(r.sourceCalls), _json(r.plan), r.jobId || null, runId).changes;
}

function _evidenceId(it) {
  return 'ev_' + _sha1([it.source, it.sourceRef || '', it.field, String(it.value == null ? '' : it.value), it.observedAt == null ? '' : it.observedAt].join('|')).slice(0, 12);
}

function _writeFindingsInTx(caseId, runId, items) {
  let n = 0;
  for (const it of items || []) {
    if (!it || !it.source || !it.field || it.retrievedAt == null || !it.freshness || !Number.isFinite(it.confidence) || !it.trust) {
      throw new ApError('INVALID_FINDING', it && it.field ? String(it.field) : '');
    }
    const value = it.value == null ? null : (typeof it.value === 'string' ? it.value : JSON.stringify(it.value)).slice(0, LIMITS.findingValueMaxChars);
    const flags = Array.isArray(it.flags) ? it.flags.join(',') : (it.flags || null);
    _run(`INSERT INTO ap_finding (case_id, run_id, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
          freshness, confidence, trust, authority_tag, conflict_group, flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    caseId, runId, it.evidenceId || _evidenceId(it), it.source, it.sourceRef || null, it.field, value,
    it.observedAt == null ? null : it.observedAt, it.retrievedAt, it.freshness, it.confidence, it.trust,
    it.authorityTag || null, it.conflictGroup || null, flags);
    n++;
  }
  return n;
}

function _copyFindingsInTx(fromRunId, toRunId) {
  return _run(`INSERT INTO ap_finding (case_id, run_id, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
        freshness, confidence, trust, authority_tag, conflict_group, flags)
      SELECT case_id, ?, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
        freshness, confidence, trust, authority_tag, conflict_group, flags FROM ap_finding WHERE run_id = ? ORDER BY id`,
  toRunId, fromRunId).changes;
}

function _getMetaInTx(key) {
  const r = _get('SELECT value FROM ap_meta WHERE key = ?', key);
  return r ? r.value : null;
}
function _setMetaInTx(key, value) {
  _run('INSERT INTO ap_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}
function _bumpMetaCounterInTx(key, n) {
  const cur = parseInt(_getMetaInTx(key) || '0', 10) || 0;
  const next = cur + (n == null ? 1 : n);
  _setMetaInTx(key, next);
  return next;
}

// R3: a NEEDS_REVIEW request from the sweep. An accepted request with the same
// code is skipped; a different code clears the accepted code.
function _requestReviewInTx(c, code, now, out) {
  if (c.review_status === 'accepted' && c.review_accepted_code === code) { out.skippedAccepted.push(c.case_id); return; }
  if (c.review_accepted_code != null) _updateCaseInTx(c.case_id, { review_accepted_code: null, review_status: 'none' }, now);
  if (c.state === S.NEEDS_REVIEW || !canTransition(c.state, S.NEEDS_REVIEW)) return;
  _transitionInTx(c.case_id, S.NEEDS_REVIEW, { reason: code, now });
  out.review.push({ caseId: c.case_id, code });
}

// ── public write functions (exactly one transaction each) ───────────────────

/**
 * upsertDetected(candidate, opts) -> { caseId, created, state }
 * A candidate with openedBy null only tags an existing open case ({caseId:null} when none).
 * candidate: { unitId, domicile, reasons[{code,...}], openedBy, daysDown, downSince, eta, buildAtMs, priority, woIds }
 * opts: { paused, now }
 */
function upsertDetected(candidate, opts) {
  const c = candidate || {};
  const o = opts || {};
  const now = _now(o);
  const unit = normUnit(c.unitId);
  const reasons = Array.isArray(c.reasons) ? c.reasons.map((r) => (typeof r === 'string' ? { code: r } : r)) : null;
  return _tx(() => {
    let open = _get("SELECT * FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state <> 'RESOLVED'", unit, ISSUE_KEY);
    if (!open) {
      // Tag-only candidate (no opening rule applies) and no open case: nothing to do.
      if (c.openedBy == null) return { caseId: null, created: false, state: null };
      if (!unit || !c.openedBy || !reasons || !reasons.length || !Number.isFinite(now)) throw new ApError('INVALID_CASE');
      const prior = _get("SELECT case_id FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state = 'RESOLVED' ORDER BY state_changed_at DESC LIMIT 1", unit, ISSUE_KEY);
      const caseId = _newId('ap_', [unit, ISSUE_KEY, now]);
      const info = _run(`INSERT OR IGNORE INTO ap_case (case_id, unit_id, domicile, issue_key, state, state_changed_at, opened_by,
            reasons_json, primary_reason, wo_ids_json, down_since, days_down, last_down_build_at, eta_json, priority,
            prior_case_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      caseId, unit, c.domicile ? normUnit(c.domicile) : null, ISSUE_KEY, S.DETECTED, now, c.openedBy,
      JSON.stringify(reasons), strongestReason(reasons), _json(c.woIds),
      Number.isFinite(c.downSince) ? c.downSince : null, Number.isFinite(c.daysDown) ? c.daysDown : null,
      Number.isFinite(c.buildAtMs) ? c.buildAtMs : null, _json(c.eta), Number.isFinite(c.priority) ? c.priority : 0,
      prior ? prior.case_id : null, now, now);
      if (info.changes > 0) {
        _appendEventInTx({ caseId, at: now, kind: 'transition', from: null, to: S.DETECTED, reason: c.openedBy, detail: { reasons: _reasonCodes(reasons) } });
        let state = S.DETECTED;
        if (!o.paused) { _transitionInTx(caseId, S.QUEUED, { reason: 'new', now }); state = S.QUEUED; }
        return { caseId, created: true, state };
      }
      // A concurrent path created the open case: continue as an update.
      open = _get("SELECT * FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state <> 'RESOLVED'", unit, ISSUE_KEY);
      if (!open) throw new ApError('INVALID_CASE');
    }
    const f = {};
    if (reasons && reasons.length) {
      const prev = _reasonCodes(_parse(open.reasons_json));
      const next = _reasonCodes(reasons);
      if (!_sameCodeSet(prev, next)) {
        f.reasons_json = reasons;
        f.primary_reason = strongestReason(reasons);
        _appendEventInTx({ caseId: open.case_id, at: now, kind: 'detection', reason: 'reasons_changed', detail: { from: prev, to: next } });
      }
    }
    if (Number.isFinite(c.daysDown) && c.daysDown !== open.days_down) f.days_down = c.daysDown;
    if (Number.isFinite(c.downSince) && c.downSince !== open.down_since) f.down_since = c.downSince;
    if (c.eta !== undefined && _json(c.eta) !== open.eta_json) f.eta_json = c.eta;
    _updateCaseInTx(open.case_id, f, now);
    return { caseId: open.case_id, created: false, state: open.state };
  });
}

/** transition(caseId, to, meta{reason, actor, resolution, pauseReason, detail, runId, now}) -> previous state */
function transition(caseId, to, meta) {
  return _tx(() => _transitionInTx(caseId, to, meta));
}

/**
 * persistRun(caseId, runId, fields, targetState, meta) -> { from, to }
 * One commit: column writes, optional transition, run close, optional event.
 * meta: { run:{outcome, aiStatus, ...}, reason, actor, resolution, pauseReason, event:{kind, reason, detail}, now }
 */
function persistRun(caseId, runId, fields, targetState, meta) {
  const m = meta || {};
  const now = _now(m);
  return _tx(() => {
    const cur = _get('SELECT state FROM ap_case WHERE case_id = ?', caseId);
    if (!cur) throw new ApError('NOT_FOUND', caseId);
    const f = Object.assign({}, fields || {});
    if (!(m.run && m.run.outcome === 'deferred')) f.ai_defer_count = 0;
    _updateCaseInTx(caseId, f, now);
    let to = cur.state;
    if (targetState && targetState !== cur.state) {
      _transitionInTx(caseId, targetState, { reason: m.reason, actor: m.actor, resolution: m.resolution, pauseReason: m.pauseReason, detail: m.detail, runId, now });
      to = targetState;
    }
    _closeRunInTx(runId, m.run, now);
    if (m.event && m.event.kind) {
      _appendEventInTx({ caseId, at: now, kind: m.event.kind, actor: m.actor, reason: m.event.reason, detail: m.event.detail, runId });
    }
    return { from: cur.state, to };
  });
}

/**
 * reserveAiCallAndMarkPending(runId, date, cap, fp, meta) -> boolean
 * Increments ai_calls:<date> only below cap and writes checkpoint {step:'ai_pending', fp} in the same commit.
 */
function reserveAiCallAndMarkPending(runId, date, cap, fp, meta) {
  const now = _now(meta);
  return _tx(() => {
    const key = 'ai_calls:' + date;
    const used = parseInt(_getMetaInTx(key) || '0', 10) || 0;
    if (!(used < cap)) return false;
    _bumpMetaCounterInTx(key, 1);
    _run('UPDATE ap_run SET checkpoint_json = ? WHERE run_id = ?', JSON.stringify({ step: 'ai_pending', fp, at: now }), runId);
    return true;
  });
}

/**
 * sweepResolution({ rowsByUnit: Map(normUnit -> row), fleetMeta:{source, syncedAt, buildAtMs, isDown}, now })
 * One transaction over all open cases (plan R1 build-time rules, R3 accepted codes).
 * Cases in INVESTIGATING / ANALYZING are left to their own run.
 */
function sweepResolution(input) {
  const i = input || {};
  const rows = i.rowsByUnit instanceof Map ? i.rowsByUnit : new Map();
  const meta = i.fleetMeta || {};
  const isDown = typeof meta.isDown === 'function' ? meta.isDown : _defaultIsDown;
  const buildAt = Number.isFinite(meta.buildAtMs) ? meta.buildAtMs : null;
  const now = _now(i);
  return _tx(() => {
    const out = { resolved: [], review: [], missing: [], skippedAccepted: [], updated: 0 };
    const open = _all("SELECT * FROM ap_case WHERE state <> 'RESOLVED' ORDER BY created_at");
    for (const c of open) {
      if (OPEN_ACTIVE.has(c.state)) continue;
      const row = rows.get(c.unit_id);
      if (!row) {
        if (buildAt == null || !(buildAt > (c.last_missing_build_at || 0))) continue;
        const n = (c.missing_syncs || 0) + 1;
        _updateCaseInTx(c.case_id, { missing_syncs: n, last_missing_build_at: buildAt }, now);
        out.updated++;
        out.missing.push(c.case_id);
        if (n >= LIMITS.missingBuilds) _requestReviewInTx(Object.assign({}, c, { missing_syncs: n }), 'unit_missing', now, out);
        continue;
      }
      const f = {};
      if (c.missing_syncs) f.missing_syncs = 0;
      if (c.last_missing_build_at != null) f.last_missing_build_at = null;
      if (isDown(row)) {
        if (buildAt != null && !(c.last_down_build_at >= buildAt)) f.last_down_build_at = Math.max(c.last_down_build_at || 0, buildAt);
        if (c.review_accepted_code != null) { f.review_accepted_code = null; f.review_status = 'none'; }
        if (Object.keys(f).length) { _updateCaseInTx(c.case_id, f, now); out.updated++; }
        continue;
      }
      if (Object.keys(f).length) { _updateCaseInTx(c.case_id, f, now); out.updated++; }
      const r = resolution.verifyResolution(c, row, Object.assign({}, meta, { isDown }), now);
      if (r && r.token) {
        if (canTransition(c.state, S.RESOLVED)) {
          _transitionInTx(c.case_id, S.RESOLVED, { reason: 'resolved', resolution: r.token, detail: resolution.payloadOf(r.token), now });
          out.resolved.push(c.case_id);
        }
      } else if (r && r.review) {
        _requestReviewInTx(c, r.review, now, out);
      }
    }
    return out;
  });
}

/** pauseCases(caseIds, pauseReason, meta) -> [caseId moved] */
function pauseCases(caseIds, pauseReason, meta) {
  const now = _now(meta);
  const actor = meta && meta.actor;
  return _tx(() => {
    const moved = [];
    for (const id of caseIds || []) {
      const c = _get('SELECT state FROM ap_case WHERE case_id = ?', id);
      if (!c || c.state === S.PAUSED || !canTransition(c.state, S.PAUSED)) continue;
      _transitionInTx(id, S.PAUSED, { reason: pauseReason, pauseReason, actor, now });
      moved.push(id);
    }
    return moved;
  });
}

/**
 * requeueCases({ caseIds?, pauseReasons?, trigger, nextAttemptAt, actor, now }) -> [caseId moved]
 * Either explicit ids, or every PAUSED case whose pause_reason is listed.
 */
function requeueCases(opts) {
  const o = opts || {};
  const now = _now(o);
  return _tx(() => {
    let ids = Array.isArray(o.caseIds) ? o.caseIds.slice() : [];
    if (!ids.length && Array.isArray(o.pauseReasons) && o.pauseReasons.length) {
      const ph = o.pauseReasons.map(() => '?').join(', ');
      ids = _all("SELECT case_id FROM ap_case WHERE state = 'PAUSED' AND pause_reason IN (" + ph + ')', ...o.pauseReasons).map((r) => r.case_id);
    }
    const moved = [];
    for (const id of ids) {
      const c = _get('SELECT state FROM ap_case WHERE case_id = ?', id);
      if (!c || !canTransition(c.state, S.QUEUED)) continue;
      _updateCaseInTx(id, { next_attempt_at: Number.isFinite(o.nextAttemptAt) ? o.nextAttemptAt : null }, now);
      _transitionInTx(id, S.QUEUED, { reason: o.trigger || 'requeue', actor: o.actor, now });
      moved.push(id);
    }
    return moved;
  });
}

/** lease(caseId, owner, until, meta) -> true when taken (free, expired or already ours). */
function lease(caseId, owner, until, meta) {
  const now = _now(meta);
  return _tx(() => _run(`UPDATE ap_case SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE case_id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
  owner, until, now, caseId, owner, now).changes > 0);
}

/** openRun({ caseId, trigger, resumedFrom, jobId, plan, now }) -> runId */
function openRun(opts) {
  const o = opts || {};
  const now = _now(o);
  const runId = _newId('run_', [o.caseId, now]);
  _tx(() => _writeRunInTx({ runId, caseId: o.caseId, startedAt: now, trigger: o.trigger || 'scheduled', resumedFrom: o.resumedFrom, jobId: o.jobId, plan: o.plan }));
  return runId;
}

/** writeCheckpoint(runId, checkpoint, extra{plan, sourceCalls, step}) — checkpoint <= 64 KB. */
function writeCheckpoint(runId, checkpoint, extra) {
  const e = extra || {};
  const cp = checkpoint == null ? null : JSON.stringify(checkpoint);
  if (cp && cp.length > LIMITS.checkpointMaxBytes) throw new ApError('CHECKPOINT_TOO_LARGE');
  return _tx(() => _run(`UPDATE ap_run SET checkpoint_json = COALESCE(?, checkpoint_json), plan_json = COALESCE(?, plan_json),
      source_calls_json = COALESCE(?, source_calls_json), step = COALESCE(?, step) WHERE run_id = ?`,
  cp, _json(e.plan), _json(e.sourceCalls), e.step || null, runId).changes > 0);
}

/** writeFindings(caseId, runId, items) -> rows written */
function writeFindings(caseId, runId, items) {
  return _tx(() => _writeFindingsInTx(caseId, runId, items));
}

/**
 * copyRunForResume(fromRunId, toRunId, meta) -> parsed checkpoint of fromRunId | null
 * Copies findings, plan_json, source_calls_json and the checkpoint (plan R10).
 */
function copyRunForResume(fromRunId, toRunId, meta) {
  const now = _now(meta);
  return _tx(() => {
    const src = _get('SELECT case_id, checkpoint_json, plan_json, source_calls_json FROM ap_run WHERE run_id = ?', fromRunId);
    if (!src) return null;
    const n = _copyFindingsInTx(fromRunId, toRunId);
    _run('UPDATE ap_run SET checkpoint_json = ?, plan_json = COALESCE(?, plan_json), source_calls_json = COALESCE(?, source_calls_json), resumed_from = ? WHERE run_id = ?',
      src.checkpoint_json, src.plan_json, src.source_calls_json, fromRunId, toRunId);
    _appendEventInTx({ caseId: src.case_id, at: now, kind: 'resumed', reason: (_parse(src.checkpoint_json) || {}).step || null, detail: { from: fromRunId, findings: n }, runId: toRunId });
    return _parse(src.checkpoint_json);
  });
}

/**
 * recoverAbandoned({ owner, now, rand }) — boot recovery (§B10.2 step 3).
 * Open runs -> 'abandoned' (checkpoints kept). INVESTIGATING / ANALYZING cases
 * with an expired or foreign lease -> QUEUED (attempts+1, 5/15 min backoff
 * +-10%) or FAILED 'crash_loop' when attempts+1 >= LIMITS.maxAttempts.
 */
function recoverAbandoned(opts) {
  const o = opts || {};
  const now = _now(o);
  const rand = typeof o.rand === 'function' ? o.rand : Math.random;
  return _tx(() => {
    const abandoned = _run("UPDATE ap_run SET outcome = 'abandoned', ended_at = ? WHERE ended_at IS NULL", now).changes;
    const out = { abandonedRuns: abandoned, requeued: [], failed: [] };
    const rows = _all("SELECT case_id, state, attempts, lease_owner, lease_until FROM ap_case WHERE state IN ('INVESTIGATING', 'ANALYZING')");
    for (const c of rows) {
      const stale = c.lease_until == null || c.lease_until < now || c.lease_owner !== o.owner;
      if (!stale) continue;
      const attempts = (c.attempts || 0) + 1;
      if (attempts >= LIMITS.maxAttempts) {
        _updateCaseInTx(c.case_id, { attempts, last_error_code: 'crash_loop', lease_owner: null, lease_until: null }, now);
        _transitionInTx(c.case_id, S.FAILED, { reason: 'crash_loop', now });
        _appendEventInTx({ caseId: c.case_id, at: now, kind: 'error', reason: 'crash_loop', detail: { attempts } });
        out.failed.push(c.case_id);
      } else {
        const mins = LIMITS.retryBackoffMin[Math.min(attempts - 1, LIMITS.retryBackoffMin.length - 1)];
        const jitter = 1 + (rand() * 0.2 - 0.1);
        const next = now + Math.round(mins * 60000 * jitter);
        _updateCaseInTx(c.case_id, { attempts, next_attempt_at: next, lease_owner: null, lease_until: null }, now);
        _transitionInTx(c.case_id, S.QUEUED, { reason: 'recovered', now });
        _appendEventInTx({ caseId: c.case_id, at: now, kind: 'recovered', reason: 'crash', detail: { attempts } });
        out.requeued.push(c.case_id);
      }
    }
    return out;
  });
}

/**
 * prune({ now, localHistory, force }) — at most every 6 h. Keeps ap_run/ap_finding
 * for the latest 5 runs per case (1 with localHistory OFF); deletes one batch of
 * 500 ap_event rows older than 180 days.
 */
function prune(opts) {
  const o = opts || {};
  const now = _now(o);
  return _tx(() => {
    const last = parseInt(_getMetaInTx('last_prune_at') || '0', 10) || 0;
    if (!o.force && now - last < RETENTION.pruneEveryMs) return { skipped: true };
    const keep = o.localHistory === false ? RETENTION.runsKeptNoHistory : RETENTION.runsKept;
    const old = _all(`SELECT run_id FROM (SELECT run_id, ended_at,
        ROW_NUMBER() OVER (PARTITION BY case_id ORDER BY started_at DESC, run_id DESC) AS rn FROM ap_run)
        WHERE rn > ? AND ended_at IS NOT NULL`, keep).map((r) => r.run_id);
    let findings = 0;
    for (const id of old) {
      findings += _run('DELETE FROM ap_finding WHERE run_id = ?', id).changes;
      _run('DELETE FROM ap_run WHERE run_id = ?', id);
    }
    const events = _run('DELETE FROM ap_event WHERE id IN (SELECT id FROM ap_event WHERE at < ? ORDER BY id LIMIT ?)',
      now - RETENTION.eventMaxAgeMs, RETENTION.eventBatch).changes;
    _setMetaInTx('last_prune_at', now);
    return { skipped: false, runs: old.length, findings, events, moreEvents: events >= RETENTION.eventBatch };
  });
}

/**
 * review(caseId, action, { note, now }) -> { ok:true, state } | { ok:false, code }
 *   acknowledge: RECOMMENDATION_READY -> MONITORING
 *   accept:      NEEDS_REVIEW -> MONITORING, stores the NEEDS_REVIEW reason code (R3)
 *   rerun:       -> QUEUED (manual) from any state that allows it except PAUSED
 */
function review(caseId, action, opts) {
  const o = opts || {};
  const now = _now(o);
  const note = o.note == null ? null : String(o.note).slice(0, 500);
  return _tx(() => {
    const c = _get('SELECT state FROM ap_case WHERE case_id = ?', caseId);
    if (!c) return { ok: false, code: 'NOT_FOUND' };
    let to;
    const f = { reviewed_at: now };
    if (note != null) f.review_note = note;
    if (action === 'acknowledge') {
      if (c.state !== S.RECOMMENDATION_READY) return { ok: false, code: 'INVALID_STATE' };
      to = S.MONITORING; f.review_status = 'acknowledged';
    } else if (action === 'accept') {
      if (c.state !== S.NEEDS_REVIEW) return { ok: false, code: 'INVALID_STATE' };
      const ev = _get("SELECT reason_code FROM ap_event WHERE case_id = ? AND kind = 'transition' AND to_state = 'NEEDS_REVIEW' ORDER BY id DESC LIMIT 1", caseId);
      to = S.MONITORING; f.review_status = 'accepted'; f.review_accepted_code = ev ? ev.reason_code : null;
    } else if (action === 'rerun') {
      if (c.state === S.PAUSED || !canTransition(c.state, S.QUEUED)) return { ok: false, code: 'INVALID_STATE' };
      to = S.QUEUED; f.next_attempt_at = null;
    } else {
      return { ok: false, code: 'INVALID_INPUT' };
    }
    _updateCaseInTx(caseId, f, now);
    _transitionInTx(caseId, to, { reason: action === 'rerun' ? 'manual' : action, actor: 'user', now });
    _appendEventInTx({ caseId, at: now, kind: 'review', actor: 'user', reason: action, detail: note ? { noted: true } : null });
    return { ok: true, state: to };
  });
}

/** bumpCounter(date, source, field, n) — per-source diagnostics counters in counters:<date>. */
function bumpCounter(date, source, field, n) {
  return _tx(() => {
    const key = 'counters:' + date;
    const doc = _parse(_getMetaInTx(key)) || {};
    const s = doc[source] && typeof doc[source] === 'object' ? doc[source] : {};
    s[field] = (Number(s[field]) || 0) + (n == null ? 1 : n);
    doc[source] = s;
    _setMetaInTx(key, JSON.stringify(doc));
    return s[field];
  });
}

function setMeta(key, value) {
  return _tx(() => { _setMetaInTx(key, value); return true; });
}

/** appendEvent(ev) — standalone audit event (control, config, harness, error). */
function appendEvent(ev) {
  const e = Object.assign({}, ev || {});
  if (!Number.isFinite(e.at)) e.at = Date.now();
  return _tx(() => { _appendEventInTx(e); return true; });
}

// ── reads (no transaction) ──────────────────────────────────────────────────

function getMeta(key) {
  const r = _get('SELECT value FROM ap_meta WHERE key = ?', key);
  return r ? r.value : null;
}

/** listCases({ state, domicile, reason, q, limit, offset }) -> { total, items } */
function listCases(filter) {
  const f = filter || {};
  const where = [];
  const args = [];
  if (f.state) {
    const states = (Array.isArray(f.state) ? f.state : [f.state]).filter((s) => typeof s === 'string');
    if (states.length) { where.push('state IN (' + states.map(() => '?').join(', ') + ')'); args.push(...states); }
  } else if (!f.includeResolved) {
    where.push("state <> 'RESOLVED'");
  }
  if (f.domicile) { where.push('domicile = ?'); args.push(normUnit(f.domicile)); }
  if (f.reason) { where.push('instr(reasons_json, ?) > 0'); args.push('"code":"' + String(f.reason) + '"'); }
  if (f.q) {
    const q = normUnit(f.q);
    if (q) { where.push('substr(unit_id, 1, length(?)) = ?'); args.push(q, q); }
  }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.max(1, Math.min(200, parseInt(f.limit, 10) || 50));
  const offset = Math.max(0, parseInt(f.offset, 10) || 0);
  const total = _get('SELECT COUNT(*) AS n FROM ap_case' + w, ...args).n;
  const items = _all('SELECT * FROM ap_case' + w + ' ORDER BY priority DESC, state_changed_at ASC, case_id ASC LIMIT ? OFFSET ?', ...args, limit, offset).map(_parseCase);
  return { total, items };
}

/** getCase(caseId, { eventsOffset }) -> { case, runs (latest 5), findings (latest run), events (page of 500), eventsTotal } | null */
function getCase(caseId, opts) {
  const c = _get('SELECT * FROM ap_case WHERE case_id = ?', caseId);
  if (!c) return null;
  const off = Math.max(0, parseInt(opts && opts.eventsOffset, 10) || 0);
  const runs = _all('SELECT * FROM ap_run WHERE case_id = ? ORDER BY started_at DESC, run_id DESC LIMIT 5', caseId).map(_parseRun);
  const findings = runs.length ? _all('SELECT * FROM ap_finding WHERE run_id = ? ORDER BY id', runs[0].run_id) : [];
  const eventsTotal = _get('SELECT COUNT(*) AS n FROM ap_event WHERE case_id = ?', caseId).n;
  const events = _all('SELECT * FROM ap_event WHERE case_id = ? ORDER BY at ASC, id ASC LIMIT 500 OFFSET ?', caseId, off)
    .map((e) => Object.assign({}, e, { detail: _parse(e.detail_json) }));
  return { case: _parseCase(c), runs, findings, events, eventsTotal };
}

/** counts() -> overview numbers for the dashboard. */
function counts() {
  const byState = {};
  for (const r of _all('SELECT state, COUNT(*) AS n FROM ap_case GROUP BY state')) byState[r.state] = r.n;
  const byReason = {};
  for (const r of _all("SELECT primary_reason AS k, COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' GROUP BY primary_reason")) byReason[r.k || 'none'] = r.n;
  const byDomicile = {};
  for (const r of _all("SELECT domicile AS k, COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' GROUP BY domicile")) byDomicile[r.k || 'none'] = r.n;
  const open = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED'").n;
  const etaOverdue = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' AND instr(reasons_json, ?) > 0", '"code":"ETA_OVERDUE_VERIFIED"').n;
  return { open, byState, byReason, byDomicile, etaOverdue, needsReview: byState[S.NEEDS_REVIEW] || 0, auth: byState[S.AUTH_REQUIRED] || 0 };
}

/** Open cases (state <> RESOLVED), parsed. */
function listOpen() {
  return _all("SELECT * FROM ap_case WHERE state <> 'RESOLVED' ORDER BY created_at").map(_parseCase);
}

/** QUEUED cases due now, priority DESC, state_changed_at ASC. */
function pickQueued(limit, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return _all("SELECT * FROM ap_case WHERE state = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY priority DESC, state_changed_at ASC LIMIT ?",
    t, Math.max(1, limit | 0)).map(_parseCase);
}

/** Newest resumable run for a case (§B8 step 2) or null. */
function findResumable(caseId, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const rows = _all('SELECT * FROM ap_run WHERE case_id = ? AND outcome IN (?, ?, ?) AND started_at > ? ORDER BY started_at DESC',
    caseId, ...RESUME_OUTCOMES, t - LIMITS.resumeMaxAgeMs);
  for (const r of rows) {
    const p = _parseRun(r);
    if (p.checkpoint && RESUME_STEPS.has(p.checkpoint.step)) return p;
  }
  return null;
}

/** Runs of a case started at or after sinceMs (for trigger limits). */
function runsSince(caseId, sinceMs) {
  return _all('SELECT run_id, trigger, started_at FROM ap_run WHERE case_id = ? AND started_at >= ? ORDER BY started_at', caseId, sinceMs);
}

/** One run, parsed, or null. */
function getRun(runId) {
  return _parseRun(_get('SELECT * FROM ap_run WHERE run_id = ?', runId));
}

/** Findings of one run as pack items (used to resume from a checkpoint). */
function findingsForRun(runId) {
  return _all('SELECT * FROM ap_finding WHERE run_id = ? ORDER BY id', runId).map((f) => ({
    evidenceId: f.evidence_id, source: f.source, sourceRef: f.source_ref, field: f.field, value: f.value_text,
    observedAt: f.observed_at, retrievedAt: f.retrieved_at, live: false, freshness: f.freshness, confidence: f.confidence,
    trust: f.trust, authorityTag: f.authority_tag, conflictGroup: f.conflict_group,
    flags: f.flags ? String(f.flags).split(',').filter(Boolean) : [],
  }));
}

/** Set of 'caseId|YYYY-MM-DD' for eta_due triggers already fired since sinceMs. */
function etaDueFired(sinceMs) {
  const out = new Set();
  for (const r of _all("SELECT case_id, reason_code FROM ap_event WHERE kind = 'transition' AND at >= ? AND substr(reason_code, 1, 8) = 'eta_due:'", sinceMs)) {
    out.add(r.case_id + '|' + String(r.reason_code).slice(8));
  }
  return out;
}

/** ap_run AI columns since sinceMs (diagnostics). */
function aiRunStats(sinceMs) {
  return _all('SELECT ai_status, ai_latency_ms, ai_lane, trigger, outcome, source_calls_json FROM ap_run WHERE started_at >= ?', sinceMs)
    .map((r) => ({ ai_status: r.ai_status, ai_latency_ms: r.ai_latency_ms, ai_lane: r.ai_lane, trigger: r.trigger, outcome: r.outcome, source_calls: _parse(r.source_calls_json) }));
}

module.exports = {
  // writes (one transaction each)
  upsertDetected, transition, persistRun, reserveAiCallAndMarkPending, sweepResolution,
  pauseCases, requeueCases, lease, openRun, writeCheckpoint, writeFindings, copyRunForResume,
  recoverAbandoned, prune, review, bumpCounter, setMeta, appendEvent,
  // reads
  getMeta, listCases, getCase, counts, listOpen, pickQueued, findResumable, runsSince,
  getRun, findingsForRun, etaDueFired, aiRunStats,
  ISSUE_KEY,
};
