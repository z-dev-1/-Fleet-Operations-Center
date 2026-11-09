'use strict';
/**
 * zoom-meet/view.js — one live Zoom meeting view that moves between layouts.
 *
 * A single WebContentsView (partition persist:zoom-portal) is owned by main:
 *   - 'main'      attached to the Fleet main window; the renderer reports the stage
 *                 rect (docked tab, in-app full screen, or corner mini player) and
 *                 main positions the view there. A null rect hides it (call keeps going).
 *   - 'detached'  re-parented into its own "Fleet Meeting" window (normal or a small
 *                 always-on-top floating mini player). Closing that window re-docks
 *                 the view; it does NOT hang up. Only leave() ends the meeting.
 * Re-parenting moves the same webContents, so switching layouts never reloads or
 * drops the call.
 *
 * Navigation is limited to *.zoom.us + the SSO hops (url.isAllowedNavUrl).
 * zoommtg:// is never auto-launched; Zoom popups stay in-app on the same partition;
 * any other link opens in the default browser only after a confirmation.
 */

const urlUtil = require('./url');
const zSession = require('./session');

const DETACHED_SIZE = Object.freeze({ width: 1280, height: 800 });
const FLOATING_SIZE = Object.freeze({ width: 420, height: 260 });

function createController(deps) {
  const d = deps || {};
  const electron = d.electron || require('electron');
  const { WebContentsView, BrowserWindow, shell, dialog } = electron;
  const log = d.log || require('../utils/logger')('zoom-meet');
  const getMainWindow = d.getMainWindow || (() => null);
  const send = d.send || (() => {});
  const getSession = d.getSession || (() => zSession.getSession({ electron, log }));
  const seedMidway = d.seedMidway || (() => zSession.seedMidway({ electron, log }));

  let view = null;
  let parent = null;           // BrowserWindow currently hosting the view
  let mode = 'main';           // 'main' | 'detached'
  let floating = false;
  let detachedWin = null;
  let visibleInMain = false;
  let lastUrl = '';
  let leaving = false;

  const alive = (w) => !!(w && !(typeof w.isDestroyed === 'function' && w.isDestroyed()));

  function state() {
    return {
      ok: true,
      open: !!view,
      mode,
      floating: mode === 'detached' && floating,
      visible: !!view && (mode === 'detached' || visibleInMain),
      inMeeting: !!view && urlUtil.isInMeetingUrl(lastUrl),
      page: lastUrl ? urlUtil.maskUrl(lastUrl) : null,
      canOpenInZoomApp: !!(lastUrl && urlUtil.toDeepLink(lastUrl)),
    };
  }
  function emit() { try { send('zoomMeet:state', state()); } catch (_) { /* window gone */ } }

  function _removeFromParent() {
    if (view && alive(parent)) { try { parent.contentView.removeChildView(view); } catch (_) {} }
    parent = null;
  }
  function _attachTo(win) {
    if (!view || !alive(win)) return false;
    if (parent === win) return true;
    _removeFromParent();
    win.contentView.addChildView(view);
    parent = win;
    return true;
  }

  async function _confirmExternal(url) {
    try {
      const host = new URL(url).hostname;
      const w = alive(parent) ? parent : getMainWindow();
      const r = await dialog.showMessageBox(w, {
        type: 'question', buttons: ['Cancel', 'Open in browser'], defaultId: 0, cancelId: 0,
        message: 'Open this link in your browser?', detail: host,
      });
      if (r && r.response === 1) await shell.openExternal(url);
    } catch (e) { log.warn('[zoom-meet] external link failed: ' + e.message); }
  }

  function _guardNavigation(wc) {
    const block = (e, url) => {
      if (urlUtil.isAllowedNavUrl(url)) return;
      e.preventDefault();
      if (/^https?:/i.test(url)) _confirmExternal(url);
      else log.info('[zoom-meet] blocked navigation to non-https scheme');
    };
    wc.on('will-navigate', block);
    wc.on('will-redirect', block);
    wc.setWindowOpenHandler(({ url }) => {
      if (urlUtil.isAllowedNavUrl(url) && !/^about:/i.test(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            webPreferences: { partition: zSession.PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
          },
        };
      }
      if (/^https?:/i.test(url)) _confirmExternal(url);
      return { action: 'deny' };
    });
  }

  function _ensureView() {
    if (view) return view;
    getSession();
    view = new WebContentsView({
      webPreferences: { partition: zSession.PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const wc = view.webContents;
    _guardNavigation(wc);
    const onNav = (_e, url) => { lastUrl = url; emit(); };
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onNav);
    wc.on('render-process-gone', (_e, details) => {
      log.warn('[zoom-meet] meeting view crashed: ' + ((details && details.reason) || 'unknown'));
      leave();
    });
    wc.on('before-input-event', (_e, input) => {
      // F11 toggles real full screen on the detached window.
      if (input.type === 'keyDown' && input.key === 'F11' && mode === 'detached' && alive(detachedWin)) {
        detachedWin.setFullScreen(!detachedWin.isFullScreen());
      }
    });
    view.setVisible(false);
    _attachTo(getMainWindow());
    mode = 'main';
    visibleInMain = false;
    return view;
  }

  /** Load a URL (already normalized + validated by the caller) into the meeting view. */
  async function open(url) {
    if (!urlUtil.isAllowedNavUrl(url) || /^about:/i.test(url)) return { ok: false, error: 'URL not allowed' };
    _ensureView();
    await seedMidway();
    lastUrl = url;
    log.info('[zoom-meet] open ' + urlUtil.maskUrl(url));
    view.webContents.loadURL(url).catch((e) => log.warn('[zoom-meet] load failed: ' + e.message));
    emit();
    return state();
  }

  /** Renderer-reported rect (CSS px of the main window). null hides the view in main. */
  function setBounds(rect) {
    if (!view || mode !== 'main') return state();
    const main = getMainWindow();
    if (!alive(main)) return state();
    _attachTo(main);
    if (!rect) { view.setVisible(false); visibleInMain = false; emit(); return state(); }
    let z = 1;
    try { z = main.webContents.getZoomFactor() || 1; } catch (_) {}
    const b = {
      x: Math.max(0, Math.round(rect.x * z)), y: Math.max(0, Math.round(rect.y * z)),
      width: Math.max(1, Math.round(rect.width * z)), height: Math.max(1, Math.round(rect.height * z)),
    };
    view.setBounds(b);
    view.setVisible(true);
    visibleInMain = true;
    emit();
    return state();
  }

  function _fitDetached() {
    if (!view || !alive(detachedWin)) return;
    const [w, h] = detachedWin.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  /** Move the live view into its own window. opts.floating → small always-on-top mini player. */
  function detach(opts) {
    if (!view) return { ok: false, error: 'No meeting open' };
    const wantFloat = !!(opts && opts.floating);
    if (mode === 'detached' && alive(detachedWin)) {
      if (wantFloat !== floating) _restyleDetached(wantFloat);
      return state();
    }
    const size = wantFloat ? FLOATING_SIZE : DETACHED_SIZE;
    detachedWin = new BrowserWindow({
      width: size.width, height: size.height, minWidth: 320, minHeight: 200,
      title: 'Fleet Meeting', backgroundColor: '#0d1117', autoHideMenuBar: true,
      alwaysOnTop: wantFloat, show: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (wantFloat) { try { detachedWin.setAlwaysOnTop(true, 'floating'); } catch (_) {} }
    floating = wantFloat;
    mode = 'detached';
    visibleInMain = false;
    _attachTo(detachedWin);
    view.setVisible(true);
    _fitDetached();
    detachedWin.on('resize', _fitDetached);
    detachedWin.on('enter-full-screen', _fitDetached);
    detachedWin.on('leave-full-screen', _fitDetached);
    detachedWin.on('close', () => {
      // Closing the meeting window re-docks the view; it does not hang up.
      if (!leaving && view) _returnToMain();
    });
    detachedWin.on('closed', () => { detachedWin = null; });
    emit();
    return state();
  }

  function _restyleDetached(wantFloat) {
    const size = wantFloat ? FLOATING_SIZE : DETACHED_SIZE;
    floating = wantFloat;
    try { detachedWin.setAlwaysOnTop(wantFloat, 'floating'); } catch (_) {}
    try { if (detachedWin.isFullScreen()) detachedWin.setFullScreen(false); } catch (_) {}
    detachedWin.setSize(size.width, size.height);
    _fitDetached();
    emit();
  }

  function _returnToMain() {
    mode = 'main';
    floating = false;
    visibleInMain = false;
    const main = getMainWindow();
    if (view) {
      view.setVisible(false);
      if (alive(main)) _attachTo(main); else _removeFromParent();
    }
    emit();   // the renderer re-reports its stage rect on this state
  }

  /** Bring a detached/floating meeting back into the Fleet window. */
  function dock() {
    if (!view) return state();
    if (mode === 'detached') {
      const w = detachedWin;
      _returnToMain();
      detachedWin = null;
      if (alive(w)) { try { w.removeAllListeners('close'); w.close(); } catch (_) {} }
    }
    return state();
  }

  /** End the meeting: close the view's webContents and any meeting window. */
  function leave() {
    if (!view) return state();
    leaving = true;
    const v = view;
    const w = detachedWin;
    _removeFromParent();
    view = null;
    detachedWin = null;
    mode = 'main';
    floating = false;
    visibleInMain = false;
    lastUrl = '';
    try { if (v.webContents && !v.webContents.isDestroyed()) v.webContents.close(); } catch (_) {}
    if (alive(w)) { try { w.close(); } catch (_) {} }
    leaving = false;
    emit();
    return state();
  }

  function currentUrl() { return lastUrl; }

  return { open, setBounds, detach, dock, leave, state, currentUrl };
}

module.exports = { createController, DETACHED_SIZE, FLOATING_SIZE };
