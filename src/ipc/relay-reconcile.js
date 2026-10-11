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
    const id = equipmentId.trim();
    const fd = store.load('fleetData', {}) || {};
    const row = (fd.rows || []).find((r) => String(r.equipmentId || '').trim() === id);
    if (!row) return { ok: false, reason: 'unit not found' };
    const paneSide = (side === 'offsite') ? 'offsite' : 'relay';

    // Primary path: a LIVE reconcile decision (only when the engine is enabled).
    // This is the freshest, most specific draft (gap-fill / dealer-ask).
    let decision = null;
    if (cfg.enabled) {
      try { decision = await reconcile.reconcileUnit(row, { cfg }); }
      catch (e) { logger.warn('[draft-for-split] live reconcile failed, falling back to canonical: ' + e.message); }
    }
    if (decision) {
      let text = '';
      const intent = decision.nextActionType || '';
      if (paneSide === 'offsite') {
        // The vendor-facing pane. Fill it with the intent's vendor message:
        //   reply_to_vendor -> OUR answer to their question (dealerAsk)
        //   request_update  -> the chase for what we're waiting on (dealerAsk)
        // When reply_to_vendor has no answer text (judgment call), surface the
        // open question so the coordinator can answer it.
        text = decision.dealerAsk || '';
        if (!text && intent === 'reply_to_vendor' && decision.awaitingReply) {
          text = 'Vendor asked: "' + decision.awaitingReply + '" — reply needed.';
        }
      } else {
        // The Relay (internal) pane — a FACTUAL status log, NEVER the vendor
        // chase. Prefer the AI's relayNote (third-person internal voice), then
        // the gap-fill, then a plain status line. We deliberately do NOT fall
        // through to decision.dealerAsk here: that is the vendor-addressed
        // message ("can you confirm...") and must never be posted into Relay as
        // if we were talking to our own tracking system.
        if (decision.relayNote) text = decision.relayNote;
        else if (decision.missingUpdate) text = decision.missingUpdate;
        else if (intent === 'reply_to_vendor' && decision.awaitingReply) text = 'Open vendor question: "' + decision.awaitingReply + '" — awaiting our reply.';
        else if (decision.currentStatus) text = decision.currentStatus + (decision.nextStep ? ' Next: ' + decision.nextStep : '');
      }
      if (text) return { ok: true, text, source: 'reconcile', side: paneSide, intent, awaitingReply: decision.awaitingReply || '', decision };
    }

    // Fallback: seed from CANONICAL STATE — populated for every unit every sync
    // regardless of the reconcile engine toggle. This is why Split View still
    // auto-fills a reconciled draft even with the engine off. We never invent:
    // if canonical has no usable text, we return ok:false so the renderer uses
    // its own generic template.
    try {
      const canon = require('../orcha/canonical_state').getCanonical(row);
      if (canon) {
        let text = '';
        const intent = canon.nextActionType || '';
        if (paneSide === 'offsite') {
          // Vendor-facing pane. If the canonical record has an open vendor
          // question, surface it (we owe a reply). Else, if we're waiting on the
          // vendor, draft a chase.
          if (intent === 'reply_to_vendor' && canon.awaitingReply) {
            text = 'Vendor asked: "' + canon.awaitingReply + '" — reply needed.';
          } else if (canon.waitingOn === 'vendor' || canon.stale) {
            text = 'Following up on ' + id + (canon.situation ? ' (' + canon.situation + ')' : '') +
              ' — can you confirm the current repair status and a revised ETC?';
          }
        } else {
          // Relay pane = internal status + reconciled next step (+ open question note).
          if (intent === 'reply_to_vendor' && canon.awaitingReply) {
            text = 'Open vendor question: "' + canon.awaitingReply + '" — awaiting our reply.';
          } else if (canon.situation || canon.nextStep) {
            text = (canon.situation || '').trim();
            if (canon.nextStep) text += (text ? ' ' : '') + 'Next: ' + canon.nextStep;
          }
        }
        if (text && text.trim().length > 10) {
          return { ok: true, text: text.trim(), source: 'canonical', side: paneSide, intent, awaitingReply: canon.awaitingReply || '', canonical: canon };
        }
      }
    } catch (e) { logger.warn('[draft-for-split] canonical fallback failed: ' + e.message); }

    return { ok: false, reason: 'nothing to draft' };
  });

  logger.info('Relay Reconcile IPC handlers registered');
}

module.exports = { registerRelayReconcileIPC };
