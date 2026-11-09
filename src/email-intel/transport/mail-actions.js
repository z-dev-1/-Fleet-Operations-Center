'use strict';
/**
 * email-intel/transport/mail-actions.js — the consequential Outlook REST calls (R7.5-listed; design 8.3, 8.4, 9).
 *
 *   apiReply(o)          reply / reply-all inside the real conversation: createreply(all) -> verify recipients ->
 *                        PATCH the body above the quote -> verify -> onRef -> beforeSend -> send -> Sent Items verify
 *   apiSendMail(o)       new message to the confirmed To only (SaveToSentItems) -> Sent Items verify
 *   apiMoveToDeleted(o)  moves the conversation's messages in one folder to Deleted Items
 *
 * Called only by executors.js after a single-use token and an accepted native dialog. Every function takes
 * `o.deps` ({ http, tokens, folders } from transport.deps()) and never creates its own http or token source.
 * PATCH / DELETE only touch drafts created in the same call (local draftIds set, I-7). Once beforeSend() has
 * persisted the attempt as `sending`, the final POST uses the cached token only and is never retried (I-5, I-6).
 * R4-M4: the recipient comparison is injected (o.compareSets, from reply/recipients via executors.js); this file
 * never requires reply/. Without it apiReply refuses before any request. Logs carry op enums and counts only.
 */
const C = require('../constants');
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const E = require('./errors');
const sentItems = require('./sent-items');
const { mapRecipients } = require('./map');
const { htmlToText } = require('../../justme-context/extract');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const fbs = (code) => ({ status: 'failed-before-send', detail: { code } });

function _preCode(e) {
  if (e instanceof E.ApiAuthBlockedError) return 'blocked-auth';
  if (e instanceof E.TokenUnavailableError) return 'TOKEN_UNAVAILABLE';
  if (e instanceof E.ThrottledError) return 'THROTTLED';
  if (e instanceof E.RequestRefusedError) return 'REFUSED';
  if (e instanceof E.AbortedError) return 'ABORTED';
  if (e instanceof E.ApiTimeoutError) return 'TIMEOUT';
  if (e instanceof E.ApiNetworkError) return 'NETWORK';
  if (e instanceof E.ResponseTooLargeError) return 'TOO_LARGE';
  if (e instanceof E.ApiHttpError) return 'HTTP_' + e.status;
  return 'EXCEPTION';
}
const _pre = (e) => { const c = _preCode(e); return c === 'blocked-auth' ? { status: 'blocked-auth', detail: {} } : fbs(c); };

/** Send pre-check (8.3 / 8.4 step 1): a token with at least SEND_TOKEN_FLOOR_MS left must be cached before `sending`. */
async function _preCheck(deps, now) {
  try {
    const a = await deps.tokens.getAuth({ minTtlMs: TC.SEND_MIN_TTL_MS });
    if (!a || !Number.isFinite(a.expMs) || a.expMs - now() < TC.SEND_TOKEN_FLOOR_MS) return fbs('TOKEN_SHORT');
    return null;
  } catch (e) {
    if (e instanceof E.ApiAuthBlockedError) return { status: 'blocked-auth', detail: {} };
    return fbs('TOKEN_UNAVAILABLE');
  }
}

/** Insert the reply above the quoted conversation: after the first <body...> tag, else at the start. */
function prepend(html, original) {
  const o = String(original || '');
  const m = /<body\b[^>]*>/i.exec(o);
  if (!m) return String(html) + o;
  const at = m.index + m[0].length;
  return o.slice(0, at) + String(html) + o.slice(at);
}
const proj = (h) => String(htmlToText(String(h || ''), C.RAW_BODY_CAP) || '').replace(/\s+/g, '').slice(-200);

function _tag(list, role) { return (list || []).map((e) => ({ name: (e && e.name) || '', address: (e && e.address) || null, role })); }
/** R4-M4: diff { to, cc } from the injected compareSets, plus the owa_reply.recipientDiff shape. */
function _recipientDiff(compareSets, expected, actual) {
  const to = compareSets((expected && expected.to) || [], (actual && actual.to) || []);
  const cc = compareSets((expected && expected.cc) || [], (actual && actual.cc) || []);
  return { to, cc, equal: !!(to.equal && cc.equal), missing: _tag(to.missing, 'to').concat(_tag(cc.missing, 'cc')), extra: _tag(to.extra, 'to').concat(_tag(cc.extra, 'cc')) };
}
const _draftRecipients = (d) => ({ to: mapRecipients(d && d.ToRecipients), cc: mapRecipients(d && d.CcRecipients) });

function _write(op, method, path, body, extra) {
  return Object.assign({ op, method, path, retry: 'write', timeoutMs: TC.POST_TIMEOUT_MS, maxBytes: TC.JSON_MAX_BYTES }, body !== undefined ? { body } : {}, extra || {});
}

async function apiReply(o) {
  const opts = o || {};
  if (typeof opts.compareSets !== 'function') return fbs('REFUSED');
  const deps = opts.deps || {};
  const http = deps.http;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const counts = { orphanDraftPossible: 0, draftLeft: 0 };
  const draftIds = new Set();
  const log = (status, code) => logger.info('[email-api] op=reply mode=' + (opts.mode === 'reply-all' ? 'reply-all' : 'reply') + ' status=' + status + (code ? ' code=' + code : '')
    + (counts.orphanDraftPossible ? ' orphanDraftPossible=' + counts.orphanDraftPossible : '') + (counts.draftLeft ? ' draftLeft=' + counts.draftLeft : ''));
  const done = (r) => { log(r.status, r.detail && r.detail.code); return r; };
  let sending = false;
  const delDraft = async (id) => {
    if (!draftIds.has(id)) return;
    // After `sending` the cleanup uses the cached token only: no token window opens once the attempt is persisted.
    try { await http.request(_write('delete-draft', 'DELETE', endpoints.draft(id), undefined, { noRetry: true, peekAuth: sending })); draftIds.delete(id); } catch (_) { counts.draftLeft++; }
  };

  const pc = await _preCheck(deps, now);
  if (pc) return done(pc);

  // 2. create the reply draft
  let created = null;
  const create = (id) => http.request(_write('create-reply', 'POST', endpoints.createReply(id, opts.mode === 'reply-all')));
  try {
    created = await create(opts.itemId);
  } catch (e) {
    if (e instanceof E.ApiHttpError && e.status === 404) {
      let alt = null;
      if (typeof opts.internetMessageId === 'string' && opts.internetMessageId) {
        try {
          const r = await http.get(endpoints.byInternetMessageId(opts.internetMessageId), { op: 'by-imid' });
          const v = r && r.json && Array.isArray(r.json.value) ? r.json.value.filter((x) => x && typeof x.Id === 'string' && x.Id) : [];
          if (v.length === 1) alt = v[0].Id;
        } catch (e2) { if (!(e2 instanceof E.ApiHttpError)) return done(_pre(e2)); }
      }
      if (!alt) return done({ status: 'mechanism-unavailable', detail: { code: 'ITEM_NOT_FOUND' } });
      try { created = await create(alt); } catch (e3) {
        if (e3 instanceof E.ApiHttpError && e3.status === 404) return done({ status: 'mechanism-unavailable', detail: { code: 'ITEM_NOT_FOUND' } });
        if (e3 instanceof E.ApiTimeoutError) counts.orphanDraftPossible++;
        return done(_pre(e3));
      }
    } else {
      if (e instanceof E.ApiTimeoutError) counts.orphanDraftPossible++;
      return done(_pre(e));
    }
  }
  const draftId = created && created.json && typeof created.json.Id === 'string' && created.json.Id.length <= TC.ITEM_ID_MAX ? created.json.Id : null;
  if (!draftId) return done(fbs('NO_DRAFT'));
  draftIds.add(draftId);

  // 3. recipient verification (To and CC separately)
  let d;
  try { d = (await http.get(endpoints.draft(draftId, true), { op: 'get' })).json || {}; } catch (e) { await delDraft(draftId); return done(_pre(e)); }
  const diff = _recipientDiff(opts.compareSets, opts.expected, _draftRecipients(d));
  if (!diff.equal) {
    await delDraft(draftId);
    return done({ status: 'recipient-mismatch', detail: { code: 'RECIPIENT_MISMATCH', diff: { missing: diff.missing, extra: diff.extra } } });
  }

  // 4. body above the quote, verified by text projection (Exchange rewrites HTML on PATCH)
  const original = d.Body && typeof d.Body.Content === 'string' ? d.Body.Content : '';
  try {
    await http.request(_write('patch-draft', 'PATCH', endpoints.draft(draftId), { Body: { ContentType: 'HTML', Content: prepend(opts.html, original) } }));
  } catch (e) { await delDraft(draftId); return done(_pre(e)); }
  let re;
  try { re = (await http.get(endpoints.draft(draftId, true), { op: 'get' })).json || {}; } catch (e) { await delDraft(draftId); return done(_pre(e)); }
  const reread = re.Body && typeof re.Body.Content === 'string' ? re.Body.Content : '';
  const po = proj(original);
  const okBody = !!opts.marker && reread.includes(opts.marker) && (!po || proj(reread).endsWith(po));
  const okRcpt = _recipientDiff(opts.compareSets, opts.expected, _draftRecipients(re)).equal;
  if (!okBody || !okRcpt) { await delDraft(draftId); return done(fbs('INSERT_UNVERIFIED')); }

  // 5. remember the draft's real ids and subject, then persist `sending`
  const subject = typeof re.Subject === 'string' && re.Subject ? re.Subject.slice(0, 400) : (typeof d.Subject === 'string' && d.Subject ? d.Subject.slice(0, 400) : undefined);
  const imid = typeof re.InternetMessageId === 'string' && re.InternetMessageId ? re.InternetMessageId : (typeof d.InternetMessageId === 'string' && d.InternetMessageId ? d.InternetMessageId : undefined);
  const convId = (typeof re.ConversationId === 'string' && re.ConversationId) || (typeof d.ConversationId === 'string' && d.ConversationId) || opts.conversationId || undefined;
  try { if (typeof opts.onRef === 'function') opts.onRef({ internetMessageId: imid, conversationId: convId, subject }); } catch (_) { /* bookkeeping only */ }
  const hooks = opts.attemptHooks || {};
  let persisted = false;
  try { persisted = typeof hooks.beforeSend === 'function' && hooks.beforeSend() === true; } catch (_) { persisted = false; }
  if (!persisted) { await delDraft(draftId); return done(fbs('ATTEMPT_NOT_PERSISTED')); }
  sending = true;

  // 6. the final POST: never refreshed, never retried
  try {
    await http.request({ op: 'send-draft', method: 'POST', path: endpoints.sendDraft(draftId), retry: 'final', timeoutMs: TC.POST_TIMEOUT_MS, maxBytes: TC.SMALL_MAX_BYTES });
  } catch (e) {
    if (e && e.definitiveNotSent) {
      const r = _pre(e);
      if (r.status === 'blocked-auth') counts.draftLeft++; else await delDraft(draftId);
      return done(r);
    }
    return done({ status: 'delivery-uncertain', detail: { code: 'UNCONFIRMED_' + _preCode(e) } });
  }
  draftIds.delete(draftId);

  // 7. Sent Items: a 202 is "queued", never "delivered"
  const v = await sentItems.verifySent(http, { internetMessageId: imid, conversationId: convId, marker: opts.marker, subject: subject || opts.subject },
    { timeoutMs: Number.isFinite(opts.verifyTimeoutMs) ? opts.verifyTimeoutMs : TC.VERIFY_TIMEOUT_MS, pollMs: opts.verifyPollMs, sleep: opts.sleep, now });
  if (v.found) return done({ status: 'sent', detail: { sentItemsMatch: { found: true, matchedBy: v.matchedBy } } });
  return done({ status: 'delivery-uncertain', detail: { code: 'NOT_IN_SENT_ITEMS' } });
}

async function apiSendMail(o) {
  const opts = o || {};
  const deps = opts.deps || {};
  const http = deps.http;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const done = (r) => { logger.info('[email-api] op=sendmail status=' + r.status + (r.detail && r.detail.code ? ' code=' + r.detail.code : '')); return r; };
  const pc = await _preCheck(deps, now);
  if (pc) return done(pc);
  const to = Array.isArray(opts.to) ? opts.to : [];
  if (!to.length || to.some((e) => !e || typeof e.address !== 'string' || !/@/.test(e.address))) return done(fbs('NO_ADDRESS'));
  const payload = {
    Message: {
      Subject: String(opts.subject || ''),
      Body: { ContentType: 'HTML', Content: String(opts.html || '') },
      ToRecipients: to.map((e) => ({ EmailAddress: { Address: e.address, Name: e.name || '' } })),
    },
    SaveToSentItems: true,
  };
  const hooks = opts.attemptHooks || {};
  let persisted = false;
  try { persisted = typeof hooks.beforeSend === 'function' && hooks.beforeSend() === true; } catch (_) { persisted = false; }
  if (!persisted) return done(fbs('ATTEMPT_NOT_PERSISTED'));
  try {
    await http.request({ op: 'sendmail', method: 'POST', path: endpoints.sendMail(), body: payload, retry: 'final', timeoutMs: TC.POST_TIMEOUT_MS, maxBytes: TC.SMALL_MAX_BYTES });
  } catch (e) {
    if (e && e.definitiveNotSent) return done(_pre(e));
    return done({ status: 'delivery-uncertain', detail: { code: 'UNCONFIRMED_' + _preCode(e) } });
  }
  const v = await sentItems.verifySent(http, { subject: payload.Message.Subject, marker: opts.marker },
    { timeoutMs: Number.isFinite(opts.verifyTimeoutMs) ? opts.verifyTimeoutMs : TC.VERIFY_TIMEOUT_MS, pollMs: opts.verifyPollMs, sleep: opts.sleep, now });
  if (v.found) {
    try { if (typeof opts.onRef === 'function' && v.internetMessageId) opts.onRef({ internetMessageId: v.internetMessageId }); } catch (_) { /* bookkeeping only */ }
    return done({ status: 'sent', detail: { sentItemsMatch: { found: true, matchedBy: v.matchedBy } } });
  }
  return done({ status: 'delivery-uncertain', detail: { code: 'NOT_IN_SENT_ITEMS' } });
}

async function apiMoveToDeleted(o) {
  const opts = o || {};
  const deps = opts.deps || {};
  const convId = typeof opts.apiConversationId === 'string' && opts.apiConversationId ? opts.apiConversationId : null;
  if (!convId) return { ok: false, code: 'NO_API_ID', moved: 0 };
  let fid;
  try { fid = await deps.folders.resolve(opts.folderLabel || 'Inbox'); } catch (e) {
    if (e instanceof E.ApiAuthBlockedError) return { ok: false, code: 'blocked-auth', moved: 0 };
    return { ok: false, code: 'FAILED', moved: 0 };
  }
  if (!fid || fid === 'not-found') return { ok: false, code: 'FOLDER_NOT_FOUND', moved: 0 };
  let ids;
  try {
    const r = await deps.http.get(endpoints.folderConversation(fid, convId), { op: 'list' });
    ids = (r && r.json && Array.isArray(r.json.value) ? r.json.value : []).map((x) => x && x.Id).filter((x) => typeof x === 'string' && x).slice(0, TC.DELETE_CONV_MAX);
  } catch (e) {
    if (e instanceof E.ApiAuthBlockedError) return { ok: false, code: 'blocked-auth', moved: 0 };
    return { ok: false, code: 'FAILED', moved: 0 };
  }
  if (!ids.length) { logger.info('[email-api] op=move moved=0'); return { ok: false, code: 'NOT_FOUND', moved: 0 }; }
  let moved = 0; let failed = 0;
  for (const id of ids) {
    try {
      await deps.http.request(_write('move', 'POST', endpoints.move(id), { DestinationId: 'deleteditems' }));
      moved++;
    } catch (e) {
      if (e instanceof E.ApiAuthBlockedError) { logger.info('[email-api] op=move moved=' + moved + ' err=blocked-auth'); return { ok: false, code: 'blocked-auth', moved, failed }; }
      failed++;
    }
  }
  logger.info('[email-api] op=move moved=' + moved + ' failed=' + failed);
  return failed ? { ok: false, code: 'PARTIAL', moved, failed } : { ok: true, moved, failed: 0 };
}

module.exports = { apiReply, apiSendMail, apiMoveToDeleted, prepend };
