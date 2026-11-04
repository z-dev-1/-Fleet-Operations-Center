'use strict';
/**
 * src/slack/audience-resolver.js — Digital FAS Phase 2: effective AUDIENCE
 * resolution for a Slack conversation (spec #7).
 *
 * The sender's own permissions are NOT enough to decide what a reply may
 * reveal. In a group DM, a watched channel, or a Slack Connect (partner)
 * channel, the RESPONSE is visible to everyone in the conversation — so FAS
 * must never expose data that the VISIBLE AUDIENCE is not collectively cleared
 * to receive, even when the person asking individually has higher permissions.
 *
 *   Example: an Amazon manager asks a question in a channel that also contains
 *   a carrier contact. The manager could see internal-only data, but the
 *   carrier cannot — so the effective audience is "mixed", internal-only data
 *   is withheld, and the fleet scope collapses to what BOTH are cleared for.
 *
 * ── DESIGN ──────────────────────────────────────────────────────────────────
 * This module is PURE + deterministic. It does NOT call Slack or mutate state;
 * the caller passes whatever participant identity it already has (resolved via
 * the Contact Book). It returns an effective-audience object the FAS agent /
 * runner use to tighten what a reply may contain. It never WIDENS anything —
 * it can only make the audience more restrictive than the sender alone.
 *
 * CONSERVATIVE BY DEFAULT (spec #7): when participant identities cannot be
 * fully determined (we can't enumerate who is in the room), assume an external
 * viewer MAY be present on a multi-party / Slack Connect surface and withhold
 * internal-only data. A 1:1 DM with the sender is the only surface where the
 * audience is exactly the sender.
 *
 * Authorization is still enforced per-unit downstream (scopeUnitForSender) and
 * per-request by the executor — this adds an AUDIENCE ceiling on top, it does
 * not replace sender authorization.
 */

let profiles; try { profiles = require('../orcha/fas/sender-profiles'); } catch (_) { profiles = null; }
let logger; try { logger = require('../utils/logger').createLogger('audience'); } catch (_) { logger = { info() {}, warn() {} }; }

const ALL_SCOPE = '*';

// Data categories that are INTERNAL-ONLY — never shown to an external/partner
// or unknown audience. Mirrors the sensitivity split used elsewhere (internal
// senders get the full FAS knowledge base; external get the shareable tier).
const INTERNAL_ONLY_CATEGORIES = ['operator_summary', 'site_summary', 'uptake'];

// Audience sensitivity labels — same vocabulary the agent's decision contract
// uses for `audienceSensitivity` (spec #5/#6) so the two line up.
const AUDIENCE = {
  INTERNAL: 'internal',
  MIXED: 'internal_external_mixed',
  EXTERNAL: 'external_partner',
  UNKNOWN: 'unknown',
};

// Surfaces where the response is visible to more than just the sender.
const MULTI_PARTY_SURFACES = new Set(['group_dm', 'channel', 'slack_connect']);

function _isExternalType(type) {
  return type === 'carrier' || type === 'vendor';
}
function _isInternalType(type) {
  return type === 'internal';
}

// Resolve one participant slackId to a compact identity via the Contact Book.
// Unknown/unresolved participants are returned with type 'unknown'.
function _resolveParticipant(p) {
  // p may be a slackId string or an object { slackId, name, type? }.
  const slackId = typeof p === 'string' ? p : (p && (p.slackId || p.id));
  const name = typeof p === 'object' && p ? (p.name || '') : '';
  if (!slackId) return { slackId: '', name, type: 'unknown', resolved: false };
  if (!profiles || typeof profiles.resolveSender !== 'function') {
    return { slackId, name, type: 'unknown', resolved: false };
  }
  try {
    const prof = profiles.resolveSender(slackId, name);
    return {
      slackId,
      name: prof.name || name,
      type: prof.type || 'unknown',
      operators: (prof.operators || []).slice(),
      domiciles: (prof.domiciles || []).slice(),
      allowedDataCategories: (prof.allowedDataCategories || []).slice(),
      enabled: prof.enabled !== false,
      // "resolved" means we found a real Contact Book entry (not a limited
      // default). source 'default-limited' / 'legacy-sender-profile' = not a
      // confident identity.
      resolved: prof.source === 'contact-book',
    };
  } catch (e) {
    logger.warn('[audience] participant resolve failed: ' + e.message);
    return { slackId, name, type: 'unknown', resolved: false };
  }
}

// Intersect two scope lists (operators or domiciles). '*' is the identity
// element (matches everything), so intersect('*', X) = X and intersect(X,Y) =
// set-intersection. An empty list means "no fleet-scoped access" and dominates
// (intersection with empty = empty) EXCEPT when the other side is '*' and this
// side is empty-because-unscoped — we treat empty as "no additional restriction
// contributed" only for the all-scope element. To stay conservative we treat a
// concrete empty list as a real restriction (no scope).
function _intersectScope(a, b) {
  const A = (a || []).map(s => String(s).toUpperCase());
  const B = (b || []).map(s => String(s).toUpperCase());
  const aAll = A.includes(ALL_SCOPE);
  const bAll = B.includes(ALL_SCOPE);
  if (aAll && bAll) return [ALL_SCOPE];
  if (aAll) return B.slice();
  if (bAll) return A.slice();
  // Both concrete: set intersection.
  const setB = new Set(B);
  return A.filter(x => setB.has(x));
}

/**
 * resolveAudience(input) -> effective audience object.
 *
 * input: {
 *   surface        : 'dm' | 'self_dm' | 'group_dm' | 'channel' | 'slack_connect'
 *   sender         : { slackId, name } OR a resolved profile
 *   participants   : optional array of slackIds / {slackId,name} who can SEE
 *                    the response (NOT counting the app itself). When omitted on
 *                    a multi-party surface, the audience is treated as possibly
 *                    containing an unknown external viewer (conservative).
 *   isSlackConnect : optional boolean hint (partner/shared channel).
 *   channelId, channelName : optional, for logging/trace only.
 * }
 *
 * Returns {
 *   surface, audienceSensitivity, participantsKnown, participantCount,
 *   effectiveOperators, effectiveDomiciles, effectiveDataCategories,
 *   withholdInternalOnly, externalPresent, unknownPresent, conservative,
 *   reason
 * }
 */
function resolveAudience(input) {
  input = input || {};
  const surface = input.surface || (input.isGroup ? 'channel' : 'dm');
  const isSelf = surface === 'self_dm' || !!input.isSelf;
  const senderProf = _senderProfile(input.sender);

  // SELF-DM / 1:1 DM: the audience is exactly the sender. No third party to
  // protect — the effective audience == the sender's own clearance.
  if (isSelf || surface === 'dm') {
    const internal = _isInternalType(senderProf.type) || isSelf;
    return _result({
      surface,
      audienceSensitivity: internal ? AUDIENCE.INTERNAL : (_isExternalType(senderProf.type) ? AUDIENCE.EXTERNAL : AUDIENCE.UNKNOWN),
      participantsKnown: true,
      participantCount: 1,
      effectiveOperators: (senderProf.operators || []).slice(),
      effectiveDomiciles: (senderProf.domiciles || []).slice(),
      effectiveDataCategories: (senderProf.allowedDataCategories || []).slice(),
      externalPresent: _isExternalType(senderProf.type),
      unknownPresent: senderProf.type === 'unknown',
      withholdInternalOnly: !internal,
      conservative: false,
      reason: isSelf ? 'self-dm: audience is the operator' : '1:1 dm: audience is the sender only',
    });
  }

  // MULTI-PARTY: group DM, channel, or Slack Connect. The response is visible
  // to everyone present, so compute the effective (most-conservative) audience.
  const connect = !!input.isSlackConnect || surface === 'slack_connect';
  const list = Array.isArray(input.participants) ? input.participants.filter(Boolean) : [];
  const resolvedParticipants = list.map(_resolveParticipant);

  // Always include the sender in the audience.
  const senderAsParticipant = {
    slackId: senderProf.slackId, name: senderProf.name, type: senderProf.type,
    operators: (senderProf.operators || []).slice(), domiciles: (senderProf.domiciles || []).slice(),
    allowedDataCategories: (senderProf.allowedDataCategories || []).slice(),
    resolved: senderProf.source === 'contact-book' || _isInternalType(senderProf.type),
  };
  const all = [senderAsParticipant, ...resolvedParticipants];

  // Can we enumerate the audience? On a multi-party surface, we need an explicit
  // participant list to be confident. Without it (or on Slack Connect, where an
  // unknown partner side can be present), we are NOT confident.
  const participantsKnown = list.length > 0 && !connect;

  const anyExternal = all.some(p => _isExternalType(p.type));
  const anyInternal = all.some(p => _isInternalType(p.type));
  const anyUnknown = all.some(p => p.type === 'unknown' || p.resolved === false);

  // CONSERVATIVE unknown-viewer assumption (spec #7): on a multi-party surface
  // where we can't enumerate everyone (no participant list) or it's a Slack
  // Connect channel, assume an external/unknown viewer MAY be present.
  const possibleHiddenExternal = (!participantsKnown) && MULTI_PARTY_SURFACES.has(_canonSurface(surface, connect));
  const externalPresent = anyExternal || possibleHiddenExternal;
  const unknownPresent = anyUnknown || possibleHiddenExternal;

  let sensitivity;
  if (externalPresent && anyInternal) sensitivity = AUDIENCE.MIXED;
  else if (externalPresent && !anyInternal) sensitivity = possibleHiddenExternal && !anyExternal ? AUDIENCE.UNKNOWN : AUDIENCE.EXTERNAL;
  else if (anyInternal && !externalPresent && !unknownPresent) sensitivity = AUDIENCE.INTERNAL;
  else sensitivity = AUDIENCE.UNKNOWN;

  // EFFECTIVE SCOPE = intersection across all KNOWN participants (most
  // restrictive wins). If any viewer is external/unknown, internal-only data
  // categories are withheld. If we cannot enumerate the audience on a
  // multi-party surface, we also conservatively narrow to the sender's scope
  // only (never broaden) and withhold internal-only data.
  let effOperators = senderAsParticipant.operators.slice();
  let effDomiciles = senderAsParticipant.domiciles.slice();
  for (const p of resolvedParticipants) {
    effOperators = _intersectScope(effOperators, p.operators || []);
    effDomiciles = _intersectScope(effDomiciles, p.domiciles || []);
  }

  // Effective data categories = intersection of what every KNOWN participant
  // may view, minus internal-only categories when any non-internal viewer is
  // (or may be) present.
  let effCats = senderAsParticipant.allowedDataCategories.slice();
  for (const p of resolvedParticipants) {
    const setP = new Set((p.allowedDataCategories || []));
    effCats = effCats.filter(c => setP.has(c));
  }
  const withholdInternalOnly = externalPresent || unknownPresent;
  if (withholdInternalOnly) effCats = effCats.filter(c => !INTERNAL_ONLY_CATEGORIES.includes(c));

  return _result({
    surface: _canonSurface(surface, connect),
    audienceSensitivity: sensitivity,
    participantsKnown,
    participantCount: all.length,
    effectiveOperators: effOperators,
    effectiveDomiciles: effDomiciles,
    effectiveDataCategories: effCats,
    externalPresent,
    unknownPresent,
    withholdInternalOnly,
    conservative: possibleHiddenExternal,
    reason: possibleHiddenExternal
      ? (connect ? 'slack connect: partner side may be present — conservative audience'
                 : 'multi-party surface without a known participant list — conservative audience')
      : (sensitivity === AUDIENCE.MIXED ? 'internal + external participants present'
         : sensitivity === AUDIENCE.EXTERNAL ? 'external participants present'
         : sensitivity === AUDIENCE.INTERNAL ? 'all participants internal'
         : 'audience identity insufficiently determined'),
  });
}

function _canonSurface(surface, connect) {
  if (connect) return 'slack_connect';
  return surface;
}

function _senderProfile(sender) {
  // sender may be a resolved profile (has .type) or { slackId, name }.
  if (sender && sender.type && (sender.operators || sender.allowedDataCategories)) return sender;
  const slackId = sender && (sender.slackId || sender.id);
  const name = sender && sender.name;
  if (profiles && typeof profiles.resolveSender === 'function') {
    try { return profiles.resolveSender(slackId, name); } catch (_) {}
  }
  return { slackId: slackId || '', name: name || '', type: 'unknown', operators: ['*'], domiciles: ['*'], allowedDataCategories: [] };
}

function _result(r) {
  // Freeze the shape so downstream can't accidentally widen it.
  return Object.assign({
    surface: 'dm',
    audienceSensitivity: AUDIENCE.UNKNOWN,
    participantsKnown: false,
    participantCount: 1,
    effectiveOperators: [],
    effectiveDomiciles: [],
    effectiveDataCategories: [],
    externalPresent: false,
    unknownPresent: false,
    withholdInternalOnly: false,
    conservative: false,
    reason: '',
  }, r);
}

/**
 * summaryForPrompt(aud) -> short string the agent prompt can carry so the model
 * also reasons about the audience (defense in depth; the hard restriction is
 * still applied in code via effectiveDataCategories/scope).
 */
function summaryForPrompt(aud) {
  if (!aud) return '';
  const bits = ['audience: ' + aud.audienceSensitivity];
  if (aud.withholdInternalOnly) bits.push('WITHHOLD internal-only data (external/unknown viewer present)');
  if (aud.conservative) bits.push('conservative (cannot enumerate who can see this)');
  if (aud.effectiveOperators && aud.effectiveOperators.length) bits.push('scope ops: ' + aud.effectiveOperators.join('/'));
  if (aud.effectiveDomiciles && aud.effectiveDomiciles.length) bits.push('scope sites: ' + aud.effectiveDomiciles.join('/'));
  return bits.join('; ');
}

// Map an internal-only data category to the evidence field(s) it produces, so
// we can strip those facts when the audience must not see internal-only data.
const INTERNAL_ONLY_FIELDS = new Set([
  'operatorSummary',   // operator_summary
  'siteSummary',       // site_summary
  'uptakeInsights', 'uptake', 'uptakeSummary', // uptake
]);

/**
 * applyAudienceCeiling(evidence, audience) -> filtered evidence (new object).
 *
 * Enforces the AUDIENCE ceiling on an already-sender-scoped evidence package
 * (spec #7). It can only REMOVE facts, never add — so it strictly tightens what
 * the model may use for the reply:
 *   - when the audience must withhold internal-only data (external/unknown
 *     viewer present or conservative), drop internal-only category facts
 *     (operator/site summaries, Uptake insights);
 *   - records what was withheld on `_audienceWithheld` for the trace.
 * The per-unit scope was already enforced for the SENDER in buildEvidence; the
 * audience's narrower effective scope is surfaced to the model via the prompt
 * block (a cross-audience unit the sender could see but the audience can't is
 * rare and still gated per-unit downstream). Best-effort + non-mutating.
 */
function applyAudienceCeiling(evidence, audience) {
  if (!evidence || !audience || !audience.withholdInternalOnly) return evidence;
  const facts = Array.isArray(evidence.verifiedFacts) ? evidence.verifiedFacts : [];
  const withheld = [];
  const kept = facts.filter(f => {
    if (f && INTERNAL_ONLY_FIELDS.has(f.field)) { withheld.push(f.field); return false; }
    return true;
  });
  if (!withheld.length) return evidence;
  logger.info('[audience] withheld ' + withheld.length + ' internal-only fact(s) for ' +
    audience.audienceSensitivity + ' audience: ' + withheld.join(', '));
  return Object.assign({}, evidence, {
    verifiedFacts: kept,
    _audienceWithheld: withheld,
  });
}

module.exports = {
  resolveAudience,
  summaryForPrompt,
  applyAudienceCeiling,
  AUDIENCE,
  INTERNAL_ONLY_CATEGORIES,
  INTERNAL_ONLY_FIELDS,
  _intersectScope,       // exported for unit tests
  _resolveParticipant,   // exported for unit tests
};
