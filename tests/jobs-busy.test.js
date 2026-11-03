// tests/jobs-busy.test.js — T6: busy classification, begin busy, the handle
// busy circuit, final-write retry, start-not-landed (round-3 fix 4), init /
// step-0 / prune busy placement and the per-run busy bound (Phase 7, design §6).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const schema = require('../src/jobs/schema');
const types = require('../src/jobs/types');
const { createJobStore, _classify } = require('../src/jobs/store');
const { createHandle, START_NOT_LANDED_NOTE } = require('../src/jobs/handle');
const jobs = require('../src/jobs');

const HOST = os.hostname();
const T0 = 1_800_000_000_000;
let tmp, file; const dbs = [];
function open(busyMs = 50) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ' + busyMs + ';');
  dbs.push(db);
  return db;
}
// Recording adapter: counts SQL calls, BEGIN IMMEDIATE attempts and busy results.
function recAdapter(db) {
  const r = { calls: 0, begins: 0, busy: 0, inTx: false };
  const guard = (fn) => { try { return fn(); } catch (e) { if (/locked|busy/i.test(e.message)) r.busy++; throw e; } };
  r.ad = {
    id: file,
    exec: (s) => {
      r.calls++;
      const isBegin = /^BEGIN/.test(s);
      if (isBegin) r.begins++;
      guard(() => db.exec(s));
      if (isBegin) r.inTx = true;
      if (/^(COMMIT|ROLLBACK)/.test(s)) r.inTx = false;
      return true;
    },
    prepare: (s) => {
      r.calls++;
      const st = db.prepare(s);
      return { run: (...a) => guard(() => st.run(...a)), get: (...a) => guard(() => st.get(...a)), all: (...a) => guard(() => st.all(...a)) };
    },
    getDb: () => db,
  };
  return r;
}
function mkStore(owner, now, warns) {
  const db = open();
  const rec = recAdapter(db);
  schema.ensureSchema(rec.ad);
  const log = { info() {}, debug() {}, error: (m) => warns && warns.push(m), warn: (m) => warns && warns.push(m) };
  const s = createJobStore({ adapter: rec.ad, now, owner, log });
  s._db = db; s._rec = rec; s._log = log;
  return s;
}
function beginH(s, type = 'deepScan', scope = 'fleet') {
  const def = types.get(type);
  const r = s.begin(type, scope, def);
  if (!r.ok || r.kind !== 'claimed') return { noop: true, r };
  return createHandle(s, { row: r.row, def, type, resumed: r.resumed, checkpoints: r.checkpoints, log: s._log });
}
function lock() { const h = open(); h.exec('BEGIN IMMEDIATE;'); return () => { try { h.exec('ROLLBACK;'); } catch (_) {} }; }
const rowOf = (s, id) => s._db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-busy-')); file = path.join(tmp, 't.sqlite'); schema._resetForTests(); });
afterEach(() => { vi.useRealTimers(); jobs._resetForTests(); while (dbs.length) { try { dbs.pop().close(); } catch (_) {} } });

describe('T6 classification', () => {
  it('masks extended codes; scope UNIQUE is busy, other constraints are hard', () => {
    for (const code of [5, 517, 6, 262]) expect(_classify(Object.assign(new Error('x'), { errcode: code }))).toBe('busy');
    expect(_classify(new Error('database is locked'))).toBe('busy');
    expect(_classify(Object.assign(new Error('UNIQUE constraint failed: jobs.type, jobs.scope_key'), { errcode: 2067 }))).toBe('busy');
    expect(_classify(Object.assign(new Error('UNIQUE constraint failed: jobs.idempotency_key'), { errcode: 2067 }))).toBe('constraint');
    expect(_classify(Object.assign(new Error('disk I/O error'), { errcode: 10 }))).toBe('sqlite');
  });
});

describe('T6 begin busy', () => {
  it('store.begin under a held lock returns busy fast; warn is rate-limited', () => {
    const warns = [];
    const A = mkStore(HOST + '|1|bootA', () => T0, warns);
    const release = lock();
    const t = Date.now();
    expect(A.begin('deepScan', 'fleet', types.get('deepScan'))).toMatchObject({ ok: false, code: 'busy' });
    expect(A.begin('deepScan', 'fleet', types.get('deepScan'))).toMatchObject({ ok: false, code: 'busy' });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(warns.filter((w) => /begin: database busy/.test(w)).length).toBe(1);
    release();
    expect(beginH(A).durable).toBe(true);
  });
});

describe('T6 handle busy circuit', () => {
  it('first busy trips the circuit: no further progress SQL, warn once, complete retried once by timer', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warns = [];
    const A = mkStore(HOST + '|1|bootA', () => T0, warns);
    const h = beginH(A); h.start(); h.unitsStarted(['U1']);
    const release = lock();
    h.unitsSettled([{ key: 'U1', status: 'done', sig: 's' }]);
    expect(h.durable).toBe(false);
    const calls0 = A._rec.calls;
    h.unitsStarted(['U2']); h.unitsSettled([{ key: 'U2', status: 'done' }]); h.setCheckpoint({ a: 1 }); h.start();
    vi.advanceTimersByTime(10 * 60 * 1000);   // renewal ticks would fire here
    expect(A._rec.calls).toBe(calls0);
    h.complete({});                            // final attempt: busy -> one timed retry
    expect(rowOf(A, h.jobId).state).toBe('running');
    release();
    vi.advanceTimersByTime(2000);
    expect(rowOf(A, h.jobId).state).toBe('completed');
    expect(warns.filter((w) => /durability suspended for this run/.test(w)).length).toBe(1);
    expect(A._active.has(h.jobId)).toBe(false);
  });

  it('both final attempts busy -> row stays running, leaves _active, requeued + resumed by the next begin after the lease lapses', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const t = { v: T0 };
    const A = mkStore(HOST + '|1|bootA', () => t.v);
    const h = beginH(A); h.start();
    const release = lock();
    h.complete({});
    vi.advanceTimersByTime(2000);
    release();
    expect(rowOf(A, h.jobId).state).toBe('running');
    expect(A._active.has(h.jobId)).toBe(false);
    t.v += types.get('deepScan').leaseMs + 1;
    const h2 = beginH(A);
    expect(h2.durable).toBe(true);
    expect(h2.resumed).toBe(true);
    expect(h2.jobId).toBe(h.jobId);
    expect(h2.attempt).toBe(2);
    h2._stopTimersForTests();
  });

  it('[round-3 fix 4] start() not landed (busy) -> complete() writes claimed -> cancelled with a note, never claimed -> completed', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const warns = [];
    const A = mkStore(HOST + '|1|bootA', () => T0, warns);
    const h = beginH(A);
    const release = lock();
    h.start();                                 // busy: start never lands
    expect(rowOf(A, h.jobId).state).toBe('claimed');
    release();
    h.complete({ processed: 1 });
    const row = rowOf(A, h.jobId);
    expect(row.state).toBe('cancelled');
    const hist = JSON.parse(row.history_json);
    expect(hist[hist.length - 1]).toMatchObject({ from: 'claimed', to: 'cancelled', note: START_NOT_LANDED_NOTE });
    expect(START_NOT_LANDED_NOTE).toBe('start not recorded (busy); ran non-durably');
    expect(warns.some((w) => /illegal transition/.test(w))).toBe(false);
    // fail() after start-not-landed takes the same edge
    const h2 = beginH(A, 'repairIntel', 'cycle');
    const rel2 = lock(); h2.start(); rel2();
    h2.fail(new Error('boom'));
    expect(rowOf(A, h2.jobId).state).toBe('cancelled');
    expect(warns.some((w) => /illegal transition/.test(w))).toBe(false);
  });

  it('bound: lock held for a whole durable run -> <=1 busy in the begin phase, <=3 in the handle phase', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const A = mkStore(HOST + '|1|bootA', () => T0);
    let release = lock();
    const b0 = A._rec.busy;
    expect(beginH(A).noop).toBe(true);
    expect(A._rec.busy - b0).toBeLessThanOrEqual(1);
    release();
    const h = beginH(A); h.start();
    release = lock();
    const b1 = A._rec.busy;
    h.unitsStarted(['U1']); h.unitsSettled([{ key: 'U1', status: 'done' }]); h.setCheckpoint({ x: 1 });
    vi.advanceTimersByTime(30 * 60 * 1000);
    h.complete({});
    vi.advanceTimersByTime(2000);
    expect(A._rec.busy - b1).toBeLessThanOrEqual(3);
    release();
  });
});

describe('T6 facade busy placement', () => {
  const ON = { enabled: true, types: { deepScan: true, repairIntel: true } };
  function facade(owner, now) {
    const db = open();
    const rec = recAdapter(db);
    const warns = [];
    jobs._resetForTests({ owner, now, flags: ON, adapter: rec.ad, logger: { info() {}, debug() {}, error: (m) => warns.push(m), warn: (m) => warns.push(m) } });
    return { db, rec, warns };
  }

  it('begin busy -> NOOP (busy:true) in under 1 s', () => {
    const f = facade(HOST + '|1|bootA', () => T0);
    expect(jobs.init()).toEqual({ mode: 'active' });
    const release = lock();
    const t = Date.now();
    const h = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(h.durable).toBe(false);
    expect(h.busy).toBe(true);
    release();
    expect(f.rec.inTx).toBe(false);
  });

  it('schema busy at init -> degraded "schema init busy", warn once', () => {
    const release = lock();
    const f = facade(HOST + '|1|bootA', () => T0);
    expect(jobs.init()).toEqual({ mode: 'degraded', reason: 'schema init busy' });
    release();
    jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(f.warns.filter((w) => /schema init busy/.test(w)).length).toBe(1);
    expect(jobs.getStatus().mode).toBe('degraded');
  });

  it('init recovery busy -> _recoveryPending, prune skipped, {mode:active, recovery:deferred}; step-0 busy -> one BEGIN, flag stays; sweep runs at the next begin', () => {
    const f = facade(HOST + '|1|bootA', () => T0);
    jobs.init();
    // an orphan from a previous boot so recover() needs a write transaction
    f.db.prepare("INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,attempt,max_attempts,owner,lease_until,created_at,updated_at) VALUES ('o1','repairIntel','cycle',1,'repairIntel:cycle:1','running',1,3,?,?,?,?)")
      .run(HOST + '|1|bootOld', T0 + 600000, T0, T0);
    const f2 = facade(HOST + '|2|bootB', () => T0 + 10);
    schema.ensureSchema(f2.rec.ad);           // memo hit at init (DDL needs no lock)
    let release = lock();
    expect(jobs.init()).toEqual({ mode: 'active', recovery: 'deferred' });
    const s = jobs._storeForTests();
    expect(s._recoveryPending).toBe(true);
    expect(s._lastPrune).toBe(0);              // prune skipped
    const begins0 = f2.rec.begins;
    const h = jobs.begin({ type: 'repairIntel', scopeKey: 'cycle' });
    expect(h.busy).toBe(true);
    expect(f2.rec.begins - begins0).toBe(1);   // only step 0 tried; steps 1-2 issued nothing
    expect(s._recoveryPending).toBe(true);
    release();
    const h2 = jobs.begin({ type: 'repairIntel', scopeKey: 'cycle' });
    expect(s._recoveryPending).toBe(false);
    expect(h2.durable).toBe(true);
    expect(h2.resumed).toBe(true);
    h2.complete({});
  });

  it('prune placement: aged _lastPrune -> prune then begin tx, no nested error; busy prune stamps _lastPrune and is not retried next call', () => {
    const t = { v: T0 };
    const f = facade(HOST + '|1|bootA', () => t.v);
    jobs.init();
    const s = jobs._storeForTests();
    t.v += 7 * 3600 * 1000;
    const b0 = f.rec.begins;
    const h = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(h.durable).toBe(true);
    expect(f.rec.begins - b0).toBe(2);         // prune tx + begin tx
    expect(s.txMisuse).toBe(0);
    expect(s.lastError).toBeNull();
    h.complete({});
    t.v += 7 * 3600 * 1000;
    const release = lock();
    const hb = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(hb.busy).toBe(true);
    expect(s._lastPrune).toBe(t.v);
    release();
    const b1 = f.rec.begins;
    const h2 = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(h2.durable).toBe(true);
    expect(f.rec.begins - b1).toBe(1);         // no re-prune
    h2.complete({});
  });
});
