'use strict';
/**
 * autopilot/schema.js — ap_* tables in the existing transactional.sqlite
 * (V1 §B5.1, V2 design §5.1-§5.3, pattern of src/repair-intel/schema.js). Additive and idempotent.
 *
 * Plan R1: last_down_build_at / last_missing_build_at hold the fleet-freshness
 * build time (lastOkAt), never fleetData.syncedAt. Plan R3: review_accepted_code.
 *
 * V2: SCHEMA_VERSION 2. Upgrading an existing v1 database first writes a one-time
 * backup with VACUUM INTO '<db>.ap-v2-premigration-<ms>.bak'. A backup failure
 * leaves the schema untouched and status().degradedCode = 'migration_backup_failed'.
 *
 * Nothing here runs at require time. The controller calls ensureSchema() once
 * per process, only while the master switch is on.
 */

const engine = require('../store/sqlite_engine');

let logger;
try { logger = require('../utils/logger')('autopilot'); } catch (_) { logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const SCHEMA_VERSION = 2;
const BACKUP_META_KEY = 'premigration_backup_v2';
const BACKUP_INFIX = '.ap-v2-premigration-';

const DDL_V1 = `
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

// V2 §5.1 (exact DDL).
const DDL_V2 = `
CREATE TABLE IF NOT EXISTS ap_step (
  step_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL, run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT,
  args_json TEXT,
  args_hash TEXT,
  idem_key TEXT NOT NULL,
  call_key TEXT,
  source TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  source_fp TEXT,
  status TEXT NOT NULL,
  code TEXT,
  why TEXT,
  summary_json TEXT,
  result_bytes INTEGER,
  reused_step_id TEXT,
  copied_from TEXT,
  ai_request_id TEXT, ai_latency_ms INTEGER, ai_lane TEXT,
  started_at INTEGER NOT NULL, ended_at INTEGER, ms INTEGER
);
CREATE TABLE IF NOT EXISTS ap_unit (
  unit_id TEXT PRIMARY KEY, eligibility TEXT NOT NULL, equipment_class TEXT, exclusion_code TEXT,
  domicile TEXT, operator TEXT, owner TEXT, vendor TEXT, is_down INTEGER NOT NULL DEFAULT 0,
  coverage TEXT NOT NULL, case_id TEXT, row_hash TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ap_detect_pass (
  pass_id TEXT PRIMARY KEY, at INTEGER NOT NULL, build_at_ms INTEGER, mode TEXT NOT NULL,
  fleet_rows INTEGER NOT NULL, duplicate_rows INTEGER NOT NULL, invalid_rows INTEGER NOT NULL,
  eligible INTEGER NOT NULL, excluded_trailer INTEGER NOT NULL, excluded_hostler INTEGER NOT NULL,
  excluded_unsupported INTEGER NOT NULL, type_unknown INTEGER NOT NULL, type_conflict INTEGER NOT NULL,
  down_eligible INTEGER NOT NULL, case_open INTEGER NOT NULL, below_threshold INTEGER NOT NULL,
  out_of_filter INTEGER NOT NULL, feature_off INTEGER NOT NULL, opened INTEGER NOT NULL,
  held INTEGER NOT NULL, reconcile_ok INTEGER NOT NULL,
  by_domicile_json TEXT, by_operator_json TEXT, by_owner_json TEXT, tokens_without_rows_json TEXT, ms INTEGER
);
CREATE TABLE IF NOT EXISTS ap_timeline_proposal (
  proposal_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL, unit_id TEXT NOT NULL, episode_key TEXT NOT NULL,
  event_at INTEGER, event_date TEXT,
  discovered_at INTEGER NOT NULL, source TEXT NOT NULL, evidence_ref TEXT NOT NULL,
  basis TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  fingerprint TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ap_record (
  case_id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, schema_version INTEGER NOT NULL,
  operator TEXT, owner TEXT, domicile TEXT, oos_status TEXT, days_down REAL, repair_phase TEXT,
  root_cause TEXT, blocker TEXT, responsible_party TEXT,
  last_verified_update_at INTEGER, last_verified_update_source TEXT,
  parts_eta TEXT, repair_eta TEXT, confidence REAL, ai_status TEXT,
  investigated_at INTEGER NOT NULL, record_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
`;

const DDL = DDL_V1 + DDL_V2;

const INDEXES_V1 = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_case_open ON ap_case(unit_id, issue_key) WHERE state <> 'RESOLVED';
CREATE INDEX IF NOT EXISTS ix_ap_case_state_due ON ap_case(state, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_ap_case_review ON ap_case(next_review_at);
CREATE INDEX IF NOT EXISTS ix_ap_case_dom ON ap_case(domicile, state);
CREATE INDEX IF NOT EXISTS ix_ap_run_case ON ap_run(case_id, started_at);
CREATE INDEX IF NOT EXISTS ix_ap_finding_run ON ap_finding(run_id);
CREATE INDEX IF NOT EXISTS ix_ap_finding_case ON ap_finding(case_id);
CREATE INDEX IF NOT EXISTS ix_ap_event_case ON ap_event(case_id, at);
`;

const INDEXES_V2 = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_step_idem ON ap_step(idem_key);
CREATE INDEX IF NOT EXISTS ix_ap_step_run ON ap_step(run_id, seq);
CREATE INDEX IF NOT EXISTS ix_ap_step_case ON ap_step(case_id, started_at);
CREATE INDEX IF NOT EXISTS ix_ap_step_call ON ap_step(case_id, call_key, status);
CREATE INDEX IF NOT EXISTS ix_ap_step_kind_at ON ap_step(kind, started_at);
CREATE INDEX IF NOT EXISTS ix_ap_step_pending ON ap_step(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_ap_unit_cov ON ap_unit(coverage, eligibility);
CREATE INDEX IF NOT EXISTS ix_ap_unit_dom ON ap_unit(domicile, operator);
CREATE INDEX IF NOT EXISTS ix_ap_pass_at ON ap_detect_pass(at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ap_tp_fp ON ap_timeline_proposal(case_id, fingerprint);
CREATE INDEX IF NOT EXISTS ix_ap_tp_case ON ap_timeline_proposal(case_id, event_at);
CREATE INDEX IF NOT EXISTS ix_ap_case_queue ON ap_case(state, queued_since);
CREATE INDEX IF NOT EXISTS ix_ap_case_aipending ON ap_case(ai_pending_reason) WHERE ai_pending_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_ap_case_operator ON ap_case(operator, state);
CREATE INDEX IF NOT EXISTS ix_ap_finding_step ON ap_finding(step_id);
`;

const INDEXES = INDEXES_V1 + INDEXES_V2;

// Columns added after the first developer builds (V1) and by V2 (§5.2); _migrate adds them when missing.
const AP_CASE_COLUMNS = Object.freeze([
  ['ai_retry_at', 'INTEGER'],
  ['last_down_build_at', 'INTEGER'],
  ['last_missing_build_at', 'INTEGER'],
  ['review_accepted_code', 'TEXT'],
  ['equipment_class', 'TEXT'], ['operator', 'TEXT'], ['owner', 'TEXT'], ['vendor', 'TEXT'],
  ['episode_key', 'TEXT'], ['episode_opened_at', 'INTEGER'], ['wo_set_json', 'TEXT'], ['dealer_cases_json', 'TEXT'],
  ['complexity', 'TEXT'], ['memory_json', 'TEXT'], ['slice_fps_json', 'TEXT'],
  ['ai_pending_reason', 'TEXT'], ['ai_investigated_at', 'INTEGER'],
  ['recurrence_of', 'TEXT'], ['recurrence_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['queued_since', 'INTEGER'], ['deep_requested_at', 'INTEGER'], ['safety', 'INTEGER NOT NULL DEFAULT 0'],
  ['awaiting_sources', 'TEXT'], ['last_up_seen_build_at', 'INTEGER'],
]);
const AP_FINDING_COLUMNS = Object.freeze([['step_id', 'TEXT']]);
const MIGRATED_COLUMNS_BY_TABLE = Object.freeze({ ap_case: AP_CASE_COLUMNS, ap_finding: AP_FINDING_COLUMNS });
// V1 export: the ap_case list (V1 tests read it as an array).
const MIGRATED_COLUMNS = AP_CASE_COLUMNS;

const BACKFILL = [
  'UPDATE ap_case SET episode_opened_at = COALESCE(down_since, created_at) WHERE episode_opened_at IS NULL',
  "UPDATE ap_case SET queued_since = state_changed_at WHERE state = 'QUEUED' AND queued_since IS NULL",
  "UPDATE ap_case SET ai_investigated_at = COALESCE(last_checked_at, state_changed_at) WHERE ai_investigated_at IS NULL AND json_extract(ai_findings_json, '$.generatedBy') = 'ai'",
];

let _ensuredPath = null;
let _degradedCode = null;
let _lastBackup = null;   // { ms, ok } of the last VACUUM INTO attempt in this process

function _tableExists(name) {
  return !!engine.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function _meta(key) {
  if (!_tableExists('ap_meta')) return null;
  const r = engine.prepare('SELECT value FROM ap_meta WHERE key = ?').get(key);
  return r ? r.value : null;
}

// True when this is an existing v1 database that has not been backed up for v2 yet.
function _needsBackup() {
  if (!_tableExists('ap_case') && !_tableExists('ap_meta')) return false;   // fresh database: nothing at risk
  const v = _meta('schema_version');
  const isV1 = v === '1' || (v == null && _tableExists('ap_case'));
  return isV1 && _meta(BACKUP_META_KEY) == null;
}

// -> true when the backup was written; false on any error (degraded, no DDL).
function _backup() {
  const dbPath = String(engine._currentDbPath());
  const target = dbPath + BACKUP_INFIX + Date.now() + '.bak';
  const t0 = Date.now();
  let ok = false;
  try {
    engine.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
    ok = true;
  } catch (_) {
    ok = false;
  }
  const ms = Date.now() - t0;
  _lastBackup = { ms, ok };
  try { logger.info('premigration_backup ms=' + ms + ' ok=' + ok); } catch (_) {}
  if (!ok) return false;
  // Only after VACUUM INTO returned: record the backup's basename.
  if (!_tableExists('ap_meta')) engine.exec('CREATE TABLE IF NOT EXISTS ap_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  engine.prepare('INSERT INTO ap_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(BACKUP_META_KEY, target.split(/[\\/]/).pop());
  return true;
}

/** Create tables + indexes idempotently. -> true when ready, false when SQLite is unavailable or the backup failed. */
function ensureSchema() {
  const p = engine._currentDbPath();
  if (_ensuredPath === p && engine.getDb()) return true;
  if (!engine.isAvailable()) return false;
  if (_needsBackup() && !_backup()) {
    _degradedCode = 'migration_backup_failed';
    return false;
  }
  if (!engine.exec(DDL)) return false;
  _migrate();
  for (const sql of BACKFILL) engine.exec(sql);
  engine.exec(INDEXES);
  engine.prepare("INSERT INTO ap_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  _degradedCode = null;
  _ensuredPath = p;
  return true;
}

function _migrate() {
  for (const table of Object.keys(MIGRATED_COLUMNS_BY_TABLE)) {
    const cols = new Set(engine.prepare('PRAGMA table_info(' + table + ')').all().map((r) => r.name));
    for (const [name, type] of MIGRATED_COLUMNS_BY_TABLE[table]) {
      if (!cols.has(name)) engine.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + type);
    }
  }
}

/** -> { version, degradedCode, backup: { ms, ok } | null } */
function status() {
  let version = null;
  try { if (engine.getDb()) { const v = _meta('schema_version'); version = v == null ? null : parseInt(v, 10); } } catch (_) { version = null; }
  return { version, degradedCode: _degradedCode, backup: _lastBackup };
}

function isEnsured() { return _ensuredPath != null && _ensuredPath === engine._currentDbPath(); }
function _resetForTests() { _ensuredPath = null; _degradedCode = null; _lastBackup = null; }

module.exports = {
  ensureSchema, isEnsured, status, SCHEMA_VERSION, DDL, DDL_V1, DDL_V2, INDEXES, INDEXES_V1, INDEXES_V2,
  MIGRATED_COLUMNS, MIGRATED_COLUMNS_BY_TABLE, BACKUP_META_KEY, _migrate, _resetForTests,
};
