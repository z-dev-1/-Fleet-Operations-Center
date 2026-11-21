// tests/fixtures/dtna/fake-electron.js — scripted Electron fakes for the DTNA session / capture tests.
//
// createFakeElectron(opts) -> { electron, calls, windows, sessions }
//   opts.urlFor(requestedUrl, win) -> url the window ends up on after loadURL (default: requested URL)
//   opts.onLoad(win, url)          -> hook after each loadURL (emit CDP events here, e.g. emitAuraSuccess)
//   opts.attachThrows              -> webContents.debugger.attach throws
//   opts.fetch(url, init)          -> scripted session.fetch (default: 200 with an empty body)
// calls.events: ordered ['attach:<wcId>', 'loadURL:<wcId>', ...] to assert capture-before-load.
// Every webContents records the event names it was given listeners for (wc.listenerNames).
//
// fakeWebContents() -> a bare webContents with a FakeDebugger (capture tests without windows).
// auraPostData({context, token, pageURI, message}) -> form-encoded aura POST body.
// emitAuraSuccess(wc, {postData, body, viaCdp}) -> emits requestWillBeSent + loadingFinished on wc.debugger.
// freshDtna(require) drops src/dtna/** from require.cache.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const WT_ROOT = ROOT;
export const AURA_URL = 'https://dtna.my.site.com/Servicetracker/s/sfsites/aura';

export const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

export class FakeDebugger extends EventEmitter {
  constructor(opts, wc, calls) {
    super();
    this._opts = opts || {};
    this._wc = wc;
    this._calls = calls;
    this.attached = false;
    this.commands = [];
    this.bodies = new Map();
    this.postData = new Map();
  }
  attach(v) {
    if (this._opts.attachThrows) throw new Error('Another debugger is already attached');
    this.attached = true;
    this.version = v;
    if (this._calls) this._calls.events.push('attach:' + this._wc.id);
  }
  isAttached() { return this.attached; }
  detach() { this.attached = false; if (this._calls) this._calls.events.push('detach:' + this._wc.id); }
  async sendCommand(method, params) {
    this.commands.push({ method, params });
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
  emitRequest(r) {
    this.emit('message', {}, 'Network.requestWillBeSent', {
      requestId: r.requestId,
      request: { url: r.url, method: r.method || 'POST', headers: r.headers || {}, postData: r.postData, hasPostData: r.hasPostData },
    });
  }
  emitResponse(requestId, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    this.bodies.set(requestId, { body: text, base64Encoded: false });
    this.emit('message', {}, 'Network.responseReceived', { requestId, response: { status: 200 } });
    this.emit('message', {}, 'Network.loadingFinished', { requestId });
  }
}

let _wcSeq = 0;

class FakeWebContents extends EventEmitter {
  constructor(opts, calls) {
    super();
    this.id = ++_wcSeq;
    this._url = '';
    this.listenerNames = [];
    this.windowOpenHandler = null;
    this.debugger = new FakeDebugger(opts, this, calls);
  }
  on(name, fn) { this.listenerNames.push(String(name)); return super.on(name, fn); }
  once(name, fn) { this.listenerNames.push(String(name)); return super.once(name, fn); }
  addListener(name, fn) { this.listenerNames.push(String(name)); return super.addListener(name, fn); }
  getURL() { return this._url; }
  _setURL(u) { this._url = u; }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  executeJavaScript() { return Promise.resolve(null); }
}

export function fakeWebContents(opts = {}) {
  return new FakeWebContents(opts, { events: [] });
}

export function createFakeElectron(opts = {}) {
  const calls = { fromPartition: [], windows: [], events: [], fetch: [], appOnce: [] };
  const sessions = new Map();

  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options || {};
      this.destroyed = false;
      this.focused = 0;
      this.webContents = new FakeWebContents(opts, calls);
      this.loads = [];
      calls.windows.push(this);
    }
    loadURL(url) {
      if (this.destroyed) return Promise.reject(Object.assign(new Error('destroyed'), { code: 'ERR_FAILED' }));
      calls.events.push('loadURL:' + this.webContents.id);
      this.loads.push(url);
      const to = opts.urlFor ? opts.urlFor(url, this) : url;
      this.webContents._setURL(to);
      try { if (opts.onLoad) opts.onLoad(this, url); } catch (_) {}
      return Promise.resolve();
    }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
    close() { this.destroy(); }
    focus() { this.focused++; }
    setMenuBarVisibility() {}
  }

  function fromPartition(p) {
    calls.fromPartition.push(p);
    if (!sessions.has(p)) {
      sessions.set(p, {
        partition: p,
        permissionHandlersSet: 0,
        setPermissionRequestHandler() { this.permissionHandlersSet++; },
        setPermissionCheckHandler() { this.permissionHandlersSet++; },
        fetch: async (url, init) => {
          calls.fetch.push({ url, init });
          if (opts.fetch) return opts.fetch(url, init);
          return { status: 200, type: 'basic', headers: { get: () => null }, text: async () => '' };
        },
      });
    }
    return sessions.get(p);
  }

  const electron = {
    session: { fromPartition },
    BrowserWindow: FakeBrowserWindow,
    app: {
      once: (ev, fn) => { calls.appOnce.push([ev, fn]); },
      on: (ev, fn) => { calls.appOnce.push([ev, fn]); },
    },
  };
  return { electron, calls, get windows() { return calls.windows; }, sessions };
}

export function auraPostData({ context = 'CTX', token = 'TOKEN', pageURI = '/Servicetracker/s/case/Case/Default', message } = {}) {
  const p = new URLSearchParams();
  p.set('message', typeof message === 'string' ? message : JSON.stringify(message || { actions: [] }));
  p.set('aura.context', context);
  p.set('aura.pageURI', pageURI);
  p.set('aura.token', token);
  return p.toString();
}

let _reqSeq = 0;
/** emitAuraSuccess(wc, {postData, body, viaCdp, url}) — the page's own aura POST and its response. */
export function emitAuraSuccess(wc, o = {}) {
  const requestId = 'r' + (++_reqSeq);
  const dbg = wc.debugger;
  const postData = o.postData || auraPostData(o);
  if (o.viaCdp) dbg.postData.set(requestId, postData);
  dbg.emitRequest({
    requestId,
    url: o.url || (AURA_URL + '?r=1&other.Controller.method=1'),
    method: o.method || 'POST',
    postData: o.viaCdp ? undefined : postData,
    hasPostData: o.viaCdp ? true : undefined,
  });
  dbg.emitResponse(requestId, o.body !== undefined ? o.body : { actions: [{ id: '1;a', state: 'SUCCESS', returnValue: {} }] });
  return requestId;
}

export function freshDtna(req) {
  for (const k of Object.keys(req.cache)) {
    const n = k.replace(/\\/g, '/');
    if (n.includes('/src/dtna/')) delete req.cache[k];
  }
}
