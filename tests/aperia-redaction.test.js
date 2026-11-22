// tests/aperia-redaction.test.js — the REAL capture / session / transport / client / export / watcher / ws modules
// driven through the real registerAperiaIPC handlers with fakes only (CDP FakeDebugger, ses.fetch, WebSocket,
// Notification). No sentinel Bearer, WS token, cookie, email or phone may appear in any log line, IPC result,
// sendToWindow payload, Notification, export file or aperia_seen_alerts.json. Plus static guards on src/aperia/**.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeLogger, WT_ROOT } from './fixtures/zoom/fake-electron.js';
import { VEHICLES_PAGES, VEHICLE_DETAIL, ISSUES_PAGE, withPii } from './fixtures/aperia/responses.js';
import {
  SENTINEL_BEARER, SENTINEL_WS_TOKEN, SENTINEL_COOKIE, SENTINEL_WS_URL, ALL_SENTINELS, containsSentinel,
} from './fixtures/aperia/sentinels.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aperia-redaction-'));
const DATA = path.join(TMP, 'data');
const DOWNLOADS = path.join(TMP, 'downloads');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(DOWNLOADS, { recursive: true });
require('../src/config/paths').setDataDir(DATA);

const API = 'https://amazon.aperiatech.com';
const SECRETS = { authToken: SENTINEL_BEARER, 'x-authorization': SENTINEL_WS_TOKEN, cookie: 'sid=' + SENTINEL_COOKIE, note: 'Bearer ' + SENTINEL_BEARER };

class FakeNotification {
  constructor(o) { this.opts = o; FakeNotification.created.push(this); }
  static isSupported() { return true; }
  on() {}
  show() {}
}
FakeNotification.created = [];

class FakeWS extends EventEmitter {
  constructor(url, opts) { super(); this.url = url; this.opts = opts; this.readyState = 0; this.sent = []; FakeWS.instances.push(this); }
  send(x) { this.sent.push(x); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}
FakeWS.instances = [];

let logger; let fx; let handlers; let ctx; let mode; let issuesExtra; let fetches;
let M = {};

function freshAperia() {
  for (const k of Object.keys(require.cache)) {
    const n = k.replace(/\\/g, '/');
    if (n.includes('/src/aperia/') || n.endsWith('/src/ipc/aperia.js')) delete require.cache[k];
  }
}

function resp(status, body) {
  return {
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'set-cookie' ? 'sid=' + SENTINEL_COOKIE + '; HttpOnly' : null) },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function detailFor(id) {
  const all = VEHICLES_PAGES.flatMap((p) => p.vehicles);
  const v = all.find((x) => String(x.id) === String(id)) || all[0];
  const d = JSON.parse(JSON.stringify(VEHICLE_DETAIL));
  Object.assign(d, { id: v.id, fleetVehicleId: v.fleetVehicleId, account: Object.assign({}, v.account, { contacts: [{ email: 'sentinel.person@example.com' }] }) }, SECRETS);
  if (String(id) === '104') {
    const s = d.sensors.find((x) => x.position === 'L3IC');
    s.issue = { id: 9555, severity: 'CRITICAL', type: 'UNDERINFLATION', resolveBy: 'immediately', createdAt: '2026-11-22T14:00:00Z', actions: ['Check the tire', { email: 'sentinel.person@example.com' }] };
  }
  return withPii(d);
}

async function fetchImpl(url, init) {
  fetches.push({ method: init && init.method });
  const u = new URL(url);
  if (mode === 'reject') throw Object.assign(new Error('net::ERR_FAILED ' + url + ' Bearer ' + SENTINEL_BEARER + ' ' + SENTINEL_COOKIE), { code: 'ERR_FAILED' });
  if (mode === 'http500') return resp(500, { error: 'bad token ' + SENTINEL_BEARER, email: 'sentinel.person@example.com' });
  if (mode === 'once401') { mode = 'ok'; return resp(401, 'Unauthorized Bearer ' + SENTINEL_BEARER); }
  if (u.pathname === '/api/v1/vehicles') {
    const page = Number(u.searchParams.get('page')) || 0;
    return resp(200, withPii(Object.assign({}, VEHICLES_PAGES[page], SECRETS)));
  }
  const m = /^\/api\/v1\/vehicles\/([^/]+)$/.exec(u.pathname);
  if (m) return resp(200, detailFor(m[1]));
  if (u.pathname === '/api/v1/issues/by/vehicle') {
    const page = JSON.parse(JSON.stringify(ISSUES_PAGE));
    if (issuesExtra) page.content[0].issues.push(issuesExtra);
    return resp(200, withPii(Object.assign(page, SECRETS)));
  }
  return resp(404, 'not found ' + SENTINEL_BEARER);
}

let seq = 0;
/** The portal's own traffic in the sign-in window: a Bearer-carrying API call (2xx) and the alert socket. */
function portalTraffic(win) {
  const dbg = win.webContents.debugger;
  const id = 'p' + (++seq);
  dbg.emitRequest({ requestId: id, url: API + '/api/v1/vehicles?page=0&size=25', method: 'GET', headers: { Authorization: 'Bearer ' + SENTINEL_BEARER, Cookie: 'sid=' + SENTINEL_COOKIE } });
  dbg.emitResponse(id, Object.assign({ vehicles: [] }, SECRETS), { status: 200 });
  dbg.emit('message', {}, 'Network.webSocketCreated', { requestId: 'w' + seq, url: SENTINEL_WS_URL });
}

function setup() {
  logger = installFakeLogger(require);
  freshAperia();
  mode = 'ok';
  issuesExtra = null;
  fetches = [];
  FakeNotification.created = [];
  FakeWS.instances = [];
  try { fs.rmSync(path.join(DATA, 'aperia_seen_alerts.json'), { force: true }); } catch (_) {}
  fx = createFakeElectron({
    onLoad(win, url) {
      if (!win.webContents.reload) win.webContents.reload = () => portalTraffic(win);
      if (url === 'https://amazon.aperiatech.com/') portalTraffic(win);
    },
  });
  fx.electron.app.getPath = (k) => (k === 'downloads' ? DOWNLOADS : TMP);
  const fromPartition = fx.electron.session.fromPartition;
  fx.electron.session.fromPartition = (p) => Object.assign(fromPartition(p), { fetch: fetchImpl });
  M = {
    capture: require('../src/aperia/capture'),
    session: require('../src/aperia/session'),
    client: require('../src/aperia/client'),
    watcher: require('../src/aperia/watcher'),
    ws: require('../src/aperia/ws'),
  };
  M.session._setDeps({ electron: fx.electron });
  M.watcher._setDeps({
    Notification: FakeNotification,
    createAlertSocket: (o) => M.ws.createAlertSocket(Object.assign({}, o, { WebSocket: FakeWS })),
  });
  handlers = new Map();
  ctx = { mainWindow: null, lastData: { rows: [{ equipmentId: 'NP6923' }] }, sent: [], sendToWindow: (ch, p) => ctx.sent.push([ch, p]) };
  require('../src/ipc/aperia.js').registerAperiaIPC(ctx, {
    handle: (ch, fn) => handlers.set(ch, fn),
    electron: fx.electron,
    dtnaStore: { all: () => [{ unitId: '122269', caseStatus: 'Closed' }] },
    store: { load: () => ({ rows: [] }) },
  });
}

const call = (ch, p) => handlers.get(ch)({}, p);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await wait(5); } }
const finished = (jobId) => ctx.sent.find((s) => s[0] === 'aperia:progress' && s[1].jobId === jobId && s[1].finished);

function walkFiles(d) {
  const out = [];
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) out.push(...walkFiles(p)); else out.push(p);
  }
  return out;
}

function assertClean(results) {
  expect(containsSentinel(logger.text())).toBe(null);
  for (const r of results.concat(ctx.sent.map((s) => s[1]))) {
    expect(containsSentinel(r)).toBe(null);
    if (r && typeof r === 'object') {
      expect(r).not.toHaveProperty('error');
      expect(r).not.toHaveProperty('message');
      expect(r).not.toHaveProperty('stack');
    }
  }
  for (const l of logger.lines) for (const a of l.args) expect(a instanceof Error).toBe(false);
  for (const n of FakeNotification.created) expect(containsSentinel([n.opts.title, n.opts.body])).toBe(null);
  for (const f of walkFiles(DATA).concat(walkFiles(DOWNLOADS))) expect(containsSentinel(fs.readFileSync(f, 'utf8')), f).toBe(null);
  expect(fetches.every((f) => f.method === 'GET')).toBe(true);
}

afterEach(() => {
  try { M.watcher._resetForTests(); } catch (_) {}
  try { M.session._resetForTests(); } catch (_) {}
  try { M.client._resetForTests(); } catch (_) {}
  try { M.capture._resetForTests(); } catch (_) {}
  logger.restore();
  freshAperia();
});

describe('Aperia redaction across the stack', () => {
  it('sign-in capture, unit, bulk, fleet, issues, critical-no-case, exports and the alert watcher (poll + WS + notifications): clean', async () => {
    setup();
    const results = [];
    const r0 = await call('aperia:status');
    expect(r0.state).toBe('signed-out');
    results.push(r0);
    const login = await call('aperia:login');
    expect(login).toEqual({ ok: true, state: 'connected' });
    results.push(login);
    expect(M.capture.current()).toBe(SENTINEL_BEARER);       // the token was captured, in memory only
    expect(M.capture.wsToken()).toBe(SENTINEL_WS_TOKEN);
    results.push(await call('aperia:status'));

    const u = await call('aperia:unit', { assetId: 'NP6923' });
    expect(u.ok).toBe(true);
    expect(u.unit.fleetVehicleId).toBe('NP6923');
    expect(u.unit.domicile).toBe('ATL2');
    results.push(u);

    // Only the last 3 jobs are kept, so each job is exported right after it finishes.
    const exportBoth = async (jobId) => {
      for (const format of ['tsv', 'xls']) {
        const e = await call('aperia:export', { jobId, format });
        expect(e.ok).toBe(true);
        expect(Object.keys(e)).toEqual(['ok', 'filename']);
        results.push(e);
      }
    };

    const b = await call('aperia:bulk', { list: ['NP6923', '122269', 'NOPE'] });
    expect(b.ok).toBe(true);
    results.push(b);
    await until(() => finished(b.jobId));
    expect(finished(b.jobId)[1]).toMatchObject({ total: 3, failed: 1, finished: true, cancelled: false });
    expect(finished(b.jobId)[1].rows.length).toBeGreaterThan(10);
    await exportBoth(b.jobId);

    const f = await call('aperia:fleet-tires', {});
    expect(f.ok).toBe(true);
    results.push(f);
    await until(() => finished(f.jobId));
    expect(finished(f.jobId)[1]).toMatchObject({ total: 8, failed: 0, finished: true });
    await exportBoth(f.jobId);

    const iss = await call('aperia:issues', { type: 'active' });
    expect(iss).toMatchObject({ ok: true, count: 4 });
    results.push(iss);
    await exportBoth(iss.jobId);
    const cx = await call('aperia:issues', { type: 'critical-no-case' });
    expect(cx.ok).toBe(true);
    expect(cx.rows.map((x) => x.fleetVehicleId)).toEqual(['NP6923']);
    results.push(cx);
    await exportBoth(cx.jobId);

    expect(walkFiles(DOWNLOADS).length).toBe(8);


    // Alerts: prime (no notification), then a WS frame, socket error/close, a poll with a new id.
    const s = await call('aperia:start-alerts', { minutes: 5 });
    expect(s).toMatchObject({ ok: true, status: { alerts: 'polling' } });
    results.push(s);
    expect(FakeNotification.created).toHaveLength(0);
    expect(FakeWS.instances).toHaveLength(1);
    const sock = FakeWS.instances[0];
    expect(sock.url).toBe(SENTINEL_WS_URL);                   // the token reached the socket, nowhere else
    sock.readyState = 1;
    sock.emit('open');
    expect((await call('aperia:status')).alerts).toBe('ws');
    sock.emit('message', Buffer.from('__pong__'), false);
    sock.emit('message', Buffer.from('garbage ' + SENTINEL_WS_TOKEN), false);
    sock.emit('message', Buffer.from(JSON.stringify({ type: 'ISSUE_CSV_GENERATED', data: { id: 1, url: SENTINEL_WS_URL } })), false);
    sock.emit('message', Buffer.from(JSON.stringify({
      type: 'NEW_ISSUE',
      data: { id: 9555, severity: 'CRITICAL', type: 'UNDERINFLATION', vehicle: { id: 104, fleetVehicleId: 'NP6923', email: 'sentinel.person@example.com' }, token: SENTINEL_BEARER },
    })), false);
    await until(() => FakeNotification.created.length === 1);
    expect(FakeNotification.created[0].opts).toMatchObject({ title: 'CRITICAL: NP6923', body: 'UNDERINFLATION \u2013 Left Rear Inner (ATL2)' });
    sock.emit('error', Object.assign(new Error('socket hang up ' + SENTINEL_WS_URL + ' ' + SENTINEL_COOKIE), { code: 'ECONNRESET' }));
    sock.emit('close', 1006);
    expect((await call('aperia:status')).alerts).toBe('polling');

    issuesExtra = { id: 9777, severity: 'MAJOR', state: 'LEAK', position: 'L1OC', positionName: 'Left Steer Outer', dateDetected: '2026-11-22T14:30:00Z' };
    const pn = await call('aperia:poll-now');
    expect(pn).toEqual({ ok: true, newCount: 1 });
    results.push(pn);
    expect(FakeNotification.created).toHaveLength(2);
    expect(FakeNotification.created[1].opts).toMatchObject({ title: 'MAJOR: NP6923', body: 'LEAK \u2013 Left Steer Outer (ATL2)' });
    const seen = fs.readFileSync(path.join(DATA, 'aperia_seen_alerts.json'), 'utf8');
    expect(seen).toContain('9555');
    expect(seen).toContain('9777');

    results.push(await call('aperia:stop-alerts'));
    results.push(await call('aperia:logout'));
    expect(M.capture.current()).toBe(null);
    expect(M.capture.wsToken()).toBe(null);

    expect(ctx.sent.some((x) => x[0] === 'aperia:alert' && x[1].type === 'alert')).toBe(true);
    expect(ctx.sent.some((x) => x[0] === 'aperia:alert' && x[1].type === 'watcher')).toBe(true);
    expect(logger.lines.some((l) => l.args[0] === '[aperia] get')).toBe(true);   // the logger did see the calls
    assertClean(results);
  });

  it('a 401 (body echoes the Bearer) reauths through the portal window and retries once: clean', async () => {
    setup();
    await call('aperia:login');
    mode = 'once401';
    const r = await call('aperia:unit', { assetId: 'NP6923' });
    expect(r.ok).toBe(true);
    expect(fx.windows).toHaveLength(1);
    assertClean([r]);
  });

  it('fetch rejecting with the token in its message, and HTTP 500 bodies with the token -> codes only: clean', async () => {
    setup();
    await call('aperia:login');
    mode = 'reject';
    const a = await call('aperia:unit', { assetId: 'NP6923' });
    expect(a).toEqual({ ok: false, code: 'APERIA_NETWORK' });
    const i = await call('aperia:issues', {});
    expect(i).toEqual({ ok: false, code: 'APERIA_NETWORK' });
    const b = await call('aperia:bulk', { list: ['NP6923', 'T100'] });
    await until(() => finished(b.jobId));
    mode = 'http500';
    const c = await call('aperia:issues', { type: 'critical-no-case' });
    expect(c).toEqual({ ok: false, code: 'APERIA_HTTP' });
    const s = await call('aperia:start-alerts', {});
    expect(s).toEqual({ ok: false, code: 'APERIA_HTTP' });
    assertClean([a, i, b, c, s, await call('aperia:status')]);
  });
});

describe('Aperia redaction: background sign-in (Phase E)', () => {
  const C = () => require('../src/aperia/constants');
  const hidden = () => fx.windows.filter((w) => w.options.show === false);
  const shown = () => fx.windows.filter((w) => w.options.show !== false);

  async function startupLogin() {
    const auth = require('../src/aperia/auto-auth');
    // Only the startup timer runs (at once); nothing else is scheduled.
    auth.start(ctx, { electron: fx.electron, setTimeout: (fn, ms) => { if (ms === C().BG_STARTUP_DELAY_MS) Promise.resolve().then(fn); return {}; }, clearTimeout: () => {} });
    await until(() => M.session.status().state === 'connected');
    return auth;
  }

  it('startup trigger: the hidden window captures the Bearer and WS token in memory only; aperia:alert {type:session} pushes are clean', async () => {
    setup();
    const auth = await startupLogin();
    expect(M.capture.current()).toBe(SENTINEL_BEARER);
    expect(M.capture.wsToken()).toBe(SENTINEL_WS_TOKEN);
    expect(fx.windows).toHaveLength(1);
    expect(hidden()).toHaveLength(1);
    expect(fx.windows[0].destroyed).toBe(true);
    const pushes = ctx.sent.filter((s) => s[0] === 'aperia:alert');
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes.every((s) => JSON.stringify(s[1]) === '{"type":"session"}')).toBe(true);
    const st = await call('aperia:status');
    expect(st).toMatchObject({ state: 'connected', alerts: 'off' });
    expect(logger.lines.some((l) => l.args[0] === '[aperia] auth' && l.args[1].op === 'background-login' && l.args[1].code === 'OK')).toBe(true);
    auth._resetForTests();
    assertClean([st]);
  });

  it('a 401 with no sign-in window open -> one hidden re-login, the read retries and succeeds; never a visible window; clean', async () => {
    setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const auth = await startupLogin();
      auth._resetForTests();
      vi.setSystemTime(Date.now() + 3 * 60e3);          // past the background sign-in min gap
      mode = 'once401';
      const r = await call('aperia:unit', { assetId: 'NP6923' });
      expect(r.ok).toBe(true);
      expect(fx.windows).toHaveLength(2);
      expect(shown()).toHaveLength(0);
      expect(fx.windows.every((w) => w.destroyed)).toBe(true);
      expect(logger.lines.some((l) => l.args[0] === '[aperia] auth' && l.args[1].reason === 'reauth' && l.args[1].code === 'OK')).toBe(true);
      assertClean([r]);
    } finally { vi.useRealTimers(); }
  });

  it('the opt-in watcher, started by the user after a background sign-in, recovers silently from a 401 on its poll', async () => {
    setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const auth = await startupLogin();
      auth._resetForTests();
      expect((await call('aperia:status')).alerts).toBe('off');   // background auth never turns alerts on
      const s = await call('aperia:start-alerts', { minutes: 5 });
      expect(s.ok).toBe(true);
      vi.setSystemTime(Date.now() + 3 * 60e3);
      mode = 'once401';
      const pn = await call('aperia:poll-now');
      expect(pn).toMatchObject({ ok: true });
      expect(shown()).toHaveLength(0);
      expect(hidden()).toHaveLength(2);
      const stop = await call('aperia:stop-alerts');
      assertClean([s, pn, stop]);
    } finally { vi.useRealTimers(); }
  });

  it('the challenge path (auto-login gives up) pushes action needed once; no visible window; clean', async () => {
    setup();
    fx = createFakeElectron({});
    fx.electron.app.getPath = (k) => (k === 'downloads' ? DOWNLOADS : TMP);
    M.session._setDeps({
      electron: fx.electron,
      autoLogin: { attachAutoLogin: (_w, _u, o) => { if (o && o.onDone) o.onDone({ success: false, error: 'bad_credentials' }); }, isLoginPage: async () => true },
    });
    const seen = [];
    M.session.onStatus((x) => seen.push(x));
    const r = await M.session.backgroundLogin({ reason: 'startup' });
    expect(r).toEqual({ ok: false, code: 'APERIA_SIGNIN_ACTION_NEEDED' });
    expect(M.session.status().actionNeeded).toBe(true);
    expect(await M.session.backgroundLogin({ reason: 'expired' })).toEqual({ ok: false, code: 'AUTH_COOLDOWN' });
    expect(seen.filter((x) => x.actionNeeded === true)).toHaveLength(1);
    expect(shown()).toHaveLength(0);
    assertClean([r, M.session.status()]);
  }, 15000);
});

describe('Aperia static guards', () => {
  const SRC = path.join(WT_ROOT, 'src');
  const files = walkFiles(path.join(SRC, 'aperia')).filter((p) => p.endsWith('.js')).concat([path.join(SRC, 'ipc', 'aperia.js')]);
  const rel = (p) => path.relative(SRC, p).replace(/\\/g, '/');
  /** code(p) -> file text with block and line comments removed. */
  const code = (p) => fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"])\/\/.*$/gm, '$1');

  it('covers the Aperia modules', () => {
    expect(files.map(rel)).toEqual(expect.arrayContaining(['aperia/client.js', 'aperia/transport.js', 'aperia/watcher.js', 'aperia/ws.js', 'ipc/aperia.js']));
  });

  it('JSON.parse only in safe-json.js', () => {
    expect(files.filter((p) => !p.endsWith('safe-json.js') && code(p).includes('JSON.parse(')).map(rel)).toEqual([]);
    expect(fs.readFileSync(path.join(SRC, 'aperia', 'safe-json.js'), 'utf8')).toContain("require('../zoom/safe-json')");
    expect(fs.readFileSync(path.join(SRC, 'zoom', 'safe-json.js'), 'utf8')).toContain('JSON.parse(');
  });

  it('no /accounts or /notifications path in code (comments only)', () => {
    expect(files.filter((p) => /\/accounts|\/notifications/.test(code(p))).map(rel)).toEqual([]);
  });

  it('no write method literal (POST / PUT / PATCH / DELETE)', () => {
    expect(files.filter((p) => /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i.test(code(p))).map(rel)).toEqual([]);
  });

  it('setInterval only in watcher.js and ws.js', () => {
    expect(files.filter((p) => code(p).includes('setInterval')).map(rel).sort()).toEqual(['aperia/watcher.js', 'aperia/ws.js']);
  });

  it('no webRequest', () => {
    expect(files.filter((p) => code(p).includes('webRequest')).map(rel)).toEqual([]);
  });

  it('the sentinel list covers the Bearer, WS token, cookie, email and phone', () => {
    for (const s of [SENTINEL_BEARER, SENTINEL_WS_TOKEN, SENTINEL_COOKIE, 'sentinel.person', '867-5309']) expect(ALL_SENTINELS).toContain(s);
  });
});
