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

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger')('aap-api');

const AAP_ORIGIN = 'https://aap-na.corp.amazon.com';
// A lightweight AAP page that authenticates + fires token-bearing XHRs on load.
// Reuse the WR page the long-dwell fetch already proved mints the token.
const TOKEN_PAGE_URL = AAP_ORIGIN + '/v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5?tab=Unplanned';

const WARM_IDLE_MS   = 3 * 60 * 1000;   // tear the window down after 3 min idle
const PAGE_LOAD_MS   = 45000;           // budget for the page to auth + settle
const TOKEN_WAIT_MS  = 10000;           // how long to wait for a token on load

const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');

let _win = null;
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
  try { if (_win && !_win.isDestroyed()) _win.destroy(); } catch (_) {}
  _win = null;
  _token = null;
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

// Ensure a warm, authenticated AAP window exists with the token captured.
async function _ensureWindow() {
  // Seed the freshest Midway/AEA cookies into the default session first.
  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) {
    logger.warn('cookie inject skipped: ' + e.message);
  }

  if (_win && !_win.isDestroyed() && _token) {
    _scheduleTeardown();
    return _win;
  }
  if (_win && !_win.isDestroyed()) { try { _win.destroy(); } catch (_) {} _win = null; }

  const win = new BrowserWindow({
    width: 1400, height: 800, show: false, x: -3000, y: -3000, skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: session.defaultSession,
    },
  });
  _win = win;

  const loaded = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const t = setTimeout(() => finish({ ok: false, error: 'timeout' }), PAGE_LOAD_MS);
    win.webContents.once('did-finish-load', async () => {
      clearTimeout(t);
      let url = '';
      try { url = win.webContents.getURL(); } catch (_) {}
      if (_isSSO(url)) { finish({ ok: false, error: 'auth' }); return; }
      try {
        await win.webContents.executeJavaScript(_HOOK_SCRIPT, true);
        const tok = await win.webContents.executeJavaScript(_waitTokenScript(TOKEN_WAIT_MS), true);
        finish({ ok: true, token: tok || null, url });
      } catch (e) {
        finish({ ok: false, error: 'script:' + e.message });
      }
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return;
      clearTimeout(t);
      finish({ ok: false, error: 'load:' + code + ':' + desc });
    });
    win.loadURL(TOKEN_PAGE_URL);
  });

  if (!loaded.ok) {
    dispose();
    const msg = loaded.error === 'auth'
      ? 'AAP session expired (Midway/AEA). Open the main window to re-authenticate, then retry.'
      : 'AAP API window failed to load: ' + loaded.error;
    throw Object.assign(new Error(msg), { code: loaded.error === 'auth' ? 'MIDWAY_SESSION_INVALID' : 'AAP_API_LOAD_FAILED' });
  }
  _token = loaded.token; // may be null for pure-GET usage; POST will re-check
  _scheduleTeardown();
  return win;
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
    const win = await _ensureWindow();
    const url = path.startsWith('http') ? path : (AAP_ORIGIN + path);
    const bodyLiteral = body != null ? JSON.stringify(JSON.stringify(body)) : 'null';
    const script = _requestScript(method, url, bodyLiteral);
    const r = await win.webContents.executeJavaScript(script, true);
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
    status:          (wo.status && (wo.status.displayText || wo.status.value || wo.status.description)) || '',
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
  //    This is the app's fleet scope. Keyed by aaid; we keep the asset summary.
  const assetByAaid = new Map();    // aaid -> asset summary record
  const assetByUnit = new Map();    // unit# -> asset summary record
  for (const key of ['domicileSite', 'operator']) {
    for (let page = 0; page < (opts.maxPages || 60); page++) {
      const res = await searchAssets({ from: page * 150, fieldFilters: filterVals.length ? [{ key, values: filterVals }] : [] });
      const list = (res && res.assets) || [];
      if (!list.length) break;
      for (const a of list) {
        const aaid = a && a.asset && a.asset.aaid;
        const unit = a && a.asset && (a.asset.displayName || (a.asset.attributesText && a.asset.attributesText.vehicleId));
        if (aaid && !assetByAaid.has(aaid)) assetByAaid.set(aaid, a);
        if (unit && !assetByUnit.has(String(unit).toUpperCase())) assetByUnit.set(String(unit).toUpperCase(), a);
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

  // 2) WORK ORDERS — fetch WOs for the same filter (both keys), index by aaid,
  //    keeping the most-recent WO per unit as the "current" one.
  const woByAaid = new Map();
  const woTs = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
  const woReq = Object.assign({}, opts.searchRequest || {});
  if (filterVals.length) woReq.assetDomicileSites = filterVals; // WO search accepts site+operator tokens here
  const woList = await searchAllPages(woReq, { maxPages: opts.maxPages || 50 });
  for (const w of woList) {
    if (!w.aaid) continue;
    const prev = woByAaid.get(w.aaid);
    if (!prev || woTs(w) > woTs(prev)) woByAaid.set(w.aaid, w);
  }

  // 3) Build one fleet row per ASSET (the app's set). Attach the current WO if
  //    the unit has one; units with no open WO still appear (lifecycle-driven).
  const detailCap = opts.detailCap != null ? opts.detailCap : assetEntries.length;
  const perCallMs = opts.detailPerCallMs || 8000;
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('detail-timeout')), ms))]);

  const rows = [];
  let detailDone = 0;
  for (const assetSummary of assetEntries) {
    const aaid = assetSummary.asset && assetSummary.asset.aaid;
    const wo = (aaid && woByAaid.get(aaid)) || null;

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
    // Asset lifecycle is the source of truth for availability — override the
    // WO's (which may lag) with the asset's current state.
    row.lifecycleState = mapper.mapLifecycleState(assetSummary.asset && assetSummary.asset.lifecycleState) || row.lifecycleState;
    if (!wo) row.lifecycleReason = mapper.mapLifecycleReason(assetSummary.asset && assetSummary.asset.lifecycleStateReason) || row.lifecycleReason;

    // VIN/model from the full single-asset endpoint (bounded).
    if (opts.withVin !== false && aaid && detailDone <= detailCap) {
      try {
        const full = await withTimeout(getAsset(aaid), perCallMs);
        const d = mapper.assetDetailFields(full);
        row.vin = d.vin || row.vin;
        row.manufacturer = d.manufacturer || row.manufacturer;
        if (d.odometerMiles !== '') row.odometerMiles = d.odometerMiles;
        if (d.engineHours !== '') row.engineHours = d.engineHours;
      } catch (_) { /* leave VIN empty */ }
    }
    rows.push(row);
  }

  const unavailableCount = rows.filter((r) => /unavailable/i.test(String(r.lifecycleState || ''))).length;
  logger.info('buildFleetDataset: ' + rows.length + ' units ('
    + 'unavailable: ' + unavailableCount + ', filter: [' + filterVals.join(',') + '], '
    + 'comments: ' + (opts.withComments !== false) + ', vin: ' + (opts.withVin !== false) + ')');
  return { rows, count: rows.length, unavailableCount, filter: filterVals, syncedAt: new Date().toISOString(), source: 'aap-api' };
}

// ── Per-unit refresh: fresh data for ONE unit via the API ────────────────────
// Replaces the (currently unused) per-unit relay scrape. Given a unit number,
// resolves its current open WO + asset, returns a mapped fleet row with the
// live comment thread. Used by the detail-panel refresh button.
async function refreshUnit(unitNumber) {
  const mapper = require('./aap_api_mapper');
  const u = String(unitNumber || '').trim().toUpperCase();
  if (!u) throw new Error('refreshUnit: no unit number');

  // Find the unit's current open WO (filtered by equipmentId, open statuses).
  const res = await searchServices({ equipmentIds: [u], page: 1 });
  const list = (res && res.serviceAggregates) || [];
  const woTs = (w) => Number(w.modifiedTimestamp || w.actualStartDateTime || w.scheduledDateTime || 0);
  const wo = list.sort((a, b) => woTs(b) - woTs(a))[0] || null;

  // Asset summary + full detail (VIN) via the aaid.
  let assetSummary = null, serviceDetail = null;
  const aaid = wo && wo.aaid;
  if (wo && (wo.id || wo.workRequestId)) {
    try { serviceDetail = await getService(wo.id || wo.workRequestId); } catch (_) {}
  }
  let full = null;
  if (aaid) { try { full = await getAsset(aaid); } catch (_) {} }

  const row = mapper.toFleetRow(wo || { assetDisplayName: u }, assetSummary, serviceDetail);
  if (full) {
    const d = mapper.assetDetailFields(full);
    row.vin = d.vin || row.vin;
    row.manufacturer = d.manufacturer || row.manufacturer;
    if (d.odometerMiles !== '') row.odometerMiles = d.odometerMiles;
    if (d.engineHours !== '') row.engineHours = d.engineHours;
    // Asset lifecycle = source of truth.
    const a = full.asset || {};
    row.lifecycleState = mapper.mapLifecycleState(a.lifecycleState) || row.lifecycleState;
    if (!wo) row.lifecycleReason = mapper.mapLifecycleReason(a.lifecycleStateReason) || row.lifecycleReason;
  }
  return row;
}

module.exports = {
  apiGet,
  apiPost,
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
  dispose,
};
