// tests/aperia-watcher.test.js — src/aperia/watcher.js + seen-store.js with a temp data dir and fake
// client / capture / Notification / socket: off by default, prime-without-notify, exact notification text,
// muted handling, de-dupe across restart, 60-day trim, WS-first with poll fallback, stop clears everything.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger } from './fixtures/zoom/fake-electron.js';

const require = createRequire(import.meta.url);
const logger = installFakeLogger(require);
const paths = require('../src/config/paths');
const C = require('../src/aperia/constants');

const WATCHER = require.resolve('../src/aperia/watcher.js');
const SEEN = require.resolve('../src/aperia/seen-store.js');
const WS = require.resolve('../src/aperia/ws.js');
const CLIENT = require.resolve('../src/aperia/client.js');
const DAY = 24 * 3600e3;
const NOW = Date.parse('2026-11-22T15:00:00Z');
const WS_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ3YXRjaGVyIn0.d2F0Y2hlci1zaWduYXR1cmU';

function fresh() {
  for (const id of [WATCHER, SEEN, WS]) delete require.cache[id];
  return { watcher: require(WATCHER), seenStore: require(SEEN) };
}

const issue = (id, o = {}) => Object.assign({
  issueId: id, vehicleId: 'v' + id, fleetVehicleId: 'NP' + id, domicile: 'DAL2', group: 'G',
  severity: 'CRITICAL', state: 'UNDERINFLATION_AND_LEAK', position: '11', positionName: 'Left Steer',
  dateDetected: '2026-11-22T14:00:00Z', muted: false,
}, o);

class FakeNotification {
  constructor(opts) { this.opts = opts; this.handlers = {}; FakeNotification.created.push(this); }
  static isSupported() { return FakeNotification.supported; }
  on(ev, cb) { this.handlers[ev] = cb; }
  show() { this.shown = true; }
}

function fakeSocketFactory() {
  const f = vi.fn((o) => {
    const sock = {
      st: 'closed', o,
      open: vi.fn(() => { sock.setState('connecting'); }),
      close: vi.fn(() => { sock.st = 'closed'; }),
      state: () => sock.st,
      setState(s) { sock.st = s; o.onState(s); },
    };
    f.sockets.push(sock);
    return sock;
  });
  f.sockets = [];
  return f;
}

let tmp;
let rows;
let env;

function setup(watcher, o = {}) {
  const client = {
    listIssues: vi.fn(async () => (o.listFail ? { ok: false, code: o.listFail } : { ok: true, rows: rows.slice(), vehicles: 1, domiciles: [], pulledAt: '' })),
    getVehicle: vi.fn(o.getVehicle || (async () => ({ ok: false, code: 'APERIA_UNIT_NOT_FOUND' }))),
  };
  const capture = {
    current: vi.fn(() => ('bearer' in o ? o.bearer : 'bearer-token')),
    wsToken: vi.fn(() => ('wsToken' in o ? o.wsToken : WS_TOKEN)),
  };
  const createAlertSocket = o.createAlertSocket || fakeSocketFactory();
  const send = vi.fn();
  const mainWindow = { show: vi.fn(), focus: vi.fn() };
  const deps = { client, capture, createAlertSocket, Notification: FakeNotification, send, now: () => env.now };
  if (o.constants) deps.constants = o.constants;
  watcher._setDeps(deps);
  return { client, capture, createAlertSocket, send, ctx: { mainWindow } };
}

const alerts = (send) => send.mock.calls.filter((c) => c[0] === 'aperia:alert' && c[1].type === 'alert').map((c) => c[1].alert);
const watcherEvents = (send) => send.mock.calls.filter((c) => c[1].type === 'watcher').map((c) => c[1].status.alerts);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-watcher-'));
  paths.setDataDir(tmp);
  rows = [issue('1'), issue('2', { muted: true })];
  env = { now: NOW };
  FakeNotification.created = [];
  FakeNotification.supported = true;
  logger.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  try { require(WATCHER)._resetForTests(); } catch (_) {}
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('aperia watcher: off by default', () => {
  it('a fresh require starts no timer, loads no client and reports off', () => {
    delete require.cache[CLIENT];
    const { watcher } = fresh();
    expect(vi.getTimerCount()).toBe(0);
    expect(require.cache[CLIENT]).toBeUndefined();
    expect(watcher.status()).toEqual({ alerts: 'off', minutes: 5, lastPollAt: null, lastNewCount: 0 });
  });

  it('start without a Bearer -> APERIA_SIGNIN_REQUIRED, nothing called', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { bearer: null });
    expect(await watcher.start({ ctx: d.ctx })).toEqual({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    expect(d.client.listIssues).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(watcher.status().alerts).toBe('off');
  });

  it('a failed priming read leaves it off and returns the code', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { listFail: 'APERIA_SESSION_EXPIRED' });
    expect(await watcher.start({ ctx: d.ctx })).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(watcher.status().alerts).toBe('off');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pollNow when off -> APERIA_ALERTS_OFF', async () => {
    const { watcher } = fresh();
    const d = setup(watcher);
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: false, code: 'APERIA_ALERTS_OFF' });
    expect(d.client.listIssues).not.toHaveBeenCalled();
  });
});

describe('aperia watcher: polling and notifications', () => {
  it('primes without notifying, then notifies a new id once with the exact title/body', async () => {
    const { watcher, seenStore } = fresh();
    const d = setup(watcher, { wsToken: null });
    const r = await watcher.start({ ctx: d.ctx });
    expect(r.ok).toBe(true);
    expect(watcher.status().alerts).toBe('polling');
    expect(FakeNotification.created).toEqual([]);
    expect(alerts(d.send)).toEqual([]);
    expect([...seenStore.load(env.now).keys()].sort()).toEqual(['1', '2']);
    expect(await watcher.start({ ctx: d.ctx })).toMatchObject({ ok: true, already: true });

    rows.push(issue('3', { severity: 'MAJOR', fleetVehicleId: 'NP6923', state: 'UNDERINFLATION', positionName: 'Right Rear Outer', domicile: 'HOU1' }));
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 1 });
    expect(FakeNotification.created.length).toBe(1);
    const n = FakeNotification.created[0];
    expect(n.opts.title).toBe('MAJOR: NP6923');
    expect(n.opts.body).toBe('UNDERINFLATION \u2013 Right Rear Outer (HOU1)');
    expect(n.shown).toBe(true);
    n.handlers.click();
    expect(d.ctx.mainWindow.show).toHaveBeenCalled();
    expect(d.ctx.mainWindow.focus).toHaveBeenCalled();
    expect(alerts(d.send)).toEqual([{
      id: '3', severity: 'MAJOR', fleetVehicleId: 'NP6923', state: 'UNDERINFLATION',
      positionName: 'Right Rear Outer', domicile: 'HOU1', detectedAt: '2026-11-22T14:00:00Z',
    }]);
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    expect(FakeNotification.created.length).toBe(1);
    expect(watcher.status().lastNewCount).toBe(0);
    expect(seenStore.load(env.now).has('3')).toBe(true);
  });

  it('underscores become spaces and missing parts render as ?', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    rows.push(issue('4', { positionName: '', domicile: '' }));
    await watcher.pollNow(d.ctx);
    expect(FakeNotification.created[0].opts.title).toBe('CRITICAL: NP4');
    expect(FakeNotification.created[0].opts.body).toBe('UNDERINFLATION AND LEAK \u2013 ? (?)');
  });

  it('a new muted id is not notified; a missing muted is', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    const noMuted = issue('6'); delete noMuted.muted;
    rows.push(issue('5', { muted: true }), noMuted);
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 1 });
    expect(FakeNotification.created.map((n) => n.opts.title)).toEqual(['CRITICAL: NP6']);
  });

  it('no Notification when unsupported, but the renderer alert is still sent', async () => {
    FakeNotification.supported = false;
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    rows.push(issue('7'));
    await watcher.pollNow(d.ctx);
    expect(FakeNotification.created).toEqual([]);
    expect(alerts(d.send).map((a) => a.id)).toEqual(['7']);
  });

  it('the interval polls every `minutes` and stop() clears the timer', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx, minutes: 2 });
    expect(d.client.listIssues).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(3);
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(watcher.status().alerts).toBe('off');
    await vi.advanceTimersByTimeAsync(10 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(3);
    expect(watcherEvents(d.send)).toEqual(['polling', 'off']);
  });

  it('severity escalation of a seen id notifies once per step up, never on equal/lower or every poll', async () => {
    rows = [issue('90', { severity: 'MAJOR', fleetVehicleId: 'NP90' })];
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    expect(FakeNotification.created).toEqual([]);
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    rows[0] = issue('90', { severity: 'CRITICAL', fleetVehicleId: 'NP90' });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 1 });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    rows[0] = issue('90', { severity: 'MAJOR', fleetVehicleId: 'NP90' });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    rows[0] = issue('90', { severity: 'CRITICAL', fleetVehicleId: 'NP90' });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    expect(FakeNotification.created.map((n) => n.opts.title)).toEqual(['CRITICAL: NP90']);
  });

  it('the notified severity survives a restart; a muted escalation does not notify', async () => {
    rows = [issue('91', { severity: 'MINOR' }), issue('92', { severity: 'MINOR' })];
    let m = fresh();
    let d = setup(m.watcher, { wsToken: null });
    await m.watcher.start({ ctx: d.ctx });
    rows = [issue('91', { severity: 'CRITICAL' }), issue('92', { severity: 'MINOR' })];
    expect(await m.watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 1 });
    m.watcher.stop();
    expect(JSON.parse(fs.readFileSync(m.seenStore.filePath(), 'utf8')).sev).toEqual({ 91: 'CRITICAL', 92: 'MINOR' });
    m = fresh();
    d = setup(m.watcher, { wsToken: null });
    await m.watcher.start({ ctx: d.ctx });
    rows = [issue('91', { severity: 'CRITICAL' }), issue('92', { severity: 'MAJOR', muted: true })];
    expect(await m.watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    expect(FakeNotification.created.length).toBe(1);
  });

  it('a poll that fails with a sign-in code sends a watcher status; other failures do not', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    expect(watcherEvents(d.send)).toEqual(['polling']);
    d.client.listIssues.mockResolvedValueOnce({ ok: false, code: 'APERIA_HTTP_500' });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: false, code: 'APERIA_HTTP_500' });
    expect(watcherEvents(d.send)).toEqual(['polling']);
    d.client.listIssues.mockResolvedValueOnce({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: false, code: 'APERIA_SESSION_EXPIRED' });
    d.client.listIssues.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(watcherEvents(d.send)).toEqual(['polling', 'polling', 'polling']);
  });

  it('defaults to 5 minutes for an invalid minutes value', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx, minutes: 0 });
    expect(watcher.status().minutes).toBe(5);
    await vi.advanceTimersByTimeAsync(5 * 60e3 - 1);
    expect(d.client.listIssues).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.client.listIssues).toHaveBeenCalledTimes(2);
  });
});

describe('aperia watcher: seen ids on disk', () => {
  it('ids seen before a restart never notify again, via poll or WS', async () => {
    let m = fresh();
    let d = setup(m.watcher, { wsToken: null });
    await m.watcher.start({ ctx: d.ctx });
    rows.push(issue('8'));
    await m.watcher.pollNow(d.ctx);
    expect(FakeNotification.created.length).toBe(1);
    m.watcher.stop();
    const before = FakeNotification.created.length;

    // Simulated restart: fresh modules, same data dir. The priming read no longer contains id 8.
    m = fresh();
    rows = [issue('1')];
    d = setup(m.watcher);
    await m.watcher.start({ ctx: d.ctx });
    rows.push(issue('8'));
    expect(await m.watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 0 });
    const sock = d.createAlertSocket.sockets[0];
    sock.setState('open');
    expect(await m.watcher._onWsAlert({ id: '8', severity: 'CRITICAL', state: 'LEAK', vehicleId: 'v8', fleetVehicleId: 'NP8' })).toEqual({ ok: true, notified: false });
    expect(FakeNotification.created.length).toBe(before);
    expect(d.client.getVehicle).not.toHaveBeenCalled();
  });

  it('writes { version:1, ids } atomically and trims entries older than 60 days', () => {
    const { seenStore } = fresh();
    expect(seenStore.filePath()).toBe(path.join(tmp, C.SEEN_FILE));
    const map = new Map([['fresh', NOW - DAY], ['old', NOW - 61 * DAY], ['edge', NOW - 60 * DAY]]);
    expect(seenStore.save(map, NOW)).toBe(true);
    const disk = JSON.parse(fs.readFileSync(seenStore.filePath(), 'utf8'));
    expect(disk).toEqual({ version: 1, ids: { fresh: NOW - DAY, edge: NOW - 60 * DAY } });
    expect(fs.existsSync(seenStore.filePath() + '.tmp')).toBe(false);
    fs.writeFileSync(seenStore.filePath(), JSON.stringify({ version: 1, ids: { a: NOW - DAY, b: NOW - 90 * DAY, 'bad id!': NOW, c: 'x' } }));
    expect([...seenStore.load(NOW).keys()]).toEqual(['a']);
  });

  it('a missing or corrupt file -> empty map', () => {
    const { seenStore } = fresh();
    expect(seenStore.load(NOW).size).toBe(0);
    fs.writeFileSync(seenStore.filePath(), '{not json');
    expect(seenStore.load(NOW).size).toBe(0);
    fs.writeFileSync(seenStore.filePath(), JSON.stringify({ version: 1, ids: [1, 2] }));
    expect(seenStore.load(NOW).size).toBe(0);
  });

  it('an id first seen 61 days ago notifies again after the trim', async () => {
    const { watcher, seenStore } = fresh();
    fs.writeFileSync(seenStore.filePath(), JSON.stringify({ version: 1, ids: { 9: NOW - 61 * DAY, 1: NOW - DAY, 2: NOW - DAY } }));
    rows = [issue('1')];
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    rows.push(issue('9'));
    expect(await watcher.pollNow(d.ctx)).toEqual({ ok: true, newCount: 1 });
  });
});

describe('aperia watcher: WS-first', () => {
  it('socket open -> alerts ws and ticks still poll; socket failed/unauthorized -> polling', async () => {
    const { watcher } = fresh();
    const d = setup(watcher);
    await watcher.start({ ctx: d.ctx });
    expect(d.createAlertSocket).toHaveBeenCalledTimes(1);
    expect(d.createAlertSocket.mock.calls[0][0].token).toBe(WS_TOKEN);
    const sock = d.createAlertSocket.sockets[0];
    expect(sock.open).toHaveBeenCalled();
    expect(watcher.status().alerts).toBe('polling');
    sock.setState('open');
    expect(watcher.status().alerts).toBe('ws');
    await vi.advanceTimersByTimeAsync(15 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(4);
    sock.setState('failed');
    expect(watcher.status().alerts).toBe('polling');
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(5);
    sock.setState('open');
    sock.setState('unauthorized');
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(6);
    expect(watcherEvents(d.send)).toEqual(['polling', 'ws', 'polling', 'ws', 'polling']);
    watcher.stop();
    expect(sock.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('socket open but silent: a new issue in the feed is still notified by the tick poll, once', async () => {
    const { watcher } = fresh();
    const d = setup(watcher);
    await watcher.start({ ctx: d.ctx });
    d.createAlertSocket.sockets[0].setState('open');
    rows.push(issue('70', { fleetVehicleId: 'NP70' }));
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(FakeNotification.created.map((n) => n.opts.title)).toEqual(['CRITICAL: NP70']);
    // The same id later arriving on the socket does not notify again.
    expect(await watcher._onWsAlert({ id: '70', severity: 'CRITICAL', state: 'LEAK', vehicleId: 'v70', fleetVehicleId: 'NP70' })).toEqual({ ok: true, notified: false });
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(FakeNotification.created.length).toBe(1);
  });

  it('a WS alert is not notified again by the next tick poll', async () => {
    const { watcher } = fresh();
    const d = setup(watcher);
    await watcher.start({ ctx: d.ctx });
    d.createAlertSocket.sockets[0].setState('open');
    expect(await watcher._onWsAlert({ id: '71', severity: 'CRITICAL', state: 'LEAK', vehicleId: 'v71', fleetVehicleId: 'NP71' })).toEqual({ ok: true, notified: true });
    rows.push(issue('71', { fleetVehicleId: 'NP71' }));
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(FakeNotification.created.length).toBe(1);
  });

  it('a WS SEVERITY_CHANGE that steps up a seen id notifies once; equal or lower does not', async () => {
    rows = [issue('80', { severity: 'MINOR', fleetVehicleId: 'NP80' })];
    const { watcher } = fresh();
    const d = setup(watcher);
    await watcher.start({ ctx: d.ctx });
    d.createAlertSocket.sockets[0].setState('open');
    const frame = (severity) => ({ id: '80', severity, state: 'LEAK', vehicleId: 'v80', fleetVehicleId: 'NP80' });
    expect(await watcher._onWsAlert(frame('MINOR'))).toEqual({ ok: true, notified: false });
    expect(await watcher._onWsAlert(frame('MAJOR'))).toEqual({ ok: true, notified: true });
    expect(await watcher._onWsAlert(frame('MAJOR'))).toEqual({ ok: true, notified: false });
    expect(await watcher._onWsAlert(frame('MINOR'))).toEqual({ ok: true, notified: false });
    expect(await watcher._onWsAlert(frame('CRITICAL'))).toEqual({ ok: true, notified: true });
    expect(FakeNotification.created.map((n) => n.opts.title)).toEqual(['MAJOR: NP80', 'CRITICAL: NP80']);
  });

  it('a WS alert is marked seen before enrichment and notifies with positionName/domicile', async () => {
    const { watcher, seenStore } = fresh();
    let seenAtEnrich = null;
    const d = setup(watcher, {
      getVehicle: async (id) => {
        seenAtEnrich = seenStore.load(env.now).has('50');
        return { ok: true, unit: { id, fleetVehicleId: 'NP6923', domicile: 'DAL2', tires: [{ positionName: 'Left Steer', issue: { id: '50' } }], issues: [{ id: '50', positionName: 'Left Steer' }] } };
      },
    });
    await watcher.start({ ctx: d.ctx });
    d.createAlertSocket.sockets[0].setState('open');
    expect(await watcher._onWsAlert({ id: '50', severity: 'CRITICAL', state: 'UNDERINFLATION', vehicleId: '77', fleetVehicleId: 'NP6923' })).toEqual({ ok: true, notified: true });
    expect(seenAtEnrich).toBe(true);
    expect(d.client.getVehicle).toHaveBeenCalledWith('77', d.ctx);
    expect(FakeNotification.created.map((n) => [n.opts.title, n.opts.body])).toEqual([['CRITICAL: NP6923', 'UNDERINFLATION \u2013 Left Steer (DAL2)']]);
    expect(await watcher._onWsAlert({ id: '50', severity: 'CRITICAL', state: 'UNDERINFLATION', vehicleId: '77', fleetVehicleId: 'NP6923' })).toEqual({ ok: true, notified: false });
    expect(FakeNotification.created.length).toBe(1);
  });

  it('the socket onAlert callback feeds the watcher; a failed enrichment still notifies with ?', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { getVehicle: async () => { throw new Error('boom'); } });
    await watcher.start({ ctx: d.ctx });
    const sock = d.createAlertSocket.sockets[0];
    sock.setState('open');
    sock.o.onAlert({ id: '51', severity: 'MINOR', state: 'HIGH_TEMP', vehicleId: '78', fleetVehicleId: 'NP1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeNotification.created.map((n) => [n.opts.title, n.opts.body])).toEqual([['MINOR: NP1', 'HIGH TEMP \u2013 ? (?)']]);
  });

  it('no WS token -> polling only, no socket', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { wsToken: null });
    await watcher.start({ ctx: d.ctx });
    expect(d.createAlertSocket).not.toHaveBeenCalled();
    expect(watcher.status().alerts).toBe('polling');
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(2);
  });

  it('APERIA_WS_ENABLED false -> polling only even with a WS token', async () => {
    const { watcher } = fresh();
    const d = setup(watcher, { constants: Object.assign({}, C, { APERIA_WS_ENABLED: false }) });
    await watcher.start({ ctx: d.ctx });
    expect(d.capture.wsToken).not.toHaveBeenCalled();
    expect(d.createAlertSocket).not.toHaveBeenCalled();
    expect(watcher.status().alerts).toBe('polling');
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(2);
  });

  it('with the real ws.js and a 401 handshake the watcher falls back to polling', async () => {
    const { EventEmitter } = await import('node:events');
    class FakeWS extends EventEmitter {
      constructor() { super(); this.readyState = 0; FakeWS.n++; FakeWS.last = this; }
      send() {} close() {} terminate() {}
    }
    FakeWS.n = 0;
    const { watcher } = fresh();
    const { createAlertSocket } = require(WS);
    let real;
    const d = setup(watcher, { createAlertSocket: (o) => { real = createAlertSocket(Object.assign({}, o, { WebSocket: FakeWS })); return real; } });
    await watcher.start({ ctx: d.ctx });
    expect(FakeWS.n).toBe(1);
    FakeWS.last.readyState = 1;
    FakeWS.last.emit('open');
    expect(watcher.status().alerts).toBe('ws');
    FakeWS.last.emit('close', 1006);
    await vi.advanceTimersByTimeAsync(5e3);
    expect(FakeWS.n).toBe(2);
    FakeWS.last.emit('unexpected-response', {}, { statusCode: 401 });
    expect(real.state()).toBe('unauthorized');
    expect(watcher.status().alerts).toBe('polling');
    await vi.advanceTimersByTimeAsync(5 * 60e3);
    expect(d.client.listIssues).toHaveBeenCalledTimes(2);
    expect(FakeWS.n).toBe(2);
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs never carry the WS token', async () => {
    const { watcher } = fresh();
    const d = setup(watcher);
    await watcher.start({ ctx: d.ctx });
    rows.push(issue('60'));
    await watcher.pollNow(d.ctx);
    watcher.stop();
    expect(logger.lines.length).toBeGreaterThan(0);
    expect(logger.text()).not.toContain(WS_TOKEN);
  });
});
