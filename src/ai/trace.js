'use strict';
/**
 * src/ai/trace.js — Unified AI Core structured trace / observability (spec #9).
 *
 * Records one operational trace per AiCore request: request id, source, actor,
 * task type, model/lane, tools called, evidence sources + freshness, latency,
 * fallbacks, output validation, proposed actions, executor result, verification
 * result, and errors. A later operator correction can be attached to the same
 * request id.
 *
 * DOES store: operational facts useful for debugging/metrics.
 * Does NOT store: hidden chain-of-thought or raw model prompts/reasoning.
 *
 * Storage is a dedicated `aiTraceLog` store (a bounded ring), kept SEPARATE
 * from the existing `fasAuditLog` so this additive layer never changes or
 * competes with the FAS audit behavior the app already relies on. Every write
 * is best-effort and guarded — tracing must never break a request.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('ai-trace'); } catch (_) { logger = { info() {}, warn() {} }; }

const STORE_KEY = 'aiTraceLog';
const CAP = 500; // bounded ring, newest-first

function _now() { return new Date().toISOString(); }
function _rid() { return 'ai_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function _load() {
  const raw = store.load(STORE_KEY, []);
  return Array.isArray(raw) ? raw : [];
}
function _save(arr) {
  try { store.save(STORE_KEY, arr.slice(0, CAP)); } catch (e) { logger.warn('[ai-trace] save failed: ' + e.message); }
}

/**
 * start(meta) -> traceHandle
 * Begin a trace for one AiCore request. `meta` carries the known-at-start
 * fields (source, actor, taskType, requestId). Returns a lightweight handle
 * that ACCUMULATES fields in memory; nothing is persisted until finish().
 *
 * The handle NEVER throws — all methods are chainable no-ops on error.
 */
function start(meta) {
  meta = meta || {};
  const t0 = Date.now();
  const rec = {
    requestId: meta.requestId || _rid(),
    at: _now(),
    source: meta.source || 'unknown',       // slack_dm | slack_channel | ui | dbr | wbr | self_dm | ...
    actor: _safeActor(meta.actor),           // { slackId?, name?, type? } — no secrets
    taskType: meta.taskType || null,         // unit_status | report | ...
    model: null,                             // resolved model/lane (filled by model router later)
    lane: meta.lane || null,
    tools: [],                               // tool names called during research
    evidenceSources: [],                     // distinct source tags used
    evidenceFreshness: {},                   // source -> LIVE|RECENT|STALE|UNKNOWN (best-effort)
    fallbacks: [],                           // e.g. ['legacy', 'repair']
    validated: null,                         // boolean: did output pass schema validation
    repaired: false,                         // did it need a structured repair
    actionProposals: [],                     // proposed action tool names (NOT executed here)
    actionOutcomes: [],                      // executor outcomes if the caller ran actions
    verification: null,                      // summary of verify result if present
    outcome: null,                           // runner outcome (shadow/queued/auto-sent/...)
    latencyMs: null,
    error: null,
    correction: null,                        // operator feedback attached later
  };

  const handle = {
    requestId: rec.requestId,
    _rec: rec,
    setTask(taskType) { if (taskType) rec.taskType = String(taskType); return handle; },
    setModel(model, lane) { if (model) rec.model = String(model); if (lane) rec.lane = String(lane); return handle; },
    addTools(names) { (Array.isArray(names) ? names : [names]).forEach((n) => { if (n && !rec.tools.includes(n)) rec.tools.push(String(n)); }); return handle; },
    addEvidenceSource(src, freshness) {
      if (src && !rec.evidenceSources.includes(src)) rec.evidenceSources.push(String(src));
      if (src && freshness) rec.evidenceFreshness[String(src)] = String(freshness);
      return handle;
    },
    addFallback(kind) { if (kind && !rec.fallbacks.includes(kind)) rec.fallbacks.push(String(kind)); return handle; },
    setValidation(validated, repaired) { rec.validated = !!validated; rec.repaired = !!repaired; return handle; },
    addActionProposal(name) { if (name && !rec.actionProposals.includes(name)) rec.actionProposals.push(String(name)); return handle; },
    setActionOutcomes(outcomes) { if (Array.isArray(outcomes)) rec.actionOutcomes = outcomes.map(_safeOutcome); return handle; },
    setVerification(v) { if (v) rec.verification = _safeVerification(v); return handle; },
    setOutcome(outcome) { if (outcome) rec.outcome = String(outcome); return handle; },
    setError(err) { if (err) rec.error = String(err && err.message ? err.message : err).slice(0, 500); return handle; },
    // Fold a FAS decision's telemetry (tools, evidence, proposals) into the
    // trace in one call. Best-effort; reads only operational fields.
    foldDecision(decision) {
      try { _foldDecision(handle, decision); } catch (_) {}
      return handle;
    },
    finish(extra) {
      try {
        rec.latencyMs = Date.now() - t0;
        if (extra && typeof extra === 'object') {
          if (extra.outcome) rec.outcome = String(extra.outcome);
          if (extra.validated != null) rec.validated = !!extra.validated;
          if (extra.error) rec.error = String(extra.error).slice(0, 500);
        }
        const arr = _load();
        arr.unshift(rec);
        _save(arr);
      } catch (e) { logger.warn('[ai-trace] finish failed: ' + e.message); }
      return rec;
    },
  };
  return handle;
}

// Fold operational telemetry from a FAS decision object into a trace handle.
function _foldDecision(handle, decision) {
  if (!decision || typeof decision !== 'object') return;
  const loop = decision._loop || {};
  (loop.research || []).forEach((r) => { if (r && r.tool) handle.addTools(r.tool); });
  const ev = decision._evidence || {};
  (ev.sources || []).forEach((s) => handle.addEvidenceSource(s));
  (ev.verifiedFacts || []).forEach((f) => {
    if (!f || !f.source) return;
    // Best-effort freshness classification from the fact's stale flag / age.
    let fresh = 'UNKNOWN';
    if (f.stale === true) fresh = 'STALE';
    else if (f.sourceUpdatedAt || f.retrievedAt) fresh = f.stale === false ? 'RECENT' : 'UNKNOWN';
    handle.addEvidenceSource(f.source, fresh);
  });
  (decision.actions || []).forEach((a) => { if (a && a.tool) handle.addActionProposal(a.tool); });
  if (decision._fallback) handle.addFallback('ai-fallback');
  if (decision._review && decision._review.changed) handle.addFallback('review-refine');
}

function _safeActor(actor) {
  if (!actor || typeof actor !== 'object') return null;
  return {
    slackId: actor.slackId ? String(actor.slackId).slice(0, 64) : null,
    name: actor.name ? String(actor.name).slice(0, 120) : null,
    type: actor.type ? String(actor.type).slice(0, 32) : null,
  };
}
function _safeOutcome(o) {
  if (!o || typeof o !== 'object') return { status: 'unknown' };
  return { tool: o.tool || null, status: o.status || o.outcome || 'unknown', error: o.error ? String(o.error).slice(0, 300) : undefined, deferred: !!o.deferred };
}
function _safeVerification(v) {
  if (typeof v === 'string') return { summary: v.slice(0, 300) };
  if (!v || typeof v !== 'object') return null;
  return { verified: !!v.verified, deferred: !!v.deferred, evidence: v.evidence ? String(v.evidence).slice(0, 300) : undefined, error: v.error ? String(v.error).slice(0, 300) : undefined };
}

/**
 * attachCorrection(requestId, correction) -> boolean
 * Attach a later operator correction/feedback to an existing trace (spec #9/#10
 * learning data). Returns true if the trace was found and updated.
 */
function attachCorrection(requestId, correction) {
  if (!requestId) return false;
  try {
    const arr = _load();
    const rec = arr.find((r) => r.requestId === requestId);
    if (!rec) return false;
    rec.correction = {
      at: _now(),
      verdict: correction && correction.verdict ? String(correction.verdict).slice(0, 32) : 'noted', // correct | incorrect | edited | ...
      note: correction && correction.note ? String(correction.note).slice(0, 500) : '',
      editedReply: correction && correction.editedReply ? String(correction.editedReply).slice(0, 2000) : undefined,
    };
    _save(arr);
    return true;
  } catch (e) { logger.warn('[ai-trace] attachCorrection failed: ' + e.message); return false; }
}

/** recent(limit) -> newest-first traces (for an AI Health screen / metrics). */
function recent(limit) {
  const arr = _load();
  return arr.slice(0, Math.max(0, limit || 50));
}

module.exports = { start, attachCorrection, recent, STORE_KEY, CAP };
