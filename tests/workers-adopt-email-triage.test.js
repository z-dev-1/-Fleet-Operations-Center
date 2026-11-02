// tests/workers-adopt-email-triage.test.js
// Phase 5 adoption of the OWA email-triage auto-scan loop (design §4.2, plan
// item 6, review fix 3). Exactly one owner in both modes; supervisor
// counts.runs cadence; flag-on effects (fake reader calls) deep-equal flag-off
// effects. Never asserts per-tick log lines. Harness copied from
// tests/email-triage-autoscan-guard.test.js: real store in a temp dir, fakes in
// require.cache for the comms mode source, leader gate, telemetry, OWA reader,
// AI core, offline authority and logger. No Electron, no OWA, no network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'wk-adopt-et-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger (silent) ───────────────────────────────────────────────────────
function _fakeLogger() { return { debug() {}, info() {}, warn() {}, error() {}, log() {} }; }
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── Mode source (Slack poller) ────────────────────────────────────────────
let _mode = 'off';
injectFakeModule('../src/slack/poller', { getMode: () => _mode });

// ── Leader gate ───────────────────────────────────────────────────────────
let _gate = true;
injectFakeModule('../src/cluster', { mayRunProduction: () => _gate, mayLivePull: () => true });

// ── Telemetry track spy (same contract as the real track) ────────────────
let _tracks = [];
injectFakeModule('../src/telemetry', {
  track: (name, fn, opts) => {
    _tracks.push(name);
    return Promise.resolve().then(fn);
  },
});

// ── Offline authority (supervisor dependency 'offline') ──────────────────
injectFakeModule('../src/orcha/offline', { isOffline: () => false });

// ── AI core + OWA reader ─────────────────────────────────────────────────
injectFakeModule('../src/orcha/reason', { reason: async () => ({ ok: false }) });
let _readerCalls = 0;
injectFakeModule('../src/scrapers/owa_reader', { readInbox: async () => { _readerCalls++; return { emails: [] }; } });

const store = require('../src/store');
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-11-03T14:00:00Z').getTime();
const MIN = 60 * 1000;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'emailTriage');

function loadTriage() {
  const resolved = require.resolve('../src/scrapers/email_triage');
  delete require.cache[resolved];
  return require('../src/scrapers/email_triage');
}

let triage = null;
function setup(flagOn) {
  if (triage) { try { triage.stopAutoScan(); } catch (_) {} }
  sup._resetForTests();
  _tracks = []; _readerCalls = 0; _mode = 'off'; _gate = true;
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.save('emailTriageConfig', { enabled: true, autoScan: true, autoScanMinutes: 30, folders: ['Inbox'] });
  store.save('emailTriageResults', { emails: [] });
  store.save('fleetData', { rows: [] });
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { emailTriage: true } }, notify: vi.fn(), logger: _fakeLogger() });
  }
  triage = loadTriage();
  return triage;
}

// Timeline: startAutoScan() at T0 with a 30 min cadence, advance 95 min
// (30, 60, 90).
async function runScenario(flagOn) {
  const t = setup(flagOn);
  t.startAutoScan();
  await adv(95 * MIN);
  return {
    effects: { readInbox: _readerCalls, tracks: _tracks.slice() },
    runs: flagOn ? rec().counts.runs : null,
    legacyArmed: t.__test__.legacyArmed(),
    owned: t.__test__.owned(),
    workers: sup.getStatus().workers,
  };
}

beforeEach(() => { triage = null; });
afterEach(() => {
  if (triage) { try { triage.stopAutoScan(); } catch (_) {} }
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt emailTriage — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const t = setup(false);
    t.startAutoScan();
    expect(t.__test__.legacyArmed()).toBe(true);
    expect(t.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'emailTriage')).toBeUndefined();
    await adv(30 * MIN);
    expect(_readerCalls).toBe(1);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const t = setup(true);
    t.startAutoScan();
    expect(t.__test__.legacyArmed()).toBe(false);
    expect(t.__test__.owned()).toBe(true);
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('emailTriage');
    expect(ws[0].group).toBe('comms');
    expect(ws[0].intervalMs).toBe(30 * MIN);
    expect(ws[0].timeoutMs).toBe(30 * MIN);
    expect(ws[0].maxFailures).toBe(3);
    expect(ws[0].cooldownMs).toBe(60 * MIN);
    expect(ws[0].dependsOn).toEqual(['offline']);
    expect(ws[0].nextRunAt).toBe(T0 + 30 * MIN);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runs).toBe(3);
    expect(r.effects.readInbox).toBe(3);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ readInbox: 3, tracks: [] });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.readInbox).toBe(off.effects.readInbox);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
  });
});

describe('workers adopt emailTriage — extras', () => {
  it('getAutoScanStatus.armedMinutes and nextRunAt mirror the supervisor worker', async () => {
    const t = setup(true);
    t.startAutoScan();
    let s = t.getAutoScanStatus();
    expect(s.armedMinutes).toBe(30);
    expect(s.armedAt).toBe(T0);
    expect(s.nextRunAt).toBe(rec().nextRunAt);
    expect(s.nextRunAt).toBe(T0 + 30 * MIN);
    await adv(31 * MIN);
    s = t.getAutoScanStatus();
    expect(s.nextRunAt).toBe(rec().nextRunAt);
    expect(s.nextRunAt).toBe(T0 + 60 * MIN);
    t.stopAutoScan();
    s = t.getAutoScanStatus();
    expect(s.armedMinutes).toBe(null);
    expect(s.nextRunAt).toBe(null);
  });

  it('nextRunAt falls back to the grid formula when the supervisor lookup throws', async () => {
    const t = setup(true);
    t.startAutoScan();
    await adv(10 * MIN);
    const spy = vi.spyOn(sup, 'getStatus').mockImplementation(() => { throw new Error('boom'); });
    try {
      const s = t.getAutoScanStatus();
      expect(s.armedMinutes).toBe(30);
      expect(s.nextRunAt).toBe(T0 + 30 * MIN);
    } finally { spy.mockRestore(); }
  });

  it('_rearmAutoScan unchanged cadence does not re-anchor; changed cadence resumes with the new interval', async () => {
    const t = setup(true);
    t.saveConfig({ autoScanMinutes: 30 });             // first arm via _rearmAutoScan
    expect(rec().nextRunAt).toBe(T0 + 30 * MIN);
    await adv(10 * MIN);
    t.saveConfig({ autoScanMinutes: 30 });             // unchanged → no re-anchor
    expect(rec().nextRunAt).toBe(T0 + 30 * MIN);
    expect(t.getAutoScanStatus().armedAt).toBe(T0);
    t.saveConfig({ autoScanMinutes: 45 });             // changed → stop + claim → resume
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].intervalMs).toBe(45 * MIN);
    expect(ws[0].nextRunAt).toBe(T0 + 55 * MIN);
    expect(t.__test__.legacyArmed()).toBe(false);
    expect(t.__test__.owned()).toBe(true);
    expect(t.getAutoScanStatus().armedMinutes).toBe(45);
    await adv(45 * MIN);
    expect(_readerCalls).toBe(1);
    expect(rec().counts.runs).toBe(1);
  });

  it('comms mode on: owa.triageAutoScan still tracked and standby skip counted under the supervisor', async () => {
    const t = setup(true);
    _mode = 'on';
    t.startAutoScan();
    await adv(30 * MIN);
    expect(_tracks).toEqual(['owa.triageAutoScan']);
    expect(_readerCalls).toBe(1);
    _gate = false;
    await adv(30 * MIN);
    expect(_tracks).toEqual(['owa.triageAutoScan']);
    expect(_readerCalls).toBe(1);
    const s = t.getAutoScanStatus();
    expect(s.skipped.standby).toBe(1);
    expect(s.lastGate).toBe(false);
    expect(rec().counts.runs).toBe(2);
  });
});
