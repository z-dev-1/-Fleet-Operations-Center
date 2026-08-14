'use strict';
/**
 * ipc/graph.js — Microsoft Graph mail IPC handlers
 * graph:check-auth, graph:sign-in, graph:sign-out, graph:send-mail
 *
 * Mirrors this app's existing Slack IPC pattern (src/ipc/slack.js):
 * interactive BrowserWindow sign-in, status check, sign-out. See
 * src/graph/client.js for the full "why" writeup on this integration.
 */

const logger = require('../utils/logger')('ipc:graph');
const { handle, requireStringMax } = require('./_safe');

const MAX_ADDR_LEN = 512;    // to/cc/bcc — comma/semicolon-separated list
const MAX_SUBJECT_LEN = 500;
const MAX_BODY_LEN = 2_000_000; // generous ceiling for a rich HTML fleet report

function registerGraphIPC() {
  handle('graph:check-auth', async () => {
    const { isConfigured, isSignedIn } = require('../graph/client');
    return { configured: isConfigured(), signedIn: await isSignedIn() };
  });

  handle('graph:sign-in', async () => {
    const { signInInteractive } = require('../graph/client');
    return signInInteractive();
  });

  handle('graph:sign-out', async () => {
    const { signOut } = require('../graph/client');
    return signOut();
  });

  handle('graph:get-calendar-events', async (_e, opts) => {
    const { getCalendarEvents } = require('../graph/client');
    return getCalendarEvents(opts || {});
  });

  handle('graph:send-mail', async (_e, data) => {
    if (!data || typeof data !== 'object') {
      const { ConfigError } = require('../utils/errors');
      throw new ConfigError('graph:send-mail payload must be an object', 'data');
    }
    requireStringMax(data.to, 'to', MAX_ADDR_LEN);
    if (data.cc) requireStringMax(data.cc, 'cc', MAX_ADDR_LEN);
    if (data.bcc) requireStringMax(data.bcc, 'bcc', MAX_ADDR_LEN);
    requireStringMax(data.subject, 'subject', MAX_SUBJECT_LEN);
    requireStringMax(data.htmlBody, 'htmlBody', MAX_BODY_LEN);
    const { sendMail } = require('../graph/client');
    return sendMail(data);
  });
}

module.exports = { registerGraphIPC };
