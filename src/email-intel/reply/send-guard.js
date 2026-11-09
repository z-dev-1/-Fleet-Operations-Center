'use strict';
/**
 * email-intel/reply/send-guard.js — persisted send attempts and the uncertain-delivery block (design 6.5; R5.8,
 * case L). Store: emailIntelSends { version, attempts:{ [attemptId]: SendAttempt } }.
 *
 * SendAttempt = { attemptId 'sa_'+16 hex, state, conversationKey, targetMessageKey, actionId?, mode, mechanism,
 *   recipients:{ to:[{name,address|null}], cc:[...] }, toCount, ccCount, subjectNorm, bodyHash, bodyChars, marker,
 *   createdAt, sendClickedAt?, finishedAt?, errorCode?,
 *   reconcile:{ checks:[{ at, found }], resolution: null|'confirmed-sent'|'user-marked-sent'|'user-marked-not-sent', resolvedAt? } }
 * state: preparing | sending | sent | delivery-uncertain | unconfirmed-not-found | failed-before-send | blocked-auth | abandoned
 *
 *   createAttempt(fields, { now })      -> { ok, attempt } | { ok:false, code:'UNRECONCILED_ATTEMPT', attemptId }   (atomic check + insert)
 *   canSend(conversationKey, { now })   -> { ok:true } | { ok:false, reason:'unreconciled-attempt', attemptId, state }
 *   markSending(attemptId, { now })     persisted synchronously right before the Send click
 *   finish(attemptId, state, extra)     terminal / reconcile states
 *   recordCheck(attemptId, found, now)  a read-only Sent Items re-check result
 *   resolve(attemptId, resolution, now) user resolution (through the mark-send-resolution token only)
 *   bootRecover({ now })                sending -> delivery-uncertain; preparing older than 10 min -> failed-before-send
 *   withSendLock(fn)                    process-wide mutex: one send at a time ({ ok:false, code:'SEND_IN_PROGRESS' } when busy)
 *   applyOutcome(attempt, { bodyText }) mirrors the outcome onto the legacy record (replyState sent | uncertain) and
 *                                       marks the conversation's live reply items done when the send is confirmed
 *
 * canSend is false while an attempt for the conversation is sending, delivery-uncertain, unconfirmed-not-found, or
 * preparing and younger than 10 minutes. Nothing here retries or sends anything: a second click, or a retry from
 * another view, is refused until the attempt is reconciled or resolved by the user. Logs carry ids hashed by rid().
 */
const crypto = require('crypto');
const stores = require('../stores');
const { rid } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const PREPARING_STALE_MS = 10 * 60_000;
const BLOCKING = new Set(['sending', 'delivery-uncertain', 'unconfirmed-not-found']);
const TERMINAL = new Set(['sent', 'failed-before-send', 'blocked-auth', 'abandoned']);
const STATES = Object.freeze(['preparing', 'sending', 'sent', 'delivery-uncertain', 'unconfirmed-not-found', 'failed-before-send', 'blocked-auth', 'abandoned']);
const MAX_ATTEMPTS = 500;
const ID_RE = /^sa_[0-9a-f]{16}$/;

const iso = (now) => new Date(Number.isFinite(now) ? now : Date.now()).toISOString();
const _ms = (s) => Date.parse(s || '') || 0;
const newAttemptId = () => 'sa_' + crypto.randomBytes(8).toString('hex');

function ensureDoc(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  if (!d.attempts || typeof d.attempts !== 'object') d.attempts = {};
  if (d.version == null) d.version = 1;
  return d;
}
function load() { return ensureDoc(stores.load('sends')); }

function _blocks(a, now) {
  if (!a) return false;
  if (BLOCKING.has(a.state)) return true;
  return a.state === 'preparing' && now - _ms(a.createdAt) < PREPARING_STALE_MS;
}

function blockingAttempt(doc, conversationKey, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return Object.values(ensureDoc(doc).attempts)
    .filter((a) => a.conversationKey === conversationKey && _blocks(a, t))
    .sort((a, b) => _ms(b.createdAt) - _ms(a.createdAt))[0] || null;
}

function canSend(conversationKey, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const a = blockingAttempt(load(), conversationKey, now);
  return a ? { ok: false, reason: 'unreconciled-attempt', attemptId: a.attemptId, state: a.state } : { ok: true };
}

function _prune(d) {
  const all = Object.values(d.attempts);
  if (all.length <= MAX_ATTEMPTS) return;
  const victims = all.filter((a) => TERMINAL.has(a.state)).sort((a, b) => _ms(a.createdAt) - _ms(b.createdAt));
  for (const v of victims) { if (Object.keys(d.attempts).length <= MAX_ATTEMPTS) break; delete d.attempts[v.attemptId]; }
}

function createAttempt(fields, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const f = fields || {};
  let attempt = null; let blocked = null;
  const r = stores.update('sends', (doc) => {
    const d = ensureDoc(doc);
    const b = blockingAttempt(d, f.conversationKey, now);
    if (b) { blocked = b; return d; }
    attempt = {
      attemptId: newAttemptId(), state: 'preparing', conversationKey: f.conversationKey, targetMessageKey: f.targetMessageKey || null,
      actionId: f.actionId || undefined, mode: f.mode, mechanism: f.mechanism,
      recipients: { to: (f.to || []).map((e) => ({ name: e.name || '', address: e.address || null })), cc: (f.cc || []).map((e) => ({ name: e.name || '', address: e.address || null })) },
      toCount: (f.to || []).length, ccCount: (f.cc || []).length, subjectNorm: f.subjectNorm || '', bodyHash: f.bodyHash || '', bodyChars: f.bodyChars || 0,
      marker: f.marker || '', createdAt: iso(now), reconcile: { checks: [], resolution: null },
    };
    // Outlook REST sends (apiTransport): the transport marker and the exact sent subject for a later reconcile.
    if (f.transport === 'api') attempt.transport = 'api';
    if (f.apiRef && typeof f.apiRef === 'object' && typeof f.apiRef.subject === 'string' && f.apiRef.subject) attempt.apiRef = { subject: f.apiRef.subject.slice(0, 400) };
    d.attempts[attempt.attemptId] = attempt;
    _prune(d);
    return d;
  });
  if (!r.ok) return { ok: false, code: r.code || 'STORE_ERROR' };
  if (blocked) { logger.warn('[email-intel] send refused: unreconciled attempt sa=' + rid(blocked.attemptId) + ' state=' + blocked.state); return { ok: false, code: 'UNRECONCILED_ATTEMPT', attemptId: blocked.attemptId, state: blocked.state }; }
  logger.info('[email-intel] send attempt created sa=' + rid(attempt.attemptId) + ' mode=' + attempt.mode + ' mechanism=' + attempt.mechanism + ' to=' + attempt.toCount + ' cc=' + attempt.ccCount);
  return { ok: true, attempt };
}

function _patch(attemptId, fn) {
  let out = null;
  const r = stores.update('sends', (doc) => {
    const d = ensureDoc(doc);
    const a = d.attempts[attemptId];
    if (!a) return d;
    fn(a);
    out = JSON.parse(JSON.stringify(a));
    return d;
  });
  if (!r.ok) return { ok: false, code: r.code || 'STORE_ERROR' };
  return out ? { ok: true, attempt: out } : { ok: false, code: 'NOT_FOUND' };
}

/** markSending: persisted (synchronous store write) immediately before the Send click. */
function markSending(attemptId, opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  return _patch(attemptId, (a) => { if (a.state === 'preparing') { a.state = 'sending'; a.sendClickedAt = iso(now); } });
}

/**
 * setApiRef(attemptId, { internetMessageId?, conversationId?, subject? }): merges the string fields that are present
 * into attempt.apiRef (ids <= 998 chars, subject <= 400). Undefined / invalid fields leave the stored value.
 */
function setApiRef(attemptId, ref) {
  const r = ref && typeof ref === 'object' ? ref : {};
  const ok = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  return _patch(attemptId, (a) => {
    const cur = a.apiRef && typeof a.apiRef === 'object' ? a.apiRef : {};
    if (ok(r.internetMessageId, 998)) cur.internetMessageId = r.internetMessageId;
    if (ok(r.conversationId, 998)) cur.conversationId = r.conversationId;
    if (typeof r.subject === 'string' && r.subject) cur.subject = r.subject.slice(0, 400);
    a.apiRef = cur;
  });
}

function finish(attemptId, state, extra) {
  if (!STATES.includes(state)) return { ok: false, code: 'BAD_STATE' };
  const e = extra || {};
  const r = _patch(attemptId, (a) => {
    a.state = state;
    a.finishedAt = iso(e.now);
    if (e.errorCode) a.errorCode = String(e.errorCode).slice(0, 40); else delete a.errorCode;
    if (e.resolution) { a.reconcile.resolution = e.resolution; a.reconcile.resolvedAt = iso(e.now); }
  });
  if (r.ok) logger.info('[email-intel] send attempt sa=' + rid(attemptId) + ' state=' + state + (e.errorCode ? ' code=' + String(e.errorCode).slice(0, 40) : ''));
  return r;
}

function recordCheck(attemptId, found, now) {
  return _patch(attemptId, (a) => {
    a.reconcile.checks.push({ at: iso(now), found: !!found });
    if (a.reconcile.checks.length > 20) a.reconcile.checks = a.reconcile.checks.slice(-20);
  });
}

function resolve(attemptId, resolution, now) {
  if (resolution === 'sent' || resolution === 'confirmed-sent') return finish(attemptId, 'sent', { now, resolution: resolution === 'sent' ? 'user-marked-sent' : 'confirmed-sent' });
  if (resolution === 'not-sent') return finish(attemptId, 'abandoned', { now, resolution: 'user-marked-not-sent' });
  return { ok: false, code: 'BAD_ARG' };
}

function get(attemptId) {
  if (typeof attemptId !== 'string' || !ID_RE.test(attemptId)) return null;
  const a = load().attempts[attemptId];
  return a ? JSON.parse(JSON.stringify(a)) : null;
}

function list(opts) {
  const o = opts || {};
  return Object.values(load().attempts)
    .filter((a) => (o.conversationKey ? a.conversationKey === o.conversationKey : true))
    .sort((a, b) => _ms(b.createdAt) - _ms(a.createdAt))
    .slice(0, Number.isInteger(o.limit) ? o.limit : 50)
    .map((a) => JSON.parse(JSON.stringify(a)));
}

function unreconciledCount(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  return Object.values(load().attempts).filter((a) => BLOCKING.has(a.state) || (a.state === 'preparing' && now - _ms(a.createdAt) < PREPARING_STALE_MS)).length;
}

/** Boot recovery: a send that was mid-click when the app stopped is uncertain; an old preparing one never clicked. */
function bootRecover(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const out = { uncertain: 0, failed: 0 };
  if (_inFlight) return out;                                                // never while this process is sending
  let any = false;
  for (const a of Object.values(load().attempts)) if (a.state === 'sending' || (a.state === 'preparing' && now - _ms(a.createdAt) >= PREPARING_STALE_MS)) any = true;
  if (!any) return out;
  stores.update('sends', (doc) => {
    const d = ensureDoc(doc);
    for (const a of Object.values(d.attempts)) {
      if (a.state === 'sending') { a.state = 'delivery-uncertain'; a.errorCode = 'BOOT_RECOVERY'; a.finishedAt = iso(now); out.uncertain++; }
      else if (a.state === 'preparing' && now - _ms(a.createdAt) >= PREPARING_STALE_MS) { a.state = 'failed-before-send'; a.errorCode = 'BOOT_RECOVERY'; a.finishedAt = iso(now); out.failed++; }
    }
    return d;
  });
  if (out.uncertain || out.failed) logger.warn('[email-intel] send boot recovery uncertain=' + out.uncertain + ' failed=' + out.failed);
  return out;
}

let _inFlight = false;
async function withSendLock(fn) {
  if (_inFlight) return { ok: false, code: 'SEND_IN_PROGRESS' };
  _inFlight = true;
  try { return await fn(); } finally { _inFlight = false; }
}
const isSending = () => _inFlight;

// ── outcome mirroring (legacy record + action items) ──────────────────────────
function _legacyIndex(results, conversationKey, legacyId) {
  const emails = (results && Array.isArray(results.emails)) ? results.emails : [];
  let idx = emails.findIndex((e) => e && e.intel && e.intel.conversationKey === conversationKey);
  if (idx === -1 && legacyId) idx = emails.findIndex((e) => e && e.id === legacyId);
  return idx;
}

/**
 * patchLegacy(conversationKey, patch, legacyId) -> updated results | null. The legacy record keeps the overlay
 * coherent: replyState 'sent' only for a confirmed send, 'uncertain' for an unconfirmed click.
 */
function patchLegacy(conversationKey, patch, legacyId) {
  try {
    const store = require('../../store');
    const results = store.load('emailTriageResults', null);
    const idx = _legacyIndex(results, conversationKey, legacyId);
    if (idx === -1) return null;
    results.emails[idx] = Object.assign({}, results.emails[idx], patch);
    store.save('emailTriageResults', results);
    return results;
  } catch (_) { return null; }
}

function _closeReplyItems(conversationKey, now) {
  try {
    const as = require('../actions/store');
    as.update((doc) => {
      for (const item of Object.values(doc.items)) {
        if (item.conversationKey !== conversationKey || item.category !== 'reply' || !as.LIVE.has(item.state)) continue;
        as.applyOp(doc, item.actionId, 'done', { now });
      }
    });
  } catch (_) { /* actions bookkeeping only */ }
}

function applyOutcome(attempt, opts) {
  const o = opts || {};
  if (!attempt) return null;
  if (attempt.state === 'sent') {
    _closeReplyItems(attempt.conversationKey, o.now);
    const patch = { replyState: 'sent' };
    if (typeof o.bodyText === 'string') patch.replyDraft = o.bodyText;
    return patchLegacy(attempt.conversationKey, patch, o.legacyId);
  }
  if (attempt.state === 'delivery-uncertain' || attempt.state === 'unconfirmed-not-found') return patchLegacy(attempt.conversationKey, { replyState: 'uncertain' }, o.legacyId);
  if (attempt.state === 'abandoned') {
    const store = require('../../store');
    let draft = '';
    try { const res = store.load('emailTriageResults', null); const i = _legacyIndex(res, attempt.conversationKey, o.legacyId); draft = i === -1 ? '' : (res.emails[i].replyDraft || ''); } catch (_) { draft = ''; }
    return patchLegacy(attempt.conversationKey, { replyState: draft ? 'drafted' : 'none' }, o.legacyId);
  }
  return null;
}

function _resetForTests() { _inFlight = false; }

module.exports = {
  STATES, BLOCKING, PREPARING_STALE_MS, ID_RE, ensureDoc, load, blockingAttempt, canSend, createAttempt, markSending, setApiRef, finish, recordCheck,
  resolve, get, list, unreconciledCount, bootRecover, withSendLock, isSending, patchLegacy, applyOutcome, _resetForTests,
};
