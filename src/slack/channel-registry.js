'use strict';
/**
 * src/slack/channel-registry.js — Digital FAS Phase 3: channel-ROLE registry
 * + information-feed classification (spec #45–#50, #60, #61, #64).
 *
 * Some Slack channels are CONVERSATIONS (people ask FAS things and expect a
 * reply); others are DATA FEEDS (vendor repair updates, PM alerts, system
 * notices) where a human FAS READS and acts on the information but does NOT
 * reply to every post. Treating a feed like a conversation makes FAS a noisy
 * bot; ignoring a feed loses operational signal. This registry lets FAS tell
 * them apart and behave correctly for each.
 *
 * ── MODES (spec #45) ─────────────────────────────────────────────────────────
 *   CONVERSATIONAL  — normal human conversation; reply when relevant.
 *   OPERATIONAL     — ops coordination; reply when relevant, ingest signal too.
 *   INFORMATION_FEED— data posts; INGEST silently, reply only if directly asked.
 *   ALERT_FEED      — automated alerts; ingest, reply only if directly asked.
 *   VENDOR_FEED     — vendor status updates; ingest, reply only if directly asked.
 *   SYSTEM_FEED     — system-generated notices; ingest, reply only if asked.
 *   MIXED           — both conversation and data; reply when relevant + ingest.
 *
 * ── SOURCE AUTHORITY (spec #61) ──────────────────────────────────────────────
 * A trustedSourceLevel ranks how much evidentiary weight a channel's posts
 * carry. Slack NEVER outranks an authoritative system API for canonical asset
 * state (spec #50/#61) — a feed post is a CLAIM to be reconciled, not truth.
 *
 * ── GOVERNANCE (spec #45/#60) ────────────────────────────────────────────────
 * The registry is persistent + operator-editable. The AI may SUGGEST a
 * classification (inferred from the channel name) but an inferred record is
 * marked `source:'inferred'` and NEVER silently granted high trust — only an
 * operator confirmation (`source:'operator'`) sets a trusted level. This mirrors
 * the invariant that AI inference can't grant trust (spec #14/#65).
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('channel-registry'); } catch (_) { logger = { info() {}, warn() {} }; }

const STORE_KEY = 'slackChannelRegistry';

const MODES = ['CONVERSATIONAL', 'OPERATIONAL', 'INFORMATION_FEED', 'ALERT_FEED', 'VENDOR_FEED', 'SYSTEM_FEED', 'MIXED'];

// Modes where FAS should INGEST silently and only reply when directly asked.
const FEED_MODES = new Set(['INFORMATION_FEED', 'ALERT_FEED', 'VENDOR_FEED', 'SYSTEM_FEED']);

// Source-authority tiers (spec #61). Higher = more evidentiary weight, but
// still below an authoritative system API for canonical state.
const SOURCE_LEVELS = ['UNVERIFIED', 'GENERAL_INTERNAL', 'PARTNER_CHANNEL', 'INTERNAL_OPERATIONS', 'VERIFIED_VENDOR_FEED', 'SYSTEM_GENERATED'];

// Reply policies (how willing FAS is to speak in the channel).
const REPLY_POLICIES = ['normal', 'only_if_directly_mentioned', 'never'];

function _load() { const r = store.load(STORE_KEY, {}); return (r && typeof r === 'object' && !Array.isArray(r)) ? r : {}; }
function _save(obj) { try { store.save(STORE_KEY, obj); } catch (e) { logger.warn('[channel-registry] save failed: ' + e.message); } }

// ── NAME-BASED CLASSIFIER (suggestion only; never grants trust) ──────────────
// Heuristics over the channel name. Returns { mode, replyPolicy, ingestionPolicy,
// trustedSourceLevel, confidence, matched }. Deliberately conservative: unknown
// names classify as CONVERSATIONAL (reply normally) so we never silence a real
// conversation by mistake; feed detection must be fairly specific.
const _NAME_RULES = [
  { re: /(sev|incident|outage|pager|pagerduty|alarm|alert)s?\b/i, mode: 'ALERT_FEED', level: 'SYSTEM_GENERATED', conf: 0.8 },
  { re: /(system|bot|automation|automated|notif(ication)?s?)\b/i, mode: 'SYSTEM_FEED', level: 'SYSTEM_GENERATED', conf: 0.75 },
  { re: /(vendor|amerit|fleetnet|cox|gabrielli|kwne|allegiance|dealer)[-_ ]?(update|status|feed|repair)/i, mode: 'VENDOR_FEED', level: 'VERIFIED_VENDOR_FEED', conf: 0.8 },
  { re: /(repair|wo|work[-_ ]?order|breakdown|road[-_ ]?call)[-_ ]?(feed|update|status)/i, mode: 'VENDOR_FEED', level: 'VERIFIED_VENDOR_FEED', conf: 0.75 },
  { re: /(pm|preventive|maintenance|dvir|inspection|compliance)[-_ ]?(alert|feed|due|status)/i, mode: 'ALERT_FEED', level: 'SYSTEM_GENERATED', conf: 0.75 },
  { re: /(feed|updates|status|digest|report|readout|standup|dashboard)\b/i, mode: 'INFORMATION_FEED', level: 'GENERAL_INTERNAL', conf: 0.65 },
  { re: /(ready|availability|deploy(ment)?|utilization)\b/i, mode: 'INFORMATION_FEED', level: 'INTERNAL_OPERATIONS', conf: 0.6 },
];

function classifyByName(channelName) {
  const name = String(channelName || '').trim();
  if (!name) return { mode: 'CONVERSATIONAL', replyPolicy: 'normal', ingestionPolicy: false, trustedSourceLevel: 'UNVERIFIED', confidence: 0.3, matched: null };
  for (const rule of _NAME_RULES) {
    if (rule.re.test(name)) {
      const isFeed = FEED_MODES.has(rule.mode);
      return {
        mode: rule.mode,
        replyPolicy: isFeed ? 'only_if_directly_mentioned' : 'normal',
        ingestionPolicy: true,   // feeds + operational channels ingest signal
        trustedSourceLevel: rule.level,
        confidence: rule.conf,
        matched: String(rule.re),
      };
    }
  }
  // Default: a normal conversation channel.
  return { mode: 'CONVERSATIONAL', replyPolicy: 'normal', ingestionPolicy: false, trustedSourceLevel: 'GENERAL_INTERNAL', confidence: 0.4, matched: null };
}

/**
 * getChannel(channelId) -> record | null
 * Returns the persisted registry record for a channel, if any.
 */
function getChannel(channelId) {
  if (!channelId) return null;
  const reg = _load();
  return reg[channelId] || null;
}

/**
 * resolveChannel({ channelId, channelName, isSlackConnect }) -> record
 * Returns the EFFECTIVE channel role: an operator-confirmed record if present
 * (authoritative), otherwise an INFERRED record from the name classifier
 * (suggestion — marked source:'inferred', never trusted-granting). Never
 * throws; falls back to CONVERSATIONAL.
 */
function resolveChannel(input) {
  input = input || {};
  const channelId = input.channelId || '';
  const existing = channelId ? getChannel(channelId) : null;
  if (existing && existing.source === 'operator') {
    return { ...existing, resolved: 'operator' };
  }
  // No confirmed record -> classify by name (suggestion only).
  const guess = classifyByName(input.channelName || (existing && existing.name));
  // A Slack Connect / partner channel downgrades source authority regardless of
  // the name guess (an external party posts there).
  const level = input.isSlackConnect ? 'PARTNER_CHANNEL' : guess.trustedSourceLevel;
  return {
    channelId,
    name: input.channelName || (existing && existing.name) || '',
    mode: (existing && existing.mode) || guess.mode,
    replyPolicy: (existing && existing.replyPolicy) || guess.replyPolicy,
    ingestionPolicy: existing ? !!existing.ingestionPolicy : guess.ingestionPolicy,
    trustedSourceLevel: (existing && existing.trustedSourceLevel) || level,
    organization: (existing && existing.organization) || '',
    purpose: (existing && existing.purpose) || '',
    confidence: guess.confidence,
    source: existing ? existing.source : 'inferred',
    resolved: existing ? existing.source : 'inferred',
    lastReviewedAt: (existing && existing.lastReviewedAt) || null,
  };
}

/**
 * isFeed(record) / ingestOnly(record, { mentioned }) — behavior helpers.
 *
 * ingestOnly returns TRUE when FAS should READ + extract but NOT reply:
 * a feed-mode channel (or any channel whose replyPolicy is
 * only_if_directly_mentioned) when the message does NOT directly mention FAS.
 * A direct mention always lets FAS respond, even in a feed (spec #46/#64).
 */
function isFeed(record) {
  return !!record && FEED_MODES.has(record.mode);
}
function ingestOnly(record, opts) {
  if (!record) return false;
  const mentioned = !!(opts && opts.mentioned);
  if (mentioned) return false;                 // a direct ask always gets a reply
  if (record.replyPolicy === 'never') return true;
  if (record.replyPolicy === 'only_if_directly_mentioned') return true;
  return false;                                // normal: not ingest-only
}

/**
 * upsertChannel(record, { operator }) -> saved record
 * Persist/update a channel record. When `operator` is true, the record is
 * marked source:'operator' (authoritative, may carry a trusted source level).
 * An AI/auto call (operator falsy) is stored as source:'inferred' and can
 * NEVER raise the trusted level above what the name classifier allows (spec
 * #14/#60/#65 — AI inference can't grant trust).
 */
function upsertChannel(record, opts) {
  record = record || {};
  const channelId = record.channelId;
  if (!channelId) return { ok: false, error: 'channelId required' };
  const operator = !!(opts && opts.operator);
  const reg = _load();
  const prev = reg[channelId] || {};
  const mode = MODES.includes(record.mode) ? record.mode : (prev.mode || 'CONVERSATIONAL');
  let trustedSourceLevel = SOURCE_LEVELS.includes(record.trustedSourceLevel) ? record.trustedSourceLevel : (prev.trustedSourceLevel || 'GENERAL_INTERNAL');
  // AI/auto write may not grant a trust level higher than the name classifier
  // would — only an operator can confirm a trusted feed.
  if (!operator) {
    const guessLevel = classifyByName(record.name || prev.name).trustedSourceLevel;
    if (SOURCE_LEVELS.indexOf(trustedSourceLevel) > SOURCE_LEVELS.indexOf(guessLevel)) {
      trustedSourceLevel = guessLevel;
    }
  }
  const next = {
    channelId,
    name: record.name || prev.name || '',
    mode,
    replyPolicy: REPLY_POLICIES.includes(record.replyPolicy) ? record.replyPolicy : (prev.replyPolicy || (FEED_MODES.has(mode) ? 'only_if_directly_mentioned' : 'normal')),
    ingestionPolicy: record.ingestionPolicy != null ? !!record.ingestionPolicy : (prev.ingestionPolicy != null ? prev.ingestionPolicy : FEED_MODES.has(mode)),
    trustedSourceLevel,
    organization: record.organization || prev.organization || '',
    purpose: record.purpose || prev.purpose || '',
    source: operator ? 'operator' : (prev.source === 'operator' ? 'operator' : 'inferred'),
    lastReviewedAt: operator ? new Date().toISOString() : (prev.lastReviewedAt || null),
    updatedAt: new Date().toISOString(),
  };
  reg[channelId] = next;
  _save(reg);
  logger.info('[channel-registry] ' + (operator ? 'operator' : 'auto') + ' upsert ' + channelId + ' -> ' + mode + ' (' + next.replyPolicy + ', ' + trustedSourceLevel + ')');
  return { ok: true, record: next };
}

/** List all registry records (for the settings UI). */
function listChannels() {
  const reg = _load();
  return Object.values(reg).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = {
  resolveChannel, getChannel, upsertChannel, listChannels, classifyByName,
  isFeed, ingestOnly,
  MODES, FEED_MODES, SOURCE_LEVELS, REPLY_POLICIES, STORE_KEY,
};
