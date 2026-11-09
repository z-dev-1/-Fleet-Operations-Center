// tests/fixtures/zoom/fake-electron.js — scripted Electron fakes for the Zoom hub tests.
//
// createFakeElectron(opts) -> { electron, calls, net, setNet(handler), windows }
//   opts.net(reqInfo) -> script | Promise<script>    reqInfo = {method, url, headers, body, options}
//     script: { status, headers, body (string|Buffer|object), chunks:[...], redirect:url, error:Error, hang:true }
//   opts.urlFor(requestedUrl, win) -> url the window ends up on after loadURL (default: requested URL)
//   opts.onLoad(win, url)          -> hook after each loadURL (emit CDP events here)
//   opts.attachThrows              -> webContents.debugger.attach throws
//   opts.cdp[method](params, dbg)  -> override a CDP sendCommand result
//   opts.throwing                  -> every electron entry point throws (flag-OFF parity)
//
// installFakeElectron(require, electron) seeds require.cache[require.resolve('electron')] and returns restore().
// installFakeLogger(require) replaces src/utils/logger.js with a recording factory -> {lines, restore}.
// freshZoom(require) drops src/zoom/** and src/ipc/zoom-hub.js from require.cache.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

class FakeDebugger extends EventEmitter {
  constructor(opts, wc) {
    super();
    this._opts = opts || {};
    this._wc = wc;
    this.attached = false;
    this.commands = [];
    this.bodies = new Map();
    this.postData = new Map();
  }
  attach(v) {
    if (this._opts.attachThrows) { const e = new Error('Another debugger is already attached ' + (this._opts.attachThrowsMessage || '')); throw e; }
    this.attached = true;
    this.version = v;
  }
  isAttached() { return this.attached; }
  detach() { this.attached = false; }
  async sendCommand(method, params) {
    this.commands.push({ method, params });
    const o = this._opts.cdp && this._opts.cdp[method];
    if (typeof o === 'function') return o(params, this);
    if (method === 'Network.getResponseBody') {
      if (!this.bodies.has(params.requestId)) throw new Error('No resource with given identifier found');
      return this.bodies.get(params.requestId);
    }
    if (method === 'Network.getRequestPostData') {
      if (!this.postData.has(params.requestId)) throw new Error('No post data available');
      return { postData: this.postData.get(params.requestId) };
    }
    return {};
  }
  /** emitRequest({requestId, url, method, headers, postData, hasPostData}) */
  emitRequest(r) {
    this.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: r.requestId,
      request: { url: r.url, method: r.method || 'POST', headers: r.headers || {}, postData: r.postData, hasPostData: r.hasPostData },
    });
  }
  /** emitResponse(requestId, body, {base64, encodedDataLength, status}) */
  emitResponse(requestId, body, o = {}) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    this.bodies.set(requestId, o.base64 ? { body: Buffer.from(text).toString('base64'), base64Encoded: true } : { body: text, base64Encoded: false });
    this.emit('message', {}, 'Network.responseReceived', { requestId, response: { status: o.status || 200 } });
    this.emit('message', {}, 'Network.loadingFinished', { requestId, encodedDataLength: o.encodedDataLength });
  }
}

class FakeWebContents extends EventEmitter {
  constructor(win, opts, calls) {
    super();
    this._win = win;
    this._opts = opts;
    this._calls = calls;
    this._url = '';
    this.audioMuted = false;
    this.windowOpenHandler = null;
    this.debugger = new FakeDebugger(opts, this);
    this.executeJavaScriptCalls = 0;
    this.insertTextCalls = 0;
    this.sendInputEventCalls = 0;
    this.id = ++calls._wcSeq;
    this.mainFrame = { processId: 10 + this.id, routingId: 1, url: '' };
  }
  getURL() { return this._url; }
  _setURL(u) { this._url = u; this.mainFrame.url = u; }
  setAudioMuted(v) { this.audioMuted = !!v; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  executeJavaScript() { this.executeJavaScriptCalls++; this._calls.executeJavaScript++; return Promise.resolve(null); }
  insertText() { this.insertTextCalls++; this._calls.insertText++; }
  sendInputEvent() { this.sendInputEventCalls++; this._calls.sendInputEvent++; }
  /** navigateAttempt(op, url) -> true when the guard called preventDefault. */
  navigateAttempt(op, url, extra = {}) {
    let prevented = false;
    const ev = Object.assign({ url, isMainFrame: true, preventDefault() { prevented = true; } }, extra);
    this.emit(op, ev, url);
    return prevented;
  }
}

export function createFakeElectron(opts = {}) {
  const calls = {
    fromPartition: [], windows: [], net: [], openExternal: [], openPath: [], dialogs: [],
    executeJavaScript: 0, insertText: 0, sendInputEvent: 0, appOnce: [], _wcSeq: 0, throwsHit: [],
  };
  let netHandler = opts.net || (() => ({ status: 200, body: { status: true, result: {} } }));
  const sessions = new Map();

  const thrower = (name) => () => { calls.throwsHit.push(name); throw new Error('electron.' + name + ' must not be called (flag OFF)'); };

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      if (opts.throwing) thrower('BrowserWindow')();
      this.options = options || {};
      this.destroyed = false;
      this.visible = !!(options && options.show);
      this.focused = 0;
      this.webContents = new FakeWebContents(this, opts, calls);
      calls.windows.push(this);
    }
    loadURL(url) {
      if (this.destroyed) return Promise.reject(Object.assign(new Error('destroyed'), { code: 'ERR_FAILED' }));
      const to = opts.urlFor ? opts.urlFor(url, this) : url;
      this.webContents._setURL(to);
      try { if (opts.onLoad) opts.onLoad(this, url); } catch (_) {}
      if (opts.loadReject) return Promise.reject(opts.loadReject(url));
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    close() { this.destroy(); }
    hide() { this.visible = false; }
    show() { this.visible = true; this.emit('show'); }
    focus() { this.focused++; }
    setMenuBarVisibility(v) { this.menuBarVisible = v; }
  }

  function fromPartition(p) {
    if (opts.throwing) thrower('session.fromPartition')();
    calls.fromPartition.push(p);
    if (!sessions.has(p)) {
      sessions.set(p, {
        partition: p,
        permissionRequestHandler: null,
        permissionCheckHandler: null,
        setPermissionRequestHandler(fn) { this.permissionRequestHandler = fn; },
        setPermissionCheckHandler(fn) { this.permissionCheckHandler = fn; },
        cookies: { set: async () => {}, get: async () => [], flushStore: async () => {} },
      });
    }
    return sessions.get(p);
  }

  const defaultSession = {
    partition: '',
    setPermissionRequestHandler() { calls.throwsHit.push('defaultSession.setPermissionRequestHandler'); },
    setPermissionCheckHandler() { calls.throwsHit.push('defaultSession.setPermissionCheckHandler'); },
    cookies: { set: async () => {}, get: async () => [] },
  };

  function request(options) {
    if (opts.throwing) thrower('net.request')();
    const req = new EventEmitter();
    const info = { method: options.method, url: options.url, headers: {}, body: null, options, aborted: false };
    calls.net.push(info);
    req.setHeader = (k, v) => { info.headers[k] = v; };
    req.write = (b) => { info.body = (info.body || '') + (Buffer.isBuffer(b) ? b.toString('utf8') : String(b)); };
    req.abort = () => { if (info.aborted) return; info.aborted = true; req.emit('abort'); };
    req.followRedirect = () => { info.followed = (info.followed || 0) + 1; };
    req.end = () => {
      Promise.resolve().then(() => netHandler(info)).then((script) => {
        const s = script || {};
        if (s.hang || info.aborted) return;
        if (s.error) { req.emit('error', s.error); return; }
        if (s.redirect) { req.emit('redirect', s.status || 302, info.method, s.redirect, {}); return; }
        const res = new EventEmitter();
        res.statusCode = s.status == null ? 200 : s.status;
        res.headers = s.headers || {};
        req.emit('response', res);
        const chunks = s.chunks || [s.body === undefined ? '' : (typeof s.body === 'string' || Buffer.isBuffer(s.body) ? s.body : JSON.stringify(s.body))];
        for (const c of chunks) {
          if (info.aborted) return;
          res.emit('data', Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
        }
        if (s.responseError) { res.emit('error', s.responseError); return; }
        if (!info.aborted) res.emit('end');
      }).catch((e) => { req.emit('error', e); });
    };
    return req;
  }

  const spy = (name, list, ret) => (...a) => { if (opts.throwing) thrower(name)(); list.push(a); return typeof ret === 'function' ? ret(...a) : ret; };

  const electron = {
    session: { fromPartition, defaultSession },
    BrowserWindow: FakeBrowserWindow,
    net: { request },
    shell: {
      openExternal: spy('shell.openExternal', calls.openExternal, () => (opts.openExternalReject ? Promise.reject(opts.openExternalReject) : Promise.resolve())),
      openPath: spy('shell.openPath', calls.openPath, () => Promise.resolve('')),
    },
    dialog: {
      showOpenDialog: spy('dialog.showOpenDialog', calls.dialogs, () => Promise.resolve({ canceled: true, filePaths: [] })),
      showMessageBox: spy('dialog.showMessageBox', calls.dialogs, () => Promise.resolve({ response: 1 })),
    },
    nativeImage: { createFromPath: spy('nativeImage.createFromPath', [], () => ({ isEmpty: () => true })) },
    systemPreferences: { getMediaAccessStatus: spy('systemPreferences.getMediaAccessStatus', [], 'granted') },
    app: {
      once: (ev, fn) => { calls.appOnce.push([ev, fn]); },
      on: (ev, fn) => { calls.appOnce.push([ev, fn]); },
      getPath: () => ROOT,
    },
    ipcMain: { handle: thrower('ipcMain.handle') },
  };
  return {
    electron,
    calls,
    setNet(fn) { netHandler = fn; },
    get windows() { return calls.windows; },
    sessions,
  };
}

export function installFakeElectron(req, electron) {
  const id = req.resolve('electron');
  const prev = req.cache[id];
  req.cache[id] = { id, filename: id, loaded: true, exports: electron };
  return () => { if (prev) req.cache[id] = prev; else delete req.cache[id]; };
}

/** installFakeLogger(require) -> {lines:[{ns, level, args}], text(), restore()} */
export function installFakeLogger(req) {
  const id = req.resolve(path.join(ROOT, 'src', 'utils', 'logger.js'));
  const prev = req.cache[id];
  const lines = [];
  const factory = (ns) => {
    const mk = (level) => (...args) => { lines.push({ ns, level, args }); };
    return { debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error'), log: mk('info') };
  };
  factory.createLogger = factory;
  factory.setLogDir = () => {}; factory.setLevel = () => {}; factory.setSilent = () => {}; factory.LEVELS = {};
  req.cache[id] = { id, filename: id, loaded: true, exports: factory };
  return {
    lines,
    text() {
      return JSON.stringify(lines, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v));
    },
    clear() { lines.length = 0; },
    restore() { if (prev) req.cache[id] = prev; else delete req.cache[id]; },
  };
}

export function freshZoom(req) {
  for (const k of Object.keys(req.cache)) {
    const n = k.replace(/\\/g, '/');
    if (n.includes('/src/zoom/') || n.endsWith('/src/ipc/zoom-hub.js')) delete req.cache[k];
  }
}

export const WT_ROOT = ROOT;
export const srcPath = (...p) => path.join(ROOT, 'src', ...p);

/** fakeSender(win, overrides) -> an IPC event whose senderFrame is win's main frame on the app page. */
export function fakeAppEvent(win, overrides = {}) {
  const wc = win.webContents;
  const frame = Object.assign({ processId: wc.mainFrame.processId, routingId: wc.mainFrame.routingId, url: 'file:///C:/app/renderer/src/index.html' }, overrides.frame || {});
  return Object.assign({ sender: wc, senderFrame: frame }, overrides.event || {});
}

/**
 * settle(vi, promise, {step, max}) — advance fake timers until the promise settles.
 */
export async function settle(vi, p, o = {}) {
  const step = o.step || 250;
  const max = o.max || 700000;
  let done = false; let val; let err;
  p.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
  let t = 0;
  await flush();
  while (!done && t < max) { await vi.advanceTimersByTimeAsync(step); t += step; }
  if (!done) throw new Error('promise did not settle within ' + max + ' ms of fake time');
  if (err) throw err;
  return val;
}

/** jwt(expSecondsFromNow) — an unsigned JWT-shaped bearer with an exp claim. */
export function jwt(expIn, extra = 'SENTINEL_TOKEN') {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'Bearer ' + b({ alg: 'none' }) + '.' + b({ exp: Math.floor(Date.now() / 1000) + expIn, sub: extra }) + '.sig';
}

/**
 * portalScript({pages, signedIn}) -> {urlFor, onLoad} options for createFakeElectron.
 *   pages: { [pageUrlPrefix]: [{ path, body, headers, postData, hasPostData, postDataViaCdp }] }
 *   signedIn: boolean | () => boolean  (false -> every portal load ends on a Midway login URL)
 */
export function portalScript(cfg) {
  let seq = 0;
  const isIn = () => (typeof cfg.signedIn === 'function' ? cfg.signedIn() : cfg.signedIn !== false);
  return {
    urlFor(url) {
      if (url === 'about:blank') return url;
      if (!isIn() && /^https:\/\/amazon\.zoom\.us\//.test(url)) return 'https://midway-auth.amazon.com/login?next=x';
      return url;
    },
    onLoad(win, url) {
      if (url === 'about:blank' || !isIn()) return;
      const entries = (cfg.pages || {})[url] || [];
      const dbg = win.webContents.debugger;
      for (const e of entries) {
        const requestId = 'req-' + (++seq);
        if (e.postDataViaCdp !== undefined) dbg.postData.set(requestId, e.postDataViaCdp);
        dbg.emitRequest({
          requestId,
          url: 'https://amazon.zoom.us' + e.path,
          method: e.method || 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json;charset=UTF-8' }, e.headers || {}),
          postData: e.postData,
          hasPostData: e.hasPostData,
        });
        if (e.body !== undefined) dbg.emitResponse(requestId, e.body, e.responseOpts || {});
      }
    },
  };
}

/** fakeMainWindow() -> a minimal main window for ctx.mainWindow (no electron needed). */
export function fakeMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: { id: 1, mainFrame: { processId: 4, routingId: 1, url: 'file:///C:/app/renderer/src/index.html' } },
  };
}
