'use strict';
/**
 * writes/write-gate.js — the single choke point for Relay (AAP) writes.
 *
 * Every Relay WR comment (addComment) and every work-order commit
 * (createWorkOrder -> /createRepair) goes through requestWrite(). With
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
const ADD_COMMENT_PATH = '/api/v1/addComment';
const COMMENT_MAX = 2000;
const SERVICE_URL = 'https://aap-na.corp.amazon.com/v2/service/';
const STORE_KEY = 'relayWritesPending';
const KINDS = ['addComment', 'createWorkOrder'];

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
  return kind === 'addComment' ? _str(payload.text).length : _str(payload.comments).trim().length;
}
function _target(kind, payload, spec) {
  if (kind === 'addComment') return _str(payload.workRequestId);
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
    return { workRequestId: _str(p.workRequestId), text: _str(p.text).slice(0, COMMENT_MAX) };
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
    lines.push('Relay write: add internal comment to a work request');
    lines.push('Unit: ' + (m.unit || '-'));
    lines.push('Relay WR: ' + wr + '  ' + SERVICE_URL + wr);
    lines.push('Visibility: internal-only');
    lines.push('AI-drafted: ' + _aiLabel(m.aiDrafted));
    lines.push('Origin: ' + (m.origin || 'unknown'));
    lines.push('Text (exact, ' + _str(p.text).length + ' chars):');
    lines.push(_str(p.text));
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
    .map((x) => [x.area, x.subcategory, x.subSubcategory].map(_str).filter(Boolean).join(' / '));
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

// ── send (the only network path) ────────────────────────────────────────────
async function _send(f, payload) {
  try {
    if (f.kind === 'addComment') {
      const body = {
        workRequestId: payload.workRequestId,
        text: _str(payload.text).slice(0, COMMENT_MAX),
        internalOnly: true,
        externalConsumers: [],
      };
      const post = _deps.apiPost || ((path, b) => _api().apiPost(path, b));
      const result = await post(ADD_COMMENT_PATH, body);
      _logLine('sent', f, 'len=' + body.text.length);
      return { ok: true, outcome: 'sent', id: f.id, result: result == null ? null : result };
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
    const err = (e && e.message) || String(e);
    _logLine('send-failed', f, 'error=' + _str(err).slice(0, 120));
    return { ok: false, outcome: 'send-failed', id: f.id, error: err };
  }
}

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
  if (flags.requireApproval === false) {
    _logLine('approved', f, 'by=setting-requireApproval-false');
    return _send(f, payload);
  }
  if (s.approvedBy) {
    _logLine('approved', f, 'by=' + _str(s.approvedBy).slice(0, 60));
    return _send(f, payload);
  }

  const win = s.interactive ? _window() : null;
  const staged = _stageItem(f, payload);
  f.id = staged.item.id;

  if (!win) {
    _logLine('gated', f, 'status=pending-approval' + (staged.reused ? ' reused=1' : ''));
    _notify('relayWrites:updated', { items: _load().items.map(_publicItem) });
    return { ok: false, outcome: 'pending-approval', id: f.id, error: 'pending-approval: queued for your approval; nothing was sent to Relay' };
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
  return { ok: false, outcome: 'skipped-not-approved', id: f.id, error: 'Not approved; nothing was sent to Relay' };
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
  if (w) w.resolve({ result: { ok: false, outcome: 'skipped-not-approved', id, error: 'Rejected; nothing was sent to Relay' } });
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
  APPROVAL_WAIT_MS,
  PENDING_TTL_MS,
  COMMENT_MAX,
  _setDepsForTest,
};
