// FEAT-A2 / AC-10, design §7.1a + §9, review F-3: VTT/TXT parsing, caps, the transcript file GET (host rule,
// redirects, content type, cap, URL never logged), the import dialog flow, and the LRU (get/import populate it
// with a source; peek never fetches; TTL).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, settle } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TRANSCRIPT, SENTINEL_PATH, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-transcript-'));
require('../src/config/paths').setDataDir(TMP);
const pf = require('../src/config/perf-flags');

const REF = 'https://amazon.zoom.us/rec/download/SENTINEL_URL_ref9.vtt';
const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nAlex Doe: Unit 59083 needs brakes by 5/12.\n\n2\n00:00:05.000 --> 00:00:07.500\n<v Sam Roe>We will tow it Friday.</v>\n';

let fx; let logger; let restoreE; let T; let client; let S;

function teardown() {
  try { if (S) S._resetForTests(); } catch (_) {}
  if (restoreE) restoreE();
  if (logger) logger.restore();
  restoreE = null; logger = null; S = null;
  freshZoom(require);
}

function setup(netScript) {
  teardown();
  logger = installFakeLogger(require);
  fx = createFakeElectron({ net: netScript });
  restoreE = installFakeElectron(require, fx.electron);
  S = require('../src/zoom/data/session');
  S._setDeps({ seeder: { seedOrLegacy: async () => ({}) }, auth: { injectCookies: async () => {} } });
  client = require('../src/zoom/data/client');
  T = require('../src/zoom/data/transcript');
}

function listRecording(key, url) {
  client.recordingByKey.set(key, { key, idHash: 'x', topic: 'T', startIso: '2026-11-01T10:00:00.000Z', hasTranscript: true });
  if (url) client.transcriptRefs.set(key, url);
}

afterEach(() => {
  vi.useRealTimers();
  teardown();
});

describe('parseVtt / parseTxt (pure)', () => {
  it('skips header / NOTE / STYLE, reads <v Name> and "Name:" speakers, drops empty cues, 1-based global i', () => {
    setup();
    const src = 'WEBVTT - x\n\nNOTE a comment\n\nSTYLE\n::cue { color: red }\n\n00:00:01.000 --> 00:00:02.000\nAlex: hello there\n\n' +
      'c2\n00:01:02.500 --> 00:01:03.000\n   \n\n00:01:04.000 --> 00:01:05.000\n<v.loud Sam Roe>Second <b>line</b></v>\n\n1:02:03.000 --> 1:02:04.000\nplain text';
    const r = T.parseVtt(src);
    expect(r.truncated).toBe(false);
    expect(r.segments).toEqual([
      { i: 1, startSec: 1, endSec: 2, speaker: 'Alex', text: 'hello there' },
      { i: 2, startSec: 64, endSec: 65, speaker: 'Sam Roe', text: 'Second line' },
      { i: 3, startSec: 3723, endSec: 3724, speaker: null, text: 'plain text' },
    ]);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(T.parseVtt(src).sha256).toBe(r.sha256);
    expect(T.parseVtt(src + '\n\n00:09:00.000 --> 00:09:01.000\nmore').sha256).not.toBe(r.sha256);
  });

  it('parseTxt: one segment per non-empty line, optional speaker, null timings', () => {
    setup();
    const r = T.parseTxt('\uFEFFAlex: first\r\n\r\nsecond line\n12: not a speaker\n');
    expect(r.segments).toEqual([
      { i: 1, startSec: null, endSec: null, speaker: 'Alex', text: 'first' },
      { i: 2, startSec: null, endSec: null, speaker: null, text: 'second line' },
      { i: 3, startSec: null, endSec: null, speaker: null, text: '12: not a speaker' },
    ]);
  });

  it('caps at 5000 segments with truncated:true', () => {
    setup();
    const lines = Array.from({ length: 5003 }, (_v, n) => 'line ' + n).join('\n');
    const r = T.parseTxt(lines);
    expect(r.segments.length).toBe(5000);
    expect(r.truncated).toBe(true);
    expect(r.segments[4999].i).toBe(5000);
    const cues = Array.from({ length: 5001 }, (_v, n) => '00:00:01.000 --> 00:00:02.000\ncue ' + n).join('\n\n');
    expect(T.parseVtt('WEBVTT\n\n' + cues)).toMatchObject({ truncated: true });
  });
});

describe('transcript file GET (design §7.1a)', () => {
  it('unknown key -> not-listed; offsite / http ref -> offsite; no request either way', async () => {
    setup();
    expect(await T.getTranscript({ key: 'nope' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-listed' });
    listRecording('k1', 'https://evil.test/rec/a.vtt');
    expect(await T.getTranscript({ key: 'k1' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'offsite' });
    client.transcriptRefs.set('k1', 'http://amazon.zoom.us/rec/a.vtt');
    expect(await T.getTranscript({ key: 'k1' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'offsite' });
    expect(fx.calls.net.length).toBe(0);
  });

  it('a text/vtt body parses, populates the LRU with source portal, and the URL is never logged', async () => {
    setup(() => ({ status: 200, headers: { 'content-type': ['text/vtt; charset=utf-8'] }, body: VTT }));
    listRecording('k1', REF);
    const r = await T.getTranscript({ key: 'k1' });
    expect(r.ok).toBe(true);
    expect(r.transcript.source).toBe('portal');
    expect(r.transcript.segments.map((s) => s.speaker)).toEqual(['Alex Doe', 'Sam Roe']);
    expect(fx.calls.net.length).toBe(1);
    const req = fx.calls.net[0];
    expect(req.method).toBe('GET');
    expect(req.options).toMatchObject({ redirect: 'manual', useSessionCookies: true, credentials: 'include' });
    expect(req.headers.Accept).toBe('text/vtt, text/plain, */*');
    // second call is an LRU hit (no request); peek returns the same entry and never fetches
    expect((await T.getTranscript({ key: 'k1' })).transcript.sha256).toBe(r.transcript.sha256);
    expect(T.peek('k1')).toMatchObject({ source: 'portal', sha256: r.transcript.sha256, truncated: false });
    expect(fx.calls.net.length).toBe(1);
    const line = logger.lines.find((l) => l.args[1] && l.args[1].op === 'transcript-get');
    expect(Object.keys(line.args[1]).sort()).toEqual(['bytes', 'code', 'idHash', 'ms', 'op', 'status']);
    expect(logger.text()).not.toContain('SENTINEL_URL');
    expect(logger.text()).not.toContain('brakes');
  });

  it('redirects: Zoom-host hops are followed (max 3); offsite, too many and sign-in hops stop', async () => {
    let hops = 0;
    setup(() => (++hops <= 2 ? { redirect: 'https://ssrweb.zoom.us/file/' + hops } : { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'Alex: hi' }));
    listRecording('k1', REF);
    const ok = await T.getTranscript({ key: 'k1' });
    expect(ok.ok).toBe(true);
    expect(fx.calls.net.length).toBe(1);   // one request, followed twice
    expect(fx.calls.net[0].followed).toBe(2);
    expect(fx.calls.net[0].urls).toEqual([REF, 'https://ssrweb.zoom.us/file/1', 'https://ssrweb.zoom.us/file/2']);

    setup(() => ({ redirect: 'https://ssrweb.zoom.us/again' }));
    listRecording('k2', REF);
    expect(await T.getTranscript({ key: 'k2' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'too-many-redirects' });
    expect(fx.calls.net[0].followed).toBe(3);

    setup(() => ({ redirect: 'https://cdn.evil.test/x.vtt' }));
    listRecording('k3', REF);
    expect(await T.getTranscript({ key: 'k3' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'offsite-redirect' });
    expect(fx.calls.net[0].followed || 0).toBe(0);
    expect(fx.calls.net[0].aborted).toBe(true);

    setup(() => ({ redirect: 'https://midway-auth.amazon.com/login?next=x' }));
    listRecording('k4', REF);
    expect(await T.getTranscript({ key: 'k4' })).toEqual({ ok: false, code: 'SIGN_IN_REQUIRED' });
    expect(logger.text()).not.toContain('midway-auth');
  });

  it('content type rule, 401, cap and timeout', async () => {
    vi.useFakeTimers();
    setup(() => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"a":1}' }));
    listRecording('k1', REF);
    expect(await settle(vi, T.getTranscript({ key: 'k1' }))).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-transcript' });
    setup(() => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: VTT }));
    listRecording('k1', REF);
    expect((await settle(vi, T.getTranscript({ key: 'k1' }))).ok).toBe(true);
    setup(() => ({ status: 401, headers: { 'content-type': 'text/plain' }, body: 'no' }));
    listRecording('k1', REF);
    expect(await settle(vi, T.getTranscript({ key: 'k1' }))).toMatchObject({ ok: false, code: 'SIGN_IN_REQUIRED', status: 401 });
    setup(() => ({ status: 200, headers: { 'content-type': 'text/vtt' }, chunks: [Buffer.alloc(1024 * 1024, 65), Buffer.alloc(1024 * 1024 + 10, 65)] }));
    listRecording('k1', REF);
    expect(await settle(vi, T.getTranscript({ key: 'k1' }))).toMatchObject({ ok: false, code: 'RESPONSE_TOO_LARGE' });
    setup(() => ({ hang: true }));
    listRecording('k1', REF);
    expect(await settle(vi, T.getTranscript({ key: 'k1' }))).toEqual({ ok: false, code: 'TIMEOUT' });
  });
});

describe('importTranscript (main-process dialog)', () => {
  function pick(filePaths) { fx.electron.dialog.showOpenDialog = vi.fn(async () => ({ canceled: !filePaths, filePaths: filePaths || [] })); }
  const ctx = { mainWindow: { isDestroyed: () => false } };

  it('unknown key -> NOT_FOUND before any dialog', async () => {
    setup();
    pick([path.join(TMP, 'a.vtt')]);
    expect(await T.importTranscript({ key: 'unknown' }, { ctx })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.electron.dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it('cancel -> CANCELLED; the dialog has the vtt/txt filter and the main window parent', async () => {
    setup();
    listRecording('k1');
    pick(null);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'CANCELLED' });
    expect(fx.electron.dialog.showOpenDialog).toHaveBeenCalledWith(ctx.mainWindow, { properties: ['openFile'], filters: [{ name: 'Transcript', extensions: ['vtt', 'txt'] }] });
  });

  it('bad extension, > 2 MB, invalid UTF-8, empty -> INVALID_FILE; ENOENT -> NOT_FOUND with no path logged', async () => {
    setup();
    listRecording('k1');
    const bin = path.join(TMP, 'x.docx'); fs.writeFileSync(bin, 'Alex: hi');
    pick([bin]);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'INVALID_FILE' });
    const big = path.join(TMP, 'big.txt'); fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    pick([big]);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'INVALID_FILE' });
    const bad = path.join(TMP, 'bad.vtt'); fs.writeFileSync(bad, Buffer.from([0x57, 0x45, 0xff, 0xfe, 0x0a]));
    pick([bad]);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'INVALID_FILE' });
    const empty = path.join(TMP, 'empty.txt'); fs.writeFileSync(empty, '\n\n  \n');
    pick([empty]);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'INVALID_FILE' });
    pick([path.join(TMP, 'SENTINEL_PATH_p4th9', 'gone.vtt')]);
    expect(await T.importTranscript({ key: 'k1' }, { ctx })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(containsSentinel(logger.text())).toBe(null);
    expect(logger.text()).not.toContain(TMP.replace(/\\/g, '\\\\'));
    expect(SENTINEL_PATH).toContain('SENTINEL_PATH');
  });

  it('a valid file populates the LRU with source import (also for a key known only from zoomLinks)', async () => {
    setup();
    const f = path.join(TMP, 'ok.vtt'); fs.writeFileSync(f, VTT.replace('brakes', SENTINEL_TRANSCRIPT));
    require('../src/store').save('zoomLinks', { version: 1, links: { linkedOnly: { topic: null, startIso: null, kind: 'recording', targets: [{ kind: 'unit', id: '59083', linkedAt: 'x' }] } } });
    pick([f]);
    const r = await T.importTranscript({ key: 'linkedOnly' }, { ctx });
    expect(r.ok).toBe(true);
    expect(r.transcript.source).toBe('import');
    expect(r.transcript.segments.length).toBe(2);
    expect(T.peek('linkedOnly')).toMatchObject({ source: 'import', sha256: r.transcript.sha256 });
    expect(fx.calls.net.length).toBe(0);
    expect(logger.text()).not.toContain('SENTINEL_TRANSCRIPT');
    require('../src/store').save('zoomLinks', { version: 1, links: {} });
  });
});

describe('LRU (review F-3)', () => {
  it('peek never fetches; entries expire after 30 min; at most 5 entries', async () => {
    vi.useFakeTimers();
    setup(() => ({ status: 200, headers: { 'content-type': 'text/vtt' }, body: VTT }));
    expect(T.peek('k1')).toBe(null);
    expect(fx.calls.net.length).toBe(0);
    for (let n = 1; n <= 6; n++) listRecording('k' + n, REF);
    for (let n = 1; n <= 6; n++) await settle(vi, T.getTranscript({ key: 'k' + n }));
    expect(T.peek('k1')).toBe(null);           // evicted (oldest of 6)
    expect(T.peek('k6')).not.toBe(null);
    vi.advanceTimersByTime(T.LRU_TTL_MS + 1000);
    expect(T.peek('k6')).toBe(null);
    expect(fx.calls.net.length).toBe(6);
  });
});

describe('IPC (design §20 row)', () => {
  it('a get-transcript payload with url -> INVALID_INPUT field:payload and no request', async () => {
    setup();
    const hub = require('../src/ipc/zoom-hub');
    const handlers = new Map();
    const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
    const c = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn() };
    hub.registerZoomHubIPC(c, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, data: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
    listRecording('k1', REF);
    const ev = { sender: wc, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } };
    expect(await handlers.get('zoomData:get-transcript')(ev, { key: 'k1', url: REF })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(fx.calls.net.length).toBe(0);
  });
});
