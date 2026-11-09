'use strict';
/**
 * email-intel/transport/endpoints.js — the ONLY file that holds the REST host and path strings (design 4.2, 14).
 *
 *   API_HOST                      the mailbox host every request goes to
 *   builders                      path + query for each allowed call (ids encoded, OData strings escaped)
 *   assertAllowed(method, path)   method/path allow-list, called by http.request for every request
 *   odataString(s)                OData string literal ('' doubling, quoted)
 *   authSourceRank(url)           3 | 2 | 1 | 0: how good a page request is as a bearer source
 *   rebaseNextLink(link, re)      @odata.nextLink -> a request path on API_HOST, or null (stop paging)
 *
 * R4-L8: GET paths match case-insensitively and may carry an OData key segment (MailFolders('id')/...),
 * the shapes Exchange uses in @odata.nextLink. POST, PATCH and DELETE stay strict.
 */
const { TC } = require('./constants');
const { RequestRefusedError } = require('./errors');

const API_HOST = 'outlook.cloud.microsoft';
const BASE = '/api/v2.0/me';

const SELECT_LIST = 'Id,ConversationId,InternetMessageId,ReceivedDateTime,IsDraft';
const SELECT_FULL = 'Id,ConversationId,InternetMessageId,ReceivedDateTime,Subject,From,ToRecipients,CcRecipients,HasAttachments,IsRead,IsDraft,ParentFolderId,Body';
const SELECT_LITE = 'Id,ConversationId,InternetMessageId,ReceivedDateTime,Subject,From,ToRecipients,CcRecipients,HasAttachments,IsRead,IsDraft,ParentFolderId,BodyPreview';
const SELECT_DRAFT = 'Subject,ToRecipients,CcRecipients,Body,InternetMessageId,ConversationId';
const WELL_KNOWN = Object.freeze(['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'archive']);
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HISTORIC = '1900-01-01T00:00:00Z';

const GET_RE = /^\/api\/v2\.0\/me\/(mailfolders|messages)(\('[^'/?]{1,512}'\))?(\/|\?|$)/i;
const POST_RES = [/^\/api\/v2\.0\/me\/sendmail$/, /^\/api\/v2\.0\/me\/messages\/[^/?]+\/(createreply|createreplyall|send|move)$/];
const DRAFT_RE = /^\/api\/v2\.0\/me\/messages\/[^/?]+$/;

const enc = (s) => encodeURIComponent(String(s));
function _id(id, max) {
  if (typeof id !== 'string' || !id || id.length > (max || TC.ITEM_ID_MAX)) throw new RequestRefusedError('bad-id');
  return enc(id);
}
function _ts(iso) {
  if (typeof iso !== 'string' || !TS_RE.test(iso)) throw new RequestRefusedError('bad-timestamp');
  return iso;
}
function _top(n, allowed) {
  if (!Number.isInteger(n) || n < 1 || n > 100 || (allowed && !allowed.includes(n))) throw new RequestRefusedError('bad-top');
  return String(n);
}
/** OData string literal: single quotes doubled, then wrapped in quotes. */
function odataString(s) {
  if (typeof s !== 'string') throw new RequestRefusedError('bad-string');
  return "'" + s.replace(/'/g, "''") + "'";
}
function _q(pairs) {
  return '?' + pairs.filter((p) => p[1] != null).map((p) => p[0] + '=' + enc(p[1])).join('&');
}

// ── builders ────────────────────────────────────────────────────────────────
const folders = () => BASE + '/mailfolders' + _q([['$top', '100'], ['$select', 'Id,DisplayName,ChildFolderCount']]);
const childFolders = (id) => BASE + '/mailfolders/' + _id(id) + '/childfolders' + _q([['$top', '100'], ['$select', 'Id,DisplayName,ChildFolderCount']]);
function wellKnown(name) {
  if (!WELL_KNOWN.includes(name)) throw new RequestRefusedError('bad-folder');
  return BASE + '/mailfolders/' + name + _q([['$select', 'Id,DisplayName']]);
}
const listSeed = (fid, top) => BASE + '/mailfolders/' + _id(fid) + '/messages'
  + _q([['$top', _top(top)], ['$orderby', 'ReceivedDateTime desc'], ['$select', SELECT_LIST]]);
const listForward = (fid, wm, orderby) => BASE + '/mailfolders/' + _id(fid) + '/messages'
  + _q([['$filter', 'ReceivedDateTime ge ' + _ts(wm)], ['$orderby', orderby ? 'ReceivedDateTime asc' : null], ['$top', String(TC.PAGE_TOP)], ['$select', SELECT_LIST]]);
const listBackfill = (fid, horizon, before, orderby) => BASE + '/mailfolders/' + _id(fid) + '/messages'
  + _q([['$filter', 'ReceivedDateTime ge ' + _ts(horizon) + ' and ReceivedDateTime lt ' + _ts(before)], ['$orderby', orderby ? 'ReceivedDateTime desc' : null], ['$top', String(TC.PAGE_TOP)], ['$select', SELECT_LIST]]);
function conversation(convId, ordered) {
  const c = odataString(convId);
  if (ordered) {
    return BASE + '/messages' + _q([['$filter', 'ReceivedDateTime ge ' + HISTORIC + ' and ConversationId eq ' + c], ['$orderby', 'ReceivedDateTime desc'],
      ['$top', String(TC.CONTEXT_MAX + 1)], ['$select', SELECT_LIST + ',ParentFolderId']]);
  }
  return BASE + '/messages' + _q([['$filter', 'ConversationId eq ' + c], ['$top', String(TC.CONVERSATION_TOP)], ['$select', SELECT_LIST + ',ParentFolderId']]);
}
const folderConversation = (fid, convId) => BASE + '/mailfolders/' + _id(fid) + '/messages'
  + _q([['$filter', 'ConversationId eq ' + odataString(convId)], ['$top', String(TC.DELETE_CONV_MAX)], ['$select', 'Id']]);
const message = (id) => BASE + '/messages/' + _id(id) + _q([['$select', SELECT_FULL]]);
const messageLite = (id) => BASE + '/messages/' + _id(id) + _q([['$select', SELECT_LITE]]);
const byInternetMessageId = (imid) => BASE + '/messages' + _q([['$filter', 'InternetMessageId eq ' + odataString(imid)], ['$top', '5'], ['$select', 'Id,ParentFolderId']]);
const attachments = (id) => BASE + '/messages/' + _id(id) + '/attachments' + _q([['$select', 'Id,Name,ContentType,Size,IsInline']]);
const attachment = (id, attId) => BASE + '/messages/' + _id(id) + '/attachments/' + _id(attId, TC.ATT_ID_MAX);
const sentByInternetMessageId = (imid) => BASE + '/mailfolders/sentitems/messages'
  + _q([['$filter', 'InternetMessageId eq ' + odataString(imid)], ['$top', '5'], ['$select', 'Id,InternetMessageId,ConversationId']]);
const sentByConversation = (convId, top) => BASE + '/mailfolders/sentitems/messages'
  + _q([['$filter', 'ConversationId eq ' + odataString(convId)], ['$top', _top(top, [TC.SENT_TOP, TC.SENT_TOP_SMALL])], ['$select', 'Id,InternetMessageId,ConversationId,Body']]);
const sentBySubject = (subject, top) => BASE + '/mailfolders/sentitems/messages'
  + _q([['$filter', 'Subject eq ' + odataString(subject)], ['$top', _top(top, [TC.SENT_TOP, TC.SENT_TOP_SMALL])], ['$select', 'Id,InternetMessageId,ConversationId,Body']]);
const probe = () => BASE + '/mailfolders/inbox/messages' + _q([['$top', '1'], ['$select', 'Id']]);
const sendMail = () => BASE + '/sendmail';
const createReply = (id, all) => BASE + '/messages/' + _id(id) + (all ? '/createreplyall' : '/createreply');
/** draft(id) for PATCH / DELETE; draft(id, true) for the verification GET (with $select). */
const draft = (id, withSelect) => BASE + '/messages/' + _id(id) + (withSelect ? _q([['$select', SELECT_DRAFT]]) : '');
const sendDraft = (id) => BASE + '/messages/' + _id(id) + '/send';
const move = (id) => BASE + '/messages/' + _id(id) + '/move';

// ── allow-list ──────────────────────────────────────────────────────────────
function assertAllowed(method, path) {
  const m = String(method || '').toUpperCase();
  const p = typeof path === 'string' ? path : '';
  if (!p || p.length > 8192 || /[\s#\\]/.test(p) || /(^|\/)\.\.(\/|$)/.test(p)) throw new RequestRefusedError('bad-path');
  const pathOnly = p.split('?')[0];
  if (m === 'GET' && GET_RE.test(p)) return true;
  if (m === 'POST' && p === pathOnly && POST_RES.some((re) => re.test(p))) return true;
  if ((m === 'PATCH' || m === 'DELETE') && p === pathOnly && DRAFT_RE.test(p)) return true;
  throw new RequestRefusedError('not-allowed');
}

// ── bearer source ranking ───────────────────────────────────────────────────
function authSourceRank(urlString) {
  let u; try { u = new URL(String(urlString)); } catch (_) { return 0; }
  if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== API_HOST) return 0;
  if (u.pathname.startsWith('/api/v2.0/')) return 3;
  if (u.pathname.startsWith('/api/')) return 2;
  if (u.pathname.startsWith('/owa/')) return 1;
  return 0;
}

/** @odata.nextLink -> a request path (requested on API_HOST by http.request), or null. */
function rebaseNextLink(link, outlookHostRe) {
  let u; try { u = new URL(String(link)); } catch (_) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const m = outlookHostRe ? outlookHostRe.exec(host) : null;
  if (!m || m[0].toLowerCase() !== host) return null;
  const path = u.pathname + u.search;
  try { assertAllowed('GET', path); } catch (_) { return null; }
  return path;
}

module.exports = {
  API_HOST, BASE, SELECT_LIST, SELECT_FULL, SELECT_LITE, SELECT_DRAFT, WELL_KNOWN, TS_RE,
  folders, childFolders, wellKnown, listSeed, listForward, listBackfill, conversation, folderConversation, message, messageLite,
  byInternetMessageId, attachments, attachment, sentByInternetMessageId, sentByConversation, sentBySubject, probe,
  sendMail, createReply, draft, sendDraft, move,
  odataString, assertAllowed, authSourceRank, rebaseNextLink,
};
