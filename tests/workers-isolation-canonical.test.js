// tests/workers-isolation-canonical.test.js — requestCanonicalPass, lane, fallbacks, generation
// check, stage_refresh ordering (design §6, review M1/N3/N4/N7).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const runner = require('../src/orcha/canonical_runner');
const iso = require('../src/workers/isolation');
const groups = require('../src/workers/isolation/groups');
const telemetry = require('../src/telemetry');
const sr = require('../src/orcha/stage_refresh');
const { OPS } = require('../src/workers/isolation/entries/canonical-worker');

const NOW = Date.parse('2026-10-29T14:00:00Z');
const SINCE = '2026-10-29T09:00:00-04:00';
const ROWS = [
  { equipmentId: 'U1', lifecycleState: 'Unavailable', issueSummary: 'turbo replacement', offsiteStage: 'ready', offsiteStageSince: SINCE, _offsiteWrId: 'w1' },
  { equipmentId: 'U2', lifecycleState: 'Available' },
];
const INITIAL = () => ({
  fleetData: { rows: ROWS },
  canonicalState: { updatedAt: new Date(NOW - 20 * 60000).toISOString(),
    units: { U1: { equipmentId: 'U1', status: 'in_repair', updatedAt: new Date(NOW - 20 * 60000).toISOString() } } },
});

function recStore(initial, { withGen = true } = {}) {
  const data = structuredClone(initial);
  const gen = {};
  const calls = [];
  const s = {
    data, calls, gen,
    load: (k, d) => { calls.push(['load', k]); return k in data ? structuredClone(data[k]) : d; },
    save: (k, v) => { calls.push(['save', k]); data[k] = structuredClone(v); gen[k] = (gen[k] || 0) + 1; },
    bump: (k) => { gen[k] = (gen[k] || 0) + 1; },
  };
  if (withGen) s.generation = (k) => gen[k] || 0;
  return s;
}
function fakeNotify() {
  const calls = [];
  return { calls, _isFreshReady: (rec) => !!(rec && rec.status === 'ready_for_pickup' && rec.previousStatus && rec.previousStatus !== 'ready_for_pickup'),
    enqueue: (fn) => Promise.resolve().then(fn), notifyReadyUnits: vi.fn(async (units) => { calls.push(Object.keys(units).sort()); return {}; }) };
}
function mkOpts(store, extra = {}) {
  const pushed = [];
  const log = { info: vi.fn(), warn: vi.fn() };
  const rn = fakeNotify();
  const ctx = {};
  const opts = Object.assign({ pushData: (p) => pushed.push(structuredClone(p)), ctx, deps: { store, readyNotify: rn, notifyDeps: {}, now: () => NOW, log } }, extra);
  return { opts, pushed, log, rn, ctx };
}
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// Worker OPS run in-process behind a structured-clone boundary, validated like the real host.
async function workerRun(op, payload) {
  const out = structuredClone(await OPS[op](structuredClone(payload)));
  const v = groups.validateCanonicalResult(op, out, payload);
  return v.ok ? { ok: true, result: v.value, workerMs: 3 } : { ok: false, code: 'INVALID_RESULT', message: v.rule };
}
function fakeHost(specOver = {}) {
  const fallbacks = {};
  const h = {
    name: 'isoCanonical', group: 'canonical', spec: Object.assign({}, groups.canonical, specOver), state: 'ready', fallbacks,
    request: vi.fn(workerRun),
    noteFallback: (why) => { fallbacks[why] = (fallbacks[why] || 0) + 1; },
    noteTiming: vi.fn(), warnOnce: () => true, start() {}, shutdown() {}, resume() {}, killSync() {}, _dispose() {},
    getStatusRow: () => ({ name: 'isoCanonical', state: 'healthy', counts: {} }), reEnable: () => false,
  };
  return h;
}
function activate(host) {
  iso._resetForTests();
  const r = iso.init({ flags: { enabled: true, groups: { canonical: true } }, supervisor: { isEnabled: () => true, registerHost() {} }, logger: { debug() {}, info() {}, warn() {}, error() {} }, deps: { createHost: () => host } });
  expect(r.enabled).toBe(true);
  return host;
}
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  iso._resetForTests();
  runner._resetLaneForTests();
  sr._resetForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  iso._resetForTests();
  runner._resetLaneForTests();
});

describe('requestCanonicalPass', () => {
  it('flags off: requestCanonicalPass is sync and identical to runCanonicalPass', async () => {
    const a = recStore(INITIAL());
    const b = recStore(INITIAL());
    const A = mkOpts(a);
    const B = mkOpts(b);
    const ra = runner.runCanonicalPass(A.opts);
    const rb = runner.requestCanonicalPass(B.opts);
    expect(rb && typeof rb.then).not.toBe('function');
    expect(rb).toEqual(ra);
    expect(rb.notifyQueued).toBe(true);
    expect(b.calls).toEqual(a.calls);
    expect(b.calls).toEqual([['load', 'fleetData'], ['load', 'canonicalState'], ['save', 'canonicalState'], ['save', 'fleetData']]);
    expect(b.data).toEqual(a.data);
    expect(B.pushed).toEqual(A.pushed);
    expect(B.log.info.mock.calls).toEqual(A.log.info.mock.calls);
    await flush();
    expect(B.rn.calls).toEqual(A.rn.calls);
  });

  it('store gate: no generation() → sync, host never called', () => {
    const host = activate(fakeHost());
    const s = recStore(INITIAL(), { withGen: false });
    const r = runner.requestCanonicalPass(mkOpts(s).opts);
    expect(r && typeof r.then).not.toBe('function');
    expect(r.ok).toBe(true);
    expect(host.request).not.toHaveBeenCalled();
  });

  it('isolated parity: worker OPS result commits the same saves, pushData and notify as legacy', async () => {
    const a = recStore(INITIAL());
    const A = mkOpts(a);
    const ra = runner.runCanonicalPass(A.opts);
    const host = activate(fakeHost());
    const b = recStore(INITIAL());
    const B = mkOpts(b);
    const p = runner.requestCanonicalPass(B.opts);
    expect(typeof p.then).toBe('function');
    const rb = await p;
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request.mock.calls[0][0]).toBe('canonical.buildAll');
    expect(rb).toMatchObject({ isolated: true, workerMs: 3 });
    const { isolated, workerMs, ...rest } = rb;
    expect(rest).toEqual(ra);
    expect(b.data).toEqual(a.data);
    expect(b.calls).toEqual(a.calls);
    expect(B.pushed).toEqual(A.pushed);
    expect(B.ctx.lastData).toEqual(A.ctx.lastData);
    await flush();
    expect(B.rn.calls).toEqual(A.rn.calls);
    expect(B.rn.calls).toEqual([['U1', 'U2']]);
    expect(B.log.info.mock.calls[0][0]).toMatch(/ \(isolated: worker 3 ms, main \d+ ms\)$/);
    expect(host.fallbacks).toEqual({});
  });

  it('stale: generation bump → zero saves from _commit then in-process', async () => {
    const host = activate(fakeHost());
    const s = recStore(INITIAL());
    host.request.mockImplementation(async (op, payload) => { s.bump('canonicalState'); return workerRun(op, payload); });
    const O = mkOpts(s);
    const r = await runner.requestCanonicalPass(O.opts);
    expect(r.ok).toBe(true);
    expect(r.isolated).toBeUndefined();
    expect(s.calls).toEqual([['load', 'fleetData'], ['load', 'canonicalState'],
      ['load', 'fleetData'], ['load', 'canonicalState'], ['save', 'canonicalState'], ['save', 'fleetData']]);
    expect(host.fallbacks).toEqual({ stale: 1 });
    expect(O.log.info).toHaveBeenCalledWith('[worker:canonical] running in-process (stale)');
    expect(O.pushed).toHaveLength(1);
  });

  it('each failure code falls back in-process exactly once', async () => {
    const codes = ['NOT_READY', 'TIMEOUT', 'CRASHED', 'RSS_LIMIT', 'PROTOCOL', 'INVALID_RESULT', 'OP_FAILED', 'CLONE_ERROR', 'SHUTDOWN'];
    for (const code of codes) {
      const host = activate(fakeHost());
      host.request.mockResolvedValue({ ok: false, code, message: 'x' });
      const s = recStore(INITIAL());
      const O = mkOpts(s);
      const r = await runner.requestCanonicalPass(O.opts);
      const why = code.toLowerCase().replace(/_/g, '-');
      expect(r.ok, code).toBe(true);
      expect(host.fallbacks, code).toEqual({ [why]: 1 });
      expect(s.calls.filter((c) => c[0] === 'save'), code).toEqual([['save', 'canonicalState'], ['save', 'fleetData']]);
      expect(O.pushed, code).toHaveLength(1);
      expect(O.log.warn).toHaveBeenCalledWith('[worker:canonical] running in-process (' + why + ')');
      runner._resetLaneForTests();
    }
    // a host that is not ready never gets a request
    const host = activate(fakeHost());
    host.state = 'backoff';
    const s = recStore(INITIAL());
    expect((await runner.requestCanonicalPass(mkOpts(s).opts)).ok).toBe(true);
    expect(host.request).not.toHaveBeenCalled();
    expect(host.fallbacks).toEqual({ 'not-ready': 1 });
  });

  it('SHUTDOWN with 2 queued → 3 in-process passes FIFO', async () => {
    const host = activate(fakeHost());
    const held = deferred();
    host.request.mockImplementationOnce(() => held.p);
    const s = recStore(INITIAL());
    const order = [];
    const mk = (tag) => mkOpts(s, { pushData: () => order.push(tag) }).opts;
    const pa = runner.requestCanonicalPass(mk('a'));
    const pb = runner.requestCanonicalPass(mk('b'));
    const pc = runner.requestCanonicalPass(mk('c'));
    await flush();
    expect(host.request).toHaveBeenCalledTimes(1);
    host.state = 'stopping';
    held.resolve({ ok: false, code: 'SHUTDOWN', message: 'shutdown' });
    const res = await Promise.all([pa, pb, pc]);
    expect(res.every((r) => r && r.ok === true)).toBe(true);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(host.fallbacks).toEqual({ shutdown: 1, 'not-ready': 2 });
    expect(s.calls.filter((c) => c[0] === 'save')).toHaveLength(6);   // each pass writes once
  });

  it('prepare-error uses legacy WARN text', async () => {
    const host = activate(fakeHost());
    const s = recStore(INITIAL());
    s.load = () => { throw new Error('disk gone'); };
    const O = mkOpts(s);
    const r = await runner.requestCanonicalPass(O.opts);
    expect(r).toEqual({ ok: false, reason: 'error' });
    expect(host.fallbacks).toEqual({ 'prepare-error': 1 });
    expect(O.log.warn).toHaveBeenCalledWith('[canonical] API-mode pass error (non-fatal): disk gone');
    expect(host.request).not.toHaveBeenCalled();
  });

  it('host request throw → internal; promise always resolves', async () => {
    const host = activate(fakeHost());
    host.request.mockImplementation(() => { throw new Error('host bug'); });
    const s = recStore(INITIAL());
    const r = await runner.requestCanonicalPass(mkOpts(s).opts);
    expect(r.ok).toBe(true);
    expect(host.fallbacks).toEqual({ internal: 1 });
    // a commit throw is not retried: legacy WARN text, { ok:false, reason:'error' }
    const host2 = activate(fakeHost());
    const s2 = recStore(INITIAL());
    let n = 0;
    s2.save = () => { n++; throw new Error('EPERM rename'); };
    const O2 = mkOpts(s2);
    const r2 = await runner.requestCanonicalPass(O2.opts);
    expect(r2).toEqual({ ok: false, reason: 'error' });
    expect(n).toBe(1);
    expect(O2.log.warn).toHaveBeenCalledWith('[canonical] API-mode pass error (non-fatal): EPERM rename');
    expect(host2.fallbacks).toEqual({});
    // no fleet rows → same early result as legacy
    activate(fakeHost());
    const r3 = await runner.requestCanonicalPass(mkOpts(recStore({ fleetData: { rows: [] } })).opts);
    expect(r3).toEqual({ ok: false, reason: 'no fleet rows' });
  });

  it('lane FIFO and overflow on 6th', async () => {
    const host = activate(fakeHost());
    const held = deferred();
    host.request.mockImplementationOnce(() => held.p);
    const s = recStore(INITIAL());
    const order = [];
    const ps = [];
    for (const tag of ['1', '2', '3', '4', '5']) ps.push(runner.requestCanonicalPass(mkOpts(s, { pushData: () => order.push(tag) }).opts));
    await flush();
    expect(order).toEqual([]);
    ps.push(runner.requestCanonicalPass(mkOpts(s, { pushData: () => order.push('6') }).opts));
    expect(order).toEqual(['6']);                       // overflow ran synchronously, out of FIFO
    held.resolve(await workerRun('canonical.buildAll', host.request.mock.calls[0][1]));
    await Promise.all(ps);
    expect(order).toEqual(['6', '1', '2', '3', '4', '5']);
    expect(host.request).toHaveBeenCalledTimes(5);
  });

  it('overflow runs in-process immediately, out of FIFO, and the in-flight pass is discarded as stale (N3)', async () => {
    const host = activate(fakeHost());
    const held = deferred();
    host.request.mockImplementationOnce(() => held.p);
    const real = recStore(INITIAL());
    const order = [];
    const ps = [];
    for (const tag of ['a', 'b', 'c', 'd', 'e']) ps.push(runner.requestCanonicalPass(mkOpts(real, { pushData: () => order.push(tag) }).opts));
    await flush();
    expect(host.request).toHaveBeenCalledTimes(1);
    const savesBefore = real.calls.filter((c) => c[0] === 'save').length;
    const genBefore = real.generation('fleetData');
    const p6 = runner.requestCanonicalPass(mkOpts(real, { pushData: () => order.push('f') }).opts);
    // The 6th ran _inProcess synchronously, before any queued pass; its saves bumped the generations.
    expect(order).toEqual(['f']);
    expect(real.calls.filter((c) => c[0] === 'save').length).toBe(savesBefore + 2);
    expect(real.generation('fleetData')).toBe(genBefore + 1);
    expect(host.fallbacks).toEqual({ overflow: 1 });
    const callsBefore = real.calls.length;
    held.resolve(await workerRun('canonical.buildAll', host.request.mock.calls[0][1]));
    await Promise.all(ps.concat([p6]));
    // The held pass's _commit returned STALE (zero saves) and re-ran in-process.
    const after = real.calls.slice(callsBefore, callsBefore + 6);
    expect(after).toEqual([['load', 'fleetData'], ['load', 'canonicalState'], ['save', 'canonicalState'], ['save', 'fleetData'],
      ['load', 'fleetData'], ['load', 'canonicalState']]);
    expect(order).toEqual(['f', 'a', 'b', 'c', 'd', 'e']);
    expect(host.fallbacks).toEqual({ overflow: 1, stale: 1 });
  });

  it('rows-limit: >20000 rows falls back right after _prepare with its own fallbacks key (N3)', async () => {
    const host = activate(fakeHost());
    const rows = Array.from({ length: runner.ROWS_LIMIT + 1 }, (_, i) => ({ equipmentId: 'R' + i }));
    const s = recStore({ fleetData: { rows }, canonicalState: {} });
    const stub = { buildAll: vi.fn(() => ({ units: {}, counts: { total: 0, reconciled: 0, baseline: 0, changed: 0 } })), mirrorFields: () => ({}) };
    const O = mkOpts(s);
    O.opts.deps.canonical = stub;
    const r = await runner.requestCanonicalPass(O.opts);
    expect(r.ok).toBe(true);
    expect(host.request).not.toHaveBeenCalled();
    expect(host.fallbacks).toEqual({ 'rows-limit': 1 });
    expect(host.fallbacks.overflow).toBeUndefined();
    expect(stub.buildAll).toHaveBeenCalledTimes(1);   // the in-process pass, once
    expect(O.log.warn).toHaveBeenCalledWith('[worker:canonical] running in-process (rows-limit)');
  });

  it('telemetry tracks canonical.request once per requestCanonicalPass while isolation is active (N7)', async () => {
    const track = vi.spyOn(telemetry, 'track');
    const host = activate(fakeHost({ queueMax: 1 }));
    const held = deferred();
    host.request.mockImplementationOnce(() => held.p);
    const s = recStore(INITIAL());
    const p1 = runner.requestCanonicalPass(mkOpts(s).opts);   // in flight
    await flush();
    const p2 = runner.requestCanonicalPass(mkOpts(s).opts);   // queued → will be not-ready
    const p3 = runner.requestCanonicalPass(mkOpts(s).opts);   // overflow
    host.state = 'busy';
    held.resolve({ ok: false, code: 'TIMEOUT', message: 't' });
    await Promise.all([p1, p2, p3]);
    const reqTracks = () => track.mock.calls.filter((c) => c[0] === 'canonical.request').length;
    expect(reqTracks()).toBe(3);
    expect(host.fallbacks).toEqual({ overflow: 1, timeout: 1, 'not-ready': 1 });
    iso._resetForTests();
    track.mockClear();
    runner.requestCanonicalPass(mkOpts(recStore(INITIAL())).opts);
    runner.requestCanonicalPass(mkOpts(recStore(INITIAL())).opts);
    expect(reqTracks()).toBe(0);
    expect(track.mock.calls.filter((c) => c[0] === 'canonical.pass')).toHaveLength(2);
  });
});

describe('stage_refresh with an isolated pass', () => {
  const ROWS_SR = () => [{ equipmentId: 'B62274', _offsiteWrId: 'w2', offsiteShopEventUrl: 'https://paccarpg.decisiv.net/fleet/estimates/21467830' }];
  function srDeps(runCanonicalPass, order) {
    const data = { fleetData: { rows: ROWS_SR() } };
    return {
      store: { load: (k, d) => (k in data ? data[k] : d), save: (k, v) => { data[k] = v; } },
      decisiv: { getCaseStatusSummary: vi.fn(async () => ({ ok: true, stage: 'ready', status: 'Asset Ready', since: '2026-10-29T08:00:00-04:00' })) },
      readyNotify: { onStageUpdate: () => { order.push('onStageUpdate'); return Promise.resolve({}); } },
      runCanonicalPass,
      log: { info() {}, warn() {} },
    };
  }

  it('stage_refresh: thenable runner is awaited before onStageUpdate; sync runner is not awaited', async () => {
    const order = [];
    const d = deferred();
    const thenable = vi.fn(() => { order.push('canonical:start'); return d.p.then((v) => { order.push('canonical:commit'); return v; }); });
    const p = sr.refreshStages({ deps: srDeps(thenable, order), force: true });
    await flush();
    expect(order).toEqual(['canonical:start']);
    d.resolve({ ok: true });
    await p;
    expect(order).toEqual(['canonical:start', 'canonical:commit', 'onStageUpdate']);

    sr._resetForTests();
    const order2 = [];
    const res = { ok: true, then: undefined };
    const sync = vi.fn(() => { order2.push('canonical'); return res; });
    await sr.refreshStages({ deps: srDeps(sync, order2), force: true });
    expect(order2).toEqual(['canonical', 'onStageUpdate']);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('stage_refresh: overlapping refresh during an isolated pass returns already running (N4)', async () => {
    const order = [];
    const d = deferred();
    const runner2 = vi.fn(() => d.p);
    const deps = srDeps(runner2, order);
    const first = sr.refreshStages({ deps, force: true });
    await flush();
    expect(runner2).toHaveBeenCalledTimes(1);
    expect(await sr.refreshStages({ deps, force: true })).toEqual({ ran: false, reason: 'already running' });
    d.resolve({ ok: true });
    expect((await first).ran).toBe(true);
    runner2.mockImplementation(() => ({ ok: true }));
    expect((await sr.refreshStages({ deps, force: true })).ran).toBe(true);
    expect(runner2).toHaveBeenCalledTimes(2);
  });
});
