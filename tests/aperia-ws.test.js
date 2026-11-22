// tests/aperia-ws.test.js — src/aperia/ws.js with a fake WebSocket: frame parsing, ping cadence,
// reconnect cap -> failed, 401 -> unauthorized without reconnect, the token never reaches a log line.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
delete require.cache[require.resolve('../src/aperia/ws.js')];
const C = require('../src/aperia/constants');
const { createAlertSocket } = require('../src/aperia/ws');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3cy10ZXN0In0.c2lnbmF0dXJlLXdzLXRva2Vu';

class FakeWS extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url; this.opts = opts; this.sent = []; this.readyState = 0;
    FakeWS.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close(code) { this.readyState = 3; this.closedWith = code; }
  terminate() { this.readyState = 3; this.terminated = true; }
  _open() { this.readyState = 1; this.emit('open'); }
  _msg(text) { this.emit('message', Buffer.from(text), false); }
}
FakeWS.instances = [];
const last = () => FakeWS.instances[FakeWS.instances.length - 1];

function make() {
  const alerts = [];
  const states = [];
  const s = createAlertSocket({ token: TOKEN, WebSocket: FakeWS, onAlert: (a) => alerts.push(a), onState: (x) => states.push(x) });
  return { s, alerts, states };
}

beforeEach(() => { FakeWS.instances = []; logger.clear(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('aperia ws: connect', () => {
  it('builds the URL with the token and the Origin header; state goes connecting -> open', () => {
    const { s, states } = make();
    expect(s.state()).toBe('closed');
    s.open();
    const ws = last();
    expect(ws.url).toBe(C.WS_URL + '?' + C.WS_TOKEN_PARAM + '=' + encodeURIComponent(TOKEN));
    expect(ws.opts).toEqual({ headers: { Origin: C.BASE_URL } });
    ws._open();
    expect(s.state()).toBe('open');
    expect(states).toEqual(['connecting', 'open']);
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it('open timeout terminates and reconnects', () => {
    const { s } = make();
    s.open();
    vi.advanceTimersByTime(C.WS_OPEN_TIMEOUT_MS);
    expect(FakeWS.instances[0].terminated).toBe(true);
    expect(s.state()).toBe('closed');
    vi.advanceTimersByTime(5e3);
    expect(FakeWS.instances.length).toBe(2);
    expect(s.state()).toBe('connecting');
  });
});

describe('aperia ws: frames', () => {
  it('emits NEW_ISSUE and SEVERITY_CHANGE; ignores ISSUE_CSV_GENERATED, __pong__, garbage', () => {
    const { s, alerts } = make();
    s.open(); last()._open();
    const ws = last();
    ws._msg(JSON.stringify({ type: 'NEW_ISSUE', data: { id: 123, severity: 'CRITICAL', type: 'UNDERINFLATION', vehicle: { id: 77, fleetVehicleId: 'NP6923' } } }));
    ws._msg(JSON.stringify({ type: 'SEVERITY_CHANGE', data: { id: 'abc', severity: 'MAJOR', type: 'LEAK', vehicle: { id: 78, fleetVehicleId: 'NP1' } } }));
    ws._msg(JSON.stringify({ type: 'ISSUE_CSV_GENERATED', data: { id: 9 } }));
    ws._msg(JSON.stringify({ type: 'NEW_ISSUE', data: { severity: 'MINOR' } }));
    ws._msg(C.WS_PONG);
    ws._msg('not json {');
    ws._msg('null');
    ws.emit('message', Buffer.from([1, 2, 3]), true);
    expect(alerts).toEqual([
      { id: '123', severity: 'CRITICAL', state: 'UNDERINFLATION', vehicleId: '77', fleetVehicleId: 'NP6923' },
      { id: 'abc', severity: 'MAJOR', state: 'LEAK', vehicleId: '78', fleetVehicleId: 'NP1' },
    ]);
  });

  it('pings every WS_PING_MS while open and stops after close()', () => {
    const { s } = make();
    s.open(); last()._open();
    const ws = last();
    vi.advanceTimersByTime(C.WS_PING_MS - 1);
    expect(ws.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(ws.sent).toEqual([C.WS_PING]);
    vi.advanceTimersByTime(C.WS_PING_MS * 2);
    expect(ws.sent).toEqual([C.WS_PING, C.WS_PING, C.WS_PING]);
    s.close();
    expect(ws.closedWith).toBe(1000);
    expect(s.state()).toBe('closed');
    vi.advanceTimersByTime(C.WS_PING_MS * 3);
    expect(ws.sent.length).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('aperia ws: reconnect', () => {
  it('unclean closes reconnect with doubling backoff up to WS_MAX_RECONNECTS, then failed', () => {
    const { s, states } = make();
    s.open();
    const delays = [];
    for (let i = 0; i < C.WS_MAX_RECONNECTS; i++) {
      last().emit('close', 1006);
      expect(s.state()).toBe('closed');
      const before = FakeWS.instances.length;
      let waited = 0;
      while (FakeWS.instances.length === before) { vi.advanceTimersByTime(1000); waited += 1000; }
      delays.push(waited);
    }
    expect(delays).toEqual([5e3, 10e3, 20e3, 40e3, 80e3, 160e3, 300e3, 300e3, 300e3, 300e3]);
    last().emit('close', 1006);
    expect(s.state()).toBe('failed');
    expect(states[states.length - 1]).toBe('failed');
    vi.advanceTimersByTime(3600e3);
    expect(FakeWS.instances.length).toBe(1 + C.WS_MAX_RECONNECTS);
  });

  it('a successful open resets the reconnect count', () => {
    const { s } = make();
    s.open();
    for (let i = 0; i < 5; i++) {
      last().emit('close', 1006);
      const before = FakeWS.instances.length;
      while (FakeWS.instances.length === before) vi.advanceTimersByTime(1000);
    }
    last()._open();
    expect(s.state()).toBe('open');
    last().emit('close', 1006);
    const before = FakeWS.instances.length;
    vi.advanceTimersByTime(5e3);
    expect(FakeWS.instances.length).toBe(before + 1);
  });

  it('a clean close (1000) does not reconnect', () => {
    const { s } = make();
    s.open(); last()._open();
    last().emit('close', 1000);
    expect(s.state()).toBe('closed');
    vi.advanceTimersByTime(3600e3);
    expect(FakeWS.instances.length).toBe(1);
  });

  it('401 / 403 handshake -> unauthorized, no reconnect', () => {
    for (const code of [401, 403]) {
      FakeWS.instances = [];
      const { s } = make();
      s.open();
      last().emit('unexpected-response', {}, { statusCode: code });
      expect(s.state()).toBe('unauthorized');
      expect(FakeWS.instances[0].terminated).toBe(true);
      last().emit('close', 1006);
      vi.advanceTimersByTime(3600e3);
      expect(FakeWS.instances.length).toBe(1);
      expect(s.state()).toBe('unauthorized');
    }
  });

  it('other handshake failures reconnect', () => {
    const { s } = make();
    s.open();
    last().emit('unexpected-response', {}, { statusCode: 502 });
    expect(s.state()).toBe('closed');
    vi.advanceTimersByTime(5e3);
    expect(FakeWS.instances.length).toBe(2);
  });
});

describe('aperia ws: logs', () => {
  it('no log line carries the token or the socket URL query', () => {
    const { s } = make();
    s.open();
    last().emit('error', Object.assign(new Error('connect failed ' + C.WS_URL + '?x-authorization=' + TOKEN), { code: 'ECONNRESET' }));
    last().emit('close', 1006);
    vi.advanceTimersByTime(5e3);
    last()._open();
    last().emit('unexpected-response', {}, { statusCode: 401 });
    s.close();
    const text = logger.text();
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(encodeURIComponent(TOKEN));
    expect(text).not.toContain(C.WS_TOKEN_PARAM + '=');
    expect(text).not.toContain(C.WS_URL);
  });
});
