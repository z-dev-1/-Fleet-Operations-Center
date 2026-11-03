// tests/jobs-lease.test.js — T3/T3b/T3c: lease + claim protocol, fencing,
// renewal and maxRunMs (Phase 7, design §4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const schema = require('../src/jobs/schema');
const types = require('../src/jobs/types');
const { createJobStore } = require('../src/jobs/store');
const { createHandle } = require('../src/jobs/handle');

let tmp, file; const dbs = [];
function conn() {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50;');
  dbs.push(db);
  return { db, ad: { id: file, exec: (s) => (db.exec(s), true), prepare: (s) => db.prepare(s), getDb: () => db } };
}
function mkStore(owner, now, warns) {
  const c = conn();
  schema.ensureSchema(c.ad);
  const log = { info() {}, debug() {}, warn: (m) => warns && warns.push(m), error: (m) => warns && warns.push(m) };
  const s = createJobStore({ adapter: c.ad, now, owner, log });
  s._db = c.db; s._log = log;
  return s;
}
function beginH(s, type, scope) {
  const def = types.get(type);
  const r = s.begin(type, scope, def);
  if (!r.ok || r.kind !== 'claimed') return { noop: true, r };
  return createHandle(s, { row: r.row, def, type, resumed: r.resumed, checkpoints: r.checkpoints, log: s._log });
}
const row = (s, id) => s._db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-lease-')); file = path.join(tmp, 't.sqlite'); schema._resetForTests(); });
afterEach(() => { vi.useRealTimers(); while (dbs.length) { try { dbs.pop().close(); } catch (_) {} } });

describe('T3 claim exclusivity', () => {
  it('two live claimers on different hosts: exactly one durable handle, the other busy', () => {
    const t = { v: 1_800_000_000_000 };
    const A = mkStore('hostA|1|bootA', () => t.v);
    const B = mkStore('hostB|2|bootB', () => t.v);
    const ha = beginH(A, 'deepScan', 'fleet');
    const hb = beginH(B, 'deepScan', 'fleet');
    expect(ha.durable).toBe(true);
    expect(hb.noop).toBe(true);
    expect(hb.r).toMatchObject({ ok: true, kind: 'busy' });
    expect(A._db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(1);
    ha._stopTimersForTests();
  });

  it('a second begin in the same process is busy', () => {
    const t = { v: 1_800_000_000_000 };
    const A = mkStore('hostA|1|bootA', () => t.v);
    const h1 = beginH(A, 'repairIntel', 'cycle');
    expect(h1.durable).toBe(true);
    expect(beginH(A, 'repairIntel', 'cycle').r.kind).toBe('busy');
    h1._stopTimersForTests();
  });

  it('a duplicate open (type, scope) insert hits ux_jobs_open_scope and classifies as busy (never thrown)', () => {
    const t = { v: 1_800_000_000_000 };
    const A = mkStore('hostA|1|bootA', () => t.v);
    const h = beginH(A, 'deepScan', 'fleet');
    let err = null;
    try {
      A._db.prepare("INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,created_at,updated_at) VALUES ('dup','deepScan','fleet',9,'deepScan:fleet:9','queued',1,1)").run();
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(A._classify(err)).toBe('busy');
    h._stopTimersForTests();
  });

  it('T3b: same host, different boot, unexpired lease -> B takes over; A\'s next fenced write is a lost lease', () => {
    const t = { v: 1_800_000_000_000 };
    const wa = [];
    const A = mkStore('hostA|1|bootA', () => t.v, wa);
    const B = mkStore('hostA|2|bootB', () => t.v);
    const ha = beginH(A, 'deepScan', 'fleet');
    ha.start();
    ha.unitsStarted(['U1']);
    const hb = beginH(B, 'deepScan', 'fleet');
    expect(hb.durable).toBe(true);
    expect(hb.jobId).toBe(ha.jobId);
    expect(hb.attempt).toBe(2);
    expect(hb.resumed).toBe(true);
    // A is stale: fence mismatch -> lost lease -> NOOP, warns once, no further writes land.
    ha.unitsSettled([{ key: 'U1', status: 'done', sig: 'abc' }]);
    expect(ha.durable).toBe(false);
    ha.unitsSettled([{ key: 'U2', status: 'done', sig: 'abc' }]);
    ha.setCheckpoint({ x: 1 });
    ha.complete({});
    expect(wa.filter((w) => /lease lost/.test(w)).length).toBe(1);
    const cps = A._db.prepare('SELECT unit_key, status FROM job_checkpoint').all();
    expect(cps).toEqual([{ unit_key: 'U1', status: 'in_progress' }]);
    expect(row(A, hb.jobId).state).toBe('claimed');
    expect(row(A, hb.jobId).checkpoint_json).toBeNull();
    hb._stopTimersForTests();
  });

  it('T3c: same instance, job in _active, lease expired -> second begin is busy, not a takeover', () => {
    const t = { v: 1_800_000_000_000 };
    const A = mkStore('hostA|1|bootA', () => t.v);
    const h = beginH(A, 'repairIntel', 'cycle');
    h._stopTimersForTests();
    t.v += 60 * 60 * 1000;
    expect(row(A, h.jobId).lease_until).toBeLessThan(t.v);
    const r2 = beginH(A, 'repairIntel', 'cycle');
    expect(r2.noop).toBe(true);
    expect(r2.r.kind).toBe('busy');
    expect(row(A, h.jobId).attempt).toBe(1);
  });
});

describe('T3 renewal + maxRunMs', () => {
  it('renewal extends lease_until; maxRunMs stops renewal', () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const A = mkStore('hostA|1|bootA', () => Date.now());
    const def = types.get('repairIntel');
    const h = beginH(A, 'repairIntel', 'cycle');
    h.start();
    const l0 = row(A, h.jobId).lease_until;
    expect(l0).toBe(1_800_000_000_000 + def.leaseMs);
    vi.advanceTimersByTime(Math.floor(def.leaseMs / 3) + 1);
    const l1 = row(A, h.jobId).lease_until;
    expect(l1).toBeGreaterThan(l0);
    vi.advanceTimersByTime(def.maxRunMs + 1);
    const l2 = row(A, h.jobId).lease_until;
    vi.advanceTimersByTime(def.maxRunMs);
    expect(row(A, h.jobId).lease_until).toBe(l2);
    expect(vi.getTimerCount()).toBe(0);
    h.complete({});
    expect(row(A, h.jobId).state).toBe('completed');
  });
});
