'use strict';
/**
 * ipc/relay-writes.js — renderer surface for the Relay write-approval gate
 * (src/writes/write-gate.js).
 *
 *   relayWrites:list              -> { items } (pending / finished writes, previews only)
 *   relayWrites:approve (id)      -> send the stored payload once
 *   relayWrites:reject  (id)      -> never sent
 *   relayWrites:respond (id, ok)  -> answer a live 'relayWrites:approval-request' prompt
 *   relay:add-comment ({ workRequestId | serviceUrl, text, unit })
 *                                 -> internal Relay WR comment via
 *                                    aap_create_wr.addConversationNote (gated, interactive)
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
      aiDrafted: false,
    });
  });

  logger.info('Relay writes IPC handlers registered');
}

module.exports = { registerRelayWritesIPC };
