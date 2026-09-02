'use strict';
/**
 * orcha/fas/runner.js — Digital FAS UNIFIED LIVE RUNNER.
 *
 * One entry point for EVERY inbound Slack surface (top-level DM, DM thread
 * reply, watched channel). It loads the selected mode + sender profile, runs
 * the real Orcha/Claude FAS agent (bounded research loop), and routes the
 * reply/actions according to mode — while telling the LEGACY engine whether it
 * may still reply, so the two engines never both send.
 *
 * Modes (default: shadow; FAS disabled by default for new installs):
 *   disabled / shadow : legacy engine replies. FAS researches + drafts +
 *                       records a comparison. Sends/mutates NOTHING.
 *                       -> { letLegacyReply: true }
 *   approval          : FAS is primary. It queues the proposed reply + actions
 *                       for Zila to approve. Nothing outbound/mutating happens
 *                       until approval. Legacy engine stays SILENT.
 *                       -> { letLegacyReply: false }
 *   autonomous        : FAS is primary. Routine, evidence-supported answers may
 *                       be sent automatically; anything requiring approval (or
 *                       low confidence / missing-conflicting evidence) is queued
 *                       instead. Legacy engine stays SILENT.
 *                       -> { letLegacyReply: false, fasReply?: string }
 *
 * This module NEVER sends Slack itself — it returns fasReply for the caller to
 * send through the existing authenticated send path (so there is exactly one
 * send code path and one watermark owner). Action execution/queueing goes
 * through executor.routeAction (which re-enforces mode + authorization).
 *
 * Guarded: on any internal error it FAILS SAFE by letting the legacy engine
 * reply (never silently drops a customer message).
 */

const config = require('./config');
const store = require('../../store');
let logger; try { logger = require('../../utils/logger').createLogger('fas-runner'); } catch (_) { logger = { info(){}, warn(){} }; }

const AUDIT_CAP = 500;
// Autonomous auto-send only for routine answers at/above this confidence.
const AUTO_SEND_MIN_CONFIDENCE = 0.75;

function _appendAudit(entry) {
  try {
    const log = store.load('fasAuditLog', []);
    const arr = Array.isArray(log) ? log : [];
    arr.unshift(entry);
    if (arr.length > AUDIT_CAP) arr.length = AUDIT_CAP;
    store.save('fasAuditLog', arr);
  } catch (e) { logger.warn('[fas-runner] audit write failed: ' + e.message); }
}

function _divergence(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/<@[^>]+>/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size && !B.size) return 0;
  let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
  const union = new Set([...A, ...B]).size;
  return union ? 1 - inter / union : 0;
}

// Does the decision propose any approval-level (mutating/outbound) action?
function _hasApprovalLevelAction(decision) {
  if (!Array.isArray(decision.actions) || !decision.actions.length) return false;
  let actions; try { actions = require('./action-registry'); } catch (_) { return true; }
  return decision.actions.some(a => {
    const def = a && a.tool && actions.getAction(a.tool);
    return !def || def.level !== 'low';
  });
}

/**
 * handleInbound(input) -> {
 *   mode, letLegacyReply, fasReply?, decision, outcome, actionOutcomes, audit
 * }
 * input: { engine, slackId, senderName, channelName, ts, text, conversation,
 *          isGroup, actualReply? }  (actualReply only known in shadow, post-send)
 */
async function handleInbound(input) {
  const cfg = config.get();
  const mode = (cfg && cfg.enabled) ? (cfg.mode || 'shadow') : 'disabled';

  // Disabled: FAS does nothing at all; legacy owns the reply.
  if (mode === 'disabled') return { mode, letLegacyReply: true, decision: null, outcome: 'disabled' };

  let decision = null;
  const actionOutcomes = [];
  try {
    const agent = require('./agent');
    decision = await agent.runAgent({
      slackId: input.slackId, senderName: input.senderName,
      text: input.text, conversation: input.conversation || [], isGroup: !!input.isGroup,
    });

    // Route proposed actions through the executor (it re-enforces mode + auth;
    // shadow records only, approval queues, autonomous runs whitelisted low-risk).
    if (Array.isArray(decision.actions) && decision.actions.length) {
      const executor = require('./executor');
      const profile = require('./sender-profiles').resolveSender(input.slackId, input.senderName);
      for (const a of decision.actions.slice(0, 6)) {
        if (!a || !a.tool) continue;
        try {
          const r = await executor.routeAction(a.tool, { ...(a.args || {}), slackId: input.slackId }, { profile });
          actionOutcomes.push({ tool: a.tool, outcome: r.outcome, detail: r.detail });
        } catch (e) { actionOutcomes.push({ tool: a.tool, outcome: 'error', detail: e.message }); }
      }
    }
  } catch (e) {
    // FAIL SAFE: never drop a message. In shadow just log; in primary modes,
    // fall back to letting the legacy engine reply this cycle.
    logger.warn('[fas-runner] agent failed (' + mode + ', failing safe to legacy): ' + e.message);
    _appendAudit({ at: new Date().toISOString(), mode, engine: input.engine || 'dm', ts: input.ts,
      message: input.text, error: e.message, outcome: 'error-failsafe' });
    return { mode, letLegacyReply: true, decision: null, outcome: 'error-failsafe' };
  }

  const base = {
    at: new Date().toISOString(), mode, engine: input.engine || 'dm',
    channelName: input.channelName || '', ts: input.ts || '', message: input.text || '',
    fasDecision: decision.decision, fasConfidence: decision.confidence, fasReason: decision.reason,
    fasReply: decision.reply, fasProposedActions: (decision.actions || []).map(a => a && a.tool).filter(Boolean),
    actionOutcomes, caseId: decision._evidence && decision._evidence.caseId,
    deniedScope: (decision._evidence && decision._evidence.deniedScope) || [],
    missingFacts: (decision._evidence && decision._evidence.missingFacts) || [],
    conflicts: (decision._evidence && decision._evidence.conflicts) || [],
    loop: decision._loop || null,
  };

  // ── AI FAILURE HANDLING (Part 6) ──────────────────────────────────────────
  // If Orcha/Claude timed out, returned invalid JSON, was aborted, exhausted
  // its research budget without a usable answer, or produced an EMPTY reply,
  // we must NEVER send an empty reply, NEVER mark the request handled, and
  // NEVER advance silently. In Shadow, let the legacy path proceed. In
  // Approval/Autonomous, create a VISIBLE manual-review item with the original
  // request + failure reason, and send nothing.
  const _aiFailed = !!decision._fallback || !!decision._aborted ||
    typeof decision.reply !== 'string' || decision.reply.trim().length === 0;
  if (_aiFailed) {
    const failReason = decision._aborted ? 'AI aborted (runtime/cancellation)'
      : decision._fallback ? 'AI unavailable or unparseable response'
      : 'AI produced an empty reply';
    if (mode === 'shadow') {
      const audit = { ...base, outcome: 'ai-failed-shadow', failReason, actualReply: input.actualReply || '' };
      _appendAudit(audit);
      // Shadow records evaluation only; do NOT update authoritative case memory.
      return { mode, letLegacyReply: true, decision, outcome: 'ai-failed-shadow', actionOutcomes, audit };
    }
    const item = _queueManualReview(input, decision, failReason);
    const audit = { ...base, outcome: 'manual-review', failReason, approvalId: item.id };
    _appendAudit(audit);
    // Do NOT update case memory from a failed/empty AI result.
    return { mode, letLegacyReply: false, decision, outcome: 'manual-review', approvalId: item.id, failReason, actionOutcomes, audit };
  }

  // ── SHADOW: legacy replies; we only record the comparison. ────────────────
  if (mode === 'shadow') {
    const audit = { ...base, actualReply: input.actualReply || '',
      divergence: Number(_divergence(input.actualReply, decision.reply).toFixed(3)) };
    _appendAudit(audit);
    // NOTE (Part 7): Shadow drafts are EVALUATION data only — never written to
    // authoritative case memory as facts/promises. Recorded in the audit log.
    return { mode, letLegacyReply: true, decision, outcome: 'shadow', actionOutcomes, audit };
  }

  // ── APPROVAL: queue the proposed reply; legacy stays silent. ──────────────
  if (mode === 'approval') {
    const item = _queueReply(input, decision);
    const audit = { ...base, outcome: 'queued-for-approval', approvalId: item.id };
    _appendAudit(audit);
    // NOTE (Part 7): a QUEUED (unapproved) draft must NOT become a case fact or
    // an active promise. Case memory is updated only when the reply is actually
    // sent (autonomous auto-send below, or approveReply after Slack confirms).
    return { mode, letLegacyReply: false, decision, outcome: 'queued', approvalId: item.id, actionOutcomes, audit };
  }

  // ── AUTONOMOUS: auto-send only routine, confident answers w/o approval-level
  // actions or unresolved gaps; otherwise queue. Legacy stays silent either way.
  const gapsOrConflicts = (base.missingFacts && base.missingFacts.length) || (base.conflicts && base.conflicts.length);
  // STALE EVIDENCE (Part 13): if any verified fact backing this decision is
  // stale (cache older than the freshness window), it must NOT support an
  // autonomous reply — queue for human review instead.
  const evFacts = (decision._evidence && decision._evidence.verifiedFacts) || [];
  const staleEvidence = evFacts.some(f => f && f.stale === true);
  const canAutoSend =
    decision.decision === 'answer' &&
    typeof decision.reply === 'string' && decision.reply.trim().length > 0 &&
    (decision.confidence == null || decision.confidence >= AUTO_SEND_MIN_CONFIDENCE) &&
    !_hasApprovalLevelAction(decision) &&
    !gapsOrConflicts &&
    !staleEvidence;

  if (canAutoSend) {
    const audit = { ...base, outcome: 'auto-sent' };
    _appendAudit(audit);
    _updateCaseFromInteraction(input, decision, 'auto-sent');
    return { mode, letLegacyReply: false, fasReply: decision.reply, decision, outcome: 'auto-sent', actionOutcomes, audit };
  }

  const item = _queueReply(input, decision);
  const audit = { ...base, outcome: 'queued-for-approval',
    queueReason: decision.decision !== 'answer' ? ('decision=' + decision.decision)
      : gapsOrConflicts ? 'missing/conflicting evidence'
      : staleEvidence ? 'stale cached evidence'
      : _hasApprovalLevelAction(decision) ? 'approval-level action proposed'
      : 'low confidence', approvalId: item.id };
  _appendAudit(audit);
  // NOTE (Part 7): queued (unapproved) draft does NOT update case memory.
  return { mode, letLegacyReply: false, decision, outcome: 'queued', approvalId: item.id, actionOutcomes, audit };
}

// Queue a proposed REPLY (distinct from action queue) so the approval UI can
// show the original request, proposed reply, evidence, sender, reason, etc.
const REPLY_QUEUE_CAP = 300;
function _queueReply(input, decision) {
  const q = store.load('fasApprovalQueue', []);
  const arr = Array.isArray(q) ? q : [];
  const item = {
    id: 'reply_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'reply',
    status: 'pending',
    createdAt: new Date().toISOString(),
    engine: input.engine || 'dm',
    channelId: input.channelId || '',
    channelName: input.channelName || '',
    threadTs: input.threadTs || null,
    ts: input.ts || '',
    slackId: input.slackId || '',
    senderName: input.senderName || '',
    request: input.text || '',
    proposedReply: decision.reply || '',
    decision: decision.decision,
    confidence: decision.confidence,
    reason: decision.reason,
    proposedActions: (decision.actions || []),
    evidence: {
      verifiedFacts: (decision._evidence && decision._evidence.verifiedFacts) || [],
      sources: (decision._evidence && decision._evidence.sources) || [],
      missingFacts: (decision._evidence && decision._evidence.missingFacts) || [],
      conflicts: (decision._evidence && decision._evidence.conflicts) || [],
    },
    targetUnit: (decision._evidence && decision._evidence.entities && (decision._evidence.entities.units || [])[0]) || null,
  };
  arr.unshift(item);
  if (arr.length > REPLY_QUEUE_CAP) arr.length = REPLY_QUEUE_CAP;
  store.save('fasApprovalQueue', arr);
  return item;
}

// Queue a VISIBLE manual-review item when the AI failed (timeout/invalid/empty/
// aborted/budget-exhausted). It carries the ORIGINAL request + failure reason so
// the operator can respond manually. It has NO proposed reply (nothing to send).
function _queueManualReview(input, decision, failReason) {
  const q = store.load('fasApprovalQueue', []);
  const arr = Array.isArray(q) ? q : [];
  const item = {
    id: 'review_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'manual-review',
    status: 'pending',
    createdAt: new Date().toISOString(),
    engine: input.engine || 'dm',
    channelId: input.channelId || '',
    channelName: input.channelName || '',
    threadTs: input.threadTs || null,
    ts: input.ts || '',                 // preserve the original Slack message ref
    slackId: input.slackId || '',
    senderName: input.senderName || '',
    request: input.text || '',
    proposedReply: '',                  // nothing to send — AI did not produce a usable answer
    proposedActions: [],
    failReason: failReason || 'AI unavailable',
    decision: (decision && decision.decision) || 'clarify',
    reason: (decision && decision.reason) || failReason,
  };
  arr.unshift(item);
  if (arr.length > REPLY_QUEUE_CAP) arr.length = REPLY_QUEUE_CAP;
  store.save('fasApprovalQueue', arr);
  return item;
}

// ── Case memory: create/update a case after every relevant interaction. ──────
// Connects Slack messages (and, via evidence, Relay/Offsite/email facts) to the
// same unit case. Facts and promises are DEDUPED. Old case memory is context
// only — it never overrides newer source records (the agent already prefers
// sourced facts; here we just persist a compact summary + open items).
function _dedupeFacts(existing, incoming) {
  const seen = new Set((existing || []).map(f => (f.field || '') + '=' + JSON.stringify(f.value)));
  const out = [];
  (incoming || []).forEach(f => {
    const k = (f.field || '') + '=' + JSON.stringify(f.value);
    if (!seen.has(k)) { seen.add(k); out.push(f); }
  });
  return out;
}
function _extractPromise(reply) {
  // A promise is a genuine FIRST-PERSON COMMITMENT to do something:
  // "I'll…", "I will…", "we'll…", "we will…", "let me…", "I'm going to…",
  // or an explicit deadline ("by EOD", "within 2 hours"). Deliberately EXCLUDES
  // soft/capability phrasing like "I can" / "I could" / "I'd be happy to",
  // which are NOT commitments (Part 7). Compact; deduped by text.
  const t = String(reply || '');
  const m = t.match(/\b(i'?ll\b|i will\b|we'?ll\b|we will\b|let me\b|i'?m going to\b|by (?:today|tomorrow|eod|end of day|end of week)\b|within \d+\s*(?:hr|hour|day|business day)s?\b)[^.!?\n]*/i);
  if (!m) return null;
  // Guard: "I can" / "I could" alone must not slip through via a following word.
  const frag = m[0].trim();
  if (/^i\s+(can|could|may|might|would)\b/i.test(frag) && !/\bwill\b|\bi'?ll\b/i.test(frag)) return null;
  return frag.slice(0, 160);
}
// Next business day at 09:00 in the configured timezone (weekends skipped).
// Falls back to +1 calendar day if timezone math is unavailable.
function _nextBusinessDueAt() {
  try {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    // Skip Sat(6)/Sun(0).
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  } catch (_) {
    return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  }
}
// Validate an AI-provided dueAt as a real, future-ish date. Returns an ISO
// string or null (never a bogus "+24h business-ish" guess).
function _validateDueAt(dueAt) {
  if (!dueAt) return null;
  const ms = Date.parse(dueAt);
  if (isNaN(ms)) return null;
  // Reject absurd dates (before 2020 or > 2 years out) — likely a hallucination.
  const y = new Date(ms).getFullYear();
  if (y < 2020 || y > new Date().getFullYear() + 2) return null;
  return new Date(ms).toISOString();
}
function _followUpFromDecision(decision) {
  const fu = decision && decision.followUp;
  if (fu && fu.required) {
    const valid = _validateDueAt(fu.dueAt);
    if (valid) return { owner: fu.owner || '', dueAt: valid };
    // required but no/invalid date -> schedule for next business day.
    return { owner: (fu && fu.owner) || '', dueAt: _nextBusinessDueAt() };
  }
  // If the reply makes a real commitment but gives no explicit dueAt, schedule
  // the follow-up for the next business day (not a naive +24h).
  if (_extractPromise(decision && decision.reply)) {
    return { owner: '', dueAt: _nextBusinessDueAt() };
  }
  return null;
}
function _updateCaseFromInteraction(input, decision, outcome) {
  try {
    const caseStore = require('./case-store');
    const ev = decision && decision._evidence;
    const unit = (ev && ev.entities && (ev.entities.units || [])[0]) || null;
    const caseId = unit ? caseStore.caseIdForUnit(unit) : caseStore.caseIdForSender(input.slackId || 'unknown');
    const existing = caseStore.getCase(caseId);
    const promiseText = _extractPromise(decision && decision.reply);
    // Dedupe promises by text against the existing case.
    const priorPromises = new Set(((existing && existing.promises) || []).map(p => p.text));
    const promises = (promiseText && !priorPromises.has(promiseText))
      ? [{ text: promiseText, madeAt: new Date().toISOString(), owner: '', dueAt: null }] : [];
    const fu = _followUpFromDecision(decision);
    // Connect completed/failed action outcomes to the case (Part 7).
    const outcomes = Array.isArray(decision && decision._actionOutcomes) ? decision._actionOutcomes : [];
    const completedActions = outcomes.filter(o => o && (o.status === 'done' || o.outcome === 'done'))
      .map(o => ({ tool: o.tool, at: new Date().toISOString() }));
    const failedActions = outcomes.filter(o => o && (o.status === 'error' || o.status === 'unverified' || o.outcome === 'error'))
      .map(o => ({ tool: o.tool, status: o.status || o.outcome, at: new Date().toISOString() }));
    const patch = {
      unit,
      currentSummary: (decision && decision.reply) ? String(decision.reply).slice(0, 500) : (existing && existing.currentSummary) || '',
      status: decision && decision.decision === 'escalate' ? 'escalated' : 'open',
      verifiedFacts: _dedupeFacts(existing && existing.verifiedFacts, (ev && ev.verifiedFacts) || []),
      openQuestions: decision && decision.decision === 'clarify' && decision.reply ? [decision.reply.slice(0, 160)] : [],
      promises,
      completedActions,
      failedActions,
      responsibleParty: (decision && decision.followUp && decision.followUp.owner) || (existing && existing.responsibleParty) || '',
      nextFollowUpAt: fu ? fu.dueAt : (existing && existing.nextFollowUpAt) || null,
      relatedSlackMessages: input.channelId && input.ts ? [{ channelId: input.channelId, ts: input.ts }] : [],
      sources: (ev && ev.sources) || [],
    };
    caseStore.upsert(caseId, patch, unit);
  } catch (e) { logger.warn('[fas-runner] case update failed (non-fatal): ' + e.message); }
}

// ── Reply-queue approval/rejection (approval + autonomous-queued replies) ────
function _loadQueue() { const q = store.load('fasApprovalQueue', []); return Array.isArray(q) ? q : []; }
function _saveQueue(q) { store.save('fasApprovalQueue', q); }

/**
 * approveReply(id, ctx, deps) -> { ok, sent?, actionOutcomes?, error? }
 * Sends the proposed reply through the REAL send path and routes the proposed
 * actions through the executor (they were held until approval). Verifies the
 * send returned a ts. Marks the queue item resolved. Rejection does nothing.
 *
 * deps.sendToChannel is injectable for testing; defaults to the app's Slack
 * send. ctx.profile is the approver (operator) for action authorization.
 */
async function approveReply(id, ctx, deps) {
  const q = _loadQueue();
  const item = q.find(x => x.id === id && x.kind === 'reply');
  if (!item) return { ok: false, error: 'reply not found' };
  if (item.status !== 'pending') return { ok: false, error: 'not pending (' + item.status + ')' };

  const sendToChannel = (deps && deps.sendToChannel) ||
    (() => { try { return require('../../scrapers/slack_send').sendToChannel; } catch (_) { return null; } })();
  if (!sendToChannel) return { ok: false, error: 'send path unavailable' };

  // 1) Send the proposed reply (tagging the original sender), in-thread if the
  //    original message was in a thread.
  const tagged = (item.slackId ? '<@' + item.slackId + '> ' : '') + (item.proposedReply || '');
  let sendRes;
  try {
    sendRes = await sendToChannel(item.channelId, tagged, item.threadTs || undefined);
  } catch (e) {
    return { ok: false, error: 'send failed: ' + e.message };
  }
  if (!sendRes || !sendRes.ts) return { ok: false, error: 'send returned no ts' };

  // 2) Route the proposed actions through the executor NOW that it's approved.
  const actionOutcomes = [];
  const approver = (ctx && ctx.profile) || { slackId: 'operator', name: 'Operator', type: 'internal',
    operators: [], domiciles: [], allowedDataCategories: ['*'],
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'] };
  if (Array.isArray(item.proposedActions) && item.proposedActions.length) {
    const executor = require('./executor');
    for (const a of item.proposedActions.slice(0, 6)) {
      if (!a || !a.tool) continue;
      try {
        const r = await executor.executeVerified(a.tool, { ...(a.args || {}), slackId: item.slackId }, { profile: approver });
        actionOutcomes.push({ tool: a.tool, status: r.status });
      } catch (e) { actionOutcomes.push({ tool: a.tool, status: 'error', error: e.message }); }
    }
  }

  // 3) Mark resolved with real send evidence (ts + channel, no credentials).
  const q2 = _loadQueue();
  const it2 = q2.find(x => x.id === id);
  if (it2) { it2.status = 'approved-sent'; it2.sentTs = sendRes.ts; it2.sentChannel = item.channelId; it2.resolvedAt = new Date().toISOString(); it2.actionOutcomes = actionOutcomes; _saveQueue(q2); }
  _appendAudit({ at: new Date().toISOString(), kind: 'reply-approved', id, sentTs: sendRes.ts, channel: item.channelId, actionOutcomes });

  // 4) NOW that Slack confirmed the send, commit case memory (Part 7): the
  //    reply was actually sent, so its promise becomes real. Reconstruct a
  //    minimal decision from the stored queue item.
  try {
    _updateCaseFromInteraction(
      { slackId: item.slackId, channelId: item.channelId, ts: item.ts },
      { decision: item.decision, reply: item.proposedReply, followUp: item.followUp,
        _evidence: { verifiedFacts: (item.evidence && item.evidence.verifiedFacts) || [],
          sources: (item.evidence && item.evidence.sources) || [],
          entities: { units: item.targetUnit ? [item.targetUnit] : [] } } },
      'approved-sent');
  } catch (_) {}
  return { ok: true, sent: { ts: sendRes.ts, channel: item.channelId }, actionOutcomes };
}

function rejectReply(id) {
  const q = _loadQueue();
  const item = q.find(x => x.id === id && x.kind === 'reply');
  if (!item) return { ok: false, error: 'reply not found' };
  item.status = 'rejected'; item.resolvedAt = new Date().toISOString();
  _saveQueue(q);
  _appendAudit({ at: new Date().toISOString(), kind: 'reply-rejected', id });
  return { ok: true };
}

function getReplyQueue(status) {
  return _loadQueue().filter(x => x.kind === 'reply' && (!status || x.status === status));
}

module.exports = { handleInbound, approveReply, rejectReply, getReplyQueue, _divergence, _hasApprovalLevelAction, _extractPromise, _validateDueAt, _nextBusinessDueAt, AUTO_SEND_MIN_CONFIDENCE };
