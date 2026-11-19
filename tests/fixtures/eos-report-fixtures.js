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

// Short pill form relay.js _formatPmDate emits for today/future: "Mon D" (no year).
function shortDate(offsetDays) {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + offsetDays);
  return MON[d.getMonth()] + ' ' + d.getDate();
}
// "Mon YYYY" month-only raw due form (AAP MONTH_AND_YEAR).
function monthYear(offsetMonths) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + offsetMonths);
  return MON[d.getMonth()] + ' ' + d.getFullYear();
}

// FLD260703 shape (live data 11/19): down, lifecycleReason Damaged-Moderate
// (not "offsite"), vendor Freightliner (DAIMLER), DTNA case + SF case, long
// Alt ID, rich timeline. Seeded with dollar amounts and personal names in the
// stored timeline/issue so render-time redaction can be checked.
const FLD_NAMES = ['Tiberius Blackshear', 'Santiago', 'Christy Adriaansen', 'Jane Doe'];
const FLD_TIMELINE = [
  '11/17 - Work order created with Freightliner (DAIMLER) for malfunctioning parking/door sensor. Unit towed to dealer (tow ref amz-r938dmz7fhqtg8). DTNA case opened (ref 500gx000003O1RBAA0).',
  '11/17 - Salesforce case 00036143 created to track potential carrier pickup (per Tiberius Blackshear email 11/17).',
  '11/18 - Berman Truck Group (Leesport, PA) estimate $1,284.50 submitted; tow invoice $350 (per Santiago, Z email 11/18).',
  '11/19 - Kenworth Northeast Group confirmed diagnosis, EST \\$2.5K pending approval (per Z Santiago email 11/19). Christy Adriaansen - Kenworth Northeast Group (Service Advisor) scheduled the appointment.',
].join('\n');
const FLD_ISSUE = 'Parking/door sensor malfunctioning and generating false alerts; dealer quoted $640.00 for the sensor.';

function fldUnits() {
  const base = { op: 'TUZR', site: 'ABE40', bodyType: 'Sleeper', atsState: 'Available', model: 'FREIGHTLINER' };
  return [
    { ...base, id: 'FLD260703', atsState: 'Unavailable', relayStatus: 'Damaged-Moderate', duration: '1d 12h 38m',
      vendor: 'Freightliner (DAIMLER)', geofence: 'ABE40', savedRepairStatus: 'Appointment scheduled', savedPrimaryComponent: 'ELECTRICAL',
      altId: 'amz-vvfnvm6rhep2et', serviceUrl: 'https://aap.example.com/v2/service/0918f605',
      offsiteShopEvent: 'DTNA Case', offsiteShopEventUrl: 'https://dtna.example.com/case/500gx000003O1',
      savedSalesforceCase: '00036143', savedSalesforceCaseUrl: 'https://sf.example.com/case/00036143',
      pmB: shortDate(80), pmBDue: fmtDate(80), dot: shortDate(330), dotDue: fmtDate(330) },
    // Down, non-offsite, vendor + issue only (no timeline)
    { ...base, id: 'FLD300010', atsState: 'Unavailable', relayStatus: 'Damaged-Minor', duration: '3d 1h 0m',
      vendor: 'COX', issue: 'Mirror bracket cracked, Jane Doe - COX (Service Writer) quoted $95.' },
    // Down, nothing at all -> Relay Garage "—"
    { ...base, id: 'FLD300011', atsState: 'Unavailable', relayStatus: 'Damaged-Minor', duration: '0d 4h 0m' },
    // PM/DOT field-mapping cases
    { ...base, id: 'FLD300001', pmB: 'overdue', pmBDue: fmtDate(-9) },          // short says only "overdue"; raw has the date
    { ...base, id: 'FLD300002', dot: shortDate(25) },                           // short form only, due in 25d
    { ...base, id: 'FLD300003' },                                               // no PM fields on the unit (scheduler shape); raw in fleetData
    { ...base, id: 'FLD300004', pmB: '--' },                                    // compose fallback '--'; raw in fleetData
    { ...base, id: 'FLD300005', pmXDue: fmtDate(60), dotDue: fmtDate(61) },     // 60d boundary
  ];
}
// Persisted fleet rows (store 'fleetData') carrying the raw due fields the send
// paths do not map onto units.
const fldFleetRows = () => [
  { equipmentId: 'FLD300003', dotDue: 'Overdue 4 days', pmXDue: monthYear(-2) },
  { equipmentId: 'FLD300004', pmBDue: fmtDate(30) },
];
const fld = {
  operator: 'TUZR', domicile: 'ABE40', slot: 'PM', scopeKey: 'TUZR_ABE40_PM',
  get units() { return fldUnits(); },
  relayCache: {},
  notesStore: { FLD260703: { timeline: FLD_TIMELINE, issueSummary: FLD_ISSUE } },
  fleetRows: fldFleetRows,
  names: FLD_NAMES,
  newIds: ['FLD300010'], returnedId: 'FLD300003',
};

// 322283 shape (user's timeline, 64 days down): same-day duplicates, ASIST /
// SF / case numbers, a tow ref, a dealer-name hedge with two labels for one
// shop, one email-format line. Seeded with a $ amount (10/20), a name header
// (11/10) and a "per <Name> email" attribution (11/13) for the strip checks.
const U322283_NAMES = ['Christy Adriaansen', 'Santiago'];
const U322283_TIMELINE = [
  '09/16 - Work order created with Volvo (ASIST) for Uptake-flagged exhaust catalyst efficiency concern and elevated fault code activity. Tow coordination initiated with FAS.',
  '09/18 - Tow arranged (amz-kzcqubb6kx3dcf). Unit transported to initial dealer location; initial dealer confirmed not certified for CNG work. Unit subsequently rerouted.',
  '09/22 - Unit relocated to alternate shop. Work order not yet created at new vendor location; diagnostic start blocked.',
  '09/30 - Confirmed unit on-site at new location; however, work order had not been created, blocking diagnostic start. Internal escalation submitted to open ASIST case.',
  '10/06 - Internal escalation submitted requesting work order be opened against ASIST case 21268757 and diagnostics scheduled. 20 days down with no diagnostic start at that point.',
  '10/12 - ASIST case created (service request 1000278). B service added to repair order. Pending shop acceptance.',
  '10/14 - Additional ASIST service request 1000784 created. Salesforce case 00034097 created. Return tow restriction active: DO NOT set up FLEETNET return tow without FAS/AFP confirmation.',
  '10/14 - Unit at CNG-capable shop (new location). Two ASIST cases opened: 1000278 (10/12) and 1000784 (10/14). B added to repair order. Pending shop acceptance of new cases and diagnostic start. 27+ days down with no diagnostic start to date. Next: Chase new CNG-capable shop via ASIST cases 1000278 and 1000784 to confirm case acceptance, technician assignment, and diagnostic scheduling for exhaust catalyst/O2 sensor fault and PM-B service.',
  '10/15 - Unit checked in at dealer (ASIST case 21365790) for CEL with catalyst faults. Diagnostics initiated.',
  "10/15 - Unit 322283 is at a CNG-capable Bergey's location with two new ASIST cases open (1000278 created 10/12, 1000784 created 10/14) and PM-B added to the repair order. Neither case has been accepted by the shop yet and no diagnostic start has been confirmed. 29 days down with zero diagnostic work completed to date. Next: Chase the CNG-capable Bergey's location via ASIST cases 1000278 and 1000784 to confirm case acceptance and obtain a confirmed diagnostic start date.",
  '10/17 - Per ASIST case 21365790 update 10/16, unit confirmed in shop undergoing diagnostics. Case in Triage status. No findings, estimate, or ETR provided yet.',
  '10/20 - Dealer submitted estimate V1 ($4,210.30) for internal review. Pending approval.',
  '10/20 - Estimate V1 rejected. Core charge present (Rule 68 conflict); body damage scope requires photo review for ARC determination (Rule 43/Rule 84) before approval.',
  '10/21 - Estimate V2 approved. Scope: four batteries replaced (all failed load test), B service and spark plugs (ISX12N CNG), accelerator pedal replacement (dead spot on PTT), hood replacement and paint (prior body damage repair failing). ARC confirmed. ISX12N CNG task force tag applied.',
  '10/26 - Follow-up submitted to dealer for repair status update. No new findings provided.',
  '10/28 - Estimate V3 approved. Added scope: transmission diagnostics and R/I/R authorization (non-final, teardown pending). B, catalyst/O2, and hood scope carried from V2. ISX12N CNG tag.',
  '11/03 - Dealer confirmed unit dispatched to transmission specialist for further diagnostics.',
  '11/04 - Estimate V4 approved. Added scope: MTM and air dryer parts authorized (labor V5 pending). Transmission R/I/R, B CNG, batteries, hood, and accelerator pedal carried from prior estimates. MTM water contamination via air dryer failure confirmed as root cause pattern. Active warranty noted; vendor queried on transmission/MTM warranty coverage. final estimate.',
  '11/07 - 11/09 - Internal follow-ups submitted requesting update on water intrusion findings and transmission repair status. Pending dealer response.',
  '11/10 - Christy Adriaansen - Bergeys Truck Centers Pennsauken (Service Advisor) confirmed transmission repairs and other approved mechanical repairs still in progress; follow-up scheduled.',
  '11/11 - Dealer reiterated transmission repairs in progress; committed to providing update as soon as available. No ETR provided.',
  '11/13 - ETR requested from dealer; no response received (per Z Santiago email 11/13).',
  '11/16 - Dealer (sources disagree on dealer name: Pennsauken per ASIST 10/15 entry vs. MV Contract Maintenance per Decisiv 11/6 entry [F8]) confirmed transmission repairs complete. B service and new driver alert speaker fault being finalized. Body repairs and final quality control inspection to follow. up set for 11/18.',
  '11/16 - Phone contact with service department confirmed technician completing repairs and uploading signed PM-B form.',
  '11/16 Vendor: Vendor finishing PM-B service and new driver-side driver alert speaker fault (per Bergeys Truck Centers Pennsauk email 11/16) [em:90b10be8]',
  '11/18 - ETR request submitted via ASIST; no ETR provided by dealer.',
  '11/18 - Road test failed for new CEL fault. Dealer confirmed diagnosis of new fault underway. Body repairs and final QC not yet completed. No ETR provided. 64 days down.',
].join('\n');
function u322283Units() {
  const base = { op: 'TUZR', site: 'PNK1', bodyType: 'Day Cab', model: 'VOLVO', atsState: 'Available' };
  return [
    { ...base, id: '322283', atsState: 'Unavailable', relayStatus: 'Offsite Shop Repair', duration: '64d 3h 0m',
      vendor: 'Volvo', dealerName: "Bergey's Truck Centers - Pennsauken", altId: 'amz-kzcqubb6kx3dcf',
      savedSalesforceCase: '00034097', issueSummary: 'CEL with exhaust catalyst efficiency faults' },
    { ...base, id: '322284' },
    { ...base, id: '322285' },
  ];
}
const u322283 = {
  operator: 'TUZR', domicile: 'PNK1', slot: 'PM', scopeKey: 'TUZR_PNK1_PM',
  get units() { return u322283Units(); },
  relayCache: {},
  notesStore: { '322283': { timeline: U322283_TIMELINE } },
  fleetRows: () => [],
  names: U322283_NAMES,
  newIds: [], returnedId: '',
};

module.exports = { auvte, mixed, fld, u322283, seedBaseline, fmtDate, shortDate, monthYear, UUID, UUID2, LONG_ISSUE, FLD_TIMELINE, FLD_ISSUE, U322283_TIMELINE, U322283_NAMES };
