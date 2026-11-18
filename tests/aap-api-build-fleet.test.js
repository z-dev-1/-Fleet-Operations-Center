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
import { FLEET, MULTI, mkAsset, mkWo, mkAssetPage, mkWoPages } from './fixtures/fleet-build/aap-fleet-fixture.js';

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

describe('buildFleetDataset fleet scope (Managed Domiciles, not a fleetIds allow-list)', () => {
  // The 8 asset fleet UUIDs pinned before 5ccc0b1 (DEFAULT_ASSET_SEARCH_REQUEST.fleetIds).
  const ORIGINAL_8 = [
    '0bb2e249-fd34-437f-83af-d1d69150558b', '0f454f75-1e45-475f-8d8b-2334ade1f6f1',
    '5c19cdf7-ce2f-4593-a37a-3fe5d506e120', '7de393df-74e1-45af-9650-560ba008bc65',
    'b84ddc20-589c-4330-af67-3d38f89e28af', 'b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe',
    'ba97eda1-cb03-446e-a907-474084194777', 'daa83ad7-5d8f-43a4-ba9c-76c643e45e1e',
  ];
  const PAGE_ID = '817ca098-8441-4329-a71e-6768f9d7e6c5';   // AAP page/view id, NOT a fleet id
  const NINTH = '9bf5bae8-f536-4157-8b23-f5632ced5e1d';
  const WO_DEFAULT_9 = require('../src/scrapers/aap_longdwell').DEFAULT_SEARCH_REQUEST.fleetIds;
  const ATS_NA_TRACTOR = 'ba97eda1-cb03-446e-a907-474084194777';
  const BOGUS = '00000000-dead-beef-0000-000000000000';
  const hasFleetIds = (r) => Object.prototype.hasOwnProperty.call(r.body, 'fleetIds');
  const isGetFleet = (r) => r.method === 'GET' && r.path.startsWith('/api/v1/fleet/');
  const fleetOf = (r) => decodeURIComponent(r.path.slice('/api/v1/fleet/'.length));
  const fnf = { ok: false, status: 404, json: { message: 'com.amazon.lifeguard.FleetNotFoundException: Could not find fleet ' + PAGE_ID } };
  const routed = (fn) => {
    const base = mkRouter(fleetSpec());
    const page = mkRoutedPage((r) => fn(r) || base(r));
    aap._setProviderForTest(mkProvider([page]));
    return page;
  };
  const expectValidFleetIds = (page) => {
    for (const r of page.requests.filter((x) => x.body && hasFleetIds(x))) {
      const ids = r.body.fleetIds;
      if (ids === null) continue;                               // widened WO attempt 2
      expect(ids).not.toContain(PAGE_ID);
      const allowed = isAssetSearch(r) ? ORIGINAL_8 : WO_DEFAULT_9;
      for (const id of ids) expect(allowed).toContain(id);
    }
    expect(page.requests.some((x) => JSON.stringify(x.body || {}).includes(PAGE_ID))).toBe(false);
  };

  it('the asset fallback list is exactly the original 8 (no page id, no 9bf5bae8); shared default unchanged', () => {
    expect([...aap.ASSET_FALLBACK_FLEET_IDS].sort()).toEqual([...ORIGINAL_8].sort());
    expect([...require('../src/scrapers/aap_longdwell').DEFAULT_ASSET_SEARCH_REQUEST.fleetIds].sort()).toEqual([...ORIGINAL_8].sort());
    expect(aap.ASSET_FALLBACK_FLEET_IDS).not.toContain(PAGE_ID);
    expect(aap.ASSET_FALLBACK_FLEET_IDS).not.toContain(NINTH);
    expect(WO_DEFAULT_9).not.toContain(PAGE_ID);
    expect(aap.SCOPE_FLEET_IDS).toBeUndefined();
  });
  it('the settings default (DEFAULT_ASSET_FLEET_IDS) is the original 8 plus ATS NA Tractor, deduped', () => {
    expect(aap.DEFAULT_ASSET_FLEET_IDS).toContain(ATS_NA_TRACTOR);
    for (const id of ORIGINAL_8) expect(aap.DEFAULT_ASSET_FLEET_IDS).toContain(id);
    expect(new Set(aap.DEFAULT_ASSET_FLEET_IDS).size).toBe(aap.DEFAULT_ASSET_FLEET_IDS.length);
    expect(aap.DEFAULT_ASSET_FLEET_IDS).not.toContain(PAGE_ID);
  });
  it('one asset-search attempt: validated fleet ids, boundingBox null, domicile/operator filters, 3 lifecycle states; AMZ503669 builds', async () => {
    const assets = FLEET.assets.concat([mkAsset({ aaid: 'aaid-amz', unit: 'AMZ503669', state: 'ORDERED', reason: 'PENDING_DELIVERY' })]);
    const { page } = useRouter(fleetSpec({ assets: { domicileSite: { 0: assets } } }));
    const ds = await aap.buildFleetDataset(BASE);
    expect(ds.count).toBe(7);
    expect(byUnit(ds).AMZ503669).toMatchObject({ lifecycleState: 'Ordered' });
    expect(page.requests.filter(isGetFleet).map(fleetOf).sort()).toEqual([...aap.DEFAULT_ASSET_FLEET_IDS].sort());
    const assetReqs = page.requests.filter(isAssetSearch);
    expect(assetReqs.map(assetKey)).toEqual(['domicileSite', 'operator']);
    for (const r of assetReqs) {
      expect([...r.body.fleetIds].sort()).toEqual([...aap.DEFAULT_ASSET_FLEET_IDS].sort());
      expect(r.body.fleetIds).toContain(ATS_NA_TRACTOR);
      expect(r.body.boundingBox).toBe(null);
      expect(r.body.fieldFilters).toEqual([{ key: assetKey(r), values: ['TST1'] }]);
      expect(r.body.lifecycleStates.map((l) => l.state)).toEqual(['ACTIVE', 'UNAVAILABLE', 'ORDERED']);
    }
    expect(page.requests.filter(isUnplanned)[0].body.assetDomicileSites).toEqual(['TST1']);
    expectValidFleetIds(page);
  });
  it('WO searches carry no page id: bulk/planned/attempt-1 use the default WO body fleetIds', async () => {
    const { page } = useRouter(fleetSpec());
    await aap.buildFleetDataset(BASE);
    const attempt1 = page.requests.filter((r) => isFallback(r) && r.body.category !== null);
    expect(attempt1.length).toBeGreaterThan(0);
    for (const r of page.requests.filter(isUnplanned).concat(page.requests.filter(isPlanned), attempt1)) {
      expect([...r.body.fleetIds].sort()).toEqual([...WO_DEFAULT_9].sort());
    }
    expectValidFleetIds(page);
  });
  it('an unknown fleet id (getFleet 404) is dropped before the search; the fleet still builds every unit', async () => {
    const page = routed((r) => (isGetFleet(r) && fleetOf(r) === BOGUS ? fnf : null));
    const ds = await aap.buildFleetDataset(Object.assign({}, BASE, { assetFleetIds: ORIGINAL_8.concat([BOGUS]) }));
    expect(ds.count).toBe(6);
    const assetReqs = page.requests.filter(isAssetSearch);
    expect(assetReqs).toHaveLength(2);
    for (const r of assetReqs) {
      expect(r.body.fleetIds).not.toContain(BOGUS);
      expect([...r.body.fleetIds].sort()).toEqual([...ORIGINAL_8].sort());
    }
    expectValidFleetIds(page);
  });
  it('settings.assetFleetIds is read; when every id fails validation the original 8 are used', async () => {
    const store = require('../src/store');
    const prev = store.load('settings', {});
    store.save('settings', Object.assign({}, prev, { assetFleetIds: [BOGUS, ' ' + BOGUS + ' '] }));
    try {
      const page = routed((r) => (isGetFleet(r) && fleetOf(r) === BOGUS ? fnf : null));
      const ds = await aap.buildFleetDataset(BASE);
      expect(ds.count).toBe(6);
      expect(page.requests.filter(isGetFleet).map(fleetOf)).toEqual([BOGUS]);
      for (const r of page.requests.filter(isAssetSearch)) {
        expect([...r.body.fleetIds].sort()).toEqual([...ORIGINAL_8].sort());
      }
    } finally {
      store.save('settings', prev);
    }
  });
  it('the old no-fleet-ids attempt is gone: no asset search is sent without fleet ids', async () => {
    const { page } = useRouter(fleetSpec());
    await aap.buildFleetDataset(BASE);
    const assetReqs = page.requests.filter(isAssetSearch);
    expect(assetReqs.length).toBeGreaterThan(0);
    expect(assetReqs.every((r) => hasFleetIds(r) && Array.isArray(r.body.fleetIds) && r.body.fleetIds.length > 0)).toBe(true);
  });
  it('a 404 on the asset search rejects (never an empty fleet), so callers keep the last-good fleet_data.json', async () => {
    const page = routed((r) => (isAssetSearch(r) ? fnf : null));
    const e = await errOf(aap.buildFleetDataset(BASE));
    expect(e).toBeTruthy();
    expect(e.code).toBe('AAP_API_ERROR');
    expect(e.status).toBe(404);
    expect(page.requests.filter(isAssetSearch)).toHaveLength(1);
  });
  it('zero assets rejects AAP_ASSET_SEARCH_EMPTY instead of resolving 0 rows', async () => {
    routed((r) => (isAssetSearch(r) ? ok({ assets: [] }) : null));
    const e = await errOf(aap.buildFleetDataset(BASE));
    expect(e && e.code).toBe('AAP_ASSET_SEARCH_EMPTY');
  });
  it('an auth rejection on the asset search throws at once (no retry)', async () => {
    const page = routed((r) => (isAssetSearch(r) ? { ok: false, status: 401, json: {} } : null));
    const e = await errOf(aap.buildFleetDataset(BASE));
    expect(e && e.code).toBe('MIDWAY_SESSION_INVALID');
    expect(page.requests.filter(isAssetSearch)).toHaveLength(1);
  });
  it('an auth rejection during getFleet validation throws (no id is silently dropped, no asset search)', async () => {
    const page = routed((r) => (isGetFleet(r) ? { ok: false, status: 401, json: {} } : null));
    const e = await errOf(aap.buildFleetDataset(BASE));
    expect(e && e.code).toBe('MIDWAY_SESSION_INVALID');
    expect(page.requests.filter(isAssetSearch)).toHaveLength(0);
  });
  it('ORDERED asset with an open WR keeps its WR; cancelled-only and zombie Active units stay blank', async () => {
    const W = (id, status, modified) => mkWo({ id, aaid: 'aaid-amz', unit: 'AMZ503669', vendor: 'TA', status, modified, state: 'ORDERED', reason: 'PENDING_DELIVERY' });
    const assets = FLEET.assets.concat([
      mkAsset({ aaid: 'aaid-amz', unit: 'AMZ503669', state: 'ORDERED', reason: 'PENDING_DELIVERY', assetType: 'tractor' }),
      mkAsset({ aaid: 'aaid-o2', unit: 'O2', state: 'ORDERED' }),
    ]);
    const spec = fleetSpec({
      assets: { domicileSite: { 0: assets } },
      unplanned: [FLEET.unplannedWos.concat([mkWo({ id: 'svc-o2-c', aaid: 'aaid-o2', unit: 'O2', status: 'CANCELLED', state: 'ORDERED' })])],
      fallback: (r) => {
        if (r.body.equipmentIds[0] === 'AMZ503669') {
          return ok({ serviceAggregates: [W('svc-amz-c1', 'CANCELLED', 4000), W('svc-amz-open', 'WORK_ORDER_ASSIGNED', 1000), W('svc-amz-c2', 'CANCELLED', 3000), W('svc-amz-c3', 'CANCELLED', 2000)] });
        }
        if (r.body.equipmentIds[0] === 'O2') return ok({ serviceAggregates: [mkWo({ id: 'svc-o2-c2', aaid: 'aaid-o2', unit: 'O2', status: 'CANCELLED' })] });
        return ok({ serviceAggregates: FLEET.fallbackWos[r.body.equipmentIds[0]] ? [FLEET.fallbackWos[r.body.equipmentIds[0]]] : [] });
      },
    });
    useRouter(spec);
    const u = byUnit(await aap.buildFleetDataset(BASE));
    expect(u.AMZ503669).toMatchObject({ lifecycleState: 'Ordered', workRequestId: 'svc-amz-open',
      serviceUrl: 'https://aap-na.corp.amazon.com/v2/service/svc-amz-open', lifecycleReason: '' });
    expect(u.AMZ503669.vendor).toBeTruthy();
    expect(u.O2).toMatchObject({ lifecycleState: 'Ordered', workRequestId: '', serviceUrl: '', vendor: '' });
    expect(u.T1006).toMatchObject({ lifecycleState: 'Ordered', workRequestId: '' });
    expect(u.T1005).toMatchObject({ lifecycleState: 'Active', workRequestId: '', vendor: '' });
    expect(u.T1001.workRequestId).toBe('svc-u1');
  });
  it('the page id is never a standalone id literal (only inside /page/ URLs) in the AAP search modules', () => {
    for (const f of ['../src/scrapers/aap_api.js', '../src/scrapers/aap_longdwell.js']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(/['"`]817ca098-8441-4329-a71e-6768f9d7e6c5['"`]/.test(src)).toBe(false);
    }
  });
});

describe('buildFleetDataset fleet discovery (in-scope WO, asset missing from the search)', () => {
  const NEW_FLEET = '11111111-2222-4333-8444-555555555555';
  const store = require('../src/store');
  const isGetFleet = (r) => r.method === 'GET' && r.path.startsWith('/api/v1/fleet/');
  const fleetOf = (r) => decodeURIComponent(r.path.slice('/api/v1/fleet/'.length));
  const assetGetRe = /^\/api\/v1\/assets\/([^/?]+)$/;
  const isGetAsset = (r) => r.method === 'GET' && assetGetRe.test(r.path);
  const aaidOf = (r) => decodeURIComponent(assetGetRe.exec(r.path)[1]);
  const withNew = (r) => (r.body.fleetIds || []).includes(NEW_FLEET);
  const AMZ_ASSET = mkAsset({ aaid: 'aaid-amz', unit: 'AMZ503669', state: 'ORDERED', reason: 'PENDING_DELIVERY', assetType: 'tractor' });
  const AMZ_WO = mkWo({ id: 'svc-amz-open', aaid: 'aaid-amz', unit: 'AMZ503669', vendor: 'TA', status: 'WORK_ORDER_ASSIGNED', state: 'ORDERED', reason: 'PENDING_DELIVERY' });
  // First pass (known fleets) misses AMZ503669; a pass that includes NEW_FLEET returns it.
  // over(r) may answer first; getAsset('aaid-amz') reports NEW_FLEET.
  const discoveryPage = (over = () => null, extraWos = []) => {
    const base = mkRouter(fleetSpec({ unplanned: [FLEET.unplannedWos.concat([AMZ_WO], extraWos)] }));
    const page = mkRoutedPage((r) => {
      const o = over(r);
      if (o) return o;
      if (isAssetSearch(r) && withNew(r)) {
        return ok({ assets: assetKey(r) === 'domicileSite' && r.body.from === 0 ? FLEET.assets.concat([AMZ_ASSET]) : [] });
      }
      if (isGetAsset(r) && aaidOf(r) === 'aaid-amz') return ok({ asset: { aaid: 'aaid-amz', displayName: 'AMZ503669', fleetId: NEW_FLEET } });
      return base(r);
    });
    aap._setProviderForTest(mkProvider([page]));
    return page;
  };
  let prevSettings;
  beforeEach(() => { prevSettings = store.load('settings', {}); });
  afterEach(() => { store.save('settings', prevSettings); });

  it('looks up only the missing AAID, validates its fleet, runs one more pass, and the unit joins the fleet with its open WR', async () => {
    const page = discoveryPage();
    const ds = await aap.buildFleetDataset(BASE);
    expect(page.requests.filter(isGetAsset).map(aaidOf)).toEqual(['aaid-amz']);   // never for AAIDs already returned
    expect(page.requests.filter(isGetFleet).map(fleetOf)).toContain(NEW_FLEET);
    const assetReqs = page.requests.filter(isAssetSearch);
    expect(assetReqs.filter((r) => !withNew(r)).map(assetKey)).toEqual(['domicileSite', 'operator']);
    const second = assetReqs.filter(withNew);
    expect(second.map(assetKey)).toEqual(['domicileSite', 'operator']);
    for (const r of second) {
      expect([...r.body.fleetIds].sort()).toEqual([...aap.DEFAULT_ASSET_FLEET_IDS, NEW_FLEET].sort());
      expect(r.body.boundingBox).toBe(null);
      expect(r.body.fieldFilters).toEqual([{ key: assetKey(r), values: ['TST1'] }]);
      expect(r.body.lifecycleStates.map((l) => l.state)).toEqual(['ACTIVE', 'UNAVAILABLE', 'ORDERED']);
    }
    expect(ds.count).toBe(7);                                              // 6 + AMZ503669, no duplicates
    expect(new Set(ds.rows.map((r) => r.assetId)).size).toBe(7);
    const u = byUnit(ds);
    expect(u.AMZ503669).toMatchObject({ lifecycleState: 'Ordered', workRequestId: 'svc-amz-open',
      serviceUrl: 'https://aap-na.corp.amazon.com/v2/service/svc-amz-open' });
    expect(u.T1001.workRequestId).toBe('svc-u1');
  });
  it('a discovered fleet id that fails getFleet is dropped: no second pass, the fleet still builds', async () => {
    const page = discoveryPage((r) => (isGetFleet(r) && fleetOf(r) === NEW_FLEET ? fail(404) : null));
    const ds = await aap.buildFleetDataset(BASE);
    expect(page.requests.filter(isGetAsset).map(aaidOf)).toEqual(['aaid-amz']);
    expect(page.requests.filter(isAssetSearch)).toHaveLength(2);
    expect(page.requests.filter(isAssetSearch).some(withNew)).toBe(false);
    expect(ds.count).toBe(6);
    expect(store.load('settings', {}).assetFleetIds).toEqual(prevSettings.assetFleetIds);
  });
  it('a second-pass error keeps the first-pass fleet and saves nothing', async () => {
    const page = discoveryPage((r) => (isAssetSearch(r) && withNew(r) ? fail(500) : null));
    const ds = await aap.buildFleetDataset(BASE);
    expect(page.requests.filter(isAssetSearch).filter(withNew).length).toBeGreaterThan(0);
    expect(ds.count).toBe(6);
    expect(byUnit(ds).AMZ503669).toBeUndefined();
    expect(store.load('settings', {}).assetFleetIds).toEqual(prevSettings.assetFleetIds);
  });
  it('caps getAsset lookups at 25 per refresh; a failing lookup is skipped', async () => {
    const extra = Array.from({ length: 30 }, (_, k) => mkWo({ id: 'svc-x' + k, aaid: 'aaid-x' + k, unit: 'X' + k }));
    const page = discoveryPage((r) => (isGetAsset(r) && aaidOf(r) === 'aaid-x0' ? fail(500) : null), extra);
    const ds = await aap.buildFleetDataset(BASE);
    const looked = page.requests.filter(isGetAsset).map(aaidOf);
    expect(looked).toHaveLength(25);
    expect(looked[0]).toBe('aaid-amz');
    expect(looked).toContain('aaid-x0');
    expect(ds.count).toBe(7);
  });
  it('appends the discovered id to settings.assetFleetIds without touching other settings; the next refresh uses it directly', async () => {
    store.save('settings', Object.assign({}, prevSettings, { keepMe: 'x', domiciles: ['TST1'], assetFleetIds: aap.ASSET_FALLBACK_FLEET_IDS.slice() }));
    discoveryPage();
    await aap.buildFleetDataset(BASE);
    const s = store.load('settings', {});
    expect(s.keepMe).toBe('x');
    expect(s.domiciles).toEqual(['TST1']);
    expect(s.assetFleetIds).toEqual(aap.ASSET_FALLBACK_FLEET_IDS.concat([NEW_FLEET]));
    aap.dispose();
    const page2 = discoveryPage();
    const ds2 = await aap.buildFleetDataset(BASE);
    expect(page2.requests.filter(isGetAsset)).toHaveLength(0);              // no rediscovery
    const reqs = page2.requests.filter(isAssetSearch);
    expect(reqs).toHaveLength(2);
    expect(reqs.every(withNew)).toBe(true);
    expect(ds2.count).toBe(7);
  });
  it('with no settings.assetFleetIds yet, the defaults are written plus the discovered id', async () => {
    const s0 = Object.assign({}, prevSettings, { keepMe: 'y' });
    delete s0.assetFleetIds;
    store.save('settings', s0);
    discoveryPage();
    await aap.buildFleetDataset(BASE);
    const s = store.load('settings', {});
    expect(s.keepMe).toBe('y');
    expect(s.assetFleetIds).toEqual(aap.DEFAULT_ASSET_FLEET_IDS.concat([NEW_FLEET]));
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

describe('buildFleetDataset multi open WOs', () => {
  const multiSpec = (extra = {}) => Object.assign({
    assets: { domicileSite: { 0: MULTI.assets } },
    unplanned: [MULTI.unplannedWos],
    planned: [MULTI.plannedWos],
  }, extra);
  const RELAY = 'https://aap-na.corp.amazon.com/v2/service/';
  const isMultiDetail = (r) => r.method === 'GET' && /^\/api\/v1\/serviceaggregates\/svc-m[^/]*$/.test(r.path);
  const detail = (id) => ok({ id, workRequest: { comments: [{ timestamp: '2026-11-10T14:00:00Z', createdBy: 'Vendor', text: 'note ' + id }] } });

  it('1 unplanned + 1 planned (122269 shape): the planned WO is the secondary and _plannedWRData', async () => {
    useRouter(multiSpec());
    const u = byUnit(await aap.buildFleetDataset(BASE));
    expect(u.M1001.workRequestId).toBe('svc-m1-u');
    expect(u.M1001.openUnplanned).toBe(1);
    expect(u.M1001.openPlanned).toBe(1);
    expect(u.M1001._secondaryWRs).toHaveLength(1);
    expect(u.M1001._secondaryWRs[0]).toMatchObject({ workRequestId: 'svc-m1-p', _wrType: 'planned', _serviceUUID: 'svc-m1-p',
      _relayUrl: RELAY + 'svc-m1-p' });
    expect(u.M1001._plannedWRData).not.toBe(null);
    expect(u.M1001._plannedWRData.workRequestId).toBe('svc-m1-p');
  });
  it('single open WO: no secondary, no planned card; the completed WO never appears', async () => {
    useRouter(multiSpec());
    const u = byUnit(await aap.buildFleetDataset(BASE));
    expect(u.M1002.workRequestId).toBe('svc-m2-u');
    expect(u.M1002._secondaryWRs).toEqual([]);
    expect(u.M1002._plannedWRData).toBe(null);
    expect(u.M1002.openUnplanned).toBe(1);
    expect(u.M1002.openPlanned).toBe(0);
  });
  it('2 unplanned + 1 planned (FLD260703 shape): both others attach, unplanned first', async () => {
    useRouter(multiSpec());
    const u = byUnit(await aap.buildFleetDataset(BASE));
    expect(u.M1003.workRequestId).toBe('svc-m3-u1');
    expect(u.M1003._secondaryWRs.map((s) => s.workRequestId)).toEqual(['svc-m3-u2', 'svc-m3-p']);
    expect(u.M1003._secondaryWRs.map((s) => s._wrType)).toEqual(['unplanned', 'planned']);
    expect(u.M1003._plannedWRData.workRequestId).toBe('svc-m3-p');
    expect(u.M1003.openUnplanned).toBe(2);
    expect(u.M1003.openPlanned).toBe(1);
  });
  it('Active unit: zombie WOs are cleared, no secondaries', async () => {
    useRouter(multiSpec());
    const u = byUnit(await aap.buildFleetDataset(BASE));
    expect(u.M1004.lifecycleState).toBe('Active');
    expect(u.M1004.workRequestId).toBe('');
    expect(u.M1004._secondaryWRs).toEqual([]);
    expect(u.M1004._plannedWRData).toBe(null);
  });
  it('FLEET.T1001 (1 + 1) attaches its planned WO; openPlanned > 0 always has the planned WO attached', async () => {
    useRouter(fleetSpec());
    const ds = await aap.buildFleetDataset(BASE);
    expect(byUnit(ds).T1001._secondaryWRs[0].workRequestId).toBe('svc-u1-pm');
    useRouter(multiSpec());
    const ds2 = await aap.buildFleetDataset(BASE);
    for (const r of ds.rows.concat(ds2.rows)) {
      if (r.openPlanned > 0 && r.lifecycleState !== 'Active') {
        expect(r._plannedWRData || /^PLANNED$/i.test(r.serviceCategory || '')).toBeTruthy();
        expect(r._secondaryWRs.filter((s) => s._wrType === 'planned').length + (/^PLANNED$/i.test(r.serviceCategory || '') ? 1 : 0)).toBe(r.openPlanned);
      }
    }
  });
  it('budget: withComments:false makes no detail GETs; detailCap:1 + secondaryDetailCap:0 makes exactly one', async () => {
    const { page } = useRouter(multiSpec({ service: detail }));
    await aap.buildFleetDataset(BASE);
    expect(page.requests.filter(isMultiDetail)).toHaveLength(0);
    aap.dispose();
    const { page: page2 } = useRouter(multiSpec({ service: detail }));
    await aap.buildFleetDataset(Object.assign({}, BASE, { withComments: true, detailCap: 1, secondaryDetailCap: 0 }));
    expect(page2.requests.filter(isMultiDetail)).toHaveLength(1);
  });
  it('secondaries have their own detail budget: they never use up the primaries\u2019 detailCap', async () => {
    const { page } = useRouter(multiSpec({ service: detail }));
    // 3 primaries with a WO (M1004 is Active); secondaries capped at 1.
    const u = byUnit(await aap.buildFleetDataset(Object.assign({}, BASE, { withComments: true, detailCap: 3, secondaryDetailCap: 1 })));
    const got = page.requests.filter(isMultiDetail).map((r) => r.path.split('/').pop());
    expect(got.filter((id) => ['svc-m1-u', 'svc-m2-u', 'svc-m3-u1'].includes(id)).sort()).toEqual(['svc-m1-u', 'svc-m2-u', 'svc-m3-u1']);
    expect(got.filter((id) => ['svc-m1-p', 'svc-m3-u2', 'svc-m3-p'].includes(id))).toHaveLength(1);
    expect(u.M1003.fullConversation).toMatch(/note svc-m3-u1/);
  });
  it('withComments:true fills secondary conversations', async () => {
    useRouter(multiSpec({ service: detail }));
    // secondaryDetailCap defaults to detailCap (its own counter).
    const u = byUnit(await aap.buildFleetDataset(Object.assign({}, BASE, { withComments: true, detailCap: 20 })));
    expect(u.M1001._secondaryWRs[0].fullConversation).toMatch(/note svc-m1-p/);
    expect(u.M1003._secondaryWRs[1].fullConversation).toMatch(/note svc-m3-p/);
  });
  it('a hanging secondary detail is bounded by detailPerCallMs: the build resolves with that secondary blank', async () => {
    vi.useFakeTimers();
    const router = mkRouter(multiSpec({ service: detail }));
    let n = 0;
    const prov = mkProvider(() => (n++ === 0
      ? mkRoutedPage(router, { hangWhen: (r) => r.method === 'GET' && r.path === '/api/v1/serviceaggregates/svc-m1-p' })
      : mkRoutedPage(router)));
    aap._setProviderForTest(prov);
    let done = null;
    const p = aap.buildFleetDataset(Object.assign({}, BASE, { withComments: true, detailPerCallMs: 50 })).then((d) => { done = d; return d; });
    await vi.advanceTimersByTimeAsync(61000);
    const ds = await p;
    expect(done).toBeTruthy();
    const u = byUnit(ds);
    expect(u.M1001._secondaryWRs[0]).toMatchObject({ workRequestId: 'svc-m1-p', _wrType: 'planned', fullConversation: '' });
    expect(u.M1003._secondaryWRs.map((s) => s.workRequestId)).toEqual(['svc-m3-u2', 'svc-m3-p']);
  });
  it('a PLANNED pass HTTP 500 leaves M1001 unplanned-only and every row still builds', async () => {
    useRouter(multiSpec({ planned: fail(500) }));
    const ds = await aap.buildFleetDataset(BASE);
    const u = byUnit(ds);
    expect(ds.count).toBe(4);
    expect(ds.plannedPassOk).toBe(false);
    expect(u.M1001._secondaryWRs).toEqual([]);
    expect(u.M1001._plannedWRData).toBe(null);
    expect(u.M1001.openPlanned).toBe(0);
    expect(u.M1003._secondaryWRs.map((s) => s.workRequestId)).toEqual(['svc-m3-u2']);
  });
  it('plannedPassOk is true on the dataset when the PLANNED pass answered', async () => {
    useRouter(multiSpec());
    expect((await aap.buildFleetDataset(BASE)).plannedPassOk).toBe(true);
  });
  it('src/window/index.js wiring: hydration keeps planned WOs on a failed refreshUnit PLANNED search; carry-forward only on a failed bulk PLANNED pass', () => {
    const src = fs.readFileSync(new URL('../src/window/index.js', import.meta.url), 'utf8');
    const h = src.indexOf('keepPrevSecondaryWRs(fr, r, { planned: fr._plannedPassOk === false })');
    expect(h).toBeGreaterThan(0);
    expect(src.slice(h, h + 300)).toContain('r._secondaryWRs = kept.secondary');
    expect(src.slice(h, h + 300)).toContain('r._plannedWRData = kept.planned');
    expect(src).toContain('const _plannedPassFailed = !!(ds && ds.plannedPassOk === false);');
    const c = src.indexOf('keepPrevSecondaryWRs(row, p, {');
    expect(c).toBeGreaterThan(0);
    expect(src.slice(c, c + 200)).toContain('planned: _plannedPassFailed');
    expect(src.slice(c, c + 200)).toContain('outsideBulk: true');
    expect(src.slice(h - 200, h)).toContain('markOutsideBulkPlanned(');
    // The old unconditional carry rules are gone.
    expect(src).not.toContain('if (!row._plannedWRData && p._plannedWRData) row._plannedWRData = p._plannedWRData;');
    expect(src).not.toContain('row._secondaryWRs = p._secondaryWRs;');
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
