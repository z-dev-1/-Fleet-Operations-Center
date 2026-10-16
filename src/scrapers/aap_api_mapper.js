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

function _epochToIso(ms) {
  const n = Number(ms);
  if (!n || Number.isNaN(n)) return '';
  try { return new Date(n).toISOString(); } catch (_) { return ''; }
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

// Pull VIN/model from a full single-asset response (asset.attributesText.*).
function assetDetailFields(full) {
  const a  = (full && full.asset) || {};
  const at = a.attributesText || {};
  const loc = (full && full.latestLocation) || {};
  return {
    vin:   at.vin || '',
    model: at.model || at.modelName || '',
    manufacturer: at.manufacturer || at.make || '',
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

  // Comments → timeline (from the full service detail, if fetched).
  const comments = (serviceDetail && serviceDetail.workRequest && serviceDetail.workRequest.comments) || [];
  const timeline = commentsToTimeline(comments);
  // A compact "conversation" blob for AI context (clean, not scraped page junk).
  const fullConversation = timeline;

  const downStart = wo.actualStartDateTime || wo.expectedStartDateTime || wo.scheduledDateTime;

  return {
    // identity / AAP-native
    equipmentId:     wo.assetDisplayName || aSum.displayName || '',
    assetId:         wo.aaid || aSum.aaid || '',
    assetType:       wo.assetType || aSum.assetType || '',
    assetUrl:        wo.aaid ? ('https://aap-na.corp.amazon.com/v2/asset/' + wo.aaid) : '',
    domicileSite:    wo.assetDomicileSite || '',
    operator:        wo.operator || aSum.operator || '',   // may be blank; filled by asset merge/Uptake
    program:         wo.assetProgram || '',
    lifecycleState:  mapLifecycleState(wo.lifecycleState || aSum.lifecycleState),
    lifecycleReason: mapLifecycleReason(wo.lifecycleStateReason || aSum.lifecycleStateReason),
    geofence:        (loc.geoFences && loc.geoFences[0]) || '',

    // WO / relay-equivalent
    vendor:          mapVendor(wo.vendor),
    suppliers:       wo.suppliers || wo.providers || '',
    serviceState:    (wo.status && (wo.status.displayText || wo.status.value)) || '',
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

    // provenance
    _apiSourced:     true,
    _serviceId:      wo.id || wo.workRequestId || '',
  };
}

module.exports = {
  toFleetRow,
  commentsToTimeline,
  assetDetailFields,
  mapVendor,
  mapLifecycleState,
  mapLifecycleReason,
  LIFECYCLE_STATE,
  LIFECYCLE_REASON,
  VENDOR_DISPLAY,
};
