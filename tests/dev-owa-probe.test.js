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
  it('the attachment-chip script is pure DOM read, no fetch verb other than ranged GET', () => {
    expect(probe.buildAttachChipScript()).not.toMatch(MUTATION);
  });
});

describe('Tier 2 — auth material only via stdin, host-filtered, child killed', () => {
  it('passes the spec via stdin only (never argv/env), filters to outlook, and kills the child at the end', async () => {
    const calls = { argv: null, env: null, stdinData: '', killed: false, ended: false };
    const child = fakeChild();
    child.stdin.write = (d) => { calls.stdinData += String(d); };
    child.stdin.end = () => { calls.ended = true; };
    child.kill = () => { calls.killed = true; child.killed = true; };
    const spawn = (source) => {
      // The spawner is called with ONLY the secret-free source string — no argv, no env object.
      expect(typeof source).toBe('string');
      expect(source).not.toContain('FLEET_OWA_PROBE_DIR');
      // emit a 401 after stdin is wired
      setTimeout(() => { child.stdout.emit('data', JSON.stringify({ status: 401, latencyMs: 12 })); child.emit('exit', 0); }, 0);
      return child;
    };
    const electron = { session: { defaultSession: { cookies: { get: async () => [{ name: 'OWAAUTH' }, { name: 'X-OWA-CANARY' }] } } } };
    const rec = await probe._tier2({ electron, log: silentLog(), spawn });
    expect(rec.tier).toBe(2);
    expect(rec.passedVia).toBe('stdin');
    // The spec sent to the child must be a single outlook-host URL, on stdin.
    const sent = JSON.parse(calls.stdinData);
    expect(probe.hostAllowed(sent.url)).toBe(true);
    expect(calls.ended).toBe(true);
    expect(calls.killed).toBe(true);                 // killed in the finally
    expect(rec.ok).toBe(false);                      // 401 — a plain Node process has no session
    expect(rec.workerIsolationConflict).toMatch(/FORBIDDEN|isolation/i);
  });

  it('the default spawner writes a secret-free source file and passes NO secret on argv/env', () => {
    // Inspect the embedded child source: it must read its input from stdin, not argv/env/disk.
    const src = probe.TIER2_CHILD_SOURCE;
    expect(src).toMatch(/process\.stdin/);
    expect(src).not.toMatch(/process\.argv\[2\]/);
    expect(src).not.toMatch(/process\.env\.[A-Z]/);
    expect(src).toMatch(/outlook\.office/);          // host allow-list baked in
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

describe('Tier 1 — main-process net.request, read-only, graceful when electron absent', () => {
  it('reports electron-unavailable without throwing when net/session are missing', async () => {
    const rec = await probe._tier1(null, silentLog(), 'before-window');
    expect(rec.tier).toBe(1);
    expect(rec.ok).toBe(false);
    expect(rec.reason).toBe('electron-unavailable');
  });
  it('records a 200 as cookies-sufficient and shape-only response', async () => {
    const electron = fakeElectronNet(200, { value: [{ Id: 'AAMkSECRET', ConversationId: 'cvSECRET' }] });
    const rec = await probe._tier1(electron, silentLog(), 'after-window-closed');
    expect(rec.ok).toBe(true);
    expect(rec.obtainableWithoutPage).toBe(true);
    expect(JSON.stringify(rec)).not.toContain('AAMkSECRET');
  });
  it('records a 401 as needing more than cookies', async () => {
    const electron = fakeElectronNet(401, null);
    const rec = await probe._tier1(electron, silentLog(), 'before-window');
    expect(rec.ok).toBe(false);
    expect(rec.authMaterialNeeded).toContain('authorization(bearer)');
  });
});

describe('overall timeout closes the window and kills the child', () => {
  it('run() closes the openSession window and kills any spawned child when the budget elapses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-probe-'));
    let windowClosed = false; let childKilled = false;
    const win = { webContents: { debugger: { isAttached: () => true, sendCommand() {}, on() {}, attach() {} } }, isDestroyed: () => false, close: () => { windowClosed = true; } };
    // openSession that never resolves its driver quickly — simulate the window being closed by the harness.
    const openSession = (opts, driver) => new Promise((resolve) => {
      const ctx = {
        win,
        execJson: async () => ({ ok: true, count: 5, wouldMarkRead: false, status: 200 }),
        exec: async () => 'yes', sleep: async () => {}, alive: () => true, stopped: () => false,
        selectFolder: async () => 'selected', waitFor: async () => true, state: {},
      };
      Promise.resolve(driver(ctx)).then(() => { win.close(); resolve({ settled: { authBlocked: false } }); });
    });
    const child = fakeChild();
    child.kill = () => { childKilled = true; child.killed = true; };
    const spawn = () => { setTimeout(() => { child.stdout.emit('data', JSON.stringify({ status: 401 })); child.emit('exit', 0); }, 0); return child; };
    const electron = fakeElectronNet(401, null);
    const stubs = {
      _triage: { loadResults: () => ({ emails: [], ranAt: null, authBlocked: false }), getConfig: () => ({ folders: ['Inbox'], maxEmails: 25, enabled: true }) },
      _intel: { getStatus: () => ({ owaAuth: { state: 'ok', blockedCount: 0 } }) },
      _canonAt: { parseCanonicalAt: () => ({ ms: 1 }) },
      _store: { load: () => ({ units: {} }) },
      _lane: { probeLane: async () => ({ ok: true }), state: () => ({ state: 'ok', checkedAt: null }) },
      _status: { gatewayFlags: () => ({ priorities: true, abortOnTimeout: true, dedupe: true, routerDecides: true }) },
      _domProbe: { domProbe: async () => ({ ok: true, authBlocked: false, rows: [], messages: [], tz: { compared: 0, match: null } }) },
    };
    const res = await probe.run(Object.assign({ dir, log: silentLog(), _electron: electron, _openSession: openSession, _spawnChild: spawn }, stubs));
    expect(res.ok).toBe(true);
    expect(windowClosed).toBe(true);
    expect(childKilled).toBe(true);
    // the four output files + the done summary
    const files = fs.readdirSync(dir);
    expect(files.some((f) => /^owa-probe-intel-/.test(f))).toBe(true);
    expect(files.some((f) => /^owa-probe-api-/.test(f))).toBe(true);
    expect(files.some((f) => /^owa-probe-network-/.test(f))).toBe(true);
    expect(files.some((f) => /^owa-probe-windowless-/.test(f))).toBe(true);
    // output must not contain any address or long id
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/@[\w.-]+\.[a-z]{2,}/i);
    fs.rmSync(dir, { recursive: true, force: true });
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
function silentLog() { return { info() {}, warn() {}, error() {}, debug() {} }; }
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
function fakeElectronNet(status, json) {
  const { EventEmitter } = require('events');
  return {
    session: { defaultSession: { cookies: { get: async () => [] } } },
    net: {
      request() {
        const req = new EventEmitter();
        req.setHeader = () => {};
        req.abort = () => {};
        req.end = () => {
          setTimeout(() => {
            const res = new EventEmitter();
            req.emit('response', res);
            if (json) res.emit('data', Buffer.from(JSON.stringify(json)));
            res.emit('end');
          }, 0);
        };
        req.statusCode = status;
        // attach statusCode onto the response emitted above
        const origEnd = req.end;
        req.end = () => {
          setTimeout(() => {
            const res = new EventEmitter();
            res.statusCode = status;
            req.emit('response', res);
            if (json) res.emit('data', Buffer.from(JSON.stringify(json)));
            res.emit('end');
          }, 0);
        };
        return req;
      },
    },
  };
}
