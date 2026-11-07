// tests/dev-owa-probe.test.js — unit tests for the DEV-ONLY OWA API/windowless probe harness
// (src/dev/dev-owa-probe.js, spike findings 2026-11-07). Proves:
//  - inertness without FLEET_OWA_PROBE_DIR (no window, no timer, no child),
//  - redaction/masking strips header values/cookies/tokens/bodies/addresses,
//  - the network recorder stores only allowed fields,
//  - no send/move/flag/delete action is ever issued by the replay or windowless layers,
//  - Tier 2 auth material is passed only via stdin/IPC (never argv/env/disk) and host-filtered,
//  - Tier 3 makes no network call,
//  - the overall timeout closes the window and kills any child,
//  - app.js wires the probe behind the env gate next to the other dev aids.
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import vm from 'vm';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probe = require('../src/dev/dev-owa-probe');

describe('inertness without the env var', () => {
  it('start() creates no window, timer, listener or child when FLEET_OWA_PROBE_DIR is unset', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    let opened = 0; let spawned = 0;
    try {
      const r = probe.start({
        env: {},                                     // no FLEET_OWA_PROBE_DIR
        log: silentLog(),
        _electron: { BrowserWindow: function () { opened++; } },
        _openSession: () => { opened++; },
        _spawnChild: () => { spawned++; return fakeChild(); },
      });
      expect(r).toBe(false);
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(opened).toBe(0);
      expect(spawned).toBe(0);
    } finally { setTimeoutSpy.mockRestore(); vi.useRealTimers(); }
  });

  it('start() with the env var schedules exactly one unref\'d timer and still opens nothing until it fires', () => {
    vi.useFakeTimers();
    let unrefCalls = 0;
    const realSet = global.setTimeout;
    const setSpy = vi.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      const t = realSet(fn, ms); if (t && t.unref) { const u = t.unref.bind(t); t.unref = () => { unrefCalls++; return u(); }; } return t;
    });
    let opened = 0;
    try {
      const r = probe.start({ env: { FLEET_OWA_PROBE_DIR: os.tmpdir() }, delayMs: 10_000, log: silentLog(), _openSession: () => { opened++; return Promise.resolve({ settled: {} }); }, _electron: null });
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
    const out = probe.maskText('from alice@a.com to bob@b.org');
    expect(out).not.toContain('alice@a.com');
    expect(out).not.toContain('bob@b.org');
    expect(out).toContain('a***@a.com');
    expect(out).toContain('b***@b.org');
  });
  it('collapsePath strips ids/guids/values and keeps only the action name', () => {
    const p = probe.collapsePath('https://outlook.office.com/owa/service.svc?action=FindItem&EP=1&id=AAMkAGI2THIS_IS_A_LONG_ITEM_ID_1234567890');
    expect(p).toBe('/owa/service.svc?action=FindItem');
    expect(p).not.toMatch(/AAMk/);
    const g = probe.collapsePath('https://outlook.office.com/api/v2.0/me/messages/11111111-2222-3333-4444-555555555555');
    expect(g).toContain('/<guid>');
  });
  it('collapsePath masks address-bearing path segments, plain and %40-encoded (B5)', () => {
    const plain = probe.collapsePath('https://outlook.office.com/owa/jane.doe@corp.test/service.svc?action=FindItem');
    expect(plain).toBe('/owa/<addr>/service.svc?action=FindItem');
    const enc = probe.collapsePath('https://outlook.office.com/owa/jane.doe%40corp.test/service.svc?action=FindItem');
    expect(enc).toBe('/owa/<addr>/service.svc?action=FindItem');
    const users = probe.collapsePath("https://outlook.office.com/api/v2.0/Users('jane.doe%40corp.test')/messages");
    for (const s of [plain, enc, users]) { expect(s).not.toMatch(/jane|corp\.test|%40|@/i); }
    // a malformed escape must not throw or leak
    const bad = probe.collapsePath('https://outlook.office.com/owa/jane%40corp.test%E0%A4%A/x');
    expect(bad).not.toMatch(/jane|corp\.test/);
  });
  it('the network recorder never persists an address from the path (B5)', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: 'a', request: { url: 'https://outlook.office.com/owa/jane.doe%40corp.test/service.svc?action=GetItem', method: 'POST', headers: {} } });
    expect(JSON.stringify(rec.finalize())).not.toMatch(/jane|corp\.test/);
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
  it('createAuthCapture keeps values in memory only; describe() exposes names/shape only', () => {
    const cap = probe.createAuthCapture();
    const tok = fakeJwt(Math.floor(Date.now() / 1000) + 600);
    cap.observe({ request: { url: 'https://outlook.cloud.microsoft/owa/service.svc?action=FindItem', headers: { Authorization: 'Bearer ' + tok, 'X-OWA-CANARY': 'CANARY_SECRET', 'X-AnchorMailbox': 'jane@corp.test' } } });
    cap.observe({ request: { url: 'https://evil.example/x', headers: { Authorization: 'Bearer EVIL' } } });
    const d = JSON.stringify(cap.describe());
    expect(d).not.toContain(tok);
    expect(d).not.toContain('CANARY_SECRET');
    expect(d).not.toContain('jane@corp.test');
    expect(cap.describe().namesObserved).toEqual(['authorization', 'x-anchormailbox', 'x-owa-canary']);
    expect(cap.host()).toBe('outlook.cloud.microsoft');
    expect(cap.headers().authorization).toBe('Bearer ' + tok);    // non-outlook host was ignored
    cap.clear();
    expect(cap.headers()).toEqual({});
  });
  it('headerNames returns only names of interesting headers — never values', () => {
    const names = probe.headerNames({ Authorization: 'Bearer SECRET.JWT.VALUE', 'X-OWA-CANARY': 'abc123', 'X-AnchorMailbox': 'x@y.com', Referer: 'https://x', cookie: 'a=b' });
    expect(names).toContain('authorization');
    expect(names).toContain('x-owa-canary');
    expect(names).toContain('x-anchormailbox');
    expect(names).toContain('cookie');
    expect(names).not.toContain('referer');
    const joined = JSON.stringify(names);
    expect(joined).not.toContain('SECRET');
    expect(joined).not.toContain('abc123');
    expect(joined).not.toContain('a=b');
  });
  it('shapeOf reports key/type structure, never values', () => {
    const s = probe.shapeOf({ Id: 'AAMkSECRET', count: 5, nested: { From: 'a@b.com' }, arr: [1, 2, 3] });
    expect(s).toEqual({ Id: 'string', count: 'number', nested: { From: 'string' }, arr: '[number x3]' });
    expect(JSON.stringify(s)).not.toContain('AAMk');
    expect(JSON.stringify(s)).not.toContain('a@b.com');
  });
});

describe('host allow-list', () => {
  it('allows only the outlook mail hosts and their subdomains', () => {
    expect(probe.hostAllowed('https://outlook.office.com/api')).toBe(true);
    expect(probe.hostAllowed('outlook.office365.com')).toBe(true);
    expect(probe.hostAllowed('sub.outlook.cloud.microsoft')).toBe(true);
    expect(probe.hostAllowed('https://evil.com/outlook.office.com')).toBe(false);
    expect(probe.hostAllowed('graph.microsoft.com')).toBe(false);
    expect(probe.hostAllowed('login.microsoftonline.com')).toBe(false);
  });
});

describe('network recorder stores only allowed fields', () => {
  it('keeps method/host/pathPattern/action/header-names/status/shape and nothing else', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({
      requestId: '1',
      request: { url: 'https://outlook.office.com/owa/service.svc?action=GetItem&id=AAMkLONGID1234567890ABCDEFG', method: 'POST', headers: { 'X-OWA-CANARY': 'CANARY_VALUE', Authorization: 'Bearer JWT' } },
    });
    rec.recordResponse({ requestId: '1', response: { status: 200, headers: { 'content-type': 'application/json' } } });
    rec.attachBodyShape('1', { Items: [{ Subject: 'secret subject', From: 'a@b.com' }] });
    const [r] = rec.finalize();
    expect(Object.keys(r).sort()).toEqual(['action', 'host', 'method', 'pathPattern', 'requestHeaderNames', 'responseHeaderNames', 'responseShape', 'status', 'wouldMutate'].sort());
    expect(r.action).toBe('GetItem');
    expect(r.pathPattern).toBe('/owa/service.svc?action=GetItem');
    expect(r.requestHeaderNames).toContain('x-owa-canary');
    const blob = JSON.stringify(r);
    expect(blob).not.toContain('CANARY_VALUE');
    expect(blob).not.toContain('JWT');
    expect(blob).not.toContain('AAMkLONGID');
    expect(blob).not.toContain('secret subject');
    expect(blob).not.toContain('a@b.com');
  });
  it('drops requests to non-outlook hosts', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: '9', request: { url: 'https://graph.microsoft.com/v1.0/me', method: 'GET', headers: {} } });
    expect(rec.finalize()).toEqual([]);
  });
  it('flags a mutating action shape as wouldMutate (for the static send-call finding only)', () => {
    const rec = probe.createNetworkRecorder();
    rec.recordRequest({ requestId: '2', request: { url: 'https://outlook.office.com/owa/service.svc?action=CreateItem', method: 'POST', headers: {} } });
    const finding = probe._staticSendCallFinding(rec);
    expect(finding.observedMutatingShapes.length).toBe(1);
    expect(finding.observedMutatingShapes[0].action).toBe('CreateItem');
  });
});

describe('replay layer issues only read-only GETs — never a send/move/flag/delete/mark-read', () => {
  const MUTATION = /CreateItem|SendItem|ReplyToItem|ForwardItem|UpdateItem|MoveItem|DeleteItem|MarkAsRead|sendMail|method:\s*["']POST|method:\s*["']PATCH|method:\s*["']PUT|method:\s*["']DELETE/i;
  for (const action of ['list', 'get', 'conversation', 'stability']) {
    it('buildReplayScript("' + action + '") contains no mutating verb/action', () => {
      const s = probe.buildReplayScript({ action });
      expect(s).toMatch(/method:\s*"GET"/);
      expect(s).not.toMatch(MUTATION);
      expect(s).toContain('wouldMarkRead:false');
    });
  }
  it('the attachment-chip script is a pure DOM read with no fetch and no generic button/anchor fallback', () => {
    const s = probe.buildAttachChipScript();
    expect(s).not.toMatch(MUTATION);
    expect(s).not.toMatch(/fetch\(/);
    expect(s).not.toContain('button[title');
  });
  it('the P-ATT ranged script is GET-only with a Range header and no mutating verb', () => {
    const s = probe._buildRangedHeadScript();
    expect(s).toMatch(/method:"GET"/);
    expect(s).toMatch(/Range:"bytes=0-15"/);
    expect(s).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(s).not.toContain('button[title');
  });
  it('the Tier 2 child source issues only a GET and touches no fs/argv/env', () => {
    const src = probe.TIER2_CHILD_SOURCE;
    expect(src).toMatch(/method:'GET'/);
    expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/i);
    expect(src).not.toMatch(/require\('fs'\)|process\.argv|process\.env/);
  });
});

describe('P-ATT ranged fetch only targets real chip hrefs on Outlook hosts (B1)', () => {
  async function runRanged(chips, pageAnchors) {
    const queried = [];
    const fetches = [];
    const document = {
      querySelectorAll(sel) {
        queried.push(sel);
        if (sel === probe.ATT_CHIP_SELECTOR) return chips;
        if (sel === 'a[href]') return pageAnchors || [];
        return [];
      },
    };
    const fetch = async (url, init) => { fetches.push({ url, init }); return { ok: false, status: 206, headers: { get: () => 'application/pdf' }, body: { cancel() {} } }; };
    const out = await vm.runInNewContext(probe._buildRangedHeadScript(), { document, fetch, URL, location: { href: 'https://outlook.office.com/mail/' } });
    return { res: JSON.parse(out), fetches, queried };
  }
  const anchor = (href) => ({ tagName: 'A', getAttribute: (n) => (n === 'href' ? href : null), querySelectorAll: () => [] });
  const chip = (inner) => ({ tagName: 'DIV', getAttribute: () => null, querySelectorAll: (s) => (s === 'a[href]' ? inner : []) });

  it('never fetches a page-level (non-chip) anchor', async () => {
    const { res, fetches, queried } = await runRanged([], [anchor('https://outlook.office.com/owa/unsubscribe')]);
    expect(fetches).toEqual([]);
    expect(res.reason).toBe('no-handle');
    expect(queried).toEqual([probe.ATT_CHIP_SELECTOR]);       // never a document-wide a[href] query
  });
  it('never fetches a chip href on a non-Outlook host', async () => {
    const { res, fetches } = await runRanged([chip([anchor('https://evil.example/approve?id=1')])]);
    expect(fetches).toEqual([]);
    expect(res.reason).toBe('bad-host');
  });
  it('never fetches a chip href whose path carries a mutating verb', async () => {
    const { fetches } = await runRanged([chip([anchor('https://outlook.office.com/owa/service.svc?action=DeleteItem')])]);
    expect(fetches).toEqual([]);
  });
  it('fetches an Outlook chip href with a ranged GET only', async () => {
    const { res, fetches } = await runRanged([chip([anchor('https://attachments.outlook.office.com/owa/x/attachment.pdf')])]);
    expect(fetches.length).toBe(1);
    expect(fetches[0].init.method).toBe('GET');
    expect(fetches[0].init.headers.Range).toBe('bytes=0-15');
    expect(res.status).toBe(206);
  });
});

describe('Tier 2 — auth material only via stdin, host-filtered, child killed (B3)', () => {
  it('copies outlook-domain cookies + captured material onto stdin only, never argv/env/logs/result', async () => {
    const calls = { spawnArgs: null, stdinData: '', killed: false, ended: false };
    const child = fakeChild();
    child.stdin.write = (d) => { calls.stdinData += String(d); };
    child.stdin.end = () => { calls.ended = true; };
    child.kill = () => { calls.killed = true; child.killed = true; };
    const spawn = (...args) => {
      calls.spawnArgs = args;
      setTimeout(() => { child.stdout.emit('data', JSON.stringify({ status: 200, shape: { value: '[{…} x5]' }, latencyMs: 12 })); child.emit('exit', 0); }, 0);
      return child;
    };
    const electron = fakeElectron({ cookies: SECRET_COOKIES });
    const auth = probe.createAuthCapture();
    auth.observe({ request: { url: 'https://outlook.office.com/owa/service.svc?action=FindItem', headers: { Authorization: 'Bearer BEARER_SECRET' } } });
    const logs = recordingLog();
    const rec = await probe._tier2({ electron, log: logs, auth, spawn });
    const sent = JSON.parse(calls.stdinData);
    // auth material is on stdin, scoped to outlook-domain cookies only
    expect(probe.hostAllowed(sent.url)).toBe(true);
    expect(sent.headers.cookie).toContain('OWAAUTH=COOKIE_SECRET');
    expect(sent.headers['x-owa-canary']).toBe('CANARY_SECRET');
    expect(sent.headers.authorization).toBe('Bearer BEARER_SECRET');
    expect(sent.headers.cookie).not.toContain('EVIL_SECRET');
    // ...and nowhere else
    const elsewhere = JSON.stringify([calls.spawnArgs.slice(1), rec, logs.lines]) + JSON.stringify(process.env);
    for (const s of ['COOKIE_SECRET', 'CANARY_SECRET', 'BEARER_SECRET', 'EVIL_SECRET']) {
      expect(elsewhere).not.toContain(s);
      expect(String(calls.spawnArgs[0])).not.toContain(s);   // the source handed to the spawner
    }
    expect(calls.spawnArgs.length).toBe(1);
    expect(calls.ended).toBe(true);
    expect(calls.killed).toBe(true);
    expect(rec.ok).toBe(true);
    expect(rec.passedVia).toBe('stdin');
    expect(rec.cookieNamesTransferred).toEqual(['OWAAUTH', 'X-OWA-CANARY']);
    expect(rec.authMaterialNeeded.filter((n) => n === 'cookie').length).toBe(1);   // no duplicate push
    expect(rec.obtainableWithoutPage).toBe(false);                                // bearer came from the page
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

  it('the embedded child source reads input from stdin and host-filters', () => {
    const src = probe.TIER2_CHILD_SOURCE;
    expect(src).toMatch(/process\.stdin/);
    expect(src).toMatch(/host-blocked/);
    expect(src).toMatch(/outlook\.office/);
  });
});

describe('Tier 3 — reasoning only, no network', () => {
  it('returns ok:false with a disallowed-OAuth reason and makes no call', () => {
    const t3 = probe._tier3();
    expect(t3.tier).toBe(3);
    expect(t3.ok).toBe(false);
    expect(t3.whenRun).toBe('reasoning-only');
    expect(t3.reason).toMatch(/OAuth|device-code|app registration|Graph/i);
    expect(t3.ms).toBe(0);
  });
});

describe('Tier 1 — main-process net.request, read-only (B4)', () => {
  it('reports electron-unavailable without throwing when net/session are missing', async () => {
    const rec = await probe._tier1(null, silentLog(), 'before-window');
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe('electron-unavailable');
  });
  it('issues GET-only requests on the shared session with cookie jar options', async () => {
    const electron = fakeElectron({ responses: [{ status: 200, json: { value: [] } }] });
    await probe._tier1(electron, silentLog(), 'before-window');
    expect(electron._calls.length).toBe(1);
    const o = electron._calls[0].opts;
    expect(o.method).toBe('GET');
    expect(o.session).toBe(electron.session.defaultSession);
    expect(o.useSessionCookies).toBe(true);
    expect(o.redirect).toBe('manual');
    expect(o.url).not.toMatch(/send|reply|move|delete|update|create/i);
  });
  it('records a 200 as cookies-sufficient and shape-only response', async () => {
    const electron = fakeElectron({ responses: [{ status: 200, json: { value: [{ Id: 'AAMkSECRET' }] } }] });
    const rec = await probe._tier1(electron, silentLog(), 'after-window-closed');
    expect(rec.ok).toBe(true);
    expect(rec.obtainableWithoutPage).toBe(true);
    expect(JSON.stringify(rec)).not.toContain('AAMkSECRET');
  });
  it('handles a manual redirect to login: records status/toLogin, never the URL, and aborts', async () => {
    const electron = fakeElectron({ responses: [{ redirect: 'https://login.microsoftonline.com/common/oauth2/authorize?login_hint=jane@corp.test', status: 302 }] });
    const rec = await probe._tier1(electron, silentLog(), 'before-window');
    expect(rec.reason).toBe('redirect-to-login');
    expect(rec.attempts[0]).toMatchObject({ status: 302, redirect: true, toLogin: true });
    expect(electron._calls[0].aborted).toBe(true);
    expect(JSON.stringify(rec)).not.toMatch(/login\.microsoftonline|jane/);
    expect(rec.authMaterialNeeded).toContain('interactive-session');
  });
  it('inventories cookie NAMES for every Outlook host and sends a cookie canary as a header, without storing its value', async () => {
    const electron = fakeElectron({ cookies: SECRET_COOKIES, responses: [{ status: 401 }] });
    const rec = await probe._tier1(electron, silentLog(), 'before-window');
    expect(electron._cookieQueries.map((q) => q.domain).sort()).toEqual([...probe.OUTLOOK_HOSTS].sort());
    expect(rec.canaryAsCookie).toBe(true);
    expect(electron._calls[0].headers['x-owa-canary']).toBe('CANARY_SECRET');
    expect(rec.attempts[0].headerNamesSent).toContain('x-owa-canary');
    expect(rec.reason).toBe('unauthorized-needs-more-than-cookies');
    expect(rec.tokenLifetime.reason).toBe('no-bearer-observed');
    const blob = JSON.stringify(rec);
    for (const s of ['COOKIE_SECRET', 'CANARY_SECRET', 'EVIL_SECRET']) expect(blob).not.toContain(s);
  });
  it('reuses page-captured material when cookies fail, records exp shape and refresh re-run, never the token', async () => {
    const tok = fakeJwt(Math.floor(Date.now() / 1000) + 3600);
    const auth = probe.createAuthCapture();
    auth.observe({ request: { url: 'https://outlook.cloud.microsoft/owa/service.svc?action=FindItem', headers: { authorization: 'Bearer ' + tok } } });
    const electron = fakeElectron({ responses: [{ status: 401 }, { status: 200, json: { value: [] } }, { status: 200, json: { value: [] } }] });
    const rec = await probe._tier1(electron, silentLog(), 'after-window-closed', { auth, reuseDelayMs: 1, remaining: () => 200_000 });
    expect(rec.ok).toBe(true);
    expect(rec.reason).toBe('needs-page-captured-material-reusable');
    expect(rec.obtainableWithoutPage).toBe(false);
    expect(rec.host).toBe('outlook.cloud.microsoft');
    expect(rec.tokenLifetime.hasExp).toBe(true);
    expect(rec.reuseStillValidAfterDelay).toBe(true);
    expect(rec.attempts.map((a) => a.mode)).toEqual(['cookies-only', 'captured-reuse', 'captured-reuse-after-0s']);
    expect(rec.authMaterialNeeded.filter((n) => n === 'cookie').length).toBe(1);
    expect(JSON.stringify(rec)).not.toContain(tok);
    for (const c of electron._calls) expect(c.opts.method).toBe('GET');
  });
});

describe('run() — normal path closes the window, kills the child, writes redacted files', () => {
  it('writes the four files with no address/secret, closes the window and kills the child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-probe-'));
    const win = fakeWin();
    let openOpts = null;
    const openSession = (opts, driver) => new Promise((resolve) => {
      openOpts = opts;
      const ctx = fakeCtx(win, async () => ({ ok: true, count: 5, wouldMarkRead: false, status: 200 }));
      Promise.resolve(driver(ctx)).then(() => { win.close(); resolve({ settled: { authBlocked: false } }); });
    });
    const child = fakeChild();
    let stdin = '';
    child.stdin.write = (d) => { stdin += String(d); };
    const spawn = () => { setTimeout(() => { child.stdout.emit('data', JSON.stringify({ status: 401 })); child.emit('exit', 0); }, 0); return child; };
    const electron = fakeElectron({ cookies: SECRET_COOKIES, responses: [{ status: 401 }, { status: 401 }] });
    const logs = recordingLog();
    const res = await probe.run(Object.assign({ dir, log: logs, _electron: electron, _openSession: openSession, _spawnChild: spawn }, STUBS));
    expect(res.ok).toBe(true);
    expect(win.closed).toBe(true);
    expect(child.killed).toBe(true);
    expect(openOpts.signal).toBeDefined();
    expect(openOpts.warmupTimeoutMs + openOpts.timeoutMs).toBeLessThanOrEqual(5 * 60_000 - 75_000);
    expect(stdin).toContain('COOKIE_SECRET');                       // secret only ever went to stdin
    const files = fs.readdirSync(dir);
    for (const p of ['intel', 'api', 'network', 'windowless']) expect(files.some((f) => f.startsWith('owa-probe-' + p + '-'))).toBe(true);
    const all = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n') + logs.lines.join('\n');
    expect(all).not.toMatch(/@[\w.-]+\.[a-z]{2,}/i);
    for (const s of ['COOKIE_SECRET', 'CANARY_SECRET', 'EVIL_SECRET']) expect(all).not.toContain(s);
    const wl = JSON.parse(fs.readFileSync(path.join(dir, files.find((f) => f.startsWith('owa-probe-windowless-'))), 'utf8'));
    expect(wl.tiers.map((t) => t.whenRun)).toEqual(['before-window', 'after-window-closed', 'after-window-closed', 'reasoning-only']);
    expect(logs.lines.some((l) => l.startsWith('[owa-probe] done'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('run() — overall timeout aborts, closes the window and kills the child (B2/B6)', () => {
  async function runHanging(openSession, extra) {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-probe-to-'));
    const child = fakeChild();                                     // never exits on its own
    const spawn = () => child;
    const electron = fakeElectron({ responses: [{ status: 401 }, { status: 401 }] });
    const logs = recordingLog();
    const t0 = Date.now();
    try {
      let doneAt = null;
      const p = probe.run(Object.assign({ dir, log: logs, _electron: electron, _openSession: openSession, _spawnChild: spawn }, STUBS, extra || {}));
      p.then(() => { doneAt = Date.now(); });
      for (let i = 0; i < 80 && doneAt == null; i++) await vi.advanceTimersByTimeAsync(5_000);
      const res = await p;
      return { res, child, logs, elapsed: doneAt - t0, files: fs.readdirSync(dir) };
    } finally { vi.useRealTimers(); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('aborts openSession via the signal when the window phase overruns, then Tier 1(b) runs with the window closed', async () => {
    const win = fakeWin();
    let sawSignal = null;
    const openSession = (opts, driver) => new Promise((resolve) => {
      sawSignal = opts.signal;
      opts.signal.addEventListener('abort', () => { win.close(); resolve({ settled: { aborted: true } }); }, { once: true });
      driver(fakeCtx(win, () => new Promise(() => {})));          // every page call hangs forever
    });
    const { res, child, logs, elapsed, files } = await runHanging(openSession, { _reserveMs: 10_000 });
    expect(sawSignal.aborted).toBe(true);
    expect(win.closed).toBe(true);
    expect(child.killed).toBe(true);
    expect(res.summary.windowTimedOut).toBe(true);
    expect(res.summary.windowClosed).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(5 * 60_000);
    expect(files.some((f) => f.startsWith('owa-probe-windowless-'))).toBe(true);
    expect(logs.lines.some((l) => l.startsWith('[owa-probe] done'))).toBe(true);
  });

  it('closes the window itself when openSession ignores the abort, and still logs done', async () => {
    const win = fakeWin();
    const openSession = (_opts, driver) => new Promise(() => { driver(fakeCtx(win, () => new Promise(() => {}))); });
    const { res, child, logs, elapsed } = await runHanging(openSession);
    expect(win.closed).toBe(true);                                 // closed by the harness, not by openSession
    expect(child.killed).toBe(true);
    expect(res.summary.windowTimedOut).toBe(true);
    expect(elapsed).toBeLessThanOrEqual(5 * 60_000);
    expect(logs.lines.some((l) => l.startsWith('[owa-probe] done'))).toBe(true);
  });
});

describe('app.js wiring', () => {
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
  it('is gated on FLEET_OWA_PROBE_DIR and requires the dev module only inside the gate', () => {
    expect(APP_SRC).toMatch(/if \(process\.env\.FLEET_OWA_PROBE_DIR\)/);
    expect(APP_SRC).toContain("require('./dev/dev-owa-probe').start({ log })");
    // the require sits after the gate check (inert by default)
    const gate = APP_SRC.indexOf('process.env.FLEET_OWA_PROBE_DIR');
    const req = APP_SRC.indexOf("require('./dev/dev-owa-probe')");
    expect(gate).toBeGreaterThan(0);
    expect(req).toBeGreaterThan(gate);
  });
});

// ───────────────────────────── fakes ─────────────────────────────
const SECRET_COOKIES = [
  { name: 'OWAAUTH', value: 'COOKIE_SECRET', domain: '.outlook.office.com' },
  { name: 'X-OWA-CANARY', value: 'CANARY_SECRET', domain: 'outlook.office.com' },
  { name: 'tracker', value: 'EVIL_SECRET', domain: '.evil.example' },
];
const STUBS = {
  _triage: { loadResults: () => ({ emails: [], ranAt: null, authBlocked: false }), getConfig: () => ({ folders: ['Inbox'], maxEmails: 25, enabled: true }) },
  _intel: { getStatus: () => ({ owaAuth: { state: 'ok', blockedCount: 0 } }) },
  _canonAt: { parseCanonicalAt: () => ({ ms: 1 }) },
  _store: { load: () => ({ units: {} }) },
  _lane: { probeLane: async () => ({ ok: true }), state: () => ({ state: 'ok', checkedAt: null }) },
  _status: { gatewayFlags: () => ({ priorities: true, abortOnTimeout: true, dedupe: true, routerDecides: true }) },
  _domProbe: { domProbe: async () => ({ ok: true, authBlocked: false, rows: [], messages: [], tz: { compared: 0, match: null } }) },
};
function silentLog() { return { info() {}, warn() {}, error() {}, debug() {} }; }
function recordingLog() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, warn: push, error: push, debug: push };
}
function fakeJwt(exp) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'none' }) + '.' + b({ exp, aud: 'https://outlook.office.com' }) + '.sig';
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
function fakeWin() {
  const win = {
    closed: false,
    webContents: { debugger: { isAttached: () => true, sendCommand() {}, on() {}, attach() {} } },
    isDestroyed: () => win.closed,
    close: () => { win.closed = true; },
  };
  return win;
}
function fakeCtx(win, execJson) {
  return {
    win, execJson, exec: async () => 'yes', sleep: async () => {}, alive: () => !win.closed, stopped: () => win.closed,
    selectFolder: async () => 'selected', waitFor: async () => true, state: {},
  };
}
/**
 * fakeElectron({ cookies, responses }) — session.cookies.get honours {domain}/{url} filters; net.request
 * records options + headers and replays `responses` in order ({status,json} or {redirect,status}).
 */
function fakeElectron(o) {
  const { EventEmitter } = require('events');
  const cookies = (o && o.cookies) || [];
  const responses = ((o && o.responses) || []).slice();
  const calls = [];
  const cookieQueries = [];
  const domainMatch = (cd, host) => { const d = String(cd).replace(/^\./, ''); return host === d || host.endsWith('.' + d); };
  const defaultSession = {
    cookies: {
      get: async (filter) => {
        cookieQueries.push(filter || {});
        if (filter && filter.url) { const h = new URL(filter.url).hostname; return cookies.filter((c) => domainMatch(c.domain, h) || /evil/.test(c.domain)); }
        if (filter && filter.domain) return cookies.filter((c) => domainMatch(c.domain, filter.domain) || domainMatch(filter.domain, String(c.domain).replace(/^\./, '')));
        return cookies.slice();
      },
    },
  };
  const electron = {
    _calls: calls,
    _cookieQueries: cookieQueries,
    session: { defaultSession },
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
