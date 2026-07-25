'use strict';
/**
 * ipc/cloud-companion.js — Fleet Ops Companion (iPhone PWA) bridge
 *
 * Polls the companion Cloudflare Worker (see companion/ folder at the repo
 * root -- a separate, independently deployed project) for chat messages
 * sent from the phone, answers them through the EXACT SAME AI action
 * pipeline the in-app FAB uses (processOrchaAction() / confirmSend() in
 * ./ai.js — same fleet context, same Slack/email send capability, same
 * confirm-before-send safety gate), and posts the reply back so the phone
 * gets a push notification with the answer.
 *
 * Because there's no clickable Send/Cancel button on the phone, a pending
 * send (Slack or email) is tracked here and resolved by the user's next
 * plain-text reply ("yes"/"no"). Nothing ever sends without that explicit
 * confirmation, matching the in-app FAB's guarantee.
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

// How long a pending Slack/email confirmation stays valid on the phone side.
// Past this, a stray "yes" days later can't trigger an old send.
const PENDING_CONFIRM_TTL_MS = 15 * 60 * 1000;

const YES_RE = /^\s*(yes|yep|yeah|y|confirm|confirmed|send|send it|go ahead|do it|ok|okay|k)\s*[.!]?\s*$/i;
const NO_RE  = /^\s*(no|nope|n|cancel|nevermind|never mind|stop|don'?t)\s*[.!]?\s*$/i;

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

function _getPending() {
  const p = store.load('cloudCompanionPendingConfirm', null);
  if (!p || !p.items || !p.items.length) return null;
  if (Date.now() - (p.createdAt || 0) > PENDING_CONFIRM_TTL_MS) return null;
  return p;
}

function _setPending(items) {
  store.save('cloudCompanionPendingConfirm', { items, createdAt: Date.now() });
}

function _clearPending() {
  store.save('cloudCompanionPendingConfirm', null);
}

async function _handleIncomingMessage(text) {
  const { processOrchaAction, confirmSend } = require('./ai');

  const pending = _getPending();
  if (pending) {
    if (YES_RE.test(text)) {
      const outcomes = [];
      for (const item of pending.items) {
        try {
          const r = await confirmSend(item);
          outcomes.push(r && r.ok ? (r.message || 'Sent.') : ('Failed: ' + (r && r.error || 'unknown error')));
        } catch (e) {
          outcomes.push('Failed: ' + e.message);
        }
      }
      _clearPending();
      return outcomes.join('\n');
    }
    if (NO_RE.test(text)) {
      _clearPending();
      return 'Cancelled — nothing was sent.';
    }
    // Stale/unrelated reply — drop the old pending confirm and treat this
    // message as a brand new question instead of silently ignoring it.
    _clearPending();
  }

  const result = await processOrchaAction(text);
  let replyText = result && result.text ? result.text : "Sorry, I couldn't process that.";
  if (result && result.pendingConfirm && result.pendingConfirm.length) {
    _setPending(result.pendingConfirm);
    replyText += '\n\nReply YES to send, or NO to cancel.';
  }
  return replyText;
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

    for (const msg of messages) {
      let replyText;
      try {
        replyText = await _handleIncomingMessage(msg.text);
      } catch (askErr) {
        logger.warn('AI pipeline failed for phone message: ' + askErr.message);
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
