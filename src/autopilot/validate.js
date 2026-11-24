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
 *   - write classes found in recommendedActions move to actionsRequiringApproval;
 *     every approval item gets requiresApproval:true, executed:false
 *   - keys outside the schema are discarded (unexpected_key:<k>)
 * The output has no field that can change case state or authorize anything.
 */

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

function _obj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _str(v, n) {
  const s = typeof v === 'string' ? v : (v == null ? '' : String(v));
  return s.length > n ? s.slice(0, n) : s;
}
function _conf(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }
function _enum(v, list) { const s = String(v == null ? '' : v).trim().toLowerCase(); return list.includes(s) ? s : 'unknown'; }
function _arr(v) { return Array.isArray(v) ? v : []; }

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
    if (allUntrusted || allStale || inConflict) {
      warnings.push('downgraded_fact');
      inferences.push({ statement: f.statement, reasoning: 'Downgraded from a confirmed fact: the cited evidence is ' +
        (inConflict ? 'in conflict' : (allUntrusted ? 'untrusted text' : 'stale')) + '.', confidence: 0.5, evidenceIds: f.evidenceIds });
    } else {
      confirmedFacts.push(f);
    }
  }
  const recommendedActions = [];
  const actionsRequiringApproval = [];
  for (const a of recIn) {
    if (WRITE.has(a.actionClass)) { warnings.push('moved_to_approval'); actionsRequiringApproval.push(a); } else recommendedActions.push(a);
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

module.exports = { validateAiOutput, TOP_KEYS };
