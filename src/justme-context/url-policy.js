'use strict';
// src/justme-context/url-policy.js — the single owner of host trust (design §9.1-9.2).
// Pure functions: URL extraction from Z's typed Slack text, intent stripping,
// classification into blocked / slack / vendor / internal / external, and the
// SSRF address block lists. Fetchers never decide trust themselves.

const net = require('net');
const { LIMITS, REASONS } = require('./constants');

const INTERNAL_SUFFIXES = Object.freeze([
  'amazon.com', 'a2z.com', 'amazon.dev', 'aws.dev', 'quip-amazon.com',
  'amazon.sharepoint.com', 'amazon-my.sharepoint.com',
]); // amazonaws.com (public S3, presigned URLs) is deliberately external.

// Hosts that may receive Slack credentials, and hosts a Slack download redirect
// may follow WITHOUT credentials (same lists as slack_send.downloadFileBounded).
const SLACK_AUTH_HOSTS = Object.freeze(['slack.com']);
const SLACK_FOLLOW_HOSTS = Object.freeze([...SLACK_AUTH_HOSTS, 'slack-edge.com', 'slack-files.com']);

// Navigation and subresources inside the internal render window only, never a
// fetch target. SharePoint federates Microsoft login to Midway; the aadcdn hosts
// serve the Microsoft login page's scripts. Add an observed host here with a
// comment if the render shows a broken login.
const SSO_NAV_HOSTS = Object.freeze([
  'login.microsoftonline.com', 'login.microsoft.com', 'login.windows.net',
  'aadcdn.msftauth.net', 'aadcdn.msauth.net',
]);

// Round-3 fix 5 (plan D6): static CDN hosts a render window of that trust class
// may load subresources from (GET + script/stylesheet/image/font/subFrame only,
// enforced in fetch-internal). EXACT hostnames only: no wildcard, no suffix
// match. Akamai and CloudFront hosts (e.g. spoprod-a.akamaihd.net) are left out
// on purpose. vendor is empty in v1: hosts observed during the manual check are
// added one by one.
const RENDER_STATIC_HOSTS = Object.freeze({
  internal: Object.freeze([
    'res.cdn.office.net', 'res-1.cdn.office.net',
    'static2.sharepointonline.com', 'publiccdn.sharepointonline.com',
    'm.media-amazon.com', 'images-na.ssl-images-amazon.com',
    'word-view.officeapps.live.com', 'excel.officeapps.live.com',
    'powerpoint.officeapps.live.com', 'view.officeapps.live.com',
  ]),
  vendor: Object.freeze([]),
});

// ───────────────────────── address block lists ─────────────────────────

const _V4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
const _V6 = ['::/128', '::1/128', '::/96', '::ffff:0:0/96', '::ffff:0:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48',
  '100::/64', '2001::/32', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8'];

function _list(cidrs, family) {
  const b = new net.BlockList();
  for (const c of cidrs) { const [a, p] = c.split('/'); b.addSubnet(a, Number(p), family); }
  return b;
}
const _blockV4 = _list(_V4, 'ipv4');
const _blockV6 = _list(_V6, 'ipv6');
const _localV4 = _list(['127.0.0.0/8', '169.254.0.0/16'], 'ipv4');
const _localV6 = _list(['::1/128', 'fe80::/10'], 'ipv6');

function _bare(ip) {
  const s = String(ip == null ? '' : ip).trim();
  return s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
}

// Expand an IPv6 literal into 8 16-bit groups (handles :: and a dotted tail).
function _v6Groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const dot = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dot) {
    const p = dot[1].split('.').map(Number);
    s = s.slice(0, -dot[1].length) + ((p[0] << 8) | p[1]).toString(16) + ':' + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? new Array(8 - head.length - tail.length).fill('0') : [];
  return [...head, ...fill, ...tail].map((g) => parseInt(g, 16) || 0);
}

/** True for private, local, reserved, mapped/translated and NAT64 addresses. Non-IP input fails closed. */
function isBlockedAddress(ip) {
  const a = _bare(ip);
  const fam = net.isIP(a);
  if (fam === 4) return _blockV4.check(a, 'ipv4');
  if (fam !== 6) return true;
  if (_blockV6.check(a, 'ipv6')) return true;
  const g = _v6Groups(a);
  if (g[0] === 0x2002) {   // 6to4: the embedded IPv4 is bits 16-47
    const v4 = [g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255].join('.');
    return _blockV4.check(v4, 'ipv4');
  }
  return false;
}

/** Round-3 fix 15: loopback (127.0.0.0/8, ::1) or link-local (169.254.0.0/16, fe80::/10), incl. IPv4-mapped forms. */
function isLoopbackOrLinkLocal(ip) {
  const a = _bare(ip);
  const fam = net.isIP(a);
  if (fam === 4) return _localV4.check(a, 'ipv4');
  if (fam === 6) return _localV6.check(a, 'ipv6') || _localV4.check(a, 'ipv6');
  return false;
}

// ───────────────────────── extraction (§9.1) ─────────────────────────

const _TRAIL = '.,;:!?)]}\'"';
const _PAIRS = { ')': '(', ']': '[', '}': '{' };
const _decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const _count = (s, ch) => s.split(ch).length - 1;

function _trimTrailing(u) {
  let s = u;
  while (s.length && _TRAIL.includes(s[s.length - 1])) {
    const c = s[s.length - 1];
    if (_PAIRS[c] && _count(s, _PAIRS[c]) >= _count(s, c)) break;   // balanced inside the URL
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * extractUrls(text, max = LIMITS.MAX_LINKS) -> string[] (normalized hrefs, deduped,
 * ≤ 2,048 chars each, at most `max`). Reads only Z's typed Slack text.
 */
function extractUrls(text, max) {
  const cap = Number.isFinite(max) || max === Infinity ? max : LIMITS.MAX_LINKS;
  const s = typeof text === 'string' ? text : '';
  // One left-to-right scan keeps the order Z typed: <…> tokens (skip #/@/! forms,
  // take the part before |) and bare URLs outside tokens.
  const raw = [];
  const re = /<([^<>]*)>|https?:\/\/[^\s<>|"']+/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[1] === undefined) { raw.push(m[0]); continue; }
    const inner = m[1];
    if (/^[#@!]/.test(inner)) continue;
    const u = inner.split('|')[0];
    if (/^https?:\/\//i.test(u)) raw.push(u);
  }
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    const t = _trimTrailing(_decode(r));
    let href;
    try { href = new URL(t).href; } catch (_) { continue; }
    if (href.length > 2048 || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
    if (out.length >= cap) break;
  }
  return out;
}

/** Z's typed intent: every <…> token, bare URL and <@U…> mention removed, whitespace collapsed. */
function stripForIntent(text) {
  return String(typeof text === 'string' ? text : '')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/https?:\/\/[^\s<>|"']+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ───────────────────────── classification (§9.2) ─────────────────────────

function hostIn(host, list) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return list.some((s) => h === s || h.endsWith('.' + s));
}
function isSsoNavHost(u) {
  try { return SSO_NAV_HOSTS.includes(_normHost(new URL(u).hostname)); } catch (_) { return false; }
}
function _normHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h.replace(/\.$/, '');
}

/** File id from a Slack file permalink (/files/<U>/<F…>/…, files-pri/<T>-<F…>/…), else null. */
function slackFileIdFromPermalink(url) {
  let p;
  try { p = new URL(url).pathname; } catch (_) { return null; }
  const m = p.match(/^\/files\/[UW][A-Z0-9]+\/(F[A-Z0-9]+)(\/|$)/) || p.match(/^\/files-(?:pri|tmb)\/T[A-Z0-9]+-(F[A-Z0-9]+)(\/|$)/);
  return m ? m[1] : null;
}

let _partitionForUrl = null;
function _partition(u) {
  if (!_partitionForUrl) _partitionForUrl = require('../orcha/auto-login').partitionForUrl;   // read-only use
  return _partitionForUrl(u);
}

/**
 * classifyUrl(url) -> { kind:'blocked'|'slack'|'vendor'|'internal'|'external', host, reason?, partition?, fileId? }
 * First matching rule wins (design §9.2). reasons are REASONS values.
 */
function classifyUrl(input) {
  let url;
  try { url = input instanceof URL ? input : new URL(String(input)); } catch (_) { return { kind: 'blocked', host: '', reason: REASONS.ONLY_WEB }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'blocked', host: '', reason: REASONS.ONLY_WEB };
  const h = _normHost(url.hostname);
  const blocked = (reason) => ({ kind: 'blocked', host: h, reason });
  if (url.username || url.password) return blocked(REASONS.URL_CREDENTIALS);
  if (url.port !== '') return blocked(REASONS.NONSTANDARD_PORT);   // WHATWG drops the scheme default
  if (net.isIP(h)) return isBlockedAddress(h) ? blocked(REASONS.PRIVATE_ADDRESS) : { kind: 'external', host: h };
  if (!h || h === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(h) || !h.includes('.')) return blocked(REASONS.LOCAL_HOST);
  if (hostIn(h, SLACK_AUTH_HOSTS)) {
    const fileId = slackFileIdFromPermalink(url.href);
    return fileId ? { kind: 'slack', host: h, fileId } : { kind: 'slack', host: h, reason: REASONS.SLACK_MESSAGE_LINK };
  }
  const partition = _partition(url.protocol + '//' + h + '/');
  if (partition) return { kind: 'vendor', host: h, partition };
  if (hostIn(h, INTERNAL_SUFFIXES)) return url.protocol === 'https:' ? { kind: 'internal', host: h } : blocked(REASONS.INTERNAL_HTTP);
  return { kind: 'external', host: h };
}

/** Report label: host + first 40 chars of the path, no scheme, query or fragment. */
function linkLabel(u) {
  try {
    const url = new URL(u);
    const p = url.pathname === '/' ? '' : url.pathname.slice(0, 40);
    return (_normHost(url.hostname) + p).replace(/[`\s<>|]/g, '').slice(0, 80) || 'link';
  } catch (_) { return 'link'; }
}

module.exports = {
  extractUrls, stripForIntent, classifyUrl, isBlockedAddress, isLoopbackOrLinkLocal, isSsoNavHost, hostIn,
  slackFileIdFromPermalink, linkLabel,
  INTERNAL_SUFFIXES, SLACK_AUTH_HOSTS, SLACK_FOLLOW_HOSTS, SSO_NAV_HOSTS, RENDER_STATIC_HOSTS,
};
