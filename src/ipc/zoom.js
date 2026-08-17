'use strict';
/**
 * ipc/zoom.js -- Zoom integration IPC handlers.
 *
 * zoom:login mirrors slack:login exactly (see ipc/slack.js): pops a real
 * Zoom sign-in window, no manual token pasting. The one thing that can't
 * be a button click is the initial OAuth app registration (Client ID /
 * Client Secret / redirect URL) -- that's a one-time app-setup step done
 * via the generic credentials:set channel already exposed to the
 * renderer (see preload.js window.credentials), same as it would be for
 * any OAuth integration. Meeting SDK credentials (sdkKey/sdkSecret) are a
 * separate, unrelated app and also go through credentials:set.
 */

const { BrowserWindow } = require('electron');
const { handle } = require('./_safe');
const { ConfigError }           = require('../utils/errors');
const creds                     = require('../security/credentials');
const zoom                       = require('../orcha/zoom');
const logger                     = require('../utils/logger')('ipc:zoom');

function registerZoomIPC(ctx) {
  handle('zoom:get-status', async () => {
    const [appConfigured, signedIn, hasSdk] = await Promise.all([
      zoom.isAppConfigured(),
      zoom.isSignedIn(),
      zoom.hasSdkCredentials(),
    ]);
    return { appConfigured, signedIn, hasSdk };
  });

  // FEATURE (2026-07-23): "Sign in with Zoom" -- mirrors slack:login.
  // Opens a real Zoom login window; once the user signs in and approves,
  // Zoom redirects to our registered redirect URL with ?code=... on the
  // main frame. We catch that redirect via will-redirect (before Electron
  // tries to actually navigate to what is often a non-serving URL),
  // exchange the code for tokens server-side, and close the window.
  handle('zoom:login', async () => {
    const [clientId, clientSecret, redirectUriRaw] = await Promise.all([
      creds.get('zoom.clientId'),
      creds.get('zoom.clientSecret'),
      creds.get('zoom.redirectUri'),
    ]);
    if (!clientId || !clientSecret) {
      throw new ConfigError('Zoom OAuth app not configured yet -- set Client ID/Secret first', 'clientId');
    }
    const redirectUri = redirectUriRaw || 'https://fleet-ops.local/oauth/zoom/callback';

    return new Promise((resolve) => {
      const win = new BrowserWindow({
        width: 500, height: 720, title: 'Sign in to Zoom',
        icon: require('../config/app-icon').getAppIconPath(),
        webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:zoom' },
      });
      win.setMenuBarVisibility(false);

      const authUrl = 'https://zoom.us/oauth/authorize?response_type=code' +
        '&client_id=' + encodeURIComponent(clientId) +
        '&redirect_uri=' + encodeURIComponent(redirectUri);
      win.loadURL(authUrl);

      let done = false;
      const tryHandleRedirect = async (event, url) => {
        if (done || !url.startsWith(redirectUri)) return;
        event.preventDefault();
        done = true;
        try {
          const code = new URL(url).searchParams.get('code');
          if (!code) throw new Error('Zoom redirect had no authorization code');
          await zoom.exchangeCodeForTokens(code, redirectUri);
          logger.info('Zoom sign-in complete');
          if (!win.isDestroyed()) win.close();
          resolve({ ok: true, message: 'Signed in to Zoom!' });
        } catch (e) {
          logger.warn('Zoom sign-in failed:', e.message);
          if (!win.isDestroyed()) win.close();
          resolve({ ok: false, error: e.message });
        }
      };
      win.webContents.on('will-redirect', tryHandleRedirect);
      win.webContents.on('will-navigate', tryHandleRedirect);

      win.on('closed', () => {
        if (!done) resolve({ ok: false, error: 'Sign-in window closed before completing' });
      });
    });
  });

  handle('zoom:logout', async () => {
    await zoom.logout();
    return { ok: true };
  });

  handle('zoom:test-connection', async () => {
    const meetings = await zoom.listUpcomingMeetings();
    return { ok: true, meetingCount: meetings.length };
  });

  // Signs a Meeting SDK JWT server-side. sdkKey is returned alongside the
  // signature -- it is NOT secret (it's the public "Client ID" of the
  // Meeting SDK app); sdkSecret never leaves this process.
  handle('zoom:get-join-signature', async (_e, meetingNumber, role) => {
    if (!meetingNumber) throw new ConfigError('meetingNumber required', 'meetingNumber');
    return await zoom.generateJoinSignature(meetingNumber, role || 0);
  });

  handle('zoom:list-upcoming-meetings', async () => {
    return await zoom.listUpcomingMeetings();
  });

  handle('zoom:open-meeting-window', async (_e, meeting) => {
    if (!meeting || !meeting.meetingNumber) throw new ConfigError('meeting.meetingNumber required', 'meeting');
    if (!ctx || typeof ctx.openZoomMeetingWindow !== 'function') {
      throw new ConfigError('openZoomMeetingWindow not available on ctx', 'ctx');
    }
    ctx.openZoomMeetingWindow(meeting);
    return { ok: true };
  });

  logger.info('Zoom IPC handlers registered');
}

module.exports = { registerZoomIPC };
