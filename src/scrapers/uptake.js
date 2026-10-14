'use strict';
// scrapers/uptake.js
// Strategy v2 — Assets + Insights + Cases page
//
// Auth flow (unchanged):
//   1. Load /?realm=amzlmiddlemile
//   2. Auto-click "Amazon SSO"
//   3. Midway SSO via  cookies
//
// Scrape flow:
//   1. Navigate to /assetsInsightsCases/insights  (Z filter = your 136 assets)
//   2. Poll DOM until table rows appear — scrape all insight rows
//   3. Screenshot the list page
//   4. For each insight → loadURL → poll until React content renders
//      → click all "Read More" → wait → scrape sidebar + summary + recommended
//      → screenshot
//   5. Group by asset numeric ID → resolve

const { BrowserWindow } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('uptake');

// ─── File logger ──────────────────────────────────────────────────────────────
const LOG_FILE = P.uptakeLog;

function flog(...args) { logger.info(...args); }
function fwarn(...args) { logger.warn(...args); }

// ─── Constants ────────────────────────────────────────────────────────────────
const UPTAKE_LOGIN_URL    = 'https://fleet.uptake.com/?realm=amzlmiddlemile';
const UPTAKE_INSIGHTS_URL = 'https://fleet.uptake.com/assetsInsightsCases/insights';
const FLEET_DOMAIN        = /fleet\.uptake\.com/i;
const LOGIN_DOMAIN        = /login\.uptake\.com/i;
const REALM_LOGIN         = /fleet\.uptake\.com\/?\?.*realm=/i;
const REALM_CALLBACK      = /#.*\bcode=/i;
const MIDWAY_PATTERN      = /midway|signin\.aws|sso\.amazon|oidc|oauth|federate\.amazon/i;
const PARTITION           = '';

// BUG FIX (2026-07-14): was 300000 (5 min, itself bumped up once already from 3 min).
// Live logs show a real scrape of the fleet's current 55 flagged insights /
// ~44 unique assets takes ~7-8 min just for the detail-page pass (observed
// ~8s/asset) before the risk-score pass even starts -- comfortably exceeding
// 5 min. Every run was hitting this timeout and (see the master-timeout
// handler below) discarding ALL partial progress, returning 0 units. Because
// sync/index.js correctly refuses to overwrite the persisted Uptake cache
// with an empty result (a good safety guard), the cache never refreshed --
// it was stuck 6 days stale (last successful run: 2026-07-08) while 195/210
// fleet units silently showed no Uptake enrichment. Bumped to 15 min to give
// real headway as the fleet's insight count grows; the master-timeout
// handler below is ALSO fixed to salvage whatever was actually completed
// instead of discarding it, so even if 15 min still isn't enough one day,
// the cache gets a genuine (if incomplete) refresh instead of nothing.
const MASTER_TIMEOUT_MS   = 1200000;  // 20 min (was 15 min) -- headroom so all insights finish before salvage
// H-3: concurrency lock — prevents duplicate BrowserWindow farms on re-entrant calls
let _uptakeLock = false;
 // Stage 5 C-2: 3 min cap (was 15 min) -- isSyncing clears promptly on hang
const PAGE_LOAD_TIMEOUT   = 20000;  // per-page: 20s -- stalled pages skip faster
const DOM_POLL_INTERVAL   = 800;    // ms between DOM-ready checks
const DOM_POLL_MAX        = 50;     // max polls (~40 seconds) — asset overview pages load slowly
const UPTAKE_READ_MORE_WAIT_MS = 1_200;   // S8: Read More expansion poll deadline (was 3000ms; times out ~96% of insights, so shortened to reclaim ~1.8s/insight)
const UPTAKE_READ_MORE_POLL_MS = 300;     // S8: body-length delta poll tick interval

const DEBUG = process.env.UPTAKE_DEBUG === '1';
if (DEBUG) flog('[Uptake] ⚠️  DEBUG MODE');

// ─── Screenshots dir ──────────────────────────────────────────────────────────
const SCREENSHOTS_DIR = P.screenshotsDir;
try { if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); } catch(_) {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Scrape risk score from asset overview tab ────────────────────────────────
// URL pattern: https://fleet.uptake.com/asset/{uuid}  (no insight suffix)
// The risk score widget uses _uav-asset_17lrh_767 and a loading spinner.
// We poll until the loading state clears, then grab the score.
const CHECK_ASSET_READY = `(function() {
  // Wait for the spinner to clear AND the tab content panel to have rendered.
  // The asset overview tab uses _uav-tabs__content which appears once React hydrates.
  // Nav bar alone is ~400 chars so we need something more specific than bodyLen.
  var loading = !!document.querySelector('[class*="loading"][class*="state"], [class*="spinner"]');
  if (loading) return false;
  var bodyLen = (document.body ? document.body.innerText : '').trim().length;
  if (bodyLen < 500) return false;
  // Must have the tabs content panel rendered — this is present on all asset pages
  return !!(
    document.querySelector('[class*="_uav-tabs__content"]') ||
    document.querySelector('[class*="_uav-asset"]') ||
    document.querySelector('[class*="asset-overview"]') ||
    document.querySelector('[class*="assetOverview"]')
  );
})()`;

// Scrape risk score from asset overview — /asset/{uuid}
// Includes a one-time DOM dump on the first asset to discover real class names.
const SCRAPE_ASSET_RISK = `(function() {
  try {
    function gt(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }

    var riskScore = null, riskLabel = '';

    // ── DOM dump: collect all unique class names that contain "risk", "score",
    // "health", "grade", or "rating" — these are the candidates for the widget ──
    var allEls = Array.from(document.querySelectorAll('*'));
    var candidateClasses = Array.from(new Set(
      allEls
        .map(function(el) { return Array.from(el.classList); })
        .reduce(function(a,b) { return a.concat(b); }, [])
        .filter(function(c) { return /risk|score|health|grade|rating/i.test(c); })
    )).slice(0, 40);

    // ── Collect leaf-node numeric text near those class elements ──────────────
    var numericLeaves = [];
    allEls.forEach(function(el) {
      if (el.childElementCount > 0) return;
      var txt = gt(el).trim();
      if (!/^\\d{1,3}$/.test(txt)) return;
      var cls = Array.from(el.classList).concat(
        el.parentElement ? Array.from(el.parentElement.classList) : []
      ).join(' ');
      numericLeaves.push({ txt: txt, cls: cls.slice(0,120) });
    });

    // ── Strategy 1: exact class fragment matches ──────────────────────────────
    var candidates = [
      document.querySelector('[class*="risk-score"]'),
      document.querySelector('[class*="riskScore"]'),
      document.querySelector('[class*="risk_score"]'),
      document.querySelector('[class*="RiskScore"]'),
      document.querySelector('[class*="score-value"]'),
      document.querySelector('[class*="scoreValue"]'),
      document.querySelector('[class*="asset-score"]'),
      document.querySelector('[class*="health-score"]'),
      document.querySelector('[class*="healthScore"]'),
      document.querySelector('[class*="risk-index"]'),
      document.querySelector('[class*="riskIndex"]'),
    ];
    for (var c = 0; c < candidates.length; c++) {
      if (!candidates[c]) continue;
      var t = gt(candidates[c]);
      var n = t.match(/\\b(\\d{1,3})\\b/);
      if (n) { riskScore = parseInt(n[1], 10); }
      var l = t.match(/\\b(low|medium|high|very high|critical)\\b/i);
      if (l) riskLabel = l[1];
      if (riskScore !== null) break;
    }

    // ── Strategy 2: leaf node with number 0-100 near a "risk"-class parent ────
    if (riskScore === null) {
      for (var i = 0; i < allEls.length; i++) {
        var el = allEls[i];
        if (el.childElementCount > 0) continue;
        var txt2 = gt(el);
        if (!/^\\d{1,3}$/.test(txt2)) continue;
        var num = parseInt(txt2, 10);
        if (num < 0 || num > 100) continue;
        // Walk up 3 levels looking for a "risk" class
        var p = el;
        for (var depth = 0; depth < 4; depth++) {
          if (!p) break;
          var pCls = Array.from(p.classList).join(' ').toLowerCase();
          if (/risk|score|health/.test(pCls)) {
            riskScore = num;
            break;
          }
          p = p.parentElement;
        }
        if (riskScore !== null) break;
      }
    }

    // ── VIN / model / year from detail panel ─────────────────────────────────
    var vin = '', model = '', modelYear = '', manufacturer = '', fuelType = '';
    var labelEls = Array.from(document.querySelectorAll('[class*="label"],[class*="title"],[class*="key"],dt,th'));
    labelEls.forEach(function(lEl) {
      var lTxt = gt(lEl).toLowerCase();
      var vEl = lEl.nextElementSibling;
      var val = vEl ? gt(vEl) : '';
      if (!val && lEl.parentElement) {
        var dd = lEl.parentElement.querySelector('dd,[class*="value"]');
        if (dd) val = gt(dd);
      }
      if      (/^vin$/.test(lTxt)                && !vin)          vin          = val;
      else if (/^model$/.test(lTxt)              && !model)        model        = val;
      else if (/model.?year|^year$/.test(lTxt)   && !modelYear)    modelYear    = val;
      else if (/manufacturer/.test(lTxt)          && !manufacturer) manufacturer = val;
      else if (/fuel.?type/.test(lTxt)            && !fuelType)     fuelType     = val;
    });

    return {
      riskScore:      riskScore,
      riskLabel:      riskLabel,
      vin:            vin,
      model:          model,
      modelYear:      modelYear,
      manufacturer:   manufacturer,
      fuelType:       fuelType,
      // Diagnostic payload — used on first asset only
      _diag: {
        candidateClasses: candidateClasses,
        numericLeaves:    numericLeaves.slice(0, 20),
        bodyLen:          (document.body ? document.body.innerText : '').length,
        url:              window.location.href,
      },
    };
  } catch(e) {
    return { riskScore: null, riskLabel: '', vin: '', model: '', modelYear: '', manufacturer: '', fuelType: '', _diag: { error: e.message } };
  }
})()`;



// ─── Wait for did-finish-load to go quiet (debounced) ────────────────────────
// The SPA fires did-finish-load 2-3 times due to OAuth rehydration.
// We wait for it to stop firing for quietMs before resolving.
function waitForLoadQuiet(win, timeoutMs = PAGE_LOAD_TIMEOUT, quietMs = 800) {
  return new Promise((resolve) => {
    let quietTimer = null;
    let done = false;
    function cleanup() {
      done = true;
      clearTimeout(quietTimer);
      clearTimeout(master);
      if (!win.isDestroyed()) win.webContents.removeListener('did-finish-load', onLoad);
    }
    const master = setTimeout(() => {
      if (done) return;
      cleanup();
      resolve();
    }, timeoutMs);
    function onLoad() {
      if (done) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        if (done) return;
        cleanup();
        resolve();
      }, quietMs);
    }
    win.webContents.on('did-finish-load', onLoad);
  });
}

// ─── Poll until JS expression returns truthy ──────────────────────────────────
async function pollUntil(win, expr, intervalMs = DOM_POLL_INTERVAL, maxTries = DOM_POLL_MAX) {
  for (let i = 0; i < maxTries; i++) {
    if (win.isDestroyed()) return false;
    try {
      const result = await win.webContents.executeJavaScript(expr);
      if (result) return true;
    } catch(_) {}
    await sleep(intervalMs);
  }
  return false;
}

// ─── Screenshot helper ────────────────────────────────────────────────────────
async function captureScreenshot(win, label) {
  try {
    // Electron 30+: capturePage() works from any position — no flash or repositioning needed.
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    if (buf.length < 5000) {
      fwarn(`[Uptake] Screenshot "${label}" too small (${buf.length}b) — blank page, skipping`);
      return null;
    }
    const file = path.join(SCREENSHOTS_DIR, `uptake_${label}_${Date.now()}.png`);
    fs.writeFileSync(file, buf);
    flog(`[Uptake] Screenshot saved: ${file} (${(buf.length/1024).toFixed(0)}KB)`);
    return file;
  } catch(e) {
    fwarn('[Uptake] Screenshot failed:', e.message);
    return null;
  }
}

// ─── Prune stale screenshots ──────────────────────────────────────────────────
// Every scrape writes NEW timestamped PNGs (uptake_<label>_<ts>.png) and never
// removed the old ones, so the screenshots dir grew without bound (observed:
// dozens of stale PNGs per unit). After a successful, non-empty scrape, delete
// any uptake_*.png NOT referenced by THIS run's results — i.e. keep only the
// current cache's images. Never throws (best-effort; caller guards on
// units.length > 0 so a salvaged empty run never triggers this).
function pruneScreenshots(units, listShotPath) {
  const keep = new Set();
  const addBase = (p) => { if (p) { try { keep.add(path.basename(p)); } catch (_) {} } };
  addBase(listShotPath);
  for (const u of (units || [])) {
    if (!u) continue;
    addBase(u.screenshotPath);
    (Array.isArray(u.screenshots) ? u.screenshots : []).forEach(addBase);
    (Array.isArray(u.insightsList) ? u.insightsList : []).forEach((ins) => addBase(ins && ins.screenshotPath));
  }
  let files;
  try { files = fs.readdirSync(SCREENSHOTS_DIR); } catch (_) { return; }
  let removed = 0;
  for (const f of files) {
    // Only ever touch our own uptake_*.png artifacts; leave everything else.
    if (!/^uptake_.*\.png$/i.test(f)) continue;
    if (keep.has(f)) continue;
    try { fs.unlinkSync(path.join(SCREENSHOTS_DIR, f)); removed++; } catch (_) {}
  }
  if (removed) flog(`[Uptake] Pruned ${removed} stale screenshot(s); kept ${keep.size}`);
}

// ─── Click "Amazon SSO" ───────────────────────────────────────────────────────
const CLICK_SSO_BUTTON = `(function() {
  try {
    var btns = Array.from(document.querySelectorAll('a,button,[role="button"]'));
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').trim().toLowerCase();
      if (txt.includes('amazon sso') || (txt.includes('amazon') && txt.includes('sso'))) {
        btns[i].click();
        return { clicked: true, text: btns[i].textContent.trim() };
      }
    }
    var all = Array.from(document.querySelectorAll('*'));
    for (var j = 0; j < all.length; j++) {
      var nodes = all[j].childNodes;
      if (nodes.length === 1 && nodes[0].nodeType === 3) {
        var t = nodes[0].textContent.trim().toLowerCase();
        if (t === 'amazon sso' || t.includes('amazon sso')) {
          all[j].click();
          return { clicked: true, fallback: true };
        }
      }
    }
    return { clicked: false, url: window.location.href };
  } catch(e) { return { clicked: false, error: e.message }; }
})()`;

// FIX (2026-07-23): Uptake sometimes shows a one-time "STEP 2: USE AND
// CONSENT" gate after SSO (checkbox + disabled Next button, no SSO button
// at all) which CLICK_SSO_BUTTON can't find, leaving the scraper stuck on
// login.uptake.com until MASTER_TIMEOUT_MS (15 min) kills the run with 0
// units. These two scripts detect/handle that gate as a fallback.
const CLICK_CONSENT_CHECKBOX = `(function() {
  try {
    var bodyText = (document.body.innerText || '').toLowerCase();
    if (!/acknowledge|consent/.test(bodyText)) return { found: false };
    var boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    var box = boxes.find(function(b) { return !b.checked; });
    if (!box) return { found: false };
    box.click();
    return { found: true };
  } catch(e) { return { found: false, error: e.message }; }
})()`;

const CLICK_ENABLED_NEXT_BUTTON = `(function() {
  try {
    var btns = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'));
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var txt = (b.textContent || b.value || '').trim().toLowerCase();
      var disabled = b.disabled || b.getAttribute('aria-disabled') === 'true' || b.classList.contains('disabled');
      if (!disabled && (txt.includes('next') || txt.includes('submit') || txt.includes('continue') || txt.includes('accept'))) {
        b.click();
        return { clicked: true, text: txt };
      }
    }
    return { clicked: false };
  } catch(e) { return { clicked: false, error: e.message }; }
})()`;

// ─── Check insights list table is ready ──────────────────────────────────────
const CHECK_LIST_READY = `(function() {
  var rows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]'));
  return rows.some(function(r) {
    return r.querySelectorAll('td a[href], [role="gridcell"] a[href]').length > 0;
  });
})()`;

// ─── Force all insight rows to load (virtualized/lazy list) ───────────────────
// BUG FIX (2026-08-14): the insights list renders only the first screenful of
// rows (~60 assets / ~71 insight rows) because it's a virtualized/lazy grid.
// SCRAPE_INSIGHTS_LIST previously read the DOM once, so ~half the fleet's ~136
// assets (e.g. unit 322600) were never discovered — they showed no Uptake data
// forever. This scrolls every plausible scroll container (window + any tall
// scrollable ancestor of the table/grid) to the bottom, then reports the
// current row count. runScrape() calls it in a loop until the count stops
// growing, forcing all rows into the DOM before scraping.
const SCROLL_LIST_STEP = `(function() {
  try {
    function rowCount() {
      return Array.from(document.querySelectorAll('table tbody tr, [role="row"]'))
        .filter(function(r) { return r.querySelectorAll('td, [role="gridcell"]').length >= 4; }).length;
    }
    var before = rowCount();
    // Scroll the window itself.
    window.scrollTo(0, document.body.scrollHeight);
    // Scroll any scrollable ancestor of the grid/table, plus the grid itself.
    var anchors = Array.from(document.querySelectorAll('table, [role="grid"], [role="rowgroup"], tbody'));
    anchors.forEach(function(a) {
      var el = a;
      for (var hops = 0; el && hops < 8; hops++) {
        try {
          if (el.scrollHeight > el.clientHeight + 20) { el.scrollTop = el.scrollHeight; }
        } catch(_) {}
        el = el.parentElement;
      }
    });
    // Also scroll the last rendered row into view (helps react-window/virtual grids).
    var rows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]'));
    if (rows.length) { try { rows[rows.length - 1].scrollIntoView({ block: 'end' }); } catch(_) {} }
    return { count: before, height: document.body.scrollHeight };
  } catch(e) { return { count: 0, error: e.message }; }
})()`;

// ─── Scrape insights list table ───────────────────────────────────────────────
const SCRAPE_INSIGHTS_LIST = `(function() {
  try {
    var rows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]'))
      .filter(function(r) { return r.querySelectorAll('td, [role="gridcell"]').length >= 4; });
    if (!rows.length) return { ready: false, count: 0, url: window.location.href };

    var headers = Array.from(document.querySelectorAll('th, [role="columnheader"]'));
    var col = { active:0, insight:1, subsystem:2, asset:3, domicile:4, program:5, assetType:6, maintenanceFactor:7, guidance:8, start:9, last:10 };
    headers.forEach(function(h, i) {
      var t = (h.textContent || '').toLowerCase().trim();
      if      (/still.?active/i.test(t))                col.active            = i;
      else if (/^insight$/i.test(t))                    col.insight           = i;
      else if (/subsystem/i.test(t))                    col.subsystem         = i;
      else if (/^asset$/i.test(t))                      col.asset             = i;
      else if (/domicile/i.test(t))                     col.domicile          = i;
      else if (/program/i.test(t))                      col.program           = i;
      else if (/asset.?type/i.test(t))                  col.assetType         = i;
      else if (/maintenance.?factor/i.test(t))          col.maintenanceFactor = i;
      else if (/guidance/i.test(t))                     col.guidance          = i;
      else if (/insight.?start|first.?detected/i.test(t)) col.start           = i;
      else if (/last.?detected/i.test(t))               col.last              = i;
    });

    var insights = [];
    rows.forEach(function(row) {
      var cells = Array.from(row.querySelectorAll('td, [role="gridcell"]'));
      if (cells.length < 4) return;
      function val(i)  { var c = cells[i]; return c ? c.textContent.trim() : ''; }
      function href(i) {
        var c = cells[i]; if (!c) return '';
        var a = c.querySelector('a[href]'); return a ? a.getAttribute('href') : '';
      }
      var assetText   = val(col.asset);
      var assetId     = (assetText.match(/\\b([A-Za-z]?\\d{4,8})\\b/) || [])[1] || '';
      var assetHref   = href(col.asset);
      var assetUuid   = (assetHref.match(/\\/asset\\/([0-9a-f\\-]{20,})\\//i) || [])[1] || '';
      var insightName = val(col.insight);
      var insightHref = href(col.insight);
      // Fallback: Uptake insight links are React router <a> — getAttribute('href')
      // may return a relative path OR be empty. Scan all row anchors for insight path.
      if (!insightHref) {
        var _rowLinks = Array.from(row.querySelectorAll('a[href]'));
        for (var _li = 0; _li < _rowLinks.length; _li++) {
          var _lh = _rowLinks[_li].getAttribute('href') || '';
          if (_lh && _lh !== '#' && (_lh.includes('insight') || _lh.includes('/assetsInsights'))) {
            insightHref = _lh; break;
          }
        }
        // Last resort: any non-asset non-empty link on this row
        if (!insightHref) {
          for (var _li2 = 0; _li2 < _rowLinks.length; _li2++) {
            var _lh2 = _rowLinks[_li2].getAttribute('href') || '';
            if (_lh2 && _lh2 !== '#' && !_lh2.includes('/asset/')) { insightHref = _lh2; break; }
          }
        }
      }
      var insightUrl = insightHref
        ? (insightHref.startsWith('http') ? insightHref : 'https://fleet.uptake.com' + insightHref)
        : '';
      var activeCell  = cells[col.active];
      var stillActive = activeCell
        ? (!!activeCell.querySelector('svg,[class*="check"],[aria-label*="active" i],[class*="active"]')
           || /^(yes|true|active)$/i.test(activeCell.textContent.trim()))
        : false;
      if (!assetId || !insightName) return;
      insights.push({
        assetId, assetUuid, insightName, insightUrl, stillActive,
        subsystem:         val(col.subsystem),
        domicile:          val(col.domicile),
        program:           val(col.program),
        assetType:         val(col.assetType),
        maintenanceFactor: val(col.maintenanceFactor),
        guidance:          val(col.guidance),
        firstDetected:     val(col.start),
        lastDetected:      val(col.last),
      });
    });
    return { ready: true, count: insights.length, insights, url: window.location.href };
  } catch(e) { return { ready: false, count: 0, error: e.message }; }
})()`;

// ─── Check insight detail page is rendered ────────────────────────────────────
// The real page structure uses _uav-tabs__content_17lrh_785 containing
// _insight-details__action_1ba7f_897 blocks. We just need body > 300 chars
// AND the insight-details data row to be present.
const CHECK_DETAIL_READY = `(function() {
  // BUG FIX (2026-08-12): the original check used obfuscated hash-suffixed class
  // names (_insight-details__action_1ba7f_897 etc.) that broke when Uptake
  // redeployed their SPA — every detail page timed out, no screenshots taken.
  // New check: body > 1800 chars (nav shell alone is ~892; a rendered insight
  // card with title + subsystem + at least one content section reliably exceeds
  // 1800). Also accepts any div with class containing "insight" that has
  // substantial text, as a secondary signal. No hash suffixes anywhere.
  var bodyLen = (document.body ? document.body.innerText : '').trim().length;
  if (bodyLen < 1800) return false;
  // Secondary: look for any element whose class contains "insight" with real text
  var insightEls = Array.from(document.querySelectorAll('[class*="insight"]'));
  return insightEls.some(function(el) {
    return (el.innerText || el.textContent || '').trim().length > 100;
  });
})()`;

// ─── Scrape insight detail page ───────────────────────────────────────────────
// Class names confirmed from live DOM dump of fleet.uptake.com:
//   _insight-details__title_1ba7f_863  → label cells (GUIDANCE:, SUBSYSTEM:, TYPE:, etc.)
//   _insight-details__value_1ba7f_942  → value cells
//   _insight-details__status_1ba7f_870 → status wrapper
//   _insight-details__heading_1ba7f_873 → section headings (SUMMARY, RECOMMENDED ACTION)
//   _insight-details__markdown_1ba7f_902 → the actual text under each heading
//   _insight-details__action_1ba7f_897  → section wrapper (contains heading + value + markdown)
// Risk score is NOT on the insight detail page — it's on the asset overview tab.
const SCRAPE_INSIGHT_DETAIL = `(function() {
  try {
    function gt(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }

    function parseDataRow() {
      var out = { guidance:'', subsystem:'', type:'', firstDetected:'', lastDetected:'', status:'' };
      var titleEls = document.querySelectorAll('._insight-details__title_1ba7f_863');
      var valueEls = document.querySelectorAll('._insight-details__value_1ba7f_942');
      titleEls.forEach(function(titleEl, idx) {
        var label = gt(titleEl).toUpperCase();
        var valEl = titleEl.nextElementSibling;
        if (!valEl || !valEl.className.includes('value')) valEl = valueEls[idx] || null;
        var val = valEl ? gt(valEl) : '';
        if (/^GUIDANCE/.test(label))             out.guidance      = val;
        else if (/^SUBSYSTEM/.test(label))        out.subsystem     = val;
        else if (/^TYPE/.test(label))             out.type          = val;
        else if (/^FIRST.DETECTED/.test(label))   out.firstDetected = val;
        else if (/^LAST.DETECTED/.test(label))    out.lastDetected  = val;
      });
      var statusEl = document.querySelector('._insight-details__status_1ba7f_870 ._insight-details__value_1ba7f_942');
      if (statusEl) out.status = gt(statusEl);
      return out;
    }

    // ── Diagnostic: what does the page actually contain? ──────────────────
    var diagActionSecs = document.querySelectorAll('._insight-details__action_1ba7f_897');
    var diagMarkdowns  = document.querySelectorAll('._insight-details__markdown_1ba7f_902');
    var diagHeadings   = document.querySelectorAll('._insight-details__heading_1ba7f_873');
    var diagInfo = {
      actionSecCount:   diagActionSecs.length,
      markdownCount:    diagMarkdowns.length,
      headingCount:     diagHeadings.length,
      headingTexts:     Array.from(diagHeadings).map(function(h){ return gt(h).slice(0,60); }),
      markdownTexts:    Array.from(diagMarkdowns).map(function(m){ return gt(m).slice(0,120); }),
      // Also try broad fallback — any element with "action" in class
      broadActionCount: document.querySelectorAll('[class*="action"]').length,
      broadMarkdownCount: document.querySelectorAll('[class*="markdown"]').length,
      // Check if the class hash might have changed — look for ANY insight-details class
      insightDetailClasses: Array.from(new Set(
        Array.from(document.querySelectorAll('[class*="_insight-details"]'))
          .map(function(el){ return Array.from(el.classList).filter(function(c){ return c.includes('_insight-details'); }); })
          .reduce(function(a,b){ return a.concat(b); }, [])
      )).slice(0, 30),
      url: window.location.href,
    };

    // ── Parse action sections ──────────────────────────────────────────────
    var summary = '', recommended = '';
    var actionSections = document.querySelectorAll('._insight-details__action_1ba7f_897');
    actionSections.forEach(function(sec) {
      var headingEl = sec.querySelector('._insight-details__heading_1ba7f_873');
      var heading = headingEl ? gt(headingEl).toUpperCase().trim() : '';
      var markdownEl = sec.querySelector('._insight-details__markdown_1ba7f_902');
      var text = markdownEl ? gt(markdownEl).trim() : '';
      if (!text) {
        // fallback: try broad class search within this section
        var broadMd = sec.querySelector('[class*="markdown"]');
        if (broadMd) text = gt(broadMd).trim();
      }
      if (!text) {
        var valEl = sec.querySelector('._insight-details__value_1ba7f_942');
        text = valEl ? gt(valEl).trim() : '';
      }
      if (/^SUMMARY/.test(heading) && text.length > 5)     summary     = text.slice(0, 3000);
      else if (/RECOMMENDED/.test(heading) && text.length > 5) recommended = text.slice(0, 3000);
    });

    // ── Broad fallback: if still empty, scan all [class*="markdown"] ──────
    if (!summary && !recommended) {
      var allMd = Array.from(document.querySelectorAll('[class*="markdown"]'));
      allMd.forEach(function(md) {
        var txt = gt(md).trim();
        if (txt.length < 10) return;
        // look at nearby heading
        var parent = md.parentElement;
        var prevSib = parent ? parent.previousElementSibling : null;
        var headTxt = (prevSib ? gt(prevSib) : '').toUpperCase();
        if (/SUMMARY/.test(headTxt) && !summary)         summary     = txt.slice(0,3000);
        else if (/RECOMMENDED/.test(headTxt) && !recommended) recommended = txt.slice(0,3000);
        else if (!summary && !recommended)                summary     = txt.slice(0,3000);
      });
    }

    var dataRow = parseDataRow();
    return {
      riskScore: null, riskLabel: '', vin: '', model: '', modelYear: '',
      manufacturer: '', fuelType: '', tsp: '', operator: '', domicilesite: '',
      region: '', lastData: '',
      guidance: dataRow.guidance, status: dataRow.status,
      subsystem: dataRow.subsystem, insightType: dataRow.type,
      firstDet: dataRow.firstDetected, lastDet: dataRow.lastDetected,
      summary: summary, recommended: recommended,
      bodyLen: (document.body ? document.body.innerText : '').length,
      url: window.location.href,
      _diag: diagInfo,
    };
  } catch(e) {
    return { error: e.message, riskScore: null, vin:'', model:'', summary:'', recommended:'', bodyLen:0 };
  }
})()`;

// ─── Re-scrape text after any Read More expansion (same selectors) ────────────
const SCRAPE_AFTER_READMORE = `(function() {
  function gt(el) { return el ? (el.innerText || el.textContent || '').trim() : ''; }
  var summary = '', recommended = '';
  var actionSections = document.querySelectorAll('._insight-details__action_1ba7f_897');
  actionSections.forEach(function(sec) {
    var headingEl = sec.querySelector('._insight-details__heading_1ba7f_873');
    var heading = headingEl ? gt(headingEl).toUpperCase().trim() : '';
    var markdownEl = sec.querySelector('._insight-details__markdown_1ba7f_902');
    var text = markdownEl ? gt(markdownEl).trim() : '';
    if (!text) {
      var broadMd = sec.querySelector('[class*="markdown"]');
      if (broadMd) text = gt(broadMd).trim();
    }
    if (!text) {
      var valEl = sec.querySelector('._insight-details__value_1ba7f_942');
      text = valEl ? gt(valEl).trim() : '';
    }
    if (/^SUMMARY/.test(heading) && text.length > 5)      summary     = text.slice(0,3000);
    if (/RECOMMENDED/.test(heading) && text.length > 5)   recommended = text.slice(0,3000);
  });
  return { summary: summary, recommended: recommended };
})()`;


// ══════════════════════════════════════════════════════════════════════════════
// API-BASED SCRAPE (UPTAKE_API=1) — reliable JSON path, DOM scrape stays fallback
// ──────────────────────────────────────────────────────────────────────────────
// Discovered 2026-10-14 (CDP netlog): the Uptake SPA is backed by a clean JSON
// API authed by the SAME in-app Midway/AEA session cookies. Hitting it directly
// is far more reliable than scraping a virtualized/Read-More DOM, and it fixes
// the "missing insight" bug: the SPA's per-asset insights/search sends a ~30-day
// lastDetectedLowerBound, which silently drops older insights (e.g. unit 622086's
// 3rd insight, lastDetected 8/27). We widen that window so ALL instances return.
//
// Endpoints (host fleet.uptake.com):
//   POST /api/asset-ui/v4/assets/insights?page=N&responseFormat=page&size=100&sort=endTs,desc  {insightQuery:{}}
//   POST /api/asset-ui/v1/assets/<uuid>/insights/search?responseFormat=array&sort=startTs,desc  {insightQuery:{lastDetectedLowerBound}}
//   GET  /api/asset-ui/assets/<uuid>/summary
// Screenshots: navigate to /asset/<uuid>/insights/<insightId> and capturePage()
// (same mechanism as the DOM path, but with exact IDs the API hands us).

const UPTAKE_API_BASE = 'https://fleet.uptake.com';
// How far back to look for per-asset insights. The SPA uses ~30d; we widen to
// 365d so older-but-still-relevant insights (like 622086's) are not dropped.
const UPTAKE_API_LOOKBACK_DAYS = 365;
const UPTAKE_API_PAGE_SIZE = 100;
// Bounded screenshot pass (screenshots are enrichment; the data is the win).
const UPTAKE_API_SHOT_MIN_RISK = 80;      // only screenshot high-risk insights
const UPTAKE_API_SHOT_CAP = 80;           // hard cap on total screenshots/run
const UPTAKE_API_SHOT_BUDGET_MS = 5 * 60 * 1000;  // 5-min time budget for the pass

// Run a fetch INSIDE the authed Uptake window so it carries the session cookies.
// Returns { ok, status, json|text, error }. Never throws.
async function apiFetch(win, url, method = 'GET', body = null, deps = null) {
  const authHeader = deps && deps.authHeader;
  const extra = (deps && deps.extraHeaders) || {};
  const headersObj = Object.assign(
    { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    authHeader ? { 'Authorization': authHeader } : {},
    extra
  );
  const expr = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(headersObj)},
        credentials: 'include',
        ${body != null ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
      });
      const ct = res.headers.get('content-type') || '';
      const txt = await res.text();
      let json = null;
      if (/json/i.test(ct)) { try { json = JSON.parse(txt); } catch(_) {} }
      return { ok: res.ok, status: res.status, json: json, text: json ? null : txt.slice(0, 2000) };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  })()`;
  try {
    const r = await win.webContents.executeJavaScript(expr);
    return r || { ok: false, status: 0, error: 'no result' };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// Fetch a binary (PNG) INSIDE the authed window and return it as a base64
// string, so we can save the real fault-chart image directly instead of
// navigating + capturePage per insight. Returns { ok, base64, status, error }.
async function apiFetchImage(win, url, deps = null) {
  const authHeader = deps && deps.authHeader;
  const headersObj = Object.assign(
    { 'Accept': 'image/png,image/*,*/*' },
    authHeader ? { 'Authorization': authHeader } : {}
  );
  const expr = `(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, {
        method: 'GET',
        headers: ${JSON.stringify(headersObj)},
        credentials: 'include',
      });
      if (!res.ok) return { ok: false, status: res.status };
      const ct = res.headers.get('content-type') || '';
      // The media endpoint serves the PNG as binary/octet-stream (not image/*),
      // so accept octet-stream too; reject only obvious non-binary (html/json).
      if (/text\\/html|application\\/json/i.test(ct)) return { ok: false, status: res.status, error: 'not-image:' + ct };
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Verify it's actually a PNG (magic bytes 0x89 'P' 'N' 'G').
      const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
      if (!isPng) return { ok: false, status: res.status, error: 'not-png:' + ct + ':' + bytes.length + 'b' };
      // Chunked base64 — a per-byte String.fromCharCode loop blows up on the
      // large charts (observed 6+ MB); build in 32KB chunks instead.
      let binary = ''; const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      }
      return { ok: true, status: res.status, base64: btoa(binary), ct: ct, bytes: bytes.length };
    } catch (e) { return { ok: false, status: 0, error: String(e && e.message || e) }; }
  })()`;
  try {
    const r = await win.webContents.executeJavaScript(expr);
    return r || { ok: false, status: 0, error: 'no result' };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// Resolve an insight media file link (relative, e.g.
// "supporting_evidence/<id>/1_fault_chart_fig.png") to the media endpoint URL.
// CONFIRMED from a live network capture (2026-10-14): the SPA fetches
//   GET /api/media/insights?file=<mediaFileLink>
// so ?file= is the real param. Keep the other shapes as fallbacks just in case.
function mediaUrlCandidates(mediaFileLink) {
  const link = String(mediaFileLink || '').replace(/^\/+/, '');
  if (!link) return [];
  const enc = encodeURIComponent(link);
  // CONFIRMED shape: /api/media/insights?file=<link> (returns the PNG as
  // binary/octet-stream). Only this one is needed.
  return [
    `${UPTAKE_API_BASE}/api/media/insights?file=${enc}`,
  ];
}

// Map one API insights/search array element -> our insightsList entry shape.
function mapApiInsight(el, assetUuid) {
  const ai  = (el && el.assetInsight) || {};
  const ins = ai.insight || {};
  const meta = ins.insightMetadata || {};
  const insightId = ins.insightId || ai.assetInsightId || '';
  const url = (assetUuid && insightId)
    ? `${UPTAKE_API_BASE}/asset/${assetUuid}/insights/${insightId}`
    : '';
  // ALL chart image links (image/png) from the insight media array, so the
  // screenshot pass can fetch every chart directly (no page render). An insight
  // can carry MORE than one PNG — e.g. "1_fault_chart_fig.png" AND
  // "2_line_chart_fig.png" (a fault chart + a trend/line chart). We collect
  // them all (sorted by the leading index) instead of just the first.
  const mediaArr = Array.isArray(ins.media) ? ins.media : [];
  const mediaPngs = mediaArr
    .filter((m) => m && m.mediaFileLink && (/image\/png/i.test(m.mediaDataType || '') || /\.png$/i.test(m.mediaFileLink)))
    .map((m) => m.mediaFileLink)
    .sort();   // "1_...png" before "2_...png"
  const mediaPng = mediaPngs[0] || '';   // kept for backward compat
  return {
    title:             meta.title || '',
    url,
    subsystem:         meta.riskFactor || '',
    guidance:          meta.recommendedAction || '',
    status:            el.actionState || '',
    type:              meta.insightCategory || '',
    maintenanceFactor: meta.riskFactor || '',
    firstSeen:         ins.startTs || '',
    lastSeen:          ins.endTs || '',
    stillActive:       !!ins.visibleInUi,
    summary:           meta.description || '',
    recommended:       meta.recommendedAction || '',
    screenshotPath:    '',
    // internal — used by the screenshot pass, stripped from final shape only if needed
    _assetUuid:        assetUuid,
    _insightId:        insightId,
    _mediaPng:         mediaPng,
    _mediaPngs:        mediaPngs,
    severity:          ai.severity || meta.severity || '',
    riskScore:         (ai.riskScore != null ? ai.riskScore : null),
  };
}

// Build the per-asset attribute block from the API asset object.
function mapApiAsset(assetObj) {
  const a = (assetObj && assetObj.attributes) || {};
  return {
    vin:          a.Vin || a.vin || '',
    model:        a.modelname || a.Model || '',
    modelYear:    a['Model Year'] || a.yearmanufactured || '',
    manufacturer: a.manufacturername || a.Make || '',
    fuelType:     a.fueltype || a['Fuel Type'] || '',
    operator:     a.operator || '',
    domicile:     a.domicilesite || '',
    assetType:    a.assettype || '',
    tsp:          a.TSP || '',
    customerName: (assetObj && assetObj.customerAssetName) || '',
  };
}

// Core API scrape. deps = { win, finish, navTo, captureScreenshot, sleep, setLiveMap }
async function runApiScrape(deps) {
  const { win, finish, navTo, sleep, setLiveMap } = deps;
  try {
    flog('[Uptake][API] Starting API scrape (UPTAKE_API=1)...');

    // ── 0. Capture the SPA's real auth via CDP ────────────────────────────
    // The asset-ui API needs the Authorization bearer the SPA attaches via an
    // in-memory interceptor (NOT in storage/cookies — confirmed: credentials-
    // only fetch got 401). A JS fetch/XHR wrapper to sniff it raced the SPA
    // and was flaky. Instead, attach the Chrome DevTools Protocol and read the
    // Authorization header + userSavedFilterId straight off the SPA's OWN
    // asset-ui requests on the wire — reliable, no race. Then re-navigate so
    // the SPA fires those requests and we capture.
    let capturedAuth = null;
    let capturedFilterId = null;
    let dbgAttached = false;
    const dbg = win.webContents.debugger;
    try {
      if (dbg.isAttached()) {
        // A prior attach (DevTools or a previous scrape cycle) is still live.
        // Reuse it rather than failing — just (re)enable Network.
        dbgAttached = false; // don't detach something we didn't attach
      } else {
        dbg.attach('1.3');
        dbgAttached = true;
      }
      await dbg.sendCommand('Network.enable');
      dbg.on('message', (_e, method, params) => {
        try {
          if (method !== 'Network.requestWillBeSent') return;
          const u = (params.request && params.request.url) || '';
          if (!/\/api\/asset-ui\//.test(u)) return;
          const h = params.request.headers || {};
          const a = h.Authorization || h.authorization;
          if (a && /bearer/i.test(a)) capturedAuth = a;
          const m = u.match(/userSavedFilterId=([0-9a-f-]+)/i);
          if (m) capturedFilterId = m[1];
        } catch (_) {}
      });
    } catch (e) {
      fwarn('[Uptake][API] CDP attach failed (' + e.message + ') — cannot capture auth, aborting API path');
      finish([], null);
      return;
    }

    // Re-navigate so the SPA re-issues its authed asset-ui calls on the wire.
    // The insights list route is what fires the saved-filter list call
    // (v4/assets/insights?...userSavedFilterId=...). We must capture BOTH the
    // bearer AND that filter id — the bearer alone appears on earlier
    // unfiltered calls (summary/metadata), so breaking on auth-only misses the
    // filter and would (dangerously) pull the whole tenant. So: wait for BOTH,
    // and if only auth lands, nudge via a different route then back to force a
    // fresh filtered list fetch.
    try { await navTo(UPTAKE_INSIGHTS_URL); } catch (_) {}
    let nudged = false;
    for (let t = 0; t < 30 && !win.isDestroyed() && !deps.settled(); t++) {
      await sleep(1500);
      if (capturedAuth && capturedFilterId) break;
      // Halfway through, if we have auth but still no filter, force the list to
      // re-fetch by bouncing to the assets route and back to insights.
      if (!capturedFilterId && capturedAuth && !nudged && t >= 6) {
        nudged = true;
        try { await navTo('https://fleet.uptake.com/assetsInsightsCases/assets'); } catch (_) {}
        await sleep(1200);
        try { await navTo(UPTAKE_INSIGHTS_URL); } catch (_) {}
      }
    }
    try { if (dbgAttached) dbg.detach(); } catch (_) {}

    deps.authHeader = capturedAuth;        // used by apiFetch below
    deps.extraHeaders = {};
    deps.filterId = capturedFilterId;      // scopes the fleet list to the user's saved filter
    flog('[Uptake][API] captured bearer: ' + (capturedAuth ? ('yes (' + capturedAuth.length + ' chars)') : 'NO')
      + ' | savedFilterId: ' + (capturedFilterId || 'none'));

    // Verify the captured auth actually works against the API.
    const probeUrl = `${UPTAKE_API_BASE}/api/asset-ui/v4/assets/insights`
      + `?page=0&responseFormat=page&size=1&sort=endTs%2Cdesc`;
    let authed = false;
    for (let t = 0; t < 8 && !win.isDestroyed() && !deps.settled(); t++) {
      const pr = await apiFetch(win, probeUrl, 'POST', { insightQuery: {} }, deps);
      if (pr.ok && pr.json) { authed = true; break; }
      await sleep(1500);
    }
    if (!authed) {
      fwarn('[Uptake][API] API still not authorized after capturing SPA auth — aborting API path (DOM fallback remains)');
      finish([], null);
      return;
    }
    flog('[Uptake][API] session authed — fetching fleet insights...');

    // ── 1. Fleet-wide insights list (paginated) ───────────────────────────
    // Gives us the set of assets that currently have insights.
    const assetUuids = new Set();
    const assetObjById = {};   // uuid -> asset object (for attributes)
    let page = 0, totalPages = 1, totalInsights = 0;
    const filterQ = deps.filterId ? `&userSavedFilterId=${deps.filterId}` : '';
    do {
      const url = `${UPTAKE_API_BASE}/api/asset-ui/v4/assets/insights`
        + `?page=${page}&responseFormat=page&size=${UPTAKE_API_PAGE_SIZE}&sort=endTs%2Cdesc${filterQ}`;
      const r = await apiFetch(win, url, 'POST', { insightQuery: {} }, deps);
      if (!r.ok || !r.json) {
        fwarn(`[Uptake][API] fleet list page ${page} failed: status=${r.status} ${r.error || ''}`);
        break;
      }
      const d = r.json;
      const content = d.content || d.data || d.items || (Array.isArray(d) ? d : []);
      if (page === 0) {
        totalPages = d.totalPages || 1;
        totalInsights = d.totalElements || content.length;
        flog(`[Uptake][API] fleet insights: totalElements=${totalInsights} totalPages=${totalPages} (filter=${deps.filterId || 'NONE'})`);
        // Safety: without the saved filter this returns the ENTIRE tenant
        // (observed ~29k insights / 292 pages). That's not the user's fleet
        // and must never be paged. Abort to the DOM fallback instead.
        if (!deps.filterId && totalPages > 10) {
          fwarn(`[Uptake][API] no saved filter captured and tenant list is huge (${totalInsights} insights) — aborting API path to avoid scraping the whole tenant`);
          finish([], null);
          return;
        }
      }
      content.forEach(el => {
        // v4 fleet-list elements have asset/insight at the TOP LEVEL (unlike the
        // per-asset insights/search element, which nests them under
        // `assetInsight`). Handle both shapes.
        const asset = (el && el.asset) || (el && el.assetInsight && el.assetInsight.asset) || {};
        const uuid = asset.assetId;
        if (uuid) { assetUuids.add(uuid); if (!assetObjById[uuid]) assetObjById[uuid] = asset; }
      });
      page++;
    } while (page < totalPages && page < 20 && !win.isDestroyed() && !deps.settled());

    flog(`[Uptake][API] discovered ${assetUuids.size} unique assets with insights`);
    if (!assetUuids.size) { finish([], null); return; }

    // ── 2. Per-asset: insights/search (WIDE window) + summary ──────────────
    const lowerBound = new Date(Date.now() - UPTAKE_API_LOOKBACK_DAYS * 86400000).toISOString();
    const unitMap = {};
    setLiveMap(unitMap);
    const uuids = Array.from(assetUuids);
    for (let i = 0; i < uuids.length; i++) {
      if (win.isDestroyed() || deps.settled()) break;
      const uuid = uuids[i];

      // 2a. insights array (all instances within the wide window)
      const searchUrl = `${UPTAKE_API_BASE}/api/asset-ui/v1/assets/${uuid}/insights/search`
        + `?responseFormat=array&sort=startTs%2Cdesc`;
      const sr = await apiFetch(win, searchUrl, 'POST', { insightQuery: { lastDetectedLowerBound: lowerBound } }, deps);
      let arr = (sr.ok && Array.isArray(sr.json)) ? sr.json : [];

      // asset attributes come from the search payload (richest) or the list
      let assetObj = assetObjById[uuid];
      if (arr.length && arr[0].assetInsight && arr[0].assetInsight.asset) {
        assetObj = arr[0].assetInsight.asset;
      }
      const attrs = mapApiAsset(assetObj || {});
      const unitId = attrs.customerName || (assetObj && assetObj.customerAssetName) || uuid;

      // 2b. summary (risk score)
      let riskScore = null, riskLabel = '';
      const sumUrl = `${UPTAKE_API_BASE}/api/asset-ui/assets/${uuid}/summary`;
      const sum = await apiFetch(win, sumUrl, 'GET', null, deps);
      if (sum.ok && sum.json) {
        const sj = sum.json;
        const rs = sj.riskScore != null ? sj.riskScore
                 : (sj.risk && sj.risk.score != null ? sj.risk.score : null);
        if (rs != null) riskScore = Math.round(Number(rs));
        riskLabel = sj.riskLabel || (sj.risk && sj.risk.label) || '';
      }
      // fallback: max insight riskScore if summary lacked one
      if (riskScore == null && arr.length) {
        const scores = arr.map(e => e.assetInsight && e.assetInsight.riskScore).filter(x => x != null);
        if (scores.length) riskScore = Math.round(Math.max.apply(null, scores));
      }

      const insightsList = arr.map(el => mapApiInsight(el, uuid));
      const subsystems = Array.from(new Set(insightsList.map(x => x.subsystem).filter(Boolean)));

      unitMap[unitId] = {
        id:           unitId,
        assetUuid:    uuid,
        riskScore:    riskScore,
        riskLabel:    riskLabel,
        openCases:    0,
        insightCount: insightsList.length,
        vin:          attrs.vin,
        model:        attrs.model,
        modelYear:    attrs.modelYear,
        manufacturer: attrs.manufacturer,
        fuelType:     attrs.fuelType,
        tsp:          attrs.tsp,
        operator:     attrs.operator,
        domicile:     attrs.domicile,
        assetType:    attrs.assetType,
        region:       '',
        lastDataDate: '',
        insightsList: insightsList,
        subsystems:   subsystems,
        screenshots:  [],
      };
      flog(`[Uptake][API] ${i + 1}/${uuids.length} asset ${unitId}: ${insightsList.length} insight(s), risk=${riskScore}`);
    }

    // ── 3. Screenshot pass — direct media PNG for ALL insights ────────────
    // CONFIRMED the chart media URL: GET /api/media/insights?file=<link>. We
    // fetch each insight's fault-chart PNG directly (fast binary fetch, no page
    // render) — so we can screenshot EVERY insight, not just high-risk ones,
    // in seconds instead of the ~30-min capturePage pass. capturePage remains
    // only as a BOUNDED fallback for insights that have no media (rare), so a
    // few slow captures can't blow up the run.
    let listShot = null;
    try {
      await navTo(UPTAKE_INSIGHTS_URL);
      await sleep(1500);
      listShot = await deps.captureScreenshot(win, 'insights_list');
    } catch (_) {}

    const saveB64Png = (base64, label) => {
      try {
        const buf = Buffer.from(base64, 'base64');
        if (buf.length < 1000) return null;      // too small = not a real chart
        const file = path.join(SCREENSHOTS_DIR, `uptake_insight_${label}_${Date.now()}.png`);
        fs.writeFileSync(file, buf);
        return file;
      } catch (_) { return null; }
    };

    const allUnits = Object.values(unitMap);
    let shotIdx = 0, mediaOk = 0, capOk = 0, mediaWinIdx = -1, capAttempts = 0;
    const shotStart = Date.now();
    for (const u of allUnits) {
      if (win.isDestroyed() || deps.settled()) break;
      for (let j = 0; j < u.insightsList.length; j++) {
        if (win.isDestroyed() || deps.settled()) break;
        const ins = u.insightsList[j];
        let saved = null;        // -> ins.screenshotPath
        const insShots = [];

        // 3a. PRIMARY: fetch the insight's fault-chart PNG — the reliable
        // raw-bytes path (the one that consistently hit ~582/619). ONE PNG per
        // insight. (The Summary + Recommended Actions text is shown ABOVE the
        // chart in the app UI (unit-detail Intel pane) rather than burned into
        // the image — drawing text on the image via canvas proved unreliable at
        // this volume. The text is also copyable there.)
        const link = (Array.isArray(ins._mediaPngs) && ins._mediaPngs.length)
          ? ins._mediaPngs[0] : ins._mediaPng;
        if (link) {
          const cu = mediaUrlCandidates(link)[0];
          const img = cu ? await apiFetchImage(win, cu, deps) : { ok: false };
          if (img.ok && img.base64) {
            if (mediaWinIdx < 0) { mediaWinIdx = 0; flog('[Uptake][API] media confirmed (raw PNG)'); }
            const file = saveB64Png(img.base64, `${u.id}_${shotIdx}`);
            if (file) { insShots.push(file); mediaOk++; }
          }
        }
        if (insShots.length) saved = insShots[0];

        // 3b. Fallback: capturePage — BOUNDED (only for no-media insights, and
        // only up to the cap/budget so slow captures can't dominate).
        if (!saved && ins.url
            && capAttempts < UPTAKE_API_SHOT_CAP
            && (Date.now() - shotStart) < UPTAKE_API_SHOT_BUDGET_MS) {
          capAttempts++;
          try {
            await navTo(ins.url);
            await pollUntil(win, CHECK_DETAIL_READY, 600, 20);
            await sleep(1200);
            const file = await deps.captureScreenshot(win, `insight_${u.id}_${shotIdx}`);
            if (file) { insShots.push(file); saved = file; capOk++; }
          } catch (e) {
            fwarn(`[Uptake][API] capturePage fallback failed for ${u.id}/${ins.title}: ${e.message}`);
          }
        }

        if (saved) ins.screenshotPath = saved;        // primary chart
        if (insShots.length) {
          ins.screenshots = insShots.slice();          // ALL charts for this insight
          insShots.forEach((f) => u.screenshots.push(f));
        }
        shotIdx++;
      }
    }
    flog(`[Uptake][API] screenshots: ${mediaOk} via media-PNG + ${capOk} via capturePage fallback, ${shotIdx} insights in ${Math.round((Date.now() - shotStart) / 1000)}s`);

    // strip internal fields before returning
    allUnits.forEach(u => u.insightsList.forEach(ins => { delete ins._assetUuid; delete ins._insightId; delete ins._mediaPng; delete ins._mediaPngs; }));

    flog(`[Uptake][API] Done — ${allUnits.length} units, risks: ${allUnits.filter(u => u.riskScore != null).length} found`);
    finish(allUnits, listShot);
  } catch (e) {
    fwarn('[Uptake][API] runApiScrape error:', e.message);
    finish([], null);
  }
}


// ─── Main scrape function ─────────────────────────────────────────────────────
async function scrapeUptake() {
  // H-3: block duplicate concurrent scrapes
  if (_uptakeLock) {
    fwarn('[Uptake] scrapeUptake() already in progress — aborting duplicate call');
    return { units: [], count: 0, scrapedAt: new Date().toISOString(), _skipped: true };
  }
  _uptakeLock = true;
  try {
  return await new Promise((resolve) => {
    let settled  = false;
    let authDone = false;
    // BUG FIX (2026-07-14): live reference to the in-progress unitMap, set once
    // runScrape() creates it (see below). Lets the master-timeout handler
    // salvage whatever was actually scraped so far instead of discarding all
    // progress -- see masterTimer below.
    let _liveUnitMap = null;

    // Fully background window — Electron 30 capturePage() works without being visible.
    const win = new BrowserWindow({
      show:        false,
      skipTaskbar: true,
      width:       1440,
      height:      900,
      webPreferences: {
        nodeIntegration:  false,
        contextIsolation: true,
        partition:        PARTITION,
        zoomFactor:       0.9,   // slight zoom-out so full insight panel renders without clipping
      },
    });

    if (DEBUG) {
      win.setPosition(100, 100);
      win.webContents.openDevTools({ mode: 'right' });
    }

    // ── TEMP API DISCOVERY PROBE (env-gated: UPTAKE_NETLOG=1) ────────────────
    // Goal: find a RELIABLE JSON/GraphQL API behind the Uptake SPA that we
    // could call directly instead of scraping the deduped/virtualized DOM
    // (the DOM list collapses same-title insights, e.g. unit 622086's two
    // "Engine Crankcase Breather Speed" rows -> only one scraped). This runs
    // INSIDE the authenticated Uptake window, so it uses the real Midway/AEA
    // session (no separate Chromium/login needed).
    //
    // webRequest alone can't read response BODIES, so we attach the Chrome
    // DevTools Protocol (webContents.debugger) and enable Network to capture
    // request + response body for every *.uptake.com API call. Everything is
    // written to uptake-api-discovery.json for inspection. Zero effect unless
    // UPTAKE_NETLOG=1. Fully wrapped in try/catch — never breaks a real scrape.
    if (process.env.UPTAKE_NETLOG === '1') {
      try {
        const _path = require('path');
        const _fs   = require('fs');
        const _app  = require('electron').app;
        const _outFile = _path.join(_app.getPath('userData'), 'uptake-api-discovery.json');
        const _apiRe = /(?:^|\.)uptake\.com/i;
        // skip static assets / telemetry noise; keep API/graphql/data calls
        const _isApi = (u) =>
          _apiRe.test(u) &&
          /\/(api|graphql|insight|asset|case|fault|v\d|data|query)/i.test(u) &&
          !/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(u) &&
          !/(segment|datadog|newrelic|sentry|analytics|telemetry|google|gtag)/i.test(u);

        const _calls = new Map();   // requestId -> {method,url,reqBody,...}
        const _dump = () => {
          try {
            const arr = Array.from(_calls.values());
            const uniq = Array.from(new Set(arr.map(c => c.method + ' ' + (c.url||'').split('?')[0])));
            _fs.writeFileSync(_outFile, JSON.stringify({
              capturedAt: new Date().toISOString(),
              uniqueEndpoints: uniq,
              callCount: arr.length,
              calls: arr,
            }, null, 2));
          } catch (_) {}
        };

        const dbg = win.webContents.debugger;
        dbg.attach('1.3');
        dbg.sendCommand('Network.enable');

        dbg.on('message', (_e, method, params) => {
          try {
            if (method === 'Network.requestWillBeSent') {
              const u = params.request && params.request.url || '';
              if (_isApi(u)) {
                _calls.set(params.requestId, {
                  method: params.request.method,
                  url: u,
                  reqBody: params.request.postData || null,
                  reqHeaders: {
                    authorization: params.request.headers && params.request.headers['authorization'] ? '(present)' : undefined,
                    'content-type': params.request.headers && params.request.headers['content-type'],
                    accept: params.request.headers && params.request.headers['accept'],
                  },
                  status: null, respType: null, respBody: null,
                });
                flog('[Uptake][NETLOG]', params.request.method, u);
              }
            } else if (method === 'Network.responseReceived') {
              const c = _calls.get(params.requestId);
              if (c) {
                c.status = params.response.status;
                c.respType = params.response.mimeType;
              }
            } else if (method === 'Network.loadingFinished') {
              const c = _calls.get(params.requestId);
              if (c && /json|graphql|text/i.test(c.respType || '')) {
                dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId })
                  .then((res) => {
                    let body = res.body || '';
                    if (res.base64Encoded) { try { body = Buffer.from(body, 'base64').toString('utf8'); } catch(_){} }
                    // cap stored body so the file stays readable
                    c.respBody = body.length > 20000 ? body.slice(0, 20000) + '…[truncated]' : body;
                    flog('[Uptake][NETLOG]   <-', c.status, c.respType, '(' + body.length + ' bytes)', c.url.split('?')[0]);
                    _dump();
                  })
                  .catch(() => {});
              }
            }
          } catch (_) {}
        });

        dbg.on('detach', () => { try { _dump(); } catch(_){} });
        flog('[Uptake][NETLOG] CDP API-discovery probe attached (UPTAKE_NETLOG=1) -> ' + _outFile);
      } catch (e) {
        fwarn('[Uptake][NETLOG] failed to attach CDP probe:', e.message);
      }
    }

    const masterTimer = setTimeout(() => {
      // BUG FIX (2026-07-14): used to hardcode finish([], null), discarding
      // whatever had already been scraped (observed live: 36/55 detail pages
      // successfully done, then thrown away, returning 0 units). Salvage any
      // units that got at least one real insight recorded instead.
      const partial = _liveUnitMap
        ? Object.values(_liveUnitMap).filter(function(u){ return u.insightsList && u.insightsList.length; })
        : [];
      fwarn('[Uptake] Master timeout -- salvaging ' + partial.length + ' partially-scraped unit(s) (of ' + (_liveUnitMap ? Object.keys(_liveUnitMap).length : 0) + ' discovered)');
      finish(partial, null);
    }, MASTER_TIMEOUT_MS);

    const finish = (units, screenshotPath) => {
      if (settled) return;
      settled = true;
      clearTimeout(masterTimer);
      try { win.destroy(); } catch(_) {}
      const arr = Array.isArray(units) ? units : [];
      flog(`[Uptake] Finished — ${arr.length} units`);
      // Prune stale screenshots ONLY on a real, non-empty scrape — never when
      // salvaging a partial/empty run (that would wipe the still-good cache's
      // images). Keep exactly the files this run referenced.
      if (arr.length > 0) {
        try { pruneScreenshots(arr, screenshotPath); } catch (e) { fwarn('[Uptake] prune skipped:', e.message); }
      }
      resolve({
        source:         'uptake',
        units:          arr,
        count:          arr.length,
        screenshotPath: screenshotPath || null,
        scrapedAt:      new Date().toISOString(),
      });
    };

    const navTo = async (url) => {
      if (win.isDestroyed()) throw new Error('window destroyed');
      win.loadURL(url);
      await waitForLoadQuiet(win, PAGE_LOAD_TIMEOUT, 1200);
    };

    const runScrape = async () => {
      try {
        // ── 1. Navigate to insights list ──────────────────────────────────
        flog('[Uptake] Navigating to insights list...');
        await navTo(UPTAKE_INSIGHTS_URL);

        const listReady = await pollUntil(win, CHECK_LIST_READY);
        if (!listReady) { fwarn('[Uptake] Insights list did not render'); finish([], null); return; }

        // ── 1b. Force all rows to load (virtualized/lazy list) ─────────────
        // The list only renders the first screenful of rows, so ~half the fleet
        // was never discovered. Scroll to the bottom repeatedly until the row
        // count stops growing (or a safety cap), forcing every row into the DOM.
        // PATIENCE FIX (2026-10): the list lazy-fetches the next chunk from the
        // server on scroll. The old loop stopped after just 3 no-growth passes
        // × 700ms (~2.1s) — if a single server chunk was slow, it looked like
        // the end of the list and the scrape quit at ~35 rows instead of ~64
        // (observed: 28 units captured vs the real ~54). Now: wait longer per
        // pass, require MORE consecutive no-growth passes, and treat a pass as
        // "growth" if EITHER the row count OR the page scrollHeight increased —
        // so rows that lag behind a height bump don't trigger an early stop.
        let prevRowCount = -1;
        let prevHeight = -1;
        let stableStreak = 0;
        let scrollPass = 0;
        for (; scrollPass < 60; scrollPass++) {
          if (win.isDestroyed()) break;
          let step;
          try { step = await win.webContents.executeJavaScript(SCROLL_LIST_STEP); }
          catch(_) { step = { count: 0, height: 0 }; }
          const curr = (step && step.count) || 0;
          const currH = (step && step.height) || 0;
          const grew = curr > prevRowCount || currH > prevHeight;
          if (grew) {
            stableStreak = 0;
          } else {
            // No growth in rows OR height this pass. Require 6 consecutive
            // no-growth passes to confirm the list is truly fully loaded
            // (guards against slow lazy-fetch chunks mid-list).
            if (++stableStreak >= 6) break;
          }
          prevRowCount = Math.max(prevRowCount, curr);
          prevHeight = Math.max(prevHeight, currH);
          await sleep(1200); // let the next chunk of rows fetch/render
        }
        flog(`[Uptake] List fully loaded after scroll: ~${prevRowCount} rows in DOM (${scrollPass + 1} pass(es))`);
        // Scroll back to top so the list screenshot captures the header.
        try { await win.webContents.executeJavaScript('window.scrollTo(0,0)'); } catch(_) {}
        await sleep(300);

        const listResult = await win.webContents.executeJavaScript(SCRAPE_INSIGHTS_LIST);
        flog(`[Uptake] List scraped: ${listResult.count} rows`);
        if (!listResult.ready || !listResult.count) { finish([], null); return; }

        // ── 2. Screenshot the list ────────────────────────────────────────
        const listShot = await captureScreenshot(win, 'insights_list');

        // ── 3. Build unit map ─────────────────────────────────────────────
        const unitMap     = {};
        // BUG FIX (2026-07-14): expose this map to the master-timeout handler
        // above so a timeout can salvage partial progress instead of losing it.
        _liveUnitMap = unitMap;
        const insightRows = listResult.insights || [];
        insightRows.forEach(row => {
          if (!unitMap[row.assetId]) {
            unitMap[row.assetId] = {
              id:           row.assetId,
              assetUuid:    row.assetUuid,
              riskScore:    null,
              riskLabel:    '',
              openCases:    0,
              insightCount: 0,
              vin:          '',
              model:        '',
              modelYear:    '',
              manufacturer: '',
              fuelType:     '',
              tsp:          '',
              operator:     row.program   || '',
              domicile:     row.domicile  || '',
              assetType:    row.assetType || '',
              region:       '',
              lastDataDate: '',
              insightsList: [],
              screenshots:  [],
            };
          }
          unitMap[row.assetId].insightCount++;
        });

        // ── 4. Risk score pass — FIRST, before detail pages ────────────────
        // BUG FIX (2026-08-12): risk pass used to run AFTER the detail page loop.
        // The detail loop takes ~43s per timed-out page × 55 pages = well over the
        // 15-min master timeout. When the timeout fired, settled=true, and the risk
        // pass immediately broke on the first asset check — returning 0 scores every
        // run. Swapped order so risk scores (fast, ~12s each, 47 assets ≈ 10 min)
        // always complete before detail pages. Detail pages are enrichment; risk
        // scores drive the email. Even if details time out, emails get real scores.
        const uniqueAssets = Object.values(unitMap).filter(u => u.assetUuid);
        flog(`[Uptake] Risk score pass: ${uniqueAssets.length} unique assets...`);
        for (const u of uniqueAssets) {
          if (win.isDestroyed() || settled) break;
          try {
            await navTo(`https://fleet.uptake.com/asset/${u.assetUuid}`);
            const assetReady = await pollUntil(win, CHECK_ASSET_READY, 600, 20);
            if (!assetReady) { fwarn(`[Uptake] Asset overview not ready for ${u.id}`); continue; }
            flog('[Uptake] Asset overview ready for', u.id, '| signal: DOM');
            const assetData = await win.webContents.executeJavaScript(SCRAPE_ASSET_RISK);

            // ── Log diagnostic on first asset only ──────────────────────
            if (uniqueAssets.indexOf(u) === 0 && assetData._diag) {
              const rd = assetData._diag;
              flog(`[Uptake] RISK-DIAG#1 bodyLen=${rd.bodyLen} url=${rd.url}`);
              flog(`[Uptake] RISK-DIAG#1 candidateClasses=${JSON.stringify(rd.candidateClasses)}`);
              flog(`[Uptake] RISK-DIAG#1 numericLeaves=${JSON.stringify(rd.numericLeaves)}`);
            }

            if (assetData.riskScore !== null) u.riskScore    = assetData.riskScore;
            if (assetData.riskLabel)          u.riskLabel    = assetData.riskLabel;
            if (!u.vin          && assetData.vin)          u.vin          = assetData.vin;
            if (!u.model        && assetData.model)        u.model        = assetData.model;
            if (!u.modelYear    && assetData.modelYear)    u.modelYear    = assetData.modelYear;
            if (!u.manufacturer && assetData.manufacturer) u.manufacturer = assetData.manufacturer;
            if (!u.fuelType     && assetData.fuelType)     u.fuelType     = assetData.fuelType;
            flog(`[Uptake] Asset ${u.id}: risk=${assetData.riskScore} vin=${assetData.vin}`);
          } catch(e) {
            fwarn(`[Uptake] Risk pass failed for ${u.id}: ${e.message}`);
          }
        }
        flog(`[Uptake] Risk pass done — ${uniqueAssets.filter(u=>u.riskScore!==null).length}/${uniqueAssets.length} scored`);

        // ── 5. Visit each insight detail page (enrichment — can be partial) ──
        flog(`[Uptake] Visiting ${insightRows.length} detail pages...`);
        for (let i = 0; i < insightRows.length; i++) {
          if (win.isDestroyed() || settled) break;
          const row = insightRows[i];

          const baseEntry = {
            title:             row.insightName,
            url:               row.insightUrl || '',
            subsystem:         row.subsystem,
            guidance:          row.guidance,
            status:            '',
            type:              '',
            maintenanceFactor: row.maintenanceFactor,
            firstSeen:         row.firstDetected,
            lastSeen:          row.lastDetected,
            stillActive:       row.stillActive,
            summary:           '',
            recommended:       '',
            screenshotPath:    '',
          };

          if (!row.insightUrl) {
            unitMap[row.assetId].insightsList.push(baseEntry);
            continue;
          }
          flog(`[Uptake] ${i+1}/${insightRows.length}: ${row.insightName} (asset ${row.assetId})`);
          try {
            await navTo(row.insightUrl);

            const ready = await pollUntil(win, CHECK_DETAIL_READY);
            if (!ready) {
              fwarn(`[Uptake] Detail not ready for ${row.assetId}`);
              unitMap[row.assetId].insightsList.push(baseEntry);
              continue;
            }

            const detail = await win.webContents.executeJavaScript(SCRAPE_INSIGHT_DETAIL);

            // ── Log diagnostic on insight #1 only ────────────────────────
            if (i === 0 && detail._diag) {
              const d = detail._diag;
              flog(`[Uptake] DIAG#1 actionSecs=${d.actionSecCount} markdowns=${d.markdownCount} headings=${d.headingCount} broadMd=${d.broadMarkdownCount}`);
              flog(`[Uptake] DIAG#1 headingTexts=${JSON.stringify(d.headingTexts)}`);
              flog(`[Uptake] DIAG#1 markdownTexts=${JSON.stringify(d.markdownTexts)}`);
              flog(`[Uptake] DIAG#1 insightDetailClasses=${JSON.stringify(d.insightDetailClasses)}`);
            }

            // ── Click all "Read More" / "Show More" buttons, then wait ───
            await win.webContents.executeJavaScript(`(function() {
              var btns = Array.from(document.querySelectorAll(
                '._insight-details__buttons_1ba7f_882 button, [class*="read-more"], [class*="readMore"], [class*="show-more"], [class*="showMore"]'
              ));
              Array.from(document.querySelectorAll('button')).forEach(function(b) {
                var t = (b.textContent || '').trim().toLowerCase();
                if (t.includes('read more') || t.includes('show more')) btns.push(b);
              });
              btns.forEach(function(b) { try { b.click(); } catch(_) {} });
              return btns.length;
            })()`);

            // S8: adaptive Read More settle — sample body length before poll
            const _bodyBefore = await win.webContents.executeJavaScript(
              'document.body ? document.body.innerText.length : 0'
            ).catch(() => 0);
            const _t0_rm = Date.now();
            let _rmReady = false;
            while (Date.now() - _t0_rm < UPTAKE_READ_MORE_WAIT_MS) {
              await sleep(UPTAKE_READ_MORE_POLL_MS);
              try {
                const _bodyNow = await win.webContents.executeJavaScript(
                  'document.body ? document.body.innerText.length : 0'
                );
                if (_bodyNow > _bodyBefore + 100) { _rmReady = true; break; }
              } catch(_) {}
            }
            logger.info('[Uptake] Read More settle | waited:', (Date.now() - _t0_rm) + 'ms',
              '| signal:', _rmReady ? 'DOM' : 'timeout(' + UPTAKE_READ_MORE_WAIT_MS + 'ms)');
            const expanded = await win.webContents.executeJavaScript(SCRAPE_AFTER_READMORE);

            const finalSummary     = expanded.summary     || detail.summary     || '';
            const finalRecommended = expanded.recommended || detail.recommended || '';

            await sleep(800); // settle expanded DOM before screenshot (was 1500ms; screenshots still capture fully-rendered Read More content)
            const shotPath = await captureScreenshot(win, `insight_${row.assetId}_${i}`);

            const u = unitMap[row.assetId];
            if (u) {
              if (shotPath) u.screenshots.push(shotPath);
              u.insightsList.push({
                title:             row.insightName,
                url:               row.insightUrl     || '',
                subsystem:         detail.subsystem   || row.subsystem,
                guidance:          detail.guidance    || row.guidance,
                status:            detail.status      || '',
                type:              detail.insightType || '',
                maintenanceFactor: row.maintenanceFactor,
                firstSeen:         detail.firstDet    || row.firstDetected,
                lastSeen:          detail.lastDet     || row.lastDetected,
                stillActive:       row.stillActive,
                summary:           finalSummary,
                recommended:       finalRecommended,
                screenshotPath:    shotPath || '',
              });
            }

            flog(`[Uptake] ✓ ${row.assetId}: body=${detail.bodyLen}ch sum=${finalSummary.length}ch rec=${finalRecommended.length}ch guidance="${detail.guidance}" status="${detail.status}" shot=${!!shotPath}`);

          } catch(e) {
            fwarn(`[Uptake] Detail ${i+1} failed (${row.assetId}): ${e.message}`);
            unitMap[row.assetId].insightsList.push(baseEntry);
          }
        }

        const units = Object.values(unitMap);
        flog(`[Uptake] Done — ${units.length} units, risks: ${units.filter(u=>u.riskScore!==null).length} found`);
        finish(units, listShot);

      } catch(e) {
        fwarn('[Uptake] runScrape error:', e.message);
        finish([], null);
      }
    };

    // ── Auth phase handler ───────────────────────────────────────────────────
    win.webContents.on('did-finish-load', async () => {
      if (win.isDestroyed() || settled) return;
      const url = win.webContents.getURL();
      flog('[Uptake] did-finish-load:', url.split('?')[0] + (REALM_CALLBACK.test(url) ? ' [CB]' : ''));

      // Phase A: SSO login page
      if ((LOGIN_DOMAIN.test(url) || REALM_LOGIN.test(url)) && !REALM_CALLBACK.test(url)) {
        flog('[Uptake] Login page — clicking Amazon SSO...');
        await sleep(1500);
        try {
          const r = await win.webContents.executeJavaScript(CLICK_SSO_BUTTON);
          flog('[Uptake] SSO click:', JSON.stringify(r));
          if (!r.clicked) {
            await sleep(2500);
            const r2 = await win.webContents.executeJavaScript(CLICK_SSO_BUTTON);
            flog('[Uptake] SSO retry:', JSON.stringify(r2));
            if (!r2.clicked) {
              // Consent-gate fallback: no SSO button at all means this is
              // likely the one-time "USE AND CONSENT" checkbox step.
              const c = await win.webContents.executeJavaScript(CLICK_CONSENT_CHECKBOX);
              flog('[Uptake] Consent checkbox:', JSON.stringify(c));
              if (c.found) {
                await sleep(500);
                const nb = await win.webContents.executeJavaScript(CLICK_ENABLED_NEXT_BUTTON);
                flog('[Uptake] Consent next-button:', JSON.stringify(nb));
              }
            }
          }
        } catch(e) { fwarn('[Uptake] SSO error:', e.message); }
        return;
      }

      // Phase B: Midway / OAuth hop
      if (MIDWAY_PATTERN.test(url) && !FLEET_DOMAIN.test(url)) {
        if (/midway-auth\.amazon\.com/i.test(url)) {
          setTimeout(async () => {
            if (win.isDestroyed() || settled) return;
            try {
              const body = await win.webContents.executeJavaScript(
                `document.body ? document.body.innerText.slice(0,500) : ''`
              );
              if (/security key|yubikey|i don.t have a working/i.test(body)) {
                fwarn('[Uptake] Midway security key required — skipping');
                finish([], null);
              }
            } catch(_) {}
          }, 3000);
        }
        flog('[Uptake] Midway/OAuth hop — waiting...');
        return;
      }

      // Phase C: fleet.uptake.com — auth done, run scrape once
      if (FLEET_DOMAIN.test(url) && (!REALM_LOGIN.test(url) || REALM_CALLBACK.test(url))) {
        if (!authDone) {
          authDone = true;
          if (process.env.UPTAKE_API === '1') {
            flog('[Uptake] Auth done — starting API scrape (UPTAKE_API=1)...');
            runApiScrape({
              win,
              finish,
              navTo,
              sleep,
              captureScreenshot,
              settled: () => settled,
              setLiveMap: (m) => { _liveUnitMap = m; },
            });
          } else {
            flog('[Uptake] Auth done — starting scrape...');
            runScrape();
          }
        }
        return;
      }

      flog('[Uptake] Unhandled page:', url.split('?')[0]);
    });

    win.webContents.on('did-fail-load', (_, code, desc, url) => {
      if (code === -3) return;
      fwarn(`[Uptake] Load failed (${code} ${desc}):`, (url||'').split('?')[0]);
    });

    flog('[Uptake] Starting auth...');
    win.loadURL(UPTAKE_LOGIN_URL);
  });
  } finally {
    _uptakeLock = false;
  }
}

// ─── Merge Uptake units into AAP rows by equipment ID ────────────────────────
function mergeUptakeIntoRows(aapRows, uptakeUnits) {
  if (!uptakeUnits || !uptakeUnits.length) {
    return aapRows.map(r => ({ ...r, riskScore: r.riskScore ?? null, uptakeSynced: false }));
  }
  const map = {};
  uptakeUnits.forEach(u => {
    if (u && u.id) {
      const numId = String(u.id).replace(/[^0-9]/g, '');
      if (numId) map[numId] = u;
    }
  });
  return aapRows.map(row => {
    const id = String(row.equipmentId || '').replace(/[^0-9]/g, '');
    const m  = map[id];
    if (!m) return { ...row, riskScore: row.riskScore ?? null, uptakeSynced: false };
    return {
      ...row,
      riskScore:    m.riskScore    ?? null,
      riskLabel:    m.riskLabel    || '',
      openCases:    m.openCases    || 0,
      insights:     m.insightCount || 0,
      vin:          m.vin          || row.vin          || '',

      model:        row.model        || m.model        || '',   // ATS is truth for make — never let Uptake overwrite
      modelYear:    row.modelYear    || m.modelYear    || '',   // ATS is truth
      manufacturer: row.manufacturer || m.manufacturer || '',   // ATS is truth
      tsp:          m.tsp          || row.tsp          || '',
      assetType:    m.assetType    || row.assetType    || '',
      domicile:     m.domicile     || row.domicile     || '',
      region:       m.region       || row.region       || '',
      lastDataDate: m.lastDataDate || '',
      insightsList: m.insightsList || [],
      subsystems:   m.subsystems   || [],
      screenshots:  m.screenshots  || [],
      uptakeSynced: true,
    };
  });
}

module.exports = { scrapeUptake, mergeUptakeIntoRows };
