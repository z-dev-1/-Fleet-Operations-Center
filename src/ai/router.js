'use strict';
/**
 * src/ai/router.js — Unified AI Core task-aware model routing (spec #6).
 *
 * The existing relay (orcha/relay.js) already load-balances across lanes
 * (Orcha / Claude / Bedrock) by lane HEALTH + preference, with a proven
 * fallback cascade. The spec asks that TASK CHARACTERISTICS also influence the
 * choice — WITHOUT replacing that cascade and WITHOUT duplicating calls.
 *
 * DESIGN (additive, non-destructive):
 *   - classifyTask(request) derives task metadata (taskType, complexity,
 *     requiresVision, actionRisk, latencyClass) from a request.
 *   - recommendLane(task) maps that metadata to a RECOMMENDED lane + model
 *     hint + rationale, respecting current lane health (read from relay) so we
 *     never recommend a lane that is down.
 *   - This is a RECOMMENDATION surface: it is recorded on the AI trace and can
 *     be consumed by callers that support a per-call preference. It does NOT
 *     force the relay to change lanes mid-cascade and NEVER issues a second
 *     model call (no duplicate calls unless a caller explicitly configures an
 *     evaluation A/B, which this module does not do on its own).
 *
 * Routing intent (from the spec), mapped to the app's real lanes:
 *   - simple classification/extraction        -> fast lane (claude-code / small)
 *   - normal Slack reply                       -> balanced/default (relay 'auto')
 *   - multi-source fleet reasoning             -> strong lane (Orcha agent / Sonnet-class)
 *   - image/PDF/attachment understanding       -> vision-capable lane (claude)
 *   - high-risk action reasoning               -> strongest reliable lane (Orcha/Sonnet)
 *   - fallback                                 -> next healthy compatible lane (relay cascade)
 */

// Lane tokens aligned with relay's own lanes/preferences.
const LANES = { FAST: 'claude', BALANCED: 'auto', STRONG: 'orcha', VISION: 'claude' };

const TASK_TYPES = [
  'classification', 'extraction', 'unit_status', 'slack_reply', 'unit_reasoning',
  'multi_source_reasoning', 'attachment_understanding', 'action_reasoning', 'report', 'unknown',
];

function _isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * classifyTask(request) -> task metadata.
 * Accepts the AiCore request ({ source, message, task, attachments, ... }) OR a
 * partial task object. Any explicit request.task fields WIN over inference, so
 * a caller can override the heuristic. Pure + side-effect free.
 */
function classifyTask(request) {
  request = request || {};
  const explicit = _isPlainObject(request.task) ? request.task : {};
  const msg = String(request.message || '').toLowerCase();
  const source = request.source || explicit.source || 'unknown';

  // Vision requirement: any attached files/links the evidence layer would read
  // as PDF/image, or an explicit flag.
  const files = _attachmentFiles(request.attachments);
  const hasVisualAttachment = files.some((f) => /\.(png|jpe?g|gif|webp|pdf)$/i.test(String((f && (f.name || f.title || f.url)) || '')));
  const requiresVision = explicit.requiresVision === true || hasVisualAttachment;

  // Action risk: a lifecycle/WR/send request (or a flip phrasing) is higher risk.
  let actionRisk = explicit.actionRisk;
  if (!actionRisk) {
    if (/\b(flip|activate|reactivate|release|move|lifecycle|create (?:a )?(?:wr|work order|work request)|submit)\b/.test(msg)) actionRisk = 'high';
    else actionRisk = 'low';
  }

  // Task type inference (explicit wins).
  let taskType = TASK_TYPES.includes(explicit.taskType) ? explicit.taskType : null;
  if (!taskType) {
    if (requiresVision) taskType = 'attachment_understanding';
    else if (source === 'dbr' || source === 'wbr' || /\b(report|briefing|summary|dbr|wbr)\b/.test(msg)) taskType = 'report';
    else if (actionRisk === 'high') taskType = 'action_reasoning';
    else if (/\b(why|compare|across|all (?:units|sites)|fleet[- ]wide|root cause|trend)\b/.test(msg)) taskType = 'multi_source_reasoning';
    // A clear short status question is unit_status even on a Slack source — the
    // specific intent wins over the generic slack_reply fallback below.
    else if (msg.length < 60 && /\b(status|where|what state|lifecycle)\b|\bis\s+[a-z]?\d{3,}\b/.test(msg)) taskType = 'unit_status';
    else if (source === 'slack_dm' || source === 'slack_channel' || source === 'slack_dm_thread') taskType = 'slack_reply';
    else taskType = 'unknown';
  }

  // Complexity (explicit wins): multi-source/report/action => high; short
  // status/classification => low; otherwise medium.
  let complexity = explicit.complexity;
  if (!complexity) {
    if (['multi_source_reasoning', 'report', 'action_reasoning'].includes(taskType)) complexity = 'high';
    else if (['classification', 'extraction', 'unit_status'].includes(taskType)) complexity = 'low';
    else complexity = 'medium';
  }

  // Latency class: interactive by default; reports/batch are relaxed.
  let latencyClass = explicit.latencyClass;
  if (!latencyClass) latencyClass = (taskType === 'report') ? 'batch' : 'interactive';

  return { taskType, complexity, requiresVision: !!requiresVision, actionRisk, latencyClass, source };
}

/**
 * recommendLane(task, opts) -> { lane, modelHint, rationale, healthy, fallbackLane }
 * Maps task metadata to a recommended lane, then adjusts for CURRENT lane
 * health (read from relay.getStatus) so a down lane is never recommended. The
 * recommendation is advisory — the relay cascade still owns actual execution
 * and fallback.
 */
function recommendLane(task, opts) {
  task = task || {};
  opts = opts || {};
  const health = _laneHealth(opts);

  // Base mapping from routing intent.
  let lane, rationale;
  if (task.requiresVision) { lane = LANES.VISION; rationale = 'vision-capable lane for image/PDF/attachment understanding'; }
  else if (task.actionRisk === 'high' || task.taskType === 'action_reasoning') { lane = LANES.STRONG; rationale = 'strongest reliable lane for high-risk action reasoning'; }
  else if (task.taskType === 'multi_source_reasoning' || task.complexity === 'high') { lane = LANES.STRONG; rationale = 'strong lane for multi-source fleet reasoning'; }
  else if (task.taskType === 'classification' || task.taskType === 'extraction' || task.complexity === 'low') { lane = LANES.FAST; rationale = 'fast lane for simple classification/extraction'; }
  else { lane = LANES.BALANCED; rationale = 'balanced/default lane for a normal reply'; }

  // Health adjustment: if the recommended concrete lane is down, fall back to
  // the next healthy compatible lane (mirrors the relay cascade intent). The
  // 'auto'/balanced recommendation already defers to the relay's own routing.
  let healthy = true, fallbackLane = null;
  if (lane === 'orcha' && !health.orcha) {
    healthy = false; fallbackLane = health.claude ? 'claude' : 'auto';
    rationale += '; Orcha lane down -> recommend ' + fallbackLane;
  } else if (lane === 'claude' && !health.claude) {
    healthy = false; fallbackLane = health.orcha ? 'orcha' : 'auto';
    rationale += '; Claude lane down -> recommend ' + fallbackLane;
  }

  return {
    lane: fallbackLane || lane,
    modelHint: _modelHint(fallbackLane || lane, task),
    rationale,
    healthy,
    fallbackLane,
  };
}

/**
 * route(request, opts) -> { task, recommendation }
 * Convenience: classify + recommend in one call for AiCore/trace.
 */
function route(request, opts) {
  const task = classifyTask(request);
  const recommendation = recommendLane(task, opts);
  return { task, recommendation };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function _attachmentFiles(att) {
  if (!att) return [];
  if (Array.isArray(att)) return att;
  if (_isPlainObject(att) && Array.isArray(att.files)) return att.files;
  return [];
}

// Read current lane health from relay (best-effort). Unknown -> treat as
// available so the router never blocks on a missing probe.
function _laneHealth(opts) {
  if (opts && opts.laneHealth) return opts.laneHealth; // injectable for tests
  try {
    const s = require('../orcha/relay').getStatus();
    const b = (s && s.backends) || {};
    return { orcha: b.orcha !== false, claude: b.claude !== false };
  } catch (_) { return { orcha: true, claude: true }; }
}

// A human-facing model hint for the lane (not a hard selection). The real model
// is owned by the Orcha agent config / claude model setting; this is a label
// for the trace/UI.
function _modelHint(lane, task) {
  if (lane === 'claude') return task.requiresVision ? 'claude (vision-capable)' : 'claude (fast lane)';
  if (lane === 'orcha') return 'orcha agent (strong)';
  return 'auto (relay balanced)';
}

module.exports = { classifyTask, recommendLane, route, LANES, TASK_TYPES };
