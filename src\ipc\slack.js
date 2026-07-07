'use strict';
/**
 * ipc/slack.js - Slack IPC handlers
 * slack:check-auth, slack:login, slack:send
 *
 * V-C: Slack token stored via safeStorage (creds.set), NOT plaintext JSON.
 *
 * Stage 3 hardening (2026-06-28):
 *   - Issue #5 MED: slack:send validates recipient (non-empty string, max 128)
 *                   and message (non-empty string, max 8000 chars) before
 *                   forwarding to sendSlackMessage.
 *   - All handlers migrated to handle() wrapper.
 */

const { BrowserWindow, session: electronSession } = require('electron');
const creds  = require('../security/credentials');
const logger = require('../utils/logger')('ipc:slack');
const { handle, requireStringMax } = require('./_safe');

// ── Issue #5: Slack field caps ───────────────────────────────────────────────
const MAX_RECIPIENT_LEN = 128;    // Slack channel name / user handle
const MAX_MESSAGE_LEN   = 8000;   // Slack API message body limit

function registerSlackIPC() {
  handle('slack:check-auth', async () => {
    const { isAuthenticated } = require('../../src/scrapers/slack_send');
    return { authenticated: isAuthenticated() };
  });

  handle('slack:login', async () => {
    return new Promise((resolve) => {
      const slackWin = new BrowserWindow({
        width: 900, height: 700, title: 'Sign in to Slack',
        webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:slack' },
      });
      slackWin.setMenuBarVisibility(false);
      slackWin.loadURL('https://amazon.enterprise.slack.com/');

      let tokenGrabbed = false;
      const ses    = electronSession.fromPartition('persist:slack');
      const filter = { urls: ['*://*.slack.com/api/*'] };

      ses.webRequest.onBeforeSendHeaders(filter, async (details, callback) => {
        if (!tokenGrabbed && details.uploadData) {
          let body = '';
          for (const item of details.uploadData) {
            if (item.bytes) body += Buffer.from(item.bytes).toString();
          }
          const tokenMatch = body.match(/xoxc-[^\s&\x27\x22,;{}\]\r\n]+/);
          if (tokenMatch) {
            tokenGrabbed = true;
            const cookieHeader = details.requestHeaders['Cookie'] || '';
            await creds.set('slack.token', tokenMatch[0]);
            await creds.set('slack.cookieHeader', cookieHeader);
            try {
              const { slackSaveConfig } = require('../../src/scrapers/slack_send');
              slackSaveConfig({ token: tokenMatch[0], allCookieHeader: cookieHeader });
            } catch (_) { /* scraper not yet migrated */ }
            logger.info('Slack authenticated - token stored securely');
            slackWin.close();
            resolve({ ok: true, message: 'Signed in successfully!' });
          }
        }
        callback({ requestHeaders: details.requestHeaders });
      });

      slackWin.on('closed', () => {
        if (!tokenGrabbed) resolve({ ok: false, error: 'Login window closed before sign-in completed' });
      });
    });
  });

  // Issue #5: validate recipient + message before forwarding
  handle('slack:send', async (_e, data) => {
    if (!data || typeof data !== 'object') {
      const { ConfigError } = require('../utils/errors');
      throw new ConfigError('slack:send payload must be an object', 'data');
    }
    requireStringMax(data.recipient, 'recipient', MAX_RECIPIENT_LEN);
    requireStringMax(data.message,   'message',   MAX_MESSAGE_LEN);
    const { sendSlackMessage } = require('../../src/scrapers/slack_send');
    return sendSlackMessage(data.recipient, data.message);
  });


  // S22: slack:get-channels -- list accessible channels/DMs
  handle('slack:get-channels', async () => {
    const { getChannels } = require('../../src/scrapers/slack_send');
    return getChannels(100);
  });

  // S22: slack:read -- fetch message history for a channel or DM
  handle('slack:read', async (_e, data) => {
    if (!data || !data.channelId) throw new Error('slack:read requires channelId');
    const { readMessages } = require('../../src/scrapers/slack_send');
    return readMessages(data.channelId, data.limit || 30);
  });

  // S22: slack:read-dms -- fetch recent DM threads
  handle('slack:read-dms', async () => {
    const { readDMs } = require('../../src/scrapers/slack_send');
    return readDMs(20);
  });

  // S22: slack:auto-reply-config -- get/set auto-reply rules
  handle('slack:get-auto-reply', async () => {
    return store.get('slackAutoReply') || [];
  });

  handle('slack:set-auto-reply', async (_e, rules) => {
    if (!Array.isArray(rules)) throw new Error('rules must be an array');
    if (rules.length > 50) throw new Error('max 50 auto-reply rules');
    store.set('slackAutoReply', rules);
    logger.info('[Slack] auto-reply rules saved: ' + rules.length);
    return { ok: true, count: rules.length };
  });

  logger.info('Slack IPC handlers registered');
}

module.exports = { registerSlackIPC };
