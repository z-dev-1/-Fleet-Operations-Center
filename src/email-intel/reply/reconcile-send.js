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
 */
const guard = require('./send-guard');
const { rid } = require('../redact');
let logger;
try { logger = require('../../utils/logger')('email-intel'); } catch (_) { logger = { info() {}, warn() {}, error() {} }; }

const RECONCILE_TIMEOUT_MS = 90_000;
const VERIFY_TIMEOUT_MS = 75_000;
const RECONCILABLE = new Set(['delivery-uncertain', 'unconfirmed-not-found']);

async function reconcileSend(attemptId, opts) {
  const o = opts || {};
  const a = guard.get(attemptId);
  if (!a) return { ok: false, code: 'NOT_FOUND' };
  if (!RECONCILABLE.has(a.state)) return { ok: false, code: 'NOT_RECONCILABLE', state: a.state };
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

module.exports = { reconcileSend, RECONCILE_TIMEOUT_MS, RECONCILABLE };
