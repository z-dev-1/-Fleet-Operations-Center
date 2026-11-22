// tests/fixtures/aperia/responses.js — Aperia API response fakes modeled on discovery.md (values are placeholders).
// NOW is fixed; every relative time is computed from it.
export const NOW = Date.parse('2026-11-22T15:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const DAY = 24 * 3600e3;

const veh = (id, unit, dom, group) => ({
  id, fleetVehicleId: unit, vin: 'VIN' + id, type: 'TRACTOR', createdAt: '2024-01-01T00:00:00Z',
  account: { id: 7, name: dom }, group: { id: 3, name: group },
  gateway: { id: 9, type: 'APOLLO', serialNumber: 'GW' + id, gatewayId: 'g' + id },
});

// 3 small /vehicles pages (totalPages 3). NP6923 sits on page 1.
export const VEHICLES_PAGES = [
  { vehicles: [veh(101, '122269', 'DFW5', 'Ops A'), veh(102, '122270', 'DFW5', 'Ops A'), veh(103, 'T100', 'ATL2', 'Ops B')], totalElements: 8, totalPages: 3, totalUnfilteredElements: 8 },
  { vehicles: [veh(104, 'NP6923', 'ATL2', 'Ops B'), veh(105, 'T200', 'ORD1', 'Ops C'), veh(106, 'T300', 'ORD1', 'Ops C')], totalElements: 8, totalPages: 3, totalUnfilteredElements: 8 },
  { vehicles: [veh(107, 'T400', 'DFW5', 'Ops A'), veh(108, 'T500', 'ATL2', 'Ops B')], totalElements: 8, totalPages: 3, totalUnfilteredElements: 8 },
];

export const GEO_PLACEHOLDER = { latitude: -11.11111, longitude: 11.11111, altitude: 0, createdAt: iso(3600e3), locationPictureUrl: 'https://maps.googleapis.com/maps/api/staticmap?center=-11,11' };
export const GEO_US = { latitude: 32.89654, longitude: -97.03804, altitude: 180.2, createdAt: iso(2 * 3600e3), locationPictureUrl: 'https://maps.googleapis.com/maps/api/staticmap?center=32.9,-97.0' };
export const GEO_OUTSIDE = { latitude: 51.0, longitude: -100.0, altitude: 500, createdAt: iso(3600e3), locationPictureUrl: 'http://evil.example/x.png' };

const sensor = (position, positionName, extra) => Object.assign({
  id: position + '-id', position, shortPosition: position.slice(0, 3), positionName,
  setPoint: 100, temperature: 71.26, faulted: false, serialNumber: 'S' + position, uniqueId: 'U' + position,
  updatedAt: iso(3600e3), tire: { brand: 'X' },
}, extra);

export const CRITICAL_ISSUE = {
  id: 9001, severity: 'CRITICAL', type: 'UNDERINFLATION', resolveBy: 'immediately', createdAt: iso(2 * 3600e3),
  actions: ['Inflate the tire to the set point.', 'Inspect for a puncture.', 'a3', 'a4', 'a5', 'a6 dropped', 'a7 dropped'],
};

// 10 sensors (deliberately out of position order) covering every flag.
export const VEHICLE_DETAIL = Object.assign(veh(104, 'NP6923', 'ATL2', 'Ops B'), {
  archived: false, cycleNumber: 4, notificationConfigId: 77, coldSnapMute: false,
  coldSnap: { detectedAt: iso(DAY), startedAt: iso(DAY), expiresAt: new Date(NOW + DAY).toISOString() },
  latestPreTripInspection: { loggedAt: iso(5 * 3600e3) },
  latestGeoTag: GEO_US,
  account: { id: 7, name: 'ATL2', ssoEnabled: true, usersCount: 12, vehiclesCount: 8811 },
  sensors: [
    sensor('R3IC', 'Right Rear Inner', { setPoint: undefined, pressure: 100 }),                 // ''
    sensor('L1IC', 'Left Steer', { faulted: true, pressure: 50, updatedAt: iso(30 * DAY) }),     // SENSOR FAULT
    sensor('L1OC', 'Left Steer Outer', { pressure: 0, updatedAt: iso(8 * DAY) }),                // STALE (dead sensor)
    sensor('L2IC', 'Left Drive Inner', { pressure: 0 }),                                         // NO READING
    sensor('L2OC', 'Left Drive Outer', { pressure: undefined }),                                 // NO READING (absent)
    sensor('R1IC', 'Right Steer', { pressure: 70, issue: CRITICAL_ISSUE }),                      // CRITICAL LOW
    sensor('R1OC', 'Right Steer Outer', { pressure: 80 }),                                       // LOW (exactly 80%)
    sensor('R2IC', 'Right Drive Inner', { pressure: 90 }),                                       // OK (exactly 90%)
    sensor('R2OC', 'Right Drive Outer', { pressure: 110, temperature: undefined, updatedAt: undefined }), // OK (110%, no time)
    sensor('L3IC', 'Left Rear Inner', { pressure: 115 }),                                        // HIGH
  ],
});

export const ISSUES_PAGE = {
  content: [
    {
      id: 104, fleetVehicleId: 'NP6923', account: { id: 7, name: 'ATL2' }, vehicleGroupName: 'Ops B', numberOfRecipients: 4,
      gatewaySerialNumber: 'GW104',
      issues: [
        { id: 9001, severity: 'CRITICAL', state: 'UNDERINFLATION', position: 'R1IC', positionName: 'Right Steer', dateDetected: iso(2 * 3600e3) },
        { id: 9002, severity: 'MAJOR', state: 'LEAK', position: 'L2IC', positionName: 'Left Drive Inner', dateDetected: iso(3 * 3600e3), muted: false },
      ],
    },
    {
      id: 101, fleetVehicleId: '122269', account: { id: 7, name: 'DFW5' }, vehicleGroupName: 'Ops A', numberOfRecipients: 2,
      gatewaySerialNumber: 'GW101',
      issues: [
        { id: 9003, severity: 'CRITICAL', state: 'UNDERINFLATION_AND_LEAK', position: 'L1IC', positionName: 'Left Steer', dateDetected: iso(DAY), muted: true },
        { id: 9004, severity: 'MINOR', state: 'UNDERINFLATION', position: 'R2OC', positionName: 'Right Drive Outer', dateDetected: iso(2 * DAY) },
      ],
    },
  ],
  totalElements: 2, totalPages: 1, totalUnfilteredElements: 2,
};

export const PII = Object.freeze({
  email: 'sentinel.person@example.com', phone: '(555) 867-5309',
  contacts: [{ email: 'sentinel.person@example.com', phoneNumber: '555-867-5309', firstName: 'Sentinelfirst' }],
  users: [{ email: 'sentinel.user@example.com', name: 'Sentineluser' }],
});
export const PII_STRINGS = ['sentinel.person', 'sentinel.user', '867-5309', 'Sentinelfirst', 'Sentineluser'];

/** withPii(v) -> deep copy with the contact-PII keys injected into every plain object. */
export function withPii(v) {
  if (Array.isArray(v)) return v.map(withPii);
  if (!v || typeof v !== 'object') return v;
  const o = {};
  for (const k of Object.keys(v)) o[k] = withPii(v[k]);
  return Object.assign(o, JSON.parse(JSON.stringify(PII)));
}
