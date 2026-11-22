'use strict';
/**
 * dev/dev-aperia-probe.js — DEV-ONLY, env-gated, READ-ONLY live discovery probe for Aperia HALO Connect
 * (task brief "LIVE DISCOVERY": REST shapes, WS-token mint, live WebSocket message format).
 *
 * Inert unless process.env.FLEET_DEV_APERIA_PROBE === '1'. When set, start() opens the Aperia sign-in
 * window (src/aperia/session.js, persist:aperia) a few seconds after launch, attaches a passive CDP
 * observer to that window before its first load, and runs ONCE after the first captured Bearer
 * (status 'connected'). Never required by product code.
 *
 * READ-ONLY everywhere:
 *  - (a) three GETs through src/aperia/transport.js (GET-only; forbidden endpoints rejected there):
 *    vehicles page 0, one vehicle detail, issues/by/vehicle page 0. Key shapes and counts only.
 *  - (b) the portal's own script bundles are read from CDP (Network.getResponseBody), falling back to a
 *    plain GET of the same static asset. Snippets around notifications/token and ws/events, redacted.
 *  - (c) the WS-token mint is tried ONCE and only when the bundle shows a GET with literal params.
 *    A POST mint is never sent: its shape is recorded only. Nothing is ever written to Aperia.
 *  - (d) the portal's own WebSocket frames are observed (Network.webSocket*), up to WS_WATCH_MS.
 *  - No page console listener, no webRequest listener, no clicks or typing in the page.
 *
 * Output: <getDataDir()>/dev/aperia-probe-<YYYY-MM-DD>.json, run through buildOutput() (Bearer,
 * x-authorization, cookies, JWTs, emails and phone numbers redacted; URLs keep query NAMES only).
 * The logger gets counts only, and always a `[aperia-probe] done ...` line.
 */
const fs = require('fs');
const path = require('path');
const C = require('../aperia/constants');
const { shapeOf, redactText, redactDeep, redactUrl, pathPattern } = require('../aperia/redact');
const { safeJson } = require('../aperia/safe-json');

const ENV_FLAG = 'FLEET_DEV_APERIA_PROBE';
const OPEN_DELAY_MS = 8000;
const WS_WATCH_MS = 3 * 60e3;
const RUN_TIMEOUT_MS = 6 * 60e3;
const MAX_FRAMES = 12;
const MAX_SCRIPTS = 40;
const BODY_MAX = 25 * 1024 * 1024;
const BUNDLE_TERMS = Object.freeze(['notifications/token', 'ws/events', 'x-authorization', 'new WebSocket']);
const SITES_PER_TERM = 6;
const EVENT_KEY_RE = /^(type|event|eventType|event_type|eventName|action|topic|channel|destination|kind|messageType|message_type|subject|op|command|category|severity|state)$/i;
const STOMP_RE = /^(CONNECT|CONNECTED|STOMP|SEND|SUBSCRIBE|UNSUBSCRIBE|MESSAGE|RECEIPT|ERROR|ACK|NACK|DISCONNECT)\r?\n/;

// ── pure helpers (unit-tested) ─────────────────────────────────────────────
function _balanced(t, open) {
  const o = t[open];
  const cl = o === '{' ? '}' : o === '(' ? ')' : ']';
  let depth = 0;
  let q = '';
  for (let i = open; i < t.length && i < open + 6000; i++) {
    const ch = t[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === o) depth++;
    else if (ch === cl) { depth--; if (depth === 0) return t.slice(open, i + 1); }
  }
  return '';
}

/** _entries('{a:"x",b:y}') -> [{ key, value, literal }] at depth 0. */
function _entries(obj) {
  const body = obj.slice(1, -1);
  const parts = [];
  let depth = 0;
  let q = '';
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (q) { cur += ch; if (ch === '\\') { cur += body[i + 1] || ''; i++; } else if (ch === q) q = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; cur += ch; continue; }
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const p of parts.slice(0, 20)) {
    const m = /^\s*["']?([\w$-]{1,60})["']?\s*(?::\s*([\s\S]*))?$/.exec(p);
    if (!m) continue;
    const raw = (m[2] == null ? m[1] : m[2]).replace(/\s+/g, ' ').trim();
    const lit = /^(["'`])([^"'`\\]{0,80})\1$/.exec(raw) || /^(-?\d{1,12}|true|false|!0|!1)$/.exec(raw);
    out.push({ key: m[1], value: redactText(raw).slice(0, 160), literal: !!lit, literalValue: lit ? (lit[2] !== undefined ? lit[2] : lit[1]) : null });
  }
  return out;
}

function _excerpt(t, at, before, after) {
  return redactText(t.slice(Math.max(0, at - before), at + after).replace(/\s+/g, ' ')).slice(0, before + after);
}

/**
 * analyzeBundle(text) -> { sites: { term: [excerpt] }, mint: [{ method, queryLiteral, params, excerpt }] }
 * Zero calls: reads bundle text only. Snippets are redacted (tokens, emails, phones).
 */
function analyzeBundle(text) {
  const t = String(text || '');
  const sites = {};
  for (const term of BUNDLE_TERMS) {
    const arr = [];
    let i = 0;
    while ((i = t.indexOf(term, i)) >= 0 && arr.length < SITES_PER_TERM) {
      arr.push(_excerpt(t, i, 500, 700));
      i += term.length + 200;
    }
    if (arr.length) sites[term] = arr;
  }
  const mint = [];
  let i = 0;
  const term = 'notifications/token';
  while ((i = t.indexOf(term, i)) >= 0 && mint.length < SITES_PER_TERM) {
    const before = t.slice(Math.max(0, i - 300), i);
    const after = t.slice(i, i + 600);
    let method = 'unknown';
    const near = before.slice(-160) + after.slice(0, 240);
    if (/\.post\s*\(\s*[`"'][^`"']*$/i.test(before) || /method\s*:\s*["']post["']/i.test(near)) method = 'POST';
    else if (/\.put\s*\(\s*[`"'][^`"']*$/i.test(before) || /\.patch\s*\(\s*[`"'][^`"']*$/i.test(before)) method = 'WRITE';
    else if (/\.get\s*\(\s*[`"'][^`"']*$/i.test(before) || /method\s*:\s*["']get["']/i.test(near)) method = 'GET';
    const q = /^notifications\/token\?([\w=&%.-]{1,200})/.exec(after);
    let params = [];
    const pm = /params\s*:\s*\{/.exec(after.slice(0, 400));
    if (pm) {
      const objAt = i + pm.index + pm[0].length - 1;
      const obj = _balanced(t, objAt);
      if (obj) params = _entries(obj);
    }
    mint.push({ method, queryLiteral: q ? redactText(q[1]) : '', params, excerpt: _excerpt(t, i, 400, 600) });
    i += term.length;
  }
  return { sites, mint };
}

/** mintPlan(mintSites) -> { send:boolean, method, path?, reason } — GET with literal params only. */
function mintPlan(mintSites) {
  const list = Array.isArray(mintSites) ? mintSites : [];
  if (!list.length) return { send: false, method: 'unknown', reason: 'NO_CALL_SITE' };
  if (list.some((m) => m.method === 'POST' || m.method === 'WRITE')) return { send: false, method: 'POST', reason: 'WRITE_METHOD_NOT_SENT' };
  const get = list.find((m) => m.method === 'GET');
  if (!get) return { send: false, method: 'unknown', reason: 'METHOD_UNCLEAR' };
  if (get.params.some((p) => !p.literal)) return { send: false, method: 'GET', reason: 'PARAM_VALUES_NOT_LITERAL' };
  const qs = new URLSearchParams();
  if (get.queryLiteral) for (const [k, v] of new URLSearchParams(get.queryLiteral)) qs.append(k, v);
  for (const p of get.params) qs.append(p.key, String(p.literalValue == null ? '' : p.literalValue).replace(/^!0$/, 'true').replace(/^!1$/, 'false'));
  const s = qs.toString();
  return { send: true, method: 'GET', path: C.WS_MINT_PATH + (s ? '?' + s : ''), reason: 'GET_LITERAL_PARAMS' };
}

/** _jwtInfo(s) -> { claimNames, ttlHours, scope } for a JWT-shaped string | null. No claim values except scope. */
function _jwtInfo(s) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(String(s || ''));
  if (!m) return null;
  const j = safeJson(Buffer.from(m[2].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (!j.ok || !j.value || typeof j.value !== 'object') return { claimNames: [] };
  const v = j.value;
  const ttl = typeof v.exp === 'number' && typeof v.iat === 'number' ? Math.round(((v.exp - v.iat) / 3600) * 10) / 10 : null;
  const scope = typeof v.scope === 'string' && /^[A-Z_ ]{1,30}$/.test(v.scope) ? v.scope : undefined;
  return { claimNames: Object.keys(v).slice(0, 30), ttlHours: ttl, scope };
}

/** _tokenStrings(value) -> JWT-shaped strings anywhere in value (to describe + scrub; never recorded). */
function _tokenStrings(v, out, depth) {
  const o = out || [];
  if ((depth || 0) > 8) return o;
  if (typeof v === 'string') { if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v)) o.push(v); return o; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) _tokenStrings(v[k], o, (depth || 0) + 1);
  return o;
}

function _eventFields(v, depth, prefix, out) {
  const o = out || {};
  if (!v || typeof v !== 'object' || (depth || 0) > 2) return o;
  const list = Array.isArray(v) ? v.slice(0, 1) : [v];
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    for (const k of Object.keys(x).slice(0, 60)) {
      const p = prefix ? prefix + '.' + k : k;
      const val = x[k];
      if (EVENT_KEY_RE.test(k) && (typeof val === 'string' || typeof val === 'number') && String(val).length <= 60 && Object.keys(o).length < 20) o[p] = redactText(val);
      else if (val && typeof val === 'object') _eventFields(val, (depth || 0) + 1, p, o);
    }
  }
  return o;
}

/** describeFrame(payload, opcode, secrets) -> a redacted description of one WebSocket frame. */
function describeFrame(payload, opcode, secrets) {
  if (Number(opcode) === 2) return { kind: 'binary', bytes: String(payload || '').length };
  const s = String(payload == null ? '' : payload);
  const st = STOMP_RE.exec(s);
  if (st) {
    const [head, ...rest] = s.split(/\r?\n\r?\n/);
    const lines = head.split(/\r?\n/).slice(1);
    const headers = {};
    for (const l of lines.slice(0, 30)) {
      const i = l.indexOf(':');
      if (i <= 0) continue;
      const k = l.slice(0, i).slice(0, 60);
      headers[redactText(k, secrets)] = /authorization|token|cookie|passcode|login/i.test(k) ? '<redacted>' : redactText(l.slice(i + 1), secrets).slice(0, 160);
    }
    const body = rest.join('\n\n').replace(/\u0000+$/, '');
    const j = safeJson(body);
    return {
      kind: 'stomp', command: st[1], length: s.length, headers,
      body: j.ok ? { shape: shapeOf(j.value, 4), eventFields: _eventFields(j.value), sample: JSON.stringify(redactDeep(j.value, secrets)).slice(0, 1500) } : { length: body.length },
    };
  }
  const j = safeJson(s);
  if (j.ok && j.value && typeof j.value === 'object') {
    return { kind: 'json', length: s.length, shape: shapeOf(j.value, 4), eventFields: _eventFields(j.value), sample: JSON.stringify(redactDeep(j.value, secrets)).slice(0, 1500) };
  }
  return { kind: 'text', length: s.length, sample: redactText(s, secrets).slice(0, 120) };
}

/** buildOutput(raw, secrets) -> the object written to disk: every string redacted, sensitive keys dropped. */
function buildOutput(raw, secrets) {
  const list = (Array.isArray(secrets) ? secrets : []).filter((x) => typeof x === 'string' && x.length >= 6);
  return redactDeep(raw, list);
}

// ── shape summaries (counts + key names only) ──────────────────────────────
function _keyUnion(rows, pick) {
  const keys = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const x = pick ? pick(r) : r;
    if (x && typeof x === 'object' && !Array.isArray(x)) for (const k of Object.keys(x)) keys.add(k);
  }
  return Array.from(keys).sort().slice(0, 80);
}
function _countBy(rows, f) {
  const out = {};
  for (const r of rows) { const k = f(r); if (typeof k === 'string' && /^[A-Z_]{1,40}$/.test(k)) out[k] = (out[k] || 0) + 1; }
  return out;
}

function summarizeVehicles(r) {
  if (!r || !r.ok) return { code: (r && r.code) || 'NO_RESULT', status: r && r.status };
  const v = r.value || {};
  const rows = Array.isArray(v.vehicles) ? v.vehicles : [];
  return {
    code: 'OK', status: r.status, topKeys: Object.keys(v).slice(0, 30), rows: rows.length,
    totalElements: v.totalElements, totalPages: v.totalPages, totalUnfilteredElements: v.totalUnfilteredElements,
    rowShape: rows.length ? shapeOf(rows[0], 3) : null, rowKeys: _keyUnion(rows),
  };
}

function summarizeVehicle(r) {
  if (!r || !r.ok) return { code: (r && r.code) || 'NO_RESULT', status: r && r.status };
  const v = r.value || {};
  const sensors = Array.isArray(v.sensors) ? v.sensors : [];
  return {
    code: 'OK', status: r.status, shape: shapeOf(v, 3), topKeys: Object.keys(v).slice(0, 60),
    sensors: sensors.length, sensorKeys: _keyUnion(sensors), sensorsWithIssue: sensors.filter((s) => s && s.issue).length,
    issueKeys: _keyUnion(sensors, (s) => s && s.issue), faulted: sensors.filter((s) => s && s.faulted === true).length,
    withPressure: sensors.filter((s) => s && typeof s.pressure === 'number').length,
    latestGeoTagKeys: v.latestGeoTag && typeof v.latestGeoTag === 'object' ? Object.keys(v.latestGeoTag) : [],
  };
}

function summarizeIssues(r) {
  if (!r || !r.ok) return { code: (r && r.code) || 'NO_RESULT', status: r && r.status };
  const v = r.value || {};
  const rows = Array.isArray(v.content) ? v.content : [];
  const issues = [];
  for (const row of rows) for (const i of (row && Array.isArray(row.issues) ? row.issues : [])) issues.push(i);
  return {
    code: 'OK', status: r.status, topKeys: Object.keys(v).slice(0, 30), rows: rows.length,
    totalElements: v.totalElements, totalPages: v.totalPages, rowShape: rows.length ? shapeOf(rows[0], 3) : null,
    rowKeys: _keyUnion(rows), issues: issues.length, issueKeys: _keyUnion(issues),
    bySeverity: _countBy(issues, (i) => i && i.severity), byState: _countBy(issues, (i) => i && i.state),
    muted: issues.filter((i) => i && i.muted === true).length,
  };
}

// ── CDP observer on the sign-in window (passive) ───────────────────────────
function createObserver(wc, getSecrets) {
  const dbg = wc && wc.debugger;
  const apiCalls = new Map();
  const reqs = new Map();       // requestId -> { key, mint? }
  const scriptReqs = new Map(); // requestId -> url (redacted)
  const scripts = { seen: 0, scanned: 0, failed: 0, skippedLarge: 0, urls: [] };
  const bundle = { sites: {}, mint: [] };
  const mintCalls = [];
  const sockets = new Map();    // requestId -> { url, status, created, closed, received, sent }
  const frames = { received: [], sent: [], receivedTotal: 0, sentTotal: 0 };
  const wsSecrets = new Set();  // x-authorization values seen (scrub only; never recorded)
  const pending = new Set();
  const waiters = new Set();
  const track = (p) => { pending.add(p); p.finally(() => pending.delete(p)); };

  function _merge(res) {
    for (const k of Object.keys(res.sites)) {
      const arr = bundle.sites[k] || (bundle.sites[k] = []);
      for (const e of res.sites[k]) if (arr.length < SITES_PER_TERM && !arr.includes(e)) arr.push(e);
    }
    for (const m of res.mint) if (bundle.mint.length < SITES_PER_TERM) bundle.mint.push(m);
  }
  function scanText(text) { scripts.scanned++; _merge(analyzeBundle(text)); }

  function _onRequest(params) {
    const rq = params && params.request;
    const u = rq && C.parseUrl(rq.url);
    if (!u || u.hostname !== C.HOST || !u.pathname.startsWith('/api/')) return;
    const method = String(rq.method || 'GET').toUpperCase();
    const key = method + ' ' + pathPattern(u.pathname);
    const e = apiCalls.get(key) || { method, path: pathPattern(u.pathname), queryNames: [], statuses: {}, count: 0 };
    e.count++;
    for (const k of u.searchParams.keys()) if (e.queryNames.length < 20 && !e.queryNames.includes(k)) e.queryNames.push(k);
    if (apiCalls.size < 200) apiCalls.set(key, e);
    const rec = { key, mint: null };
    if (u.pathname === C.WS_MINT_PATH && mintCalls.length < 10) {
      let bodyKeys = null;
      if (typeof rq.postData === 'string') {
        const j = safeJson(rq.postData);
        bodyKeys = j.ok && j.value && typeof j.value === 'object' ? Object.keys(j.value).slice(0, 20) : 'non-json';
      }
      rec.mint = { method, queryNames: Array.from(new Set(u.searchParams.keys())), contentType: _ct(rq.headers), bodyKeys, hasPostData: !!rq.hasPostData, status: null, response: null };
      mintCalls.push(rec.mint);
    }
    reqs.set(params.requestId, rec);
  }
  function _ct(h) {
    for (const k of Object.keys(h || {})) if (k.toLowerCase() === 'content-type') return String(h[k]).slice(0, 80);
    return null;
  }

  function _isScript(params) {
    const u = C.parseUrl(params && params.response && params.response.url);
    if (!u || u.hostname !== C.HOST) return false;
    return params.type === 'Script' || /\.m?js$/.test(u.pathname);
  }

  function _notify() {
    for (const w of Array.from(waiters)) if (frames.receivedTotal >= w.n) { waiters.delete(w); clearTimeout(w.timer); w.resolve(true); }
  }

  function onMessage(_e, method, params) {
    try {
      if (method === 'Network.requestWillBeSent') _onRequest(params);
      else if (method === 'Network.responseReceived') {
        const rec = reqs.get(params.requestId);
        const status = Number(params.response && params.response.status) || 0;
        if (rec) {
          const e = apiCalls.get(rec.key);
          if (e) e.statuses[status] = (e.statuses[status] || 0) + 1;
          if (rec.mint) rec.mint.status = status;
        }
        if (_isScript(params) && scriptReqs.size + scripts.seen < MAX_SCRIPTS * 2) {
          scripts.seen++;
          const ru = redactUrl(params.response.url);
          if (scripts.urls.length < MAX_SCRIPTS) scripts.urls.push(ru);
          scriptReqs.set(params.requestId, ru);
        }
      } else if (method === 'Network.loadingFinished') {
        const id = params && params.requestId;
        const rec = reqs.get(id);
        reqs.delete(id);
        if (rec && rec.mint) {
          track(Promise.resolve()
            .then(() => dbg.sendCommand('Network.getResponseBody', { requestId: id }))
            .then((r) => {
              let text = r && typeof r.body === 'string' ? r.body : '';
              if (r && r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
              const j = safeJson(text);
              const toks = j.ok ? _tokenStrings(j.value) : (/^eyJ/.test(text.trim()) ? [text.trim()] : []);
              for (const t of toks) wsSecrets.add(t);
              rec.mint.response = { json: j.ok, shape: j.ok ? shapeOf(j.value, 3) : null, tokenLike: toks.length, tokenClaims: toks.length ? _jwtInfo(toks[0]) : null };
            })
            .catch(() => {}));
        }
        if (!scriptReqs.has(id)) return;
        scriptReqs.delete(id);
        if (Number(params.encodedDataLength) > BODY_MAX) { scripts.skippedLarge++; return; }
        track(Promise.resolve()
          .then(() => dbg.sendCommand('Network.getResponseBody', { requestId: id }))
          .then((r) => {
            let text = r && typeof r.body === 'string' ? r.body : '';
            if (r && r.base64Encoded) text = Buffer.from(text, 'base64').toString('utf8');
            if (text.length > BODY_MAX) { scripts.skippedLarge++; return; }
            scanText(text);
          })
          .catch(() => { scripts.failed++; }));
      } else if (method === 'Network.webSocketCreated') {
        const u = C.parseUrl(params && params.url);
        if (u) { const v = u.searchParams.get(C.WS_TOKEN_PARAM); if (v) wsSecrets.add(v); }
        if (sockets.size < 10) sockets.set(params.requestId, { url: redactUrl(params.url), status: null, closed: false, received: 0, sent: 0, tokenClaims: u && u.searchParams.get(C.WS_TOKEN_PARAM) ? _jwtInfo(u.searchParams.get(C.WS_TOKEN_PARAM)) : null });
      } else if (method === 'Network.webSocketHandshakeResponseReceived') {
        const s = sockets.get(params.requestId);
        if (s) s.status = Number(params.response && params.response.status) || null;
      } else if (method === 'Network.webSocketClosed') {
        const s = sockets.get(params.requestId);
        if (s) s.closed = true;
      } else if (method === 'Network.webSocketFrameReceived' || method === 'Network.webSocketFrameSent') {
        const s = sockets.get(params.requestId);
        const sent = method === 'Network.webSocketFrameSent';
        if (s) { if (sent) s.sent++; else s.received++; }
        const f = params.response || {};
        const list = sent ? frames.sent : frames.received;
        if (sent) frames.sentTotal++; else frames.receivedTotal++;
        if (list.length < MAX_FRAMES) {
          const secrets = Array.from(wsSecrets).concat(getSecrets ? getSecrets() : []);
          list.push(Object.assign({ atMs: Date.now() }, describeFrame(f.payloadData, f.opcode, secrets)));
        }
        if (!sent) _notify();
      } else if (method === 'Network.webSocketFrameError') {
        const s = sockets.get(params.requestId);
        if (s) s.error = true;
      }
    } catch (_) { /* metadata only */ }
  }

  if (dbg && typeof dbg.on === 'function') dbg.on('message', onMessage);
  return {
    pending, scripts, bundle, mintCalls, sockets, frames, wsSecrets, scanText,
    apiCalls() { return Array.from(apiCalls.values()); },
    /** waitFrames(n, ms) -> true once n frames were received, false at timeout. */
    waitFrames(n, ms) {
      if (frames.receivedTotal >= n) return Promise.resolve(true);
      return new Promise((resolve) => {
        const w = { n, resolve, timer: null };
        w.timer = setTimeout(() => { waiters.delete(w); resolve(false); }, Math.max(0, ms | 0));
        if (w.timer && w.timer.unref) w.timer.unref();
        waiters.add(w);
      });
    },
    detach() {
      try { if (dbg && typeof dbg.removeListener === 'function') dbg.removeListener('message', onMessage); } catch (_) {}
      for (const w of Array.from(waiters)) { clearTimeout(w.timer); waiters.delete(w); w.resolve(false); }
    },
  };
}

// ── run state ─────────────────────────────────────────────────────────────
let _armed = false;
let _ran = false;
let _running = false;
let _lastRun = null;

function _logger(log) {
  if (log && typeof log.info === 'function') return log;
  try { return require('../utils/logger')('aperia-probe'); } catch (_) { return { info() {}, warn() {}, error() {} }; }
}
function _errName(e) { return String((e && typeof e === 'object' && e.name) || 'Error').replace(/[^\w.]/g, '').slice(0, 40); }
function _isDestroyed(w) { try { return !w || !!w.isDestroyed(); } catch (_) { return true; } }

function _resolveDeps(d) {
  const x = d || {};
  return {
    session: x.session || require('../aperia/session'),
    capture: x.capture || require('../aperia/capture'),
    transport: x.transport || require('../aperia/transport'),
    getDataDir: x.getDataDir || (() => require('../config/paths').getDataDir()),
    now: typeof x.now === 'function' ? x.now : () => Date.now(),
    wsWatchMs: Number.isFinite(x.wsWatchMs) ? x.wsWatchMs : WS_WATCH_MS,
    timeoutMs: Number.isFinite(x.timeoutMs) ? x.timeoutMs : RUN_TIMEOUT_MS,
    openDelayMs: Number.isFinite(x.openDelayMs) ? x.openDelayMs : OPEN_DELAY_MS,
    observer: x.observer || null,
  };
}

/**
 * start({ log, env, _deps }) — the only entry point. Inert (returns false, creates nothing) unless
 * env.FLEET_DEV_APERIA_PROBE === '1'. Otherwise attaches the observer to the sign-in window, opens it
 * after OPEN_DELAY_MS and runs once on the first 'connected'.
 */
function start(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  if (!env || env[ENV_FLAG] !== '1') return false;
  if (_armed) return true;
  _armed = true;
  const log = _logger(o.log);
  const D = _resolveDeps(o._deps);
  let observer = D.observer;
  const getSecrets = () => { const t = D.capture.current(); return t ? [t] : []; };
  const unWin = D.session.onWindow((win) => {
    if (observer) return;
    try { observer = createObserver(win.webContents, getSecrets); } catch (e) { log.warn('[aperia-probe] observer ' + _errName(e)); }
  });
  const go = () => {
    if (_ran) return;
    _ran = true;
    try { unWin(); } catch (_) {}
    _lastRun = run(Object.assign({}, o._deps, { log, observer })).catch((e) => { log.warn('[aperia-probe] run threw: ' + _errName(e)); });
  };
  const t = setTimeout(() => {
    log.info('[aperia-probe] opening the Aperia sign-in window');
    Promise.resolve()
      .then(() => D.session.openLoginWindow({}))
      .then((r) => {
        if (r && r.ok) go();
        else {
          _ran = true;
          _lastRun = _write(D, log, { version: 1, at: new Date(D.now()).toISOString(), code: (r && r.code) || 'APERIA_SIGNIN_FAILED' }, [], observer);
        }
      })
      .catch((e) => { log.warn('[aperia-probe] sign-in threw: ' + _errName(e)); });
  }, D.openDelayMs);
  if (t && typeof t.unref === 'function') t.unref();
  log.info('[aperia-probe] armed (opens the Aperia sign-in window, runs after sign-in)');
  return true;
}

async function _write(D, log, out, secrets, observer) {
  const date = String(out.at || new Date(D.now()).toISOString()).slice(0, 10);
  const fileName = 'aperia-probe-' + date + '.json';
  const all = secrets.concat(observer ? Array.from(observer.wsSecrets) : []);
  let written = false;
  let code = out.code || null;
  try {
    const dir = path.join(D.getDataDir(), 'dev');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), JSON.stringify(buildOutput(out, all), null, 1));
    written = true;
  } catch (e) {
    code = code || ('APERIA_PROBE_WRITE:' + _errName(e));
  }
  const fr = observer ? observer.frames : { receivedTotal: 0, sentTotal: 0 };
  const line = '[aperia-probe] done vehicles=' + ((out.rest && out.rest.vehicles && out.rest.vehicles.rows) || 0)
    + ' sensors=' + ((out.rest && out.rest.vehicle && out.rest.vehicle.sensors) || 0)
    + ' issues=' + ((out.rest && out.rest.issues && out.rest.issues.rows) || 0)
    + ' scripts=' + (observer ? observer.scripts.scanned : 0)
    + ' mintSites=' + (observer ? observer.bundle.mint.length : 0)
    + ' mintCalls=' + (observer ? observer.mintCalls.length : 0)
    + ' sockets=' + (observer ? observer.sockets.size : 0)
    + ' frames=' + fr.receivedTotal + '/' + fr.sentTotal
    + ' file=' + (written ? fileName : '-') + (code ? ' code=' + String(code).slice(0, 60) : '');
  if (code) log.warn(line); else log.info(line);
  return { ok: !code, code: code || undefined, file: written ? fileName : null };
}

/** run(deps) — one discovery pass after sign-in. Always writes the output file and logs done. */
async function run(deps) {
  const log = _logger(deps && deps.log);
  if (_running) { log.info('[aperia-probe] already running'); return { ok: false, code: 'APERIA_PROBE_BUSY' }; }
  _running = true;
  const D = _resolveDeps(deps);
  const observer = D.observer;
  const at = new Date(D.now()).toISOString();
  const out = {
    version: 1, at, host: C.HOST, forbiddenNeverCalled: C.FORBIDDEN_ENDPOINTS.slice(),
    rest: { vehicles: null, vehicle: null, issues: null },
    bundle: null, mint: { plan: null, portalCalls: [], attempt: null },
    ws: { watchedMs: 0, sockets: [], frames: null }, apiCalls: [],
  };
  let code = null;
  let aborted = false;
  let hardTimer = null;
  const hardStop = new Promise((resolve) => {
    hardTimer = setTimeout(() => { aborted = true; resolve({ timedOut: true }); }, D.timeoutMs);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
  });
  const t0 = Date.now();
  // Captured at the time of writing too (the token may rotate during the watch).
  const secrets = [];
  const noteSecret = () => { const t = D.capture.current(); if (t && !secrets.includes(t)) secrets.push(t); };
  noteSecret();

  const steps = async () => {
    const watch = observer ? observer.waitFrames(MAX_FRAMES, D.wsWatchMs) : Promise.resolve(false);
    // (a) REST shapes: issues first so the detail read can use a unit that has an active issue.
    const issues = await D.transport.getJson(C.issuesByVehiclePath(0));
    out.rest.issues = summarizeIssues(issues);
    if (aborted) return {};
    const vehicles = await D.transport.getJson(C.vehiclesPath(0));
    out.rest.vehicles = summarizeVehicles(vehicles);
    if (aborted) return {};
    const firstIssue = issues && issues.ok && issues.value && Array.isArray(issues.value.content) ? issues.value.content[0] : null;
    const firstVeh = vehicles && vehicles.ok && vehicles.value && Array.isArray(vehicles.value.vehicles) ? vehicles.value.vehicles[0] : null;
    const id = (firstIssue && firstIssue.id) || (firstVeh && firstVeh.id);
    const vp = id != null ? C.vehiclePath(id) : null;
    out.rest.vehicle = vp ? Object.assign({ from: firstIssue && firstIssue.id ? 'issues' : 'vehicles' }, summarizeVehicle(await D.transport.getJson(vp))) : { code: 'NO_VEHICLE_ID' };
    if (aborted) return {};
    noteSecret();

    // (b) bundle analysis: CDP bodies first; fall back to a plain GET of the portal's own index-*.js.
    if (observer) {
      if (observer.pending.size) await Promise.allSettled(Array.from(observer.pending));
      if (!observer.scripts.scanned) await _fallbackBundles(D, observer);
    }
    out.bundle = observer ? { scripts: observer.scripts, sites: observer.bundle.sites, mintSites: observer.bundle.mint } : { code: 'NO_OBSERVER' };

    // (c) WS-token mint: GET with literal params only, once. A POST is recorded, never sent.
    const plan = mintPlan(observer ? observer.bundle.mint : []);
    out.mint.plan = { send: plan.send, method: plan.method, reason: plan.reason, path: plan.path ? redactUrl(C.BASE_URL + plan.path) : null };
    if (plan.send && !aborted) {
      const r = await D.transport.getJson(plan.path);
      const toks = r && r.ok ? _tokenStrings(r.value) : [];
      for (const t of toks) secrets.push(t);
      out.mint.attempt = { code: r && r.ok ? 'OK' : (r && r.code) || 'NO_RESULT', status: r && r.status, shape: r && r.ok ? shapeOf(r.value, 3) : null, tokenLike: toks.length, tokenClaims: toks.length ? _jwtInfo(toks[0]) : null };
    }

    // (d) WebSocket: wait out the watch window (or MAX_FRAMES received).
    const left = D.wsWatchMs - (Date.now() - t0);
    if (left > 0) await Promise.race([watch, new Promise((r) => { const tt = setTimeout(r, left); if (tt.unref) tt.unref(); })]);
    return {};
  };

  try {
    const r = await Promise.race([steps(), hardStop]);
    if (r && r.timedOut) code = 'APERIA_PROBE_TIMEOUT';
  } catch (e) {
    code = 'APERIA_PROBE_ERROR:' + _errName(e);
  } finally {
    clearTimeout(hardTimer);
    aborted = true;
  }
  noteSecret();
  out.ws.watchedMs = Date.now() - t0;
  if (observer) {
    if (observer.pending.size) await Promise.race([Promise.allSettled(Array.from(observer.pending)), new Promise((r) => setTimeout(r, 5000))]);
    out.mint.portalCalls = observer.mintCalls.slice();
    out.ws.sockets = Array.from(observer.sockets.values());
    out.ws.frames = observer.frames;
    out.apiCalls = observer.apiCalls();
    if (!out.bundle || out.bundle.code) out.bundle = { scripts: observer.scripts, sites: observer.bundle.sites, mintSites: observer.bundle.mint };
    observer.detach();
  }
  if (code) out.code = code;
  const res = await _write(D, log, out, secrets, observer);
  _running = false;
  return res;
}

/** _fallbackBundles — the page's own script URLs (DOM read), then a plain GET of each index-*.js asset. */
async function _fallbackBundles(D, observer) {
  try {
    const win = D.session.loginWindow ? D.session.loginWindow() : null;
    if (!win || _isDestroyed(win)) return;
    const srcs = await win.webContents.executeJavaScript('Array.from(document.scripts).map(function(s){return s.src||""}).filter(Boolean).slice(0,40)', true);
    const ses = D.session.getSession();
    for (const s of Array.isArray(srcs) ? srcs : []) {
      const u = C.parseUrl(s);
      if (!u || u.protocol !== 'https:' || u.hostname !== C.HOST || !/\/index-[\w-]+\.js$/.test(u.pathname)) continue;
      try {
        const res = await ses.fetch(u.origin + u.pathname, { method: 'GET', headers: { Accept: '*/*' } });
        if (Number(res.status) >= 200 && Number(res.status) < 300) {
          const text = await res.text();
          if (text.length <= BODY_MAX) { observer.scanText(text); observer.scripts.urls.push(redactUrl(u.href) + ' (fetched)'); }
        }
      } catch (_) { observer.scripts.failed++; }
    }
  } catch (_) { observer.scripts.failed++; }
}

function _resetForTests() { _armed = false; _ran = false; _running = false; _lastRun = null; }
function _lastRunForTests() { return _lastRun; }

module.exports = {
  start, run, ENV_FLAG, WS_WATCH_MS, MAX_FRAMES, analyzeBundle, mintPlan, describeFrame, buildOutput, createObserver,
  summarizeVehicles, summarizeVehicle, summarizeIssues, _jwtInfo, _resetForTests, _lastRunForTests,
};
