// FEAT-A1 / AC-6: no sentinel (cookie, token, topic, URL, path) in any log line or IPC result across the
// transport / session / client / capture flows; no error/stack keys; plain throw -> INTERNAL; JSON.parse only in safe-json.js.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, settle, portalScript, srcPath } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_URL, SENTINEL_TOPIC, SENTINEL_TOKEN, SENTINEL_COOKIE, SENTINEL_PATH, SENTINEL_TRANSCRIPT, containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
// A2 flows read/write the store: keep it in a temp data dir.
const TMP = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zoom-redaction-'));
require('../src/config/paths').setDataDir(TMP);
const pf = require('../src/config/perf-flags');
const UP = 'https://amazon.zoom.us/meeting#/upcoming';

let fx; let logger; let restoreE; let handlers; let ctx; let S;

function setup(electronOpts = {}, seederImpl) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron(electronOpts);
  restoreE = installFakeElectron(require, fx.electron);
  const hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn() };
  hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, data: true, studio: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
  S = require('../src/zoom/data/session');
  S._setDeps({ seeder: { seedOrLegacy: seederImpl || (async () => ({})) }, auth: { injectCookies: async () => { throw new Error('cookie ' + SENTINEL_COOKIE); } } });
}

const call = (ch, payload) => handlers.get(ch)({ sender: ctx.mainWindow.webContents, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, payload);

function assertClean(results, { topicAllowedInResults = false } = {}) {
  expect(containsSentinel(logger.text())).toBe(null);
  for (const r of results) {
    const s = JSON.stringify(r);
    for (const n of ['SENTINEL_COOKIE', 'SENTINEL_TOKEN', 'SENTINEL_URL', 'SENTINEL_PATH', 'SENTINEL_TRANSCRIPT']) expect(s.includes(n)).toBe(false);
    if (!topicAllowedInResults) expect(s.includes('SENTINEL_TOPIC')).toBe(false);
    expect(r).not.toHaveProperty('error');
    expect(r).not.toHaveProperty('stack');
    expect(r).not.toHaveProperty('message');
  }
  for (const l of logger.lines) {
    for (const a of l.args) {
      if (a && typeof a === 'object') { expect(a).not.toHaveProperty('message'); expect(a).not.toHaveProperty('stack'); }
      expect(a instanceof Error).toBe(false);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
  try { S._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

describe('redaction (AC-6)', () => {
  it('net error whose message embeds a URL, cookie and path', async () => {
    setup({ net: () => ({ error: Object.assign(new Error('net::ERR ' + SENTINEL_URL + ' ' + SENTINEL_COOKIE + ' ' + SENTINEL_PATH), { code: 'ERR_FAILED' }) }) });
    const r = [await call('zoomData:status', { force: true }), await call('zoomData:recording-info')];
    expect(r[0]).toMatchObject({ ok: true, signedIn: null, code: 'NETWORK' });
    expect(r[1]).toEqual({ ok: false, code: 'NETWORK' });
    assertClean(r);
  });

  it('a response stream error and an HTML body quoting secrets', async () => {
    let n = 0;
    setup({ net: () => (++n === 1 ? { status: 200, body: 'x', responseError: new Error(SENTINEL_URL) } : { status: 200, body: '<html>' + SENTINEL_TOKEN + SENTINEL_TOPIC + '</html>' }) });
    const r = [await call('zoomData:status', { force: true }), await call('zoomData:status', { force: true })];
    expect(r[1]).toMatchObject({ code: 'SHAPE_UNRECOGNIZED' });
    assertClean(r);
  });

  it('a ZOOM_ERROR envelope never returns its message', async () => {
    setup({ net: () => ({ status: 200, body: { status: false, errorCode: 'E' + SENTINEL_TOKEN, errorMessage: SENTINEL_TOPIC } }) });
    const r = await call('zoomData:recording-info');
    expect(r.code).toBe('ZOOM_ERROR');
    expect(r).not.toHaveProperty('errorCode');   // the sentinel-bearing code fails the errorCode pattern
    assertClean([r]);
  });

  it('seeding failure, loadURL rejection and CDP getResponseBody rejection with sentinel messages', async () => {
    vi.useFakeTimers();
    const script = portalScript({ pages: { [UP]: [{ path: '/rest/meeting/list', postData: '{}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN, cookie: SENTINEL_COOKIE }, body: undefined }] } });
    setup({
      urlFor: script.urlFor,
      onLoad: (w, u) => {
        script.onLoad(w, u);
        if (u === UP) w.webContents.debugger.emit('message', {}, 'Network.loadingFinished', { requestId: 'req-1' });
      },
      cdp: { 'Network.getResponseBody': async () => { throw new Error('body ' + SENTINEL_TOPIC + ' ' + SENTINEL_URL); } },
    }, async () => { const e = new Error('ENOENT ' + SENTINEL_PATH); e.code = 'ENOENT'; throw e; });
    const r = await settle(vi, call('zoomData:list-meetings', { kind: 'upcoming', refresh: true }));
    expect(r).toEqual({ ok: false, code: 'CAPTURE_FAILED' });
    assertClean([r]);
  });

  it('loadURL rejection -> NETWORK with no URL in logs', async () => {
    vi.useFakeTimers();
    setup({ loadReject: (u) => Object.assign(new Error('ERR_NAME_NOT_RESOLVED ' + u + ' ' + SENTINEL_URL), { code: 'ERR_NAME_NOT_RESOLVED', errno: -105 }) });
    const r = await settle(vi, call('zoomData:list-meetings', { kind: 'upcoming' }));
    expect(r).toEqual({ ok: false, code: 'NETWORK' });
    assertClean([r]);
  });

  it('a successful capture logs counts only (topics, tokens and URLs stay out of logs)', async () => {
    vi.useFakeTimers();
    const script = portalScript({
      pages: { [UP]: [{ path: '/rest/meeting/list', postData: '{"q":"' + SENTINEL_TOKEN + '"}', headers: { 'zoom-csrftoken': SENTINEL_TOKEN, authorization: 'Bearer ' + SENTINEL_TOKEN }, body: { status: true, result: { list: [{ meetingId: '912345678', topic: SENTINEL_TOPIC, startTime: '2026-11-10T15:00:00Z', joinUrl: SENTINEL_URL }] } } }] },
    });
    setup(script);
    const r = await settle(vi, call('zoomData:list-meetings', { kind: 'upcoming' }));
    expect(r.ok).toBe(true);
    expect(r.items[0].topic).toBe(SENTINEL_TOPIC);   // topics go to the renderer only
    const j = await call('zoomData:join', { key: r.items[0].key });
    expect(j).toEqual({ ok: true });
    assertClean([r, j], { topicAllowedInResults: true });
  });

  it('openExternal rejecting with a URL message -> LAUNCH_FAILED, clean', async () => {
    vi.useFakeTimers();
    const script = portalScript({
      pages: { [UP]: [{ path: '/rest/meeting/list', postData: '{}', headers: { 'zoom-csrftoken': 't' }, body: { status: true, result: { list: [{ meetingId: '912345678', startTime: '2026-11-10T15:00:00Z' }] } } }] },
    });
    setup(Object.assign({}, script, { openExternalReject: new Error('cannot open ' + SENTINEL_URL) }));
    const r = await settle(vi, call('zoomData:list-meetings', { kind: 'upcoming' }));
    const j = await call('zoomData:join', { key: r.items[0].key });
    expect(j).toEqual({ ok: false, code: 'LAUNCH_FAILED' });
    assertClean([j]);
  });

  it('a handler throwing a plain Error -> {ok:false, code:"INTERNAL"}, logged as {name, code}', async () => {
    setup();
    require('../src/zoom/data/client').status = async () => { throw new Error('fs ' + SENTINEL_PATH + ' ' + SENTINEL_URL); };
    const r = await call('zoomData:status', {});
    expect(r).toEqual({ ok: false, code: 'INTERNAL' });
    assertClean([r]);
    expect(logger.lines.filter((l) => l.level === 'error').map((l) => l.args[1])).toEqual([{ name: 'Error' }]);
  });

  it('errors.toResult whitelists extras and never carries a message', () => {
    setup();
    const { ZoomError, toResult, MESSAGES } = require('../src/zoom/errors');
    const e = new ZoomError('HTTP_ERROR', { status: 500, url: SENTINEL_URL, message: SENTINEL_TOPIC, field: 'x', stack: 's' });
    expect(toResult(e)).toEqual({ ok: false, code: 'HTTP_ERROR', status: 500, field: 'x' });
    expect(e.message).toBe(MESSAGES.HTTP_ERROR);
    expect(toResult(new Error(SENTINEL_URL))).toEqual({ ok: false, code: 'INTERNAL' });
    expect(toResult('x')).toEqual({ ok: false, code: 'INTERNAL' });
    expect(new ZoomError('NOPE').code).toBe('INTERNAL');
    const { safeErr } = require('../src/zoom/redact');
    expect(safeErr(Object.assign(new TypeError(SENTINEL_URL), { code: 'E1' }))).toEqual({ name: 'TypeError', code: 'E1' });
  });

  it('static: no JSON.parse( under src/zoom/** outside safe-json.js', () => {
    const root = srcPath('zoom');
    const offenders = [];
    const walk = (d) => {
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.js') && f.name !== 'safe-json.js' && fs.readFileSync(p, 'utf8').includes('JSON.parse(')) offenders.push(p);
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'safe-json.js'), 'utf8')).toContain('JSON.parse(');
  });
});

describe('redaction: A2 transcript / summary / links flows (FEAT-A2)', () => {
  const REF = 'https://amazon.zoom.us/rec/download/' + SENTINEL_URL.split('/').pop() + '.vtt';
  const listRec = (key) => {
    const client = require('../src/zoom/data/client');
    client.recordingByKey.set(key, { key, idHash: 'h', topic: SENTINEL_TOPIC, startIso: '2026-11-01T10:00:00.000Z', hasTranscript: true });
    client.transcriptRefs.set(key, REF);
  };

  it('transcript GET failures (net error, offsite redirect, 403) never log the URL, redirect target or body', async () => {
    let n = 0;
    setup({ net: () => {
      n += 1;
      if (n === 1) return { error: Object.assign(new Error('net::ERR ' + SENTINEL_URL + ' ' + SENTINEL_COOKIE), { code: 'ERR_FAILED' }) };
      if (n === 2) return { redirect: 'https://evil.test/' + SENTINEL_URL };
      return { status: 403, headers: { 'content-type': 'text/html' }, body: '<html>' + SENTINEL_TRANSCRIPT + SENTINEL_TOKEN + '</html>' };
    } });
    listRec('k1');
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await call('zoomData:get-transcript', { key: 'k1' }));
    expect(r.map((x) => x.code)).toEqual(['NETWORK', 'TRANSCRIPT_UNAVAILABLE', 'SIGN_IN_REQUIRED']);
    assertClean(r);
  });

  it('a transcript body with sentinels reaches the renderer only; logs carry counts; summary + links results stay clean', async () => {
    const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nAlex: Unit 59083 needs brakes ' + SENTINEL_TRANSCRIPT + '\n';
    setup({ net: () => ({ status: 200, headers: { 'content-type': 'text/vtt' }, body: VTT }) });
    listRec('k1');
    const t = await call('zoomData:get-transcript', { key: 'k1' });
    expect(t.ok).toBe(true);
    expect(JSON.stringify(t)).toContain('SENTINEL_TRANSCRIPT');   // the transcript is the data the renderer asked for
    expect(containsSentinel(logger.text())).toBe(null);

    const store = require('../src/store');
    store.save('zoomSummaries', { version: 1, consentAt: '2026-11-01T00:00:00.000Z', items: {} });
    const prompts = [];
    const relay = {
      isolatedLaneAvailable: () => true,
      ask: vi.fn(async (p) => { prompts.push(p); throw new Error('relay failed ' + SENTINEL_TRANSCRIPT + ' ' + SENTINEL_URL); }),
      runWithTimeout: (run) => run(undefined),
    };
    require('../src/zoom/data/summary')._setDeps({ relay });
    const s1 = await call('zoomData:summarize', { key: 'k1' });
    expect(s1).toMatchObject({ ok: false, code: 'AI_UNAVAILABLE' });
    relay.ask = vi.fn(async (p) => { prompts.push(p); return JSON.stringify({ keyPoints: [{ text: 'Unit 59083 needs brakes', refs: [1] }], actionItems: [], decisions: [] }); });
    const s2 = await call('zoomData:summarize', { key: 'k1' });
    expect(s2.ok).toBe(true);
    for (const p of prompts) { expect(p).not.toContain('SENTINEL_TOPIC'); expect(p).not.toContain('SENTINEL_URL'); }
    const g = await call('zoomData:get-summary', { key: 'k1' });
    expect(g.ok).toBe(true);

    store.save('fleetData', { rows: [{ equipmentId: '59083', operator: 'AGNLI' }] });
    const l1 = await call('zoomData:link', { key: 'k1', kind: 'unit', id: '59083' });
    expect(l1.ok).toBe(true);
    const l2 = await call('zoomData:links');
    const l3 = await call('zoomData:link-targets', { kind: 'carrier', q: '' });
    const l4 = await call('zoomData:unlink', { key: 'k1', kind: 'unit', id: '59083' });
    assertClean([s1, s2, g, l3, l4]);
    assertClean([l1, l2], { topicAllowedInResults: true });   // the stored topic snapshot is for display
  });

  it('FEAT-B2: library import / read, launcher pick / run failures and preset names stay out of logs and error results', async () => {
    setup();
    const dir = path.join(TMP, 'SENTINEL_PATH_p4th9');
    fs.mkdirSync(dir, { recursive: true });
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 1)]);
    const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 1)]);
    fs.writeFileSync(path.join(dir, 'wrong.png'), JPEG);
    fs.writeFileSync(path.join(dir, 'thumbfail.png'), PNG);
    fx.electron.nativeImage.createFromPath = () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      resize: () => { throw Object.assign(new Error('thumb failed ' + SENTINEL_PATH), { code: 'EPERM' }); },
    });
    fx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(dir, 'wrong.png'), path.join(dir, 'gone.png'), path.join(dir, 'thumbfail.png')] });
    const lib = await call('zoomStudio:library-import', { kind: 'overlay' });
    expect(lib.rejected.map((x) => x.code)).toEqual(['INVALID_FILE', 'NOT_FOUND', 'IO_ERROR']);
    const read = await call('zoomStudio:library-read', { id: 'l_000000000000' });

    fx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(dir, 'Start Grim Reaper.bat')] });
    const pickMissing = await call('zoomStudio:launcher-pick');
    expect(pickMissing).toEqual({ ok: false, code: 'NOT_FOUND' });
    fs.writeFileSync(path.join(dir, 'Start Grim Reaper.bat'), '@echo off\r\n');
    const picked = await call('zoomStudio:launcher-pick');
    expect(picked.ok).toBe(true);    // the renderer displays the path it picked; it is never logged
    fx.electron.dialog.showMessageBox = async () => ({ response: 0 });
    fx.electron.shell.openPath = async (p) => 'cannot open ' + p + ' ' + SENTINEL_PATH;
    const run = await call('zoomStudio:launcher-run');
    expect(run).toEqual({ ok: false, code: 'LAUNCH_FAILED' });

    const p1 = await call('zoomStudio:preset-save', { preset: { name: SENTINEL_TOPIC } });
    expect(p1.ok).toBe(true);
    const p2 = await call('zoomStudio:preset-save', { preset: { name: SENTINEL_TOPIC } });
    const p3 = await call('zoomStudio:preset-save', { preset: { name: SENTINEL_TOPIC + 'x', adjust: { brightness: 999 } } });
    const p4 = await call('zoomStudio:preset-rename', { id: p1.preset.id, name: SENTINEL_TOPIC });
    expect(p2).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
    expect(p3).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'adjust.brightness' });
    assertClean([lib, read, pickMissing, run, p2, p3]);
    assertClean([p4], { topicAllowedInResults: true });   // the renamed preset itself goes back to the renderer
    expect(logger.text().includes('p4th9')).toBe(false);
    expect(logger.text().includes('Start Grim Reaper')).toBe(false);
  });

  it('import: an fs error on a sentinel path -> NOT_FOUND / INVALID_FILE with no path in logs or results', async () => {
    setup();
    listRec('k1');
    fx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SENTINEL_PATH.replace('file.txt', 'gone.vtt')] });
    const a = await call('zoomData:import-transcript', { key: 'k1' });
    fx.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SENTINEL_PATH] });
    const b = await call('zoomData:import-transcript', { key: 'k1' });
    expect(a).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(['NOT_FOUND', 'INVALID_FILE']).toContain(b.code);
    assertClean([a, b]);
  });
});
