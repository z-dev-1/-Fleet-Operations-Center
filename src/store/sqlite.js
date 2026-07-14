'use strict';
/**
 * src/store/sqlite.js — SQLite store (future migration)
 * 
 * Replaces JSON file store for critical data:
 * - Fleet data (rows)
 * - Notes store (timelines)
 * - Repair history
 * - Chat history
 * - Reminders
 * 
 * Benefits:
 * - Atomic transactions (no corruption)
 * - Queryable (find units by vendor, site, date range)
 * - Concurrent-safe
 * - WAL mode for fast reads
 * 
 * To enable:
 * 1. npm install better-sqlite3
 * 2. Call initDB() from app.js
 * 3. Gradually migrate store.load/save calls to db queries
 */

const path = require('path');
const { P } = require('../config/paths');
const logger = require('../utils/logger')('sqlite');

let db = null;

function initDB() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(P.dataDir, 'fleet-ops.db');
    db = new Database(dbPath, { verbose: null });
    
    // WAL mode for performance
    db.pragma('journal_mode = WAL');
    
    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS fleet_units (
        equipment_id TEXT PRIMARY KEY,
        operator TEXT,
        domicile TEXT,
        lifecycle_state TEXT,
        lifecycle_reason TEXT,
        vendor TEXT,
        work_duration TEXT,
        etc TEXT,
        risk_score INTEGER,
        issue_details TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS notes (
        equipment_id TEXT PRIMARY KEY,
        timeline TEXT,
        issue_summary TEXT,
        repair_status TEXT,
        primary_component TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS repair_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id TEXT,
        date TEXT,
        summary TEXT,
        vendor TEXT,
        duration TEXT,
        outcome TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        equipment_id TEXT,
        due_date TEXT,
        note TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        fired INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS chat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT,
        text TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE INDEX IF NOT EXISTS idx_history_unit ON repair_history(equipment_id);
      CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(due_date);
    `);
    
    logger.info('SQLite initialized at ' + dbPath);
    return true;
  } catch (e) {
    logger.info('SQLite not available (better-sqlite3 not installed): ' + e.message);
    return false;
  }
}

// Query helpers (only work when db is initialized)
function getUnit(equipmentId) {
  if (!db) return null;
  return db.prepare('SELECT * FROM fleet_units WHERE equipment_id = ?').get(equipmentId);
}

function upsertUnit(row) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fleet_units (equipment_id, operator, domicile, lifecycle_state, lifecycle_reason, vendor, work_duration, etc, risk_score, issue_details, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  stmt.run(row.equipmentId, row.operator, row.domicileSite, row.lifecycleState, row.lifecycleReason, row.vendor, row.workDuration, row.etc, row.riskScore, row.issueDetails);
}

function bulkUpsertUnits(rows) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fleet_units (equipment_id, operator, domicile, lifecycle_state, lifecycle_reason, vendor, work_duration, etc, risk_score, issue_details, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const batch = db.transaction((rows) => {
    for (const r of rows) stmt.run(r.equipmentId, r.operator, r.domicileSite, r.lifecycleState, r.lifecycleReason, r.vendor, r.workDuration, r.etc, r.riskScore, r.issueDetails);
  });
  batch(rows);
}

function getRepairHistory(equipmentId, days) {
  if (!db) return [];
  const d = days || 90;
  return db.prepare("SELECT * FROM repair_history WHERE equipment_id = ? AND created_at > datetime('now', '-' || ? || ' days') ORDER BY created_at DESC").all(equipmentId, d);
}

module.exports = { initDB, getUnit, upsertUnit, bulkUpsertUnits, getRepairHistory, get db() { return db; } };
