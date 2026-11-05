// tests/jobs-peek.test.js — read-only jobs.peek({type, scopeKey}) (Phase 7
// follow-up for longDwellAiFill): null + no SQL when off / not effective;
// state, attempt, checkpoint and settled count after a recovered requeue.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');

const HOST = os.hostname();
const T0 = 1_800_000_000_000;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const ON = { enabled: true, types: { longDwellAiFill: true } };
const SCOPE = 'computed:2026-11-04';
let tmp;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-peek-')); engine.close(); setDataDir(tmp); });
afterEach(() => { vi.restoreAllMocks(); jobs._resetForTests(); engine.close(); });

describe('jobs.peek', () => {
  it('off (no init / flags off): null, isEffective false, no SQL, no db file', () => {
    const sp = ['exec', 'prepare', 'getDb'].map((k) => vi.spyOn(engine, k));
    jobs._resetForTests();
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toBeNull();
    jobs._resetForTests({ flags: { enabled: false, types: { longDwellAiFill: true } }, logger: quiet });
    jobs.init();
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toBeNull();
    expect(jobs.isEffective('longDwellAiFill')).toBe(false);
    for (const s of sp) expect(s).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
  });

  it('active but type not effective, unknown type or bad scope -> null', () => {
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, logger: quiet });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const sp = vi.spyOn(engine, 'prepare');
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toBeNull();
    expect(jobs.peek({ type: 'nope', scopeKey: SCOPE })).toBeNull();
    expect(jobs.peek({ type: 'deepScan', scopeKey: 'bad scope!' })).toBeNull();
    expect(sp).not.toHaveBeenCalled();
  });

  it('no open row -> null; live running row -> running; after crash + restart -> recovered queued row with settled count', () => {
    jobs._resetForTests({ owner: HOST + '|1|bootA', flags: ON, now: () => T0, logger: quiet });
    expect(jobs.init()).toEqual({ mode: 'active' });
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toBeNull();
    const h = jobs.begin({ type: 'longDwellAiFill', scopeKey: SCOPE });
    h.start();
    h.setCheckpoint({ table: 'computed', keys: ['a', 'b', 'c'] });
    h.unitsStarted(['a', 'b']);
    h.unitsSettled([{ key: 'a', status: 'done', sig: 's' }]);
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toMatchObject({ id: h.jobId, state: 'running', attempt: 1, settled: 1 });
    h._abandonForTests();
    jobs._resetForTests({ owner: HOST + '|2|bootB', flags: ON, now: () => T0 + 1000, logger: quiet });
    expect(jobs.init()).toEqual({ mode: 'active' });
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toEqual({
      id: h.jobId, state: 'queued', attempt: 1, settled: 1, checkpoint: { table: 'computed', keys: ['a', 'b', 'c'] },
    });
    // read-only: peek changed nothing
    expect(engine.getDb().prepare('SELECT state, attempt FROM jobs').all()).toEqual([{ state: 'queued', attempt: 1 }]);
    const h2 = jobs.begin({ type: 'longDwellAiFill', scopeKey: SCOPE });
    expect(h2.resumed).toBe(true);
    h2.start(); h2.complete({});
    expect(jobs.peek({ type: 'longDwellAiFill', scopeKey: SCOPE })).toBeNull();
  });
});
