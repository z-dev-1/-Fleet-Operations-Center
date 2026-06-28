'use strict';
const logger = require('../utils/logger').createLogger('adaptive_scraper');
/**
 * Adaptive Scraper — Orcha-powered data extraction from ATS/Relay/Uptake pages
 * 
 * Instead of hardcoded CSS selectors, this:
 * 1. Grabs the full visible text + key elements from the page
 * 2. Sends to Orcha with extraction instructions
 * 3. Orcha returns structured JSON with the data
 * 
 * Used as a SUPPLEMENT to existing scrapers — fills gaps, catches changes,
 * verifies data, and extracts richer context (comments, timelines, ETAs).
 */

// ═══════════════════════════════════════════════════════════════
// PAGE CONTENT EXTRACTOR — grabs everything useful from the page
// ═══════════════════════════════════════════════════════════════
const EXTRACT_SCRIPT = `
(function() {
  function visible(el) { return el.offsetParent !== null || el.offsetHeight > 0; }
  
  // Get ALL visible text organized by sections
  var sections = [];
  var headings = document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*="header"],[class*="title"],[class*="section-label"]');
  headings.forEach(function(h) {
    if (!visible(h)) return;
    sections.push({ heading: (h.innerText || '').trim().substring(0, 100), level: h.tagName });
  });
  
  // Get full page text (limited to 8000 chars to stay in prompt budget)
  var fullText = (document.body ? document.body.innerText : '').replace(/\\s{3,}/g, '\\n\\n').substring(0, 8000);
  
  // Get all links (for offsite events, case numbers, etc.)
  var links = [];
  document.querySelectorAll('a[href]').forEach(function(a) {
    if (!visible(a)) return;
    var href = a.href || '';
    var text = (a.innerText || '').trim().substring(0, 80);
    if (href && text && !href.startsWith('javascript:')) {
      links.push({ text: text, href: href.substring(0, 200) });
    }
  });
  
  // Get table data (comments, timeline, work orders)
  var tables = [];
  document.querySelectorAll('table, [role="table"], [class*="table"]').forEach(function(t) {
    if (!visible(t)) return;
    var rows = [];
    t.querySelectorAll('tr, [role="row"]').forEach(function(r, idx) {
      if (idx > 20) return; // limit rows
      var cells = [];
      r.querySelectorAll('td,th,[role="cell"],[role="columnheader"]').forEach(function(c) {
        cells.push((c.innerText || '').trim().substring(0, 150));
      });
      if (cells.length > 0) rows.push(cells);
    });
    if (rows.length > 0) tables.push(rows);
  });
  
  // Get comments/notes sections (usually in timeline or activity feeds)
  var comments = [];
  var commentEls = document.querySelectorAll('[class*="comment"], [class*="note"], [class*="timeline"], [class*="activity"], [class*="message"]');
  commentEls.forEach(function(el) {
    if (!visible(el)) return;
    var text = (el.innerText || '').trim();
    if (text.length > 10 && text.length < 500) comments.push(text);
  });
  
  // Get any date/time values
  var dates = [];
  var dateEls = document.querySelectorAll('time, [datetime], [class*="date"], [class*="timestamp"]');
  dateEls.forEach(function(el) {
    if (!visible(el)) return;
    dates.push((el.innerText || el.getAttribute('datetime') || '').trim());
  });
  
  return JSON.stringify({
    url: location.href,
    title: document.title,
    fullText: fullText,
    sections: sections.slice(0, 20),
    links: links.slice(0, 30),
    tables: tables.slice(0, 5),
    comments: comments.slice(0, 15),
    dates: dates.slice(0, 20)
  });
})();
`;

// ═══════════════════════════════════════════════════════════════
// EXTRACTION PROMPTS — what to ask Orcha for each page type
// ═══════════════════════════════════════════════════════════════
function buildRelayPrompt(pageData, unitId) {
  return `You are extracting fleet maintenance data from a Relay Garage service page for unit ${unitId}.

PAGE DATA:
${pageData.fullText.substring(0, 6000)}

LINKS ON PAGE:
${(pageData.links || []).map(l => l.text + ' → ' + l.href).join('\n')}

COMMENTS/TIMELINE:
${(pageData.comments || []).join('\n---\n')}

TABLES:
${(pageData.tables || []).map(t => t.map(r => r.join(' | ')).join('\n')).join('\n\n')}

EXTRACT THE FOLLOWING (respond with JSON only, no explanation):
{
  "equipmentId": "unit ID",
  "vendor": "current vendor name",
  "vendorStatus": "what vendor is currently doing (if visible)",
  "lifecycleState": "Available/Unavailable/etc",
  "lifecycleReason": "reason for current state",
  "workDuration": "how long unit has been down",
  "issueDetails": "description of the problem",
  "latestComment": "most recent vendor or system comment (with date if available)",
  "latestCommentDate": "date of most recent comment (MM/DD/YYYY or ISO)",
  "allComments": ["array of all comments in chronological order, each with date prefix if available"],
  "eta": "any mentioned ETA or expected completion date",
  "partsStatus": "any mention of parts ordered/received/backordered",
  "estimateStatus": "submitted/approved/rejected/pending (no dollar amounts)",
  "alternativeId": "alt ID / case number if visible",
  "offsiteUrl": "any Decisiv/DTNA/external vendor portal link found",
  "offsiteCaseNumber": "case number from offsite link",
  "needBy": "need by date if visible",
  "urgent": "yes/no",
  "created": "creation date",
  "workRequestId": "WR ID",
  "make": "vehicle make/model",
  "operator": "operator code",
  "domicileSite": "site code",
  "hasNewActivity": true/false (based on whether latest comment appears recent - within last 24hrs)
}

If a field is not found on the page, use empty string "". 
For hasNewActivity, consider if the latest comment date is within the last 24 hours.
Respond with ONLY the JSON object.`;
}

function buildUptakePrompt(pageData, unitId) {
  return `You are extracting fleet diagnostic/sensor data from an Uptake analytics page for unit ${unitId}.

PAGE DATA:
${pageData.fullText.substring(0, 6000)}

TABLES:
${(pageData.tables || []).map(t => t.map(r => r.join(' | ')).join('\n')).join('\n\n')}

EXTRACT THE FOLLOWING (respond with JSON only):
{
  "equipmentId": "unit ID",
  "faultCodes": ["array of active fault codes (DTC/SPN/FMI)"],
  "insights": ["array of AI-generated insights or alerts"],
  "healthScore": "numeric health score if visible",
  "lastReportedLocation": "GPS or site location",
  "sensorAlerts": ["any sensor readings that are abnormal"],
  "pmDueDate": "next PM due date if visible",
  "dotInspectionDue": "DOT inspection due date",
  "mileage": "current odometer reading",
  "engineHours": "current engine hours",
  "fuelLevel": "fuel level if visible",
  "defLevel": "DEF level if visible",
  "tireData": "any tire pressure/tread data",
  "hasNewAlerts": true/false (any alerts that appeared recently)
}

If a field is not found, use empty string or empty array [].
Respond with ONLY the JSON object.`;
}

function buildATSPrompt(pageData, unitId) {
  return `You are extracting fleet status data from an ATS (Amazon Transport Services) page for unit ${unitId}.

PAGE DATA:
${pageData.fullText.substring(0, 6000)}

TABLES:
${(pageData.tables || []).map(t => t.map(r => r.join(' | ')).join('\n')).join('\n\n')}

EXTRACT THE FOLLOWING (respond with JSON only):
{
  "equipmentId": "unit ID",
  "atsState": "Available/Unavailable/In-Service/etc",
  "atsReason": "reason for current state",
  "assignedRoute": "if assigned to a route",
  "lastLocation": "last known location or geofence",
  "lastMoveDate": "when it last moved",
  "domicile": "home site",
  "operator": "operator code",
  "bodyType": "Day Cab/Sleeper/Box Truck/etc",
  "make": "make/model/year",
  "vin": "VIN number",
  "openWorkRequests": "count or list of open WRs",
  "riskScore": "risk score if visible",
  "hasStatusChange": true/false (any change from typical state)
}

If a field is not found, use empty string.
Respond with ONLY the JSON object.`;
}

// ═══════════════════════════════════════════════════════════════
// MAIN EXTRACTION FUNCTION
// ═══════════════════════════════════════════════════════════════
/**
 * Extract data from a page using Orcha AI
 * @param {BrowserWindow|WebContents} target - the window/webcontents to extract from
 * @param {string} pageType - 'relay' | 'uptake' | 'ats'
 * @param {string} unitId - the unit being scraped
 * @param {Function} askAI - the askOrcha function
 * @param {Function} log - logging function
 * @returns {Object} extracted data or null on failure
 */
async function adaptiveExtract(target, pageType, unitId, askAI, log) {
  if (!log) log = console.log;
  
  const webContents = target.webContents ? target.webContents : target;
  
  // 1. Extract page content
  let pageData;
  try {
    const raw = await webContents.executeJavaScript(EXTRACT_SCRIPT);
    pageData = JSON.parse(raw);
  } catch (e) {
    log(`[AdaptiveScraper] DOM extraction failed for ${unitId}: ${e.message}`);
    return null;
  }
  
  // ═══ WRONG PAGE DETECTION ═══
  // Quick check: does the page text contain our unit ID?
  const pageText = (pageData.fullText || '').toUpperCase();
  const targetId = unitId.toUpperCase();
  if (!pageText.includes(targetId)) {
    log(`[AdaptiveScraper] ⚠️ WRONG PAGE detected for ${unitId} — unit ID not found on page!`);
    
    // Try to identify what unit IS on this page
    const idMatch = pageText.match(/\b([A-Z]-?\d{4,6})\b/) || pageText.match(/\b(V\d{5,7})\b/);
    const wrongUnit = idMatch ? idMatch[1] : 'unknown';
    log(`[AdaptiveScraper] Page appears to show: ${wrongUnit} instead of ${unitId}`);
    
    // Attempt correction: navigate to the correct URL
    const corrected = await attemptCorrection(webContents, unitId, pageData, log);
    if (corrected) {
      // Re-extract after correction
      try {
        const raw2 = await webContents.executeJavaScript(EXTRACT_SCRIPT);
        pageData = JSON.parse(raw2);
        const verifyText = (pageData.fullText || '').toUpperCase();
        if (!verifyText.includes(targetId)) {
          log(`[AdaptiveScraper] ✗ Correction failed — still wrong page. Skipping ${unitId}.`);
          return { _error: 'wrong_page', _wrongUnit: wrongUnit, _targetUnit: unitId };
        }
        log(`[AdaptiveScraper] ✓ Correction succeeded — now on correct page for ${unitId}`);
      } catch (e) {
        log(`[AdaptiveScraper] Re-extraction failed after correction: ${e.message}`);
        return { _error: 'wrong_page', _wrongUnit: wrongUnit, _targetUnit: unitId };
      }
    } else {
      return { _error: 'wrong_page', _wrongUnit: wrongUnit, _targetUnit: unitId };
    }
  }
  
  // 2. Build prompt based on page type
  let prompt;
  switch (pageType) {
    case 'relay': prompt = buildRelayPrompt(pageData, unitId); break;
    case 'uptake': prompt = buildUptakePrompt(pageData, unitId); break;
    case 'ats': prompt = buildATSPrompt(pageData, unitId); break;
    default: log(`[AdaptiveScraper] Unknown page type: ${pageType}`); return null;
  }
  
  // 3. Ask Orcha
  let aiResponse;
  try {
    log(`[AdaptiveScraper] Asking Orcha to extract ${pageType} data for ${unitId}...`);
    const result = await askAI(prompt);
    aiResponse = (result && result.text) ? result.text.trim() : (typeof result === 'string' ? result.trim() : '');
  } catch (e) {
    log(`[AdaptiveScraper] Orcha error for ${unitId}: ${e.message}`);
    return null;
  }
  
  // 4. Parse response
  let data;
  try {
    let cleaned = aiResponse.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
    data = JSON.parse(cleaned);
    log(`[AdaptiveScraper] ✓ Extracted ${pageType} data for ${unitId}: ${Object.keys(data).filter(k => data[k] && data[k] !== '' && !(Array.isArray(data[k]) && data[k].length === 0)).length} fields`);
  } catch (e) {
    log(`[AdaptiveScraper] Failed to parse Orcha response for ${unitId}: ${aiResponse.substring(0, 100)}`);
    return null;
  }
  
  // ═══ POST-EXTRACTION VERIFICATION ═══
  // Double-check: does the extracted equipmentId match what we expected?
  if (data.equipmentId && data.equipmentId.toUpperCase() !== targetId) {
    log(`[AdaptiveScraper] ⚠️ POST-EXTRACT MISMATCH: Extracted ${data.equipmentId} but expected ${unitId}`);
    data._mismatch = true;
    data._expectedUnit = unitId;
    data._actualUnit = data.equipmentId;
  }
  
  return data;
}

/**
 * Attempt to navigate to the correct unit page
 */
async function attemptCorrection(webContents, unitId, pageData, log) {
  const AAP_SERVICE_BASE = 'https://aap-na.corp.amazon.com/v2/service/';
  const AAP_GARAGE = 'https://aap-na.corp.amazon.com/page/817ca098-8441-4329-a71e-6768f9d7e6c5?tab=Unplanned&ids=';
  
  log(`[AdaptiveScraper] Attempting correction — navigating to Relay Garage for ${unitId}...`);
  
  try {
    // Try direct Relay Garage search URL
    const correctUrl = AAP_GARAGE + encodeURIComponent(unitId);
    await webContents.loadURL(correctUrl);
    await new Promise(r => setTimeout(r, 4000)); // Wait for page load
    
    // Check if we need to click into the unit's WR
    const clickResult = await webContents.executeJavaScript(`
      (function() {
        var targetId = '${unitId.replace(/'/g, "\\'")}';
        // Look for a clickable row/link containing the unit ID
        var links = document.querySelectorAll('a, [role="row"], tr, [class*="row"]');
        for (var i = 0; i < links.length; i++) {
          var text = (links[i].innerText || '').trim();
          if (text.toUpperCase().includes(targetId.toUpperCase())) {
            links[i].click();
            return 'clicked';
          }
        }
        // Check if page already has the unit
        var pageText = (document.body ? document.body.innerText : '').toUpperCase();
        if (pageText.includes(targetId.toUpperCase())) return 'already_here';
        return 'not_found';
      })();
    `);
    
    if (clickResult === 'clicked') {
      await new Promise(r => setTimeout(r, 3000)); // Wait for navigation
      log(`[AdaptiveScraper] Clicked into ${unitId} WR — waiting for load...`);
      return true;
    } else if (clickResult === 'already_here') {
      log(`[AdaptiveScraper] Page already shows ${unitId} after navigation`);
      return true;
    } else {
      log(`[AdaptiveScraper] Could not find ${unitId} on corrected page`);
      return false;
    }
  } catch (e) {
    log(`[AdaptiveScraper] Correction navigation failed: ${e.message}`);
    return false;
  }
}

/**
 * Compare adaptive extraction with existing scraped data.
 * Returns enriched/merged data + any new findings.
 */
function mergeWithExisting(adaptiveData, existingData, log) {
  if (!adaptiveData) return existingData;
  if (!existingData) return adaptiveData;
  if (!log) log = console.log;
  
  const merged = { ...existingData };
  const newFindings = [];
  
  for (const [key, val] of Object.entries(adaptiveData)) {
    if (!val || val === '' || (Array.isArray(val) && val.length === 0)) continue;
    
    const existing = merged[key];
    
    // New field not in existing
    if (!existing || existing === '' || existing === '--') {
      merged[key] = val;
      newFindings.push(`NEW: ${key} = ${typeof val === 'string' ? val.substring(0, 50) : JSON.stringify(val).substring(0, 50)}`);
    }
    // Array fields — merge unique values
    else if (Array.isArray(val) && Array.isArray(existing)) {
      const combined = [...new Set([...existing, ...val])];
      if (combined.length > existing.length) {
        merged[key] = combined;
        newFindings.push(`UPDATED: ${key} (${existing.length} → ${combined.length} items)`);
      }
    }
    // String fields — prefer longer/more detailed
    else if (typeof val === 'string' && typeof existing === 'string') {
      if (val.length > existing.length + 5 && key !== 'equipmentId') {
        merged[key] = val;
        newFindings.push(`ENRICHED: ${key}`);
      }
    }
  }
  
  if (newFindings.length > 0) {
    log(`[AdaptiveScraper] Merge found ${newFindings.length} improvements: ${newFindings.slice(0, 5).join(', ')}`);
  }
  
  merged._adaptiveFindings = newFindings;
  merged._adaptiveTimestamp = new Date().toISOString();
  return merged;
}

/**
 * Quick check: should we bother running adaptive extraction?
 * Returns true if there are signs the page has new info worth extracting.
 */
async function hasNewContent(webContents, lastScanTimestamp) {
  try {
    const check = await webContents.executeJavaScript(`
      (function() {
        var text = (document.body ? document.body.innerText : '');
        var len = text.length;
        // Check for recent timestamps in the page
        var now = new Date();
        var today = now.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        var yesterday = new Date(now - 86400000).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
        var hasToday = text.includes(today) || text.includes(today.replace(/\\/20/g, '/'));
        var hasYesterday = text.includes(yesterday) || text.includes(yesterday.replace(/\\/20/g, '/'));
        return JSON.stringify({ textLength: len, hasToday: hasToday, hasYesterday: hasYesterday });
      })();
    `);
    const result = JSON.parse(check);
    return result.hasToday || result.hasYesterday;
  } catch (e) {
    return true; // If we can't check, extract anyway
  }
}

/**
 * DATA INTEGRITY VALIDATOR — catches logical mismatches in unit data
 * 
 * Detects things like:
 * - Unavailable unit classified as Planned/PM when it should be Unplanned
 * - Missing work orders for downed units
 * - Maintenance type doesn't match lifecycle state
 * - Stale data (unit marked unavailable but no activity in days)
 */
function validateUnitData(unit, log) {
  if (!log) log = console.log;
  const issues = [];
  
  const state = (unit.atsState || unit.lifecycleState || '').toLowerCase();
  const reason = (unit.lifecycleReason || unit.relayStatus || '').toLowerCase();
  const category = (unit.category || unit.maintenanceType || '').toLowerCase();
  const hasWO = !!(unit.serviceUrl || unit.altId || unit.workRequestId);
  const vendor = (unit.vendor || '').toLowerCase();
  
  // ═══ MISMATCH: Unavailable but categorized as Planned/PM ═══
  if (state.includes('unavail')) {
    if (category.includes('pm') || category.includes('planned') || reason.includes('pm ') || reason.includes('planned')) {
      // Check if there's evidence this is actually unplanned
      const issue = (unit.issue || '').toLowerCase();
      const hasUnplannedSigns = issue.includes('check engine') || issue.includes('cel') || issue.includes('leak') ||
        issue.includes('flat') || issue.includes('broke') || issue.includes('fault') || issue.includes('warning') ||
        issue.includes('damage') || issue.includes('accident') || issue.includes('tow') || issue.includes('derate') ||
        issue.includes('not starting') || issue.includes('won\'t start') || !hasWO;
      
      if (hasUnplannedSigns || !hasWO) {
        issues.push({
          type: 'WRONG_CATEGORY',
          severity: 'high',
          message: `Unit ${unit.id} is Unavailable but categorized as "${category || reason}". Likely should be Unplanned.`,
          suggestion: 'Recategorize to Unplanned. If no WR exists, one needs to be created.',
          autoFix: { category: 'Unplanned', maintenanceType: 'Unplanned' }
        });
      }
    }
    
    // ═══ MISMATCH: Unavailable with NO work order ═══
    if (!hasWO && !reason.includes('end of life') && !reason.includes('legal hold') && !reason.includes('sold')) {
      issues.push({
        type: 'MISSING_WORK_ORDER',
        severity: 'high',
        message: `Unit ${unit.id} is Unavailable but has no Work Order/Alt ID. Needs a WR created.`,
        suggestion: 'Create an Unplanned Work Request for this unit.',
        autoFix: null // Can't auto-fix — needs human to create WR
      });
    }
    
    // ═══ MISMATCH: Unavailable but vendor is empty ═══
    if (!vendor && !reason.includes('end of life') && !reason.includes('legal hold')) {
      issues.push({
        type: 'MISSING_VENDOR',
        severity: 'medium',
        message: `Unit ${unit.id} is Unavailable but has no vendor assigned.`,
        suggestion: 'Check Relay Garage — unit may need vendor assignment.',
        autoFix: null
      });
    }
  }
  
  // ═══ MISMATCH: Available but has open unresolved WR ═══
  if (state.includes('avail') && !state.includes('unavail') && hasWO && reason && !reason.includes('complet')) {
    issues.push({
      type: 'AVAILABLE_WITH_OPEN_WR',
      severity: 'medium',
      message: `Unit ${unit.id} is Available but still has an open WR (${unit.altId || 'unknown'}). May need WR closed.`,
      suggestion: 'Verify repair is complete. If so, close the WR in Relay Garage.',
      autoFix: null
    });
  }
  
  // ═══ STALE: Unavailable with no activity in 7+ days ═══
  if (state.includes('unavail') && unit.duration) {
    const durationMatch = (unit.duration || '').match(/(\d+)d/);
    if (durationMatch && parseInt(durationMatch[1]) >= 7) {
      if (!unit.latestComment && !unit._hasNewActivity) {
        issues.push({
          type: 'STALE_NO_ACTIVITY',
          severity: 'medium',
          message: `Unit ${unit.id} has been down ${unit.duration} with no recent vendor activity.`,
          suggestion: 'Follow up with vendor. Consider escalation.',
          autoFix: null
        });
      }
    }
  }
  
  if (issues.length > 0) {
    log(`[Validator] ${unit.id}: Found ${issues.length} issue(s): ${issues.map(i => i.type).join(', ')}`);
  }
  
  return issues;
}

/**
 * ALT ID PRIORITY — if unit has multiple WRs, prefer unplanned over planned
 * Also updates offsite URL if a better Decisiv match is found
 */
function prioritizeAltId(unit, adaptiveData, log) {
  if (!log) log = console.log;
  if (!adaptiveData) return unit;

  const fixed = { ...unit };

  // If adaptive found a WR that's unplanned and current altId points to planned/PM
  const currentCategory = (unit.category || unit.maintenanceType || '').toLowerCase();
  const isCurrentPlanned = currentCategory.includes('pm') || currentCategory.includes('planned');

  if (isCurrentPlanned && adaptiveData.workRequestId && adaptiveData.workRequestId !== unit.altId) {
    const adaptiveCategory = (adaptiveData.category || '').toLowerCase();
    if (!adaptiveCategory.includes('pm') && !adaptiveCategory.includes('planned')) {
      log(`[AltID] ${unit.id}: Switching Alt ID from planned "${unit.altId}" to unplanned "${adaptiveData.workRequestId}"`);
      fixed.altId = adaptiveData.workRequestId;
      fixed.category = 'Unplanned';
      fixed.maintenanceType = 'Unplanned';
      if (adaptiveData.serviceUrl) fixed.serviceUrl = adaptiveData.serviceUrl;
    }
  }

  // If adaptive found a better offsite Decisiv/DTNA URL
  if (adaptiveData.offsiteUrl && adaptiveData.offsiteUrl.length > 10) {
    const currentOffsite = unit.offsiteShopEventUrl || unit.savedOffsiteUrl || '';
    if (!currentOffsite || adaptiveData.offsiteUrl.length > currentOffsite.length) {
      log(`[Offsite] ${unit.id}: Better Decisiv match found: ${adaptiveData.offsiteCaseNumber || adaptiveData.offsiteUrl.substring(0, 40)}`);
      fixed.offsiteShopEventUrl = adaptiveData.offsiteUrl;
      fixed.savedOffsiteUrl = adaptiveData.offsiteUrl;
      if (adaptiveData.offsiteCaseNumber) {
        fixed.offsiteShopEvent = adaptiveData.offsiteCaseNumber;
        fixed.savedOffsiteEvent = adaptiveData.offsiteCaseNumber;
      }
    }
  }

  return fixed;
}

/**
 * Apply auto-fixes from validation issues
 * Returns the corrected unit data
 */
function applyAutoFixes(unit, issues, log) {
  if (!log) log = console.log;
  let fixed = { ...unit };
  let fixCount = 0;
  
  for (const issue of issues) {
    if (issue.autoFix) {
      for (const [key, val] of Object.entries(issue.autoFix)) {
        const oldVal = fixed[key] || '';
        fixed[key] = val;
        log(`[Validator] AUTO-FIX ${unit.id}: ${key} "${oldVal}" → "${val}" (${issue.type})`);
        fixCount++;
      }
    }
  }
  
  if (fixCount > 0) {
    fixed._autoFixed = true;
    fixed._fixedAt = new Date().toISOString();
    fixed._fixCount = fixCount;
  }
  
  return fixed;
}

module.exports = { adaptiveExtract, mergeWithExisting, hasNewContent, validateUnitData, applyAutoFixes, prioritizeAltId, EXTRACT_SCRIPT };
