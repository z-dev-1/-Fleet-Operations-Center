// tests/auth-reconnect-routing.test.js — Phase 9 auth.singleOwner.reconnect
// (AC-3, AC-12, AC-13): startOnlineReauthWatch routes the offline→online edge
// through the ONE auth supervisor's onReconnect() with the flag on, and keeps
// the legacy refreshAeaSilently → recoverAuth path with the flag off.
// AC-13 uses the REAL supervisor with fake deps/timers (REQUIRED FIX 1 setup:
// beforeEach _reset() THEN _setTimers(); afterEach _reset() only).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const auth = require('../src/scrapers/auth');
const supervisor = require('../src/auth/midway-health-supervisor');

const flags = (rc) => ({ singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: rc });
const warns = (re) => h.logs.filter((l) => l.ns === 'auth' && l.level === 'warn' && re.test(l.msg));

let refresh, recover, fakeSup;
function setup(rc, extra) {
  refresh = vi.fn(async () => ({ ok: true }));
  recover = vi.fn(async () => ({ recovered: true }));
  fakeSup = { onReconnect: vi.fn(async () => ({ ok: true, state: 'HEALTHY', verified: true })) };
  auth._setTestImpl({ refreshAeaSilently: refresh, recoverAuth: recover });
  auth._setCoordDeps(Object.assign({ flags: flags(rc), supervisor: fakeSup }, extra || {}));
  auth.startOnlineReauthWatch();             // flags must be set BEFORE subscribing
}

beforeEach(() => {
  vi.useFakeTimers();
  h.logs.length = 0;
  h.offline._offline = false;
});
afterEach(() => {
  auth._resetCoord();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('reconnect routing — flag ON (AC-12)', () => {
  it('one online edge → after 2.5 s exactly one onReconnect(); no refresh, no recoverAuth', async () => {
    setup(true);
    expect(h.logs.some((l) => /re-auth watch started \(routed via supervisor\.onReconnect\)/.test(l.msg))).toBe(true);
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2499);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(0);
    expect(recover).toHaveBeenCalledTimes(0);
  });

  it('non-online statuses are ignored', async () => {
    setup(true);
    h.offline.emit('offline');
    h.offline.emit('ONLINE');
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(0);
  });

  it('offline flap during the settle → zero calls', async () => {
    setup(true);
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(1000);
    h.offline._offline = true;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(0);
    expect(refresh).toHaveBeenCalledTimes(0);
  });

  it('a second edge while the first is pending is ignored', async () => {
    setup(true);
    h.offline.emit('online');
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(1);
  });

  it('supervisor unavailable → legacy path for that event + a warning', async () => {
    setup(true, { supervisor: null });
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(warns(/singleOwner\.reconnect is on but the supervisor is unavailable/)).toHaveLength(1);
  });

  it('onReconnect rejects → a warning and _reauthInFlight is released (a later edge is handled)', async () => {
    setup(true);
    fakeSup.onReconnect.mockRejectedValueOnce(new Error('boom'));
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(warns(/Reconnect re-verify error: boom/)).toHaveLength(1);
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledTimes(0);
  });
});

describe('reconnect routing — flag OFF parity (AC-3)', () => {
  it('online edge → refreshAeaSilently ×1; on ok:false → recoverAuth("reconnect:reverify-failed") with no opts; onReconnect ×0', async () => {
    setup(false);
    expect(h.logs.some((l) => /re-auth watch started$/.test(l.msg))).toBe(true);
    refresh.mockResolvedValueOnce({ ok: false });
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0]).toHaveLength(0);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]).toEqual(['reconnect:reverify-failed']);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(0);
  });

  it('online edge with ok:true → no recoverAuth', async () => {
    setup(false);
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledTimes(0);
    expect(fakeSup.onReconnect).toHaveBeenCalledTimes(0);
  });
});

describe('AC-13 — real supervisor coalesces concurrent onReconnect() calls', () => {
  let timers, getUserDetails, fakeAuth;
  beforeEach(() => {
    getUserDetails = vi.fn(async () => ({ login: 'test' }));
    fakeAuth = { probeSession: vi.fn(async () => false), recoverAuth: vi.fn(async () => ({ recovered: true })) };
    supervisor._reset();                       // resets deps, state, lock, history AND convergence (real timers)
    timers = { set: vi.fn(() => 1), clear: vi.fn() };
    supervisor._setTimers(timers);             // MUST come after _reset()
    supervisor._setDeps({ isOffline: () => false, aapApi: { getUserDetails: (...a) => getUserDetails(...a) }, auth: fakeAuth, checkVpnState: () => ({ connected: true }) });
  });
  afterEach(() => { supervisor._reset(); });   // single call; _resetConvergence is not exported

  it('(a) healthy: two concurrent onReconnect() → getUserDetails ×1, second coalesced, no retry armed', async () => {
    const [r1, r2] = await Promise.all([supervisor.onReconnect(), supervisor.onReconnect()]);
    expect(getUserDetails).toHaveBeenCalledTimes(1);
    expect(r1.coalesced).toBeUndefined();
    expect(r2.coalesced).toBe(true);
    expect(timers.set).toHaveBeenCalledTimes(0);
    expect(supervisor.getState()).toBe('HEALTHY');
  });

  it('(b) 401: two concurrent onReconnect() → getUserDetails ×2, recoverAuth ×1 (allowPrompt:false), one retry armed', async () => {
    getUserDetails = vi.fn(async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); });
    const [r1, r2] = await Promise.all([supervisor.onReconnect(), supervisor.onReconnect()]);
    expect(getUserDetails).toHaveBeenCalledTimes(2);
    expect(fakeAuth.recoverAuth).toHaveBeenCalledTimes(1);
    expect(fakeAuth.recoverAuth.mock.calls[0][1]).toEqual({ allowPrompt: false });
    expect(timers.set).toHaveBeenCalledTimes(1);
    expect(r2.coalesced).toBe(true);
    expect(r1.ok).toBe(false);
    expect(supervisor.getState()).toBe('COOLDOWN');
  });

  it('end-to-end: flag on + the real supervisor → one watcher edge → getUserDetails ×1', async () => {
    setup(true, { supervisor });
    h.offline.emit('online');
    await vi.advanceTimersByTimeAsync(2500);
    expect(getUserDetails).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(0);
    expect(recover).toHaveBeenCalledTimes(0);
    expect(supervisor.getState()).toBe('HEALTHY');
  });
});
