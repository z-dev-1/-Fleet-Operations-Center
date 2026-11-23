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
const FIELD_KEYS = ['versionId', 'documentId', 'name', 'ext', 'size', 'createdAt'];

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

function _row(raw, fields, byDoc) {
  if (!_isObj(raw)) return null;
  const f = _isObj(fields) ? fields : {};
  const get = (k) => {
    const key = typeof f[k] === 'string' && f[k] ? f[k] : k;
    const v = _path(raw, key);
    return v != null && typeof v !== 'object' ? v : undefined;
  };
  const versionId = _str(get('versionId')).trim();
  const documentId = _str(get('documentId')).trim();
  const okVersion = C.CONTENT_VERSION_ID_RE.test(versionId);
  const okDoc = C.CONTENT_DOC_ID_RE.test(documentId);
  if (byDoc ? !okDoc : !okVersion) return null;
  const name = _str(get('name')).replace(/[\r\n\t]+/g, ' ').trim().slice(0, NAME_MAX);
  const sz = Number(get('size'));
  const created = _str(get('createdAt')).trim();
  return {
    versionId: okVersion ? versionId : '',
    documentId: okDoc ? documentId : '',
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
  let rows = [];
  if (c.source === 'comments') {
    const field = typeof c.field === 'string' && /^[\w.]{1,80}$/.test(c.field) ? c.field : '';
    if (!field) return [];
    for (const cm of (Array.isArray(rawComments) ? rawComments : [])) {
      if (!_isObj(cm)) continue;
      rows = rows.concat(_asList(_path(cm, field)));
    }
    if (c.listPath) rows = rows.flatMap((r) => _asList(_path(r, c.listPath)));
  } else {
    rows = _asList(_path(value, c.listPath));
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const a = _row(r, c.fields, byDoc);
    if (!a) continue;
    const key = byDoc ? a.documentId : a.versionId;
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
  if (cfg.source === 'comments') return { ok: true, list: parseAttachmentList(null, cfg, rawComments) };
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
  if (!d || typeof d.urlTemplate !== 'string' || !d.urlTemplate) r = { ok: false, code: 'DTNA_ATTACHMENT_DOWNLOAD_NOT_CONFIGURED' };
  else if (!isPdf(a)) r = { ok: false, code: 'DTNA_ATTACHMENT_NOT_PDF' };
  else if (Number.isFinite(a.size) && a.size > C.ATTACHMENT_MAX_BYTES) { r = { ok: false, code: 'DTNA_ATTACHMENT_TOO_LARGE' }; bytes = a.size; }
  else {
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
