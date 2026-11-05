// tests/auth-propagation-flag-off.test.js — flag-off golden trace for the
// Midway health supervisor (auth.propagation plan item 1).
//
// The expected trace below was HAND-WRITTEN from reading _runEnsureHealthy /
// ensureHealthyConverging / _scheduleRetry at d8ac226 and verified green
// against the UNMODIFIED supervisor before any source edit. With the
// auth.propagation flag OFF the supervisor must keep producing exactly this
// trace (call sequence, state at each call, results, history, snapshot).
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => sup._reset());

// Replace non-deterministic values (timings, timestamps) with type markers.
function norm(v) {
  if (Array.isArray(v)) return v.map(norm);
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) {
    const x = v[k];
    if ((k === 'latencyMs' || k === 'durationMs') && typeof x === 'number') o[k] = '#num';
    else if ((k === 'at' || k === 'nextRetryAt') && typeof x === 'string' && !Number.isNaN(Date.parse(x))) o[k] = '#iso';
    else o[k] = norm(x);
  }
  return o;
}

function makeWorld() {
  const calls = [];
  const smoke = [];
  const handles = [];
  const unauth = () => Object.assign(new Error('AAP API 401'), { code: 'MIDWAY_SESSION_INVALID', status: 401 });
  const auth = {
    probeSession: async () => { calls.push(['probeSession', sup.getState()]); return false; },
    checkMwinit: () => { calls.push(['checkMwinit', sup.getState()]); return { ok: true, expiresInMin: 600, aeaExpiresInMin: 30 }; },
    recoverAuth: async (reason, o) => { calls.push(['recoverAuth', sup.getState(), reason, o]); return { recovered: true, rung: 'silent', prompted: false }; },
    aeaSessionExpiryMin: async () => { calls.push(['aeaSessionExpiryMin']); return 7; },
    runMwinit: async () => { calls.push(['runMwinit']); },
    injectCookies: async () => { calls.push(['injectCookies']); },
    refreshAeaViaMwinit: async () => { calls.push(['refreshAeaViaMwinit']); return true; },
  };
  const aapApi = {
    getUserDetails: async () => {
      calls.push(['getUserDetails', sup.getState()]);
      if (smoke.shift() === 'ok') return { alias: 'tester' };
      throw unauth();
    },
  };
  const immediates = [];
  sup._setDeps({
    isOffline: () => false,
    checkVpnState: async () => { calls.push(['checkVpnState']); return { connected: false, status: 'disconnected' }; },
    aapApi, auth,
  });
  sup._setTimers({
    set: (fn, ms) => { const h = { id: handles.length + 1 }; handles.push({ h, fn, ms }); calls.push(['timer.set', h.id]); return h; },
    clear: (h) => { calls.push(['timer.clear', h && h.id]); },
    immediate: (fn) => { immediates.push(fn); },
  });
  return { calls, smoke, handles, immediates };
}

// Scripted scenario: verify OK -> auth failure -> ladder fails -> data-source-api-load again -> success.
async function runScenario(w, hooks = {}) {
  const results = [];
  const states = [];
  w.smoke.push('ok');
  results.push(await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false }));
  states.push(sup.getState());
  if (hooks.afterA) await hooks.afterA();
  w.smoke.push('401', '401');
  results.push(await sup.ensureHealthyConverging({ reason: 'data-source-api-load', allowPrompt: true }));
  states.push(sup.getState());
  if (hooks.afterB) await hooks.afterB();
  w.smoke.push('ok');
  results.push(await sup.ensureHealthyConverging({ reason: 'data-source-api-load', allowPrompt: true }));
  states.push(sup.getState());
  if (hooks.afterC) await hooks.afterC();
  return { results: norm(results), states, history: norm(sup.getHistory()), snapshot: norm(sup.getSnapshot()) };
}

const GOLDEN = {
  calls: [
    // A: startup, rung-0 verify OK
    ['getUserDetails', 'UNKNOWN'],
    ['checkMwinit', 'HEALTHY'],
    ['checkVpnState'],
    // B: data-source-api-load, 401 -> DEGRADED -> RECOVERING -> ladder 'silent' -> still 401 -> COOLDOWN
    ['getUserDetails', 'HEALTHY'],
    ['probeSession', 'HEALTHY'],
    ['recoverAuth', 'RECOVERING', 'data-source-api-load', { allowPrompt: true }],
    ['getUserDetails', 'RECOVERING'],
    ['probeSession', 'RECOVERING'],
    ['checkMwinit', 'COOLDOWN'],
    ['checkVpnState'],
    ['timer.set', 1],
    // C: data-source-api-load again, rung-0 verify OK -> HEALTHY, retry timer cleared
    ['getUserDetails', 'COOLDOWN'],
    ['checkMwinit', 'HEALTHY'],
    ['checkVpnState'],
    ['timer.clear', 1],
  ],
  states: ['HEALTHY', 'COOLDOWN', 'HEALTHY'],
  results: [
    { ok: true, state: 'HEALTHY', recovered: false, rung: 'verify', prompted: false, verified: true, via: ['aap-api-smoke'], latencyMs: '#num', nextRetryAt: null },
    { ok: false, state: 'COOLDOWN', recovered: false, rung: 'silent', prompted: false, verified: false, class: 'AAP_API_UNAUTHORIZED', requiresUser: false, reason: 'AAP still AAP_API_UNAUTHORIZED', latencyMs: '#num', nextRetryAt: '#iso' },
    { ok: true, state: 'HEALTHY', recovered: false, rung: 'verify', prompted: false, verified: true, via: ['aap-api-smoke'], latencyMs: '#num', nextRetryAt: null },
  ],
  history: [
    { at: '#iso', reason: 'data-source-api-load', initialState: 'DEGRADED', attempts: ['silent'], result: 'COOLDOWN', verifiedBy: [], ladderReported: true, durationMs: '#num' },
  ],
  snapshot: {
    state: 'HEALTHY', at: '#iso',
    internet: { online: true },
    vpn: { connected: false, status: 'disconnected', required: false },
    diskSession: { present: true, expiresInMin: 600 },
    diskAea: { present: true, expiresInMin: 30 },
    aapApiSmokeTest: { ok: true, status: 200, latencyMs: '#num', class: null },
    aapProbe: null,
    lastRecovery: null,
    nextRetryAt: null,
  },
};

describe('auth.propagation flag OFF: supervisor golden trace', () => {
  it('scripted scenario reproduces the hand-written golden trace', async () => {
    const w = makeWorld();
    const out = await runScenario(w);
    expect(w.calls).toEqual(GOLDEN.calls);
    expect(out.states).toEqual(GOLDEN.states);
    expect(out.results).toEqual(GOLDEN.results);
    expect(out.history).toEqual(GOLDEN.history);
    expect(out.snapshot).toEqual(GOLDEN.snapshot);
    // The one retry timer is the first 30 s backoff step (+-15% jitter).
    expect(w.handles).toHaveLength(1);
    expect(w.handles[0].ms).toBeGreaterThanOrEqual(25500);
    expect(w.handles[0].ms).toBeLessThanOrEqual(34500);
  });

  // Added with the supervisor extensions (plan item 6). The GOLDEN above is unchanged.
  it('new entry points called with the flag OFF leave the golden trace unchanged', async () => {
    const ar = require('../src/auth/auth-report');
    expect(ar.isEnabled()).toBe(false);          // real flag path: env FLEET_AUTH_PROPAGATION=0 (tests/setup)
    const w = makeWorld();
    const seen = [];
    const unsub = sup.subscribe((e) => seen.push(e));
    const poke = () => {
      expect(sup.noteApiOutcome({ ok: true, source: 'aap-api' })).toEqual({ handled: false });
      expect(sup.noteApiOutcome({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' })).toEqual({ handled: false });
      expect(sup.noteStepUpSignal({ source: 'rca' })).toEqual({ handled: false });
      expect(sup.noteEvidence({ sessionMin: 10, liveAeaMin: 5, online: true })).toEqual({ handled: false });
      ar.report({ ok: true, source: 'aap-api' });
      ar.reportStepUp({ source: 'rca' });
      expect(ar.currentStatus()).toBeNull();
    };
    const out = await runScenario(w, { afterA: poke, afterB: poke, afterC: poke });
    await new Promise((r) => setImmediate(r));
    unsub();
    expect(w.calls).toEqual(GOLDEN.calls);
    expect(out.states).toEqual(GOLDEN.states);
    expect(out.results).toEqual(GOLDEN.results);
    for (const r of out.results) expect('stepUp' in r).toBe(false);   // no additive field flag off
    expect(out.history).toEqual(GOLDEN.history);
    expect(out.snapshot).toEqual(GOLDEN.snapshot);
    expect(w.handles).toHaveLength(1);               // no step-up lapse timer
    expect(seen).toEqual([]);                        // no events delivered
    expect(w.immediates).toEqual([]);                // setImmediate delivery never used
    expect(w.calls.some((c) => c[0] === 'aeaSessionExpiryMin')).toBe(false);
  });

  it('flag OFF: ensureHealthyFullSignIn is the legacy ui:run-mwinit allowPrompt:true pass', async () => {
    const w = makeWorld();
    w.smoke.push('401', '401');
    const r = await sup.ensureHealthyFullSignIn();
    expect(w.calls.find((c) => c[0] === 'recoverAuth')).toEqual(['recoverAuth', 'RECOVERING', 'ui:run-mwinit', { allowPrompt: true }]);
    expect(w.calls.some((c) => c[0] === 'runMwinit' || c[0] === 'aeaSessionExpiryMin')).toBe(false);
    expect(r.state).toBe('COOLDOWN');
    expect('stepUp' in r).toBe(false);
    expect(w.immediates).toEqual([]);
  });
});
