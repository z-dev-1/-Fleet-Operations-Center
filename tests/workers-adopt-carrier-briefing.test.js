// tests/workers-adopt-carrier-briefing.test.js
// Phase 5 adoption of the daily carrier-briefing scheduler (design §4.3, plan
// item 7, review fix 3). Exactly one owner in both modes; supervisor
// counts.runs cadence; flag-on effects deep-equal flag-off effects. Effects:
// getOperatorChannels calls, the once-per-fire "scheduled run for <day>" line
// and carrierBriefingLog.lastRunDay — never per-tick lines. Real store in a
// temp dir; pm_alert_reply and slack_send are require.cache fakes (the real
// slack_send.js is untouched). No Electron, no Slack, no AI.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const tmpDir = path.join(os.tmpdir(), 'wk-adopt-cb-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

function injectFakeModule(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

// ── Logger recorder (carrier_briefing namespace only) ─────────────────────
let _logs = [];
function _fakeLogger(ns) {
  const rec = (level) => (...a) => { if (ns === 'carrier_briefing') _logs.push({ level, msg: a.join(' ') }); };
  return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
}
_fakeLogger.createLogger = _fakeLogger;
_fakeLogger.setLogDir = () => {};
_fakeLogger.setLevel = () => {};
_fakeLogger.setSilent = () => {};
_fakeLogger.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
injectFakeModule('../src/utils/logger', _fakeLogger);

// ── Operator channels + Slack send (fakes only) ──────────────────────────
const getOperatorChannels = vi.fn(() => ({ operators: [] }));
injectFakeModule('../src/scrapers/pm_alert_reply', { getOperatorChannels: (...a) => getOperatorChannels(...a), resolveOperatorEntry: () => null });
const slackSend = { sendToChannel: vi.fn(), openConversation: vi.fn(), checkLiveAuth: vi.fn() };
injectFakeModule('../src/scrapers/slack_send', slackSend);

const store = require('../src/store');
const sup = require('../src/workers/supervisor');

const T0 = new Date('2026-11-03T11:58:30Z').getTime(); // 06:58:30 America/New_York (EST)
const MIN = 60 * 1000;
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'carrierBriefing');
const fireLogs = () => _logs.filter((l) => l.msg.includes('[CarrierBriefing] scheduled run for 2026-11-03')).length;
const lastRunDay = () => { const l = store.load('carrierBriefingLog', null); return l ? l.lastRunDay || null : null; };

function loadCb() {
  const resolved = require.resolve('../src/scrapers/carrier_briefing');
  delete require.cache[resolved];
  return require('../src/scrapers/carrier_briefing');
}

let cb = null;
function setup(flagOn) {
  if (cb) { try { cb.stopScheduler(); } catch (_) {} }
  sup._resetForTests();
  _logs = [];
  getOperatorChannels.mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store.save('carrierBriefingConfig', { enabled: true, sendTime: '07:00', timezone: 'America/New_York' });
  store.save('carrierBriefingLog', { sent: {}, lastRunAt: null, recentTips: [] });
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { carrierBriefing: true } }, notify: vi.fn(), logger: _fakeLogger('workers') });
  }
  cb = loadCb();
  return cb;
}

const effects = () => ({ getOperatorChannels: getOperatorChannels.mock.calls.length, fireLogs: fireLogs(), lastRunDay: lastRunDay() });

// Timeline: startScheduler() at 06:58:30 ET, advance 5 min (ticks at
// 06:59:30, 07:00:30, 07:01:30, 07:02:30, 07:03:30; only 07:00 matches).
async function runScenario(flagOn) {
  const c = setup(flagOn);
  c.startScheduler();
  await adv(5 * MIN);
  return {
    effects: effects(),
    runs: flagOn ? rec().counts.runs : null,
    legacyArmed: c.__test__.legacyArmed(),
    owned: c.__test__.owned(),
    workers: sup.getStatus().workers,
  };
}

afterEach(() => {
  if (cb) { try { cb.stopScheduler(); } catch (_) {} }
  cb = null;
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt carrierBriefing — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    const c = setup(false);
    c.startScheduler();
    expect(c.__test__.legacyArmed()).toBe(true);
    expect(c.__test__.owned()).toBe(false);
    expect(sup.getStatus().workers.find((w) => w.name === 'carrierBriefing')).toBeUndefined();
    await adv(2 * MIN);
    expect(getOperatorChannels).toHaveBeenCalledTimes(1);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    const c = setup(true);
    c.startScheduler();
    expect(c.__test__.legacyArmed()).toBe(false);
    expect(c.__test__.owned()).toBe(true);
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('carrierBriefing');
    expect(ws[0].group).toBe('comms');
    expect(ws[0].intervalMs).toBe(60 * 1000);
    expect(ws[0].timeoutMs).toBe(30 * MIN);
    expect(ws[0].maxFailures).toBe(10);
    expect(ws[0].cooldownMs).toBe(10 * MIN);
    expect(ws[0].dependsOn).toEqual([]);
    expect(ws[0].nextRunAt).toBe(T0 + MIN);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runs).toBe(5);
    expect(r.effects.getOperatorChannels).toBe(1);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ getOperatorChannels: 1, fireLogs: 1, lastRunDay: '2026-11-03' });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.getOperatorChannels).toBe(off.effects.getOperatorChannels);
    expect(on.effects.fireLogs).toBe(off.effects.fireLogs);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
    expect(slackSend.sendToChannel).not.toHaveBeenCalled();
  });
});

describe('workers adopt carrierBriefing — extras', () => {
  async function restartScenario(flagOn) {
    const c = setup(flagOn);
    c.startScheduler();
    await adv(130 * 1000);                 // 07:00:40 ET, after the 07:00:30 fire
    expect(getOperatorChannels).toHaveBeenCalledTimes(1);
    c.stopScheduler(); c.startScheduler();
    await adv(2 * MIN);
    return { effects: effects(), workers: sup.getStatus().workers.length, legacyArmed: c.__test__.legacyArmed(), owned: c.__test__.owned() };
  }

  it('restart inside the matching minute does not fire twice', async () => {
    const off = await restartScenario(false);
    const on = await restartScenario(true);
    expect(off.effects).toEqual({ getOperatorChannels: 1, fireLogs: 1, lastRunDay: '2026-11-03' });
    expect(on.effects).toEqual(off.effects);
    expect(on.workers).toBe(1);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(off.workers).toBe(0);
    expect(off.legacyArmed).toBe(true);
  });
});
