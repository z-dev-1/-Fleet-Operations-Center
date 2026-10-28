'use strict';
/**
 * ipc/rca.js — renderer bridge for the AAP Root Cause Analysis (RCA) form,
 * submitted through the Relay template API (see src/rca/client.js).
 *
 * Channels (never throw to the renderer; failures return { ok:false, error }):
 *   rca:status  (workOrderIds[], { live }) -> { ok, statuses: { id: { done, at, source } } }
 *               Local record first; with live:true, also asks Relay whether an
 *               RCA already exists (catches RCAs filled in directly in AAP).
 *   rca:draft   ({ equipmentId, workOrderId, unit }) -> pre-filled draft
 *   rca:submit  ({ equipmentId, workOrderId, values, responseId }) -> { ok, at }
 *               Validates against the template, then POST (create) or PUT
 *               (update). Only ever called from an explicit user click.
 */

const logger = require('../utils/logger')('rca');

const LIVE_TTL_MS = 10 * 60 * 1000;   // cache live "is there an RCA" checks
const LIVE_MAX = 8;                    // bound live checks per call
const _live = new Map();               // workOrderId -> { done, at, checkedAt }

const _isId = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));

function registerRcaIPC() {
  const { ipcMain } = require('electron');
  const store = require('../store');
  const client = require('../rca/client');
  const autofill = require('../rca/autofill');
  const { normalizeResponse } = require('../rca/template');

  function handle(ch, fn) {
    ipcMain.handle(ch, async (_e, ...args) => {
      try { return await fn(...args); }
      catch (err) {
        logger.warn(ch + ' failed: ' + ((err && err.message) || err));
        return { ok: false, error: (err && err.message) || String(err), code: err && err.code };
      }
    });
  }

  const _load = () => store.load('rcaSubmissions', {}) || {};

  function _record(workOrderId, rec) {
    store.update('rcaSubmissions', (all) => {
      const next = all && typeof all === 'object' ? all : {};
      next[workOrderId] = Object.assign({}, next[workOrderId] || {}, rec);
      return next;
    }, {});
  }

  handle('rca:status', async (workOrderIds, opts = {}) => {
    const ids = (Array.isArray(workOrderIds) ? workOrderIds : []).filter(_isId).slice(0, 60);
    const local = _load();
    const statuses = {};
    for (const id of ids) {
      const r = local[id];
      statuses[id] = r ? { done: true, at: r.at || null, source: r.source || 'app' } : { done: false };
    }
    if (opts.live) {
      const todo = ids.filter((id) => !statuses[id].done).slice(0, LIVE_MAX);
      for (const id of todo) {
        const c = _live.get(id);
        if (c && (Date.now() - c.checkedAt) < LIVE_TTL_MS) {
          if (c.done) statuses[id] = { done: true, at: c.at, source: 'aap' };
          continue;
        }
        try {
          const found = await client.findRcaResponse(id);
          const at = found ? (found.modifiedOn || found.createdOn || null) : null;
          _live.set(id, { done: !!found, at, checkedAt: Date.now() });
          if (found) {
            statuses[id] = { done: true, at, source: 'aap' };
            _record(id, { at: at || new Date().toISOString(), responseId: client.responseIdOf(found), source: 'aap' });
          }
        } catch (e) {
          // Live check is best-effort; stop after the first failure (auth/page).
          logger.warn('[rca] live status check failed: ' + e.message);
          break;
        }
      }
    }
    return { ok: true, statuses };
  });

  handle('rca:draft', async (args) => {
    const a = args || {};
    if (!_isId(a.workOrderId)) return { ok: false, error: 'Invalid work order id' };
    return autofill.buildDraft({ equipmentId: a.equipmentId, workOrderId: a.workOrderId,
      vendorWorkOrderId: a.vendorWorkOrderId || null, unit: a.unit || {} });
  });

  handle('rca:submit', async (args) => {
    const a = args || {};
    if (!_isId(a.workOrderId)) return { ok: false, error: 'Invalid work order id' };
    const template = await client.getTemplate();

    // AAP's prefilled fields are rebuilt HERE (never trusted from the renderer)
    // and sent exactly as AAP would send them; only the other fields are
    // validated/normalized against the template.
    const { prefill, workOrders, selected } = await autofill.computePrefill(a.workOrderId, a.vendorWorkOrderId);
    if (workOrders.length && !selected) return { ok: false, error: 'Pick the work order this RCA is for.' };
    const free = {};
    Object.keys(a.values || {}).forEach((k) => { if (!(k in prefill)) free[k] = a.values[k]; });
    const norm = normalizeResponse(template, free, { requireAll: true });
    const errors = norm.errors.filter((e) => !(e.field in prefill));
    if (errors.length) return { ok: false, error: 'Missing or invalid fields', errors, warnings: norm.warnings };
    const response = Object.assign({}, norm.response, prefill);

    // If the renderer didn't know about a saved RCA for this work order, check
    // right before writing so we update it instead of creating a duplicate.
    let responseId = a.responseId || null;
    if (!responseId) {
      try {
        const found = await client.findRcaResponse(a.workOrderId, { workOrderNumber: selected });
        if (found) responseId = client.responseIdOf(found);
      } catch (e) {
        return { ok: false, error: 'Could not confirm whether an RCA already exists for this work order (' + e.message + '). Nothing was submitted.' };
      }
    }

    let saved;
    try {
      saved = await client.submitResponse(a.workOrderId, response, { responseId });
    } catch (e) {
      if (e && (e.code === 'RELAY_TIMEOUT' || e.code === 'RELAY_NETWORK')) {
        return { ok: false, code: e.code, error: 'The connection dropped while saving, so it may or may not have been saved. Check the Custom Forms tab in AAP before submitting again.' };
      }
      throw e;
    }
    const at = new Date().toISOString();
    _record(a.workOrderId, {
      equipmentId: a.equipmentId || null, at, source: 'app',
      responseId: client.responseIdOf(saved) || responseId || null,
      mode: responseId ? 'update' : 'create',
      workOrderNumber: selected || null,
    });
    _live.set(a.workOrderId, { done: true, at, checkedAt: Date.now() });
    logger.info('[rca] submitted RCA for ' + (a.equipmentId || '?') + ' WR ' + a.workOrderId + ' (' + (responseId ? 'update' : 'create') + ')');
    return { ok: true, at, mode: responseId ? 'update' : 'create', warnings: norm.warnings };
  });
}

module.exports = { registerRcaIPC };
