'use strict';
/**
 * jobs/schema.js — relational schema for durable jobs (Phase 7, design §2).
 *
 * Two tables in the EXISTING <userData>/transactional.sqlite (same WAL db as
 * the kv ledgers and ri_*), reached through an adapter { id, exec, prepare,
 * getDb }. Synchronous only. No CHECK on state (the store layer owns it) and
 * no PRAGMA user_version (global to the shared db); additive _migrate().
 *
 * ensureSchema(adapter) -> { ok:true } | { ok:false, code:'unavailable'|'busy'|'sqlite', error }
 * Never throws. Memoized per adapter.id (db path) only on ok.
 */

const JOBS_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  scope_key       TEXT NOT NULL,
  generation      INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  state           TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  owner           TEXT,
  lease_until     INTEGER,
  checkpoint_json TEXT,
  last_error      TEXT,
  history_json    TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,
  finished_at     INTEGER,
  recovered_at    INTEGER
);
CREATE TABLE IF NOT EXISTS job_checkpoint (
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  unit_key    TEXT NOT NULL,
  status      TEXT NOT NULL,
  sig         TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (job_id, unit_key)
) WITHOUT ROWID;
`;

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_jobs_open_scope ON jobs(type, scope_key)
  WHERE state NOT IN ('completed','failed','cancelled');
CREATE INDEX IF NOT EXISTS ix_jobs_state_lease ON jobs(state, lease_until);
CREATE INDEX IF NOT EXISTS ix_jobs_type_state  ON jobs(type, state);
CREATE INDEX IF NOT EXISTS ix_jobs_finished    ON jobs(finished_at) WHERE finished_at IS NOT NULL;
`;

// v2+ columns go here (ALTER TABLE … ADD COLUMN), each in its own try/catch.
const MIGRATIONS = [];

let _memo = new Set();

function _errMsg(e) { return String((e && e.message) || e || 'error').slice(0, 200); }

function _classify(e) {
  const code = e && typeof e.errcode === 'number' ? (e.errcode & 0xff) : null;
  if (code === 5 || code === 6 || /database is (locked|busy)/i.test(_errMsg(e))) return 'busy';
  return 'sqlite';
}

function _migrate(adapter) {
  for (const sql of MIGRATIONS) {
    try { adapter.exec(sql); } catch (_) { /* duplicate column — already migrated */ }
  }
}

function ensureSchema(adapter) {
  let id = null;
  try { id = adapter ? adapter.id : null; } catch (_) { id = null; }
  if (id && _memo.has(id)) return { ok: true };
  try {
    if (!adapter || typeof adapter.exec !== 'function') return { ok: false, code: 'unavailable', error: 'no adapter' };
    if (typeof adapter.getDb === 'function' && !adapter.getDb()) return { ok: false, code: 'unavailable', error: 'node:sqlite unavailable' };
    if (adapter.exec(DDL) === false) return { ok: false, code: 'unavailable', error: 'node:sqlite unavailable' };
    adapter.exec(INDEXES);
    _migrate(adapter);
    if (id) _memo.add(id);
    return { ok: true };
  } catch (e) {
    return { ok: false, code: _classify(e), error: _errMsg(e) };
  }
}

function _resetForTests() { _memo = new Set(); }

module.exports = { ensureSchema, JOBS_SCHEMA_VERSION, DDL, INDEXES, MIGRATIONS, _migrate, _resetForTests };
