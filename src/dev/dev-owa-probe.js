'use strict';
/**
 * dev/dev-owa-probe.js — DEV-ONLY, env-gated OWA API/windowless probe harness (spike findings
 * .agents/tasks/fleet-version-c-spike-owa-api-2026-11-07/findings.md).
 *
 * Answers the user's question for Email Triage ONLY: can we get/send email through OWA's own
 * back-end via API calls, and can we do it WITHOUT a browser page/window? It never touches the
 * SOS/EOS scheduler, never sends/moves/flags/marks-read/deletes anything, and never writes tokens,
 * cookies, canary values, header values, bodies, subjects or addresses to disk or logs.
 *
 * IMPORTANT — this file lives in src/dev/, NOT src/email-intel/**, on purpose: the source-level
 * guard (tests/email-intel-static-guards.test.js) forbids service.svc / /api/v2.0 / graph strings
 * anywhere under src/email-intel. The API-call spike MUST reference those endpoint shapes, so it
 * lives here (alongside dev/timeline-audit.js) exactly as the findings design mandates (§4, §6).
 *
 * Completely inert unless process.env.FLEET_OWA_PROBE_DIR is set: start() is the only entry point
 * and it returns immediately (no window, no timer, no listener, no child) when the env var is unset.
 *
 * When set: start() schedules one run a few minutes after startup (unref'd timer). The run opens its
 * OWN hidden BrowserWindow on the SAME session.defaultSession owa_reader/owa_capture use, loading
 * outlook.office.com/mail/ the way owa_capture.openSession does (it reuses openSession, so it never
 * navigates or reuses any window the scheduler or owa-mailer owns). Overall 5-minute timeout; the
 * window is closed and any child killed on timeout or failure, and `[owa-probe] done` is always
 * logged with a summary through the app logger.
 *
 * Output files under <FLEET_OWA_PROBE_DIR>:
 *   owa-probe-intel-<ts>.json    — Part A read-only probes
 *   owa-probe-api-<ts>.json      — Part B in-page fetch replay feasibility
 *   owa-probe-network-<ts>.json  — Part B CDP network metadata (names/shapes only)
 *   owa-probe-windowless-<ts>.json — Part C Tier 1/2/3
 */
const fs = require('fs');
const path = require('path');

const ENV_DIR = 'FLEET_OWA_PROBE_DIR';
// A few minutes after startup, after the first warmOwaSession / scheduler start has settled.
const DEFAULT_DELAY_MS = 150_000;
// Overall run budget, computed ONCE as a single deadline. The window phase ends RESERVE_MS before the
// deadline so Tier 1(b), Tier 2, the writes and the done log all fit inside the 5 minutes.
const OVERALL_TIMEOUT_MS = 5 * 60_000;
const RESERVE_MS = 75_000;
const WARMUP_MAX_MS = 60_000;
const SETTLE_WAIT_MS = 10_000;          // after abort, how long we wait for openSession to settle/close
const CLOSE_WAIT_MS = 5_000;            // how long we wait for an async BrowserWindow.close() to finish
const CLOSE_POLL_MS = 100;
const NET_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 20_000;
const REUSE_DELAY_MS = 20_000;          // refresh-behaviour re-run delay (only if the budget allows)
const REPLAY_MAX_BYTES = 256 * 1024;
// Login / SSO hosts (mirrors owa-mailer AUTH_HOST_RE). Used only to classify a redirect; never stored.
const AUTH_HOST_RE = /login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|msft\.sts|adfs|\/common\/oauth2|\/consent|multifactor|mfa|midway/i;

// Outlook hosts the SPA uses for mail — the ONLY hosts any tier is allowed to contact.
const OUTLOOK_HOSTS = Object.freeze(['outlook.office365.com', 'outlook.office.com', 'outlook.cloud.microsoft']);
// Header names we care about reporting the PRESENCE of (never the values).
const INTERESTING_HEADERS = Object.freeze([
  'x-owa-canary', 'authorization', 'x-anchormailbox', 'x-owa-correlationid', 'x-req-source',
  'action', 'x-owa-urlpostdata', 'content-type', 'accept', 'x-requested-with', 'cookie',
]);
// Any mutating verb/action — presence of ANY of these in a request we observe is a red flag we record,
// and the replay/windowless layers must never issue one. (Used only for inspection/assertions.)
const MUTATION_ACTION_RE = /\b(CreateItem|SendItem|ReplyToItem|ReplyAllToItem|ForwardItem|UpdateItem|MoveItem|DeleteItem|MarkAsRead|MarkAllItemsAsRead|sendMail|\/send|\/reply|\/replyAll|\/forward|\/move|\/delete)\b/i;

// ───────────────────────────── redaction / masking ─────────────────────────────
const ADDRESS_RE = /[\w.+-]+@[\w.-]+/g;

/** maskAddress('jane@corp.test') -> 'j***@corp.test'. Empty/invalid -> '***' or ''. */
function maskAddress(addr) {
  const s = String(addr == null ? '' : addr).trim();
  const at = s.indexOf('@');
  if (at < 1) return s ? '***' : '';
  return s[0] + '***' + s.slice(at);
}

/** Replace any address-looking token inside free text with a masked form. */
function maskText(s) {
  return String(s == null ? '' : s).replace(ADDRESS_RE, (m) => maskAddress(m));
}

/**
 * collapsePath('/owa/service.svc?action=FindItem&id=AAMk...') ->
 *   '/owa/service.svc?action=FindItem'. GUIDs, base64 ids, long numbers and query VALUES are stripped
 * so only the path PATTERN and the action name survive (never an id, never a value).
 */
function collapsePath(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { return '<bad-url>'; }
  // Decode (guarded) so %40-encoded addresses are caught, then replace any '@'-bearing segment
  // (explicit / shared-mailbox logon, Users('…@…')) with <addr> before any other collapsing.
  let decoded = u.pathname;
  try { decoded = decodeURIComponent(u.pathname); } catch (_) { decoded = u.pathname.replace(/%40/gi, '@'); }
  let p = maskText(decoded.split('/').map((seg) => (seg.includes('@') ? '<addr>' : seg)).join('/'))
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/<guid>')   // GUIDs first (they also match the base64 rule)
    .replace(/\/[A-Za-z0-9+/=_-]{24,}/g, '/<id>')                 // base64-ish item ids
    .replace(/\/\d{6,}/g, '/<n>');
  // Keep only the `action` query key (OWA service action name); drop everything else's VALUE.
  const action = u.searchParams.get('action') || u.searchParams.get('Action');
  return action ? p + '?action=' + String(action).replace(/[^A-Za-z]/g, '') : p;
}

/** Header NAMES only, lower-cased, de-duped, limited to the interesting set + any x-* name (no values). */
function headerNames(headers) {
  const out = [];
  const h = headers && typeof headers === 'object' ? headers : {};
  for (const k of Object.keys(h)) {
    const name = String(k).toLowerCase();
    if (INTERESTING_HEADERS.includes(name) || name.startsWith('x-owa') || name.startsWith('x-anchor')) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out.sort();
}

/** Describe a JSON value as a key/type shape — NEVER values. Strings -> 'string', arrays -> '[T xN]', etc. */
function shapeOf(v, depth) {
  const d = depth == null ? 0 : depth;
  if (v === null) return 'null';
  if (Array.isArray(v)) return '[' + (v.length ? (d < 2 ? shapeOf(v[0], d + 1) : '…') : '') + ' x' + v.length + ']';
  const t = typeof v;
  if (t !== 'object') return t;                       // string | number | boolean | undefined
  if (d >= 3) return '{…}';
  const o = {};
  for (const k of Object.keys(v).slice(0, 40)) o[k] = shapeOf(v[k], d + 1);
  return o;
}

// ───────────────────────────── host allow-list ─────────────────────────────
/** hostAllowed(host|url) — true only for the Outlook mail hosts (exact or subdomain). */
function hostAllowed(hostOrUrl) {
  let h = String(hostOrUrl || '').toLowerCase();
  if (h.includes('://') || h.startsWith('//')) { try { h = new URL(h.startsWith('//') ? 'https:' + h : h).hostname.toLowerCase(); } catch (_) { return false; } }
  h = h.split('/')[0].split(':')[0];
  return OUTLOOK_HOSTS.some((x) => h === x || h.endsWith('.' + x));
}

// ───────────────────────────── CDP network recorder ─────────────────────────────
/**
 * NetworkRecorder — subscribes to Network.requestWillBeSent / responseReceived (via the CDP debugger)
 * and keeps ONLY: method, host, collapsed path pattern, OWA action name, request header NAMES,
 * response status, and the response-body JSON key/type shape. No urls with ids, no header values,
 * no bodies. record() is the single choke point and is unit-tested to drop everything else.
 */
function createNetworkRecorder() {
  const byReq = new Map();        // requestId -> partial record
  const records = [];
  const seen = new Set();         // de-dupe identical {method, pathPattern, action}

  function recordRequest(params) {
    const req = (params && params.request) || {};
    const url = req.url || '';
    if (!hostAllowed(url)) return;
    let host = '';
    try { host = new URL(url).host; } catch (_) { host = '<bad>'; }
    const pathPattern = collapsePath(url);
    let action = '';
    try { action = new URL(url).searchParams.get('action') || ''; } catch (_) { /* none */ }
    // OWA also carries the action in an `action` header on POSTs — name only, but the VALUE here is a
    // non-sensitive action enum (FindItem/GetItem/…); keep it when it matches the known safe set.
    const hdrAction = req.headers && (req.headers.action || req.headers.Action);
    if (!action && typeof hdrAction === 'string' && /^[A-Za-z]{3,40}$/.test(hdrAction)) action = hdrAction;
    const rec = {
      method: String(req.method || 'GET').toUpperCase(),
      host,
      pathPattern,
      action: String(action || '').replace(/[^A-Za-z]/g, '').slice(0, 40),
      requestHeaderNames: headerNames(req.headers),
      wouldMutate: MUTATION_ACTION_RE.test(url) || MUTATION_ACTION_RE.test(String(action || '')),
      status: null,
      responseHeaderNames: [],
      responseShape: null,
    };
    byReq.set(params.requestId, rec);
  }

  function recordResponse(params) {
    const rec = byReq.get(params && params.requestId);
    if (!rec) return;
    const res = (params && params.response) || {};
    rec.status = Number(res.status) || null;
    rec.responseHeaderNames = headerNames(res.headers);
  }

  // Called by the harness with an already-parsed response JSON for a request we care about.
  function attachBodyShape(requestId, json) {
    const rec = byReq.get(requestId);
    if (rec) rec.responseShape = shapeOf(json, 0);
  }

  function finalize() {
    for (const rec of byReq.values()) {
      const key = rec.method + ' ' + rec.pathPattern + ' ' + rec.action;
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
    return records.slice(0, 200);
  }

  return { recordRequest, recordResponse, attachBodyShape, finalize, _byReq: byReq };
}

/**
 * jwtExpShape(token, nowMs) -> { hasExp, secondsToExpiry, reason? }. Decodes ONLY the JWT payload's
 * `exp` claim in memory; the token itself is never returned, stored or logged.
 */
function jwtExpShape(token, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const t = String(token || '').replace(/^Bearer\s+/i, '');
  if (!t) return { hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' };
  const parts = t.split('.');
  if (parts.length !== 3) return { hasExp: false, secondsToExpiry: null, reason: 'opaque-token' };
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json || !Number.isFinite(json.exp)) return { hasExp: false, secondsToExpiry: null, reason: 'no-exp-claim' };
    return { hasExp: true, secondsToExpiry: Math.round(json.exp - now / 1000) };
  } catch (_) { return { hasExp: false, secondsToExpiry: null, reason: 'undecodable' }; }
}

/**
 * createAuthCapture() — IN-MEMORY ONLY holder for the auth material the SPA sends to Outlook hosts
 * (authorization bearer, x-owa-canary, x-anchormailbox), observed via CDP requestWillBeSent. It exists
 * so Tier 1(b)/Tier 2 can test "captured once from the hidden page, reused windowless". Values are
 * reachable only through headers(); describe() returns names/shape only; clear() drops everything.
 * Nothing from here is ever written to disk or the logger.
 */
function createAuthCapture() {
  const KEEP = ['authorization', 'x-owa-canary', 'x-anchormailbox'];
  let vals = {};
  let host = '';
  let firstSeenAt = null;
  function observe(params) {
    const req = (params && params.request) || {};
    if (!hostAllowed(req.url)) return;
    const h = req.headers && typeof req.headers === 'object' ? req.headers : {};
    let hit = false;
    for (const k of Object.keys(h)) {
      const name = String(k).toLowerCase();
      if (KEEP.includes(name) && typeof h[k] === 'string' && h[k]) { vals[name] = h[k]; hit = true; }
    }
    if (hit) {
      try { host = new URL(req.url).hostname.toLowerCase(); } catch (_) { /* keep previous */ }
      if (firstSeenAt == null) firstSeenAt = Date.now();
    }
  }
  function headers() { return Object.assign({}, vals); }
  function names() { return Object.keys(vals).sort(); }
  function describe(nowMs) {
    return {
      namesObserved: names(),
      host: host || null,
      bearer: vals.authorization && /^Bearer\s/i.test(vals.authorization) ? jwtExpShape(vals.authorization, nowMs) : { hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' },
      firstSeenAgoSec: firstSeenAt == null ? null : Math.round(((Number.isFinite(nowMs) ? nowMs : Date.now()) - firstSeenAt) / 1000),
    };
  }
  function clear() { vals = {}; host = ''; firstSeenAt = null; }
  return { observe, headers, names, describe, clear, host: () => host };
}

// ───────────────────────────── in-page replay scripts ─────────────────────────────
/**
 * buildReplayScript({ action, max, bytesCap }) — page script (string) that performs ONE read-only
 * fetch from the OWA origin and returns ONLY booleans / counts / shapes. It never returns body text,
 * addresses, subjects or ids. It uses the SPA's own cookies (credentials:'include') and issues ONLY
 * GET-shaped reads (the v2.0 REST list/get, or a metadata GET). It never posts a mutating action.
 *
 * `action` ∈ 'list' | 'get' | 'conversation' | 'stability'. The script chooses the v2.0 REST path the
 * SPA exposes on the same origin (outlook.office.com/api/v2.0/me/messages) because it is a pure GET
 * that does not flip IsRead, and reports presence booleans only.
 */
const REPLAY_AUTH_HEADER_NAMES = ['authorization', 'x-anchormailbox', 'x-owa-canary'];
function _replayAuthHeaders(h) {
  const out = {};
  const src = h && typeof h === 'object' ? h : {};
  for (const k of Object.keys(src)) {
    const name = String(k).toLowerCase();
    if (REPLAY_AUTH_HEADER_NAMES.includes(name) && typeof src[k] === 'string' && src[k]) out[name] = src[k];
  }
  return out;
}

function buildReplayScript(o) {
  // `authHeaders` (optional): the SPA's own auth headers, captured in memory via CDP from this same
  // page. The v2.0 REST surface rejects cookie-only calls (401), so the replay must send them too.
  // Allow-listed names only; the script string lives in memory and is never logged or written.
  const authHeaders = _replayAuthHeaders(o && o.authHeaders);
  const hdrs = Object.assign({ accept: 'application/json' }, authHeaders);
  const cfg = JSON.stringify({
    headerNames: Object.keys(hdrs).sort(),
    action: String((o && o.action) || 'list'),
    max: Math.max(1, Math.min(5, Math.trunc((o && o.max) || 5))),
    bytesCap: Math.max(1024, Math.trunc((o && o.bytesCap) || REPLAY_MAX_BYTES)),
    convId: String((o && o.convId) || ''),
    itemHash: String((o && o.itemHash) || ''),
  });
  return '(async function(){ /*owa-probe:replay*/\n' +
    '  var C = ' + cfg + '; var H = ' + JSON.stringify(hdrs) + '; var t0 = (performance && performance.now) ? performance.now() : Date.now();\n' +
    '  function out(o){ o.headerNamesSent = C.headerNames; o.latencyMs = Math.round(((performance&&performance.now)?performance.now():Date.now()) - t0); return JSON.stringify(o); }\n' +
    '  var base = location.origin + "/api/v2.0/me";\n' +
    '  function present(v){ return v !== undefined && v !== null && v !== ""; }\n' +
    '  function len(v){ return typeof v === "string" ? v.length : (Array.isArray(v) ? v.length : 0); }\n' +
    '  async function get(url){\n' +
    '    var ac = new AbortController(); var to = setTimeout(function(){ ac.abort(); }, 30000);\n' +
    '    try { var r = await fetch(url, { method: "GET", credentials: "include", redirect: "manual", cache: "no-store", headers: H, signal: ac.signal });\n' +
    '      if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) return { status: r.status || 302, redirect: true };\n' +
    '      var text = ""; var reader = r.body && r.body.getReader ? r.body.getReader() : null; var n = 0;\n' +
    '      if (reader){ while(true){ var s = await reader.read(); if (s.done) break; n += s.value.length; if (n > C.bytesCap){ ac.abort(); break; } text += new TextDecoder().decode(s.value); } }\n' +
    '      else { text = await r.text(); }\n' +
    '      var json = null; try { json = JSON.parse(text); } catch(e){ json = null; }\n' +
    '      return { status: r.status, json: json };\n' +
    '    } catch(e){ return { status: 0, error: String(e && e.name || "err").slice(0,40) }; }\n' +
    '    finally { clearTimeout(to); }\n' +
    '  }\n' +
    '  function keys(j){ return (j && typeof j === "object") ? Object.keys(j).slice(0,30) : []; }\n' +
    '  if (C.action === "list"){\n' +
    '    var r = await get(base + "/messages?$top=" + C.max + "&$orderby=ReceivedDateTime%20desc&$select=Id,ConversationId,InternetMessageId,ReceivedDateTime,HasAttachments");\n' +
    '    if (r.status !== 200 || !r.json) return out({ ok:false, status:r.status, redirect:!!r.redirect, error:r.error });\n' +
    '    var items = Array.isArray(r.json.value) ? r.json.value : [];\n' +
    '    return out({ ok:true, status:200, count: items.length, topLevelKeys: keys(r.json), hasIds: items.every(function(x){ return present(x.Id); }), hasConvIds: items.every(function(x){ return present(x.ConversationId); }), wouldMarkRead:false });\n' +
    '  }\n' +
    '  if (C.action === "get" || C.action === "stability"){\n' +
    '    var lr = await get(base + "/messages?$top=1&$orderby=ReceivedDateTime%20desc&$select=Id");\n' +
    '    var first = lr.json && Array.isArray(lr.json.value) && lr.json.value[0]; if (!first) return out({ ok:false, status:lr.status, reason:"no-item" });\n' +
    '    var one = await get(base + "/messages/" + encodeURIComponent(first.Id) + "?$select=ToRecipients,CcRecipients,From,ReceivedDateTime,ConversationId,InternetMessageId,HasAttachments,Body");\n' +
    '    if (one.status !== 200 || !one.json) return out({ ok:false, status:one.status, redirect:!!one.redirect });\n' +
    '    var m = one.json; var body = m.Body && m.Body.Content ? m.Body.Content : "";\n' +
    '    var res = { ok:true, status:200, present: { to: len(m.ToRecipients) > 0, cc: len(m.CcRecipients) > 0, from: present(m.From), received: present(m.ReceivedDateTime), conversationId: present(m.ConversationId), internetMessageId: present(m.InternetMessageId), hasAttachments: m.HasAttachments === true }, toCount: len(m.ToRecipients), ccCount: len(m.CcRecipients), bodyLength: body.length, wouldMarkRead:false };\n' +
    '    if (C.action === "stability"){ var two = await get(base + "/messages/" + encodeURIComponent(first.Id) + "?$select=Id,ConversationId,InternetMessageId"); res.stable = { sameItemId: !!(two.json && two.json.Id === m.Id), sameConvId: !!(two.json && two.json.ConversationId === m.ConversationId), sameInternetId: !!(two.json && two.json.InternetMessageId === m.InternetMessageId) }; }\n' +
    '    return out(res);\n' +
    '  }\n' +
    '  if (C.action === "conversation"){\n' +
    '    var lr2 = await get(base + "/messages?$top=1&$orderby=ReceivedDateTime%20desc&$select=Id,ConversationId"); var f2 = lr2.json && Array.isArray(lr2.json.value) && lr2.json.value[0];\n' +
    '    if (!f2 || !f2.ConversationId) return out({ ok:false, status:lr2.status, reason:"no-conversation" });\n' +
    '    var cr = await get(base + "/messages?$filter=" + encodeURIComponent("ConversationId eq \'" + f2.ConversationId + "\'") + "&$select=Id,ConversationId&$top=20");\n' +
    '    if (cr.status !== 200 || !cr.json) return out({ ok:false, status:cr.status });\n' +
    '    var cv = Array.isArray(cr.json.value) ? cr.json.value : [];\n' +
    '    return out({ ok:true, status:200, conversationCount: cv.length, allSameConv: cv.every(function(x){ return x.ConversationId === f2.ConversationId; }), wouldMarkRead:false });\n' +
    '  }\n' +
    '  return out({ ok:false, status:0, error:"unknown-action" });\n' +
    '})()';
}

// Real attachment-chip elements only — no generic button/anchor fallbacks (review B1).
const ATT_CHIP_SELECTOR = '[data-attachmentid], [aria-label*="attachment" i]';

// A small probe that reads the DOM to see whether a recent message has an attachment chip (P-ATT gate).
function buildAttachChipScript() {
  return '(function(){ /*owa-probe:att-chip*/ try {' +
    ' var sel = ' + JSON.stringify(ATT_CHIP_SELECTOR) + ';' +
    ' var chips = document.querySelectorAll(sel); var hrefShapes = [];' +
    ' for (var i=0;i<chips.length && hrefShapes.length<3;i++){ var a = chips[i].tagName === "A" ? chips[i] : chips[i].querySelector("a[href]");' +
    '   if (a && a.getAttribute("href")){ try { var u = new URL(a.getAttribute("href"), location.href); hrefShapes.push({ https: u.protocol === "https:", host: u.hostname, hasQuery: !!u.search }); } catch(e){} } }' +
    ' return JSON.stringify({ chipCount: chips.length, hrefShapes: hrefShapes }); } catch(e){ return JSON.stringify({ chipCount: 0, hrefShapes: [] }); } })()';
}

// ───────────────────────────── Tier 2 child source ─────────────────────────────
// The child is a plain Node process with NO Electron session. It receives cookies/canary/token
// ONLY over stdin (an IPC-style JSON message), never argv/env/disk, performs ONE read-only GET to an
// outlook host, and prints status/shape/latency. The source is written to a temp file at run time but
// contains NO secret — the secret only ever arrives on the child's stdin.
const TIER2_CHILD_SOURCE = [
  "'use strict';",
  "// dev-only Tier 2 probe child — reads one JSON line of {url, headerNames, headers} from stdin,",
  "// issues ONE read-only GET, prints {status, shape, latencyMs}. Host-filtered to outlook mail hosts.",
  "const https = require('https');",
  "const HOSTS = ['outlook.office365.com','outlook.office.com','outlook.cloud.microsoft'];",
  "function allowed(h){ h=String(h||'').toLowerCase(); return HOSTS.some(function(x){ return h===x || h.endsWith('.'+x); }); }",
  "function shape(v,d){ d=d||0; if(v===null) return 'null'; if(Array.isArray(v)) return '['+(v.length?(d<2?shape(v[0],d+1):'…'):'')+' x'+v.length+']'; var t=typeof v; if(t!=='object') return t; if(d>=3) return '{…}'; var o={}; Object.keys(v).slice(0,30).forEach(function(k){o[k]=shape(v[k],d+1);}); return o; }",
  "let buf='';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', function(c){ buf+=c; });",
  "process.stdin.on('end', run);",
  "setTimeout(function(){ if(!buf) run(); }, 15000).unref();",
  "function run(){",
  "  let msg=null; try { msg=JSON.parse(buf||'{}'); } catch(e){ msg=null; }",
  "  if(!msg || typeof msg.url!=='string'){ console.log(JSON.stringify({status:0, error:'no-input'})); process.exit(0); return; }",
  "  let u; try { u=new URL(msg.url); } catch(e){ console.log(JSON.stringify({status:0, error:'bad-url'})); process.exit(0); return; }",
  "  if(u.protocol!=='https:' || !allowed(u.hostname)){ console.log(JSON.stringify({status:0, error:'host-blocked'})); process.exit(0); return; }",
  "  const headers = Object.assign({ accept:'application/json' }, (msg.headers && typeof msg.headers==='object') ? msg.headers : {});",
  "  const t0=Date.now();",
  "  const req=https.request({ method:'GET', hostname:u.hostname, path:u.pathname+u.search, headers:headers }, function(res){",
  "    let data=''; let n=0; res.on('data', function(ch){ n+=ch.length; if(n<=262144) data+=ch; });",
  "    res.on('end', function(){ let j=null; try{ j=JSON.parse(data); }catch(e){} console.log(JSON.stringify({ status:res.statusCode, shape: j?shape(j,0):null, bytes:n, latencyMs: Date.now()-t0 })); process.exit(0); });",
  "  });",
  "  req.on('error', function(e){ console.log(JSON.stringify({ status:0, error:String(e&&e.code||'err').slice(0,40), latencyMs: Date.now()-t0 })); process.exit(0); });",
  "  req.end();",
  "}",
].join('\n');

// ───────────────────────────── the run ─────────────────────────────
let _running = false;

/**
 * start({ log, env, _electron, _openSession, _spawnChild, _now, immediate }) — the ONLY entry point.
 * Inert and returns false unless env[FLEET_OWA_PROBE_DIR] is set. Schedules exactly one run on an
 * unref'd timer (or runs immediately in tests). Never creates a window/listener/child at call time.
 */
function start(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const dir = env[ENV_DIR];
  const log = _logger(d.log);
  if (!dir) return false;                                     // INERT: nothing scheduled, created or required with side effects
  const delay = Number.isFinite(d.delayMs) ? d.delayMs : Number(env.FLEET_OWA_PROBE_DELAY_MS) || DEFAULT_DELAY_MS;
  const launch = () => { run(Object.assign({}, d, { dir, log })).catch((e) => log.warn('[owa-probe] run threw: ' + _errName(e))); };
  if (d.immediate) { launch(); return true; }
  const t = setTimeout(launch, delay);
  if (t && typeof t.unref === 'function') t.unref();
  log.info('[owa-probe] armed (runs ~' + Math.round(delay / 1000) + 's after startup)');
  return true;
}

/** run(deps) — opens the hidden window, runs Parts A/B/C, writes JSON, logs `[owa-probe] done`. */
async function run(deps) {
  const d = deps || {};
  const dir = d.dir || (d.env || process.env)[ENV_DIR];
  const log = _logger(d.log);
  if (!dir) return { ok: false, reason: 'no-dir' };
  if (_running) { log.info('[owa-probe] already running'); return { ok: false, reason: 'already-running' }; }
  _running = true;

  const electron = d._electron || _tryElectron();
  const openSession = d._openSession || _tryOpenSession();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const summary = { at: new Date().toISOString(), authBlocked: false, partA: 0, partB: null, windowless: [] };
  const recorder = createNetworkRecorder();
  const auth = createAuthCapture();
  const overallMs = Number.isFinite(d._overallTimeoutMs) ? d._overallTimeoutMs : OVERALL_TIMEOUT_MS;
  const reserveMs = Number.isFinite(d._reserveMs) ? d._reserveMs : RESERVE_MS;
  // ONE deadline for the whole run; every phase is sized from what remains of it.
  const deadline = Date.now() + overallMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const ac = new AbortController();
  const win = { ref: null };        // the harness's own hidden window (set by the driver)
  let child = null;
  let wrote = { intel: false, network: false, api: false };
  const tiers = [];

  const killChild = () => { try { if (child && typeof child.kill === 'function' && !child.killed) child.kill(); } catch (_) { /* child gone */ } };
  const closeWin = () => { try { if (win.ref && !win.ref.isDestroyed()) win.ref.close(); } catch (_) { /* closing */ } };
  const abortAll = () => { try { if (!ac.signal.aborted) ac.abort(); } catch (_) { /* aborted */ } closeWin(); killChild(); };

  // Overall hard stop: abort openSession / domProbe, close our window, kill any child.
  let hardTimer = null;
  const hardStop = new Promise((resolve) => {
    hardTimer = setTimeout(() => { summary.timedOut = true; abortAll(); resolve({ timedOut: true }); }, overallMs);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
  });

  try {
    // ── Part C Tier 1 (a): windowless BEFORE any window is opened (cookie store only). ──
    tiers.push(await Promise.race([_tier1(electron, log, 'before-window', { auth: null, timeoutMs: Math.min(NET_TIMEOUT_MS, remaining()) }), hardStop.then(() => _tierTimeout(1, 'before-window'))]));

    // ── Parts A + B run inside ONE hidden window via openSession, bounded by deadline - reserve. ──
    const windowBudget = Math.max(1_000, remaining() - reserveMs);
    const warmupMs = Math.max(1_000, Math.min(WARMUP_MAX_MS, Math.floor(windowBudget / 4)));
    const sessionTimeoutMs = Math.max(1_000, windowBudget - warmupMs);
    let phaseTimer = null;
    const phaseStop = new Promise((resolve) => {
      phaseTimer = setTimeout(() => resolve({ timedOut: true }), windowBudget);
      if (phaseTimer && typeof phaseTimer.unref === 'function') phaseTimer.unref();
    });
    const windowRun = _runInWindow({ electron, openSession, recorder, auth, log, deps: d, signal: ac.signal, warmupMs, sessionTimeoutMs, win, remaining });
    let inWindow = await Promise.race([windowRun, phaseStop, hardStop]);
    clearTimeout(phaseTimer);
    let windowClosedConfirmed = true;
    if (inWindow && inWindow.timedOut) {
      summary.windowTimedOut = true;
      log.warn('[owa-probe] window phase hit its budget; aborting and closing the hidden window');
      abortAll();
      // Wait (bounded) for openSession to settle, which closes the window on abort.
      const settled = await Promise.race([windowRun, _sleep(Math.min(SETTLE_WAIT_MS, remaining()))]);
      closeWin();
      windowClosedConfirmed = await _waitClosed(win.ref, Math.min(CLOSE_WAIT_MS, remaining()));
      inWindow = settled && settled.partA ? settled : { partA: { authBlocked: false, probes: [] }, api: { ok: false, reason: 'window-timeout' } };
    } else {
      closeWin();
      // BrowserWindow.close() is async: isDestroyed() flips only after 'closed', so poll (bounded).
      windowClosedConfirmed = await _waitClosed(win.ref, Math.min(CLOSE_WAIT_MS, remaining()));
    }
    summary.windowClosed = windowClosedConfirmed;
    const partA = (inWindow && inWindow.partA) || { authBlocked: true, probes: [] };
    const apiReplay = (inWindow && inWindow.api) || { ok: false, reason: 'no-window' };
    summary.authBlocked = !!partA.authBlocked;
    summary.partA = Array.isArray(partA.probes) ? partA.probes.length : 0;
    summary.partB = apiReplay.ok ? 'ok' : (apiReplay.reason || 'fail');

    _writeJson(dir, 'owa-probe-intel-' + ts + '.json', { at: summary.at, authBlocked: partA.authBlocked, probes: partA.probes }); wrote.intel = true;
    _writeJson(dir, 'owa-probe-network-' + ts + '.json', { at: summary.at, requests: recorder.finalize() }); wrote.network = true;
    _writeJson(dir, 'owa-probe-api-' + ts + '.json', { at: summary.at, replay: apiReplay, authCapture: auth.describe(), sendCall: _staticSendCallFinding(recorder) }); wrote.api = true;

    // ── Part C Tier 1 (b): windowless AFTER the window has been closed (cookies, then captured reuse). ──
    if (!windowClosedConfirmed) {
      tiers.push({ tier: 1, ok: false, reason: 'window-not-confirmed-closed', authMaterialNeeded: [], obtainableWithoutPage: false, ms: 0, whenRun: 'after-window-closed' });
    } else if (ac.signal.aborted && summary.timedOut) {
      tiers.push(_tierTimeout(1, 'after-window-closed'));
    } else {
      tiers.push(await Promise.race([
        _tier1(electron, log, 'after-window-closed', { auth, timeoutMs: Math.min(NET_TIMEOUT_MS, remaining()), reuseDelayMs: Number.isFinite(d._reuseDelayMs) ? d._reuseDelayMs : REUSE_DELAY_MS, remaining }),
        hardStop.then(() => _tierTimeout(1, 'after-window-closed')),
      ]));
    }
    // ── Part C Tier 2: plain Node child; auth material copied in memory, stdin ONLY, outlook-scoped. ──
    if (summary.timedOut) tiers.push(_tierTimeout(2, 'after-window-closed'));
    else {
      tiers.push(await Promise.race([
        _tier2({ electron, log, auth, spawn: d._spawnChild, onChild: (c) => { child = c; }, timeoutMs: Math.min(CHILD_TIMEOUT_MS, remaining()) }),
        hardStop.then(() => _tierTimeout(2, 'after-window-closed')),
      ]));
    }
    // ── Part C Tier 3: reasoning only, never run. ──
    tiers.push(_tier3());

    summary.windowless = tiers.map((t) => ({ tier: t.tier, ok: t.ok, when: t.whenRun, reason: t.reason }));
    _writeJson(dir, 'owa-probe-windowless-' + ts + '.json', { at: summary.at, tiers });

    abortAll();
    log.info('[owa-probe] done ' + JSON.stringify(summary));
    return { ok: true, summary };
  } catch (e) {
    abortAll();
    try {
      if (!wrote.intel) _writeJson(dir, 'owa-probe-intel-' + ts + '.json', { at: summary.at, error: _errName(e), probes: [] });
      _writeJson(dir, 'owa-probe-windowless-' + ts + '.json', { at: summary.at, error: _errName(e), tiers });
    } catch (_) { /* best-effort */ }
    log.warn('[owa-probe] done (error) ' + _errName(e) + ' ' + JSON.stringify(summary));
    return { ok: false, reason: _errName(e), summary };
  } finally {
    clearTimeout(hardTimer);
    abortAll();
    auth.clear();                    // drop captured auth material from memory
    _running = false;
  }
}

function _tierTimeout(tier, whenRun) {
  return { tier, ok: false, reason: 'timeout', authMaterialNeeded: [], obtainableWithoutPage: false, ms: 0, whenRun };
}
function _sleep(ms) { return new Promise((r) => { const t = setTimeout(r, Math.max(0, ms)); if (t && t.unref) t.unref(); }); }
function _isDestroyed(w) { try { return !!w.isDestroyed(); } catch (_) { return true; } }
/** Poll until the window reports destroyed (or none was set), up to ms. Returns the final state. */
async function _waitClosed(w, ms) {
  if (!w) return true;
  const until = Date.now() + Math.max(0, ms || 0);
  while (!_isDestroyed(w) && Date.now() < until) await _sleep(CLOSE_POLL_MS);
  return _isDestroyed(w);
}

// Part A + Part B inside the hidden window. Uses openSession, so the window is the harness's own,
// hidden, on defaultSession, and closed when the driver returns.
async function _runInWindow(o) {
  const { electron, openSession, recorder, auth, log, signal } = o;
  const deps = o.deps || {};
  const remaining = typeof o.remaining === 'function' ? o.remaining : () => OVERALL_TIMEOUT_MS;
  if (typeof openSession !== 'function') return { partA: { authBlocked: false, probes: await Promise.all(_partAReadonly(deps, null)) }, api: { ok: false, reason: 'no-openSession' } };

  const api = { ok: false };
  const partAProbes = [];
  const stop = (ctx) => (signal && signal.aborted) || (ctx && typeof ctx.stopped === 'function' && ctx.stopped());
  const driver = async (ctx) => {
    if (o.win) o.win.ref = ctx.win;   // so the harness can close it itself on timeout
    // Attach CDP network capture for the Part B metadata (names/shapes only) + in-memory auth capture.
    _attachCdp(ctx.win, recorder, log, auth);
    // ── Part A read-only probes ──
    for (const p of _partAReadonly(deps, ctx)) partAProbes.push(await p);
    if (stop(ctx)) return;
    // P-DOM / P-TZ via the shipped read-only dom-probe (addresses already masked there). It opens its
    // own window via openSession, so it gets the SAME abort signal and a budget sized from what remains.
    partAProbes.push(await _timed('P-DOM', async () => {
      const dp = deps._domProbe || _tryDomProbe();
      if (!dp) return { note: 'dom-probe-unavailable' };
      const budget = Math.max(1_000, Math.min(120_000, Math.floor(remaining() / 3)));
      const r = await dp.domProbe({ n: 3, _electron: electron, signal, timeoutMs: budget, warmupTimeoutMs: Math.min(WARMUP_MAX_MS, Math.floor(budget / 3)) });
      return { ok: !!r.ok, authBlocked: !!r.authBlocked, rows: r.rows, messages: r.messages, tz: r.tz };
    }));
    if (stop(ctx)) return;
    // P-TZ: report the offset only; NEVER call set-tz-verified.
    partAProbes.push(await _timed('P-TZ', async () => {
      const last = partAProbes.find((x) => x.id === 'P-DOM');
      const tz = last && last.result && last.result.tz ? last.result.tz : { compared: 0, match: null };
      return { compared: tz.compared, match: tz.match, maxDiffMinutes: tz.maxDiffMinutes, setTzVerifiedCalled: false };
    }));
    // P-ATT only if a recent message exposes an attachment chip.
    partAProbes.push(await _timed('P-ATT', async () => {
      const chip = await ctx.execJson(buildAttachChipScript());
      if (!chip || !chip.chipCount) return { skipped: true, reason: 'no-attachment-chip' };
      // read-only reachability of the first chip href via a ranged GET of the first bytes — no save.
      // Only an href found INSIDE/ON a real chip, on an Outlook host, is ever fetched (in-page check).
      const r = await ctx.execJson(_buildRangedHeadScript());
      return { chipCount: chip.chipCount, hrefShapes: chip.hrefShapes, reach: r, note: 'checked in the harness window; P-DOM opens messages in its own window, so a chip is usually absent here' };
    }));
    if (stop(ctx)) return;

    // ── Part B: replay the SPA's own read calls from the OWA origin, read-only. ──
    // The SPA authenticates REST calls with its own bearer + x-anchormailbox (cookies alone get 401),
    // so the replay forwards what CDP captured from this page, in memory only.
    const authHeaders = () => (auth && typeof auth.headers === 'function' ? auth.headers() : {});
    const list = await _timed('B-list', () => ctx.execJson(buildReplayScript({ action: 'list', max: 5, authHeaders: authHeaders() })));
    const get = await _timed('B-get', () => ctx.execJson(buildReplayScript({ action: 'get', authHeaders: authHeaders() })));
    const conv = await _timed('B-conversation', () => ctx.execJson(buildReplayScript({ action: 'conversation', authHeaders: authHeaders() })));
    const stab = await _timed('B-stability', () => ctx.execJson(buildReplayScript({ action: 'stability', authHeaders: authHeaders() })));
    api.ok = !!(list.result && list.result.ok);
    api.steps = { list: list.result, get: get.result, conversation: conv.result, stability: stab.result };
    api.anyWouldMarkRead = [list, get, conv, stab].some((s) => s.result && s.result.wouldMarkRead === true);
    if (!api.ok) api.reason = (list.result && (list.result.error || ('status-' + list.result.status))) || 'list-failed';
  };

  let authBlocked = false;
  try {
    // Budget sized from the single deadline: warmup + window timer together never pass deadline - reserve.
    const session = await openSession({ _electron: electron, signal, warmupTimeoutMs: o.warmupMs || WARMUP_MAX_MS, timeoutMs: o.sessionTimeoutMs || 60_000 }, driver);
    authBlocked = !!(session && session.settled && session.settled.authBlocked);
  } catch (e) {
    log.warn('[owa-probe] in-window phase failed: ' + _errName(e));
  }
  return { partA: { authBlocked, probes: partAProbes }, api };
}

function _partAReadonly(deps, ctx) {
  // Each returns a promise of a {id, ok, result, notes, ms} record (via _timed). Heavy external
  // modules are overridable via deps so unit tests can stub them (no relay spawn, no real store).
  const d = deps || {};
  const triage = d._triage || _safeRequire('../scrapers/email_triage');
  const intel = d._intel || _safeRequire('../email-intel');
  const canonAt = d._canonAt || _safeRequire('../email-intel/facts/canonical-at');
  const store = d._store || _safeRequire('../store');
  const laneMod = d._lane || _safeRequire('../email-intel/understand/lane');
  const statusMod = d._status || _safeRequire('../email-intel/reliability/status');
  const probes = [];

  probes.push(_timed('P-STATE-1', () => {
    const res = triage && triage.loadResults ? triage.loadResults() : { emails: [] };
    const emails = Array.isArray(res.emails) ? res.emails : [];
    const conf = {};
    let withFrom = 0;
    for (const e of emails) { const c = e && e.confidence; if (c != null) conf[c] = (conf[c] || 0) + 1; if (e && e.fromAddress) withFrom++; }
    return { count: emails.length, confidenceHistogram: conf, withFromAddress: withFrom, ranAt: res.ranAt || null, authBlocked: !!res.authBlocked };
  }));

  probes.push(_timed('P-STATE-2', () => {
    const cfg = triage && triage.getConfig ? triage.getConfig() : {};
    return { folders: cfg.folders || null, maxEmails: cfg.maxEmails || null, enabled: !!cfg.enabled, note: 'workers:status / health:snapshot require the app-UI sender guard; not called here' };
  }));

  probes.push(_timed('P-STATE-3', () => ({ note: 'fas:get-coverage / settings:get-domiciles are IPC-guarded; read via UI, not from the probe' })));

  probes.push(_timed('P-SENT', () => {
    const res = triage && triage.loadResults ? triage.loadResults() : { emails: [] };
    const emails = Array.isArray(res.emails) ? res.emails : [];
    const mix = {};
    for (const e of emails) { const s = (e && e.replyState) || 'none'; if (s !== 'none') mix[s] = (mix[s] || 0) + 1; }
    return { nonNoneReplyStates: mix };
  }));

  probes.push(_timed('P-AUTH', () => {
    let owaAuth = null;
    try { const st = intel && intel.getStatus ? intel.getStatus() : null; owaAuth = st && st.owaAuth ? st.owaAuth : (st ? { present: true } : null); } catch (_) { owaAuth = null; }
    return { owaAuth: owaAuth ? { state: owaAuth.state || 'unknown', blockedCount: owaAuth.blockedCount } : null, midwayGatedIndependently: true };
  }));

  probes.push(_timed('P-LIST-1', () => ({ note: 'row-scroll need is reported by P-DOM selectors.rowCount; default <=3 pages' })));

  probes.push(_timed('P-LANE', async () => {
    if (!laneMod || typeof laneMod.probeLane !== 'function') return { state: 'unavailable' };
    try { const r = await laneMod.probeLane(); const s = laneMod.state(); return { ok: !!r.ok, state: s.state }; } catch (_) { return { state: 'unavailable' }; }
  }));

  probes.push(_timed('P-GW', () => {
    const g = statusMod && typeof statusMod.gatewayFlags === 'function' ? statusMod.gatewayFlags() : null;
    return { gatewayFlags: g };
  }));

  probes.push(_timed('P-CANON-AT', () => {
    let doc = null;
    try { doc = store && store.load ? store.load('canonicalState', null) : null; } catch (_) { doc = null; }
    const units = doc && doc.units && typeof doc.units === 'object' ? doc.units : {};
    const parse = canonAt && canonAt.parseCanonicalAt;
    let parsed = 0; let unparsed = 0; const sources = {}; let sampled = 0;
    for (const id of Object.keys(units)) {
      if (sampled >= 200) break;
      const lmu = units[id] && units[id].lastMeaningfulUpdate;
      if (!lmu) continue;
      sampled++;
      sources[lmu.source || 'none'] = (sources[lmu.source || 'none'] || 0) + 1;
      if (parse) { const r = parse(lmu, units[id]); if (r && r.ms != null) parsed++; else unparsed++; }
    }
    return { unitsSampled: sampled, parsed, unparsed, sourceMix: sources };
  }));

  // When there's no window, only the pure probes above apply (P-DOM/P-TZ/P-ATT need the page).
  return probes;
}

// ───────────────────────────── Tier 1 (main-process, no page) ─────────────────────────────
const TIER1_PATH = '/api/v2.0/me/messages?$top=5&$orderby=ReceivedDateTime%20desc&$select=Id,ConversationId';

function _pushUnique(arr, v) { if (!arr.includes(v)) arr.push(v); }

/** Classify one GET outcome (status / redirect) — reason codes only. */
function _classify(r) {
  if (r.status === 200 && r.json) return 'ok';
  if (r.redirect) return r.toLogin ? 'redirect-to-login' : 'redirect-other';
  if (r.status === 401 || r.status === 403) return 'unauthorized';
  if (r.status === 429 || r.status === 503) return 'throttled';
  return 'status-' + r.status + (r.error ? ':' + r.error : '');
}

/**
 * _cookieInventory(session) — cookie NAMES per Outlook host (never values) plus the canary cookie
 * VALUE kept only in the returned closure-local object for the caller's in-memory use.
 */
async function _cookieInventory(session) {
  const byHost = {};
  let canaryValue = null;
  for (const h of OUTLOOK_HOSTS) {
    try {
      const cookies = await session.cookies.get({ domain: h });
      const list = (cookies || []).filter((c) => hostAllowed(String(c.domain || h).replace(/^\./, '')));
      byHost[h] = Array.from(new Set(list.map((c) => String(c.name)))).slice(0, 40).sort();
      const can = list.find((c) => /canary/i.test(String(c.name)) && c.value);
      if (can && !canaryValue) canaryValue = String(can.value);
    } catch (_) { byHost[h] = null; }
  }
  return { byHost, canaryValue };
}

async function _tier1(electron, log, whenRun, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const timeoutMs = Math.max(1, Math.min(NET_TIMEOUT_MS, Number.isFinite(o.timeoutMs) ? o.timeoutMs : NET_TIMEOUT_MS));
  const remaining = typeof o.remaining === 'function' ? o.remaining : () => OVERALL_TIMEOUT_MS;
  const rec = { tier: 1, ok: false, reason: '', authMaterialNeeded: [], obtainableWithoutPage: false, tokenLifetime: { hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' }, attempts: [], ms: 0, whenRun };
  try {
    if (!electron || !electron.session || !electron.net) { rec.reason = 'electron-unavailable'; rec.ms = Date.now() - t0; return rec; }
    const session = electron.session.defaultSession;
    // Cookie NAMES for every Outlook host (the live session lands on outlook.cloud.microsoft).
    const inv = await _cookieInventory(session);
    rec.cookieNamesByHost = inv.byHost;
    rec.canaryAsCookie = !!inv.canaryValue;
    const captured = o.auth ? o.auth.describe() : null;
    if (captured && captured.bearer) rec.tokenLifetime = captured.bearer;
    // Prefer the host the SPA was actually observed calling (CDP), else outlook.office.com.
    const host = (o.auth && o.auth.host() && hostAllowed(o.auth.host())) ? o.auth.host() : 'outlook.office.com';
    rec.host = host;
    const url = 'https://' + host + TIER1_PATH;

    // Attempt 1: session cookies only (+ canary header iff the canary came from a cookie).
    const cookieHeaders = { accept: 'application/json' };
    if (inv.canaryValue) cookieHeaders['x-owa-canary'] = inv.canaryValue;
    inv.canaryValue = null;
    const a1 = await _netGet(electron, session, url, cookieHeaders, timeoutMs);
    rec.attempts.push(_attemptRecord('cookies-only', a1, cookieHeaders));
    const c1 = _classify(a1);
    if (c1 === 'ok') {
      rec.ok = true; rec.reason = 'cookies-sufficient'; rec.obtainableWithoutPage = true;
      rec.responseShape = shapeOf(a1.json, 0);
      _pushUnique(rec.authMaterialNeeded, 'cookie');
      if (rec.canaryAsCookie) _pushUnique(rec.authMaterialNeeded, 'x-owa-canary(cookie)');
    } else {
      rec.reason = c1 === 'unauthorized' ? 'unauthorized-needs-more-than-cookies' : c1;
      _pushUnique(rec.authMaterialNeeded, 'cookie');
      if (c1 === 'redirect-to-login') _pushUnique(rec.authMaterialNeeded, 'interactive-session');
      // Attempt 2: reuse auth material captured ONCE from the hidden page (in memory, never stored).
      const capHeaders = o.auth ? o.auth.headers() : {};
      if (Object.keys(capHeaders).length) {
        const h2 = Object.assign({ accept: 'application/json' }, capHeaders);
        const a2 = await _netGet(electron, session, url, h2, timeoutMs);
        rec.attempts.push(_attemptRecord('captured-reuse', a2, h2));
        for (const k of Object.keys(capHeaders)) _pushUnique(rec.authMaterialNeeded, k === 'authorization' ? 'authorization(bearer)' : k);
        if (_classify(a2) === 'ok') {
          rec.ok = true; rec.reason = 'needs-page-captured-material-reusable'; rec.obtainableWithoutPage = false;
          rec.responseShape = shapeOf(a2.json, 0);
          // Refresh behaviour: re-run after a delay, only if it fits inside the overall budget.
          const delay = Number.isFinite(o.reuseDelayMs) ? o.reuseDelayMs : REUSE_DELAY_MS;
          if (delay > 0 && remaining() > delay + timeoutMs + 5_000) {
            await _sleep(delay);
            const a3 = await _netGet(electron, session, url, h2, timeoutMs);
            rec.attempts.push(_attemptRecord('captured-reuse-after-' + Math.round(delay / 1000) + 's', a3, h2));
            rec.reuseStillValidAfterDelay = _classify(a3) === 'ok';
          } else rec.reuseStillValidAfterDelay = null;
        } else {
          rec.reason += '+captured-reuse-' + _classify(a2);
        }
        for (const k of Object.keys(h2)) h2[k] = null;
      } else if (c1 === 'unauthorized') {
        _pushUnique(rec.authMaterialNeeded, 'authorization(bearer)');
        rec.capturedMaterial = 'none-captured';
      }
    }
    for (const k of Object.keys(cookieHeaders)) cookieHeaders[k] = null;
  } catch (e) {
    rec.reason = _errName(e);
  }
  rec.ms = Date.now() - t0;
  return rec;
}

function _attemptRecord(mode, r, headers) {
  return {
    mode, status: r.status, outcome: _classify(r), redirect: !!r.redirect, toLogin: r.redirect ? !!r.toLogin : null,
    retryAfterPresent: !!r.retryAfter, headerNamesSent: Object.keys(headers || {}).map((k) => k.toLowerCase()).sort(), latencyMs: r.latencyMs,
  };
}

/**
 * _netGet — one read-only GET via Electron net.request on the given session. redirect:'manual' plus a
 * 'redirect' listener: a 3xx is recorded as {status, redirect:true, toLogin} (the target URL is
 * tested against AUTH_HOST_RE and discarded, never stored) and the request is aborted.
 */
function _netGet(electron, session, url, headers, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); v.latencyMs = Date.now() - t0; resolve(v); };
    let req;
    let timer = null;
    try {
      req = electron.net.request({ method: 'GET', url, session, useSessionCookies: true, credentials: 'include', redirect: 'manual' });
    } catch (e) { resolve({ status: 0, error: _errName(e), latencyMs: Date.now() - t0 }); return; }
    let data = ''; let n = 0;
    timer = setTimeout(() => { try { req.abort(); } catch (_) { /* aborting */ } done({ status: 0, error: 'timeout' }); }, Math.max(1, timeoutMs || NET_TIMEOUT_MS));
    req.on('redirect', (statusCode, _method, redirectUrl) => {
      const toLogin = AUTH_HOST_RE.test(String(redirectUrl || ''));
      done({ status: Number(statusCode) || 302, redirect: true, toLogin });   // settle first: abort may emit 'abort' synchronously
      try { req.abort(); } catch (_) { /* aborting */ }
    });
    req.on('response', (res) => {
      const hdrs = (res && res.headers) || {};
      const retryAfter = Object.keys(hdrs).some((k) => k.toLowerCase() === 'retry-after');
      res.on('data', (c) => { n += c.length; if (n <= REPLAY_MAX_BYTES) data += c.toString('utf8'); });
      res.on('end', () => { let j = null; try { j = JSON.parse(data); } catch (_) { /* non-json */ } data = ''; done({ status: res.statusCode, json: j, retryAfter }); });
    });
    req.on('abort', () => done({ status: 0, error: 'aborted' }));
    req.on('error', (e) => done({ status: 0, error: _errName(e) }));
    const H = headers || { accept: 'application/json' };
    for (const k of Object.keys(H)) {
      if (H[k] != null) { try { req.setHeader(k, H[k]); } catch (_) { /* header rejected */ } }
    }
    req.end();
  });
}

// ───────────────────────────── Tier 2 (plain Node child, stdin only) ─────────────────────────────
async function _tier2(o) {
  const { electron, log } = o;
  const t0 = Date.now();
  const rec = {
    tier: 2, ok: false, reason: '', authMaterialNeeded: [], obtainableWithoutPage: false, ms: 0, whenRun: 'after-window-closed',
    securityNotes: 'A bare Node process holding a live Outlook session cookie is a credential-exfiltration surface; kept in-memory, host-scoped, short-lived, never logged.',
    workerIsolationConflict: 'The worker-isolation host forbids all network I/O (http/https/net/child_process are on FORBIDDEN_MODULES). This tier therefore uses a SEPARATE short-lived dev child and does NOT modify the worker host isolation rules.',
    passedVia: 'stdin',
  };
  let child = null;
  const timeoutMs = Math.max(1, Math.min(CHILD_TIMEOUT_MS, Number.isFinite(o.timeoutMs) ? o.timeoutMs : CHILD_TIMEOUT_MS));
  try {
    const host = (o.auth && o.auth.host() && hostAllowed(o.auth.host())) ? o.auth.host() : 'outlook.office.com';
    const url = 'https://' + host + TIER1_PATH;
    if (!hostAllowed(url)) { rec.reason = 'host-blocked'; rec.ms = Date.now() - t0; return rec; }
    rec.host = host;

    // Build the auth material IN MEMORY in main: the cookies the session would send to this exact
    // URL (cookies.get({url})), re-filtered to Outlook-domain cookies, + canary (cookie or captured)
    // + any bearer / anchor captured from the hidden page. Only NAMES are ever recorded.
    let headers = { accept: 'application/json' };
    const session = electron && electron.session && electron.session.defaultSession;
    let cookiePairs = [];
    if (session && session.cookies) {
      try {
        const cookies = await session.cookies.get({ url });
        cookiePairs = (cookies || []).filter((c) => c && c.name && hostAllowed(String(c.domain || host).replace(/^\./, '')));
      } catch (_) { cookiePairs = []; }
    }
    if (cookiePairs.length) {
      headers.cookie = cookiePairs.map((c) => c.name + '=' + c.value).join('; ');
      _pushUnique(rec.authMaterialNeeded, 'cookie');
      const can = cookiePairs.find((c) => /canary/i.test(String(c.name)) && c.value);
      if (can) { headers['x-owa-canary'] = String(can.value); _pushUnique(rec.authMaterialNeeded, 'x-owa-canary(cookie)'); }
    }
    rec.cookieNamesTransferred = Array.from(new Set(cookiePairs.map((c) => String(c.name)))).sort().slice(0, 40);
    cookiePairs = null;
    const cap = o.auth ? o.auth.headers() : {};
    for (const k of Object.keys(cap)) {
      if (k === 'x-owa-canary' && headers['x-owa-canary']) continue;
      headers[k] = cap[k];
      _pushUnique(rec.authMaterialNeeded, k === 'authorization' ? 'authorization(bearer)' : k + '(captured)');
    }
    rec.headerNamesTransferred = Object.keys(headers).sort();

    const spawn = o.spawn || _defaultSpawnChild;
    const res = await new Promise((resolve) => {
      let out = ''; let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const timer = setTimeout(() => { try { if (child && !child.killed) child.kill(); } catch (_) {} done({ status: 0, error: 'timeout' }); }, timeoutMs);
      try {
        // The spawner receives ONLY the secret-free source — never the auth material.
        child = spawn(TIER2_CHILD_SOURCE);
      } catch (e) { clearTimeout(timer); done({ status: 0, error: _errName(e) }); return; }
      if (o.onChild) o.onChild(child);
      if (child.stdout) child.stdout.on('data', (c) => { out += c.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(timer); done({ status: 0, error: _errName(e) }); });
      child.on('exit', () => { clearTimeout(timer); let j = null; try { j = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || '{}'); } catch (_) { j = null; } done(j || { status: 0, error: 'no-output' }); });
      // The ONE place auth material leaves main: a single stdin write, then the reference is dropped.
      try { child.stdin.write(JSON.stringify({ url, headers })); child.stdin.end(); } catch (_) { /* child may have exited */ }
      for (const k of Object.keys(headers)) headers[k] = null;
      headers = null;
    });
    rec.status = res && res.status;
    rec.latencyMs = res && res.latencyMs;
    if (res && res.status === 200) {
      rec.ok = true; rec.reason = 'transferred-material-sufficient-in-plain-node';
      rec.obtainableWithoutPage = !rec.authMaterialNeeded.some((n) => /bearer|\(captured\)/.test(n));
      if (res.shape) rec.responseShape = res.shape;
    } else if (res && (res.status === 401 || res.status === 403)) rec.reason = 'unauthorized-with-transferred-material';
    else if (res && res.status >= 300 && res.status < 400) rec.reason = 'redirect';
    else if (res && res.error === 'host-blocked') rec.reason = 'host-blocked';
    else rec.reason = 'status-' + (res && res.status) + (res && res.error ? ':' + res.error : '');
    if (!rec.authMaterialNeeded.length) rec.reason += '+no-material-available';
    rec.conclusion = 'A plain Node child has no cookie jar of its own; it only works with session material copied in-memory from main over stdin, which is a real credential-handling surface.';
  } catch (e) {
    rec.reason = _errName(e);
  } finally {
    try { if (child && typeof child.kill === 'function' && !child.killed) child.kill(); } catch (_) { /* child gone */ }
  }
  rec.ms = Date.now() - t0;
  return rec;
}

function _defaultSpawnChild(source, deps) {
  const d = deps || {};
  const cp = d._cp || require('child_process');
  const os = d._os || require('os');
  const fsx = d._fs || require('fs');
  // The source holds NO secret; only the secret-free probe body is written. The spec rides stdin.
  const file = path.join(os.tmpdir(), 'owa-probe-tier2-' + process.pid + '-' + Date.now() + '.cjs');
  fsx.writeFileSync(file, source, 'utf8');
  const child = cp.fork(file, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const cleanup = () => { try { fsx.unlinkSync(file); } catch (_) { /* gone */ } };
  child.on('exit', cleanup);
  return child;
}

// ───────────────────────────── Tier 3 (browser-free from scratch) ─────────────────────────────
function _tier3() {
  return {
    tier: 3, ok: false, whenRun: 'reasoning-only',
    reason: 'A cold process has no cookies and no token. OWA\'s own endpoints require the authenticated session established interactively via Midway/MS SSO. Minting a token from scratch requires app registration / device-code / ROPC / OAuth — all explicitly disallowed (and Microsoft Graph is excluded). Not attempted; no network call is made.',
    authMaterialNeeded: ['app-registration-or-oauth(disallowed)'],
    obtainableWithoutPage: false,
    ms: 0,
  };
}

// ───────────────────────────── CDP + helpers ─────────────────────────────
function _attachCdp(win, recorder, log, auth) {
  try {
    if (!win || !win.webContents) return;
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    dbg.sendCommand('Network.enable');
    dbg.on('message', (_e, method, params) => {
      try {
        if (method === 'Network.requestWillBeSent') {
          recorder.recordRequest(params);           // names/shapes only (persisted)
          if (auth) auth.observe(params);           // values in memory only (never persisted)
        }
        else if (method === 'Network.responseReceived') recorder.recordResponse(params);
      } catch (_) { /* metadata only */ }
    });
  } catch (e) { log.warn('[owa-probe] CDP attach failed: ' + _errName(e)); }
}

/**
 * A ranged GET of only the first bytes of an attachment-chip href (P-ATT reachability). Only an
 * anchor that IS a real chip or sits INSIDE one is considered (no generic a[href] / button fallback),
 * and only if it is https, has no credentials/port, is on an Outlook host, and its path carries no
 * mutating verb. Anything else is `no-handle` / `bad-host` and is never fetched. Body is cancelled
 * unread; nothing is saved.
 */
function _buildRangedHeadScript() {
  const cfg = JSON.stringify({ sel: ATT_CHIP_SELECTOR, hosts: OUTLOOK_HOSTS, deny: MUTATION_ACTION_RE.source });
  return '(async function(){ /*owa-probe:att-reach*/ try {' +
    ' var C = ' + cfg + '; var DENY = new RegExp(C.deny, "i");' +
    ' function hostOk(h){ h = String(h||"").toLowerCase(); for (var k=0;k<C.hosts.length;k++){ if (h === C.hosts[k] || h.slice(-(C.hosts[k].length+1)) === "." + C.hosts[k]) return true; } return false; }' +
    ' var chips = document.querySelectorAll(C.sel); var a = null; var sawHref = false;' +
    ' for (var i=0;i<chips.length && !a;i++){ var ch = chips[i]; var cands = [];' +
    '   if (ch.tagName === "A" && ch.getAttribute("href")) cands.push(ch.getAttribute("href"));' +
    '   var inner = ch.querySelectorAll("a[href]"); for (var j=0;j<inner.length && cands.length<5;j++) cands.push(inner[j].getAttribute("href"));' +
    '   for (var c=0;c<cands.length;c++){ sawHref = true; try { var u = new URL(cands[c], location.href);' +
    '     if (u.protocol !== "https:" || u.username || u.password || u.port || !hostOk(u.hostname) || DENY.test(u.pathname + u.search)) continue;' +
    '     a = u.href; break; } catch(e){} } }' +
    ' if (!a) return JSON.stringify({ ok:false, reason: sawHref ? "bad-host" : "no-handle" });' +
    ' var r = await fetch(a, { method:"GET", credentials:"include", redirect:"manual", headers:{ Range:"bytes=0-15" }, cache:"no-store" });' +
    ' try { if (r.body && r.body.cancel) r.body.cancel(); } catch(e){}' +
    ' return JSON.stringify({ ok: r.ok || r.status===206, status:r.status, mimetype:String((r.headers && r.headers.get("content-type"))||"").split(";")[0].slice(0,60) });' +
    ' } catch(e){ return JSON.stringify({ ok:false, reason:String(e&&e.name||"err").slice(0,40) }); } })()';
}

// Identify the SPA's SEND call shape from the observed requests ONLY (static inspection; nothing sent).
function _staticSendCallFinding(recorder) {
  const reqs = recorder.finalize();
  const sendShapes = reqs.filter((r) => r.wouldMutate).map((r) => ({ method: r.method, pathPattern: r.pathPattern, action: r.action }));
  return {
    observedMutatingShapes: sendShapes,
    note: sendShapes.length
      ? 'Mutating shapes were observed on the wire but the harness never issued one; the send call the SPA uses for Reply/Reply All/New would be one of CreateItem+SendItem / ReplyToItem (MessageDisposition) on owa/service.svc, or POST /api/v2.0/me/messages/{id}/reply|replyAll or /sendMail on the v2.0 REST surface.'
      : 'No mutating request was observed during the read-only run (expected). From the v2.0 REST surface the send call is POST /api/v2.0/me/messages/{id}/reply, /replyAll, or /me/sendMail; the OWA service.svc surface uses CreateItem+SendItem or ReplyToItem with MessageDisposition=SendAndSaveCopy. Identified by shape only; NEVER issued.',
  };
}

async function _timed(id, fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { id, ok: !(result && (result.ok === false || result.skipped === true)), result, notes: '', ms: Date.now() - t0 };
  } catch (e) {
    return { id, ok: false, result: null, notes: _errName(e), ms: Date.now() - t0 };
  }
}

function _writeJson(dir, name, obj) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* exists */ }
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 1));
}

function _logger(log) {
  if (log && typeof log.info === 'function') return log;
  try { const l = require('../utils/logger')('owa-probe'); return l; } catch (_) { return { info() {}, warn() {}, error() {} }; }
}
function _errName(e) {
  const name = (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error';
  const code = (e && typeof e === 'object' && e.code != null) ? String(e.code) : '';
  return (name + ':' + code).replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 60);
}
function _tryElectron() { try { return require('electron'); } catch (_) { return null; } }
function _tryOpenSession() { try { return require('../email-intel/capture/owa_capture').openSession; } catch (_) { return null; } }
function _tryDomProbe() { try { return require('../email-intel/capture/dom-probe'); } catch (_) { return null; } }
function _safeRequire(spec) { try { return require(spec); } catch (_) { return null; } }

module.exports = {
  start,
  run,
  ENV_DIR,
  OUTLOOK_HOSTS,
  // helpers exported for unit tests
  maskAddress,
  maskText,
  collapsePath,
  headerNames,
  shapeOf,
  hostAllowed,
  createNetworkRecorder,
  buildReplayScript,
  buildAttachChipScript,
  TIER2_CHILD_SOURCE,
  jwtExpShape,
  createAuthCapture,
  ATT_CHIP_SELECTOR,
  _buildRangedHeadScript,
  _netGet,
  _tier1,
  _tier2,
  _tier3,
  _defaultSpawnChild,
  _staticSendCallFinding,
  _waitClosed,
};
