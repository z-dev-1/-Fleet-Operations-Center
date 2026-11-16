// tests/fixtures/fleet-build/aap-fleet-fixture.js — masked AAP shapes for
// buildFleetDataset tests. Hand-built from the field paths in
// .agents/tasks/relay-extract/shape-probe/*.asset.json / *.serviceaggregate.json
// and tests/fixtures/extract/relay-vendors.js. Unit numbers, aaids, operators,
// VINs and sites are synthetic; no real names, aliases or phones.
const T0 = Date.parse('2026-11-10T12:00:00Z');

// One v2 asset-search entry ({ assets: [entry, ...] }).
export function mkAsset({ aaid, unit, state = 'UNAVAILABLE', reason = 'OFFSITE_SHOP_REPAIR', site = 'TST1',
  operator = 'DSPX', vin = 'TESTVIN0000000000', bodyType = 'STANDARD', assetType = 'boxTruck', geofence } = {}) {
  return {
    asset: {
      aaid,
      displayName: unit,
      assetType,
      lifecycleState: state,
      lifecycleStateReason: state === 'UNAVAILABLE' ? reason : null,
      attributesText: { operator, owner: 'OWNR', domicileSite: site, bodyType, vin, manufacturerName: 'TESTMAKE' },
    },
    latestLocation: { geoFences: [{ name: geofence || (site + '-YARD') }] },
  };
}

// One serviceaggregates/search item ({ serviceAggregates: [item, ...] }).
export function mkWo({ id, aaid, unit, status = 'WORK_IN_PROGRESS', vendor = 'AMERIT', modified = T0,
  completed = null, category = 'UNPLANNED', state = 'UNAVAILABLE', reason = 'OFFSITE_SHOP_REPAIR' } = {}) {
  const wo = {
    id,
    aaid,
    assetDisplayName: unit,
    status: { description: { value: status } },
    vendor,
    category,
    modifiedTimestamp: modified,
    lifecycleState: state,
    lifecycleStateReason: reason,
    suggestedItems: [{ level1: 'Electrical', level2: 'Batteries' }],
  };
  if (completed != null) wo.completedDateTime = completed;
  return wo;
}

// A recorded set: U1-U3 UNAVAILABLE with open WOs in the bulk search (U3 also
// has a newer COMPLETED WO that must lose to its open one), U4 UNAVAILABLE whose
// WO is only returned by findOpenWO, U5 ACTIVE with a zombie open WO, U6 ORDERED.
const A = (n, extra) => mkAsset(Object.assign({ aaid: 'aaid-u' + n, unit: 'T100' + n, vin: 'TESTVIN000000000' + n }, extra));
export const FLEET = {
  assets: [
    A(1, { operator: 'DSPA' }),
    A(2, { reason: 'IN_YARD_REPAIR' }),
    A(3, { bodyType: 'DAY_CAB', assetType: 'tractor' }),
    A(4),
    A(5, { state: 'ACTIVE' }),
    A(6, { state: 'ORDERED' }),
  ],
  unplannedWos: [
    mkWo({ id: 'svc-u1', aaid: 'aaid-u1', unit: 'T1001', vendor: 'AMERIT' }),
    mkWo({ id: 'svc-u2', aaid: 'aaid-u2', unit: 'T1002', vendor: 'VOLVO', status: 'SCHEDULED' }),
    mkWo({ id: 'svc-u3-open', aaid: 'aaid-u3', unit: 'T1003', vendor: 'PACCAR', modified: T0 - 86400000 }),
    mkWo({ id: 'svc-u3-done', aaid: 'aaid-u3', unit: 'T1003', vendor: 'PACCAR', status: 'COMPLETED', completed: T0 }),
    mkWo({ id: 'svc-u5-zombie', aaid: 'aaid-u5', unit: 'T1005', vendor: 'AMERIT', modified: T0 - 700 * 86400000 }),
  ],
  plannedWos: [
    mkWo({ id: 'svc-u1-pm', aaid: 'aaid-u1', unit: 'T1001', category: 'PLANNED', status: 'SCHEDULED' }),
  ],
  // findOpenWO (equipmentIds search) answers, keyed by unit number.
  fallbackWos: {
    T1004: mkWo({ id: 'svc-u4', aaid: 'aaid-u4', unit: 'T1004', vendor: 'CUMMINS' }),
  },
};

// n asset entries starting at index `start` (aaid 'aaid-p<i>', unit 'P<i>').
export function mkAssetPage(n, start = 0) {
  return Array.from({ length: n }, (_, k) => mkAsset({ aaid: 'aaid-p' + (start + k), unit: 'P' + (start + k) }));
}

// Two WO search pages (default 100 + 37) on aaid-p0.. so paging stops at the short page.
export function mkWoPages(sizes = [100, 37]) {
  let i = 0;
  return sizes.map((n) => Array.from({ length: n }, () => {
    const k = i++;
    return mkWo({ id: 'svc-p' + k, aaid: 'aaid-p' + k, unit: 'P' + k });
  }));
}
