// FEAT-A2 / AC-12, design §11 + review F-2: link targets from fleetData (ids failing the targetId rule are
// excluded), validation, idempotency, limits, eviction, unlink, persistence across a store module reload.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installFakeLogger, freshZoom } from './fixtures/zoom/fake-electron.js';
import { SENTINEL_TOPIC } from './fixtures/zoom/sentinels.js';

const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-links-'));
require('../src/config/paths').setDataDir(TMP);
const pf = require('../src/config/perf-flags');

let logger; let L; let client; let store;

const ROWS = [
  { equipmentId: 59083, operator: ' agnli ' },
  { equipmentId: '59083', operator: 'AGNLI' },
  { equipmentId: 'ab', operator: 'toolongcarrier1' },
  { equipmentId: 'X/1', operator: '' },
  { equipmentId: '320160', operator: 'AMZL' },
  { equipmentId: null, operator: null },
];

beforeEach(() => {
  freshZoom(require);
  logger = installFakeLogger(require);
  store = require('../src/store');
  store.save('fleetData', { rows: ROWS });
  store.save('zoomLinks', { version: 1, links: {} });
  client = require('../src/zoom/data/client');
  L = require('../src/zoom/data/links');
  client.meetingByKey.set('m1', { key: 'm1', idHash: 'h', topic: SENTINEL_TOPIC + 'x'.repeat(300), startIso: '2026-11-10T15:00:00.000Z' });
  client.recordingByKey.set('r1', { key: 'r1', idHash: 'h', topic: 'Rec', startIso: '2026-11-09T15:00:00.000Z' });
});

afterEach(() => { logger.restore(); freshZoom(require); });

describe('linkTargets (review F-2)', () => {
  it('units: distinct String(equipmentId); non-matching ids (ab, X/1) are excluded; 59083 accepted', async () => {
    expect(await L.linkTargets({ kind: 'unit', q: '' })).toEqual({ ok: true, items: [{ id: '320160', label: 'Unit 320160' }, { id: '59083', label: 'Unit 59083' }] });
  });

  it('carriers: trimmed upper-case distinct operators; AGNLI accepted, toolongcarrier1 excluded', async () => {
    expect((await L.linkTargets({ kind: 'carrier', q: '' })).items.map((i) => i.id)).toEqual(['AGNLI', 'AMZL']);
  });

  it('q filters case-insensitively (prefix first); at most 50 results', async () => {
    expect((await L.linkTargets({ kind: 'carrier', q: 'gn' })).items.map((i) => i.id)).toEqual(['AGNLI']);
    expect((await L.linkTargets({ kind: 'unit', q: '0' })).items.map((i) => i.id)).toEqual(['320160', '59083']);
    expect((await L.linkTargets({ kind: 'unit', q: '5' })).items.map((i) => i.id)).toEqual(['59083']);
    store.save('fleetData', { rows: Array.from({ length: 80 }, (_v, n) => ({ equipmentId: 'U' + String(n).padStart(3, '0') })) });
    expect((await L.linkTargets({ kind: 'unit', q: '' })).items.length).toBe(50);
  });

  it('empty fleet rows -> FLEET_DATA_UNAVAILABLE', async () => {
    store.save('fleetData', { rows: [] });
    expect(await L.linkTargets({ kind: 'unit', q: '' })).toEqual({ ok: false, code: 'FLEET_DATA_UNAVAILABLE' });
    store.delete('fleetData');
    expect(await L.link({ key: 'm1', kind: 'unit', id: '59083' })).toEqual({ ok: false, code: 'FLEET_DATA_UNAVAILABLE' });
  });
});

describe('link / unlink (AC-12)', () => {
  it('UNKNOWN_TARGET for an id not in fleet data; NOT_FOUND for an unknown key', async () => {
    expect(await L.link({ key: 'm1', kind: 'unit', id: '11111' })).toEqual({ ok: false, code: 'UNKNOWN_TARGET' });
    await expect(L.link({ key: 'nope', kind: 'unit', id: '59083' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.load('zoomLinks').links).toEqual({});
  });

  it('links a meeting (topic snapshot truncated to 200 + startIso), idempotent duplicates, unlink drops empty entries', async () => {
    const a = await L.link({ key: 'm1', kind: 'unit', id: '59083' });
    expect(a.ok).toBe(true);
    expect(a.link).toMatchObject({ kind: 'meeting', startIso: '2026-11-10T15:00:00.000Z', targets: [{ kind: 'unit', id: '59083' }] });
    expect(a.link.topic.length).toBe(200);
    await L.link({ key: 'm1', kind: 'unit', id: '59083' });
    const b = await L.link({ key: 'm1', kind: 'carrier', id: 'AGNLI' });
    expect(b.link.targets.map((t) => t.kind + ':' + t.id)).toEqual(['unit:59083', 'carrier:AGNLI']);
    expect((await L.link({ key: 'r1', kind: 'carrier', id: 'AMZL' })).link.kind).toBe('recording');
    expect(Object.keys((await L.links()).links).sort()).toEqual(['m1', 'r1']);
    expect((await L.unlink({ key: 'm1', kind: 'unit', id: '59083' })).link.targets.length).toBe(1);
    expect(await L.unlink({ key: 'm1', kind: 'carrier', id: 'AGNLI' })).toEqual({ ok: true, link: null });
    expect(Object.keys((await L.links()).links)).toEqual(['r1']);
    expect(await L.unlink({ key: 'zz', kind: 'unit', id: '59083' })).toEqual({ ok: true, link: null });
    // logs: {op, kind, idHash} only, never the topic
    const lines = logger.lines.filter((l) => l.args[1] && (l.args[1].op === 'link' || l.args[1].op === 'unlink'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(Object.keys(l.args[1]).sort()).toEqual(['idHash', 'kind', 'op']);
    expect(logger.text()).not.toContain('SENTINEL_TOPIC');
  });

  it('a key already in zoomLinks (no longer listed) can still be linked', async () => {
    store.save('zoomLinks', { version: 1, links: { old: { topic: 'x', startIso: null, kind: 'meeting', targets: [{ kind: 'unit', id: '320160', linkedAt: '2026-01-01T00:00:00.000Z' }] } } });
    const r = await L.link({ key: 'old', kind: 'unit', id: '59083' });
    expect(r.link.targets.map((t) => t.id)).toEqual(['320160', '59083']);
  });

  it('more than 10 targets -> LIMIT_REACHED', async () => {
    store.save('fleetData', { rows: Array.from({ length: 12 }, (_v, n) => ({ equipmentId: 'U' + (100 + n) })) });
    for (let n = 0; n < 10; n++) expect((await L.link({ key: 'm1', kind: 'unit', id: 'U' + (100 + n) })).ok).toBe(true);
    await expect(L.link({ key: 'm1', kind: 'unit', id: 'U110' })).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(store.load('zoomLinks').links.m1.targets.length).toBe(10);
  });

  it('past 500 linked meetings the entry with the oldest linkedAt is evicted', async () => {
    const links = {};
    for (let n = 0; n < 500; n++) links['k' + n] = { topic: null, startIso: null, kind: 'meeting', targets: [{ kind: 'unit', id: '59083', linkedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString() }] };
    store.save('zoomLinks', { version: 1, links });
    await L.link({ key: 'm1', kind: 'unit', id: '59083' });
    const after = store.load('zoomLinks').links;
    expect(Object.keys(after).length).toBe(500);
    expect(after.k0).toBeUndefined();
    expect(after.k1).toBeDefined();
    expect(after.m1).toBeDefined();
  });

  it('persists across a store module reload from the same data dir', async () => {
    await L.link({ key: 'm1', kind: 'carrier', id: 'AGNLI' });
    const id = require.resolve('../src/store');
    delete require.cache[id];
    const store2 = require('../src/store');
    expect(store2).not.toBe(store);
    expect(store2.load('zoomLinks').links.m1.targets).toMatchObject([{ kind: 'carrier', id: 'AGNLI' }]);
    freshZoom(require);
    expect((await require('../src/zoom/data/links').links()).links.m1.targets[0].id).toBe('AGNLI');
  });
});

describe('through the hub (validator + targetId)', () => {
  it('a carrier id is trimmed + upper-cased by the validator before link()', async () => {
    const hub = require('../src/ipc/zoom-hub');
    const handlers = new Map();
    const wc = { id: 1, mainFrame: { processId: 7, routingId: 3 } };
    hub.registerZoomHubIPC({ mainWindow: { isDestroyed: () => false, webContents: wc }, sendToWindow: vi.fn() }, { flags: pf.resolveZoomFlags({ zoom: { enabled: true, data: true } }, {}), handle: (ch, fn) => handlers.set(ch, fn) });
    const ev = { sender: wc, senderFrame: { processId: 7, routingId: 3, url: 'file:///C:/Fleet/renderer/src/index.html' } };
    const r = await handlers.get('zoomData:link')(ev, { key: 'm1', kind: 'carrier', id: ' agnli ' });
    expect(r.ok).toBe(true);
    expect(r.link.targets[0]).toMatchObject({ kind: 'carrier', id: 'AGNLI' });
    expect(await handlers.get('zoomData:link')(ev, { key: 'nope', kind: 'unit', id: '59083' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await handlers.get('zoomData:link-targets')(ev, { kind: 'unit' })).toMatchObject({ ok: true });
  });
});
