// scrapers/aap_wo_scraper.js
// Scrapes the open Work Order for a single unit via pre-filtered AAP URL.
//
// FULL PIPELINE (mirrors relay.js v2 exactly):
//   Step 0 — Load pre-filtered WO list URL: /v2/page/<WO_PAGE_ID>?ids=<eqId>&subStatuses=...
//   Step 1 — Wait for table row, extract WO number + click it to get /v2/service/<UUID>
//   Step 2 — Load /v2/service/<UUID> (WR detail page)
//             → Phase 1: all WR label fields (vendor, vin, altId/AMZ ID, needBy, issueDetails...)
//             → Phase 2: click "Work Orders" tab → vendorWorkOrderId, cause, correction, cost
//             → Phase 3: click "Toggle Comments" → scan for Salesforce case + offsite links
//   Skip  — Velocity / FleetNet vendors
//
// URL FORMATS built here:
//   WO list:    /v2/page/817ca098-..?tab=Unplanned&ids=b20038&subStatuses=CREATED&...
//   WR detail:  /v2/service/<uuid>
//   Offsite:    https://paccarpg.decisiv.net/fleet/estimates/<case>  (PACCAR)
//               https://volvopg.asist.decisiv.net/service_requests/<case>  (Volvo)
//               https://dtna.my.site.com/Servicetracker/s/case/<case>  (DTNA/Freightliner)
//               https://aap-na.corp.amazon.com/v2/offsite-events/<case>  (fallback AAP)
//   Salesforce: https://amazonfreightpartner.lightning.force.com/one/one.app#<b64 search JSON>

'use strict';

const { BrowserWindow } = require('electron');

// ── Constants ────────────────────────────────────────────────────────────────
const WO_PAGE_ID     = '817ca098-8441-4329-a71e-6768f9d7e6c5';
const AAP_SERVICE_BASE = 'https://aap-na.corp.amazon.com/v2/service/';
const AAP_BASE         = 'https://aap-na.corp.amazon.com';

const WO_OPEN_STATUSES = [
  'CREATED',
  'PENDING_VENDOR_RESPONSE',
  'PENDING_VERIFICATION',
  'VERIFICATION_IN_PROGRESS',
  'WAITING_FOR_WORK_ORDER',
  'WORK_ORDER_ASSIGNED',
];

// Vendors to skip entirely
const SKIP_VENDORS = ['velocity', 'velociti', 'fleetnet', 'fleet net'];

// Timeouts
const WO_LIST_TIMEOUT_MS  = 30000;
const WR_PAGE_TIMEOUT_MS  = 45000;
const WR_PAGE_SETTLE_MS   = 3000;
const WO_TAB_SETTLE_MS    = 4000;
const CONV_POLL_TRIES      = 8;
const CONV_BODY_GROW_TRIES = 8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Skip check ───────────────────────────────────────────────────────────────
function isSkippedVendor(vendor) {
  if (!vendor) return false;
  const v = String(vendor).toLowerCase().trim();
  return SKIP_VENDORS.some(p => v.includes(p));
}

// ── URL builders ─────────────────────────────────────────────────────────────
function buildWOListUrl(equipmentId) {
  const sub = WO_OPEN_STATUSES.map(s => 'subStatuses=' + s).join('&');
  return (
    'https://aap-na.corp.amazon.com/v2/page/' + WO_PAGE_ID +
    '?tab=Unplanned&ids=' + encodeURIComponent(equipmentId) +
    '&' + sub
  );
}

function buildWRUrl(serviceUUID) {
  return AAP_SERVICE_BASE + serviceUUID;
}

// Salesforce: build deep-link URL from case number (same logic as relay.js Phase 3)
function buildSalesforceUrl(caseNumber) {
  if (!caseNumber) return '';
  const sfJson = JSON.stringify({
    componentDef: 'forceSearch:searchPageDesktop',
    attributes: {
      term: caseNumber,
      scopeMap: { type: 'TOP_RESULTS' },
      context: { FILTERS: {}, disableIntentQuery: false, disableSpellCorrection: false },
      groupId: 'DEFAULT'
    },
    state: {}
  });
  return 'https://amazonfreightpartner.lightning.force.com/one/one.app#' +
    Buffer.from(sfJson).toString('base64');
}

// ── DOM scripts ──────────────────────────────────────────────────────────────

// ── STEP 0: poll the WO list page for a table row + extract UUID from link ──
const FIND_WO_TABLE_FN = `
  function findWOTable() {
    var t = document.querySelector('table[class*="css-"]');
    if (t && t.querySelector('thead th')) return t;
    var tables = document.querySelectorAll('table');
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelectorAll('thead th').length >= 2) return tables[i];
    }
    return null;
  }
`;

const POLL_WO_LIST = FIND_WO_TABLE_FN + `(function() {
  try {
    var url = window.location.href;
    var isSSO = /midway|login\\.amazon|signin|sso\\.amazon|oidc|oauth|\\/auth\\//i.test(url)
                && !/aap-na\\.corp\\.amazon\\.com/i.test(url);
    if (isSSO) return { status: 'sso' };
    if (!/aap-na\\.corp\\.amazon\\.com/i.test(url)) return { status: 'waiting' };

    // "no results" state
    var bodyText = (document.body || {}).innerText || '';
    if (/no results|no work (orders?|requests?)|0 results/i.test(bodyText))
      return { status: 'no_results' };

    var tbl = findWOTable();
    if (!tbl) return { status: 'loading' };

    var rows = tbl.querySelectorAll('tbody tr');
    if (!rows.length) return { status: 'empty_table' };

    // Check first row has text
    var cells0 = rows[0].querySelectorAll('td');
    var hasText = false;
    for (var i = 0; i < cells0.length; i++) {
      if ((cells0[i].textContent || '').trim().length > 0) { hasText = true; break; }
    }
    if (!hasText) return { status: 'empty_cells', rowCount: rows.length };

    return { status: 'ready', rowCount: rows.length };
  } catch(e) { return { status: 'error', msg: e.message }; }
})()`;


// Extract the service UUID and Due date from the first WO row link
// Due date column = "Due date" header — read cell value from first row
const EXTRACT_WO_UUID = FIND_WO_TABLE_FN + `(function() {
  try {
    var tbl = findWOTable();
    if (!tbl) return { uuid: null, dueDate: '' };
    var rows = tbl.querySelectorAll('tbody tr');

    // Build header index so we can find Due date column by name
    var ths = tbl.querySelectorAll('thead th');
    var dueDateCol = -1;
    for (var h = 0; h < ths.length; h++) {
      var hText = (ths[h].textContent || ths[h].innerText || '').trim().toLowerCase();
      if (hText === 'due date' || hText === 'due\ndate' || hText.startsWith('due date')) {
        dueDateCol = h; break;
      }
    }

    // Read Due date from first row
    var dueDate = '';
    if (rows.length > 0 && dueDateCol >= 0) {
      var cells = rows[0].querySelectorAll('td');
      if (cells[dueDateCol]) {
        dueDate = (cells[dueDateCol].textContent || cells[dueDateCol].innerText || '').trim();
      }
    }

    for (var r = 0; r < rows.length; r++) {
      var links = rows[r].querySelectorAll('a[href]');
      for (var a = 0; a < links.length; a++) {
        var href = links[a].getAttribute('href') || '';
        // Match /v2/service/<uuid>
        var m = href.match(/\\/v2\\/service\\/([a-f0-9-]{36})/i);
        if (m) return { uuid: m[1], href: href, rowIndex: r, dueDate: dueDate };
        // Also try wrId or workRequestId query param
        var q = href.match(/[?&](?:wrId|workRequestId|id)=([a-f0-9-]{36})/i);
        if (q) return { uuid: q[1], href: href, rowIndex: r, dueDate: dueDate };
      }
    }
    // Fallback: click first row link and capture navigation (React Router)
    var firstLink = tbl.querySelector('tbody tr a[href]');
    if (firstLink) {
      return { uuid: null, href: firstLink.getAttribute('href'), needsClick: true, dueDate: dueDate };
    }
    return { uuid: null, dueDate: dueDate };
  } catch(e) { return { uuid: null, dueDate: '', error: e.message }; }
})()`;

// ── STEP 1: capture UUID via React Router click (same as wr_capture_v5.js) ──
function buildClickCaptureScript(rowIdx) {
  return `(async function() {
    var tables = document.querySelectorAll('table');
    var t = null;
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelector('tbody tr')) { t = tables[i]; break; }
    }
    if (!t) return { ok: false, reason: 'no_table' };
    var row = t.querySelectorAll('tbody tr')[${rowIdx}];
    if (!row) return { ok: false, reason: 'no_row' };
    var a = row.querySelector('a[href]');
    if (!a) return { ok: false, reason: 'no_anchor' };
    var before = window.location.href;
    a.click();
    await new Promise(function(r) { setTimeout(r, 100); });
    var after = window.location.href;
    if (after !== before) history.replaceState(history.state, '', before);
    var m = (after !== before ? after : a.getAttribute('href') || '').match(/\\/v2\\/service\\/([a-f0-9-]{36})/i);
    return { ok: true, uuid: m ? m[1] : null, href: after, before: before };
  })()`;
}

// ── STEP 2 Phase 1: WR label fields (from relay.js RELAY_WR_SCRIPT) ─────────
const RELAY_WR_SCRIPT = String.raw`
(function() {
  function normalize(text) {
    return String(text || '').replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  }
  function getLines() {
    return normalize(document.body ? document.body.innerText : '').split('\n').map(function(l){return l.trim();}).filter(Boolean);
  }
  var KNOWN_LABELS = new Set([
    'asset id','asset type','vin','owner name','make','program',
    'domicile site','operator','lifecycle state','lifecycle reason',
    'last completed maintenance','vendor','state','category','last updated',
    'work duration','created by','urgent','need by',
    'alternative id','work request id','integrated method',
    'issue details','created','completed'
  ]);

  function readLabel(lines, label) {
    var target = label.toLowerCase();
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase() !== target) continue;
      for (var j = i+1; j < Math.min(lines.length, i+8); j++) {
        var v = lines[j];
        if (!v) continue;
        if (KNOWN_LABELS.has(v.toLowerCase())) continue;
        return v;
      }
    }
    return '';
  }

  function readAfterSection(lines, sectionLabel) {
    var target = sectionLabel.toLowerCase(); var idx = -1;
    for (var i = 0; i < lines.length; i++) { if (lines[i].toLowerCase() === target) { idx = i; break; } }
    if (idx < 0) return '';
    var stops = new Set(['areas of concern','point of contact','time table','work request',
      'work orders','service events','service moves','documents','history','custom forms']);
    var vals = [];
    for (var i = idx+1; i < lines.length; i++) {
      if (stops.has(lines[i].toLowerCase())) break;
      if (lines[i]) vals.push(lines[i]);
      if (vals.join(' ').length > 300) break;
    }
    return vals.join(' ');
  }

  function readCreated(lines) {
    var start = -1;
    for (var i = 0; i < lines.length; i++) { if (/^Time Table$/i.test(lines[i])) { start = i; break; } }
    if (start < 0) return '';
    var stop = /^(Equipment Location|Location:|ATS|SYNC|Work Request|Work Orders|Documents|History|Custom Forms)/i;
    for (var i = start+1; i < Math.min(lines.length, start+35); i++) {
      if (stop.test(lines[i])) break;
      if (/^Created$/i.test(lines[i])) {
        for (var j = i+1; j < Math.min(lines.length, i+5); j++) {
          var v = lines[j];
          if (!v || KNOWN_LABELS.has(v.toLowerCase())) continue;
          return v;
        }
      }
      var m = lines[i].match(/^Created\s+(.+)$/i);
      if (m) return m[1].trim();
    }
    return '';
  }

  function detectOffsiteLink() {
    var anchors = Array.from(document.querySelectorAll('a[href]'));
    for (var a = 0; a < anchors.length; a++) {
      var h = String(anchors[a].href || '');
      var pac = h.match(/https?:\/\/paccarpg(?:\.asist)?\.decisiv\.net\/(?:service_requests|fleet\/estimates)\/([A-Za-z0-9_-]+)/i);
      if (pac) return { caseNumber: pac[1].replace(/[/?#].*$/, ''), url: h.split(/[\s"'<>]/)[0] };
      var vol = h.match(/https?:\/\/volvopg\.asist\.decisiv\.net\/(?:service_requests|fleet\/estimates)\/([A-Za-z0-9_-]+)/i);
      if (vol) return { caseNumber: vol[1].replace(/[/?#].*$/, ''), url: h.split(/[\s"'<>]/)[0] };
      var dtna = h.match(/https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/([A-Za-z0-9_-]+)/i);
      if (dtna && dtna[1].toLowerCase() !== 'case') return { caseNumber: dtna[1].replace(/[/?#].*$/, ''), url: h.split(/[\s"'<>]/)[0] };
    }
    return null;
  }

  var lines = getLines();
  var text  = lines.join('\n');

  // Alt ID: "amz-XXXXXXX" pattern OR the "Alternative ID" label
  var altId = '';
  var altMatch = text.match(/\b(amz-[A-Za-z0-9_-]+)\b/i);
  if (altMatch) altId = altMatch[1];
  var altLabel = readLabel(lines, 'Alternative ID');
  if (altLabel && altLabel !== '--') altId = altLabel;

  var offsite = detectOffsiteLink();

  return {
    equipmentId:         readLabel(lines, 'Asset ID') || (document.title.match(/Service Details for\s+([A-Za-z0-9-]+)/i)||[])[1] || '',
    vin:                 readLabel(lines, 'VIN'),
    make:                readLabel(lines, 'Make'),
    assetType:           readLabel(lines, 'Asset Type'),
    program:             readLabel(lines, 'Program'),
    operator:            readLabel(lines, 'Operator'),
    domicileSite:        readLabel(lines, 'Domicile Site'),
    vendor:              readLabel(lines, 'Vendor'),
    serviceState:        readLabel(lines, 'State'),
    category:            readLabel(lines, 'Category'),
    workDuration:        readLabel(lines, 'Work Duration'),
    createdBy:           readLabel(lines, 'Created By'),
    lifecycleState:      readLabel(lines, 'Lifecycle State'),
    lifecycleReason:     readLabel(lines, 'Lifecycle Reason'),
    urgent:              readLabel(lines, 'Urgent'),
    needBy:              readLabel(lines, 'Need By'),
    issueDetails:        readAfterSection(lines, 'Issue Details'),
    altId:               altId,
    alternativeId:       altId,
    workRequestId:       readLabel(lines, 'Work Request ID'),
    integratedMethod:    readLabel(lines, 'Integrated Method') || readLabel(lines, 'Integrated Method:'),
    created:             readCreated(lines),
    completed:           readLabel(lines, 'Completed'),
    offsiteShopEvent:    offsite ? offsite.caseNumber : '',
    offsiteShopEventUrl: offsite ? offsite.url : '',
    pageUrl:             window.location.href
  };
})();
`;

// ── STEP 2 Phase 2: click Work Orders tab ────────────────────────────────────
const RELAY_CLICK_WO_TAB = String.raw`
(function() {
  var sels = ["[role='tab']", 'button', 'a', 'li', 'span', "[class*='tab']"];
  for (var i = 0; i < sels.length; i++) {
    var els = document.querySelectorAll(sels[i]);
    for (var j = 0; j < els.length; j++) {
      var txt = (els[j].textContent || '').trim().toLowerCase();
      if (txt === 'work orders' || txt === 'work order') {
        try { els[j].click(); return true; } catch(e) {}
      }
    }
  }
  return false;
})();
`;

// ── STEP 2 Phase 2: extract WO fields after tab renders ─────────────────────
const RELAY_WO_SCRIPT = String.raw`
(function() {
  function normalize(text) {
    return String(text || '').replace(/\r/g,'\n').replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
  }
  function getLines() {
    return normalize(document.body ? document.body.innerText : '').split('\n').map(function(l){return l.trim();}).filter(Boolean);
  }
  var WO_SKIP = new Set(['vendor work order id','reason for repair','work accomplished','total','status','date','description']);

  function readLabel(lines, label) {
    var target = label.toLowerCase();
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase() !== target) continue;
      for (var j = i+1; j < Math.min(lines.length, i+8); j++) {
        var v = lines[j];
        if (!v) continue;
        if (WO_SKIP.has(v.toLowerCase())) continue;
        return v;
      }
    }
    return '';
  }

  var text = getLines().join('\n');
  var cause      = (text.match(/Reason\s+for\s+Repair[:\s]*([^\n]{3,200})/i)||[])[1] || '';
  var correction = (text.match(/Work\s+Accomplished[:\s]*([^\n]{3,200})/i)||[])[1] || '';
  var costMatch  = text.match(/Total\s*\n?\s*\$?([\d,]+\.?\d*)/i);

  return {
    vendorWorkOrderId: readLabel(getLines(), 'Vendor Work Order ID'),
    cause:             cause.trim(),
    correction:        correction.trim(),
    totalCost:         costMatch ? '$' + costMatch[1] : ''
  };
})();
`;

// ── STEP 2 Phase 3a: click conversation panel ────────────────────────────────
const RELAY_CLICK_CONV = String.raw`
(function() {
  var wrTabs = ["work orders","work request","service events","documents","history","custom forms"];
  function isWRLoaded() {
    var els = document.querySelectorAll("button,[role='tab'],li,a,span");
    for (var i = 0; i < els.length; i++) {
      if (wrTabs.indexOf((els[i].textContent || "").trim().toLowerCase()) !== -1) return true;
    }
    return false;
  }
  function tryClickConv() {
    var sels = ["button","[role='tab']","a","li","span"];
    for (var s = 0; s < sels.length; s++) {
      var els = document.querySelectorAll(sels[s]);
      for (var e = 0; e < els.length; e++) {
        var txt = (els[e].textContent || "").trim().toLowerCase();
        if (txt === "toggle comments" || txt.indexOf("toggle comments") === 0) {
          try { els[e].click(); return "clicked:toggle-comments"; } catch(_) {}
        }
        if (txt === "comments" || txt === "toggle comment") {
          try { els[e].click(); return "clicked:" + txt; } catch(_) {}
        }
      }
    }
    return "no-click";
  }
  if (!isWRLoaded()) return "not-loaded";
  return tryClickConv();
})();
`;

// ── STEP 2 Phase 3b: scan for Salesforce case + offsite links in conversation ─
const RELAY_CONVERSATION_SCRIPT = String.raw`
(function() {
  var allHrefs = Array.from(document.querySelectorAll("a[href]"))
    .map(function(a) { return String(a.href || ""); });

  var convText = "";
  var convSels = ["[class*=conversation]","[class*=Conversation]",
                  "[data-testid*=conversation]","[id*=conversation]",
                  "[class*=comment]","[class*=Comment]",
                  "[class*=activity]","[class*=Activity]",
                  "[class*=feed]","[class*=Feed]",
                  "[class*=toggle]","[class*=Toggle]"];
  for (var s = 0; s < convSels.length; s++) {
    var el = document.querySelector(convSels[s]);
    if (el && el.innerText && el.innerText.length > 20) convText += " " + el.innerText;
  }
  if (!convText) convText = document.body ? document.body.innerText : "";

  var combined = allHrefs.join(" ") + " " + convText;

  var estimateLinks  = [];
  var requestLinks   = [];
  var dtnaLinks      = [];
  var salesforceLinks = [];

  var reEst  = new RegExp("https?://[a-z0-9.\\-]+decisiv\\.net/fleet/estimates/([A-Za-z0-9_\\-]+)", "gi");
  var reReq  = new RegExp("https?://[a-z0-9.\\-]+decisiv\\.net/service_requests/([A-Za-z0-9_\\-]+)", "gi");
  var reDtna = new RegExp("https?://dtna\\.my\\.site\\.com/Servicetracker/s/case/([A-Za-z0-9_\\-]+)", "gi");
  var reSF   = new RegExp("(?:(?:sales?\\s*force(?:\\s+case)?|\\bsf\\b)\\s*#?\\s*(\\d{5,12})|\\bCase\\s+(000\\d{5,9})\\b)", "gi");

  var m;
  while ((m = reEst.exec(combined)) !== null) {
    var cn = m[1], url = m[0].split(/[\s"'<>]/)[0];
    if (!estimateLinks.find(function(x){return x.url===url;})) estimateLinks.push({caseNumber:cn,url:url});
  }
  while ((m = reReq.exec(combined)) !== null) {
    var cn = m[1].replace(/[/?#].*$/, ""), url = m[0].split(/[\s"'<>]/)[0];
    if (!requestLinks.find(function(x){return x.url===url;})) requestLinks.push({caseNumber:cn,url:url});
  }
  while ((m = reDtna.exec(combined)) !== null) {
    var cn = m[1].replace(/[/?#].*$/, "");
    if (cn.toLowerCase() === "case") continue;
    var url = m[0].split(/[\s"'<>]/)[0];
    if (!dtnaLinks.find(function(x){return x.url===url;})) dtnaLinks.push({caseNumber:cn,url:url});
  }
  while ((m = reSF.exec(combined)) !== null) {
    var cn = m[1] || m[2];
    if (!salesforceLinks.find(function(x){return x.caseNumber===cn;}))
      salesforceLinks.push({caseNumber:cn,url:''});
  }

  return {
    estimateLinks:    estimateLinks,
    requestLinks:     requestLinks,
    dtnaLinks:        dtnaLinks,
    salesforceLinks:  salesforceLinks,
    fullConversation: convText.substring(0, 3000),
  };
})();
`;

// ── Helpers ──────────────────────────────────────────────────────────────────
function safewrap(script) {
  return `(function(){try{ return ${script.trim().replace(/;$/, '')} }catch(_e){ return { _rendererError: _e.message }; }})()`;
}

function pickOffsiteFromConversation(convData) {
  if (!convData) return null;
  if (convData.estimateLinks  && convData.estimateLinks.length)  return convData.estimateLinks[0];
  if (convData.requestLinks   && convData.requestLinks.length)   return convData.requestLinks[0];
  if (convData.dtnaLinks      && convData.dtnaLinks.length)      return convData.dtnaLinks[0];
  return null;
}

// ── STEP 0: resolve the service UUID from the WO list page ───────────────────
async function resolveServiceUUID(equipmentId) {
  const listUrl = buildWOListUrl(equipmentId);
  console.log('[WO-Scraper] Resolving UUID for', equipmentId, '->', listUrl);

  return new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      show: false, width: 1400, height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    // Returns { uuid, dueDate } — dueDate captured from list row
    const finish = (uuid, dueDate) => {
      if (done) return; done = true;
      clearTimeout(t); try { win.destroy(); } catch(_) {}
      resolve(uuid ? { uuid, dueDate: dueDate || '' } : null);
    };
    const t = setTimeout(() => finish(null), WO_LIST_TIMEOUT_MS);

    win.webContents.on('did-fail-load', (_, code) => { if (code !== -3) finish(null); });

    win.webContents.on('did-finish-load', async () => {
      const POLL_MS = 600;
      const t0 = Date.now();
      while (Date.now() - t0 < WO_LIST_TIMEOUT_MS - 2000) {
        if (win.isDestroyed()) return;
        await sleep(POLL_MS);
        let check;
        try { check = await win.webContents.executeJavaScript(POLL_WO_LIST); } catch(e) { continue; }

        if (check.status === 'sso')       { finish(null); return; }
        if (check.status === 'no_results'){ finish(null); return; }
        if (check.status === 'error')     { finish(null); return; }
        if (check.status !== 'ready')     continue;

        // Table ready — extract UUID + Due date from first row
        let extract;
        try { extract = await win.webContents.executeJavaScript(EXTRACT_WO_UUID); } catch(e) { finish(null); return; }

        if (extract.uuid) { finish(extract.uuid, extract.dueDate); return; }

        // Href exists but no UUID — use React Router click capture (dueDate already read above)
        if (extract.needsClick || extract.href) {
          let clickResult;
          try { clickResult = await win.webContents.executeJavaScript(buildClickCaptureScript(0)); } catch(e) { finish(null); return; }
          if (clickResult && clickResult.uuid) { finish(clickResult.uuid, extract.dueDate); return; }
          // Try building URL from href manually
          if (extract.href) {
            const m = (AAP_BASE + extract.href).match(/\/v2\/service\/([a-f0-9-]{36})/i);
            if (m) { finish(m[1], extract.dueDate); return; }
          }
        }

        finish(null);
        return;
      }
      finish(null);
    });

    win.loadURL(listUrl);
  });
}


// ── STEP 2 Phase 4: Kooner / Cummins — Documents tab + PDF extraction ────────
// Mirrors KoonerCumminsDocRcaScan from tampermonkey exactly.
// Uses Electron's fetch (no CORS) to pull S3 PDF URLs directly.
// pdf.js loaded via CDN inside the BrowserWindow renderer.

const DOC_VENDORS = ['kooner', 'cummins', 'cox'];
function isDocVendor(vendor) {
  const v = String(vendor || '').toLowerCase();
  return DOC_VENDORS.some(p => v.includes(p));
}

// Renderer script: click Documents tab, find all PDF links, open each,
// grab S3 URL from iframe/embed, extract text with pdf.js, return fullDump.
const DOCS_TAB_SCRIPT = String.raw`
(async function() {
  var PDFJS_CDN    = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var NL = '\n';

  function reactClick(el) {
    var evts = { bubbles: true, cancelable: true };
    el.scrollIntoView({ block: 'center' });
    el.dispatchEvent(new MouseEvent('mousedown', evts));
    el.dispatchEvent(new MouseEvent('mouseup',   evts));
    el.dispatchEvent(new MouseEvent('click',     evts));
    try { el.click(); } catch(_) {}
    var pk = Object.keys(el).find(function(k){ return k.startsWith('__reactProps$'); });
    if (pk && el[pk] && el[pk].onClick) {
      try { el[pk].onClick(new MouseEvent('click', evts)); } catch(_) {}
    }
  }

  function loadPdfJs() {
    return new Promise(function(resolve, reject) {
      if (window.pdfjsLib) return resolve(window.pdfjsLib);
      var s = document.createElement('script');
      s.src = PDFJS_CDN;
      s.onload = function() {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        resolve(window.pdfjsLib);
      };
      s.onerror = function() { reject(new Error('pdf.js load failed')); };
      document.head.appendChild(s);
    });
  }

  function findS3Url() {
    var sels = ['iframe','embed','object'];
    for (var i = 0; i < sels.length; i++) {
      var els = document.querySelectorAll(sels[i]);
      for (var j = 0; j < els.length; j++) {
        var src = els[j].src || els[j].data || '';
        if (/amazonaws|assetdocservices3|s3/i.test(src)) return src;
      }
    }
    // Scan portals / modals
    var portals = document.querySelectorAll('body > div,[role="dialog"],[class*="modal"],[class*="Modal"]');
    for (var p = 0; p < portals.length; p++) {
      if (portals[p].offsetParent === null) continue;
      var frames = portals[p].querySelectorAll('iframe,embed,object');
      for (var f = 0; f < frames.length; f++) {
        var src2 = frames[f].src || frames[f].data || '';
        if (/amazonaws|assetdocservices3|s3/i.test(src2)) return src2;
      }
    }
    // Last resort: innerHTML scan
    var m = document.documentElement.innerHTML.match(/https:\/\/[^"' <>]+(?:amazonaws|assetdocservices3|s3)[^"' <>]+/i);
    return m ? m[0].replace(/&amp;/g,'&') : '';
  }

  function closeViewer() {
    var closeSels = ['[aria-label="Close"]','[aria-label="close"]',
      '[class*="close"],[class*="Close"]','[data-testid*="close"]'];
    for (var c = 0; c < closeSels.length; c++) {
      var btns = document.querySelectorAll(closeSels[c]);
      for (var b = 0; b < btns.length; b++) {
        if (btns[b].offsetParent !== null) { reactClick(btns[b]); return; }
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown',{ key:'Escape', keyCode:27, bubbles:true }));
  }

  function extractPdfText(url) {
    return loadPdfJs().then(function(lib) { return lib.getDocument(url).promise; })
      .then(function(pdf) {
        var pages = [];
        for (var i = 1; i <= pdf.numPages; i++) pages.push(i);
        return pages.reduce(function(chain, pn) {
          return chain.then(function(all) {
            return pdf.getPage(pn).then(function(page) { return page.getTextContent(); })
              .then(function(c) {
                all.push('--- PAGE ' + pn + ' ---');
                all.push(c.items.map(function(it){ return it.str; }).join(' '));
                return all;
              });
          });
        }, Promise.resolve([]));
      }).then(function(lines) { return lines.join(NL); });
  }

  // ── Step 1: click Documents tab ──────────────────────────────────────────
  var allEls = document.querySelectorAll('*');
  var docTab = null;
  for (var i = 0; i < allEls.length; i++) {
    if (allEls[i].children && allEls[i].children.length > 3) continue;
    if (/^Documents\s*(\(\d+\))?$/i.test((allEls[i].textContent||'').trim())) {
      docTab = allEls[i]; break;
    }
  }
  if (!docTab) return { ok: false, error: 'Documents tab not found' };
  reactClick(docTab);
  await new Promise(function(r){ setTimeout(r, 3500); });

  // ── Step 2: collect PDF links ─────────────────────────────────────────────
  var links = Array.from(document.querySelectorAll('a.css-1xaqo5u'))
    .filter(function(a){ return (a.textContent||'').toLowerCase().includes('.pdf'); });
  if (!links.length) {
    links = Array.from(document.querySelectorAll('a'))
      .filter(function(a){
        var t = (a.textContent||'').trim().toLowerCase();
        return t.includes('.pdf') && t.length < 200;
      });
  }
  if (!links.length) return { ok: false, error: 'No PDF links found' };

  var pdfNames = links.map(function(a){ return (a.textContent||'').trim(); });
  var allTexts = [];
  var scannedUrls = {};

  // ── Step 3: open each PDF, grab S3 URL, extract text ─────────────────────
  for (var idx = 0; idx < Math.min(links.length, 10); idx++) {
    // Re-query links after each viewer close (DOM may refresh)
    var currentLinks = Array.from(document.querySelectorAll('a.css-1xaqo5u'))
      .filter(function(a){ return (a.textContent||'').toLowerCase().includes('.pdf'); });
    if (!currentLinks.length) {
      currentLinks = Array.from(document.querySelectorAll('a'))
        .filter(function(a){
          var t = (a.textContent||'').trim().toLowerCase();
          return t.includes('.pdf') && t.length < 200;
        });
    }
    var targetName = pdfNames[idx] || '';
    var link = currentLinks.find(function(a){ return (a.textContent||'').trim() === targetName; })
            || currentLinks[idx] || currentLinks[0];
    if (!link) continue;

    var fileName = (link.textContent||'PDF '+(idx+1)).trim();
    reactClick(link);
    await new Promise(function(r){ setTimeout(r, 5000); });

    var s3url = findS3Url();
    if (!s3url || scannedUrls[s3url]) { closeViewer(); await new Promise(function(r){setTimeout(r,1800);}); continue; }
    scannedUrls[s3url] = 1;

    try {
      var text = await extractPdfText(s3url);
      if (text) allTexts.push('===== ' + fileName + ' =====\n' + text);
    } catch(pdfErr) {
      allTexts.push('===== ' + fileName + ' =====\n(extraction error: ' + pdfErr.message + ')');
    }
    closeViewer();
    await new Promise(function(r){ setTimeout(r, 1800); });
  }

  if (!allTexts.length) return { ok: false, error: 'No PDF text extracted' };
  return { ok: true, fullDump: allTexts.join('\n\n') };
})()
`;

// ── PDF text parsers (ported from KoonerCumminsDocRcaScan) ───────────────────

function cleanText(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}
function limitText(text, max) {
  const s = cleanText(text);
  return s.length <= max ? s : s.slice(0, max).replace(/\s\S*$/, '').trim() + '...';
}
function captureAll(regex, text, group) {
  const results = [];
  let m;
  const re = new RegExp(regex.source, regex.flags);
  while ((m = re.exec(text)) !== null) {
    const val = cleanText(m[group] || '');
    if (val) results.push(val);
  }
  return results;
}
function uniqueParts(parts, max) {
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = cleanText(p).toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const candidate = out.length ? out.join('; ') + '; ' + cleanText(p) : cleanText(p);
    if (candidate.length > max) break;
    out.push(cleanText(p));
  }
  return out.join('; ');
}

function parseKoonerPdf(fullDump) {
  const raw = String(fullDump || '');
  const compact = cleanText(raw);

  // Primary block parser: Found issues / Check the following systems
  const blockRegex = /\b(?:Found\s+issues|Check\s+the\s+following\s+systems)\s*:\s*([\s\S]*?)\s+System\s+([\s\S]*?)\s+\(\d+\)\s+Assembly\s+([\s\S]*?)\s+\(\d+\)\s+Component\s+([\s\S]*?)\s+\(\d+\)\s+Cause\s+([\s\S]*?)\s+\(\d+\)\s+Correction\s+([\s\S]*?)\s+\(\d+\)\s+Reason\s+for\s+Repair\s+([\s\S]*?)\s+\(\d+\)\s+Notes\s+([\s\S]*?)(?=(?:\s+(?:Found\s+issues\s*:|Check\s+the\s+following\s+systems\s*:|Needs\s+Repair\b|Repaired\s+Today\b|COMPLETED\s+WITH\s+ISSUES\b|COMPLETED\s+WITHOUT\s+ISSUES\b|INSPECTED\s+COMPONENTS\b|Kooner\s+Fleet\s+Management\s+Solutions\b|---\s*PAGE\s+\d+\s*---)|$))/gi;

  const causeParts = [];
  const corrParts = [];
  let m;
  while ((m = blockRegex.exec(compact)) !== null) {
    const cause = cleanText(m[5] || '').replace(/\s+Kooner\s+Fleet\s+Management\s+Solutions\b.*$/i, '').trim();
    const corr  = cleanText(m[6] || '').replace(/\s+Kooner\s+Fleet\s+Management\s+Solutions\b.*$/i, '').trim();
    if (cause) causeParts.push(cause);
    if (corr)  corrParts.push(corr);
  }

  if (causeParts.length || corrParts.length) {
    return {
      cause:      uniqueParts(causeParts, 250),
      correction: uniqueParts(corrParts,  250),
      totalCost:  '',
    };
  }

  // Emergency fallback
  const causes = captureAll(/\bCause\s+([A-Za-z][A-Za-z\s/\-]+?)\s+\(\d+\)/gi, compact, 1);
  const notes  = captureAll(/\bNotes\s+([\s\S]*?)(?=\s+(?:Found\s+issues\s*:|Check\s+the\s+following\s+systems\s*:|Needs\s+Repair\b|Repaired\s+Today\b|Kooner\s+Fleet\s+Management\s+Solutions\b|---\s*PAGE\s+\d+\s*---|$))/gi, compact, 1);
  return {
    cause:      uniqueParts(causes, 250),
    correction: uniqueParts(notes,  250),
    totalCost:  '',
  };
}

function parseCumminsPdf(fullDump) {
  const raw     = String(fullDump || '');
  const compact = cleanText(raw);

  // Best doc: prefer invoice/quote pages with COMPLAINT CAUSE CORRECTION
  const pages    = raw.split(/---\s*PAGE\s+\d+\s*---/i).map(cleanText).filter(Boolean);
  const service  = pages.find(p => /\bCOMPLAINT\s+CAUSE\s+CORRECTION\b/i.test(p) && /\bEST\s+TO\b/i.test(p))
                || pages.find(p => /\bEST\s+TO\b/i.test(p))
                || pages[0] || compact;

  const ADMIN_STOP = /\b(?:QUOTE\s+TECHNICIAN|TECHNICIAN\s+ADMINISTRATIVE\s+TIME|AMAZON\s+LOGISTICS|Billing\s+Inquiries|TERMS\s+AND\s+CONDITIONS|\*\*\*\s*CHARGE\s*\*\*\*?|AUTHORIZED\s+BY|PAGE\s+OF|OWNER\s+BILL\s+TO|Completion\s+date|Estimate\s+expires)\b/i;

  const estMatch = service.match(/\bEST\s+TO\b\s*[-:" –]?\s*([\s\S]*?)(?=\b(?:QUOTE\s+TECHNICIAN|TECHNICIAN\s+ADMINISTRATIVE\s+TIME|AMAZON\s+LOGISTICS|Billing\s+Inquiries|TERMS\s+AND\s+CONDITIONS|\*\*\*\s*CHARGE\s*\*\*\*?|AUTHORIZED\s+BY|PAGE\s+OF|OWNER\s+BILL\s+TO|Completion\s+date|Estimate\s+expires)\b|$)/i);

  const beforeEst = estMatch ? service.slice(0, estMatch.index) : service;
  const causeRaw  = cleanText(beforeEst)
    .replace(/\bCOMPLAINT\s+CAUSE\s+CORRECTION\b/i, '')
    .replace(/\bCUSTOMER\s+STATES\b[^.]*\./i, '')
    .trim();

  const corrRaw = estMatch ? cleanText(estMatch[1]).split(ADMIN_STOP)[0].trim() : '';

  const totalMatch = compact.match(/\bTotal\s+Amount\s*:?\s*US\s*\$?\s*([\d,]+\.?\d*)/i)
                  || compact.match(/\b(?:Invoice\s+Total|Grand\s+Total|Amount\s+Due|Total\s+Due)\s*:?\s*(?:US)?\s*\$?\s*([\d,]+\.?\d*)/i);

  return {
    cause:      limitText(causeRaw, 250),
    correction: limitText(corrRaw,  250),
    totalCost:  totalMatch ? '$' + totalMatch[1].replace(/^\$/, '') : '',
  };
}

function parsePdfByVendor(vendor, fullDump) {
  const v = String(vendor || '').toUpperCase();
  if (v.includes('KOONER') || v.includes('COX')) return parseKoonerPdf(fullDump);
  if (v.includes('CUMMINS'))                     return parseCumminsPdf(fullDump);
  return {};
}

// Scrape Documents tab in an already-open BrowserWindow on the WR page.
// Returns { cause, correction, totalCost, rawPdfText } or {}
async function scrapeDocumentsTab(win, equipmentId, vendor) {
  console.log('[WO-Scraper] Phase4 Documents tab for', equipmentId, '(', vendor, ')');
  try {
    const result = await win.webContents.executeJavaScript(
      `(function(){try{ return ${DOCS_TAB_SCRIPT.trim()} }catch(e){ return {ok:false,error:e.message}; }})()`
    );
    if (!result || !result.ok || !result.fullDump) {
      console.warn('[WO-Scraper] Phase4 no PDF text for', equipmentId, result && result.error);
      return {};
    }
    console.log('[WO-Scraper] Phase4 PDF dump length:', result.fullDump.length, 'for', equipmentId);
    const parsed = parsePdfByVendor(vendor, result.fullDump);
    console.log('[WO-Scraper] Phase4 parsed cause:', (parsed.cause||'').slice(0,60), '| correction:', (parsed.correction||'').slice(0,60));
    return Object.assign({ rawPdfText: result.fullDump.slice(0, 60000) }, parsed);
  } catch(e) {
    console.warn('[WO-Scraper] Phase4 exception for', equipmentId, e.message);
    return {};
  }
}

// ── STEP 1-3: full WR detail scrape ─────────────────────────────────────────
async function scrapeWRDetail(equipmentId, serviceUUID) {
  const url = buildWRUrl(serviceUUID);
  console.log('[WO-Scraper] Scraping WR detail for', equipmentId, '->', url);

  return new Promise((resolve) => {
    let done = false;
    const win = new BrowserWindow({
      show: false, width: 1400, height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const finish = (data) => {
      if (done) return; done = true;
      clearTimeout(t); try { win.destroy(); } catch(_) {}
      resolve(data);
    };
    const t = setTimeout(() => finish(null), WR_PAGE_TIMEOUT_MS);

    win.webContents.on('did-fail-load', (_, code) => { if (code !== -3) finish(null); });

    win.webContents.on('did-finish-load', async () => {
      const finalUrl = win.webContents.getURL();
      if (!/aap-na\.corp\.amazon\.com/i.test(finalUrl)) { finish(null); return; }

      await sleep(WR_PAGE_SETTLE_MS);
      if (win.isDestroyed()) return;

      try {
        // ── Phase 1: WR label fields ─────────────────────────────────────
        const wrData = await win.webContents.executeJavaScript(safewrap(RELAY_WR_SCRIPT));
        if (!wrData || wrData._rendererError || !wrData.equipmentId) { finish(null); return; }

        // Velocity skip (FleetNet already filtered at list level, but double-check)
        if (isSkippedVendor(wrData.vendor)) {
          const reason = /velocity|velociti/i.test(wrData.vendor) ? 'velocity' : 'fleetnet';
          finish({ _skipped: true, skipReason: reason, vendor: wrData.vendor, equipmentId });
          return;
        }

        // ── Phase 2: Work Orders tab ──────────────────────────────────────
        let woData = {};
        try {
          await win.webContents.executeJavaScript(safewrap(RELAY_CLICK_WO_TAB));
          await sleep(WO_TAB_SETTLE_MS);
          const wo = await win.webContents.executeJavaScript(safewrap(RELAY_WO_SCRIPT));
          if (wo && !wo._rendererError) woData = wo;
        } catch(e) {
          console.warn('[WO-Scraper] WO tab failed for', equipmentId, e.message);
        }

        // ── Phase 3: conversation panel ────────────────────────────────────
        let convOffsite = null;
        let convSalesforce = null;
        let fullConversation = '';
        try {
          // Poll until WR page loads, then click toggle comments
          let clickResult = 'not-loaded';
          for (let p = 0; p < CONV_POLL_TRIES; p++) {
            await sleep(1000);
            try { clickResult = await win.webContents.executeJavaScript(safewrap(RELAY_CLICK_CONV)); } catch(_) {}
            if (clickResult !== 'not-loaded') break;
          }
          console.log('[WO-Scraper] Conv click for', equipmentId, ':', clickResult);

          // Wait for conversation body to grow
          const bodyBefore = await win.webContents.executeJavaScript(
            'document.body ? document.body.innerText.length : 0'
          ).catch(() => 0);
          for (let w = 0; w < CONV_BODY_GROW_TRIES; w++) {
            await sleep(1000);
            const bl = await win.webContents.executeJavaScript(
              'document.body ? document.body.innerText.length : 0'
            ).catch(() => 0);
            if (bl > bodyBefore + 200) break;
          }

          const convData = await win.webContents.executeJavaScript(safewrap(RELAY_CONVERSATION_SCRIPT));
          if (convData && !convData._rendererError) {
            fullConversation = convData.fullConversation || '';
            convOffsite = pickOffsiteFromConversation(convData);

            if (convData.salesforceLinks && convData.salesforceLinks.length) {
              convSalesforce = convData.salesforceLinks[0];
              // Build Salesforce deep-link URL in main process (Node Buffer.from)
              if (convSalesforce.caseNumber && !convSalesforce.url) {
                convSalesforce.url = buildSalesforceUrl(convSalesforce.caseNumber);
              }
            }
            if (convOffsite)    console.log('[WO-Scraper] Offsite for', equipmentId, ':', convOffsite.url || convOffsite.caseNumber);
            if (convSalesforce) console.log('[WO-Scraper] Salesforce for', equipmentId, ':', convSalesforce.caseNumber);
          }
        } catch(ce) {
          console.warn('[WO-Scraper] Phase3 failed for', equipmentId, ce.message);
        }

        // ── Phase 4: Documents tab (Kooner / Cummins / Cox only) ──────────────
        let docData = {};
        if (isDocVendor(wrData.vendor)) {
          docData = await scrapeDocumentsTab(win, equipmentId, wrData.vendor);
        }

        // Phase 1 offsite is fallback if Phase 3 found nothing
        const finalOffsite = convOffsite ||
          (wrData.offsiteShopEventUrl ? { caseNumber: wrData.offsiteShopEvent, url: wrData.offsiteShopEventUrl } : null);

        // Build fallback offsite URL from case number if we have one but no URL
        let finalOffsiteUrl = finalOffsite ? finalOffsite.url : '';
        if (!finalOffsiteUrl && wrData.offsiteShopEvent) {
          finalOffsiteUrl = 'https://aap-na.corp.amazon.com/v2/offsite-events/' + wrData.offsiteShopEvent.trim();
        }

        finish({
          // Equipment + WR identity
          equipmentId:         wrData.equipmentId || equipmentId,
          workRequestId:       wrData.workRequestId || '',
          serviceUrl:          url,
          _serviceUUID:        serviceUUID,

          // Vehicle info
          vin:                 wrData.vin           || '',
          make:                wrData.make          || '',
          assetType:           wrData.assetType     || '',
          program:             wrData.program       || '',
          operator:            wrData.operator      || '',
          domicileSite:        wrData.domicileSite  || '',

          // WR fields
          vendor:              wrData.vendor        || '',
          serviceState:        wrData.serviceState  || '',
          category:            wrData.category      || '',
          workDuration:        wrData.workDuration  || '',
          createdBy:           wrData.createdBy     || '',
          lifecycleState:      wrData.lifecycleState || '',
          lifecycleReason:     wrData.lifecycleReason || '',
          urgent:              wrData.urgent        || '',
          needBy:              wrData.needBy        || '',
          issueDetails:        wrData.issueDetails  || '',
          integratedMethod:    wrData.integratedMethod || '',
          created:             wrData.created       || '',
          completed:           wrData.completed     || '',

          // Alt ID — "amz-XXXXXXX" or Alternative ID label value
          altId:               wrData.altId         || wrData.alternativeId || '',
          alternativeId:       wrData.alternativeId || wrData.altId         || '',

          // Work Orders tab (Phase 2) — overridden by doc scan (Phase 4) for Kooner/Cummins/Cox
          vendorWorkOrderId:   woData.vendorWorkOrderId || '',
          cause:               docData.cause       || woData.cause       || '',
          correction:          docData.correction  || woData.correction  || '',
          totalCost:           docData.totalCost   || woData.totalCost   || '',

          // Phase 4 doc scan fields (Kooner / Cummins / Cox)
          docScanRan:          isDocVendor(wrData.vendor),
          rawPdfText:          docData.rawPdfText  || '',

          // Offsite event
          offsiteShopEvent:    finalOffsite ? finalOffsite.caseNumber : (wrData.offsiteShopEvent || ''),
          offsiteShopEventUrl: finalOffsiteUrl,

          // Salesforce
          salesforceCase:      convSalesforce ? convSalesforce.caseNumber : '',
          salesforceCaseUrl:   convSalesforce ? convSalesforce.url        : '',

          // Full conversation text
          fullConversation:    fullConversation,

          scrapedAt:           new Date().toISOString(),
        });

      } catch(e) {
        console.warn('[WO-Scraper] Extract failed for', equipmentId, e.message);
        finish(null);
      }
    });

    win.loadURL(url);
  });
}

// ── Main export ──────────────────────────────────────────────────────────────
/**
 * Full WO scrape for one unit.
 * @param {string} equipmentId  e.g. "b20038"
 * @param {object} [opts]
 * @param {number} [opts.timeout]  override total timeout
 * @returns {Promise<{
 *   skipped?: boolean, skipReason?: string,
 *   noWO?: boolean,
 *   equipmentId: string,
 *   vendor?: string, altId?: string,
 *   offsiteShopEvent?: string, offsiteShopEventUrl?: string,
 *   salesforceCase?: string, salesforceCaseUrl?: string,
 *   vendorWorkOrderId?: string, cause?: string, correction?: string, totalCost?: string,
 *   fullConversation?: string,
 *   ...allWRFields
 * }>}
 */
async function scrapeWorkOrder(equipmentId, opts = {}) {
  console.log('[WO-Scraper] Starting full pipeline for', equipmentId);

  // Step 0: resolve service UUID + Due date from WO list page
  // resolveServiceUUID now returns { uuid, dueDate } or null
  const resolved = await resolveServiceUUID(equipmentId);
  if (!resolved) {
    console.log('[WO-Scraper]', equipmentId, '— no open WO found');
    return { noWO: true, equipmentId, scrapedAt: new Date().toISOString() };
  }
  const { uuid: serviceUUID, dueDate: listDueDate } = resolved;
  console.log('[WO-Scraper]', equipmentId, '— UUID:', serviceUUID, '| dueDate from list:', listDueDate || '(none)');

  // Steps 1-3: load WR detail page, scrape all phases
  const result = await scrapeWRDetail(equipmentId, serviceUUID);

  if (!result) {
    return { error: 'WR detail scrape failed', equipmentId, serviceUUID };
  }
  if (result._skipped) {
    return {
      skipped:    true,
      skipReason: result.skipReason,
      vendor:     result.vendor,
      equipmentId,
    };
  }

  // Attach dueDate from list page (most reliable source for PM schedule data)
  if (listDueDate && !result.dueDate) {
    result.dueDate = listDueDate;
  }

  return result;
}

module.exports = {
  scrapeWorkOrder,
  resolveServiceUUID,
  buildWOListUrl,
  buildWRUrl,
  buildSalesforceUrl,
  isSkippedVendor,
  WO_PAGE_ID,
  WO_OPEN_STATUSES,
  SKIP_VENDORS,
};
