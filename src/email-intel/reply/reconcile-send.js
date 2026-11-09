'use strict';
/**
 * email-intel/reply/reconcile-send.js — read-only Sent Items re-check of an uncertain send (design 6.5; case L).
 *
 *   reconcileSend(attemptId, { _electron, _warm, _sleep, _verify, _session, now, timeoutMs })
 *     -> { ok:true, state:'sent', found:true } | { ok:true, state:'unconfirmed-not-found', found:false }
 *      | { ok:false, code:'NOT_FOUND'|'NOT_RECONCILABLE'|'blocked-auth'|'RECONCILE_FAILED', state? }
 *
 * Opens the same hidden OWA window as the reader (no new endpoint, no compose, no click on anything that sends)
 * and re-runs the existing Sent Items verification for the attempt's correlation marker, normalized subject and
 * recipients, bounded to 90 s. Found -> the attempt becomes sent (resolution confirmed-sent). Not found -> the
 * attempt becomes unconfirmed-not-found with the check recorded, and the conversation STAYS blocked. Auth wall ->
 * the attempt is unchanged and blocked-auth is reported. Nothing here ever sends or retries a send.
 *
 * Under apiTransport the lookup goes through the Outlook REST transport instead (no window; see _reconcileApi):
 * extra results { ok:false, code:'RECONCILE_UNAVAILABLE'|'RECONCILE_INCONCLUSIVE'|'RECONCILE_IN_PROGRESS', state }
 * and the options { onlyIfFound, signal, deadlineAt, _apiFind }.
 */
const guard = require('./send-guard');
const { rid } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const RECONCILE_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 75_000;
const RECONCILABLE = new Set(['delivery-uncertain', 'unconfirmed-not-found']);

// Outlook REST transport: attempt ids being reconciled in this process (one reconcile per attempt at a time, I-15).
const RECONCILE_IN_PROGRESS = new Set();

function _apiOn() {
  try { return require('../flags').apiTransport() === true; } catch (_) { return false; }
}

/**
 * API branch (apiTransport only, design 8.6): a read-only Sent Items lookup through the transport. No window.
 * RECONCILE_UNAVAILABLE / RECONCILE_INCONCLUSIVE / blocked-auth / RECONCILE_FAILED record no check and change no
 * state (a search that could not cover every match is never "not sent"). The attempt is re-read before recordCheck /
 * finish, so a `sent` attempt is never re-opened. onlyIfFound (automatic pre-step): found -> sent; a complete miss
 * records the check only. opts.signal / opts.deadlineAt reach every request (R4-M5).
 */
async function _reconcileApi(attemptId, a, o) {
  if (RECONCILE_IN_PROGRESS.has(attemptId)) return { ok: false, code: 'RECONCILE_IN_PROGRESS', state: a.state };
  RECONCILE_IN_PROGRESS.add(attemptId);
  try {
    const find = typeof o._apiFind === 'function' ? o._apiFind : require('../transport').findSentForAttempt;
    const now = Number.isFinite(o.now) ? o.now : Date.now();
    const fo = { now };
    if (o.signal) fo.signal = o.signal;
    if (Number.isFinite(o.deadlineAt)) fo.deadlineAt = o.deadlineAt;
    if (o.messagesDoc) fo.messagesDoc = o.messagesDoc;
    const res = await find(a, fo);
    if (!res || !res.ok) {
      const code = (res && res.code) || 'RECONCILE_FAILED';
      if (code === 'RECONCILE_UNAVAILABLE' || code === 'RECONCILE_INCONCLUSIVE') logger.info('[email-intel] reconcile ' + (code === 'RECONCILE_UNAVAILABLE' ? 'unavailable' : 'inconclusive') + ' sa=' + rid(attemptId));
      else logger.warn('[email-intel] reconcile could not check sa=' + rid(attemptId) + ' err=' + String(code).slice(0, 30));
      return { ok: false, code, state: a.state };
    }
    const cur = guard.get(attemptId);
    if (!cur || !RECONCILABLE.has(cur.state)) return { ok: true, state: cur && cur.state, found: !!res.found };
    guard.recordCheck(attemptId, !!res.found, now);
    if (res.found) {
      const r = guard.finish(attemptId, 'sent', { now, resolution: 'confirmed-sent' });
      if (r.ok) guard.applyOutcome(r.attempt, { now });
      return { ok: true, state: 'sent', found: true };
    }
    if (o.onlyIfFound) return { ok: true, state: cur.state, found: false };
    const r = guard.finish(attemptId, 'unconfirmed-not-found', { now, errorCode: cur.errorCode });
    if (r.ok) guard.applyOutcome(r.attempt, { now });
    return { ok: true, state: 'unconfirmed-not-found', found: false };
  } finally {
    RECONCILE_IN_PROGRESS.delete(attemptId);
  }
}

async function reconcileSend(attemptId, opts) {
  const o = opts || {};
  const a = guard.get(attemptId);
  if (!a) return { ok: false, code: 'NOT_FOUND' };
  if (!RECONCILABLE.has(a.state)) return { ok: false, code: 'NOT_RECONCILABLE', state: a.state };
  if (_apiOn()) return _reconcileApi(attemptId, a, o);
  const verify = o._verify || require('../../scrapers/owa-mailer')._verifySentItems;
  const session = o._session || require('../capture/owa_capture').openSession;
  const recipients = a.recipients.to.concat(a.recipients.cc).map((e) => e.address).filter(Boolean);
  let res;
  try {
    res = await session({
      _electron: o._electron, _warm: o._warm, _sleep: o._sleep, authGraceMs: o.authGraceMs,
      timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : RECONCILE_TIMEOUT_MS,
    }, async (ctx) => {
      ctx.state.verify = await verify(ctx.win, { marker: a.marker, normSubject: a.subjectNorm, recipients, timeoutMs: VERIFY_TIMEOUT_MS });
    });
  } catch (_) { res = null; }
  const st = (res && res.settled) || {};
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (st.authBlocked) { logger.warn('[email-intel] reconcile blocked by sign-in sa=' + rid(attemptId)); return { ok: false, code: 'blocked-auth', state: a.state }; }
  const v = res && res.state && res.state.verify;
  if (!v) { logger.warn('[email-intel] reconcile could not check sa=' + rid(attemptId) + ' err=' + String(st.error || 'unknown').slice(0, 30)); return { ok: false, code: 'RECONCILE_FAILED', state: a.state }; }
  guard.recordCheck(attemptId, !!v.found, now);
  if (v.found) {
    const r = guard.finish(attemptId, 'sent', { now, resolution: 'confirmed-sent' });
    if (r.ok) guard.applyOutcome(r.attempt, { now });
    return { ok: true, state: 'sent', found: true };
  }
  const r = guard.finish(attemptId, 'unconfirmed-not-found', { now, errorCode: a.errorCode });
  if (r.ok) guard.applyOutcome(r.attempt, { now });
  return { ok: true, state: 'unconfirmed-not-found', found: false };
}

module.exports = { reconcileSend, RECONCILE_TIMEOUT_MS, RECONCILABLE, RECONCILE_IN_PROGRESS };
