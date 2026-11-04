// tests/workers-adopt-daily-tasks.test.js
// Phase 5 adoption of the daily-tasks morning scheduler (design §4.5, plan
// item 9, review fix 3). Exactly one owner in both modes; supervisor
// counts.runs cadence; flag-on effects deep-equal flag-off effects.
//
// [FIX 3] concrete timeline: system time 2026-11-03T13:00:00Z = 08:00
// America/New_York (past MORNING_HOUR 7), startScheduler() at T0. The
// explicit _generate fakes make reason() an AI miss (2 attempts, 1.5 s gap),
// so the day stays unmarked and the _aiMiss cooldown (30 min) gates the retry:
//   - '[tasks] morning auto-generation' logged once by T0+8 s (+1.5 s gap),
//     reason called 2×;
//   - counts.runs 1 at 8 s, then +1 per 60 s grid slot (32 at T0+1860 s);
//   - no second generation at T0+30 min (1800 s < 9.5 s + 30 min);
//   - second generation ('AI retry 2/4') at T0+31 min (1860 s, the first 60 s
//     slot ≥ 9.5 s + 30 min), reason then called 4×;
//   - flag off over the same timeline: the same two lines and 4 reason calls.
// Effects are the once-per-generation lines and reason() calls, never
// per-tick lines. Real store in a temp dir; no AI, no relay, no Electron.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'wk-adopt-dt-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger recorder (daily-tasks namespace only) ──────────────────────────
let _logs = [];
function _fakeLogger(ns) {
  const rec = (level) => (...a) => { if (ns === 'daily-tasks') _logs.push({ level, msg: a.join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
}
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── Explicit _generate fakes (plan item 9): nothing else AI/relay reachable ──
const reason = vi.fn(async () => ({ ok: false, error: 'x' }));          // AI miss
injectFakeModule('../src/orcha/reason', { reason });
injectFakeModule('../src/orcha/recommend', { runRecommendations: () => ({ recommendations: [] }) });
injectFakeModule('../src/orcha/canonical_state', { signalTokens: () => '' });

const store = require('../src/store');
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-11-03T13:00:00Z').getTime(); // 08:00 America/New_York (EST)
const SEC = 1000;
const MIN = 60 * SEC;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'dailyTasks');
const genLogs = () => _logs.filter((l) => l.msg.includes('[tasks] morning auto-generation')).length;
const retryLogs = () => _logs.filter((l) => l.msg.includes('[tasks] morning auto-generation') && l.msg.includes('AI retry 2/4')).length;

function loadDt() {
  const resolved = require.resolve('../src/ipc/daily-tasks');
  delete require.cache[resolved];
  return require('../src/ipc/daily-tasks');
}

let dt = null;
function setup(flagOn) {
  if (dt) { try { dt.__test__.resetForTests(); } catch (_) {} }
  vi.clearAllTimers();                    // the legacy 8 s setTimeout is unstored
  vi.useRealTimers();
  sup._resetForTests();
  _logs = [];
  reason.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.save('dailyTasks', { ai: [], manual: [], lastGeneratedDay: null });
  store.save('fleetData', { rows: [{ equipmentId: 'U1', lifecycleState: 'Available' }] });
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { dailyTasks: true } }, notify: vi.fn(), logger: _fakeLogger('workers') });
  }
  dt = loadDt();
  dt.__test__.resetForTests();
  return dt;
}

const effects = () => ({ genLogs: genLogs(), retryLogs: retryLogs(), reason: reason.mock.calls.length, lastGeneratedDay: store.load('dailyTasks', {}).lastGeneratedDay || null });

// The full [FIX 3] timeline; checkpoints recorded for both modes.
async function runScenario(flagOn) {
  const d = setup(flagOn);
  const cp = {};
  const runs = () => (flagOn ? rec().counts.runs : null);
  d.__test__.startScheduler();
  await adv(8 * SEC);
  cp.at8s = { runs: runs() };
  await adv(2 * SEC);                     // T0+10 s: past the 1.5 s attempt gap
  cp.at10s = { ...effects(), runs: runs() };
  await adv(30 * MIN - 10 * SEC);         // T0+30 min
  cp.at30m = { ...effects(), runs: runs() };
  await adv(1 * MIN);                     // T0+31 min = 1860 s
  cp.at1860s = { genLogs: genLogs(), retryLogs: retryLogs(), runs: runs() };
  await adv(2 * SEC);                     // retry's 1.5 s gap settled
  cp.final = effects();
  return {
    effects: cp.final,
    checkpoints: cp,
    runs: runs(),
    legacyArmed: d.__test__.legacyArmed(),
    owned: d.__test__.owned(),
    workers: sup.getStatus().workers,
  };
}

afterEach(() => {
  if (dt) { try { dt.__test__.resetForTests(); } catch (_) {} }
  dt = null;
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt dailyTasks — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const d = setup(false);
    d.__test__.startScheduler();
    expect(d.__test__.legacyArmed()).toBe(true);
    expect(d.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'dailyTasks')).toBeUndefined();
    await adv(10 * SEC);
    expect(genLogs()).toBe(1);
    expect(reason).toHaveBeenCalledTimes(2);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const d = setup(true);
    d.__test__.startScheduler();
    expect(d.__test__.legacyArmed()).toBe(false);
    expect(d.__test__.owned()).toBe(true);
    d.__test__.startScheduler();          // repeat call: still one owner, one record
    expect(d.__test__.legacyArmed()).toBe(false);
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('dailyTasks');
    expect(ws[0].group).toBe('tasks');
    expect(ws[0].intervalMs).toBe(60 * SEC);
    expect(ws[0].timeoutMs).toBe(30 * MIN);
    expect(ws[0].maxFailures).toBe(5);
    expect(ws[0].cooldownMs).toBe(30 * MIN);
    expect(ws[0].dependsOn).toEqual([]);
    expect(ws[0].idempotent).toBe(true);
    expect(ws[0].nextRunAt).toBe(T0 + 8 * SEC);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.checkpoints.at8s.runs).toBe(1);
    expect(r.checkpoints.at10s.runs).toBe(1);
    expect(r.checkpoints.at30m.runs).toBe(31);   // 8 s + 60 s … 1800 s
    expect(r.checkpoints.at1860s.runs).toBe(32);
    const w = rec();
    expect(w.counts.fail).toBe(0);
    expect(w.counts.timeout).toBe(0);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    // 08:00 ET timeline, both modes.
    expect(off.checkpoints.at10s).toEqual({ genLogs: 1, retryLogs: 0, reason: 2, lastGeneratedDay: null, runs: null });
    expect(off.checkpoints.at30m).toEqual({ genLogs: 1, retryLogs: 0, reason: 2, lastGeneratedDay: null, runs: null });
    expect(off.checkpoints.at1860s).toEqual({ genLogs: 2, retryLogs: 1, runs: null });
    expect(off.effects).toEqual({ genLogs: 2, retryLogs: 1, reason: 4, lastGeneratedDay: null });
    expect(on.effects).toEqual(off.effects);
    const strip = (c) => { const { runs, ...rest } = c; return rest; };
    expect(strip(on.checkpoints.at10s)).toEqual(strip(off.checkpoints.at10s));
    expect(strip(on.checkpoints.at30m)).toEqual(strip(off.checkpoints.at30m));
    expect(strip(on.checkpoints.at1860s)).toEqual(strip(off.checkpoints.at1860s));
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.reason).toBe(off.effects.reason);
    expect(on.effects.genLogs).toBe(off.effects.genLogs);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
  });
});
