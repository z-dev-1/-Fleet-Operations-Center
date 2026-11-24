'use strict';
/**
 * autopilot/provenance.js — observedAt / retrievedAt / authority tag per source (§B7.4). Pure.
 *
 * provenanceOf(source, field, ctx) -> { observedAt, retrievedAt, authorityTag, observedFrom }
 *
 * ctx per source:
 *   aap_cache:    { row, syncedAt, buildAtMs }   R1: fallback = buildAtMs ?? Date.parse(syncedAt)
 *   aap_live:     { item, retrievedAt, commentDerived }
 *   canonical:    { record, retrievedAt | canonicalUpdatedAt | syncedAt }
 *   dtna:         { entry }
 *   decisiv:      { entry | item, retrievedAt }
 *   email:        { item }
 *   long_dwell:   { entry }
 *   slack:        { message, retrievedAt }
 *   repair_intel: { event, retrievedAt }
 *   fas_case:     { entry, retrievedAt }
 *   vendor_intel: { scorecard, retrievedAt }
 *   aperia_cache: { issue, pulledAt }
 */

const { toMs } = require('./updates');

const AAP_FIELDS = new Set([
  'lifecycleState', 'lifecycleReason', 'workRequestId', '_serviceId', '_offsiteWrId', 'serviceState', 'subState',
  'hasOpenWR', 'openUnplanned', 'openPlanned', 'created', 'workDuration', 'completed',
]);

function _first(...vals) {
  for (const v of vals) { const t = toMs(v); if (t != null) return t; }
  return null;
}

function _aapCache(field, ctx) {
  const row = ctx.row || {};
  const base = Number.isFinite(ctx.buildAtMs) ? ctx.buildAtMs : toMs(ctx.syncedAt);
  let observedAt = null;
  let observedFrom = null;
  if (field === 'offsiteStage') { observedAt = toMs(row.offsiteStageSince); if (observedAt != null) observedFrom = 'offsiteStageSince'; }
  else if (field === 'repairEtc' || field === '_factEtc.date') { observedAt = toMs(row._factEtc && row._factEtc.statedAt); if (observedAt != null) observedFrom = '_factEtc.statedAt'; }
  if (observedAt == null) { observedAt = base; observedFrom = Number.isFinite(ctx.buildAtMs) ? 'buildAt' : 'syncedAt'; }
  let authorityTag;
  if (field === 'repairEtc') authorityTag = String(row.repairEtcSource || '').toLowerCase() || 'notes';
  else if (field === '_factEtc.date') authorityTag = String((row._factEtc && row._factEtc.source) || '').toLowerCase() || 'notes';
  else if (AAP_FIELDS.has(field)) authorityTag = 'aap';
  else authorityTag = 'fleetdata';
  return { observedAt, retrievedAt: base, authorityTag, observedFrom };
}

function provenanceOf(source, field, ctx) {
  const c = ctx || {};
  const readAt = toMs(c.retrievedAt);
  switch (source) {
    case 'aap_cache': return _aapCache(field, c);
    case 'aap_live': {
      const it = c.item || {};
      const stated = _first(it.updated, it.timestamp);
      const observedAt = stated ?? readAt;
      return { observedAt, retrievedAt: readAt, authorityTag: c.commentDerived ? 'relaygarage' : 'aap', observedFrom: stated == null && observedAt != null ? 'retrievedAt' : null };
    }
    case 'canonical': {
      const r = c.record || {};
      return { observedAt: _first(r.statusChangedAt, r.updatedAt), retrievedAt: _first(c.canonicalUpdatedAt, c.retrievedAt, c.syncedAt), authorityTag: 'canonical', observedFrom: null };
    }
    case 'dtna': {
      const e = c.entry || {};
      const observedAt = /comment|thread/i.test(field) ? _first(e.lastCommentAt, e.stageSince) : _first(e.stageSince, e.lastCommentAt);
      return { observedAt, retrievedAt: _first(e.pulledAt, c.retrievedAt), authorityTag: 'offsiteevent', observedFrom: null };
    }
    case 'decisiv': {
      const e = c.entry || c.item || {};
      return { observedAt: _first(e.since, e.date, e.createdAt), retrievedAt: _first(c.retrievedAt, e.fetchedAt), authorityTag: 'decisiv', observedFrom: null };
    }
    case 'email': {
      const t = toMs(c.item && c.item.observedAt);
      return { observedAt: t, retrievedAt: t, authorityTag: 'notes', observedFrom: null };
    }
    case 'long_dwell': {
      const e = c.entry || {};
      const t = _first(e.updatedAt, e.importedAt);
      return { observedAt: t, retrievedAt: t, authorityTag: 'notes', observedFrom: null };
    }
    case 'slack': return { observedAt: _first(c.message && (c.message.ts || c.message.timestamp)), retrievedAt: readAt, authorityTag: 'notes', observedFrom: null };
    case 'repair_intel': return { observedAt: _first(c.event && c.event.reported_at), retrievedAt: readAt, authorityTag: 'fleetdata', observedFrom: null };
    case 'fas_case': return { observedAt: _first(c.entry && c.entry.updatedAt), retrievedAt: readAt, authorityTag: 'notes', observedFrom: null };
    case 'vendor_intel': return { observedAt: _first(c.scorecard && c.scorecard.computedAt), retrievedAt: readAt, authorityTag: null, observedFrom: null };
    case 'aperia_cache': return { observedAt: _first(c.issue && c.issue.dateDetected), retrievedAt: _first(c.pulledAt, c.retrievedAt), authorityTag: null, observedFrom: null };
    default: return { observedAt: null, retrievedAt: readAt, authorityTag: null, observedFrom: null };
  }
}

module.exports = { provenanceOf };
