'use strict';
/**
 * vendors/investigation.js -- Dealer WO pre-flight assessment engine [V-C]
 * S23-7 (2026-06-28)
 *
 * Answers: "Is this unit ready for a dealer portal workflow?"
 * Called by vendor:investigate IPC channel (and optionally by vendor:start-*
 * handlers for a zero-cost eligibility guard before relay step commits).
 *
 * Assessment checks (in order):
 *   1. UNIT_DATA     -- equipmentId + VIN present
 *   2. VENDOR        -- make resolves to paccar | volvo
 *   3. LIFECYCLE     -- unit is in a shop-routable lifecycle state
 *   4. OFFSITE_MATCH -- existing Decisiv portal link already on the Relay WR
 *                       (paccar/volvo subdomain URL in offsiteShopEventUrl)
 *   5. RELAY_WO      -- existing dealer tracking WO title found in relay data
 *                       (static check, no BrowserWindow needed)
 *   6. MILEAGE       -- odometer/mileage present (warn only, non-blocking)
 *
 * Returns InvestigationResult:
 *   {
 *     eligible:     boolean,         // false = vendor:start-* should not proceed
 *     vendor:       'paccar'|'volvo'|null,
 *     warnings:     string[],        // non-fatal, pass through to UI
 *     blocking:     string[],        // fatal, shown as errors in UI
 *     checks:       CheckMap,        // { [checkId]: CheckDetail }
 *     existingWO:   ExistingWO|null, // if RELAY_WO or OFFSITE_MATCH triggered
 *     unit:         object,          // echo of assessed unit (safe subset)
 *   }
 *
 * CheckDetail:
 *   { id, label, status: 'pass'|'warn'|'fail'|'skip', detail: string }
 *
 * ExistingWO:
 *   { source: 'relay_wo'|'offsite_match', workRequestId, caseNumber, url, title }
 *
 * IPC channel:
 *   vendor:investigate  { unit }  ->  InvestigationResult
 *   (registered in vendors/index.js via registerVendorIPC)
 */

const logger = require('../utils/logger')('investigation');
const { detectVendorFromUnit, DEALER_WO_TITLES } = require('./base/relay-step');

// ============================================================================
// Constants
// ============================================================================

// Lifecycle states that indicate the unit is in or headed to an offsite shop.
// Workflow is allowed to start in these states.
const ROUTABLE_STATES = [
  'unavailable',      // standard in-shop / offsite state
  'unplanned',        // breakdown -- high priority, needs offsite
  'planned',          // planned offsite work
  'in repair',        // already at shop, may need dealer portal case
  'pending',          // queued for offsite
  'down',             // common abbreviation for unavailable
];

// States where starting a dealer WO makes no sense.
const BLOCKED_STATES = [
  'available',        // unit is active on road -- premature
  'decommissioned',   // out of fleet
  'disposed',
  'sold',
  'transferred',
];

// Decisiv subdomain patterns to match offsiteShopEventUrl / savedOffsiteUrl.
const DECISIV_PACCAR_PATTERN = /paccarpg(?:\.asist)?\.decisiv\.net/i;
const DECISIV_VOLVO_PATTERN  = /volvopg\.asist\.decisiv\.net/i;
// ============================================================================
// Main export
// ============================================================================

/**
 * investigate(unit)
 * Synchronous + fast: no BrowserWindows, no network calls.
 * All data comes from the unit record already held in memory by the main process.
 *
 * @param {object} unit  Fleet unit record (from fleet data / relay scrape merge)
 * @returns {InvestigationResult}
 */
function investigate(unit) {
  if (!unit || typeof unit !== 'object') {
    return _result(null, [_check('unit_data', 'Unit Data', 'fail', 'unit is null or not an object')], []);
  }

  const checks = [];
  const warnings = [];
  const blocking = [];

  // ── Check 1: Unit data completeness────────────────────────────────────────
  const eqId = String(unit.equipmentId || unit.id || '').trim();
  const vin   = String(unit.vin || unit.vehicleId || '').trim();

  if (!eqId) {
    checks.push(_check('unit_data', 'Unit Data', 'fail', 'equipmentId is missing'));
    blocking.push('Unit has no equipment ID — cannot start a workflow.');
    return _result(null, checks, warnings, blocking, null, unit);
  }

  const unitDataDetail = vin
    ? 'equipmentId: ' + eqId + ' | VIN: ' + vin
    : 'equipmentId: ' + eqId + ' | VIN: MISSING';
  checks.push(_check('unit_data', 'Unit Data', vin ? 'pass' : 'warn', unitDataDetail));
  if (!vin) warnings.push('VIN is missing — portal form fill may be incomplete.');

  // ── Check 2: Vendor detection───────────────────────────────────────────────
  const vendor = detectVendorFromUnit(unit);
  if (!vendor) {
    const makeStr = [unit.make, unit.manufacturer, unit.vendor].filter(Boolean).join(' / ') || '(unknown)';
    checks.push(_check('vendor', 'Vendor Detection', 'fail',
      'Make "' + makeStr + '" does not map to PACCAR or Volvo'));
    blocking.push('Unit make "' + makeStr + '" is not supported (PACCAR/Kenworth/Peterbilt or Volvo required).');
    return _result(vendor, checks, warnings, blocking, null, unit);
  }

  const vendorLabel = vendor === 'paccar' ? 'PACCAR (Kenworth/Peterbilt)' : 'Volvo (ASIST)';
  const makeStr2    = [unit.make, unit.manufacturer].filter(Boolean).join(' / ') || vendor;
  checks.push(_check('vendor', 'Vendor Detection', 'pass',
    vendorLabel + ' | make: ' + makeStr2));
  // ── Check 3: Lifecycle state ────────────────────────────────────────────────
  const rawState = String(unit.lifecycleState || unit.atsState || unit.status || '').toLowerCase().trim();
  const stateLabel = rawState || '(unknown)';

  if (!rawState) {
    checks.push(_check('lifecycle', 'Lifecycle State', 'warn',
      'lifecycleState unknown — proceeding with caution'));
    warnings.push('Lifecycle state is unknown. Verify the unit is actually at a shop.');
  } else if (BLOCKED_STATES.some(s => rawState.includes(s))) {
    checks.push(_check('lifecycle', 'Lifecycle State', 'fail',
      'State "' + stateLabel + '" is not shop-routable'));
    blocking.push('Unit lifecycle state "' + stateLabel + '" indicates the unit is not at a shop. Cannot create dealer WO.');
    return _result(vendor, checks, warnings, blocking, null, unit);
  } else if (ROUTABLE_STATES.some(s => rawState.includes(s))) {
    checks.push(_check('lifecycle', 'Lifecycle State', 'pass',
      'State "' + stateLabel + '" is shop-routable'));
  } else {
    // Unknown state but not explicitly blocked
    checks.push(_check('lifecycle', 'Lifecycle State', 'warn',
      'State "' + stateLabel + '" is unrecognised — review before proceeding'));
    warnings.push('Lifecycle state "' + stateLabel + '" is not in the known shop-routable list. Verify manually.');
  }

  // ── Check 4: Existing offsite shop link (Decisiv ULR on the Relay WR)──────
  // If relay scraper already found a Decisiv portal URL for this unit, the
  // portal case may already exist. Surfaces as a warning (not blocking) because
  // the existing case might be for a different visit / already closed.
  const offsiteUrl = String(
    unit.offsiteShopEventUrl || unit.savedOffsiteUrl || ''
  ).trim();
  const offsiteCase = String(
    unit.offsiteShopEvent || unit.savedOffsiteEvent || ''
  ).trim();

  let existingWO = null;

  if (offsiteUrl) {
    const isMatchVendor = vendor === 'paccar'
      ? DECISIV_PACCAR_PATTERN.test(offsiteUrl)
      : DECISIV_VOLVO_PATTERN.test(offsiteUrl);

    if (isMatchVendor) {
      checks.push(_check('offsite_match', 'Existing Portal Link', 'warn',
        'Decisiv URL already on Relay WR: ' + offsiteCase + ' | ' + offsiteUrl.slice(0, 80)));
      warnings.push(
        'A ' + vendorLabel + ' portal link already exists on the Relay WR' +
        (offsiteCase ? ' (case: ' + offsiteCase + ')' : '') +
        '. A duplicate portal case may be created. Review before proceeding.'
      );
      existingWO = {
        source:        'offsite_match',
        workRequestId: unit.workRequestId || unit.serviceUrl || '',
        caseNumber:    offsiteCase,
        url:           offsiteUrl,
        title:         offsiteCase ? vendorLabel + ' case: ' + offsiteCase : 'Existing ' + vendorLabel + ' link',
      };
    } else {
      // Offsite URL exists but it's for a different vendor (e.g. Volvo unit showing a PACCAR link)
      checks.push(_check('offsite_match', 'Existing Portal Link', 'warn',
        'Offsite URL exists but does not match vendor "' + vendor + '": ' + offsiteUrl.slice(0, 60)));
      warnings.push('A different-vendor offsite link is on the Relay WR. Verify this is the correct unit.');
    }
  } else {
    checks.push(_check('offsite_match', 'Existing Portal Link', 'pass', 'No existing ' + vendorLabel + ' portal link found'));
  }
  // ── Check 5: Existing dealer tracking WO (static relay data scan) ──────────
  const dealerTitle = (DEALER_WO_TITLES[vendor] || '').toLowerCase();
  const issueText   = String(unit.issueDetails || unit.issue || '').toLowerCase();
  const vendorText  = String(unit.vendor || '').toLowerCase();

  const relayHasDealerWO =
    (dealerTitle && issueText && issueText.includes(dealerTitle.split(' ')[0])) ||
    (dealerTitle && vendorText && vendorText.includes('dealer tracking'));

  if (relayHasDealerWO) {
    checks.push(_check('relay_wo', 'Relay Dealer WO', 'warn',
      'Relay data suggests a dealer tracking WO may already exist'));
    warnings.push(
      'Relay WR data indicates a "' + DEALER_WO_TITLES[vendor] + '" WO may already be open. ' +
      'The dupe guard in runRelayStep() will confirm — this is an early warning only.'
    );
    if (!existingWO) {
      existingWO = {
        source:        'relay_wo',
        workRequestId: unit.workRequestId || '',
        caseNumber:    '',
        url:           unit.serviceUrl || '',
        title:         DEALER_WO_TITLES[vendor] + ' (detected in relay data)',
      };
    }
  } else {
    checks.push(_check('relay_wo', 'Relay Dealer WO', 'pass', 'No dealer tracking WO detected in relay data'));
  }

  // ── Check 6: Mileage / odometer (warn only) ─────────────────────────────────
  const mileage = unit.mileage || unit.odometer;
  const mileageNum = Number(mileage);
  if (!mileage || isNaN(mileageNum) || mileageNum <= 0) {
    checks.push(_check('mileage', 'Mileage / Odometer', 'warn',
      'mileage not available — portal form will leave odometer blank'));
    warnings.push('Mileage/odometer is missing. The portal form odometer field will be empty.');
  } else {
    checks.push(_check('mileage', 'Mileage / Odometer', 'pass',
      String(mileageNum.toLocaleString()) + ' mi'));
  }

  // Eligibility roll-up
  const eligible = blocking.length === 0;

  logger.info('[investigation] unit:', eqId,
    '| vendor:', vendor || 'none',
    '| eligible:', eligible,
    '| warnings:', warnings.length,
    '| blocking:', blocking.length);

  return _result(vendor, checks, warnings, blocking, existingWO, unit);
}

// Helpers

function _check(id, label, status, detail) {
  return { id, label, status, detail: detail || '' };
}

function _result(vendor, checks, warnings, blocking, existingWO, unit) {
  const eligible = !blocking || blocking.length === 0;
  const safeUnit = unit ? {
    equipmentId: unit.equipmentId || unit.id || '',
    vin:         unit.vin         || unit.vehicleId || '',
    make:        unit.make        || unit.manufacturer || '',
    unitNumber:  unit.unitNumber  || unit.equipmentId || '',
    mileage:     unit.mileage     || unit.odometer    || '',
    lifecycleState: unit.lifecycleState || unit.atsState || '',
    serviceUrl:  unit.serviceUrl  || '',
  } : null;

  const checksMap = {};
  for (const c of (checks || [])) { checksMap[c.id] = c; }

  return {
    eligible,
    vendor:    vendor || null,
    warnings:  warnings  || [],
    blocking:  blocking  || [],
    checks:    checksMap,
    existingWO: existingWO || null,
    unit:      safeUnit,
  };
}

module.exports = { investigate };
