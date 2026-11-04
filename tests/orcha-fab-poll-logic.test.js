// tests/orcha-fab-poll-logic.test.js
//
// FEATURE (2026-11-01, Phase 4): pure logic behind orcha-fab.js's renderer
// Slack poll timers (renderer/src/js/components/orcha-fab-poll-logic.js).
// No DOM / no bridge / no Electron — orcha-fab.js injects everything, so the
// mode loader, mode-change plan and DM-notify starter are exercised directly.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  POLL_MODES, normalizePollMode, rendererPollPlan, shouldArm, shouldCheckAuth,
  reducePollResult, applySteps, createPollModeLoader, planModeChange, createDmNotifyStarter,
} from '../renderer/src/js/components/orcha-fab-poll-logic.js';

const KINDS = ['dmNotify', 'channelWatch', 'dmAutoReply'];

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('normalizePollMode', () => {
  it('accepts the three modes, trimmed and case-insensitive', () => {
    expect(POLL_MODES).toEqual(['off', 'shadow', 'on']);
    expect(normalizePollMode('on')).toBe('on');
    expect(normalizePollMode(' SHADOW ')).toBe('shadow');
    expect(normalizePollMode('Off')).toBe('off');
  });
  it('maps anything else to off', () => {
    for (const v of [null, undefined, '', 'garbage', 1, true, {}, []]) expect(normalizePollMode(v)).toBe('off');
  });
});

describe('rendererPollPlan', () => {
  it('off/shadow → all true; on → all false', () => {
    expect(rendererPollPlan('off')).toEqual({ dmNotify: true, channelWatch: true, dmAutoReply: true });
    expect(rendererPollPlan('shadow')).toEqual({ dmNotify: true, channelWatch: true, dmAutoReply: true });
    expect(rendererPollPlan('on')).toEqual({ dmNotify: false, channelWatch: false, dmAutoReply: false });
    expect(rendererPollPlan('garbage')).toEqual({ dmNotify: true, channelWatch: true, dmAutoReply: true });
  });
});

describe('shouldArm', () => {
  it('throws when the mode is not loaded, for every kind', () => {
    for (const k of KINDS) {
      expect(() => shouldArm(k, null, false)).toThrow(/not loaded/);
      expect(() => shouldArm(k, undefined, true)).toThrow(/not loaded/);
    }
  });
  it("'on' → false for every kind and both timerExists values", () => {
    for (const k of KINDS) for (const t of [true, false]) expect(shouldArm(k, 'on', t)).toBe(false);
  });
  it('off/shadow/garbage: channelWatch/dmAutoReply → !timerExists; dmNotify → always true', () => {
    for (const m of ['off', 'shadow', 'garbage']) {
      for (const t of [true, false]) {
        expect(shouldArm('channelWatch', m, t)).toBe(!t);
        expect(shouldArm('dmAutoReply', m, t)).toBe(!t);
        expect(shouldArm('dmNotify', m, t)).toBe(true);
      }
    }
  });
});

describe('shouldCheckAuth', () => {
  it('off/shadow → always true; on → only when not already checked', () => {
    for (const m of ['off', 'shadow']) for (const c of [true, false]) expect(shouldCheckAuth(m, c)).toBe(true);
    expect(shouldCheckAuth('on', false)).toBe(true);
    expect(shouldCheckAuth('on', true)).toBe(false);
  });
});

describe('boot race (composed helpers)', () => {
  it("panel-open before boot with a deferred getPollerStatus resolving 'on' never arms", async () => {
    const d = deferred();
    const loader = createPollModeLoader(() => d.promise);
    const armed = [];
    const start = async (kind) => { await loader.load(); if (shouldArm(kind, loader.current(), false)) armed.push(kind); };
    const calls = [start('dmNotify'), start('dmNotify'), start('channelWatch'), start('dmAutoReply')];
    await flush();
    expect(armed).toEqual([]);
    d.resolve({ mode: 'on' });
    await Promise.all(calls);
    expect(armed).toEqual([]);
  });
});

describe('reducePollResult / applySteps', () => {
  it('DM ordering and string-compare dedupe, one step per shown message', () => {
    const dms = [{ ts: '100.1', text: 'a' }, { ts: '100.0', text: 'old' }, { ts: '101.0', text: 'b' }, { ts: '101.0', text: 'dup' }];
    const { steps } = reducePollResult('dmNotify', dms, '099.9');
    expect(steps.map(s => s.lastDmTs)).toEqual(['100.1', '101.0']);
    expect(steps[0].effects).toEqual([
      { type: 'appendDM', msg: dms[0] },
      { type: 'notif', icon: '\u{1F4E9}', title: 'Slack DM', body: 'a' },
    ]);
    expect(reducePollResult('dmNotify', dms, null).steps.map(s => s.lastDmTs)).toEqual(['100.1', '101.0']);
    expect(reducePollResult('dmNotify', [], null).steps).toEqual([]);
    expect(reducePollResult('dmNotify', null, null).steps).toEqual([]);
  });

  it('throw parity: apply throws on the second appendDM → commit ts1, ts2 only; rest not applied; throw propagates', () => {
    const dms = [{ ts: '1', text: 'x' }, { ts: '2', text: 'y' }, { ts: '3', text: 'z' }];
    const { steps } = reducePollResult('dmNotify', dms, null);
    const commits = [];
    const applied = [];
    let appends = 0;
    const apply = (ef) => {
      if (ef.type === 'appendDM' && ++appends === 2) throw new Error('boom');
      applied.push(ef.type + ':' + (ef.msg ? ef.msg.ts : ef.body));
    };
    expect(() => applySteps(steps, ts => commits.push(ts), apply)).toThrow('boom');
    expect(commits).toEqual(['1', '2']);
    expect(applied).toEqual(['appendDM:1', 'notif:x']);
  });

  it('escalation results produce one step with lastDmTs undefined; commit never called', () => {
    for (const kind of ['channelWatch', 'dmAutoReply']) {
      const { steps } = reducePollResult(kind, { escalatedCount: 2, items: [{ title: 'T' }] }, '5');
      expect(steps).toHaveLength(1);
      expect(steps[0].lastDmTs).toBeUndefined();
      const commit = vi.fn();
      const apply = vi.fn();
      applySteps(steps, commit, apply);
      expect(commit).not.toHaveBeenCalled();
      expect(apply).toHaveBeenCalledTimes(3);
    }
  });

  it('exact titles, icons and bodies for partner and DM escalations', () => {
    expect(reducePollResult('channelWatch', { escalatedCount: 3, items: [{ title: 'Unit 12' }] }, null).steps[0].effects).toEqual([
      { type: 'notif', icon: '\u{1F6A8}', title: 'Partner AI: 3 item(s) need review', body: 'Unit 12' },
      { type: 'updateReviewBadge' },
      { type: 'refreshReviewIfOpen' },
    ]);
    expect(reducePollResult('dmAutoReply', { escalatedCount: 1, items: [] }, null).steps[0].effects[0])
      .toEqual({ type: 'notif', icon: '\u{1F6A8}', title: 'DM AI: 1 item(s) need review', body: '' });
  });

  it('no effects for escalatedCount 0 / null / _skipped results', () => {
    for (const kind of ['channelWatch', 'dmAutoReply']) {
      expect(reducePollResult(kind, { escalatedCount: 0, items: [] }, null).steps).toEqual([]);
      expect(reducePollResult(kind, null, null).steps).toEqual([]);
      expect(reducePollResult(kind, { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true }, null).steps).toEqual([]);
    }
  });
});

describe('createPollModeLoader', () => {
  it("T-F2a: getStatus rejects → 'off'", async () => {
    const l = createPollModeLoader(() => Promise.reject(new Error('no ipc')));
    expect(l.current()).toBeNull();
    await expect(l.load()).resolves.toBe('off');
    expect(l.current()).toBe('off');
  });

  it("T-F2b: getStatus returns undefined → 'off'; getStatus throws synchronously → 'off'", async () => {
    const a = createPollModeLoader(() => undefined);
    await expect(a.load()).resolves.toBe('off');
    expect(a.current()).toBe('off');
    const b = createPollModeLoader(() => { throw new Error('sync'); });
    await expect(b.load()).resolves.toBe('off');
    expect(b.current()).toBe('off');
    const c = createPollModeLoader(() => null);
    await expect(c.load()).resolves.toBe('off');
  });

  it("T-F2c: set('on') before a deferred reply resolving 'off' → load() and current() === 'on'", async () => {
    const d = deferred();
    const l = createPollModeLoader(() => d.promise);
    const first = l.load();
    await flush();
    expect(l.set('on')).toBe('on');
    d.resolve({ mode: 'off' });
    await expect(first).resolves.toBe('on');
    await expect(l.load()).resolves.toBe('on');
    expect(l.current()).toBe('on');
  });

  it('T-F2d: 3x load() → getStatus called once', async () => {
    const getStatus = vi.fn(async () => ({ mode: 'shadow' }));
    const l = createPollModeLoader(getStatus);
    const r = await Promise.all([l.load(), l.load(), l.load()]);
    expect(r).toEqual(['shadow', 'shadow', 'shadow']);
    await l.load();
    expect(getStatus).toHaveBeenCalledTimes(1);
  });
});

describe('planModeChange', () => {
  it('T-F2e: every mode x all 8 armed combos', () => {
    const combos = [];
    for (let i = 0; i < 8; i++) combos.push({ dmNotify: !!(i & 1), channelWatch: !!(i & 2), dmAutoReply: !!(i & 4) });
    for (const mode of ['off', 'shadow', 'on', 'garbage']) {
      const own = mode !== 'on';
      for (const armed of combos) {
        const pl = planModeChange(mode, armed);
        expect(pl.clear).toEqual(own ? [] : KINDS.filter(k => armed[k]));
        expect(pl.arm).toEqual(own ? KINDS.filter(k => !armed[k]) : []);
      }
    }
  });
  it('T-F2e: on→off with nothing armed arms all three', () => {
    expect(planModeChange('off', { dmNotify: false, channelWatch: false, dmAutoReply: false }))
      .toEqual({ clear: [], arm: ['dmNotify', 'channelWatch', 'dmAutoReply'] });
  });
});

describe('createDmNotifyStarter', () => {
  afterEach(() => { vi.useRealTimers(); });

  function harness(loader) {
    const st = { authed: false, timer: null };
    const authCalls = [];
    const si = vi.fn((fn, ms) => setInterval(fn, ms));
    const starter = createDmNotifyStarter({
      loadMode: () => loader.load(),
      currentMode: () => loader.current(),
      checkLiveAuth: () => { const d = deferred(); authCalls.push(d); return d.promise; },
      getAuthed: () => st.authed,
      setAuthed: v => { st.authed = v; },
      getTimer: () => st.timer,
      setTimer: t => { st.timer = t; },
      setInterval: si,
      tick: () => {},
      intervalMs: 30000,
    });
    return { st, authCalls, si, starter };
  }

  for (const order of ['boot-first', 'push-first']) {
    it(`T-F2f: on→off fallback push mid boot auth arms exactly one timer (${order})`, async () => {
      vi.useFakeTimers();
      const loader = createPollModeLoader(async () => ({ mode: 'on' }));
      await loader.load();
      const { authCalls, si, starter } = harness(loader);

      const boot = starter.start();
      await flush();
      expect(authCalls).toHaveLength(1);           // boot pending on deferred checkLiveAuth

      // onPollMode({mode:'off'}) as wired in orcha-fab.js
      starter.notePush();
      const m = loader.set('off');
      const pl = planModeChange(m, { dmNotify: false, channelWatch: false, dmAutoReply: false });
      expect(pl.arm).toContain('dmNotify');
      const pushed = starter.start({ fromModePush: true });
      await flush();
      expect(authCalls).toHaveLength(2);

      const [bootAuth, pushAuth] = authCalls;
      if (order === 'boot-first') {
        bootAuth.resolve({ authenticated: true }); await flush();
        pushAuth.resolve({ authenticated: true }); await flush();
      } else {
        pushAuth.resolve({ authenticated: true }); await flush();
        bootAuth.resolve({ authenticated: true }); await flush();
      }
      await Promise.all([boot, pushed]);
      expect(si).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    });
  }

  it("T-F2g: off, no push, two concurrent start() → two timers (today's parity)", async () => {
    vi.useFakeTimers();
    const loader = createPollModeLoader(async () => ({ mode: 'off' }));
    const { authCalls, si, starter } = harness(loader);
    const a = starter.start();
    const b = starter.start();
    await flush();
    expect(authCalls).toHaveLength(2);
    authCalls.forEach(d => d.resolve({ authenticated: true }));
    await Promise.all([a, b]);
    expect(si).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(2);
  });

  it("'on' never arms and checks auth only once", async () => {
    vi.useFakeTimers();
    const loader = createPollModeLoader(async () => ({ mode: 'on' }));
    const { authCalls, si, starter } = harness(loader);
    const a = starter.start();
    await flush();
    authCalls[0].resolve({ authenticated: true });
    await a;
    await starter.start();
    expect(authCalls).toHaveLength(1);
    expect(si).not.toHaveBeenCalled();
  });

  it('auth failure (reject or unauthenticated) never arms', async () => {
    const loader = createPollModeLoader(async () => ({ mode: 'off' }));
    const { st, authCalls, si, starter } = harness(loader);
    const a = starter.start();
    await flush();
    authCalls[0].reject(new Error('net'));
    await a;
    expect(st.authed).toBe(false);
    const b = starter.start();
    await flush();
    authCalls[1].resolve({ authenticated: false });
    await b;
    expect(si).not.toHaveBeenCalled();
  });
});
