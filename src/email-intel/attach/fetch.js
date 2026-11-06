'use strict';
/**
 * email-intel/attach/fetch.js — download one attachment inside the already open hidden OWA window
 * (design 7.4; R6.2, R6.5, R8.6).
 *
 *   hrefAllowed(href)                         -> https, an Outlook host (exact host or subdomain), no
 *                                                credentials, no port, not a service / API path
 *   buildFetchScript({ name, attId, maxBytes, timeoutMs }) -> page script (string)
 *   fetchAttachment(ctx, att, { maxBytes, timeoutMs }) -> { ok:true, buffer, mimetype, bytes } | { ok:false, reason }
 *
 * Rules: the URL is the href found on the attachment chip itself (an anchor in or on the chip); URLs
 * are never constructed and no service endpoint is called; same session cookies (no new auth);
 * redirect:'manual' (a redirect ends the fetch: `redirect`); the page script counts bytes while
 * streaming and aborts above maxBytes (`too-large`); 30 s per file (`timeout`). A chip without an
 * allowed link is `no-handle`. Reason codes only; nothing here logs or returns page text.
 */
const owaMailer = require('../../scrapers/owa-mailer');

const OUTLOOK_HOSTS = Object.freeze(['outlook.office365.com', 'outlook.office.com', 'outlook.cloud.microsoft']);
// Service / API style paths are never fetched (R8.6): *.svc, *.asmx, /ews/, /api/.
const DENY_PATH_RE = /\.svc(?:\/|$)|\.asmx(?:\/|$)|\/ews\/|\/api\//i;
const CHIP_SELECTOR = '[aria-label*="attachment" i], [data-attachmentid], div[role="listitem"][title], button[title*="."]';
const EXTRA_MS = 2_000;

function hrefAllowed(href) {
  let u;
  try { u = new URL(String(href || '')); } catch (_) { return { ok: false, reason: 'bad-host' }; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return { ok: false, reason: 'bad-host' };
  const h = u.hostname.toLowerCase();
  if (!OUTLOOK_HOSTS.some((x) => h === x || h.endsWith('.' + x)) || !owaMailer.OUTLOOK_HOST_RE.test(h)) return { ok: false, reason: 'bad-host' };
  if (DENY_PATH_RE.test(u.pathname)) return { ok: false, reason: 'service-endpoint' };
  return { ok: true };
}

/** Page script: locate the chip by attachment id or exact file name, read its own href, fetch with byte counting. */
function buildFetchScript(o) {
  const cfg = JSON.stringify({
    name: String((o && o.name) || ''), attId: String((o && o.attId) || ''), max: Math.max(1, Math.trunc((o && o.maxBytes) || 1)),
    timeout: Math.max(1, Math.trunc((o && o.timeoutMs) || 30_000)), hosts: OUTLOOK_HOSTS, deny: DENY_PATH_RE.source, sel: CHIP_SELECTOR,
  });
  return '(async function(){ /*ei-attach:fetch*/\n' +
    '  var C = ' + cfg + ';\n' +
    '  var DENY = new RegExp(C.deny, "i");\n' +
    '  function ok(h){ try { var u = new URL(h, location.href); if (u.protocol !== "https:" || u.username || u.password || u.port) return 1;\n' +
    '    var host = u.hostname.toLowerCase(); var good = false; for (var i=0;i<C.hosts.length;i++){ if (host === C.hosts[i] || host.slice(-C.hosts[i].length-1) === "." + C.hosts[i]) good = true; }\n' +
    '    if (!good) return 1; if (DENY.test(u.pathname)) return 2; return 0; } catch(e){ return 1; } }\n' +
    '  function out(o){ return JSON.stringify(o); }\n' +
    '  var chips = document.querySelectorAll(C.sel); var hit = null;\n' +
    '  for (var c=0;c<chips.length;c++){ var ch = chips[c];\n' +
    '    var id = ch.getAttribute("data-attachmentid") || ch.getAttribute("data-attachment-id") || "";\n' +
    '    var label = [ch.getAttribute("title"), ch.getAttribute("aria-label"), ch.innerText].join(" ");\n' +
    '    if ((C.attId && id === C.attId) || (C.name && label.indexOf(C.name) !== -1)) hit = ch; }\n' +
    '  if (!hit) return out({ status: "no-chip" });\n' +
    '  var hrefs = []; if (hit.tagName === "A" && hit.getAttribute("href")) hrefs.push(hit.getAttribute("href"));\n' +
    '  var as = hit.querySelectorAll("a[href]"); for (var a=0;a<as.length && hrefs.length<5;a++) hrefs.push(as[a].getAttribute("href"));\n' +
    '  var href = null; var why = "no-handle";\n' +
    '  for (var k=0;k<hrefs.length;k++){ var r = ok(hrefs[k]); if (r === 0){ href = new URL(hrefs[k], location.href).href; break; } why = r === 2 ? "service-endpoint" : "bad-host"; }\n' +
    '  if (!href) return out({ status: why });\n' +
    '  var ac = new AbortController(); var timedOut = false; var t = setTimeout(function(){ timedOut = true; ac.abort(); }, C.timeout);\n' +
    '  try {\n' +
    '    var res = await fetch(href, { credentials: "include", redirect: "manual", signal: ac.signal, cache: "no-store" });\n' +
    '    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return out({ status: "redirect" });\n' +
    '    if (!res.ok) return out({ status: "http-error", code: res.status });\n' +
    '    if (res.url && ok(res.url) !== 0) return out({ status: "bad-host" });\n' +
    '    var cl = Number(res.headers.get("content-length") || 0); if (cl > C.max) { ac.abort(); return out({ status: "too-large" }); }\n' +
    '    if (!res.body || !res.body.getReader) return out({ status: "fetch-failed" });\n' +
    '    var rd = res.body.getReader(); var parts = []; var n = 0;\n' +
    '    while (true) { var s = await rd.read(); if (s.done) break; n += s.value.length; if (n > C.max) { ac.abort(); return out({ status: "too-large" }); } parts.push(s.value); }\n' +
    '    var bin = ""; for (var p=0;p<parts.length;p++){ var u8 = parts[p]; for (var q=0;q<u8.length;q+=32768) bin += String.fromCharCode.apply(null, u8.subarray(q, q+32768)); }\n' +
    '    var mt = String(res.headers.get("content-type") || "").split(";")[0].trim().slice(0, 80);\n' +
    '    return out({ status: "ok", bytes: n, mimetype: mt, base64: btoa(bin) });\n' +
    '  } catch (e) { return out({ status: timedOut ? "timeout" : "fetch-failed" }); }\n' +
    '  finally { clearTimeout(t); }\n' +
    '})()';
}

const STATUS_OK = new Set(['no-chip', 'no-handle', 'bad-host', 'service-endpoint', 'redirect', 'too-large', 'http-error', 'timeout', 'fetch-failed']);

/**
 * ctx: the open session context from capture/owa_capture.openSession ({ execJson, alive, stopped, win }).
 * The outer timer guards a page script that never settles.
 */
async function fetchAttachment(ctx, att, o) {
  const opts = o || {};
  const maxBytes = Math.max(1, Math.trunc(opts.maxBytes || 1));
  const timeoutMs = Math.max(1, Math.min(30_000, Math.trunc(opts.timeoutMs || 30_000)));
  if (!ctx || typeof ctx.execJson !== 'function' || (typeof ctx.alive === 'function' && !ctx.alive())) return { ok: false, reason: 'fetch-failed' };
  if (!att || (!att.name && !att.attId)) return { ok: false, reason: 'no-chip' };
  let timer = null;
  let r = null;
  try {
    const guard = new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs + EXTRA_MS); });
    r = await Promise.race([ctx.execJson(buildFetchScript({ name: att.name, attId: att.attId, maxBytes, timeoutMs })), guard]);
  } catch (_) {
    r = null;
  } finally { if (timer) clearTimeout(timer); }
  if (ctx.state && ctx.state.authBlocked) return { ok: false, reason: 'auth-wall' };
  if (!r || typeof r !== 'object') return { ok: false, reason: 'fetch-failed' };
  if (r.status !== 'ok') return { ok: false, reason: STATUS_OK.has(r.status) ? r.status : 'fetch-failed' };
  if (typeof r.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.base64)) return { ok: false, reason: 'fetch-failed' };
  const buffer = Buffer.from(r.base64, 'base64');
  if (buffer.length > maxBytes) return { ok: false, reason: 'too-large' };
  if (!buffer.length) return { ok: false, reason: 'fetch-failed' };
  const mimetype = typeof r.mimetype === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(r.mimetype) ? r.mimetype.toLowerCase() : '';
  return { ok: true, buffer, mimetype, bytes: buffer.length };
}

module.exports = { OUTLOOK_HOSTS, DENY_PATH_RE, CHIP_SELECTOR, hrefAllowed, buildFetchScript, fetchAttachment };
