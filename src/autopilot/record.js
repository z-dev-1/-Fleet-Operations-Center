'use strict';
/**
 * autopilot/record.js — the structured findings record of one case (V2 design §7.4, FR-14). Pure.
 *
 *   buildRecord({ rec, row, analysis, output, agent, memory, proposals, pack, conflicts, sourceStatus, aiStatus, now })
 *     -> ap_record row { case_id, unit_id, schema_version, operator, owner, domicile, oos_status, days_down,
 *        repair_phase, root_cause, blocker, responsible_party, last_verified_update_at,
 *        last_verified_update_source, parts_eta, repair_eta, confidence, ai_status, investigated_at, record_json }
 *
 * root_cause is set only from a validated AI output that cites at least one non-derived item;
 * otherwise null. confidence is the mean confidence of the cited items, null for fallback output.
 * record_json holds every column plus WO refs, episode, actions (text and class only), proposal ids,
 * evidence refs, source freshness, missing info, open questions and conflicts; <= 16 KB (lists are
 * trimmed). No fleet-wide counts are written here (FR-14.3).
 */

const { LIMITS, REASONS: R, normUnit } = require('./constants');

const TEXT_MAX = 300;
const DERIVED_TRUST = new Set(['derived_ai', 'prior_conclusion']);
const DERIVED_FLAGS = Object.freeze(['canonical_derived', 'derived_calc', 'manual_entry']);

function _arr(v) { return Array.isArray(v) ? v : []; }
function _obj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _parse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function _str(v, n) {
  // eslint-disable-next-line no-control-regex
  const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) : s;
}
function _num(v) { return Number.isFinite(v) ? v : null; }
function _bytes(x) { return Buffer.byteLength(JSON.stringify(x), 'utf8'); }

function _nonDerived(it) {
  if (!it || DERIVED_TRUST.has(it.trust)) return false;
  const fl = _arr(it.flags);
  return !DERIVED_FLAGS.some((f) => fl.includes(f));
}

function _rootCause(output, analysis, byId) {
  if (!_obj(output) || output.generatedBy !== 'ai') return null;
  const supported = (x) => _arr(x && x.evidenceIds).some((id) => _nonDerived(byId.get(id)));
  const facts = _arr(output.confirmedFacts).filter(supported);
  const infs = _arr(output.inferences).filter(supported).slice().sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  const best = infs[0] || facts[0] || null;
  if (!best) return null;
  const ss = _obj(output.stageStall) ? output.stageStall : {};
  if (ss.stalled === true && ss.stage && ss.stage !== 'unknown') return _str('Stalled at ' + ss.stage + ': ' + best.statement, TEXT_MAX);
  const blockers = _arr(analysis && analysis.blockers);
  if (blockers.length && facts.length) return _str(blockers[0] + ': ' + facts[0].statement, TEXT_MAX);
  return _str(best.statement, TEXT_MAX);
}

function _woRefs(rec) {
  const set = _parse(rec.wo_set_json !== undefined ? rec.wo_set_json : rec.wo_set);
  if (Array.isArray(set)) {
    return set.filter(Boolean).slice(0, 50).map((w) => (typeof w === 'object' ? { id: _str(w.id, 80), role: w.role || null, firstSeenAt: _num(w.firstSeenAt) } : { id: _str(w, 80), role: null, firstSeenAt: null }));
  }
  const v1 = _parse(rec.wo_ids_json);
  if (_obj(v1)) return [v1.primary].concat(_arr(v1.secondary)).filter(Boolean).map((id) => ({ id: _str(id, 80), role: null, firstSeenAt: null }));
  return [];
}

function _conflictRows(conflicts) {
  const groups = conflicts && Array.isArray(conflicts.groups) ? conflicts.groups : (Array.isArray(conflicts) ? conflicts : []);
  return groups.slice(0, 20).map((g) => ({
    group: _str(g.group, 40),
    fields: _arr(g.fields).map((f) => _str(f, 40)),
    positions: _arr(g.positions).slice(0, 8).map((p) => ({ evidenceId: p.evidenceId || null, source: _str(p.source, 40), field: _str(p.field, 60), value: _str(p.value, 80) })),
    authorityWinner: g.authorityWinner ? _str(g.authorityWinner.source, 40) : null,
    tie: !g.authorityWinner && !g.informational,
    informational: !!g.informational,
  }));
}

function buildRecord(input) {
  const i = input || {};
  const rec = i.rec || {};
  const row = i.row || {};
  const a = i.analysis || {};
  const out = _obj(i.output) ? i.output : null;
  const mem = _obj(i.memory) ? i.memory : {};
  const agent = _obj(i.agent) ? i.agent : null;
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const items = _arr(i.pack && i.pack.items).filter(Boolean);
  const byId = new Map(items.map((it) => [it.evidenceId, it]));
  const isAi = !!(out && out.generatedBy === 'ai');

  const reasons = _arr(a.reasons);
  const oos = reasons.includes(R.OOS) ? 'OOS' : (row.lifecycleState != null ? _str(row.lifecycleState, 40) || null : null);
  const blocker = (mem.confirmedBlocker && mem.confirmedBlocker.code) || _arr(a.blockers)[0] || null;
  const outParty = out && out.responsibleParty && out.responsibleParty.party;
  const party = outParty && outParty !== 'unknown' ? outParty : (a.responsibleParty || null);
  const lvu = a.lastVendorUpdate || null;
  const parts = items.filter((it) => it.field === 'partsEta' && it.trust === 'structured')
    .sort((x, y) => (Number(y.observedAt) || 0) - (Number(x.observedAt) || 0))[0];
  const eta = a.eta || {};
  let confidence = null;
  if (isAi) {
    const ids = [];
    for (const k of ['confirmedFacts', 'inferences']) for (const x of _arr(out[k])) for (const id of _arr(x && x.evidenceIds)) if (!ids.includes(id)) ids.push(id);
    const cs = ids.map((id) => byId.get(id)).filter((it) => it && Number.isFinite(it.confidence)).map((it) => it.confidence);
    confidence = cs.length ? Math.round((cs.reduce((s, x) => s + x, 0) / cs.length) * 1000) / 1000 : null;
  }
  const aiStatus = i.aiStatus || (agent && agent.aiStatus) || (isAi ? 'ok' : null);

  const cols = {
    case_id: rec.case_id || null,
    unit_id: normUnit(rec.unit_id || row.equipmentId) || null,
    schema_version: 1,
    operator: rec.operator || row.operator || null,
    owner: rec.owner || row.owner || null,
    domicile: rec.domicile || row.domicileSite || null,
    oos_status: oos,
    days_down: _num(a.daysDown) != null ? a.daysDown : _num(rec.days_down),
    repair_phase: a.repairPhase || null,
    root_cause: _rootCause(out, a, byId),
    blocker,
    responsible_party: party,
    last_verified_update_at: lvu && Number.isFinite(lvu.at) ? lvu.at : null,
    last_verified_update_source: lvu && lvu.source ? _str(lvu.source, 40) : null,
    parts_eta: parts ? _str(parts.value, 40) : null,
    repair_eta: eta.date ? _str(eta.date, 40) : null,
    confidence,
    ai_status: aiStatus,
    investigated_at: now,
  };

  const action = (x) => ({ action: _str(x && x.action, TEXT_MAX), actionClass: _str(x && x.actionClass, 40) });
  const body = Object.assign({}, cols, {
    repairEtaStatus: eta.status || null,
    episodeKey: rec.episode_key || null,
    woRefs: _woRefs(rec),
    recommendedActions: _arr(out && out.recommendedActions).slice(0, 20).map(action),
    actionsRequiringApproval: _arr(out && out.actionsRequiringApproval).slice(0, 20).map(action),
    proposalIds: _arr(i.proposals).map((p) => p && (p.proposal_id || p.fingerprint)).filter(Boolean).slice(0, 20),
    evidenceRefs: _arr(mem.evidenceRefs).slice(-60),
    sourceFreshness: _obj(mem.sourceFreshness) && Object.keys(mem.sourceFreshness).length ? mem.sourceFreshness : (_obj(i.sourceStatus) ? i.sourceStatus : {}),
    missingInfo: _arr(out && out.missingInfo).slice(0, 20).map((m) => ({ item: _str(m && m.item, 200), likelySource: _str(m && m.likelySource, 20) })),
    openQuestions: _arr(mem.openQuestions).slice(0, 8).map((q) => ({ question: _str(q && q.question, 200), likelySource: q && q.likelySource ? _str(q.likelySource, 20) : null })),
    conflicts: _conflictRows(i.conflicts || (i.pack && i.pack.conflicts)),
    agent: agent ? { status: agent.status || null, stopCode: agent.stopCode || null, tier: agent.tier || null, turns: _num(agent.turns), toolCalls: _num(agent.toolCalls) } : null,
  });

  // <= recordMaxBytes: halve the lists, longest first, then drop them.
  const LISTS = ['evidenceRefs', 'conflicts', 'woRefs', 'missingInfo', 'openQuestions', 'recommendedActions', 'actionsRequiringApproval', 'proposalIds'];
  const max = LIMITS.recordMaxBytes;
  let guard = 0;
  while (_bytes(body) > max && guard++ < 64) {
    const longest = LISTS.filter((k) => body[k].length).sort((x, y) => _bytes(body[y]) - _bytes(body[x]))[0];
    if (!longest) break;
    body[longest] = body[longest].slice(0, Math.floor(body[longest].length / 2));
  }
  if (_bytes(body) > max) body.sourceFreshness = {};
  return Object.assign({}, cols, { record_json: body });
}

module.exports = { buildRecord };
