'use strict';
/**
 * src/dtna/client.js — DTNA case reads built on the Aura transport.
 *
 * Reads only: case record, repair order id, comments, case number. Calls start from a user action (a unit
 * "Pull DTNA" or the bulk tool) or from the sync pass through src/dtna/auto.js with {silent:true}
 * (session-gated, never a sign-in). Pulled cases go to the dtnaCaseCache store. Logs carry caseTag,
 * counts, codes and ms only (never comment text, names or ids).
 */
const C = require('./constants');
const T = require('./thread');
const J = require('./join');
const { caseTag, safeErr } = require('./redact');
const log = require('../utils/logger')('dtna');

// Test seam: { aura, store, session, now, sleep }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _aura() { return _deps.aura || require('./aura'); }
function _store() { return _deps.store || require('./store'); }
function _session() { return _deps.session || require('./session'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _sleep(ms) { return typeof _deps.sleep === 'function' ? _deps.sleep(ms) : new Promise((r) => setTimeout(r, ms)); }

const LIST_TTL_MS = 30 * 60e3;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 20;
const LAST_TEXT_MAX = 500;
const FATAL = new Set(['DTNA_SIGNIN_REQUIRED', 'DTNA_SESSION_EXPIRED', 'DTNA_TIMEOUT', 'DTNA_NETWORK']);

function _str(v) { return v == null ? '' : String(v); }
function _ms(v) { const ms = v ? Date.parse(String(v)) : NaN; return Number.isFinite(ms) ? ms : null; }

// ── Reads ──────────────────────────────────────────────────────────────────
function _firstObject(v) {
  if (Array.isArray(v)) return v.find((x) => x && typeof x === 'object') || null;
  if (v && typeof v === 'object') {
    for (const k of ['record', 'caseRecord', 'case', 'Case']) if (v[k] && typeof v[k] === 'object' && !Array.isArray(v[k])) return v[k];
    return v;
  }
  return null;
}

// Transport options: only {silent:true} (the sync pass, src/dtna/auto.js) is forwarded.
function _tx(opts) { return opts && opts.silent ? { silent: true } : undefined; }

async function getCaseRecord(caseId, opts) {
  const r = await _aura().callApex('getCaseRecord', { caseId }, _tx(opts));
  if (!r.ok) return r;
  return { ok: true, value: _firstObject(r.value) };
}

/** getRepairOrderId(caseId) -> {ok, value: { Id, Name? } | null} */
async function getRepairOrderId(caseId, opts) {
  const r = await _aura().callApex('getRepairOrderId', { caseId }, _tx(opts));
  if (!r.ok) return r;
  const v = r.value;
  if (typeof v === 'string') return { ok: true, value: /^[A-Za-z0-9]{15,18}$/.test(v) ? { Id: v } : null };
  const o = _firstObject(v);
  if (!o || !o.Id) return { ok: true, value: null };
  const out = { Id: _str(o.Id) };
  if (o.Name) out.Name = _str(o.Name);
  return { ok: true, value: out };
}

async function getComments(caseId, opts) {
  const r = await _aura().callApex('getCommentsByCaseRepairOrder', { caseId }, _tx(opts));
  if (!r.ok) return r;
  const v = r.value;
  const list = Array.isArray(v) ? v : (v && typeof v === 'object' && Array.isArray(v.comments) ? v.comments : []);
  return { ok: true, value: list.filter((c) => c && typeof c === 'object') };
}

async function getComment(commentId) {
  const r = await _aura().callApex('getComment', { commentId });
  if (!r.ok) return r;
  return { ok: true, value: _firstObject(r.value) };
}

const CASE_NUMBER_RE = /^\d{1,12}$/;
function _caseNo(v) {
  const s = _str(v && typeof v === 'object' ? (v.value != null ? v.value : v.displayValue) : v).trim();
  return CASE_NUMBER_RE.test(s) ? s : '';
}

/** getCaseNumber(caseId, {silent}) -> {ok:true, value: '15667050' | ''} | {ok:false, code} */
async function getCaseNumber(caseId, opts) {
  const r = await _aura().getCaseNumberRecord(caseId, _tx(opts));
  if (!r.ok) return r;
  const f = r.value && typeof r.value === 'object' && r.value.fields && typeof r.value.fields === 'object' ? r.value.fields.CaseNumber : null;
  return { ok: true, value: _caseNo(f) };
}

// ── Normalize ──────────────────────────────────────────────────────────────
function _path(obj, key) {
  let cur = obj;
  for (const part of String(key).split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function _field(rec, keys, fallbackRe) {
  for (const k of keys) {
    const v = _path(rec, k);
    if (v != null && v !== '' && typeof v !== 'object') return _str(v).trim();
  }
  if (fallbackRe) {
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (fallbackRe.test(k) && v != null && v !== '' && (typeof v === 'string' || typeof v === 'number')) return _str(v).trim();
    }
  }
  return '';
}

function _steps(rec) {
  let arr = null;
  for (const k of C.CASE_FIELDS.steps) if (Array.isArray(_path(rec, k))) { arr = _path(rec, k); break; }
  return (arr || []).filter((s) => s && typeof s === 'object').map((s) => ({
    name: _str(s.name || s.Name || s.label || s.stepName || s.StepName).slice(0, 80),
    status: _str(s.status || s.Status || s.state).slice(0, 40),
    at: _str(s.at || s.date || s.Date || s.completedDate || s.CompletedDate || s.timestamp || s.CreatedDate),
  }));
}

function _commentOf(c) {
  return {
    id: _str(c.CommentId || c.Id),
    type: _str(c.CommentType).slice(0, 80),
    at: _str(c.CreatedDate || c.LastUpdatedDate),
    from: _str(c.FromName).slice(0, 80),
    text: T.stripHtml(c.CommentText).slice(0, C.COMMENT_MAX),
  };
}

function _newestWith(comments, keys) {
  for (const c of comments) {
    for (const k of keys) if (c && c[k] != null && c[k] !== '') return _str(c[k]).trim();
  }
  return '';
}

/**
 * normalizeCase(record, ro, comments, {caseId, now}) -> cache entry (see src/dtna/store.js fields).
 * comments: raw Apex rows. Comments in the entry are newest first.
 */
function normalizeCase(record, ro, comments, opts) {
  const o = opts || {};
  const rec = record && typeof record === 'object' ? record : {};
  const raw = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c === 'object');
  const sorted = raw.map((c, i) => ({ c, i, ms: _ms(c.CreatedDate || c.LastUpdatedDate) }))
    .sort((a, b) => ((b.ms || 0) - (a.ms || 0)) || (a.i - b.i)).map((x) => x.c);
  const norm = sorted.map(_commentOf);
  const caseId = C.CASE_ID_RE.test(_str(o.caseId)) ? o.caseId : _str(rec.Id);
  const caseStatus = _field(rec, C.CASE_FIELDS.caseStatus);
  const steps = _steps(rec);
  const th = T.commentsToThread(sorted);
  const stage = T.stageFromCase({ caseStatus, steps, comments: norm, thread: th.thread });
  const vin = _field(rec, C.CASE_FIELDS.vin, /(^|_)vin/i);
  const newest = norm[0] || null;
  return {
    caseId,
    caseNumber: _field(rec, C.CASE_FIELDS.caseNumber),
    unitId: _field(rec, C.CASE_FIELDS.unitId, /unit/i),
    serial: _field(rec, C.CASE_FIELDS.serial, /serial/i),
    vinTail: J.vinTail(vin),
    dealerCode: _field(rec, C.CASE_FIELDS.dealerCode),
    dealerName: _field(rec, C.CASE_FIELDS.dealerName),
    caseStatus,
    steps,
    repairOrderId: ro && ro.Id ? _str(ro.Id) : '',
    repairOrderNo: _newestWith(sorted, ['RepairOrderNo', 'RepairOrderNumber', 'RONumber']) || (ro && ro.Name ? _str(ro.Name) : ''),
    estimateNo: _newestWith(sorted, ['EstimateNo', 'EstimateNumber']),
    comments: norm,
    thread: th.thread,
    offsiteText: th.offsiteText,
    offsiteStage: stage.stage,
    stageSince: stage.since,
    commentCount: norm.length,
    lastCommentAt: newest ? newest.at : '',
    lastCommentType: newest ? newest.type : '',
    pulledAt: new Date(Number.isFinite(o.now) ? o.now : _now()).toISOString(),
    source: 'aura',
  };
}

// ── Pull ───────────────────────────────────────────────────────────────────
// Cases whose case-number read came back empty or refused this run: not asked again until restart.
const _noNumber = new Set();

/**
 * _caseNumberFor(caseId, entry, last, tx) -> {ok:true, value} | {ok:false, code} (FATAL codes only).
 * Case numbers never change: the record, then the previous cache entry, then the list harvest, and only
 * when all are empty one getRecordWithFields read.
 */
async function _caseNumberFor(caseId, entry, last, tx) {
  const known = _caseNo(entry.caseNumber) || _caseNo(last && last.caseNumber) || caseNumberFromList(caseId);
  if (known || _noNumber.has(caseId)) return { ok: true, value: known };
  const r = await getCaseNumber(caseId, tx);
  if (r.ok && r.value) return r;
  if (!r.ok && FATAL.has(r.code)) return { ok: false, code: r.code };
  _noNumber.add(caseId);
  return { ok: true, value: '' };
}

/** pullCase(caseId, {includeComments=true, signal, silent}) -> {ok:true, entry} | {ok:false, code} */
async function pullCase(caseId, opts) {
  const o = opts || {};
  const includeComments = o.includeComments !== false;
  const tx = _tx(o);
  if (!C.CASE_ID_RE.test(_str(caseId))) return { ok: false, code: 'DTNA_INVALID_INPUT' };
  if (o.signal && o.signal.aborted) return { ok: false, code: 'DTNA_CANCELLED' };
  const t0 = _now();
  const rec = await getCaseRecord(caseId, tx);
  if (!rec.ok) return { ok: false, code: rec.code };
  let ro = null;
  const r1 = await getRepairOrderId(caseId, tx);
  if (r1.ok) ro = r1.value;
  else if (FATAL.has(r1.code)) return { ok: false, code: r1.code };
  let comments = [];
  let prev = null;
  let commentsCode = '';
  if (includeComments) {
    const r2 = await getComments(caseId, tx);
    if (r2.ok) comments = r2.value;
    else if (FATAL.has(r2.code)) return { ok: false, code: r2.code };
    else commentsCode = _str(r2.code) || 'DTNA_APEX_ERROR';
    const last = _store().get(caseId);
    const hadThread = !!last && Number(last.commentCount) > 0;
    // A failed read, or an empty read over a cached thread, keeps the last-good thread (Phase A review #1).
    if (commentsCode && hadThread) prev = last;
    else if (!commentsCode && !comments.length && hadThread) { prev = last; commentsCode = 'DTNA_COMMENTS_EMPTY'; }
  } else {
    prev = _store().get(caseId);
  }
  const entry = normalizeCase(rec.value, ro, comments, { caseId, now: _now() });
  if (prev) {
    // Case-only pull, or a failed/empty comment read: keep the comments a previous pull read.
    for (const k of ['comments', 'thread', 'offsiteText', 'commentCount', 'lastCommentAt', 'lastCommentType', 'repairOrderNo', 'estimateNo']) {
      if (prev[k] !== undefined && prev[k] !== '') entry[k] = prev[k];
    }
  }
  const cn = await _caseNumberFor(caseId, entry, _store().get(caseId), tx);
  if (!cn.ok) return { ok: false, code: cn.code };
  entry.caseNumber = cn.value;
  const saved = _store().put(entry, { now: _now() }) || entry;
  try { _session().notePulled(saved.pulledAt); } catch (e) { log.warn('[dtna] status', safeErr(e)); }
  const stale = includeComments && !!prev;
  const info = { caseTag: caseTag(caseId), comments: saved.commentCount, hasRo: !!saved.repairOrderId, hasCaseNumber: !!saved.caseNumber, ms: _now() - t0 };
  if (commentsCode) { info.commentsKept = stale; info.code = commentsCode; }
  log.info('[dtna] pull', info);
  const out = { ok: true, entry: saved };
  if (stale) out.commentsStale = true;
  if (commentsCode) out.commentsCode = commentsCode;
  return out;
}

// ── List ───────────────────────────────────────────────────────────────────
let _listMemo = null; // { key, at, ids }
const _listNumbers = new Map(); // caseId -> case number seen on a list record (digits only)

function _collectIds(v, out, depth) {
  if (depth > 12 || v == null || typeof v !== 'object') return;
  if (Array.isArray(v)) { for (const x of v) _collectIds(x, out, depth + 1); return; }
  for (const k of Object.keys(v)) {
    const x = v[k];
    if (k === 'Id' || k === 'id') {
      const s = typeof x === 'string' ? x : (x && typeof x === 'object' && typeof x.value === 'string' ? x.value : '');
      if (/^500[A-Za-z0-9]{15}$/.test(s)) {
        out.add(s);
        const n = _caseNo(v.CaseNumber);
        if (n) _listNumbers.set(s, n);
      }
    }
    if (x && typeof x === 'object') _collectIds(x, out, depth + 1);
  }
}

/** caseNumberFromList(caseId) -> the case number a list read showed for this case | ''. No network. */
function caseNumberFromList(caseId) { return _listNumbers.get(_str(caseId)) || ''; }

/** listCaseIds({filterId, force, silent}) -> {ok:true, ids} | {ok:false, code}. Memoized 30 min in memory. */
async function listCaseIds(opts) {
  const o = opts || {};
  const filterId = typeof o.filterId === 'string' && /^[A-Za-z0-9]{15,18}$/.test(o.filterId) ? o.filterId : '';
  const key = filterId || '-';
  if (!o.force && _listMemo && _listMemo.key === key && _now() - _listMemo.at < LIST_TTL_MS) return { ok: true, ids: _listMemo.ids.slice() };
  const ids = new Set();
  let paged = false;
  let base = 0;
  let page = 0;
  for (let i = 0; i < LIST_MAX_PAGES; i++) {
    const mutate = (p) => {
      if (filterId) {
        if ('filterName' in p) p.filterName = filterId;
        if ('filterId' in p) p.filterId = filterId;
      }
      if ('pageSize' in p && 'currentPage' in p) {
        if (i === 0) base = Number(p.currentPage) || 0;
        paged = true;
        p.pageSize = LIST_PAGE_SIZE;
        p.currentPage = base + page;
      }
    };
    const r = await _aura().replayGetItems(mutate, _tx(o));
    if (!r.ok) {
      if (i === 0) return { ok: false, code: r.code };
      break;
    }
    const before = ids.size;
    const got = new Set();
    _collectIds(r.value, got, 0);
    for (const id of got) ids.add(id);
    if (!paged || got.size < LIST_PAGE_SIZE || ids.size === before) break;
    page++;
  }
  const list = Array.from(ids);
  _listMemo = { key, at: _now(), ids: list };
  log.info('[dtna] list', { count: list.length, pages: page + 1 });
  return { ok: true, ids: list.slice() };
}

// ── Resolve a fleet row to a case ──────────────────────────────────────────
/** resolveCaseForRow(row) -> {ok:true, caseId, via} | {ok:false, code} */
async function resolveCaseForRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, code: 'DTNA_INVALID_INPUT' };
  const fromUrl = J.caseIdFromUrl(require('../utils/offsite-owner').offsiteUrlOf(row));
  if (fromUrl) return { ok: true, caseId: fromUrl, via: 'offsite' };
  const cached = J.findCaseForRow(row, _store().all());
  if (cached) return { ok: true, caseId: cached.caseId, via: 'cache' };
  const lr = await listCaseIds();
  if (!lr.ok) return { ok: false, code: lr.code };
  const have = new Set(_store().all().map((e) => e.caseId));
  const todo = lr.ids.filter((id) => !have.has(id));
  for (let i = 0; i < todo.length; i += C.CONCURRENCY) {
    if (i > 0) await _sleep(C.BATCH_GAP_MS);
    const batch = todo.slice(i, i + C.CONCURRENCY);
    const found = [];
    let fatal = null;
    await Promise.all(batch.map(async (id) => {
      const r = await getCaseRecord(id);
      if (!r.ok) { if (FATAL.has(r.code)) fatal = r.code; return; }
      const n = normalizeCase(r.value, null, [], { caseId: id, now: _now() });
      if (!_caseNo(n.caseNumber)) n.caseNumber = caseNumberFromList(id);
      const e = _store().put(n, { now: _now() });
      if (e && J.findCaseForRow(row, [e])) found.push(e);
    }));
    if (found.length) {
      const best = J.findCaseForRow(row, found);
      log.info('[dtna] resolve', { caseTag: caseTag(best.caseId), via: 'list', scanned: Math.min(i + C.CONCURRENCY, todo.length) });
      return { ok: true, caseId: best.caseId, via: 'list' };
    }
    if (fatal) return { ok: false, code: fatal };
  }
  log.info('[dtna] resolve', { code: 'DTNA_CASE_NOT_FOUND', scanned: todo.length });
  return { ok: false, code: 'DTNA_CASE_NOT_FOUND' };
}

// ── Bulk ───────────────────────────────────────────────────────────────────
/**
 * bulkPull({includeComments, onProgress, signal}) -> {ok, results, total, failed, cancelled, code?}
 * Batches of CONCURRENCY with BATCH_GAP_MS between batches; abort stops scheduling new batches.
 * A sign-in / network failure stops scheduling too (ok:false with that code and the partial results).
 */
async function bulkPull(opts) {
  const o = opts || {};
  const signal = o.signal || null;
  const t0 = _now();
  const lr = await listCaseIds();
  if (!lr.ok) return { ok: false, code: lr.code, results: [], total: 0, failed: 0, cancelled: false };
  const ids = lr.ids;
  const total = ids.length;
  const results = [];
  let done = 0;
  let failed = 0;
  let cancelled = false;
  let stopCode = null;
  const progress = () => { try { if (typeof o.onProgress === 'function') o.onProgress({ done, total, failed }); } catch (e) { log.warn('[dtna] progress', safeErr(e)); } };
  for (let i = 0; i < ids.length; i += C.CONCURRENCY) {
    if (signal && signal.aborted) { cancelled = true; break; }
    if (i > 0) {
      await _sleep(C.BATCH_GAP_MS);
      if (signal && signal.aborted) { cancelled = true; break; }
    }
    const batch = ids.slice(i, i + C.CONCURRENCY);
    await Promise.all(batch.map(async (id) => {
      let r;
      try { r = await pullCase(id, { includeComments: o.includeComments !== false, signal }); } catch (e) { log.warn('[dtna] bulk', safeErr(e)); r = { ok: false, code: 'DTNA_NETWORK' }; }
      done++;
      if (r.ok) results.push(r.entry);
      else { failed++; if (FATAL.has(r.code) && r.code !== 'DTNA_TIMEOUT') stopCode = r.code; }
      progress();
    }));
    if (stopCode) break;
  }
  log.info('[dtna] bulk', { total, done, failed, cancelled, code: stopCode || 'OK', ms: _now() - t0 });
  const out = { ok: !stopCode, results, total, failed, cancelled };
  if (stopCode) out.code = stopCode;
  return out;
}

// ── Export ─────────────────────────────────────────────────────────────────
const CASE_COLUMNS = [
  'caseId', 'caseNumber', 'unitId', 'serial', 'dealerCode', 'dealerName', 'caseStatus', 'repairOrderNo', 'estimateNo',
  'estimateStatus', 'estimateTotal', 'commentCount', 'lastCommentAt', 'lastCommentType', 'lastCommentText',
  'rgWorkRequestId', 'rgVendor', 'rgSite', 'caseUrl',
];
const COMMENT_COLUMNS = ['caseId', 'caseNumber', 'unitId', 'commentId', 'commentType', 'createdAt', 'from', 'text', 'caseUrl'];

/** exportRows(results, {mode}) -> { columns, rows:[{col: value}] } (estimate columns blank in Phase A). */
function exportRows(results, opts) {
  const mode = opts && opts.mode === 'comments' ? 'comments' : 'cases';
  const list = (Array.isArray(results) ? results : []).filter((e) => e && typeof e === 'object' && C.CASE_ID_RE.test(_str(e.caseId)));
  const rows = [];
  if (mode === 'cases') {
    for (const e of list) {
      const c0 = Array.isArray(e.comments) && e.comments[0] ? e.comments[0] : null;
      rows.push({
        caseId: e.caseId, caseNumber: e.caseNumber, unitId: e.unitId, serial: e.serial, dealerCode: e.dealerCode,
        dealerName: e.dealerName, caseStatus: e.caseStatus, repairOrderNo: e.repairOrderNo, estimateNo: e.estimateNo,
        estimateStatus: '', estimateTotal: '', commentCount: e.commentCount, lastCommentAt: e.lastCommentAt,
        lastCommentType: e.lastCommentType, lastCommentText: c0 ? _str(c0.text).slice(0, LAST_TEXT_MAX) : '',
        rgWorkRequestId: e.rgWorkRequestId || '', rgVendor: e.rgVendor || '', rgSite: e.rgSite || '', caseUrl: C.caseUrl(e.caseId),
      });
    }
    return { columns: CASE_COLUMNS.slice(), rows };
  }
  for (const e of list) {
    for (const c of (Array.isArray(e.comments) ? e.comments : [])) {
      if (!c || typeof c !== 'object') continue;
      rows.push({
        caseId: e.caseId, caseNumber: e.caseNumber, unitId: e.unitId, commentId: c.id, commentType: c.type,
        createdAt: c.at, from: c.from, text: c.text, caseUrl: C.caseUrl(e.caseId),
      });
    }
  }
  return { columns: COMMENT_COLUMNS.slice(), rows };
}

function _cell(v) {
  let s = v == null ? '' : String(v);
  s = s.replace(/[\t\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

/** toTSV(results, {mode:'cases'|'comments'}) -> TSV text (header row, CRLF line ends, formula-injection guard). */
function toTSV(results, opts) {
  const { columns, rows } = exportRows(results, opts);
  const lines = [columns.join('\t')];
  for (const r of rows) lines.push(columns.map((c) => _cell(r[c])).join('\t'));
  return lines.join('\r\n') + '\r\n';
}

function _resetForTests() { _deps = {}; _listMemo = null; _listNumbers.clear(); _noNumber.clear(); }

module.exports = {
  getCaseRecord, getRepairOrderId, getComments, getComment, getCaseNumber, normalizeCase, pullCase, listCaseIds, caseNumberFromList,
  resolveCaseForRow, bulkPull, toTSV, exportRows, CASE_COLUMNS, COMMENT_COLUMNS, _setDeps, _resetForTests,
};
