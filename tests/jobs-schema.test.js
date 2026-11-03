// tests/jobs-schema.test.js — T1: jobs schema (Phase 7, design §2, round-3 fix 5).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const schema = require('../src/jobs/schema');
const jobs = require('../src/jobs');

let tmp; const opened = [];
function mkDb(file, busyMs = 50) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ' + busyMs + ';');
  opened.push(db);
  return db;
}
const adapterFor = (db, id) => ({ id, exec: (s) => (db.exec(s), true), prepare: (s) => db.prepare(s), getDb: () => db });
const objects = (db) => db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'job%' OR name LIKE 'ix_jobs%' OR name LIKE 'ux_jobs%'").all().map((r) => r.type + ':' + r.name).sort();

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-schema-')); setDataDir(tmp); engine.close(); schema._resetForTests(); });
afterEach(() => { while (opened.length) { try { opened.pop().close(); } catch (_) {} } engine.close(); });

describe('T1 jobs schema', () => {
  it('creates both tables and 4 indexes; idempotent; preserves rows', () => {
    const file = path.join(tmp, 'a.sqlite');
    const db = mkDb(file);
    const ad = adapterFor(db, file);
    expect(schema.ensureSchema(ad)).toEqual({ ok: true });
    expect(objects(db)).toEqual([
      'index:ix_jobs_finished', 'index:ix_jobs_state_lease', 'index:ix_jobs_type_state', 'index:ux_jobs_open_scope',
      'table:job_checkpoint', 'table:jobs',
    ]);
    db.prepare("INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,created_at,updated_at) VALUES ('j1','deepScan','fleet',1,'deepScan:fleet:1','queued',1,1)").run();
    schema._resetForTests();
    expect(schema.ensureSchema(ad)).toEqual({ ok: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(1);
    expect(() => schema._migrate(ad)).not.toThrow();
    expect(schema.JOBS_SCHEMA_VERSION).toBe(1);
  });

  it('returns {ok:false, code:"unavailable"} (no throw) when the adapter is unavailable', () => {
    expect(schema.ensureSchema({ id: 'x', exec: () => false, prepare: () => null, getDb: () => ({}) })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(schema.ensureSchema({ id: 'y', exec: () => true, prepare: () => null, getDb: () => null })).toMatchObject({ ok: false, code: 'unavailable' });
    expect(schema.ensureSchema(null)).toMatchObject({ ok: false, code: 'unavailable' });
  });

  it('returns {ok:false, code:"sqlite"} for a non-busy error, never throws', () => {
    const r = schema.ensureSchema({ id: 'z', exec: () => { throw new Error('disk I/O error'); }, prepare: () => null, getDb: () => ({}) });
    expect(r).toEqual({ ok: false, code: 'sqlite', error: 'disk I/O error' });
  });

  it('returns {ok:false, code:"busy"} when another connection holds the write lock; not memoized', () => {
    const file = path.join(tmp, 'b.sqlite');
    const holder = mkDb(file);
    holder.exec('BEGIN IMMEDIATE;');
    const db = mkDb(file, 50);
    const ad = adapterFor(db, file);
    const r = schema.ensureSchema(ad);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('busy');
    holder.exec('ROLLBACK;');
    expect(schema.ensureSchema(ad)).toEqual({ ok: true });
  });

  it('memo is per db path: setDataDir(tmp2) re-runs DDL on the new file; coexists with ri_* and kv', () => {
    require('../src/repair-intel/schema').ensureSchema();
    expect(schema.ensureSchema(jobs.engineAdapter)).toEqual({ ok: true });
    const names = engine.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['kv', 'ri_repair_event', 'jobs', 'job_checkpoint']));
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-schema2-'));
    setDataDir(tmp2);
    expect(schema.ensureSchema(jobs.engineAdapter)).toEqual({ ok: true });
    const names2 = engine.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names2).toEqual(expect.arrayContaining(['jobs', 'job_checkpoint']));
    expect(jobs.engineAdapter.id).toBe(path.join(tmp2, 'transactional.sqlite'));
  });
});
