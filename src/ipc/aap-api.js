'use strict';
/**
 * ipc/aap-api.js — IPC surface for the direct Relay Garage / AAP JSON API.
 *
 * Thin wrappers over src/scrapers/aap_api.js so the renderer (and a quick
 * self-test) can exercise the 8 endpoints over the app's Midway session.
 */

const logger = require('../utils/logger')('ipc:aap-api');
const { handle, requireStringMax } = require('./_safe');

function registerAapApiIPC() {
  const api = () => require('../scrapers/aap_api');

  // Self-test / auth probe: the cheapest GET. Confirms the API path works end
  // to end (window auth + token capture not even needed for GET). Returns the
  // current user, or a structured error.
  handle('aap-api:selftest', async () => {
    try {
      const user = await api().getUserDetails();
      return { ok: true, endpoint: '/api/v1/user/details', user };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Bulk WORK-ORDER search (POST). Overrides shallow-merge onto the proven full
  // filter body (a bare body 500s). Pass { page, statuses, ... } to override.
  handle('aap-api:search', async (_e, payload) => {
    const req = (payload && typeof payload === 'object') ? payload : {};
    try {
      const res = await api().searchServices(req);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Bulk ASSET search (POST /api/v2/assets/search). Overrides shallow-merge onto
  // the proven asset filter body.
  handle('aap-api:search-assets', async (_e, payload) => {
    const req = (payload && typeof payload === 'object') ? payload : {};
    try {
      const res = await api().searchAssets(req);
      return { ok: true, result: res };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  // Full service aggregate by serviceId (GET).
  handle('aap-api:service', async (_e, payload) => {
    const id = requireStringMax((payload && payload.serviceId) || '', 'serviceId', 128);
    try { return { ok: true, service: await api().getService(id) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // Full asset by aaid (GET).
  handle('aap-api:asset', async (_e, payload) => {
    const aaid = requireStringMax((payload && payload.aaid) || '', 'aaid', 128);
    try { return { ok: true, asset: await api().getAsset(aaid) }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // All AVM codes (GET) — reference data.
  handle('aap-api:avm-codes', async () => {
    try { return { ok: true, codes: await api().getAvmCodes() }; }
    catch (e) { return { ok: false, error: e.message, code: e.code || null }; }
  });

  // FULL PIPELINE — fetch all open work orders + index all assets, join by
  // aaid, return mapped tracker rows. opts: { searchRequest, maxPages }.
  handle('aap-api:build-tracker', async (_e, payload) => {
    const opts = (payload && typeof payload === 'object') ? payload : {};
    try {
      const rows = await api().buildTrackerRows(opts);
      return { ok: true, count: rows.length, rows };
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || null };
    }
  });

  logger.info('AAP API IPC handlers registered');
}

module.exports = { registerAapApiIPC };
