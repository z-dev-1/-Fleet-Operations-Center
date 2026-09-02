'use strict';
/**
 * orcha/fas/shadow.js — Digital FAS rollout: SHADOW mode runner.
 *
 * In shadow mode the FAS agent runs ALONGSIDE the existing DM engine: it
 * researches and drafts a proposed reply/decision, compares it to whatever the
 * live engine actually sent, and records the comparison to the FAS audit log +
 * decision trace. It sends NOTHING and mutates NOTHING — pure observation so
 * the agent's quality can be evaluated against real traffic with zero risk.
 *
 * Guarded so it can never throw into or slow the live reply path (fire-and-log).
 */

const config = require('./config');
const store = require('../../store');
let trace; try { ({ trace } = require('../../scrapers/slack_decision_trace')); } catch (_) { trace = () => {}; }
let logger; try { logger = require('../../utils/logger').createLogger('fas-shadow'); } catch (_) { logger = { info(){}, warn(){} }; }

const AUDIT_CAP = 500;

function _appendAudit(entry) {
  try {
    const log = store.load('fasAuditLog', []);
    const arr = Array.isArray(log) ? log : [];
    arr.unshift(entry);
    if (arr.length > AUDIT_CAP) arr.length = AUDIT_CAP;
    store.save('fasAuditLog', arr);
  } catch (e) { logger.warn('[fas-shadow] audit write failed: ' + e.message); }
}

// Rough similarity so we can flag where FAS diverges most from the live reply.
function _divergence(a, b) {
  const norm = (s) => String(s || '').toLowerCase().replace(/<@[^>]+>/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size && !B.size) return 0;
  let inter = 0; A.forEach(w => { if (B.has(w)) inter++; });
  const union = new Set([...A, ...B]).size;
  return union ? 1 - inter / union : 0; // 0 = identical set, 1 = disjoint
}

/**
 * runShadow({ engine, slackId, senderName, channelName, ts, text, conversation, actualReply })
 * Fire-and-forget: never throws, returns a promise that resolves when logged.
 * `actualReply` = what the live engine actually sent (for comparison).
 */
async function runShadow(input) {
  try {
    const cfg = config.get();
    if (!cfg.enabled || cfg.mode !== 'shadow') return; // only in shadow mode
    const agent = require('./agent');
    const decision = await agent.runAgent({
      slackId: input.slackId,
      senderName: input.senderName,
      text: input.text,
      conversation: input.conversation || [],
      isGroup: !!input.isGroup,
    });

    const divergence = _divergence(input.actualReply, decision.reply);
    const audit = {
      at: new Date().toISOString(),
      mode: 'shadow',
      engine: input.engine || 'dm',
      channelName: input.channelName || '',
      ts: input.ts || '',
      message: input.text || '',
      actualReply: input.actualReply || '',
      fasDecision: decision.decision,
      fasConfidence: decision.confidence,
      fasReason: decision.reason,
      fasReply: decision.reply,
      fasProposedActions: (decision.actions || []).map(a => a && a.tool).filter(Boolean),
      divergence: Number(divergence.toFixed(3)),
      caseId: decision._evidence && decision._evidence.caseId,
      deniedScope: (decision._evidence && decision._evidence.deniedScope) || [],
      missingFacts: (decision._evidence && decision._evidence.missingFacts) || [],
    };
    _appendAudit(audit);
    trace({ engine: 'fas-shadow', channel: input.channelName, sender: input.slackId, ts: input.ts,
      text: input.text, decision: 'shadow:' + decision.decision,
      reason: 'FAS shadow draft (not sent) — divergence ' + audit.divergence, reply: decision.reply });
    logger.info('[fas-shadow] ' + (input.channelName || '') + ' ts=' + input.ts + ' decision=' + decision.decision + ' divergence=' + audit.divergence);
  } catch (e) {
    logger.warn('[fas-shadow] run failed (non-fatal): ' + e.message);
  }
}

module.exports = { runShadow };
