'use strict';
// ── WR URL Constructor ───────────────────────────────────────────────────────
// Builds WR URLs directly from scraped row data — no clicking needed.
//
// URL pattern (decoded):
//   /v2/page/{PAGE_ID}?tab={TAB}&states=[{state+reasons}]&equipmentId={EQ_ID}
//
// Business rules:
//   Unavailable + reason matches 'expired inspection' -> tab=Planned
//   Unavailable + any other reason                   -> tab=Unplanned

// AAP lifecycle-reason -> states[] mapping
// The states array includes BOTH the lifecycle state AND its reason code.
// Reason text from AAP maps to reason codes used in the URL.
const REASON_CODE_MAP = {
  'out of service':           'OUT_OF_SERVICE',
  'mechanical':               'MECHANICAL',
  'body damage':              'BODY_DAMAGE',
  'expired inspection':       'EXPIRED_INSPECTION',
  'scheduled maintenance':    'SCHEDULED_MAINTENANCE',
  'awaiting parts':           'AWAITING_PARTS',
  'collision':                'COLLISION',
  'warranty':                 'WARRANTY',
  'recall':                   'RECALL',
};

function buildWRUrl(pageId, equipmentId, lifecycleState, lifecycleReason) {
  var state  = (lifecycleState  || '').trim().toUpperCase().replace(/\s+/g, '_');
  var reason = (lifecycleReason || '').trim().toLowerCase();

  var isExpiredInspection = /expired.{0,6}inspection/i.test(reason);
  var tab = isExpiredInspection ? 'Planned' : 'Unplanned';

  // Map reason text to code — try exact then partial match
  var reasonCode = null;
  var reasonLower = reason;
  var keys = Object.keys(REASON_CODE_MAP);
  for (var i = 0; i < keys.length; i++) {
    if (reasonLower === keys[i]) { reasonCode = REASON_CODE_MAP[keys[i]]; break; }
  }
  if (!reasonCode) {
    for (var j = 0; j < keys.length; j++) {
      if (reasonLower.includes(keys[j]) || keys[j].includes(reasonLower)) {
        reasonCode = REASON_CODE_MAP[keys[j]]; break;
      }
    }
  }

  // Build states array
  var states = [{ state: 'ACTIVE', reasons: [] }];
  var unavailEntry = { state: state, reasons: reasonCode ? [reasonCode] : [] };
  states.push(unavailEntry);

  var statesParam = encodeURIComponent(JSON.stringify(states));
  var eqParam     = encodeURIComponent(equipmentId);
  return 'https://aap-na.corp.amazon.com/v2/page/' + pageId +
    '?tab=' + tab + '&states=' + statesParam + '&equipmentId=' + eqParam;
}

// Extract PAGE_ID from any AAP page URL
function extractPageId(url) {
  var m = (url || '').match(/\/v2\/page\/([a-f0-9-]{36})/);
  return m ? m[1] : null;
}

// Build WR URLs for all unavailable units in wrRows.
// Returns { eqId: { url, col } } — same shape as captureWRUrls.
function buildWRUrls(wrRows, rawRows, pageId, logger, label) {
  if (!wrRows || wrRows.length === 0) return {};
  if (!pageId) { logger.warn('[' + label + '] WR build: no pageId'); return {}; }
  var urlMap = {};
  var rowsByEq = {};
  (rawRows || []).forEach(function(r) { if (r['Equipment ID']) rowsByEq[r['Equipment ID']] = r; });
  wrRows.forEach(function(wr) {
    var row = rowsByEq[wr.eqId];
    if (!row) return;
    var url = buildWRUrl(pageId, wr.eqId,
      row['Lifecycle state']        || '',
      row['Lifecycle state reason'] || '');
    urlMap[wr.eqId] = { url: url, col: wr.colToClick };
    logger.info('[' + label + '] WR URL built eq=' + wr.eqId +
      ' (' + wr.colToClick + '): ' + url.slice(0, 120));
  });
  return urlMap;
}

module.exports = { buildWRUrls, buildWRUrl, extractPageId };