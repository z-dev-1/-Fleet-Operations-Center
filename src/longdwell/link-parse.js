'use strict';
/**
 * longdwell/link-parse.js - parse a pasted weekly SharePoint sheet link.
 *
 * Recognized forms:
 *   sharing token  https://<t>.sharepoint.com/:x:/s/<site>/<token>?e=...      (also /t/, /g/personal/<u>/)
 *   sharing path   https://<t>.sharepoint.com/:x:/r/sites/<site>/.../<f>.xlsx?d=w<32hex>&...
 *   Doc.aspx       https://<t>.sharepoint.com/sites/<site>/_layouts/15/Doc.aspx?sourcedoc={guid}&file=<f>.xlsx
 *   direct         https://<t>.sharepoint.com/sites/<site>/Shared%20Documents/.../<f>.xlsx
 *
 * Every failure returns { ok:false, code } with a fixed code and nothing else,
 * so no part of the link (query values can be access tokens) is ever echoed.
 */

const MAX_LEN = 2048;
const HOST_RE = /^[a-z0-9-]+(-my)?\.sharepoint\.com$/i;
const GUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const OTHER_OFFICE = { w: 1, p: 1, b: 1, o: 1, v: 1, t: 1 };
const DOC_PAGES = ['doc.aspx', 'wopiframe.aspx', 'wopiframe2.aspx'];

function _fail(code) { return { ok: false, code }; }

function _guidFromHex32(h) {
  const s = String(h || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}

function _guid(s) {
  const g = String(s || '').trim().replace(/^\{/, '').replace(/\}$/, '').toLowerCase();
  return GUID_RE.test(g) ? g : null;
}

function _siteOf(segs) {
  const k = (segs[0] || '').toLowerCase();
  if ((k === 'sites' || k === 'teams' || k === 'personal') && segs[1]) return '/' + k + '/' + segs[1];
  return '';
}

// 'xlsx' | 'other' | 'none' for the last path segment.
function _extKind(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || ''));
  if (!m) return 'none';
  return m[1].toLowerCase() === 'xlsx' ? 'xlsx' : 'other';
}

function parseSheetLink(input) {
  if (typeof input !== 'string') return _fail('bad-link');
  const raw = input.trim();
  if (!raw) return _fail('bad-link');
  if (raw.length > MAX_LEN) return _fail('link-too-long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return _fail('bad-link');
  let u;
  try { u = new URL(raw); } catch (_) { return _fail('bad-link'); }
  if (u.protocol !== 'https:') return _fail('bad-link');
  if (u.username || u.password) return _fail('bad-link');
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host)) return _fail('bad-host');
  u.hash = '';
  const canonicalUrl = u.toString();

  let segs;
  try { segs = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s)); } catch (_) { return _fail('bad-link'); }
  const base = { ok: true, host, site: '', kind: null, serverRelativeUrl: null, fileGuid: null, fileName: null, canonicalUrl };

  // /:x:/... sharing links
  const typeSeg = /^:([a-z]):$/i.exec(segs[0] || '');
  if (typeSeg) {
    const t = typeSeg[1].toLowerCase();
    if (t !== 'x') return OTHER_OFFICE[t] ? _fail('unsupported-format') : _fail('unsupported-link');
    const mode = (segs[1] || '').toLowerCase();
    const rest = segs.slice(2);
    if (mode === 'r') {
      // Doc.aspx reached through /:x:/r/
      if (rest.some((s) => DOC_PAGES.includes(s.toLowerCase()))) return _docAspx(base, rest, u);
      const site = _siteOf(rest);
      const last = rest[rest.length - 1];
      if (!site || rest.length < 3) return _fail('unsupported-link');
      const ek = _extKind(last);
      if (ek === 'other') return _fail('unsupported-format');
      if (ek === 'none') return _fail('unsupported-link');
      const d = u.searchParams.get('d');
      const fileGuid = d && /^w/i.test(d) ? _guidFromHex32(d.slice(1)) : null;
      return { ...base, kind: 'direct-path', site, serverRelativeUrl: '/' + rest.join('/'), fileGuid, fileName: last };
    }
    if (mode === 's' || mode === 't') {
      if (rest.length < 2) return _fail('unsupported-link');
      return { ...base, kind: 'sharing-token', site: (mode === 's' ? '/sites/' : '/teams/') + rest[0] };
    }
    if (mode === 'g') {
      if ((rest[0] || '').toLowerCase() === 'personal') {
        if (rest.length < 3) return _fail('unsupported-link');
        return { ...base, kind: 'sharing-token', site: '/personal/' + rest[1] };
      }
      if (rest.length < 1) return _fail('unsupported-link');
      return { ...base, kind: 'sharing-token', site: '' };
    }
    return _fail('unsupported-link');
  }

  if (segs.some((s) => DOC_PAGES.includes(s.toLowerCase()))) return _docAspx(base, segs, u);

  // Direct path to the file.
  const site = _siteOf(segs);
  const last = segs[segs.length - 1];
  if (!site || segs.length < 3) return _fail('unsupported-link');
  const ek = _extKind(last);
  if (ek === 'other') return _fail('unsupported-format');
  if (ek === 'none') return _fail('unsupported-link');
  return { ...base, kind: 'direct-path', site, serverRelativeUrl: '/' + segs.join('/'), fileName: last };
}

function _docAspx(base, segs, u) {
  const i = segs.findIndex((s) => DOC_PAGES.includes(s.toLowerCase()));
  const before = segs.slice(0, i);
  // /sites/<x>/_layouts/15/Doc.aspx -> site is before _layouts
  const site = _siteOf(before);
  const fileGuid = _guid(u.searchParams.get('sourcedoc'));
  if (!fileGuid) return _fail('unsupported-link');
  const file = u.searchParams.get('file');
  if (file) {
    const ek = _extKind(file);
    if (ek === 'other') return _fail('unsupported-format');
  }
  return { ...base, kind: 'doc-aspx', site, fileGuid, fileName: file || null };
}

module.exports = { parseSheetLink, MAX_LEN, GUID_RE };
