'use strict';
/**
 * email-intel/transport/index.js — facade of the Outlook REST transport (design 2.1).
 *
 *   TC                                 frozen limits (constants.js)
 *   isOn()                             flags.apiTransport()
 *   deps() -> { http, tokens, folders, owaRe }   lazy singletons: the ONLY creator of the token source, http and
 *                                      folder resolver, so there is one token cache per process (I-12)
 *   readMailbox(opts)                  reader.js (owa_capture.readMailbox contract)
 *   createFetchOne(itemId)             attachment fetchOne bound to the shared http
 *   probe()                            one tiny GET -> { ok, transport:'api', status, latencyMs, token, error? }
 *   describe()                         { token: tokens.describe(), pausedUntil }
 *   reconcileQuery(attempt, doc)       pure: Sent Items search input + strategies for a send attempt
 *   findSentForAttempt(attempt, opts)  read-only Sent Items lookup for reconcile (R4-M5 signal / deadlineAt)
 *   _setForTests({ tokens, http, folders } | null)
 *
 * Main process only (requires electron lazily). Loaded only when apiTransport is effective (AC-19). Files in
 * transport/ never require reply/, executors.js or email-intel/index.js.
 */
const { TC } = require('./constants');
const E = require('./errors');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

let _deps = null;

function isOn() {
  try { return require('../flags').apiTransport() === true; } catch (_) { return false; }
}

function deps() {
  if (_deps) return _deps;
  const electron = require('electron');
  const owaRe = require('../../scrapers/owa-mailer');
  const tokens = require('./token-source').createTokenSource({ electron, log: logger, owaRe });
  const http = require('./http').createHttp({ electron, tokens, log: logger, owaRe });
  const folders = require('./folders').createFolderResolver({ http, owaRe });
  _deps = { tokens, http, folders, owaRe };
  return _deps;
}

function readMailbox(opts) { return require('./reader').readMailbox(opts); }

function createFetchOne(itemId) { return require('./attachments').createFetchOne({ http: deps().http, itemId }); }

function describe() {
  if (!_deps) return { token: { present: false, ttlBucket: 'none', hold: false, rank: 0, lastRefreshAt: null, refreshCount: 0, lastResult: null }, pausedUntil: 0 };
  let token = null;
  try { token = _deps.tokens.describe(); } catch (_) { token = null; }
  let paused = 0;
  try { paused = _deps.http.pausedUntil ? _deps.http.pausedUntil() : 0; } catch (_) { paused = 0; }
  return { token, pausedUntil: paused || 0 };
}

async function probe() {
  const d = deps();
  const t0 = Date.now();
  try {
    const r = await d.http.get(require('./endpoints').probe(), { op: 'probe', maxBytes: TC.SMALL_MAX_BYTES });
    return { ok: true, transport: 'api', status: r.status, latencyMs: Date.now() - t0, token: d.tokens.describe() };
  } catch (e) {
    const code = e && e.code ? String(e.code) : 'API_ERROR';
    return { ok: false, transport: 'api', status: (e && e.status) || 0, latencyMs: Date.now() - t0, token: d.tokens.describe(), error: code };
  }
}

const _str = (v) => (typeof v === 'string' && v ? v : null);

/** Pure: the search input of an attempt (design 8.6). DOM-era compose-new attempts get no strategy (INV-3). */
function reconcileQuery(a, messagesDoc) {
  const att = a || {};
  let doc = messagesDoc;
  if (!doc) {
    try { doc = require('../ingest/ledger').ensureDoc(require('../stores').load('messages')); } catch (_) { doc = { messages: {} }; }
  }
  const ref = att.apiRef && typeof att.apiRef === 'object' ? att.apiRef : {};
  const internetMessageId = _str(ref.internetMessageId);
  let conversationId = _str(ref.conversationId);
  if (!conversationId) {
    const rec = require('../ingest/identity').findMessage(doc, att.targetMessageKey);
    conversationId = rec ? _str(rec.apiConversationId) : null;
  }
  if (!conversationId && att.conversationKey && doc && doc.messages) {
    const recs = Object.values(doc.messages).filter((r) => r && r.conversationKey === att.conversationKey && _str(r.apiConversationId))
      .sort((x, y) => (Date.parse(y.receivedAt || '') || Date.parse(y.ingestedAt || '') || 0) - (Date.parse(x.receivedAt || '') || Date.parse(x.ingestedAt || '') || 0));
    if (recs.length) conversationId = recs[0].apiConversationId;
  }
  const subject = _str(ref.subject);
  const markerSent = att.transport === 'api' || att.mechanism === 'owa-thread';
  const marker = markerSent ? _str(att.marker) : null;
  const q = { internetMessageId, conversationId, subject, marker };
  return { q, strategies: require('./sent-items').strategiesFor(q) };
}

/**
 * findSentForAttempt(a, { now, messagesDoc, signal, deadlineAt }) ->
 *   { ok:true, found:true, matchedBy, internetMessageId } | { ok:true, found:false }
 *   | { ok:false, code:'RECONCILE_UNAVAILABLE'|'RECONCILE_INCONCLUSIVE'|'blocked-auth'|'RECONCILE_FAILED' }
 */
async function findSentForAttempt(a, opts) {
  const o = opts || {};
  const { q, strategies } = reconcileQuery(a, o.messagesDoc);
  if (!strategies.length) return { ok: false, code: 'RECONCILE_UNAVAILABLE' };
  const hasDeadline = Number.isFinite(o.deadlineAt);
  if (hasDeadline && Date.now() >= o.deadlineAt) return { ok: false, code: 'RECONCILE_INCONCLUSIVE' };
  const spec = {};
  if (o.signal) spec.signal = o.signal;
  if (hasDeadline) spec.deadlineAt = o.deadlineAt;
  const d = o._deps || deps();
  try {
    const r = await require('./sent-items').findSent(d.http, q, strategies, spec, d.owaRe);
    if (r.found) return { ok: true, found: true, matchedBy: r.matchedBy, internetMessageId: r.internetMessageId || null };
    if (r.complete) return { ok: true, found: false };
    return { ok: false, code: 'RECONCILE_INCONCLUSIVE' };
  } catch (e) {
    if (e instanceof E.ApiAuthBlockedError) return { ok: false, code: 'blocked-auth' };
    if (hasDeadline && (e instanceof E.AbortedError || e instanceof E.ThrottledError || (e instanceof E.ApiTimeoutError && e.reason === 'deadline'))) return { ok: false, code: 'RECONCILE_INCONCLUSIVE' };
    return { ok: false, code: 'RECONCILE_FAILED' };
  }
}

function _setForTests(x) {
  if (x == null) { _deps = null; return; }
  const owaRe = x.owaRe || require('../../scrapers/owa-mailer');
  _deps = Object.assign({ owaRe }, x);
  if (_deps.http && !_deps.folders) _deps.folders = require('./folders').createFolderResolver({ http: _deps.http, owaRe });
}

module.exports = { TC, isOn, deps, readMailbox, createFetchOne, describe, probe, reconcileQuery, findSentForAttempt, _setForTests };
