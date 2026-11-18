// tests/refresh-unit-ipc-planned-merge.test.js
// The detail panel's on-open refresh (aap-api:refresh-unit -> unit-detail.js
// refreshPatchWRs) must not drop the planned WO card when refreshUnit's
// per-unit PLANNED search failed (_plannedPassOk:false). The IPC handler merges
// the stored fleet row's planned WO; the renderer patch keeps its own as a
// fallback. When the PLANNED search succeeded, fresh wins (a closed WO drops).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkWo } from './fixtures/fleet-build/aap-fleet-fixture.js';

vi.mock('../renderer/src/js/bridge.js', () => ({ notes: {}, ai: {}, aap: {}, relay: {}, vendor: {}, files: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() {}, emit() {}, off() {} } }));
vi.mock('../renderer/src/js/state.js', () => ({ default: { get() {}, set() {}, on() {} } }));
vi.mock('../renderer/src/js/components/toast.js', () => ({ default: { show() {} } }));
vi.mock('../renderer/src/js/views/vendor-review-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/dealer-wo-modal.js', () => ({ open() {} }));
vi.mock('../renderer/src/js/views/wr-modal.js', () => ({ open() {}, readFileAsAttachment: async () => null }));

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'refresh-unit-ipc-planned-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const handlers = {};
const resolved = require.resolve('electron');
require.cache[resolved] = { id: resolved, filename: resolved, loaded: true,
  exports: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } }, BrowserWindow: function () {}, session: {} } };
const store = require('../src/store');
const aap = require('../src/scrapers/aap_api');
const mapper = require('../src/scrapers/aap_api_mapper');
require('../src/ipc/aap-api').registerAapApiIPC({ pushData() {}, lastData: null });
const call = (ch, ...args) => handlers[ch]({}, ...args);
const ud = await import('../renderer/src/js/views/unit-detail.js');

const planned = mapper.toSecondaryWR(mkWo({ id: 'svc-m1-p', category: 'PLANNED', status: 'SCHEDULED' }), null, { wrType: 'planned' });
const unpl2 = mapper.toSecondaryWR(mkWo({ id: 'svc-m3-u2' }), null, { wrType: 'unplanned' });
// Stored bulk row, 122269 shape: openUnplanned=1, openPlanned=1.
const stored = { equipmentId: 'M1001', workRequestId: 'svc-m1-u', lifecycleState: 'Unavailable', lifecycleReason: 'PM Failed',
  openUnplanned: 1, openPlanned: 1, _secondaryWRs: [planned], _plannedWRData: planned };

afterEach(() => { vi.restoreAllMocks(); });

describe('aap-api:refresh-unit planned merge', () => {
  it('PLANNED search failed: the stored planned WO is merged into the returned row', async () => {
    store.save('fleetData', { rows: [stored] });
    vi.spyOn(aap, 'refreshUnit').mockResolvedValue({ equipmentId: 'M1001', workRequestId: 'svc-m1-u',
      _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: false });
    const r = await call('aap-api:refresh-unit', { unit: 'm1001' });
    expect(r.ok).toBe(true);
    expect(r.row._secondaryWRs.map((s) => [s.workRequestId, s._wrType])).toEqual([['svc-m1-p', 'planned']]);
    expect(r.row._plannedWRData.workRequestId).toBe('svc-m1-p');
  });
  it('PLANNED search failed, FLD260703 shape: fresh unplanned secondary plus stored planned', async () => {
    store.save('fleetData', { rows: [{ equipmentId: 'M1003', workRequestId: 'svc-m3-u1', _secondaryWRs: [unpl2, planned], _plannedWRData: planned }] });
    vi.spyOn(aap, 'refreshUnit').mockResolvedValue({ equipmentId: 'M1003', workRequestId: 'svc-m3-u1',
      _secondaryWRs: [unpl2], _plannedWRData: null, _plannedPassOk: false });
    const r = await call('aap-api:refresh-unit', { unit: 'M1003' });
    expect(r.row._secondaryWRs.map((s) => s.workRequestId)).toEqual(['svc-m3-u2', 'svc-m1-p']);
  });
  it('PLANNED search succeeded: fresh wins, so a closed planned WO drops off', async () => {
    store.save('fleetData', { rows: [stored] });
    vi.spyOn(aap, 'refreshUnit').mockResolvedValue({ equipmentId: 'M1001', workRequestId: 'svc-m1-u',
      _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: true });
    const r = await call('aap-api:refresh-unit', { unit: 'M1001' });
    expect(r.row._secondaryWRs).toEqual([]);
    expect(r.row._plannedWRData).toBe(null);
  });
});

describe('unit-detail refreshPatchWRs (on-open patch)', () => {
  it('PLANNED search failed and nothing merged: the panel keeps its planned card', () => {
    const p = ud.refreshPatchWRs(stored, { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: false });
    expect(p._secondaryWRs.map((s) => s.workRequestId)).toEqual(['svc-m1-p']);
    expect(p._plannedWRData.workRequestId).toBe('svc-m1-p');
  });
  it('merged row from the IPC handler: no duplicate planned entry', () => {
    const p = ud.refreshPatchWRs(stored, { workRequestId: 'svc-m1-u', _secondaryWRs: [planned], _plannedWRData: planned, _plannedPassOk: false });
    expect(p._secondaryWRs).toEqual([planned]);
    expect(p._plannedWRData).toBe(planned);
  });
  it('PLANNED search succeeded without the WO: the planned card and entry drop', () => {
    const p = ud.refreshPatchWRs(stored, { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: true });
    expect(p._secondaryWRs).toEqual([]);
    expect(p._plannedWRData).toBe(null);
  });
  it('single open WO: nothing extra', () => {
    const p = ud.refreshPatchWRs({ workRequestId: 'svc-m2-u', _secondaryWRs: [], _plannedWRData: null },
      { workRequestId: 'svc-m2-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: true });
    expect(p._secondaryWRs).toEqual([]);
    expect(p._plannedWRData).toBe(null);
  });
  it('the patched panel renders both WO cards', () => {
    vi.useFakeTimers();
    const hadWindow = 'window' in globalThis;
    if (!hadWindow) globalThis.window = {};
    try {
      const fresh = { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: false };
      const u = Object.assign({}, stored, { vendor: 'Amerit', relaySynced: true, serviceState: 'Work In Progress' }, ud.refreshPatchWRs(stored, fresh));
      const h = ud.renderRepairPane(u);
      expect(h).toContain('<span class="dp-wo-field__v">svc-m1-u</span>');
      expect(h).toContain('<span class="dp-wo-field__v">svc-m1-p</span>');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      if (!hadWindow) delete globalThis.window;
    }
  });
});
