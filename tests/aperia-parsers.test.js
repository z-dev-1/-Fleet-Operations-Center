// tests/aperia-parsers.test.js — whitelisting parsers (src/aperia/parsers.js): exact output shapes, account ->
// domicile name only, contact PII / numberOfRecipients / unlisted keys dropped, muted === true only.
process.env.TZ = 'UTC';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { NOW, VEHICLES_PAGES, VEHICLE_DETAIL, ISSUES_PAGE, GEO_PLACEHOLDER, PII_STRINGS, withPii } from './fixtures/aperia/responses.js';

const require = createRequire(import.meta.url);
const P = require('../src/aperia/parsers');

const LEAK_KEYS = ['email', 'phone', 'phoneNumber', 'contacts', 'users', 'numberOfRecipients', 'ssoEnabled', 'usersCount', 'uniqueId', 'tire',
  'notificationConfigId', 'cycleNumber', 'account', 'gatewayId'];
function expectClean(v) {
  const s = JSON.stringify(v);
  for (const k of LEAK_KEYS) expect(s).not.toContain('"' + k + '"');
  for (const x of PII_STRINGS) expect(s).not.toContain(x);
}

describe('unitKey', () => {
  it('upper-cases and trims', () => {
    expect(P.unitKey(' np6923 ')).toBe('NP6923');
    expect(P.unitKey(null)).toBe('');
    expect(P.unitKey(122269)).toBe('122269');
  });
});

describe('parseVehiclesPage', () => {
  it('builds whitelisted rows (id string, domicile = account.name, group = group.name)', () => {
    const r = P.parseVehiclesPage(withPii(VEHICLES_PAGES[1]));
    expect(r).toMatchObject({ ok: true, totalPages: 3, totalElements: 8 });
    expect(r.rows[0]).toEqual({ id: '104', fleetVehicleId: 'NP6923', unitKey: 'NP6923', vin: 'VIN104', type: 'TRACTOR', domicile: 'ATL2', group: 'Ops B' });
    expectClean(r);
  });

  it('unrecognized shapes -> APERIA_SHAPE_UNRECOGNIZED', () => {
    for (const v of [null, 'x', [], { vehicles: 'x' }, { content: [] }]) {
      expect(P.parseVehiclesPage(v)).toEqual({ ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED' });
    }
  });
});

describe('parseVehicleDetail', () => {
  const r = P.parseVehicleDetail(withPii(VEHICLE_DETAIL), { now: NOW });

  it('has the exact detail shape and no unlisted keys', () => {
    expect(r.ok).toBe(true);
    expect(Object.keys(r.unit).sort()).toEqual(['archived', 'coldSnap', 'domicile', 'fleetVehicleId', 'gateway', 'gps', 'gpsReason', 'group', 'id',
      'issues', 'preTripAt', 'tires', 'type', 'vin'].sort());
    expect(r.unit).toMatchObject({ id: '104', fleetVehicleId: 'NP6923', domicile: 'ATL2', group: 'Ops B', archived: false,
      gateway: { type: 'APOLLO', serialNumber: 'GW104' }, gpsReason: 'OK' });
    expect(r.unit.coldSnap.active).toBe(true);
    expect(r.unit.preTripAt).toBe(VEHICLE_DETAIL.latestPreTripInspection.loggedAt);
    expect(r.unit.gps).toMatchObject({ lat: 32.89654, lng: -97.03804, outsideUs: false });
    expectClean(r);
  });

  it('tires are sorted by position and carry every flag', () => {
    const t = r.unit.tires;
    expect(t.map((x) => x.position)).toEqual(['L1IC', 'L1OC', 'L2IC', 'L2OC', 'L3IC', 'R1IC', 'R1OC', 'R2IC', 'R2OC', 'R3IC']);
    const byPos = Object.fromEntries(t.map((x) => [x.position, x.flag]));
    expect(byPos).toEqual({
      L1IC: 'SENSOR FAULT', L1OC: 'STALE', L2IC: 'NO READING', L2OC: 'NO READING', L3IC: 'HIGH',
      R1IC: 'CRITICAL LOW', R1OC: 'LOW', R2IC: 'OK', R2OC: 'OK', R3IC: '',
    });
    const r2oc = t.find((x) => x.position === 'R2OC');
    expect(r2oc).toMatchObject({ temperatureF: null, updatedAt: '', readAtEt: '', deltaPsi: 10, pct: 110 });
  });

  it('embedded issue: whitelisted, actions capped at 5 x 300 chars, listed in issues', () => {
    const long = 'x'.repeat(400);
    const d = JSON.parse(JSON.stringify(VEHICLE_DETAIL));
    d.sensors[5].issue.actions[0] = long;
    const u = P.parseVehicleDetail(d, { now: NOW }).unit;
    expect(u.issues).toHaveLength(1);
    const i = u.issues[0];
    expect(Object.keys(i).sort()).toEqual(['actions', 'createdAt', 'createdEt', 'id', 'position', 'positionName', 'resolveBy', 'severity', 'type'].sort());
    expect(i).toMatchObject({ position: 'R1IC', positionName: 'Right Steer', id: '9001', severity: 'CRITICAL', type: 'UNDERINFLATION', resolveBy: 'immediately' });
    expect(i.actions).toHaveLength(5);
    expect(i.actions[0]).toHaveLength(300);
    expect(i.createdEt).toMatch(/(EST|EDT)$/);
    expect(u.tires.find((x) => x.position === 'R1IC').issue.id).toBe('9001');
  });

  it('placeholder GPS -> gps null, gpsReason PLACEHOLDER; missing -> MISSING', () => {
    const p = P.parseVehicleDetail(Object.assign({}, VEHICLE_DETAIL, { latestGeoTag: GEO_PLACEHOLDER }), { now: NOW }).unit;
    expect(p.gps).toBeNull();
    expect(p.gpsReason).toBe('PLACEHOLDER');
    const m = P.parseVehicleDetail(Object.assign({}, VEHICLE_DETAIL, { latestGeoTag: undefined }), { now: NOW }).unit;
    expect(m.gpsReason).toBe('MISSING');
  });

  it('unrecognized shapes -> APERIA_SHAPE_UNRECOGNIZED', () => {
    for (const v of [null, [], 'x', {}]) expect(P.parseVehicleDetail(v, { now: NOW })).toEqual({ ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED' });
  });
});

describe('issues', () => {
  const r = P.parseIssuesPage(withPii(ISSUES_PAGE));

  it('parseIssuesPage builds whitelisted rows; muted only when === true', () => {
    expect(r).toMatchObject({ ok: true, totalPages: 1, totalElements: 2 });
    expect(Object.keys(r.rows[0]).sort()).toEqual(['domicile', 'fleetVehicleId', 'gatewaySerialNumber', 'group', 'issues', 'vehicleId'].sort());
    expect(r.rows[0]).toMatchObject({ vehicleId: '104', fleetVehicleId: 'NP6923', domicile: 'ATL2', group: 'Ops B', gatewaySerialNumber: 'GW104' });
    expect(Object.keys(r.rows[0].issues[0]).sort()).toEqual(['dateDetected', 'id', 'muted', 'position', 'positionName', 'severity', 'state'].sort());
    expect(r.rows[0].issues.map((x) => x.muted)).toEqual([false, false]);
    expect(r.rows[1].issues.map((x) => x.muted)).toEqual([true, false]);
    expectClean(r);
  });

  it('flattenIssues -> one object per issue with detectedEt', () => {
    const f = P.flattenIssues(r.rows);
    expect(f).toHaveLength(4);
    expect(Object.keys(f[0]).sort()).toEqual(['dateDetected', 'detectedEt', 'domicile', 'fleetVehicleId', 'group', 'issueId', 'muted', 'position',
      'positionName', 'severity', 'state', 'vehicleId'].sort());
    expect(f[0]).toMatchObject({ issueId: '9001', vehicleId: '104', fleetVehicleId: 'NP6923', domicile: 'ATL2', severity: 'CRITICAL', muted: false });
    expect(f[0].detectedEt).toMatch(/(EST|EDT)$/);
    expect(f[2]).toMatchObject({ issueId: '9003', muted: true, state: 'UNDERINFLATION_AND_LEAK' });
    expectClean(f);
  });

  it('domicilesOf -> sorted unique', () => {
    expect(P.domicilesOf(r.rows)).toEqual(['ATL2', 'DFW5']);
    expect(P.domicilesOf([{ domicile: '' }, null, { domicile: 'B' }, { domicile: 'A' }, { domicile: 'B' }])).toEqual(['A', 'B']);
  });

  it('unrecognized shapes -> APERIA_SHAPE_UNRECOGNIZED', () => {
    for (const v of [null, { content: null }, { vehicles: [] }]) expect(P.parseIssuesPage(v)).toEqual({ ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED' });
  });
});
