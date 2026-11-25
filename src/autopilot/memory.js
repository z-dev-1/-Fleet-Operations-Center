'use strict';
/**
 * autopilot/memory.js — CaseMemory v1 build, merge, trim and prompt view (V2 design §7.2). Pure.
 *
 *   init(rec, row)                         fresh memory from the case (row may be null)
 *   load(json)                             parsed memory when v === 1, else null
 *   mergeTurn(m, turnMemory, { evidenceIndex, runId, at })
 *   recordTool(m, { tool, argsHash, status, code, at, sourceFp, stepId, runId, seq })
 *   rollEpisode(m, { endedAt, newEpisode })
 *   conclude(m, { output, analysis, agent, runId, at, blockedSources, recommendationHash, nextReviewAt,
 *                 evidenceIndex, sourceStatus })
 *   trim(m)                                <= LIMITS.memoryMaxBytes, documented cut order
 *   promptView(m)                          { structured[], text[] }
 *
 * Memory never stores evidence text: only evidence ids and structured values of at
 * most 80 chars. Model-written strings (hypotheses, questions, summaries) are kept
 * clipped and are returned only in promptView().text, which the prompt fences.
 * Every function returns a new object; inputs are not mutated.
 */

const { LIMITS, normUnit, localDate } = require('./constants');

const V = 1;
const CAPS = Object.freeze({
  episodeWoIds: 20, episodeDealerCases: 10, priorConclusions: 5, summary: 400, conclusionEvidence: 10,
  hypotheses: 8, statement: 200, idsPer: 6, questions: 8, toolHistory: 40, evidenceRefs: 60, refValue: 80,
  priorEpisodes: 3, priorEpisodeWoIds: 10,
});

function _arr(v) { return Array.isArray(v) ? v : []; }
function _parse(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function _clip(s, n) {
  // Control characters and runs of whitespace collapse to one space.
  // eslint-disable-next-line no-control-regex
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}
function _tok(s, n) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_:.#-]/g, '').slice(0, n || 40); }
function _ids(list, n) {
  const out = [];
  for (const x of _arr(list)) {
    const s = _tok(x, 64);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}
function _num(v) { return Number.isFinite(v) ? v : null; }
function _conf(v) { return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : null; }
function _copy(m) { return JSON.parse(JSON.stringify(m)); }
function _has(index, id) {
  if (!index) return false;
  if (index instanceof Map || index instanceof Set) return index.has(id);
  return Object.prototype.hasOwnProperty.call(index, id);
}
function _get(index, id) {
  if (!index) return null;
  if (index instanceof Map) return index.get(id) || null;
  if (index instanceof Set) return null;
  return Object.prototype.hasOwnProperty.call(index, id) ? index[id] : null;
}
function _woIdsOf(rec) {
  const set = _parse(rec.wo_set_json !== undefined ? rec.wo_set_json : rec.wo_set);
  if (Array.isArray(set)) return set.map((w) => (w && typeof w === 'object' ? w.id : w));
  const v1 = _parse(rec.wo_ids_json !== undefined ? rec.wo_ids_json : rec.wo_ids);
  if (v1 && typeof v1 === 'object') return [v1.primary].concat(_arr(v1.secondary)).filter(Boolean);
  return [];
}
function _dealerOf(rec) {
  const d = _parse(rec.dealer_cases_json !== undefined ? rec.dealer_cases_json : rec.dealer_cases);
  return _arr(d).map((x) => (x && typeof x === 'object' ? x.id : x));
}

function _blank() {
  return {
    v: V, objective: '', episode: { key: null, openedAt: null, woIds: [], dealerCases: [] },
    priorConclusions: [], hypotheses: [], openQuestions: [], confirmedBlocker: null, responsibleParty: null,
    toolHistory: [], evidenceRefs: [], sourceFreshness: {}, lastStep: null, nextPlannedTool: null, checkpoint: null,
    recommendation: null, nextReviewAt: null, awaitingSources: [], recurrence: null, priorEpisodes: [],
  };
}

function init(rec, row) {
  const c = rec || {};
  const r = row || {};
  const m = _blank();
  const unit = normUnit(c.unit_id || r.equipmentId) || 'the unit';
  const since = _num(c.down_since) != null ? c.down_since : (_num(c.episode_opened_at) != null ? c.episode_opened_at : _num(c.created_at));
  m.objective = 'Explain why ' + _tok(unit, 32) + ' is out of service since ' + (since != null ? localDate(since) : 'an unknown date')
    + ', what blocks return to service, and who acts next.';
  m.episode = {
    key: c.episode_key ? _clip(c.episode_key, 64) : null,
    openedAt: _num(c.episode_opened_at) != null ? c.episode_opened_at : since,
    woIds: _ids(_woIdsOf(c), CAPS.episodeWoIds),
    dealerCases: _ids(_dealerOf(c), CAPS.episodeDealerCases),
  };
  if (c.recurrence_of) m.recurrence = { priorCaseId: _tok(c.recurrence_of, 64), count: Number(c.recurrence_count) || 0 };
  return m;
}

function load(json) {
  const p = _parse(json);
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.v !== V) return null;
  const m = Object.assign(_blank(), p);
  for (const k of ['priorConclusions', 'hypotheses', 'openQuestions', 'toolHistory', 'evidenceRefs', 'awaitingSources', 'priorEpisodes']) {
    if (!Array.isArray(m[k])) m[k] = [];
  }
  if (!m.episode || typeof m.episode !== 'object') m.episode = _blank().episode;
  if (!m.sourceFreshness || typeof m.sourceFreshness !== 'object') m.sourceFreshness = {};
  return m;
}

function mergeTurn(mem, turnMemory, opts) {
  const m = _copy(mem || _blank());
  const t = turnMemory || {};
  const o = opts || {};
  const at = _num(o.at);
  const known = (ids) => _ids(ids, CAPS.idsPer).filter((id) => _has(o.evidenceIndex, id));
  for (const h of _arr(t.hypotheses)) {
    const statement = _clip(h && h.statement, CAPS.statement);
    if (!statement) continue;
    const key = statement.toLowerCase();
    const ex = m.hypotheses.find((x) => String(x.statement).toLowerCase() === key);
    const ids = known(h.evidenceIds);
    const status = ['open', 'supported', 'rejected'].includes(h.status) ? h.status : null;
    if (ex) {
      ex.confidence = _conf(h.confidence) != null ? _conf(h.confidence) : ex.confidence;
      ex.evidenceIds = _ids(ex.evidenceIds.concat(ids), CAPS.idsPer);
      if (status) ex.status = status;
      ex.at = at;
    } else {
      m.hypotheses.push({ statement, confidence: _conf(h.confidence), evidenceIds: ids, status: status || 'open', at });
    }
  }
  if (m.hypotheses.length > CAPS.hypotheses) m.hypotheses = m.hypotheses.slice(-CAPS.hypotheses);
  for (const q of _arr(t.openQuestions)) {
    const question = _clip(q && (q.question || q.statement), CAPS.statement);
    if (!question) continue;
    const key = question.toLowerCase();
    if (m.openQuestions.some((x) => String(x.question).toLowerCase() === key)) continue;
    m.openQuestions.push({ question, likelySource: q.likelySource ? _tok(q.likelySource, 40) : null, at });
  }
  if (m.openQuestions.length > CAPS.questions) m.openQuestions = m.openQuestions.slice(-CAPS.questions);
  if (t.nextPlannedTool && typeof t.nextPlannedTool === 'object' && t.nextPlannedTool.tool) {
    m.nextPlannedTool = { tool: _tok(t.nextPlannedTool.tool, 40), args: t.nextPlannedTool.args && typeof t.nextPlannedTool.args === 'object' ? _copy(t.nextPlannedTool.args) : {} };
  }
  if (o.runId) m.checkpoint = Object.assign({}, m.checkpoint || {}, { runId: _tok(o.runId, 64), turn: Number.isInteger(t.turn) ? t.turn : (m.checkpoint && m.checkpoint.turn) || null });
  return m;
}

function recordTool(mem, entry) {
  const m = _copy(mem || _blank());
  const e = entry || {};
  const at = _num(e.at);
  m.toolHistory.push({
    tool: _tok(e.tool, 40), argsHash: e.argsHash ? _tok(e.argsHash, 64) : null, status: _tok(e.status, 24),
    code: e.code ? _tok(e.code, 40) : null, at, sourceFp: e.sourceFp ? _tok(e.sourceFp, 64) : null,
    stepId: e.stepId ? _tok(e.stepId, 64) : null, runId: e.runId ? _tok(e.runId, 64) : null,
  });
  if (m.toolHistory.length > CAPS.toolHistory) m.toolHistory = m.toolHistory.slice(-CAPS.toolHistory);
  m.lastStep = { runId: e.runId ? _tok(e.runId, 64) : null, seq: Number.isInteger(e.seq) ? e.seq : null, kind: 'tool', tool: _tok(e.tool, 40) || null, at };
  return m;
}

function rollEpisode(mem, opts) {
  const m = _copy(mem || _blank());
  const o = opts || {};
  const ep = m.episode || _blank().episode;
  m.priorEpisodes.unshift({
    key: ep.key || null, openedAt: _num(ep.openedAt), endedAt: _num(o.endedAt),
    woIds: _ids(ep.woIds, CAPS.priorEpisodeWoIds),
    conclusion: m.priorConclusions[0] || null,
    blocker: m.confirmedBlocker ? m.confirmedBlocker.code : null,
  });
  m.priorEpisodes = m.priorEpisodes.slice(0, CAPS.priorEpisodes);
  m.priorConclusions = [];
  m.hypotheses = [];
  m.openQuestions = [];
  m.confirmedBlocker = null;
  m.responsibleParty = null;
  m.nextPlannedTool = null;
  m.checkpoint = null;
  m.awaitingSources = [];
  const n = o.newEpisode || {};
  m.episode = {
    key: n.key ? _clip(n.key, 64) : null, openedAt: _num(n.openedAt),
    woIds: _ids(n.woIds, CAPS.episodeWoIds), dealerCases: _ids(n.dealerCases, CAPS.episodeDealerCases),
  };
  return m;
}

function _citedIds(output) {
  const ids = [];
  for (const k of ['confirmedFacts', 'inferences']) for (const x of _arr(output[k])) for (const id of _arr(x && x.evidenceIds)) ids.push(id);
  return _ids(ids, 200);
}

function conclude(mem, opts) {
  const m = _copy(mem || _blank());
  const o = opts || {};
  const at = _num(o.at);
  const out = o.output && typeof o.output === 'object' ? o.output : null;
  const idx = o.evidenceIndex || null;
  if (out) {
    const cited = _citedIds(out);
    const confs = _arr(out.inferences).map((x) => x && x.confidence).filter(Number.isFinite);
    m.priorConclusions.unshift({
      runId: o.runId ? _tok(o.runId, 64) : null, at, generatedBy: _tok(out.generatedBy || 'ai', 24),
      summary: _clip(out.summary, CAPS.summary), urgency: out.urgency ? _tok(out.urgency, 16) : null,
      confidence: confs.length ? _conf(Math.max(...confs)) : null, evidenceIds: cited.slice(0, CAPS.conclusionEvidence),
    });
    m.priorConclusions = m.priorConclusions.slice(0, CAPS.priorConclusions);
    const stall = out.stageStall;
    const blockers = _arr(o.analysis && o.analysis.blockers);
    if (stall && stall.stalled && _arr(stall.evidenceIds).length) {
      const b0 = blockers[0];
      m.confirmedBlocker = { code: _tok((b0 && (b0.code || b0)) || 'stage_stall', 40), evidenceIds: _ids(stall.evidenceIds, CAPS.idsPer), at };
    }
    const rp = out.responsibleParty;
    if (rp && rp.party && _arr(rp.evidenceIds).length) m.responsibleParty = { party: _tok(rp.party, 40), evidenceIds: _ids(rp.evidenceIds, CAPS.idsPer) };
    const inf = new Set(_arr(out.inferences).map((x) => _clip(x && x.statement, CAPS.statement).toLowerCase()).filter(Boolean));
    for (const h of m.hypotheses) if (inf.has(String(h.statement).toLowerCase())) h.status = 'supported';
    for (const id of cited) {
      if (m.evidenceRefs.some((r) => r.evidenceId === id)) continue;
      const it = _get(idx, id);
      if (!it) continue;
      const structured = it.trust === 'structured' && (typeof it.value === 'string' || typeof it.value === 'number');
      m.evidenceRefs.push({
        evidenceId: id, source: _tok(it.source, 40), field: _tok(it.field, 60),
        value: structured ? String(it.value).slice(0, CAPS.refValue) : null,
        observedAt: _num(it.observedAt), freshness: it.freshness ? _tok(it.freshness, 24) : null, trust: _tok(it.trust, 24),
      });
    }
    if (m.evidenceRefs.length > CAPS.evidenceRefs) m.evidenceRefs = m.evidenceRefs.slice(-CAPS.evidenceRefs);
  }
  const ss = o.sourceStatus && typeof o.sourceStatus === 'object' ? o.sourceStatus : {};
  for (const src of Object.keys(ss)) {
    const s = ss[src] || {};
    m.sourceFreshness[_tok(src, 40)] = {
      newestObservedAt: _num(s.newestObservedAt), retrievedAt: _num(s.retrievedAt),
      status: typeof s === 'string' ? _tok(s, 32) : (s.status ? _tok(s.status, 32) : null),
    };
  }
  m.checkpoint = null;
  m.nextPlannedTool = null;
  m.awaitingSources = _ids(o.blockedSources, 20);
  if (o.recommendationHash) {
    const rec = (out && out.recommendedActions) || [];
    const appr = (out && out.actionsRequiringApproval) || [];
    m.recommendation = { hash: _tok(o.recommendationHash, 64), actions: _arr(rec).length, approvals: _arr(appr).length };
  }
  m.nextReviewAt = _num(o.nextReviewAt);
  m.lastStep = { runId: o.runId ? _tok(o.runId, 64) : null, seq: null, kind: 'final', tool: null, at };
  return m;
}

function _bytes(m) { return Buffer.byteLength(JSON.stringify(m), 'utf8'); }

function trim(mem) {
  let m = _copy(mem || _blank());
  const max = LIMITS.memoryMaxBytes;
  if (_bytes(m) <= max) return m;
  const cuts = [
    (x) => { x.evidenceRefs = x.evidenceRefs.slice(-30); },
    (x) => { x.toolHistory = x.toolHistory.slice(-20); },
    (x) => { x.priorConclusions = x.priorConclusions.slice(0, 3); },
    (x) => { x.hypotheses = x.hypotheses.slice(-5); x.openQuestions = x.openQuestions.slice(-5); },
    (x) => { x.priorEpisodes = x.priorEpisodes.slice(0, 1); },
  ];
  for (const cut of cuts) {
    cut(m);
    if (_bytes(m) <= max) return m;
  }
  const last = _blank();
  last.objective = m.objective;
  last.episode = m.episode;
  last.priorConclusions = m.priorConclusions.slice(0, 1);
  last.checkpoint = m.checkpoint;
  m = last;
  if (_bytes(m) > max) {
    m.episode = Object.assign({}, m.episode, { woIds: [], dealerCases: [] });
    m.priorConclusions = [];
  }
  return m;
}

function _iso(ms) { return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown'; }

function promptView(mem) {
  const m = mem || _blank();
  const structured = [];
  const text = [];
  const ep = m.episode || {};
  structured.push('episode key=' + (_tok(ep.key, 64) || 'unknown') + ' openedAt=' + _iso(ep.openedAt) + ' wo=' + _ids(ep.woIds, CAPS.episodeWoIds).join(',') + ' dealerCases=' + _ids(ep.dealerCases, CAPS.episodeDealerCases).join(','));
  if (m.recurrence) structured.push('recurrence priorCase=' + _tok(m.recurrence.priorCaseId, 64) + ' count=' + (Number(m.recurrence.count) || 0));
  _arr(m.priorConclusions).forEach((c, i) => {
    structured.push('conclusion#' + (i + 1) + ' run=' + _tok(c.runId, 64) + ' at=' + _iso(c.at) + ' by=' + _tok(c.generatedBy, 24) + ' urgency=' + (_tok(c.urgency, 16) || 'none')
      + ' confidence=' + (Number.isFinite(c.confidence) ? c.confidence : 'none') + ' evidence=' + _ids(c.evidenceIds, CAPS.conclusionEvidence).join(','));
    if (c.summary) text.push('conclusion#' + (i + 1) + ': ' + _clip(c.summary, CAPS.summary));
  });
  _arr(m.hypotheses).forEach((h, i) => {
    structured.push('hypothesis#' + (i + 1) + ' status=' + _tok(h.status, 16) + ' confidence=' + (Number.isFinite(h.confidence) ? h.confidence : 'none') + ' evidence=' + _ids(h.evidenceIds, CAPS.idsPer).join(','));
    text.push('hypothesis#' + (i + 1) + ': ' + _clip(h.statement, CAPS.statement));
  });
  _arr(m.openQuestions).forEach((q, i) => {
    structured.push('question#' + (i + 1) + ' likelySource=' + (_tok(q.likelySource, 40) || 'unknown'));
    text.push('question#' + (i + 1) + ': ' + _clip(q.question, CAPS.statement));
  });
  if (m.confirmedBlocker) structured.push('blocker code=' + _tok(m.confirmedBlocker.code, 40) + ' evidence=' + _ids(m.confirmedBlocker.evidenceIds, CAPS.idsPer).join(','));
  if (m.responsibleParty) structured.push('responsibleParty=' + _tok(m.responsibleParty.party, 40) + ' evidence=' + _ids(m.responsibleParty.evidenceIds, CAPS.idsPer).join(','));
  for (const t of _arr(m.toolHistory).slice(-10)) structured.push('tool ' + _tok(t.tool, 40) + ' status=' + _tok(t.status, 24) + (t.code ? ' code=' + _tok(t.code, 40) : '') + ' at=' + _iso(t.at));
  if (_arr(m.awaitingSources).length) structured.push('awaitingSources=' + _ids(m.awaitingSources, 20).join(','));
  _arr(m.priorEpisodes).forEach((p, i) => {
    structured.push('priorEpisode#' + (i + 1) + ' key=' + (_tok(p.key, 64) || 'unknown') + ' openedAt=' + _iso(p.openedAt) + ' endedAt=' + _iso(p.endedAt)
      + ' wo=' + _ids(p.woIds, CAPS.priorEpisodeWoIds).join(',') + ' blocker=' + (_tok(p.blocker, 40) || 'none'));
    if (p.conclusion && p.conclusion.summary) text.push('priorEpisode#' + (i + 1) + ' conclusion: ' + _clip(p.conclusion.summary, CAPS.summary));
  });
  return { structured, text };
}

module.exports = { init, load, mergeTurn, recordTool, rollEpisode, conclude, trim, promptView, CAPS, VERSION: V };
