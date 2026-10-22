/**
 * repair-intel/schema.js — relational schema for the 12-month Fleet Repair
 * Intelligence engine (unit repair history + trends + vendor-network).
 *
 * WHY relational (not the kv store): the Trends dashboard and vendor/network
 * intelligence need fast multi-filter aggregation across the whole fleet (by
 * domicile, operator, make/model, vendor, category, part, outcome, date range).
 * That is a SQL job, not a JSON-blob-in-memory job — so we add real tables +
 * indexes to the SAME WAL SQLite database (via sqlite_engine's relational seam),
 * keeping one db file, one writer, short transactions.
 *
 * NO-FABRICATION RULE (spec Part 10): every field here maps to a real source
 * value or is explicitly nullable. Durations/dates that cannot be computed are
 * stored NULL and surfaced as "Unknown / Insufficient Data" in the UI — never
 * guessed. Reported issue, diagnosed issue, confirmed root cause, suspected root
 * cause, action, and verified outcome are SEPARATE columns so they are never
 * conflated.
 *
 * Idempotency: repair events upsert by a stable source identifier
 * (work_order_id, falling back to service_id) so re-syncs never duplicate.
 */

const engine = require('../store/sqlite_engine');
let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

// Bump when the table shape changes; _ensureSchema is additive/idempotent.
const SCHEMA_VERSION = 1;

const DDL = `
-- One row per repair EVENT (a work order / service record) within the window.
CREATE TABLE IF NOT EXISTS ri_repair_event (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id             TEXT NOT NULL,          -- stable id: work_order_id or service_id
  work_order_id         TEXT,                   -- Relay Garage WO id
  service_id            TEXT,                   -- AAP service aggregate id
  offsite_id            TEXT,                   -- offsite/dealer repair id when reconciled
  amz_id                TEXT,                   -- AMZ id / aaid
  equipment_id          TEXT NOT NULL,          -- unit number
  vin                   TEXT,
  make                  TEXT,
  model                 TEXT,
  model_year            TEXT,
  domicile              TEXT,
  operator              TEXT,                   -- operator / DSP / SCAC
  mileage_at_repair     INTEGER,                -- NULL when unknown
  vendor                TEXT,                   -- normalized vendor name
  repair_location       TEXT,
  repair_category       TEXT,
  repair_component      TEXT,
  repair_subcategory    TEXT,
  wo_type               TEXT,                   -- unplanned/planned/PM/corrective/dealer/offsite/roadside
  status                TEXT,                   -- open/completed/cancelled/reopened/transferred
  -- Timestamps (epoch ms, NULL when the source did not provide it)
  reported_at           INTEGER,
  created_at            INTEGER,
  repair_start_at       INTEGER,
  repair_completed_at   INTEGER,
  return_to_service_at  INTEGER,
  cancelled_at          INTEGER,
  modified_at           INTEGER,                -- source last-modified (for incremental sync)
  -- Repair detail (SEPARATE fields; never conflated)
  reported_complaint    TEXT,
  symptoms              TEXT,
  tech_findings         TEXT,
  diagnosed_problem     TEXT,
  confirmed_root_cause  TEXT,
  suspected_root_cause  TEXT,
  corrective_actions    TEXT,
  outcome               TEXT,                   -- resolved/resolved-repeated/partial/unresolved/referred/cancelled/unknown
  complaint_resolved    TEXT,                   -- yes/no/unknown
  verification_result   TEXT,
  outstanding_issues    TEXT,
  cancellation_reason   TEXT,
  -- Downtime components (ms; tracked SEPARATELY, NULL when uncomputable)
  total_elapsed_ms      INTEGER,
  hands_on_ms           INTEGER,
  wait_diagnosis_ms     INTEGER,
  wait_parts_ms         INTEGER,
  wait_approval_ms      INTEGER,
  wait_capacity_ms      INTEGER,
  wait_transfer_ms      INTEGER,
  wait_return_ms        INTEGER,
  -- Parts / back-order (from delayReasonCodes + lifecycle reason; NOT fabricated)
  delay_reason_codes    TEXT,                   -- raw delay reason codes, joined
  parts_on_order        INTEGER DEFAULT 0,      -- 1 if a parts-delay / back-order signal is present
  -- Vendor scope
  in_scope              TEXT,                   -- yes/no/unknown
  out_of_scope_reason   TEXT,
  dealer_required       TEXT,                   -- yes/no/unknown
  specialist_required   TEXT,
  transferred           TEXT,                   -- yes/no/unknown
  receiving_vendor      TEXT,
  transfer_date         INTEGER,
  transfer_result       TEXT,
  -- Cost (single-user authorized; estimated kept separate from invoiced)
  estimate_cost         REAL,
  invoiced_cost         REAL,
  -- Provenance + conflict
  source_refs           TEXT,                   -- JSON: {relay, offsite} source links
  source_conflict       TEXT,                   -- JSON describing relay/offsite disagreements
  excluded_vendor       INTEGER DEFAULT 0,      -- 1 if vendor is in the exclusion set
  raw_hash              TEXT,                   -- hash of normalized source for change detection
  first_seen_at         INTEGER,
  last_synced_at        INTEGER,
  UNIQUE(source_id)
);

-- Parts per repair event (one row per part).
CREATE TABLE IF NOT EXISTS ri_repair_part (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id       INTEGER NOT NULL REFERENCES ri_repair_event(id) ON DELETE CASCADE,
  equipment_id   TEXT,
  part_name      TEXT,
  part_number    TEXT,
  component      TEXT,
  action         TEXT,                          -- requested / replaced
  qty            INTEGER
);

-- Per-unit sync checkpoint (for incremental "fetch new data only").
CREATE TABLE IF NOT EXISTS ri_sync_checkpoint (
  equipment_id        TEXT PRIMARY KEY,
  last_full_sync_at   INTEGER,
  last_incr_sync_at   INTEGER,
  last_modified_seen  INTEGER,                  -- max modified_at seen (incremental cursor)
  window_start_at     INTEGER,                  -- rolling 365-day window start used
  source_coverage     TEXT,                     -- JSON: which sources answered / failed
  last_error          TEXT,
  records_total       INTEGER,
  updated_at          INTEGER
);

-- AI analysis per unit (concise report + metadata; invalidated on evidence change).
CREATE TABLE IF NOT EXISTS ri_ai_analysis (
  equipment_id     TEXT PRIMARY KEY,
  report_json      TEXT,                        -- executive summary + sections (concise)
  evidence_hash    TEXT,                        -- hash of the events this analysis was built from
  analysis_version INTEGER,
  model_id         TEXT,
  analyzed_at      INTEGER
);

-- Network / escalation recommendations (advisory only).
CREATE TABLE IF NOT EXISTS ri_recommendation (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  scope            TEXT,                         -- unit / vendor / domicile / model
  scope_key        TEXT,                         -- the unit#, vendor, domicile, or make|model
  kind             TEXT,                         -- monitor/operational/vendor-escalation/technical/network-review/urgent-safety
  finding          TEXT,
  reason           TEXT,
  recommended_action TEXT,
  owner            TEXT,
  priority         TEXT,
  confidence       TEXT,
  incident_count   INTEGER,
  period_start_at  INTEGER,
  period_end_at    INTEGER,
  supporting_wos   TEXT,                         -- JSON array of work_order_ids
  created_at       INTEGER,
  dismissed        INTEGER DEFAULT 0
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS ix_ev_unit        ON ri_repair_event(equipment_id);
CREATE INDEX IF NOT EXISTS ix_ev_vendor      ON ri_repair_event(vendor);
CREATE INDEX IF NOT EXISTS ix_ev_domicile    ON ri_repair_event(domicile);
CREATE INDEX IF NOT EXISTS ix_ev_operator    ON ri_repair_event(operator);
CREATE INDEX IF NOT EXISTS ix_ev_category    ON ri_repair_event(repair_category);
CREATE INDEX IF NOT EXISTS ix_ev_component   ON ri_repair_event(repair_component);
CREATE INDEX IF NOT EXISTS ix_ev_status      ON ri_repair_event(status);
CREATE INDEX IF NOT EXISTS ix_ev_outcome     ON ri_repair_event(outcome);
CREATE INDEX IF NOT EXISTS ix_ev_reported    ON ri_repair_event(reported_at);
CREATE INDEX IF NOT EXISTS ix_ev_modified    ON ri_repair_event(modified_at);
CREATE INDEX IF NOT EXISTS ix_ev_makemodel   ON ri_repair_event(make, model);
CREATE INDEX IF NOT EXISTS ix_ev_excluded    ON ri_repair_event(excluded_vendor);
CREATE INDEX IF NOT EXISTS ix_part_event     ON ri_repair_part(event_id);
CREATE INDEX IF NOT EXISTS ix_part_number    ON ri_repair_part(part_number);
CREATE INDEX IF NOT EXISTS ix_part_component ON ri_repair_part(component);
CREATE INDEX IF NOT EXISTS ix_rec_scope      ON ri_recommendation(scope, scope_key);
`;

let _ensured = false;

// Create all tables + indexes idempotently. Safe to call on every startup.
// Returns true if the schema is ready, false if SQLite is unavailable (the
// whole feature then degrades gracefully to "not available").
function ensureSchema() {
  if (_ensured) return true;
  try {
    if (!engine.isAvailable || !engine.isAvailable()) {
      if (!engine.getDb || !engine.getDb()) { logger.warn('SQLite unavailable — repair-intel disabled'); return false; }
    }
    const ok = engine.exec(DDL);
    if (!ok) { logger.warn('could not create repair-intel schema (SQLite unavailable)'); return false; }
    engine.exec(INDEXES);
    _migrate();
    _ensured = true;
    logger.info('repair-intel schema ready (v' + SCHEMA_VERSION + ')');
    return true;
  } catch (e) {
    logger.error('ensureSchema failed: ' + e.message);
    return false;
  }
}

// Additive, idempotent column migrations for tables created by an EARLIER
// schema version (CREATE TABLE IF NOT EXISTS won't add new columns). Each ADD
// COLUMN is wrapped so an "already exists" error is ignored — safe to run every
// startup. Add new columns here when the shape grows.
function _migrate() {
  const adds = [
    "ALTER TABLE ri_repair_event ADD COLUMN delay_reason_codes TEXT",
    "ALTER TABLE ri_repair_event ADD COLUMN parts_on_order INTEGER DEFAULT 0",
    "ALTER TABLE ri_repair_event ADD COLUMN backordered_parts TEXT", // JSON [{part,phrase,at}] from comments
  ];
  for (const sql of adds) {
    try { engine.exec(sql); } catch (e) { /* duplicate column name — already migrated */ }
  }
  try { engine.exec('CREATE INDEX IF NOT EXISTS ix_ev_parts_order ON ri_repair_event(parts_on_order)'); } catch (_) {}
}

module.exports = { ensureSchema, SCHEMA_VERSION, DDL, INDEXES };
