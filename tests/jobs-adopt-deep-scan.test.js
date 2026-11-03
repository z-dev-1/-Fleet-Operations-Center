// tests/jobs-adopt-deep-scan.test.js — T10: deep-scan adoption (Phase 7,
// design §9.1). Gate b: with every jobs flag off (and in degraded mode, gate f)
// the fleet / on-demand / force runs deep-equal the golden captured from the
// UNCHANGED d57e9b5 deep-scan.js (tests/fixtures/jobs-deep-scan-baseline.json):
// notesStore, pushData sequence, pushStatus, prompts, addEvent / enqueue /
// onStageUpdate args, warn list, info list and the return value.
// Round-3 fix 1: flags off -> per-batch pushData for every batch, no
// "[DS] Incremental save failed" warn.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
const require = createRequire(import.meta.url);

fx.installStubs();
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');
const ds = require('../src/orcha/deep-scan');
const BASE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/jobs-deep-scan-baseline.json', import.meta.url)), 'utf8'));
const MODES = ['fleet', 'ondemand', 'force'];

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ds-'));
  engine.close(); setDataDir(tmp);
  fx.resetRecorders();
  fx.setupClock();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); jobs._resetForTests(); engine.close(); });

const jobsLogs = () => fx.rec.logs.filter((l) => l.ns === 'jobs');
async function run(mode, opts) { fx.resetRecorders(); return fx.runScenario(ds, mode, opts); }

describe('T10 flags-off golden parity vs d57e9b5', () => {
  for (const mode of MODES) {
    it(mode + ': identical to the base-code golden (all jobs flags off)', async () => {
      jobs._resetForTests({ flags: { enabled: false, types: {} } });
      expect(jobs.init()).toEqual({ mode: 'off' });
      const out = await run(mode);
      expect(out).toEqual(BASE[mode]);
      expect(out.ret).toStrictEqual({ processed: BASE[mode].ret.processed, improved: BASE[mode].ret.improved });
      expect(jobsLogs()).toEqual([]);
      expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);   // jobs tables absent: no db at all
    });
  }

  it('default (init never called / production flag resolution) is identical too', async () => {
    jobs._resetForTests();
    const out = await run('fleet');
    expect(out).toEqual(BASE.fleet);
    jobs._resetForTests();
    jobs.init();
    expect(await run('fleet')).toEqual(BASE.fleet);
  });

  it('[round-3 fix 1] flags off: per-batch pushData for EVERY batch and no "Incremental save failed" warn', async () => {
    jobs._resetForTests({ flags: { enabled: false, types: {} } });
    jobs.init();
    for (const mode of MODES) {
      const out = await run(mode);
      const batches = Math.ceil(out.ret.processed / ds.DS_BATCH_SIZE);
      const partial = out.pushData.filter((p) => p._partial === 'deep-scan').length;
      expect(partial).toBe(batches);
      expect(out.pushDataCount).toBe(batches + 1);
      expect(out.pushDataCount).toBe(BASE[mode].pushDataCount);
      expect(out.warn.filter((w) => /Incremental save failed/.test(w))).toEqual([]);
      expect(out.warn).toEqual([]);
      expect(out.info.filter((m) => /^\[DS\] Incremental save after /.test(m)).length).toBe(batches);
    }
  });

  it('only another type enabled (repairIntel) -> deep-scan is still identical and creates no rows', async () => {
    jobs._resetForTests({ flags: { enabled: true, types: { repairIntel: true } } });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const out = await run('fleet');
    expect(out).toEqual(BASE.fleet);
    expect(engine.getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });

  it('[gate f] degraded (node:sqlite unavailable, flags on) -> legacy path identical to the golden', async () => {
    vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } } });
    expect(jobs.init()).toEqual({ mode: 'degraded', reason: 'node:sqlite unavailable' });
    for (const mode of MODES) {
      const out = await run(mode);
      expect(out).toEqual(BASE[mode]);
    }
  });
});

describe('T10 flags on', () => {
  const ON = { enabled: true, types: { deepScan: true } };
  it('fresh durable fleet job: same notes / pushes / prompts as the golden; completed; per-unit rows', async () => {
    jobs._resetForTests({ flags: ON });
    expect(jobs.init()).toEqual({ mode: 'active' });
    const out = await run('fleet');
    expect(out.notesStore).toEqual(BASE.fleet.notesStore);
    expect(out.pushData).toEqual(BASE.fleet.pushData);
    expect(out.pushStatus).toEqual(BASE.fleet.pushStatus);
    expect(out.promptCount).toBe(BASE.fleet.promptCount);
    expect(out.prompts).toEqual(BASE.fleet.prompts);
    expect(out.addEvent).toEqual(BASE.fleet.addEvent);
    expect(out.enqueue).toEqual(BASE.fleet.enqueue);
    expect(out.onStageUpdate).toEqual(BASE.fleet.onStageUpdate);
    expect(out.warn).toEqual(BASE.fleet.warn);
    expect(out.ret).toStrictEqual(BASE.fleet.ret);
    const db = engine.getDb();
    const job = db.prepare('SELECT * FROM jobs').get();
    expect(job).toMatchObject({ type: 'deepScan', scope_key: 'fleet', state: 'completed', attempt: 1 });
    expect(JSON.parse(job.checkpoint_json)).toMatchObject({ total: 6, resumeSkipped: 0, processed: 6, improved: 4 });
    const cps = db.prepare('SELECT unit_key, status, sig FROM job_checkpoint ORDER BY unit_key').all();
    const by = Object.fromEntries(cps.map((c) => [c.unit_key, c]));
    for (const id of ['U101', 'U102', 'U103', 'U104']) { expect(by[id].status).toBe('done'); expect(by[id].sig).toMatch(/^[0-9a-f]{16}$/); }
    expect(by.U105.status).toBe('failed');
    expect(by.U106.status).toBe('failed');
    expect(by.U108).toBeUndefined();   // skipped-unchanged before the job
  });

  it('on-demand and force paths (no durableScope) never create job rows', async () => {
    jobs._resetForTests({ flags: ON });
    jobs.init();
    expect(await run('ondemand')).toEqual(BASE.ondemand);
    expect(await run('force')).toEqual(BASE.force);
    expect(engine.getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });

  it('a body throw -> job failed and the same error object is rethrown', async () => {
    jobs._resetForTests({ flags: ON });
    jobs.init();
    fx.resetRecorders();
    const boom = new Error('push failed');
    fx.rec.store.set('notesStore', {});
    // The final (non-partial) pushData throws after the job is running.
    let caught = null;
    try {
      await ds.runOrchaDeepScan(fx.freshRows(), {
        durableScope: 'fleet', payload: {}, uptakeCount: 0, relayCount: 0,
        pushStatus: () => {}, pushData: (p) => { if (!p._partial) throw boom; },
      });
    } catch (e) { caught = e; }
    expect(caught).toBe(boom);
    expect(engine.getDb().prepare('SELECT state, last_error FROM jobs').all()).toEqual([{ state: 'failed', last_error: 'push failed' }]);
  });
});
