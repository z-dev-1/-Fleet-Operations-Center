// OBS FEAT-001 (plan item 3, design §4.3): the obs-websocket v5 client against a real `ws` server on
// 127.0.0.1:0 scripted as a fake OBS — Hello/Identify/Identified, SHA256 auth, close codes, the single
// `settled` guard, request correlation, 207 retry, status errors, timeouts, events, sendRaw, and no
// password in any log line.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import nodeCrypto from 'node:crypto';
import { installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const SENTINEL = 'SENTINEL_PW_9f3c1e';
const SALT = 'c2FsdHNhbHRzYWx0';
const CHALLENGE = 'Y2hhbGxlbmdlY2hhbGxlbmdl';
const digest = (pw) => {
  const h = (s) => nodeCrypto.createHash('sha256').update(s, 'utf8').digest('base64');
  return h(h(pw + SALT) + CHALLENGE);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let logger; let C; let servers; let clients;

/** fakeObs(opts) -> {port, identifies, requests, protocols, conns, close()} */
async function fakeObs(o = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const st = { identifies: [], requests: [], protocols: [], conns: [], wss };
  wss.on('connection', (ws) => {
    st.protocols.push(ws.protocol);
    st.conns.push(ws);
    if (o.beforeHello) o.beforeHello(ws);
    if (!o.noHello) {
      const d = { obsWebSocketVersion: '5.5.2', rpcVersion: 1 };
      if (o.password !== undefined) d.authentication = { salt: SALT, challenge: CHALLENGE };
      ws.send(JSON.stringify({ op: 0, d }));
    }
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.op === 1) {
        st.identifies.push(m.d);
        if (o.onIdentify) { o.onIdentify(ws, m.d); return; }
        if (o.password !== undefined && m.d.authentication !== digest(o.password)) { ws.close(4009, 'Authentication failed.'); return; }
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        if (o.afterIdentified) o.afterIdentified(ws);
        return;
      }
      if (m.op === 6) {
        st.requests.push({ at: Date.now(), d: m.d });
        if (o.onRequest) o.onRequest(m.d, ws, st);
      }
    });
  });
  st.port = wss.address().port;
  st.close = () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); });
  servers.push(st);
  return st;
}

const respond = (ws, d, code, data) => ws.send(JSON.stringify({ op: 7, d: { requestType: d.requestType, requestId: d.requestId, requestStatus: { result: code === 100, code }, responseData: data } }));

function client(opts = {}) {
  const c = C.createObsClient(opts);
  clients.push(c);
  return c;
}
const codeOf = async (p) => { try { await p; return 'RESOLVED'; } catch (e) { return e.code; } };

/** FakeWS — an injectable WebSocket that never opens (for the race / AggregateError cases). */
class FakeWS extends EventEmitter {
  constructor(url, proto) { super(); this.url = url; this.proto = proto; this.readyState = 0; FakeWS.last = this; }
  send() {}
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}

beforeEach(() => {
  servers = []; clients = [];
  freshZoom(require);
  logger = installFakeLogger(require);
  C = require('../src/zoom/studio/obs-client');
});
afterEach(async () => {
  for (const c of clients) { try { c.close(); } catch (_) {} }
  for (const s of servers) await s.close();
  logger.restore(); freshZoom(require);
});

describe('obs-client handshake', () => {
  it('no-auth handshake resolves {obsWebSocketVersion, rpcVersion}', async () => {
    const s = await fakeObs();
    const c = client();
    const r = await c.connect({ host: '127.0.0.1', port: s.port });
    expect(r).toEqual({ obsWebSocketVersion: '5.5.2', rpcVersion: 1 });
    expect(s.protocols).toEqual(['obswebsocket.json']);
    expect(s.identifies).toEqual([{ rpcVersion: 1, eventSubscriptions: 65 }]);
    expect(c.connected).toBe(true);
  });

  it('auth handshake sends the SHA256 auth string in exactly one Identify', async () => {
    const s = await fakeObs({ password: SENTINEL });
    const c = client();
    await c.connect({ host: '127.0.0.1', port: s.port, password: SENTINEL });
    await wait(30);
    expect(s.identifies).toHaveLength(1);
    expect(s.identifies[0]).toEqual({ rpcVersion: 1, eventSubscriptions: 65, authentication: digest(SENTINEL) });
  });

  it('auth Hello without a password -> OBS_PASSWORD_REQUIRED and no Identify', async () => {
    const s = await fakeObs({ password: SENTINEL });
    const c = client();
    expect(await codeOf(c.connect({ host: '127.0.0.1', port: s.port }))).toBe('OBS_PASSWORD_REQUIRED');
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s.port, password: '' }))).toBe('OBS_PASSWORD_REQUIRED');
    await wait(50);
    expect(s.identifies).toHaveLength(0);
    expect(c.connected).toBe(false);
  });

  it('close 4009 -> OBS_AUTH_FAILED; 4010 -> OBS_UNSUPPORTED', async () => {
    const s = await fakeObs({ password: 'right' });
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s.port, password: 'wrong' }))).toBe('OBS_AUTH_FAILED');
    const s2 = await fakeObs({ onIdentify: (ws) => ws.close(4010, 'unsupported') });
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s2.port }))).toBe('OBS_UNSUPPORTED');
    const s3 = await fakeObs({ onIdentify: (ws) => ws.close(4012, 'x') });
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s3.port }))).toBe('OBS_CLOSED');
  });

  it('settles exactly once when error, close and timeout race', async () => {
    const c = client({ WebSocket: FakeWS, timeoutMs: 40 });
    let settles = 0;
    const p = c.connect({ host: '127.0.0.1', port: 4455 }).then(() => { settles++; return 'RESOLVED'; }, (e) => { settles++; return e.code; });
    const ws = FakeWS.last;
    expect(ws.url).toBe('ws://127.0.0.1:4455');
    expect(ws.proto).toBe('obswebsocket.json');
    ws.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    ws.emit('close', 4009);
    ws.emit('error', new Error('again'));
    await wait(80);   // the timer fires too
    expect(await p).toBe('OBS_UNREACHABLE');
    expect(settles).toBe(1);
    const connectLogs = logger.lines.filter((l) => l.args[1] && l.args[1].op === 'connect');
    expect(connectLogs).toHaveLength(1);
    expect(connectLogs[0].args[1]).toEqual({ op: 'connect', code: 'OBS_UNREACHABLE' });
  });

  it('Hello timeout -> TIMEOUT', async () => {
    const s = await fakeObs({ noHello: true });
    const c = client({ timeoutMs: 120 });
    expect(await codeOf(c.connect({ host: '127.0.0.1', port: s.port }))).toBe('TIMEOUT');
    expect(c.connected).toBe(false);
  });

  it('ECONNREFUSED (incl. AggregateError) -> OBS_UNREACHABLE', async () => {
    const s = await fakeObs();
    const deadPort = s.port;
    await s.close();
    servers = servers.filter((x) => x !== s);
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: deadPort }))).toBe('OBS_UNREACHABLE');
    const c = client({ WebSocket: FakeWS });
    const p = codeOf(c.connect({ host: '127.0.0.1', port: 4455 }));
    FakeWS.last.emit('error', new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' })]));
    expect(await p).toBe('OBS_UNREACHABLE');
  });
});

describe('obs-client requests', () => {
  it('out-of-order responses are correlated by requestId', async () => {
    const held = [];
    const s = await fakeObs({
      onRequest: (d, ws) => {
        held.push(d);
        if (held.length === 2) { respond(ws, held[1], 100, { who: held[1].requestType }); respond(ws, held[0], 100, { who: held[0].requestType }); }
      },
    });
    const c = client();
    await c.connect({ host: '127.0.0.1', port: s.port });
    const [a, b] = await Promise.all([c.request('GetVersion'), c.request('GetSceneList', { x: 1 })]);
    expect(a).toEqual({ who: 'GetVersion' });
    expect(b).toEqual({ who: 'GetSceneList' });
    expect(held[0].requestId).not.toBe(held[1].requestId);
    expect(held[1].requestData).toEqual({ x: 1 });
  });

  it('207 is retried 5 times 500 ms apart', async () => {
    let n = 0;
    const s = await fakeObs({ onRequest: (d, ws) => { if (d.requestType === 'Busy') respond(ws, d, 207); else { n++; respond(ws, d, n < 3 ? 207 : 100, { ok: 1 }); } } });
    const c = client();
    await c.connect({ host: '127.0.0.1', port: s.port });
    let err;
    try { await c.request('Busy'); } catch (e) { err = e; }
    expect(err.code).toBe('OBS_REQUEST_FAILED');
    expect(err.extra).toEqual({ status: 207, reason: 'Busy' });
    const busy = s.requests.filter((r) => r.d.requestType === 'Busy');
    expect(busy).toHaveLength(6);   // 1 try + 5 retries
    for (let i = 1; i < busy.length; i++) expect(busy[i].at - busy[i - 1].at).toBeGreaterThanOrEqual(450);
    expect(await c.request('Later')).toEqual({ ok: 1 });   // 207, 207, then 100
    expect(s.requests.filter((r) => r.d.requestType === 'Later')).toHaveLength(3);
  }, 15000);

  it('non-100 status -> OBS_REQUEST_FAILED {status, reason}', async () => {
    const { toResult } = require('../src/zoom/errors');
    const s = await fakeObs({ onRequest: (d, ws) => respond(ws, d, 600) });
    const c = client();
    await c.connect({ host: '127.0.0.1', port: s.port });
    let err;
    try { await c.request('GetInputSettings', { inputName: 'x' }); } catch (e) { err = e; }
    expect(toResult(err)).toEqual({ ok: false, code: 'OBS_REQUEST_FAILED', status: 600, reason: 'GetInputSettings' });
  });

  it('request timeout -> TIMEOUT', async () => {
    const s = await fakeObs({ onRequest: () => {} });
    const c = client({ timeoutMs: 1000 });   // also bounds the handshake on a loaded runner
    await c.connect({ host: '127.0.0.1', port: s.port });
    expect(await codeOf(c.request('GetVersion'))).toBe('TIMEOUT');
  });

  it('malformed frames are ignored and logged by length only', async () => {
    const s = await fakeObs({
      beforeHello: (ws) => {
        ws.send('not json at all');
        ws.send(Buffer.from([1, 2, 3, 4]));
        ws.send('{"op":"x","d":{}}');
        ws.send('{"op":5}');
      },
    });
    const c = client();
    expect(await c.connect({ host: '127.0.0.1', port: s.port })).toEqual({ obsWebSocketVersion: '5.5.2', rpcVersion: 1 });
    const mal = logger.lines.filter((l) => l.args[1] && l.args[1].op === 'malformed');
    expect(mal).toHaveLength(4);
    for (const l of mal) {
      expect(l.level).toBe('debug');
      expect(Object.keys(l.args[1]).sort()).toEqual(['len', 'op']);
      expect(typeof l.args[1].len).toBe('number');
    }
    expect(mal.map((l) => l.args[1].len)).toEqual([15, 4, 17, 8]);
    expect(logger.text()).not.toContain('not json');
  });

  it('op 5 events and close after Identified are emitted', async () => {
    const s = await fakeObs();
    const c = client();
    const events = []; const closes = [];
    c.on('event', (e) => events.push(e));
    c.on('close', (e) => closes.push(e));
    await c.connect({ host: '127.0.0.1', port: s.port });
    s.conns[0].send(JSON.stringify({ op: 5, d: { eventType: 'VirtualcamStateChanged', eventIntent: 64, eventData: { outputActive: false } } }));
    s.conns[0].send(JSON.stringify({ op: 5, d: { eventType: 'ExitStarted', eventIntent: 1 } }));
    await wait(50);
    expect(events).toEqual([
      { eventType: 'VirtualcamStateChanged', eventData: { outputActive: false } },
      { eventType: 'ExitStarted', eventData: undefined },
    ]);
    s.conns[0].close(1001, 'bye');
    await wait(80);
    expect(closes).toEqual([{ code: 1001 }]);
    expect(c.connected).toBe(false);
  });

  it('sendRaw sends without waiting for a response', async () => {
    const s = await fakeObs({ onRequest: () => {} });
    // timeoutMs also bounds the Hello handshake, so it has to survive a loaded parallel run
    const c = client({ timeoutMs: 1000 });
    expect(c.sendRaw('StopVirtualCam')).toBe(false);   // not connected yet
    await c.connect({ host: '127.0.0.1', port: s.port });
    const r = c.sendRaw('SetCurrentProgramScene', { sceneName: 'Scene' });
    expect(r).toBe(true);
    expect(c.sendRaw('StopVirtualCam')).toBe(true);
    await wait(1200);   // past timeoutMs: nothing is pending, nothing rejects
    expect(s.requests.map((x) => x.d.requestType)).toEqual(['SetCurrentProgramScene', 'StopVirtualCam']);
    expect(s.requests[0].d.requestData).toEqual({ sceneName: 'Scene' });
    expect(logger.lines.filter((l) => l.args[1] && l.args[1].code === 'TIMEOUT')).toHaveLength(0);
  }, 15000);

  it('the sentinel password never appears in any log line', async () => {
    const s = await fakeObs({ password: SENTINEL, onRequest: (d, ws) => respond(ws, d, 600) });
    const c = client({ timeoutMs: 3000 });   // the 600 reply is immediate; this only bounds a loaded handshake
    await c.connect({ host: '127.0.0.1', port: s.port, password: SENTINEL });
    await codeOf(c.request('GetVersion', { secret: SENTINEL }));
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s.port, password: SENTINEL + 'x' }))).toBe('OBS_AUTH_FAILED');
    expect(await codeOf(client().connect({ host: '127.0.0.1', port: s.port }))).toBe('OBS_PASSWORD_REQUIRED');
    const s2 = await fakeObs({ noHello: true });
    expect(await codeOf(client({ timeoutMs: 80 }).connect({ host: '127.0.0.1', port: s2.port, password: SENTINEL }))).toBe('TIMEOUT');
    expect(logger.lines.length).toBeGreaterThan(0);
    const t = logger.text();
    expect(t).not.toContain(SENTINEL);
    expect(t).not.toContain(digest(SENTINEL));
  }, 15000);
});
