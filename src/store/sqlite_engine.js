'use strict';
/**
 * store/sqlite_engine.js — crash-atomic document engine for CRITICAL
 * TRANSACTIONAL state, backed by the runtime's built-in SQLite (`node:sqlite`,
 * available in Electron 42's Node 24 main process and in Node 22+/24 for tests).
 *
 * WHY THIS EXISTS
 *   The JSON file store (store/index.js) persists each store as one JSON file
 *   via tmp+rename with a .bak snapshot. That is fine for caches, but the
 *   exactly-once / lease / idempotency ledgers have two real hazards it cannot
 *   cover:
 *     1. A crash mid-write can still leave a torn/empty document for the WHOLE
 *        ledger (every job, every claim) — the .bak is only one generation deep
 *        and is overwritten on the very next save.
 *     2. A read-modify-write done WITHOUT the store's updateAsync mutex (the
 *        FAS inbound-claim acquire() does raw load→check→save) has a true race:
 *        two engines can both read "no claim", both write their own claim, and
 *        both "win" — a duplicate Slack reply.
 *
 *   SQLite fixes both: every write is a single-row transaction (atomic, durable
 *   under WAL), and a read-modify-write wrapped in an IMMEDIATE transaction is
 *   serialized by the database itself — not just within one JS event loop.
 *
 * MODEL (document-compatible, zero caller churn)
 *   We keep the EXACT whole-document contract callers rely on: a store key maps
 *   to one JSON document (e.g. schedulerLedger -> { jobs, leases, ... }). Here
 *   that document is one ROW in a `kv` table (key PRIMARY KEY, doc TEXT JSON).
 *   store/index.js routes the designated transactional keys here; every other
 *   key stays on the JSON file store untouched. No schema-per-store, no shape
 *   change — so inbound-claim.js, scheduler/ledger.js, fas/executor.js and all
 *   their tests keep calling store.load/save/updateAsync verbatim.
 *
 * AVAILABILITY / FALLBACK
 *   If `node:sqlite` is not present (an older runtime), isAvailable() returns
 *   false and store/index.js transparently falls back to the JSON file store
 *   for these keys. The app never hard-fails on a missing SQLite runtime.
 */

const path = require('path');
const { P } = require('../config/paths');
let logger; try { logger = require('../utils/logger')('sqlite-engine'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

// Lazily resolved node:sqlite DatabaseSync constructor (null = unavailable).
let _DatabaseSync = null;
let _sqliteResolved = false;
function _resolveSqlite() {
  if (_sqliteResolved) return _DatabaseSync;
  _sqliteResolved = true;
  try {
    // `node:sqlite` is the built-in SQLite (Node 22+ experimental, 24 stable).
    const mod = require('node:sqlite');
    _DatabaseSync = mod && mod.DatabaseSync ? mod.DatabaseSync : null;
  } catch (_) {
    _DatabaseSync = null;
  }
  return _DatabaseSync;
}

let _db = null;             // open DatabaseSync handle
let _dbPath = null;         // the file the handle was opened against
let _initFailed = false;    // once true, we stop retrying this process

// Prepared-statement cache (keyed by sql text) for the life of a db handle.
let _stmts = new Map();
function _prep(sql) {
  let s = _stmts.get(sql);
  if (!s) { s = _db.prepare(sql); _stmts.set(sql, s); }
  return s;
}

function _currentDbPath() {
  // Co-locate with the JSON stores so backups/inspection stay in one place.
  return path.join(P.dataDir, 'transactional.sqlite');
}

/** True when the runtime provides node:sqlite AND the db opened successfully. */
function isAvailable() {
  if (_initFailed) return false;
  if (!_resolveSqlite()) return false;
  return !!_ensureDb();
}

function _ensureDb() {
  if (_db && _dbPath === _currentDbPath()) return _db;
  if (_initFailed) return null;
  const DatabaseSync = _resolveSqlite();
  if (!DatabaseSync) { _initFailed = true; return null; }
  // The data dir may differ between the app (Electron userData) and tests
  // (setDataDir tmp). If the path changed (tests), reopen against the new one.
  if (_db && _dbPath !== _currentDbPath()) {
    try { _db.close(); } catch (_) {}
    _db = null; _stmts = new Map();
  }
  try {
    const fs = require('fs');
    const dir = P.dataDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dbPath = _currentDbPath();
    const db = new DatabaseSync(dbPath);
    // WAL = concurrent readers + a single writer, durable, fast. NORMAL sync is
    // the recommended WAL durability/perf balance.
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    // busy_timeout: when a second connection (e.g. the coord-server's own
    // store, the standby daemon, and the app all touching SQLite on one host)
    // finds the DB write-locked, wait up to 5s for the lock to clear instead of
    // failing immediately with SQLITE_BUSY. Essential under dual-instance
    // contention. Transactions MUST stay short (never held across HTTP/Slack/
    // AAP/Claude/Playwright/OWA/network/AI work) so this timeout is ample.
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`CREATE TABLE IF NOT EXISTS kv (
      key        TEXT PRIMARY KEY,
      doc        TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );`);
    _db = db; _dbPath = dbPath; _stmts = new Map();
    logger.info('transactional SQLite ready at ' + dbPath);
    return _db;
  } catch (e) {
    _initFailed = true;
    logger.warn('SQLite engine unavailable, falling back to JSON store: ' + e.message);
    return null;
  }
}

/** Read a key's document. Returns `undefined` when the row is absent. */
function readDoc(key) {
  const db = _ensureDb();
  if (!db) return undefined;
  const row = _prep('SELECT doc FROM kv WHERE key = ?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.doc); } catch (e) {
    logger.error('corrupt doc for key ' + key + ': ' + e.message);
    return undefined;
  }
}

/** Atomic single-row upsert of a key's whole document. */
function writeDoc(key, obj) {
  const db = _ensureDb();
  if (!db) throw new Error('SQLite engine unavailable');
  const doc = JSON.stringify(obj);
  _prep(`INSERT INTO kv (key, doc, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`)
    .run(key, doc);
}

function deleteDoc(key) {
  const db = _ensureDb();
  if (!db) return;
  _prep('DELETE FROM kv WHERE key = ?').run(key);
}

function hasDoc(key) {
  const db = _ensureDb();
  if (!db) return false;
  return !!_prep('SELECT 1 FROM kv WHERE key = ?').get(key);
}

/**
 * tx(fn) — run `fn()` inside a single IMMEDIATE (write-reserving) transaction.
 * The whole function body commits atomically or rolls back on throw. Because
 * SQLite serializes writers, a read-modify-write done entirely inside tx() is
 * crash-atomic AND race-free across concurrent callers — the guarantee the raw
 * JSON load→save path could not give.
 */
function tx(fn) {
  const db = _ensureDb();
  if (!db) throw new Error('SQLite engine unavailable');
  db.exec('BEGIN IMMEDIATE;');
  try {
    const out = fn();
    db.exec('COMMIT;');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw e;
  }
}

/** Close the handle (tests / shutdown). Safe to call when never opened. */
function close() {
  if (_db) { try { _db.close(); } catch (_) {} }
  _db = null; _dbPath = null; _stmts = new Map();
  // Allow a fresh open afterwards (e.g. tests switching data dirs).
  _initFailed = false;
}

// ── Relational seam ───────────────────────────────────────────────────────────
// The kv API above stores whole JSON docs. Features that need real relational
// tables + indexed aggregation (e.g. the repair-history / trends engine) use
// these to run DDL/DML against the SAME WAL database, so there is ONE db file,
// one writer, and the same short-transaction + busy_timeout guarantees. Callers
// MUST keep transactions short and NEVER do API/AI/network work inside tx().
// Returns null when SQLite is unavailable (caller should degrade gracefully).

/** Run arbitrary DDL/SQL (CREATE TABLE/INDEX, PRAGMA). No-op if unavailable. */
function exec(sql) {
  const db = _ensureDb();
  if (!db) return false;
  db.exec(sql);
  return true;
}

/** Return a cached prepared statement, or null if SQLite is unavailable. */
function prepare(sql) {
  const db = _ensureDb();
  if (!db) return null;
  return _prep(sql);
}

/** Raw handle for advanced callers (e.g. multi-statement migrations). */
function getDb() { return _ensureDb(); }

module.exports = {
  isAvailable,
  readDoc, writeDoc, deleteDoc, hasDoc, tx,
  exec, prepare, getDb,
  close,
  _currentDbPath,
};
