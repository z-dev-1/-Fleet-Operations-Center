'use strict';
/**
 * carrier-intel/intent.js — deterministic Carrier Intel pre-router (design B4, B4.1).
 *
 * detectCarrierIntel(text, catalog, unitIds)
 *   -> null | { scac, candidates, assetFilter, cues } | { ambiguous:true, candidates }
 * detectFollowUp(text, history, catalog, unitIds, nowMs) -> null | hit (+ userMsg, followUp)
 *
 * `catalog` is dbr/target-resolver.buildCatalog({ rows }); `unitIds` a Set of upper-cased
 * equipmentIds. Pure: no store, electron or logging.
 */

const { normKey } = require('../dbr/target-resolver');

const CI_MAX_TEXT = 1500;
// Copy of dbr/intent.js BENIGN_ME plus 'update' ("update me on AUVTE trends" is a question).
const BENIGN_ME = /\b(send|give|show|get|fetch|pull|tell|update)\s+me\b/g;
// Copy of the dbr/intent.js STOP set (that module does not export it).
const STOP = new Set(('today now me my mine the a an all this that it week yesterday tomorrow data info numbers report please '
  + 'sites site call panel sheet in out up down stand what whats who where its lets thats dbr uptime '
  + 'for of on at is how many units are give get pull show tell fetch refresh run').split(' '));

// imperative command at the start (after politeness)
const CI_CMD_LEAD = /^\s*(?:(?:hey|ok|okay)[,\s]+)?(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|go\s+ahead\s+and\s+)?(send|email|e-?mail|forward|slack|dm|message|ping|share|post|remind|schedule|create|draft|approve|move|flip|pin|unpin|comment|escalate|assign|close|reply|respond|add|note|log|update|mark|set|sync|refresh|text|call)\b/;
// delivery anywhere: "<send-verb> … to <someone>"
const CI_SEND_TO = /\b(send|email|e-?mail|forward|slack|dm|message|ping|share|post)\b[^.?!]{0,60}\bto\b/;
const DBR_RE = /\bdbr\b/;
const UNIT_SHAPE_RE = /^[a-z]{0,4}\d{5,8}$/i;
const CI_CUE = /\b(trends?|trending|why|reasons?|causes?|caused|breakdown|analy[sz]e|analysis|insights?|patterns?|recurring|repeat(ed|ing)?|support(\s+needed)?|help\s+needed|fas\s+input|actions?|what'?s\s+(going\s+on|happening|wrong)|how\s+long|low|poor|worst|keep\s+(coming|going)\s+back|misfires?|symptoms?|duplicate|show(s|ed)?\s+up|arriv\w*|hold(ing|s)?|releas\w*|have\s+you\s+seen)\b/;
const BOX_TRUCK_RE = /\bbox[\s-]?trucks?\b/;
const CUE_RE = Object.freeze({
  arrival: /\b(tech(nician)?s?\b[^.?]{0,40}\b(arriv|show|on\s*site|respond)|how\s+long\s+until|response\s+time)/,
  reassign: /\b(mov|pull|reassign|shift)\w*\b[^.?]{0,40}\btechs?\b|\btechs?\b[^.?]{0,40}\b(trailers?|hostlers?|yard\s+trucks?)\b/,
  driver: /\b(cold\s+starts?|after\s+fuel\w*|under\s+load|drivers?\s+(report|say|mention))/,
  cnd: /could\s*n[o']?t\s+(duplicate|replicate)|can'?t\s+duplicate|no\s+fault\s+found/,
  symptom: /\b(misfires?|voltage|electrical|cng|methane|symptoms?|faults?|recurring|repeat\w*|keep\s+coming\s+back)\b/,
  dsp: /\b(dsp|held|hold|releas\w*|damage)\b/,
  uptime: /\buptime\b/,
  why: /\bwhy\b/,
});
const ANALYTIC_CUES = Object.freeze(['arrival', 'reassign', 'driver', 'cnd', 'symptom']);
const CI_FOLLOWUP_RE = /^\s*(?:note[:,]?\s+)?(?:we(?:'re|\s+are)?\s+)?(?:talking\s+about|this\s+is\s+(?:for|about)|i\s+mean|for|about|re:?)\s+([a-z0-9][a-z0-9._-]{1,10}[a-z0-9])\s*[.!]?\s*$/i;
const CI_FOLLOWUP_MS = 15 * 60 * 1000;

function _norm(text) {
  return String(text).replace(/[\u2018\u2019\u201B\u2032]/g, "'").replace(/[\u201C\u201D\u201F\u2033]/g, '"').toLowerCase();
}
function _lc(text) { return _norm(text).replace(BENIGN_ME, ' '); }
function _tokens(t) { return String(t).match(/[A-Za-z0-9._-]+/g) || []; }
function _scacMap(catalog) { return catalog && catalog.scacs instanceof Map ? catalog.scacs : new Map(); }

/** hasUnitToken(t, unitIds) -> true when a whole token is a known unit id or unit-shaped (step 5). */
function hasUnitToken(t, unitIds) {
  const ids = unitIds instanceof Set ? unitIds : new Set();
  for (const tok of _tokens(t)) {
    if (UNIT_SHAPE_RE.test(tok) || ids.has(tok.toUpperCase())) return true;
  }
  return false;
}

/** scacCandidates(t, catalog) -> distinct upper-cased SCACs named by whole tokens (step 6). */
function scacCandidates(t, catalog) {
  const scacs = _scacMap(catalog);
  const out = [];
  for (const tok of _tokens(t)) {
    if (tok.length < 3 || tok.length > 12 || STOP.has(tok.toLowerCase())) continue;
    const key = normKey(tok);
    if (!key || !scacs.has(key)) continue;
    const vals = [...(scacs.get(key) || [])];
    const code = String(vals.length ? vals[0] : key).trim().toUpperCase() || key;
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

function _cues(t) {
  const c = {};
  for (const k of Object.keys(CUE_RE)) c[k] = CUE_RE[k].test(t);
  return c;
}

/** detectCarrierIntel(text, catalog, unitIds) (design B4 steps 1-9). */
function detectCarrierIntel(text, catalog, unitIds) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || text.length > CI_MAX_TEXT) return null;
  const t = _lc(text);
  if (CI_CMD_LEAD.test(t) || CI_SEND_TO.test(t)) return null;
  if (DBR_RE.test(t)) return null;
  if (hasUnitToken(t, unitIds)) return null;
  const candidates = scacCandidates(t, catalog);
  const cues = _cues(t);
  const analytical = CI_CUE.test(t) || ANALYTIC_CUES.some((k) => cues[k]);
  if (!analytical) return null;
  if (!candidates.length) return null;
  if (candidates.length >= 2) return { ambiguous: true, candidates };
  return { scac: candidates[0], candidates, assetFilter: BOX_TRUCK_RE.test(t) ? 'boxTruck' : null, cues };
}

/** detectFollowUp(text, history, catalog, unitIds, nowMs) (design B4.1). */
function detectFollowUp(text, history, catalog, unitIds, nowMs) {
  if (typeof text !== 'string') return null;
  const m = CI_FOLLOWUP_RE.exec(_norm(text));
  if (!m) return null;
  const key = normKey(m[1]);
  const scacs = _scacMap(catalog);
  if (!key || !scacs.has(key)) return null;
  const vals = [...(scacs.get(key) || [])];
  const scac = String(vals.length ? vals[0] : key).trim().toUpperCase() || key;
  const list = Array.isArray(history) ? history : [];
  let prev = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].role === 'user') { prev = list[i]; break; }
  }
  if (!prev) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (!(now - Number(prev.ts) <= CI_FOLLOWUP_MS)) return null;
  if (typeof prev.text !== 'string') return null;
  const pt = _lc(prev.text);
  if (scacCandidates(pt, catalog).length > 0 || hasUnitToken(pt, unitIds)) return null;
  const q = scac + ' ' + prev.text;
  const hit = detectCarrierIntel(q, catalog, unitIds);
  if (!hit || hit.ambiguous) return null;
  return Object.assign(hit, { userMsg: q, followUp: true });
}

module.exports = {
  detectCarrierIntel, detectFollowUp, hasUnitToken, scacCandidates,
  CI_MAX_TEXT, CI_CUE, CI_CMD_LEAD, CI_SEND_TO, CI_FOLLOWUP_RE, CI_FOLLOWUP_MS, CUE_RE, STOP, BENIGN_ME,
};
