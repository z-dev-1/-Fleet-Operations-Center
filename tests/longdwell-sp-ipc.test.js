// tests/longdwell-sp-ipc.test.js - long-dwell-sp:* IPC surface
// (src/ipc/long-dwell-sp.js): registration, validation table (plan A13), both
// flag gates with zero store/transport/window calls, status shapes, set-link,
// guarded() sentinel and FleetError passthrough.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
import { buildWorkbook, unitRow, createFakeTransport } from './helpers/sheet-fixture.js';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
const BrowserWindow = vi.fn();
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow, session: { defaultSession: {} } });
const logCalls = [];
function fakeLogger() { const rec = (lvl) => (...a) => logCalls.push({ lvl, a }); return { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);
const ipc = require('../src/ipc/long-dwell-sp');
const { ConfigError } = require('../src/utils/errors');
const { DELAY_REASONS } = require('../src/ipc/long-dwell');
ipc.registerLongDwellSpIPC();

const CHANNELS = ['status', 'set-link', 'clear-link', 'preview', 'write', 'discard'].map((c) => 'long-dwell-sp:' + c);
const call = (ch, payload, ev) => handlers['long-dwell-sp:' + ch](ev || { sender: { id: 1 } }, payload);
const NOW = new Date('2026-11-05T10:00:00Z');
const LINK = 'https://contoso.sharepoint.com/sites/Fleet/Shared%20Documents/Tracker.xlsx';
const OFF = { ok: false, code: 'off' };

function memStore(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  const calls = [];
  return {
    data, calls, failUpdate: false,
    load(k, d) { calls.push(['load', k]); return k in data ? JSON.parse(JSON.stringify(data[k])) : d; },
    update(k, fn, d) { calls.push(['update', k]); if (this.failUpdate) throw new Error('disk full SECRET_CELL_TEXT'); const cur = k in data ? JSON.parse(JSON.stringify(data[k])) : d; data[k] = fn(cur); return data[k]; },
  };
}
function spyTransport() {
  const calls = [];
  const f = (n) => vi.fn(async () => { calls.push(n); return { ok: false, code: 'network' }; });
  return { calls, resolveFile: f('resolve'), downloadFile: f('download'), withSession: f('session'), uploadFile: f('upload'), fileMeta: f('meta') };
}

let store, transport, guard, flags, service;
function reset(over = {}) {
  store = memStore(over.storeInit || {});
  transport = over.transport || spyTransport();
  guard = vi.fn();
  flags = over.flags || { sharepointWrite: true, sharepointWriteCommit: true, sharepointGuard: 'modified-recheck' };
  service = over.service;
  logCalls.length = 0;
  BrowserWindow.mockClear();
  ipc._resetForTests({ loadFlags: () => flags, store, transport, installPaneGuard: guard, lock: (fn) => Promise.resolve().then(fn), now: () => NOW, clock: { now: () => NOW.getTime(), sleep: async () => {} }, service });
}
beforeEach(() => reset());

describe('registration', () => {
  it('registers all six channels', () => {
    expect(Object.keys(handlers).filter((k) => k.startsWith('long-dwell-sp:')).sort()).toEqual(CHANNELS.slice().sort());
  });
});

describe('master flag off', () => {
  it('every channel except status returns off with zero store/transport/window calls (also with commit-only)', async () => {
    for (const fl of [{ sharepointWrite: false, sharepointWriteCommit: false }, { sharepointWrite: false, sharepointWriteCommit: true }]) {
      reset({ flags: fl });
      expect(await call('set-link', { url: LINK })).toEqual(OFF);
      expect(await call('clear-link')).toEqual(OFF);
      expect(await call('preview', { units: [{ equipmentId: 'U1' }] })).toEqual(OFF);
      expect(await call('write', { previewId: 'x', cells: [{ cellId: '2:N', text: 'x' }], confirm: true })).toEqual(OFF);
      expect(await call('discard', { previewId: 'x' })).toEqual(OFF);
      expect(await call('preview', null)).toEqual(OFF); // gate before validation
      expect(await call('status')).toEqual({ ok: true, enabled: false });
      expect(store.calls).toEqual([]);
      expect(transport.calls).toEqual([]);
      expect(guard).not.toHaveBeenCalled();
      expect(BrowserWindow).not.toHaveBeenCalled();
    }
  });
});

describe('status', () => {
  it('enabled: shape, week label, link null, pane guard installed on the sender', async () => {
    const sender = { id: 7 };
    const r = await call('status', undefined, { sender });
    expect(r).toEqual({ ok: true, enabled: true, commit: true, weekKey: '2026-W45', weekLabel: 'Week 45, 2026', link: null });
    expect(guard).toHaveBeenCalledWith(sender);
  });
  it('commit off is reported; stored link is returned for this week only', async () => {
    flags.sharepointWriteCommit = false;
    await call('set-link', { url: LINK });
    const r = await call('status');
    expect(r.commit).toBe(false);
    expect(r.link).toMatchObject({ url: LINK, source: 'manual', confidence: 'user' });
    expect(r.link.setAt).toBe(NOW.toISOString());
  });
});

describe('set-link / clear-link', () => {
  it('stores under the current week', async () => {
    const r = await call('set-link', { url: LINK + '#frag' });
    expect(r).toMatchObject({ ok: true, weekKey: '2026-W45', link: { url: LINK } });
    expect(store.data.longDwellSheetLinks.links['2026-W45']).toMatchObject({ url: LINK, resolved: null, lastWrite: null });
    expect(await call('clear-link')).toEqual({ ok: true });
    expect(store.data.longDwellSheetLinks.links['2026-W45']).toBeUndefined();
  });
  it('bad links come back as codes, nothing stored, no query value logged', async () => {
    expect(await call('set-link', { url: 'http://contoso.sharepoint.com/x.xlsx' })).toMatchObject({ ok: false });
    expect(await call('set-link', { url: 'https://evil.example.com/x.xlsx?e=TOKEN' })).toEqual({ ok: false, code: 'bad-host' });
    expect(await call('set-link', { url: 42 })).toEqual({ ok: false, code: 'bad-link' });
    expect(await call('set-link', { url: 'https://contoso.sharepoint.com/' + 'a'.repeat(2100) })).toEqual({ ok: false, code: 'link-too-long' });
    expect(store.calls.filter((c) => c[0] === 'update')).toEqual([]);
    expect(JSON.stringify(logCalls)).not.toMatch(/TOKEN|evil/);
  });
  it('set-link store failure -> {ok:false, code:internal}', async () => {
    store.failUpdate = true;
    expect(await call('set-link', { url: LINK })).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(logCalls)).not.toMatch(/SECRET_CELL_TEXT|disk full/);
  });
  it('payload not an object -> ConfigError', async () => {
    expect(await call('set-link', null)).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
  });
});

describe('preview validation', () => {
  it('units shape errors are ConfigError; > 1000 -> too-many-units; zero transport calls', async () => {
    const bad = [null, {}, { units: 'x' }, { units: [null] }, { units: [{}] }, { units: [{ equipmentId: '' }] }, { units: [{ equipmentId: 'x'.repeat(33) }] },
      { units: [{ equipmentId: 'U1', woKey: 5 }] }, { units: [{ equipmentId: 'U1', vendor: 'v'.repeat(129) }] }, { units: [{ equipmentId: 'U1', isPrimary: 'yes' }] },
      { units: [], tab: 7 }, { units: [], tab: 't'.repeat(256) }];
    for (const p of bad) expect(await call('preview', p)).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
    expect(await call('preview', { units: Array.from({ length: 1001 }, (_, i) => ({ equipmentId: 'U' + i })) })).toEqual({ ok: false, code: 'too-many-units' });
    expect(transport.calls).toEqual([]);
  });
  it('passes deduplicated identity fields only to the service', async () => {
    const svc = { preview: vi.fn(async () => ({ ok: true })), write: vi.fn(), discard: vi.fn() };
    reset({ service: svc });
    await call('preview', { units: [{ equipmentId: ' U1 ', summary: 'RENDERER TEXT', woNumber: '111' }, { equipmentId: 'U1' }], tab: 'Tracker' });
    expect(svc.preview).toHaveBeenCalledWith({ units: [{ equipmentId: 'U1', woKey: 'primary', isPrimary: false, woNumber: '111' }], tab: 'Tracker' });
  });
});

describe('write gates and validation (A13)', () => {
  const W = (cells, extra = {}) => call('write', { previewId: 'p1', cells, confirm: true, ...extra });
  it('master ON + commit OFF: write returns write-disabled with zero transport and store calls', async () => {
    flags.sharepointWriteCommit = false;
    const r = await W([{ cellId: '2:N', text: 'x' }]);
    expect(r).toEqual({ ok: false, code: 'write-disabled', error: 'Write is turned off. Set longDwell.sharepointWriteCommit to enable.' });
    expect(r.error).toContain('longDwell.sharepointWriteCommit');
    expect(store.calls).toEqual([]);
    expect(transport.calls).toEqual([]);
    expect(BrowserWindow).not.toHaveBeenCalled();
  });
  it('write.cells: non-array / empty -> ConfigError; 3001 entries -> too-many-cells; bad / duplicate id -> invalid-cell; non-string text -> invalid-text', async () => {
    expect(await W('x')).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
    expect(await W([])).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
    expect(await W([null])).toMatchObject({ ok: false, code: 'CONFIG_ERROR' });
    expect(await W(Array.from({ length: 3001 }, (_, i) => ({ cellId: (i + 2) + ':N', text: 'x' })))).toEqual({ ok: false, code: 'too-many-cells' });
    expect(await W([{ cellId: 'N2', text: 'x' }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await W([{ cellId: '2:N', text: 'x' }, { cellId: '2:N', text: 'y' }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await W([{ cellId: '2:N', text: 5 }])).toEqual({ ok: false, code: 'invalid-text' });
    expect(await W([{ cellId: '2:N', text: 'x' }], { confirm: false })).toEqual({ ok: false, code: 'confirm-required' });
    expect(await call('write', { cells: [{ cellId: '2:N', text: 'x' }], confirm: true })).toMatchObject({ code: 'CONFIG_ERROR' });
    expect(await call('write', { previewId: 'p'.repeat(65), cells: [{ cellId: '2:N', text: 'x' }], confirm: true })).toMatchObject({ code: 'CONFIG_ERROR' });
    expect(transport.calls).toEqual([]);
  });
  it('unknown, non-selectable id and bad text against a real preview', async () => {
    const bytes = await buildWorkbook({ tabs: [{ name: 'Tracker', rows: [unitRow('U1', { O: 'SEV3' })] }] });
    const ft = createFakeTransport({ bytes });
    const ops = {
      meta: () => ft.meta(), get: () => ft.download(), put: (b, o) => ft.upload(b, o),
      download: async () => { const m = await ft.meta(); const g = await ft.download(); return { ok: true, bytes: g.bytes, meta: m }; },
    };
    reset({ transport: { resolveFile: async () => ft.resolve(), downloadFile: () => ops.download(), withSession: async (_t, fn) => fn(ops) },
      storeInit: { longDwellStore: { 'U1::primary': { delayReason: DELAY_REASONS[1], escalationLevel: 'SEV3', summary: 'note' } } } });
    await call('set-link', { url: LINK });
    const p = await call('preview', { units: [{ equipmentId: 'U1', isPrimary: true }] });
    expect(p.ok).toBe(true);
    const w = (cells) => call('write', { previewId: p.previewId, cells, confirm: true });
    expect(await w([{ cellId: '9:N', text: DELAY_REASONS[1] }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w([{ cellId: '2:O', text: 'SEV3' }])).toEqual({ ok: false, code: 'invalid-cell' });
    expect(await w([{ cellId: '2:N', text: 'Not a reason' }])).toEqual({ ok: false, code: 'invalid-text' });
    expect(ft.state.uploads).toHaveLength(0);
    const r = await w([{ cellId: '2:N', text: DELAY_REASONS[1] }]);
    expect(r).toMatchObject({ ok: true, status: 'ok' });
  });
});

describe('guarded()', () => {
  it('sentinel exception -> internal, class name only logged', async () => {
    const SENT = 'SECRET_CELL_TEXT https://x.sharepoint.com/f?e=TOKEN';
    reset({ service: { preview: async () => { throw new TypeError(SENT); }, write: vi.fn(), discard: vi.fn() } });
    const r = await call('preview', { units: [] });
    expect(r).toEqual({ ok: false, code: 'internal' });
    const logged = JSON.stringify(logCalls.map((c) => c.a));
    expect(logged).not.toMatch(/SECRET|TOKEN/);
    expect(logged).toContain('TypeError');
  });
  it('FleetError passes through to _safe unchanged', async () => {
    const g = ipc.guarded('x', async () => { throw new ConfigError('fixed message', 'f'); });
    await expect(g({})).rejects.toBeInstanceOf(ConfigError);
    reset({ service: { preview: vi.fn(), write: vi.fn(), discard: async () => { throw new ConfigError('fixed message', 'f'); } } });
    expect(await call('discard', { previewId: 'p1' })).toEqual({ ok: false, error: 'fixed message', code: 'CONFIG_ERROR' });
  });
  it('discard requires a previewId', async () => {
    expect(await call('discard', {})).toMatchObject({ code: 'CONFIG_ERROR' });
    expect(await call('discard', { previewId: 'nope' })).toEqual({ ok: true });
  });
});
