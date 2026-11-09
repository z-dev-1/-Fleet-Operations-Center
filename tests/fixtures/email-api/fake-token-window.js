// tests/fixtures/email-api/fake-token-window.js — fake BrowserWindow + webContents.debugger for the token source.
// createTokenWorld({ steps }) -> { electron, windows, created(), closed(), other }
//   steps: array (or (windowIndex) => array) of { at: ms after loadURL, nav?: url, load?: url, cdp?: { url, headers } }
//     nav  -> did-navigate (sets the current URL); load -> did-finish-load (sets the current URL first)
//     cdp  -> debugger 'message' Network.requestWillBeSent with { request: { url, headers } }
// Every step runs on setTimeout, so vi.useFakeTimers() drives the script. Windows record their options,
// debugger attach / detach, executed scripts, and close / destroy. `other` is a pre-existing window the token
// source must never touch.
import { EventEmitter } from 'events';

export function jwt(expSec, tag) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'Bearer ' + b({ alg: 'none' }) + '.' + b({ exp: expSec, tag: tag || 'x' }) + '.sig' + (tag || '');
}

export function createTokenWorld(o) {
  const opt = o || {};
  const windows = [];
  const touched = { other: 0 };
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.index = windows.length;
      this.destroyed = false; this.closedFlag = false;
      this.url = '';
      this.scripts = [];
      const self = this;
      const dbg = new EventEmitter();
      dbg.attached = false; dbg.attachCount = 0; dbg.detachCount = 0; dbg.commands = [];
      dbg.attach = () => { if (opt.cdpFail) throw new Error('cdp'); dbg.attached = true; dbg.attachCount++; };
      dbg.detach = () => { dbg.attached = false; dbg.detachCount++; };
      dbg.isAttached = () => dbg.attached;
      dbg.sendCommand = (c) => { dbg.commands.push(c); return Promise.resolve({}); };
      const wc = new EventEmitter();
      wc.debugger = dbg;
      wc.getURL = () => self.url;
      wc.setWindowOpenHandler = (fn) => { self.openHandler = fn; };
      wc.executeJavaScript = (s) => { self.scripts.push(s); return Promise.resolve('none'); };
      this.webContents = wc;
      windows.push(this);
    }
    loadURL(url) {
      this.loadedUrl = url;
      const steps = typeof opt.steps === 'function' ? opt.steps(this.index) : (opt.steps || []);
      for (const s of steps) {
        setTimeout(() => {
          if (this.destroyed) return;
          if (s.nav) { this.url = s.nav; this.webContents.emit('did-navigate', {}, s.nav); }
          if (s.redirect) { this.url = s.redirect; this.webContents.emit('did-redirect-navigation', {}, s.redirect); }
          if (s.load) { this.url = s.load; this.webContents.emit('did-finish-load', {}); }
          if (s.cdp) this.webContents.debugger.emit('message', {}, 'Network.requestWillBeSent', { request: { url: s.cdp.url, headers: s.cdp.headers } });
        }, s.at || 0);
      }
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    hide() {}
    close() { if (this.destroyed) return; this.closedFlag = true; this.destroyed = true; this.emit('closed'); }
    destroy() { this.destroyed = true; }
  }
  const other = { isDestroyed: () => false, close: () => { touched.other++; }, loadURL: () => { touched.other++; }, webContents: { getURL: () => 'https://outlook.office.com/mail/' } };
  const BrowserWindow = function (options) { return new FakeWindow(options); };
  BrowserWindow.getAllWindows = () => { touched.other++; return [other]; };
  const electron = { BrowserWindow, session: { defaultSession: { id: 'default' } } };
  return {
    electron, windows, other, touched,
    created: () => windows.length,
    closed: () => windows.filter((w) => w.destroyed).length,
  };
}

export const OWA_RE = {
  MAILBOX_RE: /(outlook\.office365\.com|outlook\.office\.com|outlook\.cloud\.microsoft)\/mail/i,
  OUTLOOK_HOST_RE: /(outlook\.office365\.com|outlook\.office\.com|outlook\.cloud\.microsoft)/i,
  AUTH_HOST_RE: /(login\.microsoftonline\.com|login\.live\.com|login\.windows\.net|msft\.sts|adfs|\/common\/oauth2|\/consent|multifactor|\bmfa\b)/i,
};

/** A mailbox page that issues one request of the given rank with a JWT expiring `expSec` from epoch seconds. */
export function mailboxSteps(o) {
  const x = o || {};
  const rankPath = { 3: '/api/v2.0/me/messages', 2: '/api/beta/me/x', 1: '/owa/startupdata.ashx' }[x.rank || 2];
  const steps = [{ at: 10, nav: 'https://outlook.cloud.microsoft/mail/' }, { at: 20, load: 'https://outlook.cloud.microsoft/mail/inbox' }];
  if (x.token !== null) steps.push({ at: x.cdpAt || 30, cdp: { url: 'https://outlook.cloud.microsoft' + rankPath, headers: { Authorization: x.token || jwt(x.expSec), 'X-AnchorMailbox': 'SENTINEL-ANCHOR' } } });
  return steps;
}
