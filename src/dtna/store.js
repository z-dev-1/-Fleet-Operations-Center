'use strict';
/**
 * src/dtna/store.js — the dtnaCaseCache business-data store (dtna_case_cache.json).
 *
 * Holds what a user-initiated pull read: case fields, steps, repair order, comments and the derived
 * thread text. Fields are whitelisted on write, so no auth value (token, context, pageURI, cookies)
 * can ever land here. Shape: { version:1, cases: { [caseId]: entry } }.
 * Prune: newest 500 by pulledAt, nothing older than 30 days.
 */
const C = require('./constants');
const { normUnit } = require('./join');

const KEY = 'dtnaCaseCache';
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 3600e3;

const ENTRY_FIELDS = [
  'caseId', 'caseNumber', 'unitId', 'serial', 'vinTail', 'dealerCode', 'dealerName', 'caseStatus',
  'steps', 'repairOrderId', 'repairOrderNo', 'estimateNo', 'comments', 'thread', 'offsiteText',
  'offsiteStage', 'stageSince', 'commentCount', 'lastCommentAt', 'lastCommentType', 'pulledAt', 'source',
  'approvedTotal', 'approvedAt', 'attachments', 'attachmentsCheckedAt', 'attachmentsCode',
];
const STEP_FIELDS = ['name', 'status', 'at'];
const COMMENT_FIELDS = ['id', 'type', 'at', 'from', 'text'];
// Case attachments (estimate PDFs): metadata, extraction status, the extracted text (for the AI) and the
// parsed totals. Scalars only; there is no bytes field, so file bytes can never be stored.
const ATTACHMENT_FIELDS = [
  'versionId', 'documentId', 'attId', 'name', 'ext', 'size', 'createdAt', 'kind', 'status', 'code', 'text', 'textLen',
  'truncated', 'total', 'totalLabeled', 'partsTotal', 'laborTotal', 'extractedAt',
];
const LINE_ITEM_FIELDS = ['desc', 'amount', 'kind'];

function _attachment(a) {
  const out = _pick(a, ATTACHMENT_FIELDS);
  if (typeof out.text === 'string' && out.text.length > C.ATTACHMENT_TEXT_MAX) out.text = out.text.slice(0, C.ATTACHMENT_TEXT_MAX);
  for (const k of ['size', 'total', 'partsTotal', 'laborTotal', 'textLen']) if (out[k] === '') out[k] = null;
  out.lineItems = (Array.isArray(a.lineItems) ? a.lineItems : []).filter((x) => x && typeof x === 'object')
    .slice(0, C.ESTIMATE_LINE_ITEMS_MAX).map((x) => _pick(x, LINE_ITEM_FIELDS));
  return out;
}

function _store() { return require('../store'); }

function _scalar(v) {
  if (v == null) return '';
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' ? v : '';
}

function _pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = _scalar(obj[k]);
  return out;
}

/** sanitize(entry) -> whitelisted copy | null (invalid case id). */
function sanitize(entry) {
  if (!entry || typeof entry !== 'object' || !C.CASE_ID_RE.test(String(entry.caseId || ''))) return null;
  const out = {};
  for (const k of ENTRY_FIELDS) {
    if (k === 'steps' || k === 'comments' || k === 'attachments') continue;
    out[k] = _scalar(entry[k]);
  }
  out.steps = (Array.isArray(entry.steps) ? entry.steps : []).filter((s) => s && typeof s === 'object').map((s) => _pick(s, STEP_FIELDS));
  out.comments = (Array.isArray(entry.comments) ? entry.comments : []).filter((c) => c && typeof c === 'object').map((c) => _pick(c, COMMENT_FIELDS));
  out.attachments = (Array.isArray(entry.attachments) ? entry.attachments : []).filter((a) => a && typeof a === 'object' && !Buffer.isBuffer(a))
    .slice(0, C.ATTACHMENT_LIST_MAX).map(_attachment);
  out.source = 'aura';
  return out;
}

function _ms(v) {
  const ms = v ? Date.parse(String(v)) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** prune(cases, now) -> new cases map: drop entries older than 30 days, keep the newest 500 by pulledAt. */
function prune(cases, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const list = Object.values(cases || {}).filter((e) => e && C.CASE_ID_RE.test(String(e.caseId || '')) && t - _ms(e.pulledAt) <= MAX_AGE_MS);
  list.sort((a, b) => _ms(b.pulledAt) - _ms(a.pulledAt));
  const out = {};
  for (const e of list.slice(0, MAX_ENTRIES)) out[e.caseId] = e;
  return out;
}

function _load() {
  const d = _store().load(KEY, null);
  return d && typeof d === 'object' && d.cases && typeof d.cases === 'object' ? d : { version: 1, cases: {} };
}

function get(caseId) {
  if (!C.CASE_ID_RE.test(String(caseId || ''))) return null;
  return _load().cases[caseId] || null;
}

/** put(entry, {now}) -> the stored (whitelisted) entry | null. */
function put(entry, opts) {
  const e = sanitize(entry);
  if (!e) return null;
  const d = _load();
  d.cases[e.caseId] = e;
  _store().save(KEY, { version: 1, cases: prune(d.cases, opts && opts.now) });
  return e;
}

function all() { return Object.values(_load().cases); }

function findByUnit(unit) {
  const u = normUnit(unit);
  if (!u) return [];
  return all().filter((e) => normUnit(e.unitId) === u);
}

module.exports = { get, put, all, findByUnit, prune, sanitize, KEY, ENTRY_FIELDS, ATTACHMENT_FIELDS, MAX_ENTRIES, MAX_AGE_MS };
