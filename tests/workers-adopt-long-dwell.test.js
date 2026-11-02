// tests/workers-adopt-long-dwell.test.js
// Phase 5 adoption of the long-dwell CSV auto-fetch scheduler (design §4.4,
// plan item 8 + D11, review fix 3). Exactly one owner in both modes;
// supervisor counts.runs cadence; flag-on effects deep-equal flag-off effects.
// Effects: buildLongDwellSources calls, fetchBothSources calls and the
// once-per-fire "[ld-schedule] scheduled run starting" line — never per-tick
// lines. Fakes: aap_api (resolves empty sources after a fake 5 s), aap_longdwell
// (CSV fallback resolves {ok:false}), electron (no windows). Real store in a
// temp dir. No Electron, no AAP, no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'wk-adopt-ld-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger recorder (long-dwell namespace only) ───────────────────────────
let _logs = [];
function _fakeLogger(ns) {
  const rec = (level) => (...a) => { if (ns === 'ipc:long-dwell-csv') _logs.push({ level, msg: a.join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
}
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── AAP fakes (plan D11) + electron ───────────────────────────────────────
let _buildImpl;
const buildLongDwellSources = vi.fn((...a) => _buildImpl(...a));
injectFakeModule('../src/scrapers/aap_api', { buildLongDwellSources });
let _csvImpl;
const fetchBothSources = vi.fn((...a) => _csvImpl(...a));
injectFakeModule('../src/scrapers/aap_longdwell', { DEFAULT_SEARCH_REQUEST: {}, fetchBothSources });
injectFakeModule('electron', { BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle() {}, removeHandler() {} } });

const store = require('../src/store');
const sup = require('../src/workers/supervisor');

const T0 = new Date(2026, 10, 3, 10, 15, 10).getTime(); // local 10:15:10
const SCHED_TIME = '10:16';
const SEC = 1000;
const MIN = 60 * SEC;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'longDwell');
const fireLogs = () => _logs.filter((l) => l.msg.includes('[ld-schedule] scheduled run starting')).length;

function loadLd() {
  const resolved = require.resolve('../src/ipc/long-dwell-csv');
  delete require.cache[resolved];
  return require('../src/ipc/long-dwell-csv');
}

let ld = null;
function setup(flagOn) {
  if (ld) { try { ld.__test__.resetForTests(); } catch (_) {} }
  sup._resetForTests();
  _logs = [];
  buildLongDwellSources.mockClear();
  fetchBothSources.mockClear();
  _buildImpl = () => new Promise((r) => setTimeout(() => r({ wrRows: [], assetRows: [] }), 5 * SEC));
  _csvImpl = async () => ({ ok: false, error: 'fake' });
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.save('longDwellSchedule', { enabled: true, days: [new Date().getDay()], time: SCHED_TIME, aiFill: false });
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { longDwell: true } }, notify: vi.fn(), logger: _fakeLogger('workers') });
  }
  ld = loadLd();
  ld.__test__.resetForTests();
  return ld;
}

const effects = () => ({ build: buildLongDwellSources.mock.calls.length, csv: fetchBothSources.mock.calls.length, fireLogs: fireLogs() });

// Timeline: startScheduler() at 10:15:10, advance 3 min (30 s ticks; the
// 10:16:10 tick matches the schedule and awaits the 5 s fake fetch).
async function runScenario(flagOn) {
  const l = setup(flagOn);
  l.__test__.startScheduler();
  await adv(3 * MIN);
  return {
    effects: effects(),
    runs: flagOn ? rec().counts.runs : null,
    legacyArmed: l.__test__.legacyArmed(),
    owned: l.__test__.owned(),
    workers: sup.getStatus().workers,
  };
}

afterEach(() => {
  if (ld) { try { ld.__test__.resetForTests(); } catch (_) {} }
  ld = null;
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt longDwell — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const l = setup(false);
    l.__test__.startScheduler();
    expect(l.__test__.legacyArmed()).toBe(true);
    expect(l.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'longDwell')).toBeUndefined();
    await adv(70 * SEC);
    expect(fireLogs()).toBe(1);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const l = setup(true);
    l.__test__.startScheduler();
    expect(l.__test__.legacyArmed()).toBe(false);
    expect(l.__test__.owned()).toBe(true);
    l.__test__.startScheduler();          // re-entry guard: still one owner, one record
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('longDwell');
    expect(ws[0].group).toBe('analytics');
    expect(ws[0].intervalMs).toBe(30 * SEC);
    expect(ws[0].timeoutMs).toBe(20 * MIN);
    expect(ws[0].maxFailures).toBe(10);
    expect(ws[0].cooldownMs).toBe(10 * MIN);
    expect(ws[0].dependsOn).toEqual([]);
    expect(ws[0].nextRunAt).toBe(T0 + 30 * SEC);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runs).toBe(6);
    expect(r.effects.fireLogs).toBe(1);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ build: 1, csv: 1, fireLogs: 1 });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.build).toBe(off.effects.build);
    expect(on.effects.csv).toBe(off.effects.csv);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
  });
});

describe('workers adopt longDwell — extras', () => {
  it('supervised tick awaits the fetch', async () => {
    const l = setup(true);
    l.__test__.startScheduler();
    await adv(62 * SEC);                  // 10:16:12 — the matching tick is mid-fetch
    expect(rec().state).toBe('busy');
    expect(rec().currentJob).not.toBe(null);
    await adv(8 * SEC);                   // 10:16:20 — fetch (5 s) settled
    const w = rec();
    expect(w.currentJob).toBe(null);
    expect(w.lastDurationMs).toBeGreaterThanOrEqual(5000);
    expect(w.counts.ok).toBe(2);
    expect(w.counts.fail).toBe(0);
  });

  it('flag off: legacy ignores the returned promise, with no unhandled rejection', async () => {
    const seen = [];
    const onUnhandled = (e) => seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const l = setup(false);
      _buildImpl = () => Promise.reject(new Error('api down'));
      _csvImpl = () => Promise.reject(new Error('csv down'));
      l.__test__.startScheduler();
      await adv(70 * SEC);
      expect(fireLogs()).toBe(1);
      expect(_logs.filter((x) => x.level === 'warn' && x.msg.includes('[ld-schedule] fetch threw: csv down')).length).toBe(1);
      // A direct call returns the (resolving) fetch promise only on a matching minute.
      expect(l.__test__.scheduleTick()).toBe(undefined); // same minute → guarded
      await vi.advanceTimersByTimeAsync(0);
      vi.useRealTimers();
      await new Promise((r) => setImmediate(r)); // let Node flush its rejection tracking
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
