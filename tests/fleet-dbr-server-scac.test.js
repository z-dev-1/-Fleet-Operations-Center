// tests/fleet-dbr-server-scac.test.js - flagged DBR SCAC coverage query (settings.dbr.serverScacFilter,
// default OFF): flag off / no scacs -> the existing build, no AAP call; flag on -> ONE search with the
// selected SCACs' domiciles, rows and visible rows unchanged, coverage on the response only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } });
const logCalls = [];
function fakeLogger() { const rec = (lvl) => (...a) => logCalls.push({ lvl, a }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);
const ipc = require('../src/ipc/fleet-dbr');
const PF = require('../src/config/perf-flags');
const { makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');
const L = await import('../renderer/src/js/views/fleet-dbr-logic.js');
ipc.registerFleetDbrIPC({});

const call = (ch, payload) => handlers['fleet-dbr:' + ch]({ sender: { id: 1 } }, payload);
const NOW = new Date(2026, 10, 10, 10, 30, 0);

function memStore() {
  const data = {};
  return {
    data,
    load(k, d) { return k in data ? JSON.parse(JSON.stringify(data[k])) : d; },
    save(k, v) { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

let store, serverOn, search, fleet;
function reset({ on = false, searchImpl } = {}) {
  store = memStore();
  serverOn = on;
  fleet = { rows: makeFleetRows(), syncedAt: '2026-11-10T10:00:00Z' };
  search = vi.fn(searchImpl || (async () => []));
  ipc._resetForTests({
    store, loadFlags: () => ({ enabled: true, aiDraft: false }), now: () => NOW, getFleet: () => fleet,
    fasFor: () => '', fasForExact: () => '', rosterSize: () => 0, userAlias: () => '', loadServerFlags: () => ({ serverScac: serverOn }), search,
  });
}
beforeEach(() => { reset(); logCalls.length = 0; });

describe('flags', () => {
  it('resolveDbrServerFilterFlags defaults off; settings true enables; env wins', () => {
    expect(PF.resolveDbrServerFilterFlags({}, {})).toEqual({ serverScac: false });
    expect(PF.resolveDbrServerFilterFlags(null, {})).toEqual({ serverScac: false });
    expect(PF.resolveDbrServerFilterFlags({ dbr: { serverScacFilter: 'yes' } }, {})).toEqual({ serverScac: false });
    expect(PF.resolveDbrServerFilterFlags({ dbr: { serverScacFilter: true } }, {})).toEqual({ serverScac: true });
    expect(PF.resolveDbrServerFilterFlags({ dbr: { serverScacFilter: true } }, { FLEET_DBR_SERVER_SCAC: '0' })).toEqual({ serverScac: false });
    expect(PF.resolveDbrServerFilterFlags({}, { FLEET_DBR_SERVER_SCAC: '1' })).toEqual({ serverScac: true });
    expect(PF.loadDbrServerFilter({ load: () => { throw new Error('x'); }, env: {} })).toEqual({ serverScac: false });
    expect(PF.loadDbrServerFilter({ load: () => ({ dbr: { serverScacFilter: true } }), env: {} })).toEqual({ serverScac: true });
  });
});

describe('build with the flag off', () => {
  it('build({scacs}) deep-equals build() and never searches', async () => {
    const a = await call('build');
    reset();
    const b = await call('build', { scacs: ['TUZR'] });
    expect(b).toEqual(a);
    expect(b.serverCoverage).toBeUndefined();
    expect(search).not.toHaveBeenCalled();
  });
  it('flag on but no scacs -> existing build, no search', async () => {
    reset({ on: true });
    const res = await call('build', { scacs: [] });
    expect(res.ok).toBe(true);
    expect(res.serverCoverage).toBeUndefined();
    await call('build');
    expect(search).not.toHaveBeenCalled();
  });
});

describe('build with the flag on', () => {
  it('ONE search filtered by the selected SCACs domiciles; rows and visible rows unchanged', async () => {
    const off = await call('build');
    const offSnap = store.data.fleetDbrSnapshot;
    reset({
      on: true,
      searchImpl: async () => [
        { assetDisplayName: 'T0001' },          // in fleet data
        { assetDisplayName: 'NEW9' },
        { assetDisplayName: 'new9' },           // same unit, second WO
        { equipmentId: 'ZZ01' },
        { assetDisplayName: '' }, null,
      ],
    });
    const scacs = ['TUZR'];
    const on = await call('build', { scacs });
    expect(search).toHaveBeenCalledTimes(1);
    const [req, opts] = search.mock.calls[0];
    expect(req).toEqual({});
    expect(opts).toEqual({ maxPages: 10, filters: { assetDomicileSites: ['ABE40', 'EWR40', 'PHL40'] } });
    expect(opts.filters).toEqual(L.serverFilterFor(on.model, scacs));
    expect(on.model.rows).toEqual(off.model.rows);
    expect(L.visibleRows(on.model, false, scacs)).toEqual(L.visibleRows(off.model, false, scacs));
    expect(store.data.fleetDbrSnapshot).toEqual(offSnap);
    expect(JSON.stringify(store.data.fleetDbrSnapshot)).not.toContain('serverCoverage');
    expect(on.serverCoverage).toEqual({
      ok: true, sites: ['ABE40', 'EWR40', 'PHL40'], serverOpenWos: 5, missingFromFleet: ['NEW9', 'ZZ01'], missingCount: 2,
    });
    const { serverCoverage, ...rest } = on;
    expect(rest).toEqual(off);
  });

  it('missingFromFleet is capped at 20', async () => {
    reset({ on: true, searchImpl: async () => Array.from({ length: 30 }, (_, i) => ({ assetDisplayName: 'N' + String(i).padStart(2, '0') })) });
    const res = await call('build', { scacs: ['SAPB', 'TUZR'] });
    expect(res.serverCoverage.missingFromFleet).toHaveLength(20);
    expect(res.serverCoverage.missingCount).toBe(30);
    expect(search.mock.calls[0][1].filters.assetDomicileSites).toEqual(['ABE40', 'EWR40', 'EWR45', 'PHL40']);
  });

  it('search throws -> build still ok, serverCoverage.ok false with a code', async () => {
    reset({ on: true, searchImpl: async () => { throw Object.assign(new Error('boom SECRET'), { code: 'AAP_API_ERROR' }); } });
    const res = await call('build', { scacs: ['TUZR'] });
    expect(res.ok).toBe(true);
    expect(res.model.rows.length).toBeGreaterThan(0);
    expect(res.serverCoverage).toEqual({ ok: false, code: 'AAP_API_ERROR', sites: ['ABE40', 'EWR40', 'PHL40'] });
    expect(JSON.stringify(logCalls)).not.toContain('SECRET');
  });

  it('no fleet data -> no-fleet-data, no search', async () => {
    reset({ on: true });
    fleet = { rows: [] };
    expect(await call('build', { scacs: ['TUZR'] })).toEqual({ ok: false, code: 'no-fleet-data' });
    expect(search).not.toHaveBeenCalled();
  });
});

describe('serverFilterFor', () => {
  it('null without a selection; sorted unique domiciles otherwise', async () => {
    const res = await call('build');
    expect(L.serverFilterFor(res.model, [])).toBeNull();
    expect(L.serverFilterFor(res.model, ['NOPE'])).toBeNull();
    expect(L.serverFilterFor(null, ['TUZR'])).toBeNull();
    expect(L.serverFilterFor(res.model, ['AZNG'])).toEqual({ assetDomicileSites: ['ABE40', 'AVP40', 'BUF', 'EOFE01', 'SHIL01'] });
  });
});
