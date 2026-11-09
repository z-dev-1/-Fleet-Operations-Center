// FEAT-A1 / AC-8, AC-24 (+ review F-2, F-13): the Zoom hub IPC — sender guard, area stubs, NOT_IMPLEMENTED,
// WRITE_DISABLED, validator matrix (nothing logged), join through the cached URL only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom, settle, portalScript } from './fixtures/zoom/fake-electron.js';
import { containsSentinel, SENTINEL_URL } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
// A2 channels read the store: keep it in a temp data dir (never the fake electron app path).
require('../src/config/paths').setDataDir(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'zoom-ipc-')));
const pf = require('../src/config/perf-flags');
const UP = 'https://amazon.zoom.us/meeting#/upcoming';

let fx; let logger; let restoreE; let hub; let handlers; let ctx;

function mainWin() {
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  return { isDestroyed: () => false, webContents: wc };
}

function setup(zoom, electronOpts = {}) {
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron(electronOpts);
  restoreE = installFakeElectron(require, fx.electron);
  hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  ctx = { mainWindow: mainWin(), sendToWindow: vi.fn() };
  const flags = pf.resolveZoomFlags({ zoom }, {});
  hub.registerZoomHubIPC(ctx, { flags, handle: (ch, fn) => handlers.set(ch, fn) });
  const S = require.cache[require.resolve('../src/zoom/data/session')] ? require('../src/zoom/data/session') : null;
  if (S) S._setDeps({ seeder: { seedOrLegacy: async () => ({}) }, auth: { injectCookies: async () => {} } });
}

function ev(over = {}) {
  const wc = ctx.mainWindow.webContents;
  return Object.assign({ sender: wc, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, over);
}

const call = (ch, payload, e) => handlers.get(ch)(e || ev(), payload);

afterEach(() => {
  vi.useRealTimers();
  try { require('../src/zoom/data/session')._resetForTests(); } catch (_) {}
  restoreE(); logger.restore(); freshZoom(require);
});

describe('sender guard (review F-13)', () => {
  it('accepts the app page in the main frame (file:, dist, and the Vite dev server)', async () => {
    setup({ enabled: true, data: true });
    for (const url of ['file:///C:/Fleet/renderer/src/index.html', 'file:///C:/Fleet/dist/renderer/index.html', 'http://localhost:5173/', 'http://localhost:5173/index.html']) {
      expect(await call('zoomHub:flags', undefined, ev({ senderFrame: { processId: 7, routingId: 3, url } }))).toMatchObject({ ok: true });
    }
  });

  const bad = {
    'null senderFrame': () => ev({ senderFrame: null }),
    'a subframe': () => ev({ senderFrame: { processId: 7, routingId: 99, url: 'file:///C:/Fleet/renderer/src/index.html' } }),
    'another process': () => ev({ senderFrame: { processId: 8, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }),
    'a webview guest (different webContents, same frame ids)': () => ev({ sender: { id: 2, mainFrame: { processId: 7, routingId: 3 } } }),
    'the AAP corp page in the main window': () => ev({ senderFrame: { processId: 7, routingId: 3, url: 'https://aap.amazon.com/page' } }),
    'a file: page elsewhere': () => ev({ senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/evil/index.html' } }),
    'a lookalike dev host': () => ev({ senderFrame: { processId: 7, routingId: 3, url: 'http://localhost:51730/' } }),
    'a throwing frame': () => Object.defineProperty({ sender: ctx.mainWindow.webContents }, 'senderFrame', { get() { throw new Error(SENTINEL_URL); } }),
  };
  for (const [name, mk] of Object.entries(bad)) {
    it(name + ' -> FORBIDDEN (warn with channel + code only)', async () => {
      setup({ enabled: true, data: true, studio: true });
      for (const ch of ['zoomHub:flags', 'zoomData:status', 'zoomData:links', 'zoomStudio:presets-list']) {
        expect(await call(ch, undefined, mk())).toEqual({ ok: false, code: 'FORBIDDEN' });
      }
      const warns = logger.lines.filter((l) => l.level === 'warn');
      expect(warns.length).toBe(4);
      for (const w of warns) expect(Object.keys(w.args[1]).sort()).toEqual(['channel', 'code']);
      expect(containsSentinel(logger.text())).toBe(null);
    });
  }

  it('a destroyed main window -> FORBIDDEN', async () => {
    setup({ enabled: true, data: true });
    ctx.mainWindow.isDestroyed = () => true;
    expect(await call('zoomHub:flags')).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
});

describe('area stubs', () => {
  it('zoomHub:flags returns effective values', async () => {
    setup({ enabled: true, data: true, write: true });
    expect(await call('zoomHub:flags')).toEqual({ ok: true, enabled: true, data: true, studio: false, write: true });
  });

  it('data OFF -> every zoomData:* is DISABLED; studio ON -> every zoomStudio:* is REAL (B1 + B2 landed, no NOT_IMPLEMENTED left)', async () => {
    setup({ enabled: true, studio: true });
    for (const ch of hub.CHANNELS.data) expect(await call(ch, {})).toEqual({ ok: false, code: 'DISABLED' });
    for (const ch of hub.CHANNELS.studio) {
      expect(typeof hub.REAL[ch]).toBe('function');
      const r = await call(ch, { bogus: 1 });   // an unknown prop is rejected by the channel validator, never NOT_IMPLEMENTED
      expect(r).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(await call('zoomStudio:media-status')).toEqual({ ok: true, camera: 'granted', microphone: 'granted' });
  });

  it('studio OFF -> every zoomStudio:* is DISABLED', async () => {
    setup({ enabled: true, data: true });
    for (const ch of hub.CHANNELS.studio) expect(await call(ch, {})).toEqual({ ok: false, code: 'DISABLED' });
  });

  it('data ON: every zoomData:* has a REAL entry (A2 landed); write-open -> WRITE_DISABLED unless write', async () => {
    setup({ enabled: true, data: true });
    for (const ch of hub.CHANNELS.data) expect(typeof hub.REAL[ch]).toBe('function');
    for (const ch of ['zoomData:get-transcript', 'zoomData:summarize', 'zoomData:link']) {
      expect(await call(ch, {})).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    }
    expect(await call('zoomData:write-open', { action: 'schedule' })).toEqual({ ok: false, code: 'WRITE_DISABLED' });
    expect(Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/data/write.js'))).toBe(false);
  });

  it('data + write ON: write-open reaches write.js (Cancel on the confirm -> CANCELLED, no window)', async () => {
    setup({ enabled: true, data: true, write: true });
    expect(await call('zoomData:write-open', { action: 'schedule' })).toEqual({ ok: false, code: 'CANCELLED' });
    expect(fx.calls.windows.length).toBe(0);
  });

  it('A1 REAL channels are registered through zh() and lazy-require their module', async () => {
    setup({ enabled: true, data: true });
    expect(Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/data/client.js'))).toBe(false);
    const r = await call('zoomData:status', {});
    expect(r).toMatchObject({ ok: true, signedIn: true });
    expect(Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/data/client.js'))).toBe(true);
  });
});

describe('validators (AC-24, review F-2)', () => {
  it('there is exactly one validator per channel', () => {
    setup({ enabled: true, data: true });
    const V = require('../src/zoom/validate').validators;
    const all = [].concat(hub.CHANNELS.hub, hub.CHANNELS.data, hub.CHANNELS.studio);
    expect(all.length).toBe(33);
    expect(Object.keys(V).sort()).toEqual(all.slice().sort());
  });

  const matrix = [
    ['zoomData:get-meeting', { key: 'ab$' }, 'key'],
    ['zoomData:get-meeting', { key: 'a'.repeat(129) }, 'key'],
    ['zoomData:get-meeting', { key: '' }, 'key'],
    ['zoomData:get-meeting', { key: 'abc', url: 'https://evil.test/' }, 'payload'],
    ['zoomData:get-meeting', 'abc', 'payload'],
    ['zoomData:get-meeting', ['abc'], 'payload'],
    ['zoomData:get-meeting', undefined, 'payload'],
    ['zoomData:join', { key: 'abc', url: SENTINEL_URL }, 'payload'],
    ['zoomData:list-meetings', { kind: 'all' }, 'kind'],
    ['zoomData:list-meetings', { kind: 'upcoming', refresh: 'yes' }, 'refresh'],
    ['zoomData:list-recordings', { refresh: 1 }, 'refresh'],
    ['zoomData:status', { force: 'true' }, 'force'],
    ['zoomData:status', { force: true, path: 'C:\\x' }, 'payload'],
    ['zoomData:connect', { x: 1 }, 'payload'],
    ['zoomData:recording-info', [], 'payload'],
  ];
  for (const [ch, payload, field] of matrix) {
    it(ch + ' ' + JSON.stringify(payload) + ' -> INVALID_INPUT field:' + field + ' (unlogged)', async () => {
      setup({ enabled: true, data: true });
      const r = await call(ch, payload);
      expect(r).toEqual({ ok: false, code: 'INVALID_INPUT', field });
      expect(logger.lines).toEqual([]);
      expect(fx.calls.net.length + fx.calls.windows.length + fx.calls.fromPartition.length).toBe(0);
    });
  }

  it('a payload with a non-plain prototype is rejected', async () => {
    setup({ enabled: true, data: true });
    class P { constructor() { this.key = 'abc'; } }
    expect(await call('zoomData:get-meeting', new P())).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
  });

  it('direct validator matrix for later-phase channels', () => {
    setup({ enabled: true, data: true });
    const V = require('../src/zoom/validate').validators;
    const bad = (ch, p, field) => { let e = null; try { V[ch](p); } catch (x) { e = x; } expect([ch, e && e.code, e && e.extra.field]).toEqual([ch, 'INVALID_INPUT', field]); };
    // F-2 targetId
    expect(V['zoomData:link']({ key: 'abc', kind: 'unit', id: '59083' })).toEqual({ key: 'abc', kind: 'unit', id: '59083' });
    expect(V['zoomData:unlink']({ key: 'abc', kind: 'carrier', id: ' agnli ' })).toEqual({ key: 'abc', kind: 'carrier', id: 'AGNLI' });
    expect(V['zoomData:link']({ key: 'abc', kind: 'carrier', id: 'AGNLI' }).id).toBe('AGNLI');
    bad('zoomData:link', { key: 'abc', kind: 'unit', id: 'ab' }, 'id');
    bad('zoomData:link', { key: 'abc', kind: 'carrier', id: 'toolongcarrier1' }, 'id');
    bad('zoomData:link', { key: 'abc', kind: 'unit', id: 'p_0123456789ab'.replace('p_', 'p/') }, 'id');
    bad('zoomData:link', { key: 'abc', kind: 'site', id: '59083' }, 'kind');
    bad('zoomData:link', { key: 'abc', kind: 'unit', id: '59083', url: 'x' }, 'payload');
    // transcript channels take {key} only, so a url field is rejected
    bad('zoomData:get-transcript', { key: 'abc', url: 'https://amazon.zoom.us/x.vtt' }, 'payload');
    bad('zoomData:import-transcript', { key: 'abc', path: 'C:\\x.vtt' }, 'payload');
    expect(V['zoomData:summarize']({ key: 'abc', force: true })).toEqual({ key: 'abc', force: true });
    bad('zoomData:link-targets', { kind: 'unit', q: 'x'.repeat(41) }, 'q');
    expect(V['zoomData:link-targets']({ kind: 'unit' })).toEqual({ kind: 'unit', q: '' });
    bad('zoomData:write-open', { action: 'delete-meeting' }, 'action');
    expect(V['zoomData:write-open']({ action: 'delete-recording', key: 'abc' })).toEqual({ action: 'delete-recording', key: 'abc' });
    // studio ids: p_/l_ + 12 hex, prefix must match the channel
    expect(V['zoomStudio:preset-delete']({ id: 'p_0123456789ab' })).toEqual({ id: 'p_0123456789ab' });
    bad('zoomStudio:preset-delete', { id: 'l_0123456789ab' }, 'id');
    bad('zoomStudio:library-read', { id: 'p_0123456789ab' }, 'id');
    bad('zoomStudio:library-read', { id: 'l_0123456789AB' }, 'id');
    expect(V['zoomStudio:preset-select']({ id: null })).toEqual({ id: null });
    bad('zoomStudio:preset-rename', { id: 'p_0123456789ab', name: '   ' }, 'name');
    bad('zoomStudio:preset-rename', { id: 'p_0123456789ab', name: 'a\u0007b' }, 'name');
    bad('zoomStudio:preset-rename', { id: 'p_0123456789ab', name: 'x'.repeat(61) }, 'name');
    expect(V['zoomStudio:library-rename']({ id: 'l_0123456789ab', name: '  Desk  ' }).name).toBe('Desk');
    bad('zoomStudio:preset-save', { preset: [] }, 'preset');
    expect(V['zoomStudio:preset-save']({ preset: { name: 'x' } })).toEqual({ preset: { name: 'x' } });
    bad('zoomStudio:library-import', { kind: 'video' }, 'kind');
    bad('zoomStudio:open-privacy', { which: 'screen' }, 'which');
    bad('zoomStudio:launcher-run', { path: 'C:\\evil.bat' }, 'payload');
    bad('zoomStudio:library-delete', { id: 'l_0123456789ab', force: 'y' }, 'force');
  });

  it('a plain exception inside a handler -> INTERNAL, logged as {name, code} only', async () => {
    setup({ enabled: true, data: true });
    const client = require('../src/zoom/data/client');
    client.recordingInfo = async () => { const e = new Error('boom ' + SENTINEL_URL); e.code = 'EBOOM'; throw e; };
    const r = await call('zoomData:recording-info');
    expect(r).toEqual({ ok: false, code: 'INTERNAL' });
    const err = logger.lines.find((l) => l.level === 'error');
    expect(err.args[1]).toEqual({ name: 'Error', code: 'EBOOM' });
    expect(containsSentinel(logger.text())).toBe(null);
  });
});

describe('A2 channels (FEAT-A2)', () => {
  const loaded = (name) => Object.keys(require.cache).some((k) => k.replace(/\\/g, '/').endsWith('/src/zoom/data/' + name + '.js'));

  it('get-transcript / import-transcript with a url or path field -> INVALID_INPUT field:payload, no request, unlogged', async () => {
    setup({ enabled: true, data: true });
    expect(await call('zoomData:get-transcript', { key: 'abc', url: 'https://amazon.zoom.us/rec/x.vtt' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(await call('zoomData:import-transcript', { key: 'abc', path: 'C:\\x.vtt' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(fx.calls.net.length + fx.calls.dialogs.length + fx.calls.fromPartition.length).toBe(0);
    expect(loaded('transcript')).toBe(false);
    expect(logger.lines).toEqual([]);
  });

  it('get-transcript for an unlisted key -> TRANSCRIPT_UNAVAILABLE reason not-listed, no request', async () => {
    setup({ enabled: true, data: true });
    expect(await call('zoomData:get-transcript', { key: 'unlisted' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-listed' });
    expect(fx.calls.net.length).toBe(0);
    expect(loaded('transcript')).toBe(true);
  });

  it('summarize without a loaded transcript -> TRANSCRIPT_UNAVAILABLE not-loaded; get-summary -> null; links -> {}', async () => {
    setup({ enabled: true, data: true });
    expect(await call('zoomData:summarize', { key: 'abc' })).toEqual({ ok: false, code: 'TRANSCRIPT_UNAVAILABLE', reason: 'not-loaded' });
    expect(await call('zoomData:get-summary', { key: 'abc' })).toEqual({ ok: true, summary: null });
    const l = await call('zoomData:links');
    expect(l.ok).toBe(true);
    expect(typeof l.links).toBe('object');
  });

  it('link / unlink validate kind + targetId before any store access', async () => {
    setup({ enabled: true, data: true });
    expect(await call('zoomData:link', { key: 'abc', kind: 'unit', id: 'ab' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'id' });
    expect(await call('zoomData:unlink', { key: 'abc', kind: 'site', id: '59083' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'kind' });
    expect(loaded('links')).toBe(false);
  });

  it('write-open: data on + write off -> WRITE_DISABLED and write.js never required', async () => {
    setup({ enabled: true, data: true });
    expect(await call('zoomData:write-open', { action: 'delete-recording', key: 'abc' })).toEqual({ ok: false, code: 'WRITE_DISABLED' });
    expect(loaded('write')).toBe(false);
    expect(fx.calls.dialogs.length + fx.calls.windows.length).toBe(0);
  });
});

describe('join (AC-8)', () => {
  it('opens only the URL cached from the listing; never a URL from the renderer', async () => {
    vi.useFakeTimers();
    const script = portalScript({
      pages: { [UP]: [{ path: '/rest/meeting/list', postData: '{}', headers: { 'zoom-csrftoken': 't' }, body: { status: true, result: { list: [{ meetingId: '912345678', topic: 'T', startTime: '2026-11-10T15:00:00Z', joinUrl: 'https://amazon.zoom.us/j/912345678?pwd=z' }] } } }] },
    });
    setup({ enabled: true, data: true }, script);
    const lr = await settle(vi, call('zoomData:list-meetings', { kind: 'upcoming' }));
    expect(lr.ok).toBe(true);
    const key = lr.items[0].key;
    expect(await call('zoomData:join', { key, url: 'https://evil.test/j/1' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'payload' });
    expect(await call('zoomData:join', { key: 'unknownKey' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fx.calls.openExternal.length).toBe(0);
    expect(await call('zoomData:join', { key })).toEqual({ ok: true });
    expect(fx.calls.openExternal).toEqual([['https://amazon.zoom.us/j/912345678?pwd=z']]);
    expect(await call('zoomData:get-meeting', { key })).toMatchObject({ ok: true, item: { key, hasJoin: true } });
  });
});
