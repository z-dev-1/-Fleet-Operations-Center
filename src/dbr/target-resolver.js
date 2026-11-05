'use strict';
// src/dbr/target-resolver.js — resolves the site / domicile / SCAC Z asked about
// to ONE canonical code, or says why it can't. Pure (no store / electron).
//
// Never guesses: only an exact (case- and punctuation-insensitive) code match
// resolves. A near miss returns `unknown` with suggestions; a code that maps to
// more than one entry returns `ambiguous`.

const MAX_SUGGESTIONS = 5;
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,23}$/;
const MINE_RE = /^(my|mine|all)( sites?| domiciles?| carriers?| scacs?)?$/;

// Uppercase and strip every non-alphanumeric, so 'oak-w', 'OAK W' and 'OAKW'
// share a key.
function normKey(s) {
  return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function _code(s) { return typeof s === 'string' ? s.trim().toUpperCase() : ''; }

function sanitizeTarget(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return TARGET_RE.test(t) ? t : null;
}

function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function _add(map, code) {
  const c = _code(code);
  const k = normKey(c);
  if (!k) return;
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(c);
}

function _arr(v) { return Array.isArray(v) ? v : []; }

/**
 * buildCatalog({ rows, contacts, qsAfp, qsDsp }) ->
 *   { domiciles: Map<normKey, Set<code>>, scacs: Map<normKey, Set<code>> }
 * Domiciles: fleet domicileSite||domicile, Contact Book type:'domicile' names
 * (array or { contacts: [] }), QuickSight AFP domicile[].domicile and
 * scac[].domicile. SCACs: fleet operator, AFP scac[].scac, DSP scac[].scac.
 */
function buildCatalog({ rows, contacts, qsAfp, qsDsp } = {}) {
  const domiciles = new Map();
  const scacs = new Map();
  for (const r of _arr(rows)) {
    if (!r || typeof r !== 'object') continue;
    _add(domiciles, r.domicileSite || r.domicile);
    _add(scacs, r.operator);
  }
  const cl = Array.isArray(contacts) ? contacts : _arr(contacts && contacts.contacts);
  for (const c of cl) {
    if (c && c.type === 'domicile') _add(domiciles, c.name);
  }
  const afp = qsAfp && typeof qsAfp === 'object' ? qsAfp : {};
  for (const r of _arr(afp.domicile)) if (r) _add(domiciles, r.domicile);
  for (const r of _arr(afp.scac)) {
    if (!r) continue;
    _add(scacs, r.scac);
    _add(domiciles, r.domicile);
  }
  const dsp = qsDsp && typeof qsDsp === 'object' ? qsDsp : {};
  for (const r of _arr(dsp.scac)) if (r) _add(scacs, r.scac);
  return { domiciles, scacs };
}

function _hintKind(h) {
  const s = typeof h === 'string' ? h.trim().toLowerCase() : '';
  if (s === 'domicile' || s === 'site') return 'domicile';
  if (s === 'scac' || s === 'carrier') return 'scac';
  return null;
}

function _suggest(key, catalog) {
  const all = new Map(); // code -> normKey
  for (const m of [catalog.domiciles, catalog.scacs]) {
    if (!(m instanceof Map)) continue;
    for (const [k, set] of m) for (const c of set) all.set(c, k);
  }
  const max = key.length < 5 ? 1 : 2;
  const hits = [];
  for (const [code, ck] of all) {
    const d = levenshtein(key, ck);
    const near = d <= max;
    const part = key.length >= 3 && (ck.startsWith(key) || ck.endsWith(key) || ck.includes(key));
    if (near || part) hits.push({ code, d });
  }
  hits.sort((a, b) => (a.d - b.d) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return hits.slice(0, MAX_SUGGESTIONS).map((h) => h.code);
}

/**
 * resolveTarget(raw, kindHint, catalog) -> one of
 *   { status:'mine' }
 *   { status:'ok', kind:'domicile'|'scac', code }
 *   { status:'ambiguous', options:[{kind, code}] }
 *   { status:'unknown', suggestions:[code] }
 */
function resolveTarget(raw, kindHint, catalog) {
  if (kindHint === 'mine') return { status: 'mine' };
  const cat = catalog && typeof catalog === 'object' ? catalog : {};
  const lower = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  if (lower && MINE_RE.test(lower)) return { status: 'mine' };
  const clean = sanitizeTarget(raw);
  const key = clean ? normKey(clean) : '';
  if (!key) return { status: 'unknown', suggestions: [] };
  const options = [];
  const d = cat.domiciles instanceof Map ? cat.domiciles.get(key) : null;
  const s = cat.scacs instanceof Map ? cat.scacs.get(key) : null;
  for (const c of d || []) options.push({ kind: 'domicile', code: c });
  for (const c of s || []) options.push({ kind: 'scac', code: c });
  let picked = options;
  const hint = _hintKind(kindHint);
  if (hint) {
    const narrowed = options.filter((o) => o.kind === hint);
    if (narrowed.length) picked = narrowed;
  }
  if (picked.length === 1) return { status: 'ok', kind: picked[0].kind, code: picked[0].code };
  if (picked.length > 1) {
    const sorted = picked.slice().sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    return { status: 'ambiguous', options: sorted };
  }
  return { status: 'unknown', suggestions: _suggest(key, cat) };
}

module.exports = { buildCatalog, normKey, resolveTarget, sanitizeTarget, levenshtein, MAX_SUGGESTIONS };
