// tests/jobs-adopt-repair-intel.test.js — T11: repair-intel background cycle
// adoption (Phase 7, design §9.2). Gate b: with every jobs flag off (and in
// degraded mode, gate f) each scenario deep-equals the golden captured from
// the UNCHANGED d57e9b5 background.js (syncUnit order/opts, analyzeUnit calls,
// warn + info lists). Also: crash-loop guard is not tripped by a thrown sync,
// the pending AI candidate is carried across a crash (repairIntel resume), and
// the Phase 5 supervisor ownership is untouched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import * as fx from './fixtures/jobs-repair-intel-fixture.js';
const require = createRequire(import.meta.url);

fx.installStubs();
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const jobs = require('../src/jobs');
const BASE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/jobs-repair-intel-baseline.json', import.meta.url)), 'utf8'));
const HOST = os.hostname();
const ON = { enabled: true, types: { repairIntel: true } };

function loadBg() {
  const p = require.resolve('../src/repair-intel/background');
  delete require.cache[p];
  return require('../src/repair-intel/background');
}
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 2)); }
  return false;
}

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-ri-')); engine.close(); setDataDir(tmp); fx.resetRecorders(); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); jobs._resetForTests(); engine.close(); });

describe('T11 flags-off golden parity vs d57e9b5', () => {
  for (const name of Object.keys(fx.SCENARIOS)) {
    it(name + ': identical to the base-code golden (all jobs flags off)', async () => {
      jobs._resetForTests({ flags: { enabled: false, types: {} } });
      expect(jobs.init()).toEqual({ mode: 'off' });
      fx.setupClock();
      const out = await fx.runScenario(loadBg(), name);
      expect(out).toEqual(BASE[name]);
      expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
    });
  }

  it('flags off, {ok:true, added:1}: exactly one analyzeUnit, no "[bg] sync … failed", failed=0', async () => {
    jobs._resetForTests();
    fx.setupClock();
    const out = await fx.runScenario(loadBg(), 'changed');
    expect(out.analyze).toEqual([['U1', {}]]);
    expect(out.warn.filter((w) => /\[bg\] sync .* failed/.test(w))).toEqual([]);
    expect(out.info).toEqual(['[bg] cycle: synced=3 failed=0 aiRan=1 (batch=3/3 units)']);
  });

  it('flags off, null result: failed++, no TypeError, no warn', async () => {
    jobs._resetForTests();
    fx.setupClock();
    const out = await fx.runScenario(loadBg(), 'nullResult');
    expect(out.warn).toEqual([]);
    expect(out.info).toEqual(['[bg] cycle: synced=2 failed=1 aiRan=0 (batch=3/3 units)']);
  });

  it('[gate f] degraded (node:sqlite unavailable, flags on) -> identical to the golden', async () => {
    vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
    jobs._resetForTests({ flags: ON });
    expect(jobs.init().mode).toBe('degraded');
    fx.setupClock();
    for (const name of Object.keys(fx.SCENARIOS)) expect(await fx.runScenario(loadBg(), name)).toEqual(BASE[name]);
  });

  it('only another type enabled (deepScan) -> identical, no rows', async () => {
    jobs._resetForTests({ flags: { enabled: true, types: { deepScan: true } } });
    expect(jobs.init()).toEqual({ mode: 'active' });
    fx.setupClock();
    for (const name of Object.keys(fx.SCENARIOS)) expect(await fx.runScenario(loadBg(), name)).toEqual(BASE[name]);
    expect(engine.getDb().prepare('SELECT COUNT(*) AS n FROM jobs').get().n).toBe(0);
  });
});

describe('T11 flags on', () => {
  it('changed scenario: same calls/logs as the golden; completed job with per-unit rows', async () => {
    jobs._resetForTests({ flags: ON });
    expect(jobs.init()).toEqual({ mode: 'active' });
    fx.setupClock();
    const out = await fx.runScenario(loadBg(), 'changed');
    expect(out).toEqual(BASE.changed);
    const db = engine.getDb();
    const job = db.prepare('SELECT * FROM jobs').get();
    expect(job).toMatchObject({ type: 'repairIntel', scope_key: 'cycle', state: 'completed' });
    expect(JSON.parse(job.checkpoint_json)).toEqual({ aiCandidate: 'U1', aiDone: true, synced: 3, failed: 0, aiRan: 1 });
    expect(db.prepare('SELECT unit_key, status, detail_json FROM job_checkpoint ORDER BY unit_key').all()).toEqual([
      { unit_key: 'U1', status: 'done', detail_json: '{"changed":true}' },
      { unit_key: 'U2', status: 'done', detail_json: '{"changed":false}' },
      { unit_key: 'U3', status: 'done', detail_json: '{"changed":false}' },
    ]);
    // each scenario still equals the golden with flags on
    for (const name of ['nullResult', 'throwing', 'unchanged', 'allFresh']) expect(await fx.runScenario(loadBg(), name)).toEqual(BASE[name]);
  });

  async function crashCycle(boot, syncImpl, analyzeImpl, waitCond) {
    jobs._resetForTests({ owner: HOST + '|' + process.pid + '|' + boot, flags: ON });
    jobs.init();
    const realBegin = jobs.begin;
    let live = null;
    vi.spyOn(jobs, 'begin').mockImplementation((a) => (live = realBegin(a)));
    fx.resetRecorders();
    fx.applyScenario('changed');
    fx.rec.syncImpl = syncImpl;
    fx.rec.analyzeImpl = analyzeImpl || null;
    const bg = loadBg();
    bg.runOnce();                               // dropped: the "process" dies mid-cycle
    expect(await waitFor(waitCond)).toBe(true);
    const h = live;
    vi.restoreAllMocks();
    return h;
  }

  it('a thrown sync settles "failed" (never in_progress): isUnitPoisoned stays false after two resumed cycles; a real crash trips the guard', async () => {
    const hang = () => new Promise(() => {});
    const sync = (id) => { if (id === 'U2') throw new Error('AAP 503'); if (id === 'U3') return hang(); return { ok: true, added: 0 }; };
    const h1 = await crashCycle('b1', sync, null, () => fx.rec.sync.length === 3);
    expect(h1.durable).toBe(true);
    h1._abandonForTests();
    const h2 = await crashCycle('b2', sync, null, () => fx.rec.sync.length === 3);
    expect(h2.resumed).toBe(true);
    expect(h2.isUnitPoisoned('U2')).toBe(false);
    h2._abandonForTests();
    const h3 = await crashCycle('b3', sync, null, () => fx.rec.sync.length >= 2);
    expect(h3.resumed).toBe(true);
    expect(h3.attempt).toBe(3);
    expect(h3.isUnitPoisoned('U2')).toBe(false);
    expect(h3.isUnitPoisoned('U3')).toBe(true);   // in_progress during two interrupted attempts
    const st = engine.getDb().prepare('SELECT unit_key, status FROM job_checkpoint ORDER BY unit_key').all();
    expect(st.find((r) => r.unit_key === 'U2').status).toBe('failed');
    expect(fx.rec.sync.map((x) => x[0])).toEqual(['U1', 'U2']);   // U3 left out of this resumed run only
    h3._abandonForTests();
  });

  it('repairIntel resume: pending {aiCandidate:U1, aiDone:false} -> analyzeUnit("U1") once on resume', async () => {
    const h1 = await crashCycle('a1', (id) => ({ ok: true, added: id === 'U1' ? 1 : 0 }), () => new Promise(() => {}), () => fx.rec.analyze.length === 1);
    const db = engine.getDb();
    expect(JSON.parse(db.prepare('SELECT checkpoint_json FROM jobs').get().checkpoint_json)).toEqual({ aiCandidate: 'U1', aiDone: false });
    h1._abandonForTests();
    jobs._resetForTests({ owner: HOST + '|' + process.pid + '|a2', flags: ON });
    jobs.init();
    fx.resetRecorders();
    fx.applyScenario('unchanged');
    fx.rec.roster = ['U1', 'U2', 'U3'];
    await loadBg().runOnce();
    expect(fx.rec.analyze).toEqual([['U1', {}]]);
    const job = db.prepare('SELECT * FROM jobs').get();
    expect(job.state).toBe('completed');
    expect(job.attempt).toBe(2);
    expect(JSON.parse(job.checkpoint_json)).toMatchObject({ aiCandidate: 'U1', aiDone: true, aiRan: 1 });
  });

  it('supervisor ownership is unchanged: runOnce never arms legacy timers or claims', async () => {
    jobs._resetForTests({ flags: ON });
    jobs.init();
    const bg = loadBg();
    fx.resetRecorders(); fx.applyScenario('changed');
    await bg.runOnce();
    expect(bg.__test__.owned()).toBe(false);
    expect(bg.__test__.legacyArmed()).toBe(false);
  });
});
