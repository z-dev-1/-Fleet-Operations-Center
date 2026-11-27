'use strict';
/**
 * writes/write-gate.js — the single choke point for Relay (AAP) writes.
 *
 * Every Relay WR comment (addComment), every work-order commit
 * (createWorkOrder -> /createRepair), every gated WR escalation change
 * (updateEscalations -> aap_api.updateEscalations) and every gated unit
 * lifecycle change (setLifecycle -> scrapers/lifecycle_change.changeLifecycle)
 * goes through requestWrite(). With
 * settings.writes.requireApproval (default TRUE, no env override) nothing is
 * sent until the user explicitly approves the exact content:
 *
 *   - approvedBy set        an existing UI already showed the exact content and
 *                           the user confirmed (WR modal, reconcile overlay) -> send.
 *   - interactive + window  the renderer gets 'relayWrites:approval-request'
 *                           with the preview; approve -> send; cancel / no
 *                           answer within APPROVAL_WAIT_MS -> 'skipped-not-approved'.
 *   - otherwise             queued as 'pending-approval' (relayWritesPending);
 *                           nothing is sent until approve(id) from the list.
 *
 * dtnaComment (a DTNA Service Tracker case comment, src/dtna/writes.js) is
 * dealer-visible: it is in EXTERNAL_KINDS, so it ALWAYS waits for the user's
 * approval, even with requireApproval === false, and approvedBy is ignored.
 * dtnaStage (move a DTNA case to a LATER stage, src/dtna/writes.js
 * postApprovedStageChange) is dealer-visible too and in EXTERNAL_KINDS; a
 * same / earlier / unknown target stage is refused before anything is staged.
 * dtnaChatter (a post to the DTNA case Chatter feed, src/dtna/writes.js postApprovedChatter) is
 * dealer-visible and in EXTERNAL_KINDS too, gated exactly like dtnaComment.
 * decisivReply (a reply on a Decisiv case notes thread, src/writes/decisiv-reply.js
 * postApproved) goes to the dealer AND Amazon staff. It is in DECISIV_KINDS and
 * gets the same always-approve treatment as EXTERNAL_KINDS; the newest note id
 * is looked up at send time, after approval.
 *
 * The preview is built from the stored payload only, and approve(id) sends that
 * same stored payload once, so the text shown is the text sent.
 *
 * Logs: '[write] attempted|gated|approved|rejected|sent|send-failed kind= origin=
 * unit= id=' plus the text LENGTH only — never the text itself.
 */

const crypto = require('crypto');

const APPROVAL_WAIT_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 200;
const MEMORY_ONLY_BYTES = 2 * 1024 * 1024;
// AAP's own comment box (its cached web bundle) posts { id, comment:{...} } to
// /workOrder/addComment with id = the service's first workOrders[].id, and to
// /workRequest/addComment with id = the service id when the WR has no work order yet.
const WORK_ORDER_ADD_COMMENT_PATH = '/api/v1/workOrder/addComment';
const WORK_REQUEST_ADD_COMMENT_PATH = '/api/v1/workRequest/addComment';
const COMMENT_MAX = 2000;
// Who can see a Relay comment. Values match AAP's own work-order comments.
// CARRIER is only ever sent when the user picked 'vendor_carrier' in the composer.
const COMMENT_VISIBILITY = Object.freeze({
  internal:       Object.freeze({ label: 'Internal only',    internalOnly: true,  externalConsumers: Object.freeze([]) }),
  vendor:         Object.freeze({ label: 'Vendor',           internalOnly: false, externalConsumers: Object.freeze(['VENDOR']) }),
  vendor_carrier: Object.freeze({ label: 'Vendor + Carrier', internalOnly: false, externalConsumers: Object.freeze(['CARRIER', 'VENDOR']) }),
});
// A known visibility key, else the fallback. The fallback can never be carrier.
function commentVisibility(v, fallback) {
  if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(COMMENT_VISIBILITY, v)) return v;
  return fallback === 'internal' ? 'internal' : 'vendor';
}
// The AAP comment fields for a visibility key (fresh array per call).
function commentVisibilityFields(v) {
  const c = COMMENT_VISIBILITY[commentVisibility(v, 'internal')];
  return { internalOnly: c.internalOnly, externalConsumers: c.externalConsumers.slice() };
}
const SERVICE_URL = 'https://aap-na.corp.amazon.com/v2/service/';
const STORE_KEY = 'relayWritesPending';
const KINDS = ['addComment', 'createWorkOrder', 'updateEscalations', 'setLifecycle', 'dtnaComment', 'dtnaStage', 'dtnaChatter', 'decisivReply'];
// Dealer-visible writes outside Relay: ALWAYS approved by the user on the exact content.
// settings.writes.requireApproval === false and approvedBy never bypass these.
const EXTERNAL_KINDS = new Set(['dtnaComment', 'dtnaStage', 'dtnaChatter']);
// Decisiv writes (dealer + Amazon staff visible): same always-approve rule.
const DECISIV_KINDS = new Set(['decisivReply']);
function _isExternal(kind) { return EXTERNAL_KINDS.has(kind) || DECISIV_KINDS.has(kind); }
const DECISIV_RECIPIENTS_MAX = 50;
const DTNA_CASE_URL = 'https://dtna.my.site.com/Servicetracker/s/case/';

let _deps = {};
let _windowGetter = null;
const _memPayloads = new Map();   // id -> payload for items too big to persist
const _waiters = new Map();       // id -> { resolve, timer }
const _tokens = new WeakSet();    // live approval tokens for _commitApprovedWorkOrder

let _logger = null;
function _log(msg) {
  if (typeof _deps.log === 'function') { try { _deps.log(msg); } catch (_) {} return; }
  try {
    if (!_logger) _logger = require('../utils/logger')('write-gate');
    _logger.info(msg);
  } catch (_) {}
}
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _store() { return _deps.store || require('../store'); }
function _flags() {
  if (_deps.flags) return typeof _deps.flags === 'function' ? _deps.flags() : _deps.flags;
  return require('../config/perf-flags').loadWrites();
}
function _api() { return require('../scrapers/aap_api'); }
function _window() {
  try {
    const w = _windowGetter ? _windowGetter() : null;
    return (w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()) && w.webContents) ? w : null;
  } catch (_) { return null; }
}
function _notify(channel, data) {
  if (typeof _deps.notify === 'function') { try { _deps.notify(channel, data); } catch (_) {} return; }
  const w = _window();
  if (w) { try { w.webContents.send(channel, data); } catch (_) {} }
}

// ── store ───────────────────────────────────────────────────────────────────
function _load() {
  try {
    const p = _store().load(STORE_KEY, null);
    return (p && Array.isArray(p.items)) ? p : { items: [] };
  } catch (_) { return { items: [] }; }
}
function _save(p) {
  try { _store().save(STORE_KEY, p); } catch (e) { _log('[write] store save failed: ' + (e && e.message)); }
}
function _cap(items) {
  while (items.length > MAX_ITEMS) {
    // Drop the oldest finished item first; only drop a pending one if all are pending.
    let idx = -1;
    for (let i = items.length - 1; i >= 0; i--) { if (items[i].state !== 'pending') { idx = i; break; } }
    const gone = items.splice(idx === -1 ? items.length - 1 : idx, 1)[0];
    if (gone) _memPayloads.delete(gone.id);
  }
  return items;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function _str(v) { return v == null ? '' : String(v); }
function _textLen(kind, payload) {
  if (!payload) return 0;
  if (kind === 'updateEscalations') return _str(payload.comment).length;
  if (kind === 'setLifecycle' || kind === 'dtnaStage') return 0;
  if (kind === 'decisivReply') return _str(payload.text).length;
  return (kind === 'addComment' || kind === 'dtnaComment' || kind === 'dtnaChatter') ? _str(payload.text).length : _str(payload.comments).trim().length;
}
function _target(kind, payload, spec) {
  if (kind === 'addComment' || kind === 'updateEscalations') return _str(payload.workRequestId);
  if (kind === 'setLifecycle') return _str(payload.aaid || payload.assetUrl || payload.equipmentId);
  if (kind === 'dtnaComment' || kind === 'dtnaStage' || kind === 'dtnaChatter') return _str(payload.caseId);
  if (kind === 'decisivReply') return _str(payload.caseId);
  return _str(payload.aaid || payload.assetUrl || spec.unit);
}
// Dedup key for a work-order write: the fields that define WHAT is requested.
// Live context resolved per call (locationLatest, the reverse-geocoded GPS
// address, gate/caller flags) is left out, so a re-run of the same request
// reuses the pending item instead of queuing a second WR.
const WO_HASH_FIELDS = ['aaid', 'title', 'issue', 'vendor', 'vendorCode', 'supplierId', 'areaPairs',
  'comments', 'shareWith', 'urgent', 'urgencyReason', 'arcClaim', 'simNumber', 'towDirection',
  'towToStreet', 'towToCity', 'towToState', 'towToZip', 'copiedFromWorkRequestId'];
function _hashSubject(kind, payload) {
  if (kind !== 'createWorkOrder' || !payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const k of WO_HASH_FIELDS) out[k] = payload[k] == null ? null : payload[k];
  out.attachments = (Array.isArray(payload.attachments) ? payload.attachments : [])
    .map((a, i) => (a && typeof a === 'object' && a.name) ? _str(a.name) : ('attachment-' + (i + 1)));
  return out;
}
function _hash(kind, target, payload) {
  let json = '';
  try { json = JSON.stringify(_hashSubject(kind, payload)); } catch (_) { json = String(_now()); }
  return crypto.createHash('sha256').update(kind + '\n' + target + '\n' + json).digest('hex');
}
function _newId() {
  return 'rw_' + _now().toString(36) + crypto.randomBytes(3).toString('hex');
}
function _logLine(event, f, extra) {
  _log('[write] ' + event + ' kind=' + f.kind + ' origin=' + (f.origin || 'unknown') +
    ' unit=' + (f.unit || '-') + ' id=' + (f.id || '-') + (extra ? ' ' + extra : ''));
}

// Normalize the payload so what is stored (and previewed) is exactly what is sent.
function _normalizePayload(kind, payload) {
  const p = (payload && typeof payload === 'object') ? payload : {};
  if (kind === 'addComment') {
    const out = { workRequestId: _str(p.workRequestId), text: _str(p.text).slice(0, COMMENT_MAX) };
    // No visibility = a caller that never chose one (reconcile, vendor SR notes, items
    // staged before the composer had the control): internal only, as before. A present
    // but unknown value falls back to Vendor, never Carrier. Internal is left out of the
    // stored payload so those callers' pending items keep their shape and dedup hash.
    const vis = p.visibility == null || p.visibility === '' ? 'internal' : commentVisibility(p.visibility, 'vendor');
    if (vis !== 'internal') out.visibility = vis;
    return out;
  }
  if (kind === 'updateEscalations') {
    const strs = (v) => (Array.isArray(v) ? v : []).map(_str);
    return {
      workRequestId: _str(p.workRequestId),
      aaid: _str(p.aaid),
      add: strs(p.add),
      remove: strs(p.remove),
      comment: _str(p.comment).slice(0, COMMENT_MAX),
      createdBy: _str(p.createdBy),
    };
  }
  if (kind === 'dtnaComment') {
    return {
      caseId: _str(p.caseId),
      repairOrderId: _str(p.repairOrderId),
      repairOrderNo: _str(p.repairOrderNo),
      text: _str(p.text).slice(0, COMMENT_MAX),
    };
  }
  if (kind === 'dtnaChatter') {
    return {
      caseId: _str(p.caseId),
      repairOrderNo: _str(p.repairOrderNo),
      text: _str(p.text).slice(0, COMMENT_MAX),
    };
  }
  if (kind === 'dtnaStage') {
    return {
      caseId: _str(p.caseId),
      fromStage: _str(p.fromStage),
      toStage: _str(p.toStage),
      repairOrderNo: _str(p.repairOrderNo),
    };
  }
  if (kind === 'decisivReply') {
    const seen = new Set();
    const recipients = [];
    for (const r of (Array.isArray(p.recipients) ? p.recipients : [])) {
      const id = _str(r && r.id).trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      recipients.push({ id, name: _str(r && r.name).trim().slice(0, 120) });
      if (recipients.length >= DECISIV_RECIPIENTS_MAX) break;
    }
    return {
      unitId: _str(p.unitId),
      caseId: _str(p.caseId),
      estimateId: _str(p.estimateId),
      srUrl: _str(p.srUrl),
      text: _str(p.text).slice(0, COMMENT_MAX),
      recipients,
    };
  }
  if (kind === 'setLifecycle') {
    return {
      equipmentId: _str(p.equipmentId),
      assetUrl: _str(p.assetUrl),
      state: _str(p.state),
      reason: _str(p.reason),
      fromState: _str(p.fromState),
    };
  }
  return p;
}

// aiDrafted is tri-state: true / false when the caller knows, null = unknown.
function _aiTri(v) { return typeof v === 'boolean' ? v : null; }
function _aiLabel(v) { return v === true ? 'yes' : (v === false ? 'no' : 'unknown'); }
// ── preview (deterministic, from the stored payload only) ───────────────────
function previewOf(kind, payload, meta) {
  const m = meta || {};
  const p = payload || {};
  const lines = [];
  if (kind === 'addComment') {
    const wr = _str(p.workRequestId);
    const vis = commentVisibility(p.visibility, 'internal');
    lines.push('Relay write: add ' + (vis === 'internal' ? 'internal ' : '') + 'comment to a work request');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('Relay WR: ' + wr + '  ' + SERVICE_URL + wr);
    lines.push('Visible to: ' + COMMENT_VISIBILITY[vis].label);
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Text (exact, ' + _str(p.text).length + ' chars):');
    lines.push(_str(p.text));
    return lines.join('\n');
  }
  if (kind === 'updateEscalations') {
    const wr = _str(p.workRequestId);
    const add = Array.isArray(p.add) ? p.add.map(_str) : [];
    const remove = Array.isArray(p.remove) ? p.remove.map(_str) : [];
    lines.push(add.length ? 'Relay write: escalate work request' : 'Relay write: remove escalation');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('Relay WR: ' + wr + '  ' + SERVICE_URL + wr);
    lines.push('Add: ' + (add.length ? add.join(', ') : '(none)'));
    lines.push('Remove: ' + (remove.length ? remove.join(', ') : '(none)'));
    lines.push('Visibility: internal-only');
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Comment text (exact, ' + _str(p.comment).length + ' chars):');
    lines.push(_str(p.comment));
    return lines.join('\n');
  }
  if (kind === 'dtnaComment') {
    const cid = _str(p.caseId);
    lines.push('DTNA write: post comment to Service Tracker case');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('DTNA case: ' + cid + '  ' + DTNA_CASE_URL + cid + '/detail');
    lines.push('Channel: Case Comment');
    lines.push('Repair order: ' + (_str(p.repairOrderNo) || '(none)'));
    lines.push('Comment type: (none)');
    lines.push('Visibility: VISIBLE TO THE DEALER (DTNA)');
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Text (exact, ' + _str(p.text).length + ' chars):');
    lines.push(_str(p.text));
    return lines.join('\n');
  }
  if (kind === 'dtnaChatter') {
    const cid = _str(p.caseId);
    lines.push('DTNA write: post to the case Chatter feed');
    lines.push('Channel: Chatter (case feed)');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('DTNA case: ' + cid + '  ' + DTNA_CASE_URL + cid + '/detail');
    lines.push('Repair order: ' + (_str(p.repairOrderNo) || '(none)'));
    lines.push('Visibility: VISIBLE TO THE DEALER (DTNA)');
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Text (exact, ' + _str(p.text).length + ' chars):');
    lines.push(_str(p.text));
    return lines.join('\n');
  }
  if (kind === 'dtnaStage') {
    const cid = _str(p.caseId);
    lines.push('CHANGE DTNA CASE STAGE: ' + _str(p.fromStage) + ' -> ' + _str(p.toStage));
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('DTNA case: ' + cid + '  ' + DTNA_CASE_URL + cid + '/detail');
    lines.push('Repair order: ' + (_str(p.repairOrderNo) || '(none)'));
    lines.push('Visibility: VISIBLE TO THE DEALER (DTNA)');
    lines.push('Origin: ' + (m.origin || 'unknown'));
    return lines.join('\n');
  }
  if (kind === 'decisivReply') {
    const rs = Array.isArray(p.recipients) ? p.recipients : [];
    lines.push('Decisiv write: reply on the case notes thread');
    lines.push('Unit: ' + (m.unit || _str(p.unitId) || '-'));
    lines.push('Decisiv case: ' + _str(p.caseId) + ' (estimate ' + _str(p.estimateId) + ')  ' + _str(p.srUrl));
    lines.push('Replies to: the newest note on the estimate, looked up when you approve');
    lines.push('Visibility: VISIBLE TO THE DEALER AND AMAZON STAFF (Decisiv, public)');
    lines.push('Recipients (' + rs.length + '):');
    for (const r of rs) lines.push('  - ' + (_str(r && r.name) || _str(r && r.id)));
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Text (exact, ' + _str(p.text).length + ' chars):');
    lines.push(_str(p.text));
    return lines.join('\n');
  }
  if (kind === 'setLifecycle') {
    lines.push('AAP write: change unit lifecycle');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('Change: ' + (_str(p.fromState) || '?') + ' \u2192 ' + _str(p.state));
    lines.push('Reason: ' + (_str(p.reason) || '(none)'));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    return lines.join('\n');
  }
  const vendorDisplay = _str(p.vendor).trim() || '(none)';
  let location;
  if (p.offSite) {
    const addr = [p.locStreet, p.locCity, p.locState, p.locZip].map(_str).map((s) => s.trim()).filter(Boolean).join(', ');
    location = 'Off-site: ' + (addr || '(no address)') + (p.locFromGps ? ' (from GPS)' : '');
  } else {
    location = 'Yard (domicile ' + (_str(p.domicile).trim() || '-') + ')';
  }
  const towTo = [p.towToStreet, p.towToCity, p.towToState, p.towToZip].map(_str).map((s) => s.trim()).filter(Boolean).join(', ');
  const items = (Array.isArray(p.areaPairs) ? p.areaPairs : [])
    .filter((x) => x && (x.area || x.subcategory))
    .map((x) => {
      const { levelText } = require('../scrapers/avm-text');
      const sub = { level1: x.area, isSub: true };
      return [levelText(x.area), levelText(x.subcategory, sub), levelText(x.subSubcategory, sub)].filter(Boolean).join(' / ');
    });
  const urgent = _str(p.urgent).toLowerCase() === 'yes';
  const comment = _str(p.comments).trim();
  const atts = Array.isArray(p.attachments) ? p.attachments : [];
  const attNames = atts.map((a, i) => (a && typeof a === 'object' && a.name) ? _str(a.name) : ('attachment-' + (i + 1)));
  lines.push('Relay write: create work request');
  lines.push('Unit: ' + (m.unit || '-'));
  lines.push('Title: ' + _str(p.title).slice(0, 90));
  lines.push('Vendor: ' + vendorDisplay + ' -> ' + (_str(p.vendorCode) || '(unresolved)'));
  lines.push('Location: ' + location);
  lines.push('Tow destination: ' + (towTo ? towTo + (p.towDirection ? ' (' + p.towDirection + ')' : '') : '(none)'));
  lines.push('Repair items (L1 / L2 / L3): ' + (items.length ? items.join('; ') : '(none)'));
  lines.push('Urgent: ' + (urgent ? 'yes (' + (_str(p.urgencyReason) || 'no reason given') + ')' : 'no'));
  lines.push('Comment visibility: ' + (comment ? (_str(p.shareWith).toLowerCase() === 'internal' ? 'internal-only' : 'shared') : '-'));
  lines.push('Contact: ' + ([_str(p.contactName).trim(), _str(p.contactPhone).trim()].filter(Boolean).join(', ') || '(none)'));
  lines.push('Attachments: ' + atts.length + (atts.length ? ' (' + attNames.join(', ') + ')' : ''));
  lines.push('Linked WR: ' + (_str(p.copiedFromWorkRequestId) || '(none)'));
  // Same values aap_api._buildWoBody / _buildCreateRepairBody send.
  const vendorCode = _str(p.vendorCode);
  lines.push('Supplier: ' + ((vendorCode && vendorCode !== 'UNASSIGNED' && p.supplierId)
    ? _str(p.supplierId) : '(the Relay vendor recommendation\'s supplier, if any)'));
  lines.push('ARC claim: ' + (_str(p.arcClaim) || '(none)'));
  lines.push('SIM number: ' + (_str(p.simNumber) || '(none)'));
  lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
  lines.push('Origin: ' + (m.origin || 'unknown'));
  const description = _str(p.issue).trim() || _str(p.title).trim() || 'Repair requested via Fleet Ops Center';
  lines.push('Description (exact, ' + description.length + ' chars):');
  lines.push(description);
  if (comment) {
    const author = _str(p.createdBy || p.contactName || p.operatorAlias || 'Fleet Ops Center').trim() || 'Fleet Ops Center';
    lines.push('Comment author: ' + author);
  }
  lines.push('Comment text (exact, ' + comment.length + ' chars):');
  lines.push(comment || '(none)');
  return lines.join('\n');
}

// ── addComment request (resolved at send time, after approval) ──────────────
function _json(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}
// Reads only: the service aggregate (which work order to comment on) and the
// signed-in AAP user (createdBy). The stored payload and preview are unchanged.
// internalOnly / externalConsumers come from the stored (previewed) visibility.
async function _buildAddCommentRequest(payload) {
  const wr = _str(payload.workRequestId);
  if (!wr) throw new Error('addComment: no workRequestId');
  const getService = _deps.getService || ((id) => _api().getService(id));
  const getUser = _deps.getUserDetails || (() => _api().getUserDetails());
  const svc = _json(await getService(wr)) || {};
  const u = _json(await getUser()) || {};
  // Same lookup as aap_api._userAlias (the escalation write's createdBy).
  const alias = u.userName || u.alias || u.login;
  const createdBy = typeof alias === 'string' ? alias.trim() : '';
  if (!createdBy) throw new Error('Could not resolve the AAP user alias; nothing was sent');
  const wos = (Array.isArray(svc.workOrders) ? svc.workOrders : []).filter((w) => w && w.id);
  const comment = {
    timestamp: new Date(_now()).toISOString(),
    text: _str(payload.text).slice(0, COMMENT_MAX),
    createdBy,
    ...commentVisibilityFields(payload.visibility),
  };
  if (wos.length) return { path: WORK_ORDER_ADD_COMMENT_PATH, body: { id: _str(wos[0].id), comment } };
  return { path: WORK_REQUEST_ADD_COMMENT_PATH, body: { id: _str(svc.id) || wr, comment } };
}

// ── decisivReply request (resolved at send time, after approval) ────────────
// Read only: the estimate's activity_logs feed, for the newest note id (rule in
// src/writes/decisiv-reply.js pickLatestNote). The stored payload is unchanged.
async function _buildDecisivReplyRequest(payload) {
  const dr = require('./decisiv-reply');
  const latest = _deps.decisivLatestNote || ((p) => dr.latestNoteId(p));
  const r = await latest({ estimateId: payload.estimateId, srUrl: payload.srUrl });
  if (!r || !r.ok) throw Object.assign(new Error('no note to reply to'), { code: _str((r && r.code) || 'DECISIV_NO_NOTE') });
  const { path, body } = dr.buildReplyRequest(payload, r.noteId);
  return { path, body, noteId: _str(r.noteId) };
}
function _decisivCode(c) {
  const s = _str(c).replace(/[^A-Z0-9_]/g, '').slice(0, 40);
  return /^DECISIV_/.test(s) ? s : 'DECISIV_INTERNAL';
}

// ── send (the only network path) ────────────────────────────────────────────
async function _send(f, payload) {
  try {
    if (f.kind === 'decisivReply') {
      let req;
      try { req = await _buildDecisivReplyRequest(payload); } catch (e) {
        const code = _decisivCode(e && e.code);
        _logLine('send-failed', f, 'error=' + code);
        return { ok: false, outcome: 'send-failed', id: f.id, result: null, error: code };
      }
      // Single-use token: src/writes/decisiv-reply.js postApproved refuses a write without it.
      const token = {};
      _tokens.add(token);
      let r;
      try {
        const post = _deps.decisivPost || ((u, p, b, t) => require('./decisiv-reply').postApproved(u, p, b, t));
        r = await post(payload.srUrl, req.path, req.body, token);
      } finally {
        _tokens.delete(token);
      }
      if (r && r.ok) {
        const n = r.json && Array.isArray(r.json.notes) && r.json.notes[0] ? r.json.notes[0] : null;
        _logLine('sent', f, 'len=' + _textLen(f.kind, payload) + ' recipients=' + req.body.note.recipients.length + ' target=decisiv');
        return { ok: true, outcome: 'sent', id: f.id, result: { noteId: req.noteId, replyNoteId: n && n.id != null ? _str(n.id) : '' } };
      }
      const code = _decisivCode(r && r.code);
      _logLine('send-failed', f, 'error=' + code);
      return { ok: false, outcome: 'send-failed', id: f.id, result: null, error: code };
    }
    if (f.kind === 'addComment') {
      const { path, body } = await _buildAddCommentRequest(payload);
      const post = _deps.apiPost || ((p, b) => _api().apiPost(p, b));
      const result = await post(path, body);
      _logLine('sent', f, 'len=' + body.comment.text.length + ' target=' + (path === WORK_ORDER_ADD_COMMENT_PATH ? 'workOrder' : 'workRequest'));
      return { ok: true, outcome: 'sent', id: f.id, result: result == null ? null : result };
    }
    if (f.kind === 'updateEscalations') {
      const fn = _deps.updateEscalations || ((p) => _api().updateEscalations(p));
      const r = await fn(payload);
      if (r && r.ok) {
        _logLine('sent', f, 'len=' + _textLen(f.kind, payload));
        return { ok: true, outcome: 'sent', id: f.id, result: r };
      }
      const err = (r && r.error) || 'escalation not updated';
      _logLine('send-failed', f, 'error=' + _str(err).slice(0, 120));
      return { ok: false, outcome: 'send-failed', id: f.id, result: r || null, error: err };
    }
    if (f.kind === 'setLifecycle') {
      const fn = _deps.setLifecycle || ((p) => require('../scrapers/lifecycle_change').changeLifecycle(p));
      const r = await fn(payload);
      if (r && r.success === true) {
        _logLine('sent', f, 'len=0');
        return { ok: true, outcome: 'sent', id: f.id, result: r };
      }
      const err = (r && r.message) || 'lifecycle not changed';
      _logLine('send-failed', f, 'error=' + _str(err).slice(0, 120));
      return { ok: false, outcome: 'send-failed', id: f.id, result: r || null, error: err };
    }
    if (f.kind === 'dtnaComment') {
      // Single-use token: src/dtna/aura.js callWrite refuses a write without it.
      const token = {};
      _tokens.add(token);
      let r;
      try {
        const post = _deps.dtnaPostComment || ((p, t) => require('../dtna/writes').postApprovedComment(p, t));
        r = await post(payload, token);
      } finally {
        _tokens.delete(token);
      }
      if (r && r.ok) {
        _logLine('sent', f, 'len=' + _textLen(f.kind, payload));
        return { ok: true, outcome: 'sent', id: f.id, result: { commentId: _str(r.commentId) } };
      }
      const code = _str((r && r.code) || 'DTNA_INTERNAL').replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'DTNA_INTERNAL';
      _logLine('send-failed', f, 'error=' + code);
      return { ok: false, outcome: 'send-failed', id: f.id, result: null, error: code };
    }
    if (f.kind === 'dtnaChatter') {
      // Single-use token: src/dtna/aura.js callChatterWrite refuses a write without it.
      const token = {};
      _tokens.add(token);
      let r;
      try {
        const post = _deps.dtnaPostChatter || ((p, t) => require('../dtna/writes').postApprovedChatter(p, t));
        r = await post(payload, token);
      } finally {
        _tokens.delete(token);
      }
      if (r && r.ok) {
        _logLine('sent', f, 'len=' + _textLen(f.kind, payload));
        return { ok: true, outcome: 'sent', id: f.id, result: { feedItemId: _str(r.feedItemId) } };
      }
      const code = _str((r && r.code) || 'DTNA_INTERNAL').replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'DTNA_INTERNAL';
      _logLine('send-failed', f, 'error=' + code);
      return { ok: false, outcome: 'send-failed', id: f.id, result: null, error: code };
    }
    if (f.kind === 'dtnaStage') {
      // Single-use token: src/dtna/aura.js callWrite refuses a write without it.
      const token = {};
      _tokens.add(token);
      let r;
      try {
        const change = _deps.dtnaChangeStage || ((p, t) => require('../dtna/writes').postApprovedStageChange(p, t));
        r = await change(payload, token);
      } finally {
        _tokens.delete(token);
      }
      if (r && r.ok) {
        _logLine('sent', f, 'len=0');
        return { ok: true, outcome: 'sent', id: f.id, result: { toStage: _str(r.toStage) } };
      }
      const code = _str((r && r.code) || 'DTNA_INTERNAL').replace(/[^A-Z0-9_]/g, '').slice(0, 40) || 'DTNA_INTERNAL';
      _logLine('send-failed', f, 'error=' + code);
      return { ok: false, outcome: 'send-failed', id: f.id, result: null, error: code };
    }
    const token = {};
    _tokens.add(token);
    const commit = _deps.commitWorkOrder || ((o, t) => _api()._commitApprovedWorkOrder(o, t));
    const result = await commit(payload, token);
    _tokens.delete(token);
    if (result && result.ok) {
      _logLine('sent', f, 'len=' + _textLen(f.kind, payload));
      return { ok: true, outcome: 'sent', id: f.id, result };
    }
    const err = (result && result.error) || 'work order not created';
    _logLine('send-failed', f, 'error=' + _str(err).slice(0, 120));
    return { ok: false, outcome: 'send-failed', id: f.id, result: result || null, error: err };
  } catch (e) {
    // A DTNA failure never carries an error message (it could echo request or response content).
    const err = EXTERNAL_KINDS.has(f.kind) ? 'DTNA_INTERNAL'
      : (DECISIV_KINDS.has(f.kind) ? 'DECISIV_INTERNAL' : ((e && e.message) || String(e)));
    _logLine('send-failed', f, 'error=' + _str(err).slice(0, 120));
    return { ok: false, outcome: 'send-failed', id: f.id, error: err };
  }
}

// Where a write goes, for the "nothing was sent to …" messages.
function _dest(kind) { return EXTERNAL_KINDS.has(kind) ? 'DTNA' : (DECISIV_KINDS.has(kind) ? 'Decisiv' : 'Relay'); }

function isApprovalToken(token) {
  if (!token || typeof token !== 'object' || !_tokens.has(token)) return false;
  _tokens.delete(token);   // single use
  return true;
}

// ── pending items ───────────────────────────────────────────────────────────
function _publicItem(it) {
  const out = Object.assign({}, it);
  delete out.payload;
  delete out.hash;
  return out;
}
function _expireOld(p) {
  let changed = false;
  for (const it of p.items) {
    if (it.state === 'pending' && !_waiters.has(it.id) && (_now() - Date.parse(it.createdAt)) > PENDING_TTL_MS) {
      it.state = 'expired';
      it.expiredAt = new Date(_now()).toISOString();
      _memPayloads.delete(it.id);
      changed = true;
    }
  }
  return changed;
}

function _stageItem(f, payload) {
  const p = _load();
  _expireOld(p);
  const existing = p.items.find((it) => it.state === 'pending' && it.hash === f.hash);
  if (existing) {
    if (existing.memoryOnly) _memPayloads.set(existing.id, payload);
    _save(p);
    return { item: existing, reused: true };
  }
  let json = '';
  try { json = JSON.stringify(payload); } catch (_) { json = ''; }
  const memoryOnly = Buffer.byteLength(json, 'utf8') > MEMORY_ONLY_BYTES;
  const item = {
    id: f.id,
    kind: f.kind,
    origin: f.origin || 'unknown',
    unit: f.unit || '',
    workRequestId: f.workRequestId || '',
    aiDrafted: _aiTri(f.aiDrafted),
    ref: (f.ref && typeof f.ref === 'object') ? f.ref : null,
    preview: previewOf(f.kind, payload, f),
    hash: f.hash,
    createdAt: new Date(_now()).toISOString(),
    state: 'pending',
    payload: memoryOnly ? null : payload,
  };
  if (memoryOnly) { item.memoryOnly = true; _memPayloads.set(item.id, payload); }
  p.items.unshift(item);
  _cap(p.items);
  _save(p);
  return { item, reused: false };
}

function _setState(id, state, extra) {
  const p = _load();
  const it = p.items.find((x) => x.id === id);
  if (!it) return null;
  it.state = state;
  it[state + 'At'] = new Date(_now()).toISOString();
  if (extra) Object.assign(it, extra);
  if (state !== 'pending') _memPayloads.delete(id);
  _save(p);
  _notify('relayWrites:updated', { items: p.items.map(_publicItem) });
  return it;
}

// Send a pending item's stored payload exactly once.
async function _sendPending(id, by) {
  const p = _load();
  const it = p.items.find((x) => x.id === id);
  if (!it) return { ok: false, outcome: 'skipped-not-approved', id, error: 'write not found' };
  if (it.state !== 'pending') return { ok: false, outcome: 'skipped-not-approved', id, error: 'write already ' + it.state };
  if ((_now() - Date.parse(it.createdAt)) > PENDING_TTL_MS) {
    _setState(id, 'expired');
    return { ok: false, outcome: 'skipped-not-approved', id, error: 'write expired (pending over 24 h); nothing was sent' };
  }
  const payload = it.memoryOnly ? _memPayloads.get(id) : it.payload;
  if (!payload) {
    _setState(id, 'expired');
    return { ok: false, outcome: 'skipped-not-approved', id, error: 'write payload no longer available (app restarted); nothing was sent' };
  }
  // Claim the item before the network call so a second approve is refused.
  it.state = 'sending';
  _save(p);
  const f = { kind: it.kind, origin: it.origin, unit: it.unit, id: it.id };
  _logLine('approved', f, 'by=' + (by || 'user'));
  const r = await _send(f, payload);
  const sentWr = r.ok && r.result && typeof r.result === 'object' && r.result.workRequestId ? _str(r.result.workRequestId) : '';
  const done = _setState(id, r.ok ? 'sent' : 'failed', r.ok
    ? Object.assign({ approvedBy: by || 'user' }, sentWr ? { sentWorkRequestId: sentWr } : {})
    : { approvedBy: by || 'user', error: _str(r.error).slice(0, 300) });
  if (r.ok && done) _fireSent(done, r);
  return r;
}

// Callers whose writes can be queued (daily tasks, relay-step) register here
// to be told when a queued item they created is approved and sent.
const _sentHandlers = new Map();   // origin -> fn(item, result)
function onSent(origin, fn) {
  if (!origin) return;
  if (typeof fn === 'function') _sentHandlers.set(String(origin), fn); else _sentHandlers.delete(String(origin));
}
function _fireSent(item, r) {
  const fn = _sentHandlers.get(_str(item.origin));
  if (!fn) return;
  try {
    const out = fn(_publicItem(item), r);
    if (out && typeof out.catch === 'function') out.catch((e) => _log('[write] sent handler failed origin=' + item.origin + ': ' + (e && e.message)));
  } catch (e) { _log('[write] sent handler failed origin=' + item.origin + ': ' + (e && e.message)); }
}
// ── public API ──────────────────────────────────────────────────────────────
async function requestWrite(spec) {
  const s = spec || {};
  const kind = s.kind;
  if (!KINDS.includes(kind)) return { ok: false, outcome: 'skipped-not-approved', id: null, error: 'unknown write kind' };
  const payload = _normalizePayload(kind, s.payload);
  if (kind === 'dtnaStage') {
    // Forward only: refuse a same / earlier / unknown stage before anything is staged or prompted.
    const DC = require('../dtna/constants');
    if (!DC.CASE_ID_RE.test(payload.caseId) || !DC.isForwardStage(payload.fromStage, payload.toStage)) {
      return { ok: false, outcome: 'skipped-not-approved', id: null, error: 'DTNA_STAGE_NOT_FORWARD' };
    }
  }
  const f = {
    kind,
    origin: _str(s.origin) || 'unknown',
    unit: _str(s.unit),
    workRequestId: _str(s.workRequestId || (kind === 'addComment' ? payload.workRequestId : '')),
    aiDrafted: _aiTri(s.aiDrafted),
    ref: (s.ref && typeof s.ref === 'object') ? s.ref : null,
    id: _newId(),
  };
  f.hash = _hash(kind, _target(kind, payload, s), payload);
  _logLine('attempted', f, 'len=' + _textLen(kind, payload));

  let flags;
  try { flags = _flags() || {}; } catch (_) { flags = {}; }
  const external = _isExternal(kind);
  if (flags.requireApproval === false && !external) {
    _logLine('approved', f, 'by=setting-requireApproval-false');
    return _send(f, payload);
  }
  if (s.approvedBy && !external) {
    _logLine('approved', f, 'by=' + _str(s.approvedBy).slice(0, 60));
    return _send(f, payload);
  }
  if (s.approvedBy) _logLine('approvedBy-ignored', f, 'reason=dealer-visible');

  const win = s.interactive ? _window() : null;
  const staged = _stageItem(f, payload);
  f.id = staged.item.id;

  if (!win) {
    _logLine('gated', f, 'status=pending-approval' + (staged.reused ? ' reused=1' : ''));
    _notify('relayWrites:updated', { items: _load().items.map(_publicItem) });
    return { ok: false, outcome: 'pending-approval', id: f.id, error: 'pending-approval: queued for your approval; nothing was sent to ' + _dest(kind) };
  }

  _logLine('gated', f, 'status=awaiting-user');
  let answer;
  if (_waiters.has(f.id)) {
    answer = await _waiters.get(f.id).promise;
  } else {
    const w = {};
    w.promise = new Promise((resolve) => {
      w.resolve = resolve;
      w.timer = setTimeout(() => resolve(false), APPROVAL_WAIT_MS);
    });
    _waiters.set(f.id, w);
    try {
      win.webContents.send('relayWrites:approval-request', { id: f.id, kind, preview: staged.item.preview, aiDrafted: f.aiDrafted });
    } catch (_) { w.resolve(false); }
    answer = await w.promise;
    clearTimeout(w.timer);
    _waiters.delete(f.id);
  }
  if (answer && typeof answer === 'object' && answer.result) return answer.result;
  if (answer === true) return _sendPending(f.id, 'user-prompt');
  _setState(f.id, 'not-approved');
  _logLine('rejected', f, 'reason=cancel-or-timeout');
  return { ok: false, outcome: 'skipped-not-approved', id: f.id, error: 'Not approved; nothing was sent to ' + _dest(kind) };
}

async function approve(id, by) {
  const w = _waiters.get(id);
  const r = await _sendPending(id, by || 'relay-writes-list');
  if (w) w.resolve({ result: r });
  return r;
}

function reject(id) {
  const p = _load();
  const it = p.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: 'write not found' };
  if (it.state !== 'pending') return { ok: false, error: 'write already ' + it.state };
  _setState(id, 'rejected');
  _logLine('rejected', { kind: it.kind, origin: it.origin, unit: it.unit, id }, 'reason=user');
  const w = _waiters.get(id);
  if (w) w.resolve({ result: { ok: false, outcome: 'skipped-not-approved', id, error: 'Rejected; nothing was sent to ' + _dest(it.kind) } });
  return { ok: true };
}

function respond(id, approved) {
  const w = _waiters.get(id);
  if (!w) return { ok: false, error: 'no approval request is waiting for ' + id };
  w.resolve(approved === true);
  return { ok: true };
}

function list() {
  const p = _load();
  if (_expireOld(p)) _save(p);
  return { items: p.items.map(_publicItem) };
}

function setWindowGetter(fn) { _windowGetter = typeof fn === 'function' ? fn : null; }

function _setDepsForTest(d) {
  _deps = d || {};
  for (const w of _waiters.values()) { clearTimeout(w.timer); }
  _waiters.clear();
  _memPayloads.clear();
}

module.exports = {
  requestWrite,
  previewOf,
  approve,
  reject,
  respond,
  list,
  onSent,
  setWindowGetter,
  isApprovalToken,
  EXTERNAL_KINDS,
  DECISIV_KINDS,
  APPROVAL_WAIT_MS,
  PENDING_TTL_MS,
  COMMENT_MAX,
  COMMENT_VISIBILITY,
  commentVisibility,
  commentVisibilityFields,
  _setDepsForTest,
};
