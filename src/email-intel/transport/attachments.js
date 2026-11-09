'use strict';
/**
 * email-intel/transport/attachments.js — `fetchOne` for attach/extract.analyzeAttachments (design 5.4, FR-2.6).
 *
 *   createFetchOne({ http, itemId, signal }) -> (att, index, { maxBytes, timeoutMs }) ->
 *     { ok:true, buffer, mimetype, bytes } | { ok:false, reason }
 *
 * One bounded GET of the attachment (FileAttachment ContentBytes). The response is capped at
 * ceil(maxBytes * 4/3) + ATTACH_JSON_OVERHEAD (base64 plus JSON) and aborted above it (`too-large`); an attachment
 * whose listed size is already over maxBytes is never requested. Reason codes match attach/fetch.js so the
 * existing policy, budget and re-extract rules apply unchanged. Nothing here logs or keeps the content.
 */
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const E = require('./errors');

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_RE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

function createFetchOne(o) {
  const http = o && o.http;
  const itemId = o && o.itemId;
  const signal = o && o.signal;
  return async function fetchOne(att, _index, lim) {
    const maxBytes = Math.max(1, Math.trunc((lim && lim.maxBytes) || 1));
    const timeoutMs = Math.max(1, Math.min(TC.ATTACH_TIMEOUT_MS, Math.trunc((lim && lim.timeoutMs) || TC.ATTACH_TIMEOUT_MS)));
    if (typeof itemId !== 'string' || !itemId || itemId.length > TC.ITEM_ID_MAX) return { ok: false, reason: 'no-handle' };
    if (!att || att.hasDownloadHandle !== true || typeof att.attId !== 'string' || !att.attId || att.attId.length > TC.ATT_ID_MAX) return { ok: false, reason: 'no-handle' };
    if (Number.isFinite(att.sizeBytes) && att.sizeBytes > maxBytes) return { ok: false, reason: 'too-large' };
    let r;
    try {
      r = await http.request({
        op: 'att-get', method: 'GET', path: endpoints.attachment(itemId, att.attId), retry: 'read', timeoutMs,
        maxBytes: Math.ceil(maxBytes * 4 / 3) + TC.ATTACH_JSON_OVERHEAD, signal,
      });
    } catch (e) {
      if (e instanceof E.ResponseTooLargeError) return { ok: false, reason: 'too-large' };
      if (e instanceof E.ApiAuthBlockedError) return { ok: false, reason: 'auth-wall' };
      if (e instanceof E.ApiTimeoutError) return { ok: false, reason: 'timeout' };
      if (e instanceof E.ApiHttpError) return { ok: false, reason: 'http-error' };
      return { ok: false, reason: 'fetch-failed' };
    }
    const j = r && r.json;
    if (!j || typeof j !== 'object') return { ok: false, reason: 'fetch-failed' };
    const type = typeof j['@odata.type'] === 'string' ? j['@odata.type'] : '';
    if (type && !/FileAttachment$/i.test(type)) return { ok: false, reason: 'no-handle' };
    if (typeof j.ContentBytes !== 'string' || !B64_RE.test(j.ContentBytes)) return { ok: false, reason: 'fetch-failed' };
    const buffer = Buffer.from(j.ContentBytes, 'base64');
    if (buffer.length > maxBytes) return { ok: false, reason: 'too-large' };
    if (!buffer.length) return { ok: false, reason: 'fetch-failed' };
    const mt = typeof j.ContentType === 'string' ? j.ContentType.split(';')[0].trim().slice(0, 80) : '';
    return { ok: true, buffer, mimetype: MIME_RE.test(mt) ? mt.toLowerCase() : '', bytes: buffer.length };
  };
}

module.exports = { createFetchOne };
