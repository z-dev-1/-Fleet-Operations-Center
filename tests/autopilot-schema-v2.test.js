// tests/autopilot-schema-v2.test.js — Autopilot V2 AC-33 / AC-20 backfill: a v1 database migrates to
// schema_version 2 with every V1 row and column kept, behind a one-time VACUUM INTO backup (design §5.3).
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
let engine;
let schema;
let dir;

const T0 = Date.parse('2026-11-10T15:00:00Z');
const V1_TABLES = ['ap_meta', 'ap_case', 'ap_run', 'ap_finding', 'ap_event'];
const V2_TABLES = ['ap_step', 'ap_unit', 'ap_detect_pass', 'ap_timeline_proposal', 'ap_record'];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sv2-boot-'));
  setDataDir(dir);
  engine = require('../src/store/sqlite_engine');
  schema = require('../src/autopilot/schema');
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function freshDir(label) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-sv2-' + label + '-'));
  setDataDir(dir);
  engine.close();
  schema._resetForTests();
  return dir;
}
const tables = () => engine.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
const cols = (t) => engine.prepare('PRAGMA table_info(' + t + ')').all().map((r) => r.name);
const meta = (k) => { const r = engine.prepare('SELECT value FROM ap_meta WHERE key = ?').get(k); return r ? r.value : null; };
const backups = () => fs.readdirSync(dir).filter((f) => f.includes('.ap-v2-premigration-'));

// A V1 database as V1 left it (schema_version '1', V1 tables only) with rows in every table.
function seedV1() {
  engine.exec(schema.DDL_V1);
  engine.exec(schema.INDEXES_V1);
  engine.prepare('INSERT INTO ap_meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  engine.prepare('INSERT INTO ap_meta (key, value) VALUES (?, ?)').run('ai_calls:2026-11-10', '7');
  const ins = engine.prepare(`INSERT INTO ap_case (case_id, unit_id, domicile, issue_key, state, state_changed_at, opened_by, reasons_json,
      primary_reason, wo_ids_json, down_since, days_down, ai_findings_json, last_checked_at, priority, created_at, updated_at)
      VALUES (?, ?, 'ABE40', 'oos', ?, ?, 'oos_rule', '[{"code":"OOS"}]', 'OOS', ?, ?, 4, ?, ?, ?, ?, ?)`);
  ins.run('ap_q', 'U1', 'QUEUED', T0 - 1000, '{"primary":"svc-1","secondary":[]}', T0 - 4 * 86400000, null, null, 30, T0 - 5000, T0 - 1000);
  ins.run('ap_m', 'U2', 'MONITORING', T0 - 2000, null, null, '{"generatedBy":"ai","summary":"x"}', T0 - 1500, 20, T0 - 6000, T0 - 2000);
  ins.run('ap_f', 'U3', 'MONITORING', T0 - 3000, null, null, '{"generatedBy":"fallback"}', T0 - 2500, 10, T0 - 7000, T0 - 3000);
  engine.prepare("INSERT INTO ap_run (run_id, case_id, started_at, ended_at, trigger, step, outcome) VALUES ('run_1', 'ap_m', ?, ?, 'new', 'done', 'recommendation')").run(T0 - 1800, T0 - 1600);
  engine.prepare(`INSERT INTO ap_finding (case_id, run_id, evidence_id, source, field, value_text, retrieved_at, freshness, confidence, trust)
      VALUES ('ap_m', 'run_1', 'ev_1', 'aap_cache', 'lifecycleState', 'Unavailable', ?, 'RECENT', 0.9, 'structured')`).run(T0 - 1700);
  engine.prepare("INSERT INTO ap_event (case_id, at, kind, actor, reason_code) VALUES ('ap_m', ?, 'transition', 'autopilot', 'new')").run(T0 - 1900);
}
const dump = () => Object.fromEntries(V1_TABLES.map((t) => [t, engine.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()]));
const v1Cols = () => Object.fromEntries(V1_TABLES.map((t) => [t, cols(t)]));

describe('schema v2 migration (AC-33)', () => {
  it('migrates a v1 database to schema_version 2 keeping every V1 row and column, with a backup first', () => {
    freshDir('mig');
    seedV1();
    const beforeRows = dump();
    const beforeCols = v1Cols();
    const out = vi.spyOn(process.stdout, 'write');
    expect(schema.ensureSchema()).toBe(true);
    expect(schema.status()).toMatchObject({ version: 2, degradedCode: null });
    expect(schema.status().backup.ok).toBe(true);
    expect(Number.isInteger(schema.status().backup.ms)).toBe(true);
    // Elapsed ms logged (code and ms only).
    expect(out.mock.calls.map((c) => String(c[0])).some((l) => /premigration_backup ms=\d+ ok=true/.test(l))).toBe(true);
    // Backup file + meta key = its basename.
    const files = backups();
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^transactional\.sqlite\.ap-v2-premigration-\d+\.bak$/);
    expect(meta('premigration_backup_v2')).toBe(files[0]);
    // Every V1 column is still there, plus the new ones.
    for (const t of V1_TABLES) for (const c of beforeCols[t]) expect(cols(t), t + '.' + c).toContain(c);
    for (const [c] of schema.MIGRATED_COLUMNS_BY_TABLE.ap_case) expect(cols('ap_case')).toContain(c);
    expect(cols('ap_finding')).toContain('step_id');
    for (const t of V2_TABLES) expect(tables()).toContain(t);
    // Every V1 row is kept with its V1 column values.
    const after = dump();
    for (const t of V1_TABLES) {
      const rows = t === 'ap_meta' ? after[t].filter((r) => !['schema_version', 'premigration_backup_v2'].includes(r.key)) : after[t];
      const before = t === 'ap_meta' ? beforeRows[t].filter((r) => r.key !== 'schema_version') : beforeRows[t];
      expect(rows.length, t).toBe(before.length);
      rows.forEach((r, i) => { for (const k of Object.keys(before[i])) expect(r[k], t + '.' + k).toEqual(before[i][k]); });
    }
    expect(meta('schema_version')).toBe('2');
    // The backup is a real copy of the v1 database.
    const { DatabaseSync } = require('node:sqlite');
    const bak = new DatabaseSync(path.join(dir, files[0]));
    try {
      expect(bak.prepare('SELECT COUNT(*) AS n FROM ap_case').get().n).toBe(3);
      expect(bak.prepare("SELECT value FROM ap_meta WHERE key = 'schema_version'").get().value).toBe('1');
    } finally { bak.close(); }
  });

  it('backfills episode_opened_at, queued_since and ai_investigated_at (AC-20)', () => {
    freshDir('bf');
    seedV1();
    expect(schema.ensureSchema()).toBe(true);
    const c = (id) => engine.prepare('SELECT * FROM ap_case WHERE case_id = ?').get(id);
    expect(c('ap_q').episode_opened_at).toBe(T0 - 4 * 86400000);
    expect(c('ap_m').episode_opened_at).toBe(T0 - 6000);
    expect(c('ap_q').queued_since).toBe(T0 - 1000);
    expect(c('ap_m').queued_since).toBe(null);
    expect(c('ap_m').ai_investigated_at).toBe(T0 - 1500);
    expect(c('ap_f').ai_investigated_at).toBe(null);
    expect(c('ap_q').ai_investigated_at).toBe(null);
    expect(c('ap_q').recurrence_count).toBe(0);
    expect(c('ap_q').safety).toBe(0);
    expect(c('ap_q').episode_key).toBe(null);
  });

  it('is idempotent: a second run (new process) takes no backup and changes nothing', () => {
    freshDir('idem');
    seedV1();
    expect(schema.ensureSchema()).toBe(true);
    const snap = JSON.stringify(dump());
    const n = backups().length;
    engine.close();
    schema._resetForTests();
    expect(schema.ensureSchema()).toBe(true);
    expect(backups().length).toBe(n);
    expect(JSON.stringify(dump())).toBe(snap);
    expect(schema.status().backup).toBe(null);
  });

  it('a fresh database skips the backup', () => {
    freshDir('fresh');
    expect(schema.ensureSchema()).toBe(true);
    expect(backups()).toEqual([]);
    expect(meta('premigration_backup_v2')).toBe(null);
    expect(meta('schema_version')).toBe('2');
    for (const t of V1_TABLES.concat(V2_TABLES)) expect(tables()).toContain(t);
  });

  it('a leftover backup file of an older attempt is ignored; each attempt uses a new name', () => {
    freshDir('left');
    seedV1();
    const leftover = 'transactional.sqlite.ap-v2-premigration-1.bak';
    fs.writeFileSync(path.join(dir, leftover), 'partial');
    expect(schema.ensureSchema()).toBe(true);
    const files = backups();
    expect(files.length).toBe(2);
    expect(meta('premigration_backup_v2')).not.toBe(leftover);
    expect(files).toContain(meta('premigration_backup_v2'));
    expect(fs.readFileSync(path.join(dir, leftover), 'utf8')).toBe('partial');
  });

  it('a backup failure -> degraded migration_backup_failed, no DDL, no meta key; retried only after the backoff, then succeeds', () => {
    freshDir('fail');
    seedV1();
    const real = engine.exec;
    const seen = [];
    vi.spyOn(engine, 'exec').mockImplementation((sql) => {
      seen.push(String(sql).trim().split(/\s+/)[0]);
      if (/^\s*VACUUM INTO/.test(sql)) throw new Error('output file already exists');
      return real(sql);
    });
    const out = vi.spyOn(process.stdout, 'write');
    expect(schema.ensureSchema()).toBe(false);
    expect(schema.status()).toMatchObject({ version: 1, degradedCode: 'migration_backup_failed', backup: { ok: false } });
    expect(seen).toEqual(['VACUUM']);
    expect(out.mock.calls.map((c) => String(c[0])).some((l) => /premigration_backup ms=\d+ ok=false/.test(l))).toBe(true);
    for (const t of V2_TABLES) expect(tables()).not.toContain(t);
    expect(cols('ap_case')).not.toContain('episode_key');
    expect(meta('premigration_backup_v2')).toBe(null);
    expect(meta('schema_version')).toBe('1');
    expect(schema.isEnsured()).toBe(false);
    vi.restoreAllMocks();
    // Backoff: the next calls (ticks, status polls) inside 15 min do not run VACUUM INTO again.
    const t = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t + 60 * 1000);
    const nBak = backups().length;
    expect(schema.ensureSchema()).toBe(false);
    expect(schema.ensureSchema()).toBe(false);
    expect(backups().length).toBe(nBak);
    expect(schema.status()).toMatchObject({ degradedCode: 'migration_backup_failed' });
    vi.setSystemTime(t + 15 * 60 * 1000 + 1);
    expect(schema.ensureSchema()).toBe(true);
    vi.useRealTimers();
    expect(schema.status()).toMatchObject({ version: 2, degradedCode: null });
    expect(meta('premigration_backup_v2')).toMatch(/\.ap-v2-premigration-\d+\.bak$/);
  });

  it('a v1 ap_case without a schema_version row also counts as v1 (backup taken)', () => {
    freshDir('nover');
    engine.exec(schema.DDL_V1);
    expect(schema.ensureSchema()).toBe(true);
    expect(backups().length).toBe(1);
  });

  it('MIGRATED_COLUMNS keeps the V1 array export (the ap_case list)', () => {
    expect(Array.isArray(schema.MIGRATED_COLUMNS)).toBe(true);
    expect(schema.MIGRATED_COLUMNS).toBe(schema.MIGRATED_COLUMNS_BY_TABLE.ap_case);
    expect(schema.MIGRATED_COLUMNS.map((c) => c[0])).toEqual(expect.arrayContaining(['ai_retry_at', 'review_accepted_code', 'queued_since', 'last_up_seen_build_at']));
    expect(schema.SCHEMA_VERSION).toBe(2);
  });
});
