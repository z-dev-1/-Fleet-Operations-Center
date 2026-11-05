// tests/jobs-flags.test.js — T8 resolver + T8b per-type isolation through the
// facade (Phase 7, design §8; round-3 fix 3 / gate c: begin() step -1 checks
// the per-type flag first; enabling one type never makes another durable).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const pf = require('../src/config/perf-flags');
const jobs = require('../src/jobs');

describe('T8 resolveJobsFlags', () => {
  it('everything defaults off', () => {
    expect(pf.resolveJobsFlags({}, {})).toEqual({ enabled: false, types: { deepScan: false, repairIntel: false, longDwellAiFill: false, rcaAutofill: false } });
    expect(pf.JOB_TYPES).toEqual(['deepScan', 'repairIntel', 'longDwellAiFill', 'rcaAutofill']);
    expect(pf.JOB_ENV.longDwellAiFill).toBe('FLEET_JOBS_LONG_DWELL_AI_FILL');
  });
  it('only === true enables', () => {
    const s = { jobs: { durable: { enabled: 'true' }, deepScan: { durable: 1 }, repairIntel: { durable: true } } };
    expect(pf.resolveJobsFlags(s, {})).toMatchObject({ enabled: false, types: { deepScan: false, repairIntel: true } });
    expect(pf.resolveJobsFlags({ jobs: { durable: { enabled: true } } }, {}).enabled).toBe(true);
  });
  it("env '0'/'1' override both ways; garbage env ignored", () => {
    const s = { jobs: { durable: { enabled: true }, deepScan: { durable: true } } };
    expect(pf.resolveJobsFlags(s, { FLEET_JOBS_DURABLE: '0', FLEET_JOBS_DEEP_SCAN: '0' })).toMatchObject({ enabled: false, types: { deepScan: false } });
    expect(pf.resolveJobsFlags({}, { FLEET_JOBS_DURABLE: '1', FLEET_JOBS_RCA_AUTOFILL: '1' })).toMatchObject({ enabled: true, types: { rcaAutofill: true } });
    expect(pf.resolveJobsFlags(s, { FLEET_JOBS_DURABLE: 'yes', FLEET_JOBS_DEEP_SCAN: 'true' })).toMatchObject({ enabled: true, types: { deepScan: true } });
  });
  it('non-object settings tolerated; loadJobs survives a throwing load', () => {
    for (const bad of [null, undefined, 42, 'x', [], { jobs: 7 }, { jobs: { durable: [] } }]) {
      expect(pf.resolveJobsFlags(bad, {}).enabled).toBe(false);
    }
    expect(pf.loadJobs({ load: () => { throw new Error('io'); }, env: {} }).enabled).toBe(false);
    expect(pf.loadJobs({ load: () => ({ jobs: { durable: { enabled: true }, repairIntel: { durable: true } } }), env: {} }))
      .toMatchObject({ enabled: true, types: { repairIntel: true } });
  });
  it('existing resolvers are unchanged', () => {
    expect(pf.resolveWorkerFlags({}, {}).supervisorEnabled).toBe(false);
    expect(pf.resolveFlags({}, {}).telemetryEnabled).toBe(true);
  });
});

describe('T8b per-type isolation through the facade [round-3 fix 3]', () => {
  let tmp, warns, infos;
  const WO = '11111111-2222-3333-4444-555555555555';
  const SCOPES = { deepScan: 'fleet', repairIntel: 'cycle', rcaAutofill: WO, longDwellAiFill: 'computed:2026-11-04' };
  const log = () => ({ debug() {}, info: (m) => infos.push(m), warn: (m) => warns.push(m), error: (m) => warns.push(m) });
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-flags-')); engine.close(); setDataDir(tmp); warns = []; infos = []; });
  afterEach(() => { jobs._resetForTests(); engine.close(); });

  for (const only of ['deepScan', 'repairIntel', 'rcaAutofill', 'longDwellAiFill']) {
    it('only ' + only + ' enabled -> the other types stay NOOP with zero rows and no warn', () => {
      jobs._resetForTests({ flags: { enabled: true, types: { [only]: true } }, logger: log() });
      expect(jobs.init()).toEqual({ mode: 'active' });
      const others = Object.keys(SCOPES).filter((t) => t !== only);
      for (const t of others) {
        const h = jobs.begin({ type: t, scopeKey: SCOPES[t] });
        expect(h).toBe(jobs.NOOP_HANDLE);
        h.start(); h.unitsStarted(['U1']); h.complete({});
      }
      const db = engine.getDb();
      const n = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE type IN (' + others.map(() => '?').join(',') + ')').get(...others).n;
      expect(n).toBe(0);
      expect(warns).toEqual([]);
      const h = jobs.begin({ type: only, scopeKey: SCOPES[only] });
      expect(h.durable).toBe(true);
      h.start(); h.complete({});
      expect(db.prepare('SELECT type, state FROM jobs').all()).toEqual([{ type: only, state: 'completed' }]);
      const sum = jobs.getSummary(Date.now());
      for (const t of others) expect(sum.types[t].mode).toBe('off');
      expect(sum.types[only].mode).toBe('durable');
    });
  }

  it('longDwellAiFill flagged on -> effective + durable, no "deferred" info line; off -> NOOP', () => {
    jobs._resetForTests({ flags: { enabled: true, types: { longDwellAiFill: true } }, logger: log() });
    expect(jobs.init()).toEqual({ mode: 'active' });
    expect(jobs.getSummary(Date.now()).types.longDwellAiFill).toMatchObject({ adopted: true, effective: true, mode: 'durable' });
    expect(jobs.isEffective('longDwellAiFill')).toBe(true);
    expect(jobs.isEffective('deepScan')).toBe(false);
    const h = jobs.begin({ type: 'longDwellAiFill', scopeKey: 'csv:2026-11-04' });
    expect(h.durable).toBe(true);
    h.start(); h.complete({});
    expect(infos.filter((m) => /deferred/.test(m))).toEqual([]);
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, logger: log() });
    expect(jobs.init()).toEqual({ mode: 'active' });
    expect(jobs.begin({ type: 'longDwellAiFill', scopeKey: 'csv:2026-11-04' })).toBe(jobs.NOOP_HANDLE);
    expect(jobs.getSummary(Date.now()).types.longDwellAiFill).toMatchObject({ adopted: true, effective: false, mode: 'off' });
    expect(jobs.isEffective('longDwellAiFill')).toBe(false);
  });

  it('master switch off -> every type NOOP even when per-type flags are on', () => {
    jobs._resetForTests({ flags: { enabled: false, types: { deepScan: true, repairIntel: true, rcaAutofill: true, longDwellAiFill: true } }, logger: log() });
    expect(jobs.init()).toEqual({ mode: 'off' });
    for (const t of Object.keys(SCOPES)) expect(jobs.begin({ type: t, scopeKey: SCOPES[t] })).toBe(jobs.NOOP_HANDLE);
  });

  it('unknown type and bad scopeKey -> NOOP + warn once per type', () => {
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } }, logger: log() });
    jobs.init();
    jobs.begin({ type: 'nope', scopeKey: 'x' }); jobs.begin({ type: 'nope', scopeKey: 'x' });
    jobs.begin({ type: 'deepScan', scopeKey: 'bad scope!' }); jobs.begin({ type: 'deepScan', scopeKey: '' });
    expect(warns.length).toBe(2);
  });
});
