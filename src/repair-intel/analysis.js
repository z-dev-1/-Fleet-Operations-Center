/**
 * repair-intel/analysis.js — Phase 2 AI layer (narrative + classification +
 * advisory recommendations) on TOP of the deterministic report.
 *
 * Hard boundaries:
 *   - The AI NEVER changes the numbers. Counts, durations, repeat-failure
 *     linkage, downtime and effectiveness tallies come from report.js (plain
 *     math). This layer only adds: a readable narrative summary, a SUSPECTED
 *     root cause / corrective-action read of each work order's own comment
 *     thread, an outcome classification, and ADVISORY recommendations.
 *   - No fabrication. The prompt forbids inventing parts, part numbers, costs,
 *     dates, names, or confirmed root causes. Anything not stated in the source
 *     is "not documented" / "suspected". We only ever write to the AI-writable
 *     allow-list in store.applyAiToEvent (confirmed_* and all numeric/cost/
 *     duration columns are off-limits).
 *   - Advisory only. Recommendations go into ri_recommendation; they NEVER
 *     touch canonical readiness.
 *   - Caching. Keyed by an evidence hash of the unit's events, so re-analysis is
 *     skipped unless the underlying work orders changed (opts.force overrides).
 *   - Bounded. relay.ask is wrapped in a hard timeout; on timeout/failure the
 *     deterministic report still stands and we return a clear not-analyzed note.
 */

const crypto = require('crypto');
let logger; try { logger = require('../utils/logger')('repair-intel'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }
const store = require('./store');
const report = require('./report');
const { loadFullContext } = require('../orcha/source-budget');

const ANALYSIS_VERSION = 1;
const ASK_TIMEOUT_MS = 55000;   // match the baseball-card lane; Orcha ~15s, Claude slower

// Full-context prompt budget for the WORK ORDERS block (settings.ai.fullContext).
const EVENTS_BLOCK_BUDGET = 30000;

const _sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

// With fullContext the vendor evidence (wo_evidence) is part of the prompt, so
// it is part of the cache key too.
function _evidenceHash(events, o = {}) {
  const basis = events.map(e => {
    const line = [e.source_id, e.status, e.modified_at, e.vendor, e.repair_component].join('|');
    return o.fullContext ? line + '|' + _sha1(e.wo_evidence || '') : line;
  }).sort().join('\n');
  return crypto.createHash('sha1').update(basis).digest('hex');
}

// wo_evidence JSON -> indented vendor cause / correction / newest 3 comments.
function _evidenceLines(raw) {
  if (!raw) return [];
  let ev = null; try { ev = JSON.parse(raw); } catch (_) { return []; }
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return [];
  const out = [];
  if (ev.cause) out.push('    vendor cause: ' + String(ev.cause).slice(0, 300));
  if (ev.correction) out.push('    vendor correction: ' + String(ev.correction).slice(0, 300));
  const at = (c) => { const t = typeof c.at === 'number' ? c.at : Date.parse(c.at); return Number.isFinite(t) ? t : 0; };
  const comments = (Array.isArray(ev.comments) ? ev.comments : []).filter(c => c && c.text)
    .slice().sort((a, b) => at(b) - at(a)).slice(0, 3);
  for (const c of comments) {
    const t = at(c);
    const d = t ? new Date(t).toISOString().slice(0, 10) : 'date?';
    out.push('    comment ' + d + ': ' + String(c.text).slice(0, 200));
  }
  return out;
}

// Call relay.ask with a hard timeout so a slow lane can't hang the job. An
// injected relay (opts.relay) is used when provided — chiefly for tests; in
// production we lazy-require the real relay.
// Timeout via relay.runWithTimeout (Promise.race parity with the gateway flag
// off; cancels the call and frees its slot with ai.gateway.abortOnTimeout). An
// injected relay without runWithTimeout uses the real pure helper.
async function _askTimed(prompt, ms, relayOverride, source) {
  let relay = relayOverride;
  if (!relay) { try { relay = require('../orcha/relay'); } catch (_) { return null; } }
  if (!relay || typeof relay.ask !== 'function') return null;
  let rwt = (relayOverride && typeof relayOverride.runWithTimeout === 'function') ? relayOverride.runWithTimeout : null;
  if (!rwt) { try { rwt = require('../orcha/relay').runWithTimeout; } catch (_) { return null; } }
  const run = (sig) => relay.ask(prompt, { signal: sig, source }).catch(e => { logger.warn('relay.ask failed: ' + e.message); return null; });
  return rwt(run, { timeoutMs: ms, timeoutResult: null, source });
}

// Extract the first JSON object/array from a model response (tolerates code
// fences and surrounding prose). Returns null when nothing parseable is found.
function _parseJson(text) {
  if (!text || typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/,'').trim();
  const start = t.search(/[{[]/);
  if (start < 0) return null;
  // Walk to the matching close bracket.
  const open = t[start], close = open === '{' ? '}' : ']';
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

// Build the grounded analysis prompt from the deterministic report + the raw
// event comment threads we have on hand. We feed only facts; we ask for
// interpretation with explicit no-fabrication rules and a strict JSON schema.
// Returns { prompt, omitted }. fullContext OFF = the legacy 40 events x 200-char
// complaint; ON = every event (already newest-first) within EVENTS_BLOCK_BUDGET
// plus the vendor evidence lines.
function _buildPrompt(equipmentId, rep, events, o = {}) {
  const head = (e, n) => {
    const d = e.reported_at ? new Date(e.reported_at).toISOString().slice(0, 10) : 'date?';
    return '- id=' + e.source_id + ' | ' + d + ' | ' + (e.vendor || 'vendor?') + ' | ' + (e.status || '?') +
      ' | ' + (e.repair_category || '') + '/' + (e.repair_component || '') +
      ' | complaint: ' + (e.reported_complaint ? String(e.reported_complaint).slice(0, n) : 'none');
  };
  let evLines, omitted = 0;
  if (!o.fullContext) {
    evLines = events.slice(0, 40).map(e => head(e, 200)).join('\n');
  } else {
    const blocks = [];
    let used = 0;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const block = [head(e, 400) + (e.estimate_cost ? ' | est $' + e.estimate_cost : '')]
        .concat(_evidenceLines(e.wo_evidence)).join('\n');
      if (used + block.length + 1 > EVENTS_BLOCK_BUDGET) { omitted = events.length - i; break; }
      blocks.push(block); used += block.length + 1;
    }
    if (omitted > 0) blocks.push('(' + omitted + ' older work orders not listed — AI input budget)');
    evLines = blocks.join('\n');
  }

  const s = rep.executiveSummary;
  const prompt = [
    'You are a fleet maintenance analyst reviewing the 12-month repair history of unit ' + equipmentId + '.',
    'The following FACTS are already computed deterministically — DO NOT recompute or contradict them:',
    JSON.stringify({ totalRepairEvents: s.totalRepairEvents, corrective: s.correctiveRepairs, pm: s.pmEvents,
      repeatFailureGroups: s.repeatFailureGroups, effectiveness: s.effectiveness, knownDowntimeHours: s.totalKnownDowntimeHours }),
    '',
    'WORK ORDERS (newest first):',
    evLines,
    '',
    'RULES (strict):',
    '1. Do NOT invent parts, part numbers, costs, dates, people, or a CONFIRMED root cause.',
    '2. If a root cause is not stated in the complaint/thread, mark it suspected or say "not documented".',
    ...(o.fullContext ? ['2b. VENDOR CAUSE / CORRECTION / COMMENT lines are source evidence; still mark a cause suspected unless the vendor states it.'] : []),
    '3. Ground every statement in the work orders above. No speculation presented as fact.',
    '4. Recommendations are ADVISORY. Never claim a unit is ready/not-ready for service.',
    '5. Exclude vendor judgments about Velocity, Fleetnet, or Goodyear (already filtered out).',
    '',
    'Return ONLY JSON of this exact shape:',
    '{',
    '  "summary": "<=80 word narrative of this unit\'s repair pattern, grounded in the facts",',
    '  "events": [ { "id": "<source_id>", "suspected_root_cause": "<string or empty>", "corrective_actions": "<string or empty>", "outcome": "resolved|resolved-repeated|partial|unresolved|referred|cancelled|unknown" } ],',
    '  "recommendations": [ { "kind": "monitor|operational|vendor-escalation|technical|network-review|urgent-safety", "finding": "<string>", "reason": "<grounded reason>", "recommendedAction": "<string>", "priority": "low|medium|high", "confidence": "low|medium|high", "supportingWos": ["<source_id>"] } ]',
    '}',
  ].join('\n');
  return { prompt, omitted };
}

// Analyze ONE unit. Returns { ok, cached, summary, events, recommendations } or
// a not-analyzed note. Deterministic report always still available separately.
async function analyzeUnit(equipmentId, opts = {}) {
  const eq = String(equipmentId || '').trim();
  if (!eq) return { ok: false, error: 'no equipment id' };

  const events = store.eventsForUnit(eq);
  if (!events.length) return { ok: false, error: 'no repair events to analyze' };

  const rep = report.buildUnitReport(eq);
  const fullContext = opts.fullContext != null ? !!opts.fullContext : loadFullContext();
  const evidenceHash = _evidenceHash(events, { fullContext });

  // Cache: skip the model call when evidence is unchanged.
  if (!opts.force) {
    const cached = store.getAiAnalysis(eq);
    if (cached && cached.evidence_hash === evidenceHash && cached.report_json) {
      let parsed = null; try { parsed = JSON.parse(cached.report_json); } catch (_) {}
      if (parsed) return { ok: true, cached: true, analyzedAt: cached.analyzed_at, modelId: cached.model_id, ...parsed };
    }
  }

  const { prompt, omitted } = _buildPrompt(eq, rep, events, { fullContext });
  const raw = await _askTimed(prompt, opts.timeoutMs || ASK_TIMEOUT_MS, opts.relay,
    opts.force ? 'repair_intel_unit' : 'repair_intel_analysis');
  if (!raw) return { ok: false, pending: true, error: 'AI lane unavailable or timed out', report: rep };

  const parsed = _parseJson(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'could not parse AI response', report: rep };
  }

  // Validate + constrain. Only known source_ids; only allowed outcome values.
  const validIds = new Set(events.map(e => e.source_id));
  const OUTCOMES = new Set(['resolved','resolved-repeated','partial','unresolved','referred','cancelled','unknown']);
  const evOut = [];
  for (const ev of (Array.isArray(parsed.events) ? parsed.events : [])) {
    if (!ev || !validIds.has(String(ev.id))) continue;
    const ai = {};
    if (ev.suspected_root_cause) ai.suspected_root_cause = String(ev.suspected_root_cause).slice(0, 500);
    if (ev.corrective_actions)   ai.corrective_actions   = String(ev.corrective_actions).slice(0, 500);
    if (ev.outcome && OUTCOMES.has(String(ev.outcome))) ai.outcome = String(ev.outcome);
    if (Object.keys(ai).length) { store.applyAiToEvent(String(ev.id), ai); evOut.push({ id: String(ev.id), ...ai }); }
  }

  const KINDS = new Set(['monitor','operational','vendor-escalation','technical','network-review','urgent-safety']);
  const PRI = new Set(['low','medium','high']); const CONF = new Set(['low','medium','high']);
  const recs = [];
  for (const r of (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])) {
    if (!r || !r.finding) continue;
    const sup = Array.isArray(r.supportingWos) ? r.supportingWos.map(String).filter(id => validIds.has(id)) : [];
    recs.push({
      kind: KINDS.has(r.kind) ? r.kind : 'monitor',
      finding: String(r.finding).slice(0, 400),
      reason: r.reason ? String(r.reason).slice(0, 600) : null,
      recommendedAction: r.recommendedAction ? String(r.recommendedAction).slice(0, 400) : null,
      priority: PRI.has(r.priority) ? r.priority : 'low',
      confidence: CONF.has(r.confidence) ? r.confidence : 'low',
      supportingWos: sup,
    });
  }
  store.replaceRecommendations('unit', eq, recs);

  const summary = parsed.summary ? String(parsed.summary).slice(0, 800) : '';
  const payload = { summary, events: evOut, recommendations: recs };
  if (omitted > 0) payload.omittedEvents = omitted;

  let modelId = null; try { const relay = opts.relay || require('../orcha/relay'); modelId = relay.getStatus && relay.getStatus().model; } catch (_) {}
  store.saveAiAnalysis({ equipmentId: eq, reportJson: payload, evidenceHash, analysisVersion: ANALYSIS_VERSION, modelId });

  logger.info('[' + eq + '] AI analysis: ' + evOut.length + ' events classified, ' + recs.length + ' recommendations');
  return { ok: true, cached: false, analyzedAt: Date.now(), modelId, ...payload };
}

module.exports = { analyzeUnit, ANALYSIS_VERSION, _parseJson, _evidenceHash, _buildPrompt };
