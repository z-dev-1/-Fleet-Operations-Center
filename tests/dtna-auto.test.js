// DTNA Phase D: src/dtna/auto.js — the sync pass's session-gated, throttled entry into DTNA.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';
import { createFakeElectron, emitAuraSuccess, freshDtna, WT_ROOT } from './fixtures/dtna/fake-electron.js';
import { CASE_ID, NO_RO_CASE_ID } from './fixtures/dtna/aura-responses.js';

const require = createRequire(import.meta.url);

let logger;
let auto;
let tmp;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-auto-'));
  require('../src/config/paths').setDataDir(tmp);
  logger = installFakeLogger(require);
  freshDtna(require);
  auto = require('../src/dtna/auto.js');
});
afterAll(() => { logger.restore(); freshDtna(require); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });

const NOW = Date.parse('2026-11-22T15:00:00.000Z');
const MIN = 60e3;
const iso = (ms) => new Date(ms).toISOString();
const id = (n) => '500gx' + String(n).padStart(13, '0');
const caseUrl = (c) => 'https://dtna.my.site.com/Servicetracker/s/case/' + c + '/detail';

function entry(o) {
  return Object.assign({
    caseId: CASE_ID, caseNumber: '15667050', unitId: '122269', serial: 'NP6923', caseStatus: 'In Repair', steps: [],
    repairOrderNo: 'R101048154', offsiteText: 'old thread', thread: 'old thread', offsiteStage: 'repair', stageSince: '',
    commentCount: 1, pulledAt: iso(NOW - 3 * 60 * MIN), source: 'aura',
  }, o);
}

let cache;
let open;
let client;
function setup(o = {}) {
  cache = new Map((o.entries || []).map((e) => [e.caseId, e]));
  open = o.open !== undefined ? o.open : true;
  client = {
    inflight: 0,
    maxInflight: 0,
    pullCase: vi.fn(async (cid, opts) => {
      client.inflight++;
      client.maxInflight = Math.max(client.maxInflight, client.inflight);
      try {
        if (o.delay) await new Promise((r) => setTimeout(r, o.delay));
        if (o.pull) return o.pull(cid, opts);
        const e = entry({ caseId: cid, offsiteText: 'fresh thread', pulledAt: iso(NOW) });
        cache.set(cid, e);
        return { ok: true, entry: e };
      } finally { client.inflight--; }
    }),
    listCaseIds: vi.fn(async () => (o.listFail ? { ok: false, code: o.listFail } : { ok: true, ids: o.ids || [] })),
  };
  const store = { get: (cid) => cache.get(cid) || null, all: () => [...cache.values()] };
  auto._resetForTests();
  const session = Object.assign({ canAutoSync: () => open }, o.session || {});
  auto._setDeps({ client, session, store, now: () => NOW, sleep: async () => {} });
}

beforeEach(() => { logger.clear(); });

describe('gate', () => {
  it('follows session.canAutoSync with no network', () => {
    setup({ open: true });
    expect(auto.gate()).toEqual({ ok: true });
    setup({ open: false });
    expect(auto.gate()).toEqual({ ok: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(client.pullCase).not.toHaveBeenCalled();
  });
});

describe('pullIfStale', () => {
  it('signed out: never calls pullCase, returns the cached entry', async () => {
    const e = entry();
    setup({ open: false, entries: [e] });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: 2 * 60 * MIN })).toEqual({ ok: true, entry: e, live: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(await auto.pullIfStale(NO_RO_CASE_ID, { freshMs: 2 * 60 * MIN })).toEqual({ ok: false, entry: null, live: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(client.pullCase).not.toHaveBeenCalled();
  });

  it('a fresh entry is used with no call (throttle honored)', async () => {
    const e = entry({ pulledAt: iso(NOW - 10 * MIN) });
    setup({ entries: [e] });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: 2 * 60 * MIN })).toEqual({ ok: true, entry: e, live: false });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: 15 * MIN })).toMatchObject({ live: false });
    expect(client.pullCase).not.toHaveBeenCalled();
  });

  it('a stale entry while signed in -> exactly one silent pull', async () => {
    setup({ entries: [entry()] });
    const r = await auto.pullIfStale(CASE_ID, { freshMs: 2 * 60 * MIN });
    expect(r).toMatchObject({ ok: true, live: true, entry: { offsiteText: 'fresh thread' } });
    expect(client.pullCase).toHaveBeenCalledTimes(1);
    expect(client.pullCase).toHaveBeenCalledWith(CASE_ID, { silent: true });
  });

  it('no freshMs (and force) always tries live', async () => {
    setup({ entries: [entry({ pulledAt: iso(NOW - MIN) })] });
    await auto.pullIfStale(CASE_ID);
    await auto.pullIfStale(CASE_ID, { freshMs: 60 * MIN, force: true });
    expect(client.pullCase).toHaveBeenCalledTimes(2);
  });

  it('a failed pull returns the old cached entry with the code', async () => {
    const e = entry();
    setup({ entries: [e], pull: () => ({ ok: false, code: 'DTNA_TIMEOUT' }) });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: 60 * MIN })).toEqual({ ok: false, entry: e, live: true, code: 'DTNA_TIMEOUT' });
  });

  it('at most 3 pulls run at once; concurrent asks for one case share one pull', async () => {
    setup({ delay: 5 });
    const ids = Array.from({ length: 7 }, (_, i) => id(i));
    await Promise.all(ids.map((c) => auto.pullIfStale(c, { freshMs: MIN })).concat([auto.pullIfStale(ids[0], { freshMs: MIN })]));
    expect(client.pullCase).toHaveBeenCalledTimes(7);
    expect(client.maxInflight).toBe(3);
  });

  it('an invalid case id -> DTNA_INVALID_INPUT, no call', async () => {
    setup();
    expect((await auto.pullIfStale('nope')).code).toBe('DTNA_INVALID_INPUT');
    expect(client.pullCase).not.toHaveBeenCalled();
  });

  it('logs: one pull line with op/caseTag/code/ms; one skip line for 5 signed-out calls', async () => {
    setup({ entries: [entry()] });
    await auto.pullIfStale(CASE_ID, { freshMs: MIN });
    const pulls = logger.lines.filter((l) => l.args[0] === '[dtna] auto' && l.args[1].op === 'pull');
    expect(pulls).toHaveLength(1);
    expect(Object.keys(pulls[0].args[1]).sort()).toEqual(['caseTag', 'code', 'ms', 'op']);
    expect(pulls[0].args[1]).toMatchObject({ caseTag: '4U5AAK', code: 'OK' });
    logger.clear();
    open = false;
    for (let i = 0; i < 5; i++) await auto.pullIfStale(CASE_ID);
    const skips = logger.lines.filter((l) => l.args[0] === '[dtna] auto');
    expect(skips).toHaveLength(1);
    expect(skips[0].args[1]).toEqual({ op: 'skip', code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(logger.text()).not.toMatch(/old thread|fresh thread|R101048154|15667050|dtna\.my\.site\.com/);
  });
});

describe('Phase E: ensureSignedIn (silent re-login before a sync read)', () => {
  it('signed out + a background sign-in that succeeds -> one shared sign-in for 3 concurrent pulls, then live pulls', async () => {
    const backgroundLogin = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); open = true; return { ok: true }; });
    setup({ open: false, entries: [entry()], session: { backgroundLogin } });
    const ids = [CASE_ID, id(1), id(2)];
    const rs = await Promise.all(ids.map((c) => auto.pullIfStale(c, { freshMs: MIN })));
    expect(backgroundLogin).toHaveBeenCalledTimes(1);
    expect(backgroundLogin).toHaveBeenCalledWith({ reason: 'sync' });
    expect(rs.every((r) => r.ok && r.live)).toBe(true);
    expect(client.pullCase).toHaveBeenCalledTimes(3);
    expect(logger.lines.filter((l) => l.args[0] === '[dtna] auto' && l.args[1].op === 'skip')).toHaveLength(0);
  });

  it('a failed background sign-in -> the cached entry + DTNA_AUTO_SIGNED_OUT, no pullCase', async () => {
    const e = entry();
    const backgroundLogin = vi.fn(async () => ({ ok: false, code: 'DTNA_SIGNIN_ACTION_NEEDED' }));
    setup({ open: false, entries: [e], session: { backgroundLogin } });
    expect(await auto.pullIfStale(CASE_ID, { freshMs: MIN })).toEqual({ ok: true, entry: e, live: false, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(await auto.discover({ units: ['X'], budget: 3 })).toEqual({ pulled: 0, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(client.pullCase).not.toHaveBeenCalled();
    expect(client.listCaseIds).not.toHaveBeenCalled();
    expect(backgroundLogin).toHaveBeenCalledTimes(2);
  });

  it('a throwing background sign-in is treated as signed out', async () => {
    setup({ open: false, session: { backgroundLogin: async () => { throw new Error('x'); } } });
    expect(await auto.ensureSignedIn()).toEqual({ ok: false, code: 'DTNA_AUTO_SIGNED_OUT' });
  });

  it('signed in -> ok with no background call; discovery proceeds after a silent re-login', async () => {
    const backgroundLogin = vi.fn(async () => { open = true; return { ok: true }; });
    setup({ open: true, session: { backgroundLogin } });
    expect(await auto.ensureSignedIn()).toEqual({ ok: true });
    expect(backgroundLogin).not.toHaveBeenCalled();
    const ids = [id(1), id(2)];
    setup({ open: false, ids, session: { backgroundLogin }, pull: (cid) => ({ ok: true, entry: entry({ caseId: cid, unitId: 'U' + cid.slice(-2) }) }) });
    expect(await auto.discover({ units: ['NOT-THERE'], budget: 2 })).toEqual({ pulled: 2, code: 'OK' });
    expect(backgroundLogin).toHaveBeenCalledTimes(1);
  });
});

describe('discover', () => {
  it('signed out -> no list read, no pulls', async () => {
    setup({ open: false, ids: [id(1)] });
    expect(await auto.discover({ units: ['X1'], budget: 10 })).toEqual({ pulled: 0, code: 'DTNA_AUTO_SIGNED_OUT' });
    expect(client.listCaseIds).not.toHaveBeenCalled();
    expect(client.pullCase).not.toHaveBeenCalled();
  });

  it('reads uncached listed cases case-only and silently, within the budget', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => id(i));
    setup({ ids, entries: [entry({ caseId: ids[0] })], pull: (cid) => ({ ok: true, entry: entry({ caseId: cid, unitId: 'U' + cid.slice(-2) }) }) });
    const r = await auto.discover({ units: ['NOT-THERE'], budget: 4 });
    expect(r).toEqual({ pulled: 4, code: 'OK' });
    expect(client.listCaseIds).toHaveBeenCalledWith({ silent: true });
    expect(client.pullCase.mock.calls.map((c) => c[0])).toEqual(ids.slice(1, 5));
    expect(client.pullCase.mock.calls.every((c) => c[1].includeComments === false && c[1].silent === true)).toBe(true);
    // A case discovery already read is not read again this run.
    client.pullCase.mockClear();
    await auto.discover({ units: ['NOT-THERE'], budget: 2 });
    expect(client.pullCase.mock.calls.map((c) => c[0])).toEqual(ids.slice(5, 7));
  });

  it('stops on DTNA_SIGNIN_REQUIRED', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => id(i));
    setup({ ids, pull: () => ({ ok: false, code: 'DTNA_SIGNIN_REQUIRED' }) });
    expect(await auto.discover({ units: ['X'], budget: 9 })).toEqual({ pulled: 0, code: 'DTNA_SIGNIN_REQUIRED' });
    expect(client.pullCase).toHaveBeenCalledTimes(3);
  });

  it('stops once every requested unit has a case', async () => {
    const ids = Array.from({ length: 9 }, (_, i) => id(i));
    setup({ ids, pull: (cid) => ({ ok: true, entry: entry({ caseId: cid, unitId: cid === ids[1] ? '122269' : 'OTHER' }) }) });
    expect(await auto.discover({ units: ['122269'], budget: 9 })).toEqual({ pulled: 3, code: 'OK' });
  });
});

describe('applyCachedCase (unit-number join, cache only)', () => {
  it('a FREIGHTLINER row with no offsite link gets its open cached case: URL, _offsiteWrId, dtnaCaseNumber', () => {
    setup({ entries: [entry()] });
    const row = { equipmentId: '122269', workRequestId: 'WR1', vendor: 'FREIGHTLINER', created: '2026-11-01T00:00:00Z' };
    expect(auto.applyCachedCase(row, {})).toEqual({ applied: true, reason: 'ok' });
    expect(row).toMatchObject({ offsiteShopEventUrl: caseUrl(CASE_ID), asistSrUrl: caseUrl(CASE_ID), _offsiteWrId: 'WR1', dtnaCaseNumber: '15667050', asistSource: 'dtna' });
    expect(client.pullCase).not.toHaveBeenCalled();
  });

  it('refuses a Decisiv offsite row, a non-DTNA vendor and a closed case; row unchanged', () => {
    setup({ entries: [entry()] });
    const dec = { equipmentId: '122269', workRequestId: 'WR1', vendor: 'FREIGHTLINER', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/1' };
    const before = JSON.stringify(dec);
    expect(auto.applyCachedCase(dec)).toEqual({ applied: false, reason: 'has-offsite' });
    expect(JSON.stringify(dec)).toBe(before);
    expect(auto.applyCachedCase({ equipmentId: '122269', workRequestId: 'WR1', vendor: 'VOLVO' })).toEqual({ applied: false, reason: 'not-dtna-vendor' });
    setup({ entries: [entry({ caseStatus: 'Closed' })] });
    const closed = { equipmentId: '122269', workRequestId: 'WR1', vendor: 'DAIMLER' };
    expect(auto.applyCachedCase(closed)).toEqual({ applied: false, reason: 'closed' });
    expect(closed.offsiteShopEventUrl).toBeUndefined();
  });
});

describe('end to end with the real session, aura and client', () => {
  let fx;
  let session;
  let realAuto;
  let dstore;
  let attach;
  function boot(fxOpts) {
    freshDtna(require);
    fx = createFakeElectron(Object.assign({ onLoad: (win) => emitAuraSuccess(win.webContents) }, fxOpts || {}));
    session = require('../src/dtna/session.js');
    attach = vi.fn();
    session._setDeps({ electron: fx.electron, autoLogin: { attachAutoLogin: attach } });
    realAuto = require('../src/dtna/auto.js');
    dstore = require('../src/dtna/store.js');
    require('../src/store').save('dtnaCaseCache', { version: 1, cases: {} });
    dstore.put(entry({ pulledAt: iso(Date.now() - 3 * 60 * MIN) }));
  }

  it('signed out (fresh app run), hidden sign-in fails: one hidden window, 0 fetches, and a second pass inside the cooldown opens none', async () => {
    boot({ attachThrows: true });
    const r = await realAuto.pullIfStale(CASE_ID, { freshMs: 2 * 60 * MIN });
    expect(r).toMatchObject({ ok: true, live: false, code: 'DTNA_AUTO_SIGNED_OUT', entry: { caseId: CASE_ID } });
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0].options.show).toBe(false);
    expect(fx.windows[0].destroyed).toBe(true);
    expect(await realAuto.discover({ units: ['122269'], budget: 10 })).toEqual({ pulled: 0, code: 'DTNA_AUTO_SIGNED_OUT' });
    const f = await require('../src/scrapers/dtna_enrich.js').enrichDtna(caseUrl(CASE_ID), { freshMs: 2 * 60 * MIN });
    expect(f).toMatchObject({ ok: true, offsiteText: 'old thread', dtnaCaseNumber: '15667050' });
    expect(fx.calls.fetch).toHaveLength(0);
    expect(fx.windows).toHaveLength(1);
    session._resetForTests();
  });

  it('signed out (fresh app run), saved session: the sync pass signs in through one hidden window and reads live', async () => {
    boot();
    const r = await realAuto.pullIfStale(CASE_ID, { freshMs: MIN });
    expect(r).toMatchObject({ live: true });
    expect(fx.calls.fetch.length).toBeGreaterThan(0);
    expect(fx.windows).toHaveLength(1);
    expect(fx.windows[0].options.show).toBe(false);
    expect(attach).toHaveBeenCalledWith(fx.windows[0], expect.any(String), { maxRetries: 2, onDone: expect.any(Function) });
    expect(session.status().state).toBe('connected');
    session._resetForTests();
  });

  it('signed in, then marked expired: one hidden re-login, then the live read proceeds (no visible window)', async () => {
    boot();
    await session.openLoginWindow({});
    fx.windows[0].close();
    session.noteResult('DTNA_SIGNIN_REQUIRED');
    require('../src/dtna/capture.js').clear();
    const n = fx.windows.length;
    const r = await realAuto.pullIfStale(CASE_ID, { freshMs: MIN });
    expect(r).toMatchObject({ live: true });
    expect(fx.calls.fetch.length).toBeGreaterThan(0);
    expect(fx.windows).toHaveLength(n + 1);
    expect(fx.windows[n].options.show).toBe(false);
    session._resetForTests();
  });

  it('signed in: the stale case is read over the network with no new window and no auto-login', async () => {
    boot();
    await session.openLoginWindow({});
    const n = fx.windows.length;
    const calls = attach.mock.calls.length;
    await realAuto.pullIfStale(CASE_ID, { freshMs: MIN });
    expect(fx.calls.fetch.length).toBeGreaterThan(0);
    expect(fx.windows).toHaveLength(n);
    expect(attach.mock.calls.length).toBe(calls);
    session._resetForTests();
  });
});

describe('discoverForRows (sync pass, fleet rows)', () => {
  it('no FREIGHTLINER / DAIMLER rows -> no sign-in, no list read', async () => {
    const backgroundLogin = vi.fn(async () => ({ ok: true }));
    setup({ open: false, ids: [id(1)], session: { backgroundLogin } });
    const r = await auto.discoverForRows([{ equipmentId: '300001', vendor: 'VOLVO' }, { equipmentId: '300002', vendor: 'RUSH' }]);
    expect(r).toEqual({ pulled: 0, code: 'OK', units: 0 });
    expect(client.listCaseIds).not.toHaveBeenCalled();
    expect(backgroundLogin).not.toHaveBeenCalled();
  });

  it('a FREIGHTLINER row with an offsite link or a cached case is excluded', async () => {
    setup({ entries: [entry({ unitId: '122269' })], ids: [id(1)] });
    const rows = [
      { equipmentId: '300003', vendor: 'FREIGHTLINER', offsiteShopEventUrl: caseUrl(NO_RO_CASE_ID) },
      { equipmentId: '122269', vendor: 'DAIMLER TRUCK' },
    ];
    expect(await auto.discoverForRows(rows)).toEqual({ pulled: 0, code: 'OK', units: 0 });
    expect(client.listCaseIds).not.toHaveBeenCalled();
  });

  it('a FREIGHTLINER row with neither -> discover for its unit with budget 25', async () => {
    setup({ ids: [id(1)], pull: (cid) => ({ ok: true, entry: entry({ caseId: cid, unitId: '300004' }) }) });
    const r = await auto.discoverForRows([{ equipmentId: '300004', vendor: 'FREIGHTLINER' }, { equipmentId: '300005', vendor: 'VOLVO' }]);
    expect(r).toEqual({ pulled: 1, code: 'OK', units: 1 });
    expect(client.listCaseIds).toHaveBeenCalledWith({ silent: true });
    expect(client.pullCase).toHaveBeenCalledWith(id(1), { includeComments: false, silent: true });
    const line = logger.lines.find((l) => l.args[0] === '[dtna] auto' && l.args[1] && l.args[1].op === 'sync-discover');
    expect(line.args[1]).toMatchObject({ op: 'sync-discover', units: 1, pulled: 1, code: 'OK' });
  });

  it('budget 25 caps the reads', async () => {
    const ids = Array.from({ length: 40 }, (_, i) => id(i));
    setup({ ids, pull: (cid) => ({ ok: true, entry: entry({ caseId: cid, unitId: 'U' + cid.slice(-2) }) }) });
    const r = await auto.discoverForRows([{ equipmentId: '300006', vendor: 'FREIGHTLINER' }]);
    expect(r.pulled).toBe(25);
    expect(client.pullCase).toHaveBeenCalledTimes(25);
  });

  it('a list read that never resolves -> DTNA_DISCOVER_TIMEOUT', async () => {
    setup({});
    client.listCaseIds.mockImplementation(() => new Promise(() => {}));
    auto._setDeps({ client, session: { canAutoSync: () => true }, store: { get: () => null, all: () => [] }, now: () => NOW, sleep: async () => {}, raceSleep: async () => {} });
    expect(await auto.discoverForRows([{ equipmentId: '300007', vendor: 'FREIGHTLINER' }])).toEqual({ pulled: 0, code: 'DTNA_DISCOVER_TIMEOUT', units: 1 });
  });
});

describe('static guards', () => {
  it('auto.js never opens a sign-in, never auto-logs-in, never schedules, never requires electron', () => {
    const src = fs.readFileSync(path.join(WT_ROOT, 'src', 'dtna', 'auto.js'), 'utf8');
    for (const bad of ['openLoginWindow', 'attachAutoLogin', 'setInterval', 'setTimeout(', 'setPulling', "require('electron')", 'BrowserWindow']) {
      expect(src, bad).not.toContain(bad);
    }
  });
});
