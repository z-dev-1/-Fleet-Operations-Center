/* eslint-disable no-var */
/**
 * scrapers/sp_sheet_page.js - BROWSER-SIDE page functions for the Long Dwell
 * weekly sheet (preview, then write). Injected by sp_sheet_transport.js into a
 * hidden SharePoint window on session.defaultSession, the same way spRun
 * injects sp_push_script.js. No require; only `var` and `function` at the top
 * level so the script can be injected more than once into the same page.
 *
 *   spSheetResolve(cfg)  4 ordered strategies -> {ok, strategy, host, site, serverRelativeUrl, uniqueId, name, etag, length, modified}
 *   spSheetMeta(cfg)     metadata ETag/TimeLastModified/... + read-only versioning GET
 *   spSheetGet(cfg)      $value download -> {ok, b64, length, valueEtag}
 *   spSheetPut(cfg)      digest of the file's own site + $value PUT (never retried)
 *
 * Every function returns plain JSON and never throws. Nothing here logs: no
 * console output of URLs, file names or cell values.
 */
var SPS_JSON = 'application/json;odata=nometadata';
var SPS_GUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
var SPS_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.sharepoint\.com$/i;
var SPS_SITE_RE = /^(\/(sites|teams|personal)\/[^/?#]+)?$/i;
var SPS_FILE_SELECT = 'ServerRelativeUrl,Name,UniqueId,ETag,Length,TimeLastModified';
var SPS_META_SELECT = 'ETag,TimeLastModified,Length,UIVersionLabel,CheckOutType';
var SPS_CHUNK = 32 * 1024;

// Path inside an OData string literal: encodeURI, every ' doubled, and the
// three characters encodeURI leaves alone that would break the URL.
function spsEncodePath(p) {
  return encodeURI(String(p)).replace(/'/g, "''").replace(/#/g, '%23').replace(/&/g, '%26').replace(/\?/g, '%3F');
}

function spsGuid(g) {
  var s = String(g == null ? '' : g).replace(/^\{|\}$/g, '').toLowerCase();
  return SPS_GUID_RE.test(s) ? s : null;
}

function spsValidBase(origin, site) {
  return SPS_ORIGIN_RE.test(String(origin || '')) && SPS_SITE_RE.test(String(site == null ? '' : site));
}

// <origin><site>/_api/web/getfilebyserverrelativeurl('<path>')<suffix>
function buildFileApiUrl(origin, site, serverRelativeUrl, suffix) {
  if (!spsValidBase(origin, site) || typeof serverRelativeUrl !== 'string' || !serverRelativeUrl) return null;
  return origin + encodeURI(site || '') + "/_api/web/getfilebyserverrelativeurl('" + spsEncodePath(serverRelativeUrl) + "')" + (suffix || '');
}

function buildFileByIdUrl(origin, site, guid, suffix) {
  var g = spsGuid(guid);
  if (!g || !spsValidBase(origin, site)) return null;
  return origin + encodeURI(site || '') + "/_api/web/GetFileById('" + g + "')" + (suffix || '');
}

function buildLinkingUrl(origin, site, linkUrl, suffix) {
  if (!spsValidBase(origin, site) || typeof linkUrl !== 'string' || !linkUrl) return null;
  var a = encodeURIComponent("'" + linkUrl.replace(/'/g, "''") + "'");
  return origin + encodeURI(site || '') + '/_api/web/GetFileByLinkingUrl(@a)' + (suffix || '') + (suffix && suffix.indexOf('?') !== -1 ? '&' : '?') + '@a=' + a;
}

function spsRetryAfter(res) {
  var h = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('Retry-After') : null;
  if (!h) return 3000;
  var n = Number(h);
  if (isFinite(n) && n >= 0) return Math.round(n * 1000);
  var t = Date.parse(h);
  return isFinite(t) ? Math.max(0, t - Date.now()) : 3000;
}

function spsIsHtml(res) {
  var ct = res && res.headers && typeof res.headers.get === 'function' ? String(res.headers.get('Content-Type') || '') : '';
  return /text\/html/i.test(ct);
}

function spsLoginRedirect(res) {
  if (!res || !res.redirected || !res.url) return false;
  try {
    var u = new URL(res.url);
    if (!/\.sharepoint\.com$/i.test(u.hostname)) return true;
    return /\/_forms\/default\.aspx|\/_layouts\/15\/authenticate\.aspx/i.test(u.pathname);
  } catch (_) { return true; }
}

// HTTP -> code table shared by every page function.
function spsCode(res, verb) {
  var s = res.status;
  if (s === 401 || spsLoginRedirect(res)) return { ok: false, code: 'auth-required', http: s };
  if (s === 403) return { ok: false, code: verb === 'PUT' ? 'forbidden' : 'auth-required', http: s };
  if (s === 404) return { ok: false, code: 'not-found', http: s };
  if (s === 412) return { ok: false, code: 'precondition', http: s };
  if (s === 423) return { ok: false, code: 'locked', http: s };
  if (s === 429 || s === 503) return { ok: false, code: 'throttled', http: s, retryAfterMs: spsRetryAfter(res) };
  return { ok: false, code: 'http-' + s, http: s };
}

function spsFetch(url, opts, timeoutMs) {
  var ctl = typeof AbortController === 'function' ? new AbortController() : null;
  var o = Object.assign({ credentials: 'include' }, opts || {});
  if (ctl) o.signal = ctl.signal;
  var timer = ctl && timeoutMs > 0 ? setTimeout(function () { try { ctl.abort(); } catch (_) {} }, timeoutMs) : null;
  return fetch(url, o).then(function (res) {
    if (timer) clearTimeout(timer);
    return { res: res };
  }, function () {
    if (timer) clearTimeout(timer);
    return { res: null, error: { ok: false, code: 'network' } };
  });
}

function spsJson(url, timeoutMs) {
  return spsFetch(url, { method: 'GET', cache: 'no-store', headers: { Accept: SPS_JSON } }, timeoutMs).then(function (r) {
    if (!r.res) return r.error;
    if (!r.res.ok) return spsCode(r.res, 'GET');
    if (spsIsHtml(r.res) || spsLoginRedirect(r.res)) return { ok: false, code: 'auth-required', http: r.res.status };
    return r.res.json().then(function (j) { return { ok: true, json: j || {} }; }, function () { return { ok: false, code: 'auth-required', http: r.res.status }; });
  });
}

function spsSiteOf(serverRelativeUrl, fallback) {
  var m = /^(\/(?:sites|teams|personal)\/[^/]+)/i.exec(String(serverRelativeUrl || ''));
  return m ? m[1] : (fallback || '');
}

function spsFileResult(j, strategy, origin, site) {
  var name = String(j.Name || '');
  var sru = String(j.ServerRelativeUrl || '');
  if (!sru || !name) return { ok: false, code: 'unresolvable-link' };
  if (!/\.xlsx$/i.test(name)) return { ok: false, code: 'unsupported-format' };
  return {
    ok: true, strategy: strategy, host: String(origin).replace(/^https:\/\//i, ''), site: spsSiteOf(sru, site),
    serverRelativeUrl: sru, uniqueId: spsGuid(j.UniqueId), name: name,
    etag: j.ETag == null ? null : String(j.ETag), length: j.Length == null ? null : Number(j.Length),
    modified: j.TimeLastModified == null ? null : String(j.TimeLastModified),
  };
}

// Finds a file reference (path or GUID) in a landing URL after a sharing-link
// redirect (Doc.aspx?sourcedoc={guid}, ...?id=/sites/x/..., or a direct path).
function spsParseLanding(url) {
  try {
    var u = new URL(url);
    var sd = u.searchParams.get('sourcedoc');
    var g = spsGuid(sd);
    var id = u.searchParams.get('id');
    var path = id && id.charAt(0) === '/' ? id : (/\.xlsx$/i.test(decodeURIComponent(u.pathname)) ? decodeURIComponent(u.pathname) : null);
    return { origin: u.origin, guid: g, path: path };
  } catch (_) { return { origin: null, guid: null, path: null }; }
}

// cfg: { origin, site, serverRelativeUrl?, fileGuid?, linkUrl?, stepMs?, totalMs? }
function spSheetResolve(cfg) {
  var c = cfg || {};
  var origin = c.origin, site = c.site || '';
  var stepMs = c.stepMs || 15000, totalMs = c.totalMs || 30000;
  var start = Date.now();
  var failures = [];
  if (!spsValidBase(origin, site)) return Promise.resolve({ ok: false, code: 'unresolvable-link', failures: failures });
  var left = function () { return Math.min(stepMs, totalMs - (Date.now() - start)); };
  var tryUrl = function (strategy, url) {
    if (!url) return Promise.resolve(null);
    var ms = left();
    if (ms <= 0) { failures.push({ strategy: strategy, code: 'timeout' }); return Promise.resolve(null); }
    return spsJson(url, ms).then(function (r) {
      if (r.ok) {
        var out = spsFileResult(r.json, strategy, origin, site);
        if (out.ok || out.code === 'unsupported-format') return out;
        failures.push({ strategy: strategy, code: out.code });
        return null;
      }
      failures.push({ strategy: strategy, code: r.code, http: r.http });
      return null;
    });
  };
  var sel = '?$select=' + SPS_FILE_SELECT;
  var s1 = function () { return tryUrl(1, c.serverRelativeUrl ? buildFileApiUrl(origin, site, c.serverRelativeUrl, sel) : null); };
  var s2 = function () { return tryUrl(2, c.fileGuid ? buildFileByIdUrl(origin, site, c.fileGuid, sel) : null); };
  var s3 = function () { return tryUrl(3, c.linkUrl ? buildLinkingUrl(origin, site, c.linkUrl, sel) : null); };
  // Strategy 4: follow the sharing link (read-only GET, same origin) and use
  // the landing URL's path or sourcedoc GUID with strategies 1 and 2.
  var s4 = function () {
    if (!c.linkUrl) return Promise.resolve(null);
    var ms = left();
    if (ms <= 0) { failures.push({ strategy: 4, code: 'timeout' }); return Promise.resolve(null); }
    return spsFetch(c.linkUrl, { method: 'GET', cache: 'no-store', redirect: 'follow', headers: { Accept: 'text/html' } }, ms).then(function (r) {
      if (!r.res) { failures.push({ strategy: 4, code: 'network' }); return null; }
      if (spsLoginRedirect(r.res) || r.res.status === 401) { failures.push({ strategy: 4, code: 'auth-required', http: r.res.status }); return null; }
      var land = spsParseLanding(r.res.url || '');
      if (land.origin && land.origin.toLowerCase() !== String(origin).toLowerCase()) { failures.push({ strategy: 4, code: 'auth-required' }); return null; }
      var landSite = land.path ? spsSiteOf(land.path, site) : site;
      var p = land.path ? tryUrl(4, buildFileApiUrl(origin, landSite, land.path, sel)) : Promise.resolve(null);
      return p.then(function (hit) {
        if (hit) return hit;
        return land.guid ? tryUrl(4, buildFileByIdUrl(origin, landSite, land.guid, sel)) : null;
      });
    });
  };
  var chain = [s1, s2, s3, s4];
  var step = function (i) {
    if (i >= chain.length) return Promise.resolve(null);
    return chain[i]().then(function (hit) { return hit || step(i + 1); });
  };
  return step(0).then(function (hit) {
    if (hit) { hit.failures = failures; return hit; }
    var codes = failures.map(function (f) { return f.code; });
    var code = codes.indexOf('auth-required') !== -1 ? 'auth-required'
      : (codes.length && codes.every(function (x) { return x === 'not-found'; })) ? 'not-found'
        : 'unresolvable-link';
    return { ok: false, code: code, failures: failures };
  }, function () { return { ok: false, code: 'internal', failures: failures }; });
}

// cfg: { origin, site, serverRelativeUrl }
function spSheetMeta(cfg) {
  var c = cfg || {};
  var base = buildFileApiUrl(c.origin, c.site, c.serverRelativeUrl, '');
  if (!base) return Promise.resolve({ ok: false, code: 'bad-target' });
  var withLock = base + '?$select=' + SPS_META_SELECT + ',LockedByUser/Id&$expand=LockedByUser';
  var plain = base + '?$select=' + SPS_META_SELECT;
  return spsJson(withLock, 15000).then(function (r) {
    if (!r.ok && /^http-400$/.test(r.code)) return spsJson(plain, 15000).then(function (r2) { r2.noLock = true; return r2; });
    return r;
  }).then(function (r) {
    if (!r.ok) return { ok: false, code: r.code, http: r.http, retryAfterMs: r.retryAfterMs };
    var j = r.json;
    var lb = j.LockedByUser;
    var out = {
      ok: true,
      etag: j.ETag == null ? null : String(j.ETag),   // exactly as returned, quotes included
      modified: j.TimeLastModified == null ? null : String(j.TimeLastModified),
      length: j.Length == null ? null : Number(j.Length),
      version: j.UIVersionLabel == null ? null : String(j.UIVersionLabel),
      checkOutType: j.CheckOutType == null ? null : Number(j.CheckOutType),
      lockedBy: r.noLock ? null : !!(lb && lb.Id),
      versioning: null,
    };
    out.checkedOut = out.checkOutType == null ? null : out.checkOutType !== 2;
    // One read-only GET; failure only leaves versioning null.
    return spsJson(base + '/ListItemAllFields/ParentList?$select=EnableVersioning', 10000).then(function (v) {
      if (v.ok && typeof v.json.EnableVersioning === 'boolean') out.versioning = v.json.EnableVersioning;
      return out;
    }, function () { return out; });
  }, function () { return { ok: false, code: 'internal' }; });
}

function spsToB64(bytes) {
  var parts = [];
  for (var i = 0; i < bytes.length; i += SPS_CHUNK) {
    parts.push(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + SPS_CHUNK, bytes.length))));
  }
  return btoa(parts.join(''));
}

function spsFromB64(b64) {
  var bin = atob(String(b64 || ''));
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// cfg: { origin, site, serverRelativeUrl, maxBytes, bust }
function spSheetGet(cfg) {
  var c = cfg || {};
  var maxBytes = c.maxBytes > 0 ? c.maxBytes : 8 * 1024 * 1024;
  var url = buildFileApiUrl(c.origin, c.site, c.serverRelativeUrl, '/$value');
  if (!url) return Promise.resolve({ ok: false, code: 'bad-target' });
  url += '?rb=' + encodeURIComponent(String(c.bust == null ? Date.now() : c.bust));
  return spsFetch(url, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/octet-stream' } }, 60000).then(function (r) {
    if (!r.res) return r.error;
    var res = r.res;
    if (!res.ok) return spsCode(res, 'GET');
    if (spsIsHtml(res) || spsLoginRedirect(res)) return { ok: false, code: 'auth-required', http: res.status };
    var cl = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('Content-Length') : NaN);
    if (isFinite(cl) && cl > maxBytes) return { ok: false, code: 'too-large', http: res.status };
    var valueEtag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('ETag') : null;
    return res.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf);
      if (bytes.length > maxBytes) return { ok: false, code: 'too-large', http: res.status };
      if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return { ok: false, code: 'unsupported-workbook', http: res.status };
      return { ok: true, b64: spsToB64(bytes), length: bytes.length, valueEtag: valueEtag || null };
    }, function () { return { ok: false, code: 'network' }; });
  });
}

// cfg: { origin, site, serverRelativeUrl, b64, ifMatch? }. PUT is never retried.
function spSheetPut(cfg) {
  var c = cfg || {};
  var url = buildFileApiUrl(c.origin, c.site, c.serverRelativeUrl, '/$value');
  if (!url) return Promise.resolve({ ok: false, code: 'bad-target', sent: false });
  var digestUrl = c.origin + encodeURI(c.site || '') + '/_api/contextinfo';
  return spsFetch(digestUrl, { method: 'POST', headers: { Accept: SPS_JSON } }, 15000).then(function (r) {
    if (!r.res) return { ok: false, code: 'network', sent: false };
    if (!r.res.ok) { var e = spsCode(r.res, 'GET'); e.sent = false; return e; }
    if (spsIsHtml(r.res)) return { ok: false, code: 'auth-required', sent: false };
    return r.res.json().then(function (j) {
      var d = j && (j.FormDigestValue || (j.d && j.d.GetContextWebInformation && j.d.GetContextWebInformation.FormDigestValue));
      if (!d) return { ok: false, code: 'auth-required', sent: false };
      var body;
      try { body = spsFromB64(c.b64); } catch (_) { return { ok: false, code: 'internal', sent: false }; }
      var headers = { Accept: SPS_JSON, 'X-RequestDigest': d, 'Content-Type': 'application/octet-stream', 'X-HTTP-Method': 'PUT' };
      if (typeof c.ifMatch === 'string' && c.ifMatch) headers['If-Match'] = c.ifMatch;
      return spsFetch(url, { method: 'PUT', headers: headers, body: body }, 120000).then(function (p) {
        if (!p.res) return { ok: false, code: 'network', sent: true };
        if (p.res.ok) return { ok: true, http: p.res.status };
        var out = spsCode(p.res, 'PUT');
        out.sent = true;
        return out;
      });
    }, function () { return { ok: false, code: 'auth-required', sent: false }; });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildFileApiUrl: buildFileApiUrl, buildFileByIdUrl: buildFileByIdUrl, buildLinkingUrl: buildLinkingUrl,
    spsEncodePath: spsEncodePath, spsGuid: spsGuid, spsCode: spsCode,
    spSheetResolve: spSheetResolve, spSheetMeta: spSheetMeta, spSheetGet: spSheetGet, spSheetPut: spSheetPut,
  };
}
