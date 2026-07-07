'use strict';
/**
 * vendors/base/relay-step.js -- Relay Garage WO creation step [V-C]
 *
 * S23-2 (2026-06-28):
 * Shared pre-flight for every vendor portal workflow.
 *
 *   detectVendorFromUnit(unit)
 *     Inspects make/vendor/model to pick portal: paccar | volvo | null.
 *     Kenworth / Peterbilt / KWNE -> paccar
 *     Volvo                       -> volvo
 *
 *   checkExistingDealerWO(unit)
 *     Scans existing Relay WRs for a dealer tracking title.
 *     Returns first match or null (duplicate guard before creation).
 *
 *   createDealerTrackingWO(unit, vendor)
 *     Creates a Relay Garage WR via AAP API with canonical dealer title.
 *     PACCAR: Kenworth/Peterbilt Dealer Tracking Event
 *     Volvo:  Volvo Dealer Tracking Event
 *     Returns { ok, workRequestId, altId, serviceUrl, isDuplicate, error }.
 *
 *   runRelayStep(unit)
 *     Full pre-flight: detect -> dupe-check -> create -> extract altId.
 *     Returns { vendor, altId, workRequestId, isDuplicate, serviceUrl }.
 */

const logger = require("../../utils/logger")("relay-step");
const { createWorkRequest } = require("../../scrapers/aap_create_wr");

// WO titles used to identify dealer tracking events in existing WRs.
// These must match exactly what createDealerTrackingWO writes.
const DEALER_WO_TITLES = {
  paccar: "Kenworth/Peterbilt Dealer Tracking Event",
  volvo:  "Volvo Dealer Tracking Event",
};

// make/vendor strings that map to each portal.
// Case-insensitive substring match -- loose enough for AAP abbreviations.
const PACCAR_PATTERNS = ["kenworth", "peterbilt", "paccar", "kwne"];
const VOLVO_PATTERNS  = ["volvo"];

/**
 * detectVendorFromUnit(unit)
 * Returns "paccar", "volvo", or null.
 * Checks unit.make, unit.manufacturer, unit.vendor, unit.model in order.
 */
function detectVendorFromUnit(unit) {
  const haystack = [unit.make, unit.manufacturer, unit.vendor, unit.model]
    .filter(Boolean).join(" ").toLowerCase();
  if (PACCAR_PATTERNS.some(p => haystack.includes(p))) return "paccar";
  if (VOLVO_PATTERNS.some(p  => haystack.includes(p))) return "volvo";
  return null;
}

/**
 * checkExistingDealerWO(unit)
 * Scans the unit service URL page for any WR already titled with a dealer
 * tracking event marker, to prevent duplicate WO creation.
 *
 * Uses unit.serviceUrl (the active Relay WR page URL) if available,
 * then falls back to scanning the garage list via unit.equipmentId.
 *
 * @param {object} unit  unit record from fleet data (equipmentId, serviceUrl...)
 * @returns {Promise<{workRequestId:string, title:string, altId:string}|null>}
 */
async function checkExistingDealerWO(unit) {
  if (!unit || !unit.equipmentId) return null;
  const eqId = unit.equipmentId;
  const dealerTitles = Object.values(DEALER_WO_TITLES).map(t => t.toLowerCase());

  // Use the serviceUrl from relay data if we have it -- most reliable path.
  // If the unit was recently scraped, this points to the active WR page directly.
  const serviceUrl = unit.serviceUrl || unit.pageUrl || null;
  if (serviceUrl) {
    try {
      const existing = await _scrapeWRTitleAndAltId(serviceUrl);
      if (existing && dealerTitles.some(t => existing.title.toLowerCase().includes(t.split(" ")[0]))) {
        logger.info("[relay-step] Existing dealer WO found for", eqId, "via serviceUrl:", existing.title);
        return existing;
      }
    } catch (e) {
      logger.warn("[relay-step] serviceUrl dupe check failed:", e.message);
    }
  }

  // Fallback: scan garage list for any title matching dealer tracking pattern
  try {
    const rows = await _scrapeGarageListForUnit(eqId);
    const match = rows.find(r => r.title && dealerTitles.some(t => r.title.toLowerCase().includes(t.split(" ")[0])));
    if (match) {
      logger.info("[relay-step] Garage list dupe found for", eqId, match.title);
      return { workRequestId: match.uuid, title: match.title, altId: "" };
    }
  } catch (e) {
    logger.warn("[relay-step] Garage list dupe check failed:", e.message);
  }

  return null;
}

/**
 * createDealerTrackingWO(unit, vendor)
 * Creates a Relay Garage WR via AAP API with the canonical dealer tracking title.
 * PACCAR: Kenworth/Peterbilt Dealer Tracking Event
 * Volvo:  Volvo Dealer Tracking Event
 *
 * Relies on createWorkRequest from aap_create_wr.js (3-step API flow).
 *
 * @param {object} unit    unit record (equipmentId, site, operator...)
 * @param {string} vendor  paccar | volvo
 * @returns {Promise<{ok, workRequestId, altId, serviceUrl, isDuplicate, error}>}
 */
async function createDealerTrackingWO(unit, vendor) {
  if (!DEALER_WO_TITLES[vendor]) {
    return { ok: false, error: "createDealerTrackingWO: unknown vendor: " + vendor };
  }

  const title = DEALER_WO_TITLES[vendor];
  const aapVendorName = vendor === "paccar" ? "Kenworth (PACCAR)" : "Volvo (ASIST)";

  const payload = {
    unit:       unit.equipmentId || unit.id || "",
    title:      title,
    vendor:     aapVendorName,
    domicile:   unit.domicileSite || unit.site || "",
    issue:      title + " -- " + (unit.equipmentId || "") + " | Make: " + (unit.make || unit.manufacturer || "unknown"),
    comments:   title + "\nUnit: " + (unit.equipmentId||"") + " | Make: " + (unit.make||"") + " | Operator: " + (unit.operator||"") + " | Site: " + (unit.domicileSite||unit.site||""),
    shareWith:  "internal",
    urgent:     "No",
    areaPairs:  [],
  };

  logger.info("[relay-step] Creating dealer WO for", unit.equipmentId, "| vendor:", vendor, "| title:", title);

  const result = await createWorkRequest(payload, unit, (msg) => logger.info(msg));
  if (!result.ok) {
    logger.warn("[relay-step] createWorkRequest failed:", result.error);
    return { ok: false, error: result.error, isDuplicate: false };
  }

  const workRequestId = result.workRequestId;
  const serviceUrl = "https://aap-na.corp.amazon.com/v2/service/" + workRequestId;
  const altId = await _pollForAltId(serviceUrl, 30000);
  logger.info("[relay-step] WR created:", workRequestId, "| altId:", altId || "(pending)");

  return { ok: true, workRequestId, altId, serviceUrl, isDuplicate: false };
}

/**
 * runRelayStep(unit)
 * Full pre-flight orchestration:
 *   1. detectVendorFromUnit -- bail if not PACCAR / Volvo
 *   2. checkExistingDealerWO -- return early if duplicate found
 *   3. createDealerTrackingWO -- create and wait for altId
 * Returns { vendor, altId, workRequestId, isDuplicate, serviceUrl }
 *
 * @param {object} unit unit record from fleet data
 * @returns {Promise<{vendor:string, altId:string, workRequestId:string,
 *                   isDuplicate:boolean, serviceUrl:string}>}
 */
async function runRelayStep(unit) {
  const eqId = unit.equipmentId || unit.id || "unknown";

  // Step 1: vendor detection
  const vendor = detectVendorFromUnit(unit);
  if (!vendor) {
    throw new Error("[relay-step] Unit " + eqId + " is not PACCAR or Volvo (make: " + (unit.make||"") + ")");
  }
  logger.info("[relay-step] runRelayStep for", eqId, "| vendor:", vendor);

  // Step 2: duplicate guard
  const existing = await checkExistingDealerWO(unit);
  if (existing) {
    logger.info("[relay-step] Duplicate dealer WO found for", eqId, "| workRequestId:", existing.workRequestId);
    return {
      vendor,
      altId:          existing.altId || "",
      workRequestId:  existing.workRequestId,
      isDuplicate:    true,
      serviceUrl:     existing.serviceUrl || "https://aap-na.corp.amazon.com/v2/service/" + existing.workRequestId,
    };
  }

  // Step 3: create WO
  const result = await createDealerTrackingWO(unit, vendor);
  if (!result.ok) throw new Error("[relay-step] WO creation failed: " + result.error);

  return {
    vendor,
    altId:          result.altId || "",
    workRequestId:  result.workRequestId,
    isDuplicate:    false,
    serviceUrl:     result.serviceUrl,
  };
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * _pollForAltId(serviceUrl, timeoutMs)
 * Opens the WR page in a hidden BrowserWindow and polls for the Alternative ID
 * (AMZ-...) field that AAP generates after WR creation.
 * Returns the altId string or empty string if not found within timeoutMs.
 */
async function _pollForAltId(serviceUrl, timeoutMs) {
  const { BrowserWindow } = require("electron");
  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      show: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const done = (val) => {
      if (settled) return; settled = true;
      clearInterval(pollTimer); clearTimeout(maxTimer);
      try { win.destroy(); } catch (_) {}
      resolve(val || "");
    };
    const maxTimer = setTimeout(() => done(""), timeoutMs);
    let pollTimer;
    win.webContents.on("did-finish-load", () => {
      const url = win.webContents.getURL();
      if (!/aap-na\.corp\.amazon\.com/i.test(url)) return;
      pollTimer = setInterval(async () => {
        if (!win || win.isDestroyed()) { done(""); return; }
        try {
          const raw = await win.webContents.executeJavaScript(
            "(function(){var m=(document.body?document.body.innerText:'').match(/\\b(AMZ-[A-Za-z0-9_-]+)\\b/i);return m?m[1]:'';})()"
          );
          if (raw && raw.startsWith("AMZ-")) { done(raw); }
        } catch (_) {}
      }, 2000);
    });
    win.loadURL(serviceUrl);
  });
}

/**
 * _scrapeGarageListForUnit(equipmentId)
 * Scrapes the AAP Relay Garage All-tab list for a unit and returns WR rows.
 * Lightweight dupe-check helper -- uses default session partition.
 */
async function _scrapeGarageListForUnit(equipmentId) {
  const { BrowserWindow } = require("electron");
  const url = "https://aap-na.corp.amazon.com/page/817ca098-8441-4329-a71e-6768f9d7e6c5?tab=All&ids=" + equipmentId;
  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      show: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const done = (rows) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch (_) {}
      resolve(rows || []);
    };
    const timer = setTimeout(() => done([]), 20000);
    let polls = 0;
    const tryExtract = async () => {
      if (win.isDestroyed()) return;
      const curUrl = win.webContents.getURL();
      if (!/aap-na\.corp\.amazon\.com/i.test(curUrl)) return;
      polls++;
      try {
        const rows = await win.webContents.executeJavaScript('(function(){var rows=[];var anchors=Array.from(document.querySelectorAll("a[href]"));anchors.forEach(function(a){var m=a.href.match(/\/v2\/service\/([a-f0-9-]{36})/i);if(!m)return;var title=(a.textContent||"").trim();rows.push({uuid:m[1],title:title});});var seen={},deduped=[];rows.forEach(function(r){if(!seen[r.uuid]){seen[r.uuid]=1;deduped.push(r);}});return deduped;})()');
        if (Array.isArray(rows) && rows.length > 0) { done(rows); return; }
      } catch (_) {}
      if (polls < 15) setTimeout(tryExtract, 1000);
      else done([]);
    };
    win.webContents.on("did-finish-load", () => setTimeout(tryExtract, 1500));
    win.loadURL(url);
  });
}

/**
 * _scrapeWRTitleAndAltId(serviceUrl)
 * Opens a WR page and extracts its title and Alternative ID.
 * Used by checkExistingDealerWO to inspect the currently active WR.
 */
async function _scrapeWRTitleAndAltId(serviceUrl) {
  const { BrowserWindow } = require("electron");
  return new Promise((resolve) => {
    let settled = false;
    const win = new BrowserWindow({
      show: false, skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    const done = (val) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      try { win.destroy(); } catch (_) {}
      resolve(val);
    };
    const timer = setTimeout(() => done(null), 20000);
    win.webContents.on("did-finish-load", async () => {
      const url = win.webContents.getURL();
      if (!/aap-na\.corp\.amazon\.com/i.test(url)) return;
      await new Promise(r => setTimeout(r, 2500));
      try {
        const data = await win.webContents.executeJavaScript('(function(){var t=document.body?document.body.innerText:"";var title=(t.match(/Service Details for[^.\n]*\n([^\n]{3,120})/)||[])[1]||(document.title||"");var altM=t.match(/\\b(AMZ-[A-Za-z0-9_-]+)\\b/i);return {title:(title||"").trim(),altId:altM?altM[1]:""};})()');
        done(data && data.title ? data : null);
      } catch (_) { done(null); }
    });
    win.loadURL(serviceUrl);
  });
}

module.exports = { runRelayStep, createDealerTrackingWO, checkExistingDealerWO, detectVendorFromUnit, DEALER_WO_TITLES };
