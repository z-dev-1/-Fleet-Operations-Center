'use strict';
/**
 * rca/client.js — Relay template API client for AAP's Root Cause Analysis form.
 *
 * Endpoints (base https://track.relay.amazon.dev, ?region=us-east-1), taken
 * from Relay's own template repository class (bundle chunk 5630):
 *   GET  /api/template/{templateId}                     template + fields
 *   GET  /api/template/response/reference/{referenceId} saved responses for a WR
 *   POST /api/template/response                         create a response
 *   PUT  /api/template/response/{responseId}            update a response
 * Create/update body: { relatedTemplateId, relatedTemplateName,
 *   relatedTemplateVersion, response, referenceId }. referenceId = the AAP WR
 * (service aggregate) id — the id in /v2/service/<id>.
 *
 * Auth = the app's Midway session: a Midway id_token for aap-na (the same
 * audience the AAP page's own calls carry) is minted from ~/.midway/cookie
 * (rca/midway_token.js) and sent as `Authorization: Bearer`, with
 * Origin aap-na as the browser does. No hidden window, no login page.
 */

const https = require('https');
const zlib = require('zlib');
const midwayToken = require('./midway_token');
const logger = require('../utils/logger')('rca');

const TEMPLATE_ID = 'root-cause-analysis';
const REGION = 'us-east-1';
const TEMPLATE_TTL_MS = 6 * 60 * 60 * 1000;
const RELAY_HOST = 'track.relay.amazon.dev';
const TOKEN_CLIENT = 'aap-na.corp.amazon.com';
const AAP_ORIGIN = 'https://' + TOKEN_CLIENT;

let _template = null; // { tpl, at }

const _isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));

function _send(method, path, body, token) {
  const data = body != null ? JSON.stringify(body) : null;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Authorization: 'Bearer ' + token,
    Origin: AAP_ORIGIN,
    Referer: AAP_ORIGIN + '/',
  };
  if (data != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: RELAY_HOST, path, method, headers, timeout: 30000 }, (res) => {
      // Relay compresses responses even when not asked (verified: gzip body on
      // a request with no Accept-Encoding) — decode by Content-Encoding.
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (enc.includes('gzip')) stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('br')) stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', (e) => reject(Object.assign(e, { code: 'RELAY_NETWORK' })));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Relay API timed out'), { code: 'RELAY_TIMEOUT' })));
    req.on('error', (e) => reject(Object.assign(e, { code: e.code === 'RELAY_TIMEOUT' ? 'RELAY_TIMEOUT' : 'RELAY_NETWORK' })));
    if (data != null) req.write(data);
    req.end();
  });
}

// One Relay call. A 401 means the request was NOT processed, so it is safe to
// re-mint the token once and retry — even for writes. Anything else (incl. a
// timeout on a write) is never retried, so a save can't be sent twice.
// A 200 that returns HTML (Relay's SPA fallback for unknown paths) is an error.
async function _relay(method, path, body) {
  let token = await midwayToken.getIdToken(TOKEN_CLIENT);
  let r = await _send(method, path, body, token);
  if (r.status === 401) {
    logger.warn('[rca] ' + method + ' ' + path.split('?')[0] + ' got 401 — re-minting the Midway token once');
    midwayToken.clear(TOKEN_CLIENT);
    token = await midwayToken.getIdToken(TOKEN_CLIENT, { force: true });
    r = await _send(method, path, body, token);
  }
  let json = null;
  try { json = r.text ? JSON.parse(r.text) : null; } catch (_) {}
  if (r.status >= 200 && r.status < 300 && (json !== null || r.text === '')) return json;
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(new Error('Relay API ' + r.status + ' (not authorized for the RCA form)'), { code: 'RELAY_UNAUTHORIZED', status: r.status });
  }
  let detail = /<!doctype html/i.test(r.text || '') ? 'HTML page returned (unknown endpoint)' : String(r.text || '').slice(0, 300);
  if (json && json.message) detail = json.message;
  throw Object.assign(new Error('Relay API ' + r.status + ': ' + detail), { code: 'RELAY_API_ERROR', status: r.status });
}

// The RCA form definition (cached; opts.force re-fetches).
async function getTemplate(opts = {}) {
  if (!opts.force && _template && (Date.now() - _template.at) < TEMPLATE_TTL_MS) return _template.tpl;
  const tpl = await _relay('GET', '/api/template/' + encodeURIComponent(TEMPLATE_ID) + '?region=' + REGION);
  if (!tpl || !Array.isArray(tpl.fields) || !tpl.fields.length) {
    throw Object.assign(new Error('RCA template came back without fields'), { code: 'RCA_TEMPLATE_INVALID' });
  }
  _template = { tpl, at: Date.now() };
  return tpl;
}

// All saved template responses for one WR (follows continuationToken, bounded).
async function getResponses(referenceId) {
  const id = String(referenceId || '').trim();
  if (!_isId(id)) throw new Error('getResponses: invalid WR id');
  const out = [];
  let token = null;
  for (let page = 0; page < 5; page++) {
    const q = '?region=' + REGION + (token ? '&continuationToken=' + encodeURIComponent(token) : '');
    const res = await _relay('GET', '/api/template/response/reference/' + encodeURIComponent(id) + q);
    const list = (res && Array.isArray(res.responses)) ? res.responses : [];
    out.push(...list);
    token = res && res.continuationToken;
    if (!token) break;
  }
  return out;
}

function responseIdOf(r) {
  return (r && (r.responseId || r.templateResponseId || r.id)) || null;
}
function _respTime(r) {
  const t = r && (r.modifiedOn || r.createdOn || r.submittedOn || r.modifiedAt || r.createdAt);
  const n = t ? Date.parse(t) : NaN;
  return isNaN(n) ? 0 : n;
}

// The newest saved (manual) RCA response for a WR, or null. AAP keeps one RCA
// per work order, matched on response.workOrderNumber — pass
// opts.workOrderNumber to find the one for a specific work order. System
// responses (relatedTemplateId "root-cause-analysis-automated") are ignored.
async function findRcaResponse(referenceId, opts = {}) {
  const list = await getResponses(referenceId);
  let rca = list.filter((r) => r && r.relatedTemplateId === TEMPLATE_ID && r.response);
  if (opts.workOrderNumber) {
    rca = rca.filter((r) => String(r.response.workOrderNumber || '') === String(opts.workOrderNumber));
  }
  if (!rca.length) return null;
  rca.sort((a, b) => _respTime(b) - _respTime(a));
  return rca[0];
}

// All manual RCA responses for a WR (one per work order).
async function listRcaResponses(referenceId) {
  const list = await getResponses(referenceId);
  return list.filter((r) => r && r.relatedTemplateId === TEMPLATE_ID && r.response);
}

/**
 * submitResponse(referenceId, response, opts) -> saved response object.
 * opts.responseId -> PUT (update) instead of POST (create).
 * `response` must already be normalized (rca/template.normalizeResponse).
 */
async function submitResponse(referenceId, response, opts = {}) {
  const id = String(referenceId || '').trim();
  if (!_isId(id)) throw new Error('submitResponse: invalid WR id');
  const tpl = await getTemplate();
  const body = {
    relatedTemplateId: tpl.templateId || TEMPLATE_ID,
    relatedTemplateName: tpl.templateName,
    relatedTemplateVersion: tpl.version,
    response,
    referenceId: id,
  };
  const rid = opts.responseId ? String(opts.responseId) : null;
  logger.info('[rca] ' + (rid ? 'PUT update ' + rid : 'POST create') + ' for WR ' + id + ' (' + Object.keys(response || {}).length + ' fields)');
  const saved = rid
    ? await _relay('PUT', '/api/template/response/' + encodeURIComponent(rid) + '?region=' + REGION, body)
    : await _relay('POST', '/api/template/response?region=' + REGION, body);
  return saved || {};
}

module.exports = { TEMPLATE_ID, REGION, getTemplate, getResponses, findRcaResponse, listRcaResponses, submitResponse, responseIdOf };
