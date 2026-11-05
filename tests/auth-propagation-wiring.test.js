// tests/auth-propagation-wiring.test.js — src/auth/propagation.js (auth.propagation
// FEAT-003, plan item 15, design 4.1 + test 6). Fakes for the supervisor, aap_api,
// workers, scheduler, ctx and sendRaw are injected through init({ deps }); no
// Electron, no vi.mock. F10 (heartbeat sticky refresh) and F12 (dead app:midway-*
// sends unchanged) are named by prefix.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');
const prop = require('../src/auth/propagation');
const seeder = require('../src/auth/session-seeder');
const realSup = require('../src/auth/midway-health-supervisor');

const ON = { isEnabled: () => true };
const OFF = { isEnabled: () => false };

function mkStatus(state, extra = {}) {
  const level = { HEALTHY: 'ok', UNKNOWN: 'unknown', RECOVERING: 'busy', DEGRADED: 'warn', COOLDOWN: 'warn', WAITING_FOR_USER: 'down', FAILED: 'down', OFFLINE: 'warn' }[state];
  return Object.assign({
    v: 1, seq: 1, at: '2026-11-04T00:00:00.000Z', state, level,
    ok: level === 'ok' ? true : (level === 'warn' || level === 'down') ? false : null,
    action: level === 'ok' ? 'none' : 'wait', stepUp: false, failClass: null,
    message: 'msg ' + state, verifiedAt: null, verifiedBy: null, lastApiOkAt: null, lastApiFailAt: null,
    nextRetryAt: null, retryStreak: 0,
    evidence: { sessionMin: null, diskAeaMin: null, liveAeaMin: null, aeaCountToMidway: null, online: null, at: null },
  }, extra);
}

function fakeSup(state = 'UNKNOWN') {
  let status = mkStatus(state);
  const listeners = new Set();
  return {
    listeners,
    set(s) { status = typeof s === 'string' ? mkStatus(s) : s; },
    getStatus: () => status,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    noteEvidence: vi.fn(() => ({ handled: true })),
    fire(evt) { for (const fn of [...listeners]) fn(Object.assign({ status }, evt)); },
  };
}

function manualTimers() {
  const q = [];
  return {
    q,
    set: (fn, ms) => { const h = { fn, ms, done: false }; q.push(h); return h; },
    clear: (h) => { if (h) h.done = true; },
    pending: (ms) => q.filter((h) => !h.done && (ms === undefined || h.ms === ms)),
    run(ms) { for (const h of q.filter((x) => !x.done && (ms === undefined || x.ms === ms))) { h.done = true; h.fn(); } },
  };
}

function recLogger() {
  const lines = [];
  const rec = (level) => (...a) => lines.push({ level, msg: a.map(String).join(' ') });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
}

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function world(opts = {}) {
  const sup = opts.sup || fakeSup(opts.state || 'UNKNOWN');
  const sent = [];
  const timers = manualTimers();
  const log = recLogger();
  let t = opts.t0 || 1_000_000;
  const ctx = opts.ctx === undefined ? { _loadFleetViaApiStartup: vi.fn(async () => {}) } : opts.ctx;
  const d = {
    authReport: ON,
    supervisor: sup,
    seeder: opts.seeder || { refreshSticky: vi.fn(async () => ({ refreshed: 0, results: [] })), buildInventory: seeder.buildInventory, formatInventory: seeder.formatInventory },
    aapApi: { dispose: vi.fn() },
    workers: { wakeDependents: vi.fn(() => 1) },
    scheduler: { recoverBlockedSlots: vi.fn(async () => {}) },
    auth: opts.auth || { aeaSessionExpiryMin: vi.fn(async () => 7) },
    logger: log,
    now: () => t,
    timers,
    stickyDeps: opts.stickyDeps || { tag: 'sticky-deps' },
    buildInventory: opts.buildInventory || vi.fn(async () => ({ aea: [{ domain: '.amazon.com', min: 5 }], toMidway: { aea: 1, session: 1, other: 0 }, aeaCountToMidway: 1 })),
  };
  Object.assign(d, opts.deps || {});
  const getCtx = opts.getCtx || (() => ctx);
  const h = prop.init({ sendRaw: (ch, p) => sent.push([ch, p]), getCtx, deps: d });
  return { h, sup, sent, timers, log, d, ctx, advance: (ms) => { t += ms; }, now: () => t };
}

afterEach(() => { prop._reset(); seeder._reset(); realSup._reset(); });

describe('propagation.init', () => {
  it('returns null and subscribes nothing when the flag is off', () => {
    const sup = fakeSup();
    expect(prop.init({ sendRaw: () => {}, getCtx: () => null, deps: { authReport: OFF, supervisor: sup } })).toBeNull();
    expect(sup.listeners.size).toBe(0);
    expect(prop.interceptLegacy({ ok: true })).toBe(false);
  });

  it('returns a handle that subscribes once; shutdown unsubscribes and clears timers', () => {
    const w = world();
    expect(w.sup.listeners.size).toBe(1);
    w.sup.fire({ type: 'evidence', to: 'UNKNOWN' });
    expect(w.timers.pending(prop.COALESCE_MS)).toHaveLength(1);
    w.h.shutdown();
    expect(w.sup.listeners.size).toBe(0);
    expect(w.timers.pending()).toHaveLength(0);
    expect(prop.interceptLegacy({ ok: true })).toBe(false);   // module delegate: not initialised any more
  });
});

describe('broadcast', () => {
  it('sends the mirror auth:mwinit-status (with __authStatus) first, then auth:status', () => {
    const w = world({ state: 'COOLDOWN' });
    w.sup.set(mkStatus('COOLDOWN', { evidence: { sessionMin: 600, diskAeaMin: 30, liveAeaMin: 7, aeaCountToMidway: 2, online: true, at: 1 } }));
    w.sup.fire({ type: 'state', from: 'DEGRADED', to: 'COOLDOWN', cause: 'auto-retry#1' });
    expect(w.sent).toEqual([]);                               // coalesced for 200 ms
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent.map((s) => s[0])).toEqual(['auth:mwinit-status', 'auth:status']);
    expect(w.sent[0][1]).toEqual({ ok: false, reason: 'msg COOLDOWN', expiresInMin: 600, aeaExpiresInMin: 30, liveAeaMin: 7, state: 'COOLDOWN', stepUp: false, __authStatus: true });
    expect(w.sent[1][1]).toBe(w.sup.getStatus());
  });

  it('mirror omits reason when ok is true', () => {
    expect('reason' in prop._mirror(mkStatus('HEALTHY'))).toBe(false);
    expect(prop._mirror(mkStatus('UNKNOWN')).ok).toBeNull();
  });

  it('coalesces a burst into one broadcast and de-duplicates an unchanged status', () => {
    const w = world({ state: 'COOLDOWN' });
    w.sup.fire({ type: 'state', to: 'COOLDOWN' });
    w.sup.fire({ type: 'outcome', to: 'COOLDOWN' });
    w.sup.fire({ type: 'stepup', to: 'COOLDOWN' });
    expect(w.timers.pending(prop.COALESCE_MS)).toHaveLength(1);
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(2);
    w.sup.fire({ type: 'outcome', to: 'COOLDOWN' });          // same (state, level, stepUp, message, nextRetryAt, live/5)
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(2);
    w.sup.set(mkStatus('COOLDOWN', { stepUp: true, message: 'step-up' }));
    w.sup.fire({ type: 'stepup', to: 'COOLDOWN' });
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(4);
    expect(w.sent[2][1].stepUp).toBe(true);
  });

  it('evidence-only changes broadcast at most once per 60 s', () => {
    const w = world({ state: 'COOLDOWN' });
    w.sup.fire({ type: 'state', to: 'COOLDOWN' });
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(2);
    w.sup.set(mkStatus('COOLDOWN', { evidence: { liveAeaMin: 50 } }));
    w.advance(10 * 1000);
    w.sup.fire({ type: 'evidence', to: 'COOLDOWN' });
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(2);                           // within 60 s
    w.advance(51 * 1000);
    w.sup.fire({ type: 'evidence', to: 'COOLDOWN' });
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent).toHaveLength(4);
  });
});

describe('recovery fan-out', () => {
  const RELOAD_CAUSES = ['ui:retry', 'reconnect', 'monitor', 'auto-retry#2', 'ui:run-mwinit-stepup', 'aea-captured'];
  it.each(RELOAD_CAUSES)('cause %s: dispose, sticky, wake, one reload, then the scheduler sweep after it settles', async (cause) => {
    let release;
    const ctx = { _loadFleetViaApiStartup: vi.fn(() => new Promise((r) => { release = r; })) };
    const w = world({ state: 'COOLDOWN', ctx });
    w.sup.set('HEALTHY');
    w.sup.fire({ type: 'state', from: 'RECOVERING', to: 'HEALTHY', cause });
    expect(w.d.aapApi.dispose).toHaveBeenCalledTimes(1);
    expect(w.d.seeder.refreshSticky).toHaveBeenCalledWith('recovered', w.d.stickyDeps);
    expect(w.d.workers.wakeDependents).toHaveBeenCalledWith('auth');
    expect(ctx._loadFleetViaApiStartup).toHaveBeenCalledTimes(1);
    expect(ctx._loadFleetViaApiStartup).toHaveBeenCalledWith('auth-recovered');
    expect(w.d.auth.aeaSessionExpiryMin).toHaveBeenCalledTimes(1);
    await flush();
    expect(w.d.scheduler.recoverBlockedSlots).not.toHaveBeenCalled();   // waits for the reload
    release();
    await flush();
    expect(w.d.scheduler.recoverBlockedSlots).toHaveBeenCalledTimes(1);
    expect(w.timers.pending(prop.API_CAUSE_SWEEP_DELAY_MS)).toHaveLength(0);
  });

  it.each(['api:aap-api', 'data-source-api-load', 'data-source-legacy'])('cause %s: no dispose and no reload, but still wakes and sweeps 5 s later', (cause) => {
    const w = world({ state: 'COOLDOWN' });
    w.sup.set('HEALTHY');
    w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause });
    expect(w.d.aapApi.dispose).not.toHaveBeenCalled();
    expect(w.ctx._loadFleetViaApiStartup).not.toHaveBeenCalled();
    expect(w.d.workers.wakeDependents).toHaveBeenCalledWith('auth');
    expect(w.d.seeder.refreshSticky).toHaveBeenCalledTimes(1);
    expect(w.d.scheduler.recoverBlockedSlots).not.toHaveBeenCalled();
    expect(w.timers.pending(prop.API_CAUSE_SWEEP_DELAY_MS)).toHaveLength(1);
    w.timers.run(prop.API_CAUSE_SWEEP_DELAY_MS);
    expect(w.d.scheduler.recoverBlockedSlots).toHaveBeenCalledTimes(1);
  });

  it.each(['startup', 'post-reauth'])('cause %s: disposes but skips the reload; sweep runs 5 s later', (cause) => {
    const w = world({ state: 'UNKNOWN' });
    w.sup.set('HEALTHY');
    w.sup.fire({ type: 'state', from: 'UNKNOWN', to: 'HEALTHY', cause });
    expect(w.d.aapApi.dispose).toHaveBeenCalledTimes(1);
    expect(w.ctx._loadFleetViaApiStartup).not.toHaveBeenCalled();
    w.timers.run(prop.API_CAUSE_SWEEP_DELAY_MS);
    expect(w.d.scheduler.recoverBlockedSlots).toHaveBeenCalledTimes(1);
  });

  it('fires only on a transition INTO HEALTHY (not HEALTHY -> HEALTHY, not other states)', () => {
    const w = world({ state: 'HEALTHY' });
    w.sup.fire({ type: 'outcome', to: 'HEALTHY', cause: 'api:aap-api' });
    w.sup.set('DEGRADED');
    w.sup.fire({ type: 'state', from: 'HEALTHY', to: 'DEGRADED', cause: 'api:aap-api' });
    w.sup.fire({ type: 'state', from: 'DEGRADED', to: 'COOLDOWN', cause: 'api-outcome' });
    expect(w.d.workers.wakeDependents).not.toHaveBeenCalled();
    w.sup.set('HEALTHY');
    w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause: 'ui:retry' });
    expect(w.d.workers.wakeDependents).toHaveBeenCalledTimes(1);
  });

  it('each recovery step failing is isolated from the others', async () => {
    const w = world({
      state: 'COOLDOWN',
      deps: {
        aapApi: { dispose: vi.fn(() => { throw new Error('dispose boom'); }) },
        workers: { wakeDependents: vi.fn(() => { throw new Error('wake boom'); }) },
        auth: { aeaSessionExpiryMin: vi.fn(async () => { throw new Error('live boom'); }) },
      },
      seeder: { refreshSticky: vi.fn(() => { throw new Error('sticky boom'); }) },
      ctx: { _loadFleetViaApiStartup: vi.fn(() => { throw new Error('reload boom'); }) },
    });
    w.sup.set('HEALTHY');
    expect(() => w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause: 'ui:retry' })).not.toThrow();
    expect(w.d.aapApi.dispose).toHaveBeenCalled();
    expect(w.d.seeder.refreshSticky).toHaveBeenCalled();
    expect(w.d.workers.wakeDependents).toHaveBeenCalled();
    expect(w.ctx._loadFleetViaApiStartup).toHaveBeenCalled();
    expect(w.d.auth.aeaSessionExpiryMin).toHaveBeenCalled();
    w.timers.run(prop.API_CAUSE_SWEEP_DELAY_MS);              // reload threw -> sweep still runs on the timer
    expect(w.d.scheduler.recoverBlockedSlots).toHaveBeenCalledTimes(1);
    await flush();
    const warns = w.log.lines.filter((l) => l.level === 'warn').map((l) => l.msg);
    for (const s of ['dispose', 'sticky', 'wake', 'reload']) expect(warns.some((m) => m.includes('step ' + s + ' failed'))).toBe(true);
    w.timers.run(prop.COALESCE_MS);
    expect(w.sent.map((s) => s[0])).toEqual(['auth:mwinit-status', 'auth:status']);   // broadcast still happens
  });

  it.each([
    ['getCtx returns null', () => null],
    ['getCtx throws the TDZ ReferenceError', () => { throw new ReferenceError("Cannot access '_ctx' before initialization"); }],
  ])('%s: only the fleet reload is skipped', (_l, getCtx) => {
    const w = world({ state: 'COOLDOWN', getCtx });
    w.sup.set('HEALTHY');
    w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause: 'ui:retry' });
    expect(w.d.aapApi.dispose).toHaveBeenCalledTimes(1);
    expect(w.d.seeder.refreshSticky).toHaveBeenCalledTimes(1);
    expect(w.d.workers.wakeDependents).toHaveBeenCalledTimes(1);
    expect(w.d.auth.aeaSessionExpiryMin).toHaveBeenCalledTimes(1);
    w.timers.run(prop.API_CAUSE_SWEEP_DELAY_MS);
    expect(w.d.scheduler.recoverBlockedSlots).toHaveBeenCalledTimes(1);
  });

  it('the recovery sticky refresh is rate-limited to once per 5 min', () => {
    const w = world({ state: 'COOLDOWN' });
    const cycle = () => {
      w.sup.set('COOLDOWN'); w.sup.fire({ type: 'state', from: 'HEALTHY', to: 'COOLDOWN' });
      w.sup.set('HEALTHY'); w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause: 'api:aap-api' });
    };
    w.sup.set('HEALTHY'); w.sup.fire({ type: 'state', from: 'COOLDOWN', to: 'HEALTHY', cause: 'api:aap-api' });
    w.advance(60 * 1000); cycle();
    expect(w.d.seeder.refreshSticky).toHaveBeenCalledTimes(1);
    w.advance(5 * 60 * 1000); cycle();
    expect(w.d.seeder.refreshSticky).toHaveBeenCalledTimes(2);
    expect(w.d.workers.wakeDependents).toHaveBeenCalledTimes(3);
  });

  it('leaving HEALTHY writes one inventory line, rate-limited to once per 10 min', async () => {
    const w = world({ state: 'HEALTHY' });
    const leave = () => {
      w.sup.set('DEGRADED'); w.sup.fire({ type: 'state', from: 'HEALTHY', to: 'DEGRADED' });
      w.sup.set('HEALTHY'); w.sup.fire({ type: 'state', from: 'DEGRADED', to: 'HEALTHY', cause: 'api:aap-api' });
    };
    leave();
    await flush();
    expect(w.d.buildInventory).toHaveBeenCalledTimes(1);
    const inv = w.log.lines.filter((l) => l.msg.startsWith('[auth-inventory]'));
    expect(inv.map((l) => l.msg)).toEqual(['[auth-inventory] reason=left-healthy aea=[.amazon.com:5m] toMidway={aea:1, session:1}']);
    expect(w.sup.noteEvidence).toHaveBeenCalledWith({ aeaCountToMidway: 1 });
    w.advance(9 * 60 * 1000); leave(); await flush();
    expect(w.d.buildInventory).toHaveBeenCalledTimes(1);
    w.advance(61 * 1000); leave(); await flush();
    expect(w.d.buildInventory).toHaveBeenCalledTimes(2);
  });
});

describe('interceptLegacy', () => {
  it('swallows non-mirror payloads, passes the mirror, turns heartbeat payloads into evidence', () => {
    const w = world();
    expect(w.h.interceptLegacy({ ok: true })).toBe(true);
    expect(w.h.interceptLegacy({ ok: false, reason: 'AAP still rejecting' })).toBe(true);
    for (const s of ['running', 'launched', 'error:spawn failed']) expect(w.h.interceptLegacy(s)).toBe(true);
    expect(w.sup.noteEvidence).not.toHaveBeenCalled();
    expect(w.h.interceptLegacy({ ok: true, __authStatus: true })).toBe(false);
    expect(w.h.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 })).toBe(true);
    expect(w.sup.noteEvidence).toHaveBeenCalledWith({ sessionMin: 600, diskAeaMin: 30 });
    expect(prop.interceptLegacy({ ok: true })).toBe(true);    // module-level delegate uses the current handle
    const dbg = w.log.lines.filter((l) => l.level === 'debug').map((l) => l.msg);
    expect(dbg.some((m) => m.includes('shape=string'))).toBe(true);
    expect(dbg.join('\n')).not.toContain('spawn failed');      // shape only, never content
  });

  it('fails open (returns false) on an internal error', () => {
    const sup = fakeSup();
    sup.noteEvidence = () => { throw new Error('boom'); };
    const w = world({ sup });
    expect(w.h.interceptLegacy({ ok: true, expiresInMin: 5 })).toBe(false);
    expect(w.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);
    expect(w.h.interceptLegacy({ ok: true, expiresInMin: 5 })).toBe(false);
    expect(w.log.lines.filter((l) => l.level === 'warn')).toHaveLength(1);   // warn once
  });

  it('heartbeat-shaped payloads schedule refreshLive at most once per 60 s; the live AEA lands in status.evidence.liveAeaMin', async () => {
    realSup._setDeps({ propagation: true });
    const imm = [];
    realSup._setTimers({ immediate: (fn) => imm.push(fn) });
    let live = 7;
    const auth = { aeaSessionExpiryMin: vi.fn(async () => { await Promise.resolve(); return live; }) };
    const w = world({ sup: realSup, auth });
    expect(w.h.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 })).toBe(true);
    await flush();
    expect(auth.aeaSessionExpiryMin).toHaveBeenCalledTimes(1);
    let ev = realSup.getStatus().evidence;
    expect(ev.liveAeaMin).toBe(7);
    expect(ev.sessionMin).toBe(600);
    expect(ev.diskAeaMin).toBe(30);
    live = 3;
    w.advance(30 * 1000);
    w.h.interceptLegacy({ ok: true, expiresInMin: 599, aeaExpiresInMin: 29 });
    await flush();
    expect(auth.aeaSessionExpiryMin).toHaveBeenCalledTimes(1);
    expect(realSup.getStatus().evidence.liveAeaMin).toBe(7);
    w.advance(31 * 1000);
    w.h.interceptLegacy({ ok: true, expiresInMin: 598, aeaExpiresInMin: 28 });
    await flush();
    expect(auth.aeaSessionExpiryMin).toHaveBeenCalledTimes(2);
    ev = realSup.getStatus().evidence;
    expect(ev.liveAeaMin).toBe(3);
    expect(ev.sessionMin).toBe(598);
  });

  it('refreshLive records null when the live read rejects or is not a number', async () => {
    realSup._setDeps({ propagation: true });
    realSup._setTimers({ immediate: () => {} });
    const auth = { aeaSessionExpiryMin: vi.fn(async () => { throw new Error('x'); }) };
    const w = world({ sup: realSup, auth });
    realSup.noteEvidence({ liveAeaMin: 9 });
    expect(await w.h.refreshLive()).toBeNull();
    expect(realSup.getStatus().evidence.liveAeaMin).toBeNull();
    auth.aeaSessionExpiryMin = vi.fn(async () => 'n/a');
    expect(await w.h.refreshLive()).toBeNull();
  });
});

describe('F10: heartbeat sticky refresh', () => {
  it('F10: heartbeat-shaped payload through interceptLegacy calls refreshSticky(heartbeat) once and is bounded by the 5-min limit', async () => {
    // Spy level: one call per heartbeat-shaped payload, with the injected sticky deps.
    const w1 = world();
    w1.h.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 });
    expect(w1.d.seeder.refreshSticky).toHaveBeenCalledTimes(1);
    expect(w1.d.seeder.refreshSticky).toHaveBeenCalledWith('heartbeat', w1.d.stickyDeps);
    prop._reset();
    // Real seeder: bounded by its 5-min per-partition limit and the seeded-this-process rule.
    let t = 5_000_000;
    const seed = vi.fn(async () => ({ ok: true }));
    const stickyDeps = { now: () => t, seed, fromPartition: () => ({ cookies: { set() {} } }) };
    const w = world({ seeder, stickyDeps });
    w.h.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 });
    await flush();
    expect(seed).not.toHaveBeenCalled();                      // persist:vendor-uptake never seeded this process
    seeder._seededThisProcess.add('persist:vendor-uptake');
    w.h.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 });
    await flush();
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0][1]).toEqual({ reason: 'sticky:heartbeat', partition: 'persist:vendor-uptake' });
    t += 4 * 60 * 1000;
    w.h.interceptLegacy({ ok: true, expiresInMin: 596, aeaExpiresInMin: 26 });
    await flush();
    expect(seed).toHaveBeenCalledTimes(1);
    t += 61 * 1000;
    w.h.interceptLegacy({ ok: true, expiresInMin: 595, aeaExpiresInMin: 25 });
    await flush();
    expect(seed).toHaveBeenCalledTimes(2);
  });

  it('F10: non-heartbeat legacy payloads do not trigger refreshSticky', () => {
    const w = world();
    for (const p of [{ ok: true }, { ok: false, reason: 'x' }, 'running', 'launched', 'error:x', null, { ok: true, __authStatus: true }, { expiresInMin: 'soon' }]) w.h.interceptLegacy(p);
    expect(w.d.seeder.refreshSticky).not.toHaveBeenCalled();
  });

  it('F10: flag off interceptLegacy returns false and never calls refreshSticky', () => {
    const refreshSticky = vi.fn();
    const sup = fakeSup();
    const h = prop.init({ sendRaw: () => {}, getCtx: () => null, deps: { authReport: OFF, supervisor: sup, seeder: { refreshSticky } } });
    expect(h).toBeNull();
    expect(prop.interceptLegacy({ ok: true, expiresInMin: 600, aeaExpiresInMin: 30 })).toBe(false);
    expect(refreshSticky).not.toHaveBeenCalled();
    expect(sup.noteEvidence).not.toHaveBeenCalled();
  });
});

describe('static wiring', () => {
  const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8').replace(/\r\n/g, '\n');

  it('F12: app:midway-* send sites are unchanged', () => {
    const app = read('../src/app.js');
    expect(app).toContain("_send('app:midway-renewing', { expiresIn: state.expiresInMin });");
    expect(app.split("if (renewed) _send('app:midway-renewed', {});").length - 1).toBe(2);
    expect(app).toContain("_send('app:midway-expired', {});");
    expect((app.match(/app:midway-/g) || []).length).toBe(4);
    expect(read('../src/auth/propagation.js')).not.toMatch(/sendRaw\(\s*['"]app:midway-/);
    expect(read('../src/auth/propagation.js')).not.toMatch(/send\(\s*['"]app:midway-/);
  });

  it('app.js initialises propagation right after _authCoordFlags with the TDZ-safe getCtx and a legacy fallback', () => {
    const app = read('../src/app.js');
    const i = app.indexOf('const _authCoordFlags =');
    const block = app.slice(i, i + 800);
    expect(block).toContain("if (require('./auth/auth-report').isEnabled()) {");
    expect(block).toContain("_authPropagation = require('./auth/propagation').init({ sendRaw: _sendRaw, getCtx: () => { try { return _ctx; } catch (_) { return null; } } });");
    expect(block).toContain('_authPropagation = null;');
    expect(app.indexOf('let _authPropagation = null;')).toBeLessThan(app.indexOf('function _send(channel, payload)'));
  });

  it('propagation has no currentMessage()', () => {
    expect(read('../src/auth/propagation.js')).not.toContain('currentMessage');
  });
});
