'use strict';
/**
 * scrapers/lifecycle_change.js — the AAP unit lifecycle change, shared by the
 * ungated 'aap:set-lifecycle' IPC (src/ipc/scrapers.js) and the write gate's
 * 'setLifecycle' kind (src/writes/write-gate.js).
 *
 * Moved unchanged from src/ipc/scrapers.js _setLifecycleImpl: the flag-gated
 * AAP JSON API path (fasConfig.useLifecycleApi) with the proven browser
 * automation fallback. Resolves { success, message, ... }.
 */

const { requireString } = require('../ipc/_safe');
const { ScraperError } = require('../utils/errors');

async function changeLifecycle({ equipmentId, assetUrl, state, reason }) {
  requireString(equipmentId, 'equipmentId');
  requireString(assetUrl, 'assetUrl');
  requireString(state, 'state');
  // PREFERRED PATH (gated by fasConfig.useLifecycleApi, OFF by default): the
  // AAP JSON API — version-locked PUT + source read-back, and auto-clears a
  // blocking DVIR when going ACTIVE. Falls back to the proven browser
  // automation on any failure or when the flag is off. The manual detail-page
  // button and the AI MOVE_UNIT path now share the same API path.
  let useApi = false;
  try { useApi = require('../orcha/fas/config').get().useLifecycleApi === true; } catch (_) { useApi = false; }
  if (useApi) {
    try {
      const api = require('../scrapers/aap_lifecycle_api');
      const wantActive = String(state).trim().toUpperCase() === 'ACTIVE';
      const r = wantActive
        ? await api.setLifecycleActiveWithDvir({ unit: equipmentId, assetUrl, reason: reason || 'HEALTHY' })
        : await api.setLifecycleApi({ unit: equipmentId, assetUrl, state, reason: reason || '' });
      // Explicit, durable write-back line so the result is unambiguous in the
      // log (and the UI toast via `message`): VERIFIED / UNCERTAIN / etc.
      try {
        const L = require('../utils/logger').createLogger('ipc:scrapers');
        L.info('[LIFECYCLE-RESULT] ' + equipmentId + ' -> ' + String(state).toUpperCase() +
          ' : ' + String((r && r.status) || 'unknown').toUpperCase() +
          (r && r.verified ? ' (VERIFIED' + (r.version ? ' v' + r.version : '') + ', via api)' : '') +
          (r && r.dvirCleared && r.dvirCleared.length ? ' [DVIR cleared: ' + r.dvirCleared.length + ']' : ''));
      } catch (_) {}
      // Map to the UI's { success, message } contract.
      if (r && (r.status === 'done' || r.status === 'noop') && r.verified) {
        return { success: true, via: 'api', verifiedState: r.to && r.to.state, newState: r.to && r.to.state, version: r.version,
          message: r.status === 'noop' ? (equipmentId + ' is already ' + (r.to && r.to.state) + ' \u2014 verified, no change') : (equipmentId + ' set to ' + (r.to && r.to.state) + ' \u2014 VERIFIED' + (r.version ? ' (v' + r.version + ')' : '')),
          dvirCleared: r.dvirCleared };
      }
      if (r && r.status === 'execution_uncertain') {
        return { success: false, via: 'api', uncertain: true, message: 'EXECUTION_UNCERTAIN: the change may have applied but could not be verified — re-check before relying on it.' };
      }
      if (r && r.needsWorkOrder) {
        return { success: false, via: 'api', needsWorkOrder: true, message: 'Open DVIR must be cleared but no open work request was found to reference — supply a WR number.' };
      }
      // API failed -> fall through to the browser-automation fallback.
      try { require('../utils/logger').createLogger('ipc:scrapers').warn('[aap:set-lifecycle] API path failed (' + (r && (r.error || r.status)) + '); falling back to browser automation'); } catch (_) {}
    } catch (e) {
      try { require('../utils/logger').createLogger('ipc:scrapers').warn('[aap:set-lifecycle] API path threw (' + e.message + '); falling back'); } catch (_) {}
    }
  }
  // FALLBACK: proven BrowserWindow automation. The UI now sends the AAP
  // reason CODE (e.g. OFFSITE_SHOP_REPAIR) for the API path; the browser
  // automation matches by the dropdown's VISIBLE text, so translate code ->
  // friendly label here. Unknown/plain values pass through unchanged.
  const _REASON_FRIENDLY = {
    HEALTHY: 'Healthy',
    OFFSITE_SHOP_REPAIR: 'Off-site storage',
    PM_FAILED: 'PM Failed',
    PREVENTATIVE_MAINTENANCE: 'Preventative Maintenance',
    PARTS_DELAY: 'Parts Delay',
    DAMAGED_MODERATE: 'Damaged-Moderate',
    SENSOR_DETECTED_DAMAGE: 'Sensor Detected Damage',
    SAFETY_INSPECTION_POST_ACCIDENT: 'Safety Inspection Post Accident',
    LICENSE_OR_PERMIT_ISSUE: 'License or Permit Issue',
    IMPOUNDED_TOW: 'Impounded/Tow',
    GPS_MALFUNCTIONING: 'GPS Malfunctioning',
    CAMPAIGN: 'Campaign',
  };
  const fallbackReason = _REASON_FRIENDLY[String(reason || '').trim().toUpperCase()] || reason || '';
  const { setLifecycleState } = require('../scrapers/setLifecycle');
  try {
    return await setLifecycleState({ equipmentId, assetUrl, state, reason: fallbackReason });
  } catch (e) {
    throw new ScraperError(e.message, 'aap:set-lifecycle', { equipmentId, state });
  }
}

module.exports = { changeLifecycle };
