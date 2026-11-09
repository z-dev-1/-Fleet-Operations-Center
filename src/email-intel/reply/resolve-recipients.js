'use strict';
/**
 * email-intel/reply/resolve-recipients.js — authoritative reply recipients from the Outlook REST API
 * (apiTransport + threadReplies; main process only).
 *
 *   resolveReplyRecipients({ conversationKey, mode:'reply'|'reply-all' }, { now, deps })
 *     -> { ok:true, mode, source:'api'|'stored', basedOnMessageKey, recipients:{ to, cc, external, blocked },
 *          replyAllAvailable, sendable }
 *      | { ok:false, code:'NOT_FOUND' }
 *      | { ok:false, code:'RECIPIENTS_UNRESOLVED', reason:'not-found'|'no-ids'|'blocked-auth'|'unavailable'|'store',
 *          sendable:false, recipients:{ to:[], cc:[], external:null, blocked:'RECIPIENTS_UNRESOLVED' }, replyAllAvailable:false }
 *
 * Reply target: reply/target.replyTarget (the same record the send path uses). Lookup, first hit wins:
 *   (a) an API record's REST id; (b) on 404, its InternetMessageId (exactly one match); (c) the conversation
 *   (apiConversationId, else the stored real convIdRaw) -> its newest non-draft member.
 * A body-less header GET (endpoints.messageRecipients) is read first. A message already in the ledger gets its
 * From / To / CC refreshed in place (ledger.refreshRecipients); a message not in the ledger yet (legacy DOM-era
 * conversation) is read in full and ingested through the normal buildRecord + upsert path, so the send validator
 * sees exactly the recipients shown. Nothing is ever guessed: no hit -> RECIPIENTS_UNRESOLVED with empty lists.
 * Transient failures (timeout, network, throttle, HTTP errors, no token) keep the stored recipients of an API record
 * that already has them (source:'stored'; apiReply re-verifies Outlook's draft recipients before any send), otherwise
 * unresolved 'unavailable'. A sign-in wall is always unresolved. Read-only GETs; never throws. Logs enums and counts only.
 */
const stores = require('../stores');
const ledger = require('../ingest/ledger');
const identity = require('../ingest/identity');
const cfgMod = require('../config');
const { errName } = require('../redact');
const { computeRecipients } = require('./recipients');
const { replyTarget } = require('./target');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const ORDERBY_CODES = new Set(['InefficientFilter', 'ErrorInvalidProperty']);
const UNRESOLVED_REASONS = Object.freeze(['not-found', 'no-ids', 'blocked-auth', 'unavailable', 'store']);

function _apiOn() {
  try { return require('../flags').apiTransport() === true; } catch (_) { return false; }
}
function _conv(ck) {
  return ledger.conversation(ledger.ensureDoc(stores.load('messages')), ck);
}
const _str = (v) => (typeof v === 'string' && v ? v : '');

function _unresolved(reason) {
  return {
    ok: false, code: 'RECIPIENTS_UNRESOLVED', reason, sendable: false,
    recipients: { to: [], cc: [], external: null, blocked: 'RECIPIENTS_UNRESOLVED' }, replyAllAvailable: false,
  };
}

function _shape(latest, mode, me, source) {
  const rec = computeRecipients(latest, mode, me, { selfOnlyFallback: true });
  const all = computeRecipients(latest, 'reply-all', me, { selfOnlyFallback: true });
  return {
    ok: true, mode, source, basedOnMessageKey: latest.messageKey,
    recipients: { to: rec.to, cc: rec.cc, external: rec.external, blocked: rec.blocked || null },
    replyAllAvailable: !all.blocked,
    sendable: !rec.blocked && latest.source === 'api' && !!latest.itemId,
  };
}

/** A transient API failure: the stored recipients of an API record that has them, else unresolved. */
function _transient(target, mode, me) {
  if (target && target.source === 'api' && target.itemId && target.recipientsKnown === true) return _shape(target, mode, me, 'stored');
  return _unresolved('unavailable');
}

function _log(r) {
  const src = r.ok ? r.source : 'none';
  const res = r.ok ? 'ok' : (r.reason || r.code);
  const to = r.recipients ? r.recipients.to.length : 0;
  const cc = r.recipients ? r.recipients.cc.length : 0;
  logger.info('[email-intel] reply recipients source=' + src + ' result=' + res + ' to=' + to + ' cc=' + cc);
  return r;
}

const _validItem = (it) => !!it && typeof it.Id === 'string' && !!it.Id && typeof it.ConversationId === 'string' && !!it.ConversationId
  && Number.isFinite(Date.parse(it.ReceivedDateTime)) && it.IsDraft !== true;
const _values = (r) => (r && r.json && Array.isArray(r.json.value) ? r.json.value : []);

/** -> { id, json? (headers already read) }, null (ids tried, nothing found) or 'no-ids' (nothing to look up with). */
async function _lookup(target, get, T) {
  const { endpoints, map, E } = T;
  const is404 = (e) => e instanceof E.ApiHttpError && e.status === 404;
  let tried = false;
  if (target.source === 'api' && _str(target.itemId)) {
    tried = true;
    try { return { id: target.itemId, json: (await get(endpoints.messageRecipients(target.itemId))).json }; } catch (e) { if (!is404(e)) throw e; }
  }
  if (_str(target.internetMessageId)) {
    tried = true;
    const hits = _values(await get(endpoints.byInternetMessageId(target.internetMessageId))).filter((x) => x && _str(x.Id));
    if (hits.length === 1) return { id: hits[0].Id };
  }
  const cid = _str(target.apiConversationId) || (target.convIdSource !== 'derived' ? map.restConvId(_str(target.convIdRaw)) : '');
  if (cid) {
    tried = true;
    let members;
    try { members = _values(await get(endpoints.conversation(cid, true))); } catch (e) {
      if (e instanceof E.ApiHttpError && e.status === 400 && ORDERBY_CODES.has(e.apiCode)) members = _values(await get(endpoints.conversation(cid, false)));
      else if (is404(e)) members = [];
      else throw e;
    }
    const newest = members.filter(_validItem).sort((a, b) => (Date.parse(b.ReceivedDateTime) - Date.parse(a.ReceivedDateTime)) || String(a.Id).localeCompare(String(b.Id)))[0];
    if (newest) return { id: newest.Id };
  }
  return tried ? null : 'no-ids';
}

async function _full(get, id, T) {
  try { return { json: (await get(T.endpoints.message(id))).json, preview: false }; } catch (e) {
    if (!(e instanceof T.E.ResponseTooLargeError)) throw e;
    return { json: (await get(T.endpoints.messageLite(id))).json, preview: true };
  }
}

/** Legacy mirror (best effort): Reply All on the card follows what the API now knows. */
function _mirrorLegacy(conversationKey, latest, replyAllKnown) {
  try {
    const store = require('../../store');
    const results = store.load('emailTriageResults', null);
    const emails = results && Array.isArray(results.emails) ? results.emails : [];
    let idx = emails.findIndex((e) => e && e.intel && e.intel.conversationKey === conversationKey);
    if (idx === -1) idx = emails.findIndex((e) => e && e.id === latest.legacyId);
    if (idx === -1 || !emails[idx].intel || emails[idx].intel.recipientsKnown === replyAllKnown) return;
    emails[idx] = Object.assign({}, emails[idx], { intel: Object.assign({}, emails[idx].intel, { recipientsKnown: replyAllKnown }) });
    store.save('emailTriageResults', results);
  } catch (_) { /* legacy mirror only */ }
}

async function resolveReplyRecipients(input, opts) {
  const i = input || {};
  const o = opts || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ck = i.conversationKey;
  const mode = i.mode === 'reply-all' ? 'reply-all' : 'reply';
  let records;
  try { records = _conv(ck); } catch (_) { records = []; }
  if (!records.length) return { ok: false, code: 'NOT_FOUND' };
  const cfg = cfgMod.normalize(stores.load('config'));
  const me = cfg.me || {};
  const target = replyTarget(records, true);
  if (!_apiOn()) return _shape(target, mode, me, 'stored');                    // guard: callers only use this under apiTransport

  let T; let deps;
  try {
    T = { endpoints: require('../transport/endpoints'), map: require('../transport/map'), E: require('../transport/errors') };
    deps = o.deps || require('../transport').deps();
  } catch (e) { logger.warn('[email-intel] reply recipients transport unavailable ' + errName(e)); return _log(_transient(target, mode, me)); }
  const get = (path) => deps.http.get(path, { op: 'get' });
  const labelOf = (id) => { try { return deps.folders && deps.folders.labelOf ? deps.folders.labelOf(id) : null; } catch (_) { return null; } };

  let cap;
  try {
    const hit = await _lookup(target, get, T);
    if (hit === 'no-ids') return _log(_unresolved('no-ids'));
    if (!hit) return _log(_unresolved('not-found'));
    const id = hit.id;
    let fetched = { json: hit.json || (await get(T.endpoints.messageRecipients(id))).json, preview: false };
    const head = T.map.toCapture(fetched.json, { folderLabel: target.folder || 'Inbox', labelOf, isLatest: true });
    if (!head || (fetched.json && fetched.json.IsDraft === true)) return _log(_unresolved('not-found'));
    const known = !!identity.findMessage(ledger.ensureDoc(stores.load('messages')), identity.itemKey(head.keySeed));
    if (known) cap = head;
    else {
      fetched = await _full(get, id, T);
      cap = T.map.toCapture(fetched.json, { folderLabel: target.folder || 'Inbox', labelOf, isLatest: true, preview: fetched.preview });
      if (!cap) return _log(_unresolved('not-found'));
    }
  } catch (e) {
    if (T.E && e instanceof T.E.ApiAuthBlockedError) return _log(_unresolved('blocked-auth'));
    if (T.E && e instanceof T.E.RequestRefusedError) return _log(_unresolved('no-ids'));
    if (!(T.E && e instanceof T.E.ApiError)) logger.warn('[email-intel] reply recipients failed ' + errName(e));
    return _log(_transient(target, mode, me));
  }

  let u;
  try {
    u = stores.update('messages', (doc) => {
      ledger.ensureDoc(doc);
      const res = ledger.buildRecord(cap, doc, { me, banners: cfg.banners, now, scanId: 'reply-resolve', lookbackDays: cfg.caps.lookbackDays });
      if (!res) return doc;
      if (res.created) ledger.upsert(doc, res.record);
      else ledger.refreshRecipients(doc, res.record.messageKey, cap, me, now);
      return doc;
    });
  } catch (e) { logger.warn('[email-intel] reply recipients store failed ' + errName(e)); u = { ok: false }; }
  if (!u || !u.ok) return _log(_unresolved('store'));

  const after = replyTarget(_conv(ck), true);
  if (!after || after.source !== 'api' || !after.itemId) return _log(_unresolved('not-found'));
  const out = _shape(after, mode, me, 'api');
  _mirrorLegacy(ck, after, computeRecipients(after, 'reply-all', me, { selfOnlyFallback: true }).blocked !== 'RECIPIENTS_UNKNOWN');
  return _log(out);
}

module.exports = { resolveReplyRecipients, UNRESOLVED_REASONS };
