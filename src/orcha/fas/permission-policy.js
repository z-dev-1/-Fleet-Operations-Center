'use strict';
/**
 * orcha/fas/permission-policy.js — Digital FAS Phase 4: DETERMINISTIC
 * permission policy engine (spec #10–#16).
 *
 * Separates the three concerns the spec is explicit about:
 *   Slack data        -> "who does this person APPEAR to be?"           (enrichment)
 *   AI classification -> "what category/role does the EVIDENCE suggest?" (a guess)
 *   THIS module       -> "what is someone in a VERIFIED category ALLOWED to do?"
 *   Contact Book      -> the final effective authorization record.
 *
 * This engine is PURE + deterministic. Given a CLASSIFICATION
 * ({ identityType, confidence, evidence, operators, domiciles, vendor, org }),
 * it returns a SAFE permission profile plus a disposition that says whether the
 * classification is strong enough to AUTO-APPLY, should be saved as a
 * conservative SUGGESTION for review, or must be left at the UNKNOWN default.
 *
 * ── HARD INVARIANTS (enforced here, spec #14) ────────────────────────────────
 *   - AI classification can NEVER directly grant permissions. This module maps a
 *     VERIFIED category to a SAFE profile; the caller still writes it to the
 *     Contact Book, and the Contact Book + resolveSender remain the authority.
 *   - trusted_autonomous for lifecycle OR work-request creation is NEVER
 *     produced from classification at ANY confidence. It can only come from an
 *     explicit operator-configured trusted mapping (trustedActors) or operator
 *     approval. Classification tops out at 'may_request'.
 *   - vendor identity is LOCKED to not_allowed for lifecycle + create_wr.
 *   - unknown / low-confidence stays conservative (never widened).
 */

let logger; try { logger = require('../../utils/logger').createLogger('fas-policy'); } catch (_) { logger = { info() {}, warn() {} }; }

const VALID_TYPES = ['internal', 'carrier', 'vendor', 'unknown'];
const DATA_CATEGORIES = ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'];
const REQUEST_TYPES = ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'];
const THREE_STATE = ['not_allowed', 'may_request', 'trusted_autonomous'];
const ALL_SCOPE = '*';

// ── CONFIDENCE TIERS (spec #12) ──────────────────────────────────────────────
//   >= 0.95         : AUTO_APPLY  — apply the SAFE identity metadata + safe
//                     permission profile automatically.
//   0.75 .. 0.949   : SUGGEST     — save the classification as a SUGGESTION,
//                     use conservative permissions, surface for review.
//   < 0.75          : DEFAULT      — keep unknown/default behavior; do NOT widen.
const TIER = { AUTO: 'auto_apply', SUGGEST: 'suggest', DEFAULT: 'default' };
const AUTO_APPLY_MIN = 0.95;
const SUGGEST_MIN = 0.75;

function tierForConfidence(confidence) {
  const c = typeof confidence === 'number' ? confidence : 0;
  if (c >= AUTO_APPLY_MIN) return TIER.AUTO;
  if (c >= SUGGEST_MIN) return TIER.SUGGEST;
  return TIER.DEFAULT;
}

function _three(v) { return THREE_STATE.includes(v) ? v : 'not_allowed'; }
function _normScope(arr) {
  const out = Array.from(new Set((arr || []).map(s => String(s).trim()).filter(Boolean)
    .map(s => s === ALL_SCOPE ? ALL_SCOPE : s.toUpperCase())));
  return out.includes(ALL_SCOPE) ? [ALL_SCOPE] : out;
}

/**
 * Default SCOPE for a verified identity type (mirrors sender-profiles):
 *   internal        -> all-scope ('*') by default (editable to specific SCAC/site)
 *   carrier/vendor  -> EMPTY (no fleet data until explicitly scoped)
 *   unknown         -> all-scope ('*') (most unknown senders are internal), but
 *                      with lifecycle/WR locked off.
 */
function _defaultScopeFor(type) {
  return (type === 'internal' || type === 'unknown') ? [ALL_SCOPE] : [];
}

/**
 * basePermissionsFor(type) -> the SAFE ceiling for a VERIFIED category. Data
 * access is governed by scope, so every type may VIEW all categories + make all
 * request types; the meaningful controls are the two 3-state action fields,
 * which classification can set NO HIGHER than 'may_request' (never trusted).
 */
function basePermissionsFor(type) {
  const t = VALID_TYPES.includes(type) ? type : 'unknown';
  return {
    allowedDataCategories: DATA_CATEGORIES.slice(),
    permittedRequestTypes: REQUEST_TYPES.slice(),
    // Action permissions from CLASSIFICATION never exceed may_request, and are
    // not_allowed for vendor/unknown. Even an internal auto-classification only
    // reaches may_request — trusted autonomy requires an operator trusted map.
    lifecyclePermission: 'not_allowed',
    createWrPermission: 'not_allowed',
  };
}

/**
 * evaluate(classification, options) -> {
 *   tier, apply (boolean), identityType, confidence,
 *   profile: { identityType, operators, domiciles, allowedDataCategories,
 *              permittedRequestTypes, lifecyclePermission, createWrPermission },
 *   suggestion: same shape when tier===SUGGEST (not auto-applied),
 *   reasons: [..], evidence: [..], source
 * }
 *
 * classification: { identityType, confidence, evidence?, operators?, domiciles?,
 *                   vendor?, org? }  — typically produced by AI/heuristics.
 * options: { trustedActors? }  — an OPERATOR-configured map of slackId ->
 *   { lifecyclePermission, createWrPermission } that MAY grant trusted_autonomous
 *   deterministically (the ONLY path to trusted autonomy; spec #14).
 */
function evaluate(classification, options) {
  classification = classification || {};
  options = options || {};
  const identityType = VALID_TYPES.includes(classification.identityType) ? classification.identityType : 'unknown';
  const confidence = typeof classification.confidence === 'number' ? Math.max(0, Math.min(1, classification.confidence)) : 0;
  const tier = tierForConfidence(confidence);
  const evidence = Array.isArray(classification.evidence) ? classification.evidence.slice(0, 20) : [];
  const reasons = [];

  // Scope: use provided (verified) scope, else the type default.
  let operators = _normScope(classification.operators);
  let domiciles = _normScope(classification.domiciles);
  if (!operators.length && !domiciles.length) {
    const def = _defaultScopeFor(identityType);
    operators = def.slice(); domiciles = def.slice();
  }

  const base = basePermissionsFor(identityType);
  const profile = {
    identityType,
    operators,
    domiciles,
    allowedDataCategories: base.allowedDataCategories,
    permittedRequestTypes: base.permittedRequestTypes,
    lifecyclePermission: base.lifecyclePermission,   // not_allowed (classification never trusts)
    createWrPermission: base.createWrPermission,      // not_allowed
  };

  // DETERMINISTIC TRUSTED MAPPING (spec #13/#14): the ONLY way classification
  // output carries trusted autonomy is an explicit operator-configured entry
  // for this exact slackId. Vendors are still hard-locked below.
  const slackId = classification.slackId || '';
  const trusted = options.trustedActors && slackId ? options.trustedActors[slackId] : null;
  if (trusted) {
    profile.lifecyclePermission = _three(trusted.lifecyclePermission);
    profile.createWrPermission = _three(trusted.createWrPermission);
    reasons.push('operator-configured trusted mapping applied for ' + slackId);
  }

  // VENDOR LOCK (spec #13): never lifecycle / create_wr, regardless of anything.
  if (identityType === 'vendor') {
    profile.lifecyclePermission = 'not_allowed';
    profile.createWrPermission = 'not_allowed';
    reasons.push('vendor identity — lifecycle + create-WR locked to not_allowed');
  }

  // TIER DISPOSITION.
  let apply = false;
  if (tier === TIER.AUTO) {
    apply = true;
    reasons.push('confidence ' + confidence.toFixed(2) + ' >= ' + AUTO_APPLY_MIN + ' — auto-apply safe profile');
  } else if (tier === TIER.SUGGEST) {
    apply = false;
    reasons.push('confidence ' + confidence.toFixed(2) + ' in [' + SUGGEST_MIN + ',' + AUTO_APPLY_MIN + ') — SUGGEST only, conservative permissions, needs review');
  } else {
    apply = false;
    reasons.push('confidence ' + confidence.toFixed(2) + ' < ' + SUGGEST_MIN + ' — keep UNKNOWN default, do not widen');
  }

  // For the DEFAULT tier, the safe answer is the conservative unknown profile
  // (all-scope read, no actions) — never a carrier/vendor narrowing that could
  // be wrong, and never a widened trust.
  const result = {
    tier,
    apply,
    identityType: tier === TIER.DEFAULT ? 'unknown' : identityType,
    confidence,
    profile: tier === TIER.DEFAULT ? _unknownProfile() : profile,
    reasons,
    evidence,
    source: 'permission-policy',
  };
  // When only suggesting, expose the proposed profile separately so the caller
  // stores it as a suggestion WITHOUT applying it as the effective permission.
  if (tier === TIER.SUGGEST) {
    result.suggestion = profile;
    result.profile = _unknownProfile(); // effective stays conservative until reviewed
  }
  return result;
}

// The conservative UNKNOWN profile: broad read (all-scope), NO actions. Matches
// sender-profiles' limited default intent.
function _unknownProfile() {
  return {
    identityType: 'unknown',
    operators: [ALL_SCOPE],
    domiciles: [ALL_SCOPE],
    allowedDataCategories: DATA_CATEGORIES.slice(),
    permittedRequestTypes: REQUEST_TYPES.slice(),
    lifecyclePermission: 'not_allowed',
    createWrPermission: 'not_allowed',
  };
}

/**
 * canGrantTrusted(source) -> boolean
 * The single gate for whether a given SOURCE is allowed to set
 * trusted_autonomous. Only an explicit operator action or operator-configured
 * trusted mapping qualifies — never AI/classification/inference (spec #14).
 */
function canGrantTrusted(source) {
  return source === 'operator' || source === 'operator_trusted_map';
}

/**
 * sanitizeContactPermissionWrite(patch, source) -> safe patch
 * Defense-in-depth for ANY write of permission fields to the Contact Book: if
 * the write did not come from an operator, strip trusted_autonomous down to
 * may_request so inference/automation can never persist trusted autonomy.
 */
function sanitizeContactPermissionWrite(patch, source) {
  const out = { ...(patch || {}) };
  if (canGrantTrusted(source)) return out; // operator may set anything valid
  for (const f of ['lifecyclePermission', 'createWrPermission']) {
    if (out[f] === 'trusted_autonomous') {
      out[f] = 'may_request';
      logger.info('[fas-policy] downgraded ' + f + ' trusted_autonomous -> may_request (non-operator source: ' + (source || 'unknown') + ')');
    }
  }
  return out;
}

module.exports = {
  evaluate,
  tierForConfidence,
  basePermissionsFor,
  canGrantTrusted,
  sanitizeContactPermissionWrite,
  TIER, AUTO_APPLY_MIN, SUGGEST_MIN,
  VALID_TYPES, DATA_CATEGORIES, REQUEST_TYPES, THREE_STATE,
};
