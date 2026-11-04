'use strict';
/**
 * aap_longdwell.js — Fetch the AAP long-dwell tracker CSV in-app (no manual download).
 *
 * The AAP Work-Request page exposes a CSV export via:
 *   POST https://aap-na.corp.amazon.com/api/v1/serviceaggregates/download
 *   body: { searchRequest: {...}, fileType: 0 }  → returns CSV text
 *
 * That endpoint requires an `anti-csrftoken-a2z` header. The token is NOT a
 * cookie, meta tag, or global — the AAP web app mints it per-session in memory
 * and attaches it only inside its own XMLHttpRequest calls. So instead of
 * reconstructing it (fragile), we:
 *
 *   1. injectCookies() to seed the freshest Midway/AEA session,
 *   2. open an OFF-SCREEN authenticated BrowserWindow on the AAP WR page
 *      (same session.defaultSession the live rescan uses),
 *   3. bail fast if it bounces to Midway SSO (dead session),
 *   4. INSIDE that page, hook XMLHttpRequest.setRequestHeader to capture the
 *      live `anti-csrftoken-a2z` the page's own export sets, trigger the page's
 *      export so the token gets minted, then replay the download POST with that
 *      captured token and read the CSV response.
 *
 * The token is captured live on every run and never persisted.
 *
 * Returns the raw CSV text; the IPC layer parses + stores it (reusing the same
 * import pipeline the file-based "Import CSV" button already uses).
 */

const { BrowserWindow, session } = require('electron');
const logger = require('../utils/logger')('aap-longdwell');

const AAP_ORIGIN = 'https://aap-na.corp.amazon.com';

// ── Source 1: Work-Request export (open WOs — delay/vendor/escalation data) ──
const WR_DOWNLOAD_API = AAP_ORIGIN + '/api/v1/serviceaggregates/download';
const WR_SEARCH_API   = AAP_ORIGIN + '/api/v1/serviceaggregates/search';
// Loading the WR page mints the per-session CSRF token and lets the page's own
// export fire so we can capture that token.
const WR_PAGE_URL = AAP_ORIGIN + '/v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5'
  + '?tab=Unplanned'
  + '&statuses=CREATED&statuses=ESTIMATE_APPROVED&statuses=ESTIMATE_PENDING_APPROVAL'
  + '&statuses=ESTIMATE_REJECTED&statuses=PENDING&statuses=PENDING_REVIEW'
  + '&statuses=SCHEDULED&statuses=WORK_IN_PROGRESS&statuses=WORK_ORDER_ASSIGNED'
  + '&states=UNAVAILABLE&assetPrograms=DSP-MMBT&assetPrograms=vupAfp';

// ── Source 2: Asset/fleet export (master data — fleet, location, lifecycle) ──
const ASSET_DOWNLOAD_API = AAP_ORIGIN + '/api/v2/assets/download/';
const ASSET_PAGE_URL = AAP_ORIGIN + '/page/dfd44913-d2f4-4e96-99e2-64729dbdc19a'
  + '?states=%5B%7B%22state%22%3A%22ACTIVE%22%2C%22reasons%22%3A%5B%5D%7D%2C%7B%22state%22%3A%22UNAVAILABLE%22%2C%22reasons%22%3A%5B%5D%7D%5D'
  + '&fields=%5B%7B%22key%22%3A%22assetType%22%2C%22values%22%3A%5B%22tractor%22%2C%22boxTruck%22%5D%7D%5D'
  + '&fleets=%5B%220bb2e249-fd34-437f-83af-d1d69150558b%22%2C%220f454f75-1e45-475f-8d8b-2334ade1f6f1%22%2C%225c19cdf7-ce2f-4593-a37a-3fe5d506e120%22%2C%227de393df-74e1-45af-9650-560ba008bc65%22%2C%22b84ddc20-589c-4330-af67-3d38f89e28af%22%2C%22b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe%22%2C%22ba97eda1-cb03-446e-a907-474084194777%22%2C%22daa83ad7-5d8f-43a4-ba9c-76c643e45e1e%22%5D';

// The proven searchRequest body (captured from the real export cURL). This is
// the exact filter set that produces the long-dwell tracker rows the team
// fills out: the configured fleet IDs, the UNPLANNED category, the full
// open-WO status set, UNAVAILABLE lifecycle, and the DSP-MMBT / vupAfp asset
// programs. Baked in as the default; can be lifted to a setting later if the
// filters need to vary per user.
const DEFAULT_SEARCH_REQUEST = {
  category: 'UNPLANNED',
  fleetIds: [
    '0bb2e249-fd34-437f-83af-d1d69150558b',
    '0f454f75-1e45-475f-8d8b-2334ade1f6f1',
    '5c19cdf7-ce2f-4593-a37a-3fe5d506e120',
    '7de393df-74e1-45af-9650-560ba008bc65',
    '9bf5bae8-f536-4157-8b23-f5632ced5e1d',
    'b84ddc20-589c-4330-af67-3d38f89e28af',
    'b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe',
    'ba97eda1-cb03-446e-a907-474084194777',
    'daa83ad7-5d8f-43a4-ba9c-76c643e45e1e',
  ],
  equipmentIds: null,
  ids: null,
  geofenceFilter: null,
  urgencyFilter: 'ALL',
  autoAssignedFilter: false,
  types: [],
  statuses: [
    'CREATED', 'ESTIMATE_APPROVED', 'ESTIMATE_PENDING_APPROVAL',
    'ESTIMATE_REJECTED', 'PENDING', 'PENDING_REVIEW', 'SCHEDULED',
    'WORK_IN_PROGRESS', 'WORK_ORDER_ASSIGNED',
  ],
  subStatuses: [],
  vendors: [],
  etcStartEpochMs: null, etcStartEpochMsRelative: null,
  etcEndEpochMs: null, etcEndEpochMsRelative: null,
  scheduledStartEpochMs: null, scheduledStartEpochMsRelative: null,
  scheduledEndEpochMs: null, scheduledEndEpochMsRelative: null,
  completedFromEpochMs: null, completedFromEpochMsRelative: null,
  completedToEpochMs: null, completedToEpochMsRelative: null,
  modifiedFromEpochMs: null, modifiedFromEpochMsRelative: null,
  modifiedToEpochMs: null, modifiedToEpochMsRelative: null,
  vendorModifiedFromEpochMs: null, vendorModifiedFromEpochMsRelative: null,
  vendorModifiedToEpochMs: null, vendorModifiedToEpochMsRelative: null,
  rocModifiedFromEpochMs: null, rocModifiedFromEpochMsRelative: null,
  rocModifiedToEpochMs: null, rocModifiedToEpochMsRelative: null,
  sortConfig: { sortColumn: 'ScheduledDate', sortDirection: 'descending' },
  page: 1,
  reportedGeofenceNames: null,
  workOrderDelayReasons: [],
  workRequestSources: [],
  escalations: [],
  lifecycleStates: ['UNAVAILABLE'],
  workOrderTags: [],
  vendorIntegrationTypes: [],
  yardLocationTypes: [],
  assetTypes: [],
  assetPrograms: ['DSP-MMBT', 'vupAfp'],
  assetRentalStatuses: [],
  assetDomicileSites: [],
  suggestedItemsL1: [],
  suggestedItemsL2: [],
  suggestedItemsReasons: [],
  totalEstimatePendingApprovalStartCost: null,
  totalEstimatePendingApprovalEndCost: null,
  estimateAutomationOutcomes: [],
};

// Proven assetSearchRequest body for the asset/fleet export (captured from the
// real export). The CSV download returns the FULL dataset regardless of
// numberOfRecordsToReturn (that field only sizes the on-screen grid page), so
// we leave it as captured. ACTIVE + UNAVAILABLE lifecycle, tractor + boxTruck,
// the configured fleet IDs.
const DEFAULT_ASSET_SEARCH_REQUEST = {
  missingChildAssetTypes: [],
  lifecycleStates: [
    { state: 'ACTIVE', reasons: [] },
    { state: 'UNAVAILABLE', reasons: [] },
  ],
  operationalStatuses: [],
  fieldFilters: [{ key: 'assetType', values: ['tractor', 'boxTruck'] }],
  assetSubTypeClauses: [],
  freeTextSearch: null,
  numberOfRecordsToReturn: 150,
  from: 0,
  fieldsToReturn: [
    'vehicleId', 'yardBuildingID', 'yardTimestamp', 'geoPoint',
    'latestLocationTimestamp', 'geoFences', 'lifecycleState', 'assetType',
    'displayName', 'inMotion', 'odometerInKm', 'engineHours', 'fleetName',
    'lifecycleStateReason',
  ],
  fieldsToMatch: null,
  clusterZoomLevel: 2,
  sortOption: { sortBy: 'vehicleId', sortDirection: 0 },
  includeBoundingBoxAggregation: true,
  includeClusteringAggregation: true,
  networkStatus: {},
  functioningStatus: {},
  boundingBox: {
    topLeft: { latitude: 46.526280802171954, longitude: -156.03665330828767 },
    bottomRight: { latitude: 27.529739351950788, longitude: -38.232969805508446 },
  },
  loadStatus: {},
  vrStatus: {},
  workRequestType: null,
  fleetIds: [
    '0bb2e249-fd34-437f-83af-d1d69150558b',
    '0f454f75-1e45-475f-8d8b-2334ade1f6f1',
    '5c19cdf7-ce2f-4593-a37a-3fe5d506e120',
    '7de393df-74e1-45af-9650-560ba008bc65',
    'b84ddc20-589c-4330-af67-3d38f89e28af',
    'b9e02fc4-2b9f-4a70-ac7c-76b30a33bcbe',
    'ba97eda1-cb03-446e-a907-474084194777',
    'daa83ad7-5d8f-43a4-ba9c-76c643e45e1e',
  ],
  geofenceFilter: null,
  stationCodes: [],
  dspShortCodes: [],
  tireFilter: { latestTireIssues: null, surveyStartDate: null, surveyEndDate: null },
  maintenanceStatusFilter: {
    types: null, startDueDate: null, endDueDate: null, scheduledStatuses: null,
    startCompletedDate: null, endCompletedDate: null, startUsagePercentage: null,
    endUsagePercentage: null, startLastIntervalCompleted: null,
    endLastIntervalCompleted: null, startNextIntervalDue: null, endNextIntervalDue: null,
  },
  operationalCodeFilter: {},
  internalVerificationStatusFilter: {},
};

// Describes one CSV source: which page to load (to mint/capture the token),
// which download endpoint to POST, and the request body (wrapped under the
// right top-level key for that endpoint).
const SOURCES = {
  wr: {
    label: 'work-requests',
    pageUrl: WR_PAGE_URL,
    downloadApi: WR_DOWNLOAD_API,
    searchApi: WR_SEARCH_API,
    buildBody: (sr) => ({ searchRequest: sr || DEFAULT_SEARCH_REQUEST, fileType: 0 }),
    probeBody: { searchRequest: { category: 'UNPLANNED', page: 1 } },
  },
  asset: {
    label: 'assets',
    pageUrl: ASSET_PAGE_URL,
    downloadApi: ASSET_DOWNLOAD_API,
    searchApi: ASSET_DOWNLOAD_API, // same /assets endpoint family carries the token
    buildBody: (sr) => ({ assetSearchRequest: sr || DEFAULT_ASSET_SEARCH_REQUEST, fileType: 0 }),
    probeBody: null, // the asset grid fires its own token-bearing XHRs on load
  },
};

const _isSSO = (u) => /midway-auth\.amazon\.com|\/SSO\/redirect/i.test(u || '');

/**
 * In-page script (runs in the AAP page's own context). Installs an XHR hook to
 * capture the live anti-csrftoken-a2z, nudges the page to mint one, then
 * replays the download POST with that token and returns the CSV text.
 *
 * Built as a string so it can be passed to webContents.executeJavaScript.
 * All interpolated values are JSON-encoded so they embed safely:
 *   - downloadApi: the POST endpoint
 *   - bodyObjLiteral: the request PAYLOAD as an object literal (real object)
 *   - probeApi / probeBodyLiteral: optional XHR to nudge token minting (or null)
 */
function _buildInPageScript({ downloadApi, bodyObjLiteral, probeApi, probeBodyLiteral }) {
  return `(async function () {
    const DL = ${JSON.stringify(downloadApi)};
    const BODY = ${bodyObjLiteral};  // real object (NOT a string)
    const PROBE_API = ${probeApi ? JSON.stringify(probeApi) : 'null'};
    const PROBE_BODY = ${probeBodyLiteral || 'null'};

    // 1. Capture the live CSRF token the page attaches to its own XHRs. Match
    //    on the a2z header regardless of endpoint — the asset page and the WR
    //    page mint the same session token, so ANY token-bearing XHR will do.
    let captured = null;
    try {
      const RS = XMLHttpRequest.prototype.setRequestHeader;
      const OP = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return OP.apply(this, arguments); };
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        try {
          if (/csrftoken-a2z/i.test(k) && v) { captured = v; }
        } catch (e) {}
        return RS.apply(this, arguments);
      };
    } catch (e) {
      return { ok: false, error: 'hook-failed: ' + e.message };
    }

    // 2. Give the page a moment to perform its own data XHRs (which carry the
    //    token). The grid's initial load fires token-bearing calls, so the
    //    token is usually captured within a second or two.
    async function waitForToken(ms) {
      const deadline = Date.now() + ms;
      while (!captured && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
      }
      return captured;
    }

    let token = await waitForToken(8000);

    // 3. If nothing fired on its own, trigger a benign search XHR the same way
    //    the grid does, so the page attaches a fresh token we can grab.
    if (!token && PROBE_API && PROBE_BODY) {
      try {
        const probe = new XMLHttpRequest();
        probe.open('POST', PROBE_API, true);
        probe.setRequestHeader('Content-Type', 'application/json;charset=utf-8');
        probe.send(JSON.stringify(PROBE_BODY));
      } catch (e) {}
      token = await waitForToken(5000);
    }

    if (!token) return { ok: false, error: 'no-token', detail: 'Could not capture AAP CSRF token from the page.' };

    // 4. Replay the download POST with the captured token. Use XHR (not fetch)
    //    so it goes through the exact same request path the page uses.
    const csv = await new Promise((resolve) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', DL, true);
        xhr.setRequestHeader('Content-Type', 'application/json;charset=utf-8');
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        xhr.setRequestHeader('anti-csrftoken-a2z', token);
        xhr.withCredentials = true;
        xhr.onreadystatechange = function () {
          if (xhr.readyState === 4) {
            resolve({ status: xhr.status, text: xhr.responseText || '' });
          }
        };
        xhr.onerror = function () { resolve({ status: 0, text: '', netErr: true }); };
        xhr.send(JSON.stringify(BODY));
      } catch (e) {
        resolve({ status: -1, text: '', error: e.message });
      }
    });

    if (csv.status !== 200) {
      return { ok: false, error: 'http-' + csv.status, detail: (csv.text || '').slice(0, 400), netErr: !!csv.netErr };
    }
    return { ok: true, csv: csv.text, bytes: (csv.text || '').length };
  })();`;
}

/**
 * Fetch ONE source's CSV from AAP. Opens that source's page in an off-screen
 * authenticated window, captures the live CSRF token, POSTs its download
 * endpoint, and returns { ok, csv } or a structured { ok:false, error }.
 * Never throws for expected failure modes (SSO bounce, token miss, HTTP error).
 *
 * @param {object} source  one of SOURCES.wr / SOURCES.asset
 * @param {object} searchRequest  the filter body (unwrapped; source.buildBody wraps it)
 * @param {number} timeoutMs
 */
function _fetchSource(source, searchRequest, timeoutMs) {
  const payload = source.buildBody(searchRequest);
  const bodyObjLiteral = JSON.stringify(payload);
  const script = _buildInPageScript({
    downloadApi: source.downloadApi,
    bodyObjLiteral,
    probeApi: source.probeBody ? source.searchApi : null,
    probeBodyLiteral: source.probeBody ? JSON.stringify(source.probeBody) : null,
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
      resolve(res);
    };

    const win = new BrowserWindow({
      width: 1400, height: 800,
      show: false, x: -3000, y: -3000, skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: session.defaultSession,
      },
    });

    const timeout = setTimeout(() => {
      logger.warn('[' + source.label + '] fetch timed out after ' + timeoutMs + 'ms');
      finish({ ok: false, error: 'timeout', detail: 'AAP (' + source.label + ') did not respond in time.' });
    }, timeoutMs);

    const run = async () => {
      let url = '';
      try { url = win.webContents.getURL(); } catch (_) {}
      if (_isSSO(url)) {
        clearTimeout(timeout);
        logger.warn('[' + source.label + '] landed on Midway SSO — session invalid');
        finish({ ok: false, error: 'auth', detail: 'AAP session expired. Open the app’s main window to re-authenticate, then try again.' });
        return;
      }
      try {
        const result = await win.webContents.executeJavaScript(script, true);
        clearTimeout(timeout);
        if (result && result.ok) {
          logger.info('[' + source.label + '] fetched CSV: ' + result.bytes + ' bytes');
          finish({ ok: true, csv: result.csv });
        } else {
          const err = (result && (result.detail || result.error)) || 'unknown error';
          logger.warn('[' + source.label + '] fetch failed: ' + (result && result.error) + ' — ' + err);
          finish({ ok: false, error: (result && result.error) || 'failed', detail: err });
        }
      } catch (e) {
        clearTimeout(timeout);
        logger.error('[' + source.label + '] executeJavaScript threw: ' + e.message);
        finish({ ok: false, error: 'script', detail: e.message });
      }
    };

    win.webContents.once('did-finish-load', run);
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -3) return;
      logger.warn('[' + source.label + '] did-fail-load: ' + code + ' ' + desc);
    });

    win.loadURL(source.pageUrl);
  });
}

/**
 * Fetch BOTH sources (WR + asset) and return both CSVs. The two run
 * sequentially (not parallel) to avoid two heavy AAP pages competing for the
 * same session at once. Resolves with:
 *   { ok, wrCsv, assetCsv }        on full success
 *   { ok:false, error, wrCsv?, assetCsv? }  if either source failed
 *
 * @param {object} [opts]
 * @param {object} [opts.searchRequest]       override WR filter body
 * @param {object} [opts.assetSearchRequest]  override asset filter body
 * @param {number} [opts.timeoutMs]           per-source budget (default 60s)
 */
async function fetchBothSources(opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;

  // Seed the freshest Midway/AEA cookies once up front.
  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) {
    logger.warn('cookie inject skipped: ' + e.message);
  }

  const wr = await _fetchSource(SOURCES.wr, opts.searchRequest || DEFAULT_SEARCH_REQUEST, timeoutMs);
  if (!wr.ok) return { ok: false, error: 'Work-request export failed: ' + (wr.detail || wr.error), stage: 'wr' };

  const asset = await _fetchSource(SOURCES.asset, opts.assetSearchRequest || DEFAULT_ASSET_SEARCH_REQUEST, timeoutMs);
  if (!asset.ok) return { ok: false, error: 'Asset export failed: ' + (asset.detail || asset.error), stage: 'asset', wrCsv: wr.csv };

  return { ok: true, wrCsv: wr.csv, assetCsv: asset.csv };
}

/**
 * Back-compat single-source fetch (WR only). Kept so the existing
 * long-dwell-csv:fetch-aap path still works while we move the IPC layer to the
 * two-source merge.
 */
async function fetchLongDwellCsv(opts = {}) {
  try {
    const { injectCookies } = require('./auth');
    await injectCookies(session.defaultSession);
  } catch (e) {
    logger.warn('cookie inject skipped: ' + e.message);
  }
  return _fetchSource(SOURCES.wr, opts.searchRequest || DEFAULT_SEARCH_REQUEST, opts.timeoutMs || 60000);
}

module.exports = {
  fetchBothSources,
  fetchLongDwellCsv,
  DEFAULT_SEARCH_REQUEST,
  DEFAULT_ASSET_SEARCH_REQUEST,
  WR_PAGE_URL,
  ASSET_PAGE_URL,
};
