// tests/ai-gateway-call-sites.test.js — representative migrated Promise.race
// sites keep their timeout value, fallback and message (flag off AND on), the
// ai:ask low bypass, daily-tasks priority, askOrcha object form, and a static
// guard against raw AI Promise.race regressions.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-sites-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, installFakeFleetBrain, baseRelaySetup } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
const MODES = [['flag off', {}], ['flag on', { abortOnTimeout: true }]];
let calls;
beforeEach(() => { baseRelaySetup(relay); calls = installFakeFleetBrain(vi, fleetBrain); });
afterEach(async () => {
  vi.useRealTimers();
  for (let i = 0; i < 10; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
  T.setGatewayFlags(null);
  T.reset();
  vi.restoreAllMocks();
});

// A hanging injected AI: records its options; settles never (unless aborted -> stays pending, like a stuck lane).
function hanging() {
  const seen = [];
  const fn = vi.fn((p, o) => { seen.push(o || {}); return new Promise(() => {}); });
  fn.seen = seen;
  return fn;
}

describe.each(MODES)('repair-intel analyzeUnit (%s)', (_name, flags) => {
  it('injected relay with only ask/getStatus: real runWithTimeout -> pending after 55 s; source by force', async () => {
    T.setGatewayFlags(flags);
    const engine = require('../src/store/sqlite_engine');
    const store = require('../src/repair-intel/store');
    const analysis = require('../src/repair-intel/analysis');
    engine.close();
    store.upsertEvent(store.normalizeWorkOrder({ workRequestId: 'GW1', assetDisplayName: 'UNIT-GW', vendor: 'Acme', category: 'Unplanned Repair',
      status: { description: { value: 'COMPLETED' } }, suggestedItems: [{ level1: 'Brakes', level2: 'Pads' }], damageDescription: 'noise',
      reportedDateTime: new Date(Date.now() - 9 * 864e5).toISOString(), completedDateTime: new Date(Date.now() - 8 * 864e5).toISOString() }));
    const ask = hanging();
    const fake = { ask, getStatus: () => ({ model: 'm', backends: { orcha: true, claude: false } }) };
    vi.useFakeTimers();
    const p = analysis.analyzeUnit('UNIT-GW', { force: true, relay: fake });
    await vi.advanceTimersByTimeAsync(55000);
    expect(await p).toMatchObject({ ok: false, pending: true });
    expect(ask.seen[0].source).toBe('repair_intel_unit');
    if (flags.abortOnTimeout) expect(ask.seen[0].signal.aborted).toBe(true);
    else expect(ask.seen[0].signal).toBeUndefined();
    const p2 = analysis.analyzeUnit('UNIT-GW', { relay: fake, timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    await p2;
    expect(ask.seen[1].source).toBe('repair_intel_analysis');
    vi.useRealTimers();
    engine.close();
  });
});

describe.each(MODES)('orcha/reason (%s)', (_name, flags) => {
  it("{ _relay: hanging, timeoutMs } -> { ok:false, error:'reason-timeout' }", async () => {
    T.setGatewayFlags(flags);
    const { reason } = require('../src/orcha/reason');
    const ask = hanging();
    vi.useFakeTimers();
    const p = reason({ prompt: 'x', _relay: { ask }, timeoutMs: 1000, label: 'tasks' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ ok: false, error: 'reason-timeout' });
    expect(ask.seen[0].source).toBe('reason:tasks');
    if (flags.abortOnTimeout) expect(ask.seen[0].signal.aborted).toBe(true);
  });
});

describe.each(MODES)('pm_alert_reply.handleTaggedPmAlert (%s)', (_name, flags) => {
  it('hanging askOrcha -> fallback ack after 2 x 30 s', async () => {
    T.setGatewayFlags(flags);
    const pm = require('../src/scrapers/pm_alert_reply');
    const askOrcha = hanging();
    const sendToChannel = vi.fn(async () => ({ ts: '1.1' }));
    vi.useFakeTimers();
    const p = pm.handleTaggedPmAlert({ id: 'C1', name: 'pm' }, { ts: '1.0', text: '<@UME> *Asset ID:* 987654 Risk Score: 9' }, 'UME',
      { sendToChannel, askOrcha }, () => {});
    await vi.advanceTimersByTimeAsync(29999);
    expect(sendToChannel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + 1500 + 30000);
    const res = await p;
    expect(res.reply).toBe('Received — reviewing 987654 and will align accordingly.');
    expect(askOrcha.seen[0].source).toBe('pm_alert_reply');
    if (flags.abortOnTimeout) expect(askOrcha.seen.slice(0, 2).every((o) => o.signal.aborted)).toBe(true);
  });
});

describe.each(MODES)('slack_channel_watch gates (%s)', (_name, flags) => {
  it('chime-in and directed-at-me default to false after 20 s', async () => {
    T.setGatewayFlags(flags);
    const scw = require('../src/scrapers/slack_channel_watch');
    const askOrcha = hanging();
    vi.useFakeTimers();
    const a = scw.__test__.shouldChimeIn('hello', askOrcha);
    const b = scw.__test__.isDirectedAtMe('hello', 'Zila', askOrcha);
    await vi.advanceTimersByTimeAsync(20000);
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(askOrcha.seen.map((o) => o.source)).toEqual(['slack_chime_in_gate', 'slack_directed_gate']);
    expect(askOrcha.seen[0].task).toEqual({ taskType: 'classification' });
  });
});

describe('relay.askWithTimeout sites through the real relay', () => {
  it.each(MODES)('volvo-style reject message / misc-style resolve value (%s)', async (_n, flags) => {
    T.setGatewayFlags(flags);
    vi.useFakeTimers();
    const v = relay.askWithTimeout('ck82', { priority: 'high', source: 'volvo_ck82', timeoutMs: 60000, timeoutMessage: 'AI timeout' });
    v.catch(() => {});
    const m = relay.askWithTimeout('bd', { source: 'breakdown_analysis', timeoutMs: 20000, timeoutResult: '' });
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(await m).toBe('');
    await vi.advanceTimersByTimeAsync(40000);
    await expect(v).rejects.toThrow('AI timeout');
    expect(calls[0].opts.priority).toBe('high');
  });
});

describe('orcha_ws.askOrcha', () => {
  it('number form unchanged; object form forwards options and stops retrying on abort', async () => {
    const ows = require('../src/scrapers/orcha_ws');
    const spy = vi.spyOn(relay, 'ask').mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('two');
    vi.useFakeTimers();
    const p = ows.askOrcha('q');
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ ok: true, text: 'two' });
    expect(spy.mock.calls[0]).toEqual(['q']);
    spy.mockReset();
    const ac = new AbortController();
    spy.mockImplementation(async () => { ac.abort(); throw new Error('Aborted by caller'); });
    const r = await ows.askOrcha('q', { signal: ac.signal, source: 's', retries: 3 });
    expect(r).toEqual({ ok: false, error: 'Aborted' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ signal: ac.signal, source: 's' });
  });
});

describe('ai:ask low bypass (ipc/ai.js _dispatchAiAsk)', () => {
  const ai = require('../src/ipc/ai');
  async function scenario(gwPriorities, depsGw) {
    T.setGatewayFlags({ priorities: gwPriorities, reserveSlots: 2 });
    for (let i = 0; i < 3; i++) relay.ask('hold' + i).catch(() => {});
    await flush();
    const limiter = ai.__test__.createLimiter(1);
    const lowRun = () => relay.ask('LOW', { priority: 'low' });
    const highRun = vi.fn(() => relay.ask('HIGH', { priority: 'high' }));
    const deps = depsGw === undefined ? { limiter } : { limiter, gwPriorities: depsGw };
    ai.__test__.dispatchAiAsk(lowRun, 'low', deps).catch(() => {});
    await flush();
    ai.__test__.dispatchAiAsk(highRun, 'high', deps).catch(() => {});
    await flush();
    return { limiter, highRun };
  }
  it('priorities on: a reservation-blocked low never holds the limiter; high runs now', async () => {
    const { limiter, highRun } = await scenario(true, true);
    expect(relay.queueStats().byPriority.low.waiting).toBe(1);
    expect(highRun).toHaveBeenCalledTimes(1);
    expect(calls.map((c) => c.prompt)).toContain('HIGH');
    expect(limiter.stats().active).toBe(1);
  });
  it('priorities off: high waits behind the low in the limiter (today)', async () => {
    const { highRun } = await scenario(false, false);
    expect(highRun).not.toHaveBeenCalled();
    calls.filter((c) => c.prompt === 'LOW').forEach((c) => c.ok('low-done'));
    await flush();
    expect(highRun).toHaveBeenCalledTimes(1);
  });
  it('default deps read relay.queueStats().flags', async () => {
    const { highRun } = await scenario(true, undefined);
    expect(highRun).toHaveBeenCalledTimes(1);
  });
});

describe('daily tasks priority', () => {
  it("tasks:generate passes priority 'normal'; scheduled runs pass none (source reason:tasks)", async () => {
    const store = require('../src/store');
    store.save('fleetData', { rows: [{ equipmentId: '320160', lifecycleState: 'Unavailable', vendor: 'Acme', domicileSite: 'ABE40' }] });
    const spy = vi.spyOn(relay, 'ask').mockResolvedValue('{"actions":[]}');
    const dt = require('../src/ipc/daily-tasks');
    await dt.__test__.generate({ priority: 'normal' });
    expect(spy.mock.calls[0][1]).toMatchObject({ priority: 'normal', source: 'reason:tasks' });
    spy.mockClear();
    await dt.__test__.generate();
    expect(spy.mock.calls[0][1].priority).toBeUndefined();
    const src = fs.readFileSync(path.join(__dirname, '../src/ipc/daily-tasks.js'), 'utf8');
    const block = src.slice(src.indexOf("handle('tasks:generate'"), src.indexOf("handle('tasks:generate'") + 200);
    expect(block).toContain("_generate({ priority: 'normal' })");
  });
});

describe('static guard: no raw AI Promise.race left', () => {
  const SRC = path.join(__dirname, '../src');
  function walk(d, out = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }
  it('no Promise.race([relay.ask( | askOrcha( | deps.askOrcha( | ask( ...) outside the allow-list', () => {
    const re = /Promise\.race\(\s*\[\s*(?:relay\.ask|askOrcha|deps\.askOrcha|ask)\s*\(/;
    const allow = new Set([path.join(SRC, 'orcha', 'escalation-suggest.js')]);
    const bad = walk(SRC).filter((f) => !allow.has(f) && re.test(fs.readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
  it('per-file Promise.race( counts for every migrated file (pre-migration count minus migrated races)', () => {
    // Pre-migration counts: each file below had exactly the migrated races (§6.1).
    const expected = {
      'app.js': 0, 'rca/autofill.js': 0, 'repair-intel/analysis.js': 0, 'orcha/briefing.js': 0,
      'scrapers/carrier_briefing.js': 0, 'scrapers/dbr_pull.js': 0, 'vendors/volvo/api.js': 0,
      'scrapers/email_actions.js': 0, 'orcha/reason.js': 0, 'ipc/misc.js': 0, 'scrapers/slack_dm_autoreply.js': 0,
      'scrapers/slack_channel_watch.js': 0, 'scrapers/pm_alert_reply.js': 0, 'scrapers/ready_pickup_notify.js': 0, 'ipc/ai.js': 0,
    };
    for (const [rel, n] of Object.entries(expected)) {
      const txt = fs.readFileSync(path.join(SRC, rel), 'utf8');
      expect([rel, (txt.match(/Promise\.race\(/g) || []).length]).toEqual([rel, n]);
    }
  });
});
