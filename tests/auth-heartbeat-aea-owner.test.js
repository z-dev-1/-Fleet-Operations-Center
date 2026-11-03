// tests/auth-heartbeat-aea-owner.test.js — Phase 9 auth.singleOwner.aea
// (AC-4, AC-14, AC-15): with the flag on and the keep-alive running, the
// heartbeat makes NO AEA writes (the keep-alive is the one AEA owner) and only
// hands recovery to the supervisor, gated on the supervisor's state.
// Real-supervisor case uses the REQUIRED FIX 1 setup order.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const hb = require('../src/auth/heartbeat-aea');
const supervisor = require('../src/auth/midway-health-supervisor');
const svc = require('../src/auth/aea-keepalive-service');

function mkLog() { return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }; }
function throwingAuth(liveAea) {
  const no = (n) => vi.fn(() => { throw new Error(n + ' must not be called by the heartbeat'); });
  return {
    aeaSessionExpiryMin: vi.fn(async () => liveAea),
    refreshAeaSilently: no('refreshAeaSilently'),
    injectCookies: no('injectCookies'),
    injectAeaFromPostureToken: no('injectAeaFromPostureToken'),
  };
}
const ka = (state, running = true) => ({ getState: () => ({ running, state, consecutiveFailures: state === 'FRESH' ? 0 : 3 }) });
function fakeSup(state, ehc) {
  return {
    getState: typeof state === 'function' ? state : () => state,
    ensureHealthyConverging: vi.fn(ehc || (async () => ({ ok: true, verified: true }))),
    ensureRecoveryArmed: vi.fn(() => false),
  };
}
const STATE_OK = { ok: true, expiresInMin: 1000, aeaExpiresInMin: 100 };

afterEach(() => { hb._reset(); });

describe('ownerFor (AC-4, AC-15)', () => {
  it('flag off → legacy (no log)', () => {
    const log = mkLog();
    expect(hb.ownerFor({ singleOwnerAea: false, keepalive: ka('FRESH'), log })).toEqual({ owner: 'legacy', reason: 'flag-off' });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('flag on + keep-alive running → keepalive', () => {
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: ka('FRESH'), log: mkLog() }).owner).toBe('keepalive');
  });

  it('flag on + keep-alive missing / not running / getState throws → legacy, warned once per process', () => {
    const log = mkLog();
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: null, log }).owner).toBe('legacy');
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: ka('FRESH', false), log }).owner).toBe('legacy');
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: { getState: () => { throw new Error('x'); } }, log }).owner).toBe('legacy');
    expect(log.warn).toHaveBeenCalledTimes(1);
    hb._reset();
    hb.ownerFor({ singleOwnerAea: true, keepalive: null, log });
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('never throws', () => {
    expect(hb.ownerFor(undefined).owner).toBe('legacy');
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: ka('FRESH', false), log: { warn: () => { throw new Error('x'); } } }).owner).toBe('legacy');
  });
});

describe('runKeepaliveOwned (AC-14)', () => {
  it('keep-alive FRESH: 3 steps → no AEA writes, AEA-DIAG with owner tag, supervisor untouched', async () => {
    const auth = throwingAuth(12);
    const sup = fakeSup('HEALTHY');
    const log = mkLog();
    for (let i = 0; i < 3; i++) {
      const r = await hb.runKeepaliveOwned({ state: STATE_OK, auth, keepalive: ka('FRESH'), supervisor: sup, log });
      expect(r.delegated).toBe(false);
    }
    expect(auth.refreshAeaSilently).not.toHaveBeenCalled();
    expect(auth.injectCookies).not.toHaveBeenCalled();
    expect(auth.injectAeaFromPostureToken).not.toHaveBeenCalled();
    const diag = log.info.mock.calls.map((c) => c[0]).filter((m) => m.startsWith('[AEA-DIAG]'));
    expect(diag).toHaveLength(3);
    for (const m of diag) expect(m).toMatch(/^\[AEA-DIAG\] live session AEA\(min\)=.* \| owner=aea-keepalive/);
    expect(sup.ensureHealthyConverging).not.toHaveBeenCalled();
    expect(sup.ensureRecoveryArmed).not.toHaveBeenCalled();
  });

  const NEEDS_HELP = [['ACME_DOWN', 12], ['DEGRADED', 12], ['FRESH', null], ['FRESH', 0]];
  const DELEGATE = ['HEALTHY', 'UNKNOWN', 'DEGRADED', 'throws'];
  for (const [kaState, live] of NEEDS_HELP) {
    for (const s of DELEGATE) {
      it(`needs help (keepalive=${kaState}, live=${live}) + supervisor ${s} → ensureHealthyConverging ×1 (no prompt)`, async () => {
        const sup = fakeSup(s === 'throws' ? () => { throw new Error('x'); } : s);
        const r = await hb.runKeepaliveOwned({ state: STATE_OK, auth: throwingAuth(live), keepalive: ka(kaState), supervisor: sup, log: mkLog() });
        expect(r.delegated).toBe(true);
        expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(1);
        expect(sup.ensureHealthyConverging).toHaveBeenCalledWith({ reason: 'heartbeat:aea-keepalive-degraded', allowPrompt: false });
        expect(sup.ensureRecoveryArmed).not.toHaveBeenCalled();
      });
    }
  }

  for (const s of ['COOLDOWN', 'RECOVERING', 'OFFLINE', 'WAITING_FOR_USER']) {
    it(`supervisor ${s} owns recovery → no ladder call, watchdog only, deferred`, async () => {
      const sup = fakeSup(s);
      if (s !== 'WAITING_FOR_USER') sup.ensureRecoveryArmed.mockReturnValue(true);
      const log = mkLog();
      const r = await hb.runKeepaliveOwned({ state: STATE_OK, auth: throwingAuth(12), keepalive: ka('ACME_DOWN'), supervisor: sup, log });
      expect(r).toMatchObject({ delegated: false, deferred: true, supState: s });
      expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(0);
      expect(sup.ensureRecoveryArmed).toHaveBeenCalledTimes(1);
      const line = log.info.mock.calls.map((c) => c[0]).find((m) => /already owns recovery/.test(m));
      if (s === 'WAITING_FOR_USER') expect(line).not.toMatch(/watchdog armed retry/);
      else expect(line).toMatch(/\(watchdog armed retry\)/);
    });
  }

  it('overlap guard: a second step while the first delegation is pending is skipped; afterwards a step delegates again', async () => {
    let release;
    const sup = fakeSup('HEALTHY');
    sup.ensureHealthyConverging.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const args = () => ({ state: STATE_OK, auth: throwingAuth(12), keepalive: ka('ACME_DOWN'), supervisor: sup, log: mkLog() });
    const first = hb.runKeepaliveOwned(args());
    for (let i = 0; i < 10 && sup.ensureHealthyConverging.mock.calls.length === 0; i++) await Promise.resolve();
    expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(1);
    const second = await hb.runKeepaliveOwned(args());
    expect(second.skipped).toBe(true);
    expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(1);
    release({ ok: true });
    expect((await first).delegated).toBe(true);
    const third = await hb.runKeepaliveOwned(args());
    expect(third.delegated).toBe(true);
    expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(2);
  });

  it('overlap guard: a rejected delegation clears the guard (rejection propagates) and the next step delegates', async () => {
    const sup = fakeSup('HEALTHY');
    sup.ensureHealthyConverging.mockRejectedValueOnce(new Error('sup down'));
    const args = () => ({ state: STATE_OK, auth: throwingAuth(12), keepalive: ka('ACME_DOWN'), supervisor: sup, log: mkLog() });
    await expect(hb.runKeepaliveOwned(args())).rejects.toThrow('sup down');
    expect((await hb.runKeepaliveOwned(args())).delegated).toBe(true);
    expect(sup.ensureHealthyConverging).toHaveBeenCalledTimes(2);
  });

  it('supervisor unavailable → warning, nothing delegated', async () => {
    const log = mkLog();
    const r = await hb.runKeepaliveOwned({ state: STATE_OK, auth: throwingAuth(null), keepalive: ka('ACME_DOWN'), supervisor: null, log });
    expect(r.delegated).toBe(false);
    expect(log.warn.mock.calls[0][0]).toMatch(/auth supervisor unavailable/);
  });
});

describe('real supervisor backoff is respected (REQUIRED FIX 1 setup)', () => {
  let timers, getUserDetails, fakeAuth;
  beforeEach(() => {
    getUserDetails = vi.fn(async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); });
    fakeAuth = { probeSession: vi.fn(async () => false), recoverAuth: vi.fn(async () => ({ recovered: true })) };
    supervisor._reset();
    timers = { set: vi.fn(() => 1), clear: vi.fn() };
    supervisor._setTimers(timers);
    supervisor._setDeps({ isOffline: () => false, aapApi: { getUserDetails: (...a) => getUserDetails(...a) }, auth: fakeAuth, checkVpnState: () => ({ connected: true }) });
  });
  afterEach(() => { supervisor._reset(); });

  it('supervisor in COOLDOWN with a retry armed → 3 heartbeat steps add no ladder run and no timer', async () => {
    await supervisor.ensureHealthyConverging({ reason: 'test', allowPrompt: false });
    expect(supervisor.getState()).toBe('COOLDOWN');
    expect(timers.set).toHaveBeenCalledTimes(1);
    const ladderRuns = fakeAuth.recoverAuth.mock.calls.length;
    const log = mkLog();
    for (let i = 0; i < 3; i++) {
      const r = await hb.runKeepaliveOwned({ state: STATE_OK, auth: throwingAuth(null), keepalive: ka('ACME_DOWN'), supervisor, log });
      expect(r.deferred).toBe(true);
    }
    expect(fakeAuth.recoverAuth).toHaveBeenCalledTimes(ladderRuns);
    expect(timers.set).toHaveBeenCalledTimes(1);
  });
});

describe('one AEA owner end-to-end (keep-alive writes, heartbeat does not)', () => {
  afterEach(() => { svc._reset(); });

  it('alternating keep-alive ticks and heartbeat steps → keep-alive injects ≥ 1, heartbeat-attributed delta 0', async () => {
    const kaAuth = h.fakeKeepaliveAuth({ liveAea: null, tokenMin: 15 });
    svc._setDeps({ auth: kaAuth });
    svc._setTimers({ set: () => 1, clear: () => {} });
    svc.start({ immediate: false });
    const sup = fakeSup('HEALTHY');
    let kaWrites = 0, hbWrites = 0;
    for (let i = 0; i < 3; i++) {
      let before = kaAuth._s.injects;
      await svc.tick();
      kaWrites += kaAuth._s.injects - before;
      before = kaAuth._s.injects;
      await hb.runKeepaliveOwned({ state: STATE_OK, auth: kaAuth, keepalive: svc, supervisor: sup, log: mkLog() });
      hbWrites += kaAuth._s.injects - before;
      kaAuth._s.liveAea = i === 0 ? 3 : kaAuth._s.liveAea;   // drop below the floor once so the keep-alive re-injects
    }
    expect(hb.ownerFor({ singleOwnerAea: true, keepalive: svc, log: mkLog() }).owner).toBe('keepalive');
    expect(kaWrites).toBeGreaterThanOrEqual(1);
    expect(hbWrites).toBe(0);
    expect(kaAuth.refreshAeaSilently).not.toHaveBeenCalled();
    expect(kaAuth.injectCookies).not.toHaveBeenCalled();
    expect(sup.ensureHealthyConverging).not.toHaveBeenCalled();
  });
});
