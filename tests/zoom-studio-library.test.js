// FEAT-B2 / AC-17 (design §15.3, §20 row): the Studio image library through the hub — magic bytes vs
// extension, nativeImage for PNG/JPEG only, WebP sizes from the VP8 / VP8L / VP8X headers, the 10-file
// and 4096-px caps, fs error mapping without paths in logs, thumbnails, IN_USE and force delete.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { containsSentinel } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const cjsFs = require('fs');
const pf = require('../src/config/perf-flags');

// ── byte fixtures ──────────────────────────────────────────────────────────
const pad = (b, n = 96) => Buffer.concat([b, Buffer.alloc(Math.max(0, n - b.length), 7)]);
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]));
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]));
function riff(fourcc) {
  const b = Buffer.alloc(64, 0);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(56, 4); b.write('WEBP', 8, 'ascii'); b.write(fourcc, 12, 'ascii'); b.writeUInt32LE(40, 16);
  return b;
}
function vp8(w, h) {
  const b = riff('VP8 ');
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
}
function vp8l(w, h) {
  const b = riff('VP8L');
  b[20] = 0x2f;
  b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
}
function vp8x(w, h) {
  const b = riff('VP8X');
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
}

let TMP; let SRC; let logger; let restoreE; let handlers; let ctx; let fx; let native;

function setup({ sizeFor, resizeThrows } = {}) {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-lib-'));
  // Every source path carries the path sentinel: no log line may contain it.
  SRC = path.join(TMP, 'SENTINEL_PATH_p4th9');
  fs.mkdirSync(SRC);
  require('../src/config/paths').setDataDir(path.join(TMP, 'data'));
  freshZoom(require);
  logger = installFakeLogger(require);
  fx = createFakeElectron();
  native = [];
  fx.electron.nativeImage.createFromPath = (p) => {
    native.push(p);
    const ext = path.extname(p).toLowerCase();
    if (ext === '.webp') throw new Error('nativeImage must not be used for WebP');
    const size = sizeFor ? sizeFor(p) : { width: 640, height: 360 };
    return {
      isEmpty: () => !size,
      getSize: () => size || { width: 0, height: 0 },
      resize: (o) => {
        if (resizeThrows) throw new Error('resize failed ' + p);
        expect(o).toEqual({ width: 160, quality: 'good' });
        return { toPNG: () => Buffer.concat([PNG.subarray(0, 8), Buffer.from('THUMB')]) };
      },
    };
  };
  restoreE = installFakeElectron(require, fx.electron);
  const hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => {} };
  hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, studio: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
}

const call = (ch, payload) => handlers.get(ch)({ sender: ctx.mainWindow.webContents, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, payload);
const put = (name, bytes) => { const p = path.join(SRC, name); fs.writeFileSync(p, bytes); return p; };
const pick = (files) => { fx.electron.dialog.showOpenDialog = vi.fn(async () => ({ canceled: false, filePaths: files })); };
const libDir = () => path.join(TMP, 'data', 'zoom-studio', 'library');

beforeEach(() => {});
afterEach(() => {
  vi.restoreAllMocks();
  restoreE(); logger.restore(); freshZoom(require);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function assertNoPathInLogs() {
  expect(containsSentinel(logger.text())).toBe(null);
  expect(logger.text().includes('p4th9')).toBe(false);
}

describe('image-sniff (pure)', () => {
  it('sniff + webpSize for VP8 / VP8L / VP8X; anything else -> null', () => {
    setup();
    const S = require('../src/zoom/studio/image-sniff');
    expect(S.sniff(PNG)).toBe('png');
    expect(S.sniff(JPEG)).toBe('jpeg');
    expect(S.sniff(vp8(10, 10))).toBe('webp');
    expect(S.sniff(Buffer.from('GIF89a'))).toBe(null);
    expect(S.webpSize(vp8(640, 480))).toEqual({ w: 640, h: 480 });
    expect(S.webpSize(vp8l(1000, 3))).toEqual({ w: 1000, h: 3 });
    expect(S.webpSize(vp8l(16384, 16384))).toEqual({ w: 16384, h: 16384 });
    expect(S.webpSize(vp8x(4096, 2160))).toEqual({ w: 4096, h: 2160 });
    expect(S.webpSize(vp8(0, 10))).toBe(null);
    const badStart = vp8(10, 10); badStart[23] = 0;
    expect(S.webpSize(badStart)).toBe(null);
    const badSig = vp8l(10, 10); badSig[20] = 0;
    expect(S.webpSize(badSig)).toBe(null);
    expect(S.webpSize(riff('ALPH'))).toBe(null);
    expect(S.webpSize(vp8(10, 10).subarray(0, 29))).toBe(null);
    expect(S.webpSize(PNG)).toBe(null);
  });
});

describe('library import (AC-17)', () => {
  it('PNG + JPEG via nativeImage with thumbnails; WebP from header bytes with thumb:null and no nativeImage', async () => {
    setup();
    const files = [put('desk.png', PNG), put('logo.jpg', JPEG), put('a.webp', vp8(800, 600)), put('b.webp', vp8l(320, 240)), put('c.webp', vp8x(1920, 1080))];
    const before = files.map((f) => [fs.readFileSync(f), fs.statSync(f).mtimeMs]);
    pick(files);
    const r = await call('zoomStudio:library-import', { kind: 'background' });
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([]);
    expect(r.items.map((i) => [i.name, i.format, i.w, i.h, i.kind])).toEqual([
      ['desk', 'png', 640, 360, 'background'], ['logo', 'jpeg', 640, 360, 'background'],
      ['a', 'webp', 800, 600, 'background'], ['b', 'webp', 320, 240, 'background'], ['c', 'webp', 1920, 1080, 'background'],
    ]);
    for (const it of r.items) expect(it.id).toMatch(/^l_[0-9a-f]{12}$/);
    expect(r.items[0].thumb).toMatch(/^data:image\/png;base64,/);
    expect(r.items[1].thumb).toMatch(/^data:image\/png;base64,/);
    expect(r.items.slice(2).map((i) => i.thumb)).toEqual([null, null, null]);
    expect(native.map((p) => path.extname(p))).toEqual(['.png', '.jpg']);
    // The dialog: main window parent, multi-select, the image filter.
    expect(fx.electron.dialog.showOpenDialog).toHaveBeenCalledWith(ctx.mainWindow, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    // Copies + thumbnails in <dataDir>/zoom-studio/library; sources untouched.
    const names = fs.readdirSync(libDir()).sort();
    expect(names.length).toBe(7);
    expect(names.filter((n) => n.endsWith('.thumb.png')).length).toBe(2);
    expect(fs.readFileSync(path.join(libDir(), r.items[0].id + '.png'))).toEqual(PNG);
    files.forEach((f, i) => { expect(fs.readFileSync(f)).toEqual(before[i][0]); expect(fs.statSync(f).mtimeMs).toBe(before[i][1]); });
    // list / read / rename
    const l = await call('zoomStudio:library-list');
    expect(l.items.length).toBe(5);
    expect(l.items[0]).toEqual(r.items[0]);
    const rd = await call('zoomStudio:library-read', { id: r.items[2].id });
    expect(rd).toEqual({ ok: true, dataUrl: 'data:image/webp;base64,' + vp8(800, 600).toString('base64'), w: 800, h: 600 });
    expect(await call('zoomStudio:library-read', { id: 'l_000000000000' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    const rn = await call('zoomStudio:library-rename', { id: r.items[0].id, name: ' Office wall ' });
    expect(rn.ok).toBe(true);
    expect(rn.item.name).toBe('Office wall');
    expect(await call('zoomStudio:library-rename', { id: 'l_000000000000', name: 'x' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    assertNoPathInLogs();
  });

  it('a .png whose bytes are not PNG, a corrupt WebP header, a > 4096 canvas and an empty decode -> INVALID_FILE', async () => {
    setup({ sizeFor: (p) => (p.includes('huge') ? { width: 5000, height: 100 } : (p.includes('empty') ? null : { width: 10, height: 10 })) });
    const corrupt = vp8(10, 10); corrupt[24] = 0;
    pick([
      put('fake.png', JPEG), put('fake.webp', PNG), put('corrupt.webp', corrupt), put('big.webp', vp8x(5000, 100)),
      put('huge.png', PNG), put('empty.jpg', JPEG), put('notes.gif', PNG), put('zero.png', Buffer.alloc(0)), put('ok.png', PNG),
    ]);
    const r = await call('zoomStudio:library-import', { kind: 'overlay' });
    expect(r.ok).toBe(true);
    expect(r.rejected).toEqual([
      { name: 'fake.png', code: 'INVALID_FILE' }, { name: 'fake.webp', code: 'INVALID_FILE' }, { name: 'corrupt.webp', code: 'INVALID_FILE' },
      { name: 'big.webp', code: 'INVALID_FILE' }, { name: 'huge.png', code: 'INVALID_FILE' }, { name: 'empty.jpg', code: 'INVALID_FILE' },
      { name: 'notes.gif', code: 'INVALID_FILE' }, { name: 'zero.png', code: 'INVALID_FILE' },
    ]);
    expect(r.items.map((i) => i.name)).toEqual(['ok']);
    expect(native.some((p) => p.endsWith('.webp'))).toBe(false);
    assertNoPathInLogs();
  });

  it('12 selected -> the first 10 imported, the last 2 LIMIT_REACHED; the library total is capped at 100', async () => {
    setup();
    const files = [];
    for (let i = 0; i < 12; i++) files.push(put('img' + i + '.png', PNG));
    pick(files);
    const r = await call('zoomStudio:library-import', { kind: 'avatar' });
    expect(r.items.length).toBe(10);
    expect(r.items.map((i) => i.name)).toEqual(files.slice(0, 10).map((f) => path.basename(f, '.png')));
    expect(r.rejected).toEqual([{ name: 'img10.png', code: 'LIMIT_REACHED' }, { name: 'img11.png', code: 'LIMIT_REACHED' }]);
    // Fill the index to 99 entries: only one more file fits.
    const store = require('../src/store');
    const doc = store.load('zoomStudioLibrary', null);
    for (let i = doc.items.length; i < 99; i++) doc.items.push({ id: 'l_' + String(i).padStart(12, '0'), name: 'x', kind: 'avatar', file: 'x.png', thumb: null, w: 1, h: 1, bytes: 1, addedAt: 'x' });
    store.save('zoomStudioLibrary', doc);
    pick(files.slice(0, 3));
    const r2 = await call('zoomStudio:library-import', { kind: 'avatar' });
    expect(r2.items.length).toBe(1);
    expect(r2.rejected.map((x) => x.code)).toEqual(['LIMIT_REACHED', 'LIMIT_REACHED']);
  });

  it('ENOENT -> NOT_FOUND, EACCES -> IO_ERROR, symlink / directory -> INVALID_FILE; no path in logs or results', async () => {
    setup();
    const ok = put('fine.png', PNG);
    const locked = put('locked.png', PNG);
    const gone = path.join(SRC, 'gone.png');
    const dir = path.join(SRC, 'folder.png'); fs.mkdirSync(dir);
    const real = cjsFs.lstatSync;
    vi.spyOn(cjsFs, 'lstatSync').mockImplementation((p, ...a) => {
      if (p === locked) { const e = new Error('EACCES: permission denied, lstat ' + p); e.code = 'EACCES'; throw e; }
      return real(p, ...a);
    });
    pick([gone, locked, dir, ok]);
    const r = await call('zoomStudio:library-import', { kind: 'background' });
    expect(r.rejected).toEqual([{ name: 'gone.png', code: 'NOT_FOUND' }, { name: 'locked.png', code: 'IO_ERROR' }, { name: 'folder.png', code: 'INVALID_FILE' }]);
    expect(r.items.length).toBe(1);
    expect(JSON.stringify(r).includes('p4th9')).toBe(false);
    assertNoPathInLogs();
  });

  it('a thumbnail failure after the copy deletes the copy and rejects the file with IO_ERROR', async () => {
    setup({ resizeThrows: true });
    pick([put('desk.png', PNG)]);
    const r = await call('zoomStudio:library-import', { kind: 'background' });
    expect(r).toEqual({ ok: true, items: [], rejected: [{ name: 'desk.png', code: 'IO_ERROR' }] });
    expect(fs.existsSync(libDir()) ? fs.readdirSync(libDir()) : []).toEqual([]);
    expect(require('../src/store').load('zoomStudioLibrary', { items: [] }).items).toEqual([]);
    assertNoPathInLogs();
  });

  it('cancel -> CANCELLED; an unknown kind is rejected by the validator', async () => {
    setup();
    expect(await call('zoomStudio:library-import', { kind: 'background' })).toEqual({ ok: false, code: 'CANCELLED' });
    expect(await call('zoomStudio:library-import', { kind: 'video' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'kind' });
  });
});

describe('library delete', () => {
  it('IN_USE with usedBy unless force; force deletes both files + the entry and clears preset refs', async () => {
    setup();
    pick([put('bg.png', PNG), put('ov.png', PNG)]);
    const r = await call('zoomStudio:library-import', { kind: 'background' });
    const [bg, ov] = r.items.map((i) => i.id);
    const p1 = await call('zoomStudio:preset-save', { preset: { name: 'Green', effect: { mode: 'chromaKey', chromaKey: { backgroundId: bg } }, overlays: [{ imageId: ov }, { imageId: bg, x: 0.1 }] } });
    const p2 = await call('zoomStudio:preset-save', { preset: { name: 'Avatar', effect: { mode: 'image', imageId: bg } } });
    expect(p1.ok && p2.ok).toBe(true);
    expect(await call('zoomStudio:library-delete', { id: bg })).toEqual({ ok: false, code: 'IN_USE', usedBy: 2 });
    expect(fs.existsSync(path.join(libDir(), bg + '.png'))).toBe(true);
    expect(await call('zoomStudio:library-delete', { id: bg, force: true })).toEqual({ ok: true });
    expect(fs.existsSync(path.join(libDir(), bg + '.png'))).toBe(false);
    expect(fs.existsSync(path.join(libDir(), bg + '.thumb.png'))).toBe(false);
    expect((await call('zoomStudio:library-list')).items.map((i) => i.id)).toEqual([ov]);
    const ps = (await call('zoomStudio:presets-list')).presets;
    const g = ps.find((p) => p.name === 'Green');
    const a = ps.find((p) => p.name === 'Avatar');
    expect(g.effect.chromaKey.backgroundId).toBe(null);
    expect(g.overlays).toEqual([expect.objectContaining({ imageId: ov })]);
    expect(a.effect.imageId).toBe(null);
    // An unused image deletes without force; an unknown id -> NOT_FOUND.
    await call('zoomStudio:preset-delete', { id: p1.preset.id });
    expect(await call('zoomStudio:library-delete', { id: ov })).toEqual({ ok: true });
    expect(await call('zoomStudio:library-delete', { id: ov })).toEqual({ ok: false, code: 'NOT_FOUND' });
    assertNoPathInLogs();
  });

  it('an unlink EPERM -> IO_ERROR and the entry stays', async () => {
    setup();
    pick([put('bg.png', PNG)]);
    const r = await call('zoomStudio:library-import', { kind: 'background' });
    const id = r.items[0].id;
    vi.spyOn(cjsFs, 'unlinkSync').mockImplementation((p) => { const e = new Error('EPERM ' + p); e.code = 'EPERM'; throw e; });
    expect(await call('zoomStudio:library-delete', { id })).toEqual({ ok: false, code: 'IO_ERROR' });
    vi.restoreAllMocks();
    expect((await call('zoomStudio:library-list')).items.length).toBe(1);
    assertNoPathInLogs();
  });
});
