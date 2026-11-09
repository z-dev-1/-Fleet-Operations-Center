// tests/dev-zoom-probe.test.js — unit tests for the DEV-ONLY, READ-ONLY Zoom portal API / windowless
// probe harness (src/dev/dev-zoom-probe.js, spike findings 2026-11-08). Proves:
//  - inertness without FLEET_ZOOM_PROBE_DIR (no window, no timer, no child),
//  - metadata-only CDP recording (method/host/path-pattern/query-names/header-names/status/shape),
//  - redaction of values/PII/ids (addresses, tokens, cookies, meeting ids, topics),
//  - the replay/net/child layers NEVER write/send: any non-GET and any write-pattern path is refused,
//  - graceful "needs interactive sign-in" when SSO never lands on a signed-in amazon.zoom.us page,
//  - Tier 2 auth material is passed only via stdin (never argv/env/disk) and host-filtered to *.zoom.us,
//  - Tier 3 makes no network call,
//  - the overall timeout closes the window and kills any child,
//  - app.js wires the probe behind the env gate next to the other dev aids.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = require('../src/dev/dev-zoom-probe');

describe('inertness without the env var', () => {
  it('start() creates no window, timer, listener or child when FLEET_ZOOM_PROBE_DIR is unset', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let opened = 0; let spawned = 0;
    try {
      const r = probe.start({
        env: {},                                     // no FLEET_ZOOM_PROBE_DIR
        log: silentLog(),
        _electron: { BrowserWindow: function () { opened++; } },
        _spawnChild: () => { spawned++; return fakeChild(); },
      });
      expect(r).toBe(false);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(opened).toBe(0);
      expect(spawned).toBe(0);
    } finally { setTimeoutSpy.mockRestore(); vi.useRealTimers(); }
  });

  it('start() with the env var schedules exactly one unref\'d timer and opens nothing until it fires', () => {
    vi.useFakeTimers();
    let unrefCalls = 0;
    const realSet = global.setTimeout;
    const setSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      const t = realSet(fn, ms); if (t && t.unref) { const u = t.unref.bind(t); t.unref = () => { unrefCalls++; return u(); }; } return t;
    });
    let opened = 0;
    try {
      const r = probe.start({ env: { FLEET_ZOOM_PROBE_DIR: os.tmpdir() }, delayMs: 10_000, log: silentLog(), _electron: { BrowserWindow: function () { opened++; } } });
      expect(r).toBe(true);
      expect(setSpy).toHaveBeenCalledTimes(1);
      expect(unrefCalls).toBe(1);
      expect(opened).toBe(0);                        // nothing happens until the timer fires
    } finally { setSpy.mockRestore(); vi.useRealTimers(); }
  });
});

describe('redaction / masking', () => {
  it('maskAddress reduces an address to the first char + domain', () => {
    expect(probe.maskAddress('jane.doe@corp.test')).toBe('j***@corp.test');
    expect(probe.maskAddress('x@amazon.com')).toBe('x***@amazon.com');
    expect(probe.maskAddress('')).toBe('');
  });
  it('maskText masks every address inside free text', () => {
    const out = probe.maskText('host alice@a.com and bob@b.org');
    expect(out).not.toContain('alice@a.com');
    expect(out).not.toContain('bob@b.org');
    expect(out).toContain('a***@a.com');
    expect(out).toContain('b***@b.org');
  });
  it('collapsePath strips meeting ids/guids/values and keeps only structural query names', () => {
    const p = probe.collapsePath('https://amazon.zoom.us/api/v2/users/me/meetings?type=upcoming&page_size=30&from=2026-01-01&topic=SECRET_TOPIC');
    expect(p).toBe('/api/v2/users/me/meetings?page_size=N&type=N');
    expect(p).not.toMatch(/SECRET_TOPIC|2026-01-01/);
    const g = probe.collapsePath('https://amazon.zoom.us/api/v2/meetings/11111111-2222-3333-4444-555555555555');
    expect(g).toContain('/<guid>');
    const num = probe.collapsePath('https://amazon.zoom.us/api/v2/meetings/8412345678');
    expect(num).toContain('/<n>');
    const uuid = probe.collapsePath('https://amazon.zoom.us/api/v2/past_meetings/abCDefGHijKLmnOPqrSTuv==/participants');
    expect(uuid).toContain('/<id>');
  });
  it('collapsePath masks address-bearing path segments, plain and %40-encoded', () => {
    const plain = probe.collapsePath('https://amazon.zoom.us/api/v2/users/jane.doe@corp.test/meetings');
    expect(plain).toContain('/<addr>/');
    const enc = probe.collapsePath('https://amazon.zoom.us/api/v2/users/jane.doe%40corp.test/meetings');
    expect(enc).toContain('/<addr>/');
    for (const s of [plain, enc]) { expect(s).not.toMatch(/jane|corp\.test|%40|@/i); }
    const bad = probe.collapsePath('https://amazon.zoom.us/api/v2/users/jane%40corp.test%E0%A4%A/x');
    expect(bad).not.toMatch(/jane|corp\.test/);
  });
  it('the network recorder never persists an address/topic/id from the path', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: 'a', request: { url: 'https://amazon.zoom.us/api/v2/users/jane.doe%40corp.test/meetings?topic=STANDUP_SECRET', method: 'GET', headers: {} } });
    expect(JSON.stringify(rec.finalize())).not.toMatch(/jane|corp\.test|STANDUP_SECRET/);
  });
  it('jwtExpShape reports only exp presence/seconds — never the token', () => {
    const tok = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const s = probe.jwtExpShape('Bearer ' + tok, Date.now());
    expect(s.hasExp).toBe(true);
    expect(s.secondsToExpiry).toBeGreaterThan(3500);
    expect(JSON.stringify(s)).not.toContain(tok.split('.')[1]);
    expect(probe.jwtExpShape('', Date.now())).toEqual({ hasExp: null, secondsToExpiry: null, reason: 'no-bearer-observed' });
    expect(probe.jwtExpShape('opaqueTOKEN', Date.now()).reason).toBe('opaque-token');
  });
  it('createAuthCapture keeps values in memory only; describe() exposes names/model/shape only, ignores non-Zoom hosts', () => {
    const cap = probe.createAuthCapture();
    const tok = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    cap.observe({ request: { url: 'https://amazon.zoom.us/api/v2/users/me', headers: { Authorization: 'Bearer ' + tok, 'ZOOM-CSRFTOKEN': 'CSRF_SECRET', cookie: '_zm_ssid=SESSION_SECRET' } } });
    cap.observe({ request: { url: 'https://evil.example/x', headers: { Authorization: 'Bearer EVIL' } } });
    const d = JSON.stringify(cap.describe());
    expect(d).not.toContain(tok);
    expect(d).not.toContain('CSRF_SECRET');
    expect(d).not.toContain('SESSION_SECRET');
    expect(cap.describe().namesObserved).toEqual(['authorization', 'cookie', 'zoom-csrftoken']);
    expect(cap.describe().authModel).toBe('cookie+csrf-header+bearer');
    expect(cap.host()).toBe('amazon.zoom.us');
    expect(cap.headers().authorization).toBe('Bearer ' + tok);    // non-zoom host was ignored
    expect(cap.headers()).not.toHaveProperty('cookie');           // cookie value never kept, only presence
    cap.clear();
    expect(cap.headers()).toEqual({});
    expect(cap.cookieSeen()).toBe(false);
  });
  it('headerNames returns only names of interesting headers — never values', () => {
    const names = probe.headerNames({ Authorization: 'Bearer SECRET.JWT', 'ZOOM-CSRFTOKEN': 'abc123', 'X-Zm-Trackingid': 't', cookie: '_zm=1', Referer: 'https://x', 'x-random': 'y' });
    expect(names).toContain('authorization');
    expect(names).toContain('zoom-csrftoken');
    expect(names).toContain('x-zm-trackingid');
    expect(names).toContain('cookie');
    const joined = JSON.stringify(names);
    expect(joined).not.toContain('SECRET');
    expect(joined).not.toContain('abc123');
    expect(joined).not.toContain('_zm=1');
  });
  it('shapeOf reports key/type structure, never values', () => {
    const s = probe.shapeOf({ id: 'MEETING_SECRET', topic: 'standup', count: 5, nested: { host_email: 'a@b.com' }, meetings: [1, 2, 3] });
    expect(s).toEqual({ id: 'string', topic: 'string', count: 'number', nested: { host_email: 'string' }, meetings: '[number x3]' });
    expect(JSON.stringify(s)).not.toContain('MEETING_SECRET');
    expect(JSON.stringify(s)).not.toContain('a@b.com');
  });
});

describe('host allow-list', () => {
  it('allows only amazon.zoom.us and *.zoom.us hosts', () => {
    expect(probe.hostAllowed('https://amazon.zoom.us/api')).toBe(true);
    expect(probe.hostAllowed('us01web.zoom.us')).toBe(true);
    expect(probe.hostAllowed('us01campaign.zoom.us')).toBe(true);
    expect(probe.hostAllowed('zoom.us')).toBe(true);
    expect(probe.hostAllowed('https://evil.com/amazon.zoom.us')).toBe(false);
    expect(probe.hostAllowed('marketplace.example.com')).toBe(false);
    expect(probe.hostAllowed('notzoom.us')).toBe(false);
  });
});

describe('isWriteRequest — any non-GET or write-pattern path is a write', () => {
  it('classifies non-GET methods as writes', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(probe.isWriteRequest(m, '/api/v2/users/me')).toBe(true);
    expect(probe.isWriteRequest('GET', '/api/v2/users/me')).toBe(false);
  });
  it('classifies write-pattern paths as writes even on GET', () => {
    expect(probe.isWriteRequest('GET', 'https://amazon.zoom.us/api/v2/users/me/meetings?action=create')).toBe(true);
    expect(probe.isWriteRequest('GET', '/api/v2/meetings/123/status?action=start')).toBe(true);
    expect(probe.isWriteRequest('GET', '/wc/join/123')).toBe(true);
    expect(probe.isWriteRequest('GET', '/api/v2/users/me/meetings?type=upcoming')).toBe(false);
  });
});

describe('network recorder stores only allowed fields', () => {
  it('keeps method/host/pathPattern/queryParamNames/header-names/status/shape/wouldWrite and nothing else', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({
      requestId: '1',
      request: { url: 'https://amazon.zoom.us/api/v2/meetings/8412345678?type=live&occurrence_id=XYZSECRET', method: 'GET', headers: { 'ZOOM-CSRFTOKEN': 'CSRF_VALUE', Authorization: 'Bearer JWT', cookie: '_zm=SECRET' } },
    });
    rec.recordResponse({ requestId: '1', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    rec.attachBodyShape('1', { meetings: [{ topic: 'secret topic', host_email: 'a@b.com' }] });
    const [r] = rec.finalize();
    expect(Object.keys(r).sort()).toEqual(['host', 'method', 'pathPattern', 'queryParamNames', 'requestHeaderNames', 'responseHeaderNames', 'responseShape', 'status', 'wouldWrite'].sort());
    expect(r.method).toBe('GET');
    expect(r.pathPattern).toBe('/api/v2/meetings/<n>?type=N');
    expect(r.queryParamNames).toEqual(['occurrence_id', 'type']);
    expect(r.requestHeaderNames).toContain('zoom-csrftoken');
    expect(r.wouldWrite).toBe(false);
    const blob = JSON.stringify(r);
    for (const s of ['CSRF_VALUE', 'JWT', 'SECRET', 'secret topic', 'a@b.com', 'XYZSECRET', '8412345678']) expect(blob).not.toContain(s);
  });
  it('drops requests to non-Zoom hosts', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: '9', request: { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET', headers: {} } });
    expect(rec.finalize()).toEqual([]);
  });
  it('flags a write-shaped request as wouldWrite (classification only, never issued)', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: '2', request: { url: 'https://amazon.zoom.us/api/v2/users/me/meetings', method: 'POST', headers: {} } });
    rec.recordRequest({ requestId: '3', request: { url: 'https://amazon.zoom.us/api/v2/meetings/123/recordings', method: 'DELETE', headers: {} } });
    const finding = probe._classifyWrite(rec);
    expect(finding.observedWriteShapes.length).toBe(2);
    expect(finding.observedWriteShapes.map((w) => w.method).sort()).toEqual(['DELETE', 'POST']);
  });
});

describe('replay layer issues only read-only GETs — never a write', () => {
  const WRITE = /method:\s*["'](POST|PUT|PATCH|DELETE)|"?(create|schedule|start|join|delete|cancel)"?\s*:/i;
  it('buildReplayScript emits only GET fetches and hard-refuses writes', () => {
    const s = probe.buildReplayScript({});
    expect(s).toMatch(/method:"GET"/);
    expect(s).not.toMatch(WRITE);
    expect(s).toContain('refused:true');
    expect(s).toContain('DENY.test(p)');                         // write-pattern refusal before any fetch
  });
  it('covers all the documented read-only targets', () => {
    const actions = probe.REPLAY_TARGETS.map((t) => t.action);
    for (const a of ['profile', 'meetings-upcoming', 'meetings-previous', 'meeting-detail', 'recordings-list', 'recording-transcript-availability', 'past-participants']) {
      expect(actions).toContain(a);
    }
    // every target is a GET-shaped /api path with no write verb
    for (const t of probe.REPLAY_TARGETS) expect(probe.isWriteRequest('GET', t.path)).toBe(false);
  });
  it('forwards only allow-listed captured auth headers and reports header NAMES, never cookie/evil values', () => {
    const s = probe.buildReplayScript({ authHeaders: { Authorization: 'Bearer tok-123', 'zoom-csrftoken': 'csrf-1', cookie: 'SECRET=1', 'x-evil': 'no' } });
    expect(s).toContain('Bearer tok-123');
    expect(s).toContain('csrf-1');
    expect(s).not.toContain('SECRET=1');
    expect(s).not.toContain('x-evil');
    expect(s).toContain('"headerNames":["accept","authorization","zoom-csrftoken"]');
  });
  it('without captured auth the replay sends accept only (cookies ride credentials:include)', () => {
    const s = probe.buildReplayScript({});
    expect(s).toContain('"headerNames":["accept"]');
    expect(s).toContain('credentials:"include"');
  });
  it('the Tier 2 child source issues only a GET, refuses writes/non-zoom hosts, touches no fs/argv/env', () => {
    const src = probe.TIER2_CHILD_SOURCE;
    expect(src).toMatch(/method:'GET'/);
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    expect(src).toMatch(/write-refused/);
    expect(src).toMatch(/host-blocked/);
    expect(src).toMatch(/zoom\.us/);
    expect(src).not.toMatch(/require\('fs'\)|process\.argv|process\.env/);
  });
});

describe('Tier 1 — main-process net.request on the probe partition, read-only', () => {
  it('reports electron-unavailable without throwing when net/session are missing', async () => {
    const rec = await probe._tier1(null, silentLog(), 'before-window');
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe('electron-unavailable');
  });
  it('issues GET-only requests on the probe partition session with cookie jar options', async () => {
    const electron = fakeElectron({ responses: [{ status: 200, json: { meetings: [] } }] });
    await probe._tier1(electron, silentLog(), 'before-window');
    expect(electron._calls.length).toBe(1);
    const o = electron._calls[0].opts;
    expect(o.method).toBe('GET');
    expect(electron._partitions).toContain(probe.PARTITION);
    expect(o.useSessionCookies).toBe(true);
    expect(o.redirect).toBe('manual');
    expect(o.url).not.toMatch(/create|schedule|start|join|delete|update/i);
  });
  it('records a 200 as cookies-sufficient and shape-only response (never an id)', async () => {
    const electron = fakeElectron({ responses: [{ status: 200, json: { meetings: [{ id: 'MEETING_SECRET' }] } }] });
    const rec = await probe._tier1(electron, silentLog(), 'after-window-closed');
    expect(rec.ok).toBe(true);
    expect(rec.obtainableWithoutPage).toBe(true);
    expect(JSON.stringify(rec)).not.toContain('MEETING_SECRET');
  });
  it('handles a manual redirect to SSO: records status/toLogin, never the URL, and aborts', async () => {
    const electron = fakeElectron({ responses: [{ redirect: 'https://midway-auth.amazon.com/SSO?user=jane@corp.test', status: 302 }] });
    const rec = await probe._tier1(electron, silentLog(), 'before-window');
    expect(rec.reason).toBe('redirect-to-login');
    expect(rec.attempts[0]).toMatchObject({ status: 302, redirect: true, toLogin: true });
    expect(electron._calls[0].aborted).toBe(true);
    expect(JSON.stringify(rec)).not.toMatch(/midway-auth|jane/);
    expect(rec.authMaterialNeeded).toContain('interactive-session');
  });
  it('reuses page-captured material when cookies fail, records exp shape, never the token', async () => {
    const tok = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const auth = probe.createAuthCapture();
    auth.observe({ request: { url: 'https://amazon.zoom.us/api/v2/users/me', headers: { authorization: 'Bearer ' + tok } } });
    const electron = fakeElectron({ responses: [{ status: 401 }, { status: 200, json: { meetings: [] } }, { status: 200, json: { meetings: [] } }] });
    const rec = await probe._tier1(electron, silentLog(), 'after-window-closed', { auth, reuseDelayMs: 1, remaining: () => 200_000 });
    expect(rec.ok).toBe(true);
    expect(rec.reason).toBe('needs-page-captured-material-reusable');
    expect(rec.obtainableWithoutPage).toBe(false);
    expect(rec.host).toBe('amazon.zoom.us');
    expect(rec.tokenLifetime.hasExp).toBe(true);
    expect(rec.attempts.map((a) => a.mode)).toEqual(['cookies-only', 'captured-reuse', 'captured-reuse-after-0s']);
    expect(JSON.stringify(rec)).not.toContain(tok);
    for (const c of electron._calls) expect(c.opts.method).toBe('GET');
  });
});

describe('Tier 2 — auth material only via stdin, host-filtered, child killed', () => {
  it('copies zoom-domain cookies + captured material onto stdin only, never argv/env/logs/result', async () => {
    const calls = { spawnArgs: null, stdinData: '', killed: false, ended: false };
    const child = fakeChild();
    child.stdin.write = (d) => { calls.stdinData += String(d); };
    child.stdin.end = () => { calls.ended = true; };
    child.kill = () => { calls.killed = true; child.killed = true; };
    const spawn = (...args) => {
      calls.spawnArgs = args;
      setTimeout(() => { child.stdout.emit('data', JSON.stringify({ status: 200, shape: { meetings: '[{…} x5]' }, latencyMs: 12 })); child.emit('exit', 0); }, 0);
      return child;
    };
    const electron = fakeElectron({ cookies: SECRET_COOKIES });
    const auth = probe.createAuthCapture();
    auth.observe({ request: { url: 'https://amazon.zoom.us/api/v2/users/me', headers: { Authorization: 'Bearer BEARER_SECRET' } } });
    const logs = recordingLog();
    const rec = await probe._tier2({ electron, log: logs, auth, spawn });
    const sent = JSON.parse(calls.stdinData);
    expect(probe.hostAllowed(sent.url)).toBe(true);
    expect(probe.isWriteRequest('GET', sent.url)).toBe(false);
    expect(sent.headers.cookie).toContain('_zm_ssid=COOKIE_SECRET');
    expect(sent.headers['zoom-csrftoken']).toBe('CSRF_SECRET');
    expect(sent.headers.authorization).toBe('Bearer BEARER_SECRET');
    expect(sent.headers.cookie).not.toContain('EVIL_SECRET');
    const elsewhere = JSON.stringify([calls.spawnArgs.slice(1), rec, logs.lines]) + JSON.stringify(process.env);
    for (const s of ['COOKIE_SECRET', 'CSRF_SECRET', 'BEARER_SECRET', 'EVIL_SECRET']) {
      expect(elsewhere).not.toContain(s);
      expect(String(calls.spawnArgs[0])).not.toContain(s);   // the source handed to the spawner
    }
    expect(calls.spawnArgs.length).toBe(1);
    expect(calls.ended).toBe(true);
    expect(calls.killed).toBe(true);
    expect(rec.ok).toBe(true);
    expect(rec.passedVia).toBe('stdin');
    expect(rec.cookieNamesTransferred).toEqual(['_zm_csrf', '_zm_ssid']);
    expect(rec.workerIsolationConflict).toMatch(/FORBIDDEN|isolation/i);
  });

  it('the default spawner forks with empty argv and writes only the secret-free source', () => {
    const written = []; const forks = [];
    const fakeCp = { fork: (file, args, opts) => { forks.push({ file, args, opts }); return fakeChild(); } };
    const fakeFs = { writeFileSync: (f, c) => written.push({ f, c }), unlinkSync() {} };
    probe._defaultSpawnChild(probe.TIER2_CHILD_SOURCE, { _cp: fakeCp, _fs: fakeFs, _os: os });
    expect(written.length).toBe(1);
    expect(written[0].c).toBe(probe.TIER2_CHILD_SOURCE);
    expect(forks[0].args).toEqual([]);
    expect(forks[0].opts.env).toBeUndefined();
    expect(forks[0].opts.stdio[0]).toBe('pipe');
  });
});

describe('Tier 3 — reasoning only, no network', () => {
  it('returns ok:false with a disallowed-OAuth reason and makes no call', () => {
    const t3 = probe._tier3();
    expect(t3.tier).toBe(3);
    expect(t3.ok).toBe(false);
    expect(t3.whenRun).toBe('reasoning-only');
    expect(t3.reason).toMatch(/OAuth|Marketplace|app registration|admin scopes/i);
    expect(t3.ms).toBe(0);
  });
});

describe('_runInWindow — graceful needs-interactive-sign-in and read-only replay', () => {
  it('returns needsInteractiveSignIn and issues no replay when the window stays on an SSO URL', async () => {
    let execCalls = 0;
    const win = fakeWin('https://midway-auth.amazon.com/SSO');            // never lands on amazon.zoom.us
    win.webContents.executeJavaScript = async () => { execCalls++; return '{}'; };
    const electron = { BrowserWindow: function () { return win; } };
    const out = await probe._runInWindow({
      electron, recorder: probe.createNetworkRecorder(), auth: probe.createAuthCapture(), log: silentLog(),
      win: {}, remaining: () => 3_000, deps: { _injectCookies: async () => {} },
    });
    expect(out.needsInteractiveSignIn).toBe(true);
    expect(out.lastUrlHost).toBe('midway-auth.amazon.com');
    expect(execCalls).toBe(0);                                              // no replay script ran
  });
  it('runs the read-only replay when the window lands on a signed-in amazon.zoom.us page', async () => {
    const win = fakeWin('https://amazon.zoom.us/profile');
    let ranScript = null;
    win.webContents.executeJavaScript = async (s) => { ranScript = s; return JSON.stringify({ profile: { ok: true, status: 200, listCount: null }, 'meetings-upcoming': { ok: true, status: 200, listCount: 3 } }); };
    const electron = { BrowserWindow: function () { return win; } };
    const out = await probe._runInWindow({
      electron, recorder: probe.createNetworkRecorder(), auth: probe.createAuthCapture(), log: silentLog(),
      win: {}, remaining: () => 120_000, deps: { _injectCookies: async () => {}, _navSettleMs: 0 },
    });
    expect(out.needsInteractiveSignIn).toBeUndefined();
    expect(out.replay.ok).toBe(true);
    expect(ranScript).toMatch(/method:"GET"/);
    expect(ranScript).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
  });
});

describe('run() — overall timeout aborts, closes the window and kills the child, writes redacted files', () => {
  it('closes the hidden window and kills any spawned child when the window phase overruns, still logs done', async () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-probe-to-'));
    const win = fakeWin('https://amazon.zoom.us/profile');
    win.webContents.executeJavaScript = () => new Promise(() => {});        // the replay hangs forever
    const electron = Object.assign(fakeElectron({ responses: [{ status: 401 }, { status: 401 }] }), { BrowserWindow: function () { return win; } });
    const child = fakeChild();                                              // never exits on its own
    const spawn = () => child;
    const logs = recordingLog();
    try {
      // Large overall budget so the OVERALL hard stop never fires; a small reserve forces the window
      // phase to overrun first (window closes), then Tier 2 spawns the child which its own timeout kills.
      let doneAt = null;
      const p = probe.run({ dir, log: logs, _electron: electron, _spawnChild: spawn, _overallTimeoutMs: 600_000, _reserveMs: 595_000, _reuseDelayMs: 0, _navSettleMs: 0 });
      p.then(() => { doneAt = Date.now(); });
      for (let i = 0; i < 200 && doneAt == null; i++) await vi.advanceTimersByTimeAsync(2_000);
      const res = await p;
      expect(res.ok).toBe(true);
      expect(win.closed).toBe(true);
      expect(child.killed).toBe(true);
      const files = fs.readdirSync(dir);
      expect(files.some((f) => f.startsWith('zoom-probe-windowless-'))).toBe(true);
      const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') + logs.lines.join('\n');
      expect(all).not.toMatch(/@[\w.-]+\.[a-z]{2,}/i);                      // no raw address anywhere
      expect(logs.lines.some((l) => l.startsWith('[zoom-probe] done'))).toBe(true);
    } finally { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes a signin summary and skips replay when SSO never completes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-probe-si-'));
    const win = fakeWin('https://midway-auth.amazon.com/SSO');
    win.webContents.executeJavaScript = async () => '{}';
    const electron = Object.assign(fakeElectron({ responses: [{ status: 401 }, { status: 401 }] }), { BrowserWindow: function () { return win; } });
    const logs = recordingLog();
    try {
      const res = await probe.run({ dir, log: logs, _electron: electron, _spawnChild: () => fakeChild(), _overallTimeoutMs: 60_000, _injectCookies: async () => {} });
      expect(res.ok).toBe(true);
      expect(res.needsInteractiveSignIn).toBe(true);
      const files = fs.readdirSync(dir);
      expect(files.some((f) => f.startsWith('zoom-probe-signin-'))).toBe(true);
      expect(files.some((f) => f.startsWith('zoom-probe-api-'))).toBe(false);   // no replay/api file
      expect(logs.lines.some((l) => l.startsWith('[zoom-probe] done'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('_waitClosed — BrowserWindow.close() is async', () => {
  it('waits for a window that is destroyed shortly after close()', async () => {
    const w = { d: false, isDestroyed() { return this.d; } };
    setTimeout(() => { w.d = true; }, 150);
    expect(await probe._waitClosed(w, 2_000)).toBe(true);
  });
  it('treats no window as closed', async () => {
    expect(await probe._waitClosed(null, 0)).toBe(true);
  });
});

describe('app.js wiring', () => {
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  it('is gated on FLEET_ZOOM_PROBE_DIR and requires the dev module only inside the gate', () => {
    expect(APP_SRC).toMatch(/if \(process\.env\.FLEET_ZOOM_PROBE_DIR\)/);
    expect(APP_SRC).toContain("require('./dev/dev-zoom-probe').start({ log })");
    const gate = APP_SRC.indexOf('process.env.FLEET_ZOOM_PROBE_DIR');
    const req = APP_SRC.indexOf("require('./dev/dev-zoom-probe')");
    expect(gate).toBeGreaterThan(0);
    expect(req).toBeGreaterThan(gate);
  });
});

// ───────────────────────────── fakes ─────────────────────────────
const SECRET_COOKIES = [
  { name: '_zm_ssid', value: 'COOKIE_SECRET', domain: '.zoom.us' },
  { name: '_zm_csrf', value: 'CSRF_SECRET', domain: 'amazon.zoom.us' },
  { name: 'tracker', value: 'EVIL_SECRET', domain: '.evil.example' },
];
function silentLog() { return { info() {}, warn() {}, error() {}, debug() {} }; }
function recordingLog() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, warn: push, error: push, debug: push };
}
function fakeJwt(exp) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'none' }) + '.' + b({ exp, aud: 'https://amazon.zoom.us' }) + '.sig';
}
function fakeChild() {
  const { EventEmitter } = require('events');
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = { write() {}, end() {} };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
function fakeWin(url) {
  let current = url || 'about:blank';
  const { EventEmitter } = require('events');
  const wc = new EventEmitter();
  const win = {
    closed: false,
    webContents: Object.assign(wc, {
      debugger: { isAttached: () => false, attach() {}, sendCommand() {}, on() {} },
      getURL: () => current,
      setURL: (u) => { current = u; },
      executeJavaScript: async () => '{}',
      loadURL: async (u) => { current = u; setTimeout(() => wc.emit('did-finish-load'), 0); },
    }),
    setWindowOpenHandler() {},
    on() { return win; },
    hide() {},
    isDestroyed: () => win.closed,
    close: () => { win.closed = true; },
  };
  return win;
}
/**
 * fakeElectron({ cookies, responses }) — session.fromPartition(p) records p and returns a session whose
 * cookies.get honours {domain}/{url} filters; net.request records options + headers and replays
 * `responses` in order ({status,json} or {redirect,status}).
 */
function fakeElectron(o) {
  const { EventEmitter } = require('events');
  const cookies = (o && o.cookies) || [];
  const responses = ((o && o.responses) || []).slice();
  const calls = [];
  const partitions = [];
  const domainMatch = (cd, host) => { const d = String(cd).replace(/^\./, ''); return host === d || host.endsWith('.' + d); };
  const makeSession = () => ({
    cookies: {
      get: async (filter) => {
        if (filter && filter.url) { const h = new URL(filter.url).hostname; return cookies.filter((c) => domainMatch(c.domain, h) || /evil/.test(c.domain)); }
        if (filter && filter.domain) return cookies.filter((c) => domainMatch(c.domain, filter.domain) || domainMatch(filter.domain, String(c.domain).replace(/^\./, '')));
        return cookies.slice();
      },
    },
  });
  const electron = {
    _calls: calls,
    _partitions: partitions,
    session: { fromPartition: (p) => { partitions.push(p); return makeSession(); }, defaultSession: makeSession() },
    net: {
      request(opts) {
        const req = new EventEmitter();
        const call = { opts, headers: {}, aborted: false };
        calls.push(call);
        req.setHeader = (k, v) => { call.headers[String(k).toLowerCase()] = v; };
        req.abort = () => { call.aborted = true; req.emit('abort'); };
        req.end = () => {
          const r = responses.shift() || { status: 401 };
          setTimeout(() => {
            if (r.redirect) { req.emit('redirect', r.status || 302, 'GET', r.redirect, {}); return; }
            const res = new EventEmitter();
            res.statusCode = r.status;
            res.headers = r.headers || {};
            req.emit('response', res);
            if (r.json) res.emit('data', Buffer.from(JSON.stringify(r.json)));
            res.emit('end');
          }, 0);
        };
        return req;
      },
    },
  };
  return electron;
}
