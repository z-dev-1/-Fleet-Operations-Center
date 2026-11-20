// tests/pending-est-sources.test.js — team-wide Pending Estimates collector
// (src/scrapers/pending_est_sources.js). Every network dep is faked (no live
// AAP / Decisiv). The pure parser / mapper / classifier are the real modules.

process.env.TZ = 'America/New_York';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);

// aap_longdwell requires electron at load; stub it (no windows are opened).
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { BrowserWindow: function () {}, session: {}, app: { getPath: () => os.tmpdir() }, ipcMain: { handle() {} } },
};

const ld = require('../src/scrapers/aap_longdwell');
const src = require('../src/scrapers/pending_est_sources');

const here = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(here, 'fixtures', 'decisiv', 'case-page-21383146.html'), 'utf8');
const VOLVO_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/21383146';
const PACCAR_URL = 'https://paccarpg.decisiv.net/fleet/estimates/21467830';
const FLEET_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/21999999';
const T0 = Date.parse('2026-11-20T17:00:00.000Z');

function memStore(init) {
  const data = JSON.parse(JSON.stringify(init || {}));
  return {
    data,
    load: (k, d) => (k in data ? JSON.parse(JSON.stringify(data[k])) : d),
    save: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

const st = (value, type = 'Neutral') => ({ type, description: { value, displayText: value } });
function wo(o) {
  return Object.assign({
    workRequestId: o.id, aaid: 'aaid-' + o.id, assetDisplayName: 'EQ-' + o.id, assetDomicileSite: '',
    vendor: 'TA', status: st('CREATED'), modifiedTimestamp: 1000, scheduledDateTime: Date.parse('2026-11-01T12:00:00Z'),
    vendorWorkOrderIds: [],
  }, o);
}
const WOS = () => [
  wo({ id: 'WR_A', aaid: 'aaid-A', assetDisplayName: 'A100', assetDomicileSite: 'DAS1', vendor: 'VOLVO', status: st('ESTIMATE_APPROVED'), vendorWorkOrderIds: ['30933SP'] }),
  wo({ id: 'WR_B', aaid: 'aaid-B', assetDisplayName: 'B200', assetDomicileSite: 'DBS1', vendor: 'KENWORTH', status: st('ESTIMATE_PENDING_APPROVAL') }),
  wo({ id: 'WR_C', aaid: 'aaid-C', assetDisplayName: 'C300', assetDomicileSite: 'DCS1', vendor: 'TA', status: st('CREATED'), totalEstimatePendingApprovalCost: 512.5 }),
  wo({ id: 'WR_D', aaid: 'aaid-D', assetDisplayName: 'D400', vendor: 'RUSH', status: st('ESTIMATE_PENDING_APPROVAL') }),
  wo({ id: 'WR_E', vendor: 'VOLVO', status: st('ESTIMATE_PENDING_APPROVAL'), completedDateTime: Date.parse('2026-11-10T00:00:00Z') }),
  wo({ id: 'WR_F', vendor: 'RUSH', status: st('CANCELLED', 'Alert'), totalEstimatePendingApprovalCost: 100 }),
  wo({ id: 'WR_G', vendor: 'FREIGHTLINER', status: st('ESTIMATE_PENDING_APPROVAL') }),
  wo({ id: 'WR_H', vendor: 'VOLVO', status: st('CREATED') }),
];
const comment = (text) => ({ workRequest: { comments: [{ text, timestamp: '2026-11-02T12:00:00Z' }] } });
const DETAILS = {
  WR_A: comment('Estimate posted ' + VOLVO_URL + ' please review'),
  WR_B: comment('PACCAR case ' + PACCAR_URL),
  WR_H: comment('no link yet'),
};
const SUMMARY = {
  21383146: { ok: true, stage: 'repair', status: 'Waiting', since: '2026-11-04T15:00:00Z', history: [] },
  21467830: { ok: true, stage: 'ready', status: 'Complete (here)', since: '2026-11-05T15:00:00Z', history: [] },
  21999999: { ok: true, stage: 'ready', status: 'Complete (here)', since: '2026-11-06T15:00:00Z', history: [] },
};
const FLEET = () => [
  { equipmentId: 'A100', assetId: 'aaid-A', operator: 'OPFLEET', domicileSite: 'DAS1', workRequestId: 'WR_A' },
  { equipmentId: 'U900', assetId: 'aaid-U', operator: 'ZZOP', domicileSite: 'DXX1', workRequestId: 'WR_OLD', vendor: 'Volvo (ASIST)', offsiteShopEventUrl: FLEET_URL },
];

function makeDeps(over = {}) {
  let now = T0;
  const store = memStore({
    longDwellCsv: { rows: { 'B200::DBS1::0': { assetId: 'B200', site: 'DBS1', csv: { SCAC: 'OPCSV', Site: 'SCSV1' } } } },
  });
  const deps = {
    store,
    now: () => now,
    searchAllPages: vi.fn(async () => WOS()),
    getService: vi.fn(async (id) => DETAILS[id] || { workRequest: { comments: [] } }),
    getAsset: vi.fn(async (aaid) => ({ asset: { attributesText: { operator: 'OPASSET', domicileSite: 'SASSET' } } })),
    getCasePage: vi.fn(async (id) => ({ ok: true, html: HTML.split('21383146').join(String(id)), url: 'x' })),
    getCaseStatusSummary: vi.fn(async (id) => SUMMARY[id] || { ok: false, code: 'DECISIV_API_ERROR' }),
    fasFor: vi.fn((op, site) => (op ? 'FAS-' + op + '-' + site : '')),
    loadMine: vi.fn(() => ({ mySites: new Set(), myCarriers: new Set(['OPFLEET']) })),
    rowIsMine: vi.fn((kind, row, sites, carriers) => carriers.has(row.scac)),
    fleetRows: () => FLEET(),
    log: { info() {}, warn() {} },
  };
  Object.assign(deps, over);
  return { deps, store, setNow: (t) => { now = t; } };
}
const byKey = (scan) => Object.fromEntries(scan.rows.map((r) => [r.key, r]));

beforeEach(() => { src._resetForTests(); });

describe('pending_est_sources: team scan', () => {
  it('pulls team-wide with the exact Long Dwell DEFAULT_SEARCH_REQUEST', async () => {
    const { deps } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    expect(scan.ok).toBe(true);
    expect(deps.searchAllPages).toHaveBeenCalledTimes(1);
    expect(deps.searchAllPages.mock.calls[0][0]).toBe(ld.DEFAULT_SEARCH_REQUEST);
    expect(deps.searchAllPages.mock.calls[0][1]).toEqual({ maxPages: 50 });
    expect(scan.wrEst).toBeUndefined();
    expect(scan.assetCache).toBeUndefined();
  });

  it('drops closed / cancelled WRs and DTNA; RG pending by status and by cost', async () => {
    const { deps } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    const k = byKey(scan);
    expect(k['wr:WR_E']).toBeUndefined();
    expect(k['wr:WR_F']).toBeUndefined();
    expect(k['wr:WR_G']).toBeUndefined();
    expect(k['wr:WR_H']).toBeUndefined();          // open, no estimate link, not pending
    expect(scan.excludedDtna).toBe(1);
    expect(k['wr:WR_C']).toMatchObject({ source: 'rg', rgPending: true, rgPendingCost: 512.5, offsite: null });
    expect(k['wr:WR_D']).toMatchObject({ source: 'rg', rgPending: true });
    expect(scan.rows.some((r) => /dtna/i.test(r.offsiteShopEventUrl) || /FREIGHTLINER/i.test(r.vendor))).toBe(false);
    // getService only for Volvo / PACCAR vendors
    expect(deps.getService.mock.calls.map((c) => c[0]).sort()).toEqual(['WR_A', 'WR_B', 'WR_H']);
  });

  it('follows comment links to Decisiv and scrapes each case once', async () => {
    const { deps, store } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    const k = byKey(scan);
    const pageIds = deps.getCasePage.mock.calls.map((c) => c[0]);
    expect(pageIds.filter((x) => x === '21383146')).toHaveLength(1);
    expect(pageIds.filter((x) => x === '21467830')).toHaveLength(1);
    expect(deps.getCasePage.mock.calls.find((c) => c[0] === '21383146')[1]).toEqual({ srUrl: VOLVO_URL });
    expect(deps.getCaseStatusSummary.mock.calls.filter((c) => c[0] === '21383146')).toHaveLength(1);
    expect(deps.getCaseStatusSummary.mock.calls.filter((c) => c[0] === '21467830')).toHaveLength(1);

    const a = k['wr:WR_A'];
    expect(a.source).toBe('decisiv');
    expect(a.vendorKind).toBe('volvo');
    expect(a.offsiteShopEventUrl).toBe(VOLVO_URL);
    expect(a.offsite.total).toBe(8735.97);
    expect(a.offsite.fleetStatus).toBe('Approved');
    expect(a.offsite.repairStatus).toBe('Waiting');
    expect(a.offsite.stage).toBe('repair');
    expect(a.rgOpen).toBe(true);
    expect(a.notInRg).toBe(false);
    expect(a.statusMismatch).toBe(false);          // Approved but Waiting
    expect(a.vendorWorkOrderId).toBe('30933SP');

    const b = k['wr:WR_B'];
    expect(b.source).toBe('both');
    expect(b.vendorKind).toBe('paccar');
    expect(b.offsite.total).toBe(8735.97);
    expect(b.offsite.stage).toBe('ready');
    expect(b.offsiteDone).toBe(true);
    expect(b.statusMismatch).toBe(true);           // done offsite, RG WR still open

    expect(store.data.decisivCaseCache['21383146'].total).toBe(8735.97);
    expect(scan.counts).toMatchObject({ rg: 2, decisiv: 2, both: 1, mismatch: 1, notInRg: 1 });
  });

  it('a fleet-row estimate not in the team pull is listed as notInRg', async () => {
    const { deps } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    const r = byKey(scan)['est:21999999'];
    expect(r).toBeTruthy();
    expect(r).toMatchObject({ notInRg: true, rgOpen: false, statusMismatch: false, source: 'decisiv', equipmentId: 'U900', operator: 'ZZOP' });
    expect(r.offsiteDone).toBe(true);
  });

  it('reuses a fresh fleet-row stage instead of calling getCaseStatusSummary', async () => {
    const fleet = FLEET();
    fleet[1].offsiteStage = 'ready';
    fleet[1].offsiteStageDetail = 'Complete (here)';
    fleet[1]._stageReadAt = new Date(T0 - 60000).toISOString();
    const { deps } = makeDeps({ fleetRows: () => fleet });
    const scan = await src.scanTeamPending({}, deps);
    expect(deps.getCaseStatusSummary.mock.calls.some((c) => c[0] === '21999999')).toBe(false);
    expect(byKey(scan)['est:21999999'].offsite.stage).toBe('ready');
  });

  it('operator for FAS: fleetData, then longDwellCsv, then getAsset', async () => {
    const { deps } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    const k = byKey(scan);
    expect(k['wr:WR_A'].operator).toBe('OPFLEET');
    expect(k['wr:WR_B'].operator).toBe('OPCSV');
    expect(k['wr:WR_C'].operator).toBe('OPASSET');
    expect(deps.fasFor).toHaveBeenCalledWith('OPFLEET', 'DAS1');
    expect(deps.fasFor).toHaveBeenCalledWith('OPCSV', 'DBS1');   // WR domicile wins over csv Site
    expect(deps.fasFor).toHaveBeenCalledWith('OPASSET', 'DCS1');
    expect(deps.fasFor).toHaveBeenCalledWith('OPASSET', 'SASSET'); // WR_D has no WR domicile
    expect(k['wr:WR_A'].fas).toBe('FAS-OPFLEET-DAS1');
    expect(deps.getAsset.mock.calls.map((c) => c[0]).sort()).toEqual(['aaid-C', 'aaid-D']);
  });

  it('mine comes from the injected DBR rule with sectionKind scac', async () => {
    const { deps } = makeDeps();
    const scan = await src.scanTeamPending({}, deps);
    const k = byKey(scan);
    expect(deps.loadMine).toHaveBeenCalledTimes(1);
    expect(deps.rowIsMine).toHaveBeenCalled();
    for (const c of deps.rowIsMine.mock.calls) expect(c[0]).toBe('scac');
    expect(deps.rowIsMine).toHaveBeenCalledWith('scac', { scac: 'OPFLEET', domicile: 'DAS1' }, expect.any(Set), expect.any(Set));
    expect(k['wr:WR_A'].mine).toBe(true);
    expect(k['wr:WR_B'].mine).toBe(false);
  });

  it('throttles for 15 min, force re-runs, concurrent scans share one run', async () => {
    const { deps, setNow } = makeDeps();
    const [s1, s2] = await Promise.all([src.scanTeamPending({}, deps), src.scanTeamPending({}, deps)]);
    expect(deps.searchAllPages).toHaveBeenCalledTimes(1);
    expect(s1).toBe(s2);
    setNow(T0 + 5 * 60 * 1000);
    const s3 = await src.scanTeamPending({}, deps);
    expect(s3.cached).toBe(true);
    expect(s3.rows.length).toBe(s1.rows.length);
    expect(deps.searchAllPages).toHaveBeenCalledTimes(1);
    const s4 = await src.scanTeamPending({ force: true }, deps);
    expect(s4.cached).toBe(false);
    expect(deps.searchAllPages).toHaveBeenCalledTimes(2);
    setNow(T0 + 21 * 60 * 1000);   // 16 min after the forced scan
    await src.scanTeamPending({}, deps);
    expect(deps.searchAllPages).toHaveBeenCalledTimes(3);
  });

  it('an unchanged modifiedTimestamp skips getService on the next forced scan', async () => {
    const { deps } = makeDeps();
    await src.scanTeamPending({}, deps);
    expect(deps.getService).toHaveBeenCalledTimes(3);
    const scan = await src.scanTeamPending({ force: true }, deps);
    expect(deps.getService).toHaveBeenCalledTimes(3);
    expect(byKey(scan)['wr:WR_A'].offsiteShopEventUrl).toBe(VOLVO_URL);
    deps.searchAllPages.mockImplementation(async () => WOS().map((w) => (w.workRequestId === 'WR_A' ? Object.assign(w, { modifiedTimestamp: 2000 }) : w)));
    await src.scanTeamPending({ force: true }, deps);
    expect(deps.getService).toHaveBeenCalledTimes(4);
    expect(deps.getService.mock.calls[3][0]).toBe('WR_A');
  });

  it('a getService rejection is counted in errors and the scan still succeeds', async () => {
    const { deps } = makeDeps({
      getService: vi.fn(async (id) => { if (id === 'WR_H') throw Object.assign(new Error('boom'), { code: 'AAP_HTTP_500' }); return DETAILS[id]; }),
    });
    const scan = await src.scanTeamPending({}, deps);
    expect(scan.ok).toBe(true);
    expect(scan.errors).toContainEqual({ stage: 'getService', code: 'AAP_HTTP_500', n: 1 });
    expect(byKey(scan)['wr:WR_A']).toBeTruthy();
  });

  it('a failed team search returns ok:false with the last scan and never throws', async () => {
    const { deps } = makeDeps();
    await src.scanTeamPending({}, deps);
    deps.searchAllPages.mockImplementation(async () => { throw Object.assign(new Error('down'), { code: 'AAP_SESSION_INVALID' }); });
    const scan = await src.scanTeamPending({ force: true }, deps);
    expect(scan.ok).toBe(false);
    expect(scan.code).toBe('AAP_SESSION_INVALID');
    expect(scan.rows.length).toBeGreaterThan(0);
  });

  it('getLastScan strips the internal caches', async () => {
    const { deps, store } = makeDeps();
    await src.scanTeamPending({}, deps);
    expect(store.data.pendingEstScan.wrEst).toBeTruthy();
    const last = src.getLastScan({ store });
    expect(last.rows.length).toBeGreaterThan(0);
    expect(last.wrEst).toBeUndefined();
    expect(last.assetCache).toBeUndefined();
  });

  it('predicates', () => {
    expect(src._isOpenWo(wo({ id: 'x', status: st('ESTIMATE_APPROVED') }))).toBe(true);
    expect(src._isOpenWo(wo({ id: 'x', status: st('COMPLETED', 'Complete') }))).toBe(false);
    expect(src._isRgPending(wo({ id: 'x', status: st('CREATED'), totalEstimatePendingApprovalCost: '10' }))).toBe(true);
    expect(src._isRgPending(wo({ id: 'x', status: st('CREATED') }))).toBe(false);
    expect(src._isDtnaWo({ vendor: 'DAIMLER' }, '')).toBe(true);
    expect(src._isDtnaWo({ vendor: 'VOLVO' }, 'https://dtna.my.site.com/Servicetracker/s/case/abc')).toBe(true);
    expect(src._isDtnaWo({ vendor: 'VOLVO' }, VOLVO_URL)).toBe(false);
    expect([...src.DECISIV_VENDORS].sort()).toEqual(['KENWORTH', 'PACCAR', 'PETERBILT', 'VOLVO']);
  });
});
