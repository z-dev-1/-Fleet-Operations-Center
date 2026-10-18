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
            resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json: json, text: json ? null : txt.slice(0, 1000) });
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
      const detail = (r && (r.text || r.error)) || ('HTTP ' + (r && r.status));
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
    street: '', city: '', subRegion: '', country: 'US', postalCode: '', timeZone: '',
  };
  // Off-site address typed in the wizard wins (unit is away from its yard).
  if (opts && opts.offSite) {
    loc.street     = opts.locStreet || '';
    loc.city       = opts.locCity   || '';
    loc.subRegion  = opts.locState  || '';
    loc.postalCode = opts.locZip    || '';
  }
  const gp = assetFull && assetFull.latestLocation && assetFull.latestLocation.geoPoint;
  if (gp && (gp.latitude != null || gp.lat != null)) {
    loc.latitude  = gp.latitude  != null ? gp.latitude  : gp.lat;
    loc.longitude = gp.longitude != null ? gp.longitude : gp.lng;
  }
  // Domicile fallback coords if GPS missing.
  if (loc.latitude == null && opts && opts.domicile) {
    let DOM = null;
    try { DOM = require('./aap_create_wr').DOMICILE_COORDS; } catch (_) {}
    const d = DOM && (DOM[opts.domicile] || DOM[String(opts.domicile).toUpperCase()]);
    if (d) { loc.latitude = d.latitude; loc.longitude = d.longitude; }
  }
  return loc;
}

// Build the CREATE_WORK_ORDER_BODY from a wizard payload + resolved asset.
// vendorCode is 'UNASSIGNED' for Phase 1 or the confirmed code for Phase 2.
function _buildWoBody(opts, assetFull, vendorCode) {
  const now = Date.now();
  const nowIso   = new Date(now).toISOString();
  const needByIso = new Date(now + 24 * 3600 * 1000).toISOString();
  const aaid = opts.aaid || _aaidFromUrl(opts.assetUrl);

  const suggestedItems = (opts.areaPairs || [])
    .filter(p => p && (p.area || p.subcategory))
    .map(p => ({ level1: p.area || '', level2: p.subcategory || '', level3: '' }));

  const comments = [];
  if (opts.comments) comments.push(String(opts.comments));

  const urgent = String(opts.urgent || '').toLowerCase() === 'yes';
  const calltype = (opts && opts.offSite) ? 'OFFSITE' : (opts.calltype || 'ONSITE');

  return {
    aaid,
    title: String(opts.title || '').slice(0, 90),
    calltype,
    currentLocation: _buildLocation(assetFull, opts),
    destination: null,
    urgent,
    urgencyReason: urgent ? _mapUrgencyReason(opts.urgencyReason) : null,
    severity: urgent ? 'HIGH' : 'LOW',
    tireIssue: suggestedItems.some(s => /tire/i.test(s.level1)) || false,
    assetLoaded: false,
    assetRefrigerated: false,
    arcClaimNumber: opts.arcClaim || null,
    simNumber: opts.simNumber || null,
    assetAvailableDateTime: nowIso,
    needByDateTime: needByIso,
    damageDescription: String(opts.issue || '') || null,
    comments,
    suggestedItems,
    vendor: vendorCode,
    supplierId: null,
    sourceNotificationIds: [],
    source: 'FLEET_OPS_CENTER',
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
  const body = _buildWoBody({ ...opts, aaid }, assetFull, vendorCode);
  const resp = await apiPut(CREATE_WO_PATH, body);
  const recommendation = _readRecommendation(resp);
  const workRequestId =
    (resp && (resp.workRequestId || resp.workOrderId || resp.id ||
      (resp.workOrder && resp.workOrder.id) ||
      (recommendation.raw && recommendation.raw.workRequestId))) || '';
  logger.info('createWorkOrder Phase 2 (commit) aaid=' + aaid +
    ' vendor=' + vendorCode + ' workRequestId=' + workRequestId);
  return {
    ok: true,
    phase: 'commit',
    aaid,
    vendor: vendorCode,
    autoAssignable: recommendation.autoAssignable,
    workRequestId,
    raw: resp || null,
  };
}

module.exports = {
  apiGet,
  apiPost,
  apiPut,
  createWorkOrder,
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
  searchAllPages,
  findOpenWO,
  buildLongDwellSources,
  dispose,
};
