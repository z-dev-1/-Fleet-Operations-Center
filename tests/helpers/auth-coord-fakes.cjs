'use strict';
// tests/helpers/auth-coord-fakes.cjs — Phase 9 shared test harness for code
// that loads src/scrapers/auth.js. Call installAuthCoordHarness({ vi }) at
// MODULE TOP LEVEL of the test file, BEFORE the file's first
// require('../src/scrapers/auth').
//
// REQUIRED FIX 8: this file is CommonJS and uses ITS OWN `require` (relative to
// tests/helpers/) for every require.resolve / require.cache entry and every
// spy target. It takes no `require` parameter. The Node CJS module cache is
// process-wide, so the test file's later require('../src/scrapers/auth') (via
// its own createRequire(import.meta.url)) hits the same cache entries.
//
// What it isolates (no real network / Midway / mwinit / VPN / AAP / Electron /
// child processes / credential files / settings.json):
//   1. asserts auth.js is not loaded yet (else the spawn guard is bypassed)
//   2. data dir → fresh tmp dir (store/settings reads see an empty dir)
//   3. os.homedir → tmp/home with a SYNTHETIC ~/.midway/cookie (fake values)
//   4. os.tmpdir → tmp/tmp (runMwinit writes its .bat there)
//   5. fs.readFileSync: ACME posture-token path → synthetic JWT; the real
//      ~/.midway/cookie → throws; everything else passes through
//   6. child_process.spawn → throws unless the test installs a recorder
//   7. fake `electron` (in-memory defaultSession cookie store, a distinct vendor
//      session, counting BrowserWindow with test-controlled navigation, net)
//   8. fake src/orcha/offline (controllable isOffline, capturable onChange)
//   9. logger.createLogger → in-memory recorder (logs[]), nothing printed
//
// RULES for files using it: never vi.restoreAllMocks(), never
// spawnSpy.mockRestore(), never a second vi.spyOn(cp, 'spawn') — each would
// detach the reference auth.js captured at load (`const { spawn } = ...`).
// Change behavior only via spawnSpy.mockImplementation(...), reset counts via
// spawnSpy.mockClear().

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');

const ACME_POSTURE_TOKEN = 'C:\\ProgramData\\Amazon\\ACME\\PostureToken\\posture_token.jwt';

function _b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function installAuthCoordHarness({ vi }) {
  // 1) clean-cache assertion
  const authPath = require.resolve('../../src/scrapers/auth');
  if (require.cache[authPath]) throw new Error('auth.js loaded before the harness — spawn guard would be bypassed');

  // 2) isolated data dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-coord-'));
  require('../../src/config/paths').setDataDir(tmpDir);

  // 3) homedir + synthetic cookie fixture
  const realHome = os.homedir();
  const home = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(home, '.midway'), { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const cookieFixturePath = path.join(home, '.midway', 'cookie');
  const exp = Math.floor(Date.now() / 1000) + 20 * 3600;
  const aeaExp = Math.floor(Date.now() / 1000) + 2 * 3600;
  fs.writeFileSync(cookieFixturePath, [
    '# Netscape HTTP Cookie File',
    '#HttpOnly_midway-auth.amazon.com\tFALSE\t/\tTRUE\t' + exp + '\tsession\tFAKE-SESSION-VALUE',
    'midway-auth.amazon.com\tFALSE\t/\tTRUE\t' + exp + '\tuser_name\tfake-user',
    '#HttpOnly_.auth.midway.aws.dev\tTRUE\t/\tTRUE\t' + aeaExp + '\tamazon_enterprise_access\tFAKE-AEA-VALUE',
    '',
  ].join('\n'));

  // 4) tmpdir
  const tmpTmp = path.join(tmpDir, 'tmp');
  fs.mkdirSync(tmpTmp, { recursive: true });
  vi.spyOn(os, 'tmpdir').mockReturnValue(tmpTmp);

  // 5) readFileSync guard
  const realCookie = path.join(realHome, '.midway', 'cookie');
  const origRead = fs.readFileSync;
  const posture = {
    token: () => [_b64url({ alg: 'RS256' }), _b64url({ exp: Math.floor(Date.now() / 1000) + 15 * 60 }), 'FAKE-SIGNATURE'].join('.'),
  };
  vi.spyOn(fs, 'readFileSync').mockImplementation(function (p, ...rest) {
    if (p === ACME_POSTURE_TOKEN) return posture.token();
    if (typeof p === 'string' && path.resolve(p).toLowerCase() === path.resolve(realCookie).toLowerCase()) {
      throw new Error('real ~/.midway/cookie read blocked in tests');
    }
    return origRead.call(fs, p, ...rest);
  });

  // 6) spawn guard (installed while the cache is clean)
  const spawnSpy = vi.spyOn(cp, 'spawn').mockImplementation(() => { throw new Error('spawn blocked in tests'); });
  function spawnRecorder() {
    const c = new EventEmitter();
    c.pid = 4242;
    c.unref = () => {};
    c.kill = () => {};
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    return c;
  }

  // 7) fake electron
  function makeSession(label) {
    const store = new Map();
    const s = {
      label,
      sets: 0,
      setLog: [],
      cookies: {
        get: async (filter) => {
          const all = [...store.values()];
          return (filter && filter.name) ? all.filter((c) => c.name === filter.name) : all;
        },
        set: async (c) => {
          s.sets++;
          s.setLog.push({ name: c.name, domain: c.domain || null });
          store.set(c.name + '|' + (c.domain || c.url), Object.assign({}, c));
        },
        flushStore: async () => {},
      },
      _store: store,
      _clear: () => { store.clear(); s.sets = 0; s.setLog.length = 0; },
    };
    return s;
  }
  const defaultSession = makeSession('default');
  const fakeVendorSession = makeSession('vendor');
  const bw = { constructed: 0, alive: 0, maxAlive: 0, windows: [], throwNext: false };
  class BrowserWindow {
    constructor(opts) {
      if (bw.throwNext) { bw.throwNext = false; throw new Error('BrowserWindow constructor failed (test)'); }
      this.opts = opts;
      this._destroyed = false;
      this._url = '';
      this._h = {};
      const self = this;
      this.webContents = {
        on: (ev, cb) => { (self._h[ev] = self._h[ev] || []).push(cb); },
        getURL: () => self._url,
      };
      bw.constructed++; bw.alive++; bw.maxAlive = Math.max(bw.maxAlive, bw.alive);
      bw.windows.push(this);
    }
    loadURL(url) { this.loadedUrl = url; return Promise.resolve(); }
    isDestroyed() { return this._destroyed; }
    destroy() { if (!this._destroyed) { this._destroyed = true; bw.alive--; } }
    _emit(ev, ...args) { for (const cb of (this._h[ev] || [])) cb(...args); }
    nav(url) { this._url = url; this._emit('did-navigate', {}, url); this._emit('did-finish-load'); }
  }
  const electron = {
    session: { defaultSession },
    BrowserWindow,
    net: { isOnline: () => true },
    app: { getPath: () => tmpDir, isPackaged: false },
    fakeVendorSession,
    bw,
    aliveWindows: () => bw.windows.filter((w) => !w._destroyed),
    navAll: (url) => { for (const w of bw.windows.filter((x) => !x._destroyed)) w.nav(url); },
    resetCounters: () => { bw.constructed = 0; bw.alive = 0; bw.maxAlive = 0; bw.windows.length = 0; bw.throwNext = false; defaultSession._clear(); fakeVendorSession._clear(); },
  };
  const ePath = require.resolve('electron');
  require.cache[ePath] = { id: ePath, filename: ePath, loaded: true, exports: electron };

  // 8) fake offline module
  const subs = new Set();
  const offline = {
    _offline: false,
    isOffline: () => offline._offline,
    onChange: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    emit: (status) => { for (const cb of [...subs]) cb(status); },
    subscriberCount: () => subs.size,
  };
  const oPath = require.resolve('../../src/orcha/offline');
  require.cache[oPath] = { id: oPath, filename: oPath, loaded: true, exports: offline };

  // 9) in-memory logger (keeps test output quiet and lets tests assert lines)
  const logs = [];
  const loggerMod = require('../../src/utils/logger');
  const mk = (ns) => {
    const rec = (level) => (...a) => { logs.push({ ns, level, msg: a.map((x) => (typeof x === 'string' ? x : String(x))).join(' ') }); };
    return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), log: rec('info') };
  };
  vi.spyOn(loggerMod, 'createLogger').mockImplementation(mk);

  // keep-alive fake auth (copy of tests/aea-keepalive-service.test.js fakeAuth + guards)
  function fakeKeepaliveAuth(init) {
    const s = Object.assign({ liveAea: null, tokenMin: 15, injectOk: true, injects: 0 }, init);
    return {
      _s: s,
      aeaSessionExpiryMin: async () => s.liveAea,
      postureTokenExpiryMin: () => s.tokenMin,
      injectAeaFromPostureToken: async () => {
        s.injects++;
        if (!s.injectOk) return { ok: false, reason: 'inject-failed', aeaMin: s.liveAea };
        s.liveAea = s.tokenMin;
        return { ok: true, aeaMin: s.tokenMin, tokenExp: Math.floor(Date.now() / 1000) + s.tokenMin * 60, domains: 4 };
      },
      refreshAeaSilently: vi.fn(() => { throw new Error('refreshAeaSilently must not be called'); }),
      injectCookies: vi.fn(() => { throw new Error('injectCookies must not be called'); }),
      ACME_POSTURE_TOKEN: null,
    };
  }

  return {
    tmpDir, cookieFixturePath, spawnSpy, spawnRecorder, electron, offline, logs,
    fakeKeepaliveAuth, realHome, posture, ACME_POSTURE_TOKEN,
  };
}

module.exports = { installAuthCoordHarness };
