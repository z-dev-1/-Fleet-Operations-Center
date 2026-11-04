'use strict';
/**
 * src/slack/identity-resolver.js — Digital FAS Phase 5: automatic identity
 * CLASSIFICATION from enriched Slack profile + known mappings (spec #11).
 *
 * Turns an enriched Slack profile (slack/profile-enrichment) into a
 * CLASSIFICATION the deterministic permission policy can act on:
 *   { identityType, role, organization, operators, domiciles, vendor,
 *     confidence, evidence: [..] }
 *
 * This module only CLASSIFIES — it assigns NO permissions (spec #11). The
 * permission-policy engine decides what a verified category may do, and the
 * Contact Book remains the authority. Classification confidence drives the
 * policy's auto-apply / suggest / default tiers, and (critically) the policy
 * never lets classification grant trusted autonomy no matter how confident.
 *
 * Signals used (only what is ACTUALLY available; nothing invented):
 *   - verified email domain (amazon.com -> internal; a known carrier/vendor
 *     domain -> that category)
 *   - org/company text
 *   - job title keywords
 *   - known SCAC / domicile / vendor mappings (operator-maintained config)
 *   - account flags (bot/app, deactivated, guest/restricted)
 */

let logger; try { logger = require('../utils/logger').createLogger('identity-resolver'); } catch (_) { logger = { info() {}, warn() {} }; }
let store; try { store = require('../store'); } catch (_) { store = null; }

const INTERNAL_EMAIL = /@amazon\.com$/i;
const INTERNAL_ORG = /amazon/i;

// Title keywords that suggest an internal fleet/ops role (weak signal only).
const INTERNAL_TITLE = /(fleet|operations|logistics|asset|dispatch|program|site|amazon)/i;
const VENDOR_TITLE = /(mechanic|technician|service advisor|shop|repair|dealer|parts)/i;
const CARRIER_TITLE = /(driver|carrier|owner.?operator|dsp|delivery)/i;

// Load operator-maintained mappings (optional). SCAC/domicile/vendor-domain maps
// let a carrier/vendor be classified confidently from a verified email domain.
function _mappings() {
  const empty = { carrierDomains: {}, vendorDomains: {}, scacByDomain: {}, domicilesByDomain: {} };
  if (!store) return empty;
  try {
    const m = store.load('slackIdentityMappings', empty);
    return (m && typeof m === 'object') ? Object.assign({}, empty, m) : empty;
  } catch (_) { return empty; }
}

/**
 * classify(profile, opts) -> classification
 * profile: an enriched Slack profile (from profile-enrichment / fetchUserProfile)
 *          OR a minimal { slackId, email, org, title }.
 * opts: { existing } — an existing Contact Book record (prior operator-confirmed
 *        identity OUTRANKS inference; spec #10/#11/#65).
 */
function classify(profile, opts) {
  profile = profile || {};
  opts = opts || {};
  const evidence = [];
  const email = String(profile.email || '').toLowerCase();
  const domain = profile.emailDomain || (email.includes('@') ? email.split('@')[1] : '');
  const org = String(profile.org || profile.organization || '').trim();
  const title = String(profile.title || '').trim();
  const maps = _mappings();

  // PRIOR OPERATOR IDENTITY WINS (spec #10/#65). If the Contact Book already has
  // an operator-set identity, classification defers to it with full confidence
  // but NEVER escalates permissions (that's the policy's job).
  const existing = opts.existing || null;
  if (existing && existing.identityType && existing.permissionSource &&
      /operator|ui-edited|manual/i.test(String(existing.permissionSource))) {
    evidence.push('operator-confirmed identity in Contact Book');
    return _result(existing.identityType, {
      role: existing.role, organization: existing.organization || org,
      operators: existing.operators, domiciles: existing.domiciles, vendor: existing.vendor,
      confidence: 1.0, evidence, slackId: profile.slackId,
    });
  }

  // Deactivated / bot / app accounts -> unknown, low confidence (don't act).
  if (profile.deleted) { evidence.push('account deactivated'); return _result('unknown', { confidence: 0.2, evidence, slackId: profile.slackId }); }
  if (profile.isBot || profile.isAppUser) { evidence.push('bot/app account'); return _result('unknown', { confidence: 0.2, evidence, slackId: profile.slackId }); }

  // ── INTERNAL: verified @amazon.com email is the strongest safe signal. ─────
  if (domain && INTERNAL_EMAIL.test('@' + domain)) {
    evidence.push('verified email domain @' + domain + ' (Amazon)');
    // A restricted/guest account on the Amazon workspace is NOT a full internal
    // employee — keep it lower confidence so it SUGGESTS rather than auto-applies.
    const conf = (profile.isRestricted || profile.isUltraRestricted) ? 0.8 : 0.96;
    if (profile.isRestricted || profile.isUltraRestricted) evidence.push('guest/restricted account — not full internal');
    return _result('internal', { organization: 'Amazon', role: 'internal', confidence: conf, evidence, slackId: profile.slackId });
  }

  // ── CARRIER / VENDOR by known domain mapping (operator-maintained). ────────
  if (domain && maps.vendorDomains[domain]) {
    evidence.push('known vendor domain @' + domain + ' -> ' + maps.vendorDomains[domain]);
    return _result('vendor', { vendor: maps.vendorDomains[domain], organization: maps.vendorDomains[domain],
      domiciles: maps.domicilesByDomain[domain] || [], confidence: 0.95, evidence, slackId: profile.slackId });
  }
  if (domain && maps.carrierDomains[domain]) {
    evidence.push('known carrier domain @' + domain + ' -> ' + maps.carrierDomains[domain]);
    return _result('carrier', { organization: maps.carrierDomains[domain],
      operators: maps.scacByDomain[domain] || [], domiciles: maps.domicilesByDomain[domain] || [],
      confidence: 0.95, evidence, slackId: profile.slackId });
  }

  // ── ORG / TITLE heuristics (WEAK — SUGGEST tier at most). ─────────────────
  if (org && INTERNAL_ORG.test(org)) {
    evidence.push('org text mentions Amazon: "' + org + '"');
    return _result('internal', { organization: org, confidence: 0.82, evidence, slackId: profile.slackId });
  }
  if (title) {
    if (VENDOR_TITLE.test(title)) { evidence.push('title suggests vendor/shop: "' + title + '"'); return _result('vendor', { organization: org, confidence: 0.78, evidence, slackId: profile.slackId }); }
    if (CARRIER_TITLE.test(title)) { evidence.push('title suggests carrier/driver: "' + title + '"'); return _result('carrier', { organization: org, confidence: 0.78, evidence, slackId: profile.slackId }); }
    if (INTERNAL_TITLE.test(title)) { evidence.push('title suggests internal ops: "' + title + '"'); return _result('internal', { organization: org, confidence: 0.78, evidence, slackId: profile.slackId }); }
  }

  // External email domain with no mapping -> likely external, but which? Low
  // confidence so the policy keeps it at the conservative default.
  if (domain && !INTERNAL_EMAIL.test('@' + domain)) {
    evidence.push('external email domain @' + domain + ' (no known mapping)');
    return _result('unknown', { organization: org, confidence: 0.55, evidence, slackId: profile.slackId });
  }

  // Nothing to go on.
  evidence.push('no classifying signal (no verified email/org/title)');
  return _result('unknown', { confidence: 0.3, evidence, slackId: profile.slackId });
}

function _result(identityType, extra) {
  return Object.assign({
    identityType,
    role: '',
    organization: '',
    operators: [],
    domiciles: [],
    vendor: '',
    confidence: 0.3,
    evidence: [],
    slackId: '',
  }, extra || {}, { identityType });
}

module.exports = { classify, _mappings };
