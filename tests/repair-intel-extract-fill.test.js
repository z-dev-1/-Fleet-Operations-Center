// tests/repair-intel-extract-fill.test.js — relay-extract AC21 (§13): fetch.syncUnit with
// hydrateDetail runs the 3a extraction (digest, extract_hash, counted etc_miss_count, estimate
// cost, parts) and the unit-row offsite dwell; upsertEvent keeps extracted values over a null
// re-sync (COALESCE); vendor-stated corrective actions are never overwritten by AI; the 3C
// evidence falls back to the extractor's cause / correction. aap_api + logger are stubs; real
// mapper, real store, tmp SQLite.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import * as V from './fixtures/extract/relay-vendors.js';
import * as R from './fixtures/extract/relay-39582-volvo.js';
import { blocks } from './fixtures/extract/fact-39582.js';
import { stageHistory } from './fixtures/extract/deep-scan-output-shape.js';
const require = createRequire(import.meta.url);

function inject(rel, exportsObj) {
  const resolved = require.resolve('../' + rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}
const silent = () => ({ debug() {}, info() {}, warn() {}, error() {}, log() {} });
silent.createLogger = silent; silent.setLogDir = () => {}; silent.setLevel = () => {}; silent.setSilent = () => {};
silent.LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

const fx = { aggregates: [], details: {} };
inject('src/utils/logger', silent);
inject('src/scrapers/aap_api', {
  searchAllPages: async () => fx.aggregates,
  getAsset: async () => ({}),
  getService: async (id) => fx.details[id],
});

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const fetch = require('../src/repair-intel/fetch');
const dealerLink = require('../src/repair-intel/dealer-link');
const mapper = require('../src/scrapers/aap_api_mapper');

let tmpDir;
const row = (sid) => engine.prepare('SELECT * FROM ri_repair_event WHERE source_id = ?').get(sid);
const parts = (sid) => engine.prepare('SELECT p.* FROM ri_repair_part p JOIN ri_repair_event e ON e.id = p.event_id WHERE e.source_id = ?').all(sid);
const agg = (sid, unit, vendor, extra) => Object.assign({
  workRequestId: sid, assetDisplayName: unit, vendor, category: 'Unplanned Repair', status: { description: { value: 'OPEN' } },
  damageDescription: 'issue ' + sid, reportedDateTime: '2026-09-23T18:04:00Z', createdDateTime: '2026-09-23T18:04:00Z',
  lastModifiedDateTime: '2026-11-10T00:00:00Z',
}, extra || {});

describe('repair-intel extracted fills (AC21)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-xf-'));
    setDataDir(tmpDir);
    engine.close();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });
  beforeEach(() => { delete process.env.FLEET_EXTRACT; fx.aggregates = []; fx.details = {}; });
  afterEach(() => { delete process.env.FLEET_EXTRACT; });

  it('IND260261 (TA): 3a writes estimate_cost 24804.13, extract_hash and etc_miss_count', async () => {
    fx.aggregates = [agg('I1', 'IND260261', 'TA', { totalEstimatePendingApprovalCost: 500 })];
    fx.details = { I1: V.relayIND260261 };
    const res = await fetch.syncUnit('IND260261', { hydrateDetail: true });
    expect(res.ok).toBe(true);
    expect(res.detail).toEqual({ hydrated: 1, dealerFound: 0, skipped: 0, failed: 0 });
    const r = row('I1');
    expect(r.estimate_cost).toBe(24804.13);
    expect(r.extract_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(r.etc_miss_count).toBe(0);
    const d = JSON.parse(r.extracted_facts);
    expect(d.estimate.approvedTotal).toBe(24804.13);
    expect(parts('I1').map((p) => p.part_number).sort()).toEqual(['4049968C99', '4125033C96', '6121796C1']);
  });

  it('a re-sync whose pending cost is null does not erase estimate_cost (COALESCE); an unchanged digest is not rewritten', async () => {
    const before = row('I1');
    fx.aggregates = [agg('I1', 'IND260261', 'TA', { totalEstimatePendingApprovalCost: null, lastModifiedDateTime: '2026-11-11T00:00:00Z' })];
    fx.details = { I1: V.relayIND260261 };
    await fetch.syncUnit('IND260261', { hydrateDetail: true });
    const r = row('I1');
    expect(r.estimate_cost).toBe(24804.13);
    expect(r.extract_hash).toBe(before.extract_hash);
    expect(store.setExtractedFacts('I1', JSON.parse(r.extracted_facts))).toBe(false);
  });

  it('39582 unit row: one ri_repair_part 85152780 qty 1 arrived; offsite dwell + wait_approval_ms', async () => {
    fx.aggregates = [agg('wr-39582', '39582', 'Volvo (ASIST)')];
    fx.details = { 'wr-39582': R.serviceDetail };
    const unitRow = Object.assign({ equipmentId: '39582', workRequestId: 'wr-39582', offsiteStageHistory: stageHistory() }, blocks());
    await fetch.syncUnit('39582', { hydrateDetail: true, unitRow });
    const ps = parts('wr-39582');
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ part_number: '85152780', qty: 1, action: 'arrived', equipment_id: '39582' });
    const r = row('wr-39582');
    expect(r.wait_approval_ms).toBeGreaterThan(0);
    const dw = JSON.parse(r.offsite_dwell);
    expect(dw.approval).toBe(r.wait_approval_ms);
    expect(dw.open).toMatchObject({ stage: 'repair', status: 'Waiting' });
    expect(r.dealer_name).toBe('M & K Truck Centers - Dunmore, PA');
    expect(r.etc_miss_count).toBe(0);                          // parts ship-date misses are not counted
    expect(r.wait_parts_ms).toBeGreaterThan(0);                // parts chain 09/28 -> arrived 11/04
  });

  it('vendor-stated cause / correction: extract_cc = 1 and AI never overwrites corrective_actions', async () => {
    fx.aggregates = [agg('A59', '59080', 'Amerit')];
    fx.details = { A59: V.relay59080 };
    await fetch.syncUnit('59080', { hydrateDetail: true });
    const r = row('A59');
    expect(r.extract_cc).toBe(1);
    expect(r.confirmed_root_cause).toBeTruthy();
    expect(r.corrective_actions).toBeTruthy();
    expect(store.applyAiToEvent('A59', { corrective_actions: 'x', outcome: 'resolved' })).toBe(true);
    const after = row('A59');
    expect(after.corrective_actions).toBe(r.corrective_actions);
    expect(after.outcome).toBe('resolved');
    expect(store.applyAiToEvent('A59', { corrective_actions: 'x' })).toBe(false);
  });

  it('3C evidence falls back to the extracted cause / correction when the structured keys are absent', () => {
    const ev = dealerLink.evidenceFromDetail(V.relay59080, mapper);
    expect(ev.cause).toBe(row('A59').confirmed_root_cause.slice(0, ev.cause.length));
    expect(ev.correction.length).toBeGreaterThan(0);
    process.env.FLEET_EXTRACT = '0';
    const off = dealerLink.evidenceFromDetail(V.relay59080, mapper);
    expect(off.cause).toBe('');
    expect(off.correction).toBe('');
  });

  it('flag off: no extraction columns are written', async () => {
    process.env.FLEET_EXTRACT = '0';
    fx.aggregates = [agg('OFF1', 'IND9', 'TA', { totalEstimatePendingApprovalCost: 500 })];
    fx.details = { OFF1: V.relayIND260261 };
    await fetch.syncUnit('IND9', { hydrateDetail: true });
    const r = row('OFF1');
    expect(r.extract_hash).toBeNull();
    expect(r.extracted_facts).toBeNull();
    expect(r.estimate_cost).toBe(500);
    expect(parts('OFF1')).toEqual([]);
  });
});
