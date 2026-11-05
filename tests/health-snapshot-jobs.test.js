// tests/health-snapshot-jobs.test.js — T13: health:snapshot `jobs` section
// (Phase 7, design §10): read-only, bounded, redacted, memoized 30 s,
// NOT_LOADED when src/jobs is not in the require cache, isolated failures,
// off / degraded modes and foreign rows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const health = require('../src/health/snapshot');

const T = 1_800_000_000_000;
const quiet = { debug() {}, info() {}, warn() {} };
const jobsPath = path.join(path.dirname(require.resolve('../src/health/snapshot')), '..', 'jobs', 'index.js');

function summary(over) {
  return Object.assign({
    mode: 'active', reason: null,
    types: { deepScan: { flag: true, effective: true, adopted: true, mode: 'durable' }, longDwellAiFill: { flag: false, effective: false, adopted: true, mode: 'off' } },
    counts: { deepScan: { running: 1, completed: 40, bogus: 3 } },
    totals: { open: 1, recoveryRequired: 0, failed24h: 0, foreign: 0 },
    oldestRunning: { id: 'job_1', type: 'deepScan', scopeKey: 'fleet', startedAt: T - 1000, leaseUntil: T + 1000, attempt: 1, leaseExpired: false },
    recoveryRequiredCount: 0, recoveryRequired: [], lastRecovery: { at: T - 5000, requeued: 1, recoveryRequired: 0, failed: 0, cancelled: 0 }, lastError: null,
  }, over || {});
}

beforeEach(() => { health._resetForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('T13 jobs section', () => {
  it('NOT_LOADED when src/jobs is not in the require cache', () => {
    expect(require.cache[jobsPath]).toBeUndefined();
    const s = health.buildSnapshot({ now: () => T, logger: quiet });
    expect(s.jobs).toEqual({ status: 'unavailable', reason: 'not-loaded' });
  });

  it('shape and bounds: ≤5 recovery items, clipped + redacted strings, only known states in counts', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: 'job_' + i, type: 'deepScan', scopeKey: 'fleet', updatedAt: T, lastError: 'token=abcdef ' + 'x'.repeat(400) }));
    const s = health.buildSnapshot({ now: () => T, logger: quiet, jobs: { getSummary: () => summary({ recoveryRequired: many, recoveryRequiredCount: 8, reason: 'r'.repeat(300) }) } });
    const j = s.jobs;
    expect(j.status).toBe('ok');
    expect(j.mode).toBe('active');
    expect(j.reason.length).toBeLessThanOrEqual(120);
    expect(j.recoveryRequired.length).toBe(5);
    expect(j.recoveryRequired[0].lastError.length).toBeLessThanOrEqual(200);
    expect(j.recoveryRequired[0].lastError).toContain('token=[redacted]');
    expect(j.recoveryRequiredCount).toBe(8);
    expect(j.counts).toEqual({ deepScan: { running: 1, completed: 40 } });
    expect(j.types.longDwellAiFill.mode).toBe('off');
    expect(j.oldestRunning).toMatchObject({ id: 'job_1', type: 'deepScan', leaseExpired: false });
    expect(j.totals).toEqual({ open: 1, recoveryRequired: 0, failed24h: 0, foreign: 0 });
    expect(j.lastRecovery).toEqual({ at: T - 5000, requeued: 1, recoveryRequired: 0, failed: 0, cancelled: 0 });
  });

  it('a throwing getSummary makes only this section unavailable', () => {
    const s = health.buildSnapshot({ now: () => T, logger: quiet, jobs: { getSummary: () => { throw new Error('db gone'); } } });
    expect(s.jobs).toEqual({ status: 'unavailable', reason: 'db gone' });
    expect(s.ok).toBe(true);
    expect(s.workers.status).toBe('ok');
  });

  it('memoized for 30 s', () => {
    const getSummary = vi.fn(() => summary());
    const deps = (t) => ({ now: () => t, logger: quiet, jobs: { getSummary } });
    health.buildSnapshot(deps(T));
    health.buildSnapshot(deps(T + 10000));
    expect(getSummary).toHaveBeenCalledTimes(1);
    health.buildSnapshot(deps(T + health.SLOW_TTL_MS + 1));
    expect(getSummary).toHaveBeenCalledTimes(2);
  });

  describe('with the real facade', () => {
    let tmp, engine, jobs;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-health-'));
      require('../src/config/paths').setDataDir(tmp);
      engine = require('../src/store/sqlite_engine'); engine.close();
      jobs = require('../src/jobs');
    });
    afterEach(() => { jobs._resetForTests(); engine.close(); });

    it('off mode: no SQL, mode off', () => {
      jobs._resetForTests();
      const sp = vi.spyOn(engine, 'prepare');
      const s = health.buildSnapshot({ now: () => T, logger: quiet });
      expect(s.jobs.status).toBe('ok');
      expect(s.jobs.mode).toBe('off');
      expect(sp).not.toHaveBeenCalled();
    });

    it('degraded mode: mode + reason, flagged types legacy, no SQL', () => {
      vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
      jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, logger: quiet });
      jobs.init();
      const sp = vi.spyOn(engine, 'prepare');
      const s = health.buildSnapshot({ now: () => T, logger: quiet });
      expect(s.jobs).toMatchObject({ status: 'ok', mode: 'degraded', reason: 'node:sqlite unavailable' });
      expect(s.jobs.types.deepScan.mode).toBe('legacy');
      expect(sp).not.toHaveBeenCalled();
    });

    it('foreign rows: counted in totals.foreign only, never in recoveryRequired*/counts', () => {
      jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, logger: quiet, now: () => T });
      expect(jobs.init()).toEqual({ mode: 'active' });
      engine.getDb().prepare("INSERT INTO jobs (id,type,scope_key,generation,idempotency_key,state,attempt,max_attempts,created_at,updated_at) VALUES ('f1','futureType','x',1,'futureType:x:1','recovery_required',1,3,?,?)").run(T, T);
      const h = jobs.begin({ type: 'deepScan', scopeKey: 'fleet' }); h.start();
      const s = health.buildSnapshot({ now: () => T, logger: quiet });
      expect(s.jobs.totals.foreign).toBe(1);
      expect(s.jobs.recoveryRequiredCount).toBe(0);
      expect(s.jobs.recoveryRequired).toEqual([]);
      expect(s.jobs.counts).toEqual({ deepScan: { running: 1 } });
      expect(s.jobs.oldestRunning).toMatchObject({ type: 'deepScan', scopeKey: 'fleet', attempt: 1, leaseExpired: false });
      h.complete({});
    });

    it('longDwellAiFill flagged: types mode durable and counts.longDwellAiFill flow through', () => {
      jobs._resetForTests({ flags: { enabled: true, types: { longDwellAiFill: true } }, logger: quiet, now: () => T });
      expect(jobs.init()).toEqual({ mode: 'active' });
      const h = jobs.begin({ type: 'longDwellAiFill', scopeKey: 'computed:2026-11-04' }); h.start();
      const s = health.buildSnapshot({ now: () => T, logger: quiet });
      expect(s.jobs.types.longDwellAiFill).toEqual({ flag: true, effective: true, adopted: true, mode: 'durable' });
      expect(s.jobs.counts).toEqual({ longDwellAiFill: { running: 1 } });
      h.complete({});
    });
  });
});
