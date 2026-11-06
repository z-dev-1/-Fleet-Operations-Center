'use strict';
/**
 * email-intel/understand/scope.js — "is this unit mine?" and the deterministic full-body unit pass
 * (design 3.2; R1.3, R2.3, AC-7, F-25, F2-10).
 *
 *   buildScopeIndex({ now, fleetData?, fasName?, fasFor? }) -> ScopeIndex
 *     .ready / .stale / .reason ('ok'|'fleet-empty'|'fleet-stale') / .byId (Map lowerId -> row info)
 *     .scopeOf(id)  -> 'in' | 'out' | 'unknown'
 *     .detail(id)   -> { scope, unit, operator, domicileSite, rosterMismatch }
 *   extractUnits(text, index)  -> [{ id, key, scope, offsets[], rosterMismatch }]   (offsets into `text`)
 *   scanMessage(record, index) -> { subject[], body[], quotedOnly[], all[] }
 *
 * Rules: the source is store fleetData.rows[].equipmentId. With zero rows, or a sync time
 * (syncedAt, else scrapedAt) that is missing, unparseable or older than FLEET_STALE_HOURS, every
 * unit is 'unknown' (never 'out'), so nothing is dropped because of a bad fleet snapshot.
 *
 * Optional roster cross-check: when me.fasName is configured and the FAS roster names a different
 * FAS for the unit's (scac || operator, domicileSite), the unit stays 'in' with rosterMismatch:true
 * and Phase C stages its facts. The check can only downgrade, never upgrade. With an EMPTY fasName
 * the check is skipped entirely, so no scope result changes (F2-10).
 *
 * Unit tokens follow email_intel.extractUnits (`[A-Za-z]?\d{4,7}`, exact case-insensitive row match).
 * Dates, phone numbers and $ amounts are blanked (same length, offsets preserved) before the pass so
 * a year or a price is never mistaken for a unit id.
 */
const C = require('../constants');

const UNIT_RE = /\b([A-Za-z]?\d{4,7})\b/g;
const BLANK_RES = [
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g,
  /(\+\d[\d\s().-]{8,}\d)|(\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b)/g,
  /\$\s?\d[\d,]*(?:\.\d+)?/g,
];

function _blank(text) {
  let t = String(text == null ? '' : text);
  for (const re of BLANK_RES) t = t.replace(re, (m) => ' '.repeat(m.length));
  return t;
}

function _rowsOf(fleet) {
  return fleet && Array.isArray(fleet.rows) ? fleet.rows.filter((r) => r && String(r.equipmentId || '').trim()) : [];
}

function buildScopeIndex(opts) {
  opts = opts || {};
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let fleet = opts.fleetData;
  if (fleet === undefined) {
    try { fleet = require('../../store').load('fleetData', {}); } catch (_) { fleet = {}; }
  }
  const rows = _rowsOf(fleet);
  const byId = new Map();
  for (const r of rows) {
    const unit = String(r.equipmentId).trim();
    byId.set(unit.toLowerCase(), { unit, operator: String(r.operator || '').trim(), domicileSite: String(r.domicileSite || '').trim(), scac: String(r.scac || '').trim() });
  }
  const stamp = fleet ? (fleet.syncedAt || fleet.scrapedAt) : null;
  const t = stamp ? Date.parse(stamp) : NaN;
  const ready = byId.size > 0;
  const stale = !Number.isFinite(t) || now - t > C.FLEET_STALE_HOURS * 3_600_000;
  const reason = !ready ? 'fleet-empty' : (stale ? 'fleet-stale' : 'ok');
  const fasName = typeof opts.fasName === 'string' ? opts.fasName.trim().toLowerCase() : '';
  let fasFor = opts.fasFor || null;
  const rosterCache = new Map();

  function _roster(info) {
    if (!fasName) return false;                                      // F2-10: no fasName, no cross-check
    if (rosterCache.has(info.unit)) return rosterCache.get(info.unit);
    let mismatch = false;
    try {
      if (!fasFor) fasFor = require('../../orcha/fas/roster-lookup').fasFor;
      const name = String(fasFor(info.scac || info.operator, info.domicileSite) || '').trim().toLowerCase();
      mismatch = !!name && name !== fasName;
    } catch (_) { mismatch = false; }
    rosterCache.set(info.unit, mismatch);
    return mismatch;
  }

  function scopeOf(id) {
    if (!ready || stale) return 'unknown';
    return byId.has(String(id == null ? '' : id).trim().toLowerCase()) ? 'in' : 'out';
  }

  function detail(id) {
    const key = String(id == null ? '' : id).trim().toLowerCase();
    const info = byId.get(key) || null;
    const scope = scopeOf(key);
    return {
      scope, unit: info ? info.unit : String(id == null ? '' : id).trim(),
      operator: info ? info.operator : '', domicileSite: info ? info.domicileSite : '',
      rosterMismatch: scope === 'in' && info ? _roster(info) : false,
    };
  }

  return { ready, stale, reason, byId, size: byId.size, scopeOf, detail };
}

/** extractUnits(text, index) -> mentions with every occurrence offset (offsets index into `text`). */
function extractUnits(text, index) {
  const src = String(text == null ? '' : text);
  const blanked = _blank(src);
  const map = new Map();
  UNIT_RE.lastIndex = 0;
  let m;
  while ((m = UNIT_RE.exec(blanked)) !== null) {
    const key = m[1].toLowerCase();
    let e = map.get(key);
    if (!e) {
      const d = index ? index.detail(key) : { scope: 'unknown', unit: m[1], rosterMismatch: false };
      e = { id: d.unit || m[1], key, scope: d.scope, offsets: [], rosterMismatch: !!d.rosterMismatch };
      map.set(key, e);
    }
    e.offsets.push(m.index);
  }
  return Array.from(map.values());
}

/**
 * scanMessage(record, index): the deterministic pass over the subject and the stored new content
 * (which includes forwarded segments). Units that the segmenter saw only in quoted text are reported
 * separately (`quotedOnly`): they are context, never new facts.
 */
function scanMessage(rec, index) {
  const subject = extractUnits(rec && rec.subject, index);
  const body = extractUnits(rec && rec.body && rec.body.newContent, index);
  const all = new Map();
  for (const u of body) all.set(u.key, Object.assign({}, u, { inSubject: false, inBody: true }));
  for (const u of subject) {
    const e = all.get(u.key);
    if (e) e.inSubject = true; else all.set(u.key, Object.assign({}, u, { offsets: [], inSubject: true, inBody: false }));
  }
  const quotedOnly = [];
  for (const q of (rec && rec.body && Array.isArray(rec.body.unitsOnlyInQuoted) ? rec.body.unitsOnlyInQuoted : [])) {
    const key = String(q).toLowerCase();
    if (all.has(key)) continue;
    const d = index ? index.detail(key) : { scope: 'unknown', unit: String(q) };
    quotedOnly.push({ id: d.unit || String(q), key, scope: d.scope });
  }
  return { subject, body, quotedOnly, all: Array.from(all.values()) };
}

module.exports = { buildScopeIndex, extractUnits, scanMessage, _blank };
