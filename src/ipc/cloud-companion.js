'use strict';
/**
 * ipc/cloud-companion.js — Fleet Ops Companion (iPhone PWA) bridge
 *
 * Polls the companion Cloudflare Worker (see companion/ folder at the repo
 * root -- a separate, independently deployed project) for chat messages
 * sent from the phone, answers them through the exact same AI pipeline the
 * in-app FAB uses (relay.ask()), and posts the reply back so the phone gets
 * a push notification with the answer.
 *
 * Config (Settings > Integrations > Cloud Companion) is stored via the
 * shared `store` module under the 'cloudCompanion' key:
 *   { enabled: boolean, workerUrl: string, alertSecret: string }
 * `workerUrl` and `alertSecret` come from running through companion/README.md.
 */

const store  = require('../store');
const logger = require('../utils/logger')('cloud-companion');

const POLL_INTERVAL_MS = 10000;
const DEFAULT_CONFIG = { enabled: false, workerUrl: '', alertSecret: '' };

let _pollTimer = null;
let _polling = false; // reentrancy guard, in case a poll takes >10s

function getConfig() {
  return { ...DEFAULT_CONFIG, ...store.load('cloudCompanion', DEFAULT_CONFIG) };
}

function saveConfig(partial) {
  const cfg = { ...getConfig(), ...partial };
  store.save('cloudCompanion', cfg);
  return cfg;
}

async function _pollOnce() {
  if (_polling) return; // previous poll still running, skip this tick
  const cfg = getConfig();
  if (!cfg.enabled || !cfg.workerUrl || !cfg.alertSecret) return;

  _polling = true;
  try {
    const pollRes = await fetch(`${cfg.workerUrl}/api/chat-poll`, {
      headers: { Authorization: `Bearer ${cfg.alertSecret}` },
    });
    if (!pollRes.ok) {
      logger.warn('chat-poll failed: HTTP ' + pollRes.status);
      return;
    }
    const { messages } = await pollRes.json();
    if (!messages || messages.length === 0) return;

    logger.info(`Received ${messages.length} phone chat message(s)`);
    const relay = require('../orcha/relay');

    for (const msg of messages) {
      let replyText;
      try {
        replyText = await relay.ask(msg.text);
      } catch (askErr) {
        logger.warn('relay.ask failed for phone message: ' + askErr.message);
        replyText = "Sorry, I couldn't reach the AI assistant just now. Try again in a bit.";
      }
      try {
        await fetch(`${cfg.workerUrl}/api/chat-reply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.alertSecret}` },
          body: JSON.stringify({ id: msg.id, text: replyText }),
        });
      } catch (replyErr) {
        logger.warn('chat-reply post failed: ' + replyErr.message);
      }
    }
  } catch (err) {
    logger.warn('Cloud companion poll error: ' + err.message);
  } finally {
    _polling = false;
  }
}

function _startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(_pollOnce, POLL_INTERVAL_MS);
  logger.info('Cloud companion chat polling started');
}

function _stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  logger.info('Cloud companion chat polling stopped');
}

function registerCloudCompanionIPC(ctx) {
  const { ipcMain } = require('electron');

  ipcMain.handle('cloud-companion:get-config', () => getConfig());

  ipcMain.handle('cloud-companion:set-config', (_e, partial) => {
    const cfg = saveConfig(partial || {});
    if (cfg.enabled) _startPolling(); else _stopPolling();
    return cfg;
  });

  ipcMain.handle('cloud-companion:test-connection', async () => {
    const cfg = getConfig();
    if (!cfg.workerUrl || !cfg.alertSecret) return { ok: false, error: 'Worker URL and Alert Secret are required' };
    try {
      const res = await fetch(`${cfg.workerUrl}/api/chat-poll`, {
        headers: { Authorization: `Bearer ${cfg.alertSecret}` },
      });
      if (res.status === 401) return { ok: false, error: 'Alert Secret rejected by the Worker (401)' };
      if (!res.ok) return { ok: false, error: `Worker returned HTTP ${res.status}` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Resume polling on startup if it was left enabled last session.
  const cfg = getConfig();
  if (cfg.enabled) _startPolling();

  logger.info('Cloud companion IPC registered');
}

module.exports = { registerCloudCompanionIPC };
