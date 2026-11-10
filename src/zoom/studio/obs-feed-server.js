'use strict';
/**
 * src/zoom/studio/obs-feed-server.js — loopback feed relay for the OBS browser source (design §4.4).
 *
 *   createFeedServer({http, WebSocketServer, crypto, now})
 *     -> {start, stop, viewUrl, feedUrl, onProducer, lastFrameAt (getter)}
 *
 *   start()        -> Promise<{port, token}>  listen(0, '127.0.0.1'); idempotent while running; a fresh
 *                     32-byte hex token on every fresh start. Listen error -> ZoomError OBS_FEED_FAILED.
 *   stop()         -> Promise<void>  closes every socket and the server.
 *   viewUrl()      -> 'http://127.0.0.1:<port>/obs/<token>/' | null   (the OBS browser source URL)
 *   feedUrl()      -> 'ws://127.0.0.1:<port>/feed/<token>'   | null   (the renderer producer URL)
 *   onProducer(cb) -> unsubscribe(); cb(connected:boolean) on producer connect / disconnect.
 *   lastFrameAt    -> ms timestamp of the last binary producer frame (0 when none since start).
 *
 * Routes (one check(req) for HTTP and upgrade: Host != 127.0.0.1:<port> -> 403, bad path/token -> 404):
 *   GET /obs/<token>/      inline viewer page (nonce CSP)
 *   ws  /feed/<token>      single producer (a newer one replaces the old); binary frames only
 *   ws  /obs/<token>/view  at most 4 viewers; anything a viewer sends is ignored
 * Each producer frame goes to every viewer with bufferedAmount < 1 MB; nothing is queued.
 *
 * The token and URLs never appear in a log line; logs carry codes only.
 */
const { ZoomError } = require('../errors');

const HOST = '127.0.0.1';
const MAX_PAYLOAD = 2 * 1024 * 1024;
const MAX_VIEWERS = 4;
const VIEWER_BUFFER_LIMIT = 1024 * 1024;
const OPEN = 1;
const REASONS = { 403: 'Forbidden', 404: 'Not Found', 429: 'Too Many Requests' };

/** containRect(sw, sh, dw, dh) -> {x, y, w, h}: fit a sw x sh source inside dw x dh, centred (plan D5). */
function containRect(sw, sh, dw, dh) {
  if (!(sw > 0 && sh > 0 && dw > 0 && dh > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  var s = Math.min(dw / sw, dh / sh);
  var w = sw * s;
  var h = sh * s;
  return { x: (dw - w) / 2, y: (dh - h) / 2, w: w, h: h };
}

/**
 * VIEWER_JS — the viewer page script (plan D6). It uses only the globals WebSocket, createImageBitmap,
 * document, location, setTimeout, setInterval and Date, so tests evaluate it with new Function(...).
 * F1: on socket close, or when no frame has arrived for 1000 ms, the canvas is filled black with the
 * centred text "Fleet camera feed stopped" (white, 32px sans-serif).
 */
const VIEWER_JS = [
  "'use strict';",
  'var W = 1280, H = 720, STALL_MS = 1000, RETRY_MS = 1000, CHECK_MS = 250;',
  'var STOPPED_TEXT = "Fleet camera feed stopped";',
  "var canvas = document.getElementById('c');",
  "var g = canvas.getContext('2d');",
  "var url = 'ws://' + location.host + location.pathname.replace(/\\/?$/, '/') + 'view';",
  'var sock = null, lastFrame = 0, blank = false, decoding = false;',
  'var containRect = ' + containRect.toString() + ';',
  'function card() {',
  "  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);",
  "  g.fillStyle = '#fff'; g.font = '32px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';",
  '  g.fillText(STOPPED_TEXT, W / 2, H / 2);',
  '  blank = true;',
  '}',
  'function draw(blob) {',
  '  if (decoding) return;',
  '  decoding = true;',
  '  createImageBitmap(blob).then(function (bmp) {',
  '    decoding = false;',
  '    var r = containRect(bmp.width, bmp.height, W, H);',
  "    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);",
  '    g.drawImage(bmp, r.x, r.y, r.w, r.h);',
  '    bmp.close();',
  '    blank = false;',
  '  }, function () { decoding = false; });',
  '}',
  'function connect() {',
  '  var s;',
  '  try { s = new WebSocket(url); } catch (e) { card(); setTimeout(connect, RETRY_MS); return; }',
  '  sock = s;',
  "  s.binaryType = 'blob';",
  '  s.onmessage = function (ev) {',
  "    if (typeof ev.data === 'string') return;",
  '    lastFrame = Date.now();',
  '    draw(ev.data);',
  '  };',
  '  s.onerror = function () {};',
  '  s.onclose = function () {',
  '    if (sock === s) sock = null;',
  '    card();',
  '    setTimeout(connect, RETRY_MS);',
  '  };',
  '}',
  'card();',
  'connect();',
  'setInterval(function () { if (!blank && Date.now() - lastFrame >= STALL_MS) card(); }, CHECK_MS);',
].join('\n');

function _page(nonce) {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Fleet Camera Feed</title>'
    + '<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}'
    + 'canvas{display:block;width:100%;height:100%;object-fit:contain}</style></head>'
    + '<body><canvas id="c" width="1280" height="720"></canvas>'
    + '<script nonce="' + nonce + '">\n' + VIEWER_JS + '\n</script></body></html>';
}

function createFeedServer(deps = {}) {
  const http = deps.http || require('http');
  const WebSocketServer = deps.WebSocketServer || require('ws').WebSocketServer;
  const crypto = deps.crypto || require('crypto');
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const log = deps.log || require('../../utils/logger')('zoom:studio');

  let server = null;
  let wss = null;
  let port = 0;
  let token = null;
  let tokenBuf = null;
  let starting = null;
  let producer = null;
  let lastFrameAt = 0;
  const viewers = new Set();
  const producerCbs = new Set();

  const _log = (level, fields) => { try { log[level]('[zoom-studio] obs-feed', fields); } catch (_) {} };
  const _emitProducer = (v) => { for (const cb of producerCbs) { try { cb(v); } catch (_) {} } };

  function _tokenOk(t) {
    if (!tokenBuf || typeof t !== 'string') return false;
    const b = Buffer.from(t, 'utf8');
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  }

  /** check(req) -> {status: 200, kind: 'page'|'feed'|'view'} | {status: 403|404} */
  function check(req) {
    if (String((req.headers && req.headers.host) || '') !== HOST + ':' + port) return { status: 403 };
    const p = String(req.url || '').split('?')[0];
    let m = /^\/obs\/([^/]+)\/$/.exec(p);
    if (m && _tokenOk(m[1])) return { status: 200, kind: 'page' };
    m = /^\/obs\/([^/]+)\/view$/.exec(p);
    if (m && _tokenOk(m[1])) return { status: 200, kind: 'view' };
    m = /^\/feed\/([^/]+)$/.exec(p);
    if (m && _tokenOk(m[1])) return { status: 200, kind: 'feed' };
    return { status: 404 };
  }

  function _onHttp(req, res) {
    const c = check(req);
    if (c.status !== 200 || c.kind !== 'page' || req.method !== 'GET') {
      const st = c.status === 403 ? 403 : 404;
      res.writeHead(st, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(REASONS[st]);
      return;
    }
    const nonce = crypto.randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'nonce-" + nonce + "'; connect-src ws://" + HOST + ':' + port + "; style-src 'unsafe-inline'; img-src blob:",
    });
    res.end(_page(nonce));
  }

  function _reject(socket, status) {
    try { socket.write('HTTP/1.1 ' + status + ' ' + (REASONS[status] || 'Error') + '\r\n\r\n'); } catch (_) {}
    try { socket.destroy(); } catch (_) {}
  }

  function _onUpgrade(req, socket, head) {
    const c = check(req);
    if (c.status !== 200 || (c.kind !== 'feed' && c.kind !== 'view')) { _reject(socket, c.status === 403 ? 403 : 404); return; }
    if (c.kind === 'view' && viewers.size >= MAX_VIEWERS) { _reject(socket, 429); return; }
    wss.handleUpgrade(req, socket, head, (ws) => (c.kind === 'feed' ? _onProducer(ws) : _onViewer(ws)));
  }

  function _onProducer(ws) {
    const old = producer;
    producer = ws;
    if (old) { try { old.close(1000); } catch (_) {} }
    _emitProducer(true);
    ws.on('message', (data, isBinary) => {
      if (!isBinary || producer !== ws) return;   // text frames are ignored
      lastFrameAt = now();
      for (const v of viewers) {
        if (v.readyState === OPEN && v.bufferedAmount < VIEWER_BUFFER_LIMIT) {
          try { v.send(data, { binary: true }); } catch (_) {}
        }
      }
    });
    ws.on('error', (e) => { _log('warn', { op: 'producer', code: (e && e.code) || 'ERROR' }); });
    ws.on('close', () => {
      if (producer !== ws) return;   // replaced or stopped
      producer = null;
      _emitProducer(false);
    });
  }

  function _onViewer(ws) {
    viewers.add(ws);
    ws.on('message', () => {});   // viewer input is ignored
    ws.on('error', () => {});
    ws.on('close', () => { viewers.delete(ws); });
  }

  function start() {
    if (server && token) return Promise.resolve({ port, token });
    if (starting) return starting;
    token = crypto.randomBytes(32).toString('hex');
    tokenBuf = Buffer.from(token, 'utf8');
    lastFrameAt = 0;
    starting = new Promise((resolve, reject) => {
      const srv = http.createServer(_onHttp);
      wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
      srv.on('upgrade', _onUpgrade);
      const onErr = (e) => {
        _log('error', { op: 'listen', code: 'OBS_FEED_FAILED', err: (e && e.code) || 'ERROR' });
        try { srv.close(); } catch (_) {}
        try { wss.close(); } catch (_) {}
        server = null; wss = null; token = null; tokenBuf = null; port = 0; starting = null;
        reject(new ZoomError('OBS_FEED_FAILED'));
      };
      srv.once('error', onErr);
      srv.listen(0, HOST, () => {
        srv.removeListener('error', onErr);
        srv.on('error', (e) => { _log('warn', { op: 'server', code: (e && e.code) || 'ERROR' }); });
        server = srv;
        port = srv.address().port;
        starting = null;
        resolve({ port, token });
      });
    });
    return starting;
  }

  function stop() {
    const srv = server;
    const w = wss;
    const p = producer;
    producer = null;
    server = null; wss = null; token = null; tokenBuf = null; port = 0; starting = null;
    if (p) { try { p.terminate(); } catch (_) {} }
    for (const v of viewers) { try { v.terminate(); } catch (_) {} }
    viewers.clear();
    if (w) { try { w.close(); } catch (_) {} }
    if (!srv) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        srv.close(() => resolve());
        if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      } catch (_) { resolve(); }
    });
  }

  function onProducer(cb) {
    producerCbs.add(cb);
    return () => producerCbs.delete(cb);
  }

  return {
    start,
    stop,
    check,
    viewUrl: () => (server && token ? 'http://' + HOST + ':' + port + '/obs/' + token + '/' : null),
    feedUrl: () => (server && token ? 'ws://' + HOST + ':' + port + '/feed/' + token : null),
    onProducer,
    get lastFrameAt() { return lastFrameAt; },
    get running() { return !!server; },
  };
}

module.exports = { createFeedServer, containRect, VIEWER_JS, MAX_PAYLOAD, MAX_VIEWERS, VIEWER_BUFFER_LIMIT };
