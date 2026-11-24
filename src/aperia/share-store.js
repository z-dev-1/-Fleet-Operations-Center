'use strict';
/**
 * src/aperia/share-store.js — the underinflation share ledger and the carrier-briefing approval items
 * (<dataDir>/aperia_share.json). Never throws; a missing or corrupt file reads as empty.
 *
 * Shape: { version:1, sent:{ [issueId]: 'MINOR'|'MAJOR'|'CRITICAL'|'?' },
 *          items:[{ id, issueId, unit, operator, severity, state, text,
 *                   status:'pending'|'approved'|'sent'|'dismissed', createdAt, decidedAt, sentAt }] }
 *
 *   shouldSend(issueId, severity) -> true when the id was never DM'd or the severity steps up (MINOR < MAJOR < CRITICAL)
 *   markSent(issueId, severity)   -> records the highest severity DM'd for the id
 *   addItem({ issueId, unit, operator, severity, state, text }) -> the item (one per issueId+severity; status 'pending')
 *   list()                        -> copies of every item
 *   pendingCount()                -> number of 'pending' items
 *   decide(id, 'approve'|'dismiss', now) -> { ok:true, item } | { ok:false, code }
 *   approvedFor(operator)         -> 'approved' items for the operator (case-insensitive), copies
 *   markItemsSent(ids, now)       -> number of items moved to 'sent'
 *
 * The text of sent or dismissed items is blanked (it may carry a street address); items older than
 * 30 days are pruned; at most 200 items and 2000 ledger ids are kept. Atomic tmp+rename writes.
 */
const fs = require('fs');
const path = require('path');
const { safeJson } = require('./safe-json');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

const FILE = 'aperia_share.json';
const ITEM_MAX_AGE_MS = 30 * 24 * 3600e3;
const MAX_ITEMS = 200;
const MAX_SENT = 2000;
const STATUSES = new Set(['pending', 'approved', 'sent', 'dismissed']);
const SEV_RANK = Object.freeze({ MINOR: 1, MAJOR: 2, CRITICAL: 3 });

function filePath() { return path.join(require('../config/paths').getDataDir(), FILE); }

function _sev(s) { const k = String(s || '').toUpperCase().trim(); return SEV_RANK[k] ? k : '?'; }
function _rank(s) { return SEV_RANK[String(s || '').toUpperCase()] || 0; }
function _now(now) { return Number.isFinite(now) ? now : Date.now(); }
function _str(v, max) { return v === null || v === undefined ? '' : String(v).slice(0, max || 200); }

function _empty() { return { version: 1, sent: {}, items: [] }; }

// Windows: AV/indexers briefly lock the file or the tmp, so read/rename can throw EPERM/EACCES/EBUSY.
// Retry those a few times (sync, ~25 ms apart) instead of dropping a write or reading the store as empty.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function _retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (i >= 4 || !e || !TRANSIENT.has(e.code)) throw e;
      Atomics.wait(_sleepBuf, 0, 0, 25);
    }
  }
}

const UNREADABLE = Symbol('unreadable');

function _read() {
  let text;
  try { text = _retry(() => fs.readFileSync(filePath(), 'utf8')); } catch (e) {
    const d = _empty();
    // A locked (not missing) file must not be overwritten with an empty store.
    if (!e || e.code !== 'ENOENT') d[UNREADABLE] = true;
    return d;
  }
  const p = safeJson(text);
  if (!p.ok || !p.value || typeof p.value !== 'object' || Array.isArray(p.value)) {
    log.warn('[aperia] share-store load', { code: 'APERIA_SHARE_STORE_CORRUPT' });
    return _empty();
  }
  const v = p.value;
  const sent = {};
  if (v.sent && typeof v.sent === 'object' && !Array.isArray(v.sent)) {
    for (const k of Object.keys(v.sent)) sent[k] = _sev(v.sent[k]);
  }
  const items = (Array.isArray(v.items) ? v.items : [])
    .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && STATUSES.has(x.status));
  return { version: 1, sent, items };
}

function _prune(d, now) {
  const t = _now(now);
  d.items = d.items.filter((x) => !(Number.isFinite(x.createdAt) && t - x.createdAt > ITEM_MAX_AGE_MS));
  if (d.items.length > MAX_ITEMS) d.items = d.items.slice(d.items.length - MAX_ITEMS);
  const keys = Object.keys(d.sent);
  if (keys.length > MAX_SENT) for (const k of keys.slice(0, keys.length - MAX_SENT)) delete d.sent[k];
  return d;
}

function _write(d, now) {
  const file = filePath();
  const tmp = file + '.tmp';
  if (d[UNREADABLE]) {
    log.warn('[aperia] share-store save', { code: 'APERIA_SHARE_STORE_UNREADABLE' });
    return false;
  }
  try {
    _prune(d, now);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    _retry(() => fs.writeFileSync(tmp, JSON.stringify(d), 'utf8'));
    _retry(() => fs.renameSync(tmp, file));
    return true;
  } catch (e) {
    log.warn('[aperia] share-store save', { code: 'APERIA_SHARE_STORE_WRITE_FAILED', err: safeErr(e) });
    return false;
  }
}

function shouldSend(issueId, severity) {
  try {
    const id = _str(issueId, 64);
    if (!id) return false;
    const d = _read();
    if (d[UNREADABLE]) return false;
    if (!(id in d.sent)) return true;
    return _rank(_sev(severity)) > _rank(d.sent[id]);
  } catch (_) { return false; }
}

function markSent(issueId, severity) {
  try {
    const id = _str(issueId, 64);
    if (!id) return false;
    const d = _read();
    const k = _sev(severity);
    const prev = d.sent[id];
    const next = prev && _rank(prev) >= _rank(k) ? prev : k;
    delete d.sent[id];          // re-insert so the newest ids survive the cap
    d.sent[id] = next;
    return _write(d);
  } catch (_) { return false; }
}

function _newId(d) {
  for (let i = 0; i < 5; i++) {
    const id = 's' + (Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36)).slice(-12);
    if (!d.items.some((x) => x.id === id)) return id;
  }
  return 's' + Date.now().toString(36) + d.items.length.toString(36);
}

function addItem(item, now) {
  try {
    const it = item || {};
    const issueId = _str(it.issueId, 64);
    if (!issueId) return null;
    const severity = _sev(it.severity);
    const d = _read();
    const dup = d.items.find((x) => x.issueId === issueId && x.severity === severity);
    if (dup) return Object.assign({}, dup);
    const out = {
      id: _newId(d), issueId, unit: _str(it.unit, 60), operator: _str(it.operator, 200), severity,
      state: _str(it.state, 60), text: _str(it.text, 1000), status: 'pending',
      createdAt: _now(now), decidedAt: null, sentAt: null,
    };
    d.items.push(out);
    return _write(d, now) ? Object.assign({}, out) : null;
  } catch (_) { return null; }
}

function list() {
  try { return _read().items.map((x) => Object.assign({}, x)); } catch (_) { return []; }
}

function pendingCount() {
  try { return _read().items.filter((x) => x.status === 'pending').length; } catch (_) { return 0; }
}

function decide(id, action, now) {
  try {
    const d = _read();
    const it = d.items.find((x) => x.id === String(id || ''));
    if (!it) return { ok: false, code: 'APERIA_SHARE_ITEM_NOT_FOUND' };
    if (action !== 'approve' && action !== 'dismiss') return { ok: false, code: 'APERIA_INVALID_INPUT' };
    if (it.status === 'sent' || it.status === 'dismissed') return { ok: true, item: Object.assign({}, it) };
    it.status = action === 'approve' ? 'approved' : 'dismissed';
    it.decidedAt = _now(now);
    if (it.status === 'dismissed') it.text = '';
    _write(d, now);
    return { ok: true, item: Object.assign({}, it) };
  } catch (_) { return { ok: false, code: 'APERIA_INTERNAL' }; }
}

function approvedFor(operator) {
  try {
    const op = String(operator || '').trim().toLowerCase();
    if (!op) return [];
    return _read().items
      .filter((x) => x.status === 'approved' && String(x.operator || '').trim().toLowerCase() === op)
      .map((x) => Object.assign({}, x));
  } catch (_) { return []; }
}

function markItemsSent(ids, now) {
  try {
    const want = new Set((Array.isArray(ids) ? ids : []).map(String));
    if (!want.size) return 0;
    const d = _read();
    let n = 0;
    for (const it of d.items) {
      if (!want.has(it.id) || it.status === 'sent') continue;
      it.status = 'sent';
      it.sentAt = _now(now);
      it.text = '';
      n++;
    }
    if (n) _write(d, now);
    return n;
  } catch (_) { return 0; }
}

module.exports = {
  shouldSend, markSent, addItem, list, pendingCount, decide, approvedFor, markItemsSent, filePath,
  ITEM_MAX_AGE_MS, MAX_ITEMS, MAX_SENT,
};
