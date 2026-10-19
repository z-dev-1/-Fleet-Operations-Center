'use strict';
/**
 * aap_api.js — Direct Relay Garage / AAP JSON API client (no page scraping).
 *
 * Talks to AAP's REST API the same way the AAP web app does, over the app's
 * existing Midway session. This is the API path that sidesteps the fragile
 * BrowserWindow page-scrape for Relay unit detail.
 *
 * ENDPOINTS (host: https://aap-na.corp.amazon.com):
 *   POST /api/v1/serviceaggregates/search        bulk search (paginated list)
 *   GET  /api/v1/serviceaggregates/{serviceId}   full service + comments + estimates
 *   GET  /api/v1/assets/{aaid}                    full asset (VIN, model, odometer, GPS)
 *   GET  /api/v1/servicemoves/asset/{aaid}        move history
 *   GET  /api/v1/maintenanceschedules/asset/{aaid} PM schedules
 *   GET  /api/v1/dvirs/asset/{aaid}               DVIR records
 *   GET  /api/v1/avmCodes/                         all L1/L2/L3 codes + reasons
 *   GET  /api/v1/user/details                      current user info
 *
 * AUTH MODEL:
 *   GET  → Midway cookies only (no extra header).
 *   POST → requires the per-session `anti-csrftoken-a2z` header, which the AAP
 *          web app mints in memory and attaches only inside its own XHRs. We
 *          open ONE authenticated AAP page, hook XHR to capture the live token,
 *          and run all GET/POST calls INSIDE that page context (so cookies +
 *          the captured token ride along exactly like the real app).
 *
 * The window is opened per-session (lazy), kept warm briefly, and torn down
 * when idle. All requests are serialized through it.
 */

// Stage 10: the browser is now obtained through browser_provider, which picks
// Electron (laptop, has a display) or headless Playwright (DevSpace standby,
// seeds ~/.midway/cookie). The token-capture + XHR-in-page logic below is
// engine-agnostic — it only needs a page with evaluate()/url()/close().
const provider = require('./browser_provider');
const logger = require('../utils/logger')('aap-api');

const AAP_ORIGIN = 'https://aap-na.corp.amazon.com';
// A lightweight AAP page that authenticates + fires token-bearing XHRs on load.
// Reuse the WR page the long-dwell fetch already proved mints the token.
const TOKEN_PAGE_URL = AAP_ORIGIN + '/v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5?tab=Unplanned';

const WARM_IDLE_MS   = 3 * 60 * 1000;   // tear the window down after 3 min idle
const PAGE_LOAD_MS   = 45000;           // budget for the page to auth + settle
const TOKEN_WAIT_MS  = 10000;           // how long to wait for a token on load

const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');

// Read a WO's status tolerant of the API's shapes. CONFIRMED (2026-10-16): the
// live shape nests it under status.description.{value,displayText} (status.type
// is "Alert" for cancelled). Older code read status.value/displayText directly,
// which returned '' for every WO — so cancelled WOs were mis-classified as open.
function _woStatusStr(wo) {
  const s = (wo && wo.status) || {};
  const d = s.description || s;
  return String(d.value || d.displayText || '');
}
function _woIsCancelled(wo) {
  return /cancel/i.test(_woStatusStr(wo));
}

let _page = null;          // provider page: { evaluate, url, close, engine }
let _token = null;
let _warmTimer = null;
let _lock = Promise.resolve();

// Serialize access to the single warm window.
function _withLock(fn) {
  const next = _lock.then(fn, fn);
  _lock = next.then(() => {}, () => {});
  return next;
}

function _scheduleTeardown() {
  if (_warmTimer) clearTimeout(_warmTimer);
  _warmTimer = setTimeout(() => dispose(), WARM_IDLE_MS);
  if (_warmTimer.unref) _warmTimer.unref();
}

function dispose() {
  if (_warmTimer) { clearTimeout(_warmTimer); _warmTimer = null; }
  try { if (_page) _page.close(); } catch (_) {}
  _page = null;
  _token = null;
  // Release the shared headless Playwright browser (no-op on the Electron path,
  // where openPage creates a per-call BrowserWindow that _page.close() destroys).
  try { if (provider.kind() === 'playwright') provider.shutdown(); } catch (_) {}
}

// In-page bootstrap: hook XHR.setRequestHeader to capture the live
// anti-csrftoken-a2z the AAP app attaches to its own calls. Installed once per
// window load. Stores the token on window.__aapToken so our request runner can
// read it synchronously.
const _HOOK_SCRIPT = `(function () {
  if (window.__aapHookInstalled) return window.__aapToken || null;
  window.__aapHookInstalled = true;
  window.__aapToken = window.__aapToken || null;
  try {
    var RS = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      try { if (/csrftoken-a2z/i.test(k) && v) { window.__aapToken = v; } } catch (e) {}
      return RS.apply(this, arguments);
    };
  } catch (e) {}
  return window.__aapToken;
})();`;

// Wait (in-page) until a token has been captured, up to ms. Returns the token or null.
function _waitTokenScript(ms) {
  return `(async function () {
    var deadline = Date.now() + ${ms};
    while (!window.__aapToken && Date.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 150); });
    }
    return window.__aapToken || null;
  })();`;
}

// Ensure a warm, authenticated AAP page exists with the token captured. The
// page is obtained from browser_provider (Electron window on the laptop; a
// headless Playwright context on the DevSpace). Cookie seeding happens INSIDE
// the provider per-engine (Electron injects into session.defaultSession;
// Playwright seeds ~/.midway/cookie into the context), so there's no engine
// branching here — the token-capture + XHR logic is identical on both.
async function _ensureWindow() {
  if (_page && _token) { _scheduleTeardown(); return _page; }
  if (_page) { try { _page.close(); } catch (_) {} _page = null; }

  let page;
  try {
    page = await provider.openPage(TOKEN_PAGE_URL, { loadMs: PAGE_LOAD_MS });
  } catch (e) {
    dispose();
    // Normalize provider errors to the codes callers already handle.
    if (e && e.code === 'MIDWAY_SESSION_INVALID') {
      throw Object.assign(new Error(
        'AAP session expired (Midway/AEA). ' +
        (provider.kind() === 'playwright' ? 'Run mwinit -o on this host, then retry.'
                                          : 'Open the main window to re-authenticate, then retry.')),
        { code: 'MIDWAY_SESSION_INVALID' });
    }
    throw Object.assign(new Error('AAP API page failed to load: ' + (e && e.message)),
      { code: 'AAP_API_LOAD_FAILED' });
  }
  _page = page;

  // Install the XHR hook + wait briefly for a token-bearing XHR to fire. The
  // page already loaded authenticated (provider rejected on an SSO bounce).
  try {
    await page.evaluate(_HOOK_SCRIPT);
    const tok = await page.evaluate(_waitTokenScript(TOKEN_WAIT_MS));
    _token = tok || null;   // may be null for pure-GET usage; POST re-checks
  } catch (e) {
    dispose();
    throw Object.assign(new Error('AAP API token capture failed: ' + (e && e.message)),
      { code: 'AAP_API_LOAD_FAILED' });
  }

  _scheduleTeardown();
  return _page;
}

// Run a single HTTP request INSIDE the authenticated AAP page (so cookies + the
// captured token ride along). GET needs no token; POST attaches the a2z token.
function _requestScript(method, url, bodyLiteral) {
  const m = method.toUpperCase();
  const isPost = m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  return `(async function () {
    var token = window.__aapToken || null;
    ${isPost ? `if (!token) {
      // Try a short wait in case a token-bearing XHR is still in flight.
      var dl = Date.now() + 4000;
      while (!window.__aapToken && Date.now() < dl) { await new Promise(function(r){setTimeout(r,150);}); }
      token = window.__aapToken || null;
      if (!token) return { ok: false, status: 0, error: 'no-csrf-token' };
    }` : ''}
    return await new Promise(function (resolve) {
      try {
        var xhr = new XMLHttpRequest();
        xhr.open(${JSON.stringify(m)}, ${JSON.stringify(url)}, true);
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        ${isPost ? `xhr.setRequestHeader('Content-Type', 'application/json;charset=utf-8');
        xhr.setRequestHeader('anti-csrftoken-a2z', token);` : ''}
        xhr.withCredentials = true;
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            var txt = xhr.responseText || '';
            var json = null;
            try { json = JSON.parse(txt); } catch (e) {}
            var okStatus = xhr.status >= 200 && xhr.status < 300;
            // On error, always include the FULL raw body (not just when json is
            // null) so structured error detail (errors[], cause, fieldName)
            // isn't lost behind a generic top-level message.
            resolve({ ok: okStatus, status: xhr.status, json: json, text: (json && okStatus) ? null : txt.slice(0, 4000) });
          }
        };
        xhr.onerror = function () { resolve({ ok: false, status: 0, netErr: true }); };
        ${isPost ? `xhr.send(${bodyLiteral});` : 'xhr.send();'}
      } catch (e) { resolve({ ok: false, status: -1, error: e.message }); }
    });
  })();`;
}

async function _request(method, path, body) {
  return _withLock(async () => {
    const page = await _ensureWindow();
    const url = path.startsWith('http') ? path : (AAP_ORIGIN + path);
    const bodyLiteral = body != null ? JSON.stringify(JSON.stringify(body)) : 'null';
    const script = _requestScript(method, url, bodyLiteral);
    const r = await page.evaluate(script);
    _scheduleTeardown();
    if (!r || !r.ok) {
      // Surface the server's error body — AAP returns a JSON error object on 4xx
      // (validation details). We now capture the FULL raw text on error, so
      // prefer that (it carries errors[]/cause detail a top-level message hides).
      let detail = (r && r.text) || '';
      if (!detail && r && r.json) { try { detail = JSON.stringify(r.json); } catch (_) {} }
      if (!detail && r && r.error) detail = r.error;
      if (!detail) detail = 'HTTP ' + (r && r.status);
      // A 401/403 or an SSO redirect body means the session lapsed mid-call.
      if (r && (r.status === 401 || r.status === 403)) {
        throw Object.assign(new Error('AAP API ' + r.status + ' (session rejected)'), { code: 'MIDWAY_SESSION_INVALID' });
      }
      throw Object.assign(new Error('AAP API ' + (r && r.status) + ': ' + detail), { code: 'AAP_API_ERROR', status: r && r.status });
    }
    return r.json;
  });
}

// ── Public API ───────────────────────────────────────────────────────────────

function apiGet(path)        { return _request('GET',  path, null); }
function apiPost(path, body) { return _request('POST', path, body); }
function apiPut(path, body)  { return _request('PUT',  path, body); }

// Endpoint 1: paginated bulk WORK-ORDER search (serviceaggregates). Returns the
// raw response (caller reads the list + pagination). The endpoint 500s on a
// bare/partial body — it needs the FULL filter schema. We default to the proven
// DEFAULT_SEARCH_REQUEST captured from the real AAP export (same body the
// long-dwell CSV fetch uses) and shallow-merge any caller overrides on top.
function searchServices(searchRequest) {
  let base;
  try { base = require('./aap_longdwell').DEFAULT_SEARCH_REQUEST; } catch (_) { base = {}; }
  const body = Object.assign({}, base, searchRequest || {});
  return apiPost('/api/v1/serviceaggregates/search', body);
}

// Endpoint (inventory, v2): paginated bulk ASSET search — 200K+ assets. NOTE:
// this is /api/v2/assets/search (v2), NOT v1 — earlier probes missed it. Uses
// the proven DEFAULT_ASSET_SEARCH_REQUEST body; caller overrides shallow-merge.
function searchAssets(assetSearchRequest) {
  let base;
  try { base = require('./aap_longdwell').DEFAULT_ASSET_SEARCH_REQUEST; } catch (_) { base = {}; }
  const body = Object.assign({}, base, assetSearchRequest || {});
  return apiPost('/api/v2/assets/search', body);
}

// Fleet definitions + lifecycle schemas.
function getFleet(fleetId) {
  return apiGet('/api/v1/fleet/' + encodeURIComponent(fleetId));
}

// Latest known GPS location for an asset. The WR wizard calls this to fill the
// VRE recommendation's currentLocation (real lat/long + reverse-geocoded
// address). VRE's geofence rules depend on real coordinates — a null/zero
// coordinate makes the engine reject the request.
function getLocationLatest(aaid) {
  return apiGet('/api/v1/locationHistories/latest/' + encodeURIComponent(aaid));
}

// Endpoint 2: full service aggregate (comments, estimates, AVM codes).
function getService(serviceId) {
  return apiGet('/api/v1/serviceaggregates/' + encodeURIComponent(serviceId));
}

// Endpoint 3: full asset (VIN, model, odometer, GPS).
function getAsset(aaid) {
  return apiGet('/api/v1/assets/' + encodeURIComponent(aaid));
}

// Endpoint 4: service move history.
function getServiceMoves(aaid) {
  return apiGet('/api/v1/servicemoves/asset/' + encodeURIComponent(aaid));
}

// Endpoint 5: PM schedules.
function getMaintenanceSchedules(aaid) {
  return apiGet('/api/v1/maintenanceschedules/asset/' + encodeURIComponent(aaid));
}

// Endpoint 6: DVIR records.
function getDvirs(aaid) {
  return apiGet('/api/v1/dvirs/asset/' + encodeURIComponent(aaid));
}

// Endpoint 7: all AVM codes (L1/L2/L3 + reasons). Reference data — cache-worthy.
function getAvmCodes() {
  return apiGet('/api/v1/avmCodes/');
}

// Endpoint 8: current user info. Also a cheap auth probe.
function getUserDetails() {
  return apiGet('/api/v1/user/details');
}

// ── WR WIZARD LIVE LOOKUPS (vendors + category tree) ─────────────────────────
// These power the Create-WR modal's auto-populating dropdowns so vendors +
// categories + sub-categories always match AAP (self-updating). Cached briefly
// so opening the wizard repeatedly is instant; each returns the live data on a
// cache miss. All read-only (GET).

const _wrLookupCache = { vendors: null, avm: {} }; // avm keyed by equipmentType
const _WR_CACHE_MS = 6 * 60 * 60 * 1000; // refresh at most every 6h

// Map an asset's assetType/bodyType to the avmCodes path token. Confirmed:
// box trucks use 'boxTruck'. Tractors use 'tractor' (day-cab + sleeper share
// the tractor code set). Falls back to 'boxTruck' when unknown so the wizard
// always has a usable list.
function avmTypeFor(assetOrType) {
  const a = assetOrType || {};
  const hay = (typeof a === 'string' ? a : [a.assetType, a.bodyType, a.assetDefinitionKey, (a.attributesText && a.attributesText.bodyType)].filter(Boolean).join(' ')).toLowerCase();
  if (/box/.test(hay)) return 'boxTruck';
  if (/tractor|sleeper|day\s*cab|dayCab/.test(hay)) return 'tractor';
  if (/box/.test(hay)) return 'boxTruck';
  return 'boxTruck';
}

/**
 * getVendorConfigs(opts) -> array of vendor configs from AAP (cached).
 * Each: { vendorId, vendorName, uuid, suppliers[], supplierRequired,
 *         enabledFeatures[], wrEnabled }. The live vendor list for the WR modal.
 */
async function getVendorConfigs(opts = {}) {
  const now = Date.now();
  if (!opts.force && _wrLookupCache.vendors && (now - _wrLookupCache.vendors.at) < _WR_CACHE_MS) {
    return _wrLookupCache.vendors.list;
  }
  const raw = await apiGet('/api/v1/vendorConfigsByFilter?tenant=middleMile');
  const arr = Array.isArray(raw) ? raw : (raw && raw.vendorConfigs) || [];
  const list = arr.map((v) => ({
    vendorId: v.vendorId,
    vendorName: v.vendorName || v.vendorId,
    uuid: v.uuid || null,
    suppliers: Array.isArray(v.suppliers) ? v.suppliers : [],
    supplierRequired: !!v.supplierRequired,
    enabledFeatures: Array.isArray(v.enabledFeatures) ? v.enabledFeatures : [],
    // Only vendors enabled for unplanned WR creation should appear in the WR
    // dropdown (skill/eligibility at the vendor level).
    wrEnabled: (Array.isArray(v.enabledFeatures) ? v.enabledFeatures : []).some((f) => /WORK_REQUEST_CREATION|UNPLANNED/.test(String(f))),
  }));
  _wrLookupCache.vendors = { list, at: now };
  return list;
}

/**
 * getAvmTree(equipmentType, opts) -> {
 *   l1: [{code,displayName}],
 *   l2ByParent: { L1CODE: [{code,displayName}] },
 *   l3ByParent: { L2CODE: [{code,displayName}] },
 *   reasons: [{code,displayName}]
 * }  (cached per equipmentType). Powers cascading category -> sub-category ->
 * sub-sub-category -> reason-for-repair dropdowns, always current.
 */
async function getAvmTree(equipmentType, opts = {}) {
  const type = equipmentType || 'boxTruck';
  const now = Date.now();
  const cached = _wrLookupCache.avm[type];
  if (!opts.force && cached && (now - cached.at) < _WR_CACHE_MS) return cached.tree;

  const raw = await apiGet('/api/v1/avmCodes/' + encodeURIComponent(type));
  const l1 = (raw && raw.l1Codes || []).map((c) => ({ code: c.code, displayName: c.displayName || c.code }));
  const l2ByParent = {};
  (raw && raw.l2Codes || []).forEach((c) => {
    const item = { code: c.code, displayName: c.displayName || c.code };
    (Array.isArray(c.l1Parents) ? c.l1Parents : []).forEach((p) => { (l2ByParent[p] = l2ByParent[p] || []).push(item); });
  });
  const l3ByParent = {};
  (raw && raw.l3Codes || []).forEach((c) => {
    const item = { code: c.code, displayName: c.displayName || c.code };
    (Array.isArray(c.l2Parents) ? c.l2Parents : []).forEach((p) => { (l3ByParent[p] = l3ByParent[p] || []).push(item); });
  });
  const reasons = (raw && raw.reasonsForRepair || []).map((r) => (typeof r === 'string' ? { code: r, displayName: r } : { code: r.code, displayName: r.displayName || r.code }));
  const tree = { l1, l2ByParent, l3ByParent, reasons };
  _wrLookupCache.avm[type] = { tree, at: now };
  return tree;
}

// Pull every page of a search (100/page). Returns the concatenated list of
// service aggregates. Caps at maxPages to stay bounded. The exact list/field
// names depend on the response shape — we read common envelope keys and the
// caller can post-process.
async function searchAllPages(baseRequest, opts = {}) {
  const maxPages = opts.maxPages || 50;
  const all = [];
  let page = 1;
  for (; page <= maxPages; page++) {
    const req = Object.assign({}, baseRequest, { page });
    const res = await searchServices(req);
    // Confirmed list key is `serviceAggregates`; keep fallbacks for safety.
    const list = (res && (res.serviceAggregates || res.results || res.content || res.items || res.data)) || [];
    if (!Array.isArray(list) || list.length === 0) break;
    all.push(...list);
    // Stop when the page returned fewer than a full page (last page).
    if (list.length < (opts.pageSize || 100)) break;
  }
  logger.info('searchAllPages: collected ' + all.length + ' services across ' + (page) + ' page(s)');
  return all;
}

// ── Long Dwell sources via the JSON API (replaces the CSV /download path) ────
// Returns { wrRows, assetRows } as arrays of plain objects keyed by the SAME
// header names the CSV exports use — so ipc/long-dwell-csv.js _mergeToImportPayload
// can consume them unchanged (no CSV parsing, no BrowserWindow, no token capture;
// reuses the already-authenticated API client). WR = the open-WO list (the
// tracker's row driver); asset = fleet master data (site/operator/lifecycle).
async function buildLongDwellSources(opts = {}) {
  const woStatusStr = _woStatusStr;
  // 1) Work orders — the exact DEFAULT_SEARCH_REQUEST filter the CSV export used
  //    (UNPLANNED, open statuses, UNAVAILABLE, DSP-MMBT/vupAfp, the fleet IDs).
  const woList = await searchAllPages(opts.searchRequest || {}, { maxPages: opts.maxPages || 50 });
  const _epochIso = (ms) => { const n = Number(ms); if (!n || Number.isNaN(n)) return ''; try { return new Date(n).toISOString(); } catch (_) { return ''; } };
  const wrRows = woList.map((w) => {
    const l1 = []; const l2 = [];
    for (const si of (w.suggestedItems || [])) {
      if (si && si.level1 && !l1.includes(si.level1)) l1.push(si.level1);
      if (si && si.level2 && !l2.includes(si.level2)) l2.push(si.level2);
    }
    return {
      'Equipment ID':             w.assetDisplayName || '',
      'Asset Type':               w.assetType || '',
      'Lifecycle State Reason':   w.lifecycleStateReason || '',
      'Vendor':                   w.vendor || '',
      'Suppliers':                Array.isArray(w.suppliers) ? w.suppliers.join('; ') : (w.suppliers || w.providers || ''),
      'Delay reason codes':       Array.isArray(w.delayReasonCodes) ? w.delayReasonCodes.join('; ') : (w.delayReasonCodes || ''),
      'L1 Area of Concern':       l1.join('; '),
      'L2 Area of Concern':       l2.join('; '),
      'Asset Domicile Site':      w.assetDomicileSite || '',
      'Reported location':        (w.reportedLocation && (w.reportedLocation.geofenceName || w.reportedLocation.code)) || '',
      'Status':                   woStatusStr(w),
      'Expected completed date time': _epochIso(w.expectedCompletedDateTime),
      'Scheduled date time':      _epochIso(w.scheduledDateTime),
      'Actual start date time':   _epochIso(w.actualStartDateTime),
      'Expected start date time': _epochIso(w.expectedStartDateTime),
      'Last modified time':       _epochIso(w.modifiedTimestamp),
    };
  });

  // 2) Asset master data — all tractors/boxTrucks in the configured fleets,
  //    keyed by Equipment ID, for the site/operator/lifecycle join.
  const assetByAaid = new Map();
  const ASSET_FIELDS = ['displayName', 'operator', 'owner', 'domicileSite', 'assetType', 'lifecycleState', 'lifecycleStateReason'];
  for (let page = 0; page < (opts.maxPages || 60); page++) {
    let res;
    try { res = await searchAssets({ from: page * 150, fieldsToReturn: ASSET_FIELDS }); }
    catch (e) { logger.warn('buildLongDwellSources: asset search page ' + page + ' failed: ' + e.message); break; }
    const list = (res && res.assets) || [];
    if (!list.length) break;
    for (const a of list) {
      const aaid = a && a.asset && a.asset.aaid;
      if (aaid && !assetByAaid.has(aaid)) assetByAaid.set(aaid, a);
    }
    if (list.length < 150) break;
  }
  const assetRows = [...assetByAaid.values()].map((a) => {
    const at = (a.asset && a.asset.attributesText) || {};
    const asset = a.asset || {};
    return {
      'Equipment ID':          at.displayName || asset.displayName || '',
      'Domicile site':         at.domicileSite || '',
      'Operator':              at.operator || '',
      'Asset type':            asset.assetType || '',
      'Lifecycle state reason': asset.lifecycleStateReason || at.lifecycleStateReason || '',
    };
  });

  logger.info('buildLongDwellSources: ' + wrRows.length + ' WR rows, ' + assetRows.length + ' asset rows (API)');
  return { wrRows, assetRows };
}

// ── Pipeline: build a work-order dataset joined to asset master data ─────────
// Confirmed field names (from live response shapes 2026-10-16):
//   WORK ORDER (serviceAggregates[]):
//     id / workRequestId, aaid, assetDisplayName (=unit#), assetType,
//     assetProgram, assetDomicileSite, assetRentalStatus, vendor, suppliers,
//     status{description,type}, subStatus, isUrgent, lifecycleState,
//     lifecycleStateReason, delayReasonCodes[], damageDescription,
//     scheduledDateTime, expectedStartDateTime, actualStartDateTime,
//     expectedCompletedDateTime, completedDateTime, modifiedTimestamp,
//     suggestedItems[], escalations, totalEstimatePendingApprovalCost,
//     providers, alternateUniqueId
//   ASSET (assets[]): asset{aaid,assetType,displayName,fleetId,lifecycleState,
//     lifecycleStateReason}, fleetName, displayName, yard{...}, latestLocation{
//     odometerInKm, engineHours, geoFences, ...}
function _epochToIso(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  try { return new Date(n).toISOString(); } catch (_) { return ''; }
}
function _daysDownFrom(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  const d = Math.floor((Date.now() - n) / 86400000);
  return d >= 0 ? String(d) : '';
}

// Build an aaid -> asset-record map from the asset search (all pages).
async function _assetIndex(opts = {}) {
  const idx = new Map();
  const maxPages = opts.maxPages || 60;
  for (let page = 0; page < maxPages; page++) {
    const res = await searchAssets({ from: page * 150 });
    const list = (res && res.assets) || [];
    if (!list.length) break;
    for (const a of list) {
      const aaid = a && a.asset && a.asset.aaid;
      if (aaid && !idx.has(aaid)) idx.set(aaid, a);
    }
    if (list.length < 150) break;
  }
  return idx;
}

// Map one work-order aggregate (+ its matched asset) to a flat tracker row
// keyed by the AFP/Long-Dwell column names.
function _mapRow(wo, asset) {
  const a = (asset && asset.asset) || {};
  const loc = (wo && wo.latestLocation) || (asset && asset.latestLocation) || {};
  // suggestedItems[] fields (confirmed): level1/level2/level3 (+ vmrsL*Code,
  // reasonForRepair). Collect distinct non-empty L1/L2 + reasons.
  const l1 = []; const l2 = []; const l3 = []; const reasons = [];
  for (const si of (wo.suggestedItems || [])) {
    if (!si) continue;
    if (si.level1 && !l1.includes(si.level1)) l1.push(si.level1);
    if (si.level2 && !l2.includes(si.level2)) l2.push(si.level2);
    if (si.level3 && !l3.includes(si.level3)) l3.push(si.level3);
    if (si.reasonForRepair && !reasons.includes(si.reasonForRepair)) reasons.push(si.reasonForRepair);
  }
  // latestLocation carries odometerInMiles directly; fall back to km → miles.
  const odoMiles = loc.odometerInMiles != null ? Math.round(Number(loc.odometerInMiles))
    : (loc.odometerInKm != null ? Math.round(Number(loc.odometerInKm) * 0.621371) : null);
  return {
    serviceId:       wo.id || wo.workRequestId || '',
    aaid:            wo.aaid || a.aaid || '',
    assetId:         wo.assetDisplayName || a.displayName || '',       // unit number
    assetType:       wo.assetType || a.assetType || '',
    site:            wo.assetDomicileSite || '',
    fleetName:       wo.fleetName || (asset && asset.fleetName) || '',
    assetProgram:    wo.assetProgram || '',
    rentalStatus:    wo.assetRentalStatus || '',
    vendor:          wo.vendor || '',
    suppliers:       wo.suppliers || wo.providers || '',
    status:          _woStatusStr(wo),
    subStatus:       wo.subStatus || '',
    isUrgent:        wo.isUrgent === true || wo.isUrgent === 'true',
    lifecycleState:  wo.lifecycleState || a.lifecycleState || '',
    lifecycleReason: wo.lifecycleStateReason || a.lifecycleStateReason || '',
    delayReasons:    Array.isArray(wo.delayReasonCodes) ? wo.delayReasonCodes.join('; ') : '',
    damageDescription: wo.damageDescription || '',
    l1:              l1.join('; '),
    l2:              l2.join('; '),
    l3:              l3.join('; '),
    reasonForRepair: reasons.join('; '),
    scheduledDateTime:     _epochToIso(wo.scheduledDateTime),
    expectedStartDateTime: _epochToIso(wo.expectedStartDateTime),
    actualStartDateTime:   _epochToIso(wo.actualStartDateTime),
    expectedCompletedDateTime: _epochToIso(wo.expectedCompletedDateTime),
    completedDateTime:     _epochToIso(wo.completedDateTime),
    daysDown:        _daysDownFrom(wo.actualStartDateTime || wo.expectedStartDateTime || wo.scheduledDateTime),
    estimatePendingCost: wo.totalEstimatePendingApprovalCost != null ? wo.totalEstimatePendingApprovalCost : '',
    escalations:     wo.escalations ? (Array.isArray(wo.escalations) ? wo.escalations.join('; ') : String(wo.escalations)) : '',
    vendorWorkOrderIds: Array.isArray(wo.vendorWorkOrderIds) ? wo.vendorWorkOrderIds.join('; ') : '',
    odometerMiles:   odoMiles != null ? odoMiles : '',
    engineHours:     loc.engineHours != null ? loc.engineHours : '',
    vin:             a.vin || '',
    alternateUniqueId: wo.alternateUniqueId || '',
  };
}

// Pull a VIN (and a few other master-data fields) out of a full single-asset
// response. Confirmed shape: everything lives under asset.attributes{Text,
// Integer,Double,Boolean,Date}. VIN = asset.attributesText.vin.
function _assetDetailFields(full) {
  const a  = (full && full.asset) || {};
  const at = a.attributesText || {};
  const ai = a.attributesInteger || {};
  const ad = a.attributesDouble || {};
  return {
    vin:          at.vin || '',
    model:        at.model || at.modelName || '',
    manufacturer: at.manufacturer || at.make || '',
    modelYear:    ai.modelYear || at.modelYear || '',
    engineManufacturer: at.engineManufacturer || '',
    licensePlate: at.licensePlateId || at.licensePlate || '',
    odometerMiles: (full && full.latestLocation && full.latestLocation.odometerInMiles != null)
      ? Math.round(Number(full.latestLocation.odometerInMiles)) : '',
    engineHours:  (full && full.latestLocation && full.latestLocation.engineHours != null)
      ? full.latestLocation.engineHours : '',
  };
}

// Full pipeline: fetch all open work orders, index all assets, join by aaid,
// map, and (optionally) enrich each row with VIN/model via the full single-asset
// GET. Enrichment is one GET per unit — bounded to the WO set (typically the
// long-dwell list, not the whole fleet), and skippable via opts.enrich=false.
async function buildTrackerRows(opts = {}) {
  const [woList, assetIdx] = await Promise.all([
    searchAllPages(opts.searchRequest || {}, { maxPages: opts.maxPages || 50 }),
    _assetIndex(opts),
  ]);
  const rows = woList.map((wo) => _mapRow(wo, assetIdx.get(wo.aaid)));

  // Enrich with VIN/model from the full single-asset endpoint. Default on, but
  // BOUNDED: deduped by aaid, each GET has its own timeout, and the whole
  // enrichment phase is capped so it can never hang the pipeline. Skip entirely
  // with { enrich: false } for a fast list.
  if (opts.enrich !== false) {
    const uniqueAaids = [...new Set(rows.map((r) => r.aaid).filter(Boolean))];
    const perCallMs = opts.enrichPerCallMs || 8000;
    const maxEnrich = opts.enrichMax || uniqueAaids.length; // cap how many we enrich
    const seen = new Map();
    const withTimeout = (p, ms) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('enrich-timeout')), ms)),
    ]);
    let done = 0;
    for (const aaid of uniqueAaids) {
      if (done >= maxEnrich) break;
      done++;
      try {
        const full = await withTimeout(getAsset(aaid), perCallMs);
        seen.set(aaid, _assetDetailFields(full));
      } catch (_) { seen.set(aaid, null); }
    }
    for (const r of rows) {
      const d = r.aaid && seen.get(r.aaid);
      if (d) {
        r.vin = d.vin || r.vin;
        r.model = d.model;
        r.manufacturer = d.manufacturer;
        r.modelYear = d.modelYear;
        if (d.odometerMiles !== '') r.odometerMiles = d.odometerMiles;
        if (d.engineHours !== '') r.engineHours = d.engineHours;
      }
    }
    logger.info('buildTrackerRows: enriched ' + done + '/' + uniqueAaids.length + ' unique assets');
  }

  logger.info('buildTrackerRows: ' + rows.length + ' work orders, ' + assetIdx.size + ' assets indexed'
    + (opts.enrich === false ? ' (no VIN enrichment)' : ' (VIN-enriched)'));
  return rows;
}

// ── Build the full fleet dataset in the app's fleet-row shape ────────────────
// Additive / opt-in: produces rows mapped to the SAME field names the renderer
// + merges expect (see aap_api_mapper.toFleetRow), so this can feed the live
// pipeline or be previewed side-by-side with the scrape before any switch.
//
// opts:
//   domiciles   : array of site codes to filter (defaults to settings.domiciles)
//   withComments: fetch per-WO service detail for the comment thread (default true)
//   withVin     : fetch per-asset detail for VIN/model (default true)
//   maxPages    : WO search page cap
//   detailCap   : max per-unit detail GETs (bounds the comment/VIN enrichment)
// VERIFIED MODEL (2026-10-16): the app's fleet set = ASSETS whose domicileSite
// OR operator is in the configured filter list (settings.domiciles, which mixes
// site codes AND operator/SCAC codes — exactly replicating the scrape's loose
// `search=` behavior). The asset lifecycleState is the source of truth for
// availability (matches the app's unavailable count). Work orders are attached
// as enrichment (vendor, status, L1/L2, comment thread). A unit that is
// UNAVAILABLE in asset lifecycle but has no open WO still appears — just as the
// app shows it.
//
// opts:
//   domiciles    : filter list (defaults to settings.domiciles)
//   unavailableOnly : only return UNAVAILABLE units (default false → full fleet)
//   withComments : fetch per-WO service detail for the comment thread (default true)
//   withVin      : fetch per-asset detail for VIN/model (default true)
//   detailCap    : cap per-unit detail GETs (bounds enrichment)
async function buildFleetDataset(opts = {}) {
  const mapper = require('./aap_api_mapper');

  // Resolve the filter list from settings unless explicitly provided.
  let filters = opts.domiciles;
  if (!filters) {
    try {
      const store = require('../store');
      const s = store.load('settings', {});
      filters = (s.domiciles && s.domiciles.length) ? s.domiciles
        : require('../config/defaults').DEFAULT_DOMICILES;
    } catch (_) { filters = []; }
  }
  const filterVals = (filters || []).map((d) => String(d).trim().toUpperCase());

  // 1) ASSET SET — union of domicileSite-matched and operator-matched assets.
  //    This is the app's fleet scope. Keyed by aaid. We request the master-data
  //    fields IN BULK via fieldsToReturn (confirmed the search honors it), so
  //    operator / owner / domicileSite / bodyType / VIN / make come back for
  //    EVERY unit in the search result — no per-unit getAsset loop needed.
  // NOTE: maintenanceScheduleStatuses is NOT requestable here — the v2 asset
  // search rejects it (HTTP 400). PM due dates come from per-unit getAsset()
  // (hydration for down units + lazy refreshUnit on panel open) instead.
  const BULK_FIELDS = ['displayName', 'operator', 'owner', 'domicileSite', 'bodyType',
    'assetType', 'vin', 'manufacturerName', 'engineManufacturerName', 'program',
    'lifecycleState', 'lifecycleStateReason',
    // NOTE: the asset search does NOT carry open-WR counts (confirmed: only
    // displayName/yard/latestLocation come back). The U/P column is populated
    // from per-category open-WO tallies instead (see openUnplannedByAaid /
    // openPlannedByAaid below).
    // Location fields so EVERY unit shows a "Last Geofence" (geoFences are
    // confirmed valid search fields — DEFAULT_ASSET_SEARCH_REQUEST requests them).
    'geoFences', 'yardBuildingID', 'latestLocationTimestamp', 'geoPoint'];
  const assetByAaid = new Map();    // aaid -> asset summary record
  for (const key of ['domicileSite', 'operator']) {
    for (let page = 0; page < (opts.maxPages || 60); page++) {
      const res = await searchAssets({
        from: page * 150,
        fieldFilters: filterVals.length ? [{ key, values: filterVals }] : [],
        fieldsToReturn: BULK_FIELDS,
      });
      const list = (res && res.assets) || [];
      if (!list.length) break;
      for (const a of list) {
        const aaid = a && a.asset && a.asset.aaid;
        if (aaid && !assetByAaid.has(aaid)) assetByAaid.set(aaid, a);
      }
      if (list.length < 150) break;
      if (!filterVals.length) break; // unfiltered: don't page the whole fleet
    }
  }

  // Optionally narrow to UNAVAILABLE assets only.
  const assetEntries = [...assetByAaid.values()].filter((a) => {
    if (opts.unavailableOnly) return String(a.asset && a.asset.lifecycleState).toUpperCase() === 'UNAVAILABLE';
    return true;
  });

  // 2) WORK ORDERS — fetch WOs for the same filter, index by aaid, choosing the
  //    CURRENT OPEN WO per unit. A unit accumulates many historical WOs; picking
  //    "most recently modified" can land on a CLOSED one (and its serviceId gives
  //    a Split-View URL to a closed WR). So prefer an OPEN-status WO, then break
  //    ties by recency. (Bug fix: 321187/321186/321946 were getting the wrong /
  //    no serviceUrl because a non-open WO won the most-recent tiebreak.)
  const OPEN_STATUSES = new Set(['CREATED', 'PENDING', 'PENDING_REVIEW', 'SCHEDULED',
    'WORK_IN_PROGRESS', 'WORK_ORDER_ASSIGNED', 'ESTIMATE_APPROVED',
    'ESTIMATE_PENDING_APPROVAL', 'ESTIMATE_REJECTED']);
  const woByAaid = new Map();
  const woTs = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
  const woIsOpen = (w) => {
    const s = _woStatusStr(w);
    const completed = w && (w.completedDateTime || w.completedDate);
    return OPEN_STATUSES.has(String(s).toUpperCase()) || (!completed && !/complet|closed|cancel/i.test(String(s)));
  };
  const woBetter = (cand, prev) => {
    if (!prev) return true;
    const co = woIsOpen(cand), po = woIsOpen(prev);
    if (co !== po) return co;            // an open WO always beats a non-open one
    return woTs(cand) > woTs(prev);      // otherwise newest wins
  };
  const woReq = Object.assign({}, opts.searchRequest || {});
  if (filterVals.length) woReq.assetDomicileSites = filterVals; // WO search accepts site+operator tokens here
  const woList = await searchAllPages(woReq, { maxPages: opts.maxPages || 50 });
  for (const w of woList) {
    if (!w.aaid) continue;
    if (woBetter(w, woByAaid.get(w.aaid))) woByAaid.set(w.aaid, w);
  }

  // U/P COLUMN — open WORK-REQUEST counts per asset, by category. The asset
  // record carries NO open-WR count fields (confirmed via getAsset + asset
  // search: only displayName/yard/latestLocation come back). The ONLY reliable
  // source is the WO search itself, counting OPEN WOs per aaid for each
  // category. `category` is NON-nullable on the search body, so we run one pass
  // per value. The UNPLANNED open set is already `woList` above (the default
  // searchRequest is UNPLANNED + the open-status list); we add a PLANNED pass.
  // Counts are indexed by aaid and attached to each row below.
  const openUnplannedByAaid = new Map();
  const openPlannedByAaid = new Map();
  for (const w of woList) {
    if (w && w.aaid && woIsOpen(w)) openUnplannedByAaid.set(w.aaid, (openUnplannedByAaid.get(w.aaid) || 0) + 1);
  }
  try {
    const plannedReq = Object.assign({}, woReq, { category: 'PLANNED' });
    const plannedList = await searchAllPages(plannedReq, { maxPages: opts.maxPages || 50 });
    for (const w of plannedList) {
      if (w && w.aaid && woIsOpen(w)) openPlannedByAaid.set(w.aaid, (openPlannedByAaid.get(w.aaid) || 0) + 1);
    }
  } catch (e) {
    try { logger.warn('buildFleetDataset: PLANNED WO count pass failed: ' + e.message); } catch (_) { /* noop */ }
  }

  // 3) Build one fleet row per ASSET (the app's set). Attach the current WO if
  //    the unit has one; units with no open WO still appear (lifecycle-driven).
  const detailCap = opts.detailCap != null ? opts.detailCap : assetEntries.length;
  const perCallMs = opts.detailPerCallMs || 8000;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('detail-timeout')), ms))]);

  const rows = [];
  let detailDone = 0;
  let woFallbacks = 0;
  for (const assetSummary of assetEntries) {
    const aaid = assetSummary.asset && assetSummary.asset.aaid;
    let wo = (aaid && woByAaid.get(aaid)) || null;

    // FALLBACK: the bulk site-filtered WO search can miss a unit's open WO
    // (paged out, or the WO's domicile token didn't match the asset's). Without
    // the WO we have no serviceUrl → Split View can't open the Relay pane. So
    // for any in-scope unit that ended up with no WO, query its open WO directly
    // by equipmentId (bounded). Confirmed fix for 321187/321186/321946.
    const unitNum = assetSummary.asset && assetSummary.asset.displayName;
    if (!wo && unitNum && opts.woFallback !== false && woFallbacks < (opts.woFallbackCap || assetEntries.length)) {
      try {
        const found = await withTimeout(findOpenWO(unitNum), perCallMs);
        if (found) { wo = found; woFallbacks++; }
      } catch (_) { /* no WO available */ }
    }

    // Enrich with the comment thread from the full service detail (bounded).
    let serviceDetail = null;
    if (wo && opts.withComments !== false && detailDone < detailCap && (wo.id || wo.workRequestId)) {
      try { serviceDetail = await withTimeout(getService(wo.id || wo.workRequestId), perCallMs); detailDone++; }
      catch (_) { /* leave comments empty */ }
    }

    // Map to the app's fleet-row shape. When there's no WO, synthesize a minimal
    // WO-like object from the asset so lifecycle/site/unit still populate.
    const woOrAsset = wo || {
      assetDisplayName: assetSummary.asset && assetSummary.asset.displayName,
      aaid,
      assetType: assetSummary.asset && assetSummary.asset.assetType,
      lifecycleState: assetSummary.asset && assetSummary.asset.lifecycleState,
      lifecycleStateReason: assetSummary.asset && assetSummary.asset.lifecycleStateReason,
    };
    const row = mapper.toFleetRow(woOrAsset, assetSummary, serviceDetail);
    // U/P column: open unplanned / planned WR counts for THIS asset, from the
    // per-category open-WO tallies built above (the asset record itself has no
    // such field). Keyed by aaid.
    row.openUnplanned = (aaid && openUnplannedByAaid.get(aaid)) || 0;
    row.openPlanned = (aaid && openPlannedByAaid.get(aaid)) || 0;
    // Asset lifecycle is the SOURCE OF TRUTH for availability. A WO's own
    // lifecycleState/Reason can lag badly (a zombie "open" WO from years ago),
    // so always override from the asset.
    const _assetState = assetSummary.asset && assetSummary.asset.lifecycleState;
    const _assetReason = assetSummary.asset && assetSummary.asset.lifecycleStateReason;
    row.lifecycleState = mapper.mapLifecycleState(_assetState) || row.lifecycleState;
    const _assetUnavailable = /unavail/i.test(String(_assetState || ''));
    if (_assetUnavailable) {
      // Unavailable: use the asset's reason (truth); only keep the WO-derived
      // reason if the asset doesn't carry one.
      row.lifecycleReason = mapper.mapLifecycleReason(_assetReason) || row.lifecycleReason;
    } else {
      // AVAILABLE / Active: the unit is in service — it has NO unavailable
      // reason, and any WO the bulk search attached is HISTORICAL (a zombie
      // "open" WO that was never closed). Clear the WO framing so the row shows
      // as a clean in-service unit instead of "Active / Offsite Shop Repair"
      // with a 2-year-old work order (124124). Asset master data stays.
      row.lifecycleReason = '';
      row.vendor = '';
      row.serviceState = '';
      row.subState = '';
      row.serviceCategory = '';
      row.issueDetails = '';
      row.issueSummary = '';
      row.workRequestId = '';
      row.serviceUrl = '';
      row._serviceId = '';
      row.created = '';
      row.completed = '';
      row.repairTimeline = '';
      row.fullConversation = '';
      row.level1 = '';
      row.level2 = '';
      row.relaySynced = false;
      wo = null; // ensure no secondary/detail logic treats it as having a WO
    }

    // ASSET MASTER DATA — read straight from the BULK search result's
    // attributesText (operator, owner, domicileSite, bodyType, make, VIN). This
    // populates every unit instantly with no per-unit getAsset call, and fixes
    // the blank operator (incl. AKJJI), site, and box-truck body type.
    const at = (assetSummary.asset && assetSummary.asset.attributesText) || {};
    if (at.operator)     row.operator = at.operator;
    if (at.owner)        row.owner = at.owner;
    if (at.domicileSite) row.domicileSite = at.domicileSite;
    if (at.bodyType)     row.bodyType = mapper.mapBodyType(at.bodyType, assetSummary.asset && assetSummary.asset.assetType);
    if (at.vin)          row.vin = at.vin;
    if (at.manufacturerName) row.manufacturer = at.manufacturerName;
    if (at.engineManufacturerName) row.engineManufacturer = at.engineManufacturerName;

    // PM due dates — from the asset's maintenanceScheduleStatuses[] if the bulk
    // search returned it (requested via BULK_FIELDS). Sets raw pm*Due fields +
    // the short pills, same formatter as the scrape path.
    try {
      const mss = (assetSummary.asset && assetSummary.asset.maintenanceScheduleStatuses);
      if (Array.isArray(mss) && mss.length) {
        const pmRaw = mapper.pmDueFields({ maintenanceScheduleStatuses: mss });
        Object.assign(row, pmRaw);
        const { parsePMDates } = require('./relay');
        if (parsePMDates) {
          const pm = parsePMDates(pmRaw);
          row.pmB = pm.pmB; row.pmX = pm.pmX; row.dot = pm.dot; row.quarterlyLift = pm.quarterlyLift;
        }
      }
    } catch (_) { /* PM best-effort */ }

    // LOCATION — the v2 asset search returns location fields (geoFences, etc.)
    // requested via BULK_FIELDS, but their nesting varies. Try the common spots
    // so every unit gets a "Last Geofence". Falls back to the domicile site.
    try {
      if (!row.geofence) {
        const asset = assetSummary.asset || {};
        const ll = assetSummary.latestLocation || asset.latestLocation || {};
        const gf = (g) => (Array.isArray(g) && g.length) ? (g[0] && (g[0].name || g[0].geofenceName || g[0])) : '';
        row.geofence = gf(ll.geoFences) || gf(asset.geoFences) || gf(assetSummary.geoFences)
          || ll.geofenceName || ll.yardBuildingID || asset.yardBuildingID
          || row.domicileSite || '';
      }
    } catch (_) { /* geofence best-effort */ }

    rows.push(row);
  }

  const unavailableCount = rows.filter((r) => /unavailable/i.test(String(r.lifecycleState || ''))).length;
  if (woFallbacks) logger.info('buildFleetDataset: ' + woFallbacks + ' per-unit WO fallbacks (bulk search missed their open WO)');
  logger.info('buildFleetDataset: ' + rows.length + ' units ('
    + 'unavailable: ' + unavailableCount + ', filter: [' + filterVals.join(',') + '], '
    + 'comments: ' + (opts.withComments !== false) + ', vin: ' + (opts.withVin !== false) + ')');
  return { rows, count: rows.length, unavailableCount, filter: filterVals, syncedAt: new Date().toISOString(), source: 'aap-api' };
}

// Find a unit's CURRENT OPEN work order, unconstrained by the restrictive
// DEFAULT_SEARCH_REQUEST (fleetIds/assetPrograms/lifecycleStates/status set).
// CONFIRMED (2026-10-16): searching a unit with the default filter can return 0
// WOs even when it has open ones (its program/status isn't in the default set),
// which is why some units got no serviceUrl. Here we query by equipmentId with
// the status filter and the narrowing filters CLEARED, see every WO, and pick
// the open one (newest tiebreak). Returns the WO object or null.
async function findOpenWO(unitNumber) {
  const u = String(unitNumber || '').trim().toUpperCase();
  if (!u) return null;

  const ts = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
  const isOpen = (w) => {
    const s = _woStatusStr(w);
    const completed = w && (w.completedDateTime || w.completedDate);
    return (!completed && !/complet|closed|cancel/i.test(String(s)));
  };
  const pickOpen = (list) => {
    if (!list || !list.length) return null;
    list = list.slice().sort((a, b) => ((isOpen(b) ? 1 : 0) - (isOpen(a) ? 1 : 0)) || (ts(b) - ts(a)));
    return isOpen(list[0]) ? list[0] : null;
  };

  // ATTEMPT 1 — fast path: query by equipmentId, clear ONLY the status filter.
  // Works for the common case (unit's program/lifecycle/fleet match the default
  // body). `{ equipmentIds:[u], statuses:[] }` returned all WOs live.
  let res = await searchServices({ equipmentIds: [u], statuses: [], page: 1 });
  let hit = pickOpen((res && res.serviceAggregates) || []);
  if (hit) return hit;

  // ATTEMPT 2 — widened: the default body also constrains category ('UNPLANNED'),
  // lifecycleStates (['UNAVAILABLE']), assetPrograms (['DSP-MMBT','vupAfp']) and
  // fleetIds. A unit whose OPEN WO falls outside ANY of those (e.g. a PLANNED
  // DAMAGE work request, or a program/fleet not in the default set) is dropped
  // by attempt 1 even though it has an open WO. CONFIRMED cases: 922483, B13014,
  // 321186 — all Status=Scheduled, Sub=Created, WRSource=DAMAGE. Setting these
  // dimensions to null (NOT [] — an empty array over-constrained the body and
  // returned nothing) means "no filter on this dimension", so the unit's open WO
  // is seen regardless of its category/program/lifecycle/fleet.
  res = await searchServices({
    equipmentIds: [u],
    statuses: [],
    category: null,
    lifecycleStates: null,
    assetPrograms: null,
    fleetIds: null,
    page: 1,
  });
  hit = pickOpen((res && res.serviceAggregates) || []);
  if (hit) {
    logger.info('findOpenWO: ' + u + ' resolved via widened query (outside default category/program/lifecycle/fleet)');
  }
  return hit;
}

// ── Per-unit refresh: fresh data for ONE unit via the API ────────────────────
// Replaces the (currently unused) per-unit relay scrape. Given a unit number,
// resolves its current open WO + asset, returns a mapped fleet row with the
// live comment thread. Used by the detail-panel refresh button.
async function refreshUnit(unitNumber) {
  const mapper = require('./aap_api_mapper');
  const u = String(unitNumber || '').trim().toUpperCase();
  if (!u) throw new Error('refreshUnit: no unit number');

  // Fetch ALL of the unit's work orders (planned + unplanned, open + closed),
  // unconstrained by the restrictive default filter. We show every WO as a card
  // in the detail pane — a closed WO is still a work order worth seeing.
  let allWOs = [];
  try {
    const r1 = await searchServices({ equipmentIds: [u], statuses: [], page: 1 });
    allWOs = (r1 && r1.serviceAggregates) || [];
    // If the restrictive body hid them, widen (same two-tier logic as findOpenWO).
    if (!allWOs.length) {
      const r2 = await searchServices({
        equipmentIds: [u], statuses: [], category: null,
        lifecycleStates: null, assetPrograms: null, fleetIds: null, page: 1,
      });
      allWOs = (r2 && r2.serviceAggregates) || [];
    }
  } catch (_) { allWOs = []; }

  // Classify WOs. The search with statuses:[] returns the unit's ENTIRE WO
  // history (every old completed/cancelled WO), so we must NOT show all of them
  // — only the CURRENTLY-RELEVANT ones.
  const _ts = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
  const _statusOf = (w) => _woStatusStr(w);
  const _isCancelled = (w) => _woIsCancelled(w);
  const _isOpen = (w) => {
    const completed = w && (w.completedDateTime || w.completedDate);
    return (!completed && !/complet|closed|cancel/i.test(_statusOf(w)));
  };
  // Is the ASSET itself unavailable? The WO aggregate carries the asset's
  // lifecycleState; any WO row for this unit reflects it.
  const _unitUnavailable = allWOs.some((w) => /unavail/i.test(String(w && w.lifecycleState || '')));

  const openWOs = allWOs.filter(_isOpen).sort((a, b) => _ts(b) - _ts(a));

  // Primary WO selection:
  //  1) Newest OPEN work order (the normal case).
  //  2) No open WO → newest NON-cancelled WO (a just-completed WO still shows so
  //     the card/timeline render; its status pill reads its real state).
  //  3) Only cancelled WOs left → show the newest cancelled one ONLY when the
  //     unit is UNAVAILABLE and has no open WO (per rule: a cancelled WO is
  //     hidden unless it's the single thing explaining an unavailable unit).
  //     For an AVAILABLE unit, never surface a cancelled WO as the primary card.
  const byRecency = allWOs.slice().sort((a, b) => _ts(b) - _ts(a));
  let wo = openWOs[0] || null;
  if (!wo) {
    const newestNonCancelled = byRecency.find((w) => !_isCancelled(w)) || null;
    if (newestNonCancelled) {
      wo = newestNonCancelled;
    } else if (_unitUnavailable) {
      // Every WO is cancelled, but the unit is unavailable with no open WO —
      // surface the newest cancelled WO as the last-resort explanation.
      wo = byRecency[0] || null;
    } else {
      wo = null; // available unit, only cancelled history → show no WR card
    }
  }

  // Asset summary + full detail (VIN) via the aaid.
  let assetSummary = null, serviceDetail = null;
  const aaid = wo && wo.aaid;
  if (wo && (wo.id || wo.workRequestId)) {
    try { serviceDetail = await getService(wo.id || wo.workRequestId); } catch (_) {}
  }
  let full = null;
  if (aaid) { try { full = await getAsset(aaid); } catch (_) {} }

  const row = mapper.toFleetRow(wo || { assetDisplayName: u }, assetSummary, serviceDetail);

  // Attach ONLY the OTHER CURRENTLY-OPEN work orders as secondary cards (a unit
  // with one open unplanned + one open planned WR shows both). We deliberately
  // DO NOT list the unit's old completed/closed/cancelled WOs here — those are
  // history, not current work, and listing them cluttered the pane with
  // irrelevant cards (e.g. 322377 has ONE active WO but the full-history query
  // returned many old closed ones). A just-closed WO only surfaces as the
  // PRIMARY card (the openWOs[0]||newest fallback above), never as a secondary.
  const primaryId = wo ? (wo.workRequestId || wo.id) : null;
  const others = openWOs.filter((w) => (w.workRequestId || w.id) !== primaryId);
  const secondary = [];
  const SECONDARY_CAP = 6;
  for (const w of others.slice(0, SECONDARY_CAP)) {
    let sd = null;
    const wid = w.workRequestId || w.id;
    if (wid) { try { sd = await getService(wid); } catch (_) {} }
    const entry = mapper.toSecondaryWR(w, sd);
    if (entry) secondary.push(entry);
  }
  row._secondaryWRs = secondary.length ? secondary : [];
  if (full) {
    const d = mapper.assetDetailFields(full);
    row.vin = d.vin || row.vin;
    row.manufacturer = d.manufacturer || row.manufacturer;
    row.engineManufacturer = d.engineManufacturer || row.engineManufacturer || '';
    row.modelYear = d.modelYear || row.modelYear || '';
    if (d.operator)     row.operator = d.operator;
    if (d.owner)        row.owner = d.owner;
    if (d.domicileSite) row.domicileSite = d.domicileSite;
    if (d.bodyType)     row.bodyType = d.bodyType;
    if (d.odometerMiles !== '') row.odometerMiles = d.odometerMiles;
    if (d.engineHours !== '') row.engineHours = d.engineHours;
    // Asset lifecycle = source of truth.
    const a = full.asset || {};
    row.lifecycleState = mapper.mapLifecycleState(a.lifecycleState) || row.lifecycleState;
    if (!wo) row.lifecycleReason = mapper.mapLifecycleReason(a.lifecycleStateReason) || row.lifecycleReason;

    // PM due dates — from the asset's maintenanceScheduleStatuses[] (getAsset).
    // Set the raw per-label fields (pmBDue/pmXDue/dotDue/quarterlyLiftDue) AND
    // the short display pills (pmB/pmX/dot/quarterlyLift) via relay's parser so
    // the detail panel + grid show them exactly like the scrape path did.
    try {
      const pmRaw = mapper.pmDueFields(full);
      const _hasPm = pmRaw.pmBDue || pmRaw.pmXDue || pmRaw.dotDue || pmRaw.quarterlyLiftDue;
      if (_hasPm) {
        for (const k of Object.keys(pmRaw)) { if (pmRaw[k]) row[k] = pmRaw[k]; }
        const { parsePMDates } = require('./relay');
        if (parsePMDates) {
          const pm = parsePMDates(pmRaw);
          row.pmB = pm.pmB; row.pmX = pm.pmX; row.dot = pm.dot; row.quarterlyLift = pm.quarterlyLift;
        }
      }
    } catch (_) { /* PM parse best-effort */ }
  }

  // ASSET-IS-TRUTH guard: if the unit is AVAILABLE/Active (not unavailable), it
  // is in service — it has no current repair. A WO the history query attached
  // (even one with an "open" status) is a stale/zombie WO. Clear the WR framing
  // so an Active unit never shows "Active / Offsite Shop Repair" with an old
  // work order (124124). Decide from the authoritative asset lifecycle (full),
  // falling back to the WO aggregate's lifecycleState.
  const _finalState = String(row.lifecycleState || '');
  const _available = !/unavail/i.test(_finalState) && !!_finalState;
  if (_available) {
    row.lifecycleReason = '';
    row.vendor = '';
    row.serviceState = '';
    row.subState = '';
    row.serviceCategory = '';
    row.issueDetails = '';
    row.issueSummary = '';
    row.workRequestId = '';
    row.serviceUrl = '';
    row._serviceId = '';
    row.created = '';
    row.completed = '';
    row.repairTimeline = '';
    row.fullConversation = '';
    row.level1 = '';
    row.level2 = '';
    row.relaySynced = false;
    row._secondaryWRs = [];
  }
  return row;
}

// ── WORK-ORDER DETAIL (API-first) ────────────────────────────────────────────
// API replacement for aap_wo_scraper.scrapeWorkOrder(equipmentId). The scraper
// loaded /v2/service/<uuid> in a hidden BrowserWindow and did a 3-phase DOM
// scrape (WR label fields → Work Orders tab → Toggle Comments) that took
// seconds per unit and broke on any AAP UI change. But the serviceaggregate
// JSON (GET /api/v1/serviceaggregates/{id}) carries ALL of it as structured
// fields (confirmed live 2026-10-19): workRequest{ vendor, state/subState,
// isUrgent, damageDescription, title, alternateUniqueId, needByDateTime,
// createdBy, suggestedItem[L1/L2/L3], reportedLocation }, vendorWorkOrderIds[],
// and the full comment thread (workRequest.comments[] + workOrders[].comments[])
// from which the mapper already extracts fullConversation + the offsite URL.
//
// This returns the SAME object shape scrapeWorkOrder produced, so wo:scrape can
// prefer it with the DOM scraper as fallback. The only fields the API cannot
// provide are the vendor-PDF doc-scan cause/correction/cost for
// Kooner/Cummins/Cox (Phase-4 Documents tab) and the Salesforce deep link —
// those stay scraper-only edge cases; the API covers the core for every unit.
async function getWorkOrderDetailViaApi(equipmentId) {
  const mapper = require('./aap_api_mapper');
  const u = String(equipmentId || '').trim();
  if (!u) return { error: 'no equipmentId', equipmentId: '' };

  // Resolve the unit's current open WO (two-tier widen, same as findOpenWO).
  let wo = null;
  try {
    let r1 = await searchServices({ equipmentIds: [u.toUpperCase()], statuses: [], page: 1 });
    let list = (r1 && r1.serviceAggregates) || [];
    if (!list.length) {
      const r2 = await searchServices({ equipmentIds: [u.toUpperCase()], statuses: [], category: null, lifecycleStates: null, assetPrograms: null, fleetIds: null, page: 1 });
      list = (r2 && r2.serviceAggregates) || [];
    }
    const ts = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
    const isOpen = (w) => { const done = w && (w.completedDateTime || w.completedDate); return !done && !/complet|closed|cancel/i.test(_woStatusStr(w)); };
    const open = list.filter(isOpen).sort((a, b) => ts(b) - ts(a));
    wo = open[0] || list.slice().sort((a, b) => ts(b) - ts(a))[0] || null;
  } catch (e) {
    return { error: 'WO search failed: ' + e.message, equipmentId: u };
  }
  if (!wo) return { noWO: true, equipmentId: u, scrapedAt: new Date().toISOString() };

  const serviceId = wo.id || wo.workRequestId;

  // Full service detail (comments + estimates + nested workRequest).
  let detail = null;
  try { detail = await getService(serviceId); } catch (_) { /* best-effort */ }

  const wr = (detail && detail.workRequest) || {};
  const loc = wr.reportedLocation || {};
  const si = Array.isArray(wr.suggestedItem) && wr.suggestedItem[0] ? wr.suggestedItem[0] : {};
  const ms = (t) => (t ? new Date(Number(t)).toISOString() : '');

  // Full conversation + offsite URL via the proven mapper helpers.
  let fullConversation = '';
  let offsite = null;
  try {
    const row = mapper.toFleetRow(wo, { asset: { displayName: u, aaid: wo.aaid } }, detail);
    fullConversation = row.fullConversation || '';
  } catch (_) { /* leave blank */ }
  try { offsite = mapper.extractOffsiteFromComments(detail); } catch (_) {}

  // Vendor WO + cost from the vendor work order(s) / line items when present.
  const woArr = (detail && detail.workOrders) || [];
  const firstWO = woArr[0] || {};
  const vendorWorkOrderId = (Array.isArray(detail && detail.vendorWorkOrderIds) && detail.vendorWorkOrderIds[0])
    || (Array.isArray(wo.vendorWorkOrderIds) && wo.vendorWorkOrderIds[0]) || firstWO.vendorWorkOrderId || '';
  const lineItems = (detail && detail.workOrderLineItems) || firstWO.lineItems || [];
  const totalCost = firstWO.totalCost || firstWO.cost ||
    (Array.isArray(lineItems) && lineItems.reduce((s, li) => s + (Number(li && (li.cost || li.amount)) || 0), 0)) || '';

  let offsiteUrl = offsite ? offsite.url : '';
  if (!offsiteUrl && wr.caseNumber) offsiteUrl = 'https://aap-na.corp.amazon.com/v2/offsite-events/' + String(wr.caseNumber).trim();

  return {
    // identity
    equipmentId:         wr.assetDisplayName || detail && detail.assetDisplayName || u,
    workRequestId:       wr.id || serviceId || '',
    serviceUrl:          'https://aap-na.corp.amazon.com/v2/service/' + serviceId,
    _serviceUUID:        serviceId,
    // WR fields
    vendor:              wr.vendor || wo.vendor || (detail && detail.vendor) || '',
    serviceState:        wr.state || (detail && detail.state) || '',
    subState:            wr.subState || (detail && detail.subState) || '',
    category:            (detail && detail.category) || si.level1 || '',
    urgent:              (wr.isUrgent != null ? wr.isUrgent : (detail && detail.isUrgent)) ? 'Urgent' : '',
    needBy:              ms(wr.needByDateTime),
    created:            ms(wr.createdDateTime),
    completed:           ms(wr.completedDateTime),
    createdBy:           wr.createdBy || '',
    lifecycleState:      (detail && detail.lifecycleState) || wo.lifecycleState || '',
    lifecycleReason:     (detail && detail.lifecycleStateReason) || wo.lifecycleStateReason || '',
    issueDetails:        wr.damageDescription || wr.title || '',
    // category tree (L1/L2/L3)
    level1:              si.level1 || '',
    level2:              si.level2 || '',
    level3:              si.level3 || '',
    // alt id
    altId:               wr.alternateUniqueId || '',
    alternativeId:       wr.alternateUniqueId || '',
    // vendor work order
    vendorWorkOrderId:   vendorWorkOrderId || '',
    cause:               firstWO.cause || '',
    correction:          firstWO.correction || '',
    totalCost:           totalCost || '',
    // offsite
    offsiteShopEvent:    (offsite && offsite.caseNumber) || wr.caseNumber || '',
    offsiteShopEventUrl: offsiteUrl || '',
    // full conversation
    fullConversation:    fullConversation,
    source:              'aap-api',
    scrapedAt:           new Date().toISOString(),
  };
}

// ── Work-order creation (VRE recommendation API) ─────────────────────────────
// Creates an UNPLANNED / ACTIVE work order via the same endpoint the AAP web
// app uses when you build a WR by hand:
//
//   PUT /api/v1/vre/recommendation/UNPLANNED/ACTIVE
//
// Two-phase flow (mirrors the web app exactly):
//   Phase 1 — PUT the body with vendor:"UNASSIGNED". VRE returns a vendor
//             recommendation (recommendation.vendors[].vendor, ruleName,
//             autoAssignable). Nothing is committed yet.
//   Phase 2 — PUT the SAME body again with vendor set to the confirmed code
//             (the recommended one, or an operator override). This commits
//             the work order.
//
// The caller (WR wizard Submit) can stop after Phase 1 to let the operator
// confirm/override the vendor, then call again with confirmVendor set.

const CREATE_WO_PATH = '/api/v1/vre/recommendation/UNPLANNED/ACTIVE';
// REAL work-request creation endpoints (captured live 2026-10-19 from the AAP
// wizard's Create/Submit flow). The /vre/recommendation PUT above ONLY
// recommends; the WR is actually created by POST /createRepair (which returns
// the workRequestId), then the contact is attached via POST
// /createDriverConnection. This is the clean API path the wizard itself uses.
const CREATE_REPAIR_PATH = '/api/v1/createRepair';
const CREATE_DRIVER_CONNECTION_PATH = '/api/v1/createDriverConnection';

// Default urgency-reason mapping from the wizard's human label → API enum.
function _mapUrgencyReason(label) {
  const t = String(label || '').toLowerCase();
  if (/shortage|dea/.test(t))              return 'DEA_ASSET_SHORTAGE';
  if (/safety/.test(t))                    return 'SAFETY';
  if (/regulat|complian/.test(t))          return 'REGULATORY';
  return 'OTHER';
}

// Vendor display string → API vendor CODE. 'Volvo (ASIST)' → 'VOLVO',
// 'TA' → 'TA'. Empty/falsy → 'UNASSIGNED' (Phase-1 sentinel).
function _vendorCode(vendorName) {
  const raw = String(vendorName || '').trim();
  if (!raw) return 'UNASSIGNED';
  return raw.split(' (')[0].trim().toUpperCase();
}

// Pull the aaid out of a /v2/asset/<aaid> URL, or pass through a bare id.
function _aaidFromUrl(assetUrl) {
  const u = String(assetUrl || '');
  if (!u) return '';
  if (u.includes('/v2/asset/')) {
    return u.split('/v2/asset/')[1].split('?')[0].split('/')[0];
  }
  return u; // already a bare aaid
}

// Best-effort current location for the WO body. Prefers the asset's live GPS
// (latestLocation.geoPoint); falls back to a known domicile coordinate, then to
// a zeroed coordinate so the request still forms. Street/city are not available
// from the asset API — we leave them blank unless the caller supplies off-site
// address fields.
function _buildLocation(assetFull, opts) {
  const loc = {
    latitude: null, longitude: null,
    // Wizard sends full country name + a real IANA timeZone. Default to US East
    // (most of the fleet) when we can't reverse-geocode; VRE reads COUNTRY/STATE
    // rule attributes from these.
    street: '', city: '', subRegion: '', country: 'United States', postalCode: '',
    timeZone: 'America/New_York',
  };
  // Off-site address typed in the wizard wins (unit is away from its yard).
  if (opts && opts.offSite) {
    loc.street     = opts.locStreet || '';
    loc.city       = opts.locCity   || '';
    loc.subRegion  = opts.locState  || '';
    loc.postalCode = opts.locZip    || '';
  }
  // Prefer the live location-latest payload (same source the wizard uses). It
  // carries geoPoint + a reverse-geocoded address + timeZone.
  const llRaw = opts && opts.locationLatest;
  const ll = llRaw && (llRaw.location || llRaw.geoPoint || llRaw);
  if (ll) {
    const lat = ll.latitude != null ? ll.latitude : ll.lat;
    const lng = ll.longitude != null ? ll.longitude : (ll.lng != null ? ll.lng : ll.lon);
    if (lat != null) loc.latitude = lat;
    if (lng != null) loc.longitude = lng;
    if (!opts.offSite) {
      if (ll.street)     loc.street = ll.street;
      if (ll.city)       loc.city = ll.city;
      if (ll.subRegion || ll.state) loc.subRegion = ll.subRegion || ll.state;
      if (ll.postalCode || ll.zip)  loc.postalCode = ll.postalCode || ll.zip;
      if (ll.country)    loc.country = ll.country;
      if (ll.timeZone)   loc.timeZone = ll.timeZone;
    }
  }
  // Asset's own latestLocation.geoPoint as a secondary source.
  if (loc.latitude == null) {
    const gp = assetFull && assetFull.latestLocation && assetFull.latestLocation.geoPoint;
    if (gp && (gp.latitude != null || gp.lat != null)) {
      loc.latitude  = gp.latitude  != null ? gp.latitude  : gp.lat;
      loc.longitude = gp.longitude != null ? gp.longitude : gp.lng;
    }
  }
  // Domicile fallback coords if GPS still missing.
  if (loc.latitude == null && opts && opts.domicile) {
    let DOM = null;
    try { DOM = require('./aap_create_wr').DOMICILE_COORDS; } catch (_) {}
    const d = DOM && (DOM[opts.domicile] || DOM[String(opts.domicile).toUpperCase()]);
    if (d) { loc.latitude = d.latitude; loc.longitude = d.longitude; }
  }
  // VRE rejects null coordinates. As a last resort send 0,0 (the request still
  // forms; geofence rules simply won't match, which is acceptable for Phase 1).
  if (loc.latitude == null) loc.latitude = 0;
  if (loc.longitude == null) loc.longitude = 0;
  return loc;
}

// ── LIVE GEOFENCE (API-first) ────────────────────────────────────────────────
// API replacement for geofence_scraper.js. The DOM scraper loaded the Fleet
// Monitoring page, waited 8s for the React table, scrolled virtualized rows and
// scraped { equipmentId, geofence, latLong }. But the v2 asset search already
// returns geoFences + geoPoint for EVERY unit in a single bulk call (the same
// BULK_FIELDS the fleet grid uses). So this gets the live geofence + GPS for the
// whole fleet via JSON — no browser, no 8s wait, no virtualized-scroll hacks —
// and writes the SAME cache shape the scraper did, so every consumer is unchanged.
//
// Returns { ok, count, units: [{ equipmentId, geofence, latLong }] }.
function _firstGeofenceName(g) {
  if (Array.isArray(g) && g.length) {
    const g0 = g[0];
    return (g0 && (g0.name || g0.geofenceName)) || (typeof g0 === 'string' ? g0 : '') || '';
  }
  return '';
}
function _latLongStr(geoPoint) {
  if (!geoPoint) return '';
  const lat = geoPoint.latitude != null ? geoPoint.latitude : geoPoint.lat;
  const lng = geoPoint.longitude != null ? geoPoint.longitude : (geoPoint.lng != null ? geoPoint.lng : geoPoint.lon);
  if (lat == null || lng == null) return '';
  const n = (v) => (typeof v === 'number' ? v.toFixed(6) : String(v));
  return n(lat) + ', ' + n(lng);
}

async function getFleetGeofencesViaApi(opts = {}) {
  // Same domicile filter resolution the fleet build uses.
  let filters = opts.domiciles;
  if (!filters) {
    try {
      const store = require('../store');
      const s = store.load('settings', {});
      filters = (s.domiciles && s.domiciles.length) ? s.domiciles
        : require('../config/defaults').DEFAULT_DOMICILES;
    } catch (_) { filters = []; }
  }
  const filterVals = (filters || []).map((d) => String(d).trim().toUpperCase());
  // IMPORTANT: 'assetType' MUST be in fieldsToReturn. The v2 asset search 500s
  // ("Cannot invoke String.equals ... assetType is null") when assetType is
  // filtered on but NOT requested back — confirmed live 2026-10-19 (identical
  // fieldFilters returned 150 assets WITH assetType in fieldsToReturn, but 500
  // without it).
  const FIELDS = ['assetType', 'displayName', 'lifecycleState', 'geoFences',
    'yardBuildingID', 'latestLocationTimestamp', 'geoPoint'];

  // The v2 asset search REQUIRES an assetType fieldFilter (a missing/null
  // assetType returns HTTP 500 "Cannot invoke String.equals ... assetType is
  // null"). DEFAULT_ASSET_SEARCH_REQUEST carries that filter, but our per-call
  // fieldFilters shallow-overwrite it — so we must MERGE our domicile/operator
  // filter WITH the base assetType filter, not replace it.
  let baseAssetTypeFilter = [{ key: 'assetType', values: ['tractor', 'boxTruck'] }];
  try {
    const base = require('./aap_longdwell').DEFAULT_ASSET_SEARCH_REQUEST;
    if (base && Array.isArray(base.fieldFilters)) {
      const at = base.fieldFilters.filter((f) => f && f.key === 'assetType');
      if (at.length) baseAssetTypeFilter = at;
    }
  } catch (_) { /* fall back to the hardcoded assetType filter above */ }

  const byEquip = new Map();    // equipmentId -> { equipmentId, geofence, latLong }
  // Union of domicileSite- and operator-matched assets (same scope as the grid).
  for (const key of ['domicileSite', 'operator']) {
    for (let page = 0; page < (opts.maxPages || 60); page++) {
      let res;
      try {
        const fieldFilters = baseAssetTypeFilter.concat(
          filterVals.length ? [{ key, values: filterVals }] : []
        );
        res = await searchAssets({
          from: page * 150,
          fieldFilters,
          fieldsToReturn: FIELDS,
        });
      } catch (e) {
        logger.warn('[geofence-api] asset search failed (' + key + ' p' + page + '): ' + e.message);
        break;
      }
      const list = (res && res.assets) || [];
      if (!list.length) break;
      for (const a of list) {
        const asset = (a && a.asset) || {};
        const equipmentId = asset.displayName || asset.equipmentId || '';
        if (!equipmentId) continue;
        const ll = a.latestLocation || asset.latestLocation || {};
        const geofence = _firstGeofenceName(ll.geoFences) || _firstGeofenceName(asset.geoFences)
          || _firstGeofenceName(a.geoFences) || ll.geofenceName || ll.yardBuildingID
          || asset.yardBuildingID || '';
        const latLong = _latLongStr(ll.geoPoint || asset.geoPoint || a.geoPoint);
        // Keep the first (or upgrade if we later find coordinates for a unit that had none).
        const prev = byEquip.get(equipmentId);
        if (!prev) byEquip.set(equipmentId, { equipmentId, geofence, latLong });
        else {
          if (!prev.geofence && geofence) prev.geofence = geofence;
          if (!prev.latLong && latLong) prev.latLong = latLong;
        }
      }
    }
  }
  const units = Array.from(byEquip.values());
  logger.info('[geofence-api] resolved ' + units.length + ' units (geofence + GPS) via JSON API — no browser');
  return { ok: true, count: units.length, units, source: 'aap-api' };
}

// Build the CREATE_WORK_ORDER_BODY from a wizard payload + resolved asset.
// vendorCode is 'UNASSIGNED' for Phase 1 or the confirmed code for Phase 2.
function _buildWoBody(opts, assetFull, vendorCode) {
  const now = Date.now();
  // Match the wizard: whole-second ISO (no millis), needBy = now + 4h.
  const nowIso   = new Date(Math.floor(now / 1000) * 1000).toISOString();
  const needByIso = new Date(Math.floor(now / 1000) * 1000 + 4 * 3600 * 1000).toISOString();
  const aaid = opts.aaid || _aaidFromUrl(opts.assetUrl);

  // areaPairs values are now AAP AVM CODES (L1/L2/L3) from the WR modal's live
  // cascading dropdowns — level1=area, level2=subcategory, level3=subSubcategory
  // (L3 is '' for the common case; only categories like Tires carry an L3).
  // TOW is a passthrough (not an avmCode) and still flows straight through as
  // level1='TOW', level2=<tow reason>.
  const suggestedItems = (opts.areaPairs || [])
    .filter(p => p && (p.area || p.subcategory))
    .map(p => ({ level1: p.area || '', level2: p.subcategory || '', level3: p.subSubcategory || '' }));

  // AAP's CreateRepairInput.comments is a list of Comment OBJECTS, not strings
  // (confirmed by a live 500: "Cannot construct instance of Comment ... no
  // String-argument constructor ... from String value"). The service-aggregate
  // GET shows the Comment shape as { timestamp, text, createdBy, internalOnly }.
  // Build that shape. `shareWith:'internal'` -> internalOnly true.
  // createdBy is REQUIRED non-null on each Comment (confirmed by a live 400:
  // "comments.N.member.createdBy ... must not be null"). Use the contact name,
  // then the operator alias, then a safe default — never null.
  const _commentAuthor = String(opts.createdBy || opts.contactName || opts.operatorAlias || 'Fleet Ops Center').trim() || 'Fleet Ops Center';
  const comments = [];
  if (opts.comments && String(opts.comments).trim()) {
    comments.push({
      text: String(opts.comments).trim(),
      internalOnly: String(opts.shareWith || '').toLowerCase() === 'internal',
      createdBy: _commentAuthor,
      timestamp: nowIso,
    });
  }

  const urgent = String(opts.urgent || '').toLowerCase() === 'yes';
  // callType enum (confirmed live): [OFFSITE, ROADSIDE, YARD]. 'ONSITE' is NOT
  // valid. NOTE: the real AAP wizard sends the field LOWERCASE as `calltype`
  // (the 400 validator echoes it as `callType`, but the accepted request body
  // from the live wizard capture uses `calltype`). A unit at its domicile is
  // YARD; a unit away from the yard is OFFSITE. Caller may force one.
  const _ct = String(opts.callType || opts.calltype || '').trim().toUpperCase();
  const VALID_CALLTYPES = ['OFFSITE', 'ROADSIDE', 'YARD'];
  const calltype = VALID_CALLTYPES.includes(_ct)
    ? _ct
    : (opts && opts.offSite ? 'OFFSITE' : 'YARD');

  // Body shape mirrors the real wizard's accepted /vre/recommendation request
  // EXACTLY (captured live 2026-10-18). Key fixes vs. our earlier (rejected)
  // body: field is `calltype` (lowercase); `destination` is a full zeroed
  // object (NOT null); NO `source` field; currentLocation carries real GPS +
  // full address + timeZone. suggestedItems level1/level2 are DISPLAY NAMES
  // ("Chassis", "Check Engine Light") — not avmCodes.
  return {
    aaid,
    title: String(opts.title || '').slice(0, 90),
    calltype,
    currentLocation: _buildLocation(assetFull, opts),
    destination: {
      latitude: 0, longitude: 0,
      street: '', city: '', subRegion: '', country: '', postalCode: '',
    },
    urgent,
    urgencyReason: urgent ? _mapUrgencyReason(opts.urgencyReason) : null,
    tireIssue: suggestedItems.some(s => /tire/i.test(s.level1)) || false,
    assetLoaded: false,
    assetRefrigerated: false,
    arcClaimNumber: opts.arcClaim || null,
    simNumber: opts.simNumber || null,
    assetAvailableDateTime: nowIso,
    needByDateTime: needByIso,
    // damageDescription is NON-nullable (confirmed by a live 500). Never send
    // null: fall back to the title, then a safe generic string.
    damageDescription: (String(opts.issue || '').trim() ||
      String(opts.title || '').trim() ||
      'Repair requested via Fleet Ops Center'),
    comments,
    suggestedItems,
    vendor: vendorCode,
    // Preferred supplier (branch/location) the modal selected. supplierRequired
    // vendors (COX, Gabrielli, KWNE, Allegiance) need this; it was previously
    // hardcoded null, dropping the operator's supplier choice. Phase 1
    // (UNASSIGNED) still sends null — a recommendation has no supplier yet.
    supplierId: (vendorCode && vendorCode !== 'UNASSIGNED' && opts.supplierId) ? String(opts.supplierId) : null,
    sourceNotificationIds: null,
    source: null, // wizard sends source:null (NOT omitted, NOT a string)
    severity: urgent ? 'HIGH' : 'LOW',
    relatedAsset: null,
  };
}

// Read the recommended vendor from a VRE recommendation response.
function _readRecommendation(resp) {
  const rec = resp && resp.recommendation;
  const vendors = (rec && Array.isArray(rec.vendors)) ? rec.vendors : [];
  const top = vendors[0] || null;
  return {
    vendor: top ? (top.vendor || '') : '',
    ruleName: rec ? (rec.ruleName || '') : '',
    autoAssignable: rec ? !!rec.autoAssignable : false,
    vendors: vendors.map(v => v && v.vendor).filter(Boolean),
    raw: rec || null,
  };
}

/**
 * createWorkOrder(opts) — build + submit an UNPLANNED/ACTIVE work order.
 *
 * opts (from the WR wizard payload, plus a few resolved fields):
 *   assetUrl | aaid        the unit's /v2/asset/<aaid> URL, or bare aaid
 *   title, issue, comments
 *   areaPairs[]            [{ area, subcategory }] → suggestedItems
 *   urgent ('Yes'/'No'), urgencyReason
 *   arcClaim, simNumber
 *   domicile               site code for coord fallback
 *   offSite, locStreet/City/State/Zip   off-site address (unit away from yard)
 *   vendor                 operator's chosen vendor DISPLAY string (optional)
 *   confirmVendor          when true, run Phase 2 (commit) with `vendor`.
 *                          when false/omitted, run Phase 1 only and return the
 *                          recommendation for operator confirmation.
 *
 * Returns:
 *   Phase 1 (recommend):  { ok, phase:'recommend', recommendation:{vendor,ruleName,autoAssignable,vendors[]} }
 *   Phase 2 (commit):     { ok, phase:'commit', vendor, autoAssignable, workRequestId, raw }
 */
async function createWorkOrder(opts = {}) {
  const aaid = opts.aaid || _aaidFromUrl(opts.assetUrl);
  if (!aaid) {
    throw Object.assign(new Error('createWorkOrder: no aaid (need assetUrl or aaid)'), { code: 'NO_AAID' });
  }

  // Resolve the asset once for location + VIN context (best-effort).
  let assetFull = null;
  try { assetFull = await getAsset(aaid); } catch (e) {
    logger.warn('createWorkOrder: getAsset failed, using fallback location: ' + e.message);
  }
  // Fetch the live latest GPS location (same source the wizard uses) so the VRE
  // currentLocation carries real coordinates — VRE rejects null/zero coords.
  if (opts.locationLatest == null) {
    try {
      const ll = await getLocationLatest(aaid);
      opts = { ...opts, locationLatest: ll };
    }
    catch (e) { logger.warn('createWorkOrder: getLocationLatest failed: ' + e.message); }
  }

  const wantCommit = !!opts.confirmVendor;

  if (!wantCommit) {
    // ── Phase 1: ask VRE for a vendor recommendation ──────────────────────
    const body = _buildWoBody({ ...opts, aaid }, assetFull, 'UNASSIGNED');
    const resp = await apiPut(CREATE_WO_PATH, body);
    const recommendation = _readRecommendation(resp);
    logger.info('createWorkOrder Phase 1 (recommend) aaid=' + aaid +
      ' vendor=' + recommendation.vendor + ' rule=' + recommendation.ruleName +
      ' autoAssignable=' + recommendation.autoAssignable);
    return { ok: true, phase: 'recommend', aaid, recommendation };
  }

  // ── Phase 2: commit with the confirmed vendor ───────────────────────────
  const vendorCode = _vendorCode(opts.vendor);

  // STEP A: get the VRE recommendation (read-only) — it carries the
  // recommendationInfo (groupingId/ruleName/ruleId/supplier) that the real
  // /createRepair body requires to link the recommendation to the created WR.
  const recoResp = await apiPut(CREATE_WO_PATH, _buildWoBody({ ...opts, aaid }, assetFull, 'UNASSIGNED'));
  const recommendation = _readRecommendation(recoResp);

  // STEP B: build + POST the REAL create body to /createRepair, with a bounded
  // SELF-HEALING loop: if AAP rejects a specific field (its 400s name the field
  // path, e.g. "comments.1.member.createdBy must not be null"), apply a
  // deterministic correction and retry. If it still can't be fixed, return a
  // PRECISE diagnosis of where it got stuck — never a generic "failed".
  const createBody = _buildCreateRepairBody({ ...opts, aaid }, assetFull, vendorCode, recoResp);
  const healed = await _postCreateRepairWithHealing(createBody, { aaid, vendorCode });
  if (!healed.ok) {
    logger.warn('createWorkOrder: /createRepair could not be healed — stuck at field "' + (healed.stuckField || '?') + '"');
    return {
      ok: false, phase: 'create-failed', aaid, vendor: vendorCode, recommendation,
      stuckField: healed.stuckField || null,
      corrections: healed.corrections || [],
      error: healed.error || 'AAP /createRepair failed and could not self-correct.',
      aapMessage: healed.aapMessage || null,
      raw: healed.raw || null,
    };
  }
  const resp = healed.resp;
  const workRequestId =
    (resp && (resp.workRequestId || resp.workOrderId || resp.id ||
      (resp.workOrder && resp.workOrder.id))) || '';
  logger.info('createWorkOrder Phase 2 (createRepair) aaid=' + aaid +
    ' vendor=' + vendorCode + ' workRequestId=' + workRequestId +
    (healed.corrections && healed.corrections.length ? ' (self-corrected: ' + healed.corrections.join('; ') + ')' : ''));

  // HONESTY GUARD: no workRequestId back = the WR was NOT created. Never claim
  // success. (Should not happen now that we POST /createRepair, but keep the
  // guard so a future AAP change can't silently fake a success.)
  if (!workRequestId) {
    logger.warn('createWorkOrder: /createRepair returned no workRequestId — WR NOT created.');
    return {
      ok: false, phase: 'create-failed', aaid, vendor: vendorCode, recommendation,
      error: 'AAP /createRepair returned no work-request id — the WR was NOT created.',
      raw: resp || null,
    };
  }

  // STEP C: attach the contact/driver (separate call the wizard makes). Contact
  // is optional — a missing contact never fails the WR (it already exists).
  let driverConnection = null;
  const _contactName = String(opts.contactName || '').trim();
  const _contactPhone = String(opts.contactPhone || '').trim();
  if (_contactName || _contactPhone) {
    try {
      driverConnection = await apiPost(CREATE_DRIVER_CONNECTION_PATH, {
        workRequestId,
        driverName: _contactName || null,
        driverPhoneNumber: _contactPhone || null,
        aaid,
      });
      logger.info('createWorkOrder: attached contact to WR ' + workRequestId);
    } catch (e) {
      logger.warn('createWorkOrder: createDriverConnection failed (non-fatal, WR exists): ' + e.message);
      driverConnection = { ok: false, error: e.message };
    }
  }

  // STEP D: upload attachments to the just-created WR (best-effort).
  let attachmentResults = null;
  if (workRequestId && Array.isArray(opts.attachments) && opts.attachments.length) {
    try {
      attachmentResults = await uploadWrAttachments(workRequestId, opts.attachments, { vendor: vendorCode });
    } catch (e) {
      logger.warn('createWorkOrder: attachment upload batch failed: ' + e.message);
      attachmentResults = [{ ok: false, error: e.message }];
    }
  }

  return {
    ok: true,
    phase: 'commit',
    aaid,
    vendor: vendorCode,
    autoAssignable: recommendation.autoAssignable,
    workRequestId,
    suggestedItemIds: (resp && resp.suggestedItemIds) || [],
    driverConnection,
    attachments: attachmentResults,
    raw: resp || null,
  };
}

// ── SELF-HEALING /createRepair ──────────────────────────────────────────────
// Posts the create body and, when AAP rejects a SPECIFIC field (its 400/500
// validation errors name the offending JSON path), applies a deterministic
// correction and retries — bounded. If it still fails, returns a precise
// diagnosis of WHERE it got stuck (field + AAP message + what it tried) so the
// caller/operator sees exactly what to fix instead of a generic error.
//
// Returns { ok:true, resp, corrections[] } or
//         { ok:false, stuckField, aapMessage, corrections[], error, raw }.
const _CREATE_HEAL_MAX = 4;
async function _postCreateRepairWithHealing(body, ctx) {
  ctx = ctx || {};
  let current = body;
  const corrections = [];
  let lastErr = null;
  for (let attempt = 0; attempt <= _CREATE_HEAL_MAX; attempt++) {
    try {
      const resp = await apiPost(CREATE_REPAIR_PATH, current);
      return { ok: true, resp, corrections };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      // Only self-heal AAP validation errors (4xx with a field detail). A
      // 401/403 session error or a network error is NOT a body problem — stop.
      if (e && e.code === 'MIDWAY_SESSION_INVALID') {
        return { ok: false, stuckField: null, aapMessage: msg, corrections, error: 'AAP session rejected — re-auth needed (not a body fix).' };
      }
      const field = _parseAapErrorField(msg);
      logger.warn('[create-heal] attempt ' + attempt + ' failed; AAP field="' + (field || '?') + '" msg=' + msg.slice(0, 180));
      if (!field || attempt >= _CREATE_HEAL_MAX) {
        return {
          ok: false,
          stuckField: field || null,
          aapMessage: msg.slice(0, 600),
          corrections,
          error: field
            ? ('Stuck at /createRepair field "' + field + '" — AAP rejected it and no deterministic fix is known after ' + corrections.length + ' correction(s).')
            : ('Stuck at /createRepair — AAP error could not be mapped to a field: ' + msg.slice(0, 200)),
          raw: (e && e.raw) || null,
        };
      }
      const fix = _correctCreateRepairField(current, field, msg);
      if (!fix.changed) {
        // We recognized the field but have no correction for this case — stop
        // with a precise diagnosis rather than loop pointlessly.
        return {
          ok: false, stuckField: field, aapMessage: msg.slice(0, 600), corrections,
          error: 'Stuck at /createRepair field "' + field + '" — recognized but no self-correction available.',
        };
      }
      current = fix.body;
      corrections.push(fix.note);
      logger.info('[create-heal] applied correction: ' + fix.note + ' — retrying');
    }
  }
  return { ok: false, stuckField: null, aapMessage: String((lastErr && lastErr.message) || ''), corrections, error: 'exhausted create-repair retries' };
}

// Parse the offending JSON field path out of an AAP validation error message.
// Handles both styles seen live:
//   Jackson: 'reference chain: ...CreateRepairInput["comments"]->ArrayList[0]'
//            and '...for JSON property damageDescription ...'
//   AWS val: "Value null at 'workRequestInput.comments.1.member.createdBy' ..."
function _parseAapErrorField(msg) {
  if (!msg) return null;
  // AWS-style: at 'workRequestInput.<path>'
  let m = msg.match(/at '([^']+)'/);
  if (m) {
    // Normalize workRequestInput.comments.1.member.createdBy -> comments.createdBy
    return m[1].replace(/^workRequestInput\./, '').replace(/\.\d+\.member/g, '').replace(/\.\d+/g, '');
  }
  // Jackson "for JSON property X"
  m = msg.match(/JSON property ["']?([A-Za-z0-9_]+)["']?/);
  if (m) return m[1];
  // Jackson reference chain: ...model.X["field"]->...["sub"]
  const chain = [...msg.matchAll(/\["([A-Za-z0-9_]+)"\]/g)].map((x) => x[1]);
  if (chain.length) return chain.join('.');
  return null;
}

// Apply a DETERMINISTIC correction for a known-bad field. Returns
// { changed, body, note }. Only known, safe fixes — never invents values that
// change the WR's meaning (e.g. it won't fabricate a vendor); it fills
// required-but-empty structural fields with safe defaults the wizard uses.
function _correctCreateRepairField(body, field, msg) {
  const b = JSON.parse(JSON.stringify(body || {}));
  const nullish = /must not be null|non-nullable|missing \(therefore NULL\)|may not be (null|empty)|Cannot construct/i.test(msg);
  const f = String(field || '');
  // comments.* — each Comment needs non-null text/createdBy/timestamp/externalConsumers
  if (/^comments(\.|$)/.test(f)) {
    b.comments = (Array.isArray(b.comments) ? b.comments : []).map((c) => ({
      text: (c && c.text) || '(no comment provided)',
      internalOnly: !!(c && c.internalOnly),
      externalConsumers: Array.isArray(c && c.externalConsumers) ? c.externalConsumers : [],
      timestamp: (c && c.timestamp) || new Date().toISOString(),
      createdBy: (c && String(c.createdBy || '').trim()) || 'Fleet Ops Center',
    }));
    return { changed: true, body: b, note: 'normalized comments[] (text/createdBy/timestamp/externalConsumers non-null)' };
  }
  if (/damageDescription/i.test(f) && nullish) {
    b.damageDescription = String(b.damageDescription || b.title || 'Repair requested via Fleet Ops Center').trim() || 'Repair requested via Fleet Ops Center';
    return { changed: true, body: b, note: 'set non-null damageDescription' };
  }
  if (/^suggestedItems/i.test(f)) {
    b.suggestedItems = (Array.isArray(b.suggestedItems) ? b.suggestedItems : []).filter((s) => s && s.level1).map((s) => ({ level1: s.level1 || '', level2: s.level2 || '', level3: s.level3 || '' }));
    if (!b.suggestedItems.length) return { changed: false, body: b, note: '' };
    return { changed: true, body: b, note: 'normalized suggestedItems[]' };
  }
  if (/recommendationInfo/i.test(f) && nullish) {
    b.recommendationInfo = b.recommendationInfo || {};
    for (const k of ['vendor', 'ruleName', 'groupingId', 'ruleId']) if (b.recommendationInfo[k] === undefined) b.recommendationInfo[k] = null;
    if (b.recommendationInfo.recommendationOverridden === undefined) b.recommendationInfo.recommendationOverridden = false;
    return { changed: true, body: b, note: 'filled recommendationInfo required keys' };
  }
  if (/supplierId/i.test(f) && nullish) {
    // supplierId required but null: can't invent a branch — only fixable if the
    // recommendation gave one. Leave for diagnosis (handled by caller).
    return { changed: false, body: b, note: '' };
  }
  if (/urgencyReason/i.test(f) && nullish) {
    // urgent true but reason null -> a safe default; if not urgent, null is fine.
    if (b.urgent) { b.urgencyReason = b.urgencyReason || 'DEA_ASSET_SHORTAGE'; return { changed: true, body: b, note: 'set default urgencyReason (urgent)' }; }
    return { changed: false, body: b, note: '' };
  }
  if ((/currentLocation/i.test(f)) && nullish) {
    b.currentLocation = b.currentLocation || {};
    if (b.currentLocation.latitude == null) b.currentLocation.latitude = 0;
    if (b.currentLocation.longitude == null) b.currentLocation.longitude = 0;
    if (!b.currentLocation.country) b.currentLocation.country = 'United States';
    if (!b.currentLocation.timeZone) b.currentLocation.timeZone = 'America/New_York';
    return { changed: true, body: b, note: 'filled currentLocation required coords/country/timeZone' };
  }
  // Generic: a top-level scalar required-but-null we can safely blank-fill.
  if (nullish && /^[A-Za-z0-9_]+$/.test(f) && (f in b) && b[f] == null) {
    b[f] = (f.toLowerCase().includes('date') ? new Date().toISOString() : '');
    return { changed: true, body: b, note: 'set non-null default for ' + f };
  }
  return { changed: false, body: b, note: '' };
}

// Build the REAL /createRepair request body (captured live from the AAP wizard
// 2026-10-19). It extends the recommendation body with: comments carrying
// externalConsumers[], the chosen vendor+supplierId, and a recommendationInfo
// block (groupingId/ruleName/ruleId/supplier) copied from the VRE response so
// AAP links the created WR to its recommendation. recoResp is the raw VRE
// recommendation response (for recommendationInfo); may be null.
function _buildCreateRepairBody(opts, assetFull, vendorCode, recoResp) {
  const base = _buildWoBody(opts, assetFull, vendorCode);
  // Enrich currentLocation with the yard/geofence fields the wizard's
  // /createRepair body carries (geofenceName/code/type + yardLocation +
  // deviceTelemetryData). Best-effort from locationLatest/asset; the base
  // lat/long/address stay as-is. Missing geofence fields are sent as the
  // wizard does (nulls), which AAP accepts.
  const currentLocation = Object.assign({}, base.currentLocation);
  try {
    const llRaw = opts && opts.locationLatest;
    const ll = (llRaw && (llRaw.location || llRaw)) || {};
    const gfArr = (ll.geoFences || (assetFull && assetFull.geoFences)) || [];
    const gf = Array.isArray(gfArr) && gfArr.length ? gfArr[0] : null;
    currentLocation.yardLocation = ll.yardLocation || (assetFull && assetFull.yardLocation) || null;
    currentLocation.yardLocationType = ll.yardLocationType || null;
    currentLocation.geofenceName = (gf && (gf.name || gf.geofenceName)) || null;
    currentLocation.code = (gf && gf.code) || opts.domicile || null;
    currentLocation.type = (gf && gf.type) || 'AMAZON_FACILITY';
    currentLocation.deviceTelemetryData = { engineHours: null, odometer: null };
  } catch (_) { /* keep the base location */ }
  // comments need externalConsumers:[] (the wizard always sends it).
  const comments = (base.comments || []).map((c) => ({
    text: c.text,
    internalOnly: c.internalOnly,
    externalConsumers: [],
    timestamp: c.timestamp,
    createdBy: c.createdBy,
  }));
  // recommendationInfo: pull the matching recommended vendor entry from the VRE
  // response so groupingId/ruleName/ruleId/supplier are consistent. Falls back
  // to nulls if the recommendation wasn't available.
  const rec = (recoResp && recoResp.recommendation) || {};
  const vendorsArr = Array.isArray(rec.vendors) ? rec.vendors : [];
  const chosen = vendorsArr.find((v) => _vendorCode(v.vendor) === vendorCode) || vendorsArr[0] || null;
  const supplierObj = chosen && chosen.supplier;
  const recommendationInfo = {
    vendor: (chosen && chosen.vendor) || vendorCode,
    vendorOpenWRCount: (chosen && chosen.openWorkRequestCount) != null ? chosen.openWorkRequestCount : null,
    vendorDistanceToAsset: null,
    multiVendorDecisionReason: rec.multiVendorDecisionReason || null,
    supplier: supplierObj ? ((chosen.vendor || vendorCode) + '-' + (supplierObj.name || '')) : null,
    ruleName: rec.ruleName || null,
    groupingId: rec.groupingId || null,
    ruleId: rec.ruleId || null,
    recommendationOverridden: !!opts.vendorIsOverride,
    recommendationOverrideReason: opts.overrideReason || null,
  };
  const supplierId = (vendorCode && vendorCode !== 'UNASSIGNED' && opts.supplierId)
    ? String(opts.supplierId)
    : (supplierObj && supplierObj.id) || null;
  return {
    aaid: base.aaid,
    title: base.title,
    calltype: base.calltype,
    currentLocation,
    urgent: base.urgent,
    urgencyReason: base.urgencyReason,
    tireIssue: base.tireIssue,
    assetLoaded: base.assetLoaded,
    assetRefrigerated: base.assetRefrigerated,
    arcClaimNumber: base.arcClaimNumber,
    simNumber: base.simNumber,
    assetAvailableDateTime: base.assetAvailableDateTime,
    needByDateTime: base.needByDateTime,
    damageDescription: base.damageDescription,
    suggestedItems: base.suggestedItems,
    comments,
    vendor: vendorCode,
    supplierId,
    sourceNotificationIds: null,
    source: null,
    severity: base.severity,
    recommendationInfo,
    copiedFromWorkRequestId: opts.copiedFromWorkRequestId || null,
    dvirId: opts.dvirId || null,
    relatedAsset: null,
    campaign: null,
    maintenanceTypes: null,
  };
}

// ── VRE Phase-1 recommendation MATRIX (diagnostic, commits NOTHING) ─────────
// Exercises the live VRE recommendation endpoint across the full combination
// matrix a user can produce in the WR modal — urgent/non-urgent, tires, tow,
// multi-area, and (when a real L1/L2 tree is available) real avmCode display
// names — WITHOUT creating any work order (every call is Phase 1,
// vendor:'UNASSIGNED'). Returns one row per scenario with the recommended
// vendor / rule / autoAssignable (or the error), so we can confirm the whole
// matrix works in one run. opts: { assetUrl|aaid, domicile, assetType }.
async function vreRecommendMatrix(opts = {}) {
  const aaid = opts.aaid || _aaidFromUrl(opts.assetUrl);
  if (!aaid) throw Object.assign(new Error('vreRecommendMatrix: no aaid'), { code: 'NO_AAID' });

  // Scenarios use DISPLAY names for suggestedItems (confirmed correct live:
  // "Chassis", "Check Engine Light", "Tires", etc. — not avmCodes).
  const scenarios = [
    { label: 'single area, non-urgent',   areaPairs: [{ area: 'Check Engine Light', subcategory: 'CEL Engine Position' }], urgent: 'No'  },
    { label: 'single area, URGENT',       areaPairs: [{ area: 'Check Engine Light', subcategory: 'CEL Engine Position' }], urgent: 'Yes', urgencyReason: 'DEA - Asset Shortage' },
    { label: 'multi-area, non-urgent',    areaPairs: [{ area: 'Chassis', subcategory: 'Reservoir and Lines' }, { area: 'Check Engine Light', subcategory: 'CEL Engine Position' }], urgent: 'No' },
    { label: 'TIRES, non-urgent',         areaPairs: [{ area: 'Tires', subcategory: 'Steer Left' }], urgent: 'No'  },
    { label: 'TIRES, URGENT',             areaPairs: [{ area: 'Tires', subcategory: 'Steer Left' }], urgent: 'Yes', urgencyReason: 'DEA - Asset Shortage' },
    { label: 'TOW, urgent (passthrough)', areaPairs: [{ area: 'TOW', subcategory: 'MECHANICAL ISSUE' }], urgent: 'Yes', urgencyReason: 'DEA - Asset Shortage' },
    { label: 'Brakes, non-urgent',        areaPairs: [{ area: 'Brakes', subcategory: 'Air Brake Assembly' }], urgent: 'No' },
    { label: 'no area (bare rec)',        areaPairs: [], urgent: 'No' },
  ];

  logger.info('[vre-matrix] starting ' + scenarios.length + ' scenarios for ' + aaid + ' (Phase 1 only — NOTHING committed)');
  const rows = [];
  for (const s of scenarios) {
    try {
      const rec = await createWorkOrder({
        assetUrl: opts.assetUrl, aaid,
        title: 'VRE matrix: ' + s.label,
        issue: 'recommendation test — not submitted',
        areaPairs: s.areaPairs,
        urgent: s.urgent,
        urgencyReason: s.urgencyReason,
        confirmVendor: false, // Phase 1 ONLY
      });
      const r = rec && rec.recommendation;
      logger.info('[vre-matrix] ✅ ' + s.label + ' → vendor=' + (r && r.vendor) +
        ' rule=' + (r && r.ruleName) + ' autoAssignable=' + (r && r.autoAssignable));
      rows.push({ scenario: s.label, ok: true, vendor: r && r.vendor, ruleName: r && r.ruleName, autoAssignable: r && r.autoAssignable });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      logger.warn('[vre-matrix] ✗ ' + s.label + ' → ' + msg.slice(0, 300));
      rows.push({ scenario: s.label, ok: false, error: msg.slice(0, 400) });
    }
  }
  const okCount = rows.filter((r) => r.ok).length;

  // ── Override PREVIEW (read-only, commits NOTHING) ─────────────────────────
  // Shows what an OVERRIDE would do without committing: the AAP-recommended
  // vendor vs. a sample override vendor (the first wrEnabled vendor that ISN'T
  // the recommendation), and whether that override vendor requires a supplier
  // (read from the live vendor config). A real override only differs from the
  // recommendation at Phase-2 COMMIT (which creates a WR) — so this previews
  // the decision without creating anything.
  let override = null;
  try {
    const recommended = (rows.find((r) => r.ok && r.vendor) || {}).vendor || '';
    const vendors = await getVendorConfigs();
    const wrEnabled = (vendors || []).filter((v) => v && v.wrEnabled);
    const codeOf = (s) => String(s || '').split(' (')[0].trim().toLowerCase();
    const sample = wrEnabled.find((v) => codeOf(v.vendorName) !== codeOf(recommended)) || wrEnabled[0] || null;
    if (sample) {
      override = {
        recommendedVendor: recommended,
        overrideVendor: sample.vendorName,
        isOverride: codeOf(sample.vendorName) !== codeOf(recommended),
        supplierRequired: !!sample.supplierRequired,
        suppliers: Array.isArray(sample.suppliers) ? sample.suppliers : [],
        note: 'Override would COMMIT a WR with this vendor (Phase 2). Not executed here.',
      };
      logger.info('[vre-matrix] OVERRIDE PREVIEW: recommended=' + recommended +
        ' → override=' + sample.vendorName + ' (isOverride=' + override.isOverride +
        ', supplierRequired=' + override.supplierRequired + ', suppliers=' + override.suppliers.length + ')');
    }
  } catch (e) {
    logger.warn('[vre-matrix] override preview failed: ' + e.message);
  }

  logger.info('[vre-matrix] DONE ' + okCount + '/' + rows.length + ' scenarios OK\n' + JSON.stringify(rows, null, 2));
  return { ok: okCount > 0, aaid, okCount, total: rows.length, rows, override };
}

// ── WR document upload (attachments) ────────────────────────────────────────
// Reconstructed from the live AAP bundle (FileUploadPreview + doc client). The
// real 3-step flow:
//   1. POST /api/v1/doc/uploadLink  { serviceEntityIdCategory, serviceEntityId,
//        documentType, vendor, filename, fileType, maintenanceType, workState }
//      → returns { uploadLink, documentId, ... } (uploadLink = presigned S3 URL)
//   2. PUT <uploadLink>  <raw file bytes>  header Content-Type: <mime>
//   3. POST /api/v1/doc/associateDocument  { ... }  (links doc → work request)
// fileType is the extension UPPERCASED (file.type.split('/').pop().toUpperCase()
// e.g. image/png → PNG). Enum defaults (documentType/serviceEntityIdCategory/
// maintenanceType/workState) are best-effort from the bundle and logged on the
// first live run so we can lock them to reality.
const DOC_UPLOAD_LINK_PATH = '/api/v1/doc/uploadLink';
const DOC_ASSOCIATE_PATH   = '/api/v1/doc/associateDocument';

// Derive AAP's fileType token from a mime or filename. image/png → 'PNG'.
function _fileTypeToken(mimeOrName) {
  const s = String(mimeOrName || '');
  let ext = '';
  if (s.includes('/')) ext = s.split('/').pop();          // mime: image/png → png
  else if (s.includes('.')) ext = s.split('.').pop();     // name: foo.png  → png
  ext = ext.split(';')[0].trim();
  if (/jpe?g/i.test(ext)) return 'JPG';
  return ext.toUpperCase() || 'PNG';
}

// Step 1: ask AAP for a presigned upload link for one file.
// opts: { serviceEntityId (WR id, required), serviceEntityIdCategory, documentType,
//         vendor, filename, mime, maintenanceType, workState }
async function getDocumentUploadLink(opts = {}) {
  // Enum values confirmed live by AAP's validation (2026-10-18):
  //   serviceEntityIdCategory ∈ {SERVICE_EVENT_DOCUMENT, WORK_REQUEST_DOCUMENT, WORK_ORDER_DOCUMENT}
  //   documentType ∈ {PARTS, ESTIMATE, DAMAGE, ACCIDENT, OTHER, INSPECTION, COMPLIANCE, COMPLETION, ASSET_IDENTIFICATION}
  //   workState ∈ {IN_PROGRESS, COMPLETED, AFTER, FAILED, BEFORE}
  //   maintenanceType is a large PM-type enum — NOT applicable to a WR document, so omit it.
  const body = {
    serviceEntityIdCategory: opts.serviceEntityIdCategory || 'WORK_REQUEST_DOCUMENT',
    serviceEntityId:         opts.serviceEntityId || '',
    documentType:            opts.documentType || 'OTHER',
    vendor:                  opts.vendor || null,
    filename:                opts.filename || 'attachment',
    fileType:                _fileTypeToken(opts.mime || opts.filename),
    workState:               opts.workState || 'IN_PROGRESS',
  };
  // Only include maintenanceType if a caller explicitly supplies a valid one.
  if (opts.maintenanceType) body.maintenanceType = opts.maintenanceType;
  const resp = await apiPost(DOC_UPLOAD_LINK_PATH, body);
  return resp; // { uploadLink, documentId, ... }
}

// Step 2: PUT the raw file bytes to the presigned S3 URL. `bytes` is a Buffer
// or base64 string; `mime` sets the Content-Type. This goes to an arbitrary S3
// host (not AAP_ORIGIN), so it's a raw PUT via the browser page context.
async function uploadDocumentFile(uploadLink, bytes, mime) {
  if (!uploadLink) throw Object.assign(new Error('uploadDocumentFile: no uploadLink'), { code: 'NO_UPLOAD_LINK' });
  const b64 = Buffer.isBuffer(bytes) ? bytes.toString('base64') : String(bytes || '');
  // Run the PUT inside the authenticated AAP page so cookies/CSRF are present.
  const script = `(async function () {
    try {
      var bin = atob(${JSON.stringify(b64)});
      var len = bin.length, arr = new Uint8Array(len);
      for (var i = 0; i < len; i++) arr[i] = bin.charCodeAt(i);
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', ${JSON.stringify(uploadLink)}, true);
      xhr.setRequestHeader('Content-Type', ${JSON.stringify(mime || 'application/octet-stream')});
      return await new Promise(function (resolve) {
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, text: (xhr.responseText || '').slice(0, 500) });
        };
        xhr.onerror = function () { resolve({ ok: false, status: 0, netErr: true }); };
        xhr.send(arr.buffer);
      });
    } catch (e) { return { ok: false, status: -1, error: e.message }; }
  })();`;
  return _withLock(async () => {
    const page = await _ensureWindow();
    const r = await page.evaluate(script);
    _scheduleTeardown();
    if (!r || !r.ok) {
      throw Object.assign(new Error('S3 upload failed: HTTP ' + (r && r.status) + (r && r.text ? ' ' + r.text : '')),
        { code: 'S3_UPLOAD_FAILED', status: r && r.status });
    }
    return r;
  });
}

// Step 3 (usually unnecessary): link an uploaded document to the work request.
// CONFIRMED LIVE 2026-10-18: the uploadLink response is just {uploadLink,
// uploadTime} with NO documentId — the association is implicit in the S3 key
// (keyed by aaid + the serviceEntityId passed to uploadLink), so uploadWrAttach-
// ments only calls this if a documentId actually comes back (it doesn't today).
async function associateDocument(opts = {}) {
  const body = {
    documentId:      opts.documentId || '',
    serviceEntityId: opts.serviceEntityId || '',
    serviceEntityIdCategory: opts.serviceEntityIdCategory || 'WORK_REQUEST_DOCUMENT',
  };
  return apiPost(DOC_ASSOCIATE_PATH, body);
}

// High-level: upload a list of attachments to a just-created WR. Each attachment
// is { name, dataUrl } (dataUrl = "data:<mime>;base64,<...>" as produced by the
// WR modal's FileReader). Best-effort: failures are collected, not thrown, so a
// bad attachment never sinks a successfully-created WR. Logs the first link
// request+response so we can confirm the enum values live.
async function uploadWrAttachments(workRequestId, attachments, opts = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  const out = [];
  let loggedShape = false;
  for (let i = 0; i < list.length; i++) {
    const att = list[i] || {};
    const name = att.name || ('attachment-' + (i + 1));
    try {
      // Parse the data URL → mime + raw bytes.
      const du = String(att.dataUrl || '');
      const m = du.match(/^data:([^;]+);base64,(.*)$/);
      if (!m) { out.push({ name, ok: false, error: 'not a base64 data URL' }); continue; }
      const mime = m[1];
      const buf = Buffer.from(m[2], 'base64');

      const link = await getDocumentUploadLink({
        serviceEntityId: workRequestId,
        serviceEntityIdCategory: opts.serviceEntityIdCategory,
        documentType: opts.documentType,
        vendor: opts.vendor || null,
        filename: name,
        mime,
        maintenanceType: opts.maintenanceType,
        workState: opts.workState,
      });
      if (!loggedShape) {
        loggedShape = true;
        logger.info('[doc-upload] first uploadLink response shape:\n' + JSON.stringify(link, null, 2));
      }
      const uploadLink = link && (link.uploadLink || link.url || link.preSignedUrl || link.presignedUrl);
      const documentId = link && (link.documentId || link.docId || link.id);
      if (!uploadLink) { out.push({ name, ok: false, error: 'no uploadLink in response' }); continue; }

      await uploadDocumentFile(uploadLink, buf, mime);

      // Associate only if the upload-link step didn't already bind to the WR.
      if (documentId) {
        try { await associateDocument({ documentId, serviceEntityId: workRequestId, serviceEntityIdCategory: opts.serviceEntityIdCategory }); }
        catch (e) { logger.warn('[doc-upload] associate failed for ' + name + ': ' + e.message); }
      }
      logger.info('[doc-upload] uploaded ' + name + ' → WR ' + workRequestId + (documentId ? ' (doc ' + documentId + ')' : ''));
      out.push({ name, ok: true, documentId: documentId || null });
    } catch (e) {
      logger.warn('[doc-upload] FAILED ' + name + ': ' + (e && e.message));
      out.push({ name, ok: false, error: (e && e.message) || String(e) });
    }
  }
  return out;
}

module.exports = {
  apiGet,
  apiPost,
  apiPut,
  createWorkOrder,
  _parseAapErrorField,          // exported for self-healing unit tests
  _correctCreateRepairField,    // exported for self-healing unit tests
  vreRecommendMatrix,
  getDocumentUploadLink,
  uploadDocumentFile,
  associateDocument,
  uploadWrAttachments,
  searchServices,
  searchAssets,
  getFleet,
  buildTrackerRows,
  buildFleetDataset,
  refreshUnit,
  getService,
  getAsset,
  getServiceMoves,
  getMaintenanceSchedules,
  getDvirs,
  getAvmCodes,
  getUserDetails,
  getVendorConfigs,
  getAvmTree,
  avmTypeFor,
  searchAllPages,
  findOpenWO,
  buildLongDwellSources,
  getFleetGeofencesViaApi, // API-first live geofence + GPS (replaces geofence_scraper DOM scrape)
  getWorkOrderDetailViaApi, // API-first WO detail (replaces aap_wo_scraper DOM scrape)
  getLocationLatest,
  dispose,
};
