// FEAT-B2 / AC-16 (design §15.1-§15.2): Studio presets through the hub — round trip, duplicate names,
// the 50-preset cap, schema stripping / dotted-field errors without clamping, UNKNOWN_IMAGE,
// lastPresetId, persistence across a store reload, and no preset names in logs.
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeElectron, installFakeElectron, installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TOPIC } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const pf = require('../src/config/perf-flags');

let TMP; let logger; let restoreE; let handlers; let ctx;

const LIB_A = 'l_aaaaaaaaaaaa';
const LIB_B = 'l_bbbbbbbbbbbb';

function setup() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-presets-'));
  require('../src/config/paths').setDataDir(TMP);
  freshZoom(require);
  logger = installFakeLogger(require);
  const fx = createFakeElectron();
  restoreE = installFakeElectron(require, fx.electron);
  const hub = require('../src/ipc/zoom-hub');
  handlers = new Map();
  const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
  ctx = { mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: () => {} };
  hub.registerZoomHubIPC(ctx, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, studio: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
}

const call = (ch, payload) => handlers.get(ch)({ sender: ctx.mainWindow.webContents, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } }, payload);
const store = () => require('../src/store');
const addLibrary = (...ids) => store().save('zoomStudioLibrary', { version: 1, items: ids.map((id) => ({ id, name: id, kind: 'overlay', file: id + '.png', thumb: null, w: 10, h: 10, bytes: 1, addedAt: 'x' })) });

beforeEach(() => setup());
afterEach(() => {
  restoreE(); logger.restore(); freshZoom(require);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

describe('presets round trip (AC-16)', () => {
  it('save -> list -> select -> load (list) -> rename -> update -> delete', async () => {
    const s = await call('zoomStudio:preset-save', { preset: { name: '  Desk  ', effect: { mode: 'edgeBlur', edgeBlur: { radiusPx: 20 } }, adjust: { brightness: 120, mirror: true } } });
    expect(s.ok).toBe(true);
    expect(s.preset.id).toMatch(/^p_[0-9a-f]{12}$/);
    expect(s.preset.name).toBe('Desk');
    expect(s.preset.version).toBe(1);
    expect(s.preset.createdAt).toBe(s.preset.updatedAt);
    expect(s.preset.effect).toEqual({ mode: 'edgeBlur', edgeBlur: { radiusPx: 20, focus: 0.6 }, chromaKey: { color: 'green', tolerance: 50, backgroundId: null }, imageId: null });
    expect(s.preset.adjust).toEqual({ brightness: 120, contrast: 100, saturation: 100, mirror: true });
    expect(s.preset.camera).toEqual({ id: null, label: null });
    expect(s.preset.overlays).toEqual([]);
    const id = s.preset.id;

    let l = await call('zoomStudio:presets-list');
    expect(l).toEqual({ ok: true, presets: [s.preset], lastPresetId: null });
    expect(await call('zoomStudio:preset-select', { id })).toEqual({ ok: true });
    l = await call('zoomStudio:presets-list');
    expect(l.lastPresetId).toBe(id);

    const r = await call('zoomStudio:preset-rename', { id, name: 'Office' });
    expect(r.ok).toBe(true);
    expect(r.preset.name).toBe('Office');

    const u = await call('zoomStudio:preset-save', { preset: { id, name: 'Office', camera: { id: 'cam-hp', label: 'HP 5MP Camera' } } });
    expect(u.ok).toBe(true);
    expect(u.preset.id).toBe(id);
    expect(u.preset.createdAt).toBe(s.preset.createdAt);
    expect(u.preset.camera).toEqual({ id: 'cam-hp', label: 'HP 5MP Camera' });

    expect(await call('zoomStudio:preset-delete', { id })).toEqual({ ok: true });
    l = await call('zoomStudio:presets-list');
    expect(l).toEqual({ ok: true, presets: [], lastPresetId: null });
    expect(store().load('zoomStudioConfig', null).lastPresetId).toBe(null);   // cleared on delete
  });

  it('unknown ids -> NOT_FOUND; select(null) clears the selection', async () => {
    const missing = 'p_000000000000';
    expect(await call('zoomStudio:preset-rename', { id: missing, name: 'x' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await call('zoomStudio:preset-delete', { id: missing })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await call('zoomStudio:preset-select', { id: missing })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await call('zoomStudio:preset-save', { preset: { id: missing, name: 'x' } })).toEqual({ ok: false, code: 'NOT_FOUND' });
    const s = await call('zoomStudio:preset-save', { preset: { name: 'A' } });
    await call('zoomStudio:preset-select', { id: s.preset.id });
    expect(await call('zoomStudio:preset-select', { id: null })).toEqual({ ok: true });
    expect((await call('zoomStudio:presets-list')).lastPresetId).toBe(null);
  });

  it('DUPLICATE_NAME is case-insensitive (create and rename); renaming to its own name is fine', async () => {
    const a = await call('zoomStudio:preset-save', { preset: { name: 'Desk' } });
    const b = await call('zoomStudio:preset-save', { preset: { name: 'Other' } });
    expect(await call('zoomStudio:preset-save', { preset: { name: ' desk ' } })).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
    expect(await call('zoomStudio:preset-rename', { id: b.preset.id, name: 'DESK' })).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
    expect((await call('zoomStudio:preset-rename', { id: a.preset.id, name: 'desk' })).ok).toBe(true);
    expect((await call('zoomStudio:presets-list')).presets.length).toBe(2);
  });

  it('the 51st preset -> LIMIT_REACHED', async () => {
    // 49 seeded through the store (keeps the test fast under parallel load), the 50th through the hub.
    const first = (await call('zoomStudio:preset-save', { preset: { name: 'P0' } })).preset;
    const doc = store().load('zoomStudioPresets', null);
    for (let i = 1; i < 49; i++) doc.presets.push(Object.assign({}, first, { id: 'p_' + String(i).padStart(12, '0'), name: 'P' + i }));
    store().save('zoomStudioPresets', doc);
    expect((await call('zoomStudio:preset-save', { preset: { name: 'P49' } })).ok).toBe(true);
    expect((await call('zoomStudio:presets-list')).presets.length).toBe(50);
    expect(await call('zoomStudio:preset-save', { preset: { name: 'P50' } })).toEqual({ ok: false, code: 'LIMIT_REACHED' });
    expect((await call('zoomStudio:presets-list')).presets.length).toBe(50);
  });
});

describe('schema (design §15.1)', () => {
  it('unknown keys are stripped at every level; id/createdAt from the renderer are ignored on create', async () => {
    addLibrary(LIB_A);
    const s = await call('zoomStudio:preset-save', { preset: {
      name: 'Strip', evil: 'x', createdAt: '1999', version: 9,
      camera: { id: 'c', label: 'L', extra: 1 }, mic: { id: null, deviceId: 'zz' },
      effect: { mode: 'chromaKey', junk: 1, chromaKey: { color: 'blue', tolerance: 10, backgroundId: LIB_A, more: 2 }, edgeBlur: { radiusPx: 0, x: 1 } },
      adjust: { brightness: 50, contrast: 150, saturation: 0, mirror: false, hue: 3 },
      overlays: [{ imageId: LIB_A, x: 0, y: 1, scale: 2, opacity: 0, rotate: 9 }],
    } });
    expect(s.ok).toBe(true);
    const p = s.preset;
    expect(Object.keys(p).sort()).toEqual(['adjust', 'camera', 'createdAt', 'effect', 'id', 'mic', 'name', 'overlays', 'updatedAt', 'version']);
    expect(p.version).toBe(1);
    expect(p.createdAt).not.toBe('1999');
    expect(p.camera).toEqual({ id: 'c', label: 'L' });
    expect(p.mic).toEqual({ id: null, label: null });
    expect(p.effect).toEqual({ mode: 'chromaKey', edgeBlur: { radiusPx: 0, focus: 0.6 }, chromaKey: { color: 'blue', tolerance: 10, backgroundId: LIB_A }, imageId: null });
    expect(p.adjust).toEqual({ brightness: 50, contrast: 150, saturation: 0, mirror: false });
    expect(p.overlays).toEqual([{ imageId: LIB_A, x: 0, y: 1, scale: 2, opacity: 0 }]);
    // The stored document carries the same clean shape.
    expect(store().load('zoomStudioPresets', null).presets[0]).toEqual(p);
  });

  it('wrong type / out of range -> INVALID_INPUT with a dotted field; values are never clamped', async () => {
    addLibrary(LIB_A);
    const bad = async (preset, field) => expect(await call('zoomStudio:preset-save', { preset })).toEqual({ ok: false, code: 'INVALID_INPUT', field });
    await bad({ name: 'x', adjust: { brightness: 151 } }, 'adjust.brightness');
    await bad({ name: 'x', adjust: { brightness: 49 } }, 'adjust.brightness');
    await bad({ name: 'x', adjust: { saturation: '100' } }, 'adjust.saturation');
    await bad({ name: 'x', adjust: { mirror: 'yes' } }, 'adjust.mirror');
    await bad({ name: 'x', effect: { edgeBlur: { radiusPx: 12.5 } } }, 'effect.edgeBlur.radiusPx');
    await bad({ name: 'x', effect: { edgeBlur: { focus: 0.95 } } }, 'effect.edgeBlur.focus');
    await bad({ name: 'x', effect: { mode: 'magic' } }, 'effect.mode');
    await bad({ name: 'x', effect: { chromaKey: { color: 'red' } } }, 'effect.chromaKey.color');
    await bad({ name: 'x', effect: { chromaKey: { tolerance: 101 } } }, 'effect.chromaKey.tolerance');
    await bad({ name: 'x', effect: { mode: 'chromaKey' } }, 'effect.chromaKey.backgroundId');
    await bad({ name: 'x', effect: { mode: 'image' } }, 'effect.imageId');
    await bad({ name: 'x', effect: { imageId: 'p_aaaaaaaaaaaa' } }, 'effect.imageId');
    await bad({ name: 'x', overlays: [{ imageId: LIB_A, scale: 3 }] }, 'overlays.0.scale');
    await bad({ name: 'x', overlays: [{ imageId: LIB_A }, { imageId: LIB_A, x: -0.1 }] }, 'overlays.1.x');
    await bad({ name: 'x', overlays: [{ x: 0.5 }] }, 'overlays.0.imageId');
    await bad({ name: 'x', overlays: [{ imageId: LIB_A }, { imageId: LIB_A }, { imageId: LIB_A }, { imageId: LIB_A }] }, 'overlays');
    await bad({ name: 'x', overlays: 'none' }, 'overlays');
    await bad({ name: 'x', camera: 'cam' }, 'camera');
    await bad({ name: 'x', camera: { id: 'x'.repeat(257) } }, 'camera.id');
    await bad({ name: 'x', mic: { label: 'y'.repeat(121) } }, 'mic.label');
    await bad({ name: '   ' }, 'name');
    await bad({ name: 'x'.repeat(61) }, 'name');
    await bad({ name: 'a\u0007b' }, 'name');
    await bad({ name: 'x', id: 'nope' }, 'id');
    expect((await call('zoomStudio:presets-list')).presets).toEqual([]);
    // Boundary values are stored exactly as given.
    const s = await call('zoomStudio:preset-save', { preset: { name: 'edge', adjust: { brightness: 150, contrast: 50, saturation: 200 }, effect: { edgeBlur: { radiusPx: 40, focus: 0.3 } }, overlays: [{ imageId: LIB_A, scale: 0.05, opacity: 1 }] } });
    expect(s.preset.adjust).toMatchObject({ brightness: 150, contrast: 50, saturation: 200 });
    expect(s.preset.effect.edgeBlur).toEqual({ radiusPx: 40, focus: 0.3 });
    expect(s.preset.overlays[0]).toMatchObject({ scale: 0.05, opacity: 1 });
  });

  it('a referenced library id that does not exist -> UNKNOWN_IMAGE', async () => {
    expect(await call('zoomStudio:preset-save', { preset: { name: 'x', overlays: [{ imageId: LIB_B }] } })).toEqual({ ok: false, code: 'UNKNOWN_IMAGE' });
    expect(await call('zoomStudio:preset-save', { preset: { name: 'x', effect: { mode: 'image', imageId: LIB_B } } })).toEqual({ ok: false, code: 'UNKNOWN_IMAGE' });
    addLibrary(LIB_B);
    expect((await call('zoomStudio:preset-save', { preset: { name: 'x', effect: { mode: 'image', imageId: LIB_B } } })).ok).toBe(true);
  });

  it('the schema exports RANGES that the renderer slider ranges mirror', async () => {
    const schema = require('../src/zoom/studio/preset-schema');
    const L = await import('../renderer/src/js/zoom/studio-logic.js');
    for (const [k, r] of Object.entries(schema.RANGES)) {
      expect([k, L.RANGES[k].min, L.RANGES[k].max, L.RANGES[k].def]).toEqual([k, r.min, r.max, r.def]);
    }
    expect(schema.MAX_OVERLAYS).toBe(L.MAX_OVERLAYS);
  });
});

describe('persistence + REGISTRY', () => {
  it('presets survive a store module reload from the same data dir; keys resolve under the data dir', async () => {
    const s = await call('zoomStudio:preset-save', { preset: { name: 'Keep' } });
    await call('zoomStudio:preset-select', { id: s.preset.id });
    const storeId = require.resolve('../src/store');
    delete require.cache[storeId];
    freshZoom(require);
    const fresh = require('../src/zoom/studio/presets');
    const l = await fresh.list();
    expect(l.presets.map((p) => p.name)).toEqual(['Keep']);
    expect(l.lastPresetId).toBe(s.preset.id);
    const st = require('../src/store');
    expect(st.REGISTRY.zoomStudioPresets()).toBe(path.join(TMP, 'zoom_studio_presets.json'));
    expect(st.REGISTRY.zoomStudioConfig()).toBe(path.join(TMP, 'zoom_studio_config.json'));
    expect(fs.existsSync(path.join(TMP, 'zoom_studio_presets.json'))).toBe(true);
    expect(fs.existsSync(path.join(TMP, 'zoom_studio_config.json'))).toBe(true);
  });
});

describe('logging', () => {
  it('logs {op, count} only: preset names never reach a log line or an error result', async () => {
    const s = await call('zoomStudio:preset-save', { preset: { name: SENTINEL_TOPIC } });
    const d = await call('zoomStudio:preset-save', { preset: { name: SENTINEL_TOPIC.toLowerCase() } });
    const r = await call('zoomStudio:preset-rename', { id: s.preset.id, name: SENTINEL_TOPIC + '2' });
    await call('zoomStudio:preset-delete', { id: s.preset.id });
    expect(d).toEqual({ ok: false, code: 'DUPLICATE_NAME' });
    expect(r.ok).toBe(true);
    expect(logger.text().includes('SENTINEL_TOPIC')).toBe(false);
    const infos = logger.lines.filter((l) => l.ns === 'zoom:studio' && l.level === 'info');
    expect(infos.length).toBeGreaterThan(0);
    for (const l of infos) expect(Object.keys(l.args[1]).sort()).toEqual(['count', 'op']);
  });
});
