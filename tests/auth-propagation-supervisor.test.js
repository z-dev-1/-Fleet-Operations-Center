// tests/auth-propagation-supervisor.test.js — supervisor extensions behind
// auth.propagation (design 3.1-3.3, 6.1; findings F1, F4, F5, F9 supervisor side).
// Dependency injection only (_setDeps / _setTimers); no vi.mock.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');
const ar = require('../src/auth/auth-report');

afterEach(() => { sup._reset(); ar._reset(); });

const MIN = 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }

function setup(o = {}) {
  const log = [];
  const clock = { t: Date.parse('2026-11-04T12:00:00.000Z') };
  const timers = { live: new Map(), seq: 0, immediates: [] };
  const w = {
    log, clock, timers,
    smoke: o.smoke || 'unauth',
    ladder: o.ladder || (async () => ({ recovered: false, rung: 'silent', prompted: false })),
    aea: 'aea' in o ? o.aea : 7,
    offline: false, probe: false,
    mwinit: o.mwinit || (async () => undefined),
  };
  const deps = {
    now: () => clock.t,
    isOffline: () => w.offline,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }),
    aapApi: {
      getUserDetails: async () => {
        log.push('smoke');
        const s = typeof w.smoke === 'function' ? await w.smoke() : w.smoke;
        if (s === 'ok') return { alias: 'tester' };
        if (s === '500') throw Object.assign(new Error('AAP API 500: boom'), { status: 500 });
        throw Object.assign(new Error('AAP API 401'), { code: 'MIDWAY_SESSION_INVALID', status: 401 });
      },
    },
    auth: {
      probeSession: async () => { log.push('probe'); return w.probe; },
      checkMwinit: () => ({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 }),
      recoverAuth: async (reason, opts) => { log.push('recoverAuth:' + reason); return w.ladder(reason, opts); },
      aeaSessionExpiryMin: async () => { log.push('aea'); return typeof w.aea === 'function' ? w.aea() : w.aea; },
      runMwinit: async () => { log.push('runMwinit'); const r = await w.mwinit(); log.push('runMwinit:resolved'); return r; },
      injectCookies: async () => { log.push('injectCookies'); },
      refreshAeaViaMwinit: async () => { log.push('refreshAeaViaMwinit'); return true; },
    },
  };
  if (o.propagation !== null) deps.propagation = o.propagation === undefined ? true : o.propagation;
  sup._setDeps(deps);
  sup._setTimers({
    set: (fn, ms) => { const h = { id: ++timers.seq, ms }; timers.live.set(h.id, { fn, ms, h }); return h; },
    clear: (h) => { if (h) timers.live.delete(h.id); },
    immediate: (fn) => { timers.immediates.push(fn); },
  });
  w.flush = () => { while (timers.immediates.length) timers.immediates.shift()(); };
  w.retryTimers = () => [...timers.live.values()].filter((t) => t.ms < 20 * MIN);
  w.signalTimers = () => [...timers.live.values()].filter((t) => t.ms === 30 * MIN);
  w.fire = async (t) => { timers.live.delete(t.h.id); await t.fn(); };
  return w;
}

const AUTH_FAIL = { ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' };
const AUTH_OK = { ok: true, source: 'aap-api' };

async function toCooldown(w, passes = 1) {
  w.smoke = 'unauth';
  for (let i = 0; i < passes; i++) await sup.ensureHealthy({ reason: 'test' });
  expect(sup.getState()).toBe('COOLDOWN');
}
async function toHealthy(w) {
  w.smoke = 'ok';
  await sup.ensureHealthy({ reason: 'test' });
  expect(sup.getState()).toBe('HEALTHY');
}
async function toState(w, state) {
  if (state === 'UNKNOWN') return;
  if (state === 'COOLDOWN') return toCooldown(w);
  if (state === 'WAITING_FOR_USER') {
    w.smoke = 'unauth';
    w.ladder = async () => ({ recovered: false, rung: 'mwinit', sessionInvalid: true, prompted: false });
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getState()).toBe('WAITING_FOR_USER');
    return;
  }
  if (state === 'DEGRADED') {
    await toHealthy(w);
    sup.noteApiOutcome(AUTH_FAIL);
    expect(sup.getState()).toBe('DEGRADED');
    return;
  }
  if (state === 'OFFLINE') {
    w.offline = true;
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getState()).toBe('OFFLINE');
    w.offline = false;
  }
}

// ── F4: cycle-free require order, flag read at call time ────────────────────
describe('F4: auth-report <-> supervisor require cycle', () => {
  const supPath = require.resolve('../src/auth/midway-health-supervisor');
  const arPath = require.resolve('../src/auth/auth-report');
  function withFreshCache(order, fn) {
    const saved = { s: require.cache[supPath], a: require.cache[arPath] };
    try {
      delete require.cache[supPath]; delete require.cache[arPath];
      const mods = {};
      for (const k of order) mods[k] = require(k === 'ar' ? arPath : supPath);
      fn(mods.ar, mods.sup);
      mods.sup._reset(); mods.ar._reset();
    } finally { require.cache[supPath] = saved.s; require.cache[arPath] = saved.a; }
  }
  function assertFunctional(a2, s2) {
    expect(a2).not.toBe(ar);
    expect(s2).not.toBe(sup);
    expect(a2.isEnabled()).toBe(false);              // env FLEET_AUTH_PROPAGATION=0
    expect(a2.currentStatus()).toBeNull();
    a2._setEnabledForTest(true);
    expect(a2.isEnabled()).toBe(true);
    expect(s2.getStatus()).toMatchObject({ v: 1, state: 'UNKNOWN', level: 'unknown' });
    expect(a2.currentStatus()).toMatchObject({ v: 1, state: 'UNKNOWN' });
    s2._setTimers({ immediate: () => {} });
    expect(s2.noteEvidence({ sessionMin: 5 }).handled).toBe(true);   // supervisor sees the fresh auth-report flag
  }

  it('F4: requiring auth-report first then the supervisor (fresh require.cache) leaves isEnabled and getStatus functional', () => {
    withFreshCache(['ar', 'sup'], assertFunctional);
  });

  it('F4: requiring the supervisor first then auth-report', () => {
    withFreshCache(['sup', 'ar'], assertFunctional);
  });

  it('F4: flag read at call time (_setEnabledForTest toggles behavior without re-require)', () => {
    setup({ propagation: null });                    // no _deps.propagation override
    expect(sup.noteEvidence({ sessionMin: 1 })).toEqual({ handled: false });
    ar._setEnabledForTest(true);
    expect(sup.noteEvidence({ sessionMin: 1 }).handled).toBe(true);
    ar._setEnabledForTest(false);
    expect(sup.noteEvidence({ sessionMin: 1 })).toEqual({ handled: false });
  });

  it('F4: auth-report has no top-level require of the supervisor', () => {
    const src = fs.readFileSync(arPath, 'utf8');
    const lines = src.split(/\r?\n/).filter((l) => l.includes("require('./midway-health-supervisor')"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^function _sup\(\)/);
    const supSrc = fs.readFileSync(supPath, 'utf8');
    expect(supSrc).not.toMatch(/^(const|let|var)\s+\w+\s*=\s*require\('\.\/auth-report'\)/m);
  });
});

// ── noteApiOutcome (design 3.3) ─────────────────────────────────────────────
describe('noteApiOutcome', () => {
  for (const state of ['COOLDOWN', 'WAITING_FOR_USER', 'DEGRADED', 'UNKNOWN', 'OFFLINE']) {
    it(`observed success in ${state} -> HEALTHY with verifiedBy api:aap-api`, async () => {
      const w = setup();
      await toState(w, state);
      if (state === 'DEGRADED') expect(w.retryTimers()).toHaveLength(1);
      const r = sup.noteApiOutcome(AUTH_OK);
      expect(r).toEqual({ handled: true, transitioned: true });
      expect(sup.getState()).toBe('HEALTHY');
      expect(w.retryTimers()).toHaveLength(0);
      const st = sup.getStatus();
      expect(st.verifiedBy).toBe('api:aap-api');
      expect(st.level).toBe('ok');
      expect(st.lastApiOkAt).toBe(new Date(w.clock.t).toISOString());
      expect(sup.getSnapshot().aapApiSmokeTest).toEqual({ ok: true, status: 200, via: 'observed-traffic' });
      expect(sup.getHistory()[0]).toMatchObject({ reason: 'api:aap-api', initialState: state, result: 'HEALTHY' });
    });
  }

  it('success while HEALTHY only updates lastApiOkAt and emits nothing', async () => {
    const w = setup();
    await toHealthy(w);
    w.flush();
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    w.clock.t += 1000;
    expect(sup.noteApiOutcome(AUTH_OK)).toEqual({ handled: true, transitioned: false });
    w.flush();
    expect(seen).toEqual([]);
    expect(sup.getStatus().lastApiOkAt).toBe(new Date(w.clock.t).toISOString());
  });

  it('success while a recovery is in flight is evidence only', async () => {
    const w = setup();
    const gate = deferred();
    w.smoke = async () => { await gate.p; return 'unauth'; };
    const pass = sup.ensureHealthy({ reason: 'test' });
    await settle(2);
    const r = sup.noteApiOutcome(AUTH_OK);
    expect(r).toEqual({ handled: false, reason: 'in-flight' });
    expect(sup.getState()).toBe('UNKNOWN');
    expect(sup.getStatus().lastApiOkAt).not.toBeNull();
    gate.resolve(); w.smoke = 'unauth';
    await pass;
    expect(sup.getState()).toBe('COOLDOWN');
  });

  it('auth failure in HEALTHY -> DEGRADED with exactly one retry timer', async () => {
    const w = setup();
    await toHealthy(w);
    expect(sup.noteApiOutcome(AUTH_FAIL)).toEqual({ handled: true, transitioned: true });
    expect(sup.getState()).toBe('DEGRADED');
    expect(w.retryTimers()).toHaveLength(1);
    expect(sup.noteApiOutcome({ ok: false, err: { status: 403 }, source: 'aap-api' })).toEqual({ handled: true, transitioned: false });
    expect(w.retryTimers()).toHaveLength(1);
    expect(sup.getStatus().failClass).toBe('AAP_API_UNAUTHORIZED');
  });

  it('auth failure in UNKNOWN -> DEGRADED; in COOLDOWN evidence only', async () => {
    const w = setup();
    sup.noteApiOutcome({ ok: false, err: { status: 401 }, source: 'aap-api' });
    expect(sup.getState()).toBe('DEGRADED');
    sup._reset(); const w2 = setup();
    await toCooldown(w2);
    const before = w2.retryTimers().length;
    expect(sup.noteApiOutcome(AUTH_FAIL).transitioned).toBe(false);
    expect(sup.getState()).toBe('COOLDOWN');
    expect(w2.retryTimers()).toHaveLength(before);
    expect(w.log).toEqual([]);
  });

  it('5xx, network errors and offline are ignored', async () => {
    const w = setup();
    await toHealthy(w);
    expect(sup.noteApiOutcome({ ok: false, err: { status: 500 }, source: 'aap-api' }).handled).toBe(false);
    expect(sup.noteApiOutcome({ ok: false, err: { code: 'AAP_API_LOAD_FAILED' }, source: 'aap-api' }).handled).toBe(false);
    expect(sup.noteApiOutcome({ ok: false, source: 'aap-api' }).handled).toBe(false);
    w.offline = true;
    expect(sup.noteApiOutcome(AUTH_FAIL)).toEqual({ handled: false, reason: 'offline' });
    expect(sup.getState()).toBe('HEALTHY');
    expect(w.retryTimers()).toHaveLength(0);
    sup._reset(); const w2 = setup();
    await toCooldown(w2);
    w2.offline = true;
    expect(sup.noteApiOutcome(AUTH_OK)).toEqual({ handled: false, reason: 'offline' });
    expect(sup.getState()).toBe('COOLDOWN');
  });

  it('MIDWAY_STEPUP_REQUIRED handed to noteApiOutcome is ignored', async () => {
    const w = setup();
    await toHealthy(w);
    expect(sup.noteApiOutcome({ ok: false, err: { code: 'MIDWAY_STEPUP_REQUIRED' }, source: 'rca' }).handled).toBe(false);
    expect(sup.getState()).toBe('HEALTHY');
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('never awaits recovery: returns synchronously and runs no smoke test or ladder', async () => {
    const w = setup();
    await toHealthy(w);
    w.log.length = 0;
    const r = sup.noteApiOutcome(AUTH_FAIL);
    expect(r && typeof r.then).toBe('undefined');
    await settle();
    expect(w.log).toEqual([]);
  });

  it('bad input and shutting down are not handled', async () => {
    setup();
    expect(sup.noteApiOutcome({ ok: 'yes' }).handled).toBe(false);
    expect(sup.noteApiOutcome(null).handled).toBe(false);
    sup.shutdown();
    expect(sup.noteApiOutcome(AUTH_FAIL)).toEqual({ handled: false, reason: 'shutting-down' });
  });
});

// ── Step-up counter (awaited aeaSessionExpiryMin) ───────────────────────────
describe('step-up counter', () => {
  it('two class-B passes with a live AEA (async 7) set stepUp and failClass STEP_UP_REQUIRED', async () => {
    const w = setup({ aea: async () => 7 });
    await toCooldown(w, 1);
    expect(sup.getStatus().stepUp).toBe(false);
    const r = await sup.ensureHealthy({ reason: 'test' });
    expect(r.stepUp).toBe(true);
    const st = sup.getStatus();
    expect(st).toMatchObject({ stepUp: true, failClass: 'STEP_UP_REQUIRED', action: 'mwinit', level: 'warn' });
    expect(st.evidence.liveAeaMin).toBe(7);
    expect(w.log.filter((x) => x === 'aea')).toHaveLength(2);
  });

  it('a resolved-null live AEA is not counted', async () => {
    const w = setup({ aea: async () => null });
    await toCooldown(w, 3);
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('a rejecting live AEA read is not counted', async () => {
    const w = setup({ aea: async () => { throw new Error('agent hung'); } });
    await toCooldown(w, 3);
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('sessionInvalid ladder is not counted and resets the counter', async () => {
    const w = setup();
    await toCooldown(w, 1);
    w.ladder = async () => ({ recovered: false, rung: 'mwinit', sessionInvalid: true });
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getState()).toBe('WAITING_FOR_USER');
    w.ladder = async () => ({ recovered: false, rung: 'silent' });
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getStatus().stepUp).toBe(false);       // counter restarted at 1
  });

  it('a rung error is not counted', async () => {
    const w = setup();
    await toCooldown(w, 1);
    w.ladder = async () => { throw new Error('spawn failed'); };
    await sup.ensureHealthy({ reason: 'test' });
    w.ladder = async () => ({ recovered: false, rung: 'silent' });
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('a server error pass is not counted', async () => {
    const w = setup();
    await toCooldown(w, 1);
    w.smoke = '500';
    await sup.ensureHealthy({ reason: 'test' });
    expect(sup.getState()).toBe('DEGRADED');
    expect(sup.getStatus().stepUp).toBe(false);
    expect(w.log.filter((x) => x === 'aea')).toHaveLength(1);
  });

  it('HEALTHY resets the counter', async () => {
    const w = setup();
    await toCooldown(w, 1);
    await toHealthy(w);
    await toCooldown(w, 1);
    expect(sup.getStatus().stepUp).toBe(false);
  });
});

// ── Event delivery ──────────────────────────────────────────────────────────
describe('subscribe / async delivery', () => {
  it('delivery is asynchronous, in order, with the status computed at flush time', async () => {
    const w = setup();
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    await sup.ensureHealthy({ reason: 'test' });
    expect(seen).toEqual([]);
    expect(w.timers.immediates).toHaveLength(1);       // one flush scheduled
    w.flush();
    expect(seen.map((e) => [e.type, e.from, e.to])).toEqual([
      ['state', 'UNKNOWN', 'DEGRADED'], ['state', 'DEGRADED', 'RECOVERING'], ['state', 'RECOVERING', 'COOLDOWN'],
    ]);
    for (const e of seen) { expect(e.status.state).toBe('COOLDOWN'); expect(e.cause).toBe('test'); }
  });

  it('consecutive identical (to, stepUp) events collapse into one', async () => {
    const w = setup();
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    sup.noteEvidence({ sessionMin: 1 });
    sup.noteEvidence({ sessionMin: 2 });
    w.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].status.evidence.sessionMin).toBe(2);
  });

  it('a throwing listener is isolated and kept', async () => {
    const w = setup();
    const seen = [];
    let threw = 0;
    sup.subscribe(() => { threw++; throw new Error('listener boom'); });
    sup.subscribe((e) => seen.push(e.type));
    sup.noteEvidence({ sessionMin: 1 });
    expect(() => w.flush()).not.toThrow();
    sup.noteEvidence({ sessionMin: 2, online: true });
    sup.noteApiOutcome(AUTH_FAIL);                     // UNKNOWN -> DEGRADED
    w.flush();
    expect(threw).toBe(3);
    expect(seen).toEqual(['evidence', 'evidence', 'state']);
  });

  it('unsubscribe stops delivery; non-function subscribe is a no-op', async () => {
    const w = setup();
    const seen = [];
    const off = sup.subscribe((e) => seen.push(e));
    expect(typeof sup.subscribe(42)).toBe('function');
    off();
    sup.noteEvidence({ sessionMin: 1 });
    w.flush();
    expect(seen).toEqual([]);
  });

  it('noteEvidence validates numbers', () => {
    setup();
    sup.noteEvidence({ sessionMin: 'x', diskAeaMin: Infinity, liveAeaMin: 4, aeaCountToMidway: 2, online: 'y' });
    expect(sup.getStatus().evidence).toMatchObject({ sessionMin: null, diskAeaMin: null, liveAeaMin: 4, aeaCountToMidway: 2, online: null });
  });
});

// ── F5 ──────────────────────────────────────────────────────────────────────
describe('F5: noteStepUpSignal', () => {
  it('F5: noteStepUpSignal in COOLDOWN emits exactly one stepup event immediately', async () => {
    const w = setup();
    await toCooldown(w);
    w.flush();
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    expect(sup.noteStepUpSignal({ source: 'rca' }).handled).toBe(true);
    w.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('stepup');
    expect(seen[0].status.stepUp).toBe(true);
    expect(sup.getState()).toBe('COOLDOWN');
    expect(w.signalTimers()).toHaveLength(1);
  });

  it('F5: noteStepUpSignal while HEALTHY emits nothing and leaves stepUp false', async () => {
    const w = setup();
    await toHealthy(w);
    w.flush();
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    sup.noteStepUpSignal({ source: 'rca' });
    w.flush();
    expect(seen).toEqual([]);
    expect(sup.getState()).toBe('HEALTHY');
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('F5: lapse timer firing emits a stepup event and stepUp becomes false', async () => {
    const w = setup();
    await toCooldown(w);
    sup.noteStepUpSignal({ source: 'rca' });
    w.flush();
    expect(sup.getStatus().stepUp).toBe(true);
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    w.clock.t += 30 * MIN;
    await w.fire(w.signalTimers()[0]);
    w.flush();
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('stepup');
    expect(seen[0].status.stepUp).toBe(false);
    expect(sup.getStatus().stepUp).toBe(false);
  });

  it('a HEALTHY transition clears the signal timer', async () => {
    const w = setup();
    await toCooldown(w);
    sup.noteStepUpSignal({ source: 'rca' });
    expect(w.signalTimers()).toHaveLength(1);
    sup.noteApiOutcome(AUTH_OK);
    expect(w.signalTimers()).toHaveLength(0);
  });
});

// ── Throttle (D6) ───────────────────────────────────────────────────────────
describe('ensureHealthyConverging throttle', () => {
  it('COOLDOWN + data-source-* + armed future retry -> deferred without a pass', async () => {
    const w = setup();
    await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
    expect(sup.getState()).toBe('COOLDOWN');
    expect(w.retryTimers()).toHaveLength(1);
    for (const reason of ['data-source-api-load', 'data-source-legacy']) {
      w.log.length = 0;
      const r = await sup.ensureHealthyConverging({ reason, allowPrompt: true });
      expect(r).toMatchObject({ ok: false, deferred: true, rung: 'deferred', state: 'COOLDOWN', reason: 'auth recovery backoff in effect', latencyMs: 0 });
      expect(r.nextRetryAt).toBeTruthy();
      expect(w.log).toEqual([]);
    }
  });

  it('ui:*, reconnect, aea-captured, heartbeat, startup, post-reauth, monitor are never throttled', async () => {
    for (const reason of ['ui:retry', 'ui:run-mwinit-stepup', 'reconnect', 'aea-captured', 'heartbeat:session-expired', 'startup', 'post-reauth', 'monitor:degraded']) {
      sup._reset();
      const w = setup();
      await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
      w.log.length = 0;
      const r = await sup.ensureHealthyConverging({ reason, allowPrompt: false });
      expect(r.deferred).toBeUndefined();
      expect(w.log).toContain('smoke');
    }
  });

  it('not throttled without an armed retry, outside COOLDOWN, or with the flag off', async () => {
    let w = setup();
    await sup.ensureHealthy({ reason: 'test' });          // COOLDOWN, no timer
    w.log.length = 0;
    expect((await sup.ensureHealthyConverging({ reason: 'data-source-api-load' })).deferred).toBeUndefined();
    sup._reset(); w = setup();
    await toState(w, 'DEGRADED');                          // DEGRADED with a timer
    expect((await sup.ensureHealthyConverging({ reason: 'data-source-api-load' })).deferred).toBeUndefined();
    sup._reset(); w = setup({ propagation: false });
    await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
    expect(w.retryTimers()).toHaveLength(1);
    expect((await sup.ensureHealthyConverging({ reason: 'data-source-api-load' })).deferred).toBeUndefined();
  });

  it('auto-retry is not throttled (timer calls ensureHealthy directly)', async () => {
    const w = setup();
    await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
    w.log.length = 0;
    await w.fire(w.retryTimers()[0]);
    expect(w.log).toContain('recoverAuth:auto-retry#1');
    expect(w.retryTimers()).toHaveLength(1);              // re-armed once
  });
});

// ── F9 (supervisor side) ────────────────────────────────────────────────────
describe('F9: stepUpMwinitAt', () => {
  it('F9: after a failed full sign-in the status action is wait for 30 min then returns to mwinit', async () => {
    const w = setup();
    await toCooldown(w, 2);
    expect(sup.getStatus()).toMatchObject({ stepUp: true, action: 'mwinit' });
    const r = await sup.ensureHealthyFullSignIn();
    expect(r.ok).toBe(false);
    expect(sup.getState()).toBe('COOLDOWN');
    expect(sup.getStatus()).toMatchObject({
      stepUp: true, level: 'warn', action: 'wait',
      message: 'Full sign-in completed; Midway is still rejecting. Retrying automatically.',
    });
    w.clock.t += 29 * MIN;
    expect(sup.getStatus().action).toBe('wait');
    w.clock.t += 1 * MIN;
    expect(sup.getStatus().action).toBe('mwinit');
  });

  it('F9: HEALTHY transition clears stepUpMwinitAt', async () => {
    const w = setup();
    await toCooldown(w, 2);
    await sup.ensureHealthyFullSignIn();
    expect(sup.getStatus().action).toBe('wait');
    sup.noteApiOutcome(AUTH_OK);
    expect(sup.getState()).toBe('HEALTHY');
    await toCooldown(w, 2);                              // a fresh wall within the 30 min
    expect(sup.getStatus()).toMatchObject({ stepUp: true, action: 'mwinit' });
  });
});

// ── F1 (supervisor level) ───────────────────────────────────────────────────
describe('F1: ensureHealthyFullSignIn', () => {
  it('F1: waits for an in-flight pass and runMwinit starts only after it settles', async () => {
    const w = setup();
    const gate = deferred();
    let mwinitDone = false;
    w.mwinit = async () => { mwinitDone = true; };
    w.smoke = () => (mwinitDone ? 'ok' : 'unauth');
    w.ladder = async () => { await gate.p; w.log.push('ladder:settled'); return { recovered: false, rung: 'silent' }; };
    const pass = sup.ensureHealthy({ reason: 'auto-retry#1', allowPrompt: false });
    await settle(2);
    const full = sup.ensureHealthyFullSignIn();
    await settle();
    expect(w.log).not.toContain('runMwinit');
    gate.resolve();
    expect((await pass).state).toBe('COOLDOWN');
    const r = await full;
    expect(w.log.indexOf('ladder:settled')).toBeLessThan(w.log.indexOf('runMwinit'));
    expect(r).toMatchObject({ ok: true, verified: true, rung: 'mwinit', prompted: true, state: 'HEALTHY' });
  });

  it('F1: auto-retry timer, data-source-api-load and ui:retry coalesce while runMwinit is pending', async () => {
    const w = setup();
    await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
    const retry = w.retryTimers()[0];
    const gate = deferred();
    w.mwinit = () => gate.p;
    w.log.length = 0;
    const full = sup.ensureHealthyFullSignIn();
    await settle();
    expect(w.log).toEqual(['runMwinit']);
    expect(w.retryTimers()).toHaveLength(0);              // cleared before the pass
    const others = [
      retry.fn(),                                          // a timer callback that already fired
      sup.ensureHealthyConverging({ reason: 'data-source-api-load', allowPrompt: true }),
      sup.ensureHealthyConverging({ reason: 'ui:retry', allowPrompt: false }),
    ];
    await settle();
    expect(w.log).toEqual(['runMwinit']);                  // no second pass, no ladder
    w.smoke = 'ok';
    gate.resolve();
    const r = await full;
    const rs = await Promise.all(others);
    expect(rs[1]).toMatchObject({ coalesced: true, ok: true, rung: 'mwinit' });
    expect(rs[2]).toMatchObject({ coalesced: true, ok: true, rung: 'mwinit' });
    expect(r.coalesced).toBeUndefined();
    expect(w.log.filter((x) => x.startsWith('recoverAuth'))).toEqual([]);
    expect(w.log.filter((x) => x === 'runMwinit')).toHaveLength(1);
  });

  it('F1: recoverAuth and refreshAeaViaMwinit are never called during the full sign-in', async () => {
    const w = setup();
    await toCooldown(w, 2);
    w.log.length = 0;
    await sup.ensureHealthyFullSignIn();
    expect(w.log.some((x) => x.startsWith('recoverAuth') || x === 'refreshAeaViaMwinit')).toBe(false);
    expect(w.log).toEqual(['runMwinit', 'runMwinit:resolved', 'injectCookies', 'smoke', 'probe']);
  });

  it('F1: result comes from a verify that ran after runMwinit resolved and is never coalesced', async () => {
    const w = setup();
    let mwinitDone = false;
    w.mwinit = async () => { mwinitDone = true; };
    w.smoke = () => (mwinitDone ? 'ok' : 'unauth');
    const r = await sup.ensureHealthyFullSignIn();
    expect(w.log.indexOf('runMwinit:resolved')).toBeLessThan(w.log.indexOf('smoke'));
    expect(r).toMatchObject({ ok: true, verified: true, state: 'HEALTHY', rung: 'mwinit' });
    expect('coalesced' in r).toBe(false);
    expect(sup.getStatus().verifiedBy).toBe('ladder:mwinit');
    expect(sup.getHistory()[0]).toMatchObject({ reason: 'ui:run-mwinit-stepup', attempts: ['mwinit'], result: 'HEALTHY' });
    const again = await Promise.all([sup.ensureHealthyFullSignIn(), sup.ensureHealthyFullSignIn()]);
    for (const x of again) expect(x.coalesced).toBeUndefined();
  });

  it('F1: failure re-arms exactly one retry timer', async () => {
    const w = setup();
    await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
    expect(w.retryTimers()).toHaveLength(1);
    const r = await sup.ensureHealthyFullSignIn();
    expect(r.ok).toBe(false);
    expect(sup.getState()).toBe('COOLDOWN');
    expect(w.retryTimers()).toHaveLength(1);
    expect(r.nextRetryAt).toBeTruthy();
  });

  it('F1: runMwinit rejection returns mwinit-failed with no verify and no second spawn', async () => {
    const w = setup();
    await toCooldown(w, 2);
    w.mwinit = async () => { throw new Error('mwinit timed out'); };
    w.log.length = 0;
    const r = await sup.ensureHealthyFullSignIn();
    expect(r).toMatchObject({ ok: false, rung: 'mwinit', prompted: true, verified: false, reason: 'mwinit-failed' });
    expect(w.log).toEqual(['runMwinit']);
    expect(w.retryTimers()).toHaveLength(1);
    expect(sup.getStatus().action).toBe('mwinit');         // F9 window not opened by a failed spawn
  });

  it('F1: offline skip returns reason offline with no verify', async () => {
    const w = setup();
    await toCooldown(w, 2);
    w.mwinit = async () => ({ skipped: 'offline' });
    w.log.length = 0;
    const r = await sup.ensureHealthyFullSignIn();
    expect(r).toMatchObject({ ok: false, reason: 'offline', verified: false });
    expect(w.log).toEqual(['runMwinit', 'runMwinit:resolved']);
  });

  it('STATE enum unchanged', () => {
    expect(sup.STATE).toEqual({
      UNKNOWN: 'UNKNOWN', HEALTHY: 'HEALTHY', DEGRADED: 'DEGRADED', RECOVERING: 'RECOVERING',
      WAITING_FOR_USER: 'WAITING_FOR_USER', COOLDOWN: 'COOLDOWN', OFFLINE: 'OFFLINE', FAILED: 'FAILED',
    });
    expect(sup.FAIL.STEP_UP_REQUIRED).toBe('STEP_UP_REQUIRED');
  });

  it('flag off never calls aeaSessionExpiryMin or the immediate timer', async () => {
    const w = setup({ propagation: false });
    await toCooldown(w, 3);
    sup.noteEvidence({ sessionMin: 1 });
    expect(w.log).not.toContain('aea');
    expect(w.timers.immediates).toEqual([]);
  });

  it('_reset clears status state and listeners', async () => {
    const w = setup();
    await toCooldown(w, 2);
    sup.noteStepUpSignal({ source: 'rca' });
    const seen = [];
    sup.subscribe((e) => seen.push(e));
    sup._reset();
    const w2 = setup();
    expect(sup.getStatus()).toMatchObject({ state: 'UNKNOWN', stepUp: false, failClass: null, verifiedBy: null, lastApiOkAt: null });
    sup.noteEvidence({ sessionMin: 1 });
    w2.flush();
    expect(seen).toEqual([]);
    expect(w.signalTimers()).toHaveLength(0);              // lapse timer cleared through the injected clear
  });
});
