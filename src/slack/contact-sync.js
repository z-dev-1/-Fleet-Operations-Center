'use strict';
/**
 * src/slack/contact-sync.js — Digital FAS Phase 5: Contact Book
 * auto-maintenance (spec #8/#9/#11/#15/#16).
 *
 * Orchestrates the enrichment -> classification -> policy -> Contact Book
 * pipeline for a Slack sender, as an AUTOMATED (non-operator) write so the
 * Phase 4 policy gate strips any trusted grant inference might produce:
 *
 *   enrich (TTL-gated)  ->  classify (identity-resolver)  ->  evaluate
 *   (permission-policy, confidence tiers)  ->  write to Contact Book
 *   (contact-book.upsert with { operator:false }).
 *
 * INVARIANTS (spec #8/#9/#14/#15/#16):
 *   - Authorization is resolved every message elsewhere; this only maintains
 *     the identity/metadata record — and never on every message (TTL-gated).
 *   - SAFE metadata (name/email/title/org/tz/image) is written immediately.
 *   - Permission changes follow the deterministic policy tier: AUTO_APPLY only
 *     the safe profile at >=0.95; SUGGEST (store proposal, keep conservative
 *     effective) at 0.75-0.949; DEFAULT (no widening) below.
 *   - trusted_autonomous is NEVER written from here (the contact-book sanitize
 *     gate downgrades it; this path always passes { operator:false }).
 *   - A prior operator-confirmed identity is never silently downgraded.
 *   - Every identity/permission change is logged with provenance (spec #16).
 */

let store; try { store = require('../store'); } catch (_) { store = null; }
let logger; try { logger = require('../utils/logger').createLogger('contact-sync'); } catch (_) { logger = { info() {}, warn() {} }; }

const CHANGE_LOG_KEY = 'slackIdentityChangeLog';
const CHANGE_LOG_CAP = 500;

function _req(p) { try { return require(p); } catch (_) { return null; } }

function _findContact(slackId) {
  if (!store) return null;
  try {
    const key = String(slackId).trim().toLowerCase();
    const contacts = store.load('contacts', []) || [];
    return contacts.find(c => c.slackId && String(c.slackId).trim().toLowerCase() === key) || null;
  } catch (_) { return null; }
}

function _logChange(entry) {
  if (!store) return;
  try {
    const log = store.load(CHANGE_LOG_KEY, []);
    const arr = Array.isArray(log) ? log : [];
    arr.unshift(Object.assign({ at: new Date().toISOString() }, entry));
    if (arr.length > CHANGE_LOG_CAP) arr.length = CHANGE_LOG_CAP;
    store.save(CHANGE_LOG_KEY, arr);
  } catch (e) { logger.warn('[contact-sync] change-log write failed: ' + e.message); }
}

/**
 * syncSender(slackId, opts) -> {
 *   ok, action: 'none'|'metadata'|'applied'|'suggested',
 *   enriched, tier, identityType, confidence, reason, error?
 * }
 *
 * opts: { force, ttlMs, highRiskAction, name, trustedActors }
 *   - force / ttlMs / highRiskAction : passed to the enrichment freshness gate.
 *   - name           : fallback display name for a first-contact create.
 *   - trustedActors  : operator-configured trusted map (only path to trusted).
 *
 * Best-effort; never throws. If enrichment is skipped (fresh), returns
 * action:'none'. The Contact Book remains the authority; resolveSender reads it.
 */
async function syncSender(slackId, opts) {
  opts = opts || {};
  if (!slackId) return { ok: false, error: 'slackId required' };
  const enrichMod = _req('./profile-enrichment');
  const idResolver = _req('./identity-resolver');
  const policy = _req('../orcha/fas/permission-policy');
  const contactBook = _req('../services/contact-book');
  if (!enrichMod || !idResolver || !policy || !contactBook) {
    return { ok: false, error: 'phase-5 dependencies unavailable' };
  }

  const existing = _findContact(slackId);

  // 1) ENRICH (TTL-gated). Skipped -> nothing to do this cycle.
  let er;
  try { er = await enrichMod.enrich(slackId, { contact: existing, force: opts.force, ttlMs: opts.ttlMs, highRiskAction: opts.highRiskAction, needClassification: true }); }
  catch (e) { return { ok: false, error: 'enrich failed: ' + e.message }; }
  if (!er || (!er.profile && er.skipped)) return { ok: true, action: 'none', enriched: false, reason: (er && er.reason) || 'fresh' };
  if (!er.ok || !er.profile) return { ok: false, error: (er && er.error) || 'enrichment failed', reason: er && er.reason };

  const profile = er.profile;

  // 2) CLASSIFY from the enriched profile + prior record (operator identity wins).
  const classification = idResolver.classify(profile, { existing });

  // 3) EVALUATE against the deterministic policy (confidence tiers + invariants).
  const verdict = policy.evaluate(classification, { trustedActors: opts.trustedActors });

  // 4) Build the Contact Book patch. SAFE metadata always applies. Permission/
  //    identity fields apply ONLY on AUTO_APPLY; SUGGEST stores a proposal
  //    WITHOUT changing effective permissions; DEFAULT changes nothing but metadata.
  const prevIdentity = existing ? (existing.identityType || 'unknown') : '(new)';
  const basePatch = {
    type: 'slack',
    slackId,
    name: (existing && existing.name) || profile.realName || profile.displayName || opts.name || slackId,
    // SAFE metadata (spec #16: apply immediately). Never blanks a populated field.
    email: profile.email || undefined,
    organization: profile.org || profile.organization || (verdict.profile && verdict.profile.organization) || undefined,
    title: profile.title || undefined,
    timezone: profile.timezone || undefined,
    imageUrl: profile.imageUrl || undefined,
    customFields: (profile.customFields && Object.keys(profile.customFields).length) ? profile.customFields : undefined,
    slackProfileRetrievedAt: profile.retrievedAt,
    identityEvidence: classification.evidence,
    identityConfidence: classification.confidence,
    permissionPolicyVersion: 1,
  };

  let action = 'metadata';
  let patch = Object.assign({}, basePatch);

  if (verdict.apply && verdict.tier === policy.TIER.AUTO) {
    // AUTO_APPLY: write the safe identity + permissions (policy already capped
    // trusted; contact-book gate also enforces operator:false).
    Object.assign(patch, {
      identityType: verdict.profile.identityType,
      operators: verdict.profile.operators,
      domiciles: verdict.profile.domiciles,
      allowedDataCategories: verdict.profile.allowedDataCategories,
      permittedRequestTypes: verdict.profile.permittedRequestTypes,
      lifecyclePermission: verdict.profile.lifecyclePermission,
      createWrPermission: verdict.profile.createWrPermission,
      permissionSource: 'auto-classified-v1',
    });
    action = 'applied';
  } else if (verdict.tier === policy.TIER.SUGGEST) {
    // SUGGEST: record the proposal; DO NOT change effective permissions.
    patch.suggestedIdentity = {
      identityType: verdict.suggestion.identityType,
      operators: verdict.suggestion.operators,
      domiciles: verdict.suggestion.domiciles,
      confidence: classification.confidence,
      evidence: classification.evidence,
      proposedAt: new Date().toISOString(),
    };
    action = 'suggested';
  }
  // DEFAULT tier: only the SAFE metadata patch (action stays 'metadata').

  // 5) WRITE as an AUTOMATED (non-operator) upsert — the Phase 4 contact-book
  //    gate strips any trusted_autonomous that slipped through (defense in depth).
  let res;
  try { res = contactBook.upsert(patch, { operator: false }); }
  catch (e) { return { ok: false, error: 'contact write failed: ' + e.message }; }
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'contact write not ok' };

  // 6) Provenance log (spec #16): old identity -> new, evidence, confidence,
  //    tier, what changed.
  const newIdentity = action === 'applied' ? verdict.profile.identityType : prevIdentity;
  if (action === 'applied' && prevIdentity !== newIdentity) {
    _logChange({ slackId, change: 'identity', from: prevIdentity, to: newIdentity,
      confidence: classification.confidence, tier: verdict.tier, evidence: classification.evidence, source: 'auto-classified-v1' });
  } else if (action === 'suggested') {
    _logChange({ slackId, change: 'identity-suggested', suggested: verdict.suggestion.identityType,
      confidence: classification.confidence, tier: verdict.tier, evidence: classification.evidence });
  }

  logger.info('[contact-sync] ' + slackId + ' -> ' + action + ' (tier=' + verdict.tier + ', type=' +
    (action === 'applied' ? verdict.profile.identityType : classification.identityType) + ', conf=' + classification.confidence.toFixed(2) + ')');

  return { ok: true, action, enriched: true, tier: verdict.tier,
    identityType: action === 'applied' ? verdict.profile.identityType : classification.identityType,
    confidence: classification.confidence, reason: er.reason, contactId: res.id };
}

/** Recent identity/permission change log (for the settings UI / audit). */
function getChangeLog(limit) {
  if (!store) return [];
  const log = store.load(CHANGE_LOG_KEY, []);
  const arr = Array.isArray(log) ? log : [];
  return arr.slice(0, limit || 100);
}

module.exports = { syncSender, getChangeLog, CHANGE_LOG_KEY };
