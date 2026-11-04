// tests/jobs-checkpoint.test.js — T5: per-unit checkpoints (store level) and
// the deep-scan resume integration through runOrchaDeepScan (Phase 7,
// design §9.1; round-3 fixes 2 and 7: real DS_BATCH_SIZE=3, 6 rows in
// batches of 3, getStatus orcha up, begin captured via a vi.spyOn
// passthrough, never-resolving relay only for batch-2 ids, fresh stubs for run 2).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
const require = createRequire(import.meta.url);

fx.installStubs();
const { DatabaseSync } = require('node:sqlite');
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const schema = require('../src/jobs/schema');
const types = require('../src/jobs/types');
const { createJobStore } = require('../src/jobs/store');
const { createHandle } = require('../src/jobs/handle');
const jobs = require('../src/jobs');
const ds = require('../src/orcha/deep-scan');

const HOST = os.hostname();
const T0 = 1_800_000_000_000;
let tmp, file; const dbs = [];

function mkStore(owner, now, warns) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 50;');
  dbs.push(db);
  const ad = { id: file, exec: (s) => (db.exec(s), true), prepare: (s) => db.prepare(s), getDb: () => db };
  schema.ensureSchema(ad);
  const log = { info() {}, debug() {}, error() {}, warn: (m) => warns && warns.push(m) };
  const s = createJobStore({ adapter: ad, now, owner, log });
  s._db = db; s._log = log;
  return s;
}
function beginH(s, type, scope) {
  const def = types.get(type);
  const r = s.begin(type, scope, def);
  return createHandle(s, { row: r.row, def, type, resumed: r.resumed, checkpoints: r.checkpoints, log: s._log });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ckpt-'));
  file = path.join(tmp, 't.sqlite');
  schema._resetForTests();
  fx.resetRecorders();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  jobs._resetForTests();
  while (dbs.length) { try { dbs.pop().close(); } catch (_) {} }
  engine.close();
});

describe('T5 store-level checkpoints', () => {
  it('unitsStarted/unitsSettled round-trip; isUnitDone only for done + matching non-null sig', () => {
    const A = mkStore(HOST + '|1|bootA', () => T0);
    const h = beginH(A, 'deepScan', 'fleet');
    h.start();
    h.unitsStarted(['U1', 'U2', 'U3']);
    h.unitsSettled([{ key: 'U1', status: 'done', sig: 'S1' }, { key: 'U2', status: 'failed' }, { key: 'U3', status: 'done', sig: null }]);
    const rows = A._db.prepare('SELECT unit_key, status, sig, attempts FROM job_checkpoint ORDER BY unit_key').all();
    expect(rows).toEqual([
      { unit_key: 'U1', status: 'done', sig: 'S1', attempts: 1 },
      { unit_key: 'U2', status: 'failed', sig: null, attempts: 1 },
      { unit_key: 'U3', status: 'done', sig: null, attempts: 1 },
    ]);
    expect(h.isUnitDone('U1', 'S1')).toBe(false); // fresh job: never resume-skip
    h._abandonForTests();
    const B = mkStore(HOST + '|2|bootB', () => T0 + 1);
    const h2 = beginH(B, 'deepScan', 'fleet');
    expect(h2.resumed).toBe(true);
    expect(h2.isUnitDone('U1', 'S1')).toBe(true);
    expect(h2.isUnitDone('U1', 'S2')).toBe(false);
    expect(h2.isUnitDone('U2', 'S1')).toBe(false);
    expect(h2.isUnitDone('U3', null)).toBe(false);
    expect(h2.isUnitDone('U3', 'anything')).toBe(false);
    h2._stopTimersForTests();
  });

  it('crash-loop guard: in_progress with attempts >= 2 is skipped on the next resume', () => {
    const A = mkStore(HOST + '|1|bootA', () => T0);
    const h1 = beginH(A, 'deepScan', 'fleet'); h1.start(); h1.unitsStarted(['U9']); h1._abandonForTests();
    const B = mkStore(HOST + '|2|bootB', () => T0 + 1);
    const h2 = beginH(B, 'deepScan', 'fleet'); h2.start();
    expect(h2.isUnitPoisoned('U9')).toBe(false);
    h2.unitsStarted(['U9']); h2._abandonForTests();
    const C = mkStore(HOST + '|3|bootC', () => T0 + 2);
    const h3 = beginH(C, 'deepScan', 'fleet');
    expect(h3.attempt).toBe(3);
    expect(h3.isUnitPoisoned('U9')).toBe(true);
    expect(C._db.prepare("SELECT status FROM job_checkpoint WHERE unit_key = 'U9'").get().status).toBe('skipped');
    h3._stopTimersForTests();
  });

  it('a checkpoint over 16 KB is dropped with a warn; shallow merge otherwise', () => {
    const warns = [];
    const A = mkStore(HOST + '|1|bootA', () => T0, warns);
    const h = beginH(A, 'deepScan', 'fleet');
    h.start();
    h.setCheckpoint({ total: 5 });
    h.setCheckpoint({ resumeSkipped: 0 });
    expect(JSON.parse(A._db.prepare('SELECT checkpoint_json FROM jobs').get().checkpoint_json)).toEqual({ total: 5, resumeSkipped: 0 });
    h.setCheckpoint({ big: 'x'.repeat(17000) });
    expect(JSON.parse(A._db.prepare('SELECT checkpoint_json FROM jobs').get().checkpoint_json)).toEqual({ total: 5, resumeSkipped: 0 });
    expect(warns.some((w) => /16 KB/.test(w))).toBe(true);
    expect(h.durable).toBe(true);
    h.complete({ processed: 5 });
    expect(JSON.parse(A._db.prepare('SELECT checkpoint_json FROM jobs').get().checkpoint_json)).toEqual({ total: 5, resumeSkipped: 0, processed: 5 });
  });

  it('prune deletes old terminal jobs and cascades their checkpoints', () => {
    const t = { v: T0 };
    const A = mkStore(HOST + '|1|bootA', () => t.v);
    const h = beginH(A, 'deepScan', 'fleet'); h.start(); h.unitsStarted(['U1']); h.complete({});
    expect(A._db.prepare('SELECT COUNT(*) AS n FROM job_checkpoint').get().n).toBe(1);
    t.v += 4 * 24 * 3600 * 1000;
    expect(A.prune(t.v)).toMatchObject({ ok: true, deleted: 1 });
    expect(A._db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
    expect(A._db.prepare('SELECT COUNT(*) AS n FROM job_checkpoint').get().n).toBe(0);
  });
});

// ── T5 integration: resume through runOrchaDeepScan ─────────────────────────
const ON = { enabled: true, types: { deepScan: true } };
function liveRows() {
  const base = fx.freshRows()[0]; // U101 shape: Decisiv URL, stale asistScrapedAt
  return ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].map((id) => Object.assign({}, JSON.parse(JSON.stringify(base)), {
    equipmentId: id, workRequestId: 'WR-' + id, offsiteShopEventUrl: 'https://volvo.decisiv.net/case/' + id,
    asistNotes: 'Old cached dealer notes for ' + id + ' (stale).',
  }));
}
const TL = (id) => 'REPAIR_STATUS: Parts ordered\nPRIMARY_COMPONENT: CHASSIS\nISSUE: Leak on ' + id + '\nTIMELINE:\n10/30 - Parts ordered for ' + id + '.';
const BATCH2 = new Set(['L4', 'L5', 'L6']);
const enrichOk = async (url) => ({ ok: true, offsiteText: 'NEW dealer text for ' + url + ' — parts confirmed today.', scrapedAt: new Date().toISOString(), source: 'decisiv-api', bestLabel: 'Decisiv', bestUrl: url });

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 5)); }
  return false;
}

async function runOneAndCrash(notes) {
  setDataDir(tmp); engine.close();
  jobs._resetForTests({ owner: HOST + '|' + process.pid + '|bootA', flags: ON });
  expect(jobs.init()).toEqual({ mode: 'active' });
  const realBegin = jobs.begin;
  let live = null;
  vi.spyOn(jobs, 'begin').mockImplementation((a) => (live = realBegin(a)));
  fx.resetRecorders();
  rec().relayImpl = (id) => (BATCH2.has(id) ? new Promise(() => {}) : Promise.resolve(TL(id)));
  rec().enrichImpl = enrichOk;
  fx.startScenario(ds, 'fleet', { rows: liveRows(), notes: notes || {} });   // promise intentionally dropped (crash)
  const db = engine.getDb();
  const landed = await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM job_checkpoint WHERE status = 'done'").get().n === 3);
  expect(landed).toBe(true);
  expect(live && live.durable).toBe(true);
  live._abandonForTests();
  vi.restoreAllMocks();
  return { persisted: JSON.parse(JSON.stringify(rec().store.get('notesStore'))), jobId: live.jobId };
}
const rec = () => fx.rec;

describe('T5 integration: deep-scan resume', () => {
  it('DS_BATCH_SIZE is 3 (no option added)', () => { expect(ds.DS_BATCH_SIZE).toBe(3); });

  it('after a crash in batch 2, the restart resumes and skips the 3 units done before the crash', async () => {
    const { persisted, jobId } = await runOneAndCrash();
    // Restart: same host, new boot -> init() recovery re-queues the row.
    jobs._resetForTests({ owner: HOST + '|' + process.pid + '|bootB', flags: ON });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const db = engine.getDb();
    expect(db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId).state).toBe('queued');
    // Run 2: fresh stubs, fresh deep copies of the original rows, notes from run 1.
    fx.resetRecorders();
    rec().relayImpl = (id) => Promise.resolve(TL(id));
    rec().enrichImpl = enrichOk;
    const out = await fx.runScenario(ds, 'fleet', { rows: liveRows(), notes: persisted });
    expect(rec().enrich.map((u) => u.split('/').pop())).toEqual(['L4', 'L5', 'L6']);
    expect(rec().prompts.map((p) => p.id)).toEqual(['L4', 'L5', 'L6']);
    const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
    expect(row.state).toBe('completed');
    expect(row.attempt).toBe(2);
    const ck = JSON.parse(row.checkpoint_json);
    expect(ck.resumeSkipped).toBe(3);
    expect(ck.total).toBe(6);
    expect(out.info.some((m) => m === '[DS] resume job ' + jobId + ' attempt 2: skipping 3 unit(s) completed before restart')).toBe(true);
    expect(out.ret).toStrictEqual({ processed: 3, improved: 3 });
  });

  it('control: flags off -> enrich IS called for all 6 (the skip came from the job)', async () => {
    const { persisted } = await runOneAndCrash();
    jobs._resetForTests({ owner: HOST + '|' + process.pid + '|bootB', flags: { enabled: false, types: {} } });
    expect(jobs.init()).toEqual({ mode: 'off' });
    fx.resetRecorders();
    rec().relayImpl = (id) => Promise.resolve(TL(id));
    rec().enrichImpl = enrichOk;
    await fx.runScenario(ds, 'fleet', { rows: liveRows(), notes: persisted });
    expect(rec().enrich.length).toBe(6);
    expect(rec().prompts.length).toBe(6);
  });

  it('sig change: editing manualEntries of a batch-1 unit makes it reprocess', async () => {
    const { persisted, jobId } = await runOneAndCrash();
    persisted.L2.manualEntries = ['10/31 - Called dealer; ETA Friday.'];
    jobs._resetForTests({ owner: HOST + '|' + process.pid + '|bootB', flags: ON });
    jobs.init();
    fx.resetRecorders();
    rec().relayImpl = (id) => Promise.resolve(TL(id));
    rec().enrichImpl = enrichOk;
    await fx.runScenario(ds, 'fleet', { rows: liveRows(), notes: persisted });
    expect(rec().prompts.map((p) => p.id)).toEqual(['L2', 'L4', 'L5', 'L6']);
    const ck = JSON.parse(engine.getDb().prepare('SELECT checkpoint_json FROM jobs WHERE id = ?').get(jobId).checkpoint_json);
    expect(ck.resumeSkipped).toBe(2);
  });
});
