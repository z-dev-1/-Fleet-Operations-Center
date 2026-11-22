'use strict';
/**
 * src/dtna/constants.js — DTNA Service Tracker (Salesforce Experience Cloud, Aura) constants. Pure, no requires.
 *
 * Every DTNA network call is user-initiated (a click behind it); nothing here schedules anything.
 */

const HOST = 'dtna.my.site.com';
const BASE = 'https://dtna.my.site.com/Servicetracker';
const AURA_PATH = '/Servicetracker/s/sfsites/aura';
const AURA_URL = BASE + '/s/sfsites/aura';
// Shared with the Split View webview and the vendor auto-login map (src/orcha/auto-login.js VENDOR_PARTITIONS).
const PARTITION = 'persist:vendor-dtna';
// The Cases list page: it loads the list view and issues getItems.
const LIST_URL = BASE + '/s/case/Case/Default';
const DEFAULT_LIST_FILTER = '00B6T000007X74uUAC';

const CASE_ID_RE = /^500[A-Za-z0-9]{15}$/;
const COMMENT_ID_RE = /^[A-Za-z0-9]{15,18}$/;
const DTNA_CASE_URL_RE = /https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/([A-Za-z0-9]+)/i;

// The case stage stepper on the portal's case page, in order (user-confirmed 2026-11-21). The portal marks
// finished stages 'Stage Complete' and the active one 'Current Stage' (e.g. 'Closed - Current Stage').
const CASE_STAGES = Object.freeze(['Pre-Repair', 'Arrived', 'In-Repair', 'Post-Repair', 'Ready for Pickup', 'Closed']);
const _STAGE_MATCH = [
  [5, /^closed\b/i],
  [4, /^ready\s*for\s*pick\s*-?\s*up\b/i],
  [3, /^post[-\s]?repair\b/i],
  [2, /^in[-\s]?repair\b/i],
  [1, /^arrived\b/i],
  [0, /^pre[-\s]?repair\b/i],
];
/** caseStageOf(text) -> { name, index } on CASE_STAGES | null. Accepts 'Closed - Current Stage', 'In Repair', ... */
function caseStageOf(text) {
  const s = String(text == null ? '' : text).replace(/\s*[-\u2013\u2014:]\s*(current stage|stage complete)\s*$/i, '').trim();
  for (const [i, re] of _STAGE_MATCH) if (re.test(s)) return { name: CASE_STAGES[i], index: i };
  return null;
}
/** stageIndex(name) -> exact index of name in CASE_STAGES, or -1. */
function stageIndex(name) { return typeof name === 'string' ? CASE_STAGES.indexOf(name) : -1; }
/** isForwardStage(from, to) -> true only when both are pipeline names and to is later than from. */
function isForwardStage(from, to) {
  const a = stageIndex(from);
  const b = stageIndex(to);
  return a >= 0 && b >= 0 && b > a;
}

/** caseUrl(id) -> canonical case detail URL (matches DTNA_CASE_RE in src/scrapers/dtna_enrich.js). */
function caseUrl(id) { return BASE + '/s/case/' + id + '/detail'; }

// Same hosts as vendor_session._LOGIN_HOSTS_RE (DTNA / Daimler B2C / Azure AD sign-in).
const LOGIN_HOST_RE = /(ciam\.daimlertruck\.com|ciam\.dtna\.com|login\.dtna\.com|login\.microsoftonline|b2clogin\.com)/i;

// The only Apex methods aura.callApex accepts (reads). params = exact param key list.
const READ_METHODS = Object.freeze({
  getCaseRecord: Object.freeze({ params: Object.freeze(['caseId']) }),
  getRepairOrderId: Object.freeze({ params: Object.freeze(['caseId']) }),
  getCommentsByCaseRepairOrder: Object.freeze({ params: Object.freeze(['caseId']) }),
  getComment: Object.freeze({ params: Object.freeze(['commentId']) }),
});

// Default Apex class per read method. A class the page itself is seen calling (capture.classFor) wins.
// dtna-probe 2026-11-21: first three seen in the page's own aura calls, getComment from the bundle only.
const APEX_CLASS = Object.freeze({
  getCaseRecord: 'E2E_CaseDetailsLWCController',
  getRepairOrderId: 'E2E_CaseDetailsLWCController',
  getCommentsByCaseRepairOrder: 'E2E_UTP_CommentController',
  getComment: 'E2E_UTP_CommentController',
});

const WRITE_RE = /^(post|save|update|create|delete|insert|upsert|submit|send|set|change|close|reopen|assign|approve|reject)/i;

const CONTEXT_MAX_AGE_MS = 30 * 60e3;
const HIDDEN_WAIT_MS = 45e3;
const SIGNIN_WINDOW_MS = 10 * 60e3;
const CALL_TIMEOUT_MS = 20e3;
const CONCURRENCY = 3;
const BATCH_GAP_MS = 250;
const THREAD_MAX = 20000;
const OFFSITE_TEXT_MAX = 8000;
const COMMENT_MAX = 1500;

// Ordered candidate keys on the getCaseRecord value (dotted = nested).
// dtna-probe 2026-11-21 (D1): unit 122269 at E2E_AssetAccountParticipant__r.E2E_Unit_Id__c, serial NP6923 at
// E2E_AssetAccountParticipant__r.Asset.SerialNumber, status at Status (also Category_Status__c, E2E_Repair_Status__c),
// dealer = E2E_Repair_Location__r.Name (Account.Name is the customer fleet). No dealer code, VIN, CaseNumber or
// steps array on the record; the stage path is only in the page DOM. Older candidates kept as fallbacks.
const CASE_FIELDS = Object.freeze({
  unitId: Object.freeze(['E2E_AssetAccountParticipant__r.E2E_Unit_Id__c', 'Unit_Id__c', 'UnitId__c', 'Unit_ID__c', 'E2E_Unit_Id__c', 'Unit_Number__c', 'UnitNumber__c', 'unitId', 'UnitId']),
  serial: Object.freeze(['E2E_AssetAccountParticipant__r.Asset.SerialNumber', 'Serial_Number__c', 'SerialNumber__c', 'Serial_No__c', 'E2E_Serial_Number__c', 'serialNumber', 'SerialNumber']),
  vin: Object.freeze(['VIN__c', 'Vin__c', 'E2E_VIN__c', 'VIN', 'vin']),
  caseNumber: Object.freeze(['CaseNumber', 'caseNumber']),
  caseStatus: Object.freeze(['Status', 'status', 'E2E_Status__c', 'caseStatus']),
  dealerCode: Object.freeze(['Dealer_Code__c', 'DealerCode__c', 'E2E_Dealer_Code__c', 'dealerCode', 'Account.Dealer_Code__c']),
  dealerName: Object.freeze(['E2E_Repair_Location__r.Name', 'Dealer_Name__c', 'DealerName__c', 'E2E_Dealer_Name__c', 'dealerName', 'Account.Name']),
  steps: Object.freeze(['steps', 'Steps', 'caseSteps', 'statusSteps', 'milestones']),
});

// dtna-probe 2026-11-21: D2/D4 found no estimate amount on 2026-11-21 (D4 source 'none'; no money-looking
// field on getCaseRecord, getRepairOrderId or getCommentsByCaseRepairOrder; the bundle exposes no estimate/EA
// read method). Phase B ships DTNA Total = '—' with status from case (CASE_FIELDS.caseStatus).
const ESTIMATE_FIELDS = null;
// learned 2026-11-21 via the read-only post probe (dtna-post-probe, case ...4U5AAK; no comment posted).
// Source: the portal's own composer, LWC c:e2E_CaseComments handleCommentSubmit (the "Post" button) calls
//   E2E_UTP_CommentController.postComment({ caseId: recordId, userInput: <textarea>, userName: <User.Name>, files: fileArray })
// and treats returnValue === 201 as sent; anything else is "Message not sent to Repair Facility".
// No repairOrderId and no comment-type key (the portal labels new comments 'Services Tracker Comment').
// userName 'AFP FAS' is the shared site user's name (user-confirmed). files: [] = text only; attachments
// are a fast-follow (lightning-file-upload -> ContentVersion -> files[] entries
// { name, documentId, contentVersionId, AttachmentId: contentVersionId + '_internal', FileName }, names <= 50 chars).
// STATE: params discovered from the portal composer, NOT yet verified by a live round-trip post. The user
// declined a test post; the first real user-approved comment in production is the live validation.
// Shape (src/dtna/writes.js buildPostParams resolves the '$' placeholders): params values are
// '$caseId' | '$repairOrderId' | '$text' | literal string|boolean|null | [] (empty array); successValue?: the
// returnValue that means sent (anything else fails with DTNA_POST_REJECTED). Set to null to disable posting
// (then the post-comment IPC returns DTNA_POST_NOT_CONFIGURED with no approval prompt and no network).
const POST_COMMENT_PARAMS = Object.freeze({
  classname: 'E2E_UTP_CommentController',
  method: 'postComment',
  params: Object.freeze({ caseId: '$caseId', userInput: '$text', userName: 'AFP FAS', files: Object.freeze([]) }),
  successValue: 201,
});
// The only Apex write aura.callWrite accepts (behind a single-use write-gate approval token).
const WRITE_METHODS = Object.freeze({
  postComment: Object.freeze({ classname: 'E2E_UTP_CommentController' }),
  changeStatus: Object.freeze({ classname: 'E2E_CaseDetailsLWCController' }),
});
// The composer has no maxlength (P2); the app caps a posted comment at the write gate's COMMENT_MAX.
const POST_COMMENT_MAX = 2000;
// Change DTNA Stage (Phase C, 2026-11-21): E2E_CaseDetailsLWCController.changeStatus, forward-only.
// Configured from portal code; not yet verified by a live write. Learned 2026-11-21 via the read-only
// stage probe (FLEET_DEV_DTNA_PROBE_MODE=stage): the c:e2E_RecordPath component's handleClick calls
// changeStatus({ caseId: this.recordId, status: this.currentValue }) and then reads e.Status from the
// returned Case (no success code is checked, so no successValue). statusValues are the portal stepper's
// step labels; the case record's Status field reads 'Closed' on the 'Closed - Current Stage' step.
// Set to null to disable: the change-stage IPC then returns DTNA_STAGE_NOT_CONFIGURED (no prompt, no network).
// Shape (src/dtna/writes.js buildStageParams resolves the '$' placeholders):
//   { classname: 'E2E_CaseDetailsLWCController', method: 'changeStatus',
//     params: { <key>: '$caseId' | '$status' | '$fromStatus' | literal string|boolean|null },
//     statusValues: { '<CASE_STAGES name>': '<portal status value>' },
//     successValue?: number|string }
const STAGE_CHANGE_PARAMS = Object.freeze({
  classname: 'E2E_CaseDetailsLWCController',
  method: 'changeStatus',
  params: Object.freeze({ caseId: '$caseId', status: '$status' }),
  statusValues: Object.freeze({
    'Pre-Repair': 'Pre-Repair', Arrived: 'Arrived', 'In-Repair': 'In-Repair',
    'Post-Repair': 'Post-Repair', 'Ready for Pickup': 'Ready for Pickup', Closed: 'Closed',
  }),
});

// Session timer: cookie-only servlet returning { sp: period secs, sr: remaining secs } behind 'while(1);'.
const SESSION_TIME_URL = BASE + '/_nc_external/system/security/session/SessionTimeServlet';
const SESSION_TIME_TIMEOUT_MS = 10e3;
// Pre-flight before a write / bulk pull: below this many seconds left, ask the user to sign in again first.
const SESSION_PREFLIGHT_MIN_SEC = 120;

module.exports = {
  HOST, BASE, AURA_PATH, AURA_URL, PARTITION, LIST_URL, DEFAULT_LIST_FILTER,
  CASE_ID_RE, COMMENT_ID_RE, DTNA_CASE_URL_RE, caseUrl, LOGIN_HOST_RE,
  READ_METHODS, APEX_CLASS, WRITE_RE,
  CONTEXT_MAX_AGE_MS, HIDDEN_WAIT_MS, SIGNIN_WINDOW_MS, CALL_TIMEOUT_MS, CONCURRENCY, BATCH_GAP_MS,
  THREAD_MAX, OFFSITE_TEXT_MAX, COMMENT_MAX, CASE_FIELDS, ESTIMATE_FIELDS, POST_COMMENT_PARAMS,
  WRITE_METHODS, POST_COMMENT_MAX, CASE_STAGES, caseStageOf, stageIndex, isForwardStage, STAGE_CHANGE_PARAMS,
  SESSION_TIME_URL, SESSION_TIME_TIMEOUT_MS, SESSION_PREFLIGHT_MIN_SEC,
};
