'use strict';
/**
 * src/ai/status.js — Unified AI Core health / capability status (spec #18).
 *
 * Exposes ONE backend status object that can later drive an "AI Health" screen.
 * Per the spec, the backend interface is built FIRST; no UI is required in this
 * phase.
 *
 * It is HONEST and composed from REAL runtime signals (never fabricated green):
 *   - lane health: Fleet Brain / Orcha / Claude Code / Bedrock, from the live
 *     relay.getStatus() (backends + request/error counts + lastHealthy/Error);
 *   - configured models: from relay status + FAS config;
 *   - cluster role + whether production ACTIONS are currently allowed;
 *   - attachment-reading availability (claude-code / link-research presence);
 *   - trace-derived quality metrics (ai/eval): answer success, fallback rate,
 *     tool success, avg latency, model usage, correction rate;
 *   - queue length / active requests (best-effort from relay internals).
 *
 * Every probe is wrapped so building the snapshot NEVER throws. A signal that
 * cannot be read degrades to a neutral/unknown value rather than a false green.
 */

const evalMod = require('./eval');
let logger; try { logger = require('../utils/logger').createLogger('ai-status'); } catch (_) { logger = { info() {}, warn() {} }; }

function _safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; }
}

// ── Lane health ──────────────────────────────────────────────────────────────
// Reads relay.getStatus() for the real per-backend availability. Fleet Brain is
// the orchestrator in front of Orcha (WS) + Claude (claude-code) + Bedrock, so
// we report Fleet Brain readiness plus each lane. Bedrock is a terminal
// fallback with no always-on probe — reported as "fallback" (configured) rather
// than a live up/down, which is honest.
function _lanes() {
  const relayStatus = _safe(() => require('../orcha/relay').getStatus(), null);
  const fbStatus = _safe(() => require('../orcha/fleet-brain').getStatus(), null);

  const backends = (relayStatus && relayStatus.backends) || {};
  const orchaUp = !!backends.orcha;
  const claudeUp = !!backends.claude;

  const fleetBrain = fbStatus
    ? { status: fbStatus.ready ? 'up' : 'down', ready: !!fbStatus.ready, localMode: !!fbStatus.localMode, connected: !!fbStatus.connected }
    : { status: 'unknown', ready: false };

  return {
    fleetBrain,
    orcha: { status: orchaUp ? 'up' : (relayStatus ? 'down' : 'unknown') },
    claude: { status: claudeUp ? 'up' : (relayStatus ? 'down' : 'unknown') },
    // Bedrock is a last-resort fallback; presence of the SDK path is the only
    // honest signal without making a live call.
    bedrock: { status: _safe(() => { require('../scrapers/bedrock'); return 'fallback'; }, 'unknown') },
  };
}

// ── Configured models + routing preference ───────────────────────────────────
function _models() {
  const relayStatus = _safe(() => require('../orcha/relay').getStatus(), null);
  const fasCfg = _safe(() => require('../orcha/fas/config').get(), null);
  return {
    primaryModel: (relayStatus && relayStatus.model) || null,
    region: (relayStatus && relayStatus.region) || null,
    routingPreference: (relayStatus && relayStatus.preference) || null, // auto|orcha|claude|balanced
    fasMode: fasCfg ? (fasCfg.enabled ? (fasCfg.mode || 'shadow') : 'disabled') : 'unknown',
  };
}

// ── Relay counters (request/error totals + recent error ratio) ────────────────
function _reliability() {
  const s = _safe(() => require('../orcha/relay').getStatus(), null);
  if (!s) return { requestCount: null, errorCount: null, recentErrorRate: null, lastHealthy: null, lastError: null };
  const req = typeof s.requestCount === 'number' ? s.requestCount : null;
  const err = typeof s.errorCount === 'number' ? s.errorCount : null;
  return {
    requestCount: req,
    errorCount: err,
    recentErrorRate: (req && err != null) ? Number((err / req).toFixed(3)) : null,
    lastHealthy: s.lastHealthy || null,
    lastError: s.lastError || null,
    status: s.status || 'unknown',
  };
}

// ── Cluster role + production-action availability ─────────────────────────────
// Production fleet ACTIONS (MOVE_UNIT / SUBMIT_WORK_REQUEST etc.) require the
// cluster production leadership gate when the cluster is enabled. We report the
// role and whether production is currently allowed — read-only reasoning may
// run regardless, but mutations are gated (spec #14). Degrades to "standalone"
// when the cluster module is absent/disabled.
function _cluster() {
  const info = _safe(() => {
    const c = require('../cluster');
    if (c && typeof c.getStatus === 'function') return c.getStatus();
    if (c && typeof c.status === 'function') return c.status();
    return null;
  }, null);
  if (!info || info.enabled === false) {
    return { enabled: false, role: 'standalone', productionActionsAllowed: true, detail: 'single-host (cluster disabled)' };
  }
  const role = info.role || info.mode || 'unknown';
  // Production actions allowed only when the cluster's OWN authoritative gate
  // says so (mayRunProduction / isLeader + productionReady). We do NOT re-derive
  // this from the role string — the cluster is the single source of truth
  // (spec #14). Any non-production role is read-only for mutations.
  const allowed = info.mayRunProduction === true ||
    (info.isLeader === true && info.productionReady === true);
  return {
    enabled: true,
    role,
    productionActionsAllowed: !!allowed,
    detail: allowed ? ('holds production leadership (' + role + ')') : ('read-only for mutations (' + role + ')'),
  };
}

// ── Attachment-reading availability (spec #13 capability surface) ─────────────
function _attachments() {
  const linkResearch = _safe(() => { require('../orcha/fas/link-research'); return true; }, false);
  const attachmentResearch = _safe(() => { require('../orcha/fas/attachment-research'); return true; }, false);
  // Claude-code presence is the primary signal for PDF/image understanding.
  const claudeLane = _safe(() => require('../orcha/relay').getStatus().backends.claude, false);
  return {
    available: !!(linkResearch || attachmentResearch),
    linkResearch: !!linkResearch,
    attachmentResearch: !!attachmentResearch,
    visionCapableLane: !!claudeLane,
  };
}

/**
 * snapshot(opts) -> the composed AI health/capability status object.
 * opts.metricsLimit — how many recent traces to aggregate for quality metrics.
 *
 * Shape:
 *   {
 *     at,
 *     lanes: { fleetBrain, orcha, claude, bedrock },
 *     models: { primaryModel, region, routingPreference, fasMode },
 *     reliability: { requestCount, errorCount, recentErrorRate, status, lastHealthy, lastError },
 *     cluster: { enabled, role, productionActionsAllowed, detail },
 *     attachments: { available, linkResearch, attachmentResearch, visionCapableLane },
 *     metrics: <ai/eval.metrics()>,
 *     overall: { status: 'up'|'degraded'|'down', reasons: [] }
 *   }
 */
function snapshot(opts) {
  opts = opts || {};
  const lanes = _lanes();
  const models = _models();
  const reliability = _reliability();
  const cluster = _cluster();
  const attachments = _attachments();
  const metrics = _safe(() => evalMod.metrics({ limit: opts.metricsLimit || 200 }), {});

  // Overall roll-up: UP if any reasoning lane is up; DEGRADED if only fallback
  // reachable or a high recent error rate; DOWN if nothing is reachable.
  const reasons = [];
  const anyUp = lanes.fleetBrain.ready || lanes.orcha.status === 'up' || lanes.claude.status === 'up';
  let overallStatus = 'down';
  if (anyUp) {
    overallStatus = 'up';
    if (reliability.recentErrorRate != null && reliability.recentErrorRate > 0.3) { overallStatus = 'degraded'; reasons.push('elevated recent error rate'); }
    if (!(lanes.orcha.status === 'up') || !(lanes.claude.status === 'up')) reasons.push('one AI lane unavailable');
  } else {
    reasons.push('no AI reasoning lane reachable');
  }
  if (metrics && metrics.fallbackRate != null && metrics.fallbackRate > 0.5) { if (overallStatus === 'up') overallStatus = 'degraded'; reasons.push('high fallback rate'); }

  return {
    at: new Date().toISOString(),
    lanes,
    models,
    reliability,
    cluster,
    attachments,
    metrics,
    overall: { status: overallStatus, reasons },
  };
}

module.exports = { snapshot };
