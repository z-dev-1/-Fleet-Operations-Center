'use strict';
// Shared fixtures for the SOS/EOS report redesign: used by
// tests/email-builder-redesign.test.js and scripts/build-eos-samples.js.
// PM dates are computed relative to "today" so overdue day counts are exact.

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(offsetDays) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  const dd = d.getDate();
  return MON[d.getMonth()] + ' ' + (dd < 10 ? '0' + dd : dd) + ', ' + d.getFullYear();
}

const UUID = '0f8c2a1e-1111-4a2b-9c3d-abcdefabcdef';
const UUID2 = '7a1b2c3d-2222-4e5f-8a9b-0c1d2e3f4a5b';
const LONG_ISSUE = 'CEL coolant temperature sensor fault; dealer diagnosed a chafed harness behind the cab, replacement harness is backordered with no ETA, unit cannot be released until the harness is installed and a road test is completed. Shop asked for approval on an additional coolant flush. END-OF-ISSUE-MARKER';

function auvteUnits() {
  const base = { op: 'AUVTE', site: 'ABE40', bodyType: 'Box Truck', atsState: 'Available', model: 'FREIGHTLINER' };
  const units = [];
  // 7 unavailable
  units.push({ ...base, id: 'B12195', atsState: 'Unavailable', duration: '11d 4h 2m', relayStatus: 'Offsite Shop Repair',
    vendor: 'COX', subVendor: 'Kenworth Rochester', geofence: 'ABE40', issueSummary: LONG_ISSUE,
    savedRepairStatus: 'Repairs In Progress', savedPrimaryComponent: 'Engine',
    altId: 'amz-8w2u-0001', serviceUrl: 'https://service.example.com/alt/amz-8w2u-0001',
    savedSalesforceCase: '00482213', savedSalesforceCaseUrl: 'https://sf.example.com/case/00482213',
    savedNotes: 'PRIVATE-SCRATCH-DO-NOT-SEND', pmB: fmtDate(-14) });
  units.push({ ...base, id: 'B12201', atsState: 'Unavailable', duration: '8d 10h 0m', relayStatus: 'Offsite Shop Repair',
    vendor: 'TA', geofence: 'ABE40', issue: 'Brake chamber leak', model: 'VOLVO',
    offsiteShopEvent: 'OSE-55120', offsiteShopEventUrl: 'https://relay.example.com/ose/55120', dot: fmtDate(-3) });
  units.push({ ...base, id: 'B12210', atsState: 'Unavailable', duration: '5d 2h 0m', relayStatus: 'Onsite Repair',
    savedRepairStatus: 'Amerit', savedSalesforceCase: '00490001', quarterlyLift: fmtDate(-2) });
  units.push({ ...base, id: 'B12222', atsState: 'Unavailable', duration: '4d 0h 0m', relayStatus: 'Onsite Repair', model: 'MACK', pmX: 'Overdue 5 months' });
  units.push({ ...base, id: 'B12230', atsState: 'Unavailable', duration: '2d 6h 0m', relayStatus: 'Onsite Repair', model: 'MODEL YEAR 2021' });
  units.push({ ...base, id: 'B12240', atsState: 'Unavailable', duration: '1d 0h 0m', relayStatus: 'Onsite Repair', savedRepairStatus: 'Done' });
  units.push({ ...base, id: 'B12250', atsState: 'Unavailable', duration: '', relayStatus: 'Onsite Repair' });
  // ORDERED new delivery
  units.push({ ...base, id: 'B13001', atsState: 'Ordered', relayStatus: 'Pending Delivery', issue: 'New Delivery Box Truck Inspection' });
  // Uptake units
  units.push({ ...base, id: 'B12300', riskScore: 82, riskTier: 'Very High',
    insightsList: [{ title: 'Coolant pressure trending abnormal', stillActive: true, url: 'https://fleet.uptake.com/asset/' + UUID + '/insights/ins-1' }] });
  units.push({ ...base, id: 'B12301', riskScore: 64, insights: 'Battery voltage dips at start' });
  // PM due-soon / far / unknown
  units.push({ ...base, id: 'B12310', dot: fmtDate(20) });
  units.push({ ...base, id: 'B12311', pmB: fmtDate(45) });
  units.push({ ...base, id: 'B12312', pmX: fmtDate(200) });
  units.push({ ...base, id: 'B12313', pmB: '--', dot: 'Unknown' });
  let n = 0;
  while (units.length < 29) units.push({ ...base, id: 'B1240' + (n++) });
  return units;
}

function mixedUnits() {
  const units = [];
  const tz = { op: 'TUZR', site: 'AVP40', atsState: 'Available' };
  const add = (bodyType, count, downCount, prefix, extra) => {
    for (let i = 0; i < count; i++) {
      const u = { ...tz, bodyType, id: prefix + String(i).padStart(3, '0'), model: 'FREIGHTLINER', ...(extra || {}) };
      if (i < downCount) { u.atsState = 'Unavailable'; u.duration = (i * 3 + 1) + 'd 2h 0m'; u.relayStatus = 'Onsite Repair'; }
      units.push(u);
    }
  };
  add('Day Cab', 34, 4, 'DC');
  add('Sleeper', 22, 3, 'SL', { model: 'VOLVO' });
  add('Box Truck', 15, 2, 'BX');
  units.push({ ...tz, id: 'OT001', bodyType: '' });
  // sleeper offsite card with garage + timeline
  Object.assign(units.find(u => u.id === 'SL000'), { id: 'FLD260412', duration: '11d 0h 0m', relayStatus: 'Offsite Shop Repair',
    vendor: 'TA', subVendor: 'TA Breezewood', geofence: 'AVP40', issueSummary: 'Aftertreatment fault; DEF head on order, ETA 11/21 per shop.',
    savedRepairStatus: 'Repairs In Progress', savedPrimaryComponent: 'Engine', savedSalesforceCase: '00488210', pmB: fmtDate(-14) });
  Object.assign(units.find(u => u.id === 'DC000'), { id: 'IND260114', model: 'KENWORTH', duration: '4d 0h 0m', relayStatus: 'Offsite Shop Repair',
    vendor: 'AMERIT', geofence: 'AVP40 (mobile)', issueSummary: 'Front brake chamber replacement; parts on hand.', savedRepairStatus: 'Amerit',
    altId: 'amz-k4p2', dot: fmtDate(-9) });
  // ORDERED new deliveries
  Object.assign(units.find(u => u.id === 'SL021'), { id: 'AMZ504120', atsState: 'Ordered', relayStatus: 'Pending Delivery', issue: 'New Delivery Sleeper Inspection' });
  Object.assign(units.find(u => u.id === 'DC033'), { id: 'AMZ504121', atsState: 'Ordered', relayStatus: 'Pending Delivery' });
  // Uptake
  Object.assign(units.find(u => u.id === 'DC020'), { id: 'FLD260889', riskScore: 88, riskTier: 'Very High',
    insightsList: [{ title: 'Coolant system pressure trending abnormal', stillActive: true, url: 'https://fleet.uptake.com/asset/' + UUID2 + '/insights/x' }] });
  Object.assign(units.find(u => u.id === 'BX010'), { quarterlyLift: fmtDate(-4), dot: fmtDate(30) });
  // other operator (must be filtered out)
  units.push({ op: 'AUVTE', site: 'AVP40', id: 'AUVTE-LEAK-1', bodyType: 'Box Truck', atsState: 'Unavailable', duration: '9d 0h 0m' });
  units.push({ op: 'AUVTE', site: 'AVP40', id: 'AUVTE-LEAK-2', bodyType: 'Box Truck', atsState: 'Available' });
  units.push({ op: 'AUVTE', site: 'AVP40', id: 'AUVTE-LEAK-3', bodyType: 'Day Cab', atsState: 'Available' });
  return units;
}

const auvte = {
  operator: 'AUVTE', domicile: 'ABE40', slot: 'PM', scopeKey: 'AUVTE_ABE40_PM',
  get units() { return auvteUnits(); },
  relayCache: { B12230: { make: 'PETERBILT' } },
  notesStore: { B12195: { timeline: '11/07 \u2014 Towed to COX, diagnosed CEL\n11/09 \u2014 Parts ordered, no ETA\nok' } },
  // baseline: B12230 + B12240 were available, B12400 was unavailable
  newIds: ['B12230', 'B12240'], returnedId: 'B12400',
};
const mixed = {
  operator: 'TUZR', domicile: 'AVP40', slot: 'AM', scopeKey: 'TUZR_AVP40_AM',
  get units() { return mixedUnits(); },
  relayCache: {}, notesStore: { FLD260412: { timeline: '11/07 \u2014 Towed to TA\n11/10 \u2014 Diagnosed aftertreatment' } },
  newIds: ['FLD260412', 'IND260114'], returnedId: 'DC030',
};

// Seed a previous verified-send snapshot for a scope: same unit states as
// now, except newIds were Available and returnedId was Unavailable.
function seedBaseline(store, fx, sentAt) {
  const units = fx.units.filter(u => u.op === fx.operator).map(u => {
    let st = u.atsState || '';
    if (fx.newIds.includes(u.id)) st = 'Available';
    if (u.id === fx.returnedId) st = 'Unavailable';
    return { id: u.id, atsState: st, vendor: u.vendor || '', duration: u.duration || '', riskScore: u.riskScore || 0 };
  });
  const root = store.load('emailLastSnapshot', null) || {};
  if (!root.__scopes) root.__scopes = {};
  root.__scopes[fx.scopeKey] = { sentAt: sentAt || new Date(Date.now() - 8 * 3600e3).toISOString(), slot: fx.slot, units };
  store.save('emailLastSnapshot', root);
}

module.exports = { auvte, mixed, seedBaseline, fmtDate, UUID, UUID2, LONG_ISSUE };
