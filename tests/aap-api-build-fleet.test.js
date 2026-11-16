// tests/aap-api-build-fleet.test.js
// buildFleetDataset (src/scrapers/aap_api.js) against a fake AAP page that
// routes the in-page request scripts by method/URL/body: asset + WO paging,
// the mapper over a masked fixture, per-unit WO fallback, partial failures
// keeping rows, a mid-build failure rejecting (never resolving 0 rows) plus the
// loader's empty-build guard, AAP_API_TIMEOUT mid-build releasing the lock and
// the real api-load-guard, and the corrected getter URLs.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FLEET, mkAsset, mkWo, mkAssetPage, mkWoPages } from './fixtures/fleet-build/aap-fleet-fixture.js';

const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aap-build-fleet-'));
require('../src/config/paths').setDataDir(tmpDir);
const aap = require('../src/scrapers/aap_api');
const { mkRoutedPage, mkProvider } = require('./helpers/fake-aap-page.cjs');

const ok = (json) => ({ ok: true, status: 200, json });
const fail = (status = 500) => ({ ok: false, status, json: { message: 'boom' } });
const BASE = { domiciles: ['TST1'], withComments: false };
const isAssetSearch = (r) => r.method === 'POST' && r.path === '/api/v2/assets/search';
const isWoSearch = (r) => r.method === 'POST' && r.path === '/api/v1/serviceaggregates/search';
const isFallback = (r) => isWoSearch(r) && Array.isArray(r.body.equipmentIds) && r.body.equipmentIds.length > 0;
const isPlanned = (r) => isWoSearch(r) && !isFallback(r) && r.body.category === 'PLANNED';
const isUnplanned = (r) => isWoSearch(r) && !isFallback(r) && r.body.category !== 'PLANNED';
const assetKey = (r) => r.body.fieldFilters && r.body.fieldFilters[0] && r.body.fieldFilters[0].key;

// spec: { assets: { domicileSite: { [from]: list }, operator: {...} }, unplanned: [page1, ...],
//         planned: [page1, ...] | result, fallback(req) -> result, service(id) -> result }
function mkRouter(spec) {
  return (r) => {
    if (isAssetSearch(r)) {
      const v = ((spec.assets || {})[assetKey(r)] || {})[r.body.from];
      if (v && !Array.isArray(v)) return v;
      return ok({ assets: v || [] });
    }
    if (isFallback(r)) return spec.fallback ? spec.fallback(r) : ok({ serviceAggregates: [] });
    if (isPlanned(r)) {
      if (spec.planned && !Array.isArray(spec.planned)) return spec.planned;
      return ok({ serviceAggregates: (spec.planned || [])[r.body.page - 1] || [] });
    }
    if (isUnplanned(r)) return ok({ serviceAggregates: (spec.unplanned || [])[r.body.page - 1] || [] });
    const m = /^\/api\/v1\/serviceaggregates\/([^/?]+)$/.exec(r.path);
    if (r.method === 'GET' && m && spec.service) return spec.service(decodeURIComponent(m[1]));
    return ok({});
  };
}
function useRouter(spec, opts) {
  const page = mkRoutedPage(mkRouter(spec), opts);
  const prov = mkProvider([page]);
  aap._setProviderForTest(prov);
  return { page, prov };
}
const fleetSpec = (extra = {}) => Object.assign({
  assets: { domicileSite: { 0: FLEET.assets } },
  unplanned: [FLEET.unplannedWos],
  planned: [FLEET.plannedWos],
  fallback: (r) => ok({ serviceAggregates: FLEET.fallbackWos[r.body.equipmentIds[0]] ? [FLEET.fallbackWos[r.body.equipmentIds[0]]] : [] }),
}, extra);
const byUnit = (ds) => Object.fromEntries(ds.rows.map((r) => [r.equipmentId, r]));
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

beforeEach(() => {
  aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });
  aap._resetCallStatsForTest();
});
afterEach(() => {
  aap.dispose();
  aap._setProviderForTest(null);
  aap._resetCallStatsForTest();
  vi.useRealTimers();
});

describe('buildFleetDataset paging', () => {
  it('pages assets from 0/150 per pass, dedupes across passes, pages WOs 1->2 and stops at the short page', async () => {
    const p0 = mkAssetPage(150, 0);
    const p1 = mkAssetPage(3, 150);
    const { page } = useRouter({
      assets: {
        domicileSite: { 0: p0, 150: p1 },
        operator: { 0: [mkAsset({ aaid: 'aaid-p0', unit: 'P0' }), mkAsset({ aaid: 'aaid-p152', unit: 'P152' }), mkAsset({ aaid: 'aaid-op1', unit: 'OP1' })] },
      },
      unplanned: mkWoPages([100, 37]),
    });
    const ds = await aap.buildFleetDataset(Object.assign({ woFallback: false }, BASE));
    const assetReqs = page.requests.filter(isAssetSearch);
    expect(assetReqs.filter((r) => assetKey(r) === 'domicileSite').map((r) => r.body.from)).toEqual([0, 150]);
    expect(assetReqs.filter((r) => assetKey(r) === 'operator').map((r) => r.body.from)).toEqual([0]);
    expect(assetReqs.every((r) => r.body.fieldFilters[0].values.join() === 'TST1')).toBe(true);
    expect(ds.count).toBe(154);   // 153 site units + 1 operator-only unit; 2 overlaps deduped
    expect(new Set(ds.rows.map((r) => r.assetId)).size).toBe(154);
    expect(page.requests.filter(isUnplanned).map((r) => r.body.page)).toEqual([1, 2]);
    expect(ds.rows.filter((r) => r.workRequestId).length).toBe(137);
    expect(ds.filter).toEqual(['TST1']);
  });
});

describe('buildFleetDataset mapper over the recorded fixture', () => {
  it('maps unavailable units, clears the active zombie WO, counts open unplanned/planned', async () => {
    useRouter(fleetSpec());
    const ds = await aap.buildFleetDataset(BASE);
    const u = byUnit(ds);
    expect(Object.keys(u).sort()).toEqual(['T1001', 'T1002', 'T1003', 'T1004', 'T1005', 'T1006']);
    expect(u.T1001).toMatchObject({
      equipmentId: 'T1001', assetId: 'aaid-u1', vendor: 'Amerit', workRequestId: 'svc-u1',
      serviceUrl: 'https://aap-na.corp.amazon.com/v2/service/svc-u1', lifecycleState: 'Unavailable',
      operator: 'DSPA', domicileSite: 'TST1', vin: 'TESTVIN0000000001', geofence: 'TST1-YARD',
      bodyType: 'Box Truck', manufacturer: 'TESTMAKE', relaySynced: true,
    });
    expect(u.T1001.lifecycleReason).toBeTruthy();
    expect(u.T1002.vendor).toBe('Volvo (ASIST)');
    expect(u.T1003.workRequestId).toBe('svc-u3-open');   // open WO beats the newer completed one
    expect(u.T1003.bodyType).toBe('Day Cab');
    expect(u.T1005).toMatchObject({ lifecycleState: 'Active', vendor: '', workRequestId: '', serviceUrl: '', lifecycleReason: '', relaySynced: false });
    expect(u.T1006).toMatchObject({ lifecycleState: 'Ordered', workRequestId: '' });
    expect(u.T1001.openUnplanned).toBe(1);
    expect(u.T1003.openUnplanned).toBe(1);
    expect(u.T1001.openPlanned).toBe(1);
    expect(u.T1002.openPlanned).toBe(0);
    expect(ds.unavailableCount).toBe(4);
    expect(ds.source).toBe('aap-api');
  });
});

describe('buildFleetDataset per-unit WO fallback', () => {
  it('attempt 1, widened attempt 2 (category null) and a failing fallback that still yields the row', async () => {
    const assets = [
      mkAsset({ aaid: 'aaid-f1', unit: 'F1' }),
      mkAsset({ aaid: 'aaid-f2', unit: 'F2' }),
      mkAsset({ aaid: 'aaid-f3', unit: 'F3' }),
    ];
    const { page } = useRouter({
      assets: { domicileSite: { 0: assets } },
      fallback: (r) => {
        const u = r.body.equipmentIds[0];
        if (u === 'F1' && r.body.category !== null) return ok({ serviceAggregates: [mkWo({ id: 'svc-f1', aaid: 'aaid-f1', unit: 'F1' })] });
        if (u === 'F2' && r.body.category === null) return ok({ serviceAggregates: [mkWo({ id: 'svc-f2', aaid: 'aaid-f2', unit: 'F2', category: 'PLANNED' })] });
        if (u === 'F3') return fail(500);
        return ok({ serviceAggregates: [] });
      },
    });
    const ds = await aap.buildFleetDataset(BASE);
    const u = byUnit(ds);
    expect(ds.count).toBe(3);
    expect(u.F1.workRequestId).toBe('svc-f1');
    expect(u.F2.workRequestId).toBe('svc-f2');
    expect(u.F3.workRequestId).toBe('');
    expect(u.F3.lifecycleState).toBe('Unavailable');
    const fb = page.requests.filter(isFallback);
    const f1 = fb.filter((r) => r.body.equipmentIds[0] === 'F1');
    const f2 = fb.filter((r) => r.body.equipmentIds[0] === 'F2');
    expect(f1.length).toBe(1);
    expect(f1[0].body.statuses).toEqual([]);
    expect(f2.map((r) => r.body.category)).toEqual(['UNPLANNED', null]);
    expect(f2[1]).toMatchObject({ body: { lifecycleStates: null, assetPrograms: null, fleetIds: null } });
  });
});

describe('buildFleetDataset partial failures keep rows', () => {
  it('a PLANNED pass HTTP 500 still resolves all rows with openPlanned 0', async () => {
    useRouter(fleetSpec({ planned: fail(500) }));
    const ds = await aap.buildFleetDataset(BASE);
    expect(ds.count).toBe(6);
    expect(ds.rows.every((r) => r.openPlanned === 0)).toBe(true);
    expect(byUnit(ds).T1001.openUnplanned).toBe(1);
  });
  it('withComments:true with getService 500 for one unit keeps that row with an empty conversation', async () => {
    const detail = (id) => ({ id, workRequest: { id: 'wr-' + id, comments: [{ timestamp: '2026-11-10T14:00:00Z', createdBy: 'Vendor', text: 'parts on order' }] } });
    const { page } = useRouter(fleetSpec({ service: (id) => (id === 'svc-u2' ? fail(500) : ok(detail(id))) }));
    const ds = await aap.buildFleetDataset(Object.assign({}, BASE, { withComments: true }));
    const u = byUnit(ds);
    expect(ds.count).toBe(6);
    expect(u.T1002.workRequestId).toBe('svc-u2');
    expect(u.T1002.fullConversation).toBe('');
    expect(u.T1001.fullConversation).toMatch(/^Conversation\n.*parts on order/);
    expect(page.requests.some((r) => r.method === 'GET' && r.path === '/api/v1/serviceaggregates/svc-u2')).toBe(true);
  });
});

describe('buildFleetDataset mid-build failure', () => {
  it('an asset page HTTP 500 at from=150 rejects AAP_API_ERROR instead of resolving partial/zero rows', async () => {
    useRouter({ assets: { domicileSite: { 0: mkAssetPage(150, 0), 150: fail(500) } } });
    const e = await errOf(aap.buildFleetDataset(BASE));
    expect(e).toBeTruthy();
    expect(e.code).toBe('AAP_API_ERROR');
    expect(e.status).toBe(500);
  });
  it('the loader keeps the last good fleet: empty-build guard sits between buildFleetDataset and store.save', () => {
    const ff = require('../src/health/fleet-freshness');
    expect(ff.isEmptyBuildOverGood([], [{ equipmentId: 'X' }])).toBe(true);
    const src = fs.readFileSync(new URL('../src/window/index.js', import.meta.url), 'utf8');
    const buildIdx = src.indexOf('await api.buildFleetDataset(');
    const guardIdx = src.indexOf('isEmptyBuildOverGood(', buildIdx);
    const saveIdx = src.indexOf("store.save('fleetData', payload);", buildIdx);
    expect(buildIdx).toBeGreaterThan(0);
    expect(guardIdx).toBeGreaterThan(buildIdx);
    expect(saveIdx).toBeGreaterThan(guardIdx);
  });
});

describe('buildFleetDataset AAP_API_TIMEOUT mid-build', () => {
  it('rejects AAP_API_TIMEOUT, the real load guard releases, and the next build proceeds on a fresh page', async () => {
    vi.useFakeTimers();
    const { createApiLoadGuard } = require('../src/window/api-load-guard');
    const assets = [mkAsset({ aaid: 'aaid-p0', unit: 'P0' }), mkAsset({ aaid: 'aaid-p1', unit: 'P1' })];
    const spec = { assets: { domicileSite: { 0: assets } }, unplanned: mkWoPages([100, 37]) };
    const hungPage = mkRoutedPage(mkRouter(spec), { hangWhen: (r) => isUnplanned(r) && r.body.page === 2 });
    const goodPage = mkRoutedPage(mkRouter(spec));
    const prov = mkProvider([hungPage, goodPage]);
    aap._setProviderForTest(prov);
    const guard = createApiLoadGuard();

    const s1 = guard.tryStart('refresh');
    expect(s1).toMatchObject({ started: true, superseded: false });
    let settled = false;
    const first = errOf(aap.buildFleetDataset(BASE)).then((e) => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(0);
    expect(hungPage.hung).toBe(1);
    await vi.advanceTimersByTimeAsync(59000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const e = await first;
    expect(e && e.code).toBe('AAP_API_TIMEOUT');
    expect(aap.getCallStats().consecutiveTimeouts).toBe(1);
    expect(hungPage.closed).toBeGreaterThan(0);

    expect(guard.release(s1.token).released).toBe(true);
    const s2 = guard.tryStart('refresh');
    expect(s2).toMatchObject({ started: true, superseded: false });
    const ds = await aap.buildFleetDataset(BASE);
    expect(ds.count).toBe(2);
    expect(ds.rows.every((r) => r.workRequestId)).toBe(true);
    expect(aap.getCallStats().consecutiveTimeouts).toBe(0);
    expect(prov.opened).toBe(2);
    expect(guard.release(s2.token).released).toBe(true);
  });
});

describe('corrected getter URLs', () => {
  it('getServiceMoves / getMaintenanceSchedules / getDvirs request the verified paths', async () => {
    const { page } = useRouter({});
    await aap.getServiceMoves('svc-1');
    await aap.getMaintenanceSchedules('A1');
    await aap.getDvirs('A1');
    await aap.getDvirs('A1', { startDate: 's', endDate: 'e' });
    expect(page.requests.map((r) => r.method + ' ' + r.path)).toEqual([
      'GET /api/v1/servicemoves/svc-1',
      'GET /api/v1/assets/A1/maintenance',
      'GET /api/v2/dvir/A1?openIssuesOnly=false',
      'GET /api/v2/dvir/A1?openIssuesOnly=false&startDate=s&endDate=e',
    ]);
  });
});
