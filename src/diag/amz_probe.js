// TEMPORARY one-time READ-ONLY diagnostic: logs the real AAP fleetId for
// AMZ503669 and whether an asset search scoped to that fleet returns it.
// Runs only when FLEET_AMZ_PROBE=1, at most once per launch. REVERT AFTER USE.
'use strict';

const logger = require('../utils/logger')('amz-probe');

const AAID = 'aaid_8ba76ee8-038e-480d-9e33-891de80665b3';
let _ran = false;

function _log(msg) { try { logger.info('[AMZ_PROBE] ' + msg); } catch (_) {} }

function _contains(res) {
  const list = (res && res.assets) || [];
  return list.some((a) => a && ((a.asset && a.asset.aaid === AAID) || a.aaid === AAID));
}

async function _run() {
  const api = require('../scrapers/aap_api');
  const full = await api.getAsset(AAID);
  const a = (full && full.asset) || full || {};
  const pick = (k) => (a[k] != null ? a[k] : (full && full[k] != null ? full[k] : null));
  const fleetId = pick('fleetId');
  _log('fleetId=' + fleetId + ' fleetName=' + pick('fleetName') + ' program=' + (pick('program') || pick('assetProgram')) +
    ' domicile=' + pick('domicileSite') + ' lifecycle=' + JSON.stringify(pick('lifecycleState')));
  if (!fleetId) { _log('no fleetId on asset; skipping searches'); return; }
  const body = {
    from: 0,
    fieldFilters: [{ key: 'domicileSite', values: ['ABE40'] }],
    lifecycleStates: [
      { state: 'ACTIVE', reasons: [] },
      { state: 'UNAVAILABLE', reasons: [] },
      { state: 'ORDERED', reasons: [] },
    ],
    fleetIds: [fleetId],
  };
  try { _log('ownFleetSearchReturnsAsset=' + _contains(await api.searchAssets(body))); }
  catch (e) { _log('ERROR ownFleetSearch ' + (e && e.message)); }
  try { _log('withBoundingBoxNull=' + _contains(await api.searchAssets(Object.assign({}, body, { boundingBox: null })))); }
  catch (e) { _log('ERROR withBoundingBoxNull ' + (e && e.message)); }
}

function maybeRunAmzProbe() {
  if (process.env.FLEET_AMZ_PROBE !== '1' || _ran) return;
  _ran = true;
  _log('start aaid=' + AAID);
  Promise.resolve().then(_run).catch((e) => _log('ERROR ' + (e && e.message)));
}

module.exports = { maybeRunAmzProbe };
