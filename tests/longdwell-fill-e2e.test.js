// tests/longdwell-fill-e2e.test.js — renderer orchestrator (runDurableFill) wired
// to the real FEAT-001 core, real jobs SQLite and the real store under a tmp
// data dir, with a fake AI. The bridge adapter calls the core directly (what
// the long-dwell-ai:* IPC does). Covers: crash after 3 of 8 + restart + resume,
// third click all skipped (exactly 8 AI calls in total), manual edit, edit
// during the AI call, changed fingerprint, and flag-off -> legacy with no writes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { runDurableFill } from '../renderer/src/js/longdwell-fill-logic.js';
const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/store');
const jobs = require('../src/jobs');
const fill = require('../src/jobs/long-dwell-ai-fill');

const HOST = os.hostname();
const ON = { enabled: true, types: { longDwellAiFill: true } };
const T0 = new Date(2026, 10, 4, 9, 0, 0).getTime();
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const CRASH = new Error('CRASH_SENTINEL');
let tmp, clock, aiCalls, boot;

function restart(flags) {
  boot++;
  jobs._resetForTests({ owner: HOST + '|' + boot + '|boot' + boot, flags: flags || ON, now: () => clock, logger: quiet });
  jobs.init();
  return fill.createCore(Object.assign(fill._storeDeps(), { jobs, now: () => clock, log: quiet }));
}

// The renderer bridge, backed by the core. After crash() every call throws
// (the process is gone), so nothing more reaches main.
function adapter(core) {
  const a = { dead: false, lastRunId: null };
  const live = (fn) => async (p) => { if (a.dead) throw new Error('renderer gone'); return fn(p); };
  a.bridge = {
    status: live(() => core.status()),
    plan: live((p) => { const r = core.plan(p); if (r && r.runId) a.lastRunId = r.runId; return r; }),
    unitStart: live((p) => core.unitStart(p)),
    commit: live((p) => core.commit(p)),
    finish: live((p) => core.finish(p)),
    today: live((p) => core.today(p)),
  };
  a.crash = () => { a.dead = true; core._runsForTests().get(a.lastRunId).handle._abandonForTests(); };
  return a;
}

const cands = (n, fpOf) => Array.from({ length: n }, (_, i) => {
  const id = 'U' + (i + 1);
  return { key: id + '::primary', equipmentId: id, woKey: 'primary', isPrimary: true, fp: fpOf ? fpOf(id) : 'fp-' + id };
});
const fakeAi = (c) => { aiCalls.push(c.key); return { delayReason: 'Parts Delay', escalation: 'SEV4', summary: '- Initial Issue Reported: ' + c.key, fp: c.fp }; };
const annotations = () => store.load('longDwellStore', {});

async function fullRun(core, list, extra) {
  const a = adapter(core);
  return runDurableFill(Object.assign({ table: 'computed', candidates: list, bridge: a.bridge, fillOne: async (c) => fakeAi(c) }, extra || {}));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-e2e-'));
  engine.close(); setDataDir(tmp);
  clock = T0; aiCalls = []; boot = 0;
});
afterEach(() => { jobs._resetForTests(); engine.close(); });

describe('durable AI Fill end to end', () => {
  it('crash after 3 of 8, restart, resume fills the other 5; third click skips all 8; exactly 8 AI calls', async () => {
    let core = restart();
    const a1 = adapter(core);
    let n = 0;
    const r1 = await runDurableFill({
      table: 'computed', candidates: cands(8), bridge: a1.bridge,
      fillOne: async (c) => {
        if (++n === 4) { a1.crash(); throw CRASH; }   // dies while starting unit 4, before its AI call
        return fakeAi(c);
      },
    });
    expect(r1).toMatchObject({ ok: false, aborted: true });
    expect(aiCalls.length).toBe(3);

    core = restart();                                  // simulated app restart
    expect(jobs.getStatus().lastRecovery).toMatchObject({ requeued: 1 });
    const st = core.status();
    expect(st.durable).toBe(true);
    expect(st.pending).toEqual([expect.objectContaining({ table: 'computed', attempt: 1, settled: 3 })]);
    expect(st.filledToday).toEqual({ computed: 3, csv: 0 });
    // badges after restart: today() hydration
    expect(Object.keys(core.today({ table: 'computed' }).entries).sort()).toEqual(['U1::primary', 'U2::primary', 'U3::primary']);

    const r2 = await fullRun(core, cands(8), { resume: true });
    expect(r2.ok).toBe(true);
    expect(r2.resumed).toBe(true);
    expect(r2.summary).toBe('3 skipped (already filled today), 5 filled');
    expect(aiCalls.slice(3)).toEqual(['U4', 'U5', 'U6', 'U7', 'U8'].map((u) => u + '::primary'));

    const r3 = await fullRun(core, cands(8));
    expect(r3.summary).toBe('8 skipped (already filled today), 0 filled');
    expect(aiCalls.length).toBe(8);
    expect(new Set(aiCalls).size).toBe(8);

    const ann = annotations();
    for (let i = 1; i <= 8; i++) expect(ann['U' + i + '::primary']).toMatchObject({ delayReason: 'Parts Delay', escalationLevel: 'SEV4' });
    expect(Object.keys(core.today({ table: 'computed' }).entries).length).toBe(8);
  });

  it('a manually edited unit is skipped ("edited by you") and keeps the edit', async () => {
    let core = restart();
    await fullRun(core, cands(4));
    store.update('longDwellStore', (s) => { s['U2::primary'].summary = 'my own words'; return s; }, {});
    core = restart();
    const r = await fullRun(core, cands(4));
    expect(r.summary).toBe('3 skipped (already filled today), 0 filled, 1 skipped (edited by you)');
    expect(annotations()['U2::primary'].summary).toBe('my own words');
    expect(aiCalls.length).toBe(4);
    expect(core.today({ table: 'computed' }).entries['U2::primary']).toBeUndefined();
  });

  it('an edit made while the AI call is in flight is never overwritten', async () => {
    const core = restart();
    const r = await fullRun(core, cands(2), {
      fillOne: async (c) => {
        if (c.key === 'U2::primary') store.update('longDwellStore', (s) => { s['U2::primary'] = { equipmentId: 'U2', woKey: 'primary', delayReason: 'Towing', escalationLevel: '', summary: '' }; return s; }, {});
        return fakeAi(c);
      },
    });
    expect(r.summary).toBe('0 skipped (already filled today), 1 filled, 1 skipped (edited by you)');
    expect(annotations()['U2::primary']).toMatchObject({ delayReason: 'Towing', summary: '' });
  });

  it('a changed fingerprint refills only that unit', async () => {
    const core = restart();
    await fullRun(core, cands(8));
    const r = await fullRun(core, cands(8, (id) => (id === 'U5' ? 'fp-U5-new-timeline' : 'fp-' + id)));
    expect(r.summary).toBe('7 skipped (already filled today), 1 filled');
    expect(aiCalls.length).toBe(9);
    expect(aiCalls[8]).toBe('U5::primary');
  });

  it('a failed unit is counted, not recorded, and retried on the next click', async () => {
    const core = restart();
    const r1 = await fullRun(core, cands(3), { fillOne: async (c) => { if (c.key === 'U2::primary') throw new Error('ai down'); return fakeAi(c); } });
    expect(r1.summary).toBe('0 skipped (already filled today), 2 filled, 1 failed');
    expect(core.today({ table: 'computed' }).entries['U2::primary']).toBeUndefined();
    const r2 = await fullRun(core, cands(3));
    expect(r2.summary).toBe('2 skipped (already filled today), 1 filled');
    expect(aiCalls).toEqual(['U1::primary', 'U3::primary', 'U2::primary']);
  });

  it('flags off -> {legacy:true}, no AI call and nothing written', async () => {
    store.save('longDwellStore', { 'U1::primary': { equipmentId: 'U1', woKey: 'primary', delayReason: '', escalationLevel: '', summary: '' } });
    const ldFile = store.REGISTRY.longDwellStore();
    const before = fs.readFileSync(ldFile);
    for (const flags of [{ enabled: false, types: { longDwellAiFill: true } }, { enabled: true, types: {} }]) {
      const core = restart(flags);
      expect(core.status()).toMatchObject({ ok: true, durable: false });
      const r = await fullRun(core, cands(3));
      expect(r).toEqual({ legacy: true });
    }
    expect(aiCalls).toEqual([]);
    expect(fs.readFileSync(ldFile).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'long_dwell_ai_fills.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
  });
});
