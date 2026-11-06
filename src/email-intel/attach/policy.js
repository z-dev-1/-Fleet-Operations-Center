'use strict';
/**
 * email-intel/attach/policy.js — which attachments may be fetched and read (design 7.3; R6.2, R6.5,
 * F-24, F-28).
 *
 *   enabled(effective)                 -> effective.attachments === true (the sub-flag)
 *   policyOf(intelCfg)                 -> frozen, clamped policy from emailIntelConfig.attachments
 *   visionAllowance(policy)            -> 0 until the one-time vision notice is acknowledged, else maxVision
 *   createBudget(policy, { now })      -> per-scan budget { policy, deadline, used, visionLeft, noticePending, take() }
 *   decide(att, budget, { flagOn, perMessageUsed, now }) -> { allow:true } | { allow:false, status, reason }
 *   reasonText(code)                   -> fixed user-facing text for a policy / fetch reason code
 *
 * Checks, in order: flag, a real file name, extension allowlist, known size over maxBytes (from the
 * chip text), a download handle on the chip, per-message count, per-scan count, remaining time, and
 * for image files the vision allowance. Refusals are `skipped` with a reason code (the flag being off
 * is `filename-only`, a chip without a download handle is `unreadable: no-handle`); nothing here reads
 * a file or a filename's meaning. Hard caps cannot be raised by configuration.
 */
const cfgMod = require('../config');

const HARD = Object.freeze({ maxBytes: 10_000_000, maxPerMessage: 5, maxPerScan: 12, timeBudgetMs: 240_000, maxVision: 4 });
const DEFAULTS = Object.freeze({ maxBytes: 6_000_000, maxPerMessage: 3, maxPerScan: 8, timeBudgetMs: 120_000, maxVision: 2 });
const VISION_EXT = Object.freeze(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const FETCH_TIMEOUT_MS = 30_000;

// Fixed user-facing texts (never built from file names or file content).
const REASON_TEXT = Object.freeze({
  'flag-off': 'attachment reading is off',
  'no-name': 'no file name shown',
  'extension-not-allowed': 'file type is not on the allow list',
  'over-size': 'file is larger than the size limit',
  'message-limit': 'more attachments on this message than the limit',
  'scan-limit': 'attachment limit for this scan reached',
  'time-budget': 'attachment time budget used up',
  'vision-notice-pending': 'image reading waits for your OK on the notice',
  'vision-off': 'image reading is turned off',
  'vision-limit': 'image reading limit for this scan reached',
  'no-handle': 'Outlook showed no download link',
  'no-chip': 'the attachment was not found in the message',
  'bad-host': 'download link is not an Outlook https link',
  'service-endpoint': 'download link is a service endpoint (not used)',
  redirect: 'download redirected (not followed)',
  timeout: 'download took too long',
  'too-large': 'file is larger than the size limit',
  'http-error': 'download failed',
  'fetch-failed': 'download failed',
  'auth-wall': 'Outlook needs sign-in',
  'sensitive-content-withheld': 'text looked like credentials - not used',
  'reextract-exhausted': 'could not be read again after 3 tries',
  'not-found': 'the message could not be found again',
  'extract-failed': "couldn't read file",
});

function enabled(effective) { return !!(effective && effective.attachments === true); }

function _clamp(v, lo, hi, def) { return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.trunc(v))) : def; }

function policyOf(intelCfg) {
  const a = cfgMod.normalize(intelCfg).attachments || {};
  const allowed = (Array.isArray(a.allowedExt) ? a.allowedExt : cfgMod.DEFAULT_EXT).map((x) => String(x).toLowerCase().replace(/^\./, '')).filter(Boolean);
  return Object.freeze({
    allowedExt: Object.freeze(Array.from(new Set(allowed))),
    maxBytes: _clamp(a.maxBytes, 100_000, HARD.maxBytes, DEFAULTS.maxBytes),
    maxPerMessage: _clamp(a.maxPerMessage, 1, HARD.maxPerMessage, DEFAULTS.maxPerMessage),
    maxPerScan: _clamp(a.maxPerScan, 1, HARD.maxPerScan, DEFAULTS.maxPerScan),
    timeBudgetMs: _clamp(a.timeBudgetMs, 10_000, HARD.timeBudgetMs, DEFAULTS.timeBudgetMs),
    maxVision: _clamp(a.maxVision, 0, HARD.maxVision, DEFAULTS.maxVision),
    visionNoticeAcknowledged: a.visionNoticeAcknowledged === true,
    fetchTimeoutMs: FETCH_TIMEOUT_MS,
  });
}

/** F-28: no image bytes go to the vision reader before the one-time notice is acknowledged. */
function visionAllowance(policy) { return policy && policy.visionNoticeAcknowledged === true ? policy.maxVision : 0; }

function createBudget(policy, o) {
  const now = o && Number.isFinite(o.now) ? o.now : Date.now();
  const b = {
    policy, startedAt: now, deadline: now + policy.timeBudgetMs, used: 0,
    visionLeft: visionAllowance(policy), noticePending: policy.visionNoticeAcknowledged !== true,
    take() { b.used++; },
    remainingMs(at) { return b.deadline - (Number.isFinite(at) ? at : Date.now()); },
  };
  return b;
}

const isVisionExt = (ext) => VISION_EXT.includes(String(ext || '').toLowerCase());

/** Why an image / scanned PDF is not read: the notice is pending, image reading is off, or the per-scan limit. */
function visionReason(budget) {
  if (!budget || budget.noticePending) return 'vision-notice-pending';
  return budget.policy.maxVision === 0 ? 'vision-off' : 'vision-limit';
}

function decide(att, budget, o) {
  const opts = o || {};
  const a = att || {};
  if (!opts.flagOn) return { allow: false, status: 'filename-only', reason: 'flag-off' };
  if (!budget || !budget.policy) return { allow: false, status: 'filename-only', reason: 'flag-off' };
  const p = budget.policy;
  if (a.placeholder || !a.name) return { allow: false, status: 'filename-only', reason: 'no-name' };
  const ext = String(a.ext || String(a.name).split('.').pop() || '').toLowerCase().replace(/^\./, '');
  if (!p.allowedExt.includes(ext)) return { allow: false, status: 'skipped', reason: 'extension-not-allowed' };
  if (Number.isFinite(a.sizeBytes) && a.sizeBytes > p.maxBytes) return { allow: false, status: 'skipped', reason: 'over-size' };
  if (a.hasDownloadHandle !== true) return { allow: false, status: 'unreadable', reason: 'no-handle' };
  if ((opts.perMessageUsed || 0) >= p.maxPerMessage) return { allow: false, status: 'skipped', reason: 'message-limit' };
  if (budget.used >= p.maxPerScan) return { allow: false, status: 'skipped', reason: 'scan-limit' };
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (now >= budget.deadline) return { allow: false, status: 'skipped', reason: 'time-budget' };
  if (isVisionExt(ext) && budget.visionLeft <= 0) return { allow: false, status: 'skipped', reason: visionReason(budget) };
  return { allow: true, ext };
}

function reasonText(code) { return REASON_TEXT[code] || ''; }

module.exports = {
  HARD, DEFAULTS, VISION_EXT, FETCH_TIMEOUT_MS, REASON_TEXT,
  enabled, policyOf, visionAllowance, visionReason, createBudget, decide, isVisionExt, reasonText,
};
