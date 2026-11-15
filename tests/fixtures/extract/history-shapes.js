// tests/fixtures/extract/history-shapes.js — Relay change-history fixtures in the REAL
// serviceChangeLogs shape (shape-probe/*.service_history.json, aap_service_history_stats.all.json):
// { serviceEntityId (36-char), eventDateTime (ns ISO), requester, message, operation, status,
//   serviceChangeDetails: [{ field, description, oldValue, newValue, displayType }] }.
// Requester logins are masked ('fasuser*').
const WR_B = '68a47710-1b2c-4d3e-8f90-a1b2c3d4e5f6';
const WO_B = 'c97ca908-2c3d-4e5f-9a01-b2c3d4e5f6a7';
const WR_I = '5dbf0a12-3d4e-4f60-8b12-c3d4e5f6a7b8';
const WO_I = '4a8d2b86-4e5f-4071-9c23-d4e5f6a7b8c9';
const WR_V = '7e1f3c55-5f60-4182-8d34-e5f6a7b8c9d0';
const WR_T = '9b2e4d66-6071-4293-9e45-f6a7b8c9d0e1';
const WO_T = 'ab3f5e77-7182-43a4-8f56-a7b8c9d0e1f2';

const det = (field, oldValue, newValue, displayType = 'PLAIN_TEXT') => ({ field, description: field.toLowerCase(), oldValue, newValue, displayType });
const log = (serviceEntityId, eventDateTime, requester, operation, message, details) => ({
  serviceEntityId, eventDateTime, requester, message, operation, status: 'SUCCESS', serviceChangeDetails: details,
});

// ── B12195 COX: WR created by DVIR, assigned to COX, WO with ETC revisions ──
export const histB12195Full = [
  log(WR_B, '2026-11-07T20:54:59.851818361Z', 'DVIR', 'CREATE', 'Work request created', [
    det('State', null, 'CREATED', 'ENUM_TEXT'), det('Sub state', null, 'PENDING_REVIEW', 'ENUM_TEXT'),
    det('Vendor', null, 'UNASSIGNED'), det('Source', null, 'DVIR', 'ENUM_TEXT'), det('Category', null, 'UNPLANNED', 'ENUM_TEXT'),
    det('Is urgent', null, 'false', 'BOOLEAN'),
  ]),
  log(WR_B, '2026-11-07T20:55:07.624777696Z', 'RelayGarage-PendingAssignmentAutomation', 'EDIT', 'Work request edited', [
    det('Need by date time', null, '2026-11-09T20:54:59Z', 'DATE_TIME'), det('Sub state', 'PENDING_REVIEW', 'MANUAL_ASSIGNMENT', 'ENUM_TEXT'),
  ]),
  log(WR_B, '2026-11-07T20:58:12.112233445Z', 'fasuser1', 'ASSIGN_VENDOR', 'Work request vendor assigned', [
    det('Vendor', 'UNASSIGNED', 'COX'), det('Supplier', null, 'ROC5'), det('Vendor integration type', null, 'DIRECT', 'ENUM_TEXT'),
  ]),
  log(WR_B, '2026-11-07T21:01:40.998877665Z', 'COX', 'ACCEPT', 'Work request accepted by vendor', [
    det('Sub state', 'MANUAL_ASSIGNMENT', 'PENDING_VENDOR_RESPONSE', 'ENUM_TEXT'),
  ]),
  log(WO_B, '2026-11-07T21:02:05.443322110Z', 'COX', 'CREATE', 'Work order created', [
    det('State', null, 'WORK_ORDER_ASSIGNED', 'ENUM_TEXT'),
    det('Expected completion date time', null, '2026-11-09T22:00Z', 'DATE_TIME'),
  ]),
  log(WO_B, '2026-11-07T21:04:24.076918536Z', 'COX', 'EDIT', 'Work order edited', [
    det('Expected start date time', '2026-11-08T08:59Z', '2026-11-09T02:08Z', 'DATE_TIME'),
    det('Expected completion date time', '2026-11-09T22:00Z', '2026-11-09T04:08Z', 'DATE_TIME'),
  ]),
  log(WO_B, '2026-11-09T07:09:44.291643213Z', 'COX', 'EDIT', 'Work order edited', [
    det('Expected technician arrival date time', null, '2026-11-09T02:08:00Z', 'DATE_TIME'),
    det('Sub state', 'PENDING', 'TECHNICIAN_EN_ROUTE', 'ENUM_TEXT'),
  ]),
  log(WO_B, '2026-11-09T07:19:04.487226632Z', 'COX', 'EDIT', 'Work order edited', [
    det('Start date time', null, '2026-11-09T07:18:47Z', 'DATE_TIME'),
    det('Actual technician arrival date time', null, '2026-11-09T07:18:47Z', 'DATE_TIME'),
    det('State', 'WORK_ORDER_ASSIGNED', 'WORK_IN_PROGRESS', 'ENUM_TEXT'),
  ]),
  log(WO_B, '2026-11-09T12:28:25.417622381Z', 'COX', 'EDIT', 'Work order edited', [
    det('Expected completion date time', '2026-11-09T04:08Z', '2026-11-10T07:13Z', 'DATE_TIME'),
    det('Sub state', 'TECHNICIAN_EN_ROUTE', 'PARTS_ON_BACK_ORDER', 'ENUM_TEXT'),
    det('Reason codes', null, 'SOURCING_PARTS'),
  ]),
  // No-op ETC edit (same instant, different spelling).
  log(WO_B, '2026-11-10T09:00:00.000000000Z', 'COX', 'EDIT', 'Work order edited', [
    det('Expected completion date time', '2026-11-10T07:13Z', '2026-11-10T07:13:00Z', 'DATE_TIME'),
  ]),
  log(WO_B, '2026-11-11T12:51:36.043936532Z', 'COX', 'EDIT', 'Work order edited', [
    det('Asset location', '34 N MAIN ST TIOGA, Pennsylvania 16946', '36 N MAIN ST TIOGA, Pennsylvania 16946'),
  ]),
];

// ── IND260261 TA: estimate revisions, three rejections, one approval ─────────
export const histIND260261 = [
  log(WR_I, '2026-10-26T20:33:30.530281367Z', 'fasuser3', 'CREATE', 'Work request created', [
    det('State', null, 'CREATED', 'ENUM_TEXT'), det('Vendor', null, 'TA'), det('Category', null, 'UNPLANNED', 'ENUM_TEXT'),
  ]),
  log(WR_I, '2026-10-26T20:40:11.100000000Z', 'fasuser3', 'SUBMIT_TO_VENDOR', 'Work request submitted to vendor', [
    det('State', 'CREATED', 'SCHEDULED', 'ENUM_TEXT'),
  ]),
  log(WR_I, '2026-10-27T13:00:02.200000000Z', 'TA', 'ACCEPT', 'Work request accepted by vendor', [
    det('Vendor integration type', null, 'DIRECT', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-10-27T13:05:03.300000000Z', 'TA', 'CREATE', 'Work order created', [
    det('State', null, 'WORK_IN_PROGRESS', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-10-30T13:00:04.400000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('Estimate', null, '28895.94', 'COST'), det('State', 'WORK_IN_PROGRESS', 'ESTIMATE_PENDING_APPROVAL', 'ENUM_TEXT'),
    det('Line items', null, '3PP ESTIMATE AMOUNT', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-10-30T18:00:05.500000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('Estimate', '28895.94', '28984.94', 'COST'), det('Line items', 'LABOR', 'LABOR - ROADSIDE'),
  ]),
  log(WO_I, '2026-10-31T14:00:06.600000000Z', 'fasuser3', 'SUBMIT_DECISION', 'Work order decision submitted', [
    det('State', 'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED', 'ENUM_TEXT'),
    det('Estimate rejection reason', null, 'Line item cost above expected'),
  ]),
  log(WO_I, '2026-11-01T15:58:02.546849510Z', 'TA', 'EDIT', 'Work order edited', [
    det('Start date time', null, '2026-11-01T15:58:01.829572740Z', 'DATE_TIME'),
    det('State', 'ESTIMATE_REJECTED', 'ESTIMATE_PENDING_APPROVAL', 'ENUM_TEXT'),
    det('Line items', 'Placeholder', 'Placeholder - Details to Follow'),
  ]),
  log(WO_I, '2026-11-02T14:00:07.700000000Z', 'fasuser3', 'SUBMIT_DECISION', 'Work order decision submitted', [
    det('State', 'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED', 'ENUM_TEXT'),
    det('Estimate rejection reason', 'Line item cost above expected', 'Question/Concern'),
  ]),
  log(WO_I, '2026-11-03T13:00:08.800000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('Estimate', '28984.94', '24715.13', 'COST'), det('State', 'ESTIMATE_REJECTED', 'ESTIMATE_PENDING_APPROVAL', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-11-04T10:00:09.900000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('Estimate', '24715.13', '24804.13', 'COST'), det('Line items', '1', '2', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-11-04T14:00:10.100000000Z', 'fasuser3', 'SUBMIT_DECISION', 'Work order decision submitted', [
    det('State', 'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED', 'ENUM_TEXT'),
    det('Estimate rejection reason', 'Question/Concern', 'Question/Concern'),
  ]),
  log(WO_I, '2026-11-04T18:00:11.110000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('State', 'ESTIMATE_REJECTED', 'ESTIMATE_PENDING_APPROVAL', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-11-05T14:00:12.120000000Z', 'fasuser3', 'SUBMIT_DECISION', 'Work order decision submitted', [
    det('State', 'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_APPROVED', 'ENUM_TEXT'),
  ]),
  log(WO_I, '2026-11-05T15:00:13.130000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('State', 'ESTIMATE_APPROVED', 'WORK_IN_PROGRESS', 'ENUM_TEXT'), det('Line items', 'a', 'b'),
  ]),
];

// IND260261 without the 11/05 approval (still rejected): drop the last two logs.
export const histIND260261NoApproval = histIND260261.slice(0, histIND260261.length - 2);

// ── 39582 Decisiv / Volvo: a single CREATE (dealer-integrated) ──────────────
export const hist39582CreateOnly = [
  log(WR_V, '2026-09-23T18:04:31.124507921Z', 'fasuser2', 'CREATE', 'Work request created', [
    det('State', null, 'CREATED', 'ENUM_TEXT'), det('Sub state', null, 'PENDING_VENDOR_RESPONSE', 'ENUM_TEXT'),
    det('Vendor', null, 'VOLVO'), det('Source', null, 'MANUAL', 'ENUM_TEXT'), det('Category', null, 'UNPLANNED', 'ENUM_TEXT'),
    det('Vendor integration type', null, 'DECISIV', 'ENUM_TEXT'),
  ]),
];

// ── TA WR with estimate + state edits but no ETC field ──────────────────────
export const histTaNoEtc = [
  log(WR_T, '2026-11-02T12:00:00.100000000Z', 'fasuser4', 'CREATE', 'Work request created', [
    det('State', null, 'CREATED', 'ENUM_TEXT'), det('Vendor', null, 'TA'),
  ]),
  log(WO_T, '2026-11-02T15:00:00.200000000Z', 'TA', 'CREATE', 'Work order created', [
    det('State', null, 'WORK_IN_PROGRESS', 'ENUM_TEXT'),
  ]),
  log(WO_T, '2026-11-03T15:00:00.300000000Z', 'TA', 'EDIT', 'Work order edited', [
    det('Estimate', null, '1250.50', 'COST'), det('State', 'WORK_IN_PROGRESS', 'ESTIMATE_PENDING_APPROVAL', 'ENUM_TEXT'),
  ]),
];

// ── Malformed: nulls, missing details, a bad date, a detail without a field ─
export const histMalformed = [
  null,
  42,
  { serviceEntityId: WR_T, eventDateTime: 'not-a-date', requester: 'TA', operation: 'EDIT', message: 'Work order edited',
    serviceChangeDetails: [det('Expected completion date time', null, '2026-11-05T12:00:00Z', 'DATE_TIME')] },
  { serviceEntityId: WO_T, eventDateTime: '2026-11-03T15:00:00.300000000Z', requester: 'TA', operation: 'EDIT', message: 'Work order edited' },
  log(WO_T, '2026-11-04T15:00:00.000000000Z', 'TA', 'EDIT', 'Work order edited', [
    null, { description: 'no field', oldValue: 'a', newValue: 'b' },
    det('Expected completion date time', null, 'garbage', 'DATE_TIME'),
    det('Expected completion date time', null, '2026-11-06T12:00:00Z', 'DATE_TIME'),
    det('Estimate', null, 'NaN', 'COST'),
  ]),
];

// 100 synthetic ETC edits, each 1 h later than the last (cap test).
export function histManyEtc(n = 100) {
  const base = Date.parse('2026-11-01T00:00:00Z');
  const out = [];
  for (let i = 0; i < n; i++) {
    const oldV = i === 0 ? null : new Date(base + i * 3600000).toISOString();
    const newV = new Date(base + (i + 1) * 3600000).toISOString();
    out.push(log(WO_T, new Date(base + i * 60000).toISOString(), 'TA', 'EDIT', 'Work order edited',
      [det('Expected completion date time', oldV, newV, 'DATE_TIME')]));
  }
  return out;
}
