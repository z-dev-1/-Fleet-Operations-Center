// tests/trends-extracted.test.js — relay-extract AC31 (§12.6): buildTrends().extracted on a tmp
// SQLite fixture of three real digests (39582, IND260261, B62281) with offsite_dwell, under the
// same _where filters. ETC misses are the COUNTED explicit repair misses (Path B): 39582's two
// parts ship-date misses do not count; a thread that explicitly revises a past ETC does. Also the
// analysis gate: a summary whose every sentence is dropped is stored as null (aiGate 'rejected').
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import * as T from './fixtures/extract/ri-trends-3.js';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const trends = require('../src/repair-intel/trends');
const analysis = require('../src/repair-intel/analysis');

const MK = 'M & K Truck Centers - Dunmore, PA';
const PB = 'The Peterbilt Store - Hartford';
let tmpDir;
let seeded;

describe('Trends extracted section (AC31)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-tx-'));
    setDataDir(tmpDir);
    engine.close();
    seeded = T.seed(store, T.specs());
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('byPartNumber, counted ETC misses, approval cycle, dwell, calls, reject reasons, coverage', () => {
    const x = trends.buildTrends({ sinceMs: 0 }).extracted;
    expect(x.byPartNumber).toContainEqual({ key: '85152780', count: 1, units: 1 });
    expect(x.byPartNumber).toHaveLength(4);                    // + the three IND260261 parts
    expect(x.etcMissByVendor).toContainEqual({ key: 'Volvo (ASIST)', misses: 0, wos: 1, rate: 0 });
    expect(x.etcMissByVendor.map((r) => r.key).sort()).toEqual(['PACCAR', 'TA', 'Volvo (ASIST)']);
    expect(x.etcMissByDealer.map((r) => r.key).sort()).toEqual([MK, PB]);
    // IND260261: V1 submitted 10/30 13:00Z -> first approval 11/05 14:00Z. B62281 has no submitted time.
    expect(x.approvalCycle.n).toBe(1);
    expect(x.approvalCycle.medianMs).toBe(Date.parse('2026-11-05T14:00:00Z') - Date.parse('2026-10-30T13:00:00Z'));
    expect(x.approvalCycle.p90Ms).toBe(x.approvalCycle.medianMs);
    const d39 = seeded.S39582.dwell;
    const dB = seeded.SB62281.dwell;
    expect(d39.approval).toBeGreaterThan(0);
    expect(x.dealerDwell).toContainEqual({ key: MK, medianApprovalMs: d39.approval, medianRepairMs: d39.repair, n: 1 });
    expect(x.dealerDwell).toContainEqual({ key: PB, medianApprovalMs: dB.approval, medianRepairMs: dB.repair, n: 1 });
    expect(x.unansweredCallsByDealer).toEqual([{ key: MK, calls: 2, wos: 1 }]);
    expect(x.rejectReasonsByVendor).toEqual([{ key: 'TA', reasons: [{ key: 'Question/Concern', count: 1 }] }]);
    expect(x.coverage).toEqual({ eventsWithFacts: 3, events: 3 });
  });

  it('the same _where filters narrow every list', () => {
    const x = trends.buildTrends({ sinceMs: 0, vendor: 'Volvo (ASIST)' }).extracted;
    expect(x.byPartNumber).toEqual([{ key: '85152780', count: 1, units: 1 }]);
    expect(x.etcMissByVendor).toEqual([{ key: 'Volvo (ASIST)', misses: 0, wos: 1, rate: 0 }]);
    expect(x.etcMissByDealer.map((r) => r.key)).toEqual([MK]);
    expect(x.approvalCycle.n).toBe(0);
    expect(x.dealerDwell.map((r) => r.key)).toEqual([MK]);
    expect(x.rejectReasonsByVendor).toEqual([]);
    expect(x.coverage).toEqual({ eventsWithFacts: 1, events: 1 });
    const ta = trends.buildTrends({ sinceMs: 0, vendor: 'TA' }).extracted;
    expect(ta.byPartNumber.map((r) => r.key).sort()).toEqual(['4049968C99', '4125033C96', '6121796C1']);
    expect(ta.unansweredCallsByDealer).toEqual([]);
  });

  it('an explicit ETC revision counts one miss for its vendor; parts misses never do', () => {
    T.seed(store, [T.revisedSpec()]);
    const x = trends.buildTrends({ sinceMs: 0 }).extracted;
    expect(x.etcMissByVendor).toContainEqual({ key: 'TA', misses: 1, wos: 2, rate: 0.5 });
    expect(x.etcMissByVendor).toContainEqual({ key: 'Volvo (ASIST)', misses: 0, wos: 1, rate: 0 });
    expect(x.etcMissByVendor[0].key).toBe('TA');
    expect(x.coverage).toEqual({ eventsWithFacts: 4, events: 4 });
  });

  it('analysis: a summary that loses every sentence to the gate is stored null (aiGate rejected)', async () => {
    const bad = JSON.stringify({ summary: 'Harness Part #85152799 failed twice.', events: [], recommendations: [] });
    const relay = { ask: async () => bad, getStatus: () => ({ model: 'test-model' }) };
    const res = await analysis.analyzeUnit('39582', { force: true, relay });
    expect(res.ok).toBe(true);
    expect(res.summary).toBeNull();
    expect(res.aiGate).toBe('rejected');
    expect(JSON.parse(store.getAiAnalysis('39582').report_json).summary).toBeNull();
  });
});
