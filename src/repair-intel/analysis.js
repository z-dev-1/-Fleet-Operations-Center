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

const ANALYSIS_VERSION = 1;
const ASK_TIMEOUT_MS = 55000;   // match the baseball-card lane; Orcha ~15s, Claude slower

function _evidenceHash(events) {
  const basis = events.map(e => [e.source_id, e.status, e.modified_at, e.vendor, e.repair_component].join('|')).sort().join('\n');
  return crypto.createHash('sha1').update(basis).digest('hex');
}

// Call relay.ask with a hard timeout so a slow lane can't hang the job. An
// injected relay (opts.relay) is used when provided — chiefly for tests; in
// production we lazy-require the real relay.
async function _askTimed(prompt, ms, relayOverride) {
  let relay = relayOverride;
  if (!relay) { try { relay = require('../orcha/relay'); } catch (_) { return null; } }
  if (!relay || typeof relay.ask !== 'function') return null;
  return Promise.race([
    relay.ask(prompt).catch(e => { logger.warn('relay.ask failed: ' + e.message); return null; }),
    new Promise(res => setTimeout(() => res(null), ms)),
  ]);
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
function _buildPrompt(equipmentId, rep, events) {
  const evLines = events.slice(0, 40).map(e => {
    const d = e.reported_at ? new Date(e.reported_at).toISOString().slice(0, 10) : 'date?';
    return '- id=' + e.source_id + ' | ' + d + ' | ' + (e.vendor || 'vendor?') + ' | ' + (e.status || '?') +
      ' | ' + (e.repair_category || '') + '/' + (e.repair_component || '') +
      ' | complaint: ' + (e.reported_complaint ? String(e.reported_complaint).slice(0, 200) : 'none');
  }).join('\n');

  const s = rep.executiveSummary;
  return [
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
}

// Analyze ONE unit. Returns { ok, cached, summary, events, recommendations } or
// a not-analyzed note. Deterministic report always still available separately.
async function analyzeUnit(equipmentId, opts = {}) {
  const eq = String(equipmentId || '').trim();
  if (!eq) return { ok: false, error: 'no equipment id' };

  const events = store.eventsForUnit(eq);
  if (!events.length) return { ok: false, error: 'no repair events to analyze' };

  const rep = report.buildUnitReport(eq);
  const evidenceHash = _evidenceHash(events);

  // Cache: skip the model call when evidence is unchanged.
  if (!opts.force) {
    const cached = store.getAiAnalysis(eq);
    if (cached && cached.evidence_hash === evidenceHash && cached.report_json) {
      let parsed = null; try { parsed = JSON.parse(cached.report_json); } catch (_) {}
      if (parsed) return { ok: true, cached: true, analyzedAt: cached.analyzed_at, modelId: cached.model_id, ...parsed };
    }
  }

  const prompt = _buildPrompt(eq, rep, events);
  const raw = await _askTimed(prompt, opts.timeoutMs || ASK_TIMEOUT_MS, opts.relay);
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

  let modelId = null; try { const relay = opts.relay || require('../orcha/relay'); modelId = relay.getStatus && relay.getStatus().model; } catch (_) {}
  store.saveAiAnalysis({ equipmentId: eq, reportJson: payload, evidenceHash, analysisVersion: ANALYSIS_VERSION, modelId });

  logger.info('[' + eq + '] AI analysis: ' + evOut.length + ' events classified, ' + recs.length + ' recommendations');
  return { ok: true, cached: false, analyzedAt: Date.now(), modelId, ...payload };
}

module.exports = { analyzeUnit, ANALYSIS_VERSION, _parseJson, _evidenceHash };
