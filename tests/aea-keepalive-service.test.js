import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const svc = require('../src/auth/aea-keepalive-service');

afterEach(() => svc._reset());

// A fake auth module: controllable live-session AEA + posture-token TTL, and a
// recording inject that simulates the cookie landing.
function fakeAuth(init) {
  const s = Object.assign({ liveAea: null, tokenMin: 15, injectOk: true, injects: 0 }, init);
  return {
    _s: s,
    aeaSessionExpiryMin: async () => s.liveAea,
    postureTokenExpiryMin: () => s.tokenMin,
    injectAeaFromPostureToken: async () => {
      s.injects++;
      if (!s.injectOk) return { ok: false, reason: 'inject-failed', aeaMin: s.liveAea };
      // Injecting makes the live AEA equal to the token's remaining life.
      s.liveAea = s.tokenMin;
      return { ok: true, aeaMin: s.tokenMin, tokenExp: Math.floor(Date.now() / 1000) + s.tokenMin * 60, domains: 4 };
    },
    ACME_POSTURE_TOKEN: null, // disable the real file watch in tests
  };
}

describe('AEA keep-alive — proactive re-inject (never let AEA go stale)', () => {
  it('injects when the live session has NO AEA', async () => {
    const auth = fakeAuth({ liveAea: null, tokenMin: 15 });
    svc._setDeps({ auth });
    const r = await svc.tick();
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('reinjected');
    expect(auth._s.injects).toBe(1);
    expect(r.aeaMin).toBe(15);
  });

  it('injects when live AEA is below the safety floor', async () => {
    const auth = fakeAuth({ liveAea: 5, tokenMin: 15 });  // 5 < floor 8
    svc._setDeps({ auth });
    const r = await svc.tick({ floorMin: 8 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('reinjected');
    expect(auth._s.injects).toBe(1);
  });

  it('does NOT inject when live AEA is comfortably above the floor', async () => {
    const auth = fakeAuth({ liveAea: 14, tokenMin: 14 });  // fresh, token not newer
    svc._setDeps({ auth });
    const r = await svc.tick({ floorMin: 8 });
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('fresh');
    expect(auth._s.injects).toBe(0);
  });

  it('captures a freshly-rolled token even when current AEA is still above floor', async () => {
    // Live AEA 10min, but ACME just rolled a 15min token → capture the newer one.
    const auth = fakeAuth({ liveAea: 10, tokenMin: 15 });
    svc._setDeps({ auth });
    const r = await svc.tick({ floorMin: 8 });
    expect(r.reason).toBe('reinjected');
    expect(auth._s.injects).toBe(1);
  });

  it('force always injects', async () => {
    const auth = fakeAuth({ liveAea: 99, tokenMin: 99 });
    svc._setDeps({ auth });
    const r = await svc.tick({ force: true });
    expect(r.reason).toBe('reinjected');
    expect(auth._s.injects).toBe(1);
  });
});

describe('AEA keep-alive — honest degrade (ACME / session problems)', () => {
  it('reports ACME_DOWN when the posture token is missing (null)', async () => {
    const auth = fakeAuth({ liveAea: null, tokenMin: null });
    svc._setDeps({ auth });
    const r = await svc.tick();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('posture-token-missing');
    expect(svc.getState().state).toBe('ACME_DOWN');
    expect(auth._s.injects).toBe(0);   // nothing to inject
  });

  it('reports ACME_DOWN when the posture token is expired (<=0)', async () => {
    const auth = fakeAuth({ liveAea: null, tokenMin: 0 });
    svc._setDeps({ auth });
    const r = await svc.tick();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('posture-token-expired');
    expect(svc.getState().state).toBe('ACME_DOWN');
  });

  it('reports DEGRADED when a live token exists but inject does not land', async () => {
    const auth = fakeAuth({ liveAea: 2, tokenMin: 15, injectOk: false });
    svc._setDeps({ auth });
    const r = await svc.tick();
    expect(r.ok).toBe(false);
    expect(svc.getState().state).toBe('DEGRADED');
  });
});

describe('AEA keep-alive — single-flight + loop', () => {
  it('start runs a tick and keeps AEA fresh on the fake timer', async () => {
    const auth = fakeAuth({ liveAea: null, tokenMin: 15 });
    svc._setDeps({ auth });
    // Capture the loop callback via fake timers; fire it once manually.
    let scheduled = null;
    svc._setTimers({ set: (fn, ms) => { scheduled = { fn, ms }; return scheduled; }, clear: () => {} });
    svc.start({ checkMs: 60000, floorMin: 8 });
    // immediate:true schedules the first loop at 0ms — fire it.
    expect(scheduled).toBeTruthy();
    await scheduled.fn();
    expect(auth._s.injects).toBeGreaterThanOrEqual(1);
    expect(svc.getState().running).toBe(true);
    svc.stop();
    expect(svc.getState().running).toBe(false);
  });
});
