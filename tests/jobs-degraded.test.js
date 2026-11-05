// tests/jobs-degraded.test.js — T7: degraded mode, no-init lifecycle, init
// reason mapping (Phase 7, design §7; gate f; round-3 fix 5). The adopted
// bodies' degraded == flags-off parity is asserted in T10/T11/T12.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const schema = require('../src/jobs/schema');
const storeMod = require('../src/jobs/store');
const jobs = require('../src/jobs');

const ON = { enabled: true, types: { deepScan: true, repairIntel: true } };
let tmp, warns, infos;
const logger = () => ({ debug() {}, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => warns.push(m) });
const dbFile = () => path.join(tmp, 'transactional.sqlite');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-degraded-'));
  engine.close(); setDataDir(tmp);
  warns = []; infos = [];
});
afterEach(() => { vi.restoreAllMocks(); jobs._resetForTests(); engine.close(); });

describe('T7 degraded mode (node:sqlite unavailable)', () => {
  it('degraded, exactly one warn across init + 5 begins, NOOP handles, getSummary issues no SQL', () => {
    vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
    const sExec = vi.spyOn(engine, 'exec'); const sPrep = vi.spyOn(engine, 'prepare'); const sDb = vi.spyOn(engine, 'getDb');
    jobs._resetForTests({ flags: ON, logger: logger() });
    expect(jobs.init()).toEqual({ mode: 'degraded', reason: 'node:sqlite unavailable' });
    for (let i = 0; i < 5; i++) {
      const h = jobs.begin({ type: i % 2 ? 'repairIntel' : 'deepScan', scopeKey: i % 2 ? 'cycle' : 'fleet' });
      expect(h.durable).toBe(false);
      expect(h.degraded).toBe(true);
      h.start(); h.unitsStarted(['U1']); h.unitsSettled([{ key: 'U1', status: 'done' }]); h.complete({});
    }
    const sum = jobs.getSummary(Date.now());
    expect(sum.mode).toBe('degraded');
    expect(sum.reason).toBe('node:sqlite unavailable');
    expect(sum.types.deepScan.mode).toBe('legacy');
    expect(sum.types.rcaAutofill.mode).toBe('off');
    expect(sum.types.longDwellAiFill.mode).toBe('off');    // adopted but not flagged
    expect(sExec).not.toHaveBeenCalled(); expect(sPrep).not.toHaveBeenCalled(); expect(sDb).not.toHaveBeenCalled();
    expect(warns.length).toBe(1);
    expect(warns[0]).toMatch(/durable jobs requested for deepScan, repairIntel but node:sqlite unavailable — running non-durable \(legacy\) behavior; status: degraded/);
    expect(jobs.reconcile('x', 'done')).toEqual({ ok: false, code: 'off' });
  });

  it('[fix 5] ensureSchema result codes map to degraded reasons', () => {
    const cases = [
      [{ ok: false, code: 'busy', error: 'database is locked' }, 'schema init busy'],
      [{ ok: false, code: 'sqlite', error: 'disk I/O error' }, 'schema init failed: disk I/O error'],
      [{ ok: false, code: 'unavailable', error: 'x' }, 'node:sqlite unavailable'],
    ];
    for (const [ret, reason] of cases) {
      const sp = vi.spyOn(schema, 'ensureSchema').mockReturnValue(ret);
      jobs._resetForTests({ flags: ON, logger: logger() });
      expect(jobs.init()).toEqual({ mode: 'degraded', reason });
      expect(jobs.begin({ type: 'deepScan', scopeKey: 'fleet' }).durable).toBe(false);
      sp.mockRestore();
    }
  });

  it('init() throwing after flags are read -> degraded "init failed: …", warn once; second init returns the memo', () => {
    vi.spyOn(storeMod, 'createJobStore').mockImplementation(() => { throw new Error('kaboom'); });
    jobs._resetForTests({ flags: ON, logger: logger() });
    const s1 = jobs.init();
    expect(s1.mode).toBe('degraded');
    expect(s1.reason.startsWith('init failed:')).toBe(true);
    expect(s1.reason).toBe('init failed: kaboom');
    const s2 = jobs.init();
    expect(s2).toBe(s1);
    expect(warns.length).toBe(1);
  });
});

describe('T7 no init / flags off', () => {
  it('without init(): NOOP / {mode:off} / {ok:false, code:off}, no SQL, db file not created', () => {
    const sExec = vi.spyOn(engine, 'exec'); const sPrep = vi.spyOn(engine, 'prepare'); const sDb = vi.spyOn(engine, 'getDb'); const sAv = vi.spyOn(engine, 'isAvailable');
    jobs._resetForTests();
    const h = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' });
    expect(h).toBe(jobs.NOOP_HANDLE);
    expect(h.durable).toBe(false);
    expect(jobs.getSummary(Date.now())).toMatchObject({ mode: 'off', counts: {}, recoveryRequiredCount: 0, recoveryRequired: [] });
    expect(jobs.reconcile('x', 'done')).toEqual({ ok: false, code: 'off' });
    for (const s of [sExec, sPrep, sDb, sAv]) expect(s).not.toHaveBeenCalled();
    expect(fs.existsSync(dbFile())).toBe(false);
  });

  it('flags off (default): init -> {mode:off}; no SQLite access, no jobs tables, no file', () => {
    const sAv = vi.spyOn(engine, 'isAvailable'); const sExec = vi.spyOn(engine, 'exec');
    jobs._resetForTests({ flags: { enabled: false, types: { deepScan: true } }, logger: logger() });
    expect(jobs.init()).toEqual({ mode: 'off' });
    expect(jobs.begin({ type: 'deepScan', scopeKey: 'fleet' })).toBe(jobs.NOOP_HANDLE);
    expect(sAv).not.toHaveBeenCalled(); expect(sExec).not.toHaveBeenCalled();
    expect(fs.existsSync(dbFile())).toBe(false);
    expect(warns).toEqual([]);
  });

  it('flags off with an existing db file: sqlite_master has no jobs tables after init', () => {
    engine.isAvailable();                       // creates the file + kv only
    jobs._resetForTests({ flags: { enabled: true, types: {} }, logger: logger() });
    expect(jobs.init()).toEqual({ mode: 'off' });
    const names = engine.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    expect(names).not.toContain('jobs');
    expect(names).not.toContain('job_checkpoint');
  });

  it('the production default (no overrides) reads perf-flags.loadJobs -> off in tests', () => {
    jobs._resetForTests();
    expect(jobs.init()).toEqual({ mode: 'off' });
  });
});
