// tests/repair-intel-fetch-detail.test.js — per-WO detail hydration in
// fetch.syncUnit (opts.hydrateDetail === true): dealer link + 3C evidence.
// aap_api + logger are require-cache stubs; real mapper, real store, tmp SQLite.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function inject(rel, exportsObj) {
  const resolved = require.resolve('../' + rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
const silent = () => ({ debug() {}, info() {}, warn() {}, error() {}, log() {} });
silent.createLogger = silent; silent.setLogDir = () => {}; silent.setLevel = () => {}; silent.setSilent = () => {};
silent.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const fx = { aggregates: [], details: {}, impl: null };
const getService = vi.fn(async (id) => (fx.impl ? fx.impl(id) : fx.details[id]));
inject('src/utils/logger', silent);
inject('src/scrapers/aap_api', {
  searchAllPages: async () => fx.aggregates,
  getAsset: async () => ({}),
  getService,
});

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const fetch = require('../src/repair-intel/fetch');

const EST = 'https://pssmfleet.decisiv.net/fleet/estimates/E100';
const DAY = 24 * 3600 * 1000;
let tmpDir;

function agg(unit, id, i, extra) {
  return Object.assign({
    workRequestId: id, assetDisplayName: unit, vendor: 'Acme Truck Repair', category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } }, damageDescription: 'issue ' + id,
    reportedDateTime: new Date(Date.parse('2026-10-01T00:00:00Z') + i * DAY).toISOString(),
    lastModifiedDateTime: '2026-10-20T00:00:00Z',
  }, extra || {});
}
const det = (text) => ({ workRequest: { damageDescription: 'x', comments: text ? [{ timestamp: '2026-10-02T00:00:00Z', text, createdBy: 'Tech' }] : [] } });
const row = (sid) => engine.prepare('SELECT * FROM ri_repair_event WHERE source_id = ?').get(sid);

describe('fetch.syncUnit detail hydration', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-fd-'));
    setDataDir(tmpDir);
    engine.close();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
  beforeEach(() => { getService.mockClear(); fx.impl = null; fx.details = {}; fx.aggregates = []; });

  it('dealer / offsite-events only / neither', async () => {
    fx.aggregates = [agg('UA', 'A1', 0), agg('UA', 'A2', 1, { caseNumber: 'CASE9' }), agg('UA', 'A3', 2)];
    fx.details = { A1: det('see ' + EST + ' for estimate'), A2: det('no link'), A3: det('') };
    const res = await fetch.syncUnit('UA', { hydrateDetail: true });
    expect(res.ok).toBe(true);
    expect(res.detail).toEqual({ hydrated: 3, dealerFound: 1, skipped: 0, failed: 0 });
    const a1 = row('A1');
    expect(a1.dealer_url).toBe(EST);
    expect(a1.dealer_source).toBe('estimate');
    expect(JSON.parse(a1.source_refs)).toEqual({ relay: 'https://aap-na.corp.amazon.com/v2/service/A1', offsite: null });
    expect(JSON.parse(a1.wo_evidence).comments[0].text).toContain(EST);
    const a2 = row('A2');
    expect(a2.dealer_url).toBeNull();
    expect(JSON.parse(a2.source_refs).offsite).toBe('https://aap-na.corp.amazon.com/v2/offsite-events/CASE9');
    const a3 = row('A3');
    expect(a3.dealer_url).toBeNull();
    expect(JSON.parse(a3.source_refs).offsite).toBeNull();
    expect(a3.detail_modified_at).toBe(Date.parse('2026-10-20T00:00:00Z'));
  });

  it('second sync with same modified_at → 0 getService calls', async () => {
    fx.aggregates = [agg('UA', 'A1', 0), agg('UA', 'A2', 1, { caseNumber: 'CASE9' }), agg('UA', 'A3', 2)];
    const res = await fetch.syncUnit('UA', { hydrateDetail: true });
    expect(getService).toHaveBeenCalledTimes(0);
    expect(res.detail).toEqual({ hydrated: 0, dealerFound: 0, skipped: 3, failed: 0 });
    expect(row('A1').dealer_url).toBe(EST);
  });

  it('hydrateDetail absent → getService only for parts-on-order WOs, no result.detail', async () => {
    fx.aggregates = [agg('UB', 'B1', 0, { delayReasonCodes: ['PARTS_DELAY'] }), agg('UB', 'B2', 1), agg('UB', 'B3', 2)];
    fx.details = { B1: det('waiting on part'), B2: det(EST), B3: det('') };
    const res = await fetch.syncUnit('UB', {});
    expect(res.ok).toBe(true);
    expect(res.detail).toBeUndefined();
    expect(getService.mock.calls.map((c) => c[0])).toEqual(['B1']);
    expect(row('B2').dealer_url).toBeNull();
    expect(row('B2').detail_synced_at).toBeNull();
  });

  it('parts loop reuses the hydrated detail (one call per WO)', async () => {
    fx.aggregates = [agg('UB2', 'P1', 0, { delayReasonCodes: ['PARTS_DELAY'] })];
    fx.details = { P1: det('waiting on part') };
    await fetch.syncUnit('UB2', { hydrateDetail: true });
    expect(getService.mock.calls.map((c) => c[0])).toEqual(['P1']);
  });

  it('detailCap 3 with 6 WOs → 3 calls, newest first', async () => {
    fx.aggregates = [0, 1, 2, 3, 4, 5].map((i) => agg('UC', 'C' + i, i));
    const res = await fetch.syncUnit('UC', { hydrateDetail: true, detailCap: 3 });
    expect(getService.mock.calls.map((c) => c[0]).sort()).toEqual(['C3', 'C4', 'C5']);
    expect(res.detail.skipped).toBe(3);
  });

  it('max in-flight 2', async () => {
    fx.aggregates = [0, 1, 2, 3, 4, 5].map((i) => agg('UD', 'D' + i, i));
    let inFlight = 0, max = 0;
    fx.impl = (id) => new Promise((resolve) => {
      inFlight++; max = Math.max(max, inFlight);
      setTimeout(() => { inFlight--; resolve(det('x ' + id)); }, 5);
    });
    const res = await fetch.syncUnit('UD', { hydrateDetail: true });
    expect(getService).toHaveBeenCalledTimes(6);
    expect(max).toBe(2);
    expect(res.detail.hydrated).toBe(6);
  });

  it('one rejecting + one never resolving → ok, others stored', async () => {
    fx.aggregates = [agg('UE', 'E1', 0), agg('UE', 'E2', 1), agg('UE', 'E3', 2), agg('UE', 'E4', 3)];
    fx.impl = (id) => {
      if (id === 'E1') return Promise.reject(new Error('AAP 500'));
      if (id === 'E2') return new Promise(() => {});
      return Promise.resolve(det(EST));
    };
    const res = await fetch.syncUnit('UE', { hydrateDetail: true, detailTimeoutMs: 50 });
    expect(res.ok).toBe(true);
    expect(res.detail).toEqual({ hydrated: 2, dealerFound: 2, skipped: 0, failed: 2 });
    expect(row('E3').dealer_url).toBe(EST);
    expect(row('E4').dealer_url).toBe(EST);
    expect(row('E1').dealer_url).toBeNull();
    expect(row('E2').detail_synced_at).toBeNull();
  });

  it('unitRow owning WO X → dealer_source unit_row; others unchanged', async () => {
    fx.aggregates = [agg('UF', 'X', 0), agg('UF', 'Y', 1), agg('UF', 'Z', 2)];
    fx.details = { X: det('nothing'), Y: det('nothing'), Z: det('https://dtna.my.site.com/Servicetracker/s/case/C1') };
    const unitRow = { equipmentId: 'UF', workRequestId: 'X', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/V1', asistLabel: 'Fleet Estimate' };
    await fetch.syncUnit('UF', { hydrateDetail: true, unitRow });
    expect(row('X').dealer_url).toBe('https://volvopg.asist.decisiv.net/fleet/estimates/V1');
    expect(row('X').dealer_source).toBe('unit_row');
    expect(row('X').dealer_label).toBe('Fleet Estimate');
    expect(row('Y').dealer_url).toBeNull();
    expect(row('Z').dealer_source).toBe('dtna');
    // Unit row owning Z does not overwrite the thread's link.
    const unitRow2 = { equipmentId: 'UF', _offsiteWrId: 'Z', workRequestId: 'Y', offsiteShopEventUrl: 'https://volvopg.asist.decisiv.net/fleet/estimates/V2' };
    await fetch.syncUnit('UF', { hydrateDetail: true, unitRow: unitRow2 });
    expect(row('Z').dealer_source).toBe('dtna');
    expect(row('Y').dealer_url).toBeNull();
  });
});
