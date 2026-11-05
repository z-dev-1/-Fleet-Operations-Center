// tests/longdwell-sp-parity.test.js - flag-off parity for the Long Dwell
// weekly sheet feature. MAIN-SIDE cases (FEAT-002): with the default flags the
// new IPC channels are inert, and sharepoint_push.js exports exactly the
// previous set plus _withWriteLock. RENDERER cases (FEAT-003): mount is
// synchronous and leaves the host untouched when disabled, the #an-refresh
// handler calls safeRefresh once after its button reset, no console.* in the
// new renderer modules, and analytics.js carries the hook only on the planned
// lines (none inside _dashboardHtml).
import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }
const handlers = {};
const BrowserWindow = vi.fn();
inject('electron', { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow, session: { defaultSession: {} }, shell: { openExternal: vi.fn() } });
function fakeLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
fakeLogger.createLogger = fakeLogger; fakeLogger.setLogDir = () => {}; fakeLogger.setLevel = () => {}; fakeLogger.setSilent = () => {}; fakeLogger.LEVELS = {};
inject('../src/utils/logger', fakeLogger);
const { setDataDir } = require('../src/config/paths');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ldsp-parity-'));
setDataDir(tmp);
const { resolveLongDwellSpFlags } = require('../src/config/perf-flags');
const ipc = require('../src/ipc/long-dwell-sp');
ipc.registerLongDwellSpIPC();

describe('flag-off parity (main side)', () => {
  it('default flags are off and every long-dwell-sp channel is inert', async () => {
    const defaults = resolveLongDwellSpFlags({}, {});
    expect(defaults.sharepointWrite).toBe(false);
    expect(defaults.sharepointWriteCommit).toBe(false);
    const store = { load: vi.fn(), update: vi.fn() };
    const transport = { resolveFile: vi.fn(), downloadFile: vi.fn(), withSession: vi.fn(), uploadFile: vi.fn(), fileMeta: vi.fn() };
    const guard = vi.fn();
    ipc._resetForTests({ loadFlags: () => resolveLongDwellSpFlags({}, {}), store, transport, installPaneGuard: guard });
    const ev = { sender: {} };
    expect(await handlers['long-dwell-sp:status'](ev)).toEqual({ ok: true, enabled: false });
    for (const [ch, p] of [['set-link', { url: 'https://contoso.sharepoint.com/sites/F/a.xlsx' }], ['clear-link'], ['preview', { units: [] }],
      ['write', { previewId: 'p', cells: [{ cellId: '2:N', text: 'x' }], confirm: true }], ['discard', { previewId: 'p' }]]) {
      expect(await handlers['long-dwell-sp:' + ch](ev, p)).toEqual({ ok: false, code: 'off' });
    }
    expect(store.load).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
    for (const f of Object.values(transport)) expect(f).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(BrowserWindow).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
  it('the env commit flag alone stays off without the master flag', () => {
    expect(resolveLongDwellSpFlags({}, { FLEET_LONGDWELL_SP_COMMIT: '1' }).sharepointWriteCommit).toBe(false);
  });
});

// ── Renderer half (FEAT-003) ────────────────────────────────────────────────
const SP_BRIDGE = vi.hoisted(() => ({ longDwellSp: { status: null }, aap: { openUrl: () => {} } }));
vi.mock('../renderer/src/js/bridge.js', () => SP_BRIDGE);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANALYTICS_SRC = () => fs.readFileSync(path.join(ROOT, 'renderer/src/js/views/analytics.js'), 'utf8').replace(/\r\n/g, '\n');
const flushMicro = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function recordingHost() {
  const calls = [];
  const rec = (n) => () => { calls.push(n); };
  const h = { calls, appendChild: rec('appendChild'), insertBefore: rec('insertBefore'), addEventListener: rec('addEventListener'),
    removeChild: rec('removeChild'), setAttribute: rec('setAttribute'), querySelector: (s) => { calls.push('querySelector:' + s); return null; },
    classList: { add: rec('classList.add'), remove: rec('classList.remove') } };
  Object.defineProperty(h, 'innerHTML', { get() { return ''; }, set() { calls.push('innerHTML'); } });
  Object.defineProperty(h, 'ownerDocument', { get() { calls.push('ownerDocument'); return { createElement: () => { calls.push('createElement'); return {}; } }; } });
  return h;
}

describe('flag-off Refresh', () => {
  it('safeRefresh never throws for undefined, a Promise, a throwing refresh and a real flag-off mount result', async () => {
    const view = await import('../renderer/src/js/views/longdwell-sp.js');
    SP_BRIDGE.longDwellSp.status = async () => ({ ok: true, enabled: false });
    const real = view.mount(recordingHost(), { getUnits: () => [] });
    await flushMicro();
    const p = Promise.resolve({ refresh() {} });
    for (const v of [undefined, null, p, { refresh: 'x' }, { refresh() { throw new Error('boom'); } }, real]) {
      expect(() => view.safeRefresh(v)).not.toThrow();
    }
  });
  it('#an-refresh handler calls safeRefresh(_ldSp) once, after the button reset lines', () => {
    const lines = ANALYTICS_SRC().split('\n');
    const s = lines.findIndex((l) => l.includes("_el.querySelector('#an-refresh').addEventListener('click'"));
    expect(s).toBeGreaterThan(0);
    const e = lines.findIndex((l, i) => i > s && l === '  });');
    const body = lines.slice(s, e + 1);
    const calls = body.filter((l) => l.includes('safeRefresh'));
    expect(calls).toEqual(['    longDwellSp.safeRefresh(_ldSp);']);
    const reset = body.findIndex((l) => l.includes("btn.disabled = false; btn.textContent = '\\u21ba Refresh';"));
    expect(reset).toBeGreaterThan(0);
    expect(body.findIndex((l) => l.includes('safeRefresh'))).toBe(reset + 1);
  });
});

describe('renderer source parity', () => {
  it('new renderer modules contain no console.* call', () => {
    for (const rel of ['renderer/src/js/views/longdwell-sp.js', 'renderer/src/js/longdwell-sp-logic.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(/\bconsole\./.test(src), rel).toBe(false);
    }
  });
  it('_dashboardHtml text contains no an-ld-sp / longDwellSp', () => {
    const lines = ANALYTICS_SRC().split('\n');
    const s = lines.findIndex((l) => l.startsWith('function _dashboardHtml('));
    const e = lines.findIndex((l, i) => i > s && l === '}');
    expect(s).toBeGreaterThan(0);
    const text = lines.slice(s, e + 1).join('\n');
    expect(text).not.toMatch(/an-ld-sp|longDwellSp|_ldSp|ldsp/);
  });
  it('an-ld-sp / longDwellSp / _ldSp appear in analytics.js only on the planned lines', () => {
    const hits = ANALYTICS_SRC().split('\n').filter((l) => /an-ld-sp|longDwellSp|_ldSp/.test(l)).map((l) => l.trim());
    expect(hits).toEqual([
      "import * as longDwellSp from './longdwell-sp.js';",
      'let _ldSp = null;',
      'function _ldSpUnits() {',
      'longDwellSp.safeRefresh(_ldSp);',
      '_ldSp = longDwellSp.mount(_ldComputedWrap, { getUnits: _ldSpUnits });',
    ]);
  });
  for (const [name, status] of [['status disabled', { ok: true, enabled: false }], ['only the commit flag on (enabled:false)', { ok: true, enabled: false, commit: true }], ['off', { ok: false, code: 'off' }]]) {
    it('recording fake host untouched when ' + name, async () => {
      const view = await import('../renderer/src/js/views/longdwell-sp.js');
      SP_BRIDGE.longDwellSp.status = vi.fn(async () => status);
      const host = recordingHost();
      const getUnits = vi.fn();
      const api = view.mount(host, { getUnits });
      expect(typeof api.then).toBe('undefined');
      await flushMicro();
      view.safeRefresh(api);
      await flushMicro();
      expect(host.calls).toEqual([]);
      expect(getUnits).not.toHaveBeenCalled();
    });
  }
});

describe('sharepoint_push.js exports', () => {
  it('equal the previous set plus _withWriteLock', () => {
    const sp = require('../src/scrapers/sharepoint_push');
    const PREVIOUS = ['pushToSharePoint', 'WORKBOOKS', 'buildRowValues', 'loadWorkbooks', 'saveWorkbooks', 'SP_CONFIG_FILE', '_newSpResult', '_deriveSpStatus', '_verifyMissingCount'];
    expect(Object.keys(sp).sort()).toEqual(PREVIOUS.concat('_withWriteLock').sort());
    expect(typeof sp._withWriteLock).toBe('function');
  });
});
