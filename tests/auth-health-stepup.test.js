// tests/auth-health-stepup.test.js — auth-health:run-mwinit step-up branch (F1)
// and auth-status:get. Fake electron.ipcMain via require.cache (pattern:
// tests/health-ipc.test.js); real supervisor driven through _setDeps fakes, or
// a fake supervisor where only the handler logic is under test. No vi.mock.
import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const handlers = {};
function injectFake(relPath, exportsObj) {
  const resolved = require.resolve(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
injectFake('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
const { registerAuthHealthIPC } = require('../src/ipc/auth-health');
const sup = require('../src/auth/midway-health-supervisor');

afterEach(() => sup._reset());

const MIN = 60 * 1000;
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }
function deferred() { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; }
const call = (ch) => handlers[ch]({ sender: { getURL: () => 'file:///app/index.html' } });

const ON = { isEnabled: () => true };
const OFF = { isEnabled: () => false };

// Real supervisor with fake auth / AAP API / timers.
function world(o = {}) {
  const log = [];
  const timers = { live: new Map(), seq: 0 };
  const w = {
    log, timers,
    smoke: 'unauth', mwinit: async () => undefined,
    ladder: async () => ({ recovered: false, rung: 'silent', prompted: false }),
    disposed: 0,
  };
  sup._setDeps({
    propagation: o.propagation === undefined ? true : o.propagation,
    isOffline: () => false,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }),
    aapApi: {
      getUserDetails: async () => {
        log.push('smoke');
        const s = typeof w.smoke === 'function' ? w.smoke() : w.smoke;
        if (s === 'ok') return { alias: 'tester' };
        throw Object.assign(new Error('AAP API 401'), { code: 'MIDWAY_SESSION_INVALID', status: 401 });
      },
    },
    auth: {
      probeSession: async () => { log.push('probe'); return false; },
      checkMwinit: () => ({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 }),
      recoverAuth: async (reason, opts) => { log.push('recoverAuth:' + reason + ':' + JSON.stringify(opts)); return w.ladder(reason, opts); },
      aeaSessionExpiryMin: async () => 7,
      runMwinit: async () => { log.push('runMwinit'); const r = await w.mwinit(); log.push('runMwinit:resolved'); return r; },
      injectCookies: async () => { log.push('injectCookies'); },
      refreshAeaViaMwinit: async () => { log.push('refreshAeaViaMwinit'); return true; },
    },
  });
  sup._setTimers({
    set: (fn, ms) => { const h = { id: ++timers.seq, ms }; timers.live.set(h.id, { fn, ms, h }); return h; },
    clear: (h) => { if (h) timers.live.delete(h.id); },
    immediate: () => {},
  });
  w.retryTimers = () => [...timers.live.values()].filter((t) => t.ms < 20 * MIN);
  registerAuthHealthIPC({}, { authReport: o.authReport || ON, aapApi: { dispose: () => { w.disposed++; } } });
  return w;
}

// Two class-B passes (live AEA 7, silent ladder, still 401) -> COOLDOWN + stepUp.
async function toStepUp(w) {
  await sup.ensureHealthyConverging({ reason: 'startup', allowPrompt: false });
  await sup.ensureHealthy({ reason: 'test', allowPrompt: false });
  expect(sup.getState()).toBe('COOLDOWN');
  expect(sup.getStatus().stepUp).toBe(true);
  w.log.length = 0;
}

describe('auth-health IPC registration', () => {
  it('registers auth-status:get alongside the existing channels', () => {
    world();
    for (const ch of ['auth-health:get', 'auth-health:retry', 'auth-health:run-mwinit', 'auth-status:get']) {
      expect(typeof handlers[ch]).toBe('function');
    }
  });
});

describe('F1: auth-health:run-mwinit step-up branch', () => {
  it('F1: handler waits for an in-flight pass and runMwinit starts only after it settles', async () => {
    const w = world();
    await toStepUp(w);
    const gate = deferred();
    w.ladder = async () => { await gate.p; w.log.push('ladder:settled'); return { recovered: false, rung: 'silent' }; };
    const pass = sup.ensureHealthy({ reason: 'auto-retry#2', allowPrompt: false });
    await settle(2);
    const h = call('auth-health:run-mwinit');
    await settle();
    expect(w.log).not.toContain('runMwinit');
    let done = false;
    w.mwinit = async () => { done = true; };
    w.smoke = () => (done ? 'ok' : 'unauth');
    gate.resolve();
    await pass;
    const r = await h;
    expect(w.log.indexOf('ladder:settled')).toBeLessThan(w.log.indexOf('runMwinit'));
    expect(r).toMatchObject({ ok: true, verified: true, prompted: true, state: 'HEALTHY' });
  });

  it('F1: auto-retry timer, data-source-api-load and ui:retry coalesce while runMwinit is pending', async () => {
    const w = world();
    await toStepUp(w);
    const retry = w.retryTimers()[0];
    expect(retry).toBeTruthy();
    const gate = deferred();
    w.mwinit = () => gate.p;
    const h = call('auth-health:run-mwinit');
    await settle();
    expect(w.log).toEqual(['runMwinit']);
    expect(w.retryTimers()).toHaveLength(0);
    const others = [
      retry.fn(),
      sup.ensureHealthyConverging({ reason: 'data-source-api-load', allowPrompt: true }),
      call('auth-health:retry'),
    ];
    await settle();
    expect(w.log).toEqual(['runMwinit']);
    w.smoke = 'ok';
    gate.resolve();
    const r = await h;
    const [, ds, uiRetry] = await Promise.all(others);
    expect(ds).toMatchObject({ coalesced: true, rung: 'mwinit', ok: true });
    expect(uiRetry).toMatchObject({ ok: true, verified: true });
    expect(r).toMatchObject({ ok: true, verified: true, prompted: true });
    expect(w.log.filter((x) => x === 'runMwinit')).toHaveLength(1);
    expect(w.log.some((x) => x.startsWith('recoverAuth'))).toBe(false);
  });

  it('F1: recoverAuth and refreshAeaViaMwinit are never called during the full sign-in', async () => {
    const w = world();
    await toStepUp(w);
    await call('auth-health:run-mwinit');
    expect(w.log.some((x) => x.startsWith('recoverAuth') || x === 'refreshAeaViaMwinit')).toBe(false);
    expect(w.log).toEqual(['runMwinit', 'runMwinit:resolved', 'injectCookies', 'smoke', 'probe']);
  });

  it('F1: result comes from a verify that ran after runMwinit resolved and is never coalesced', async () => {
    const w = world();
    await toStepUp(w);
    let done = false;
    w.mwinit = async () => { done = true; };
    w.smoke = () => (done ? 'ok' : 'unauth');
    const r = await call('auth-health:run-mwinit');
    expect(w.log.indexOf('runMwinit:resolved')).toBeLessThan(w.log.indexOf('smoke'));
    expect(r).toMatchObject({ ok: true, verified: true, prompted: true, state: 'HEALTHY' });
    expect('coalesced' in r).toBe(false);
    expect(sup.getStatus().verifiedBy).toBe('ladder:mwinit');
    expect(r.snapshot.state).toBe('HEALTHY');
  });

  it('F1: failure re-arms exactly one retry timer', async () => {
    const w = world();
    await toStepUp(w);
    expect(w.retryTimers()).toHaveLength(1);
    const r = await call('auth-health:run-mwinit');
    expect(r).toMatchObject({ ok: false, verified: false, prompted: true, state: 'COOLDOWN' });
    expect(w.retryTimers()).toHaveLength(1);
    expect(sup.getStatus().action).toBe('wait');            // F9 row after a completed full sign-in
  });

  it('F1: runMwinit rejection returns mwinit-failed with no verify and no second spawn', async () => {
    const w = world();
    await toStepUp(w);
    w.mwinit = async () => { throw new Error('mwinit timed out after 180s'); };
    const r = await call('auth-health:run-mwinit');
    expect(r).toMatchObject({ ok: false, verified: false, prompted: true, reason: 'mwinit-failed' });
    expect(w.log).toEqual(['runMwinit']);
    expect(w.retryTimers()).toHaveLength(1);
  });

  it('F1: offline skip returns reason offline with no verify', async () => {
    const w = world();
    await toStepUp(w);
    w.mwinit = async () => ({ skipped: 'offline' });
    const r = await call('auth-health:run-mwinit');
    expect(r).toMatchObject({ ok: false, verified: false, reason: 'offline' });
    expect(w.log).toEqual(['runMwinit', 'runMwinit:resolved']);
  });

  it('F1: aap_api.dispose only when verified', async () => {
    let w = world();
    await toStepUp(w);
    await call('auth-health:run-mwinit');
    expect(w.disposed).toBe(0);
    sup._reset();
    w = world();
    await toStepUp(w);
    let done = false;
    w.mwinit = async () => { done = true; };
    w.smoke = () => (done ? 'ok' : 'unauth');
    await call('auth-health:run-mwinit');
    expect(w.disposed).toBe(1);
  });
});

// Fake supervisor: only the handler's branching is under test.
function fakeSup(o = {}) {
  const calls = [];
  return {
    calls,
    getState: () => 'COOLDOWN',
    getSnapshot: () => ({ state: 'COOLDOWN' }),
    getHistory: () => [],
    buildSnapshot: async () => ({ state: 'COOLDOWN' }),
    getStatus: () => { calls.push('getStatus'); if (o.statusThrows) throw new Error('must not be called'); return { stepUp: !!o.stepUp, state: 'COOLDOWN' }; },
    ensureHealthyConverging: async (opts) => { calls.push(['converging', opts]); return { ok: false, verified: false, prompted: true, reason: 'legacy' }; },
    ensureHealthyFullSignIn: async () => { calls.push('fullSignIn'); return { ok: false, verified: false, reason: 'x' }; },
  };
}

describe('F1: legacy body and flag-off behavior', () => {
  it('F1: flag on but stepUp false uses the legacy ui:run-mwinit allowPrompt:true body', async () => {
    const s = fakeSup({ stepUp: false });
    registerAuthHealthIPC({}, { supervisor: s, authReport: ON });
    const r = await call('auth-health:run-mwinit');
    expect(s.calls).toEqual(['getStatus', ['converging', { reason: 'ui:run-mwinit', allowPrompt: true }]]);
    expect(r).toEqual({ ok: false, state: 'COOLDOWN', snapshot: { state: 'COOLDOWN' }, verified: false, prompted: true, reason: 'legacy' });
  });

  it('F1: flag off never consults getStatus', async () => {
    const s = fakeSup({ stepUp: true, statusThrows: true });
    registerAuthHealthIPC({}, { supervisor: s, authReport: OFF });
    const r = await call('auth-health:run-mwinit');
    expect(s.calls).toEqual([['converging', { reason: 'ui:run-mwinit', allowPrompt: true }]]);
    expect(r.reason).toBe('legacy');
    const g = await call('auth-health:get');
    expect('status' in g).toBe(false);
    expect(s.calls.includes('getStatus')).toBe(false);
  });

  it('flag on + stepUp true calls ensureHealthyFullSignIn and reports prompted:true', async () => {
    const s = fakeSup({ stepUp: true });
    registerAuthHealthIPC({}, { supervisor: s, authReport: ON });
    const r = await call('auth-health:run-mwinit');
    expect(s.calls).toEqual(['getStatus', 'fullSignIn']);
    expect(r).toMatchObject({ ok: false, prompted: true, reason: 'x' });
  });
});

describe('auth-status:get', () => {
  it('auth-status:get returns enabled:false/status:null with the flag off', async () => {
    const s = fakeSup({ statusThrows: true });
    registerAuthHealthIPC({}, { supervisor: s, authReport: OFF });
    expect(await call('auth-status:get')).toEqual({ ok: true, enabled: false, status: null });
    expect(s.calls).toEqual([]);
  });

  it('auth-status:get and auth-health:get return the status with the flag on', async () => {
    world();
    const st = await call('auth-status:get');
    expect(st.ok).toBe(true);
    expect(st.enabled).toBe(true);
    expect(st.status).toMatchObject({ v: 1, state: 'UNKNOWN', level: 'unknown' });
    const g = await call('auth-health:get');
    expect(g.status).toMatchObject({ v: 1, state: 'UNKNOWN' });
  });

  it('production default (no deps) reads the real flag, which tests force OFF', async () => {
    registerAuthHealthIPC({});
    expect(await call('auth-status:get')).toEqual({ ok: true, enabled: false, status: null });
  });
});
