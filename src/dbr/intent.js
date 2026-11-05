'use strict';
// src/dbr/intent.js — deterministic pre-router for "DBR for <site>" style
// questions, plus the one-segment AI prompt patch used when the DBR lookup
// flag is on. Pure (no store / electron).
//
// detectDbrLookup needs a DBR cue (or an uptime cue plus a KNOWN target) and a
// target, so plain "pull dbr" / "get dbr data" / "refresh dbr" return null and
// keep reaching the AI and DBR_PULL exactly as before. Anything that asks to
// send / share / schedule something returns null (normal AI path).

const { normKey } = require('./target-resolver');

const MAX_TEXT = 300;
const BENIGN_ME = /\b(send|give|show|get|fetch|pull|tell)\s+me\b/g;
const OUTWARD = /\b(send|email|e-?mail|forward|slack|dm|message|ping|tell|share|post|remind|schedule|create|draft|approve|move|flip|pin|unpin)\b/;
const DBR_CUE = /\bdbr\b/;
const UPTIME_CUE = /\buptime\b/;
const UPTIME_NOT = /\b(manager|owner|who|goal|rate of)\b/;
const MINE = /\b(my|mine)\s+(sites?|domiciles?|carriers?|scacs?)\b|\bdbr\b.*\bmine\b/;
const UNIT_ID = /^\d{5,8}$/;
const EXPLICIT_FOR = /\bdbr(?:\s+(?:data|numbers|info|sheet|report|status|row))?\s+(?:for|of|on|at)\s+([a-z0-9][a-z0-9._-]{1,23})\b/;
// Apostrophe required (plan had '?s): without it "does dbr" / "is dbr" would
// capture "doe" / "i" as a site.
const EXPLICIT_POSS = /\b([a-z0-9][a-z0-9._-]{1,23})'s\s+dbr\b/;
// Words never taken as a target (explicit capture and known-token matching).
const STOP = new Set(('today now me my mine the a an all this that it week yesterday tomorrow data info numbers report please '
  + 'sites site call panel sheet in out up down stand what whats who where its lets thats dbr uptime '
  + 'for of on at is how many units are give get pull show tell fetch refresh run').split(' '));

function _knownKey(catalog, key) {
  if (!key || !catalog) return false;
  const d = catalog.domiciles instanceof Map && catalog.domiciles.has(key);
  const s = catalog.scacs instanceof Map && catalog.scacs.has(key);
  return d || s;
}

// Whole tokens (and adjacent token pairs, so "oak w" finds OAK-W) whose
// normKey is a known domicile or SCAC. Returns the typed text of each distinct
// match, first-seen order.
function _knownTargets(text, catalog) {
  const toks = [];
  let m;
  const re = /[A-Za-z0-9._-]+/g;
  while ((m = re.exec(text))) toks.push(m[0]);
  const out = [];
  const seen = new Set();
  const consider = (raw) => {
    if (raw.length < 2 || raw.length > 24) return;
    const low = raw.toLowerCase();
    if (STOP.has(low) || UNIT_ID.test(raw)) return;
    const key = normKey(raw);
    if (!key || seen.has(key) || !_knownKey(catalog, key)) return;
    seen.add(key);
    out.push(raw);
  };
  for (let i = 0; i < toks.length; i++) {
    const pair = i + 1 < toks.length ? toks[i] + ' ' + toks[i + 1] : null;
    if (pair && !STOP.has(toks[i].toLowerCase()) && !STOP.has(toks[i + 1].toLowerCase())
      && !_knownKey(catalog, normKey(toks[i])) && _knownKey(catalog, normKey(pair))) {
      consider(pair);
      i++;
      continue;
    }
    consider(toks[i]);
  }
  return out;
}

function _explicit(t) {
  for (const re of [EXPLICIT_FOR, EXPLICIT_POSS]) {
    const m = t.match(re);
    if (!m) continue;
    const w = m[1];
    if (STOP.has(w) || UNIT_ID.test(w)) continue;
    return w;
  }
  return null;
}

/**
 * detectDbrLookup(text, catalog) -> null | { rawTarget, mine, cue, candidates }
 * candidates lists every distinct known target typed (2+ means "Which one?").
 */
function detectDbrLookup(text, catalog) {
  if (typeof text !== 'string') return null;
  const orig = text.trim().replace(/[\u2018\u2019]/g, "'");
  if (!orig || orig.length > MAX_TEXT) return null;
  const t = orig.toLowerCase();
  const stripped = t.replace(BENIGN_ME, ' ');
  if (OUTWARD.test(stripped)) return null;
  const dbr = DBR_CUE.test(t);
  const uptime = UPTIME_CUE.test(t) && !UPTIME_NOT.test(t);
  if (!dbr && !uptime) return null;
  const cue = dbr ? 'dbr' : 'uptime';
  if (dbr && MINE.test(t)) return { rawTarget: '', mine: true, cue, candidates: [] };
  const known = _knownTargets(orig, catalog);
  if (known.length) return { rawTarget: known[0], mine: false, cue, candidates: known };
  if (!dbr) return null; // the uptime cue only counts with a known target
  const w = _explicit(t);
  if (!w) return null;
  return { rawTarget: w, mine: false, cue, candidates: [w] };
}

const PROMPT_OLD = 'DBR_PULL({type:DBR_PULL}) (runs the DBR pull for AFP+DSP; for `pull dbr`/`get dbr data`)';
const PROMPT_NEW = 'DBR_PULL({type:DBR_PULL}) (runs the DBR pull for AFP+DSP from QuickSight; ONLY for `pull dbr`/`refresh dbr`/`get dbr data` when NO site, domicile or carrier is named), '
  + 'DBR_LOOKUP({type:DBR_LOOKUP,target:SITE_OR_SCAC,kind:OPTIONAL_domicile|scac|mine}) (read-only: answers DBR data for ONE named site, domicile or carrier SCAC right now from live fleet data, plus QuickSight when it was pulled today; '
  + 'for `dbr for AUVTE`, `dbr data for OAK-W`, `what\'s AUVTE\'s uptime`; use kind:mine with no target for `dbr for my sites`; if a site or SCAC is named NEVER use DBR_PULL; keep your reply to one short line, the system attaches the data)';

// One-segment replacement in the processOrchaAction action list. Returns the
// prompt unchanged when the segment is not found (the caller logs a warn).
function patchPrompt(prompt) {
  if (typeof prompt !== 'string') return prompt;
  return prompt.includes(PROMPT_OLD) ? prompt.replace(PROMPT_OLD, PROMPT_NEW) : prompt;
}

module.exports = { detectDbrLookup, patchPrompt, PROMPT_OLD, PROMPT_NEW };
