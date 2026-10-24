import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => sup._reset());

// A controllable fake timer: capture the scheduled callback + delay; fire on demand.
function fakeTimers() {
  const pending = [];
  sup._setTimers({
    set: (fn, ms) => { const h = { fn, ms, cleared: false }; pending.push(h); return h; },
    clear: (h) => { if (h) h.cleared = true; },
  });
  return {
    pending,
    // Fire the most recently scheduled (not cleared) timer.
    async fireLast() {
      for (let i = pending.length - 1; i >= 0; i--) { if (!pending[i].cleared && !pending[i].fired) { pending[i].fired = true; await pending[i].fn(); return pending[i]; } }
      return null;
    },
    lastDelay() { for (let i = pending.length - 1; i >= 0; i--) { if (!pending[i].cleared) return pending[i].ms; } return null; },
  };
}

function deps({ offline = () => false, smoke, probe = false, recoverAuth } = {}) {
  return {
    isOffline: offline,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }), // no real spawn
    aapApi: { getUserDetails: smoke },
    auth: {
      probeSession: async () => probe,
      checkMwinit: () => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: null }),
      recoverAuth: recoverAuth || (async () => ({ recovered: false, rung: 'silent', prompted: false })),
    },
  };
}
const unauth = async () => { throw Object.assign(new Error('401'), { status: 401 }); };
const ok200 = async () => ({ alias: 'z' });

describe('convergence — backoff schedule (spec #9)', () => {
  it('grows 30s → 1m → 2m and is bounded', () => {
    // jittered ±15%, so assert within range.
    const within = (v, base) => v >= base * 0.8 && v <= base * 1.35;
    expect(within(sup._backoffFor(1), 30000)).toBe(true);
    expect(within(sup._backoffFor(2), 60000)).toBe(true);
    expect(within(sup._backoffFor(3), 120000)).toBe(true);
    // way past the end is capped at the last bucket (~15m)
    expect(sup._backoffFor(99)).toBeLessThanOrEqual(900000 * 1.35);
  });
});

describe('convergence — persistent auto-retry until HEALTHY (spec #9: not stuck after one pass)', () => {
  it('failed pass arms a retry; a later retry converges to HEALTHY', { timeout: 20000 }, async () => {
    const t = fakeTimers();
    let healed = false;
    const smoke = async () => { if (!healed) throw Object.assign(new Error('401'), { status: 401 }); return { alias: 'z' }; };
    sup._setDeps(deps({ smoke, recoverAuth: async () => ({ recovered: false, rung: 'silent' }) }));

    // First pass fails → should schedule a retry.
    const r1 = await sup.ensureHealthyConverging({ reason: 'test' });
    expect(r1.ok).toBe(false);
    expect(r1.nextRetryAt).toBeTruthy();
    expect(t.lastDelay()).toBeGreaterThan(0);

    // Simulate the fix landing, then fire the scheduled retry.
    healed = true;
    await t.fireLast();
    expect(sup.getState()).toBe(sup.STATE.HEALTHY);
  });

  it('repeated failures grow the backoff (streak increases)', { timeout: 20000 }, async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ smoke: unauth }));
    await sup.ensureHealthyConverging({ reason: 'test' });      // fail #1 -> ~30s
    const d1 = t.lastDelay();
    await t.fireLast();                                          // fail #2 -> ~60s (still unhealthy)
    const d2 = t.lastDelay();
    expect(d2).toBeGreaterThan(d1 * 0.9);                       // grew (allowing jitter)
  });
});

describe('convergence — suppressed states (spec #9/#22)', () => {
  it('offline → no retry armed (reconnect watcher owns online-return)', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ offline: () => true, smoke: ok200 }));
    const r = await sup.ensureHealthyConverging({ reason: 'test' });
    expect(r.state).toBe(sup.STATE.OFFLINE);
    expect(t.lastDelay()).toBeNull();   // nothing scheduled
  });

  it('shutdown cancels pending retries', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ smoke: unauth }));
    await sup.ensureHealthyConverging({ reason: 'test' });
    expect(t.lastDelay()).toBeGreaterThan(0);
    sup.shutdown();
    // the pending timer is cleared
    expect(t.pending.every(p => p.cleared || p.fired)).toBe(true);
  });
});

describe('convergence — reconnect verifies without prompt (spec #10)', () => {
  it('onReconnect verifies real target, no prompt; HEALTHY if AAP works', async () => {
    fakeTimers();
    sup._setDeps(deps({ smoke: ok200 }));
    const r = await sup.onReconnect();
    expect(r.ok).toBe(true);
    expect(r.state).toBe(sup.STATE.HEALTHY);
    expect(r.prompted).toBe(false);
  });

  it('onReconnect does NOT prompt even if AAP still fails (background)', async () => {
    fakeTimers();
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => ({ recovered: false, rung: 'needs-prompt', prompted: false }) }));
    const r = await sup.onReconnect();
    expect(r.prompted).toBe(false);
  });
});

describe('convergence — success resets the streak', () => {
  it('after HEALTHY, a new failure starts backoff at the first bucket again', { timeout: 20000 }, async () => {
    const t = fakeTimers();
    let healthy = true;
    const smoke = async () => { if (healthy) return { alias: 'z' }; throw Object.assign(new Error('401'), { status: 401 }); };
    sup._setDeps(deps({ smoke }));
    await sup.ensureHealthyConverging({ reason: 'ok' });   // HEALTHY, streak 0
    expect(sup.getState()).toBe(sup.STATE.HEALTHY);
    healthy = false;
    await sup.ensureHealthyConverging({ reason: 'now-bad' }); // fail -> streak 1 -> ~30s
    const d = t.lastDelay();
    expect(d).toBeGreaterThan(30000 * 0.8);
    expect(d).toBeLessThan(60000);   // first bucket, not a grown one
  });
});
