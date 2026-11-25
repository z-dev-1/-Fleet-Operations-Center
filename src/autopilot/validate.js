'use strict';
/**
 * autopilot/validate.js — strict validation of the AI output (§B9). Pure.
 *
 * validateAiOutput(data, pack) -> { ok, output, warnings[] }
 *   data is the already-parsed reason() `data`.
 *   - plain object with schemaVersion === 1, else invalid
 *   - arrays must be arrays (missing -> []); strings clipped; confidence 0..1;
 *     nextReviewInHours 1..72 (non-number -> 24)
 *   - enums outside the set -> 'unknown' (party / stage / likelySource); an action
 *     with an unknown actionClass is dropped
 *   - unknown evidence ids are removed; a fact, inference or action left without
 *     a valid id is dropped (uncited_item); more than 50% dropped -> invalid
 *   - a confirmed fact citing only untrusted_text items, only STALE items, or any
 *     conflict member moves to inferences with confidence <= 0.5 (downgraded_fact)
 *   - write classes found in recommendedActions move to actionsRequiringApproval, and so do
 *     actions whose text reads as a write or contact (APPROVAL_WORDING), whatever their class;
 *     every approval item gets requiresApproval:true, executed:false
 *   - keys outside the schema are discarded (unexpected_key:<k>)
 * The output has no field that can change case state or authorize anything.
 */

const untrusted = require('../email-intel/untrusted');
const { ACTION_CLASSES, WRITE_ACTION_CLASSES } = require('./constants');

const TOP_KEYS = Object.freeze([
  'schemaVersion', 'summary', 'confirmedFacts', 'inferences', 'stageStall', 'missingInfo', 'conflicts',
  'responsibleParty', 'recommendedActions', 'actionsRequiringApproval', 'urgency', 'nextReviewInHours',
]);
const STAGES = Object.freeze(['approval', 'parts', 'diagnosis', 'repair', 'scheduling', 'ready', 'unknown']);
const LIKELY = Object.freeze(['aap', 'dtna', 'decisiv', 'vendor', 'dsp', 'slack', 'email', 'unknown']);
const PARTIES = Object.freeze(['vendor', 'dealer', 'dsp_carrier', 'amazon_fleet', 'parts_supplier', 'unknown']);
const URGENCY = Object.freeze(['low', 'normal', 'high']);
const ALL_CLASSES = new Set([...ACTION_CLASSES, ...WRITE_ACTION_CLASSES]);
const WRITE = new Set(WRITE_ACTION_CLASSES);
const IDS_MAX = 20;
// The model picks actionClass. Action text that reads as road-ready, a DOT / lifecycle change,
// contacting someone, an approval or a WO record change needs approval whatever its class.
const APPROVAL_WORDING = Object.freeze([
  /\broad[\s-]*ready\b/i,
  /\bDOT\b/,
  /\blifecycle\b/i,
  /\bcontact\b/i,
  /\be-?mail\b/i,
  /\bmessage\b/i,
  /\bslack\b/i,
  /\bapprov(?:e|al)\b/i,
  /\b(?:create|update|open|close|edit)\b[^.]{0,30}\b(?:WO|WR|work[\s-]*order|work[\s-]*request)s?\b/i,
]);

function _obj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _str(v, n) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > n ? s.slice(0, n) : s;
}
function _conf(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }
function _enum(v, list) { const s = String(v == null ? '' : v).trim().toLowerCase(); return list.includes(s) ? s : 'unknown'; }
function _arr(v) { return Array.isArray(v) ? v : []; }
function _flags(it) { return Array.isArray(it && it.flags) ? it.flags : (typeof (it && it.flags) === 'string' ? it.flags.split(',') : []); }
const DERIVED_TRUST = new Set(['derived_ai', 'prior_conclusion']);

function validateAiOutput(data, pack) {
  const warnings = [];
  if (!_obj(data) || data.schemaVersion !== 1) return { ok: false, output: null, warnings: ['schema_version'] };
  for (const k of Object.keys(data)) if (!TOP_KEYS.includes(k)) warnings.push('unexpected_key:' + String(k).slice(0, 40));

  const items = ((pack && pack.items) || []).filter(Boolean);
  const byId = new Map(items.map((i) => [i.evidenceId, i]));
  const memberOf = (pack && pack.conflicts && pack.conflicts.memberOf) || {};
  const ids = (v) => {
    const out = [];
    for (const x of _arr(v)) {
      const id = typeof x === 'string' ? x : '';
      if (byId.has(id) && !out.includes(id)) out.push(id);
      if (out.length >= IDS_MAX) break;
    }
    return out;
  };
  let total = 0;
  let dropped = 0;
  const cited = (list, build) => {
    const out = [];
    for (const raw of _arr(list)) {
      total++;
      if (!_obj(raw)) { dropped++; warnings.push('malformed_item'); continue; }
      const e = ids(raw.evidenceIds);
      if (!e.length) { dropped++; warnings.push('uncited_item'); continue; }
      const built = build(raw, e);
      if (!built) { dropped++; continue; }
      out.push(built);
    }
    return out;
  };

  const facts = cited(data.confirmedFacts, (r, e) => ({ statement: _str(r.statement, 300), evidenceIds: e }));
  const inferences = cited(data.inferences, (r, e) => ({
    statement: _str(r.statement, 300), reasoning: _str(r.reasoning, 500), confidence: _conf(r.confidence), evidenceIds: e,
  }));
  const action = (r, e) => {
    const cls = String(r.actionClass == null ? '' : r.actionClass).trim();
    if (!ALL_CLASSES.has(cls)) { warnings.push('invalid_action_class'); return null; }
    return { action: _str(r.action, 300), rationale: _str(r.rationale, 400), owner: _str(r.owner, 60), actionClass: cls, evidenceIds: e };
  };
  const recIn = cited(data.recommendedActions, action);
  const apprIn = cited(data.actionsRequiringApproval, action);

  if (total > 0 && dropped * 2 > total) return { ok: false, output: null, warnings: warnings.concat(['too_many_dropped']) };

  // Fact downgrade.
  const confirmedFacts = [];
  for (const f of facts) {
    const its = f.evidenceIds.map((id) => byId.get(id));
    const allUntrusted = its.every((i) => i.trust === 'untrusted_text');
    const allStale = its.every((i) => i.freshness === 'STALE');
    const inConflict = its.some((i) => (memberOf[i.evidenceId] && memberOf[i.evidenceId].length) || i.conflictGroup);
    // V2 (§6.5, §7.5): circular, canonical-only and timeline-only support.
    const allDerived = its.every((i) => DERIVED_TRUST.has(i.trust));
    const canonicalOnly = its.every((i) => _flags(i).includes('canonical_derived'));
    const timelineOnly = its.every((i) => i.source === 'timeline');
    if (allUntrusted || allStale || inConflict || allDerived || canonicalOnly || timelineOnly) {
      warnings.push('downgraded_fact');
      const why = inConflict ? 'in conflict' : (timelineOnly ? 'timeline text only' : (allDerived ? 'AI-written or a prior conclusion'
        : (canonicalOnly ? 'canonical status only' : (allUntrusted ? 'untrusted text' : 'stale'))));
      inferences.push({ statement: f.statement, reasoning: 'Downgraded from a confirmed fact: the cited evidence is ' + why + '.', confidence: 0.5, evidenceIds: f.evidenceIds });
    } else {
      confirmedFacts.push(f);
    }
  }
  const recommendedActions = [];
  const actionsRequiringApproval = [];
  for (const a of recIn) {
    if (WRITE.has(a.actionClass) || APPROVAL_WORDING.some((re) => re.test(a.action))) { warnings.push('moved_to_approval'); actionsRequiringApproval.push(a); } else recommendedActions.push(a);
  }
  for (const a of apprIn) actionsRequiringApproval.push(a);
  for (const a of actionsRequiringApproval) { a.requiresApproval = true; a.executed = false; }

  const ss = _obj(data.stageStall) ? data.stageStall : {};
  const stageStall = {
    stalled: typeof ss.stalled === 'boolean' ? ss.stalled : null,
    stage: _enum(ss.stage, STAGES),
    reasoning: _str(ss.reasoning, 500),
    confidence: _conf(ss.confidence),
    evidenceIds: ids(ss.evidenceIds),
  };
  const missingInfo = _arr(data.missingInfo).filter(_obj).slice(0, 20).map((m) => ({
    item: _str(m.item, 200), whyNeeded: _str(m.whyNeeded, 200), likelySource: _enum(m.likelySource, LIKELY),
  }));
  const conflicts = _arr(data.conflicts).filter(_obj).slice(0, 20).map((c) => ({
    field: _str(c.field, 40), note: _str(c.note, 300), evidenceIds: ids(c.evidenceIds),
  }));
  const rp = _obj(data.responsibleParty) ? data.responsibleParty : {};
  const responsibleParty = { party: _enum(rp.party, PARTIES), evidenceIds: ids(rp.evidenceIds) };
  const urgency = URGENCY.includes(data.urgency) ? data.urgency : 'normal';
  const nr = Number(data.nextReviewInHours);
  const nextReviewInHours = Number.isFinite(nr) ? Math.min(72, Math.max(1, nr)) : 24;

  return {
    ok: true,
    warnings,
    output: {
      schemaVersion: 1,
      generatedBy: 'ai',
      summary: _str(data.summary, 400),
      confirmedFacts,
      inferences,
      stageStall,
      missingInfo,
      conflicts,
      responsibleParty,
      recommendedActions,
      actionsRequiringApproval,
      urgency,
      nextReviewInHours,
    },
  };
}

// ── V2 planner turn (§6.5) ──────────────────────────────────────────────────

const DECISIONS = Object.freeze(['request_tools', 'final']);
const TOOL_NAME_RE = /^[a-z_]+$/;
const EV_ID_RE = /^ev_[a-f0-9_]{1,40}$/;
const TURN_TOOLS_MAX = 3;
const TURN_ARGS_KEYS_MAX = 6;
const TURN_MEMORY_MAX = 5;
const TURN_STR_MAX = 200;

function _sanitized(v, n) { return untrusted.sanitize(_str(v, n), '').slice(0, n); }

function _turnMemory(m, warnings) {
  const src = _obj(m) ? m : {};
  const hypotheses = [];
  for (const h of _arr(src.hypotheses)) {
    if (hypotheses.length >= TURN_MEMORY_MAX) { warnings.push('memory_capped'); break; }
    if (!_obj(h)) continue;
    const statement = _sanitized(h.statement, TURN_STR_MAX);
    if (!statement.trim()) continue;
    const evidenceIds = _arr(h.evidenceIds).filter((x) => typeof x === 'string' && EV_ID_RE.test(x)).slice(0, IDS_MAX);
    hypotheses.push({ statement, confidence: _conf(h.confidence), evidenceIds });
  }
  const openQuestions = [];
  for (const q of _arr(src.openQuestions)) {
    if (openQuestions.length >= TURN_MEMORY_MAX) { warnings.push('memory_capped'); break; }
    if (!_obj(q)) continue;
    const question = _sanitized(q.question, TURN_STR_MAX);
    if (!question.trim()) continue;
    openQuestions.push({ question, likelySource: _enum(q.likelySource, LIKELY) });
  }
  return { hypotheses, openQuestions };
}

/**
 * validatePlannerTurn(r, { toolNames }) -> { ok, decision, tools[], memory, result, code, warnings[] }
 *   r is the reason() result. A V1-shaped answer (schemaVersion 1, no decision) is a final.
 *   Unknown tool names are kept (the core reports them as data); at most 3 tools per turn.
 */
function validatePlannerTurn(r, opts) {
  const o = opts || {};
  const warnings = [];
  const bad = (code) => ({ ok: false, decision: null, tools: [], memory: { hypotheses: [], openQuestions: [] }, result: null, code, warnings });
  if (!r || r.ok !== true) return bad((r && r.error) || 'no_result');
  const data = r.data;
  if (!_obj(data)) return bad('invalid_schema');
  if (data.decision === undefined && data.schemaVersion === 1) {
    return { ok: true, decision: 'final', tools: [], memory: { hypotheses: [], openQuestions: [] }, result: data, code: null, warnings: ['v1_shaped_final'] };
  }
  if (data.schemaVersion !== 2) return bad('invalid_schema');
  if (!DECISIONS.includes(data.decision)) return bad('invalid_decision');
  const known = new Set(_arr(o.toolNames));
  const tools = [];
  for (const t of _arr(data.tools)) {
    if (!_obj(t) || typeof t.tool !== 'string' || t.tool.length < 1 || t.tool.length > 40 || !TOOL_NAME_RE.test(t.tool)
      || !_obj(t.args) || Object.keys(t.args).length > TURN_ARGS_KEYS_MAX) { warnings.push('tool_dropped'); continue; }
    if (tools.length >= TURN_TOOLS_MAX) { warnings.push('tools_capped'); break; }
    if (known.size && !known.has(t.tool)) warnings.push('unknown_tool');
    tools.push({ tool: t.tool, args: Object.assign({}, t.args), why: _sanitized(t.why, TURN_STR_MAX) });
  }
  const memory = _turnMemory(data.memory, warnings);
  if (data.decision === 'final') {
    if (!_obj(data.result)) return bad('invalid_final');
    return { ok: true, decision: 'final', tools: [], memory, result: data.result, code: null, warnings };
  }
  return { ok: true, decision: 'request_tools', tools, memory, result: null, code: null, warnings };
}

const SUPPORT_TRUST = new Set(['structured', 'untrusted_text']);
const NO_SUPPORT_FLAGS = Object.freeze(['canonical_derived', 'derived_calc', 'manual_entry', 'injection_suspected']);

/**
 * hasSourceSupport(output, pack) -> true when a confirmedFacts or inferences entry cites an item with
 * trust structured or untrusted_text and none of the flags canonical_derived, derived_calc, manual_entry.
 */
function hasSourceSupport(output, pack) {
  if (!_obj(output)) return false;
  const byId = new Map(((pack && pack.items) || []).filter(Boolean).map((i) => [i.evidenceId, i]));
  for (const k of ['confirmedFacts', 'inferences']) {
    for (const x of _arr(output[k])) {
      for (const id of _arr(x && x.evidenceIds)) {
        const it = byId.get(id);
        if (!it || !SUPPORT_TRUST.has(it.trust)) continue;
        const fl = _flags(it);
        if (!NO_SUPPORT_FLAGS.some((f) => fl.includes(f))) return true;
      }
    }
  }
  return false;
}

module.exports = { validateAiOutput, validatePlannerTurn, hasSourceSupport, TOP_KEYS, EV_ID_RE };
