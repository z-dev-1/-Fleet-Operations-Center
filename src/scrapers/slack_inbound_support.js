'use strict';
/**
 * slack_inbound_support.js — shared helpers for the Slack inbound pipeline
 * (DM auto-reply + channel watch). Centralizes the behavior the pipeline was
 * missing so both engines get it consistently:
 *
 *   - discoverSenders(): decoupled, reliable contact discovery that runs on
 *     EVERY detected sender (top-level, thread reply, group DM, skipped or
 *     old messages) BEFORE any reply decision. Retries transient storage
 *     failures, records unresolved failures durably, never overwrites manual
 *     permission settings, and never throws into the caller.
 *
 *   - Send-block registry: restricted_action marks a conversation TEMPORARILY
 *     send-blocked (persisted, with a recheck TTL) instead of permanently
 *     ignoring it for the session. Discovery + incoming tracking continue.
 *
 *   - manualReplyByOperator(): precise "did I already answer this?" check that
 *     is scoped to the SAME conversation + thread + the specific incoming
 *     message, so it doesn't false-positive in group DMs / fast conversations.
 *
 *   - lifecycle(): a structured per-message observability record (a real
 *     store the app can read + a decision-trace line), with reason codes for
 *     every skipped reply. Never logs full message content.
 *
 * All state lives in the `store` so it survives restarts.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('slack-inbound'); } catch (_) { logger = { info(){}, warn(){} }; }
let contactBook; try { contactBook = require('../services/contact-book'); } catch (_) { contactBook = null; }

// ── Store keys ───────────────────────────────────────────────────────────────
const SAVE_FAILURES_KEY = 'slackContactSaveFailures'; // durable unresolved contact-save failures
const SEND_BLOCKS_KEY   = 'slackSendBlocks';          // { [channelId]: { reason, blockedAt, recheckAt } }
const LIFECYCLE_KEY     = 'slackInboundLifecycle';    // rolling per-message lifecycle records (health/activity)

const SEND_BLOCK_RECHECK_MS = 30 * 60 * 1000; // recheck a send-blocked conversation after 30 min
const LIFECYCLE_CAP = 500;
const SAVE_RETRY_ATTEMPTS = 3;

function _now() { return new Date().toISOString(); }
function _loadObj(key) { const v = store.load(key, {}); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function _loadArr(key) { const v = store.load(key, []); return Array.isArray(v) ? v : []; }

// ── Contact discovery (decoupled from reply decisions) ───────────────────────

let _resolveUserName = null;
function _getResolver() {
  if (_resolveUserName) return _resolveUserName;
  try { _resolveUserName = require('./slack_send').resolveUserName; } catch (_) { _resolveUserName = async (id) => id; }
  return _resolveUserName;
}

// Record a durable, visible contact-save failure (surfaced in system health).
function _recordSaveFailure(slackId, channelId, error) {
  try {
    const arr = _loadArr(SAVE_FAILURES_KEY);
    // Dedupe by slackId+channelId; bump attempt count + timestamp.
    const existing = arr.find(f => f.slackId === slackId && f.channelId === channelId && !f.resolvedAt);
    if (existing) { existing.attempts = (existing.attempts || 1) + 1; existing.lastError = String(error); existing.lastAt = _now(); }
    else arr.unshift({ slackId, channelId, attempts: 1, lastError: String(error), firstAt: _now(), lastAt: _now() });
    store.save(SAVE_FAILURES_KEY, arr.slice(0, 200));
  } catch (e) { logger.warn('[slack-inbound] could not record save failure: ' + e.message); }
}
function _clearSaveFailure(slackId, channelId) {
  try {
    const arr = _loadArr(SAVE_FAILURES_KEY);
    let changed = false;
    arr.forEach(f => { if (f.slackId === slackId && f.channelId === channelId && !f.resolvedAt) { f.resolvedAt = _now(); changed = true; } });
    if (changed) store.save(SAVE_FAILURES_KEY, arr.filter(f => !f.resolvedAt).slice(0, 200));
  } catch (_) {}
}
function getUnresolvedSaveFailures() { return _loadArr(SAVE_FAILURES_KEY).filter(f => !f.resolvedAt); }

/**
 * discoverOneSender({ slackId, channelId, name?, isGroup? }) -> { ok, existed?, created?, error? }
 * Saves/updates ONE sender through the hardened Contact Book service with
 * bounded retry on transient storage failures. Never overwrites manual
 * permission settings (discoverFromDM only fills missing name/channelId).
 * Never throws. Logs success/failure with slackId + conversationId.
 */
async function discoverOneSender({ slackId, channelId, name, isGroup }, deps) {
  if (!slackId) return { ok: false, error: 'no slackId' };
  if (!contactBook || typeof contactBook.discoverFromDM !== 'function') return { ok: false, error: 'contact-book unavailable' };
  // Resolve a display name if not supplied (best-effort; a bad name never blocks the save).
  let resolvedName = name;
  if (!resolvedName) {
    try { const r = (deps && deps.resolveUserName) || _getResolver(); resolvedName = (await r(slackId)) || slackId; }
    catch (_) { resolvedName = slackId; }
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= SAVE_RETRY_ATTEMPTS; attempt++) {
    try {
      const res = contactBook.discoverFromDM({ slackId, name: resolvedName, channelId });
      if (res && res.ok) {
        _clearSaveFailure(slackId, channelId);
        if (!res.existed) logger.info(`[slack-inbound] contact discovered slackId=${slackId} conv=${channelId} name="${resolvedName}"`);
        return { ok: true, existed: !!res.existed, created: !res.existed, contact: res.contact };
      }
      lastErr = (res && res.error) || 'discoverFromDM returned not-ok';
    } catch (e) { lastErr = e.message; }
    // transient backoff between attempts
    if (attempt < SAVE_RETRY_ATTEMPTS) await new Promise(r => setTimeout(r, 50 * attempt));
  }
  _recordSaveFailure(slackId, channelId, lastErr);
  logger.warn(`[slack-inbound] contact SAVE FAILED slackId=${slackId} conv=${channelId}: ${lastErr}`);
  return { ok: false, error: lastErr };
}

/**
 * discoverSenders(messages, { myUserId, channelId, isGroup }, deps)
 * Collects UNIQUE external sender IDs from a message list (top-level or thread
 * replies) and saves each one. Runs regardless of any reply decision. Returns
 * { discovered, created, failed, ids }.
 */
async function discoverSenders(messages, ctx, deps) {
  ctx = ctx || {};
  const myUserId = ctx.myUserId || '';
  const channelId = ctx.channelId || '';
  const ids = [...new Set((messages || [])
    .map(m => m && (m.userId || m.user))
    .filter(id => id && id !== myUserId))];
  let created = 0, failed = 0;
  for (const id of ids) {
    const r = await discoverOneSender({ slackId: id, channelId, name: ctx.nameFor && ctx.nameFor(id), isGroup: ctx.isGroup }, deps);
    if (r.ok && r.created) created++;
    else if (!r.ok) failed++;
  }
  return { discovered: ids.length, created, failed, ids };
}

// ── Send-block registry (temporary, persisted, with recheck) ─────────────────

/** Is this conversation currently send-blocked? (false once the recheck TTL passes.) */
function isSendBlocked(channelId) {
  const blocks = _loadObj(SEND_BLOCKS_KEY);
  const b = blocks[channelId];
  if (!b) return false;
  // Recheck window elapsed -> allow a send attempt again (do NOT auto-clear;
  // a fresh restricted_action will re-block + push the recheck window out).
  if (b.recheckAt && Date.parse(b.recheckAt) <= Date.now()) return false;
  return true;
}

/** Mark a conversation temporarily send-blocked with a reason + recheck time. */
function markSendBlocked(channelId, reason) {
  try {
    const blocks = _loadObj(SEND_BLOCKS_KEY);
    const prev = blocks[channelId] || {};
    blocks[channelId] = {
      reason: reason || 'restricted_action',
      blockedAt: prev.blockedAt || _now(),
      recheckAt: new Date(Date.now() + SEND_BLOCK_RECHECK_MS).toISOString(),
      hits: (prev.hits || 0) + 1,
    };
    store.save(SEND_BLOCKS_KEY, blocks);
  } catch (e) { logger.warn('[slack-inbound] markSendBlocked failed: ' + e.message); }
}

/** Clear a send-block once a send succeeds. */
function clearSendBlocked(channelId) {
  try {
    const blocks = _loadObj(SEND_BLOCKS_KEY);
    if (blocks[channelId]) { delete blocks[channelId]; store.save(SEND_BLOCKS_KEY, blocks); }
  } catch (_) {}
}

function getSendBlocks() { return _loadObj(SEND_BLOCKS_KEY); }

// Classify a send error. restricted_action -> temporary block; everything else
// (ratelimited, timeout, auth, transient) -> retryable.
function classifySendError(err) {
  const msg = String((err && err.message) || err || '');
  if (/restricted_action/i.test(msg)) return { kind: 'send-blocked', retryable: false, reason: msg };
  if (/ratelimited|rate_limited/i.test(msg)) return { kind: 'ratelimited', retryable: true, reason: msg };
  if (/not_authed|invalid_auth|token/i.test(msg)) return { kind: 'auth', retryable: true, reason: msg };
  return { kind: 'transient', retryable: true, reason: msg };
}

// ── Manual-reply detection (thread-scoped, no group-DM false positives) ──────

/**
 * manualReplyByOperator(candidateMessages, { myUserId, incomingTs, threadTs })
 * True ONLY if MY (operator) message appears in the SAME relevant sequence
 * AFTER the specific incoming message:
 *   - When threadTs is set: my message must be a reply in that SAME thread
 *     (thread_ts === threadTs) with ts > incomingTs.
 *   - When no thread: my message must be a plain top-level message
 *     (no thread_ts, or thread_ts === its own ts) with ts > incomingTs.
 * This avoids the old bug where "any newer message from me anywhere in the DM"
 * suppressed replies to earlier, unrelated messages (a real problem in group
 * DMs and fast-moving conversations).
 */
function manualReplyByOperator(candidateMessages, opts) {
  opts = opts || {};
  const myUserId = opts.myUserId;
  const incoming = parseFloat(opts.incomingTs);
  const threadTs = opts.threadTs || null;
  if (!myUserId || !isFinite(incoming)) return false;
  return (candidateMessages || []).some(m => {
    if (!m || (m.userId || m.user) !== myUserId) return false;
    if (parseFloat(m.ts) <= incoming) return false;
    const mThread = m.threadTs || m.thread_ts || null;
    if (threadTs) {
      // Must be in the same thread.
      return mThread === threadTs;
    }
    // Top-level incoming: my message must be top-level too (not buried in some
    // other thread), so a reply I made in a different thread doesn't suppress
    // a brand-new top-level question.
    return !mThread || mThread === m.ts;
  });
}

// ── Structured per-message lifecycle observability ───────────────────────────
// Records a compact lifecycle for each detected inbound message. Reason codes
// make every skipped reply explainable. Deliberately does NOT store full
// message text (only a short redacted preview length) to avoid persisting
// sensitive content.

// Reason codes for a skipped/held/blocked/queued reply.
const REASON = {
  DUPLICATE: 'duplicate-already-logged',
  MANUAL_REPLY: 'operator-already-replied',
  FIRST_SEEN_BASELINE: 'first-seen-baseline-no-reply',
  OLD_HISTORY: 'old-history-no-reply',
  AI_HELD: 'ai-held',
  AI_FAILED_RETRY: 'ai-failed-retry-scheduled',
  AI_FAILED_ESCALATED: 'ai-failed-escalated-to-review',
  SEND_BLOCKED: 'conversation-send-blocked',
  SEND_FAILED_RETRY: 'send-failed-retry-scheduled',
  QUEUED_APPROVAL: 'queued-for-approval',
  QUEUED_REVIEW: 'queued-for-manual-review',
  LEGACY_FALLBACK: 'ai-failed-legacy-fallback',
  NOT_DIRECTED: 'not-directed-at-me',
  SENT: 'reply-sent',
};

function lifecycle(rec) {
  // rec: { engine, channelId, ts, threadTs?, senderId, stage, reason?, detail? }
  try {
    // Structured trace line (log-only) — no full content.
    try { require('./slack_decision_trace').trace({
      engine: rec.engine, channel: rec.channelId, sender: rec.senderId, ts: rec.ts,
      decision: rec.stage, reason: rec.reason || '', threadTs: rec.threadTs || null,
    }); } catch (_) {}
    const arr = _loadArr(LIFECYCLE_KEY);
    arr.unshift({
      at: _now(),
      engine: rec.engine || 'dm',
      channelId: rec.channelId || '',
      ts: rec.ts || '',
      threadTs: rec.threadTs || null,
      senderId: rec.senderId || '',
      stage: rec.stage || '',        // detected | discovered | resolved | ai-requested | ai-ok | ai-failed | sent | skipped | blocked | queued | retry | watermark
      reason: rec.reason || null,    // reason code (see REASON)
      contact: rec.contact || null,  // created | updated | present
      detail: rec.detail || null,    // short, non-sensitive
    });
    if (arr.length > LIFECYCLE_CAP) arr.length = LIFECYCLE_CAP;
    store.save(LIFECYCLE_KEY, arr);
  } catch (e) { logger.warn('[slack-inbound] lifecycle write failed: ' + e.message); }
}

function getLifecycle(limit) { return _loadArr(LIFECYCLE_KEY).slice(0, limit || 100); }

// Deterministic idempotency key for an inbound reply attempt.
function idempotencyKey(channelId, ts, senderId, threadTs) {
  return [channelId || '', ts || '', senderId || '', threadTs || ''].join('|');
}

module.exports = {
  // discovery
  discoverSenders, discoverOneSender, getUnresolvedSaveFailures,
  // send-block registry
  isSendBlocked, markSendBlocked, clearSendBlocked, getSendBlocks, classifySendError,
  // manual-reply detection
  manualReplyByOperator,
  // observability
  lifecycle, getLifecycle, REASON,
  // idempotency
  idempotencyKey,
  // keys (for tests / IPC)
  SAVE_FAILURES_KEY, SEND_BLOCKS_KEY, LIFECYCLE_KEY, SEND_BLOCK_RECHECK_MS,
};
