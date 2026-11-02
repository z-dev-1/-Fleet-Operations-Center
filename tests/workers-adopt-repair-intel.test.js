// tests/workers-adopt-repair-intel.test.js
// Phase 5 adoption of the repair-intel background loop (design §4.1, plan
// item 5, review fixes 3 and 6). Exactly one owner in both modes; supervisor
// counts.runs cadence; flag-on effects deep-equal flag-off effects. Effects
// are the fake telemetry track('repairIntel.cycle') calls — never per-tick
// log lines. Fake timers + require.cache fakes only (no SQLite/AAP/AI).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'wk-adopt-ri-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger (silent; no assertion ever reads a per-tick line) ──────────────
function _fakeLogger() { return { debug() {}, info() {}, warn() {}, error() {}, log() {} }; }
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── Telemetry: track spy counts by name, never runs _cycle ────────────────
let _trackCounts = {};
injectFakeModule('../src/telemetry', {
  track: (name) => { _trackCounts[name] = (_trackCounts[name] || 0) + 1; return Promise.resolve(); },
});

// ── Dependency authorities read by the supervisor ─────────────────────────
let _offline = false;
injectFakeModule('../src/orcha/offline', { isOffline: () => _offline });
injectFakeModule('../src/auth/midway-health-supervisor', {
  getState: () => 'HEALTHY',
  STATE: { HEALTHY: 'HEALTHY', OFFLINE: 'OFFLINE', WAITING_FOR_USER: 'WAITING_FOR_USER', COOLDOWN: 'COOLDOWN', RECOVERING: 'RECOVERING', FAILED: 'FAILED' },
});
injectFakeModule('../src/cluster', { mayRunProduction: () => true, mayLivePull: () => true });

const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-11-03T14:00:00Z').getTime();
const MIN = 60 * 1000;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const cycles = () => _trackCounts['repairIntel.cycle'] || 0;
const rec = () => sup.getStatus().workers.find((w) => w.name === 'repairIntel');

function loadBg() {
  const resolved = require.resolve('../src/repair-intel/background');
  delete require.cache[resolved];
  return require('../src/repair-intel/background');
}

function setup(flagOn) {
  sup._resetForTests();
  _trackCounts = {};
  _offline = false;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const notify = vi.fn();
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { repairIntel: true } }, notify, logger: _fakeLogger() });
  }
  return { bg: loadBg(), notify };
}

// Timeline: start() at T0, advance 45 min (5, 20, 40), then the
// scheduler.reload shape stop(); start() at 45 min, advance to 70 (50, 65).
async function runScenario(flagOn) {
  const { bg } = setup(flagOn);
  bg.start();
  await adv(45 * MIN);
  const first = cycles();
  const runsFirst = flagOn ? rec().counts.runs : null;
  bg.stop(); bg.start();
  await adv(25 * MIN);
  return {
    effects: { first, total: cycles() },
    runs: flagOn ? rec().counts.runs : null,
    runsFirst,
    legacyArmed: bg.__test__.legacyArmed(),
    owned: bg.__test__.owned(),
    workers: sup.getStatus().workers,
    bg,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt repairIntel — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const { bg } = setup(false);
    bg.start();
    expect(bg.__test__.legacyArmed()).toBe(true);
    expect(bg.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'repairIntel')).toBeUndefined();
    await adv(20 * MIN);
    expect(cycles()).toBe(2); // first delay (5 min) + one interval (20 min)
    bg.stop();
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const { bg } = setup(true);
    bg.start();
    expect(bg.__test__.legacyArmed()).toBe(false);
    expect(bg.__test__.owned()).toBe(true);
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('repairIntel');
    expect(ws[0].intervalMs).toBe(20 * MIN);
    expect(ws[0].timeoutMs).toBe(15 * MIN);
    expect(ws[0].maxFailures).toBe(3);
    expect(ws[0].cooldownMs).toBe(30 * MIN);
    expect(ws[0].dependsOn).toEqual(['cluster.production', 'offline', 'auth']);
    expect(ws[0].idempotent).toBe(true);
    expect(ws[0].nextRunAt).toBe(T0 + 5 * MIN);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runsFirst).toBe(3);
    expect(r.effects.first).toBe(3);
    expect(r.runs).toBe(5);
    expect(r.effects.total).toBe(5);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ first: 3, total: 5 });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.total).toBe(off.effects.total);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.owned).toBe(false);
    expect(off.workers.length).toBe(0);
  });
});

describe('workers adopt repairIntel — extras', () => {
  it('reload resumes, re-applies the 5 min first delay, keeps counters', async () => {
    const { bg } = setup(true);
    bg.start();
    await adv(45 * MIN);
    expect(rec().counts.runs).toBe(3);
    bg.stop();
    expect(rec().state).toBe('disabled');
    expect(rec().disabledReason).toBe('stopped');
    bg.start();
    expect(sup.getStatus().workers.length).toBe(1);
    expect(rec().nextRunAt).toBe(T0 + 50 * MIN);
    expect(rec().counts.runs).toBe(3);
    await adv(5 * MIN);
    expect(rec().counts.runs).toBe(4);
    expect(cycles()).toBe(4);
  });

  it('[FIX 6] dependency skip (offline) bypasses track and counts skipReasons.dependency.offline', async () => {
    const { bg } = setup(true);
    _offline = true;
    bg.start();
    await adv(45 * MIN);
    expect(_trackCounts['repairIntel.cycle']).toBeUndefined();
    const w = rec();
    expect(w.counts.runs).toBe(0);
    expect(w.skipReasons.dependency.offline).toBe(3);
    expect(w.waitingOn).toEqual(['offline']);
    expect(w.state).toBe('waiting');
    _offline = false;
    await adv(20 * MIN);
    expect(cycles()).toBe(1);
    expect(rec().counts.runs).toBe(1);
  });
});
