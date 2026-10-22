'use strict';
/**
 * aap_api_mapper.js — Translate AAP/RG API records into the app's fleet-row
 * shape, so the API can feed the SAME renderer + merge pipeline the scrape does.
 *
 * Confirmed live field names (2026-10-16):
 *   WORK ORDER (serviceaggregates/search → serviceAggregates[]):
 *     id, workRequestId, aaid, assetDisplayName (=unit#), assetType, assetProgram,
 *     assetDomicileSite, assetRentalStatus, vendor (RAW enum), suppliers, providers,
 *     status{displayText,value}, subStatus, isUrgent, lifecycleState,
 *     lifecycleStateReason (RAW enum), delayReasonCodes[], damageDescription,
 *     scheduledDateTime, expectedStartDateTime, actualStartDateTime,
 *     expectedCompletedDateTime, completedDateTime, suggestedItems[]
 *       {level1,level2,level3,vmrsL*Code,reasonForRepair}, escalations,
 *     totalEstimatePendingApprovalCost, vendorWorkOrderIds[]
 *   SERVICE DETAIL (serviceaggregates/{id}):
 *     workRequest.comments[] { timestamp, text, createdBy, internalOnly,
 *       onBehalfOf, externalConsumers }, workOrders[], serviceEvents[]
 *   ASSET (assets/{aaid}): asset.attributesText.{vin,model,...}, latestLocation.
 *
 * The app's fleet row (see src/scrapers/relay.js mergeRelayIntoRows + AAP_FIELD_MAP)
 * uses HUMANIZED values: lifecycleState "Unavailable", lifecycleReason "Parts Delay",
 * vendor "Volvo (ASIST)". The API returns RAW enums (UNAVAILABLE, PARTS_DELAY, VOLVO).
 * These maps translate so the UI, filters, and Create-WR vendor lookup are unchanged.
 */

// ── Lifecycle state (RAW → humanized, matching the scrape's values) ──────────
const LIFECYCLE_STATE = {
  ACTIVE: 'Active',
  UNAVAILABLE: 'Unavailable',
  ORDERED: 'Ordered',
  INACTIVE: 'Inactive',
};

// ── Lifecycle reason (RAW enum → humanized). Covers the reasons seen in the
// live data; unknown values fall back to a title-cased transform. ──────────
const LIFECYCLE_REASON = {
  PARTS_DELAY: 'Parts Delay',
  OFFSITE_SHOP_REPAIR: 'Offsite Shop Repair',
  DAMAGED_MODERATE: 'Damaged-Moderate',
  DAMAGED_SEVERE: 'Damaged-Severe',
  DAMAGED: 'Damaged',
  SENSOR_DETECTED_DAMAGE: 'Sensor Detected Damage',
  PREVENTATIVE_MAINTENANCE: 'Preventative Maintenance',
  RECONDITIONING: 'Reconditioning',
  TO_BE_RETURNED: 'To Be Returned',
  READY_TO_RENT: 'Ready to Rent',
};

// ── Vendor (RAW enum → the display name the app + Create-WR expect) ───────────
// Create-WR (aap_create_wr.js VENDOR_IDS) keys supplierId lookup on these exact
// strings, so the API mapper MUST emit the same labels to keep that action working.
const VENDOR_DISPLAY = {
  VOLVO: 'Volvo (ASIST)',
  PACCAR: 'Peterbilt (PACCAR)',
  PETERBILT: 'Peterbilt (PACCAR)',
  KENWORTH: 'Kenworth (PACCAR)',
  FREIGHTLINER: 'Freightliner (DAIMLER)',
  DAIMLER: 'Freightliner (DAIMLER)',
  AMERIT: 'Amerit',
  CUMMINS: 'CUMMINS',
  GOODYEAR: 'GOODYEAR',
  FLEETNET: 'FLEETNET',
  VELOCITI: 'VELOCITI',
  CEI: 'CEI (CEI)',
  TA: 'TA',
};

function _titleCaseEnum(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function mapLifecycleState(raw)  { const k = String(raw || '').toUpperCase(); return LIFECYCLE_STATE[k] || (raw ? _titleCaseEnum(raw) : ''); }
function mapLifecycleReason(raw) { const k = String(raw || '').toUpperCase(); return LIFECYCLE_REASON[k] || (raw ? _titleCaseEnum(raw) : ''); }
function mapVendor(raw)          { const k = String(raw || '').toUpperCase(); return VENDOR_DISPLAY[k] || (raw || ''); }

// Vendors EXCLUDED from the Fleet Repair Intelligence feature (unit history,
// trends, vendor-network): Velocity/Velociti, Fleetnet, Goodyear. This is the
// SINGLE canonical chokepoint — every WO's vendor already flows through the
// mapper, so the repair-history collector/service calls isExcludedVendor() here
// instead of scattering the filter. Matches on the normalized (raw or display)
// vendor string. (Mirrors the existing aap_wo_scraper SKIP_VENDORS convention,
// and ADDS goodyear which that list was missing.)
const EXCLUDED_VENDORS = ['velocity', 'velociti', 'fleetnet', 'fleet net', 'goodyear'];
function isExcludedVendor(raw) {
  const v = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
  return EXCLUDED_VENDORS.some((x) => v.includes(x.replace(/[^a-z]/g, '')));
}

// Accepts epoch milliseconds (number or numeric string) OR an ISO/date string.
// Returns a clean ISO string, or '' if the input isn't a valid date — so the
// UI never renders "Invalid Date".
function _epochToIso(v) {
  if (v == null || v === '') return '';
  // Pure-numeric → treat as epoch ms.
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    if (!n || Number.isNaN(n)) return '';
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString();
  }
  // Otherwise try to parse as a date string (ISO, etc.).
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

// Humanized "down for" duration from a start epoch, matching the scrape's
// "Nd Nh Nm" style so the UI/detail panel read identically.
function _durationFrom(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  let secs = Math.floor((Date.now() - n) / 1000);
  if (secs < 0) return '';
  const d = Math.floor(secs / 86400); secs -= d * 86400;
  const h = Math.floor(secs / 3600);  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  return d + 'd ' + h + 'h ' + m + 'm';
}

// Turn the structured comment thread into a clean, attributed, timestamped
// timeline string (newest last), mirroring the repairTimeline format the app
// already uses. Decodes common HTML entities from the API text. Optionally
// drops internal-only comments for an external-facing view.

// Extract PM due-date raw fields from an asset's maintenanceScheduleStatuses[]
// (returned by GET /api/v1/assets/{aaid}). CONFIRMED live (2026-10-17): each
// entry has maintenanceType (DOT|PM_A|PM_B|PM_X|QUARTERLY_LIFT|WASH|...),
// nextDueDate ("2026-09-11" ISO), and dueDateDisplayFormat (DATE|MONTH_AND_YEAR).
// We emit the same raw per-label fields the scrape produced (pmBDue/pmXDue/
// dotDue/quarterlyLiftDue) in the "Mon D, YYYY" / "Mon YYYY" form that
// relay.js _formatPmDate()/_parsePMDates() expect, so the PM pills render
// identically (overdue | "Mon D" | --).
const _PM_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function _isoToPmRaw(iso, monthOnly) {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3]);
  if (mo < 0 || mo > 11) return null;
  return monthOnly
    ? (_PM_MONTHS[mo] + ' ' + y)              // "Feb 2027"
    : (_PM_MONTHS[mo] + ' ' + d + ', ' + y);  // "Sep 11, 2026"
}
function pmDueFields(assetFull) {
  const statuses = (assetFull && (assetFull.asset && assetFull.asset.maintenanceScheduleStatuses
    || assetFull.maintenanceScheduleStatuses)) || [];
  const out = { pmBDue: null, pmXDue: null, dotDue: null, quarterlyLiftDue: null };
  if (!Array.isArray(statuses)) return out;
  const KEY = { PM_B: 'pmBDue', PM_X: 'pmXDue', DOT: 'dotDue', QUARTERLY_LIFT: 'quarterlyLiftDue' };
  for (const s of statuses) {
    const key = KEY[String(s && s.maintenanceType || '').toUpperCase()];
    if (!key || !s.nextDueDate) continue;
    const monthOnly = String(s.dueDateDisplayFormat || '').toUpperCase() === 'MONTH_AND_YEAR';
    const raw = _isoToPmRaw(s.nextDueDate, monthOnly);
    if (raw) out[key] = raw;
  }
  return out;
}

// Resolve a unit's current location (geofence / site) for the "Last Geofence"
// field. Prefers the WO's reported location, then the asset's latest-location
// geofences, then the yard building, then the domicile site — so EVERY unit
// shows something, not just ones with an open WO.
function _pickLocation(wo, assetSummary) {
  const aSum = (assetSummary && assetSummary.asset) || {};
  const aLoc = (assetSummary && assetSummary.latestLocation) || {};
  const wLoc = (wo && wo.latestLocation) || {};
  const rLoc = (wo && wo.reportedLocation) || {};
  const firstGeo = (g) => Array.isArray(g) && g.length ? (g[0] && (g[0].name || g[0].geofenceName || g[0])) : '';
  return (
    (rLoc && (rLoc.geofenceName || rLoc.code)) ||
    firstGeo(wLoc.geoFences) || firstGeo(aLoc.geoFences) ||
    (aLoc.geofenceName || aLoc.yardBuildingID || aLoc.lastKnownSite) ||
    (aSum.attributesText && aSum.attributesText.domicileSite) ||
    (wo && wo.assetDomicileSite) || ''
  );
}

// Extract the best OFFSITE (Decisiv / Volvo ASIST / PACCAR estimate / DTNA)
// URL from a service detail's comment thread. The AAP/RG API has NO offsite URL
// field — but the dealer/offsite links are pasted into comments[].text (the
// same place the scrape path's RELAY_CONVERSATION_SCRIPT harvested them from the
// DOM). We replicate pickOffsiteFromConversation: prefer a Fleet Estimate, then
// a Service Request, then DTNA; NEWEST-WINS (last match in the oldest-first
// thread). Returns { url, label, source } or null. serviceDetail may be the
// full aggregate (with workRequest.comments[]) or anything collectAllComments
// can read.
function extractOffsiteFromComments(serviceDetail) {
  const comments = collectAllComments(serviceDetail);
  if (!comments.length) return null;
  // Oldest-first already (collectAllComments sorts ascending). Concatenate text.
  const text = comments.map((c) => String(c.text || '')).join('\n');
  const grabAll = (re) => {
    const urls = []; let m; re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const url = m[0].split(/[\s"'<>)]/)[0];
      if (url) urls.push(url);
    }
    return urls;
  };
  const est = grabAll(/https?:\/\/[a-z0-9.\-]+decisiv\.net\/fleet\/estimates\/[A-Za-z0-9_\-]+/gi);
  const req = grabAll(/https?:\/\/[a-z0-9.\-]+decisiv\.net\/service_requests\/[A-Za-z0-9_\-]+/gi);
  const dtna = grabAll(/https?:\/\/dtna\.my\.site\.com\/Servicetracker\/s\/case\/[A-Za-z0-9_\-]+/gi);
  // newest-wins: last element of the preferred non-empty list.
  if (est.length)  return { url: est[est.length - 1],  label: 'Fleet Estimate', source: 'estimate' };
  if (req.length)  return { url: req[req.length - 1],  label: 'Service Request', source: 'service_request' };
  if (dtna.length) return { url: dtna[dtna.length - 1], label: 'DTNA Case', source: 'dtna' };
  return null;
}

// Read a work order's human/enum status, tolerant of the API's shapes. CONFIRMED
// (2026-10-16): the live shape is status.description.{displayText,value} with
// status.type ("Alert" for cancelled, "Complete", "Neutral"). Older/other shapes
// put displayText/value directly on status. Returns { value, displayText, type }.
function woStatus(wo) {
  const s = (wo && wo.status) || {};
  const d = s.description || s;   // nested (current) or flat (legacy)
  return {
    value:       String(d.value || '').trim(),
    displayText: String(d.displayText || '').trim(),
    type:        String(s.type || '').trim(),
  };
}

// Gather the COMPLETE comment thread from a service-detail response. For the
// units checked, the whole conversation lives in workRequest.comments[], but a
// service aggregate can also carry vendor-side comments under workOrders[] (and
// occasionally a workRequests[] array). Collect from every location, dedupe by
// timestamp+text, and sort oldest→newest so the timeline is the full thread.
function collectAllComments(serviceDetail) {
  if (!serviceDetail) return [];
  const buckets = [];
  const wr = serviceDetail.workRequest;
  if (wr && Array.isArray(wr.comments)) buckets.push(wr.comments);
  if (Array.isArray(serviceDetail.workRequests)) {
    for (const w of serviceDetail.workRequests) if (w && Array.isArray(w.comments)) buckets.push(w.comments);
  }
  if (Array.isArray(serviceDetail.workOrders)) {
    for (const w of serviceDetail.workOrders) if (w && Array.isArray(w.comments)) buckets.push(w.comments);
  }
  const seen = new Set();
  const all = [];
  for (const b of buckets) {
    for (const c of b) {
      if (!c || !c.text) continue;
      const key = (c.timestamp || '') + '|' + c.text;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(c);
    }
  }
  all.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
  return all;
}

function commentsToTimeline(comments, opts = {}) {
  if (!Array.isArray(comments) || !comments.length) return '';
  const includeInternal = opts.includeInternal !== false; // default: include
  const decode = (t) => String(t || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').trim();
  const rows = comments
    .filter((c) => c && c.text && (includeInternal || !c.internalOnly))
    .map((c) => {
      const ts = c.timestamp ? new Date(c.timestamp) : null;
      const date = ts && !isNaN(ts) ? (String(ts.getMonth() + 1).padStart(2, '0') + '/' + String(ts.getDate()).padStart(2, '0')) : '';
      const who = c.createdBy ? (' ' + c.createdBy) : '';
      const tag = c.internalOnly ? ' [internal]' : '';
      return (date ? date + ' -' : '-') + who + tag + ': ' + decode(c.text);
    });
  return rows.join('\n');
}

// ── Body type (RAW enum → humanized, matching the scrape's display) ─────────
// Confirmed values: DAY_CAB, SLEEPER, STANDARD (box truck body). Unknown falls
// back to title-case.
const BODY_TYPE = {
  DAY_CAB: 'Day Cab',
  SLEEPER: 'Sleeper',
  STANDARD: 'Box Truck',   // box-truck body comes back as STANDARD — show "Box Truck"
  BOX: 'Box Truck',
  REEFER: 'Reefer',
  FLATBED: 'Flatbed',
};
// assetType is passed so a STANDARD body on a non-box asset isn't mislabeled.
function mapBodyType(raw, assetType) {
  const k = String(raw || '').toUpperCase();
  if (k === 'STANDARD') {
    // STANDARD is the box-truck body; label it "Box Truck" (the assetType is
    // boxTruck for these). For any non-box asset, fall back to title-case.
    if (!assetType || /box/i.test(assetType)) return 'Box Truck';
    return 'Standard';
  }
  return BODY_TYPE[k] || (raw ? _titleCaseEnum(raw) : '');
}

// Pull the master-data fields from a full single-asset response. CONFIRMED live
// (2026-10-16): everything is under asset.attributesText.* (not the lightweight
// search summary). This is where operator, owner, domicileSite, bodyType, make,
// engine, VIN live — the reason those columns were blank before was that the
// mapper read them off the WO/summary, which don't carry them.
function assetDetailFields(full) {
  const a  = (full && full.asset) || {};
  const at = a.attributesText || {};
  const ai = a.attributesInteger || {};
  const loc = (full && full.latestLocation) || {};
  return {
    vin:          at.vin || '',
    model:        at.model || at.modelName || '',
    manufacturer: at.manufacturerName || at.manufacturer || at.make || '',
    engineManufacturer: at.engineManufacturerName || at.engineManufacturer || '',
    modelYear:    ai.yearManufactured || at.modelYear || '',
    operator:     at.operator || '',
    owner:        at.owner || '',
    domicileSite: at.domicileSite || '',
    bodyType:     mapBodyType(at.bodyType, a.assetType),
    odometerMiles: loc.odometerInMiles != null ? Math.round(Number(loc.odometerInMiles))
      : (loc.odometerInKm != null ? Math.round(Number(loc.odometerInKm) * 0.621371) : ''),
    engineHours: loc.engineHours != null ? loc.engineHours : '',
  };
}

// Map a work-order aggregate (+ optional asset summary + optional full service
// detail with comments) into the app's fleet-row field names. This mirrors the
// field set relay.js/mergeRelayIntoRows produces so the renderer + downstream
// merges (Uptake, offsite) see a familiar row.
function toFleetRow(wo, assetSummary, serviceDetail) {
  const aSum = (assetSummary && assetSummary.asset) || {};
  const loc  = (wo && wo.latestLocation) || (assetSummary && assetSummary.latestLocation) || {};

  // Suggested items → L1/L2 lists (for Level 1/Level 2 columns + issue summary).
  const l1 = []; const l2 = [];
  for (const si of (wo.suggestedItems || [])) {
    if (si && si.level1 && !l1.includes(si.level1)) l1.push(si.level1);
    if (si && si.level2 && !l2.includes(si.level2)) l2.push(si.level2);
  }

  // Conversation → RAW feed for the AI timeline builder (deep-scan.js). We do
  // NOT put raw comments into repairTimeline — that field is the AI-BUILT
  // professional timeline (same as the scrape path). Instead we assemble a raw
  // conversation blob into fullConversation for the AI to transform, EXCLUDING
  // internal-only comments (carolddu [internal], VRE OVERRIDE, etc. — the API
  // exposes an internalOnly flag the scrape path never had; honor it so those
  // never surface). The deep-scan prompt header-strips from the word
  // "Conversation", so prefix with it.
  const extComments = collectAllComments(serviceDetail).filter((c) => !(c && c.internalOnly));
  const fullConversation = extComments.length
    ? ('Conversation\n' + commentsToTimeline(extComments, { includeInternal: false }))
    : '';
  // repairTimeline stays EMPTY here — runOrchaDeepScan builds it from
  // fullConversation (+ offsite notes) and writes it back. mergeRelayIntoRows
  // re-stamps any previously-built timeline from notesStore onto the row.
  const timeline = '';

  // OFFSITE URL — extracted from the comment thread (incl. internal comments,
  // which is where the Decisiv/ASIST estimate link is usually pasted). Gives
  // Split View its right pane + the offsite link for the detail card, and the
  // URL the deep-scan uses to pull offsite notes for the AI timeline.
  const _offsite = extractOffsiteFromComments(serviceDetail);

  const downStart = wo.actualStartDateTime || wo.expectedStartDateTime || wo.scheduledDateTime;

  return {
    // identity / AAP-native
    equipmentId:     wo.assetDisplayName || aSum.displayName || '',
    assetId:         wo.aaid || aSum.aaid || '',
    assetType:       wo.assetType || aSum.assetType || '',
    assetUrl:        wo.aaid ? ('https://aap-na.corp.amazon.com/v2/asset/' + wo.aaid) : '',
    domicileSite:    wo.assetDomicileSite || '',
    operator:        wo.operator || aSum.operator || '',   // filled from asset.attributesText in enrichment
    owner:           '',                                    // SCAC owner, filled from asset.attributesText
    bodyType:        '',                                    // filled from asset.attributesText.bodyType
    program:         wo.assetProgram || '',
    lifecycleState:  mapLifecycleState(wo.lifecycleState || aSum.lifecycleState),
    lifecycleReason: mapLifecycleReason(wo.lifecycleStateReason || aSum.lifecycleStateReason),
    // Location: last-known geofence/site. Try the WO's reported location, the
    // asset's latestLocation geoFences, the yard building, then the domicile.
    geofence:        _pickLocation(wo, assetSummary),

    // OFFSITE (Decisiv/ASIST) — extracted from the comment thread. These drive
    // Split View's right pane + the offsite card, and give the deep-scan the URL
    // to pull offsite notes for the AI timeline (same fields the scrape set).
    offsiteShopEventUrl: _offsite ? _offsite.url : '',
    offsiteShopEvent:    _offsite ? _offsite.label : '',
    savedOffsiteUrl:     _offsite ? _offsite.url : '',
    asistSrUrl:          (_offsite && _offsite.source === 'service_request') ? _offsite.url : '',
    asistSource:         _offsite ? _offsite.source : '',
    asistLabel:          _offsite ? _offsite.label : '',

    // WO / relay-equivalent
    vendor:          mapVendor(wo.vendor),
    suppliers:       wo.suppliers || wo.providers || '',
    serviceState:    (function(){ const st = woStatus(wo); return st.displayText || st.value || ''; })(),
    subState:        wo.subStatus || '',
    workRequestId:   wo.workRequestId || wo.id || '',
    serviceUrl:      wo.workRequestId || wo.id ? ('https://aap-na.corp.amazon.com/v2/service/' + (wo.workRequestId || wo.id)) : '',
    serviceCategory: wo.category || '',
    urgent:          (wo.isUrgent === true || wo.isUrgent === 'true') ? 'Yes' : '',
    workDuration:    _durationFrom(downStart),
    issueDetails:    wo.damageDescription || '',
    issueSummary:    [l1.join('; '), l2.join('; ')].filter(Boolean).join(' / '),
    vendorWorkOrderId: Array.isArray(wo.vendorWorkOrderIds) ? wo.vendorWorkOrderIds.join('; ') : '',
    created:         _epochToIso(wo.scheduledDateTime || downStart),
    completed:       _epochToIso(wo.completedDateTime),
    delayReasonCodes: Array.isArray(wo.delayReasonCodes) ? wo.delayReasonCodes.join('; ') : '',

    // comment thread (the big win — structured, clean)
    repairTimeline:  timeline,
    fullConversation,

    // L1/L2 (AVM)
    level1:          l1.join('; '),
    level2:          l2.join('; '),

    // estimate / escalation
    estimatePendingCost: wo.totalEstimatePendingApprovalCost != null ? wo.totalEstimatePendingApprovalCost : '',
    escalations:     wo.escalations ? (Array.isArray(wo.escalations) ? wo.escalations.join('; ') : String(wo.escalations)) : '',

    // asset master (filled by enrichment)
    vin:             '',
    manufacturer:    '',

    // Open WR counts (the U/P column). The asset record carries NO such field
    // (confirmed via getAsset + asset search). These are populated AFTER the
    // mapper in buildFleetDataset, from per-category open-WO tallies keyed by
    // aaid. Default to 0 here; the real values overwrite them.
    openUnplanned:   0,
    openPlanned:     0,

    // provenance
    _apiSourced:     true,
    _serviceId:      wo.id || wo.workRequestId || '',
    // Mark the row as having live WO/Relay data so the detail pane renders the
    // WR card (its gate is `relaySynced && (vendor||issueDetails||workRequestId)`)
    // instead of the "No Relay WR data" empty state. The API IS the Relay source
    // now, so any row that carries a vendor / issue / WR id is "relay-synced".
    relaySynced:     !!(mapVendor(wo.vendor) || wo.damageDescription || wo.workRequestId || wo.id),
  };
}

// Map ONE work-order aggregate into the lightweight "secondary WR card" shape
// the unit-detail repair pane expects for its planned/unplanned extra cards
// (unit._secondaryWRs[]). Includes CLOSED work orders — a WO is shown whether
// it's open or closed (per product: "closed doesn't matter if it's still a
// work order"). `serviceDetail` is optional (comment thread for that WO).
function toSecondaryWR(wo, serviceDetail) {
  if (!wo) return null;
  const id = wo.workRequestId || wo.id || '';
  const l1 = []; const l2 = [];
  for (const si of (wo.suggestedItems || [])) {
    if (si && si.level1 && !l1.includes(si.level1)) l1.push(si.level1);
    if (si && si.level2 && !l2.includes(si.level2)) l2.push(si.level2);
  }
  const downStart = wo.actualStartDateTime || wo.expectedStartDateTime || wo.scheduledDateTime;
  // External-only conversation (internal comments excluded) for the AI, NOT a
  // raw dump shown directly. Prefixed "Conversation" for the deep-scan header-strip.
  const extComments = collectAllComments(serviceDetail).filter((c) => !(c && c.internalOnly));
  const cat = wo.category || '';
  const _st = woStatus(wo);
  return {
    workRequestId:   id,
    vendor:          mapVendor(wo.vendor),
    serviceState:    _st.displayText || _st.value || '',
    subState:        wo.subStatus || '',
    serviceCategory: cat,
    issueDetails:    wo.damageDescription || [l1.join('; '), l2.join('; ')].filter(Boolean).join(' / ') || '',
    level1:          l1.join('; '),
    level2:          l2.join('; '),
    created:         _epochToIso(wo.scheduledDateTime || downStart),
    completed:       _epochToIso(wo.completedDateTime),
    totalCost:       wo.totalEstimatePendingApprovalCost != null ? wo.totalEstimatePendingApprovalCost : '',
    // Raw feed for the AI (planned/secondary WR conversation) — not shown directly.
    fullConversation: extComments.length ? ('Conversation\n' + commentsToTimeline(extComments, { includeInternal: false })) : '',
    repairTimeline:  '',   // AI-built by deep-scan, never a raw dump
    // 'planned' | 'unplanned' — drives the card's section title.
    _wrType:         /plan/i.test(cat) && !/unplan/i.test(cat) ? 'planned' : 'unplanned',
    // Split View: the Relay URL for THIS work order.
    _serviceUUID:    id,
    _relayUrl:       id ? ('https://aap-na.corp.amazon.com/v2/service/' + id) : '',
  };
}

module.exports = {
  toFleetRow,
  toSecondaryWR,
  woStatus,
  pmDueFields,
  extractOffsiteFromComments,
  commentsToTimeline,
  assetDetailFields,
  mapVendor,
  isExcludedVendor,
  EXCLUDED_VENDORS,
  mapLifecycleState,
  mapLifecycleReason,
  mapBodyType,
  LIFECYCLE_STATE,
  LIFECYCLE_REASON,
  VENDOR_DISPLAY,
};
