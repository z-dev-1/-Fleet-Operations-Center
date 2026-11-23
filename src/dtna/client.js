'use strict';
/**
 * src/dtna/client.js — DTNA case reads built on the Aura transport.
 *
 * Reads only: case record, repair order id, comments, case number, the feed's Chatter flag and the case
 * files (estimate PDFs, downloaded and text-extracted inside a comments pull). Calls start from a user action (a unit
 * "Pull DTNA" or the bulk tool) or from the sync pass through src/dtna/auto.js with {silent:true}
 * (session-gated, never a sign-in). Pulled cases go to the dtnaCaseCache store. Logs carry caseTag,
 * counts, codes and ms only (never comment text, names or ids).
 */
const C = require('./constants');
const T = require('./thread');
const J = require('./join');
const { caseTag, safeErr } = require('./redact');
const log = require('../utils/logger')('dtna');

// Test seam: { aura, store, session, capture, now, sleep }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _aura() { return _deps.aura || require('./aura'); }
function _store() { return _deps.store || require('./store'); }
function _session() { return _deps.session || require('./session'); }
function _capture() { return _deps.capture || require('./capture'); }
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

function _findBool(v, key, depth) {
  if (depth > 8 || v == null || typeof v !== 'object') return null;
  if (!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, key) && typeof v[key] === 'boolean') return v[key];
  for (const k of Object.keys(v).slice(0, 200)) {
    const x = _findBool(v[k], key, depth + 1);
    if (x !== null) return x;
  }
  return null;
}

/**
 * getChatterEnabled(caseId, {silent}) -> {ok:true, value: true|false|null} | {ok:false, code}
 * The case feed's own config read (aura.getFeedModel); value = the boolean at CHATTER_FEED_READ.enabledKey
 * (default isChatterEnabled) anywhere in the returned value (depth <= 8), null when absent.
 */
async function getChatterEnabled(caseId, opts) {
  const r = await _aura().getFeedModel(caseId, _tx(opts));
  if (!r || !r.ok) return { ok: false, code: _str((r && r.code) || 'DTNA_INTERNAL').slice(0, 40) };
  const cfg = Object.prototype.hasOwnProperty.call(_deps, 'chatterFeedRead') ? _deps.chatterFeedRead : C.CHATTER_FEED_READ;
  const key = cfg && typeof cfg.enabledKey === 'string' && /^\w{1,60}$/.test(cfg.enabledKey) ? cfg.enabledKey : 'isChatterEnabled';
  return { ok: true, value: _findBool(r.value, key, 0) };
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
  const approved = require('./pending').approvedTotalOf(norm);
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
    approvedTotal: approved ? approved.total : null,
    approvedAt: approved ? approved.at : '',
    attachments: [],
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

// ── Attachments (estimate PDFs) ────────────────────────────────────────────
function _files() { return _deps.files || require('./files'); }
function _estimatePdf() { return _deps.estimatePdf || require('./estimate-pdf'); }

// Final statuses: reused while the file is unchanged and younger than ATTACHMENT_REFRESH_MS.
const ATT_FINAL = new Set(['read', 'scanned', 'skipped-size', 'skipped-type']);
// Download codes that stop the attachment step for this pull (the case pull itself still succeeds).
const ATT_STOP = new Set(['DTNA_SESSION_EXPIRED', 'DTNA_SIGNIN_REQUIRED', 'DTNA_NETWORK', 'DTNA_TIMEOUT', 'DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED']);

function _attKey(a) { return a ? _str(a.attId ? 'att:' + a.attId : (a.versionId || a.documentId)) : ''; }
function _attMeta(a) {
  return { versionId: _str(a.versionId), documentId: _str(a.documentId), attId: _str(a.attId), name: _str(a.name), ext: _str(a.ext), size: Number.isFinite(a.size) ? a.size : null, createdAt: _str(a.createdAt) };
}

/**
 * syncAttachments(caseId, rawComments, prevEntry, {silent}) -> { attachments, attachmentsCheckedAt, attachmentsCode }
 * Lists the case files, reuses unchanged cached extractions (same id + size, final status, younger than
 * ATTACHMENT_REFRESH_MS), downloads and extracts at most ATTACHMENT_MAX_PER_PULL new / changed / stale /
 * failed PDFs (newest first) through one lazily opened extractor (closed in finally). Only the newest
 * ATTACHMENT_KEEP_TEXT PDFs keep their text. Never throws; a failure keeps the previous attachments.
 */
async function syncAttachments(caseId, rawComments, prevEntry, opts) {
  const t0 = _now();
  const prevList = prevEntry && Array.isArray(prevEntry.attachments) ? prevEntry.attachments : [];
  const out = { attachments: prevList, attachmentsCheckedAt: new Date(_now()).toISOString(), attachmentsCode: '' };
  const stats = { listed: 0, pdfs: 0, downloaded: 0, reused: 0, skipped: 0, failed: 0 };
  let code = '';
  let lr;
  try { lr = await _files().listAttachments(caseId, rawComments, opts); } catch (_) { lr = { ok: false, code: 'DTNA_INTERNAL' }; }
  if (!lr || !lr.ok) {
    out.attachmentsCode = _str((lr && lr.code) || 'DTNA_INTERNAL').slice(0, 40);
    if (out.attachmentsCode !== 'DTNA_ATTACHMENTS_NOT_CONFIGURED') {
      log.info('[dtna] attachments', Object.assign({ caseTag: caseTag(caseId) }, stats, { code: out.attachmentsCode, ms: _now() - t0 }));
    }
    return out;
  }
  const list = Array.isArray(lr.list) ? lr.list : [];
  stats.listed = list.length;
  const prevBy = new Map(prevList.filter((a) => a && _attKey(a)).map((a) => [_attKey(a), a]));
  const F = _files();
  const pdfs = list.map((a, i) => ({ a, i })).filter((x) => F.isPdf(x.a))
    .sort((x, y) => ((_ms(y.a.createdAt) || 0) - (_ms(x.a.createdAt) || 0)) || (x.i - y.i)).map((x) => x.a);
  const others = list.filter((a) => !F.isPdf(a)).map((a) => Object.assign(_attMeta(a), { kind: a.ext || 'file', status: 'skipped-type', code: '' }));
  stats.pdfs = pdfs.length;
  stats.skipped += others.length;
  const result = [];
  let ex = null;
  let stopped = false;
  try {
    for (const a of pdfs) {
      const meta = Object.assign(_attMeta(a), { kind: 'pdf' });
      const prev = prevBy.get(_attKey(a));
      const fresh = prev && ATT_FINAL.has(prev.status) && (prev.size == null ? null : prev.size) === meta.size
        && _now() - (_ms(prev.extractedAt) || 0) < C.ATTACHMENT_REFRESH_MS;
      if (fresh) { result.push(Object.assign({}, prev, meta)); stats.reused++; continue; }
      if (meta.size != null && meta.size > C.ATTACHMENT_MAX_BYTES) {
        result.push(Object.assign(meta, { status: 'skipped-size', code: 'DTNA_ATTACHMENT_TOO_LARGE', extractedAt: new Date(_now()).toISOString() }));
        stats.skipped++;
        continue;
      }
      if (stopped || stats.downloaded >= C.ATTACHMENT_MAX_PER_PULL) {
        // Not attempted this pull: keep what an earlier pull extracted, else retried next pull.
        result.push(prev ? Object.assign({}, prev, meta) : Object.assign(meta, { status: 'pending', code: code || '' }));
        continue;
      }
      stats.downloaded++;
      let d;
      try { d = await F.downloadPdf(a, { caseId, silent: !!(opts && opts.silent) }); } catch (_) { d = { ok: false, code: 'DTNA_INTERNAL' }; }
      if (!d || !d.ok) {
        const c = _str((d && d.code) || 'DTNA_INTERNAL').slice(0, 40);
        if (ATT_STOP.has(c)) { stopped = true; code = c; }
        const status = c === 'DTNA_ATTACHMENT_TOO_LARGE' ? 'skipped-size' : (c === 'DTNA_ATTACHMENT_NOT_PDF' ? 'skipped-type' : 'failed');
        if (status === 'failed') stats.failed++; else stats.skipped++;
        result.push(prev && status === 'failed' && prev.status === 'read'
          ? Object.assign({}, prev, meta)
          : Object.assign(meta, { status, code: c, extractedAt: new Date(_now()).toISOString() }));
        continue;
      }
      if (!ex) ex = _estimatePdf().openExtractor(_deps.extractorDeps);
      let x;
      try { x = await ex.extract(d.buffer, meta.name); } catch (_) { x = { ok: false, status: 'failed', text: '', code: 'DTNA_PDF_FAILED' }; }
      const text = _str(x && x.text);
      const parsed = text ? _estimatePdf().parseEstimateText(text) : { total: null, totalLabeled: false, partsTotal: null, laborTotal: null, lineItems: [] };
      if (!x || x.status === 'failed') stats.failed++;
      result.push(Object.assign(meta, {
        status: (x && x.status) || 'failed',
        code: x && x.code ? _str(x.code).slice(0, 40) : '',
        text,
        textLen: text.length,
        truncated: !!(x && x.truncated),
        total: parsed.total,
        totalLabeled: !!parsed.totalLabeled,
        partsTotal: parsed.partsTotal,
        laborTotal: parsed.laborTotal,
        lineItems: parsed.lineItems,
        extractedAt: new Date(_now()).toISOString(),
      }));
    }
  } finally {
    if (ex) { try { ex.close(); } catch (_) { /* already gone */ } }
  }
  // Only the newest ATTACHMENT_KEEP_TEXT PDFs keep their text (result is newest first).
  let kept = 0;
  for (const a of result) {
    if (a.text) { if (kept < C.ATTACHMENT_KEEP_TEXT) kept++; else a.text = ''; }
  }
  out.attachments = result.concat(others);
  out.attachmentsCode = code;
  log.info('[dtna] attachments', Object.assign({ caseTag: caseTag(caseId) }, stats, { code: code || 'OK', ms: _now() - t0 }));
  return out;
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
    for (const k of ['comments', 'thread', 'offsiteText', 'commentCount', 'lastCommentAt', 'lastCommentType', 'repairOrderNo', 'estimateNo', 'approvedTotal', 'approvedAt',
      'attachments', 'attachmentsCheckedAt', 'attachmentsCode']) {
      if (prev[k] !== undefined && prev[k] !== '') entry[k] = prev[k];
    }
  }
  if (includeComments) {
    // Case files (estimate PDFs) ride on the same per-case pull: same throttle and slot, no extra cycle.
    try {
      // A failed or empty comment read passes null so a comment-sourced list keeps the cached files (review B1).
      Object.assign(entry, await syncAttachments(caseId, commentsCode ? null : comments, _store().get(caseId), tx));
    } catch (e) {
      log.warn('[dtna] attachments', safeErr(e));
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
    // recordId: ListViewDataManager getItems lists its rows under recordIdActionsList[].recordId.
    if (k === 'Id' || k === 'id' || k === 'recordId') {
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

/**
 * _listShape(value) -> shape-only diagnostic for an empty list page: key names (id-like keys masked),
 * array paths with lengths, and counts of 500-prefixed strings by length. Never a value.
 */
function _listShape(value) {
  const arrays = [];
  const idPaths = new Set();
  let ids18 = 0;
  let ids15 = 0;
  const mask = (k) => (/^[A-Za-z0-9]{15,18}$/.test(k) && /\d/.test(k) ? '<id>' : String(k).slice(0, 40));
  const walk = (v, path, depth) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      if (/^500[A-Za-z0-9]{15}$/.test(v)) { ids18++; if (idPaths.size < 6) idPaths.add(path); }
      else if (/^500[A-Za-z0-9]{12}$/.test(v)) { ids15++; if (idPaths.size < 6) idPaths.add(path); }
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (arrays.length < 10) arrays.push({ path: path || '.', len: v.length });
      for (const x of v.slice(0, 200)) walk(x, path + '[]', depth + 1);
      return;
    }
    for (const k of Object.keys(v).slice(0, 60)) walk(v[k], path + '.' + mask(k), depth + 1);
  };
  walk(value, '', 0);
  const top = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 15).map(mask) : [];
  return { type: Array.isArray(value) ? 'array' : typeof value, top, arrays, ids18, ids15, idPaths: Array.from(idPaths) };
}

/** caseNumberFromList(caseId) -> the case number a list read showed for this case | ''. No network. */
function caseNumberFromList(caseId) { return _listNumbers.get(_str(caseId)) || ''; }

/**
 * _listPass(filterOrNull, o) -> {ok:true, ids, pages, templateFilter} | {ok:false, code}
 * Pages through the captured getItems action. filterOrNull overrides filterName / filterId (only keys the
 * template has); null replays the template's own filter verbatim. templateFilter: the template's own
 * filterName before any override (internal only, never logged).
 */
async function _listPass(filter, o) {
  const ids = new Set();
  let paged = false;
  let base = 0;
  let page = 0;
  let size = LIST_PAGE_SIZE;
  let total = null;
  let templateFilter;
  for (let i = 0; i < LIST_MAX_PAGES; i++) {
    const mutate = (p) => {
      if (i === 0) templateFilter = p.filterName;
      if (filter) {
        if ('filterName' in p) p.filterName = filter;
        if ('filterId' in p) p.filterId = filter;
      }
      if ('pageSize' in p && 'currentPage' in p) {
        if (i === 0) base = Number(p.currentPage) || 0;
        paged = true;
        p.pageSize = LIST_PAGE_SIZE;
        p.currentPage = base + page;
      } else if ('pageSize' in p && 'offset' in p) {
        // ListViewDataManager getItems pages by offset; keep the page's own pageSize.
        if (i === 0) {
          base = Number(p.offset) || 0;
          const s = Number(p.pageSize);
          size = Number.isInteger(s) && s > 0 && s <= LIST_PAGE_SIZE ? s : 50;
        }
        paged = true;
        p.pageSize = size;
        p.offset = base + page * size;
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
    if (i === 0 && !got.size) { try { log.info('[dtna] list-shape', _listShape(r.value)); } catch (_) { /* diagnostic only */ } }
    for (const id of got) ids.add(id);
    const v = r.value && typeof r.value === 'object' ? r.value : {};
    if (Number.isFinite(Number(v.totalCount)) && v.totalCount !== null) total = Number(v.totalCount);
    // hasMoreData (ListViewDataManager) is authoritative when present; else a short page ends the list.
    // totalCount is the list total only alongside hasMoreData (other list actions report the page count).
    const lvdm = typeof v.hasMoreData === 'boolean';
    const more = lvdm ? v.hasMoreData : got.size >= size;
    if (!paged || !more || ids.size === before || (lvdm && total != null && total > 0 && ids.size >= total)) break;
    page++;
  }
  return { ok: true, ids: Array.from(ids), pages: page + 1, total, templateFilter };
}

/**
 * listCaseIds({filterId, force, silent}) -> {ok:true, ids} | {ok:false, code}.
 * Lists with filterId, else the all-open-cases list view (C.DEFAULT_LIST_FILTER); when that default pass
 * is empty and the captured template had another filter, one verbatim replay of the template.
 * Non-empty lists memoized 30 min; an empty list is retried on the next call.
 */
async function listCaseIds(opts) {
  const o = opts || {};
  const filterId = typeof o.filterId === 'string' && /^[A-Za-z0-9]{15,18}$/.test(o.filterId) ? o.filterId : '';
  const key = filterId || '-';
  if (!o.force && _listMemo && _listMemo.key === key && _now() - _listMemo.at < LIST_TTL_MS) return { ok: true, ids: _listMemo.ids.slice() };
  let r = await _listPass(filterId || C.DEFAULT_LIST_FILTER, o);
  if (!r.ok) return { ok: false, code: r.code };
  let filter = filterId ? 'custom' : 'default';
  let fallback = false;
  if (!r.ids.length && !filterId && r.templateFilter !== undefined && r.templateFilter !== C.DEFAULT_LIST_FILTER) {
    const r2 = await _listPass(null, o);
    if (r2.ok) { r = r2; filter = 'template'; fallback = true; }
  }
  const list = r.ids;
  if (list.length) _listMemo = { key, at: _now(), ids: list.slice() };
  let info = { entity: null, filter: null };
  try { info = _capture().listInfo() || info; } catch (_) { /* capture unavailable: classification stays null */ }
  let built = false;
  try { built = !!(_aura().listTemplateBuilt && _aura().listTemplateBuilt()); } catch (_) { built = false; }
  if (built) info = { entity: 'Case', filter: 'default' };
  log.info('[dtna] list', { count: list.length, pages: r.pages, total: r.total == null ? null : r.total, filter, fallback, built, entity: info.entity || null, listFilter: info.filter || null });
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
  getChatterEnabled, syncAttachments,
  resolveCaseForRow, bulkPull, toTSV, exportRows, CASE_COLUMNS, COMMENT_COLUMNS, _setDeps, _resetForTests, _listShape,
};
