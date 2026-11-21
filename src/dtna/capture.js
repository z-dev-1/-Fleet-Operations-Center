'use strict';
/**
 * src/dtna/capture.js — passive CDP capture of the DTNA portal's own Aura POSTs.
 *
 * The portal page (visible sign-in window or the hidden refresh window) issues its own aura POSTs.
 * From those we keep aura.context, aura.token, aura.pageURI and the list's getItems action, in this
 * module's memory only (never persisted, never logged, never returned over IPC). Values commit only
 * after the matching response holds a SUCCESS action, so a signed-out page never "connects".
 * observedApex keeps class / method / param KEY names the page used (no values).
 * Never listens to the page console (the portal prints its OIDC token to the console).
 */
const C = require('./constants');
const { safeErr } = require('./redact');
const { safeJson } = require('./safe-json');
const log = require('../utils/logger')('dtna');

const ORIGIN = 'https://' + C.HOST;
const APEX_DESCRIPTOR = 'aura://ApexActionController/ACTION$execute';

let _ctx = null;        // { context, token, pageURI, capturedAt }
let _getItems = null;   // { query, action }
const _observed = new Map(); // method -> { classname, paramKeys }

function _parseEnvelope(text) { return require('./aura').parseEnvelope(text); }

function _isAuraPost(rq) {
  if (!rq || String(rq.method || '').toUpperCase() !== 'POST') return false;
  let u;
  try { u = new URL(String(rq.url || '')); } catch (_) { return null; }
  if (u.origin !== ORIGIN || u.pathname !== C.AURA_PATH) return null;
  return u;
}

function _readPost(u, body) {
  const p = new URLSearchParams(String(body || ''));
  const out = { context: p.get('aura.context'), token: p.get('aura.token'), pageURI: p.get('aura.pageURI'), getItems: null };
  const m = safeJson(p.get('message') || '');
  const actions = m.ok && m.value && Array.isArray(m.value.actions) ? m.value.actions : [];
  for (const a of actions) {
    if (!a || typeof a !== 'object' || typeof a.descriptor !== 'string') continue;
    if (a.descriptor === APEX_DESCRIPTOR && a.params && typeof a.params === 'object') {
      const cls = typeof a.params.classname === 'string' ? a.params.classname.slice(0, 80) : '';
      const meth = typeof a.params.method === 'string' ? a.params.method.slice(0, 80) : '';
      if (/^\w+$/.test(cls) && /^\w+$/.test(meth)) {
        const pk = a.params.params && typeof a.params.params === 'object' ? Object.keys(a.params.params).slice(0, 20).map((k) => String(k).slice(0, 40)) : [];
        _observed.set(meth, { classname: cls, paramKeys: pk });
      }
    } else if (/ACTION\$getItems$/.test(a.descriptor)) {
      const copy = safeJson(JSON.stringify(a));
      if (copy.ok) out.getItems = { query: u.search, action: copy.value };
    }
  }
  return out;
}

function _anySuccess(envelope) {
  const v = envelope && envelope.ok ? envelope.value : null;
  return !!(v && Array.isArray(v.actions) && v.actions.some((a) => a && a.state === 'SUCCESS'));
}

/** createCapture(webContents, { onSuccess }) -> { attach, detach } */
function createCapture(webContents, opts) {
  const dbg = webContents && webContents.debugger;
  const onSuccess = opts && typeof opts.onSuccess === 'function' ? opts.onSuccess : null;
  const reqs = new Map(); // requestId -> { pending, values }
  let listening = false;

  function _onRequest(params) {
    const rq = params && params.request;
    const u = _isAuraPost(rq);
    if (!u) return;
    const entry = { values: null, pending: null };
    if (typeof rq.postData === 'string' && rq.postData) {
      entry.values = _readPost(u, rq.postData);
    } else if (rq.hasPostData === true) {
      entry.pending = Promise.resolve()
        .then(() => dbg.sendCommand('Network.getRequestPostData', { requestId: params.requestId }))
        .then((r) => { entry.values = r && typeof r.postData === 'string' ? _readPost(u, r.postData) : null; })
        .catch((e) => { entry.values = null; log.warn('[dtna] capture', safeErr(e)); });
    }
    reqs.set(params.requestId, entry);
  }

  async function _onFinished(params) {
    const entry = reqs.get(params && params.requestId);
    if (!entry) return;
    reqs.delete(params.requestId);
    try {
      const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      let text = r && typeof r.body === 'string' ? r.body : '';
      if (r && r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
      if (entry.pending) { try { await entry.pending; } catch (_) {} }
      const v = entry.values;
      if (!v || !v.context || !_anySuccess(_parseEnvelope(text))) return;
      _ctx = { context: v.context, token: v.token || '', pageURI: v.pageURI || '', capturedAt: Date.now() };
      if (v.getItems) _getItems = v.getItems;
      if (onSuccess) { try { onSuccess(); } catch (e) { log.warn('[dtna] capture', safeErr(e)); } }
    } catch (e) {
      log.warn('[dtna] capture', safeErr(e));
    }
  }

  function onMessage(_e, method, params) {
    try {
      if (method === 'Network.requestWillBeSent') _onRequest(params);
      else if (method === 'Network.loadingFinished') {
        _onFinished(params).catch((e) => { try { log.warn('[dtna] capture', safeErr(e)); } catch (_) {} });
      } else if (method === 'Network.loadingFailed') {
        reqs.delete(params && params.requestId);
      }
    } catch (e) {
      try { log.warn('[dtna] capture', safeErr(e)); } catch (_) {}
    }
  }

  return {
    /** attach() — debugger.attach('1.3') + Network.enable. Throws when attach fails. */
    attach() {
      if (!dbg.isAttached()) dbg.attach('1.3');
      if (!listening) { dbg.on('message', onMessage); listening = true; }
      Promise.resolve()
        .then(() => dbg.sendCommand('Network.enable', { maxPostDataSize: 65536 }))
        .catch((e) => { try { log.warn('[dtna] capture', safeErr(e)); } catch (_) {} });
    },
    /** detach() — stop listening; captured values stay (they belong to the partition, not the window). */
    detach() {
      try { if (listening) dbg.removeListener('message', onMessage); } catch (e) { log.warn('[dtna] capture', safeErr(e)); }
      listening = false;
      reqs.clear();
      try { if (dbg.isAttached()) dbg.detach(); } catch (e) { log.warn('[dtna] capture', safeErr(e)); }
    },
  };
}

/** current() -> { context, token, pageURI, capturedAt } | null. For src/dtna/aura.js only. */
function current() { return _ctx ? Object.assign({}, _ctx) : null; }

/** getItemsTemplate() -> { query, action } (deep copy) | null. */
function getItemsTemplate() {
  if (!_getItems) return null;
  const c = safeJson(JSON.stringify(_getItems.action));
  return c.ok ? { query: _getItems.query, action: c.value } : null;
}

/** classFor(method) -> the E2E_* class the page was seen calling for this method | null. */
function classFor(method) {
  const o = _observed.get(String(method));
  return o && /^E2E_\w+$/.test(o.classname) ? o.classname : null;
}

function ageMs() { return _ctx ? Math.max(0, Date.now() - _ctx.capturedAt) : Infinity; }

/** clear() — drop the captured context and list template (observed method names stay). */
function clear() { _ctx = null; _getItems = null; }

/** describe() -> booleans, numbers and method names only. */
function describe() {
  const a = ageMs();
  return {
    hasContext: !!_ctx,
    ageSec: Number.isFinite(a) ? Math.round(a / 1000) : null,
    hasGetItems: !!_getItems,
    observedMethods: Array.from(_observed.keys()).sort(),
  };
}

function _resetForTests() { _ctx = null; _getItems = null; _observed.clear(); }

module.exports = { createCapture, current, getItemsTemplate, classFor, ageMs, clear, describe, _resetForTests };
