'use strict';
/**
 * src/slack/profile-enrichment.js — Digital FAS Phase 5: Slack profile
 * enrichment with a FRESHNESS policy (spec #8/#9).
 *
 * Separates IDENTITY ENRICHMENT from AUTHORIZATION (spec #9):
 *   - Authorization is resolved EVERY message (sender-profiles.resolveSender,
 *     from the Contact Book — unchanged, cheap, local).
 *   - Slack profile enrichment does NOT hit Slack every message. It runs only
 *     on FIRST CONTACT, when the stored profile is STALE (TTL), or on a FORCE
 *     refresh (missing identity-critical fields, or a high-risk action needs
 *     stronger identity confidence).
 *
 * This module decides WHETHER to enrich and performs the fetch; it does NOT
 * classify (identity-resolver) or assign permissions (permission-policy). The
 * actual Contact Book write is orchestrated by contact-sync.
 */

let store; try { store = require('../store'); } catch (_) { store = null; }
let logger; try { logger = require('../utils/logger').createLogger('profile-enrich'); } catch (_) { logger = { info() {}, warn() {} }; }

// Default TTL for a cached Slack profile (spec #9: ~24h).
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Identity-critical fields — if any are missing, a force refresh is warranted
// when the information is needed for classification (spec #9).
const CRITICAL_FIELDS = ['email', 'title', 'org'];

function _now() { return Date.now(); }
function _slackSend() { try { return require('../scrapers/slack_send'); } catch (_) { return null; } }

/**
 * freshnessOf(contact) -> { hasProfile, retrievedAt, ageMs, stale }
 * Reads the enrichment timestamp a prior sync stored on the contact.
 */
function freshnessOf(contact, ttlMs) {
  const ttl = typeof ttlMs === 'number' ? ttlMs : DEFAULT_TTL_MS;
  const at = contact && (contact.slackProfileRetrievedAt || contact.profileRetrievedAt);
  if (!at) return { hasProfile: false, retrievedAt: null, ageMs: Infinity, stale: true };
  const ts = Date.parse(at);
  if (isNaN(ts)) return { hasProfile: false, retrievedAt: at, ageMs: Infinity, stale: true };
  const ageMs = _now() - ts;
  return { hasProfile: true, retrievedAt: at, ageMs, stale: ageMs > ttl };
}

/**
 * shouldEnrich(contact, opts) -> { enrich, reason }
 * Decides whether a Slack profile fetch is warranted (spec #9):
 *   - FIRST CONTACT (no stored profile) -> yes
 *   - STALE (older than TTL) -> yes
 *   - MISSING identity-critical field needed for classification -> yes
 *   - FORCE (operator request / high-risk action requires stronger identity) -> yes
 *   - otherwise -> no (use the Contact Book immediately; spec #9)
 */
function shouldEnrich(contact, opts) {
  opts = opts || {};
  if (opts.force) return { enrich: true, reason: 'force' };
  const fresh = freshnessOf(contact, opts.ttlMs);
  if (!fresh.hasProfile) return { enrich: true, reason: 'first-contact' };
  if (fresh.stale) return { enrich: true, reason: 'stale (' + Math.round(fresh.ageMs / 3600000) + 'h old)' };
  // Missing a critical field that classification needs.
  if (opts.needClassification) {
    const missing = CRITICAL_FIELDS.filter(f => !contact || !String(contact[f] || contact[f === 'org' ? 'organization' : f] || '').trim());
    if (missing.length) return { enrich: true, reason: 'missing critical field(s): ' + missing.join(', ') };
  }
  // High-risk action requires stronger identity confidence (spec #9).
  if (opts.highRiskAction) return { enrich: true, reason: 'high-risk action needs identity confidence' };
  return { enrich: false, reason: 'fresh profile within TTL' };
}

/**
 * enrich(slackId, opts) -> { ok, profile?, skipped?, reason, error? }
 * Fetches the full Slack profile via the authenticated session. Best-effort;
 * never throws. Returns skipped:true when a fetch isn't warranted (the caller
 * then uses the existing Contact Book record).
 */
async function enrich(slackId, opts) {
  opts = opts || {};
  if (!slackId) return { ok: false, error: 'slackId required' };
  const contact = opts.contact || _findContact(slackId);
  const decision = shouldEnrich(contact, opts);
  if (!decision.enrich) return { ok: true, skipped: true, reason: decision.reason, profile: null };
  const ss = _slackSend();
  if (!ss || typeof ss.fetchUserProfile !== 'function') {
    return { ok: false, skipped: false, reason: decision.reason, error: 'slack profile fetch unavailable (non-app context)' };
  }
  let profile;
  try { profile = await ss.fetchUserProfile(slackId); }
  catch (e) { return { ok: false, reason: decision.reason, error: 'users.info failed: ' + e.message }; }
  if (!profile) return { ok: false, reason: decision.reason, error: 'no profile returned' };
  logger.info('[profile-enrich] enriched ' + slackId + ' (' + decision.reason + ')' + (profile.email ? ' email=' + profile.email : ''));
  return { ok: true, skipped: false, reason: decision.reason, profile };
}

function _findContact(slackId) {
  if (!store) return null;
  try {
    const key = String(slackId).trim().toLowerCase();
    const contacts = store.load('contacts', []) || [];
    return contacts.find(c => c.slackId && String(c.slackId).trim().toLowerCase() === key) || null;
  } catch (_) { return null; }
}

module.exports = { enrich, shouldEnrich, freshnessOf, DEFAULT_TTL_MS, CRITICAL_FIELDS };
