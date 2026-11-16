// tests/fleet-trust-freshness-dom.test.js
// FEAT-002 / plan.md D7: toolbar fleet-data freshness chip. Pure logic
// (fleet-trust-logic.js) at the D2 thresholds, parity with the main-process
// src/health/fleet-freshness.js evaluate(), and the mount() wiring against
// fake DOM elements (no jsdom in this repo) with injected deps.
process.env.TZ = 'America/New_York';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';

vi.mock('../renderer/src/js/bridge.js', () => ({ fleet: {}, auth: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {} } }));

const L = await import('../renderer/src/js/components/fleet-trust-logic.js');
const { mount } = await import('../renderer/src/js/components/fleet-trust-indicator.js');
const require = createRequire(import.meta.url);
const ff = require('../src/health/fleet-freshness.js');
const { API_LOAD_MAX_AGE_MS } = require('../src/window/api-load-guard.js');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-16T15:00:00Z'); // 10:00 America/New_York
const H60 = 60 * MIN;

function snap(over = {}) {
  return {
    v: 1, at: NOW, intervalMs: H60,
    lastOkAt: null, lastOkCount: null, lastFailAt: null, lastFailCode: null, lastFailMessage: null,
    consecutiveFailures: 0, buildInFlight: false, buildStartedAt: null,
    supersededCount: 0, lastSupersededAt: null, aap: null,
    ...over,
  };
}
const view = (s, now = NOW) => L.deriveFreshness({ snapshot: s, evaluation: null }, { now });

describe('constants mirror the main process', () => {
  it('matches fleet-freshness.js / api-load-guard.js', () => {
    expect(L.INFLIGHT_AMBER_MS).toBe(ff.INFLIGHT_AMBER_MS);
    expect(L.INFLIGHT_RED_MS).toBe(API_LOAD_MAX_AGE_MS);
    expect(L.AMBER_AGE_FACTOR).toBe(ff.AMBER_AGE_FACTOR);
    expect(L.RED_AGE_FACTOR).toBe(ff.RED_AGE_FACTOR);
    expect(L.AAP_TIMEOUT_STREAK_RED).toBe(ff.AAP_TIMEOUT_STREAK_RED);
    expect(L.DEFAULT_INTERVAL_MS).toBe(ff.DEFAULT_INTERVAL_MS);
  });
});

describe('deriveFreshness at the D2 thresholds (60-min interval)', () => {
  it('30 min old -> green "as of HH:MM"', () => {
    const v = view(snap({ lastOkAt: NOW - 30 * MIN }));
    expect(v.level).toBe('green');
    expect(v.text).toBe('Fleet data as of 09:30 (30 min old)');
    expect(v.title).toContain('Click to refresh');
    expect(v.title).toContain('Refresh interval 60 min');
  });
  it('121 min old -> amber "may be stale"', () => {
    const v = view(snap({ lastOkAt: NOW - 121 * MIN }));
    expect(v.level).toBe('amber');
    expect(v.text).toBe('Fleet data may be stale (121 min old)');
  });
  it('181 min old -> red "STALE — last good HH:MM"', () => {
    const v = view(snap({ lastOkAt: NOW - 181 * MIN }));
    expect(v.level).toBe('red');
    expect(v.text).toBe('STALE — last good 06:59');
  });
  it('build in flight 6 min -> amber; 10 min -> red', () => {
    const a = view(snap({ lastOkAt: NOW - 10 * MIN, buildInFlight: true, buildStartedAt: NOW - 6 * MIN }));
    expect(a.level).toBe('amber');
    expect(a.title).toContain('build in flight 6 min');
    const r = view(snap({ lastOkAt: NOW - 10 * MIN, buildInFlight: true, buildStartedAt: NOW - 10 * MIN }));
    expect(r.level).toBe('red');
    expect(r.reasons).toContain('wedged');
  });
  it('superseded after the last ok -> red', () => {
    const v = view(snap({ lastOkAt: NOW - 20 * MIN, lastSupersededAt: NOW - 5 * MIN, supersededCount: 1 }));
    expect(v.level).toBe('red');
    expect(v.title).toContain('build superseded by watchdog');
  });
  it('3 consecutive AAP timeouts -> red', () => {
    const v = view(snap({ lastOkAt: NOW - 5 * MIN, aap: { timeouts: 3, consecutiveTimeouts: 3, lastTimeoutAt: NOW, lastOkAt: null } }));
    expect(v.level).toBe('red');
    expect(v.title).toContain('AAP calls timing out (3 in a row)');
  });
  it('red with no good refresh yet', () => {
    const v = view(snap({ lastOkAt: null, aap: { timeouts: 4, consecutiveTimeouts: 4 } }));
    expect(v.level).toBe('red');
    expect(v.text).toBe('STALE — no good refresh yet');
  });
  it('last failure appears in the title', () => {
    const v = view(snap({ lastOkAt: NOW - 30 * MIN, lastFailAt: NOW - 2 * MIN, lastFailCode: 'AAP_API_TIMEOUT' }));
    expect(v.level).toBe('green');
    expect(v.title).toContain('last refresh failed 09:58: AAP_API_TIMEOUT');
  });
  it('null / invalid payload -> grey without throwing', () => {
    for (const p of [null, undefined, {}, { snapshot: null }, 'x', 42]) {
      const v = L.deriveFreshness(p, { now: NOW });
      expect(v.level).toBe('grey');
      expect(v.text).toBe('Fleet data: waiting for first refresh');
    }
    expect(view(snap()).level).toBe('grey');
  });
  it('renderFreshnessHtml escapes the text', () => {
    const h = L.renderFreshnessHtml({ text: '<b>x</b>' });
    expect(h).toBe('<span class="tb-fresh__dot"></span><span class="tb-fresh__text">&lt;b&gt;x&lt;/b&gt;</span>');
  });
});

describe('parity with src/health/fleet-freshness.js evaluate()', () => {
  beforeEach(() => ff._resetForTests());

  const CASES = [
    { name: 'no success', ok: null },
    { name: 'fresh', ok: 10 },
    { name: 'aging 90', ok: 90 },
    { name: 'exactly 2x', ok: 120 },
    { name: 'age 121', ok: 121 },
    { name: 'exactly 3x', ok: 180 },
    { name: 'age 181', ok: 181 },
    { name: 'in flight 4', ok: 10, inflight: 4 },
    { name: 'in flight exactly 5', ok: 10, inflight: 5 },
    { name: 'in flight 6', ok: 10, inflight: 6 },
    { name: 'in flight 10', ok: 10, inflight: 10 },
    { name: 'in flight, no success', ok: null, inflight: 7 },
    { name: 'superseded after ok', ok: 20, sup: 5 },
    { name: 'superseded before ok', ok: 5, sup: 20 },
    { name: 'timeouts 2', ok: 5, streak: 2 },
    { name: 'timeouts 3', ok: 5, streak: 3 },
    { name: 'failed after ok', ok: 30, fail: 2 },
    { name: 'interval 5 min, age 16', ok: 16, interval: 5 * MIN },
  ];

  for (const c of CASES) {
    it(c.name, () => {
      const interval = c.interval || H60;
      ff.init({
        store: { load: () => null, save() {} },
        now: () => NOW,
        getIntervalMs: () => interval,
        getGuardSnapshot: () => (c.inflight != null ? { busy: true, startedAt: NOW - c.inflight * MIN } : { busy: false }),
        getAapStats: () => (c.streak != null ? { timeouts: c.streak, consecutiveTimeouts: c.streak, lastTimeoutAt: NOW, lastOkAt: null } : null),
      });
      if (c.sup != null) ff.recordSuperseded({ at: NOW - c.sup * MIN });
      if (c.ok != null) ff.recordBuildOk({ count: 100, at: NOW - c.ok * MIN });
      if (c.fail != null) ff.recordBuildFailed({ code: 'X', at: NOW - c.fail * MIN });
      const main = ff.evaluate(NOW);
      const s = ff.getSnapshot(NOW);
      const mine = L.levelFor(s, NOW);
      expect(mine.level).toBe(main.level);
      expect(mine.reasons).toEqual(main.reasons);
      expect(L.deriveFreshness({ snapshot: s, evaluation: main }, { now: NOW }).level).toBe(main.level);
    });
  }
});

// ── mount() with fake elements ─────────────────────────────────────────────
function el() {
  return {
    className: '', innerHTML: '', title: '', disabled: false, hidden: false, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, target) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: target || this }))); },
  };
}
function fakeBus() {
  const h = {};
  return {
    h,
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return () => { h[ev] = h[ev].filter((x) => x !== fn); }; },
    fire(ev, p) { (h[ev] || []).forEach((f) => f(p)); },
  };
}
function deps(over = {}) {
  const b = fakeBus();
  return {
    bus: b,
    getFreshness: vi.fn(async () => ({ ok: true, snapshot: snap({ lastOkAt: NOW - 30 * MIN }), evaluation: null })),
    forceSync: vi.fn(async () => {}),
    statusGet: vi.fn(async () => ({ ok: true, enabled: false, status: null })),
    healthGet: vi.fn(async () => ({ ok: true, state: 'HEALTHY', snapshot: null })),
    healthRunMwinit: vi.fn(async () => ({ ok: true, verified: true })),
    on: b.on, emit: vi.fn(),
    now: () => NOW,
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    ...over,
  };
}

describe('mount() freshness chip', () => {
  it('renders green from the pull and updates from the fleet:freshness push', async () => {
    const fresh = el();
    const d = deps();
    const m = mount({ fresh, auth: null, banner: null }, d);
    expect(fresh.className).toBe('tb-fresh tb-fresh--grey');
    await m.ready;
    expect(fresh.className).toBe('tb-fresh tb-fresh--green');
    expect(fresh.innerHTML).toContain('Fleet data as of 09:30 (30 min old)');
    d.bus.fire('fleet:freshness', { snapshot: snap({ lastOkAt: NOW - 181 * MIN }), evaluation: null });
    expect(fresh.className).toBe('tb-fresh tb-fresh--red');
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function), 30000);
    expect(d.setInterval).toHaveBeenCalledWith(expect.any(Function), 60000);
    m.destroy();
  });

  it('a rejected pull renders grey without throwing', async () => {
    const fresh = el();
    const m = mount({ fresh }, deps({ getFreshness: vi.fn(async () => { throw new Error('boom'); }), statusGet: vi.fn(async () => { throw new Error('x'); }) }));
    await m.ready;
    expect(fresh.className).toBe('tb-fresh tb-fresh--grey');
    expect(fresh.innerHTML).toContain('waiting for first refresh');
  });

  it('NOT_APP_UI pull renders grey', async () => {
    const fresh = el();
    const m = mount({ fresh }, deps({ getFreshness: vi.fn(async () => ({ ok: false, code: 'NOT_APP_UI' })) }));
    await m.ready;
    expect(fresh.className).toBe('tb-fresh tb-fresh--grey');
  });

  it('click calls forceSync once and keeps the chip disabled until it settles', async () => {
    const fresh = el();
    let release;
    const d = deps({ forceSync: vi.fn(() => new Promise((r) => { release = r; })) });
    const m = mount({ fresh }, d);
    await m.ready;
    const p1 = fresh.fire('click');
    const p2 = fresh.fire('click'); // second click while busy is ignored
    expect(d.forceSync).toHaveBeenCalledTimes(1);
    expect(fresh.disabled).toBe(true);
    expect(d.emit).toHaveBeenCalledWith('ui:toast', expect.objectContaining({ type: 'info', message: 'Refreshing fleet data…' }));
    const pulls = d.getFreshness.mock.calls.length;
    release();
    await Promise.all([p1, p2]);
    expect(fresh.disabled).toBe(false);
    expect(d.getFreshness.mock.calls.length).toBe(pulls + 1);
    expect(d.forceSync).toHaveBeenCalledTimes(1);
  });

  it('a failing forceSync toasts an error and re-enables the chip', async () => {
    const fresh = el();
    const d = deps({ forceSync: vi.fn(async () => { throw new Error('nope'); }) });
    const m = mount({ fresh }, d);
    await m.ready;
    await fresh.fire('click');
    expect(fresh.disabled).toBe(false);
    expect(d.emit).toHaveBeenCalledWith('ui:toast', expect.objectContaining({ type: 'error', message: 'Refresh failed: nope' }));
  });

  it('state:fleet refetches freshness; destroy unsubscribes', async () => {
    const fresh = el();
    const d = deps();
    const m = mount({ fresh }, d);
    await m.ready;
    const n = d.getFreshness.mock.calls.length;
    d.bus.fire('state:fleet', { rows: [] });
    expect(d.getFreshness.mock.calls.length).toBe(n + 1);
    m.destroy();
    d.bus.fire('state:fleet', { rows: [] });
    expect(d.getFreshness.mock.calls.length).toBe(n + 1);
    expect(d.clearInterval).toHaveBeenCalledTimes(2);
  });
});
