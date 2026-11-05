'use strict';
/**
 * jobs/store.js — the ONLY module that issues jobs SQL (Phase 7, design §3–§6).
 *
 * Fully synchronous: no promise-returning functions anywhere in this file
 * (a static test scans for the keywords). Every operation is one short
 * IMMEDIATE transaction through _tx(), or one autocommit statement (renew,
 * setCheckpoint, summary reads). Nothing here ever runs network / browser /
 * AI work, and no API accepts a callback that runs inside a transaction
 * except the internal _tx guard, which rejects promise-returning callbacks.
 *
 * createJobStore({ adapter, now, owner, log }) -> instance with its own
 * _active set, owner/boot, _lastPrune, _recoveryPending, lastRecovery,
 * lastError and busy-log limiter (nothing module-global).
 */

const crypto = require('crypto');
const { STATES, TERMINAL, LEASED, WAITING, canTransition } = require('./states');
const types = require('./types');

class JobsTxError extends Error {
  constructor(msg) { super(msg); this.name = 'JobsTxError'; }
}

const MAX_CKPT = 16 * 1024;
const MAX_DETAIL = 2048;
const MAX_ERR = 500;
const HIST_CAP = 20;
const RECOVER_BATCH = 200;
const PRUNE_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PRUNE_KEEP = 200;
const BUSY_LOG_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^.{1,200}$/s;
const TERM_SQL = "('completed','failed','cancelled')";
const LEASED_SQL = "('claimed','running','verifying')";

function parseOwner(s) {
  const p = String(s || '').split('|');
  return p.length >= 3 ? { host: p[0], pid: p[1], boot: p.slice(2).join('|') } : null;
}

function _genId(t) { return 'job_' + Number(t).toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function _errText(e) { return String((e && e.message) || e || 'error').slice(0, MAX_ERR); }
function _parse(s, d) { if (!s) return d; try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : d; } catch (_) { return d; } }

function _classify(e) {
  if (e instanceof JobsTxError) {
    return (e.message === 'begin failed' || e.message === 'prepare returned null') ? 'sqlite' : 'tx-misuse';
  }
  const msg = String((e && e.message) || e || '');
  const code = e && typeof e.errcode === 'number' ? (e.errcode & 0xff) : null;
  if (code === 5 || code === 6 || /database is (locked|busy)/i.test(msg)) return 'busy';
  if (code === 19 || /constraint failed/i.test(msg)) {
    return /jobs\.type, jobs\.scope_key/.test(msg) ? 'busy' : 'constraint';
  }
  return 'sqlite';
}

function createJobStore(opts) {
  const o = opts || {};
  const adapter = o.adapter;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const owner = String(o.owner || '');
  const me = parseOwner(owner) || { host: '', pid: '', boot: owner };
  const log = o.log || { debug() {}, info() {}, warn() {}, error() {} };

  let _inTx = false;
  const _busyLogAt = new Map();

  const inst = {
    owner, now,
    _active: new Set(),
    _handles: new Set(),
    _lastPrune: 0,
    _recoveryPending: false,
    lastRecovery: null,
    lastError: null,
    txMisuse: 0,
  };

  // ── Transaction guard ────────────────────────────────────────────────────
  function _db() { try { return typeof adapter.getDb === 'function' ? adapter.getDb() : null; } catch (_) { return null; } }
  function _isTx() {
    if (_inTx) return true;
    const db = _db();
    return !!(db && db.isTransaction === true);
  }
  function _rollback() { try { adapter.exec('ROLLBACK;'); } catch (_) {} _inTx = false; }

  function _tx(fn) {
    if (typeof fn !== 'function') throw new JobsTxError('fn required');
    if (fn.constructor && fn.constructor.name === 'AsyncFunction') throw new JobsTxError('async fn not allowed');
    if (_isTx()) throw new JobsTxError('nested');
    if (adapter.exec('BEGIN IMMEDIATE;') === false) throw new JobsTxError('begin failed');
    _inTx = true;
    let out;
    try { out = fn(); } catch (e) { _rollback(); throw e; }
    if (out && typeof out.then === 'function') { _rollback(); throw new JobsTxError('thenable returned'); }
    try { adapter.exec('COMMIT;'); } catch (e) { _rollback(); throw e; }
    _inTx = false;
    return out;
  }

  function _stmt(sql) {
    const s = adapter.prepare(sql);
    if (!s) throw new JobsTxError('prepare returned null');
    return s;
  }

  function _fail(op, e) {
    const code = _classify(e);
    const error = _errText(e);
    if (code === 'busy') {
      const last = _busyLogAt.get(op) || 0;
      const t = Date.now();
      if (t - last >= BUSY_LOG_MS) { _busyLogAt.set(op, t); try { log.warn('[jobs] ' + op + ': database busy (' + error + ')'); } catch (_) {} }
    } else {
      inst.lastError = { message: error, at: now(), code, op };
      if (code === 'tx-misuse') { inst.txMisuse++; try { log.error('[jobs] ' + op + ': ' + error); } catch (_) {} }
      else { try { log.warn('[jobs] ' + op + ' failed (' + code + '): ' + error); } catch (_) {} }
    }
    return { ok: false, code, error };
  }

  // ── Row helpers (must run inside _tx or as autocommit reads) ─────────────
  function _row(id) { return _stmt('SELECT * FROM jobs WHERE id = ?').get(id) || null; }
  function _openRow(type, scope) {
    return _stmt('SELECT * FROM jobs WHERE type = ? AND scope_key = ? AND state NOT IN ' + TERM_SQL).get(type, scope) || null;
  }
  function _hist(row, to, note, t) {
    const h = Array.isArray(_parse(row.history_json, null)) ? JSON.parse(row.history_json) : [];
    h.push({ at: t, from: row.state, to, note: note ? String(note).slice(0, 200) : undefined });
    return JSON.stringify(h.slice(-HIST_CAP));
  }

  const PATCH_COLS = ['checkpoint_json', 'last_error', 'recovered_at', 'lease_until', 'owner'];

  // CAS state change on an already-read row. Returns { ok, ... }.
  function _applyInTx(row, to, a) {
    a = a || {};
    if (!STATES.includes(to)) return { ok: false, error: 'unknown state ' + to };
    if (row.state === 'recovery_required' && !a._reconcile) return { ok: false, error: 'recovery_required exits only via reconcile()' };
    if (!canTransition(row.state, to)) {
      try { log.warn('[jobs] illegal transition ' + row.state + ' -> ' + to + ' (' + row.id + ')'); } catch (_) {}
      return { ok: false, error: 'illegal transition ' + row.state + ' -> ' + to };
    }
    const t = now();
    const sets = ['state = ?', 'updated_at = ?', 'history_json = ?'];
    const vals = [to, t, _hist(row, to, a.note, t)];
    const leaseCleared = TERMINAL.includes(to) || WAITING.includes(to) || to === 'queued' || to === 'recovery_required';
    if (leaseCleared) sets.push('lease_until = NULL');
    if (TERMINAL.includes(to)) { sets.push('finished_at = ?'); vals.push(t); }
    if (to === 'running') { sets.push('started_at = COALESCE(started_at, ?)'); vals.push(t); }
    const patch = a.patch || {};
    for (const c of PATCH_COLS) {
      if (!Object.prototype.hasOwnProperty.call(patch, c)) continue;
      if (c === 'lease_until' && leaseCleared) continue;
      sets.push(c + ' = ?'); vals.push(patch[c] == null ? null : patch[c]);
    }
    let where = 'id = ? AND state = ? AND attempt = ?';
    const wv = [row.id, row.state, row.attempt];
    if (a.owner != null) { where += ' AND owner = ?'; wv.push(a.owner); }
    const r = _stmt('UPDATE jobs SET ' + sets.join(', ') + ' WHERE ' + where).run(...vals, ...wv);
    if (Number(r.changes) !== 1) return { ok: false, code: 'lost', error: 'cas failed' };
    return { ok: true, from: row.state, to };
  }

  function _transitionInTx(id, to, a) {
    a = a || {};
    const row = _row(id);
    if (!row) return { ok: false, code: 'lost', error: 'not found' };
    if (a.expectFrom && row.state !== a.expectFrom) return { ok: false, code: 'lost', error: 'state changed', state: row.state };
    if (a.attempt != null && row.attempt !== a.attempt) return { ok: false, code: 'lost', error: 'attempt fence' };
    if (a.owner != null && row.owner !== a.owner) return { ok: false, code: 'lost', error: 'owner fence' };
    return _applyInTx(row, to, a);
  }

  function transition(id, to, a) {
    try { return _tx(() => _transitionInTx(id, to, a)); }
    catch (e) { return _fail('transition', e); }
  }

  const RECONCILE = Object.freeze({ 'not-done': 'queued', done: 'completed', failed: 'failed', cancel: 'cancelled' });
  function reconcile(id, outcome) {
    if (typeof outcome !== 'string' || !Object.prototype.hasOwnProperty.call(RECONCILE, outcome)) {
      return { ok: false, error: 'invalid outcome' };
    }
    return transition(id, RECONCILE[outcome], { expectFrom: 'recovery_required', _reconcile: true, note: 'reconcile: ' + outcome });
  }

  // ── Orphan detection + tx-free recovery helper ───────────────────────────
  function _isOrphan(row, t) {
    if (inst._active.has(row.id)) return false;               // a live job in this process is never stolen
    const ow = parseOwner(row.owner);
    if (ow && me.host && ow.host === me.host && ow.boot !== me.boot) return true;  // previous boot, same host: dead
    return row.lease_until == null || row.lease_until < t;
  }

  function _recoverRowInTx(row, t) {
    if (!_isTx()) throw new JobsTxError('not in tx');
    const def = types.get(row.type);
    let to = null;
    let note = '';
    const patch = { recovered_at: t };
    if (row.state === 'claimed') {
      to = 'queued'; note = 'recovered: claimed, no work started';
    } else if (row.state === 'running' || row.state === 'verifying') {
      const ow = parseOwner(row.owner);
      const iso = row.lease_until != null ? new Date(row.lease_until).toISOString() : 'none';
      if (!def) { to = 'recovery_required'; note = 'unknown type ' + row.type; }
      else if (def.sideEffects === 'external') { to = 'recovery_required'; note = 'side-effecting job interrupted; needs reconciliation'; }
      else if (def.recovery === 'retry-on-demand') { to = 'failed'; note = 'interrupted; read-only draft, re-run on demand'; }
      else if (row.attempt >= row.max_attempts) { to = 'failed'; note = 'interrupted ' + row.attempt + ' times; resume abandoned'; }
      else { to = 'queued'; note = 'interrupted (owner ' + (ow ? ow.boot : row.owner) + ' lease ' + iso + ')'; }
      patch.last_error = note;
    } else if (row.state === 'queued') {
      if (!def || (t - row.created_at) <= def.resumeMaxAgeMs) return 'untouched';
      to = 'cancelled'; note = 'superseded: too old to resume';
    } else {
      return 'untouched';
    }
    const r = _applyInTx(row, to, { note, patch });
    if (!r.ok) return 'untouched';
    return to === 'queued' ? 'requeued' : to;
  }

  function recover(at) {
    const t = at != null ? at : now();
    const counts = { requeued: 0, recoveryRequired: 0, failed: 0, cancelled: 0 };
    try {
      const rows = _stmt("SELECT * FROM jobs WHERE state IN ('claimed','running','verifying','queued')").all();
      const cand = rows.filter((r) => r.state === 'queued' || _isOrphan(r, t));
      for (let i = 0; i < cand.length; i += RECOVER_BATCH) {
        const chunk = cand.slice(i, i + RECOVER_BATCH);
        const c = _tx(() => {
          const local = { requeued: 0, recoveryRequired: 0, failed: 0, cancelled: 0 };
          for (const r0 of chunk) {
            const r = _row(r0.id);
            if (!r || r.state !== r0.state || r.attempt !== r0.attempt) continue;
            if (LEASED.includes(r.state) && !_isOrphan(r, t)) continue;
            const a = _recoverRowInTx(r, t);
            if (a === 'requeued') local.requeued++;
            else if (a === 'recovery_required') local.recoveryRequired++;
            else if (a === 'failed') local.failed++;
            else if (a === 'cancelled') local.cancelled++;
          }
          return local;
        });
        for (const k of Object.keys(counts)) counts[k] += c[k];
      }
      inst.lastRecovery = Object.assign({ at: t }, counts);
      if (counts.requeued || counts.recoveryRequired || counts.failed || counts.cancelled) {
        try { log.info('[jobs] startup recovery: requeued=' + counts.requeued + ' recovery_required=' + counts.recoveryRequired + ' failed=' + counts.failed + ' cancelled=' + counts.cancelled); } catch (_) {}
      }
      return Object.assign({ ok: true }, counts);
    } catch (e) { return _fail('recover', e); }
  }

  // ── Retention ────────────────────────────────────────────────────────────
  function prune(at) {
    const t = at != null ? at : now();
    try {
      return _tx(() => {
        let cancelled = 0;
        for (const r of _stmt("SELECT * FROM jobs WHERE state = 'queued'").all()) {
          const def = types.get(r.type);
          if (!def || (t - r.created_at) <= def.resumeMaxAgeMs) continue;
          if (_applyInTx(r, 'cancelled', { note: 'superseded: too old to resume' }).ok) cancelled++;
        }
        const del = _stmt('DELETE FROM jobs WHERE state IN ' + TERM_SQL + ' AND finished_at IS NOT NULL AND finished_at < ?').run(t - PRUNE_AGE_MS);
        let deleted = Number(del.changes) || 0;
        for (const x of _stmt('SELECT DISTINCT type FROM jobs WHERE state IN ' + TERM_SQL).all()) {
          const r = _stmt('DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE type = ? AND state IN ' + TERM_SQL +
            ' ORDER BY finished_at DESC, id DESC LIMIT -1 OFFSET ' + PRUNE_KEEP + ')').run(x.type);
          deleted += Number(r.changes) || 0;
        }
        _stmt('DELETE FROM job_checkpoint WHERE job_id NOT IN (SELECT id FROM jobs)').run();
        return { ok: true, cancelled, deleted };
      });
    } catch (e) { return _fail('prune', e); }
  }

  // ── Claim (begin step 2) ─────────────────────────────────────────────────
  function _insertInTx(type, scope, def, t) {
    const g = _stmt('SELECT COALESCE(MAX(generation), 0) + 1 AS g FROM jobs WHERE type = ? AND scope_key = ?').get(type, scope).g;
    const id = _genId(t);
    _stmt('INSERT INTO jobs (id, type, scope_key, generation, idempotency_key, state, attempt, max_attempts, created_at, updated_at, history_json)' +
      " VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)")
      .run(id, type, scope, g, type + ':' + scope + ':' + g, def.maxAttempts, t, t, JSON.stringify([{ at: t, from: null, to: 'queued' }]));
    return _row(id);
  }

  function _loadCheckpointsInTx(id) {
    return _stmt('SELECT unit_key, status, sig, attempts, detail_json FROM job_checkpoint WHERE job_id = ?').all(id);
  }

  function _claimInTx(row, def, t, resumed) {
    const hist = _hist(row, 'claimed', resumed ? 'resume' : null, t);
    const r = _stmt("UPDATE jobs SET state = 'claimed', owner = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?, history_json = ?" +
      " WHERE id = ? AND state = 'queued'").run(owner, t + def.leaseMs, t, hist, row.id);
    if (Number(r.changes) !== 1) return { kind: 'busy', row };
    let checkpoints = [];
    if (resumed) {
      // Per-unit crash-loop guard (design §5).
      _stmt("UPDATE job_checkpoint SET status = 'skipped', detail_json = ?, updated_at = ? WHERE job_id = ? AND status = 'in_progress' AND attempts >= 2")
        .run(JSON.stringify({ reason: 'crash-loop guard' }), t, row.id);
      checkpoints = _loadCheckpointsInTx(row.id);
    }
    return { kind: 'claimed', row: _row(row.id), resumed, checkpoints };
  }

  function beginTx(type, scope, def) {
    return _tx(() => {
      const t = now();
      const step = (row, allowRecover) => {
        if (!row) return _claimInTx(_insertInTx(type, scope, def, t), def, t, false);
        if (row.state === 'queued') {
          if ((t - row.created_at) <= def.resumeMaxAgeMs && row.attempt < row.max_attempts) {
            return _claimInTx(row, def, t, row.attempt > 0);
          }
          _applyInTx(row, 'cancelled', { note: 'superseded' });
          return _claimInTx(_insertInTx(type, scope, def, t), def, t, false);
        }
        if (LEASED.includes(row.state)) {
          if (allowRecover && _isOrphan(row, t)) {
            _recoverRowInTx(row, t);
            return step(_openRow(type, scope), false);
          }
          return { kind: 'busy', row };
        }
        return { kind: 'blocked', state: row.state, row };
      };
      return step(_openRow(type, scope), true);
    });
  }

  function begin(type, scope, def) {
    try { return Object.assign({ ok: true }, beginTx(type, scope, def)); }
    catch (e) { return _fail('begin', e); }
  }

  // ── Fenced handle writes ─────────────────────────────────────────────────
  function _fenceInTx(f) {
    const r = _stmt('SELECT 1 AS x FROM jobs WHERE id = ? AND owner = ? AND attempt = ? AND state IN ' + LEASED_SQL).get(f.id, f.owner, f.attempt);
    return !!r;
  }

  function renew(f, leaseUntil) {
    try {
      const r = _stmt('UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND owner = ? AND attempt = ? AND state IN ' + LEASED_SQL)
        .run(leaseUntil, now(), f.id, f.owner, f.attempt);
      return Number(r.changes) === 1 ? { ok: true } : { ok: false, code: 'lost', error: 'lease lost' };
    } catch (e) { return _fail('renew', e); }
  }

  function _validKey(k) { return typeof k === 'string' && KEY_RE.test(k); }

  function unitsStarted(f, keys) {
    const list = (Array.isArray(keys) ? keys : []).filter(_validKey);
    try {
      return _tx(() => {
        if (!_fenceInTx(f)) return { ok: false, code: 'lost', error: 'lease lost' };
        const t = now();
        const s = _stmt("INSERT INTO job_checkpoint (job_id, unit_key, status, attempts, updated_at) VALUES (?, ?, 'in_progress', 1, ?)" +
          " ON CONFLICT(job_id, unit_key) DO UPDATE SET status = 'in_progress', attempts = attempts + 1, updated_at = excluded.updated_at");
        for (const k of list) s.run(f.id, k, t);
        return { ok: true };
      });
    } catch (e) { return _fail('unitsStarted', e); }
  }

  function unitsSettled(f, entries) {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => e && _validKey(e.key) && (e.status === 'done' || e.status === 'failed'));
    try {
      return _tx(() => {
        if (!_fenceInTx(f)) return { ok: false, code: 'lost', error: 'lease lost' };
        const t = now();
        const s = _stmt('INSERT INTO job_checkpoint (job_id, unit_key, status, sig, attempts, detail_json, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)' +
          ' ON CONFLICT(job_id, unit_key) DO UPDATE SET status = excluded.status, sig = excluded.sig, detail_json = excluded.detail_json, updated_at = excluded.updated_at');
        for (const e of list) {
          const sig = typeof e.sig === 'string' && e.sig.length <= 64 ? e.sig : null;
          let detail = null;
          if (e.detail != null) { try { detail = JSON.stringify(e.detail); } catch (_) { detail = null; } if (detail && detail.length > MAX_DETAIL) detail = null; }
          s.run(f.id, e.key, e.status, sig, detail, t);
        }
        return { ok: true };
      });
    } catch (e) { return _fail('unitsSettled', e); }
  }

  function setCheckpoint(f, json) {
    if (typeof json !== 'string' || json.length > MAX_CKPT) return { ok: false, code: 'too-large', error: 'checkpoint over 16 KB' };
    try {
      const r = _stmt('UPDATE jobs SET checkpoint_json = ?, updated_at = ? WHERE id = ? AND owner = ? AND attempt = ? AND state IN ' + LEASED_SQL)
        .run(json, now(), f.id, f.owner, f.attempt);
      return Number(r.changes) === 1 ? { ok: true } : { ok: false, code: 'lost', error: 'lease lost' };
    } catch (e) { return _fail('setCheckpoint', e); }
  }

  // Read-only autocommit look at the open row for (type, scope).
  function peekOpen(type, scope) {
    try {
      const row = _openRow(type, scope);
      if (!row) return { ok: true, row: null };
      const n = _stmt("SELECT COUNT(*) AS n FROM job_checkpoint WHERE job_id = ? AND status = 'done'").get(row.id).n;
      return { ok: true, row: { id: row.id, state: row.state, attempt: row.attempt, checkpoint: _parse(row.checkpoint_json, {}), settled: Number(n) || 0 } };
    } catch (e) { return _fail('peekOpen', e); }
  }

  function loadCheckpoints(id) {
    try { return { ok: true, rows: _loadCheckpointsInTx(id) }; }
    catch (e) { return _fail('loadCheckpoints', e); }
  }

  // ── Health summary (read-only autocommit SELECTs) ────────────────────────
  function summary(at) {
    const t = at != null ? at : now();
    const known = new Set(types.names());
    const counts = {};
    let open = 0, recoveryRequired = 0, foreign = 0, failed24h = 0;
    for (const r of _stmt('SELECT type, state, COUNT(*) AS n FROM jobs GROUP BY type, state').all()) {
      const n = Number(r.n) || 0;
      if (!known.has(r.type)) { foreign += n; continue; }
      if (Object.keys(counts).length >= 10 && !counts[r.type]) continue;
      (counts[r.type] = counts[r.type] || {})[r.state] = n;
      if (!TERMINAL.includes(r.state)) open += n;
      if (r.state === 'recovery_required') recoveryRequired += n;
    }
    for (const r of _stmt("SELECT type, COUNT(*) AS n FROM jobs WHERE state = 'failed' AND finished_at >= ? GROUP BY type").all(t - DAY_MS)) {
      if (known.has(r.type)) failed24h += Number(r.n) || 0;
    }
    let oldestRunning = null;
    for (const r of _stmt('SELECT id, type, scope_key, started_at, created_at, lease_until, attempt FROM jobs WHERE state IN ' + LEASED_SQL +
      ' ORDER BY COALESCE(started_at, created_at) ASC LIMIT 20').all()) {
      if (!known.has(r.type)) continue;
      oldestRunning = { id: r.id, type: r.type, scopeKey: r.scope_key, startedAt: r.started_at, leaseUntil: r.lease_until, attempt: r.attempt,
        leaseExpired: r.lease_until != null && r.lease_until < t };
      break;
    }
    const rr = [];
    for (const r of _stmt("SELECT id, type, scope_key, updated_at, last_error FROM jobs WHERE state = 'recovery_required' ORDER BY updated_at DESC LIMIT 50").all()) {
      if (!known.has(r.type)) continue;
      if (rr.length >= 5) break;
      rr.push({ id: r.id, type: r.type, scopeKey: r.scope_key, updatedAt: r.updated_at, lastError: r.last_error });
    }
    return {
      counts,
      totals: { open, recoveryRequired, failed24h, foreign },
      oldestRunning,
      recoveryRequiredCount: recoveryRequired,
      recoveryRequired: rr,
      lastRecovery: inst.lastRecovery,
      lastError: inst.lastError ? { message: inst.lastError.message, at: inst.lastError.at } : null,
    };
  }

  function _stopAllTimersForTests() {
    for (const h of Array.from(inst._handles)) { try { h._stopTimersForTests(); } catch (_) {} }
  }

  return Object.assign(inst, {
    _tx, _stmt, _classify, _isTx, _recoverRowInTx, _isOrphan,
    transition, reconcile, recover, prune, beginTx, begin,
    renew, unitsStarted, unitsSettled, setCheckpoint, loadCheckpoints, peekOpen, summary,
    _stopAllTimersForTests,
  });
}

module.exports = { createJobStore, JobsTxError, parseOwner, _classify, MAX_CKPT };
