// tests/aperia-client.test.js — src/aperia/client.js with fake transport / session / dtna store:
// 401 -> one reauth -> one retry, shared reauth across workers, unit index paging / TTL / miss rebuild,
// worker pool cap (6), fatal stop, abort, full fleet, DTNA cross-link from the case cache only.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { NOW, VEHICLES_PAGES, VEHICLE_DETAIL, ISSUES_PAGE } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const C = require('../src/aperia/constants');
const client = require('../src/aperia/client');

const EXPIRED = { ok: false, code: 'APERIA_SESSION_EXPIRED', status: 401 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function detailFor(id) {
  const all = [].concat(...VEHICLES_PAGES.map((p) => p.vehicles));
  const v = all.find((x) => String(x.id) === String(id));
  return Object.assign(JSON.parse(JSON.stringify(VEHICLE_DETAIL)), { id: Number(id), fleetVehicleId: v ? v.fleetVehicleId : 'X', account: { name: v ? v.account.name : '' } });
}

/** fakeTransport({vehicleDelayMs, onVehicle}) -> transport with call log and in-flight instrumentation. */
function fakeTransport(o = {}) {
  const t = {
    calls: [], inFlight: 0, maxInFlight: 0,
    async getJson(p) {
      t.calls.push(p);
      if (o.intercept) { const r = await o.intercept(p); if (r) return r; }
      const pathname = p.split('?')[0];
      if (pathname === C.VEHICLES_PATH) {
        const page = Number(/page=(\d+)/.exec(p)[1]);
        return { ok: true, status: 200, value: (o.pages || VEHICLES_PAGES)[page] };
      }
      if (pathname === C.ISSUES_BY_VEHICLE_PATH) return { ok: true, status: 200, value: o.issues || ISSUES_PAGE };
      const m = /^\/api\/v1\/vehicles\/(\w+)$/.exec(pathname);
      if (m) {
        t.inFlight++;
        t.maxInFlight = Math.max(t.maxInFlight, t.inFlight);
        try {
          if (o.vehicleDelayMs) await sleep(o.vehicleDelayMs);
          return { ok: true, status: 200, value: detailFor(m[1]) };
        } finally { t.inFlight--; }
      }
      return { ok: false, code: 'APERIA_PATH_NOT_ALLOWED' };
    },
  };
  return t;
}

let now = NOW;
function setup(tOpts, sOpts = {}) {
  const transport = fakeTransport(tOpts);
  const session = {
    reauth: vi.fn(sOpts.reauth || (async () => ({ ok: true }))),
    notePull: vi.fn(),
  };
  const dtnaStore = { all: vi.fn(() => sOpts.dtnaEntries || []) };
  client._setDeps({ transport, session, dtnaStore, now: () => now });
  return { transport, session, dtnaStore };
}
const vehicleCalls = (t) => t.calls.filter((p) => p.startsWith('/api/v1/vehicles?')).length;

beforeEach(() => { client._resetForTests(); now = NOW; });

describe('_get: 401 -> reauth -> retry once', () => {
  it('retry succeeds after one reauth', async () => {
    let n = 0;
    const { transport, session } = setup({ intercept: () => (n++ === 0 ? EXPIRED : null) });
    const r = await client.getVehicle('104', {});
    expect(r.ok).toBe(true);
    expect(r.unit.fleetVehicleId).toBe('NP6923');
    expect(transport.calls).toHaveLength(2);
    expect(session.reauth).toHaveBeenCalledTimes(1);
  });

  it('401 twice -> APERIA_SESSION_EXPIRED with exactly 2 transport calls and 1 reauth', async () => {
    const { transport, session } = setup({ intercept: () => EXPIRED });
    const r = await client.getVehicle('104', {});
    expect(r).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(transport.calls).toHaveLength(2);
    expect(session.reauth).toHaveBeenCalledTimes(1);
  });

  it('failed reauth -> APERIA_SESSION_EXPIRED without a retry', async () => {
    const { transport, session } = setup({ intercept: () => EXPIRED }, { reauth: async () => ({ ok: false, code: 'APERIA_SESSION_EXPIRED' }) });
    expect(await client.getVehicle('104', {})).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(transport.calls).toHaveLength(1);
    expect(session.reauth).toHaveBeenCalledTimes(1);
  });

  it('concurrent bulk workers share one reauth', async () => {
    let authed = true;
    const { session } = setup(
      { intercept: (p) => (!authed && /^\/api\/v1\/vehicles\/\w+$/.test(p) ? EXPIRED : null) },
      { reauth: async () => { await sleep(10); authed = true; return { ok: true }; } },
    );
    await client.buildIndex({});
    authed = false;
    const units = ['122269', '122270', 'T100', 'NP6923', 'T200', 'T300', 'T400', 'T500'];
    const r = await client.bulkLookup(units, { ctx: {} });
    expect(r).toMatchObject({ ok: true, total: 8, failed: 0, cancelled: false });
    expect(r.results.every((x) => x.found)).toBe(true);
    expect(session.reauth).toHaveBeenCalledTimes(1);
  });

  it('invalid vehicle id never reaches the transport', async () => {
    const { transport } = setup();
    expect(await client.getVehicle('../accounts', {})).toEqual({ ok: false, code: 'APERIA_INVALID_INPUT' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('unit index', () => {
  it('pages across all 3 pages and normalizes the unit key', async () => {
    const { transport } = setup();
    expect(await client.buildIndex({})).toEqual({ ok: true, size: 8 });
    expect(transport.calls.slice(0, 3)).toEqual([C.vehiclesPath(0), C.vehiclesPath(1), C.vehiclesPath(2)]);
    const r = await client.lookupUnit(' np6923 ', {});
    expect(r.ok).toBe(true);
    expect(r.unit.id).toBe('104');
    expect(transport.calls[3]).toBe('/api/v1/vehicles/104');
    expect(vehicleCalls(transport)).toBe(3);
  });

  it('single-flight: concurrent builds share one paging run', async () => {
    const { transport } = setup();
    const [a, b] = await Promise.all([client.buildIndex({}), client.buildIndex({})]);
    expect(a).toEqual(b);
    expect(vehicleCalls(transport)).toBe(3);
  });

  it('caps paging at MAX_PAGES', async () => {
    const pages = Array.from({ length: 150 }, (_, i) => ({ vehicles: [{ id: i + 1, fleetVehicleId: 'U' + i }], totalPages: 150, totalElements: 150 }));
    const { transport } = setup({ pages });
    expect(await client.buildIndex({})).toEqual({ ok: true, size: C.MAX_PAGES });
    expect(vehicleCalls(transport)).toBe(C.MAX_PAGES);
  });

  it('reuses the index within the TTL, rebuilds after it', async () => {
    const { transport } = setup();
    await client.lookupUnit('T100', {});
    now = NOW + 3600e3;
    await client.lookupUnit('T200', {});
    expect(vehicleCalls(transport)).toBe(3);
    now = NOW + C.INDEX_TTL_MS + 1;
    await client.lookupUnit('T200', {});
    expect(vehicleCalls(transport)).toBe(6);
  });

  it('a miss rebuilds once only when the index is older than 15 min', async () => {
    const { transport } = setup();
    await client.buildIndex({});
    now = NOW + 60e3;
    expect((await client.lookupUnit('ZZZ', {})).code).toBe('APERIA_UNIT_NOT_FOUND');
    expect(vehicleCalls(transport)).toBe(3);
    now = NOW + C.INDEX_MISS_REBUILD_MS + 1;
    expect((await client.lookupUnit('ZZZ', {})).code).toBe('APERIA_UNIT_NOT_FOUND');
    expect(vehicleCalls(transport)).toBe(6);
    expect((await client.lookupUnit('ZZZ', {})).code).toBe('APERIA_UNIT_NOT_FOUND');
    expect(vehicleCalls(transport)).toBe(6);
  });

  it('a page failure is reported and nothing is cached', async () => {
    const { transport } = setup({ intercept: (p) => (p === C.vehiclesPath(1) ? { ok: false, code: 'APERIA_HTTP', status: 500 } : null) });
    expect(await client.buildIndex({})).toEqual({ ok: false, code: 'APERIA_HTTP' });
    expect(client.indexRows()).toEqual([]);
    expect(vehicleCalls(transport)).toBe(2);
  });
});

describe('listIssues', () => {
  it('returns flattened rows, vehicle count, domiciles, pulledAt and calls notePull', async () => {
    const { session } = setup();
    const r = await client.listIssues({});
    expect(r).toMatchObject({ ok: true, vehicles: 2, domiciles: ['ATL2', 'DFW5'], pulledAt: new Date(NOW).toISOString() });
    expect(r.rows).toHaveLength(4);
    expect(session.notePull).toHaveBeenCalledWith(new Date(NOW).toISOString());
  });

  it('shape error -> APERIA_SHAPE_UNRECOGNIZED, no notePull', async () => {
    const { session } = setup({ issues: { content: 'nope' } });
    expect(await client.listIssues({})).toEqual({ ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED' });
    expect(session.notePull).not.toHaveBeenCalled();
  });
});

describe('bulk / fleet worker pool', () => {
  const pages40 = [{ vehicles: Array.from({ length: 40 }, (_, i) => ({ id: 200 + i, fleetVehicleId: 'B' + i, account: { name: i % 2 ? 'DFW5' : 'ATL2' } })), totalPages: 1, totalElements: 40 }];

  it('concurrency never exceeds 6 and progress is monotonic', async () => {
    const { transport } = setup({ pages: pages40, vehicleDelayMs: 3 });
    const prog = [];
    const list = Array.from({ length: 40 }, (_, i) => 'b' + i);
    const r = await client.bulkLookup(list, { ctx: {}, onProgress: (p) => prog.push(p) });
    expect(r).toMatchObject({ ok: true, total: 40, failed: 0, cancelled: false });
    expect(r.results.map((x) => x.assetId)).toEqual(list);
    expect(transport.maxInFlight).toBe(C.CONCURRENCY);
    expect(prog.map((p) => p.done)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(prog.every((p) => p.total === 40)).toBe(true);
  });

  it('not-found units count as failed but do not stop the job', async () => {
    setup();
    const r = await client.bulkLookup(['NP6923', 'NOPE', 'T100'], { ctx: {} });
    expect(r).toMatchObject({ ok: true, total: 3, failed: 1 });
    expect(r.results[1]).toEqual({ assetId: 'NOPE', found: false, code: 'APERIA_UNIT_NOT_FOUND' });
  });

  it('a fatal code stops scheduling', async () => {
    const { transport } = setup({ pages: pages40, intercept: (p) => (/^\/api\/v1\/vehicles\/\w+$/.test(p) ? { ok: false, code: 'APERIA_SIGNIN_REQUIRED' } : null) });
    const r = await client.bulkLookup(Array.from({ length: 40 }, (_, i) => 'B' + i), { ctx: {} });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('APERIA_SIGNIN_REQUIRED');
    expect(r.results.length).toBeLessThanOrEqual(C.CONCURRENCY);
    expect(transport.calls.filter((p) => /^\/api\/v1\/vehicles\/\w+$/.test(p)).length).toBeLessThanOrEqual(C.CONCURRENCY);
  });

  it('session expired after the failed reauth is fatal', async () => {
    setup({ pages: pages40, intercept: (p) => (/^\/api\/v1\/vehicles\/\w+$/.test(p) ? EXPIRED : null) }, { reauth: async () => ({ ok: false }) });
    const r = await client.bulkLookup(Array.from({ length: 40 }, (_, i) => 'B' + i), { ctx: {} });
    expect(r).toMatchObject({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(r.results.length).toBeLessThan(40);
  });

  it('abort -> cancelled:true with partial results', async () => {
    setup({ pages: pages40, vehicleDelayMs: 2 });
    const ac = new AbortController();
    const r = await client.bulkLookup(Array.from({ length: 40 }, (_, i) => 'B' + i), {
      ctx: {}, signal: ac.signal, onProgress: (p) => { if (p.done === 3) ac.abort(); },
    });
    expect(r).toMatchObject({ ok: true, cancelled: true, total: 40 });
    expect(r.results.length).toBeLessThan(40);
    expect(r.results.length).toBeGreaterThanOrEqual(3);
  });

  it('fleetTires forces a fresh index and pulls every vehicle with at most 6 in flight', async () => {
    const { transport } = setup({ pages: pages40, vehicleDelayMs: 2 });
    await client.buildIndex({});
    const prog = [];
    const r = await client.fleetTires({ ctx: {}, onProgress: (p) => prog.push(p.done) });
    expect(vehicleCalls(transport)).toBe(2);
    expect(r).toMatchObject({ ok: true, total: 40, failed: 0, cancelled: false });
    expect(r.results[0]).toMatchObject({ assetId: 'B0', found: true });
    expect(transport.maxInFlight).toBeLessThanOrEqual(C.CONCURRENCY);
    expect(prog).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  });

  it('fleetTires index failure -> ok:false with the code', async () => {
    setup({ intercept: (p) => (p.startsWith('/api/v1/vehicles?') ? { ok: false, code: 'APERIA_SIGNIN_REQUIRED' } : null) });
    expect(await client.fleetTires({ ctx: {} })).toMatchObject({ ok: false, code: 'APERIA_SIGNIN_REQUIRED', total: 0, results: [] });
  });
});

describe('DTNA cross-link (critical, no open repair case)', () => {
  const iss = (unit, severity, extra) => Object.assign({ issueId: unit + severity, fleetVehicleId: unit, domicile: 'DFW5', severity, state: 'UNDERINFLATION',
    position: 'L1IC', positionName: 'Left Steer', dateDetected: '2026-11-22T10:00:00Z', muted: false }, extra);

  it('lists critical + closed-only case; skips open case, MAJOR-only and muted critical', () => {
    const issues = [
      iss('A1', 'CRITICAL'),
      iss('A2', 'CRITICAL', { dateDetected: '2026-11-22T12:00:00Z', state: 'LEAK' }),
      iss('A2', 'CRITICAL', { positionName: 'Right Steer', dateDetected: '2026-11-21T12:00:00Z' }),
      iss('B1', 'CRITICAL'),
      iss('C1', 'MAJOR'),
      iss('D1', 'CRITICAL', { muted: true }),
      iss('NP6923', 'CRITICAL', { dateDetected: '2026-11-20T00:00:00Z' }),
    ];
    const dtnaEntries = [
      { caseId: 'x1', unitId: 'A1', caseStatus: 'Closed' },
      { caseId: 'x2', unitId: 'B1', caseStatus: 'Open - In Repair' },
      { caseId: 'x3', unitId: 'B1', caseStatus: 'Closed' },
      { caseId: 'x4', unitId: '#np 6923', caseStatus: 'Working' },
    ];
    const rows = client.crossLinkCriticalNoCase(issues, { dtnaEntries, fleetRows: [{ equipmentId: ' a2 ' }] });
    expect(rows.map((r) => r.fleetVehicleId)).toEqual(['A2', 'A1']);
    expect(rows[0]).toMatchObject({ domicile: 'DFW5', criticalCount: 2, states: ['LEAK', 'UNDERINFLATION'], positions: ['Left Steer', 'Right Steer'],
      latestDetected: '2026-11-22T12:00:00Z', inFleet: true, closedDtnaCases: 0 });
    expect(rows[0].latestDetectedEt).toBe('11/22/2026, 7:00 AM EST');
    expect(rows[1]).toMatchObject({ criticalCount: 1, inFleet: false, closedDtnaCases: 1 });
  });

  it('unit match uses normUnit on both sides (#np 6923 matches NP6923)', () => {
    const rows = client.crossLinkCriticalNoCase([iss('NP6923', 'CRITICAL')], { dtnaEntries: [{ unitId: '#np 6923', caseStatus: 'Closed' }] });
    expect(rows).toHaveLength(1);
    expect(rows[0].closedDtnaCases).toBe(1);
    expect(client.crossLinkCriticalNoCase([iss('NP6923', 'CRITICAL')], { dtnaEntries: [{ unitId: '#np 6923', caseStatus: 'Open' }] })).toEqual([]);
  });

  it('criticalNoCase reads the stubbed dtna store only and never loads the DTNA client or session', async () => {
    const { dtnaStore } = setup({}, { dtnaEntries: [{ caseId: 'c', unitId: 'NP6923', caseStatus: 'Open' }] });
    const r = await client.criticalNoCase({}, { fleetRows: [] });
    expect(r.ok).toBe(true);
    expect(dtnaStore.all).toHaveBeenCalledTimes(1);
    // ISSUES_PAGE: NP6923 critical (open case -> skipped), 122269 critical is muted -> nothing listed.
    expect(r).toMatchObject({ rows: [], count: 0, domiciles: [], pulledAt: new Date(NOW).toISOString() });
    const loaded = Object.keys(require.cache).map((k) => k.replace(/\\/g, '/'));
    expect(loaded.some((k) => k.endsWith('/src/dtna/client.js'))).toBe(false);
    expect(loaded.some((k) => k.endsWith('/src/dtna/session.js'))).toBe(false);
    const src = fs.readFileSync(path.join(path.dirname(require.resolve('../src/aperia/client')), 'client.js'), 'utf8');
    expect(src).not.toMatch(/require\(['"]\.\.\/dtna\/(client|session)['"]\)/);
  });

  it('criticalNoCase lists a critical unit whose only case is closed', async () => {
    setup({}, { dtnaEntries: [{ caseId: 'c', unitId: 'NP6923', caseStatus: 'Closed' }] });
    const r = await client.criticalNoCase({}, { fleetRows: [{ equipmentId: 'NP6923' }] });
    expect(r).toMatchObject({ ok: true, count: 1, domiciles: ['ATL2'] });
    expect(r.rows[0]).toMatchObject({ fleetVehicleId: 'NP6923', criticalCount: 1, inFleet: true, closedDtnaCases: 1 });
  });
});
