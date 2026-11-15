'use strict';
/**
 * ipc/relay-writes.js — renderer surface for the Relay write-approval gate
 * (src/writes/write-gate.js).
 *
 *   relayWrites:list              -> { items } (pending / finished writes, previews only)
 *   relayWrites:approve (id)      -> send the stored payload once
 *   relayWrites:reject  (id)      -> never sent
 *   relayWrites:respond (id, ok)  -> answer a live 'relayWrites:approval-request' prompt
 *
 * Main -> renderer: 'relayWrites:approval-request' { id, kind, preview, aiDrafted },
 * 'relayWrites:updated' { items }.
 */

const logger = require('../utils/logger')('ipc:relay-writes');
const { handle, requireString } = require('./_safe');
const writeGate = require('../writes/write-gate');

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

  logger.info('Relay writes IPC handlers registered');
}

module.exports = { registerRelayWritesIPC };
