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

const MASTER_TIMEOUT_MS   = 180000;
// H-3: concurrency lock — prevents duplicate BrowserWindow farms on re-entrant calls
let _uptakeLock = false;
 // Stage 5 C-2: 3 min cap (was 15 min) -- isSyncing clears promptly on hang
const PAGE_LOAD_TIMEOUT   = 40000;  // per-page: 40s to handle slow CB reloads
const DOM_POLL_INTERVAL   = 800;    // ms between DOM-ready checks
const DOM_POLL_MAX        = 50;     // max polls (~40 seconds) — asset overview pages load slowly
const UPTAKE_READ_MORE_WAIT_MS = 3_000;   // S8: Read More expansion poll deadline (was 2500ms fixed sleep)
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

// ─── Check insights list table is ready ──────────────────────────────────────
const CHECK_LIST_READY = `(function() {
  var rows = Array.from(document.querySelectorAll('table tbody tr, [role="row"]'));
  return rows.some(function(r) {
    return r.querySelectorAll('td a[href], [role="gridcell"] a[href]').length > 0;
  });
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
      var assetId     = (assetText.match(/\\b(\\d{4,8})\\b/) || [])[1] || '';
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
  // body=892 is the nav shell only — React has NOT yet hydrated the content.
  // The _insight-details__action sections only appear after full React render.
  // Require bodyLen > 800 AND at least one action section whose markdown/value
  // text is longer than 30 chars (the truncated pre-expand state is still >30).
  var bodyLen = (document.body ? document.body.innerText : '').trim().length;
  if (bodyLen < 800) return false;
  var secs = Array.from(document.querySelectorAll('._insight-details__action_1ba7f_897'));
  if (!secs.length) return false;
  return secs.some(function(sec) {
    var el = sec.querySelector('._insight-details__markdown_1ba7f_902') ||
             sec.querySelector('._insight-details__value_1ba7f_942');
    return !!(el && (el.innerText || el.textContent || '').trim().length > 30);
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

    const masterTimer = setTimeout(() => {
      fwarn('[Uptake] Master timeout — resolving empty');
      finish([], null);
    }, MASTER_TIMEOUT_MS);

    const finish = (units, screenshotPath) => {
      if (settled) return;
      settled = true;
      clearTimeout(masterTimer);
      try { win.destroy(); } catch(_) {}
      const arr = Array.isArray(units) ? units : [];
      flog(`[Uptake] Finished — ${arr.length} units`);
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

        const listResult = await win.webContents.executeJavaScript(SCRAPE_INSIGHTS_LIST);
        flog(`[Uptake] List scraped: ${listResult.count} rows`);
        if (!listResult.ready || !listResult.count) { finish([], null); return; }

        // ── 2. Screenshot the list ────────────────────────────────────────
        const listShot = await captureScreenshot(win, 'insights_list');

        // ── 3. Build unit map ─────────────────────────────────────────────
        const unitMap     = {};
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

        // ── 4. Visit each insight detail page ────────────────────────────
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
              '| signal:', _rmReady ? 'DOM' : 'timeout(3s)');
            const expanded = await win.webContents.executeJavaScript(SCRAPE_AFTER_READMORE);

            const finalSummary     = expanded.summary     || detail.summary     || '';
            const finalRecommended = expanded.recommended || detail.recommended || '';

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

        // ── 5. Risk score pass — visit each unique asset overview page ────
        // Risk score lives on /asset/{uuid} (overview tab), NOT the insight page.
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
          flog('[Uptake] Auth done — starting scrape...');
          runScrape();
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
