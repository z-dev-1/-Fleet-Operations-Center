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

// Build the IMMUTABLE original-requester permission snapshot (Part 5). This is
// what execution authorization is checked against — never the operator's own
// authority. Includes identity, contactId, scope, request types, and the
// lifecycle 3-state permission.
function _buildRequesterSnapshot(input) {
  try {
    const p = require('./sender-profiles').resolveSender(input.slackId, input.senderName);
    return {
      slackId: p.slackId || input.slackId || '',
      contactId: p.contactId || null,
      name: p.name || input.senderName || '',
      identityType: p.type,
      enabled: p.enabled !== false,
      operators: (p.operators || []).slice(),
      domiciles: (p.domiciles || []).slice(),
      allowedDataCategories: (p.allowedDataCategories || []).slice(),
      permittedRequestTypes: (p.permittedRequestTypes || []).slice(),
      lifecyclePermission: p.lifecyclePermission || 'not_allowed',
      createWrPermission: p.createWrPermission || 'not_allowed',
      capturedAt: new Date().toISOString(),
    };
  } catch (_) { return null; }
}
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
async function handleInbound(input, deps) {
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
    // PART 3: DO NOT route or execute actions here. Proposed actions are
    // carried on the decision and become part of the SINGLE reply+action
    // transaction, executed only AFTER the final confidence/evidence/scope/mode
    // gate below (on autonomous auto-send, or when the operator approves the
    // reply). Executing before the gate would let unverified/low-confidence or
    // out-of-scope proposals run.
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
    // PART 3: reply + its (low-risk) actions are ONE transaction. Execute the
    // linked actions FIRST and verify them; only auto-send the reply if they
    // all succeed. If any action fails/does not verify, do NOT auto-send a
    // success reply — queue for review with the truthful outcome.
    const execRes = await _executeLinkedActions(input, decision);
    decision._actionOutcomes = execRes.outcomes;
    if (!execRes.ok) {
      const item = _queueReply(input, decision, { failReason: 'a proposed action failed/did not verify', actionOutcomes: execRes.outcomes });
      const audit = { ...base, outcome: 'action-failed-queued', approvalId: item.id, actionOutcomes: execRes.outcomes };
      _appendAudit(audit);
      return { mode, letLegacyReply: false, decision, outcome: 'queued', approvalId: item.id, actionOutcomes: execRes.outcomes, audit };
    }
    // AUTONOMOUS DELIVERY SAFETY (Part 8): case memory / promises / follow-ups
    // must NOT be committed until Slack confirms delivery with a timestamp.
    // If a send path is available here, send now and commit ONLY on a confirmed
    // ts; on failure, queue a recoverable review item and commit nothing.
    const autoSend = (deps && deps.sendToChannel) || null;
    if (autoSend) {
      const tagged = (input.slackId ? '<@' + input.slackId + '> ' : '') + decision.reply;
      let sr;
      try { sr = await autoSend(input.channelId, tagged, input.threadTs || undefined); }
      catch (e) { sr = null; decision._sendError = e.message; }
      if (sr && sr.ts) {
        const audit = { ...base, outcome: 'auto-sent', actionOutcomes: execRes.outcomes, sentTs: sr.ts };
        _appendAudit(audit);
        _updateCaseFromInteraction(input, decision, 'auto-sent'); // AFTER confirmed send
        return { mode, letLegacyReply: false, decision, outcome: 'auto-sent', sent: { ts: sr.ts }, actionOutcomes: execRes.outcomes, audit };
      }
      // Delivery failed -> recoverable review; NO case memory committed.
      const item = _queueReply(input, decision, { failReason: 'autonomous Slack delivery failed: ' + (decision._sendError || 'no ts'), actionOutcomes: execRes.outcomes });
      const audit = { ...base, outcome: 'auto-send-failed-queued', approvalId: item.id, actionOutcomes: execRes.outcomes };
      _appendAudit(audit);
      return { mode, letLegacyReply: false, decision, outcome: 'auto-send-failed', approvalId: item.id, actionOutcomes: execRes.outcomes, audit };
    }
    // No send path injected (current DM/channel callers): return fasReply for
    // the caller to send. Case memory is committed by the caller via
    // confirmAutonomousSend() ONLY after Slack confirms — NOT here.
    const audit = { ...base, outcome: 'auto-sent-pending-delivery', actionOutcomes: execRes.outcomes };
    _appendAudit(audit);
    return { mode, letLegacyReply: false, fasReply: decision.reply, decision, outcome: 'auto-sent', _pendingCaseCommit: true, actionOutcomes: execRes.outcomes, audit };
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

// Execute a decision's proposed actions through the VERIFIED executor as part
// of one transaction. Returns { ok, outcomes } — ok is false if any action did
// not reach a 'done' (or idempotent-done) state, so the caller can avoid
// sending a success reply for an action that failed/did not verify (Part 3).
async function _executeLinkedActions(input, decision, approverProfile) {
  const outcomes = [];
  const list = Array.isArray(decision.actions) ? decision.actions.slice(0, 6) : [];
  if (!list.length) return { ok: true, outcomes };
  let executor; try { executor = require('./executor'); } catch (_) { return { ok: false, outcomes: [{ error: 'executor unavailable' }] }; }
  const profile = approverProfile || require('./sender-profiles').resolveSender(input.slackId, input.senderName);
  // Autonomous: the requester IS the sender (no separate operator). The
  // requester snapshot still gates lifecycle 3-state + scope at execution.
  const requesterSnapshot = _buildRequesterSnapshot(input);
  let allOk = true;
  for (const a of list) {
    if (!a || !a.tool) continue;
    try {
      const r = await executor.executeVerified(a.tool, { ...(a.args || {}), slackId: input.slackId }, { profile, requesterSnapshot });
      outcomes.push({ tool: a.tool, status: r.status, error: r.error });
      // A linked action counts as OK only if done (verified) or idempotent-done.
      if (!(r.status === 'done' || (r.idempotent && r.status === 'done'))) allOk = false;
    } catch (e) { outcomes.push({ tool: a.tool, status: 'error', error: e.message }); allOk = false; }
  }
  return { ok: allOk, outcomes };
}

// Queue a proposed REPLY as a SINGLE transaction that also carries its proposed
// actions, evidence, sender+permission snapshot, confidence, and state. The
// linked actions are executed only when this transaction is approved (or, in
// autonomous, alongside the auto-send) — never as a separate independent queue.
const REPLY_QUEUE_CAP = 300;
function _queueReply(input, decision, extra) {
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
    // IMMUTABLE original-requester permission snapshot (Part 5). Captured at
    // proposal time; used at EXECUTION to verify the requester was permitted to
    // request the action — the operator's Approve does NOT replace this.
    requesterSnapshot: _buildRequesterSnapshot(input),
    // Risk classification: does this transaction include a mutating action?
    riskClass: _hasApprovalLevelAction(decision) ? 'mutating' : ((decision.actions || []).length ? 'low-risk-action' : 'reply-only'),
    // State-machine + linked-transaction bookkeeping.
    claimedBy: null,
    executionResults: [],
    sentEvidence: null,
    ...(extra || {}),
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
// Atomically CLAIM a pending transaction so two windows / rapid double-clicks
// can't both approve it. Returns the claimed item or null.
function _claimTransaction(id) {
  const q = _loadQueue();
  const item = q.find(x => x.id === id && x.kind === 'reply');
  if (!item) return { error: 'reply not found' };
  if (item.status !== 'pending') return { error: 'not pending (' + item.status + ')' };
  item.status = 'claimed';
  item.claimedBy = 'operator';
  item.claimedAt = new Date().toISOString();
  _saveQueue(q);
  return { item };
}
function _setTxnStatus(id, status, patch) {
  const q = _loadQueue();
  const it = q.find(x => x.id === id);
  if (it) { it.status = status; Object.assign(it, patch || {}); it.updatedAt = new Date().toISOString(); _saveQueue(q); }
  return it;
}

/**
 * approveReply(id, ctx, deps) — approve ONE linked reply+action transaction.
 *
 * PART 3 ordering (verify-before-send): atomic claim -> execute + VERIFY the
 * linked actions FIRST -> only if they all succeed, send the reply -> record
 * Slack send evidence -> commit case memory. If any action fails/doesn't
 * verify, DO NOT send the (success) reply; mark the transaction failed with the
 * truthful outcome so the operator can send a corrected message.
 *
 * deps.sendToChannel is injectable for testing; ctx.profile is the approver.
 */
async function approveReply(id, ctx, deps) {
  // 1) Atomic claim — prevents double approval.
  const claim = _claimTransaction(id);
  if (claim.error) return { ok: false, error: claim.error };
  const item = claim.item;

  const sendToChannel = (deps && deps.sendToChannel) ||
    (() => { try { return require('../../scrapers/slack_send').sendToChannel; } catch (_) { return null; } })();
  if (!sendToChannel) { _setTxnStatus(id, 'failed', { failReason: 'send path unavailable' }); return { ok: false, error: 'send path unavailable' }; }

  const approver = (ctx && ctx.profile) || { slackId: 'operator', name: 'Operator', type: 'internal',
    operators: [], domiciles: [], allowedDataCategories: ['*'],
    permittedRequestTypes: ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'] };

  // 2) Execute + VERIFY the linked actions FIRST (before sending the reply).
  _setTxnStatus(id, 'executing');
  const actionOutcomes = [];
  let anyFailed = false;
  let anyVerifying = false;
  if (Array.isArray(item.proposedActions) && item.proposedActions.length) {
    _setTxnStatus(id, 'verifying');
    const executor = require('./executor');
    for (const a of item.proposedActions.slice(0, 6)) {
      if (!a || !a.tool) continue;
      try {
        // Part 5: pass BOTH the APPROVER (operator) profile AND the IMMUTABLE
        // ORIGINAL-REQUESTER snapshot. The executor verifies the requester was
        // permitted to request this action (incl. lifecycle 3-state) — the
        // operator's Approve does NOT bypass the requester's authority.
        const r = await executor.executeVerified(a.tool, { ...(a.args || {}), slackId: item.slackId }, { profile: approver, requesterSnapshot: item.requesterSnapshot });
        actionOutcomes.push({ tool: a.tool, status: r.status, error: r.error, deferred: !!r.deferred });
        if (r.status === 'verifying' || (r.status !== 'done' && r.deferred)) anyVerifying = true;
        else if (r.status !== 'done') anyFailed = true;
      } catch (e) { actionOutcomes.push({ tool: a.tool, status: 'error', error: e.message }); anyFailed = true; }
    }
  }

  // 3a) A hard failure -> DO NOT send the success reply. Truthful failure.
  if (anyFailed) {
    _setTxnStatus(id, 'failed', { executionResults: actionOutcomes, failReason: 'a proposed action failed or did not verify — reply not sent' });
    _appendAudit({ at: new Date().toISOString(), kind: 'reply-action-failed', id, actionOutcomes });
    return { ok: false, error: 'linked action failed/unverified — success reply NOT sent', actionOutcomes };
  }

  // 3b) DEFERRED verification (e.g. MOVE_UNIT awaiting AAP read-back, Part 7):
  //     keep the SAME transaction in a 'waiting-verification' state and send
  //     NOTHING now. A later fleet sync's reconcile resumes THIS exact txn:
  //     resumeVerifiedTransactions() sends the truthful reply once (or fails it
  //     with an operator-review item). Never send a false success meanwhile.
  if (anyVerifying) {
    _setTxnStatus(id, 'waiting-verification', { executionResults: actionOutcomes, waitingSince: new Date().toISOString() });
    _appendAudit({ at: new Date().toISOString(), kind: 'reply-awaiting-verification', id, actionOutcomes });
    return { ok: true, deferred: true, status: 'waiting-verification', actionOutcomes };
  }

  // 4) Actions verified (or none) — send the reply + resolve the transaction.
  return _finalizeSendAndCommit(id, item, actionOutcomes, sendToChannel);
}

// Send the transaction's reply through the real path, record Slack evidence,
// commit case memory (ONLY after Slack confirms), and resolve the txn to 'sent'.
// Idempotent: if the txn is already 'sent' it does nothing (prevents double-send
// from a restart/retry/reconcile race). Used by approveReply AND the deferred
// verification resume path so the reply is sent EXACTLY ONCE.
async function _finalizeSendAndCommit(id, item, actionOutcomes, sendToChannel) {
  // Re-load + guard: only a transaction not already sent may be finalized.
  const cur = _loadQueue().find(x => x.id === id);
  if (cur && cur.status === 'sent') return { ok: true, alreadySent: true, sent: cur.sentEvidence };
  const send = sendToChannel || (() => { try { return require('../../scrapers/slack_send').sendToChannel; } catch (_) { return null; } })();
  if (!send) { _setTxnStatus(id, 'failed', { failReason: 'send path unavailable' }); return { ok: false, error: 'send path unavailable' }; }

  const tagged = (item.slackId ? '<@' + item.slackId + '> ' : '') + (item.proposedReply || '');
  let sendRes;
  try { sendRes = await send(item.channelId, tagged, item.threadTs || undefined); }
  catch (e) { _setTxnStatus(id, 'failed', { executionResults: actionOutcomes, failReason: 'send failed: ' + e.message }); return { ok: false, error: 'send failed: ' + e.message, actionOutcomes }; }
  if (!sendRes || !sendRes.ts) { _setTxnStatus(id, 'failed', { executionResults: actionOutcomes, failReason: 'send returned no ts' }); return { ok: false, error: 'send returned no ts', actionOutcomes }; }

  _setTxnStatus(id, 'sent', { sentEvidence: { ts: sendRes.ts, channel: item.channelId, at: new Date().toISOString() },
    executionResults: actionOutcomes, resolvedAt: new Date().toISOString() });
  _appendAudit({ at: new Date().toISOString(), kind: 'reply-approved-sent', id, sentTs: sendRes.ts, channel: item.channelId, actionOutcomes });

  // Commit case memory only AFTER Slack confirmed the send (Part 7).
  try {
    _updateCaseFromInteraction(
      { slackId: item.slackId, channelId: item.channelId, ts: item.ts },
      { decision: item.decision, reply: item.proposedReply, followUp: item.followUp,
        _actionOutcomes: actionOutcomes,
        _evidence: { verifiedFacts: (item.evidence && item.evidence.verifiedFacts) || [],
          sources: (item.evidence && item.evidence.sources) || [],
          entities: { units: item.targetUnit ? [item.targetUnit] : [] } } },
      'approved-sent');
  } catch (_) {}
  return { ok: true, sent: { ts: sendRes.ts, channel: item.channelId }, actionOutcomes };
}

/**
 * resumeVerifiedTransactions(deps) — Part 7. Called AFTER a fleet sync's
 * lifecycle reconcile. For every reply transaction in 'waiting-verification':
 *   - look up whether its linked lifecycle action(s) have now resolved via the
 *     executor idempotency ledger (done vs failed);
 *   - if DONE: resume THIS exact transaction — send the truthful reply once,
 *     record Slack evidence, commit case memory;
 *   - if FAILED (sync disagreed): mark the txn failed + leave a visible
 *     operator-review record. Never send a false success.
 * Uses per-transaction status guards so a restart/retry cannot double-send.
 */
async function resumeVerifiedTransactions(deps) {
  const q = _loadQueue();
  const waiting = q.filter(x => x.kind === 'reply' && x.status === 'waiting-verification');
  if (!waiting.length) return { resumed: 0, failed: 0 };
  let executor; try { executor = require('./executor'); } catch (_) { return { resumed: 0, failed: 0 }; }
  const sendToChannel = (deps && deps.sendToChannel) || null;
  let resumed = 0, failed = 0;
  for (const item of waiting) {
    // Atomically claim this txn for resume so two syncs/restarts can't both act.
    const claimed = _claimResume(item.id);
    if (!claimed) continue;
    // Resolve the lifecycle state of the linked MOVE_UNIT action(s).
    const verdicts = (item.proposedActions || []).filter(a => a && (a.tool === 'MOVE_UNIT'))
      .map(a => executor.lifecycleVerdictFor(a.tool, { ...(a.args || {}), slackId: item.slackId }));
    const anyStillPending = verdicts.some(v => v === 'verifying' || v === 'unknown');
    const anyFailed = verdicts.some(v => v === 'failed');
    if (anyFailed) {
      _setTxnStatus(item.id, 'failed', { failReason: 'lifecycle verification disagreed on sync — success reply NOT sent; operator review required', needsOperatorReview: true });
      _appendAudit({ at: new Date().toISOString(), kind: 'reply-verification-failed', id: item.id });
      failed++;
      continue;
    }
    if (anyStillPending) { _setTxnStatus(item.id, 'waiting-verification', {}); continue; } // still waiting; unclaim by resetting
    // All linked lifecycle actions confirmed done -> resume + send truthfully once.
    const res = await _finalizeSendAndCommit(item.id, item, item.executionResults || [], sendToChannel);
    if (res.ok) resumed++;
  }
  return { resumed, failed };
}

// Called by a DM/channel caller AFTER it has confirmed the autonomous reply was
// delivered (Slack returned a ts). Commits case memory exactly once. If the
// caller could not confirm delivery, it must NOT call this — nothing is
// committed and the message stays recoverable (Part 8).
function confirmAutonomousSend(input, decision) {
  if (!input || !decision) return { ok: false };
  try { _updateCaseFromInteraction(input, decision, 'auto-sent'); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Claim a waiting-verification txn for resume (prevents double resume/send).
function _claimResume(id) {
  const q = _loadQueue();
  const it = q.find(x => x.id === id);
  if (!it || it.status !== 'waiting-verification') return false;
  it.status = 'resuming'; it.resumeAt = new Date().toISOString();
  _saveQueue(q);
  return true;
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

module.exports = { handleInbound, approveReply, rejectReply, getReplyQueue, resumeVerifiedTransactions, confirmAutonomousSend, _finalizeSendAndCommit, _buildRequesterSnapshot, _divergence, _hasApprovalLevelAction, _extractPromise, _validateDueAt, _nextBusinessDueAt, AUTO_SEND_MIN_CONFIDENCE };
