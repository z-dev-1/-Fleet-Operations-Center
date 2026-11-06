'use strict';
/**
 * email-intel/understand/confidence.js — effective confidence and the auto-apply threshold
 * (design 3.7; R1.5, R7.3, R7.4, AC-0).
 *
 *   effectiveConfidence(fact, ctx) -> { value, caps:[{ cap, reason }] }
 *   meetsThreshold(value, cfg?)    -> value >= max(AUTO_APPLY_MIN_CONFIDENCE, cfg.minConfidence)
 *   threshold(cfg?)                -> the effective threshold (never below 0.75, never NaN)
 *   messageCtx(record, analysis)   -> the message-level inputs of the caps
 *
 *   base  = (fact.confidenceValid && overallValid) ? min(fact.confidence, overallConfidence) : 0
 *   value = min(base, ...caps)
 *
 * Missing / null / string / NaN / negative / > 1 confidence is INVALID: the effective value is 0, so
 * it can never auto-apply (Phase C stages it as `invalid-confidence`). There is no 0.7 / 0.4
 * fallback anywhere in this path and nothing is clamped. Caps only lower values. The threshold is
 * the frozen AUTO_APPLY_MIN_CONFIDENCE constant compared with `>=`; configuration can only raise it.
 */
const C = require('../constants');
const cfgMod = require('../config');

const CAP_LOW = 0.6;
const CAP_MID = 0.74;

const isValid = (c) => typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1;

/** Message-level cap inputs derived from the ledger record and the validated analysis. */
function messageCtx(rec, analysis) {
  const r = rec || {};
  const a = analysis || {};
  const from = r.from || {};
  const body = r.body || {};
  // A forwarded message whose original "Sent:/Date:" header cannot be parsed keeps an unknown fact time.
  const fwdDated = String(body.newContent || '').split('\n').some((l) => {
    const m = /^\s*(?:\*\*)?(?:sent|date):\s*(.+)$/i.exec(l);
    return !!m && Number.isFinite(Date.parse(m[1].replace(/\s+at\s+/i, ' ')));
  });
  const forwardedUndated = !!(r.flags && r.flags.forwarded) && !fwdDated;
  return {
    overallConfidence: a.overallConfidence, overallValid: a.overallValid === true,
    bodyStatus: body.status || 'unknown', receivedAtQuality: r.receivedAtQuality || 'unknown',
    senderNameEmpty: !String(from.name || '').trim(), automated: !!(r.flags && r.flags.automated),
    forwardedUndated, injectionSuspected: !!(r.flags && r.flags.injectionSuspected),
  };
}

/**
 * effectiveConfidence(fact, ctx)
 *   fact: validated fact (confidence, confidenceValid, assertion, unitAttribution, dateInvalid, amountUnverified)
 *   ctx: messageCtx(...) plus { unitDroppedMoreThanHalf }
 */
function effectiveConfidence(fact, ctx) {
  const f = fact || {};
  const c = ctx || {};
  const caps = [];
  const factOk = f.confidenceValid === true && isValid(f.confidence);
  const overallOk = c.overallValid === true && isValid(c.overallConfidence);
  const base = factOk && overallOk ? Math.min(f.confidence, c.overallConfidence) : 0;
  if (!factOk) caps.push({ cap: 0, reason: 'invalid-confidence' });
  else if (!overallOk) caps.push({ cap: 0, reason: 'invalid-overall-confidence' });
  if (f.assertion !== 'stated') caps.push({ cap: CAP_LOW, reason: 'not-stated' });
  if (c.bodyStatus !== 'complete') caps.push({ cap: CAP_LOW, reason: 'partial-content' });
  if (f.unitAttribution === 'weak') caps.push({ cap: CAP_LOW, reason: 'weak-attribution' });
  if (f.dateInvalid) caps.push({ cap: CAP_LOW, reason: 'date-invalid' });
  if (f.amountUnverified) caps.push({ cap: CAP_LOW, reason: 'amount-unverified' });
  if (c.receivedAtQuality === 'unknown') caps.push({ cap: CAP_LOW, reason: 'received-time-unknown' });
  if (c.senderNameEmpty || c.automated) caps.push({ cap: CAP_MID, reason: 'sender-unverified' });
  if (c.forwardedUndated) caps.push({ cap: CAP_MID, reason: 'forwarded-undated' });
  if (c.injectionSuspected) caps.push({ cap: CAP_MID, reason: 'injection-suspected' });
  if (c.unitDroppedMoreThanHalf) caps.push({ cap: CAP_MID, reason: 'validation-dropped-most' });
  let value = base;
  for (const k of caps) value = Math.min(value, k.cap);
  return { value, caps };
}

function threshold(cfg) {
  return Math.max(C.AUTO_APPLY_MIN_CONFIDENCE, cfgMod.effectiveMinConfidence(cfg || {}));
}

function meetsThreshold(value, cfg) {
  return typeof value === 'number' && Number.isFinite(value) && value >= threshold(cfg);
}

module.exports = { effectiveConfidence, meetsThreshold, threshold, messageCtx, isValid, CAP_LOW, CAP_MID };
