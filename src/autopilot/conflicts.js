'use strict';
/**
 * autopilot/conflicts.js — conflict groups over pack items (§B7.4 with plan R2). Pure.
 *
 * buildConflicts(items, { isDown }) -> { groups[], memberOf{evidenceId: [group]} }
 *   Same-field groups cf_<field> for the CONFLICT_FIELDS fields, using
 *   ai/authority.resolveField with each candidate's authority tag. Only
 *   structured items count. A mirror candidate (aap_cache.offsiteStage) counts
 *   only when no decisiv / dtna repairStatus item exists.
 *   authorityWinner is null on an authority tie (same authority index AND same
 *   freshness rank between the top candidate and the best differing candidate).
 *   Cross-field cf_status: unit down AND a structured 'ready' stage item (or
 *   canonical ready_for_pickup). Informational; the AAP lifecycle is named as
 *   the winner per field authority. Canonical status is never a lifecycleState
 *   candidate. There is no cf_stage (cf_repairStatus covers it).
 */

const { FIELD_AUTHORITY, FRESHNESS_RANK, resolveField } = require('../ai/authority');
const untrusted = require('../email-intel/untrusted');
const { CONFLICT_FIELDS } = require('./constants');
const { LIFECYCLE_STATES } = require('./classify');
const { isoDate } = require('./updates');

function authorityIndex(field, tag) {
  const order = FIELD_AUTHORITY[field];
  if (!order) return 0;                       // no field rule: every candidate ties on authority
  const t = String(tag || '').toLowerCase();
  for (let i = 0; i < order.length; i++) if (t.includes(order[i])) return i;
  return Infinity;
}
const fr = (c) => (FRESHNESS_RANK[c.freshness] != null ? FRESHNESS_RANK[c.freshness] : 1);
// Exact copy of authority._norm.
function norm(v) { try { return typeof v === 'object' ? JSON.stringify(v) : String(v); } catch (_) { return String(v); } }

function _spec(item) {
  for (const f of Object.keys(CONFLICT_FIELDS)) {
    for (const c of CONFLICT_FIELDS[f].candidates) {
      if (c.source === item.source && c.field === item.field) return { field: f, cand: c };
    }
  }
  return null;
}

function conflictFieldOf(item) {
  if (!item) return null;
  if (item.conflictField) return item.conflictField;
  const s = _spec(item);
  return s ? s.field : null;
}

/** normalizeConflictValue(field, value, { source, refMs }) -> normalized value | null */
function normalizeConflictValue(field, value, opts) {
  const spec = CONFLICT_FIELDS[field];
  if (!spec) return value;
  const o = opts || {};
  if (value == null) return null;
  const s = String(value).trim();
  switch (spec.norm) {
    case 'lifecycle': {
      if (!s) return null;
      const hit = LIFECYCLE_STATES.find((x) => x === s.toLowerCase());
      return hit ? hit.charAt(0).toUpperCase() + hit.slice(1) : s;
    }
    case 'stage': {
      const v = s.toLowerCase();
      if (v === '') return o.source === 'decisiv' ? 'none' : null;   // Decisiv API answer "no status set"
      return v;
    }
    case 'date': return isoDate(s, o.refMs);
    case 'name': {
      const v = untrusted.sanitize(s, '').trim().replace(/\s+/g, ' ').toLowerCase();
      return v || null;
    }
    default: return s;
  }
}

/** Ranked candidates (authority index, then freshness; stable). Matches resolveField's order. */
function rankCandidates(field, candidates) {
  const idx = (c) => authorityIndex(field, c.authorityTag);
  return candidates.slice().sort((a, b) => (idx(a) - idx(b)) || (fr(b) - fr(a)));
}

function _value(it, field) {
  if (it.normalizedValue !== undefined) return it.normalizedValue;
  return normalizeConflictValue(field, it.value, { source: it.source, refMs: it.observedAt || undefined });
}

function _position(it, value) {
  return { source: it.source, field: it.field, value, evidenceId: it.evidenceId || null, authorityTag: it.authorityTag || null };
}

function _sameField(field, list) {
  const cands = list.map((x) => ({ item: x.item, value: x.value, authorityTag: x.item.authorityTag, freshness: x.item.freshness }));
  const r = resolveField(field, cands.map((c) => ({ value: c.value, source: c.authorityTag, freshness: c.freshness })));
  if (!r.conflict) return null;
  const ranked = rankCandidates(field, cands);
  const top = ranked[0];
  const rival = ranked.find((c) => norm(c.value) !== norm(top.value));
  const idx = (c) => authorityIndex(field, c.authorityTag);
  const tie = !!rival && idx(rival) === idx(top) && fr(rival) === fr(top);
  return {
    group: 'cf_' + field,
    fields: [field],
    positions: cands.map((c) => _position(c.item, c.value)),
    authorityWinner: tie ? null : _position(top.item, top.value),
  };
}

function buildConflicts(items, opts) {
  const o = opts || {};
  const list = (items || []).filter((it) => it && it.trust === 'structured');
  const byField = new Map();
  for (const it of list) {
    const field = conflictFieldOf(it);
    if (!field) continue;
    const s = _spec(it);
    const value = _value(it, field);
    if (value == null) continue;
    const arr = byField.get(field) || [];
    arr.push({ item: it, value, mirror: !!(s && s.cand.mirror) });
    byField.set(field, arr);
  }
  const groups = [];
  for (const field of Object.keys(CONFLICT_FIELDS)) {
    let arr = byField.get(field);
    if (!arr || arr.length < 2) continue;
    if (arr.some((x) => !x.mirror)) arr = arr.filter((x) => !x.mirror);
    const g = _sameField(field, arr);
    if (g) groups.push(g);
  }

  if (o.isDown) {
    const life = list.find((it) => conflictFieldOf(it) === 'lifecycleState');
    const ready = [];
    for (const it of list) {
      if (['decisiv', 'dtna', 'aap_cache'].includes(it.source) && conflictFieldOf(it) === 'repairStatus' && _value(it, 'repairStatus') === 'ready') ready.push(_position(it, 'ready'));
      else if (it.source === 'canonical' && it.field === 'status' && String(it.value).trim().toLowerCase() === 'ready_for_pickup') ready.push(_position(it, 'ready_for_pickup'));
    }
    if (ready.length) {
      const lp = life ? _position(life, _value(life, 'lifecycleState')) : null;
      groups.push({
        group: 'cf_status',
        fields: ['lifecycleState', 'repairStatus'],
        positions: (lp ? [lp] : []).concat(ready),
        authorityWinner: lp,
        informational: true,
      });
    }
  }

  const memberOf = {};
  for (const g of groups) {
    for (const p of g.positions) {
      if (!p.evidenceId) continue;
      (memberOf[p.evidenceId] = memberOf[p.evidenceId] || []).push(g.group);
    }
  }
  return { groups, memberOf };
}

/** A lifecycleState / repairStatus group with no authority winner sends the case to NEEDS_REVIEW. */
function needsReview(groups) {
  return (groups || []).some((g) => (g.group === 'cf_lifecycleState' || g.group === 'cf_repairStatus') && g.authorityWinner === null);
}

module.exports = {
  buildConflicts, needsReview, authorityIndex, rankCandidates, normalizeConflictValue, conflictFieldOf, norm, fr,
};
