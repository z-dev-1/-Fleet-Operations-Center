'use strict';
/**
 * action-log.js — short rolling log of what the user just did in the app
 * (context-aware assistant, design §D7). Store key assistantActionLog:
 *   { actions: [ { at, type, unit, wr, detail, actor } ] }  newest first, ring 50.
 *
 * Only successful user actions are recorded (the handlers call the pure
 * from* mappers below, which return null unless the result shows success).
 * Message bodies, email bodies and escalation comments are NEVER recorded;
 * `detail` carries recipient names / teams / states only and is redacted.
 * record() never throws.
 */

const store  = require('../../store');
const logger = require('../../utils/logger')('action-log');

const MAX_ACTIONS = 50;
const MAX_DETAIL  = 160;
const MAX_ID      = 64;
const TYPES = new Set(['wr-created', 'escalation', 'de-escalation', 'lifecycle-set', 'message-sent', 'email-sent',
  'timeline-add', 'timeline-edit', 'timeline-hide', 'notes-saved']);
const ACTORS = new Set(['user', 'user-via-orcha']);
const REDACT_RE = /(xox[a-z]-[A-Za-z0-9-]+|Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+|[A-Za-z0-9+\/]{40,})/g;

function _id(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return s ? s.slice(0, MAX_ID) : null;
}

function _detail(v) {
  if (v == null) return '';
  return String(v).replace(REDACT_RE, '[redacted]').slice(0, MAX_DETAIL);
}

function record(entry, deps = {}) {
  const log = deps.log || logger;
  try {
    if (!entry || !TYPES.has(entry.type)) { log.debug('[action-log] ignored type ' + (entry && entry.type)); return; }
    const load = deps.load || store.load;
    const save = deps.save || store.save;
    const now = deps.now || Date.now;
    const rec = {
      at: now(), type: entry.type, unit: _id(entry.unit), wr: _id(entry.wr),
      detail: _detail(entry.detail), actor: ACTORS.has(entry.actor) ? entry.actor : 'user',
    };
    const doc = load('assistantActionLog', null);
    const actions = (doc && Array.isArray(doc.actions)) ? doc.actions.slice() : [];
    actions.unshift(rec);
    save('assistantActionLog', { actions: actions.slice(0, MAX_ACTIONS) });
  } catch (e) {
    try { log.warn('[action-log] record failed: ' + e.message); } catch (_) { /* never throw */ }
  }
}

function recent(n, maxAgeMs, deps = {}) {
  try {
    const load = deps.load || store.load;
    const now = (deps.now || Date.now)();
    const doc = load('assistantActionLog', null);
    const actions = (doc && Array.isArray(doc.actions)) ? doc.actions : [];
    return actions.filter((a) => a && typeof a.at === 'number' && (!maxAgeMs || now - a.at <= maxAgeMs)).slice(0, Math.max(0, n || 0));
  } catch (_) { return []; }
}

function resolveUnit({ equipmentId, aaid, assetUrl, workRequestId } = {}, deps = {}) {
  try {
    const load = deps.load || store.load;
    const fd = load('fleetData', {});
    const rows = (fd && Array.isArray(fd.rows)) ? fd.rows : [];
    const pick = (r) => (r && r.equipmentId ? String(r.equipmentId) : null);
    if (equipmentId) {
      const r = rows.find((x) => x && String(x.equipmentId) === String(equipmentId));
      if (r) return pick(r);
    }
    if (workRequestId) {
      const w = String(workRequestId);
      const r = rows.find((x) => x && (String(x.workRequestId || '') === w
        || (Array.isArray(x._secondaryWRs) && x._secondaryWRs.some((s) => String((s && typeof s === 'object') ? s.workRequestId : s) === w))));
      if (r) return pick(r);
    }
    const a = aaid ? String(aaid) : '';
    if (a) {
      const r = rows.find((x) => x && typeof x.assetUrl === 'string' && x.assetUrl.includes(a));
      if (r) return pick(r);
    }
    if (assetUrl) {
      const r = rows.find((x) => x && x.assetUrl && String(x.assetUrl) === String(assetUrl));
      if (r) return pick(r);
    }
    return null;
  } catch (_) { return null; }
}

// ── pure mappers (each returns null unless the result shows success) ────────
function fromCreateWr(result, ctx = {}) {
  if (!result || result.phase !== 'commit' || !result.workRequestId || result.ok === false || result.error) return null;
  const vendor = ctx.vendor || result.vendor || '';
  return { type: 'wr-created', unit: ctx.unitId || null, wr: String(result.workRequestId),
    detail: 'vendor ' + vendor + (ctx.towDirection ? ' (tow)' : ''), actor: 'user' };
}

// Never reads the payload's comment.
function fromEscalationUpdate({ add, remove, workRequestId } = {}, unit) {
  const out = [];
  const wr = workRequestId ? String(workRequestId) : null;
  const a = Array.isArray(add) ? add.map(String).filter(Boolean) : [];
  const r = Array.isArray(remove) ? remove.map(String).filter(Boolean) : [];
  if (a.length) out.push({ type: 'escalation', unit: unit || null, wr, detail: a.join(', '), actor: 'user' });
  if (r.length) out.push({ type: 'de-escalation', unit: unit || null, wr, detail: r.join(', '), actor: 'user' });
  return out;
}

function fromLifecycleResult(result, { unitId, state, reason } = {}) {
  if (!result || result.success !== true) return null;
  return { type: 'lifecycle-set', unit: unitId || null, wr: null,
    detail: String(state || '') + (reason ? ' / ' + reason : ''), actor: 'user' };
}

function fromConfirmSend(item, result) {
  if (!item || !result || result.ok !== true) return null;
  // MOVE_UNIT confirm items carry equipmentId; approve-wr results carry unit.
  const unit = item.unitId || item.unit || item.equipmentId
    || (item.channel === 'approve-wr' ? result.unit : null) || null;
  switch (item.channel) {
    case 'slack': return { type: 'message-sent', unit, wr: null, detail: 'Slack to ' + (item.recipientName || ''), actor: 'user' };
    case 'email': return { type: 'email-sent', unit, wr: null, detail: 'email to ' + (item.to || ''), actor: 'user' };
    case 'lifecycle': return { type: 'lifecycle-set', unit, wr: null,
      detail: String(item.state || item.lifecycleState || '') + (item.reason ? ' / ' + item.reason : ''), actor: 'user' };
    case 'approve-wr': return { type: 'wr-created', unit, wr: (result.workRequestId || item.workRequestId) ? String(result.workRequestId || item.workRequestId) : null,
      detail: 'approved WR' + (item.vendor ? ' vendor ' + item.vendor : ''), actor: 'user' };
    default: return null;
  }
}

const TIMELINE_TYPES = { add: 'timeline-add', edit: 'timeline-edit', hide: 'timeline-hide', notes: 'notes-saved' };
function fromTimeline(kind, unitId, entry, actor) {
  const type = TIMELINE_TYPES[kind];
  if (!type) return null;
  return { type, unit: unitId || null, wr: null, detail: _detail(entry), actor: actor === 'user-via-orcha' ? actor : 'user' };
}

module.exports = {
  record, recent, resolveUnit,
  fromCreateWr, fromEscalationUpdate, fromLifecycleResult, fromConfirmSend, fromTimeline,
  REDACT_RE, TYPES, MAX_ACTIONS,
};
