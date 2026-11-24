'use strict';
/**
 * autopilot/schema.js — ap_* tables in the existing transactional.sqlite
 * (§B5.1, pattern of src/repair-intel/schema.js). Additive and idempotent.
 *
 * Plan R1: last_down_build_at / last_missing_build_at hold the fleet-freshness
 * build time (lastOkAt), never fleetData.syncedAt. Plan R3: review_accepted_code.
 *
 * Nothing here runs at require time. The controller calls ensureSchema() once
 * per process, only while the master switch is on.
 */

const engine = require('../store/sqlite_engine');

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS ap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ap_case (
  case_id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL,
  domicile TEXT, issue_key TEXT NOT NULL,
  state TEXT NOT NULL, prev_state TEXT, pause_reason TEXT, state_changed_at INTEGER NOT NULL,
  opened_by TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  primary_reason TEXT,
  wo_ids_json TEXT,
  down_since INTEGER, days_down REAL,
  last_down_build_at INTEGER,
  repair_phase TEXT,
  last_vendor_update_at INTEGER, last_vendor_update_source TEXT,
  last_logged_update_at INTEGER,
  eta_json TEXT,
  blockers_json TEXT, responsible_party TEXT,
  ai_findings_json TEXT,
  recommendation_json TEXT, recommendation_hash TEXT,
  next_review_at INTEGER, last_checked_at INTEGER,
  evidence_fp TEXT, ai_fp TEXT,
  cheap_fp TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error_code TEXT,
  ai_defer_count INTEGER NOT NULL DEFAULT 0, ai_reject_streak INTEGER NOT NULL DEFAULT 0,
  ai_retry_at INTEGER,
  review_status TEXT NOT NULL DEFAULT 'none',
  review_note TEXT, reviewed_at INTEGER,
  review_accepted_code TEXT,
  resolution_json TEXT, prior_case_id TEXT,
  lease_owner TEXT, lease_until INTEGER,
  missing_syncs INTEGER NOT NULL DEFAULT 0,
  last_missing_build_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ap_run (
  run_id TEXT PRIMARY KEY, case_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER,
  trigger TEXT NOT NULL,
  step TEXT NOT NULL,
  checkpoint_json TEXT,
  resumed_from TEXT,
  outcome TEXT,
  ai_status TEXT,
  ai_request_id TEXT, ai_latency_ms INTEGER, ai_lane TEXT, ai_model TEXT, ai_isolated INTEGER,
  source_calls_json TEXT,
  plan_json TEXT,
  error_code TEXT, job_id TEXT, cpu_ms INTEGER, duration_ms INTEGER
);
CREATE TABLE IF NOT EXISTS ap_finding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, run_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source TEXT NOT NULL, source_ref TEXT, field TEXT NOT NULL, value_text TEXT,
  observed_at INTEGER, retrieved_at INTEGER NOT NULL,
  freshness TEXT NOT NULL, confidence REAL NOT NULL, trust TEXT NOT NULL,
  authority_tag TEXT, conflict_group TEXT, flags TEXT
);
CREATE TABLE IF NOT EXISTS ap_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT, at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_state TEXT, to_state TEXT, actor TEXT NOT NULL,
  reason_code TEXT, detail_json TEXT, run_id TEXT
);
`;

const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_case_open ON ap_case(unit_id, issue_key) WHERE state <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS ix_ap_case_state_due ON ap_case(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_ap_case_review ON ap_case(next_review_at);
CREATE INDEX IF NOT EXISTS ix_ap_case_dom ON ap_case(domicile, state);
CREATE INDEX IF NOT EXISTS ix_ap_run_case ON ap_run(case_id, started_at);
CREATE INDEX IF NOT EXISTS ix_ap_finding_run ON ap_finding(run_id);
CREATE INDEX IF NOT EXISTS ix_ap_finding_case ON ap_finding(case_id);
CREATE INDEX IF NOT EXISTS ix_ap_event_case ON ap_event(case_id, at);
`;

// Columns added after the first developer builds; _migrate adds them when missing.
const MIGRATED_COLUMNS = Object.freeze([
  ['ai_retry_at', 'INTEGER'],
  ['last_down_build_at', 'INTEGER'],
  ['last_missing_build_at', 'INTEGER'],
  ['review_accepted_code', 'TEXT'],
]);

let _ensuredPath = null;

/** Create tables + indexes idempotently. -> true when ready, false when SQLite is unavailable. */
function ensureSchema() {
  const p = engine._currentDbPath();
  if (_ensuredPath === p && engine.getDb()) return true;
  if (!engine.isAvailable()) return false;
  if (!engine.exec(DDL)) return false;
  _migrate();
  engine.exec(INDEXES);
  engine.prepare('INSERT OR IGNORE INTO ap_meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  _ensuredPath = p;
  return true;
}

function _migrate() {
  const cols = new Set(engine.prepare('PRAGMA table_info(ap_case)').all().map((r) => r.name));
  for (const [name, type] of MIGRATED_COLUMNS) {
    if (!cols.has(name)) engine.exec('ALTER TABLE ap_case ADD COLUMN ' + name + ' ' + type);
  }
}

function isEnsured() { return _ensuredPath != null && _ensuredPath === engine._currentDbPath(); }
function _resetForTests() { _ensuredPath = null; }

module.exports = { ensureSchema, isEnsured, SCHEMA_VERSION, DDL, INDEXES, MIGRATED_COLUMNS, _migrate, _resetForTests };
