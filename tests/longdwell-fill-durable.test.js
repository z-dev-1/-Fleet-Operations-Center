// tests/longdwell-fill-durable.test.js — durable longDwellAiFill end to end on
// the main side: real store (setDataDir tmp) + real jobs SQLite, injected
// clock, fake AI. Crash/resume, re-click skipping, filled-today round-trip,
// manual-edit protection, refills, busy/idle, and main-side flag-off parity.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
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
let tmp, clock, aiCalls, boot;

function restart(flags) {
  boot++;
  jobs._resetForTests({ owner: HOST + '|' + boot + '|boot' + boot, flags: flags || ON, now: () => clock, logger: quiet });
  const st = jobs.init();
  const core = fill.createCore(Object.assign(fill._storeDeps(), { jobs, now: () => clock, log: quiet }));
  return { st, core };
}
const units = (n, fp) => Array.from({ length: n }, (_, i) => ({ key: 'U' + (i + 1) + '::primary', equipmentId: 'U' + (i + 1), woKey: 'primary', isPrimary: true, fp: fp || 'fp1' }));
const ai = (key) => { aiCalls.push(key); return { delayReason: 'Parts Delay', escalation: 'SEV4', summary: '- Initial Issue: ' + key }; };
// Drive a run like the renderer: plan -> (unit-start, AI, commit)* -> finish.
// stopAfter = N simulates the process dying after N commits (no finish).
function drive(core, table, list, o) {
  const opts = o || {};
  const p = core.plan({ table, units: list });
  const committed = [];
  let i = 0;
  for (const u of p.toFill) {
    if (opts.stopAfter != null && i >= opts.stopAfter) {
      if (opts.inFlight) { core.unitStart({ runId: p.runId, key: u.key }); }
      return { p, committed, crashed: true };
    }
    core.unitStart({ runId: p.runId, key: u.key });
    const fp = (list.find((x) => x.key === u.key) || {}).fp || 'fp1';
    const r = core.commit({ runId: p.runId, table, key: u.key, fp, result: ai(u.key) });
    committed.push([u.key, r.outcome]);
    i++;
  }
  const f = core.finish({ runId: p.runId });
  return { p, committed, f };
}
const crash = (core, runId) => core._runsForTests().get(runId).handle._abandonForTests();
const rows = () => engine.getDb().prepare("SELECT state, attempt FROM jobs WHERE type = 'longDwellAiFill' ORDER BY created_at, generation").all();

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-durable-'));
  engine.close(); setDataDir(tmp);
  clock = T0; aiCalls = []; boot = 0;
});
afterEach(() => { vi.restoreAllMocks(); jobs._resetForTests(); engine.close(); });

describe('store key', () => {
  it('REGISTRY.longDwellAiFills is registered and round-trips', () => {
    expect(typeof store.REGISTRY.longDwellAiFills).toBe('function');
    expect(store.REGISTRY.longDwellAiFills()).toBe(path.join(tmp, 'long_dwell_ai_fills.json'));
    expect(store.SQLITE_KEYS.has('longDwellAiFills')).toBe(false);
    store.save('longDwellAiFills', { version: 1, entries: { a: { day: 'd' } } });
    expect(store.load('longDwellAiFills', null)).toEqual({ version: 1, entries: { a: { day: 'd' } } });
  });
});

describe('crash / resume', () => {
  it('commit 3 of 6, crash, restart: resumed plan returns exactly the 3 remaining; 6 AI calls; no key twice', () => {
    let { st, core } = restart();
    expect(st).toEqual({ mode: 'active' });
    const r1 = drive(core, 'computed', units(6), { stopAfter: 3 });
    expect(r1.committed.map((c) => c[1])).toEqual(['filled', 'filled', 'filled']);
    crash(core, r1.p.runId);

    ({ core } = restart());
    expect(jobs.getStatus().lastRecovery).toMatchObject({ requeued: 1 });
    const s = core.status();
    expect(s).toMatchObject({ ok: true, durable: true, day: '2026-11-04', filledToday: { computed: 3, csv: 0 } });
    expect(s.pending).toEqual([{ table: 'computed', jobId: expect.any(String), attempt: 1, settled: 3, keys: units(6).map((u) => u.key) }]);
    const r2 = drive(core, 'computed', units(6));
    expect(r2.p.resumed).toBe(true);
    expect(r2.p.toFill.map((x) => x.key)).toEqual(['U4::primary', 'U5::primary', 'U6::primary']);
    expect(r2.p.skipped).toEqual(['U1', 'U2', 'U3'].map((k) => ({ key: k + '::primary', reason: 'filled-today' })));
    expect(aiCalls.length).toBe(6);
    expect(new Set(aiCalls).size).toBe(6);
    expect(r2.f.counts).toMatchObject({ planned: 3, filled: 3, filledToday: 3, notRun: 0 });
    expect(rows()).toEqual([{ state: 'completed', attempt: 2 }]);
    expect(core.status().pending).toEqual([]);
  });

  it('an in-flight unit is offered again once; in progress in two runs -> crash-loop skip', () => {
    let { core } = restart();
    const r1 = drive(core, 'computed', units(4), { stopAfter: 2, inFlight: true });   // U3 started, never committed
    crash(core, r1.p.runId);
    ({ core } = restart());
    const p2 = core.plan({ table: 'computed', units: units(4) });
    expect(p2.resumed).toBe(true);
    expect(p2.toFill.map((x) => x.key)).toEqual(['U3::primary', 'U4::primary']);   // offered again
    core.unitStart({ runId: p2.runId, key: 'U3::primary' });                         // crashes on U3 again
    crash(core, p2.runId);
    ({ core } = restart());
    const r3 = drive(core, 'computed', units(4));
    expect(r3.p.resumed).toBe(true);
    expect(r3.p.toFill.map((x) => x.key)).toEqual(['U4::primary']);
    expect(r3.p.skipped).toContainEqual({ key: 'U3::primary', reason: 'crash-loop' });
    expect(r3.f.counts).toMatchObject({ crashLoop: 1, filled: 1, filledToday: 2 });
    expect(aiCalls).toEqual(['U1::primary', 'U2::primary', 'U4::primary']);
  });
});

describe('re-click', () => {
  it('after a partial run skips the filled units and fills the rest; after a full run nothing is left', () => {
    const { core } = restart();
    const r1 = drive(core, 'computed', units(5), { stopAfter: 2 });
    core.finish({ runId: r1.p.runId });                     // user stopped early
    const r2 = drive(core, 'computed', units(5));
    expect(r2.p.toFill.map((x) => x.key)).toEqual(['U3::primary', 'U4::primary', 'U5::primary']);
    expect(r2.f.counts).toMatchObject({ units: 5, filledToday: 2, filled: 3, edited: 0, hasContent: 0, failed: 0 });
    const r3 = drive(core, 'computed', units(5));
    expect(r3.p.toFill).toEqual([]);
    expect(r3.p.skipped.every((x) => x.reason === 'filled-today')).toBe(true);
    expect(r3.f.counts).toMatchObject({ filledToday: 5, filled: 0 });
    expect(aiCalls.length).toBe(5);
    expect(rows().map((r) => r.state)).toEqual(['completed', 'completed', 'completed']);
  });

  it('filled-today survives a restart (store round-trip): today() and annotations intact', () => {
    // The JSON store has no in-memory cache (every load reads the file), so
    // a fresh core + jobs reset is a full restart for this state.
    let { core } = restart();
    drive(core, 'computed', units(3));
    ({ core } = restart());
    const t = core.today({ table: 'computed' });
    expect(t.day).toBe('2026-11-04');
    expect(Object.keys(t.entries).sort()).toEqual(['U1::primary', 'U2::primary', 'U3::primary']);
    expect(t.entries['U1::primary'].filledAt).toBe(new Date(T0).toISOString());
    const ann = JSON.parse(fs.readFileSync(path.join(tmp, 'long_dwell.json'), 'utf8'));
    expect(ann['U2::primary']).toMatchObject({ equipmentId: 'U2', woKey: 'primary', delayReason: 'Parts Delay', escalationLevel: 'SEV4', summary: '- Initial Issue: U2::primary' });
    expect(drive(core, 'computed', units(3)).p.toFill).toEqual([]);
  });
});

describe('manual edits are never overwritten', () => {
  it('edited after the fill -> skipped "edited" and dropped from today()', () => {
    const { core } = restart();
    drive(core, 'computed', units(2));
    store.update('longDwellStore', (s) => { s['U1::primary'].summary = 'my own words'; return s; }, {});
    clock += 24 * 3600 * 1000;                                  // even the next day
    const p = core.plan({ table: 'computed', units: units(2) });
    expect(p.skipped).toEqual([{ key: 'U1::primary', reason: 'edited' }]);
    expect(p.toFill).toEqual([{ key: 'U2::primary', reason: 'refresh-day' }]);
    core.finish({ runId: p.runId });
    clock -= 24 * 3600 * 1000;
    expect(Object.keys(core.today({ table: 'computed' }).entries)).toEqual(['U2::primary']);
  });

  it('edited between plan and commit -> "edited-during-run", stored value unchanged, no record', () => {
    const { core } = restart();
    const p = core.plan({ table: 'computed', units: units(1) });
    store.update('longDwellStore', (s) => { s['U1::primary'] = { equipmentId: 'U1', woKey: 'primary', delayReason: 'Weather', escalationLevel: '', summary: '', updatedAt: 'x' }; return s; }, {});
    const r = core.commit({ runId: p.runId, table: 'computed', key: 'U1::primary', fp: 'fp1', result: ai('U1::primary') });
    expect(r).toEqual({ ok: true, outcome: 'skipped', reason: 'edited-during-run' });
    expect(store.load('longDwellStore', {})['U1::primary']).toEqual({ equipmentId: 'U1', woKey: 'primary', delayReason: 'Weather', escalationLevel: '', summary: '', updatedAt: 'x' });
    expect(fs.existsSync(path.join(tmp, 'long_dwell_ai_fills.json'))).toBe(false);
    expect(core.finish({ runId: p.runId }).counts).toMatchObject({ editedDuringRun: 1, filled: 0 });
  });
});

describe('refills', () => {
  it('changed inputs (fingerprint) refill an unedited AI note', () => {
    const { core } = restart();
    drive(core, 'computed', units(2, 'fpA'));
    const list = units(2, 'fpA'); list[1].fp = 'fpB';
    const r = drive(core, 'computed', list);
    expect(r.p.toFill).toEqual([{ key: 'U2::primary', reason: 'inputs-changed' }]);
    expect(store.load('longDwellAiFills', null).entries['computed|U2::primary'].fp).toBe('fpB');
  });

  it('next local day refills unedited AI notes under a new day scope', () => {
    const { core } = restart();
    drive(core, 'computed', units(2));
    clock += 24 * 3600 * 1000;
    const r = drive(core, 'computed', units(2));
    expect(r.p.toFill.map((x) => x.reason)).toEqual(['refresh-day', 'refresh-day']);
    expect(store.load('longDwellAiFills', null).entries['computed|U1::primary'].day).toBe('2026-11-05');
    expect(engine.getDb().prepare("SELECT scope_key FROM jobs WHERE type = 'longDwellAiFill' ORDER BY created_at").all().map((x) => x.scope_key))
      .toEqual(['computed:2026-11-04', 'computed:2026-11-05']);
  });
});

describe('run guards', () => {
  it('a duplicate commit for the same key in one run is rejected and writes once', () => {
    const { core } = restart();
    const p = core.plan({ table: 'computed', units: units(1) });
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'U1::primary', fp: 'fp1', result: ai('U1::primary') }).outcome).toBe('filled');
    const before = fs.readFileSync(path.join(tmp, 'long_dwell.json'), 'utf8');
    clock += 1000;
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'U1::primary', fp: 'fp1', result: ai('U1::primary') })).toEqual({ ok: false, code: 'duplicate' });
    expect(fs.readFileSync(path.join(tmp, 'long_dwell.json'), 'utf8')).toBe(before);
    expect(Object.keys(store.load('longDwellAiFills', null).entries)).toEqual(['computed|U1::primary']);
  });

  it('a second plan on the same table while a run is live -> busy', () => {
    const { core } = restart();
    const p = core.plan({ table: 'computed', units: units(2) });
    expect(core.plan({ table: 'computed', units: units(2) })).toMatchObject({ ok: true, busy: true, runId: null, toFill: [] });
    expect(core.plan({ table: 'csv', units: [] })).toMatchObject({ ok: true, busy: false });
    core.finish({ runId: p.runId });
    expect(core.plan({ table: 'computed', units: units(2) }).busy).toBe(false);
  });

  it('the idle sweep cancels a stale run and the next plan proceeds', () => {
    const { core } = restart();
    const p = core.plan({ table: 'computed', units: units(2) });
    clock += 10 * 60 * 1000;
    expect(core.sweepIdle()).toEqual({ ok: true, cancelled: 0 });
    clock += 6 * 60 * 1000;
    expect(core.sweepIdle()).toEqual({ ok: true, cancelled: 1 });
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'U1::primary', fp: 'fp1', result: ai('U1::primary') })).toEqual({ ok: false, code: 'unknown-run' });
    const p2 = core.plan({ table: 'computed', units: units(2) });
    expect(p2).toMatchObject({ ok: true, busy: false, resumed: false });
    expect(p2.toFill.length).toBe(2);
    expect(rows().map((r) => r.state)).toEqual(['cancelled', 'running']);
    core.finish({ runId: p2.runId });
  });
});

describe('csv table (real store)', () => {
  it('fills manual fields through the core, keeps team columns, and reports filled today', () => {
    store.save('longDwellCsv', { importedAt: 'x', columns: [], rows: {
      'A1::S1::0': { assetId: 'A1', site: 'S1', csv: {}, manual: { delayReason: '', escalationAction: '', supportPOC: 'pat', asanaLink: '', notes: '' }, updatedAt: 'x' },
    } });
    const { core } = restart();
    const r = drive(core, 'csv', [{ key: 'A1::S1::0', fp: 'c1' }]);
    expect(r.committed).toEqual([['A1::S1::0', 'filled']]);
    expect(store.load('longDwellCsv', null).rows['A1::S1::0'].manual).toEqual({ delayReason: 'Parts Delay', escalationAction: 'SEV4', supportPOC: 'pat', asanaLink: '', notes: '- Initial Issue: A1::S1::0' });
    expect(core.status().filledToday).toEqual({ computed: 0, csv: 1 });
  });
});

describe('flag-off parity (main side)', () => {
  function seed() {
    store.save('longDwellStore', { 'U1::primary': { equipmentId: 'U1', woKey: 'primary', delayReason: '', escalationLevel: '', summary: '', updatedAt: 'x' } });
    store.save('longDwellCsv', { importedAt: 'x', columns: [], rows: { 'A::S::0': { assetId: 'A', site: 'S', csv: {}, manual: {}, updatedAt: 'x' } } });
    const files = ['long_dwell.json', 'long_dwell_csv.json'];
    return { files, bytes: files.map((f) => fs.readFileSync(path.join(tmp, f))) };
  }
  function assertInert(core, s) {
    const OFF = { ok: false, code: 'off' };
    expect(core.status()).toEqual({ ok: true, durable: false, day: '2026-11-04' });
    expect(core.plan({ table: 'computed', units: units(1) })).toEqual(OFF);
    expect(core.unitStart({ runId: 'x', key: 'U1::primary' })).toEqual(OFF);
    expect(core.commit({ runId: 'x', table: 'computed', key: 'U1::primary', fp: 'fp1', result: ai('U1::primary') })).toEqual(OFF);
    expect(core.commit({ runId: null, table: 'csv', key: 'A::S::0', fp: 'fp1', result: ai('A'), force: true, base: {} })).toEqual(OFF);
    expect(core.finish({ runId: 'x' })).toEqual(OFF);
    expect(core.today({ table: 'computed' })).toEqual(OFF);
    expect(core.sweepIdle()).toEqual(OFF);
    expect(fs.existsSync(path.join(tmp, 'long_dwell_ai_fills.json'))).toBe(false);
    s.files.forEach((f, i) => expect(fs.readFileSync(path.join(tmp, f)).equals(s.bytes[i])).toBe(true));
  }

  it('flags off: inert, no fills file, no transactional.sqlite, annotations byte-identical', () => {
    const s = seed();
    for (const flags of [{ enabled: false, types: { longDwellAiFill: true } }, { enabled: true, types: {} }]) {
      const { st, core } = restart(flags);
      expect(st).toEqual({ mode: 'off' });
      assertInert(core, s);
    }
    expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
  });

  it('degraded: inert, no SQL', () => {
    const s = seed();
    vi.spyOn(engine, 'isAvailable').mockReturnValue(false);
    const sp = ['exec', 'prepare', 'getDb'].map((k) => vi.spyOn(engine, k));
    const { st, core } = restart();
    expect(st.mode).toBe('degraded');
    assertInert(core, s);
    for (const x of sp) expect(x).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp, 'transactional.sqlite'))).toBe(false);
  });

  it('another type flagged (jobs active): longDwellAiFill still inert, zero longDwellAiFill rows', () => {
    const s = seed();
    const { st, core } = restart({ enabled: true, types: { deepScan: true } });
    expect(st).toEqual({ mode: 'active' });
    assertInert(core, s);
    expect(rows()).toEqual([]);
  });
});
