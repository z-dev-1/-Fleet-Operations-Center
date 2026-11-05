// tests/auth-propagation-integration.test.js — cross-FEAT seams of auth.propagation.
// Real modules end to end: auth-report (FEAT-001/002 producer API) -> real supervisor
// (FEAT-001) -> real propagation broadcaster (FEAT-003) -> the exact app.js _send
// intercept line (FEAT-003) -> the renderer channels the preload/bridge consume
// (FEAT-004: 'auth:mwinit-status' mirror, then 'auth:status'), plus the real
// 'auth-health:run-mwinit' / 'auth-status:get' IPC handlers and the real
// src/scrapers/auth.js injectCookies under the Phase 9 flags ON and OFF.
// Harness fakes only (no Electron, network, child process or credential file). No vi.mock.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { installAuthCoordHarness } = require('./helpers/auth-coord-fakes.cjs');
const h = installAuthCoordHarness({ vi });
const fs = require('fs');
const auth = require('../src/scrapers/auth');
const sup = require('../src/auth/midway-health-supervisor');
const ar = require('../src/auth/auth-report');
const prop = require('../src/auth/propagation');
const seeder = require('../src/auth/session-seeder');

// The harness put a fake electron in require.cache; give it an ipcMain for the IPC module.
const handlers = {};
h.electron.ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; } };
const { registerAuthHealthIPC } = require('../src/ipc/auth-health');
const call = (ch) => handlers[ch]({ sender: { getURL: () => 'file:///app/index.html' } });

const PHASE9_ON = { singleFlight: true, singleOwnerAea: true, singleOwnerReconnect: true };
const PHASE9_OFF = { singleFlight: false, singleOwnerAea: false, singleOwnerReconnect: false };

const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

// The exact `_send` intercept line from src/app.js, evaluated against a real handle.
function appSend(sendRaw, handle) {
  const src = fs.readFileSync(require.resolve('../src/app.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = /function _send\(channel, payload\) \{\n\s*(if \(.*\) return;)\n\s*_sendRaw\(channel, payload\);\n\s*\}/.exec(src);
  expect(m).not.toBeNull();
  // eslint-disable-next-line no-new-func
  return new Function('_sendRaw', '_authPropagation', 'return function _send(channel, payload) { ' + m[1] + ' _sendRaw(channel, payload); };')(sendRaw, handle);
}

function world() {
  const w = { smoke: 'ok', log: [], retryTimers: new Map(), seq: 0, sent: [], propQ: [], disposed: 0, wakes: [], reloads: [], sweeps: 0, sticky: [] };
  sup._setDeps({
    isOffline: () => false,
    checkVpnState: async () => ({ connected: false, status: 'disconnected' }),
    aapApi: {
      getUserDetails: async () => {
        w.log.push('smoke');
        if (w.smoke === 'ok') return { alias: 'tester' };
        throw Object.assign(new Error('AAP API 401'), { code: 'MIDWAY_SESSION_INVALID', status: 401 });
      },
    },
    auth: {
      // Real auth.js for the cookie write and the live-AEA read; fakes for anything that spawns or opens windows.
      injectCookies: (...a) => { w.log.push('injectCookies'); return auth.injectCookies(...a); },
      aeaSessionExpiryMin: () => auth.aeaSessionExpiryMin(),
      checkMwinit: () => auth.checkMwinit(),
      probeSession: async () => { w.log.push('probe'); return w.smoke === 'ok'; },
      runMwinit: async () => { w.log.push('runMwinit'); w.smoke = 'ok'; return undefined; },
      recoverAuth: async () => { w.log.push('recoverAuth'); return { recovered: false, rung: 'silent', prompted: false }; },
      refreshAeaViaMwinit: async () => { w.log.push('refreshAeaViaMwinit'); return false; },
    },
  });
  sup._setTimers({
    set: (fn, ms) => { const id = ++w.seq; w.retryTimers.set(id, { fn, ms }); return id; },
    clear: (id) => { w.retryTimers.delete(id); },
  });
  const timers = { set: (fn, ms) => { const x = { fn, ms }; w.propQ.push(x); return x; }, clear: (x) => { const i = w.propQ.indexOf(x); if (i >= 0) w.propQ.splice(i, 1); } };
  w.flushProp = async () => { await settle(); const q = w.propQ.splice(0); for (const x of q) x.fn(); await settle(); };
  w.handle = prop.init({
    sendRaw: (ch, p) => w.sent.push([ch, p]),
    getCtx: () => ({ _loadFleetViaApiStartup: async (reason) => { w.reloads.push(reason); } }),
    deps: {
      timers,
      aapApi: { dispose: () => { w.disposed++; } },
      workers: { wakeDependents: (key) => { w.wakes.push(key); return 1; } },
      scheduler: { recoverBlockedSlots: async () => { w.sweeps++; } },
      seeder: { refreshSticky: async (reason) => { w.sticky.push(reason); return { refreshed: false, results: [] }; }, buildInventory: seeder.buildInventory, formatInventory: seeder.formatInventory },
      buildInventory: async () => ({ aea: [], toMidway: { aea: 0, session: 0, other: 0 }, aeaCountToMidway: 0 }),
    },
  });
  w.send = appSend((ch, p) => w.sent.push([ch, p]), w.handle);
  w.take = () => w.sent.splice(0);
  return w;
}

describe.each([
  ['Phase 9 flags ON', PHASE9_ON],
  ['Phase 9 flags OFF', PHASE9_OFF],
])('integration with the flag ON (%s)', (_label, flags) => {
  beforeEach(() => {
    h.electron.resetCounters();
    h.logs.length = 0;
    h.offline._offline = false;
    auth._setCoordDeps({ flags });
    ar._setEnabledForTest(true);
  });
  afterEach(() => {
    prop._reset(); sup._reset(); ar._reset(); seeder._reset(); auth._resetCoord();
  });

  it('integration: AAP traffic via auth-report drives the real supervisor and reaches the renderer channels mirror-then-status', async () => {
    const w = world();
    expect(w.handle).not.toBeNull();

    ar.report({ ok: true, source: 'aap-api' });                       // UNKNOWN -> HEALTHY (api cause)
    await w.flushProp();
    let out = w.take();
    expect(out.map((x) => x[0])).toEqual(['auth:mwinit-status', 'auth:status']);
    expect(out[0][1]).toMatchObject({ ok: true, __authStatus: true, state: 'HEALTHY' });
    expect(out[1][1]).toMatchObject({ state: 'HEALTHY', level: 'ok', ok: true, action: 'none', verifiedBy: 'api:aap-api' });
    // Recovery fan-out for an api: cause: wake + sweep, but no page dispose and no fleet reload.
    expect(w.wakes).toEqual(['auth']);
    expect(w.disposed).toBe(0);
    expect(w.reloads).toEqual([]);

    ar.report({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' });   // HEALTHY -> DEGRADED
    await w.flushProp();
    out = w.take();
    expect(out.map((x) => x[0])).toEqual(['auth:mwinit-status', 'auth:status']);
    expect(out[0][1]).toMatchObject({ ok: false, __authStatus: true, state: 'DEGRADED' });
    expect(out[1][1]).toMatchObject({ state: 'DEGRADED', level: 'warn', ok: false, action: 'wait', stepUp: false });
    expect(w.retryTimers.size).toBe(1);                                // exactly one auto-retry timer, no synchronous ladder
    expect(w.log).not.toContain('recoverAuth');

    // A legacy heartbeat {ok:true,...} through the real app.js _send is demoted to evidence:
    // it never reaches the renderer and never flips the status back to ok.
    w.send('auth:mwinit-status', { ok: true, expiresInMin: 600, aeaExpiresInMin: 30 });
    w.send('auth:mwinit-status', { ok: true });                       // window/index.js post-reauth shape
    w.send('fleet:data', { rows: [] });                               // other channels pass through untouched
    await w.flushProp();
    out = w.take();
    expect(out.filter((x) => x[0] === 'auth:mwinit-status' && !x[1].__authStatus)).toEqual([]);
    expect(out.filter((x) => x[0] === 'fleet:data')).toHaveLength(1);
    expect(sup.getStatus()).toMatchObject({ state: 'DEGRADED', ok: false });
    expect(sup.getStatus().evidence).toMatchObject({ sessionMin: 600, diskAeaMin: 30 });
    expect(w.sticky).toContain('heartbeat');                          // F10 path reached through the real _send

    // RCA step-up signal -> stepUp row with action mwinit, pushed to the renderer.
    ar.reportStepUp({ source: 'rca' });
    await w.flushProp();
    out = w.take();
    const st = out.find((x) => x[0] === 'auth:status');
    expect(st && st[1]).toMatchObject({ stepUp: true, action: 'mwinit', level: 'warn' });
    expect(out[0][0]).toBe('auth:mwinit-status');
    expect(out[0][1]).toMatchObject({ stepUp: true, __authStatus: true });
  });

  it('integration: Run mwinit IPC during a step-up runs the full sign-in on the real auth.js inject and fans out the recovery', async () => {
    const w = world();
    registerAuthHealthIPC({}, { supervisor: sup, authReport: ar, aapApi: { dispose: () => { w.disposed++; } } });

    ar.report({ ok: true, source: 'aap-api' });
    ar.report({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' });
    ar.reportStepUp({ source: 'rca' });
    w.smoke = 'unauth';
    await w.flushProp();
    w.take(); w.wakes.length = 0; w.disposed = 0; w.sweeps = 0;      // drop the setup recovery's (api-cause) fan-out
    expect(sup.getStatus().stepUp).toBe(true);
    expect((await call('auth-status:get'))).toMatchObject({ ok: true, enabled: true, status: { stepUp: true, action: 'mwinit' } });

    const gen0 = auth._coordStats().cookieGen;
    const setsBefore = h.electron.session.defaultSession.sets;
    const r = await call('auth-health:run-mwinit');
    expect(r).toMatchObject({ ok: true, verified: true, prompted: true, state: 'HEALTHY' });
    // Ordered: one interactive mwinit, the real default-jar inject, then a fresh verify.
    const i = w.log.indexOf('runMwinit');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(w.log.filter((x) => x === 'runMwinit')).toHaveLength(1);
    expect(w.log.indexOf('injectCookies')).toBeGreaterThan(i);
    expect(w.log.lastIndexOf('smoke')).toBeGreaterThan(w.log.indexOf('injectCookies'));
    expect(w.log).not.toContain('recoverAuth');
    expect(w.log).not.toContain('refreshAeaViaMwinit');
    // The real auth.js wrote the default jar; Phase 9 cookie-generation accounting is intact.
    expect(h.electron.session.defaultSession.sets).toBeGreaterThan(setsBefore);
    expect(auth._coordStats().cookieGen).toBe(gen0 + 2);
    expect(h.spawnSpy).not.toHaveBeenCalled();
    expect(w.retryTimers.size).toBe(0);
    expect(sup.getStatus()).toMatchObject({ state: 'HEALTHY', level: 'ok', stepUp: false, verifiedBy: 'ladder:mwinit' });

    await w.flushProp();
    const out = w.take();
    expect(out.map((x) => x[0])).toEqual(['auth:mwinit-status', 'auth:status']);
    expect(out[1][1]).toMatchObject({ state: 'HEALTHY', ok: true, action: 'none' });
    // Non-api cause: page disposed (by propagation and by the IPC handler), workers woken, fleet reloaded, sweep after reload.
    expect(w.disposed).toBe(2);
    expect(w.wakes).toEqual(['auth']);
    expect(w.reloads).toEqual(['auth-recovered']);
    expect(w.sweeps).toBe(1);
  });

  it('integration: no Midway/AEA cookie value reaches any renderer payload or log line', async () => {
    const w = world();
    ar.report({ ok: true, source: 'aap-api' });
    ar.report({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' });
    w.send('auth:mwinit-status', { ok: true, expiresInMin: 600, aeaExpiresInMin: 30 });
    await sup.ensureHealthyFullSignIn();
    await w.flushProp();
    const hay = JSON.stringify(w.sent) + '\n' + h.logs.map((l) => l.msg).join('\n') + JSON.stringify(sup.getStatus());
    for (const s of ['FAKE-SESSION-VALUE', 'FAKE-AEA-VALUE', 'FAKE-SIGNATURE']) expect(hay).not.toContain(s);
  });
});

describe.each([
  ['Phase 9 flags ON', PHASE9_ON],
  ['Phase 9 flags OFF', PHASE9_OFF],
])('integration with the flag OFF (%s)', (_label, flags) => {
  beforeEach(() => {
    h.electron.resetCounters();
    auth._setCoordDeps({ flags });
  });
  afterEach(() => { prop._reset(); sup._reset(); ar._reset(); auth._resetCoord(); });

  it('integration: flag off the whole chain is inert and legacy pushes reach the renderer unchanged', async () => {
    expect(ar.isEnabled()).toBe(false);                               // real resolver: FLEET_AUTH_PROPAGATION=0 (tests/setup)
    const sent = [];
    const handle = prop.init({ sendRaw: (c, p) => sent.push([c, p]), getCtx: () => null });
    expect(handle).toBeNull();
    const send = appSend((c, p) => sent.push([c, p]), handle);
    const events = [];
    const unsub = sup.subscribe((e) => events.push(e));
    ar.report({ ok: true, source: 'aap-api' });
    ar.report({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' });
    ar.reportStepUp({ source: 'rca' });
    expect(ar.currentStatus()).toBeNull();
    const legacy = [['auth:mwinit-status', { ok: true, expiresInMin: 600, aeaExpiresInMin: 30 }], ['auth:mwinit-status', 'running'], ['auth:mwinit-status', { ok: false, reason: 'x' }]];
    for (const [c, p] of legacy) send(c, p);
    await settle();
    if (typeof unsub === 'function') unsub();
    expect(sent).toEqual(legacy);                                     // byte-identical passthrough, no auth:status
    expect(events).toEqual([]);
    expect(sup.getState()).toBe('UNKNOWN');
    expect(sup.getHistory()).toEqual([]);
    sup._setDeps({ isOffline: () => false, checkVpnState: async () => ({ connected: false, status: 'disconnected' }) });   // snapshot never shells out
    registerAuthHealthIPC({}, { supervisor: sup, authReport: ar });
    expect(await call('auth-status:get')).toEqual({ ok: true, enabled: false, status: null });
    const g = await call('auth-health:get');
    expect('status' in g).toBe(false);
  });
});
