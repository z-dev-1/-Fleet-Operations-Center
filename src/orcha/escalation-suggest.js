'use strict';
/**
 * orcha/escalation-suggest.js — suggest which AAP escalation team a WR should
 * go to, plus a factual internal reason comment.
 *
 * A deterministic rule-based suggestion is ALWAYS computed first so the panel
 * works with AI down. The AI answer is only used if it parses to a listed,
 * not-already-applied team value with a non-empty comment. Never throws.
 *
 * All collaborators are injectable via deps (ask/getRow/getCanonical/
 * buildUnitContext/timeoutMs) so tests run without mocking store/relay.
 */

const HIGH_VALUE_ESTIMATE_USD = 5000;
const COMMENT_MAX = 2000;
const DAY_MS = 86400000;

function _s(v) { return v == null ? '' : String(v).trim(); }
function _clip(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, COMMENT_MAX); }

function _selectable(options, current) {
  const cur = new Set((Array.isArray(current) ? current : []).map(_s));
  const out = [];
  const seen = new Set();
  for (const o of (Array.isArray(options) ? options : [])) {
    const value = _s(o && o.value);
    if (!value || cur.has(value) || seen.has(value)) continue;
    seen.add(value);
    out.push({ value, displayText: _s(o.displayText) || value });
  }
  return out;
}

function _cost(row) {
  const n = Number(String((row && row.estimatePendingCost) == null ? '' : row.estimatePendingCost).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Days down: workDuration as a number or the mapper's "Nd Nh Nm" string,
// else derived from row.created.
function _daysDown(row) {
  const r = row || {};
  const wd = r.workDuration;
  if (typeof wd === 'number' && Number.isFinite(wd)) return wd;
  const ws = _s(wd);
  if (ws) {
    if (/^\d+(\.\d+)?$/.test(ws)) return Number(ws);
    const m = ws.match(/(\d+)\s*d/i);
    if (m) return Number(m[1]);
    if (/\d+\s*[hm]/i.test(ws)) return 0;
  }
  const t = Date.parse(_s(r.created));
  if (Number.isFinite(t)) return Math.max(0, Math.floor((Date.now() - t) / DAY_MS));
  return null;
}

function _statusLabel(status) {
  const s = _s(status) || 'unknown';
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function deterministicSuggestion({ row, canon, options, current } = {}) {
  const r = row || {};
  const c = canon || {};
  const sel = _selectable(options, current);
  if (!sel.length) return { team: null, comment: '', rationale: 'No escalation teams available to add.', source: 'rules' };
  const has = (v) => sel.some((o) => o.value === v);
  const cost = _cost(r);
  const days = _daysDown(r);
  let team = null;
  let reason = '';

  if (cost >= HIGH_VALUE_ESTIMATE_USD && has('MCS_HIGH_VALUE_ESTIMATE')) {
    team = 'MCS_HIGH_VALUE_ESTIMATE'; reason = 'Pending estimate is at or above $' + HIGH_VALUE_ESTIMATE_USD + '.';
  }
  if (!team && c.waitingOn === 'approval') {
    if (cost > 0 && has('MCS_HIGH_VALUE_ESTIMATE')) { team = 'MCS_HIGH_VALUE_ESTIMATE'; reason = 'Estimate is waiting on approval.'; }
    else if (cost <= 0 && has('TOM_PENDING_ACTION')) { team = 'TOM_PENDING_ACTION'; reason = 'Repair is waiting on an approval action.'; }
  }
  if (!team && (c.waitingOn === 'vendor' || c.waitingOn === 'parts')) {
    if (days != null && days >= 7 && has('MCS_LEAD')) { team = 'MCS_LEAD'; reason = 'Waiting on ' + c.waitingOn + ' for 7+ days.'; }
    else if (has('FAS')) { team = 'FAS'; reason = 'Waiting on ' + c.waitingOn + '; needs field follow-up.'; }
  }
  if (!team) {
    if (has('MCS_LEAD')) { team = 'MCS_LEAD'; reason = 'General escalation for repair progress.'; }
    else { team = sel[0].value; reason = 'First available escalation team.'; }
  }

  const opt = sel.find((o) => o.value === team);
  const parts = [];
  if (_s(r.equipmentId)) parts.push('Unit ' + _s(r.equipmentId) + '.');
  const site = _s(r.domicileSite) || _s(r.geofence);
  if (site) parts.push('Site ' + site + '.');
  if (_s(r.vendor)) parts.push('Vendor ' + _s(r.vendor) + '.');
  if (days != null) parts.push('Down ' + days + ' day' + (days === 1 ? '' : 's') + '.');
  if (c.status) parts.push('Status: ' + _statusLabel(c.status) + '.');
  if (_s(c.situation)) parts.push(_s(c.situation).replace(/\.?$/, '.'));
  if (cost > 0) parts.push('Pending estimate $' + cost + '.');
  parts.push('Requesting ' + opt.displayText + ': ' + reason);
  return { team, comment: _clip(parts.join(' ')), rationale: reason, source: 'rules' };
}

function buildEscalationPrompt({ unitId, unitContext, options, current } = {}) {
  const sel = _selectable(options, current);
  return [
    'You are helping a fleet analyst escalate an AAP work request for unit ' + _s(unitId) + '.',
    'Pick exactly ONE escalation team from this list (use the value before the dash):',
    sel.map((o) => o.value + ' — ' + o.displayText).join('\n'),
    '',
    'Ground your choice strictly in the unit context below. Do not invent facts.',
    'The comment is an internal AAP reason note (max ' + COMMENT_MAX + ' characters) explaining why this team is needed.',
    'Reply with ONLY a JSON object: {"team":"<value>","comment":"<reason note>","rationale":"<one short sentence>"}',
    '',
    'UNIT CONTEXT:',
    _s(unitContext) || '(none)',
  ].join('\n');
}

function parseAiSuggestion(text, options, current) {
  const t = String(text || '');
  const start = t.indexOf('{');
  if (start < 0) return null;
  let obj = null;
  // Widest block first (tolerates '}' inside the comment), then the first block.
  for (const end of [t.lastIndexOf('}'), t.indexOf('}', start)]) {
    if (end <= start) continue;
    try { obj = JSON.parse(t.slice(start, end + 1)); break; } catch (_) { obj = null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const want = _s(obj.team).toLowerCase();
  if (!want) return null;
  const match = _selectable(options, current).find((o) => o.value.toLowerCase() === want || o.displayText.toLowerCase() === want);
  if (!match) return null;
  const comment = _clip(obj.comment);
  if (!comment) return null;
  return { team: match.value, comment, rationale: _s(obj.rationale) };
}

async function _askTimed(ask, prompt, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, ms || 45000);
  try {
    return await Promise.race([
      ask(prompt, { maxTokens: 700, priority: 'high', signal: ac.signal }),
      new Promise((_resolve, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('AI suggestion timed out')), { once: true });
      }),
    ]);
  } finally { clearTimeout(timer); }
}

async function suggestEscalation({ unitId, options, current } = {}, deps = {}) {
  const ask = deps.ask || ((p, o) => require('./relay').ask(p, o));
  const getRow = deps.getRow || ((id) => (require('../store').load('fleetData', {}).rows || []).find((r) => r.equipmentId === id) || { equipmentId: id });
  const getCanonical = deps.getCanonical || ((row) => require('./canonical_state').getCanonical(row));
  const buildUnitContext = deps.buildUnitContext || ((id) => require('./ai-context').buildUnitContext(id));
  const timeoutMs = deps.timeoutMs || 45000;

  let row = { equipmentId: unitId };
  try { row = getRow(unitId) || row; } catch (_) {}
  let canon = null;
  try { canon = getCanonical(row); } catch (_) {}
  const fallback = deterministicSuggestion({ row, canon, options, current });
  if (!fallback.team) return fallback;

  try {
    let unitContext = '';
    try { unitContext = buildUnitContext(unitId) || ''; } catch (_) {}
    const prompt = buildEscalationPrompt({ unitId, unitContext, options, current });
    const text = await _askTimed(ask, prompt, timeoutMs);
    const ai = parseAiSuggestion(text, options, current);
    if (ai) return { ...ai, source: 'ai' };
    return { ...fallback, aiError: 'AI response did not contain a valid listed team and comment' };
  } catch (e) {
    return { ...fallback, aiError: (e && e.message) || String(e) };
  }
}

module.exports = {
  HIGH_VALUE_ESTIMATE_USD,
  deterministicSuggestion,
  buildEscalationPrompt,
  parseAiSuggestion,
  suggestEscalation,
};
