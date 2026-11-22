// tests/fixtures/dtna/aura-responses.js — DTNA Service Tracker Apex values and Aura envelopes for tests.
// Case 500gx000002E4U5AAK: unit 122269, serial NP6923, RO R101048154, comments from AFP FAS, a dealer
// and the API User. Case 500gx000003ZOQoAAO: no repair order, closed.

export const CASE_ID = '500gx000002E4U5AAK';
export const NO_RO_CASE_ID = '500gx000003ZOQoAAO';
export const RO_ID = 'a0Xgx0000012345AAA';

export const CASE_RECORD = {
  Id: CASE_ID,
  CaseNumber: '05123456',
  Status: 'In Repair',
  Unit_Id__c: '122269',
  Serial_Number__c: 'NP6923',
  VIN__c: '3AKJHHDR1NSNP6923',
  Dealer_Code__c: 'HF041',
  Dealer_Name__c: 'HORWITH FREIGHTLINER',
  steps: [
    { name: 'Arrived', status: 'Complete', at: '2026-09-22T13:00:00.000Z' },
    { name: 'In Repair', status: 'Current', at: '2026-09-23T14:00:00.000Z' },
  ],
};

export const NO_RO_RECORD = {
  Id: NO_RO_CASE_ID,
  CaseNumber: '05123999',
  Status: 'Closed',
  Unit_Id__c: '133001',
  Serial_Number__c: 'PK1111',
  Dealer_Name__c: 'VELOCITY TRUCK CENTERS',
};

export const RO_LIST = [{ Id: RO_ID, Name: 'R101048154' }];

export const COMMENTS = [
  {
    CommentId: 'a1Agx0000000001AAA', CommentType: 'Status Update', FromName: 'API User',
    CommentText: 'Serial No: NP6923 (Unit Id: 122269) has entered HORWITH FREIGHTLINER in NORTHAMPTON, PA at 09/22/2026 9:00 AM EDT',
    CreatedDate: '2026-09-22T13:05:00.000Z',
  },
  {
    CommentId: 'a1Agx0000000002AAA', CommentType: 'Estimate', FromName: 'HORWITH FREIGHTLINER',
    CommentText: '<p>Estimate sent &amp; pending approval</p><br>Total parts listed',
    CreatedDate: '2026-09-24T10:56:00.000Z', RepairOrderNo: 'R101048154', EstimateNo: 'E-77881',
  },
  {
    CommentId: 'a1Agx0000000003AAA', CommentType: 'General', FromName: 'AFP FAS',
    CommentText: 'Please send an ETA for unit 122269',
    CreatedDate: '2026-09-24T12:30:00.000Z',
  },
];

export const NO_RO_COMMENTS = [
  {
    CommentId: 'a1Agx0000000009AAA', CommentType: 'Ready for Pick Up', FromName: 'VELOCITY TRUCK CENTERS',
    CommentText: 'Unit ready', CreatedDate: '2026-09-20T15:00:00.000Z',
  },
];

/** success(value) -> Aura envelope text for an Apex SUCCESS (wrapped like ApexActionController). */
export function success(value, o = {}) {
  const rv = o.raw ? value : { returnValue: value, cacheable: false };
  return JSON.stringify({ actions: [{ id: '1;a', state: 'SUCCESS', returnValue: rv, error: [] }], context: { fwuid: 'x' } });
}

export function apexError(exceptionType = 'System.QueryException', message = 'List has no rows') {
  return JSON.stringify({ actions: [{ id: '1;a', state: 'ERROR', returnValue: null, error: [{ exceptionType, message, stackTrace: 'Class.X' }] }] });
}

export function invalidSession() {
  return '*/{"event":{"descriptor":"markup://aura:invalidSession","attributes":{"values":{"newToken":null}}},"exceptionEvent":true}/*ERROR*/';
}

export function outOfSync() {
  return '*/{"event":{"descriptor":"markup://aura:clientOutOfSync","attributes":{}},"exceptionEvent":true}/*ERROR*/';
}

/** res(status, body, {location, type}) -> a fetch Response-like object. */
export function res(status, body = '', o = {}) {
  return {
    status,
    type: o.type || 'basic',
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? (o.location || null) : null) },
    text: async () => body,
  };
}

/** getItemsAction(params) -> a captured list action (selectableListDataProvider getItems). */
export function getItemsAction(params = {}) {
  return {
    id: '12;a',
    descriptor: 'serviceComponent://ui.force.components.controllers.lists.selectableListDataProvider.SelectableListDataProviderController/ACTION$getItems',
    callingDescriptor: 'UNKNOWN',
    params: Object.assign({ entityNameOrId: 'Case', layoutType: 'LIST', pageSize: 25, currentPage: 0, getCount: true, filterName: '00B6T000007X74uUAC' }, params),
  };
}

/** listResult(ids, numbers?) -> getItems returnValue shape (records with Id + fields); numbers[id] = CaseNumber. */
export function listResult(ids, numbers) {
  const n = numbers || {};
  return {
    result: ids.map((id) => ({ record: { Id: id, CaseNumber: 'x', fields: n[id] ? { Id: { value: id }, CaseNumber: { value: n[id] } } : { Id: { value: id } } } })),
    totalCount: ids.length,
  };
}

// Phase D: the human case number of CASE_ID (RecordUi getRecordWithFields, fields ['Case.CaseNumber']).
export const CASE_NUMBER = '15667050';
export const CASE_NUMBER_RECORD = { apiName: 'Case', id: CASE_ID, fields: { CaseNumber: { value: CASE_NUMBER, displayValue: null } } };
