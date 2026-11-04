'use strict';
/**
 * src/ai/authority.js — field-specific source authority + conflict policy (spec §4).
 *
 * There is NO single universal precedence ranking. Each operational FIELD has
 * its own authority order. When two sources provide the same field, this module
 * picks the authoritative value AND reports whether the sources conflict — the
 * AI must receive conflicts EXPLICITLY and never silently pick the nicer text.
 *
 * Precedence is expressed as an ordered list of source tags (highest authority
 * first). Source tags match the `source` strings the FAS/tool layer already
 * emits (e.g. 'AAP/fleetData', 'RelayGarage', 'Uptake', 'notes/Relay',
 * 'OffsiteEvent'), matched case-insensitively by substring so minor tag
 * variations still resolve.
 *
 * Pure + deterministic. No I/O.
 */

// Field -> ordered source authority (highest first). Fields not listed use a
// sensible default: fresher/live source wins, else first-seen.
const FIELD_AUTHORITY = {
  // Lifecycle: live AAP > canonical cache > older fleet snapshot.
  lifecycleState: ['aap', 'canonical', 'fleetdata'],
  lifecycleReason: ['aap', 'relaygarage', 'canonical', 'fleetdata'],
  // Dealer/repair status: live dealer/Decisiv/PACCAR > verified timeline > cached note.
  serviceState: ['relaygarage', 'offsiteevent', 'decisiv', 'paccar', 'notes'],
  repairStatus: ['relaygarage', 'offsiteevent', 'notes', 'fleetdata'],
  workAccomplished: ['relaygarage/wo', 'relaygarage', 'offsiteevent', 'notes'],
  reasonForRepair: ['relaygarage/wo', 'relaygarage', 'offsiteevent', 'notes'],
  // Work orders: live AAP counts > relay-derived.
  openUnplanned: ['aap', 'fleetdata', 'relaygarage'],
  openPlanned: ['aap', 'fleetdata', 'relaygarage'],
  workRequestId: ['aap', 'fleetdata', 'relaygarage'],
  hasOpenWR: ['aap', 'fleetdata', 'relaygarage'],
  // PM / inspection: authoritative maintenance source > canonical derived > historical.
  pmB: ['aap', 'fleetdata', 'canonical'],
  pmX: ['aap', 'fleetdata', 'canonical'],
  dot: ['aap', 'fleetdata', 'canonical'],
  inspectionDueDate: ['fleetdata(dot)', 'aap', 'fleetdata'],
  inspectionStatus: ['fleetdata(dot)', 'aap', 'fleetdata'],
  // Location: live authoritative location > last verified canonical.
  location: ['aap', 'canonical', 'fleetdata'],
  domicile: ['fleetdata', 'aap', 'canonical'],
  // Predictive: Uptake is authoritative for risk/insights.
  riskScore: ['uptake'],
  insights: ['uptake'],
  // Vendor: fleet record then relay-derived.
  vendor: ['fleetdata', 'relaygarage', 'aap'],
};

// Freshness rank so, within equal authority, a fresher value wins.
const FRESHNESS_RANK = { LIVE: 3, RECENT: 2, STALE: 0, UNKNOWN: 1 };

function _tag(s) { return String(s || '').toLowerCase(); }

// Authority index of a source for a field: lower index = higher authority.
// Returns Infinity when the source is not in the field's list (lowest).
function _authorityIndex(field, source) {
  const order = FIELD_AUTHORITY[field];
  if (!order) return null; // no field-specific rule
  const src = _tag(source);
  for (let i = 0; i < order.length; i++) {
    if (src.includes(order[i])) return i;
  }
  return Infinity;
}

/**
 * resolveField(field, candidates) -> {
 *   value, source, freshness, conflict, candidates, reason
 * }
 * candidates: [{ value, source, freshness }]
 *
 * Deterministic resolution:
 *   1. If a field-specific authority order exists, the highest-authority source
 *      wins; ties broken by freshness, then by first-seen.
 *   2. Otherwise, freshest wins; ties broken by first-seen.
 *   3. conflict=true when ≥2 DISTINCT values exist among candidates (regardless
 *      of which won) — the caller MUST surface it.
 */
function resolveField(field, candidates) {
  const list = (candidates || []).filter((c) => c && c.value != null);
  if (!list.length) return { value: null, source: null, freshness: 'UNKNOWN', conflict: false, candidates: [], reason: 'no candidates' };

  const distinct = Array.from(new Set(list.map((c) => _norm(c.value))));
  const conflict = distinct.length > 1;

  const hasRule = !!FIELD_AUTHORITY[field];
  const scored = list.map((c) => ({
    c,
    auth: hasRule ? _authorityIndex(field, c.source) : 0,
    fresh: FRESHNESS_RANK[c.freshness] != null ? FRESHNESS_RANK[c.freshness] : 1,
  }));

  scored.sort((a, b) => {
    if (hasRule && a.auth !== b.auth) return a.auth - b.auth;   // lower index = higher authority
    if (a.fresh !== b.fresh) return b.fresh - a.fresh;          // fresher wins
    return 0;                                                   // stable -> first-seen
  });

  const winner = scored[0].c;
  return {
    value: winner.value,
    source: winner.source,
    freshness: winner.freshness,
    conflict,
    candidates: list.map((c) => ({ value: c.value, source: c.source, freshness: c.freshness })),
    reason: hasRule ? ('field-authority: ' + (FIELD_AUTHORITY[field] || []).join(' > ')) : 'no field rule — freshest wins',
  };
}

/**
 * reconcile(evidence) -> { fields, conflicts }
 * Given an array of normalized tool envelopes (from src/ai/tools), group facts
 * by field across sources and resolve each field. Returns the resolved field
 * map plus an explicit conflict list (spec §4: conflicts surfaced, not hidden).
 */
function reconcile(evidence) {
  const byField = {};
  for (const env of (evidence || [])) {
    if (!env || !env.ok || !env.data || !Array.isArray(env.data.facts)) continue;
    for (const f of env.data.facts) {
      if (!f || f.value == null) continue;
      (byField[f.field] = byField[f.field] || []).push({ value: f.value, source: f.source || env.source, freshness: env.freshness });
    }
  }
  const fields = {};
  const conflicts = [];
  for (const field of Object.keys(byField)) {
    const r = resolveField(field, byField[field]);
    fields[field] = r;
    if (r.conflict) conflicts.push({ field, resolved: { value: r.value, source: r.source }, candidates: r.candidates });
  }
  return { fields, conflicts };
}

function _norm(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }

module.exports = { resolveField, reconcile, FIELD_AUTHORITY, FRESHNESS_RANK };
