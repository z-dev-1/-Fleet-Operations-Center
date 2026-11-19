'use strict';
/**
 * ipc/relay-writes.js — renderer surface for the Relay write-approval gate
 * (src/writes/write-gate.js).
 *
 *   relayWrites:list              -> { items } (pending / finished writes, previews only)
 *   relayWrites:approve (id)      -> send the stored payload once
 *   relayWrites:reject  (id)      -> never sent
 *   relayWrites:respond (id, ok)  -> answer a live 'relayWrites:approval-request' prompt
 *   relay:add-comment ({ workRequestId | serviceUrl, text, unit, aiDrafted })
 *                                 -> internal Relay WR comment via
 *                                    aap_create_wr.addConversationNote (gated, interactive)
 *   relay:draft-comment ({ workRequestId | serviceUrl, unit })
 *                                 -> { ok, aiDrafted, draft, noUpdate, dropped, droppedCount }
 *                                    AI gap draft (writes/relay-comment-draft); never sends
 *   relay:draft-action ({ workRequestId | serviceUrl, kind:'escalation'|'comment', target, template,
 *                         unit, userInputs:{ estAmount } })
 *                                 -> { ok, draft, placeholders, freshness, aiUsed, replaced, sources, note }
 *                                    grounded <FILL: …> draft (writes/relay-action-draft); never sends
 *   relay:escalate ({ workRequestId, aaid, add[], remove[], comment, unit, aiDrafted })
 *                                 -> { ok, outcome, id, error, current } escalation change
 *                                    via the gate's updateEscalations kind (interactive)
 *   relay:change-lifecycle ({ equipmentId, assetUrl, state, reason, fromState, confirmed })
 *                                 -> { ok, outcome, id, error, result } via the gate's
 *                                    setLifecycle kind; CONFIRM_REQUIRED unless confirmed===true
 *   relay:lifecycle-options ({ fleetId })
 *                                 -> { ok, states, reasons } read-only, END_OF_LIFE never listed
 *
 * Main -> renderer: 'relayWrites:approval-request' { id, kind, preview, aiDrafted },
 * 'relayWrites:updated' { items }.
 */

const logger = require('../utils/logger')('ipc:relay-writes');
const { handle, requireString, requireStringMax, requireObject } = require('./_safe');
const { ConfigError } = require('../utils/errors');
const writeGate = require('../writes/write-gate');

const WR_UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

function registerRelayWritesIPC(ctx) {
  writeGate.setWindowGetter(() => (ctx && typeof ctx.getMainWindow === 'function'
    ? ctx.getMainWindow()
    : (ctx && ctx.mainWindow) || null));

  handle('relayWrites:list', () => writeGate.list());
  handle('relayWrites:approve', async (_e, id) => {
    requireString(id, 'id');
    return writeGate.approve(id, 'relay-writes-list');
  });
  handle('relayWrites:reject', (_e, id) => {
    requireString(id, 'id');
    return writeGate.reject(id);
  });
  handle('relayWrites:respond', (_e, id, approved) => {
    requireString(id, 'id');
    return writeGate.respond(id, approved === true);
  });
  // Unit-detail compose control. Goes through addConversationNote, so the
  // write gate (and its approval modal) decides whether anything is sent.
  handle('relay:add-comment', async (_e, payload) => {
    requireObject(payload, 'payload');
    const text = requireStringMax(payload.text, 'text', writeGate.COMMENT_MAX);
    const m = WR_UUID_RE.exec(String(payload.workRequestId || '')) || WR_UUID_RE.exec(String(payload.serviceUrl || ''));
    if (!m) throw new ConfigError('workRequestId must be a Relay WR id', 'workRequestId');
    return require('../scrapers/aap_create_wr').addConversationNote(m[0], text, {
      origin: 'unit-detail',
      unit: String(payload.unit || '').slice(0, 40),
      interactive: true,
      aiDrafted: payload.aiDrafted === true,
    });
  });
  // AI draft for the compose box. Returns text only; nothing is sent from here
  // (the user edits it and Send goes through relay:add-comment above).
  handle('relay:draft-comment', async (_e, payload) => {
    requireObject(payload, 'payload');
    const m = WR_UUID_RE.exec(String(payload.workRequestId || '')) || WR_UUID_RE.exec(String(payload.serviceUrl || ''));
    if (!m) throw new ConfigError('workRequestId must be a Relay WR id', 'workRequestId');
    requireObject(payload.unit, 'unit');
    return require('../writes/relay-comment-draft').draftForUnit({
      workRequestId: m[0], unit: payload.unit, lastData: ctx && ctx.lastData,
    });
  });
  // Grounded draft for the Escalate reason / Relay comment templates. Text only; nothing
  // is staged or sent from here (submit goes through relay:escalate / relay:add-comment).
  handle('relay:draft-action', async (_e, payload) => {
    requireObject(payload, 'payload');
    const m = WR_UUID_RE.exec(String(payload.workRequestId || '')) || WR_UUID_RE.exec(String(payload.serviceUrl || ''));
    if (!m) throw new ConfigError('workRequestId must be a Relay WR id', 'workRequestId');
    const policy = require('../writes/relay-action-policy');
    const kind = payload.kind;
    if (kind !== 'escalation' && kind !== 'comment') throw new ConfigError('kind must be escalation or comment', 'kind');
    if (kind === 'escalation' && !policy.ESCALATION_TARGETS.some((t) => t.key === payload.target)) {
      throw new ConfigError('target must be an RG escalation type', 'target');
    }
    if (kind === 'comment' && payload.template !== 'offsite-update' && payload.template !== 'update-request') {
      throw new ConfigError('template must be offsite-update or update-request', 'template');
    }
    requireObject(payload.unit, 'unit');
    const ui = payload.userInputs && typeof payload.userInputs === 'object' ? payload.userInputs : {};
    const amt = Number(ui.estAmount);
    return require('../writes/relay-action-draft').draftAction({
      kind,
      target: kind === 'escalation' ? payload.target : undefined,
      template: kind === 'comment' ? payload.template : undefined,
      workRequestId: m[0],
      unit: payload.unit,
      userInputs: { estAmount: Number.isFinite(amt) && amt >= 0 ? amt : 0 },
      lastData: ctx && ctx.lastData,
    });
  });
  // Escalate / de-escalate a WR through the write gate (approval modal).
  // createdBy is resolved in main from the signed-in AAP user.
  handle('relay:escalate', async (_e, payload) => {
    requireObject(payload, 'payload');
    const m = WR_UUID_RE.exec(String(payload.workRequestId || ''));
    if (!m) throw new ConfigError('workRequestId must be a Relay WR id', 'workRequestId');
    const aaid = requireStringMax(payload.aaid, 'aaid', 128);
    const list = (v, name) => {
      const arr = v == null ? [] : v;
      if (!Array.isArray(arr) || arr.length > 20 || arr.some((x) => typeof x !== 'string')) {
        return { error: name + ' must be an array of at most 20 strings' };
      }
      return { arr };
    };
    const a = list(payload.add, 'add');
    if (a.error) return { ok: false, error: a.error, code: 'ESCALATION_INVALID' };
    const r = list(payload.remove, 'remove');
    if (r.error) return { ok: false, error: r.error, code: 'ESCALATION_INVALID' };
    return require('../writes/relay-action-writes').escalate({
      workRequestId: m[0],
      aaid,
      add: a.arr,
      remove: r.arr,
      comment: payload.comment == null ? '' : String(payload.comment),
      unit: payload.unit,
      aiDrafted: payload.aiDrafted === true,
    });
  });
  // Lifecycle change: refused without an explicit confirmed:true, then gated.
  handle('relay:change-lifecycle', async (_e, payload) => {
    requireObject(payload, 'payload');
    if (payload.confirmed !== true) {
      return { ok: false, code: 'CONFIRM_REQUIRED', error: 'Lifecycle change needs an explicit confirm' };
    }
    const equipmentId = requireString(payload.equipmentId, 'equipmentId');
    const assetUrl = requireString(payload.assetUrl, 'assetUrl');
    const state = requireString(payload.state, 'state');
    const lc = require('../scrapers/aap_lifecycle_api');
    const norm = state.toUpperCase().replace(/\s+/g, '_');
    if (lc.BLOCKED_STATES.includes(norm) || !lc.ALLOWED_STATES.includes(norm)) {
      return { ok: false, code: 'STATE_NOT_ALLOWED', error: 'Lifecycle state ' + norm + ' is not allowed' };
    }
    return require('../writes/relay-action-writes').changeLifecycle({
      equipmentId,
      assetUrl,
      state,   // label form (Active/Unavailable/Ordered): the browser fallback matches labels
      reason: payload.reason == null ? '' : String(payload.reason),
      fromState: payload.fromState == null ? '' : String(payload.fromState),
    });
  });
  // Read-only: lifecycle states (END_OF_LIFE never offered) + supported reasons.
  handle('relay:lifecycle-options', async (_e, payload) => {
    const fleetId = payload && typeof payload === 'object' && payload.fleetId ? String(payload.fleetId) : '';
    return require('../writes/relay-action-writes').lifecycleOptions(fleetId);
  });

  logger.info('Relay writes IPC handlers registered');
}

module.exports = { registerRelayWritesIPC };
