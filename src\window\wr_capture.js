'use strict';
// ── WR URL Builder ────────────────────────────────────────────────────────────
// Constructs AAP Work Request URLs directly from scraped row data.
//
// URL patterns:
//   Unplanned: /v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5?tab=Unplanned&ids={equipmentId}
//   Planned:   /v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5?ids={equipmentId}
//
// Business rules:
//   - Skip if operator is Velocity or FleetNet (vendor-managed, not our WRs)
//   - Expired inspection -> Planned tab
//   - All other unavailable reasons -> Unplanned tab

const AAP_WR_PAGE = 'https://aap-na.corp.amazon.com/v2/page/817ca098-8441-4329-a71e-6768f9d7e6c5';

// Operators that are vendor-managed -- skip WR URL generation entirely
const SKIP_OPERATORS = ['velocity', 'fleetnet', 'fleet net'];

function isSkippedOperator(operator) {
  var op = (operator || '').trim().toLowerCase();
  return SKIP_OPERATORS.some(function(s) { return op.includes(s); });
}

function buildWRUrl(equipmentId, col) {
  if (col === 'planned') {
    return AAP_WR_PAGE + '?ids=' + encodeURIComponent(equipmentId);
  }
  return AAP_WR_PAGE + '?tab=Unplanned&ids=' + encodeURIComponent(equipmentId);
}

// Build WR URLs for all qualifying unavailable units.
// wrRows: [{ eqId, colToClick, reason }] from JS_EXTRACT_TABLE
// rawRows: raw scraped row objects (need 'Operator' field for skip check)
// Returns { [eqId]: { url, col } }
function buildWRUrls(wrRows, rawRows, _pageId, logger, label) {
  if (!wrRows || wrRows.length === 0) return {};

  var rowsByEq = {};
  (rawRows || []).forEach(function(r) {
    if (r['Equipment ID']) rowsByEq[r['Equipment ID']] = r;
  });

  var urlMap = {};
  var skipped = 0;

  wrRows.forEach(function(wr) {
    var row = rowsByEq[wr.eqId];
    var operator = row ? (row['Operator'] || '') : '';

    if (isSkippedOperator(operator)) {
      logger.info('[' + label + '] WR skip eq=' + wr.eqId + ' operator=' + operator + ' (vendor-managed)');
      skipped++;
      return;
    }

    var url = buildWRUrl(wr.eqId, wr.colToClick);
    urlMap[wr.eqId] = { url: url, col: wr.colToClick };
    logger.info('[' + label + '] WR URL eq=' + wr.eqId + ' (' + wr.colToClick + '): ' + url);
  });

  logger.info('[' + label + '] WR URLs built: ' + Object.keys(urlMap).length + ' / skipped: ' + skipped);
  return urlMap;
}

module.exports = { buildWRUrls };
