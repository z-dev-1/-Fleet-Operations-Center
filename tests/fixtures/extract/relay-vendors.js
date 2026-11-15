// tests/fixtures/extract/relay-vendors.js — Relay serviceaggregate fixtures for the
// Relay-native vendors (design §20.1): 322355 Amerit (+ history), 59080 Amerit (3 labor
// lines), B12195 COX (+ history), IND260261 TA, B12258 KWNE, 321185 CEI, 321062 Amerit
// inspection, B13014 DSP, 892568 PETE. Shapes from shape-probe/*.serviceaggregate.json
// and *.service_history.json; wording from findings §(a)/(b); names, aliases and phones
// are masked.
const c = (timestamp, createdBy, text, internalOnly = false) => ({ timestamp, createdBy, text, internalOnly, externalConsumers: [] });
const wr = (id, comments, extra = {}) => Object.assign({
  id, createdBy: 'fasuser1', createdDateTime: Date.parse('2026-11-01T12:00:00Z'),
  needByDateTime: Date.parse('2026-11-12T12:00:00Z'), alternateUniqueId: 'amz-' + id.toLowerCase().replace(/[^a-z0-9]/g, '') + 'altid0000',
  salesforceCaseId: null, caseNumber: null, comments,
}, extra);

// ── 322355 Amerit in-yard ────────────────────────────────────────────────────
export const relay322355 = {
  id: 'svc-322355',
  vendorModifiedTimestamp: '2026-11-11T12:40:00Z',
  workRequest: wr('wr-322355', []),
  workOrders: [{
    id: 'wo-322355', vendorWorkOrderIds: ['891-00011598'], reasonCodes: ['SOURCING_PARTS'],
    expectedCompletionDateTime: '2026-11-11T19:36:00Z', vendorModifiedTimestamp: '2026-11-11T12:40:00Z',
    estimate: null, lineItems: [],
    comments: [
      c('2026-11-10T14:00:00Z', 'Amerit', 'Cause Of Repair: MECHANICAL Cause: DEAD BATTERIES WOULD NOT START IN YARD Correction: UNIT WOULD NOT START. TESTED BATTERIES, BATTERIES NEED TO BE REPLACED. ETC Delay Reason-SOURCING_PARTS'),
      c('2026-11-10T16:00:00Z', 'Amerit', 'air fitting on order eta 11/11 RO# 891-00011598'),
    ],
  }],
  workOrderLineItems: [],
};
export const history322355 = [
  { serviceEntityId: 'wo-322355', eventDateTime: '2026-11-10T13:00:00Z', requester: 'Amerit', operation: 'EDIT',
    serviceChangeDetails: [{ field: 'Expected completion date time', oldValue: null, newValue: '2026-11-11T07:36:00Z', displayType: 'DATE_TIME' }] },
  { serviceEntityId: 'wo-322355', eventDateTime: '2026-11-11T12:40:00Z', requester: 'Amerit', operation: 'EDIT',
    serviceChangeDetails: [{ field: 'Expected completion date time', oldValue: '2026-11-11T07:36:00Z', newValue: '2026-11-11T19:36:00Z', displayType: 'DATE_TIME' }] },
];

// ── 59080 Amerit, three labor lines in one vendor comment ───────────────────
export const relay59080 = {
  id: 'svc-59080',
  workRequest: wr('wr-59080', []),
  workOrders: [{
    id: 'wo-59080', vendorWorkOrderIds: ['891-00012001'], reasonCodes: [], lineItems: [],
    comments: [
      c('2026-11-05T15:00:00Z', 'Amerit',
        'Cause Of Repair: MECHANICAL Cause: DEAD BATTERIES WOULD NOT START IN YARD Correction: UNIT WOULD NOT START. BATTERIES NEED TO BE REPLACED. '
        + 'Cause Of Repair: ELECTRICAL Cause: LEFT MARKER LAMP INOP Correction: REPLACED LEFT MARKER LAMP AND TESTED OK. '
        + 'Cause Of Repair: TIRES Cause: RIGHT FRONT TIRE WORN BELOW SPEC Correction: REPLACED RIGHT FRONT TIRE.'),
    ],
  }],
};

// ── B12195 COX ──────────────────────────────────────────────────────────────
export const relayB12195 = {
  id: 'svc-B12195',
  workRequest: wr('wr-B12195', []),
  workOrders: [{
    id: 'wo-B12195', vendorWorkOrderIds: ['03398831'], reasonCodes: [],
    expectedCompletionDateTime: '2026-11-10T07:13:00Z', vendorModifiedTimestamp: '2026-11-09T20:00:00Z',
    lineItems: [{ id: 'li-1', description: 'LABOR - ROADSIDE', failureCause: '', workAccomplished: '', partNumber: null, quantity: 1 }],
    comments: [
      c('2026-11-08T15:00:00Z', 'COX', 'RO#206910652 Labor Line 1: COMPLAINT: UNIT WILL NOT START CAUSE: FAILED STARTER MOTOR CORRECTION: REPLACED STARTER MOTOR Labor Line 2: COMPLAINT: AIR LEAK CAUSE: CRACKED AIR LINE AT FITTING CORRECTION: REPLACED AIR LINE AND FITTING'),
      c('2026-11-09T15:00:00Z', 'COX', 'Service appointment updated to Cannot Complete (CC). Selected Reason: CC - Parts Ordered. Technician Notes: waiting on starter, no eta'),
    ],
  }],
  workOrderLineItems: [{ id: 'li-1', description: 'LABOR - ROADSIDE', failureCause: '', workAccomplished: '', partNumber: null, quantity: 1 }],
};
export const historyB12195 = [
  ['2026-11-07T15:00:00Z', null, '2026-11-09T22:00:00Z'],
  ['2026-11-08T10:00:00Z', '2026-11-09T22:00:00Z', '2026-11-09T04:08:00Z'],
  ['2026-11-09T09:00:00Z', '2026-11-09T04:08:00Z', '2026-11-10T07:13:00Z'],
  ['2026-11-09T20:00:00Z', '2026-11-10T07:13:00Z', '2026-11-10T07:13:00Z'],
].map(([eventDateTime, oldValue, newValue]) => ({
  serviceEntityId: 'wo-B12195', eventDateTime, requester: 'COX', operation: 'EDIT',
  serviceChangeDetails: [{ field: 'Expected completion date time', oldValue, newValue, displayType: 'DATE_TIME' }],
}));

// ── IND260261 TA (accident), TA-stripped punctuation ─────────────────────────
export const relayIND260261 = {
  id: 'svc-IND260261',
  workRequest: wr('wr-IND260261', [
    c('2026-10-31T14:00:00Z', 'fasuser3', 'Estimate rejection reason: Line item cost above expected\n\nDetails: $28,984.94 Rejected, parts price is excessive, please review'),
    c('2026-11-02T14:00:00Z', 'fasuser3', 'Estimate rejection reason: Question/Concern\n\nDetails: Temp Reject $28,984.94 Estimate submitted still reflects as $28,984.94 not $24,715.13'),
    c('2026-11-04T14:00:00Z', 'fasuser3', 'Estimate rejection reason: Question/Concern\n\nDetails: Temp reject  $24,804.13. This is still not showing $24,715.13'),
    c('2026-11-05T14:00:00Z', 'fasuser3', 'Approved  $24,804.13'),
  ]),
  workOrders: [{
    id: 'wo-IND260261', vendorWorkOrderIds: ['TA-77120'], reasonCodes: [],
    expectedCompletionDateTime: '2026-10-30T15:22:57.828240781Z', vendorModifiedTimestamp: '2026-11-07T20:08:58.939934533Z',
    estimate: { state: 'APPROVED', totalCost: 24804.13, estimateUpdatedAt: null, estimateApprovalReason: null },
    lineItems: [{ id: 'l1', description: '3PP ESTIMATE AMOUNT' }, { id: 'l2', description: 'LABOR - ROADSIDE' }, { id: 'l3', description: 'Placeholder - Details to Follow' }],
    comments: [
      c('2026-10-28T13:00:00Z', 'TA', 'ETA  10 29 2026 2 30 PM  EDT   ETC  11 07 2026 12 05 PM  EST'),
      c('2026-10-30T13:00:00Z', 'TA', 'estimate submitted to 501  $28 895 94 for approval'),
      c('2026-11-01T13:00:00Z', 'TA', 'international 4125033C96 price is $6,784.49  headlight 4049968C99 price is $1,775.49  side fairing international 6121796C1'),
      c('2026-11-03T13:00:00Z', 'TA', 'Revised estimate uploaded  parts pricing corrected  $24 715 13'),
      c('2026-11-04T16:00:00Z', 'TA', 'revised estimate for $24, 804.13 uploaded'),
      c('2026-11-06T13:00:00Z', 'TA', 'PARTS ARE ON ORDER   EXPECTED UPDATE FROM SUPPLIER 11 10 26'),
      c('2026-11-07T13:00:00Z', 'TA', 'VIN  3HSDZAPR1VN265324   071  BODY   REASON FOR REPAIR  001  BREAKDOWN'),
      c('2026-11-10T13:00:00Z', 'TA', 'eta for parts will be in on friday 11 13 26    waiting on hood    possible etc 11 20 26'),
    ],
  }],
  workOrderLineItems: [{ id: 'l1', description: '3PP ESTIMATE AMOUNT' }],
};

// ── B12258 KWNE ─────────────────────────────────────────────────────────────
export const relayB12258 = {
  id: 'svc-B12258',
  workRequest: wr('wr-B12258', [
    c('2026-11-02T16:00:00Z', 'fasuser4', 'reject $ 1,720.52 please upload estimate with line detail'),
    c('2026-11-03T16:00:00Z', 'fasuser4', 'Approved V1 $509.65. CEL diagnostic -- harness repin identified as root cause. V2 expected'),
    c('2026-11-02T13:00:00Z', 'KWNE', 'still waiting on correct pins for harness- hoping for them to be here by thurs'),
  ]),
  workOrders: [],
};

// ── 321185 CEI (accident) ───────────────────────────────────────────────────
export const relay321185 = {
  id: 'svc-321185',
  workRequest: wr('wr-321185', [
    c('2026-10-19T15:00:00Z', 'fasuser5', 'Created Accident SaleForce Case # 00034983 per claim Confirm Vehicle in Shop for Estimate @ Push & Pull Autobody'),
    c('2026-10-20T15:00:00Z', 'CEI', 'CNG parts expected to take 2-3 weeks to ship'),
    c('2026-10-21T15:00:00Z', 'CEI', 'ETC is early next week 10/27'),
  ]),
  workOrders: [],
};

// ── 321062 Amerit inspection (lat/long in text) ─────────────────────────────
export const relay321062 = {
  id: 'svc-321062',
  workRequest: wr('wr-321062', []),
  workOrders: [{
    id: 'wo-321062', vendorWorkOrderIds: ['891-00011134'], reasonCodes: [], lineItems: [],
    comments: [c('2026-09-10T15:00:00Z', 'Amerit', 'Current unit ETC is the 16th of Sept vendor site verified RO# 891-00011134 has been created unit loc # 40.62664, -75.44557')],
  }],
};

// ── B13014 DSP ──────────────────────────────────────────────────────────────
export const relayB13014 = {
  id: 'svc-B13014',
  workRequest: wr('wr-B13014', [
    c('2026-11-01T15:00:00Z', 'fasuser6', 'RG: https://relay.example/wr/B13014 / Vendor: TBD by Carrier / ETC: N/A / FAS: Pat Fas / Dom: AUVTE01'),
    c('2026-11-02T15:00:00Z', 'fasuser6', 'Fleetnet per 00176990|amz-dr67qazvrtau54'),
    c('2026-11-03T15:00:00Z', 'fasuser6', 'FNA ticket amz-7cvf6f2rds7r3w. Unit has been in accident status for 31 days. Carrier contact = Acme Carrier Sam Lee | 555-010-3333'),
    c('2026-11-04T15:00:00Z', 'fasuser6', 'Dealer opened case 12345 for the body shop'),
  ]),
  workOrders: [],
};

// ── 892568 PETE ─────────────────────────────────────────────────────────────
export const relay892568 = {
  id: 'svc-892568',
  workRequest: wr('wr-892568', [
    c('2026-11-03T15:00:00Z', 'fasuser7', 'Primary Vendor Rejection Reason: work is out of scope (Amerit). || Vendor: THE PETE STORE - SEAFORD'),
    c('2026-11-04T15:00:00Z', 'PETE_STORE', 'Tech ETA 11/12, ETC 11/14'),
  ]),
  workOrders: [],
};

// ── Scrape-era comment with the legacy UTC timestamp form ───────────────────
export const legacyTs = { timestamp: '11/03/2026 14:05:09', createdBy: 'fasuser1', text: 'ETC 11/07' };
