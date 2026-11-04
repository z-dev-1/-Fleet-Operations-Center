// tests/jobs-recovery.test.js — T4: startup recovery action table, Rule R
// ("recovery is inert"), inline orphan recovery in begin(), not-in-tx guard
// (Phase 7, design §5; gate e: side-effecting work is never blindly retried).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// ── Rule R spies (require-cache stubs; installed before anything loads them) ──
const calls = [];
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const spy = (name) => (...a) => { calls.push(name); return Promise.resolve(null); };
inject('../src/orcha/relay', { ask: spy('relay.ask'), askWithTimeout: spy('relay.askWithTimeout'), getStatus: () => ({ backends: {} }) });
inject('../src/scrapers/asist_enrich', { enrichVolvoAsist: spy('enrichVolvoAsist') });
inject('../src/scrapers/dtna_enrich', { enrichDtna: spy('enrichDtna') });
inject('../src/scrapers/ready_pickup_notify', { onStageUpdate: spy('onStageUpdate'), notifyReadyUnits: spy('notifyReadyUnits') });
inject('../src/orcha/awareness/notifier', { getNotifier: () => ({ enqueue: spy('notifier.enqueue') }) });
inject('../src/repair-intel/fetch', { syncUnit: spy('fetch.syncUnit') });
inject('../src/repair-intel/analysis', { analyzeUnit: spy('analysis.analyzeUnit') });
inject('../src/rca/autofill', { buildDraft: spy('autofill.buildDraft') });

const { DatabaseSync } = require('node:sqlite');
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const schema = require('../src/jobs/schema');
const types = require('../src/jobs/types');
const { createJobStore, JobsTxError } = require('../src/jobs/store');
const { createHandle } = require('../src/jobs/handle');
const jobs = require('../src/jobs');

const HOST = os.hostname();
const T0 = 1_800_000_000_000;
let tmp, file; const dbs = [];
function mkStore(owner, now) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50;');
  dbs.push(db);
  const ad = { id: file, exec: (s) => (db.exec(s), true), prepare: (s) => db.prepare(s), getDb: () => db };
  schema.ensureSchema(ad);
  const s = createJobStore({ adapter: ad, now, owner, log: { info() {}, warn() {}, error() {}, debug() {} } });
  s._db = db;
  return s;
}
function ins(db, o) {
  const r = Object.assign({ type: 'deepScan', generation: 1, attempt: 1, max_attempts: 3, lease_until: T0 + 600000, created_at: T0 - 1000 }, o);
  db.prepare('INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,attempt,max_attempts,owner,lease_until,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.type, r.scope, r.generation, r.type + ':' + r.scope + ':' + r.generation + ':' + r.id, r.state, r.attempt, r.max_attempts, r.owner, r.lease_until, r.created_at, r.created_at);
}
const st = (db, id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-recovery-')); file = path.join(tmp, 't.sqlite'); schema._resetForTests(); calls.length = 0; });
afterEach(() => { while (dbs.length) { try { dbs.pop().close(); } catch (_) {} } types._unregisterTypeForTests('extType'); jobs._resetForTests(); engine.close(); });

describe('T4 recovery action table (store level)', () => {
  it('classifies every orphan by its type', () => {
    types._registerTypeForTests('extType', { sideEffects: 'external' });
    const A = HOST + '|1|bootA';
    const B = mkStore(HOST + '|2|bootB', () => T0);
    const db = B._db;
    ins(db, { id: 'c1', state: 'claimed', scope: 's1', owner: A });
    ins(db, { id: 'r1', state: 'running', type: 'repairIntel', scope: 'cycle', owner: A, attempt: 1 });
    ins(db, { id: 'v1', state: 'verifying', scope: 's2', owner: A, attempt: 2 });
    ins(db, { id: 'r2', state: 'running', scope: 's3', owner: A, attempt: 3 });
    ins(db, { id: 'r3', state: 'running', type: 'rcaAutofill', scope: 'wo1', owner: A, attempt: 1, max_attempts: 1 });
    ins(db, { id: 'x1', state: 'running', type: 'extType', scope: 'e1', owner: A });
    ins(db, { id: 'u1', state: 'running', type: 'futureType', scope: 'f1', owner: A });
    ins(db, { id: 'o1', state: 'running', scope: 's4', owner: 'otherHost|9|bootZ', lease_until: T0 + 60000 });
    ins(db, { id: 'o2', state: 'running', scope: 's5', owner: 'otherHost|9|bootZ', lease_until: T0 - 1 });
    ins(db, { id: 'q1', state: 'queued', scope: 's6', owner: null, attempt: 1, created_at: T0 - 3 * 3600 * 1000 });
    ins(db, { id: 'w1', state: 'waiting_on_auth', scope: 's7', owner: A });
    const r = B.recover(T0);
    expect(r.ok).toBe(true);
    expect(st(db, 'c1').state).toBe('queued');
    expect(st(db, 'r1')).toMatchObject({ state: 'queued', attempt: 1, recovered_at: T0 });
    expect(st(db, 'r1').last_error).toMatch(/^interrupted \(owner bootA lease /);
    expect(st(db, 'r1').lease_until).toBeNull();
    expect(st(db, 'v1')).toMatchObject({ state: 'queued', attempt: 2 });
    expect(st(db, 'r2')).toMatchObject({ state: 'failed', last_error: 'interrupted 3 times; resume abandoned' });
    expect(st(db, 'r3')).toMatchObject({ state: 'failed', last_error: 'interrupted; read-only draft, re-run on demand' });
    expect(st(db, 'x1').state).toBe('recovery_required');
    expect(st(db, 'u1').state).toBe('recovery_required');
    expect(st(db, 'o1').state).toBe('running');
    expect(st(db, 'o2').state).toBe('queued');
    expect(st(db, 'q1').state).toBe('cancelled');
    expect(st(db, 'w1').state).toBe('waiting_on_auth');
    expect(B.lastRecovery).toEqual({ at: T0, requeued: 4, recoveryRequired: 2, failed: 2, cancelled: 1 });
    // recovery_required is NOT claimable: begin is blocked, never retried.
    const b = B.begin('extType', 'e1', types.get('extType'));
    expect(b).toMatchObject({ ok: true, kind: 'blocked', state: 'recovery_required' });
    expect(st(db, 'x1').state).toBe('recovery_required');
    expect(st(db, 'x1').attempt).toBe(1);
    // A second recover is a no-op for recovery_required rows.
    B.recover(T0 + 1);
    expect(st(db, 'x1').state).toBe('recovery_required');
    // Exits only via reconcile.
    expect(B.transition('x1', 'queued').ok).toBe(false);
    expect(B.reconcile('x1', 'cancel').ok).toBe(true);
    expect(st(db, 'x1').state).toBe('cancelled');
  });

  it('inline orphan in begin(): recovered and claimed in one call, durable + resumed, attempt+1, no JobsTxError', () => {
    const A = mkStore(HOST + '|1|bootA', () => T0);
    const def = types.get('deepScan');
    const r1 = A.begin('deepScan', 'fleet', def);
    const h1 = createHandle(A, { row: r1.row, def, type: 'deepScan', resumed: false, checkpoints: [] });
    h1.start();
    h1._abandonForTests();
    const B = mkStore(HOST + '|2|bootB', () => T0 + 1000);
    const r2 = B.begin('deepScan', 'fleet', def);
    expect(r2).toMatchObject({ ok: true, kind: 'claimed', resumed: true });
    expect(r2.row.attempt).toBe(2);
    expect(r2.row.id).toBe(r1.row.id);
    expect(B.txMisuse).toBe(0);
    expect(B.lastError).toBeNull();
  });

  it('_recoverRowInTx outside a transaction throws JobsTxError("not in tx")', () => {
    const B = mkStore(HOST + '|2|bootB', () => T0);
    ins(B._db, { id: 'z1', state: 'running', scope: 'zz', owner: HOST + '|1|bootA' });
    expect(() => B._recoverRowInTx(st(B._db, 'z1'), T0)).toThrow(JobsTxError);
    expect(() => B._recoverRowInTx(st(B._db, 'z1'), T0)).toThrow('not in tx');
    expect(st(B._db, 'z1').state).toBe('running');
  });
});

describe('T4 facade: recovery is inert (Rule R)', () => {
  it('init() recovery + begin() on every type makes zero side-effect calls', () => {
    setDataDir(tmp); engine.close();
    const ON = { enabled: true, types: { deepScan: true, repairIntel: true, rcaAutofill: true, longDwellAiFill: true } };
    jobs._resetForTests({ owner: HOST + '|1|bootA', flags: ON, now: () => T0 });
    expect(jobs.init()).toEqual({ mode: 'active' });
    types._registerTypeForTests('extType', { sideEffects: 'external' });
    const db = engine.getDb();
    const A = HOST + '|1|bootA';
    const WO = '11111111-2222-3333-4444-555555555555';
    let n = 0;
    for (const [type, scope] of [['deepScan', 'fleet'], ['repairIntel', 'cycle'], ['rcaAutofill', WO], ['extType', 'ext']]) {
      ins(db, { id: 'a' + (n++), type, scope, state: 'running', owner: A, max_attempts: type === 'rcaAutofill' ? 1 : 3 });
      ins(db, { id: 'a' + (n++), type, scope: scope + '-c', state: 'claimed', owner: A });
      ins(db, { id: 'a' + (n++), type, scope: scope + '-v', state: 'verifying', owner: A });
    }
    jobs._resetForTests({ owner: HOST + '|2|bootB', flags: ON, now: () => T0 + 1000 });
    jobs._registerTypeForTests('extType', { sideEffects: 'external' });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const handles = [
      jobs.begin({ type: 'deepScan', scopeKey: 'fleet' }),
      jobs.begin({ type: 'repairIntel', scopeKey: 'cycle' }),
      jobs.begin({ type: 'rcaAutofill', scopeKey: WO }),
      jobs.begin({ type: 'extType', scopeKey: 'ext' }),
      jobs.begin({ type: 'longDwellAiFill', scopeKey: 'x' }),
    ];
    expect(calls).toEqual([]);
    expect(handles[0].resumed).toBe(true);
    expect(handles[3].durable).toBe(false);
    expect(handles[3].blockedBy).toBe('recovery_required');
    expect(handles[4].durable).toBe(false);
    for (const h of handles) h.complete({});
    expect(calls).toEqual([]);
    const st2 = jobs.getStatus();
    expect(st2.lastRecovery.recoveryRequired).toBe(2);
  });
});
