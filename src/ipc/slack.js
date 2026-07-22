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
const store  = require('../store'); // BUG FIX (2026-07-16): was missing entirely; see slack:get/set-auto-reply below
const logger = require('../utils/logger')('ipc:slack');
const { handle, requireString, requireStringMax } = require('./_safe');

// ── Issue #5: Slack field caps ───────────────────────────────────────────────
const MAX_RECIPIENT_LEN = 128;    // Slack channel name / user handle
const MAX_MESSAGE_LEN   = 8000;   // Slack API message body limit

function registerSlackIPC() {
  // FEATURE (2026-07-16): the handler below only checks that a token file
  // exists on disk. slack:check-live-auth (added a few lines down) actually
  // confirms the token still works via Slack's auth.test endpoint -- used
  // by the new Slack tab in the Orcha floater so a stale/revoked session
  // shows correctly instead of appearing permanently "connected."
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

  // FEATURE (2026-07-16): see comment above slack:check-auth. Actually
  // confirms the token still works (Slack session tokens can be revoked
  // without the local file changing), used by the new Slack tab so a
  // stale session shows correctly instead of appearing "connected" forever.
  handle('slack:check-live-auth', async () => {
    const { checkLiveAuth } = require('../../src/scrapers/slack_send');
    return checkLiveAuth();
  });

  // FEATURE (2026-07-16): lets the user cleanly reset a stuck/stale Slack
  // session from the UI instead of having no way to force a fresh sign-in.
  handle('slack:logout', async () => {
    const { logout } = require('../../src/scrapers/slack_send');
    return logout();
  });

  // FEATURE (2026-07-16): direct send-by-ID for the Slack tab's reply box,
  // where the channel/DM ID is already known from getChannels()/readDMs()
  // -- more reliable than slack:send's fuzzy name-based recipient lookup.
  handle('slack:send-to-channel', async (_e, data) => {
    if (!data || typeof data !== 'object') {
      const { ConfigError } = require('../utils/errors');
      throw new ConfigError('slack:send-to-channel payload must be an object', 'data');
    }
    requireStringMax(data.channelId, 'channelId', MAX_RECIPIENT_LEN);
    requireStringMax(data.message,   'message',   MAX_MESSAGE_LEN);
    const { sendToChannel } = require('../../src/scrapers/slack_send');
    return sendToChannel(data.channelId, data.message);
  });

  // FEATURE (2026-07-16): search-based directory lookup, replacing the
  // channel/DM browse list -- Amazon's Enterprise Grid Slack blocks bulk
  // conversation listing (verified: conversations.list AND
  // users.conversations both return "enterprise_is_restricted"), but
  // individual search.modules lookups are NOT restricted. See searchDirectory
  // in slack_send.js for full detail.
  handle('slack:search-directory', async (_e, data) => {
    if (!data || typeof data.query !== 'string' || !data.query.trim()) {
      throw new Error('slack:search-directory requires a non-empty query');
    }
    requireStringMax(data.query, 'query', MAX_RECIPIENT_LEN);
    const { searchDirectory } = require('../../src/scrapers/slack_send');
    return searchDirectory(data.query.trim(), data.limit || 8);
  });

  // FEATURE (2026-07-16): resolves a search result to an open conversation
  // ID (opens the DM if it's a person; passes through the channel ID as-is
  // if it's a channel). See openConversation in slack_send.js.
  handle('slack:open-conversation', async (_e, data) => {
    if (!data || !data.id || !data.type) {
      throw new Error('slack:open-conversation requires { id, type }');
    }
    const { openConversation } = require('../../src/scrapers/slack_send');
    return { channelId: await openConversation(data) };
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
    // BUG FIX (2026-07-16): this called store.get(), but (1) `store` was
    // never imported/required anywhere in this file -- would throw
    // "store is not defined" -- and (2) even if it had been imported, the
    // real store module (src/store/index.js) only exposes load/save/
    // update/exists/delete, no .get()/.set(). Currently unreachable (no UI
    // calls this yet), but would have crashed instantly the moment
    // anything did. Fixed to use the real API + registered the
    // 'slackAutoReply' key in store/index.js's REGISTRY.
    return store.load('slackAutoReply', []);
  });

  handle('slack:set-auto-reply', async (_e, rules) => {
    if (!Array.isArray(rules)) throw new Error('rules must be an array');
    if (rules.length > 50) throw new Error('max 50 auto-reply rules');
    store.save('slackAutoReply', rules);
    logger.info('[Slack] auto-reply rules saved: ' + rules.length);
    return { ok: true, count: rules.length };
  });

  // ── Partner Auto-Reply engine (2026-07-21) ──────────────────────────────
  // See src/scrapers/slack_channel_watch.js for the full design/safety
  // writeup. IPC surface: config get/save, the poll trigger (called on a
  // timer from the renderer, same pattern as the existing DM poller), and
  // review-queue read/update for the Orcha floater's Review tab.
  handle('slack:get-channel-watch-config', async () => {
    const { getWatchConfig } = require('../../src/scrapers/slack_channel_watch');
    return getWatchConfig();
  });

  handle('slack:save-channel-watch-config', async (_e, config) => {
    if (!config || typeof config !== 'object') throw new Error('config must be an object');
    const { saveWatchConfig } = require('../../src/scrapers/slack_channel_watch');
    return saveWatchConfig(config);
  });

  // FEATURE (2026-07-22): channel-add-by-ID membership check -- see
  // checkChannelMembership() in slack_send.js for the full rationale on
  // why ID entry + verification replaces a browsable channel list here.
  handle('slack:check-channel-membership', async (_e, channelId) => {
    requireString(channelId, 'channelId');
    const { checkChannelMembership } = require('../../src/scrapers/slack_send');
    return checkChannelMembership(channelId);
  });

  handle('slack:poll-channel-watch', async () => {
    const { pollChannelsOnce } = require('../../src/scrapers/slack_channel_watch');
    return pollChannelsOnce((msg) => logger.info(msg));
  });

  // BUG FIX (2026-07-22): one-time cleanup of any duplicate log entries
  // already created before the pollChannelsOnce re-entrancy lock existed.
  // See dedupeReplyLog() in slack_channel_watch.js for full rationale.
  handle('slack:dedupe-replies', async () => {
    const { dedupeReplyLog } = require('../../src/scrapers/slack_channel_watch');
    return dedupeReplyLog();
  });

  handle('slack:get-review-queue', async () => {
    const { getReviewQueue } = require('../../src/scrapers/slack_channel_watch');
    return getReviewQueue();
  });

  handle('slack:get-reply-log', async (_e, limit) => {
    const { getReplyLog } = require('../../src/scrapers/slack_channel_watch');
    return getReplyLog(limit);
  });

  handle('slack:update-review-item', async (_e, data) => {
    if (!data || !data.id) throw new Error('data.id required');
    const { updateReviewItem } = require('../../src/scrapers/slack_channel_watch');
    return updateReviewItem(data.id, data.updates || {});
  });

  logger.info('Slack IPC handlers registered');
}

module.exports = { registerSlackIPC };
