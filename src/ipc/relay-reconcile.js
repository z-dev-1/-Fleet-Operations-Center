'use strict';
/**
 * ipc/relay-reconcile.js — IPC surface for the Relay ↔ Offsite reconcile feature.
 *
 * Lets the renderer: read/update config (incl. the MODE A/B switch), list the
 * MODE B staging queue, confirm/dismiss a staged Relay post, and run a reconcile
 * for ONE unit on demand. The reasoning + write layers live in
 * src/scrapers/relay_reconcile.js and relay_reconcile_apply.js; everything that
 * posts to the live AAP work request is behind an explicit confirm (MODE B) or
 * the autoPostToRelay toggle (MODE A).
 */

const store = require('../store');
const logger = require('../utils/logger')('ipc:relay-reconcile');
const { handle, requireString } = require('./_safe');
const { ConfigError } = require('../utils/errors');

const reconcile = require('../scrapers/relay_reconcile');
const apply = require('../scrapers/relay_reconcile_apply');

function registerRelayReconcileIPC(_ctx) {
  handle('relayReconcile:get-config', () => reconcile.getConfig());
  handle('relayReconcile:set-config', (_e, patch) => {
    if (patch && typeof patch !== 'object') throw new ConfigError('config patch must be an object', 'patch');
    return reconcile.saveConfig(patch || {});
  });

  handle('relayReconcile:get-pending', () => apply.loadPending());

  // Confirm a staged Relay comment -> actually posts to the AAP work request.
  handle('relayReconcile:confirm', async (_e, id) => {
    requireString(id, 'id');
    return apply.confirmPending(id);
  });

  handle('relayReconcile:dismiss', (_e, id) => {
    requireString(id, 'id');
    return apply.dismissPending(id);
  });

  // Run a reconcile for ONE unit on demand (by equipmentId). Returns the AI
  // decision + what the apply layer did (posted/staged/timeline).
  handle('relayReconcile:run-unit', async (_e, equipmentId) => {
    requireString(equipmentId, 'equipmentId');
    const id = equipmentId.trim();
    const fd = store.load('fleetData', {}) || {};
    const row = (fd.rows || []).find((r) => String(r.equipmentId || '').trim() === id);
    if (!row) throw new ConfigError('unit not found in fleet data: ' + id, 'equipmentId');
    const cfg = reconcile.getConfig();
    const decision = await reconcile.reconcileUnit(row, { cfg });
    if (!decision) return { ok: false, error: 'no decision produced' };
    const result = await apply.applyReconcile(decision, { cfg });
    return { ok: true, decision, result };
  });

  // Draft text for a Split View pane. Runs the reconcile reasoning for ONE unit
  // and returns the pane-appropriate text so Split View can auto-fill it:
  //   side 'relay'   -> the gap-fill (Offsite update missing from Relay) or, if
  //                     a vendor follow-up is warranted, the escalated dealer-ask;
  //                     else the synthesized current status + next step.
  //   side 'offsite' -> the dealer-ask (what to ask the vendor).
  // Returns { ok:false } when the engine is disabled or no decision — so the
  // Split View caller cleanly falls back to its existing simple draft.
  handle('relayReconcile:draft-for-split', async (_e, equipmentId, side) => {
    requireString(equipmentId, 'equipmentId');
    const cfg = reconcile.getConfig();
    if (!cfg.enabled) return { ok: false, reason: 'engine disabled' };
    const id = equipmentId.trim();
    const fd = store.load('fleetData', {}) || {};
    const row = (fd.rows || []).find((r) => String(r.equipmentId || '').trim() === id);
    if (!row) return { ok: false, reason: 'unit not found' };
    let decision;
    try { decision = await reconcile.reconcileUnit(row, { cfg }); }
    catch (e) { return { ok: false, reason: e.message }; }
    if (!decision) return { ok: false, reason: 'no decision' };

    const paneSide = (side === 'offsite') ? 'offsite' : 'relay';
    let text = '';
    if (paneSide === 'offsite') {
      text = decision.dealerAsk || '';
    } else {
      // Relay pane: prefer the concrete gap-fill; else a warranted follow-up;
      // else a plain status line.
      if (decision.missingUpdate) text = decision.missingUpdate;
      else if ((decision.followUpNeeded || decision.isStale) && decision.dealerAsk) text = decision.dealerAsk;
      else if (decision.currentStatus) text = decision.currentStatus + (decision.nextStep ? ' Next: ' + decision.nextStep : '');
    }
    if (!text) return { ok: false, reason: 'nothing to draft', decision };
    return { ok: true, text, source: 'reconcile', side: paneSide, decision };
  });

  logger.info('Relay Reconcile IPC handlers registered');
}

module.exports = { registerRelayReconcileIPC };
