'use strict';
/**
 * dev/dev-zoom-probe.js — DEV-ONLY, env-gated, READ-ONLY Zoom portal API / windowless probe
 * harness (spike findings .agents/tasks/fleet-version-c-spike-zoom-2026-11-08/findings.md).
 *
 * Answers the user's question: can we read the user's OWN Zoom data through their signed-in
 * amazon.zoom.us portal session (Amazon SSO / Midway), what auth model does it use, and is any of
 * it reachable windowless? It is a discovery harness, NOT the integration. It is READ-ONLY
 * everywhere: it never creates/schedules/starts/joins/deletes/sends anything, never issues a
 * non-GET, never automates credentials, and never writes tokens, cookies, header values, meeting
 * topics, participant names, emails, join URLs or any PII/content to disk or logs.
 *
 * It mirrors src/dev/dev-owa-probe.js in structure and safety, and the Asana session.js pattern for
 * the hidden Midway-SSO window. It does NOT touch src/orcha/zoom.js / src/ipc/zoom.js (the blocked
 * OAuth path), does NOT modify auth/Midway/injectCookies, and does NOT add a VENDOR_PARTITIONS or
 * LOGIN_STRATEGIES entry — it picks its own partition name locally.
 *
 * Completely inert unless process.env.FLEET_ZOOM_PROBE_DIR is set: start() is the only entry point
 * and it returns immediately (no window, no timer, no listener, no child) when the env var is unset.
 *
 * When set: start() schedules one run a few minutes after startup (unref'd timer). The run opens its
 * OWN hidden BrowserWindow on a dedicated persist:fleet-zoom-probe partition seeded read-only with
 * Midway cookies via the existing scrapers/auth.injectCookies helper, completes Amazon SSO, loads
 * the signed-in portal pages, records CDP network metadata (names/shapes only), replays the portal's
 * own read-only GET calls for the user's own data, runs windowless tiers, writes zoom-probe-*.json
 * and always logs `[zoom-probe] done`. If SSO needs interactive sign-in it stops gracefully with a
 * needsInteractiveSignIn result and runs no replay.
 *
 * Output files under <FLEET_ZOOM_PROBE_DIR>:
 *   zoom-probe-network-<ts>.json    — CDP network metadata (method/host/pathPattern/names/shapes)
 *   zoom-probe-api-<ts>.json        — in-page read-only GET replay feasibility + auth model
 *   zoom-probe-windowless-<ts>.json — Tier 1/2/3 + observed WRITE classification (never issued)
 *   zoom-probe-signin-<ts>.json     — written instead of the above when SSO needs interactive sign-in
 */
const fs = require('fs');
const path = require('path');

const ENV_DIR = 'FLEET_ZOOM_PROBE_DIR';
// A few minutes after startup, after the first warm sessions / scheduler start have settled.
const DEFAULT_DELAY_MS = 150_000;
// Overall run budget, computed ONCE as a single deadline.
const OVERALL_TIMEOUT_MS = 5 * 60_000;
const RESERVE_MS = 75_000;              // reserved at the end for Tier 1(b)/Tier 2/writes/done log
const WARMUP_MAX_MS = 60_000;
const AUTH_WAIT_MS = 40_000;            // Amazon SAML/Midway SSO round-trip budget (mirrors Asana)
const NAV_SETTLE_MS = 8_000;            // let a loaded portal page fire its own authed calls
const CLOSE_WAIT_MS = 5_000;
const CLOSE_POLL_MS = 100;
const NET_TIMEOUT_MS = 20_000;
const CHILD_TIMEOUT_MS = 20_000;
const REUSE_DELAY_MS = 20_000;
const REPLAY_MAX_BYTES = 256 * 1024;

// Dedicated, disposable partition — NOT defaultSession, NOT the shipped OAuth persist:zoom (findings §3).
const PARTITION = 'persist:fleet-zoom-probe';
const PORTAL_URL = 'https://amazon.zoom.us/';
// Signed-in portal pages to load so the SPA fires its own authed back-end calls (CDP observes them).
// Live run 1 (2026-11-09) confirmed these pages drive the portal's OWN back-end calls on
// amazon.zoom.us: GET /profile, POST /rest/meeting/list (meetings), GET /nws/recording/1.0/recording-info
// and POST /nws/recording/1.0/host-list (recordings). The /meeting#/upcoming hash route is served by
// the same /meeting document, so it is dropped to avoid a redundant reload.
const SIGNED_IN_PAGES = Object.freeze(['/profile', '/meeting', '/recording']);

// Zoom hosts the probe is allowed to contact: the portal origin + any *.zoom.us regional fan-out host
// (findings §2: the captured call went to us01campaign.zoom.us with Origin amazon.zoom.us).
const ZOOM_HOST_SUFFIX = '.zoom.us';
const ZOOM_PORTAL_HOST = 'amazon.zoom.us';

// SSO / login hosts (mirrors Asana MIDWAY_RE). Used only to classify a redirect/landing; never stored.
const AUTH_HOST_RE = /midway|sso\.amazon|oidc|oauth|federate\.amazon|signin\.aws|login\.amazon|\/saml|\/signin|\/login\b/i;

// Header NAMES we care about reporting the PRESENCE of (never the values). Zoom-tuned.
const INTERESTING_HEADERS = Object.freeze([
  'cookie', 'authorization', 'zoom-csrftoken', 'x-zm-csrf', 'x-requested-with',
  'content-type', 'accept', 'referer', 'origin',
]);

// Any mutating verb / write-pattern path. The replay + windowless layers must NEVER issue one; this
// is used only to classify an observed request and to HARD-REFUSE a non-GET before it is sent.
const WRITE_METHOD_RE = /^(POST|PUT|PATCH|DELETE)$/i;
const WRITE_PATH_RE = /\b(create|schedule|start|join|delete|update|cancel|invite|register|rwg\/join|end)\b/i;

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
 * collapsePath('https://amazon.zoom.us/api/v2/users/me/meetings?type=upcoming&page_size=30&from=...') ->
 *   '/api/v2/users/me/meetings?type=upcoming&page_size=N'. Meeting ids, GUIDs, base64 ids, long numbers
 * and all query VALUES are stripped so only the path PATTERN and a small allow-list of structural query
 * param NAMES survive (never an id, a meeting number, a topic, an address or any value).
 */
const QUERY_KEY_ALLOW = Object.freeze(['type', 'page_size', 'page_number', 'view', 'next_page_token']);
function collapsePath(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { return '<bad-url>'; }
  let decoded = u.pathname;
  try { decoded = decodeURIComponent(u.pathname); } catch (_) { decoded = u.pathname.replace(/%40/gi, '@'); }
  let p = maskText(decoded.split('/').map((seg) => (seg.includes('@') ? '<addr>' : seg)).join('/'))
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/<guid>')   // GUIDs first
    .replace(/\/\d{5,}(?=\/|$)/g, '/<n>')                         // long numeric ids (meeting numbers), whole segment
    .replace(/\/[A-Za-z0-9+=_-]{22,}(?=\/|$)/g, '/<id>');         // base64-ish opaque ids (meeting uuids etc.), single segment
  // Keep only the allow-listed STRUCTURAL query keys; each value is normalized to N (never the value).
  const keptKeys = [];
  try {
    for (const k of Array.from(u.searchParams.keys())) {
      const lk = String(k).toLowerCase();
      if (QUERY_KEY_ALLOW.includes(lk) && !keptKeys.includes(lk)) keptKeys.push(lk);
    }
  } catch (_) { /* no query */ }
  if (!keptKeys.length) return p;
  keptKeys.sort();
  return p + '?' + keptKeys.map((k) => k + '=N').join('&');
}

/** Header NAMES only, lower-cased, de-duped, limited to the interesting set + any x-zm-* name (no values). */
function headerNames(headers) {
  const out = [];
  const h = headers && typeof headers === 'object' ? headers : {};
  for (const k of Object.keys(h)) {
    const name = String(k).toLowerCase();
    if (INTERESTING_HEADERS.includes(name) || name.startsWith('x-zm') || name.startsWith('zoom-')) {
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
/** hostAllowed(host|url) — true only for amazon.zoom.us and any *.zoom.us subdomain. */
function hostAllowed(hostOrUrl) {
  let h = String(hostOrUrl || '').toLowerCase();
  if (h.includes('://') || h.startsWith('//')) { try { h = new URL(h.startsWith('//') ? 'https:' + h : h).hostname.toLowerCase(); } catch (_) { return false; } }
  h = h.split('/')[0].split(':')[0];
  if (!h) return false;
  return h === ZOOM_PORTAL_HOST || h === 'zoom.us' || h.endsWith(ZOOM_HOST_SUFFIX);
}

/** True if a request is a WRITE (non-GET method OR a write-pattern path). Classification/refusal only. */
function isWriteRequest(method, urlOrPath) {
  if (WRITE_METHOD_RE.test(String(method || ''))) return true;
  let probe = String(urlOrPath || '');
  try { const u = new URL(probe); probe = u.pathname + u.search; } catch (_) { /* already a path */ }
  return WRITE_PATH_RE.test(probe);
}

// ───────────────────────────── CDP network recorder ─────────────────────────────
/**
 * NetworkRecorder — subscribes to Network.requestWillBeSent / responseReceived (via the CDP debugger)
 * and keeps ONLY: method, host, collapsed path pattern, structural query param NAMES, request/response
 * header NAMES, status, the response-body JSON key/type SHAPE, and a wouldWrite boolean. No urls with
 * ids, no header values, no bodies, no cookies, no tokens. record() is the single choke point.
 */
function createNetworkRecorder() {
  const byReq = new Map();        // requestId -> partial record
  const records = [];
  const seen = new Set();         // de-dupe identical {method, pathPattern}

  function recordRequest(params) {
    const req = (params && params.request) || {};
    const url = req.url || '';
    if (!hostAllowed(url)) return;
    let host = '';
    try { host = new URL(url).host; } catch (_) { host = '<bad>'; }
    let queryParamNames = [];
    try { queryParamNames = Array.from(new Set(Array.from(new URL(url).searchParams.keys()).map((k) => String(k).toLowerCase()))).sort().slice(0, 40); } catch (_) { queryParamNames = []; }
    const method = String(req.method || 'GET').toUpperCase();
    const rec = {
      method,
      host,
      pathPattern: collapsePath(url),
      queryParamNames,
      requestHeaderNames: headerNames(req.headers),
      wouldWrite: isWriteRequest(method, url),
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
      const key = rec.method + ' ' + rec.pathPattern;
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
 * createAuthCapture() — IN-MEMORY ONLY holder for the auth material the SPA sends to Zoom hosts
 * (cookie presence, authorization bearer, zoom-csrftoken / x-zm-csrf CSRF header), observed via CDP
 * requestWillBeSent. It exists so Tier 1(b)/Tier 2 can test "captured once from the page, reused
 * windowless". Values are reachable only through headers(); describe() returns names + a bearer
 * jwtExpShape (exp SHAPE only, never the token); clear() wipes everything. Nothing from here is ever
 * written to disk or the logger. Auth-model detection (cookie vs CSRF header vs bearer) is derived here.
 */
function createAuthCapture() {
  const KEEP = ['authorization', 'zoom-csrftoken', 'x-zm-csrf'];
  let vals = {};
  let cookiePresent = false;
  let host = '';
  let firstSeenAt = null;
  function observe(params) {
    const req = (params && params.request) || {};
    if (!hostAllowed(req.url)) return;
    const h = req.headers && typeof req.headers === 'object' ? req.headers : {};
    let hit = false;
    for (const k of Object.keys(h)) {
      const name = String(k).toLowerCase();
      if (name === 'cookie' && h[k]) { cookiePresent = true; hit = true; continue; }
      if (KEEP.includes(name) && typeof h[k] === 'string' && h[k]) { vals[name] = h[k]; hit = true; }
    }
    if (hit) {
      try { host = new URL(req.url).hostname.toLowerCase(); } catch (_) { /* keep previous */ }
      if (firstSeenAt == null) firstSeenAt = Date.now();
    }
  }
  function headers() { return Object.assign({}, vals); }
  function names() {
    const n = Object.keys(vals);
    if (cookiePresent) n.push('cookie');
    return n.sort();
  }
  /** Derived auth model, names only: 'cookie' | 'csrf-header' | 'bearer' | combinations, or 'unknown'. */
  function authModel() {
    const parts = [];
    if (cookiePresent) parts.push('cookie');
    if (vals['zoom-csrftoken'] || vals['x-zm-csrf']) parts.push('csrf-header');
    if (vals.authorization && /^Bearer\s/i.test(vals.authorization)) parts.push('bearer');
    return parts.length ? parts.join('+') : 'unknown';
  }
  function describe(nowMs) {
    return {
      namesObserved: names(),
      authModel: authModel(),
      host: host || null,
      bearer: vals.authorization && /^Bearer\s/i.test(vals.authorization) ? jwtExpShape(vals.authorization, nowMs) : { hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' },
      firstSeenAgoSec: firstSeenAt == null ? null : Math.round(((Number.isFinite(nowMs) ? nowMs : Date.now()) - firstSeenAt) / 1000),
    };
  }
  function clear() { vals = {}; cookiePresent = false; host = ''; firstSeenAt = null; }
  return { observe, headers, names, authModel, describe, clear, host: () => host, cookieSeen: () => cookiePresent };
}

// ───────────────────────────── in-page read-only replay script ─────────────────────────────
// The read-only GET targets the probe replays from the authenticated amazon.zoom.us context. Each is
// a PURE GET for the user's own data and reports presence/counts/key-shape only (never topics,
// participant names, emails, join URLs or any body text). Paths are relative to the portal origin.
// Live run 1 (2026-11-09) correction: amazon.zoom.us is NOT the public Marketplace REST API host, so the
// guessed /api/v2/* paths all 404'd. The CDP capture (zoom-probe-network-*.json) showed the portal's OWN
// authed back-end calls. The portal serves its list data over POST (/rest/meeting/list for meetings,
// /nws/recording/1.0/host-list for recordings, /wc/webapp/header for profile) and a few read endpoints over
// GET (/nws/recording/1.0/recording-info, /account/user/assistant_host). This probe is strictly read-only
// and issues GET ONLY, so a POST-only portal endpoint is recorded by SHAPE (portalMethod) and NOT retrieved
// (getRetrievable:false) rather than hitting it with a mismatched GET. Each target keeps its documented
// action name; `portalMethod` is the verb the portal itself used, recorded for the feasibility writeup.
const REPLAY_TARGETS = Object.freeze([
  { action: 'profile', path: '/account/user/assistant_host', portalMethod: 'GET', getRetrievable: true },
  { action: 'meetings-upcoming', path: '/rest/meeting/list', portalMethod: 'POST', getRetrievable: false },
  { action: 'meetings-previous', path: '/rest/meeting/list', portalMethod: 'POST', getRetrievable: false },
  { action: 'meeting-detail', path: '/rest/meeting/list', portalMethod: 'POST', getRetrievable: false },
  { action: 'recordings-list', path: '/nws/recording/1.0/host-list', portalMethod: 'POST', getRetrievable: false },
  { action: 'recording-transcript-availability', path: '/nws/recording/1.0/recording-info', portalMethod: 'GET', getRetrievable: true },
  { action: 'past-participants', path: '/nws/recording/1.0/host-list', portalMethod: 'POST', getRetrievable: false },
]);

const REPLAY_AUTH_HEADER_NAMES = ['authorization', 'zoom-csrftoken', 'x-zm-csrf'];
function _replayAuthHeaders(h) {
  const out = {};
  const src = h && typeof h === 'object' ? h : {};
  for (const k of Object.keys(src)) {
    const name = String(k).toLowerCase();
    if (REPLAY_AUTH_HEADER_NAMES.includes(name) && typeof src[k] === 'string' && src[k]) out[name] = src[k];
  }
  return out;
}

/**
 * buildReplayScript({ authHeaders, origin, bytesCap }) — page script (string) that runs the read-only
 * GET targets from the authenticated amazon.zoom.us context using the SPA's own cookies
 * (credentials:'include') plus any captured CSRF/bearer header (allow-listed NAMES only). It returns
 * ONLY booleans / counts / key-shapes — never body text, meeting topics, participant names, emails or
 * join URLs. It HARD-REFUSES any non-GET and any write-pattern path before issuing a request
 * (returns {refused:true}), so a write is structurally impossible.
 */
function buildReplayScript(o) {
  const authHeaders = _replayAuthHeaders(o && o.authHeaders);
  const hdrs = Object.assign({ accept: 'application/json' }, authHeaders);
  const cfg = JSON.stringify({
    headerNames: Object.keys(hdrs).sort(),
    targets: REPLAY_TARGETS,
    writePath: WRITE_PATH_RE.source,
    bytesCap: Math.max(1024, Math.trunc((o && o.bytesCap) || REPLAY_MAX_BYTES)),
  });
  return '(async function(){ /*zoom-probe:replay*/\n' +
    '  var C = ' + cfg + '; var H = ' + JSON.stringify(hdrs) + '; var DENY = new RegExp(C.writePath, "i");\n' +
    '  var base = location.origin; var out = {};\n' +
    '  function keys(j){ return (j && typeof j === "object" && !Array.isArray(j)) ? Object.keys(j).slice(0,30) : []; }\n' +
    '  function len(v){ return Array.isArray(v) ? v.length : (typeof v === "string" ? v.length : 0); }\n' +
    '  function present(v){ return v !== undefined && v !== null && v !== ""; }\n' +
    '  async function get(p){\n' +
    '    // HARD REFUSE any non-GET or write-pattern path before issuing anything.\n' +
    '    if (DENY.test(p)) return { refused:true, reason:"write-pattern-path" };\n' +
    '    var url = base + p; var t0 = (performance && performance.now) ? performance.now() : Date.now();\n' +
    '    var ac = new AbortController(); var to = setTimeout(function(){ ac.abort(); }, 30000);\n' +
    '    try { var r = await fetch(url, { method:"GET", credentials:"include", redirect:"manual", cache:"no-store", headers:H, signal:ac.signal });\n' +
    '      var latencyMs = Math.round(((performance&&performance.now)?performance.now():Date.now()) - t0);\n' +
    '      if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) return { status: r.status || 302, redirect:true, latencyMs:latencyMs };\n' +
    '      var text = ""; var n = 0; var reader = r.body && r.body.getReader ? r.body.getReader() : null;\n' +
    '      if (reader){ while(true){ var s = await reader.read(); if (s.done) break; n += s.value.length; if (n > C.bytesCap){ ac.abort(); break; } text += new TextDecoder().decode(s.value); } }\n' +
    '      else { text = await r.text(); }\n' +
    '      var json = null; try { json = JSON.parse(text); } catch(e){ json = null; }\n' +
    '      return { status:r.status, latencyMs:latencyMs, ok:r.status===200, topLevelKeys: keys(json), listCount: (json && Array.isArray(json.meetings)) ? json.meetings.length : (json && Array.isArray(json.recordings)) ? json.recordings.length : (json && Array.isArray(json.participants)) ? json.participants.length : null, hasData: present(json) };\n' +
    '    } catch(e){ return { status:0, error:String(e && e.name || "err").slice(0,40), latencyMs: Math.round(((performance&&performance.now)?performance.now():Date.now()) - t0) }; }\n' +
    '    finally { clearTimeout(to); }\n' +
    '  }\n' +
    '  for (var i=0;i<C.targets.length;i++){ var tgt = C.targets[i];\n' +
    '    // Skip targets whose path still contains an unresolved {placeholder} (no id discovered).\n' +
    '    if (/\\{[a-zA-Z]+\\}/.test(tgt.path)) { out[tgt.action] = { skipped:true, reason:"no-id-discovered" }; continue; }\n' +
    '    // The portal serves some data ONLY over POST. This probe is read-only / GET-only, so such an\n' +
    '    // endpoint is recorded by SHAPE (its real verb) and NEVER issued — not retrievable via a GET.\n' +
    '    if (tgt.getRetrievable === false) { out[tgt.action] = { skipped:true, notRetrievableViaGet:true, portalMethod: tgt.portalMethod || "POST", pathPattern: tgt.path }; continue; }\n' +
    '    out[tgt.action] = await get(tgt.path);\n' +
    '  }\n' +
    '  out.headerNamesSent = C.headerNames;\n' +
    '  return JSON.stringify(out);\n' +
    '})()';
}

// ───────────────────────────── Tier 2 child source ─────────────────────────────
// A plain Node process with NO Electron session. It receives {url, headers} ONLY over stdin (never
// argv/env/disk), issues ONE read-only GET to a *.zoom.us host (hard-refusing any non-GET or
// write-pattern path), and prints {status, shape, latencyMs}. The source holds NO secret — the auth
// material only ever arrives on the child's stdin.
const TIER2_CHILD_SOURCE = [
  "'use strict';",
  "// dev-only Tier 2 probe child — reads one JSON line of {url, headers} from stdin, issues ONE",
  "// read-only GET, prints {status, shape, latencyMs}. Host-filtered to *.zoom.us; writes refused.",
  "const https = require('https');",
  "function allowed(h){ h=String(h||'').toLowerCase(); return h==='amazon.zoom.us' || h==='zoom.us' || h.endsWith('.zoom.us'); }",
  "const WRITE_PATH=/\\b(create|schedule|start|join|delete|update|cancel|invite|register|end)\\b/i;",
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
  "  if(WRITE_PATH.test(u.pathname+u.search)){ console.log(JSON.stringify({status:0, error:'write-refused'})); process.exit(0); return; }",
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
 * start({ log, env, _electron, _spawnChild, delayMs, immediate }) — the ONLY entry point.
 * Inert and returns false unless env[FLEET_ZOOM_PROBE_DIR] is set. Schedules exactly one run on an
 * unref'd timer (or runs immediately in tests). Never creates a window/listener/child at call time.
 */
function start(deps) {
  const d = deps || {};
  const env = d.env || process.env;
  const dir = env[ENV_DIR];
  const log = _logger(d.log);
  if (!dir) return false;                                     // INERT: nothing scheduled or created
  const delay = Number.isFinite(d.delayMs) ? d.delayMs : Number(env.FLEET_ZOOM_PROBE_DELAY_MS) || DEFAULT_DELAY_MS;
  const launch = () => { run(Object.assign({}, d, { dir, log })).catch((e) => log.warn('[zoom-probe] run threw: ' + _errName(e))); };
  if (d.immediate) { launch(); return true; }
  const t = setTimeout(launch, delay);
  if (t && typeof t.unref === 'function') t.unref();
  log.info('[zoom-probe] armed (runs ~' + Math.round(delay / 1000) + 's after startup)');
  return true;
}

/** run(deps) — opens the hidden window, runs the window + windowless phases, writes JSON, logs done. */
async function run(deps) {
  const d = deps || {};
  const dir = d.dir || (d.env || process.env)[ENV_DIR];
  const log = _logger(d.log);
  if (!dir) return { ok: false, reason: 'no-dir' };
  if (_running) { log.info('[zoom-probe] already running'); return { ok: false, reason: 'already-running' }; }
  _running = true;

  const electron = d._electron || _tryElectron();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const at = new Date().toISOString();
  const summary = { at, partition: PARTITION, needsInteractiveSignIn: false, authModel: 'unknown', replay: null, windowless: [] };
  const recorder = createNetworkRecorder();
  const auth = createAuthCapture();
  const overallMs = Number.isFinite(d._overallTimeoutMs) ? d._overallTimeoutMs : OVERALL_TIMEOUT_MS;
  const reserveMs = Number.isFinite(d._reserveMs) ? d._reserveMs : RESERVE_MS;
  const deadline = Date.now() + overallMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const win = { ref: null };
  let child = null;
  const tiers = [];

  const killChild = () => { try { if (child && typeof child.kill === 'function' && !child.killed) child.kill(); } catch (_) { /* gone */ } };
  const closeWin = () => { try { if (win.ref && !_isDestroyed(win.ref)) win.ref.close(); } catch (_) { /* closing */ } };
  const abortAll = () => { closeWin(); killChild(); };

  let hardTimer = null;
  const hardStop = new Promise((resolve) => {
    hardTimer = setTimeout(() => { summary.timedOut = true; abortAll(); resolve({ timedOut: true }); }, overallMs);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
  });

  try {
    // ── Tier 1 (a): windowless BEFORE any window (partition cookie store only). ──
    tiers.push(await Promise.race([_tier1(electron, log, 'before-window', { auth: null, timeoutMs: Math.min(NET_TIMEOUT_MS, remaining()) }), hardStop.then(() => _tierTimeout(1, 'before-window'))]));

    // ── Hidden window: Midway-seeded SSO, read-only GET replay, bounded by deadline - reserve. ──
    const windowBudget = Math.max(1_000, remaining() - reserveMs);
    const windowRun = _runInWindow({ electron, recorder, auth, log, deps: d, win, remaining, budgetMs: windowBudget });
    let phaseTimer = null;
    const phaseStop = new Promise((resolve) => {
      phaseTimer = setTimeout(() => resolve({ timedOut: true }), windowBudget);
      if (phaseTimer && typeof phaseTimer.unref === 'function') phaseTimer.unref();
    });
    let inWindow = await Promise.race([windowRun, phaseStop, hardStop]);
    clearTimeout(phaseTimer);
    if (inWindow && inWindow.timedOut) {
      summary.windowTimedOut = true;
      log.warn('[zoom-probe] window phase hit its budget; closing the hidden window');
      closeWin();
      const settled = await Promise.race([windowRun, _sleep(Math.min(CLOSE_WAIT_MS, remaining()))]);
      inWindow = (settled && (settled.replay || settled.needsInteractiveSignIn)) ? settled : { needsInteractiveSignIn: false, replay: { ok: false, reason: 'window-timeout' } };
    } else {
      closeWin();
    }
    const windowClosedConfirmed = await _waitClosed(win.ref, Math.min(CLOSE_WAIT_MS, remaining()));
    summary.windowClosed = windowClosedConfirmed;

    const authDesc = auth.describe();
    summary.authModel = authDesc.authModel;

    // ── Graceful needs-sign-in: write the signin summary and skip replay/windowless-reuse. ──
    if (inWindow && inWindow.needsInteractiveSignIn) {
      summary.needsInteractiveSignIn = true;
      summary.lastUrlHost = inWindow.lastUrlHost || null;
      _writeJson(dir, 'zoom-probe-signin-' + ts + '.json', {
        at, needsInteractiveSignIn: true, lastUrlHost: inWindow.lastUrlHost || null,
        note: 'Amazon SSO/Midway did not land on a signed-in amazon.zoom.us page within the budget. The probe never automates credentials; a human must sign in interactively once, then re-run.',
      });
      _writeJson(dir, 'zoom-probe-network-' + ts + '.json', { at, requests: recorder.finalize() });
      // Tier 3 reasoning is still recorded; Tier 1(b)/Tier 2 have no page-captured material to reuse.
      tiers.push(_tier3());
      summary.windowless = tiers.map((t) => ({ tier: t.tier, ok: t.ok, when: t.whenRun, reason: t.reason }));
      _writeJson(dir, 'zoom-probe-windowless-' + ts + '.json', { at, tiers, note: 'needs-interactive-sign-in; no page-captured material to reuse' });
      abortAll();
      log.info('[zoom-probe] done ' + JSON.stringify(summary));
      return { ok: true, summary, needsInteractiveSignIn: true };
    }

    const replay = (inWindow && inWindow.replay) || { ok: false, reason: 'no-window' };
    summary.replay = replay.ok ? 'ok' : (replay.reason || 'fail');

    _writeJson(dir, 'zoom-probe-network-' + ts + '.json', { at, requests: recorder.finalize() });
    _writeJson(dir, 'zoom-probe-api-' + ts + '.json', {
      at, replay, authCapture: authDesc, writeClassification: _classifyWrite(recorder),
    });

    // ── Tier 1 (b): windowless AFTER the window closed (cookies, then captured reuse). ──
    if (!windowClosedConfirmed) {
      tiers.push({ tier: 1, ok: false, reason: 'window-not-confirmed-closed', authMaterialNeeded: [], obtainableWithoutPage: false, ms: 0, whenRun: 'after-window-closed' });
    } else if (summary.timedOut) {
      tiers.push(_tierTimeout(1, 'after-window-closed'));
    } else {
      tiers.push(await Promise.race([
        _tier1(electron, log, 'after-window-closed', { auth, timeoutMs: Math.min(NET_TIMEOUT_MS, remaining()), reuseDelayMs: Number.isFinite(d._reuseDelayMs) ? d._reuseDelayMs : REUSE_DELAY_MS, remaining }),
        hardStop.then(() => _tierTimeout(1, 'after-window-closed')),
      ]));
    }
    // ── Tier 2: plain Node child; auth material copied in memory, stdin ONLY, *.zoom.us-scoped. ──
    if (summary.timedOut) tiers.push(_tierTimeout(2, 'after-window-closed'));
    else {
      tiers.push(await Promise.race([
        _tier2({ electron, log, auth, spawn: d._spawnChild, onChild: (c) => { child = c; }, timeoutMs: Math.min(CHILD_TIMEOUT_MS, remaining()) }),
        hardStop.then(() => _tierTimeout(2, 'after-window-closed')),
      ]));
    }
    // ── Tier 3: reasoning only, never run. ──
    tiers.push(_tier3());

    summary.windowless = tiers.map((t) => ({ tier: t.tier, ok: t.ok, when: t.whenRun, reason: t.reason }));
    _writeJson(dir, 'zoom-probe-windowless-' + ts + '.json', { at, tiers });

    abortAll();
    log.info('[zoom-probe] done ' + JSON.stringify(summary));
    return { ok: true, summary };
  } catch (e) {
    abortAll();
    try {
      _writeJson(dir, 'zoom-probe-network-' + ts + '.json', { at, error: _errName(e), requests: recorder.finalize() });
      _writeJson(dir, 'zoom-probe-windowless-' + ts + '.json', { at, error: _errName(e), tiers });
    } catch (_) { /* best-effort */ }
    log.warn('[zoom-probe] done (error) ' + _errName(e) + ' ' + JSON.stringify(summary));
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
async function _waitClosed(w, ms) {
  if (!w) return true;
  const until = Date.now() + Math.max(0, ms || 0);
  while (!_isDestroyed(w) && Date.now() < until) await _sleep(CLOSE_POLL_MS);
  return _isDestroyed(w);
}

/**
 * _runInWindow — creates the probe's OWN hidden window on PARTITION, seeds Midway read-only, attaches
 * CDP BEFORE navigation, completes SSO (or stops gracefully), loads the signed-in pages so the SPA
 * fires its own authed calls, then runs the read-only GET replay. Returns { needsInteractiveSignIn,
 * lastUrlHost } on a sign-in wall, else { replay }.
 */
async function _runInWindow(o) {
  const { electron, recorder, auth, log, win } = o;
  const deps = o.deps || {};
  const remaining = typeof o.remaining === 'function' ? o.remaining : () => OVERALL_TIMEOUT_MS;
  if (!electron || !electron.BrowserWindow) return { replay: { ok: false, reason: 'electron-unavailable' } };

  const injectCookies = deps._injectCookies || _tryInjectCookies();
  const authWaitMs = Math.max(1_000, Math.min(AUTH_WAIT_MS, remaining() - 2_000));
  let w = null;
  try {
    w = new electron.BrowserWindow({
      show: false, skipTaskbar: true, x: -32000, y: -32000, width: 1280, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition: PARTITION },
    });
    win.ref = w;
    try { w.setWindowOpenHandler(() => ({ action: 'deny' })); } catch (_) { /* older electron */ }
    try { w.on('show', () => { try { w.hide(); } catch (_) {} }); } catch (_) { /* no-op */ }

    _attachCdp(w, recorder, log, auth);

    // Seed Midway read-only (never modify the helper). If unavailable, SSO will stall -> needs-sign-in.
    if (typeof injectCookies === 'function') {
      try { await injectCookies(w.webContents.session); } catch (e) { log.warn('[zoom-probe] injectCookies failed: ' + _errName(e)); }
    }

    await _loadUrl(w, PORTAL_URL);
    const authed = await _waitForZoomAuthed(w, authWaitMs);
    if (!authed) {
      const lastUrlHost = _hostOf(_currentUrl(w));
      log.info('[zoom-probe] stopped on a sign-in/SSO URL; no replay run (never automates credentials)');
      return { needsInteractiveSignIn: true, lastUrlHost };
    }

    // Load the signed-in pages so the SPA fires its own authed back-end calls (CDP sees hosts/headers).
    const settleMs = Number.isFinite(deps._navSettleMs) ? deps._navSettleMs : NAV_SETTLE_MS;
    for (const p of SIGNED_IN_PAGES) {
      if (remaining() < reserveGuard()) break;
      try { await _loadUrl(w, _joinPortal(p)); await _sleep(Math.min(settleMs, Math.max(0, remaining() - 2_000))); } catch (_) { /* best-effort */ }
    }

    // Read-only GET replay from the authenticated amazon.zoom.us context.
    const replay = await _timed('replay', async () => {
      const script = buildReplayScript({ authHeaders: auth.headers(), origin: PORTAL_URL });
      const raw = await _execJson(w, script);
      return raw || { ok: false, reason: 'no-result' };
    });
    const steps = replay.result || {};
    const anyOk = Object.keys(steps).some((k) => steps[k] && steps[k].ok);
    return {
      replay: {
        ok: anyOk, steps, authModel: auth.authModel(),
        reason: anyOk ? undefined : 'no-target-returned-200',
      },
    };
  } catch (e) {
    log.warn('[zoom-probe] in-window phase failed: ' + _errName(e));
    return { replay: { ok: false, reason: _errName(e) } };
  }
}

function reserveGuard() { return 10_000; }
function _joinPortal(p) { try { return new URL(p, PORTAL_URL).href; } catch (_) { return PORTAL_URL; } }
function _currentUrl(w) { try { return w.webContents.getURL(); } catch (_) { return ''; } }
function _hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch (_) { return null; } }

function _loadUrl(w, url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
    let timer = setTimeout(done, Math.min(NET_TIMEOUT_MS, 15_000));
    try {
      w.webContents.once('did-finish-load', done);
      w.webContents.once('did-fail-load', done);
      Promise.resolve(w.loadURL(url)).catch(() => done());
    } catch (_) { done(); }
  });
}

// Poll until the window is on an AUTHENTICATED amazon.zoom.us path (NOT an SSO/login host).
function _waitForZoomAuthed(w, totalMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (_isDestroyed(w)) { clearInterval(iv); resolve(false); return; }
      const url = _currentUrl(w);
      const host = _hostOf(url);
      const onAuthHost = AUTH_HOST_RE.test(String(url || '')) && host !== ZOOM_PORTAL_HOST;
      const authed = host === ZOOM_PORTAL_HOST && !onAuthHost && !/\/signin|\/login|\/saml/i.test(url);
      if (authed) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - started > totalMs) { clearInterval(iv); resolve(false); return; }
    }, 500);
  });
}

async function _execJson(w, script) {
  try {
    const raw = await w.webContents.executeJavaScript(script, true);
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (_) { return null; }
  } catch (e) { return { ok: false, error: _errName(e) }; }
}

// ───────────────────────────── Tier 1 (main-process, no page) ─────────────────────────────
// A read-only GET for the user's own data on the portal host. Live run 1 (2026-11-09) showed the
// portal's meeting LIST is POST-only (/rest/meeting/list) so it is not a valid GET target; the real
// GET-retrievable authed portal endpoint is the recordings read /nws/recording/1.0/recording-info.
// Pure GET, no ids in the path, no write pattern — used to test windowless reuse of session material.
const TIER1_PATH = '/nws/recording/1.0/recording-info';

function _pushUnique(arr, v) { if (!arr.includes(v)) arr.push(v); }

function _classify(r) {
  if (r.status === 200 && r.json) return 'ok';
  if (r.redirect) return r.toLogin ? 'redirect-to-login' : 'redirect-other';
  if (r.status === 401 || r.status === 403) return 'unauthorized';
  if (r.status === 429 || r.status === 503) return 'throttled';
  return 'status-' + r.status + (r.error ? ':' + r.error : '');
}

/** Cookie NAMES per Zoom host (never values) + the CSRF cookie VALUE kept only in the returned object. */
async function _cookieInventory(session) {
  const byHost = {};
  let csrfValue = null;
  const hosts = ['amazon.zoom.us', 'zoom.us'];
  for (const h of hosts) {
    try {
      const cookies = await session.cookies.get({ domain: h });
      const list = (cookies || []).filter((c) => hostAllowed(String(c.domain || h).replace(/^\./, '')));
      byHost[h] = Array.from(new Set(list.map((c) => String(c.name)))).slice(0, 40).sort();
      const csrf = list.find((c) => /csrf/i.test(String(c.name)) && c.value);
      if (csrf && !csrfValue) csrfValue = String(csrf.value);
    } catch (_) { byHost[h] = null; }
  }
  return { byHost, csrfValue };
}

async function _tier1(electron, log, whenRun, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const timeoutMs = Math.max(1, Math.min(NET_TIMEOUT_MS, Number.isFinite(o.timeoutMs) ? o.timeoutMs : NET_TIMEOUT_MS));
  const remaining = typeof o.remaining === 'function' ? o.remaining : () => OVERALL_TIMEOUT_MS;
  const rec = { tier: 1, ok: false, reason: '', authMaterialNeeded: [], obtainableWithoutPage: false, tokenLifetime: { hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' }, attempts: [], ms: 0, whenRun };
  try {
    if (!electron || !electron.session || !electron.net) { rec.reason = 'electron-unavailable'; rec.ms = Date.now() - t0; return rec; }
    const session = electron.session.fromPartition(PARTITION);
    const inv = await _cookieInventory(session);
    rec.cookieNamesByHost = inv.byHost;
    rec.csrfAsCookie = !!inv.csrfValue;
    const captured = o.auth ? o.auth.describe() : null;
    if (captured && captured.bearer) rec.tokenLifetime = captured.bearer;
    const host = (o.auth && o.auth.host() && hostAllowed(o.auth.host())) ? o.auth.host() : ZOOM_PORTAL_HOST;
    rec.host = host;
    const url = 'https://' + host + TIER1_PATH;
    // Defensive: never issue a windowless write (this path is a read, but guard anyway).
    if (isWriteRequest('GET', url)) { rec.reason = 'write-refused'; rec.ms = Date.now() - t0; return rec; }

    // Attempt 1: partition session cookies only (+ CSRF header iff the CSRF came from a cookie).
    const cookieHeaders = { accept: 'application/json' };
    if (inv.csrfValue) cookieHeaders['zoom-csrftoken'] = inv.csrfValue;
    inv.csrfValue = null;
    const a1 = await _netGet(electron, session, url, cookieHeaders, timeoutMs);
    rec.attempts.push(_attemptRecord('cookies-only', a1, cookieHeaders));
    const c1 = _classify(a1);
    if (c1 === 'ok') {
      rec.ok = true; rec.reason = 'cookies-sufficient'; rec.obtainableWithoutPage = true;
      rec.responseShape = shapeOf(a1.json, 0);
      _pushUnique(rec.authMaterialNeeded, 'cookie');
      if (rec.csrfAsCookie) _pushUnique(rec.authMaterialNeeded, 'zoom-csrftoken(cookie)');
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
        _pushUnique(rec.authMaterialNeeded, 'csrf-header-or-bearer');
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
 * 'redirect' listener: a 3xx is recorded as {status, redirect:true, toLogin} (the target URL is tested
 * against AUTH_HOST_RE and discarded, never stored) and the request is aborted. Refuses any non-GET.
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
      done({ status: Number(statusCode) || 302, redirect: true, toLogin });   // settle first
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
  const { electron } = o;
  const t0 = Date.now();
  const rec = {
    tier: 2, ok: false, reason: '', authMaterialNeeded: [], obtainableWithoutPage: false, ms: 0, whenRun: 'after-window-closed',
    securityNotes: 'A bare Node process holding a live Zoom session cookie is a credential-exfiltration surface; kept in-memory, host-scoped, short-lived, never logged.',
    workerIsolationConflict: 'The worker-isolation host forbids all network I/O (http/https/net/child_process are on FORBIDDEN_MODULES). This tier therefore uses a SEPARATE short-lived dev child and does NOT modify the worker host isolation rules.',
    passedVia: 'stdin',
  };
  let child = null;
  const timeoutMs = Math.max(1, Math.min(CHILD_TIMEOUT_MS, Number.isFinite(o.timeoutMs) ? o.timeoutMs : CHILD_TIMEOUT_MS));
  try {
    const host = (o.auth && o.auth.host() && hostAllowed(o.auth.host())) ? o.auth.host() : ZOOM_PORTAL_HOST;
    const url = 'https://' + host + TIER1_PATH;
    if (!hostAllowed(url)) { rec.reason = 'host-blocked'; rec.ms = Date.now() - t0; return rec; }
    if (isWriteRequest('GET', url)) { rec.reason = 'write-refused'; rec.ms = Date.now() - t0; return rec; }
    rec.host = host;

    // Build the auth material IN MEMORY in main: the cookies the partition session would send to this
    // exact URL (cookies.get({url})), re-filtered to Zoom-domain cookies, + CSRF (cookie or captured)
    // + any bearer captured from the hidden page. Only NAMES are ever recorded.
    let headers = { accept: 'application/json' };
    const session = electron && electron.session && electron.session.fromPartition(PARTITION);
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
      const csrf = cookiePairs.find((c) => /csrf/i.test(String(c.name)) && c.value);
      if (csrf) { headers['zoom-csrftoken'] = String(csrf.value); _pushUnique(rec.authMaterialNeeded, 'zoom-csrftoken(cookie)'); }
    }
    rec.cookieNamesTransferred = Array.from(new Set(cookiePairs.map((c) => String(c.name)))).sort().slice(0, 40);
    cookiePairs = null;
    const cap = o.auth ? o.auth.headers() : {};
    for (const k of Object.keys(cap)) {
      if (k === 'zoom-csrftoken' && headers['zoom-csrftoken']) continue;
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
        child = spawn(TIER2_CHILD_SOURCE);   // the spawner receives ONLY the secret-free source
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
    else if (res && res.error === 'write-refused') rec.reason = 'write-refused';
    else rec.reason = 'status-' + (res && res.status) + (res && res.error ? ':' + res.error : '');
    if (!rec.authMaterialNeeded.length) rec.reason += '+no-material-available';
    rec.conclusion = 'A plain Node child has no cookie jar of its own; it only works with session material copied in-memory from main over stdin, which is a real credential-handling surface.';
  } catch (e) {
    rec.reason = _errName(e);
  } finally {
    try { if (child && typeof child.kill === 'function' && !child.killed) child.kill(); } catch (_) { /* gone */ }
  }
  rec.ms = Date.now() - t0;
  return rec;
}

function _defaultSpawnChild(source, deps) {
  const d = deps || {};
  const cp = d._cp || require('child_process');
  const os = d._os || require('os');
  const fsx = d._fs || require('fs');
  const file = path.join(os.tmpdir(), 'zoom-probe-tier2-' + process.pid + '-' + Date.now() + '.cjs');
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
    reason: 'A cold process has no cookies and no token. The Zoom portal\'s own endpoints require the authenticated session established interactively via Amazon SSO/Midway. Minting a token from scratch requires a Marketplace OAuth app / app registration / admin scopes — all explicitly disallowed here (and there is no Graph analog). Not attempted; no network call is made.',
    authMaterialNeeded: ['marketplace-oauth-or-app-registration(disallowed)'],
    obtainableWithoutPage: false,
    ms: 0,
  };
}

// ───────────────────────────── CDP + write classification + helpers ─────────────────────────────
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
          if (auth) auth.observe(params);            // values in memory only (never persisted)
        } else if (method === 'Network.responseReceived') recorder.recordResponse(params);
      } catch (_) { /* metadata only */ }
    });
  } catch (e) { log.warn('[zoom-probe] CDP attach failed: ' + _errName(e)); }
}

/**
 * _classifyWrite(recorder) — scan the CDP records and report the SHAPE of any observed WRITE call
 * (create/schedule meeting, start/join, delete recording) WITHOUT ever issuing one. Observation only.
 */
function _classifyWrite(recorder) {
  const reqs = recorder.finalize();
  const writeShapes = reqs.filter((r) => r.wouldWrite).map((r) => ({ method: r.method, pathPattern: r.pathPattern, queryParamNames: r.queryParamNames }));
  return {
    observedWriteShapes: writeShapes,
    note: writeShapes.length
      ? 'Write-shaped requests were observed on the wire but the harness NEVER issued one; the replay/net/child layers hard-refuse any non-GET and any write-pattern path. These are recorded by SHAPE only (method + masked path) for the follow-up decision.'
      : 'No write-shaped request was observed during the read-only run (expected). On amazon.zoom.us the portal\'s own mutating calls (schedule/create meeting, start/join, delete recording) are non-GET POST/PUT/PATCH/DELETE on portal paths such as /rest/meeting/list, /nws/recording/1.0/host-list and /wc/webapp/header; identified by shape only, NEVER issued.',
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
  try { return require('../utils/logger')('zoom-probe'); } catch (_) { return { info() {}, warn() {}, error() {} }; }
}
function _errName(e) {
  const name = (e && typeof e === 'object' && e.name) ? String(e.name) : 'Error';
  const code = (e && typeof e === 'object' && e.code != null) ? String(e.code) : '';
  return (name + ':' + code).replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 60);
}
function _tryElectron() { try { return require('electron'); } catch (_) { return null; } }
function _tryInjectCookies() { try { return require('../scrapers/auth').injectCookies; } catch (_) { return null; } }

module.exports = {
  start,
  run,
  ENV_DIR,
  PARTITION,
  PORTAL_URL,
  REPLAY_TARGETS,
  // helpers exported for unit tests
  maskAddress,
  maskText,
  collapsePath,
  headerNames,
  shapeOf,
  hostAllowed,
  isWriteRequest,
  createNetworkRecorder,
  buildReplayScript,
  TIER2_CHILD_SOURCE,
  jwtExpShape,
  createAuthCapture,
  _netGet,
  _tier1,
  _tier2,
  _tier3,
  _defaultSpawnChild,
  _classifyWrite,
  _runInWindow,
  _waitClosed,
  _waitForZoomAuthed,
};
