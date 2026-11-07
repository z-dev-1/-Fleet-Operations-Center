// tests/worker-health-logic.test.js — pure renderer helpers for the Worker
// Health section (renderer/src/js/views/worker-health-logic.js, Phase 6).
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  esc, truncate, relTime, dur, workerStatus, authStatus, laneStatus, aiOverall,
  unavailableStatus, canReEnable, createVisiblePoller, STATUS_LABELS, akiLaneStatus,
} from '../renderer/src/js/views/worker-health-logic.js';

const NOW = 1730000000000;

describe('esc / truncate / dur / relTime', () => {
  it('esc escapes & < > " \'', () => {
    expect(esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(esc(null)).toBe('');
  });
  it('truncate', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('x'.repeat(100))).toHaveLength(80);
    expect(truncate(null)).toBe('');
  });
  it('dur', () => {
    expect(dur(12000)).toBe('12s');
    expect(dur(3 * 60000)).toBe('3m');
    expect(dur(2 * 3600000)).toBe('2h');
    expect(dur(36 * 3600000)).toBe('1d');
    expect(dur(-1)).toBe('—');
    expect(dur(null)).toBe('—');
  });
  it('relTime past / future / now / null / invalid / ISO', () => {
    expect(relTime(NOW - 5000, NOW)).toBe('5s ago');
    expect(relTime(NOW - 3 * 60000, NOW)).toBe('3m ago');
    expect(relTime(NOW - 2 * 3600000, NOW)).toBe('2h ago');
    expect(relTime(NOW - 25 * 3600000, NOW)).toBe('1d ago');
    expect(relTime(NOW + 5000, NOW)).toBe('in 5s');
    expect(relTime(NOW + 4 * 60000, NOW)).toBe('in 4m');
    expect(relTime(NOW + 300, NOW)).toBe('now');
    expect(relTime(null, NOW)).toBe('—');
    expect(relTime(undefined, NOW)).toBe('—');
    expect(relTime('not a date', NOW)).toBe('—');
    expect(relTime({}, NOW)).toBe('—');
    expect(relTime(new Date(NOW - 60000).toISOString(), NOW)).toBe('1m ago');
  });
});

describe('workerStatus', () => {
  const w = (o) => Object.assign({ state: 'healthy', restarts: 0, maxRestarts: 3, consecutiveFailures: 0 }, o);
  const cases = [
    [w({}), 'healthy', 'Healthy', ''],
    [w({ state: 'busy', currentJob: { startedAt: NOW - 12000, timedOut: false } }), 'busy', 'Busy', 'running 12s'],
    [w({ state: 'waiting', waitingOn: ['auth'] }), 'waiting', 'Waiting', 'waiting on auth'],
    [w({ state: 'waiting', waitingOn: ['auth', 'offline'] }), 'waiting', 'Waiting', 'waiting on auth, offline'],
    [w({ state: 'degraded', consecutiveFailures: 2 }), 'degraded', 'Degraded', '2 consecutive failures'],
    [w({ state: 'degraded', consecutiveFailures: 1 }), 'degraded', 'Degraded', '1 consecutive failure'],
    [w({ state: 'degraded', currentJob: { startedAt: NOW, timedOut: true } }), 'degraded', 'Degraded', 'tick timed out'],
    [w({ state: 'isolated', restarts: 1, maxRestarts: 3, isolatedUntil: NOW + 10 * 60000 }), 'recovering', 'Recovering', 'auto-retry in 10m'],
    [w({ state: 'isolated', restarts: 3, maxRestarts: 3, isolationReason: 'max-failures' }), 'failed', 'Failed / Isolated', 'max-failures'],
    [w({ state: 'isolated', restarts: 0, maxRestarts: 0, isolationReason: 'timeout-non-idempotent' }), 'failed', 'Failed / Isolated', 'timeout-non-idempotent'],
    [w({ state: 'disabled', disabledReason: 'restart-budget-exhausted' }), 'failed', 'Failed / Isolated', 'restart budget exhausted'],
    [w({ state: 'disabled', disabledReason: 'stopped' }), 'disabled', 'Disabled', 'stopped'],
    [w({ state: 'disabled', disabledReason: 'shutdown' }), 'disabled', 'Disabled', 'shutdown'],
    [w({ state: 'weird' }), 'unknown', 'Unknown', ''],
  ];
  for (const [input, key, label, reason] of cases) {
    it(input.state + ' ' + (input.disabledReason || input.isolationReason || reason) + ' → ' + label, () => {
      const s = workerStatus(input, NOW);
      expect(s).toEqual({ key, label, reason, cls: 'wh-st wh-st--' + key });
    });
  }
  it('null worker → Unknown', () => { expect(workerStatus(null, NOW).key).toBe('unknown'); });
});

describe('authStatus / laneStatus / aiOverall / unavailableStatus', () => {
  const cases = [
    ['HEALTHY', 'healthy', 'Healthy', ''],
    ['WAITING_FOR_USER', 'auth', 'Authentication required', 'sign in needed'],
    ['RECOVERING', 'recovering', 'Recovering', ''],
    ['COOLDOWN', 'recovering', 'Recovering', 'cooling down'],
    ['DEGRADED', 'degraded', 'Degraded', ''],
    ['OFFLINE', 'waiting', 'Waiting', 'offline'],
    ['FAILED', 'failed', 'Failed / Isolated', ''],
    ['UNKNOWN', 'unknown', 'Unknown', ''],
  ];
  for (const [state, key, label, reason] of cases) {
    it('auth ' + state + ' → ' + label, () => {
      expect(authStatus({ status: 'ok', state })).toEqual({ key, label, reason, cls: 'wh-st wh-st--' + key });
    });
  }
  it('auth unavailable section → Unknown with reason', () => {
    expect(authStatus({ status: 'unavailable', reason: 'not-loaded' })).toMatchObject({ key: 'unknown', reason: 'unavailable — not-loaded' });
    expect(authStatus(null).key).toBe('unknown');
  });
  it('auth.propagation: stepUp with action mwinit in COOLDOWN → sign in needed', () => {
    expect(authStatus({ status: 'ok', state: 'COOLDOWN', stepUp: true, action: 'mwinit' }))
      .toEqual({ key: 'auth', label: STATUS_LABELS.auth, reason: 'sign in needed', cls: 'wh-st wh-st--auth' });
    expect(authStatus({ status: 'ok', state: 'DEGRADED', stepUp: true, action: 'mwinit' }).reason).toBe('sign in needed');
  });
  it('F9: authStatus with the completed-full-sign-in row does not report sign in needed', () => {
    const a = {
      status: 'ok', state: 'COOLDOWN', stepUp: true, action: 'wait', level: 'warn',
      message: 'Full sign-in completed; Midway is still rejecting. Retrying automatically.',
    };
    const s = authStatus(a);
    expect(s.reason).not.toBe('sign in needed');
    expect(s).toEqual(authStatus({ status: 'ok', state: 'COOLDOWN' }));
  });
  it('auth.propagation: legacy inputs (no stepUp/action fields) are unchanged', () => {
    expect(authStatus({ status: 'ok', state: 'COOLDOWN' })).toMatchObject({ key: 'recovering', reason: 'cooling down' });
    expect(authStatus({ status: 'ok', state: 'WAITING_FOR_USER' })).toMatchObject({ key: 'auth', reason: 'sign in needed' });
    expect(authStatus({ status: 'ok', state: 'HEALTHY', stepUp: false, action: 'none' })).toMatchObject({ key: 'healthy' });
    expect(authStatus({ status: 'ok', state: 'COOLDOWN', stepUp: false, action: 'mwinit' })).toMatchObject({ key: 'recovering' });
  });
  it('laneStatus', () => {
    expect(laneStatus('up')).toMatchObject({ key: 'healthy', label: 'Healthy' });
    expect(laneStatus('down')).toMatchObject({ key: 'failed', label: 'Failed' });
    expect(laneStatus('fallback')).toMatchObject({ key: 'waiting', label: 'Waiting', reason: 'fallback only' });
    expect(laneStatus('unknown')).toMatchObject({ key: 'unknown', label: 'Unknown' });
  });
  it('akiLaneStatus', () => {
    expect(akiLaneStatus('up')).toMatchObject({ key: 'healthy', label: 'Healthy' });
    expect(akiLaneStatus('down')).toMatchObject({ key: 'failed', label: 'Failed' });
    expect(akiLaneStatus('not-found')).toMatchObject({ key: 'failed', label: 'Not found', reason: 'aki not found' });
    expect(akiLaneStatus('idle')).toMatchObject({ key: 'unknown', label: 'Unknown' });
    expect(akiLaneStatus(undefined)).toMatchObject({ key: 'unknown' });
  });
  it('aiOverall', () => {
    expect(aiOverall('up').key).toBe('healthy');
    expect(aiOverall('degraded').key).toBe('degraded');
    expect(aiOverall('down')).toMatchObject({ key: 'failed', label: 'Failed' });
    expect(aiOverall(undefined).key).toBe('unknown');
  });
  it('unavailableStatus', () => {
    expect(unavailableStatus({ status: 'unavailable', reason: 'boom' })).toEqual({ key: 'unknown', label: 'Unavailable', reason: 'boom', cls: 'wh-st wh-st--unknown' });
  });
  it('every status has a text label (not color only)', () => {
    for (const k of Object.keys(STATUS_LABELS)) expect(STATUS_LABELS[k].length).toBeGreaterThan(0);
  });
});

describe('canReEnable', () => {
  it('isolated or budget-exhausted only', () => {
    expect(canReEnable({ state: 'isolated' })).toBe(true);
    expect(canReEnable({ state: 'disabled', disabledReason: 'restart-budget-exhausted' })).toBe(true);
    expect(canReEnable({ state: 'disabled', disabledReason: 'stopped' })).toBe(false);
    expect(canReEnable({ state: 'disabled', disabledReason: 'shutdown' })).toBe(false);
    for (const s of ['healthy', 'busy', 'waiting', 'degraded']) expect(canReEnable({ state: s })).toBe(false);
    expect(canReEnable(null)).toBe(false);
  });
});

describe('createVisiblePoller', () => {
  afterEach(() => { vi.useRealTimers(); });

  function setup(opts) {
    vi.useFakeTimers();
    let visible = true;
    const run = vi.fn(opts && opts.run ? opts.run : () => Promise.resolve());
    const p = createVisiblePoller({
      run, intervalMs: opts && opts.intervalMs, isVisible: () => visible,
      setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h),
    });
    return { p, run, setVisible: (v) => { visible = v; } };
  }

  it('no run while closed; runs on open; then every interval', async () => {
    const { p, run } = setup();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).not.toHaveBeenCalled();
    await p.setOpen(true);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(run).toHaveBeenCalledTimes(3);
    p.setOpen(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(p.isArmed()).toBe(false);
  });

  it('no run while hidden; stops on hide; one immediate run + chain resumes on visible', async () => {
    const { p, run, setVisible } = setup();
    setVisible(false);
    await p.setOpen(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).not.toHaveBeenCalled();
    setVisible(true);
    await p.onVisibilityChange();
    expect(run).toHaveBeenCalledTimes(1);
    setVisible(false);
    await p.onVisibilityChange();
    expect(p.isArmed()).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(1);
    setVisible(true);
    await p.onVisibilityChange();
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('no overlap when run is slow; next armed only after settle', async () => {
    let active = 0;
    let maxActive = 0;
    const { p, run } = setup({ run: () => { active++; maxActive = Math.max(maxActive, active); return new Promise((r) => setTimeout(() => { active--; r(); }, 40000)); } });
    p.setOpen(true);
    await vi.advanceTimersByTimeAsync(100000);
    expect(maxActive).toBe(1);
    // runs at 0 (settles 40s), next at 55s (settles 95s) → 2 runs started by 100s
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refreshNow during in-flight → exactly one extra run after settle, no overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const { p, run } = setup({ run: () => { active++; maxActive = Math.max(maxActive, active); return new Promise((r) => setTimeout(() => { active--; r(); }, 1000)); } });
    p.setOpen(true);
    expect(run).toHaveBeenCalledTimes(1);
    p.refreshNow();
    p.refreshNow();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('refreshNow when idle runs immediately; when closed is a no-op', async () => {
    const { p, run } = setup();
    await p.refreshNow();
    expect(run).not.toHaveBeenCalled();
    await p.setOpen(true);
    await p.refreshNow();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('interval clamped to 10–15 s', () => {
    vi.useFakeTimers();
    expect(createVisiblePoller({ run: () => {}, intervalMs: 1000 }).intervalMs).toBe(10000);
    expect(createVisiblePoller({ run: () => {}, intervalMs: 60000 }).intervalMs).toBe(15000);
    expect(createVisiblePoller({ run: () => {}, intervalMs: 12000 }).intervalMs).toBe(12000);
    expect(createVisiblePoller({ run: () => {} }).intervalMs).toBe(15000);
  });

  it('a rejected or throwing run does not break the chain', async () => {
    let n = 0;
    const { p, run } = setup({ run: () => { n++; if (n === 1) return Promise.reject(new Error('x')); if (n === 2) throw new Error('y'); return Promise.resolve(); } });
    await p.setOpen(true);
    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(15000);
    expect(run).toHaveBeenCalledTimes(3);
    expect(p.isArmed()).toBe(true);
  });

  it('stop() disarms and ignores later calls', async () => {
    const { p, run } = setup();
    await p.setOpen(true);
    p.stop();
    await p.refreshNow();
    await p.onVisibilityChange();
    await vi.advanceTimersByTimeAsync(60000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
