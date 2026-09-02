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

  // ── SHADOW: legacy replies; we only record the comparison. ────────────────
  if (mode === 'shadow') {
    const audit = { ...base, actualReply: input.actualReply || '',
      divergence: Number(_divergence(input.actualReply, decision.reply).toFixed(3)) };
    _appendAudit(audit);
    return { mode, letLegacyReply: true, decision, outcome: 'shadow', actionOutcomes, audit };
  }

  // ── APPROVAL: queue the proposed reply; legacy stays silent. ──────────────
  if (mode === 'approval') {
    const item = _queueReply(input, decision);
    const audit = { ...base, outcome: 'queued-for-approval', approvalId: item.id };
    _appendAudit(audit);
    return { mode, letLegacyReply: false, decision, outcome: 'queued', approvalId: item.id, actionOutcomes, audit };
  }

  // ── AUTONOMOUS: auto-send only routine, confident answers w/o approval-level
  // actions or unresolved gaps; otherwise queue. Legacy stays silent either way.
  const gapsOrConflicts = (base.missingFacts && base.missingFacts.length) || (base.conflicts && base.conflicts.length);
  const canAutoSend =
    decision.decision === 'answer' &&
    typeof decision.reply === 'string' && decision.reply.trim().length > 0 &&
    (decision.confidence == null || decision.confidence >= AUTO_SEND_MIN_CONFIDENCE) &&
    !_hasApprovalLevelAction(decision) &&
    !gapsOrConflicts;

  if (canAutoSend) {
    const audit = { ...base, outcome: 'auto-sent' };
    _appendAudit(audit);
    return { mode, letLegacyReply: false, fasReply: decision.reply, decision, outcome: 'auto-sent', actionOutcomes, audit };
  }

  const item = _queueReply(input, decision);
  const audit = { ...base, outcome: 'queued-for-approval',
    queueReason: decision.decision !== 'answer' ? ('decision=' + decision.decision)
      : gapsOrConflicts ? 'missing/conflicting evidence'
      : _hasApprovalLevelAction(decision) ? 'approval-level action proposed'
      : 'low confidence', approvalId: item.id };
  _appendAudit(audit);
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

module.exports = { handleInbound, _divergence, _hasApprovalLevelAction, AUTO_SEND_MIN_CONFIDENCE };
