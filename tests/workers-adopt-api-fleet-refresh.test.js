// tests/workers-adopt-api-fleet-refresh.test.js
// Phase 5 adoption of the recurring API fleet refresh (design §4.7, plan
// item 11, review fix 3). src/window/index.js cannot be loaded in a unit test
// (top-level electron + closure state), so the ownership decision is the pure
// helper src/workers/api-refresh-arm.js, tested here with a real supervisor,
// the faked global setInterval and a load() spy. Effect = load() calls (the
// _loadFleetViaApiStartup('refresh') stand-in), never per-tick log lines.
// A static source check pins window/index.js to the helper as its only arm site.
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const sup = require('../src/workers/supervisor');
const { armApiRefresh } = require('../src/workers/api-refresh-arm');

const T0 = new Date('2026-11-03T14:00:00Z').getTime();
const SEC = 1000;
const MIN = 60 * SEC;
const INTERVAL = 5 * MIN; // RESCAN_INTERVAL_MS
const adv = (ms) => vi.advanceTimersByTimeAsync(ms);
const rec = () => sup.getStatus().workers.find((w) => w.name === 'apiFleetRefresh');
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function mkLogger() {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), debug() {}, error() {} };
}

function setup(flagOn) {
  sup._resetForTests();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  if (flagOn) {
    sup.init({ flags: { supervisorEnabled: true, supervised: { apiFleetRefresh: true } }, notify: vi.fn(), logger: silent });
  }
}

function arm(over = {}) {
  const load = over.load || vi.fn(() => Promise.resolve(undefined));
  const logger = over.logger || mkLogger();
  const r = armApiRefresh({
    alreadyArmed: false,
    claim: (spec) => sup.claim(spec),
    setIntervalFn: setInterval,
    load,
    intervalMs: INTERVAL,
    logger,
    ...over,
  });
  return { r, load, logger };
}

// Timeline: arm at T0, advance 15 min → loads at 5, 10 and 15 min.
async function runScenario(flagOn) {
  setup(flagOn);
  const { r, load } = arm();
  await adv(15 * MIN);
  return {
    effects: { loads: load.mock.calls.length, args: load.mock.calls.map((c) => c.length) },
    runs: flagOn ? rec().counts.runs : null,
    legacyArmed: !!r.timer,
    owned: r.owned,
    workers: sup.getStatus().workers,
  };
}

afterEach(() => {
  vi.clearAllTimers();
  sup._resetForTests();
  vi.useRealTimers();
});

describe('workers adopt apiFleetRefresh — [FIX 3] ownership, cadence, parity', () => {
  it('flag off: legacy owns (legacyArmed true, no supervisor record)', async () => {
    setup(false);
    const { r, load } = arm();
    expect(r.owned).toBe(false);
    expect(r.timer).toBeTruthy();
    expect(sup.getStatus().workers.find((w) => w.name === 'apiFleetRefresh')).toBeUndefined();
    await adv(INTERVAL);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('flag on: supervisor owns (legacyArmed false, one record, verbatim intervalMs/timeoutMs)', () => {
    setup(true);
    const { r } = arm();
    expect(r).toEqual({ owned: true, timer: null });
    const ws = sup.getStatus().workers;
    expect(ws.length).toBe(1);
    expect(ws[0].name).toBe('apiFleetRefresh');
    expect(ws[0].group).toBe('fleet');
    expect(ws[0].intervalMs).toBe(INTERVAL);
    expect(ws[0].timeoutMs).toBe(15 * MIN);
    expect(ws[0].maxFailures).toBe(3);
    expect(ws[0].cooldownMs).toBe(30 * MIN);
    expect(ws[0].dependsOn).toEqual([]);
    expect(ws[0].nextRunAt).toBe(T0 + INTERVAL);
  });

  it('cadence: counts.runs === N over N intervals', async () => {
    const r = await runScenario(true);
    expect(r.runs).toBe(3);
    expect(r.effects.loads).toBe(3);
  });

  it('effect parity: flag-on effects deep-equal flag-off effects', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(off.effects).toEqual({ loads: 3, args: [0, 0, 0] });
    expect(on.effects).toEqual(off.effects);
  });

  it('no double execution: flag-on effect count equals legacy, never 2×', async () => {
    const off = await runScenario(false);
    const on = await runScenario(true);
    expect(on.effects.loads).toBe(off.effects.loads);
    expect(on.legacyArmed).toBe(false);
    expect(on.owned).toBe(true);
    expect(on.workers.length).toBe(1);
    expect(off.legacyArmed).toBe(true);
    expect(off.workers.length).toBe(0);
  });
});

describe('workers adopt apiFleetRefresh — helper', () => {
  it('off: setIntervalFn called once with 300000 and the legacy line logged', () => {
    setup(false);
    const setIntervalFn = vi.fn(() => 'H');
    const { r, logger } = arm({ setIntervalFn });
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(setIntervalFn.mock.calls[0][1]).toBe(300000);
    expect(r).toEqual({ owned: false, timer: 'H' });
    expect(logger.lines).toEqual(['[data-source] API mode \u2014 scheduling recurring API refresh (no scrape rescan)']);
  });

  it('on: { owned:true, timer:null }, intervalMs 300000, timeoutMs 900000', () => {
    setup(true);
    const setIntervalFn = vi.fn();
    const { r, logger } = arm({ setIntervalFn });
    expect(r).toEqual({ owned: true, timer: null });
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(rec().intervalMs).toBe(300000);
    expect(rec().timeoutMs).toBe(900000);
    expect(logger.lines).toEqual(['[data-source] API mode \u2014 recurring API refresh supervised']);
  });

  it('alreadyArmed → "already scheduled" line, no claim, no timer', () => {
    setup(true);
    const claim = vi.fn(() => true);
    const setIntervalFn = vi.fn();
    const { r, logger } = arm({ alreadyArmed: true, claim, setIntervalFn });
    expect(r).toEqual({ owned: false, timer: null });
    expect(claim).not.toHaveBeenCalled();
    expect(setIntervalFn).not.toHaveBeenCalled();
    expect(logger.lines).toEqual(['[data-source] API refresh already scheduled \u2014 not double-scheduling']);
  });

  it('claim throws → legacy timer', async () => {
    setup(true);
    const { r, load } = arm({ claim: () => { throw new Error('boom'); } });
    expect(r.owned).toBe(false);
    expect(r.timer).toBeTruthy();
    expect(sup.getStatus().workers.length).toBe(0);
    await adv(INTERVAL);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('coalesce-shape load (resolves undefined) counts ok', async () => {
    setup(true);
    arm({ load: vi.fn(() => Promise.resolve(undefined)) });
    await adv(2 * INTERVAL);
    const w = rec();
    expect(w.counts.runs).toBe(2);
    expect(w.counts.ok).toBe(2);
    expect(w.counts.fail).toBe(0);
    expect(w.counts.skip).toBe(0);
  });

  it("static: src/window/index.js contains armApiRefresh( exactly once and no longer contains setInterval(() => { _loadFleetViaApiStartup('refresh'); }", () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/window/index.js'), 'utf8');
    expect(src.split('armApiRefresh(').length - 1).toBe(1);
    expect(src.includes("setInterval(() => { _loadFleetViaApiStartup('refresh'); }")).toBe(false);
    expect(src.includes('let _apiRefreshOwned = false;') || /let _apiRefreshOwned\s+= false;/.test(src)).toBe(true);
  });
});
