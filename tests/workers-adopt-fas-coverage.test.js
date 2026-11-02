// tests/workers-adopt-fas-coverage.test.js
// Phase 5 adoption of the FAS coverage 6 h safety refresh (design §4.6, plan
// item 10, review fix 3). Exactly one owner in both modes; supervisor
// counts.runs cadence; flag-on effects deep-equal flag-off effects. Effects
// are the once-per-refresh 'coverage refresh (schedule)' lines and the
// persisted lastAttemptAt. Store harness from tests/fas-coverage.test.js
// (fresh temp data dir + fresh store/coverage per scenario). No Electron.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger recorder (fas-coverage namespace only) ─────────────────────────
let _logs = [];
function _fakeLogger(ns) {
  const rec = (level) => (...a) => { if (ns === 'fas-coverage') _logs.push({ level, msg: a.join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
}
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-11-03T14:00:00Z').getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'fasCoverage');
const scheduleLogs = () => _logs.filter((l) => l.msg.includes('coverage refresh (schedule)')).length;

let store = null;
let cov = null;
function setup(flagOn) {
  if (cov) { try { cov.stop(); } catch (_) {} }
  sup._resetForTests();
  _logs = [];
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'wk-adopt-fas-')));
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/orcha/fas/coverage')];
  store = require('../src/store');
  store.save('fleetData', {
    rows: [
      { equipmentId: '122269', operator: 'TUZR', domicileSite: 'ABE40', bodyType: 'Day Cab' },
      { equipmentId: '39461', operator: 'YTSC', domicileSite: 'AVP40', bodyType: 'Sleeper' },
    ],
    syncedAt: new Date().toISOString(),
  });
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { fasCoverage: true } }, notify: vi.fn(), logger: _fakeLogger('workers') });
  }
  cov = require('../src/orcha/fas/coverage');
  return cov;
}

const effects = () => ({ scheduleLogs: scheduleLogs(), lastAttemptAt: cov.get().lastAttemptAt, operators: cov.listOperators().sort() });

// Timeline: start() at T0, advance 12 h → schedule refreshes at 6 h and 12 h.
async function runScenario(flagOn) {
  const c = setup(flagOn);
  c.start();
  await adv(12 * HOUR);
  return {
    effects: effects(),
    runs: flagOn ? rec().counts.runs : null,
    legacyArmed: c.__test__.legacyArmed(),
    owned: c.__test__.owned(),
    workers: sup.getStatus().workers,
  };
}

afterEach(() => {
  if (cov) { try { cov.stop(); } catch (_) {} }
  cov = null;
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt fasCoverage — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const c = setup(false);
    c.start();
    expect(c.__test__.legacyArmed()).toBe(true);
    expect(c.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'fasCoverage')).toBeUndefined();
    await adv(6 * HOUR);
    expect(scheduleLogs()).toBe(1);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const c = setup(true);
    c.start();
    expect(c.__test__.legacyArmed()).toBe(false);
    expect(c.__test__.owned()).toBe(true);
    c.start();                            // repeat start: still one owner, one record
    expect(c.__test__.legacyArmed()).toBe(false);
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('fasCoverage');
    expect(ws[0].group).toBe('fas');
    expect(ws[0].intervalMs).toBe(6 * HOUR);
    expect(ws[0].timeoutMs).toBe(60 * SEC);
    expect(ws[0].maxFailures).toBe(3);
    expect(ws[0].cooldownMs).toBe(60 * MIN);
    expect(ws[0].dependsOn).toEqual([]);
    expect(ws[0].nextRunAt).toBe(T0 + 6 * HOUR);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runs).toBe(2);
    expect(rec().counts.ok).toBe(2);
    expect(r.effects.scheduleLogs).toBe(2);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ scheduleLogs: 2, lastAttemptAt: new Date(T0 + 12 * HOUR).toISOString(), operators: ['TUZR', 'YTSC'] });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.scheduleLogs).toBe(off.effects.scheduleLogs);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
  });
});

describe('workers adopt fasCoverage — extras', () => {
  it('startup refresh still synchronous in start()', () => {
    for (const flagOn of [false, true]) {
      const c = setup(flagOn);
      expect(c.get().lastAttemptAt).toBe(null);
      c.start();                          // no timer advanced
      expect(c.get().lastAttemptAt).toBe(new Date(T0).toISOString());
      expect(_logs.filter((l) => l.msg.includes('coverage refresh (startup)')).length).toBe(1);
      expect(c.__test__.owned()).toBe(flagOn);
      expect(c.__test__.legacyArmed()).toBe(!flagOn);
    }
  });

  it('stop() releases the owner in both modes (no timer, supervisor record stopped)', async () => {
    for (const flagOn of [false, true]) {
      const c = setup(flagOn);
      c.start();
      c.stop();
      expect(c.__test__.legacyArmed()).toBe(false);
      expect(c.__test__.owned()).toBe(false);
      await adv(12 * HOUR);
      expect(scheduleLogs()).toBe(0);
      if (flagOn) expect(rec().nextRunAt).toBe(null);
    }
  });
});
