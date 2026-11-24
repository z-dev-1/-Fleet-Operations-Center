'use strict';
/**
 * src/aperia/share-compose.js — the underinflation share message. The AI writes it from the alerted
 * tire's facts only; code validates the result and falls back to a deterministic line.
 *
 *   isShareable(stateOrType) -> true only for UNDERINFLATION / UNDERINFLATION_AND_LEAK (case and
 *                               spaces normalized: 'underinflation and leak' counts).
 *   alertFacts(unit, alert)  -> { unit, positionName, shortPosition, pressure, setPoint, deltaPsi, state,
 *                                 severity, resolveBy, actions, otherTires:[names and short codes] }
 *                               The tire is picked by issue id, then position, then positionName.
 *                               otherTires is for validation only and never reaches the prompt.
 *   buildPrompt(facts, address) -> the AI prompt (alert fields + address when non-null; no coordinates).
 *   validate(text, facts)    -> boolean. Rejects empty, > 700 chars, a coordinate pair, '$', any other
 *                               tire's name or short code, or a text missing the alerted positionName.
 *   fallbackText(facts, address) -> deterministic message.
 *   compose(facts, address, deps) -> Promise<{ text, aiWritten }>  (deps.ask replaces relay.askWithTimeout)
 *
 * Never throws. Nothing here logs message text.
 */
const SHAREABLE = /^UNDERINFLATION(_AND_LEAK)?$/;
const MAX_LEN = 700;
const COORD_RE = /-?\d{1,3}\.\d{2,}\s*,\s*-?\d{1,3}\.\d{2,}/;
const AI_TIMEOUT_MS = 30000;

function _norm(s) { return String(s === null || s === undefined ? '' : s).toUpperCase().trim().replace(/\s+/g, '_'); }
function isShareable(s) { return SHAREABLE.test(_norm(s)); }

function _s(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function _n(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

function _pickTire(tires, alert) {
  const list = (Array.isArray(tires) ? tires : []).filter((t) => t && typeof t === 'object');
  const id = _s(alert.id);
  return (id && list.find((t) => t.issue && _s(t.issue.id) === id))
    || (_s(alert.position) && list.find((t) => _s(t.position) === _s(alert.position)))
    || (_s(alert.positionName) && list.find((t) => _s(t.positionName).toLowerCase() === _s(alert.positionName).toLowerCase()))
    || null;
}

function alertFacts(unit, alert) {
  const u = unit && typeof unit === 'object' ? unit : {};
  const a = alert && typeof alert === 'object' ? alert : {};
  const tires = Array.isArray(u.tires) ? u.tires : [];
  const tire = _pickTire(tires, a);
  const issue = (tire && tire.issue) || {};
  const positionName = _s(tire ? tire.positionName : '') || _s(a.positionName);
  const shortPosition = tire ? _s(tire.shortPosition) : '';
  const otherTires = [];
  for (const t of tires) {
    if (!t || t === tire) continue;
    const nm = _s(t.positionName);
    const sp = _s(t.shortPosition);
    if (nm && nm.toLowerCase() !== positionName.toLowerCase()) otherTires.push(nm);
    if (sp && sp.toLowerCase() !== shortPosition.toLowerCase()) otherTires.push(sp);
  }
  return {
    unit: _s(a.fleetVehicleId) || _s(u.fleetVehicleId),
    positionName,
    shortPosition,
    pressure: tire ? _n(tire.pressure) : null,
    setPoint: tire ? _n(tire.setPoint) : null,
    deltaPsi: tire ? _n(tire.deltaPsi) : null,
    state: _s(a.state) || _s(issue.type),
    severity: _s(a.severity) || _s(issue.severity),
    resolveBy: _s(issue.resolveBy),
    actions: (Array.isArray(issue.actions) ? issue.actions : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
    otherTires: Array.from(new Set(otherTires)),
  };
}

function _signed(n) { return n === null ? '' : (n > 0 ? '+' + n : String(n)); }
function _stateText(s) { return _s(s).replace(/_/g, ' '); }

function buildPrompt(facts, address) {
  const f = facts || {};
  const lines = [
    'Write a short internal Slack direct message to a fleet operator owner about one tire alert.',
    'Rules: 2-4 sentences, plain text (no markdown headers, no bullet lists), no greeting and no names,',
    'no dollar amounts, no GPS coordinates, and do not mention any other tire. Use the tire position name',
    'exactly as given. Say what is wrong, the reading versus the target, and the action to take.',
    address ? 'Mention the location as the street address given below.' : 'Do not mention a location.',
    '',
    'ALERT FACTS',
    'Unit: ' + _s(f.unit),
    'Tire: ' + _s(f.positionName) + (f.shortPosition ? ' (' + f.shortPosition + ')' : ''),
    'Pressure: ' + (f.pressure === null || f.pressure === undefined ? 'unknown' : f.pressure + ' PSI'),
    'Target: ' + (f.setPoint === null || f.setPoint === undefined ? 'unknown' : f.setPoint + ' PSI'),
    'Delta: ' + (f.deltaPsi === null || f.deltaPsi === undefined ? 'unknown' : _signed(f.deltaPsi) + ' PSI'),
    'Alert: ' + _stateText(f.state) + (f.severity ? ' (' + _s(f.severity) + ')' : ''),
    'Resolve by: ' + (_s(f.resolveBy) || 'not given'),
    'Recommended actions: ' + ((Array.isArray(f.actions) && f.actions.length) ? f.actions.join(' ') : 'not given'),
  ];
  if (address) lines.push('Location: ' + address);
  lines.push('', 'Reply with the message text only.');
  return lines.join('\n');
}

function _escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function validate(text, facts) {
  const f = facts || {};
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t || t.length > MAX_LEN) return false;
  if (COORD_RE.test(t) || t.includes('$')) return false;
  const pn = _s(f.positionName);
  if (!pn || !t.toLowerCase().includes(pn.toLowerCase())) return false;
  // Remove the alerted tire's own name / code first so a shorter other name inside it does not match.
  let rest = t.replace(new RegExp(_escRe(pn), 'gi'), ' ');
  if (f.shortPosition) rest = rest.replace(new RegExp('\\b' + _escRe(_s(f.shortPosition)) + '\\b', 'gi'), ' ');
  for (const o of Array.isArray(f.otherTires) ? f.otherTires : []) {
    const s = _s(o);
    if (!s) continue;
    // A longer name that contains the alerted one ('Right Steer Outer' vs 'Right Steer') is checked on the full text.
    const hay = s.toLowerCase().includes(pn.toLowerCase()) ? t : rest;
    if (new RegExp('(^|[^A-Za-z0-9])' + _escRe(s) + '($|[^A-Za-z0-9])', 'i').test(hay)) return false;
  }
  return true;
}

function fallbackText(facts, address) {
  const f = facts || {};
  const reading = (f.pressure !== null && f.pressure !== undefined ? f.pressure + ' PSI' : 'unknown PSI')
    + (f.setPoint !== null && f.setPoint !== undefined ? ' vs ' + f.setPoint + ' target' : '')
    + (f.deltaPsi !== null && f.deltaPsi !== undefined ? ' (' + _signed(f.deltaPsi) + ' PSI)' : '');
  const a0 = Array.isArray(f.actions) && f.actions.length ? _s(f.actions[0]).replace(/[.\s]+$/, '') : '';
  const rb = _s(f.resolveBy);
  let action = '';
  if (a0) action = ' Action: ' + a0 + (rb ? ' (resolve ' + rb + ')' : '') + '.';
  else if (rb) action = ' Resolve ' + rb + '.';
  return '\u{1F6DE} ' + _s(f.unit) + ' \u2014 ' + _s(f.positionName) + ': ' + reading + '. '
    + _stateText(f.state) + (f.severity ? ' (' + _s(f.severity) + ')' : '') + '.'
    + action
    + (address ? ' Location: ' + address + '.' : '');
}

async function compose(facts, address, deps) {
  const addr = typeof address === 'string' && address.trim() ? address.trim() : null;
  const ask = (deps && deps.ask) || ((p, o) => require('../orcha/relay').askWithTimeout(p, o));
  let raw = '';
  try {
    const r = await ask(buildPrompt(facts, addr), { timeoutMs: AI_TIMEOUT_MS, timeoutResult: '', source: 'aperia_share' });
    raw = typeof r === 'string' ? r : (r && typeof r.text === 'string' ? r.text : '');
  } catch (_) { raw = ''; }
  const text = String(raw || '').trim();
  if (validate(text, facts)) return { text, aiWritten: true };
  return { text: fallbackText(facts, addr), aiWritten: false };
}

module.exports = { SHAREABLE, isShareable, alertFacts, buildPrompt, validate, fallbackText, compose, MAX_LEN, COORD_RE };
