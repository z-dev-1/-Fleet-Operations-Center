'use strict';
/**
 * src/dtna/constants.js — DTNA Service Tracker (Salesforce Experience Cloud, Aura) constants. Pure, no requires.
 *
 * DTNA network calls come from a user action (a click behind it), from the normal sync pass
 * (src/dtna/auto.js) or from the gated background sign-in (src/dtna/auto-auth.js); nothing here schedules anything.
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
// The Cases list page's own getItems action (user-captured from the live portal 2026-11-23, values only,
// no tokens). Used only when no live template was captured; the live one always wins. Offset paging.
const LIST_ACTION_DESCRIPTOR = 'serviceComponent://ui.force.components.controllers.lists.listViewDataManager.ListViewDataManagerController/ACTION$getItems';
const LIST_ACTION_QUERY = '?r=1&ui-force-components-controllers-lists-listViewDataManager.ListViewDataManager.getItems=1';
const LIST_ACTION_PARAMS = Object.freeze({
  filterName: DEFAULT_LIST_FILTER, entityName: 'Case', pageSize: 50, layoutType: 'LIST',
  sortBy: null, getCount: false, enableRowActions: false, offset: 0,
});

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
  // Comment attachment content (base64), 2026-11-23 chatter-files probe; see ATTACHMENT_DOWNLOAD.
  getAttachment: Object.freeze({ params: Object.freeze(['caseId', 'attId']) }),
  getFilesOnCase: Object.freeze({ params: Object.freeze(['recordId']) }),
});

// Default Apex class per read method. A class the page itself is seen calling (capture.classFor) wins.
// dtna-probe 2026-11-21: first three seen in the page's own aura calls, getComment from the bundle only.
const APEX_CLASS = Object.freeze({
  getCaseRecord: 'E2E_CaseDetailsLWCController',
  getRepairOrderId: 'E2E_CaseDetailsLWCController',
  getCommentsByCaseRepairOrder: 'E2E_UTP_CommentController',
  getComment: 'E2E_UTP_CommentController',
  getAttachment: 'E2E_UTP_CommentController',
  getFilesOnCase: 'E2E_UTP_CommentController',
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

// The human case number (e.g. 15667050) is the standard Case.CaseNumber field, which getCaseRecord does not
// return. The portal reads Case fields with this RecordUi action (dtna-post-probe 2026-11-22 pageDescriptors:
// params { recordId, fields, optionalFields }); the value is at returnValue.fields.CaseNumber.value.
// STATE: value not yet live-verified (case 15667050 = 500gx000002E4U5AAK).
const CASE_NUMBER_READ = Object.freeze({ descriptor: 'aura://RecordUiController/ACTION$getRecordWithFields', field: 'Case.CaseNumber' });

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
// STATE: configured from portal code, NOT verified by a live write. The user declined a live test stage
// change (the probe case is already Closed); the first real user-approved forward stage change is the
// live validation. Learned 2026-11-21 via the read-only
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

// ── Chatter (case feed) ─────────────────────────────────────────────────────
// The case feed's own config read. Learned 2026-11-23 via the read-only chatter-files probe (cases
// ...GUsIAM and ...1RBAA0): the portal's case page sends this action itself with the single param subjectId
// (the case id); its returnValue.isChatterEnabled is a boolean (true on both cases). A read; it only runs
// when Chatter posting is configured (dtna:channels checks isChatterConfigured first), which it is not.
// Shape: { descriptor: 'aura://...|serviceComponent://.../ACTION$getModel', query: '?r=1&...',
//          params: { <key>: '$caseId' | literal string|number|boolean|null }, enabledKey: 'isChatterEnabled' }
const CHATTER_FEED_READ = Object.freeze({
  descriptor: 'serviceComponent://ui.communities.components.aura.components.forceCommunity.controller.ForceCommunityFeedController/ACTION$getModel',
  query: '?r=1&ui-communities-components-aura-components-forceCommunity-controller.ForceCommunityFeed.getModel=1',
  params: Object.freeze({ subjectId: '$caseId' }),
  enabledKey: 'isChatterEnabled',
});
// Post to the case Chatter feed. STATE: NOT CONFIGURED (deliberately), 2026-11-23 chatter-files probe.
// The portal case page renders no new-post composer for the site user (feed DOM: no textarea / rich-text
// editor, only "Latest Posts" / "Filter Feed"), and the portal bundles carry no top-level post action
// (no createFeedItem / postFeedElement / publisher post; 152 feed-family actions scanned). The only
// post-like action is forceChatter CommentInputController/ACTION$comment { feedItemId, commentInput,
// feedType, communityId }: a REPLY under an existing feed item, not a new case post, and its commentInput
// body shape was not observed. No Chatter method is faked: posting returns DTNA_CHATTER_NOT_CONFIGURED (no
// approval prompt, no network) and the "Post to DTNA" modal auto-selects the case comment (postComment).
// Connect REST / ui-api are blocked for the portal user (findings §8), so REST is NOT a supported transport.
// Shape (src/dtna/writes.js buildChatterParams resolves the '$' placeholders):
//   { transport: 'aura', descriptor, query, params, success? }
//   | { transport: 'apex', classname: 'E2E_...', method, params, success? }
//   params: JSON template (nested objects/arrays allowed, depth <= 6); a string value of exactly '$caseId'
//   or '$text' is substituted, any other '$...' string is refused. success?: { value } (the returnValue
//   that means posted) | { idPath } (dotted path to the new FeedItem id 0D5...).
const CHATTER_POST_PARAMS = null;

// ── Case attachments (estimate PDFs) ────────────────────────────────────────
// How to list a case's files. Learned 2026-11-23 via the read-only chatter-files probe (case ...1RBAA0,
// case number 15730628): External Communication files hang off the getCommentsByCaseRepairOrder rows
// (the same read the pull already makes, so listing costs zero extra requests): row.Attachments =
// [{ FileSize:number, FileName:string, ContentVersionId:null, CaseId:null, AttachmentId:string }], with
// row.HasAttachment true; the row's LastUpdatedDate dates its files. 4 files / 3 PDFs on 2 rows, all
// AttachmentIds external (UTP ids, not Salesforce 068/069). Chatter feed files: none found on the two probed
// cases (feed getModel carried no file capability), so no Chatter file source is configured yet.
// Shape: { source: 'apex', classname: 'E2E_...', method: 'get...', params: { <key>: '$caseId' }, listPath?,
//          fields: { versionId, documentId?, attId?, name, ext?, size?, createdAt? } }
//      | { source: 'comments', field: 'Attachments', listPath?, rowCreatedAt?, fields: { ... } }
const ATTACHMENT_LIST_READ = Object.freeze({
  source: 'comments',
  field: 'Attachments',
  rowCreatedAt: 'LastUpdatedDate',
  fields: Object.freeze({ attId: 'AttachmentId', name: 'FileName', size: 'FileSize' }),
});
// How to download one file through the authenticated persist:vendor-dtna session. Learned 2026-11-23 from
// the portal's own c:e2E_CaseComments handleAttachmentClick and exercised live (one read, case ...1RBAA0:
// base64 string returned, decoded bytes start with %PDF-, <1MB, pdfjs text read OK):
//   AttachmentId '<068 ContentVersion id>_internal' -> getFilesOnCase({ recordId: <068 id> })   (base64)
//   any other AttachmentId                         -> getAttachment({ caseId, attId: AttachmentId }) (base64)
// Both are E2E_UTP_CommentController reads through the normal aura transport (no new auth, no servlet).
// Shape: { source: 'apex', encoding: 'base64', internal: { method }, external: { method } }
//      | { urlTemplate }  ('{versionId}' / '{documentId}' placeholder; host must be HOST)
const ATTACHMENT_DOWNLOAD = Object.freeze({
  source: 'apex',
  encoding: 'base64',
  internal: Object.freeze({ method: 'getFilesOnCase' }),
  external: Object.freeze({ method: 'getAttachment' }),
});
// A UTP comment attachment id as the portal hands it to getAttachment / getFilesOnCase (opaque, no spaces).
const ATTACHMENT_ID_RE = /^[A-Za-z0-9][\w.\-]{2,119}$/;
const ATTACHMENT_MAX_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_MAX_PER_PULL = 4;
const ATTACHMENT_KEEP_TEXT = 4;
const ATTACHMENT_LIST_MAX = 50;
const ATTACHMENT_TEXT_MAX = 8000;
const ATTACHMENT_REFRESH_MS = 7 * 24 * 3600e3;
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30e3;
const ESTIMATE_CONTEXT_MAX = 3000;
const ESTIMATE_LINE_ITEMS_MAX = 40;
// Bumped when parseEstimateText changes: a cached 'read' PDF parsed by an older rule is re-extracted once.
// 2 (2026-11-23 live loop): totals / line items parsed from the full text before the 8000-char clip, and a
// line item may end with up to 2 short word columns after its amount (the live dealer layout).
const ESTIMATE_PARSE_VERSION = 2;
const CHATTER_POST_MAX = POST_COMMENT_MAX;
const CONTENT_VERSION_ID_RE = /^068[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const CONTENT_DOC_ID_RE = /^069[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;
const FEED_ITEM_ID_RE = /^0D5[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

// Session timer: cookie-only servlet returning { sp: period secs, sr: remaining secs } behind 'while(1);'.
const SESSION_TIME_URL = BASE + '/_nc_external/system/security/session/SessionTimeServlet';
const SESSION_TIME_TIMEOUT_MS = 10e3;
// Pre-flight before a write / bulk pull: below this many seconds left, ask the user to sign in again first.
const SESSION_PREFLIGHT_MIN_SEC = 120;

// Background sign-in (Phase E, src/dtna/auto-auth.js + session.backgroundLogin): a hidden window with the
// stored-credential auto-login, at startup, on expiry and on a sync auth failure. Rate limited by
// src/utils/auth-retry-gate.js: at most one attempt per BG_MIN_GAP_MS, BG_FAIL_COOLDOWN_MS after a
// timeout, BG_ACTION_COOLDOWN_MS once a step needs the user (MFA / terms / no stored credentials).
const BG_LOGIN_WAIT_MS = 90e3;
const BG_STARTUP_DELAY_MS = 10e3;
const BG_MIN_GAP_MS = 2 * 60e3;
const BG_FAIL_COOLDOWN_MS = 5 * 60e3;
const BG_ACTION_COOLDOWN_MS = 30 * 60e3;
const BG_EXPIRY_SLACK_MS = 60e3;
const BG_EXPIRY_MAX_MS = 9 * 3600e3;

module.exports = {
  HOST, BASE, AURA_PATH, AURA_URL, PARTITION, LIST_URL, DEFAULT_LIST_FILTER,
  LIST_ACTION_DESCRIPTOR, LIST_ACTION_QUERY, LIST_ACTION_PARAMS,
  CASE_ID_RE, COMMENT_ID_RE, DTNA_CASE_URL_RE, caseUrl, LOGIN_HOST_RE,
  READ_METHODS, APEX_CLASS, WRITE_RE,
  CONTEXT_MAX_AGE_MS, HIDDEN_WAIT_MS, SIGNIN_WINDOW_MS, CALL_TIMEOUT_MS, CONCURRENCY, BATCH_GAP_MS,
  THREAD_MAX, OFFSITE_TEXT_MAX, COMMENT_MAX, CASE_FIELDS, CASE_NUMBER_READ, ESTIMATE_FIELDS, POST_COMMENT_PARAMS,
  WRITE_METHODS, POST_COMMENT_MAX, CASE_STAGES, caseStageOf, stageIndex, isForwardStage, STAGE_CHANGE_PARAMS,
  SESSION_TIME_URL, SESSION_TIME_TIMEOUT_MS, SESSION_PREFLIGHT_MIN_SEC,
  BG_LOGIN_WAIT_MS, BG_STARTUP_DELAY_MS, BG_MIN_GAP_MS, BG_FAIL_COOLDOWN_MS, BG_ACTION_COOLDOWN_MS,
  BG_EXPIRY_SLACK_MS, BG_EXPIRY_MAX_MS,
  CHATTER_FEED_READ, CHATTER_POST_PARAMS, CHATTER_POST_MAX, FEED_ITEM_ID_RE,
  ATTACHMENT_LIST_READ, ATTACHMENT_DOWNLOAD, ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_PULL, ATTACHMENT_KEEP_TEXT,
  ATTACHMENT_LIST_MAX, ATTACHMENT_TEXT_MAX, ATTACHMENT_REFRESH_MS, ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
  ESTIMATE_CONTEXT_MAX, ESTIMATE_LINE_ITEMS_MAX, ESTIMATE_PARSE_VERSION, CONTENT_VERSION_ID_RE, CONTENT_DOC_ID_RE, ATTACHMENT_ID_RE,
};
