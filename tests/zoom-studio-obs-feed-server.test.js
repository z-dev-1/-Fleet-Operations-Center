// OBS FEAT-001 (plan item 4, design §4.4 + F1 + F3): the loopback feed relay on real http/ws sockets
// (127.0.0.1, port 0) — token + Host checks on HTTP and upgrade, the nonce-CSP viewer page, producer /
// viewer relay rules, lastFrameAt, stop — and the viewer page script (VIEWER_JS) evaluated with fakes.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import http from 'node:http';
import { installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require('ws');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
async function until(fn, ms = 2000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) throw new Error('condition not met'); await wait(5); }
}

let logger; let F; let feed; let created; let serverSockets; let clock; let opened;

class SpyWSS extends WebSocketServer {
  handleUpgrade(req, socket, head, cb) {
    super.handleUpgrade(req, socket, head, (ws) => { serverSockets.push({ url: req.url, ws }); cb(ws); });
  }
}
const spyHttp = { createServer: (...a) => { const s = http.createServer(...a); created.push(s); return s; } };

function get(port, p, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: host ? { Host: host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

function upgradeStatus(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: headers || {} });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (req, res) => { resolve(res.statusCode); try { req.destroy(); } catch (_) {} });
    ws.on('error', (e) => resolve('error:' + e.message));
  });
}

/** openWs(url) -> {ws, msgs, closed:{code}|null} once open. */
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const h = { ws, msgs: [], closed: null };
    ws.on('message', (d, isBinary) => h.msgs.push(isBinary ? Buffer.from(d).toString('utf8') : 'TEXT:' + String(d)));
    ws.on('close', (code) => { h.closed = { code }; });
    ws.on('open', () => { opened.push(ws); resolve(h); });
    ws.on('error', reject);
  });
}
const viewWs = (s) => s.feedUrl().replace('/feed/', '/obs/') + '/view';

beforeEach(() => {
  created = []; serverSockets = []; opened = []; clock = 1000;
  freshZoom(require);
  logger = installFakeLogger(require);
  F = require('../src/zoom/studio/obs-feed-server');
  feed = F.createFeedServer({ http: spyHttp, WebSocketServer: SpyWSS, now: () => clock });
});
afterEach(async () => {
  for (const ws of opened) { try { ws.terminate(); } catch (_) {} }
  await feed.stop();
  logger.restore(); freshZoom(require);
});

describe('obs-feed-server', () => {
  it('binds 127.0.0.1 on an ephemeral port with a fresh 64-hex token per start', async () => {
    const a = await feed.start();
    expect(a.port).toBeGreaterThan(0);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created[0].address().address).toBe('127.0.0.1');
    expect(created[0].address().port).toBe(a.port);
    expect(feed.viewUrl()).toBe('http://127.0.0.1:' + a.port + '/obs/' + a.token + '/');
    expect(feed.feedUrl()).toBe('ws://127.0.0.1:' + a.port + '/feed/' + a.token);
    expect(await feed.start()).toEqual(a);   // idempotent while running
    expect(created).toHaveLength(1);
    await feed.stop();
    expect(feed.viewUrl()).toBeNull();
    expect(feed.feedUrl()).toBeNull();
    const b = await feed.start();
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).not.toBe(a.token);
    expect(logger.text()).not.toContain(a.token);
    expect(logger.text()).not.toContain(b.token);
  });

  it('wrong token -> 404 on HTTP and on upgrade', async () => {
    const { port, token } = await feed.start();
    const bad = token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    expect((await get(port, '/obs/' + bad + '/')).status).toBe(404);
    expect((await get(port, '/obs/short/')).status).toBe(404);
    expect((await get(port, '/')).status).toBe(404);
    expect((await get(port, '/feed/' + token)).status).toBe(404);   // ws endpoint over plain HTTP
    expect(await upgradeStatus('ws://127.0.0.1:' + port + '/feed/' + bad)).toBe(404);
    expect(await upgradeStatus('ws://127.0.0.1:' + port + '/obs/' + bad + '/view')).toBe(404);
    expect(await upgradeStatus('ws://127.0.0.1:' + port + '/obs/' + token + '/')).toBe(404);   // page path is not a ws route
    expect(await upgradeStatus('ws://127.0.0.1:' + port + '/feed/' + token)).toBe('open');
  });

  it('wrong Host -> 403 on HTTP and on upgrade', async () => {
    const { port, token } = await feed.start();
    for (const host of ['localhost:' + port, 'evil.example', '127.0.0.1:' + (port + 1), '127.0.0.1']) {
      expect((await get(port, '/obs/' + token + '/', host)).status).toBe(403);
      expect(await upgradeStatus('ws://127.0.0.1:' + port + '/feed/' + token, { Host: host })).toBe(403);
      expect(await upgradeStatus('ws://127.0.0.1:' + port + '/obs/' + token + '/view', { Host: host })).toBe(403);
    }
    expect((await get(port, '/obs/' + token + '/')).status).toBe(200);
  });

  it('viewer page is served with the nonce CSP', async () => {
    const { port, token } = await feed.start();
    const r = await get(port, '/obs/' + token + '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    const csp = r.headers['content-security-policy'];
    const m = /^default-src 'none'; script-src 'nonce-([A-Za-z0-9+/=]+)'; connect-src ws:\/\/127\.0\.0\.1:(\d+); style-src 'unsafe-inline'; img-src blob:$/.exec(csp);
    expect(m).not.toBeNull();
    expect(Number(m[2])).toBe(port);
    expect(r.body).toContain('<script nonce="' + m[1] + '">');
    expect(r.body).toContain(F.VIEWER_JS);
    expect(r.body).toContain('<canvas id="c" width="1280" height="720">');
    expect(r.body).not.toContain(token);   // the script derives its ws URL from location
    const r2 = await get(port, '/obs/' + token + '/');
    expect(/'nonce-([^']+)'/.exec(r2.headers['content-security-policy'])[1]).not.toBe(m[1]);
  });

  it('relays only the newest frame to a slow viewer', async () => {
    await feed.start();
    const slowV = await openWs(viewWs(feed));
    const fastV = await openWs(viewWs(feed));
    await until(() => serverSockets.length === 2);
    let slow = false;
    Object.defineProperty(serverSockets[0].ws, 'bufferedAmount', { configurable: true, get: () => (slow ? 2 * 1024 * 1024 : 0) });
    const prod = await openWs(feed.feedUrl());
    slow = true;
    for (const f of ['f1', 'f2', 'f3']) prod.ws.send(Buffer.from(f));
    await until(() => fastV.msgs.length === 3);
    await wait(30);
    expect(slowV.msgs).toEqual([]);
    slow = false;
    prod.ws.send(Buffer.from('f4'));
    await until(() => fastV.msgs.length === 4);
    await until(() => slowV.msgs.length === 1);
    await wait(30);
    expect(slowV.msgs).toEqual(['f4']);   // skipped frames are never queued
    expect(fastV.msgs).toEqual(['f1', 'f2', 'f3', 'f4']);
  });

  it('producer frame over 2 MB closes the producer with 1009', async () => {
    await feed.start();
    const seen = [];
    feed.onProducer((v) => seen.push(v));
    const v = await openWs(viewWs(feed));
    const prod = await openWs(feed.feedUrl());
    prod.ws.send(Buffer.alloc(2 * 1024 * 1024 + 1));
    await until(() => prod.closed !== null);
    expect(prod.closed.code).toBe(1009);
    await until(() => seen.length === 2);
    expect(seen).toEqual([true, false]);
    expect(v.msgs).toEqual([]);
    expect(feed.lastFrameAt).toBe(0);
  });

  it('producer text frames are ignored', async () => {
    await feed.start();
    const v = await openWs(viewWs(feed));
    const prod = await openWs(feed.feedUrl());
    prod.ws.send('hello');
    prod.ws.send(Buffer.from('bin'));
    await until(() => v.msgs.length === 1);
    await wait(30);
    expect(v.msgs).toEqual(['bin']);
    expect(prod.closed).toBeNull();
  });

  it('a newer producer replaces the old one and onProducer reports true/false', async () => {
    await feed.start();
    const seen = [];
    const off = feed.onProducer((x) => seen.push(x));
    const v = await openWs(viewWs(feed));
    const p1 = await openWs(feed.feedUrl());
    await until(() => seen.length === 1);
    const p2 = await openWs(feed.feedUrl());
    await until(() => p1.closed !== null);
    expect(seen).toEqual([true, true]);
    p2.ws.send(Buffer.from('from-p2'));
    await until(() => v.msgs.length === 1);
    expect(v.msgs).toEqual(['from-p2']);
    p2.ws.close();
    await until(() => seen.length === 3);
    expect(seen).toEqual([true, true, false]);
    off();
    const p3 = await openWs(feed.feedUrl());
    p3.ws.close();
    await wait(50);
    expect(seen).toEqual([true, true, false]);
  });

  it('lastFrameAt advances on each binary producer frame', async () => {
    await feed.start();
    expect(feed.lastFrameAt).toBe(0);
    const prod = await openWs(feed.feedUrl());
    clock = 5000;
    prod.ws.send(Buffer.from('a'));
    await until(() => feed.lastFrameAt === 5000);
    clock = 6500;
    prod.ws.send(Buffer.from('b'));
    await until(() => feed.lastFrameAt === 6500);
    clock = 9000;
    prod.ws.send('text is not a frame');
    await wait(50);
    expect(feed.lastFrameAt).toBe(6500);
    await feed.stop();
    await feed.start();
    expect(feed.lastFrameAt).toBe(0);   // fresh start
  });

  it('at most 4 viewers', async () => {
    await feed.start();
    const vs = [];
    for (let i = 0; i < 4; i++) vs.push(await openWs(viewWs(feed)));
    expect(await upgradeStatus(viewWs(feed))).toBe(429);
    vs[0].ws.close();
    await until(() => vs[0].closed !== null);
    await wait(30);
    const v5 = await openWs(viewWs(feed));
    v5.ws.send('viewer input is ignored');
    const prod = await openWs(feed.feedUrl());
    prod.ws.send(Buffer.from('x'));
    await until(() => v5.msgs.length === 1);
    expect(prod.msgs).toEqual([]);
  });

  it('stop closes every socket and the server', async () => {
    const { port, token } = await feed.start();
    const v1 = await openWs(viewWs(feed));
    const v2 = await openWs(viewWs(feed));
    const prod = await openWs(feed.feedUrl());
    await feed.stop();
    await until(() => v1.closed && v2.closed && prod.closed);
    expect(created[0].listening).toBe(false);
    await expect(get(port, '/obs/' + token + '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(feed.viewUrl()).toBeNull();
    await feed.stop();   // idempotent
  });

  it('listen error -> OBS_FEED_FAILED logged at error level with the code only', async () => {
    const failing = { createServer: (...a) => { const s = http.createServer(...a); s.listen = function () { setImmediate(() => this.emit('error', Object.assign(new Error('listen EACCES 127.0.0.1'), { code: 'EACCES' }))); return this; }; return s; } };
    const f2 = F.createFeedServer({ http: failing, WebSocketServer: SpyWSS });
    await expect(f2.start()).rejects.toMatchObject({ name: 'ZoomError', code: 'OBS_FEED_FAILED' });
    const errs = logger.lines.filter((l) => l.level === 'error');
    expect(errs).toHaveLength(1);
    expect(errs[0].args[1]).toEqual({ op: 'listen', code: 'OBS_FEED_FAILED', err: 'EACCES' });
    expect(logger.text()).not.toContain('127.0.0.1');
    expect(f2.feedUrl()).toBeNull();
  });
});

// ---- viewer page script (plan D6), evaluated with fakes, no jsdom ----

function runViewer() {
  const ops = [];
  const g = {
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    fillRect(...a) { ops.push(['fillRect', ...a, g.fillStyle]); },
    fillText(t, x, y) { ops.push(['fillText', t, x, y, g.fillStyle, g.font, g.textAlign, g.textBaseline]); },
    drawImage(bmp, ...a) { ops.push(['drawImage', bmp.id, ...a]); },
  };
  const canvas = { width: 1280, height: 720, getContext: (k) => (k === '2d' ? g : null) };
  const document = { getElementById: (id) => (id === 'c' ? canvas : null) };
  const location = { host: '127.0.0.1:5555', pathname: '/obs/TOKEN/' };
  const sockets = [];
  class FakeSocket { constructor(url) { this.url = url; sockets.push(this); } close() {} }
  const env = { now: 10000, timeouts: [], intervals: [], bitmaps: [] };
  const DateFake = { now: () => env.now };
  const setTimeoutFake = (fn, ms) => { env.timeouts.push({ fn, ms }); return env.timeouts.length; };
  const setIntervalFake = (fn, ms) => { env.intervals.push({ fn, ms }); return env.intervals.length; };
  const createImageBitmap = (blob) => {
    const b = { id: env.bitmaps.length + 1, width: blob.w, height: blob.h, closed: 0, close() { this.closed++; } };
    env.bitmaps.push(b);
    return Promise.resolve(b);
  };
  // eslint-disable-next-line no-new-func
  new Function('WebSocket', 'createImageBitmap', 'document', 'location', 'setTimeout', 'setInterval', 'Date', F.VIEWER_JS)(
    FakeSocket, createImageBitmap, document, location, setTimeoutFake, setIntervalFake, DateFake);
  const tick = () => { for (const i of env.intervals) i.fn(); };
  const isCard = (list) => list.some((o) => o[0] === 'fillRect' && o[1] === 0 && o[2] === 0 && o[3] === 1280 && o[4] === 720 && o[5] === '#000')
    && list.some((o) => o[0] === 'fillText' && o[1] === 'Fleet camera feed stopped' && o[2] === 640 && o[3] === 360 && o[4] === '#fff' && o[5] === '32px sans-serif' && o[6] === 'center' && o[7] === 'middle');
  return { ops, sockets, env, tick, isCard, frame: async (w, h) => { sockets[sockets.length - 1].onmessage({ data: { w, h } }); await flush(); } };
}

describe('obs-feed-server viewer script', () => {
  it("viewer script blanks to 'Fleet camera feed stopped' on socket close", async () => {
    const v = runViewer();
    expect(v.isCard(v.ops)).toBe(true);   // nothing received yet
    await v.frame(1280, 720);
    v.ops.length = 0;
    v.sockets[0].onclose({ code: 1006 });
    expect(v.isCard(v.ops)).toBe(true);
    expect(v.ops.some((o) => o[0] === 'drawImage')).toBe(false);
  });

  it('viewer script blanks after 1000 ms with no frame (fake clock)', async () => {
    const v = runViewer();
    expect(v.env.intervals).toHaveLength(1);
    expect(v.env.intervals[0].ms).toBeLessThanOrEqual(1000);
    await v.frame(1280, 720);
    v.ops.length = 0;
    v.env.now += 900; v.tick();
    expect(v.isCard(v.ops)).toBe(false);
    await v.frame(1280, 720);   // a frame resets the stall clock
    v.ops.length = 0;
    v.env.now += 999; v.tick();
    expect(v.isCard(v.ops)).toBe(false);
    v.env.now += 1; v.tick();
    expect(v.isCard(v.ops)).toBe(true);
    v.ops.length = 0;
    v.env.now += 5000; v.tick();
    expect(v.ops).toEqual([]);   // already blank: drawn once
    v.sockets[0].onmessage({ data: 'text frames are ignored' });
    await flush();
    v.env.now += 2000; v.tick();
    expect(v.ops.some((o) => o[0] === 'drawImage')).toBe(false);
  });

  it('viewer script contain-fits, closes each bitmap and reconnects every 1 s', async () => {
    const v = runViewer();
    expect(v.sockets).toHaveLength(1);
    expect(v.sockets[0].url).toBe('ws://127.0.0.1:5555/obs/TOKEN/view');
    expect(v.sockets[0].binaryType).toBe('blob');
    v.ops.length = 0;
    await v.frame(640, 480);
    const r1 = F.containRect(640, 480, 1280, 720);
    expect(r1).toEqual({ x: 160, y: 0, w: 960, h: 720 });
    expect(v.ops).toEqual([['fillRect', 0, 0, 1280, 720, '#000'], ['drawImage', 1, r1.x, r1.y, r1.w, r1.h]]);
    v.ops.length = 0;
    await v.frame(720, 1280);
    const r2 = F.containRect(720, 1280, 1280, 720);
    expect(r2).toEqual({ x: 437.5, y: 0, w: 405, h: 720 });
    expect(v.ops[1]).toEqual(['drawImage', 2, r2.x, r2.y, r2.w, r2.h]);
    expect(v.env.bitmaps.map((b) => b.closed)).toEqual([1, 1]);
    expect(F.containRect(0, 0, 1280, 720)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    // reconnect
    v.sockets[0].onclose({ code: 1006 });
    expect(v.env.timeouts.map((t) => t.ms)).toEqual([1000]);
    v.env.timeouts.shift().fn();
    expect(v.sockets).toHaveLength(2);
    expect(v.sockets[1].url).toBe('ws://127.0.0.1:5555/obs/TOKEN/view');
    v.sockets[1].onclose({ code: 1006 });
    v.env.timeouts.shift().fn();
    expect(v.sockets).toHaveLength(3);
  });
});
