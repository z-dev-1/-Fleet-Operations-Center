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
const { STATES: S, LIMITS, RETENTION, OPERATIONAL_CADENCE, ApError, normUnit, localDate, DAY, HOUR } = require('./constants');
const { canTransition } = require('./lifecycle');
const resolution = require('./resolution');
const { strongestReason } = require('./priority');
const memoryMod = require('./memory');
const { stableStringify } = require('./fingerprint');
const coverageMod = require('./coverage');

const ISSUE_KEY = 'oos';

// V2 caps (§5.4).
const WO_SET_MAX = 50;
const DEALER_CASES_MAX = 30;
const PASSES_KEPT = 500;
const PROPOSAL_MAX_AGE_MS = 180 * DAY;
const STEP_ARGS_MAX_BYTES = 1024;
const STEP_SUMMARY_MAX_BYTES = 4096;
// Entering one of these clears queued_since (§8.1); QUEUED sets it when NULL; the others keep it.
const QUEUED_SINCE_CLEARS = new Set([S.MONITORING, S.RECOMMENDATION_READY, S.NEEDS_REVIEW, S.WAITING_FOR_DATA, S.AUTH_REQUIRED, S.FAILED, S.PAUSED, S.RESOLVED]);
const DEEP_ALLOWED = new Set([S.DETECTED, S.MONITORING, S.RECOMMENDATION_READY, S.NEEDS_REVIEW, S.WAITING_FOR_DATA, S.AUTH_REQUIRED, S.FAILED, S.QUEUED]);
const RESTING = new Set([S.MONITORING, S.RECOMMENDATION_READY, S.NEEDS_REVIEW, S.WAITING_FOR_DATA, S.AUTH_REQUIRED, S.FAILED]);

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
  // V2 (§5.2). queued_since is written only by _transitionInTx (§8.1).
  'equipment_class', 'operator', 'owner', 'vendor', 'episode_key', 'episode_opened_at', 'wo_set_json',
  'dealer_cases_json', 'complexity', 'memory_json', 'slice_fps_json', 'ai_pending_reason', 'ai_investigated_at',
  'recurrence_of', 'recurrence_count', 'deep_requested_at', 'safety', 'awaiting_sources', 'last_up_seen_build_at',
]);
const CASE_JSON = ['reasons_json', 'wo_ids_json', 'eta_json', 'blockers_json', 'ai_findings_json', 'recommendation_json', 'resolution_json',
  'wo_set_json', 'dealer_cases_json', 'memory_json', 'slice_fps_json'];
const RUN_JSON = ['checkpoint_json', 'source_calls_json', 'plan_json'];
const RESUME_OUTCOMES = ['abandoned', 'aborted', 'deferred'];
const RESUME_STEPS = new Set(['evidence_done', 'ai_pending', 'loop', 'analysis_done']);
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
          review_accepted_code = NULL, lease_owner = NULL, lease_until = NULL, queued_since = NULL, updated_at = ?, version = version + 1 WHERE case_id = ?`,
    to, cur.state, now, JSON.stringify(resolution.payloadOf(m.resolution)), now, caseId);
  } else {
    const pause = to === S.PAUSED ? (m.pauseReason || m.reason || null) : null;
    // queued_since (§8.1): set on entering QUEUED when NULL, cleared on entering a resting / closed state, else kept.
    const qs = to === S.QUEUED ? 'COALESCE(queued_since, ?)' : (QUEUED_SINCE_CLEARS.has(to) ? 'NULL' : 'queued_since');
    const args = [to, cur.state, pause, now];
    if (to === S.QUEUED) args.push(now);
    _run('UPDATE ap_case SET state = ?, prev_state = ?, pause_reason = ?, state_changed_at = ?, queued_since = ' + qs + ', updated_at = ?, version = version + 1 WHERE case_id = ?',
      ...args, now, caseId);
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

function _writeFindingsInTx(caseId, runId, items, stepId) {
  let n = 0;
  for (const it of items || []) {
    if (!it || !it.source || !it.field || it.retrievedAt == null || !it.freshness || !Number.isFinite(it.confidence) || !it.trust) {
      throw new ApError('INVALID_FINDING', it && it.field ? String(it.field) : '');
    }
    const value = it.value == null ? null : (typeof it.value === 'string' ? it.value : JSON.stringify(it.value)).slice(0, LIMITS.findingValueMaxChars);
    const flags = Array.isArray(it.flags) ? it.flags.join(',') : (it.flags || null);
    _run(`INSERT INTO ap_finding (case_id, run_id, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
          freshness, confidence, trust, authority_tag, conflict_group, flags, step_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    caseId, runId, it.evidenceId || _evidenceId(it), it.source, it.sourceRef || null, it.field, value,
    it.observedAt == null ? null : it.observedAt, it.retrievedAt, it.freshness, it.confidence, it.trust,
    it.authorityTag || null, it.conflictGroup || null, flags, stepId || null);
    n++;
  }
  return n;
}

function _copyFindingsInTx(fromRunId, toRunId) {
  return _run(`INSERT INTO ap_finding (case_id, run_id, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
        freshness, confidence, trust, authority_tag, conflict_group, flags, step_id)
      SELECT case_id, ?, evidence_id, source, source_ref, field, value_text, observed_at, retrieved_at,
        freshness, confidence, trust, authority_tag, conflict_group, flags, step_id FROM ap_finding WHERE run_id = ? ORDER BY id`,
  toRunId, fromRunId).changes;
}

// ── V2 private helpers (never open a transaction) ───────────────────────────

// Per-run lease check (FR-12.1): the case must still be leased by `owner`. With a finite
// `until` the lease is renewed in the same statement. Throws LEASE_LOST otherwise.
function _leaseCheckInTx(caseId, owner, until, now) {
  if (!owner) throw new ApError('LEASE_LOST', 'no owner');
  const ch = Number.isFinite(until)
    ? _run('UPDATE ap_case SET lease_until = ?, updated_at = ? WHERE case_id = ? AND lease_owner = ?', until, now, caseId, owner).changes
    : (_get('SELECT 1 AS x FROM ap_case WHERE case_id = ? AND lease_owner = ?', caseId, owner) ? 1 : 0);
  if (!ch) throw new ApError('LEASE_LOST');
}

function _clipId(v) { const s = v == null ? '' : String(v).trim(); return s && s.length <= 80 ? s : null; }

// Candidate WO entries: [{ id, role }] from { primary, secondary[], ids[] } (constants.woSetOf shape) or an array.
function _candWos(c) {
  const w = c && c.woIds;
  const out = [];
  const add = (id, role) => { const s = _clipId(id); if (s && !out.some((x) => x.id === s)) out.push({ id: s, role }); };
  if (Array.isArray(w)) { for (const x of w) add(x && typeof x === 'object' ? x.id : x, (x && x.role) || 'secondary'); return out; }
  if (!w || typeof w !== 'object') return out;
  add(w.primary, 'primary');
  for (const s of Array.isArray(w.secondary) ? w.secondary : []) add(s, 'secondary');
  for (const s of Array.isArray(w.ids) ? w.ids : []) add(s, 'alias');
  return out;
}
function _candDealer(c) {
  const out = [];
  for (const x of Array.isArray(c && c.dealerCases) ? c.dealerCases : []) {
    const id = _clipId(x && typeof x === 'object' ? x.id : x);
    if (id && !out.some((y) => y.id === id)) out.push({ id, kind: x && typeof x === 'object' && x.kind ? String(x.kind).slice(0, 20) : null });
  }
  return out;
}
function _freshSet(entries, now) { return entries.map((e) => Object.assign({}, e, { firstSeenAt: now, lastSeenAt: now })); }
// Union by id; refreshes lastSeenAt, appends new ids, keeps the newest `max` (oldest firstSeenAt dropped first).
function _mergeSet(cur, entries, now, max) {
  const list = Array.isArray(cur) ? cur.map((e) => Object.assign({}, e)) : [];
  let added = 0;
  for (const e of entries) {
    const ex = list.find((x) => x && x.id === e.id);
    if (ex) ex.lastSeenAt = now;
    else { list.push(Object.assign({}, e, { firstSeenAt: now, lastSeenAt: now })); added++; }
  }
  while (list.length > max) {
    let oldest = 0;
    for (let k = 1; k < list.length; k++) if ((list[k].firstSeenAt || 0) < (list[oldest].firstSeenAt || 0)) oldest = k;
    list.splice(oldest, 1);
  }
  return { list, added };
}
function _episodeKey(unit, openedAt) { return unit + ':' + localDate(openedAt); }

function _stepIdemKey(caseId, runId, seq, kind, tool, argsHash) {
  return _sha1([caseId, runId, seq, kind, tool || '', argsHash || ''].join('|'));
}
function _stepCallKey(caseId, tool, argsHash, sourceFp) {
  return _sha1([caseId, tool || '', argsHash || '', sourceFp || ''].join('|'));
}
function _isUniqueViolation(e) { return /UNIQUE constraint failed/i.test(String((e && e.message) || '')); }

// Insert one pending ap_step. -> { stepId, idemKey, callKey }
function _insertStepInTx(st, now) {
  const s = st || {};
  if (!s.caseId || !s.runId || !Number.isInteger(s.seq) || !s.kind) throw new ApError('INVALID_STEP');
  const isTool = s.kind === 'tool';
  const argsJson = s.args === undefined || s.args === null ? null : stableStringify(s.args);
  if (argsJson && Buffer.byteLength(argsJson, 'utf8') > STEP_ARGS_MAX_BYTES) throw new ApError('INVALID_STEP', 'args');
  const argsHash = s.argsHash || (isTool ? _sha1(argsJson || 'null') : null);
  const idemKey = _stepIdemKey(s.caseId, s.runId, s.seq, s.kind, s.tool, argsHash);
  const callKey = isTool ? _stepCallKey(s.caseId, s.tool, argsHash, s.sourceFp) : null;
  const stepId = s.stepId || _newId('st_', [s.caseId, s.runId, s.seq, s.kind]);
  const startedAt = Number.isFinite(s.startedAt) ? s.startedAt : now;
  try {
    _run(`INSERT INTO ap_step (step_id, case_id, run_id, seq, turn, kind, tool, args_json, args_hash, idem_key, call_key, source,
          live, source_fp, status, code, why, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    stepId, s.caseId, s.runId, s.seq, Number.isInteger(s.turn) ? s.turn : 0, s.kind, s.tool || null, argsJson, argsHash,
    idemKey, callKey, s.source || null, s.live ? 1 : 0, s.sourceFp || null, s.code || null,
    s.why == null ? null : String(s.why).slice(0, 200), startedAt);
  } catch (e) {
    if (_isUniqueViolation(e)) throw new ApError('STEP_EXISTS');
    throw e;
  }
  return { stepId, idemKey, callKey };
}

const RECORD_COLUMNS = ['operator', 'owner', 'domicile', 'oos_status', 'days_down', 'repair_phase', 'root_cause', 'blocker',
  'responsible_party', 'last_verified_update_at', 'last_verified_update_source', 'parts_eta', 'repair_eta', 'confidence', 'ai_status'];

function _upsertRecordInTx(caseId, unitId, rec, now) {
  const r = rec || {};
  const json = _json(r.record_json !== undefined ? r.record_json : {});
  if (Buffer.byteLength(json || '', 'utf8') > LIMITS.recordMaxBytes) throw new ApError('RECORD_TOO_LARGE');
  const vals = RECORD_COLUMNS.map((k) => (r[k] === undefined ? null : r[k]));
  _run(`INSERT INTO ap_record (case_id, unit_id, schema_version, ${RECORD_COLUMNS.join(', ')}, investigated_at, record_json, updated_at)
        VALUES (?, ?, ?, ${RECORD_COLUMNS.map(() => '?').join(', ')}, ?, ?, ?)
        ON CONFLICT(case_id) DO UPDATE SET unit_id = excluded.unit_id, schema_version = excluded.schema_version,
        ${RECORD_COLUMNS.map((k) => k + ' = excluded.' + k).join(', ')},
        investigated_at = excluded.investigated_at, record_json = excluded.record_json, updated_at = excluded.updated_at`,
  caseId, r.unit_id || unitId, Number.isInteger(r.schema_version) ? r.schema_version : 1, ...vals,
  Number.isFinite(r.investigated_at) ? r.investigated_at : now, json, now);
}

// -> 1 when inserted, 0 when the (case_id, fingerprint) proposal already exists.
function _insertProposalInTx(caseId, cur, runId, p, now) {
  const x = p || {};
  if (!x.fingerprint || !x.source || (!x.evidence_ref && !x.evidenceRef)) throw new ApError('INVALID_PROPOSAL');
  const id = x.proposal_id || x.proposalId || ('tp_' + _sha1(caseId + '|' + x.fingerprint).slice(0, 16));
  const pick = (a, b) => (x[a] !== undefined ? x[a] : x[b]);
  return _run(`INSERT OR IGNORE INTO ap_timeline_proposal (proposal_id, case_id, unit_id, episode_key, event_at, event_date,
        discovered_at, source, evidence_ref, basis, kind, description, fingerprint, run_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  id, caseId, cur.unit_id, pick('episode_key', 'episodeKey') || cur.episode_key || 'unknown',
  pick('event_at', 'eventAt') == null ? null : pick('event_at', 'eventAt'), pick('event_date', 'eventDate') || null,
  Number.isFinite(pick('discovered_at', 'discoveredAt')) ? pick('discovered_at', 'discoveredAt') : now,
  String(x.source), String(pick('evidence_ref', 'evidenceRef')), x.basis === 'verified' ? 'verified' : 'inferred',
  String(x.kind || 'inference'), String(x.description || '').slice(0, 300), String(x.fingerprint), runId || 'none',
  'proposed', now).changes;
}

function _parseStep(r) {
  if (!r) return null;
  return Object.assign({}, r, { args: _parse(r.args_json), summary: _parse(r.summary_json) });
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
 * upsertDetected(candidate, opts) -> { caseId, created, state } (+ rolled:true on an episode roll)
 * A candidate with openedBy null only tags an existing open case ({caseId:null} when none).
 * candidate: { unitId, domicile, reasons[{code,...}], openedBy, daysDown, downSince, eta, buildAtMs, priority, woIds,
 *              V2: equipmentClass, operator, owner, vendor, safety, dealerCases[] }
 *   woIds: { primary, secondary[], ids[] } (constants.woSetOf) — ids holds both _serviceId and workRequestId.
 * opts: { paused, hold, now } — paused or hold keeps a new case DETECTED.
 */
function upsertDetected(candidate, opts) {
  const c = candidate || {};
  const o = opts || {};
  const now = _now(o);
  const unit = normUnit(c.unitId);
  const reasons = Array.isArray(c.reasons) ? c.reasons.map((r) => (typeof r === 'string' ? { code: r } : r)) : null;
  const wos = _candWos(c);
  const dealer = _candDealer(c);
  const v2 = {};
  for (const [k, col] of [['equipmentClass', 'equipment_class'], ['operator', 'operator'], ['owner', 'owner'], ['vendor', 'vendor']]) {
    if (c[k] !== undefined) v2[col] = c[k] == null || c[k] === '' ? null : String(c[k]).slice(0, 60);
  }
  if (c.safety !== undefined) v2.safety = c.safety ? 1 : 0;
  return _tx(() => {
    let open = _get("SELECT * FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state <> 'RESOLVED'", unit, ISSUE_KEY);
    if (!open) {
      // Tag-only candidate (no opening rule applies) and no open case: nothing to do.
      if (c.openedBy == null) return { caseId: null, created: false, state: null };
      if (!unit || !c.openedBy || !reasons || !reasons.length || !Number.isFinite(now)) throw new ApError('INVALID_CASE');
      const prior = _get("SELECT case_id, state_changed_at, recurrence_count FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state = 'RESOLVED' ORDER BY state_changed_at DESC LIMIT 1", unit, ISSUE_KEY);
      const recurrent = !!prior && prior.state_changed_at >= now - LIMITS.recurrenceWindowMs;
      const openedAt = Number.isFinite(c.downSince) ? c.downSince : now;
      const caseId = _newId('ap_', [unit, ISSUE_KEY, now]);
      const info = _run(`INSERT OR IGNORE INTO ap_case (case_id, unit_id, domicile, issue_key, state, state_changed_at, opened_by,
            reasons_json, primary_reason, wo_ids_json, down_since, days_down, last_down_build_at, eta_json, priority,
            prior_case_id, created_at, updated_at, equipment_class, operator, owner, vendor, safety,
            episode_key, episode_opened_at, wo_set_json, dealer_cases_json, recurrence_of, recurrence_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      caseId, unit, c.domicile ? normUnit(c.domicile) : null, ISSUE_KEY, S.DETECTED, now, c.openedBy,
      JSON.stringify(reasons), strongestReason(reasons), _json(c.woIds),
      Number.isFinite(c.downSince) ? c.downSince : null, Number.isFinite(c.daysDown) ? c.daysDown : null,
      Number.isFinite(c.buildAtMs) ? c.buildAtMs : null, _json(c.eta), Number.isFinite(c.priority) ? c.priority : 0,
      prior ? prior.case_id : null, now, now,
      v2.equipment_class == null ? null : v2.equipment_class, v2.operator == null ? null : v2.operator,
      v2.owner == null ? null : v2.owner, v2.vendor == null ? null : v2.vendor, v2.safety || 0,
      _episodeKey(unit, openedAt), openedAt, JSON.stringify(_freshSet(wos, now)), JSON.stringify(_freshSet(dealer, now)),
      recurrent ? prior.case_id : null, recurrent ? (prior.recurrence_count || 0) + 1 : 0);
      if (info.changes > 0) {
        _appendEventInTx({ caseId, at: now, kind: 'transition', from: null, to: S.DETECTED, reason: c.openedBy, detail: { reasons: _reasonCodes(reasons) } });
        let state = S.DETECTED;
        if (!o.paused && !o.hold) { _transitionInTx(caseId, S.QUEUED, { reason: 'new', now }); state = S.QUEUED; }
        return { caseId, created: true, state };
      }
      // A concurrent path created the open case: continue as an update.
      open = _get("SELECT * FROM ap_case WHERE unit_id = ? AND issue_key = ? AND state <> 'RESOLVED'", unit, ISSUE_KEY);
      if (!open) throw new ApError('INVALID_CASE');
    }
    const f = {};
    const curSet = _parse(open.wo_set_json);
    const curIds = new Set((Array.isArray(curSet) ? curSet : []).map((x) => x && x.id));
    const episodeOpened = open.episode_opened_at != null ? open.episode_opened_at : (open.down_since != null ? open.down_since : open.created_at);
    // Episode roll (FR-6.5, §7.6): seen up after the episode opened, and none of the candidate's WO ids is known.
    const roll = !OPEN_ACTIVE.has(open.state) && open.last_up_seen_build_at != null && open.last_up_seen_build_at > episodeOpened
      && wos.length > 0 && !wos.some((w) => curIds.has(w.id));
    let rolled = false;
    let state = open.state;
    if (roll) {
      const openedAt = Number.isFinite(c.downSince) ? c.downSince : now;
      const key = _episodeKey(unit, openedAt);
      const newSet = _freshSet(wos, now);
      const newDealer = _freshSet(dealer, now);
      const mem0 = memoryMod.load(open.memory_json) || memoryMod.init(open, null);
      const mem = memoryMod.trim(memoryMod.rollEpisode(mem0, {
        endedAt: now, newEpisode: { key, openedAt, woIds: newSet.map((x) => x.id), dealerCases: newDealer.map((x) => x.id) },
      }));
      Object.assign(f, {
        episode_opened_at: openedAt, episode_key: key, wo_set_json: newSet, dealer_cases_json: newDealer,
        recurrence_count: (open.recurrence_count || 0) + 1, memory_json: mem, slice_fps_json: null, ai_fp: null,
        deep_requested_at: null, last_up_seen_build_at: null,
      });
      _appendEventInTx({ caseId: open.case_id, at: now, kind: 'detection', reason: 'episode_rolled', detail: { from: open.episode_key || null, to: key, wos: newSet.length } });
      rolled = true;
      if (open.state !== S.PAUSED && open.state !== S.QUEUED && RESTING.has(open.state) && canTransition(open.state, S.QUEUED)) {
        _transitionInTx(open.case_id, S.QUEUED, { reason: 'new_episode', now });
        state = S.QUEUED;
      }
    } else {
      if (wos.length || curSet == null) {
        const merged = _mergeSet(curSet, wos, now, WO_SET_MAX);
        if (curSet == null || merged.added || wos.length) f.wo_set_json = merged.list;
        if (merged.added && Array.isArray(curSet)) {
          _appendEventInTx({ caseId: open.case_id, at: now, kind: 'detection', reason: 'wo_joined', detail: { added: merged.added, total: merged.list.length } });
        }
      }
      const curDealer = _parse(open.dealer_cases_json);
      if (dealer.length || curDealer == null) f.dealer_cases_json = _mergeSet(curDealer, dealer, now, DEALER_CASES_MAX).list;
      if (open.episode_key == null) f.episode_key = _episodeKey(unit, episodeOpened);
      if (open.episode_opened_at == null) f.episode_opened_at = episodeOpened;
    }
    for (const col of Object.keys(v2)) if (v2[col] !== open[col]) f[col] = v2[col];
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
    return rolled ? { caseId: open.case_id, created: false, state, rolled: true } : { caseId: open.case_id, created: false, state };
  });
}

/**
 * transition(caseId, to, meta{reason, actor, resolution, pauseReason, detail, runId, now, leaseOwner}) -> previous state
 * meta.leaseOwner: the per-run lease owner is checked in the same transaction (LEASE_LOST).
 */
function transition(caseId, to, meta) {
  const m = meta || {};
  return _tx(() => {
    if (m.leaseOwner) _leaseCheckInTx(caseId, m.leaseOwner, null, _now(m));
    return _transitionInTx(caseId, to, meta);
  });
}

/**
 * persistRun(caseId, runId, fields, targetState, meta) -> { from, to }
 * One commit: column writes, optional transition, run close, optional event.
 * meta: { run:{outcome, aiStatus, ...}, reason, actor, resolution, pauseReason, event:{kind, reason, detail}, now,
 *         V2: leaseOwner (checked first, LEASE_LOST), record (ap_record row, upserted), proposals[] (INSERT OR IGNORE) }
 */
function persistRun(caseId, runId, fields, targetState, meta) {
  const m = meta || {};
  const now = _now(m);
  return _tx(() => {
    const cur = _get('SELECT state, unit_id, episode_key FROM ap_case WHERE case_id = ?', caseId);
    if (!cur) throw new ApError('NOT_FOUND', caseId);
    if (m.leaseOwner) _leaseCheckInTx(caseId, m.leaseOwner, null, now);
    if (m.record) _upsertRecordInTx(caseId, cur.unit_id, m.record, now);
    if (Array.isArray(m.proposals)) for (const p of m.proposals) _insertProposalInTx(caseId, cur, runId, p, now);
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
      // V2 §7.6: the newest build in which the unit was seen not down while the case is open.
      const upAt = buildAt != null ? buildAt : now;
      if (!(c.last_up_seen_build_at >= upAt)) f.last_up_seen_build_at = upAt;
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

/**
 * closeRun(runId, run{outcome, aiStatus, ...}, { now }) -> rows updated. Closes only the ap_run row; no
 * case column changes (V2 §7.1 step 1: a run that lost its lease closes its own run as 'lease_lost').
 */
function closeRun(runId, run, meta) {
  const now = _now(meta);
  return _tx(() => _closeRunInTx(runId, run, now));
}

/**
 * writeCheckpoint(runId, checkpoint, extra{plan, sourceCalls, step, leaseOwner, leaseUntil, now}) — checkpoint <= 64 KB.
 * extra.leaseOwner: the case lease is checked (LEASE_LOST) and renewed to extra.leaseUntil in the same transaction.
 */
function writeCheckpoint(runId, checkpoint, extra) {
  const e = extra || {};
  const cp = checkpoint == null ? null : JSON.stringify(checkpoint);
  if (cp && cp.length > LIMITS.checkpointMaxBytes) throw new ApError('CHECKPOINT_TOO_LARGE');
  return _tx(() => {
    if (e.leaseOwner) {
      const run = _get('SELECT case_id FROM ap_run WHERE run_id = ?', runId);
      if (!run) throw new ApError('NOT_FOUND', runId);
      _leaseCheckInTx(run.case_id, e.leaseOwner, e.leaseUntil, _now(e));
    }
    return _run(`UPDATE ap_run SET checkpoint_json = COALESCE(?, checkpoint_json), plan_json = COALESCE(?, plan_json),
      source_calls_json = COALESCE(?, source_calls_json), step = COALESCE(?, step) WHERE run_id = ?`,
    cp, _json(e.plan), _json(e.sourceCalls), e.step || null, runId).changes > 0;
  });
}

/** writeFindings(caseId, runId, items, meta{leaseOwner, now}) -> rows written */
function writeFindings(caseId, runId, items, meta) {
  const m = meta || {};
  return _tx(() => {
    if (m.leaseOwner) _leaseCheckInTx(caseId, m.leaseOwner, null, _now(m));
    return _writeFindingsInTx(caseId, runId, items);
  });
}

/**
 * copyRunForResume(fromRunId, toRunId, meta) -> parsed checkpoint of fromRunId | null
 * Copies findings, plan_json, source_calls_json and the checkpoint (plan R10), and every
 * ap_step of the run (new step_id / idem_key, original call_key, copied_from set; the
 * copied findings are remapped to the new step ids).
 */
function copyRunForResume(fromRunId, toRunId, meta) {
  const now = _now(meta);
  return _tx(() => {
    const src = _get('SELECT case_id, checkpoint_json, plan_json, source_calls_json FROM ap_run WHERE run_id = ?', fromRunId);
    if (!src) return null;
    const n = _copyFindingsInTx(fromRunId, toRunId);
    let steps = 0;
    for (const st of _all('SELECT * FROM ap_step WHERE run_id = ? ORDER BY seq', fromRunId)) {
      const stepId = _newId('st_', [st.case_id, toRunId, st.seq, st.kind]);
      _run(`INSERT INTO ap_step (step_id, case_id, run_id, seq, turn, kind, tool, args_json, args_hash, idem_key, call_key, source,
            live, source_fp, status, code, why, summary_json, result_bytes, reused_step_id, copied_from, ai_request_id, ai_latency_ms,
            ai_lane, started_at, ended_at, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      stepId, st.case_id, toRunId, st.seq, st.turn, st.kind, st.tool, st.args_json, st.args_hash,
      _stepIdemKey(st.case_id, toRunId, st.seq, st.kind, st.tool, st.args_hash), st.call_key, st.source, st.live, st.source_fp,
      st.status, st.code, st.why, st.summary_json, st.result_bytes, st.reused_step_id, st.step_id, st.ai_request_id,
      st.ai_latency_ms, st.ai_lane, st.started_at, st.ended_at, st.ms);
      _run('UPDATE ap_finding SET step_id = ? WHERE run_id = ? AND step_id = ?', stepId, toRunId, st.step_id);
      steps++;
    }
    _run('UPDATE ap_run SET checkpoint_json = ?, plan_json = COALESCE(?, plan_json), source_calls_json = COALESCE(?, source_calls_json), resumed_from = ? WHERE run_id = ?',
      src.checkpoint_json, src.plan_json, src.source_calls_json, fromRunId, toRunId);
    _appendEventInTx({ caseId: src.case_id, at: now, kind: 'resumed', reason: (_parse(src.checkpoint_json) || {}).step || null, detail: { from: fromRunId, findings: n, steps }, runId: toRunId });
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
    const interrupted = _run("UPDATE ap_step SET status = 'interrupted', ended_at = ? WHERE status = 'pending'", now).changes;
    const out = { abandonedRuns: abandoned, interruptedSteps: interrupted, requeued: [], failed: [] };
    const rows = _all("SELECT case_id, state, attempts, lease_owner, lease_until FROM ap_case WHERE state IN ('INVESTIGATING', 'ANALYZING')");
    const own = o.owner == null ? null : String(o.owner);
    for (const c of rows) {
      // Per-run owners are '<processOwner>#<run>'; the V1 whole-owner lease stays ours too.
      const ours = own != null && c.lease_owner != null && (c.lease_owner === own || String(c.lease_owner).startsWith(own + '#'));
      const stale = c.lease_until == null || c.lease_until < now || !ours;
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
    let steps = 0;
    for (const id of old) {
      findings += _run('DELETE FROM ap_finding WHERE run_id = ?', id).changes;
      steps += _run('DELETE FROM ap_step WHERE run_id = ?', id).changes;
      _run('DELETE FROM ap_run WHERE run_id = ?', id);
    }
    const events = _run('DELETE FROM ap_event WHERE id IN (SELECT id FROM ap_event WHERE at < ? ORDER BY id LIMIT ?)',
      now - RETENTION.eventMaxAgeMs, RETENTION.eventBatch).changes;
    const proposals = _run(`DELETE FROM ap_timeline_proposal WHERE proposal_id IN (SELECT p.proposal_id FROM ap_timeline_proposal p
        JOIN ap_case c ON c.case_id = p.case_id WHERE c.state = 'RESOLVED' AND p.created_at < ? LIMIT ?)`,
    now - PROPOSAL_MAX_AGE_MS, RETENTION.eventBatch).changes;
    _setMetaInTx('last_prune_at', now);
    return { skipped: false, runs: old.length, findings, steps, events, proposals, moreEvents: events >= RETENTION.eventBatch };
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

/**
 * appendEvent(ev, meta{leaseOwner}) — standalone audit event (control, config, harness, error).
 * meta.leaseOwner: the lease of ev.caseId is checked in the same transaction (LEASE_LOST).
 */
function appendEvent(ev, meta) {
  const e = Object.assign({}, ev || {});
  const m = meta || {};
  if (!Number.isFinite(e.at)) e.at = Date.now();
  return _tx(() => {
    if (m.leaseOwner) _leaseCheckInTx(e.caseId, m.leaseOwner, null, e.at);
    _appendEventInTx(e);
    return true;
  });
}

// ── V2 public writes (exactly one transaction each, §5.4) ───────────────────

/**
 * applyPass(pass, units, { now }) -> { written, deleted }
 * Inserts the ap_detect_pass row (newest 500 kept), upserts ap_unit rows whose row_hash
 * changed, deletes ap_unit rows not in `units`, and writes ap_event coverage_mismatch
 * (counts only) when the pass does not reconcile.
 */
function applyPass(pass, units, opts) {
  const p = pass || {};
  const list = Array.isArray(units) ? units : [];
  const now = _now(opts);
  const PASS_COLS = ['pass_id', 'at', 'build_at_ms', 'mode', 'fleet_rows', 'duplicate_rows', 'invalid_rows', 'eligible',
    'excluded_trailer', 'excluded_hostler', 'excluded_unsupported', 'type_unknown', 'type_conflict', 'down_eligible',
    'case_open', 'below_threshold', 'out_of_filter', 'feature_off', 'opened', 'held', 'reconcile_ok',
    'by_domicile_json', 'by_operator_json', 'by_owner_json', 'tokens_without_rows_json', 'ms'];
  const passId = p.pass_id || _newId('dp_', [now]);
  const vals = PASS_COLS.map((k) => {
    if (k === 'pass_id') return passId;
    if (k === 'at') return Number.isFinite(p.at) ? p.at : now;
    if (k === 'mode') return p.mode || 'fleet';
    if (k.endsWith('_json')) return _json(p[k]);
    if (k === 'build_at_ms' || k === 'ms') return Number.isFinite(p[k]) ? p[k] : null;
    return Number.isFinite(p[k]) ? p[k] : 0;
  });
  const rec = coverageMod.reconcile(p);
  return _tx(() => {
    _run('INSERT INTO ap_detect_pass (' + PASS_COLS.join(', ') + ') VALUES (' + PASS_COLS.map(() => '?').join(', ') + ')', ...vals);
    _run('DELETE FROM ap_detect_pass WHERE pass_id NOT IN (SELECT pass_id FROM ap_detect_pass ORDER BY at DESC, rowid DESC LIMIT ?)', PASSES_KEPT);
    let written = 0;
    const keep = new Set();
    for (const u of list) {
      if (!u || !u.unit_id) continue;
      keep.add(u.unit_id);
      written += _run(`INSERT INTO ap_unit (unit_id, eligibility, equipment_class, exclusion_code, domicile, operator, owner, vendor,
            is_down, coverage, case_id, row_hash, first_seen_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(unit_id) DO UPDATE SET eligibility = excluded.eligibility, equipment_class = excluded.equipment_class,
            exclusion_code = excluded.exclusion_code, domicile = excluded.domicile, operator = excluded.operator, owner = excluded.owner,
            vendor = excluded.vendor, is_down = excluded.is_down, coverage = excluded.coverage, case_id = excluded.case_id,
            row_hash = excluded.row_hash, updated_at = excluded.updated_at WHERE ap_unit.row_hash <> excluded.row_hash`,
      u.unit_id, u.eligibility, u.equipment_class == null ? null : u.equipment_class, u.exclusion_code == null ? null : u.exclusion_code,
      u.domicile == null ? null : u.domicile, u.operator == null ? null : u.operator, u.owner == null ? null : u.owner,
      u.vendor == null ? null : u.vendor, u.is_down ? 1 : 0, u.coverage, u.case_id == null ? null : u.case_id, u.row_hash, now, now).changes;
    }
    let deleted = 0;
    for (const r of _all('SELECT unit_id FROM ap_unit')) {
      if (!keep.has(r.unit_id)) deleted += _run('DELETE FROM ap_unit WHERE unit_id = ?', r.unit_id).changes;
    }
    if (!rec.ok) {
      _appendEventInTx({ caseId: null, at: now, kind: 'coverage_mismatch', reason: 'reconcile', detail: { passId, rowsDiff: rec.rowsDiff, downDiff: rec.downDiff } });
    }
    return { written, deleted };
  });
}

/**
 * promoteDetected(n, { now, boost, cap }) -> [caseId moved to QUEUED]
 * DETECTED cases (held by maxQueued) in pickQueued order with created_at as the age base (FR-8.5).
 */
function promoteDetected(n, opts) {
  const o = opts || {};
  const now = _now(o);
  const boost = Number.isFinite(o.boost) ? o.boost : 0;
  const cap = Number.isFinite(o.cap) ? o.cap : 0;
  const limit = Math.max(0, n | 0);
  if (!limit) return [];
  return _tx(() => {
    const ids = _all(`SELECT case_id FROM ap_case WHERE state = 'DETECTED'
        ORDER BY (priority + MIN(?, CAST((? - created_at) / 3600000 AS INTEGER) * ?)) DESC, created_at ASC, case_id ASC LIMIT ?`,
    cap, now, boost, limit).map((r) => r.case_id);
    for (const id of ids) _transitionInTx(id, S.QUEUED, { reason: 'promoted', now });
    return ids;
  });
}

/** leaseRun(caseId, leaseOwner, until, { now }) -> true when taken (free, expired or already this owner's). */
function leaseRun(caseId, leaseOwner, until, meta) {
  const now = _now(meta);
  if (!leaseOwner) return false;
  return _tx(() => _run(`UPDATE ap_case SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE case_id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_until IS NULL OR lease_until < ?)`,
  leaseOwner, until, now, caseId, leaseOwner, now).changes > 0);
}

/** renewLease(caseId, leaseOwner, until, { now }) -> true; throws LEASE_LOST when the lease is no longer ours. */
function renewLease(caseId, leaseOwner, until, meta) {
  const now = _now(meta);
  return _tx(() => {
    _leaseCheckInTx(caseId, leaseOwner, Number.isFinite(until) ? until : now, now);
    return true;
  });
}

/**
 * beginStep(step, { leaseOwner, leaseUntil, now }) -> { stepId, idemKey, callKey }
 * step: { caseId, runId, seq, turn, kind, tool, args, argsHash, source, live, sourceFp, why, startedAt }
 * Lease check (+renew) and the pending ap_step insert in one transaction. STEP_EXISTS on an idem_key clash.
 */
function beginStep(step, meta) {
  const m = meta || {};
  const now = _now(m);
  return _tx(() => {
    _leaseCheckInTx(step && step.caseId, m.leaseOwner, m.leaseUntil, now);
    return _insertStepInTx(step, now);
  });
}

/**
 * reserveAiTurn(step, date, cap, { leaseOwner, leaseUntil, now }) -> { stepId, idemKey, callKey } | false
 * Lease check, ai_calls:<date> below cap (else false and nothing written), counter bump and the
 * pending model step, in one transaction (V2 form of reserveAiCallAndMarkPending, FR-9.2).
 */
function reserveAiTurn(step, date, cap, meta) {
  const m = meta || {};
  const now = _now(m);
  return _tx(() => {
    _leaseCheckInTx(step && step.caseId, m.leaseOwner, m.leaseUntil, now);
    const key = 'ai_calls:' + date;
    const used = parseInt(_getMetaInTx(key) || '0', 10) || 0;
    if (!(used < cap)) return false;
    _bumpMetaCounterInTx(key, 1);
    return _insertStepInTx(Object.assign({ kind: 'model' }, step), now);
  });
}

/**
 * completeStep(stepId, patch, items, { leaseOwner, caseId, now }) -> { updated, findings }
 * patch: { status, code, summary, resultBytes, reusedStepId, aiRequestId, aiLatencyMs, aiLane }
 * Only a pending step completes; its findings get step_id.
 */
function completeStep(stepId, patch, items, meta) {
  const p = patch || {};
  const m = meta || {};
  const now = _now(m);
  let summary = p.summary == null ? null : JSON.stringify(p.summary);
  if (summary && Buffer.byteLength(summary, 'utf8') > STEP_SUMMARY_MAX_BYTES) summary = JSON.stringify({ truncated: true });
  return _tx(() => {
    const st = _get('SELECT case_id, run_id, started_at, status FROM ap_step WHERE step_id = ?', stepId);
    if (!st) throw new ApError('NOT_FOUND', stepId);
    const caseId = m.caseId || st.case_id;
    _leaseCheckInTx(caseId, m.leaseOwner, null, now);
    const updated = _run(`UPDATE ap_step SET status = ?, code = ?, summary_json = ?, result_bytes = ?, reused_step_id = ?,
          ai_request_id = ?, ai_latency_ms = ?, ai_lane = ?, ended_at = ?, ms = ? WHERE step_id = ? AND status = 'pending'`,
    p.status || 'ok', p.code || null, summary, Number.isFinite(p.resultBytes) ? p.resultBytes : null, p.reusedStepId || null,
    p.aiRequestId || null, Number.isFinite(p.aiLatencyMs) ? p.aiLatencyMs : null, p.aiLane || null,
    now, Math.max(0, now - st.started_at), stepId).changes;
    if (!updated) throw new ApError('STEP_NOT_PENDING', stepId);
    const findings = _writeFindingsInTx(caseId, st.run_id, items, stepId);
    return { updated, findings };
  });
}

/** writeMemory(caseId, memory, { leaseOwner, now }) -> true. Over LIMITS.memoryMaxBytes -> MEMORY_TOO_LARGE (trim first). */
function writeMemory(caseId, memory, meta) {
  const m = meta || {};
  const now = _now(m);
  const json = memory == null ? null : (typeof memory === 'string' ? memory : JSON.stringify(memory));
  if (json && Buffer.byteLength(json, 'utf8') > LIMITS.memoryMaxBytes) throw new ApError('MEMORY_TOO_LARGE');
  return _tx(() => {
    _leaseCheckInTx(caseId, m.leaseOwner, null, now);
    _updateCaseInTx(caseId, { memory_json: json }, now);
    return true;
  });
}

/**
 * requestDeep(caseId, { now }) -> { ok:true, state:'QUEUED' } | { ok:false, code }
 * Deep investigate (§8.7): priority = MAX(priority, 95), deep_requested_at = now, next_attempt_at = NULL,
 * QUEUED (reason manual) and ap_event review / deep. PAUSED / RESOLVED -> INVALID_STATE; INVESTIGATING / ANALYZING -> CASE_BUSY.
 */
function requestDeep(caseId, opts) {
  const now = _now(opts);
  return _tx(() => {
    const c = _get('SELECT state, priority FROM ap_case WHERE case_id = ?', caseId);
    if (!c) return { ok: false, code: 'NOT_FOUND' };
    if (OPEN_ACTIVE.has(c.state)) return { ok: false, code: 'CASE_BUSY' };
    if (!DEEP_ALLOWED.has(c.state)) return { ok: false, code: 'INVALID_STATE' };
    _updateCaseInTx(caseId, { priority: Math.max(c.priority || 0, OPERATIONAL_CADENCE.priorityV2.deepMin), deep_requested_at: now, next_attempt_at: null }, now);
    if (c.state !== S.QUEUED) _transitionInTx(caseId, S.QUEUED, { reason: 'manual', actor: 'user', now });
    _appendEventInTx({ caseId, at: now, kind: 'review', actor: 'user', reason: 'deep' });
    return { ok: true, state: S.QUEUED };
  });
}

/** setSliceBaseline(caseId, fps, { now }) -> true when written (only while slice_fps_json IS NULL). */
function setSliceBaseline(caseId, fps, opts) {
  const now = _now(opts);
  return _tx(() => _run('UPDATE ap_case SET slice_fps_json = ?, updated_at = ?, version = version + 1 WHERE case_id = ? AND slice_fps_json IS NULL',
    _json(fps), now, caseId).changes > 0);
}

/** releaseAiDeferred(reason, { now }) -> cases whose ai_retry_at moved to now. */
function releaseAiDeferred(reason, opts) {
  const now = _now(opts);
  return _tx(() => _run("UPDATE ap_case SET ai_retry_at = ?, updated_at = ? WHERE ai_pending_reason = ? AND state <> 'RESOLVED'",
    now, now, String(reason)).changes);
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

/**
 * pickQueued(limit, now, { boost, cap }) — QUEUED cases due now, by priority plus aging
 * MIN(cap, hours queued x boost) DESC, then oldest queued, then case_id (§8.3).
 * The V1 2-argument form is boost 0, cap 0 (priority DESC, oldest first).
 */
function pickQueued(limit, now, aging) {
  const t = Number.isFinite(now) ? now : Date.now();
  const a = aging || {};
  const boost = Number.isFinite(a.boost) ? a.boost : 0;
  const cap = Number.isFinite(a.cap) ? a.cap : 0;
  return _all(`SELECT * FROM ap_case WHERE state = 'QUEUED' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY (priority + MIN(?, CAST((? - COALESCE(queued_since, state_changed_at)) / 3600000 AS INTEGER) * ?)) DESC,
             COALESCE(queued_since, state_changed_at) ASC, case_id ASC
    LIMIT ?`, t, cap, t, boost, Math.max(1, limit | 0)).map(_parseCase);
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

function _findingItem(f) {
  return {
    evidenceId: f.evidence_id, source: f.source, sourceRef: f.source_ref, field: f.field, value: f.value_text,
    observedAt: f.observed_at, retrievedAt: f.retrieved_at, live: false, freshness: f.freshness, confidence: f.confidence,
    trust: f.trust, authorityTag: f.authority_tag, conflictGroup: f.conflict_group,
    flags: f.flags ? String(f.flags).split(',').filter(Boolean) : [],
  };
}

/** Findings of one run as pack items (used to resume from a checkpoint). */
function findingsForRun(runId) {
  return _all('SELECT * FROM ap_finding WHERE run_id = ? ORDER BY id', runId).map(_findingItem);
}

/** findingsForStep(stepId) -> the findings a tool step wrote, as pack items (V2 cross-run reuse, §6.2.5). */
function findingsForStep(stepId) {
  return _all('SELECT * FROM ap_finding WHERE step_id = ? ORDER BY id', stepId).map(_findingItem);
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

// ── V2 reads (no transaction) ───────────────────────────────────────────────

/** queuedCount() -> number of QUEUED cases. */
function queuedCount() {
  return _get("SELECT COUNT(*) AS n FROM ap_case WHERE state = 'QUEUED'").n;
}

/** listSteps(caseId, { runId, limit <= 200 }) -> steps, newest run first, seq ascending within a run. */
function listSteps(caseId, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(200, parseInt(o.limit, 10) || 200));
  const where = o.runId ? 's.case_id = ? AND s.run_id = ?' : 's.case_id = ?';
  const args = o.runId ? [caseId, o.runId] : [caseId];
  return _all(`SELECT s.* FROM ap_step s LEFT JOIN ap_run r ON r.run_id = s.run_id WHERE ${where}
      ORDER BY COALESCE(r.started_at, s.started_at) DESC, s.run_id DESC, s.seq ASC LIMIT ?`, ...args, limit).map(_parseStep);
}

/** stepsForRun(runId) -> steps of one run by seq. */
function stepsForRun(runId) {
  return _all('SELECT * FROM ap_step WHERE run_id = ? ORDER BY seq', runId).map(_parseStep);
}

/** findReusableStep(caseId, callKey, sinceMs) -> newest ok / empty tool step with that call_key since sinceMs, or null. */
function findReusableStep(caseId, callKey, sinceMs) {
  return _parseStep(_get(`SELECT * FROM ap_step WHERE case_id = ? AND call_key = ? AND status IN ('ok', 'empty') AND kind = 'tool'
      AND started_at >= ? ORDER BY started_at DESC, seq DESC LIMIT 1`, caseId, callKey, Number.isFinite(sinceMs) ? sinceMs : 0));
}

function _parsePass(p) {
  if (!p) return null;
  const out = Object.assign({}, p);
  for (const k of ['by_domicile_json', 'by_operator_json', 'by_owner_json', 'tokens_without_rows_json']) out[k.replace(/_json$/, '')] = _parse(p[k]);
  out.tokensWithoutRows = out.tokens_without_rows || [];
  return out;
}

// State-group counts of §8.1 / §10.1.
function _groupsAt(t) {
  const n = (sql, ...a) => _get('SELECT COUNT(*) AS n FROM ap_case WHERE ' + sql, ...a).n;
  return {
    detectedHeld: n("state = 'DETECTED'"),
    queued: n("state = 'QUEUED'"),
    active: n("state IN ('INVESTIGATING', 'ANALYZING')"),
    scheduled: n("state IN ('MONITORING', 'RECOMMENDATION_READY') AND next_review_at > ?", t),
    waiting: n("(state IN ('WAITING_FOR_DATA', 'AUTH_REQUIRED') OR (state IN ('MONITORING', 'RECOMMENDATION_READY', 'NEEDS_REVIEW') AND awaiting_sources IS NOT NULL AND awaiting_sources <> ''))"),
    review: n("state IN ('NEEDS_REVIEW', 'RECOMMENDATION_READY')"),
    deferredAi: n("state <> 'RESOLVED' AND ai_pending_reason IS NOT NULL"),
    paused: n("state = 'PAUSED'"),
    failed: n("state = 'FAILED'"),
    resolved: n("state = 'RESOLVED'"),
  };
}

/** coverage(now) -> { pass (latest ap_detect_pass, parsed) | null, reconcileOk, groups } */
function coverage(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const pass = _parsePass(_get('SELECT * FROM ap_detect_pass ORDER BY at DESC, rowid DESC LIMIT 1'));
  return { pass, reconcileOk: pass ? pass.reconcile_ok === 1 : null, groups: _groupsAt(t) };
}

/** listUnits({ coverage, eligibility, domicile, scac, q, limit 1..200 (50), offset }) -> { total, items } */
function listUnits(filter) {
  const f = filter || {};
  const where = [];
  const args = [];
  if (f.coverage) { where.push('coverage = ?'); args.push(String(f.coverage)); }
  if (f.eligibility) { where.push('eligibility = ?'); args.push(String(f.eligibility)); }
  if (f.domicile) { where.push('domicile = ?'); args.push(normUnit(f.domicile)); }
  if (f.scac) { where.push('operator = ?'); args.push(normUnit(f.scac)); }
  if (f.q) {
    const q = normUnit(f.q);
    if (q) { where.push('substr(unit_id, 1, length(?)) = ?'); args.push(q, q); }
  }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const limit = Math.max(1, Math.min(200, parseInt(f.limit, 10) || 50));
  const offset = Math.max(0, Math.min(100000, parseInt(f.offset, 10) || 0));
  const total = _get('SELECT COUNT(*) AS n FROM ap_unit' + w, ...args).n;
  const items = _all('SELECT * FROM ap_unit' + w + ' ORDER BY unit_id ASC LIMIT ? OFFSET ?', ...args, limit, offset);
  return { total, items };
}

/** getRecord(caseId) -> ap_record row with `record` parsed, or null. */
function getRecord(caseId) {
  const r = _get('SELECT * FROM ap_record WHERE case_id = ?', caseId);
  return r ? Object.assign({}, r, { record: _parse(r.record_json) }) : null;
}

/** listProposals(caseId) -> timeline proposals by event time. */
function listProposals(caseId) {
  return _all('SELECT * FROM ap_timeline_proposal WHERE case_id = ? ORDER BY COALESCE(event_at, discovered_at) ASC, proposal_id ASC', caseId);
}

const COMPLETED_OUTCOMES = "('recommendation', 'unchanged', 'resolved')";

/** queueStats(now) — §10.1 dashboard metric definitions. */
function queueStats(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const g = _groupsAt(t);
  const oldest = _get("SELECT MIN(COALESCE(queued_since, state_changed_at)) AS m FROM ap_case WHERE state = 'QUEUED'").m;
  const startedLast1h = _get('SELECT COUNT(*) AS n FROM ap_run WHERE started_at >= ?', t - HOUR).n;
  const completedLast6h = _get('SELECT COUNT(*) AS n FROM ap_run WHERE ended_at >= ? AND outcome IN ' + COMPLETED_OUTCOMES, t - 6 * HOUR).n;
  const open = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED'").n;
  const checked = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' AND last_checked_at IS NOT NULL").n;
  return {
    detectedHeld: g.detectedHeld, queued: g.queued, active: g.active, scheduled: g.scheduled, waiting: g.waiting,
    review: g.review, deferredAi: g.deferredAi,
    oldestQueuedAt: oldest == null ? null : oldest,
    oldestQueuedAgeMs: oldest == null ? null : t - oldest,
    startedLast1h, completedLast6h,
    queueCoveragePct: Math.round((100 * checked) / Math.max(1, open)),
    processingRatePerHour: Math.round((completedLast6h / 6) * 10) / 10,
  };
}

function _nearestRank(sorted, p) {
  if (!sorted.length) return null;
  const k = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, k) - 1];
}

/** aiMetrics(now, { cap }) — per AI call over the last 24 h (§10.1). */
function aiMetrics(now, opts) {
  const t = Number.isFinite(now) ? now : Date.now();
  const since = t - 24 * HOUR;
  const steps = _all("SELECT status, code, ai_latency_ms FROM ap_step WHERE kind = 'model' AND started_at >= ? AND status <> 'pending' LIMIT 5000", since);
  const v1 = _all(`SELECT ai_status, ai_latency_ms FROM ap_run r WHERE r.started_at >= ? AND r.ai_latency_ms IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ap_step s WHERE s.run_id = r.run_id AND s.kind = 'model') LIMIT 5000`, since);
  const lat = [];
  let failures = 0;
  for (const s of steps) {
    if (Number.isFinite(s.ai_latency_ms)) lat.push(s.ai_latency_ms);
    if (s.status === 'invalid' || ['ai_timeout', 'ai_unavailable', 'reason-timeout'].includes(s.code)) failures++;
  }
  for (const r of v1) {
    if (Number.isFinite(r.ai_latency_ms)) lat.push(r.ai_latency_ms);
    if (['invalid', 'timeout', 'unavailable'].includes(r.ai_status)) failures++;
  }
  lat.sort((a, b) => a - b);
  const calls = steps.length + v1.length;
  const today = parseInt(_getMetaInTx('ai_calls:' + localDate(t)) || '0', 10) || 0;
  const cap = opts && Number.isFinite(opts.cap) ? opts.cap : null;
  return { calls, p50Ms: _nearestRank(lat, 50), p95Ms: _nearestRank(lat, 95), failures, failureRate: failures / Math.max(1, calls), callsToday: today, cap };
}

const SOURCE_BUCKETS = ['ok', 'not_warm', 'auth', 'cache_only', 'rate_limited', 'error', 'timeout'];
function _bucketOf(status, code) {
  const c = String(code || '');
  if (status === 'ok' || status === 'empty') return 'ok';
  if (status === 'auth_required') return 'auth';
  if (status === 'timeout') return 'timeout';
  if (status === 'error') return 'error';
  if (status === 'unavailable') {
    if (/RATE_LIMITED/.test(c)) return 'rate_limited';
    if (/NOT_WARM/.test(c)) return 'not_warm';
    return 'error';
  }
  if (status === 'skipped' && (c === 'SOURCE_UNAVAILABLE' || /^LIVE_/.test(c) || c === 'CACHE_FRESH')) return 'cache_only';
  return null;
}
function _bucketOfErrorCode(code) {
  const c = String(code || '').toUpperCase();
  if (/RATE/.test(c)) return 'rate_limited';
  if (/TIMEOUT/.test(c)) return 'timeout';
  if (/AUTH/.test(c)) return 'auth';
  if (/NOT_WARM/.test(c)) return 'not_warm';
  return 'error';
}

/** sourceMetrics(now) -> { <source>: { ok, not_warm, auth, cache_only, rate_limited, error, timeout } } over the last 24 h (§10.1). */
function sourceMetrics(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const since = t - 24 * HOUR;
  const out = {};
  const row = (s) => out[s] || (out[s] = SOURCE_BUCKETS.reduce((o, k) => { o[k] = 0; return o; }, {}));
  for (const r of _all('SELECT source_calls_json FROM ap_run WHERE started_at >= ? AND source_calls_json IS NOT NULL', since)) {
    const sc = _parse(r.source_calls_json);
    if (!sc || typeof sc !== 'object') continue;
    for (const src of Object.keys(sc)) {
      const v = sc[src] || {};
      const o = row(src);
      o.ok += Number(v.live) || 0;
      if (v.status === 'not_warm') o.not_warm++;
      if (typeof v.status === 'string' && v.status.startsWith('cache_only')) o.cache_only++;
      const errs = v.errors && typeof v.errors === 'object' ? v.errors : {};
      for (const code of Object.keys(errs)) o[_bucketOfErrorCode(code)] += Number(errs[code]) || 0;
    }
  }
  for (const r of _all("SELECT source, status, code, COUNT(*) AS n FROM ap_step WHERE kind = 'tool' AND live = 1 AND started_at >= ? GROUP BY source, status, code", since)) {
    const b = _bucketOf(r.status, r.code);
    if (!b || !r.source) continue;
    row(r.source)[b] += r.n;
  }
  return out;
}

/** aiBacklog(now, { cap }) — §6.7 backlog read model. */
function aiBacklog(now, opts) {
  const t = Number.isFinite(now) ? now : Date.now();
  const notYetAi = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' AND (ai_investigated_at IS NULL OR ai_pending_reason IS NOT NULL)").n;
  const noAiConclusion = _get("SELECT COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' AND COALESCE(json_extract(ai_findings_json, '$.generatedBy'), '') <> 'ai'").n;
  const deferred = {};
  for (const r of _all("SELECT ai_pending_reason AS k, COUNT(*) AS n FROM ap_case WHERE state <> 'RESOLVED' AND ai_pending_reason IS NOT NULL GROUP BY ai_pending_reason")) deferred[r.k] = r.n;
  const oldest = _get("SELECT MIN(state_changed_at) AS m FROM ap_case WHERE state <> 'RESOLVED' AND ai_pending_reason IS NOT NULL").m;
  const completed24h = _get('SELECT COUNT(*) AS n FROM ap_run WHERE ended_at >= ? AND outcome IN ' + COMPLETED_OUTCOMES, t - 24 * HOUR).n;
  const completed6h = _get('SELECT COUNT(*) AS n FROM ap_run WHERE ended_at >= ? AND outcome IN ' + COMPLETED_OUTCOMES, t - 6 * HOUR).n;
  const turns = _get(`SELECT AVG(n) AS a FROM (SELECT r.run_id, (SELECT COUNT(*) FROM ap_step s WHERE s.run_id = r.run_id AND s.kind = 'model') AS n
      FROM ap_run r WHERE r.started_at >= ? GROUP BY r.run_id)`, t - 24 * HOUR).a;
  return {
    notYetAi, noAiConclusion, deferred, oldestDeferredAt: oldest == null ? null : oldest,
    callsToday: parseInt(_getMetaInTx('ai_calls:' + localDate(t)) || '0', 10) || 0,
    cap: opts && Number.isFinite(opts.cap) ? opts.cap : null,
    completed24h, ratePerHour6h: Math.round((completed6h / 6) * 10) / 10,
    avgTurns24h: turns == null ? null : Math.round(turns * 100) / 100,
  };
}

module.exports = {
  // writes (one transaction each)
  upsertDetected, transition, persistRun, reserveAiCallAndMarkPending, sweepResolution,
  pauseCases, requeueCases, lease, openRun, closeRun, writeCheckpoint, writeFindings, copyRunForResume,
  recoverAbandoned, prune, review, bumpCounter, setMeta, appendEvent,
  // V2 writes
  applyPass, promoteDetected, leaseRun, renewLease, beginStep, reserveAiTurn, completeStep, writeMemory,
  requestDeep, setSliceBaseline, releaseAiDeferred,
  // reads
  getMeta, listCases, getCase, counts, listOpen, pickQueued, findResumable, runsSince,
  getRun, findingsForRun, etaDueFired, aiRunStats,
  // V2 reads
  queuedCount, listSteps, stepsForRun, findReusableStep, findingsForStep, coverage, listUnits, getRecord, listProposals,
  queueStats, aiMetrics, sourceMetrics, aiBacklog,
  ISSUE_KEY,
};
