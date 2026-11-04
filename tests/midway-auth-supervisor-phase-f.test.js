import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => { sup.stopHealthMonitor(); sup._reset(); });

// Controllable fake timers (same seam the Phase C tests use).
function fakeTimers() {
  const pending = [];
  sup._setTimers({
    set: (fn, ms) => { const h = { fn, ms, cleared: false, fired: false }; pending.push(h); return h; },
    clear: (h) => { if (h) h.cleared = true; },
  });
  return {
    pending,
    async fireLast() {
      for (let i = pending.length - 1; i >= 0; i--) { if (!pending[i].cleared && !pending[i].fired) { pending[i].fired = true; await pending[i].fn(); return pending[i]; } }
      return null;
    },
    lastDelay() { for (let i = pending.length - 1; i >= 0; i--) { if (!pending[i].cleared && !pending[i].fired) return pending[i].ms; } return null; },
    armedCount() { return pending.filter(p => !p.cleared && !p.fired).length; },
  };
}

function deps({ offline = () => false, smoke, probe = false, checkMwinit, recoverAuth } = {}) {
  return {
    isOffline: offline,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }),
    aapApi: { getUserDetails: smoke },
    auth: {
      probeSession: async () => probe,
      checkMwinit: checkMwinit || (() => ({ ok: true, expiresInMin: 800, aeaExpiresInMin: 90 })),
      recoverAuth: recoverAuth || (async () => ({ recovered: false, rung: 'silent', prompted: false })),
    },
  };
}
const unauth = async () => { throw Object.assign(new Error('401'), { status: 401 }); };
const ok200 = async () => ({ alias: 'z' });

// ═══════════════════════════════════════════════════════════════════════════
// BUG #1/#14 — the exact stuck-recovery scenario. A background retry with
// allowPrompt:false that stays unhealthy, WITHOUT a real interactive-user
// requirement, must NOT enter WAITING_FOR_USER and must keep retrying.
// ═══════════════════════════════════════════════════════════════════════════
describe('REGRESSION #14 — allowPrompt:false never falsely strands auth in WAITING_FOR_USER', () => {
  it('silent ladder exhausted (session still valid) → COOLDOWN + retry armed, not WAITING_FOR_USER', async () => {
    const t = fakeTimers();
    // recoverAuth stops at needs-prompt but the session is NOT invalid: this is
    // a silent-rung exhaustion, NOT a genuine user requirement.
    sup._setDeps(deps({
      smoke: unauth,
      recoverAuth: async () => ({ recovered: false, rung: 'needs-prompt', prompted: false, sessionInvalid: false, requiresInteractiveAuth: false }),
    }));

    const r1 = await sup.ensureHealthyConverging({ reason: 'auto-retry', allowPrompt: false });
    expect(r1.ok).toBe(false);
    expect(r1.requiresUser).toBe(false);
    expect(sup.getState()).toBe(sup.STATE.COOLDOWN);     // NOT WAITING_FOR_USER
    expect(t.lastDelay()).toBeGreaterThan(0);             // a retry IS armed
    expect(r1.nextRetryAt).toBeTruthy();
  });

  it('full stuck-recovery loop: fail → retry → still unhealthy → COOLDOWN → retry #2 → later success → HEALTHY + streak reset', { timeout: 20000 }, async () => {
    const t = fakeTimers();
    let healed = false;
    const smoke = async () => { if (!healed) throw Object.assign(new Error('401'), { status: 401 }); return { alias: 'z' }; };
    sup._setDeps(deps({
      smoke,
      recoverAuth: async () => ({ recovered: false, rung: 'silent', prompted: false, sessionInvalid: false }),
    }));

    // 1-2. first pass fails → retry #1 armed
    const r1 = await sup.ensureHealthyConverging({ reason: 'test', allowPrompt: false });
    expect(r1.ok).toBe(false);
    expect(sup.getState()).toBe(sup.STATE.COOLDOWN);
    expect(t.lastDelay()).toBeGreaterThan(0);

    // 3-6. retry #1 fires (allowPrompt:false), still unhealthy, no user required
    await t.fireLast();
    expect(sup.getState()).toBe(sup.STATE.COOLDOWN);      // still COOLDOWN, NOT stuck
    // 7. retry #2 armed
    expect(t.lastDelay()).toBeGreaterThan(0);

    // 8-9. the fix lands; the next retry converges to HEALTHY
    healed = true;
    await t.fireLast();
    expect(sup.getState()).toBe(sup.STATE.HEALTHY);

    // 10. streak reset → a new failure starts the backoff at the first bucket
    healed = false;
    await sup.ensureHealthyConverging({ reason: 'now-bad', allowPrompt: false });
    const d = t.lastDelay();
    expect(d).toBeGreaterThan(30000 * 0.8);
    expect(d).toBeLessThan(60000);                        // first bucket again
  });

  it('genuine user requirement (sessionInvalid) DOES enter WAITING_FOR_USER and suppresses retry', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({
      smoke: unauth,
      checkMwinit: () => ({ ok: false, reason: 'expired', expiresInMin: 0, aeaExpiresInMin: null }),
      recoverAuth: async () => ({ recovered: false, rung: 'needs-prompt', prompted: false, sessionInvalid: true, requiresInteractiveAuth: true }),
    }));
    const r = await sup.ensureHealthyConverging({ reason: 'test', allowPrompt: false });
    expect(r.requiresUser).toBe(true);
    expect(sup.getState()).toBe(sup.STATE.WAITING_FOR_USER);
    expect(t.lastDelay()).toBeNull();                     // no retry while user is the gate
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG #2/#11 — background retries must never self-disable on a silent failure.
// ═══════════════════════════════════════════════════════════════════════════
describe('REGRESSION #2 — convergence loop keeps retrying until HEALTHY', () => {
  it('repeated silent failures keep a retry armed every pass', { timeout: 20000 }, async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => ({ recovered: false, rung: 'silent', sessionInvalid: false }) }));
    await sup.ensureHealthyConverging({ reason: 'test', allowPrompt: false });
    expect(t.armedCount()).toBe(1);
    await t.fireLast();
    expect(t.armedCount()).toBe(1);   // another retry armed, not zero
    await t.fireLast();
    expect(t.armedCount()).toBe(1);   // and again
    expect(sup.getState()).toBe(sup.STATE.COOLDOWN);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG #12 — recovery watchdog arms convergence if a bad state has no retry.
// ═══════════════════════════════════════════════════════════════════════════
describe('REGRESSION #12 — watchdog arms recovery when unhealthy + online + no retry', () => {
  it('ensureRecoveryArmed schedules a retry from a stranded COOLDOWN', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => ({ recovered: false, rung: 'silent', sessionInvalid: false }) }));
    // ensureHealthy (NOT converging) leaves us COOLDOWN WITHOUT arming a retry —
    // exactly the illegal "stuck" shape: unhealthy + online + no retry timer.
    await sup.ensureHealthy({ reason: 'seed', allowPrompt: false });
    expect(sup.getState()).toBe(sup.STATE.COOLDOWN);
    expect(t.armedCount()).toBe(0);                 // no retry armed yet (the bug shape)
    // Watchdog detects the stranded state and arms convergence.
    const armed = sup.ensureRecoveryArmed();
    expect(armed).toBe(true);
    expect(t.armedCount()).toBe(1);
    // Idempotent: calling again does NOT create a duplicate timer.
    expect(sup.ensureRecoveryArmed()).toBe(false);
    expect(t.armedCount()).toBe(1);
  });

  it('watchdog is a no-op when HEALTHY', async () => {
    fakeTimers();
    sup._setDeps(deps({ smoke: ok200 }));
    await sup.ensureHealthyConverging({ reason: 'ok' });
    expect(sup.getState()).toBe(sup.STATE.HEALTHY);
    expect(sup.ensureRecoveryArmed()).toBe(false);
  });

  it('watchdog is a no-op while WAITING_FOR_USER', async () => {
    fakeTimers();
    sup._setDeps(deps({
      smoke: unauth,
      checkMwinit: () => ({ ok: false, reason: 'expired', expiresInMin: 0, aeaExpiresInMin: null }),
      recoverAuth: async () => ({ recovered: false, rung: 'needs-prompt', sessionInvalid: true, requiresInteractiveAuth: true }),
    }));
    await sup.ensureHealthyConverging({ reason: 'test', allowPrompt: false });
    expect(sup.getState()).toBe(sup.STATE.WAITING_FOR_USER);
    expect(sup.ensureRecoveryArmed()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG #15 — startup uses converging recovery and does NOT trust disk cookies.
// (The supervisor is the unit under test; startup wiring just calls it.)
// ═══════════════════════════════════════════════════════════════════════════
describe('REGRESSION #15 — health is real-target verified, not cookie-derived', () => {
  it('disk cookies look valid but AAP rejects → NOT healthy, retry armed', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({
      // Disk says everything is fine (valid session + fresh AEA)...
      checkMwinit: () => ({ ok: true, expiresInMin: 1200, aeaExpiresInMin: 180 }),
      // ...but the REAL AAP target rejects.
      smoke: unauth,
      recoverAuth: async () => ({ recovered: false, rung: 'silent', sessionInvalid: false }),
    }));
    const r = await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: true, forceVerify: true });
    expect(r.ok).toBe(false);                 // cookies did NOT make it healthy
    expect(sup.getState()).not.toBe(sup.STATE.HEALTHY);
    expect(t.lastDelay()).toBeGreaterThan(0); // startup armed bounded retry
  });

  it('startup failure arms a retry (converging, not one-shot)', async () => {
    const t = fakeTimers();
    sup._setDeps(deps({ smoke: unauth, recoverAuth: async () => ({ recovered: false, rung: 'silent', sessionInvalid: false }) }));
    const r = await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: true, forceVerify: true });
    expect(r.nextRetryAt).toBeTruthy();
  });

  it('server 500 is NOT auth: no ladder, no WAITING_FOR_USER', async () => {
    fakeTimers();
    const err500 = async () => { throw Object.assign(new Error('AAP API 500'), { status: 500 }); };
    let ladderRan = 0;
    sup._setDeps(deps({ smoke: err500, recoverAuth: async () => { ladderRan++; return { recovered: false }; } }));
    const r = await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: true, forceVerify: true });
    expect(r.class).toBe(sup.FAIL.AAP_SERVER_ERROR);
    expect(ladderRan).toBe(0);
    expect(sup.getState()).not.toBe(sup.STATE.WAITING_FOR_USER);
  });
});
