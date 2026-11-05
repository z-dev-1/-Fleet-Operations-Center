// tests/longdwell-sp-parity.test.js - flag-off parity for the Long Dwell
// weekly sheet feature. MAIN-SIDE cases (FEAT-002): with the default flags the
// new IPC channels are inert, and sharepoint_push.js exports exactly the
// previous set plus _withWriteLock. Renderer cases are added by FEAT-003.
import { describe, it, expect, vi } from 'vitest';
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

describe('sharepoint_push.js exports', () => {
  it('equal the previous set plus _withWriteLock', () => {
    const sp = require('../src/scrapers/sharepoint_push');
    const PREVIOUS = ['pushToSharePoint', 'WORKBOOKS', 'buildRowValues', 'loadWorkbooks', 'saveWorkbooks', 'SP_CONFIG_FILE', '_newSpResult', '_deriveSpStatus', '_verifyMissingCount'];
    expect(Object.keys(sp).sort()).toEqual(PREVIOUS.concat('_withWriteLock').sort());
    expect(typeof sp._withWriteLock).toBe('function');
  });
});
