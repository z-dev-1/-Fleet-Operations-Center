'use strict';
/**
 * longdwell/sheet-links.js - host-local store of the weekly SharePoint sheet
 * link, keyed by ISO week ("2026-W45"). The link changes every week, so lookup
 * is by exact week key only; history is kept and pruned to the newest 26 weeks.
 *
 * Store key 'longDwellSheetLinks' (REGISTRY only, never cluster-synced). The
 * file holds sharing URLs (they can carry an access token), so nothing here
 * logs a URL.
 *
 * Shape: { links: { "<week>": { url, kind, setAt, resolved|null, lastWrite|null } } }
 */
const crypto = require('crypto');

const STORE_KEY = 'longDwellSheetLinks';
const MAX_WEEKS = 26;
const DEFAULT_DOC = () => ({ links: {} });

// ISO-8601 week key from LOCAL calendar components; UTC arithmetic on those
// components so DST cannot shift the day.
function isoWeekKey(d = new Date()) {
  const t = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Mon=0
  const thu = t - dow * 864e5 + 3 * 864e5;      // Thursday of this ISO week
  const y = new Date(thu).getUTCFullYear();
  const week = 1 + Math.floor((thu - Date.UTC(y, 0, 1)) / 864e5 / 7);
  return y + '-W' + String(week).padStart(2, '0');
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
}

function _deps(deps) {
  const d = deps || {};
  return {
    store: d.store || require('../store'),
    now: typeof d.now === 'function' ? d.now : () => new Date(),
  };
}

function _doc(v) {
  const o = v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  const links = o.links && typeof o.links === 'object' && !Array.isArray(o.links) ? o.links : {};
  return { ...o, links: { ...links } };
}

function _prune(links) {
  const keys = Object.keys(links).sort();
  const drop = keys.slice(0, Math.max(0, keys.length - MAX_WEEKS));
  for (const k of drop) delete links[k];
  return links;
}

function _week(deps, weekKey) {
  return typeof weekKey === 'string' && weekKey ? weekKey : isoWeekKey(deps.now());
}

function getLink(weekKey, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  const doc = _doc(d.store.load(STORE_KEY, DEFAULT_DOC()));
  const rec = doc.links[wk];
  return rec && typeof rec === 'object' && typeof rec.url === 'string' ? rec : null;
}

// Writes a COMPLETE new record: a replaced link never inherits the previous
// resolution, chosen tab or last-write counts.
function setLink(weekKey, { url, kind }, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  const rec = { url: String(url), kind: kind || null, setAt: d.now().toISOString(), resolved: null, lastWrite: null };
  d.store.update(STORE_KEY, (cur) => {
    const doc = _doc(cur);
    doc.links[wk] = rec;
    _prune(doc.links);
    return doc;
  }, DEFAULT_DOC());
  return { weekKey: wk, record: rec };
}

// Caches a resolution on the week's record. resolved.forUrlSha256 ties it to
// the URL it was resolved for; a different URL ignores it.
function setResolved(weekKey, resolved, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  let out = null;
  d.store.update(STORE_KEY, (cur) => {
    const doc = _doc(cur);
    const rec = doc.links[wk];
    if (!rec || typeof rec.url !== 'string') return doc;
    const r = resolved && typeof resolved === 'object' ? resolved : {};
    out = { ...r, forUrlSha256: sha256(rec.url), resolvedAt: d.now().toISOString() };
    doc.links[wk] = { ...rec, resolved: out };
    return doc;
  }, DEFAULT_DOC());
  return out;
}

// The cached resolution, only when it belongs to the record's current URL.
function resolvedFor(rec) {
  if (!rec || !rec.resolved || typeof rec.url !== 'string') return null;
  return rec.resolved.forUrlSha256 === sha256(rec.url) ? rec.resolved : null;
}

function clearLink(weekKey, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  let removed = false;
  d.store.update(STORE_KEY, (cur) => {
    const doc = _doc(cur);
    if (doc.links[wk]) { delete doc.links[wk]; removed = true; }
    return doc;
  }, DEFAULT_DOC());
  return removed;
}

// Records counts only (never cell contents).
function markWrite(weekKey, counts, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  const c = counts && typeof counts === 'object' ? counts : {};
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const lastWrite = { at: d.now().toISOString(), written: n(c.written), failed: n(c.failed) };
  d.store.update(STORE_KEY, (cur) => {
    const doc = _doc(cur);
    const rec = doc.links[wk];
    if (rec && typeof rec.url === 'string') doc.links[wk] = { ...rec, lastWrite };
    return doc;
  }, DEFAULT_DOC());
  return lastWrite;
}

// ── Pluggable link sources (only 'manual' ships) ────────────────────────────
// A source returns null or { url, confidence: 'user'|'high'|'low', source }.
const sources = [
  {
    id: 'manual',
    find: async (weekKey, deps) => {
      const rec = getLink(weekKey, deps);
      return rec ? { url: rec.url, confidence: 'user', source: 'manual', record: rec } : null;
    },
  },
];

function registerSource(src) {
  if (!src || typeof src.id !== 'string' || typeof src.find !== 'function') throw new TypeError('invalid link source');
  if (sources.some((s) => s.id === src.id)) throw new TypeError('duplicate link source');
  sources.push(src);
}

async function findLink(weekKey, deps) {
  const d = _deps(deps);
  const wk = _week(d, weekKey);
  for (const s of sources) {
    let r = null;
    try { r = await s.find(wk, deps); } catch { r = null; }
    if (r && typeof r.url === 'string' && r.url) return r;
  }
  return null;
}

// Test seam: drop every non-default source.
function _resetSourcesForTests() { sources.splice(1); }

module.exports = {
  STORE_KEY, MAX_WEEKS, isoWeekKey, sha256,
  getLink, setLink, setResolved, resolvedFor, clearLink, markWrite,
  sources, registerSource, findLink, _resetSourcesForTests,
};
