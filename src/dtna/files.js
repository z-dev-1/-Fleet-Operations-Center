'use strict';
/**
 * src/dtna/files.js — DTNA case attachments: parse the configured file list and download one PDF through
 * the authenticated persist:vendor-dtna session (the same session the Aura calls use).
 *
 * The list read and the download URL come from constants.ATTACHMENT_LIST_READ / ATTACHMENT_DOWNLOAD; while
 * they are null nothing is requested (DTNA_ATTACHMENTS_NOT_CONFIGURED / DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED).
 * Only PDFs are downloaded, never more than ATTACHMENT_MAX_BYTES (declared size, content-length and the
 * streamed body are all checked), and the bytes must start with '%PDF-'.
 * This is the only module under src/dtna that downloads a file.
 * One log line per download: { caseTag, kind, bytesBucket, code, status, ms }. Never the file name, URL,
 * ids, bytes or text.
 */
const C = require('./constants');
const { caseTag, safeErr } = require('./redact');
const { safeJson } = require('./safe-json');
const log = require('../utils/logger')('dtna');

// Test seam: { aura, session, fetch, listConfig, downloadConfig, now }.
let _deps = {};
function _setDeps(d) { _deps = d || {}; }
function _aura() { return _deps.aura || require('./aura'); }
function _session() { return _deps.session || require('./session'); }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _listConfig() { return Object.prototype.hasOwnProperty.call(_deps, 'listConfig') ? _deps.listConfig : C.ATTACHMENT_LIST_READ; }
function _downloadConfig() { return Object.prototype.hasOwnProperty.call(_deps, 'downloadConfig') ? _deps.downloadConfig : C.ATTACHMENT_DOWNLOAD; }

const NAME_MAX = 120;
const FIELD_KEYS = ['versionId', 'documentId', 'attId', 'name', 'ext', 'size', 'createdAt'];
const INTERNAL_SUFFIX = '_internal';

function _str(v) { return v == null ? '' : String(v); }
function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function _path(obj, dotted) {
  if (!dotted) return obj;
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function _extOf(ext, name) {
  const e = _str(ext).trim().replace(/^\./, '').toLowerCase();
  if (/^[a-z0-9]{1,10}$/.test(e)) return e;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(_str(name).trim());
  return m ? m[1].toLowerCase() : '';
}

function _usesDocumentId() {
  const d = _downloadConfig();
  return !!(d && typeof d.urlTemplate === 'string' && d.urlTemplate.includes('{documentId}'));
}

function _isApexDownload(d) {
  return _isObj(d) && d.source === 'apex' && _isObj(d.internal) && _isObj(d.external);
}

function _row(raw, fields, byDoc, fallbackCreatedAt) {
  if (!_isObj(raw)) return null;
  const f = _isObj(fields) ? fields : {};
  const get = (k) => {
    const key = typeof f[k] === 'string' && f[k] ? f[k] : k;
    const v = _path(raw, key);
    return v != null && typeof v !== 'object' ? v : undefined;
  };
  let versionId = _str(get('versionId')).trim();
  const documentId = _str(get('documentId')).trim();
  // A UTP comment attachment id (only when the list config maps one): '<068 id>_internal' also names the
  // ContentVersion; any other value is an external UTP attachment id.
  const rawAtt = typeof f.attId === 'string' && f.attId ? _str(get('attId')).trim() : '';
  const attId = C.ATTACHMENT_ID_RE.test(rawAtt) ? rawAtt : '';
  if (attId.endsWith(INTERNAL_SUFFIX) && !C.CONTENT_VERSION_ID_RE.test(versionId)) {
    const v = attId.slice(0, -INTERNAL_SUFFIX.length);
    if (C.CONTENT_VERSION_ID_RE.test(v)) versionId = v;
  }
  const okVersion = C.CONTENT_VERSION_ID_RE.test(versionId);
  const okDoc = C.CONTENT_DOC_ID_RE.test(documentId);
  if (!attId && (byDoc ? !okDoc : !okVersion)) return null;
  const name = _str(get('name')).replace(/[\r\n\t]+/g, ' ').trim().slice(0, NAME_MAX);
  const sz = Number(get('size'));
  const created = _str(get('createdAt')).trim() || _str(fallbackCreatedAt).trim();
  return {
    versionId: okVersion ? versionId : '',
    documentId: okDoc ? documentId : '',
    attId,
    name,
    ext: _extOf(get('ext'), name),
    size: Number.isFinite(sz) && sz >= 0 ? Math.round(sz) : null,
    createdAt: Number.isFinite(Date.parse(created)) ? created.slice(0, 40) : '',
  };
}

function _asList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) { const j = safeJson(v); return j.ok ? _asList(j.value) : []; }
  if (_isObj(v)) return [v];
  return [];
}

/**
 * parseAttachmentList(value, cfg, rawComments?) -> [{ versionId, documentId, name, ext, size, createdAt }]
 * source 'apex': walks cfg.listPath (dotted) of the read's value. source 'comments': reads cfg.field off each
 * raw comment row (a JSON string, an array or an object). Rows without a valid ContentVersion id (or
 * ContentDocument id when the download template uses {documentId}) are dropped; dedup; capped.
 */
function parseAttachmentList(value, cfg, rawComments) {
  const c = _isObj(cfg) ? cfg : {};
  const byDoc = _usesDocumentId();
  // rows: [{ raw, at }] — at = the comment row's date (cfg.rowCreatedAt) for files that carry none.
  let rows = [];
  if (c.source === 'comments') {
    const field = typeof c.field === 'string' && /^[\w.]{1,80}$/.test(c.field) ? c.field : '';
    if (!field) return [];
    const atKey = typeof c.rowCreatedAt === 'string' && /^[\w.]{1,80}$/.test(c.rowCreatedAt) ? c.rowCreatedAt : '';
    for (const cm of (Array.isArray(rawComments) ? rawComments : [])) {
      if (!_isObj(cm)) continue;
      const atV = atKey ? _path(cm, atKey) : '';
      const at = typeof atV === 'string' ? atV : '';
      let list = _asList(_path(cm, field));
      if (c.listPath) list = list.flatMap((r) => _asList(_path(r, c.listPath)));
      rows = rows.concat(list.map((raw) => ({ raw, at })));
    }
  } else {
    rows = _asList(_path(value, c.listPath)).map((raw) => ({ raw, at: '' }));
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const a = _row(r.raw, c.fields, byDoc, r.at);
    if (!a) continue;
    const key = a.attId ? 'att:' + a.attId : (byDoc ? a.documentId : a.versionId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
    if (out.length >= C.ATTACHMENT_LIST_MAX) break;
  }
  return out;
}

/**
 * listAttachments(caseId, rawComments, {silent}) -> {ok:true, list} | {ok:false, code}
 * Not configured -> DTNA_ATTACHMENTS_NOT_CONFIGURED with zero requests. source 'comments' makes no request.
 */
async function listAttachments(caseId, rawComments, opts) {
  const cfg = _listConfig();
  if (!_isObj(cfg) || (cfg.source !== 'apex' && cfg.source !== 'comments')) return { ok: false, code: 'DTNA_ATTACHMENTS_NOT_CONFIGURED' };
  if (!C.CASE_ID_RE.test(_str(caseId))) return { ok: false, code: 'DTNA_INVALID_INPUT' };
  if (cfg.source === 'comments') {
    // No comment rows (the read failed or came back empty over a cached thread): the caller keeps its list.
    if (!Array.isArray(rawComments)) return { ok: false, code: 'DTNA_COMMENTS_UNAVAILABLE' };
    return { ok: true, list: parseAttachmentList(null, cfg, rawComments) };
  }
  const r = await _aura().listAttachmentsRaw(caseId, opts && opts.silent ? { silent: true } : undefined);
  if (!r || !r.ok) return { ok: false, code: _str((r && r.code) || 'DTNA_INTERNAL').slice(0, 40) };
  return { ok: true, list: parseAttachmentList(r.value, cfg) };
}

function isPdf(att) {
  const a = att || {};
  return a.ext === 'pdf' || (!a.ext && /\.pdf$/i.test(_str(a.name)));
}

function _bucket(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1024 * 1024) return '<1MB';
  if (n < 5 * 1024 * 1024) return '<5MB';
  if (n <= C.ATTACHMENT_MAX_BYTES) return '<=15MB';
  return '>15MB';
}

/** downloadUrl(att) -> the configured download URL for att | '' (not configured, bad id, other host). */
function downloadUrl(att) {
  const d = _downloadConfig();
  const tpl = d && typeof d.urlTemplate === 'string' ? d.urlTemplate : '';
  if (!tpl) return '';
  const a = att || {};
  let url;
  if (tpl.includes('{versionId}')) {
    if (!C.CONTENT_VERSION_ID_RE.test(_str(a.versionId))) return '';
    url = tpl.split('{versionId}').join(a.versionId);
  } else if (tpl.includes('{documentId}')) {
    if (!C.CONTENT_DOC_ID_RE.test(_str(a.documentId))) return '';
    url = tpl.split('{documentId}').join(a.documentId);
  } else return '';
  if (/[{}]/.test(url)) return '';
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === C.HOST ? u.href : '';
  } catch (_) { return ''; }
}

function _fetchFn() {
  if (typeof _deps.fetch === 'function') return _deps.fetch;
  const ses = _session().getSession();
  return (url, init) => ses.fetch(url, init);
}

function _isLoginUrl(url) {
  try { return C.LOGIN_HOST_RE.test(new URL(String(url || '')).hostname); } catch (_) { return false; }
}

async function _readCapped(res, ac) {
  const max = C.ATTACHMENT_MAX_BYTES;
  const body = res && res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const b = Buffer.from(value);
      total += b.length;
      if (total > max) {
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        try { ac.abort(); } catch (_) { /* ignore */ }
        return { tooLarge: true, total };
      }
      chunks.push(b);
    }
    return { buffer: Buffer.concat(chunks), total };
  }
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (buf.length > max) return { tooLarge: true, total: buf.length };
  return { buffer: buf, total: buf.length };
}

// Base64 length that decodes to more than ATTACHMENT_MAX_BYTES.
const B64_MAX = Math.ceil(C.ATTACHMENT_MAX_BYTES / 3) * 4 + 4;

/**
 * _apexDownload(cfg, att, {caseId, silent}) -> { r: {ok:true, buffer} | {ok:false, code}, bytes }
 * The portal's own rule (c:e2E_CaseComments handleAttachmentClick): attId '<068>_internal' (or a bare
 * ContentVersion id) -> internal.method({ recordId }); any other attId -> external.method({ caseId, attId }).
 * Both return the file as a base64 string. Reads through aura.callApex (READ_METHODS allowlist).
 */
async function _apexDownload(cfg, att, opts) {
  const caseId = _str(opts && opts.caseId);
  const attId = _str(att.attId);
  const internal = attId ? attId.endsWith(INTERNAL_SUFFIX) : C.CONTENT_VERSION_ID_RE.test(_str(att.versionId));
  const method = _str(internal ? cfg.internal.method : cfg.external.method);
  let params;
  if (internal) {
    const vid = attId ? attId.slice(0, -INTERNAL_SUFFIX.length) : _str(att.versionId);
    if (!C.CONTENT_VERSION_ID_RE.test(vid)) return { r: { ok: false, code: 'DTNA_INVALID_INPUT' }, bytes: 0 };
    params = { recordId: vid };
  } else {
    if (!C.CASE_ID_RE.test(caseId) || !C.ATTACHMENT_ID_RE.test(attId)) return { r: { ok: false, code: 'DTNA_INVALID_INPUT' }, bytes: 0 };
    params = { caseId, attId };
  }
  let res;
  try {
    res = await _aura().callApex(method, params, opts && opts.silent ? { silent: true } : undefined);
  } catch (e) {
    log.warn('[dtna] attachment', safeErr(e));
    return { r: { ok: false, code: 'DTNA_INTERNAL' }, bytes: 0 };
  }
  if (!res || !res.ok) return { r: { ok: false, code: _str((res && res.code) || 'DTNA_INTERNAL').slice(0, 40) }, bytes: 0 };
  let b64 = typeof res.value === 'string' ? res.value : '';
  const comma = b64.startsWith('data:') ? b64.indexOf(',') : -1;
  if (comma >= 0) b64 = b64.slice(comma + 1);
  if (!b64) return { r: { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' }, bytes: 0 };
  if (b64.length > B64_MAX) return { r: { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' }, bytes: Math.floor(b64.length * 3 / 4) };
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64.slice(0, 4096))) return { r: { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' }, bytes: 0 };
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length > C.ATTACHMENT_MAX_BYTES) return { r: { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' }, bytes: buffer.length };
  if (buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') return { r: { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' }, bytes: buffer.length };
  return { r: { ok: true, buffer }, bytes: buffer.length };
}

/**
 * downloadPdf(att, {caseId}) -> {ok:true, buffer} | {ok:false, code}
 * Codes: DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED, DTNA_ATTACHMENT_NOT_PDF, DTNA_ATTACHMENT_TOO_LARGE,
 * DTNA_SESSION_EXPIRED, DTNA_HTTP_ERROR, DTNA_TIMEOUT, DTNA_NETWORK, DTNA_INVALID_INPUT.
 */
async function downloadPdf(att, opts) {
  const t0 = _now();
  const tag = caseTag(_str(opts && opts.caseId));
  const a = att || {};
  let r;
  let status;
  let bytes = 0;
  const d = _downloadConfig();
  const apex = _isApexDownload(d);
  if (!apex && (!d || typeof d.urlTemplate !== 'string' || !d.urlTemplate)) r = { ok: false, code: 'DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED' };
  else if (!isPdf(a)) r = { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' };
  else if (Number.isFinite(a.size) && a.size > C.ATTACHMENT_MAX_BYTES) { r = { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' }; bytes = a.size; }
  else if (apex) {
    const x = await _apexDownload(d, a, opts);
    r = x.r;
    bytes = x.bytes;
  } else {
    const url = downloadUrl(a);
    if (!url) r = { ok: false, code: 'DTNA_INVALID_INPUT' };
    else {
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch (_) {} }, C.ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        const res = await _fetchFn()(url, { method: 'GET', credentials: 'include', redirect: 'manual', headers: { Accept: 'application/pdf,*/*' }, signal: ac.signal });
        status = res ? res.status : 0;
        let location = '';
        try { location = res && res.headers && typeof res.headers.get === 'function' ? (res.headers.get('location') || '') : ''; } catch (_) { location = ''; }
        let len = NaN;
        try { len = Number(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN); } catch (_) { len = NaN; }
        if (res && res.type === 'opaqueredirect') r = { ok: false, code: 'DTNA_SESSION_EXPIRED' };
        else if (status === 401) r = { ok: false, code: 'DTNA_SESSION_EXPIRED' };
        else if (status >= 300 && status < 400) r = { ok: false, code: _isLoginUrl(location) ? 'DTNA_SESSION_EXPIRED' : 'DTNA_HTTP_ERROR' };
        else if (status !== 200) r = { ok: false, code: 'DTNA_HTTP_ERROR' };
        else if (Number.isFinite(len) && len > C.ATTACHMENT_MAX_BYTES) {
          try { ac.abort(); } catch (_) { /* ignore */ }
          bytes = len;
          r = { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' };
        } else {
          const body = await _readCapped(res, ac);
          bytes = body.total;
          if (body.tooLarge) r = { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' };
          else if (body.buffer.length < 5 || body.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') r = { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' };
          else r = { ok: true, buffer: body.buffer };
        }
      } catch (e) {
        if (timedOut) r = { ok: false, code: 'DTNA_TIMEOUT' };
        else if (e && e.name === 'AbortError') r = { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' };
        else { log.warn('[dtna] attachment', safeErr(e)); r = { ok: false, code: 'DTNA_NETWORK' }; }
      } finally {
        clearTimeout(timer);
      }
    }
  }
  log.info('[dtna] attachment', { caseTag: tag, kind: 'pdf', bytesBucket: _bucket(bytes), code: r.ok ? 'OK' : r.code, status, ms: _now() - t0 });
  return r;
}

module.exports = { parseAttachmentList, listAttachments, downloadPdf, downloadUrl, isPdf, FIELD_KEYS, _setDeps };
