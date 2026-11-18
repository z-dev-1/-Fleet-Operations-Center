// tests/refresh-unit-multi-wo.test.js
// refreshUnit (src/scrapers/aap_api.js) for units with more than one open work
// order. Attempt 1 is pinned to category UNPLANNED, so the open PLANNED WO of a
// 122269/322283/B62281-shaped unit (1 unplanned + 1 planned) needs its own
// PLANNED pass. The fake AAP page routes /serviceaggregates/search by
// body.category (UNPLANNED / PLANNED / null = both) from MULTI.byUnit.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MULTI, mkWo } from './fixtures/fleet-build/aap-fleet-fixture.js';

const require = createRequire(import.meta.url);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-unit-multi-wo-'));
require('../src/config/paths').setDataDir(tmpDir);
const aap = require('../src/scrapers/aap_api');
const { mkRoutedPage, mkProvider } = require('./helpers/fake-aap-page.cjs');

const ok = (json) => ({ ok: true, status: 200, json });
const fail = (status = 500) => ({ ok: false, status, json: { message: 'boom' } });
const RELAY = 'https://aap-na.corp.amazon.com/v2/service/';
const isSearch = (r) => r.method === 'POST' && r.path === '/api/v1/serviceaggregates/search';

// spec: { byUnit, planned(req) -> result override, assetState }
function mkRouter(spec) {
  const units = spec.byUnit || MULTI.byUnit;
  return (r) => {
    if (isSearch(r)) {
      const u = units[r.body.equipmentIds[0]] || { unplanned: [], planned: [] };
      if (r.body.category === 'PLANNED') return spec.planned ? spec.planned(r) : ok({ serviceAggregates: u.planned });
      if (r.body.category === null) return ok({ serviceAggregates: u.unplanned.concat(u.planned) });
      return ok({ serviceAggregates: u.unplanned });
    }
    if (r.method === 'GET' && /\/history$/.test(r.path)) return ok({ serviceChangeLogs: [] });
    const a = /^\/api\/v1\/assets\/([^/?]+)$/.exec(r.path);
    if (r.method === 'GET' && a) {
      const st = (spec.assetState && spec.assetState[a[1]]) || 'UNAVAILABLE';
      return ok({ asset: { aaid: a[1], lifecycleState: st, attributesText: {} } });
    }
    const m = /^\/api\/v1\/serviceaggregates\/([^/?]+)$/.exec(r.path);
    if (r.method === 'GET' && m) return ok({ id: m[1], workRequest: { comments: [{ timestamp: '2026-11-10T14:00:00Z', createdBy: 'Vendor', text: 'note ' + m[1] }] } });
    return ok({});
  };
}
function useRouter(spec = {}, opts) {
  const page = mkRoutedPage(mkRouter(spec), opts);
  aap._setProviderForTest(mkProvider(() => page));
  return page;
}
const ids = (row) => row._secondaryWRs.map((s) => s.workRequestId);

beforeEach(() => {
  aap._setAuthReporterForTest({ isEnabled: () => false, report() {} });
  aap._resetHistoryCacheForTest();
});
afterEach(() => {
  aap.dispose();
  aap._setProviderForTest(null);
  vi.useRealTimers();
});

describe('refreshUnit multi open WOs', () => {
  it('1 unplanned + 1 planned (122269 shape): unplanned primary, planned secondary + _plannedWRData', async () => {
    const page = useRouter();
    const row = await aap.refreshUnit('M1001');
    expect(row.workRequestId).toBe('svc-m1-u');
    expect(row._secondaryWRs).toHaveLength(1);
    expect(row._secondaryWRs[0]).toMatchObject({ workRequestId: 'svc-m1-p', _wrType: 'planned', _serviceUUID: 'svc-m1-p', _relayUrl: RELAY + 'svc-m1-p' });
    expect(row._secondaryWRs[0].fullConversation).toMatch(/note svc-m1-p/);
    expect(row._plannedWRData.workRequestId).toBe('svc-m1-p');
    const planned = page.requests.filter((r) => isSearch(r) && r.body.category === 'PLANNED');
    expect(planned).toHaveLength(1);
    expect(planned[0].body).toMatchObject({ equipmentIds: ['M1001'], statuses: [], category: 'PLANNED', fleetIds: null, assetPrograms: null, lifecycleStates: null });
  });
  it('single open WO: no secondary, no planned card, the completed WO is absent', async () => {
    useRouter();
    const row = await aap.refreshUnit('M1002');
    expect(row.workRequestId).toBe('svc-m2-u');
    expect(row._secondaryWRs).toEqual([]);
    expect(row._plannedWRData).toBe(null);
    expect(JSON.stringify(row)).not.toContain('svc-m2-old');
  });
  it('2 unplanned + 1 planned (FLD260703 shape): both others attach', async () => {
    useRouter();
    const row = await aap.refreshUnit('M1003');
    expect(row.workRequestId).toBe('svc-m3-u1');
    expect(ids(row)).toEqual(['svc-m3-u2', 'svc-m3-p']);
    expect(row._secondaryWRs.map((s) => s._wrType)).toEqual(['unplanned', 'planned']);
    expect(row._plannedWRData.workRequestId).toBe('svc-m3-p');
  });
  it('primary stays the unplanned WO when the planned one is newer', async () => {
    const u = mkWo({ id: 'svc-s-u', aaid: 'aaid-s', unit: 'S1', modified: 1000 });
    const p = mkWo({ id: 'svc-s-p', aaid: 'aaid-s', unit: 'S1', category: 'PLANNED', status: 'SCHEDULED', modified: 9000 });
    useRouter({ byUnit: { S1: { unplanned: [u], planned: [p] } } });
    const row = await aap.refreshUnit('S1');
    expect(row.workRequestId).toBe('svc-s-u');
    expect(ids(row)).toEqual(['svc-s-p']);
  });
  it('the PLANNED pass echoing the unplanned aggregate is deduped', async () => {
    const u = mkWo({ id: 'svc-d-u', aaid: 'aaid-d', unit: 'D1' });
    useRouter({ byUnit: { D1: { unplanned: [u], planned: [u] } } });
    const row = await aap.refreshUnit('D1');
    expect(row.workRequestId).toBe('svc-d-u');
    expect(row._secondaryWRs).toEqual([]);
    expect(row._plannedWRData).toBe(null);
  });
  it('PLANNED pass HTTP 500: unplanned-only result', async () => {
    useRouter({ planned: () => fail(500) });
    const row = await aap.refreshUnit('M1003');
    expect(row.workRequestId).toBe('svc-m3-u1');
    expect(ids(row)).toEqual(['svc-m3-u2']);
    expect(row._plannedWRData).toBe(null);
    expect(row._plannedPassOk).toBe(false);
  });
  it('_plannedPassOk: true when the PLANNED search answered (or the widened search covered it)', async () => {
    useRouter();
    expect((await aap.refreshUnit('M1001'))._plannedPassOk).toBe(true);
    expect((await aap.refreshUnit('M1002'))._plannedPassOk).toBe(true);
    const p = mkWo({ id: 'svc-w-p', aaid: 'aaid-w', unit: 'W1', category: 'PLANNED', status: 'SCHEDULED' });
    aap.dispose();
    useRouter({ byUnit: { W1: { unplanned: [], planned: [p] } } });
    const w = await aap.refreshUnit('W1');
    expect(w.workRequestId).toBe('svc-w-p');
    expect(w._plannedPassOk).toBe(true);
  });
  it('a hanging PLANNED search is bounded at 8 s: unplanned-only result with _plannedPassOk false', async () => {
    vi.useFakeTimers();
    useRouter({}, { hangWhen: (r) => isSearch(r) && r.body.category === 'PLANNED' });
    let row = null;
    const p = aap.refreshUnit('M1001').then((x) => { row = x; return x; });
    // The abandoned search still holds the request lock until EVAL_REQUEST_MS.
    await vi.advanceTimersByTimeAsync(61000);
    await p;
    expect(row.workRequestId).toBe('svc-m1-u');
    expect(row._secondaryWRs).toEqual([]);
    expect(row._plannedPassOk).toBe(false);
  });
  it('a hanging secondary getService is bounded at 8 s: refreshUnit resolves, secondary kept blank', async () => {
    vi.useFakeTimers();
    useRouter({}, { hangWhen: (r) => r.method === 'GET' && r.path === '/api/v1/serviceaggregates/svc-m1-p' });
    let row = null;
    const p = aap.refreshUnit('M1001').then((x) => { row = x; return x; });
    await vi.advanceTimersByTimeAsync(7900);
    expect(row).toBe(null);
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(row._secondaryWRs[0]).toMatchObject({ workRequestId: 'svc-m1-p', _wrType: 'planned', fullConversation: '' });
    expect(row._plannedWRData.workRequestId).toBe('svc-m1-p');
    // Let the orphaned evaluate hit EVAL_REQUEST_MS so the request lock is released.
    await vi.advanceTimersByTimeAsync(60000);
  });
  it('Active asset: zombie WOs cleared, no secondaries', async () => {
    useRouter({ assetState: { 'aaid-m4': 'ACTIVE' } });
    const row = await aap.refreshUnit('M1004');
    expect(row.lifecycleState).toBe('Active');
    expect(row.workRequestId).toBe('');
    expect(row._secondaryWRs).toEqual([]);
    expect(row._plannedWRData).toBe(null);
  });
});
