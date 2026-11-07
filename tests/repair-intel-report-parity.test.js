// tests/repair-intel-report-parity.test.js — the unit report is unchanged when
// the new dealer columns are empty; dealer keys are only added when present.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const report = require('../src/repair-intel/report');
const trends = require('../src/repair-intel/trends');

const DAY = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const UNIT = 'UNIT-P';
let tmpDir;

function wo(id, i, extra) {
  return Object.assign({
    workRequestId: id, assetDisplayName: UNIT, vendor: 'Acme Truck Repair', category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } }, suggestedItems: [{ level1: 'Brakes', level2: 'Pads' }],
    damageDescription: 'grinding ' + id,
    reportedDateTime: new Date(Date.now() - (30 - i) * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - (29 - i) * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 100 * (i + 1),
  }, extra || {});
}

// The pre-change timeline mapping, copied verbatim.
function _num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function legacyTimeline(events) {
  return events.slice().sort((a, b) => (b.reported_at || b.created_at || 0) - (a.reported_at || a.created_at || 0))
    .map(e => ({
      reportedAt: e.reported_at, completedAt: e.repair_completed_at || null, workOrderId: e.work_order_id, amzId: e.amz_id, vendor: e.vendor,
      category: e.repair_category, component: e.repair_component, status: e.status, woType: e.wo_type,
      complaint: e.reported_complaint,
      rootCause: e.confirmed_root_cause || (e.suspected_root_cause ? ('suspected: ' + e.suspected_root_cause) : null),
      actions: e.corrective_actions || null,
      outcome: e.outcome || null,
      durationHours: e.total_elapsed_ms != null ? Math.round(e.total_elapsed_ms / HOUR_MS) : null,
      estimateCost: _num(e.estimate_cost),
      sourceRefs: (() => { try { return JSON.parse(e.source_refs || '{}'); } catch (_) { return {}; } })(),
    }));
}
const strip = (r) => { const o = Object.assign({}, r); delete o.generatedAt; return o; };
const drill = () => {
  const res = trends.drillEvents('category', 'Unplanned Repair', { equipmentId: UNIT });
  const events = [].concat(...(res.units || []).map((u) => u.events || []));
  return events.map((e) => ({ wo: e.workOrderId, url: e.url, offsiteUrl: e.offsiteUrl })).sort((a, b) => a.wo.localeCompare(b.wo));
};

describe('repair-intel report parity', () => {
  let before, drillBefore;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-par-'));
    setDataDir(tmpDir);
    engine.close();
    store.upsertEvent(store.normalizeWorkOrder(wo('P1', 0)));
    store.upsertEvent(store.normalizeWorkOrder(wo('P2', 1, { caseNumber: 'CASE2' })));
    store.upsertEvent(store.normalizeWorkOrder(wo('P3', 2, { status: { description: { value: 'OPEN' } }, completedDateTime: null })));
    store.upsertEvent(store.normalizeWorkOrder(wo('P4', 3, { suggestedItems: [{ level1: 'Electrical' }] })));
    before = report.buildUnitReport(UNIT);
    drillBefore = drill();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('no new columns populated → report equals the legacy mapping', () => {
    const expected = strip(before);
    expected.timeline = legacyTimeline(store.eventsForUnit(UNIT));
    expect(strip(before)).toEqual(expected);
    expect(before.timeline.length).toBe(4);
    for (const t of before.timeline) expect(Object.keys(t.sourceRefs).sort()).toEqual(['offsite', 'relay']);
  });

  it('dealer stored → relay/offsite unchanged, dealer keys added; rest identical', () => {
    store.setWoDetail('P2', {
      dealer: { url: 'https://pssmfleet.decisiv.net/fleet/estimates/E1', source: 'estimate', label: 'Fleet Estimate' },
      evidence: { v: 1, complaint: 'x', cause: '', correction: '', comments: [], commentCount: 0, lastCommentAt: null },
      modifiedAt: 1,
    });
    store.setWoDetail('P1', { dealer: null, evidence: null, modifiedAt: 1 });
    const after = report.buildUnitReport(UNIT);
    const p2b = before.timeline.find((t) => t.workOrderId === 'P2');
    const p2a = after.timeline.find((t) => t.workOrderId === 'P2');
    expect(p2a.sourceRefs).toEqual(Object.assign({}, p2b.sourceRefs, {
      dealer: 'https://pssmfleet.decisiv.net/fleet/estimates/E1', dealerSource: 'estimate', dealerLabel: 'Fleet Estimate',
    }));
    expect(p2a.sourceRefs.offsite).toBe('https://aap-na.corp.amazon.com/v2/offsite-events/CASE2');
    // Every other timeline entry is identical.
    const others = (r) => r.timeline.filter((t) => t.workOrderId !== 'P2');
    expect(others(after)).toEqual(others(before));
    const { sourceRefs: _a, ...restA } = p2a; const { sourceRefs: _b, ...restB } = p2b;
    expect(restA).toEqual(restB);
    expect(after.executiveSummary).toEqual(before.executiveSummary);
    expect(after.repeatFailures).toEqual(before.repeatFailures);
    expect(drill()).toEqual(drillBefore);
    expect(drillBefore.length).toBe(4);
  });

  it('threeC key absent while wo_3c is null; present and parsed after setWo3c', () => {
    const r1 = report.buildUnitReport(UNIT);
    for (const t of r1.timeline) expect('threeC' in t).toBe(false);
    const three = {
      v: 1, complaint: { text: 'Grinding.', status: 'confirmed' }, cause: { text: 'Not recorded', status: 'not_recorded' },
      correction: { text: 'Pads replaced.', status: 'suspected' }, basis: 'aap', ai: true, at: 1, model: null,
    };
    store.setWo3c('P3', three, 'h1');
    const r2 = report.buildUnitReport(UNIT);
    const p3 = r2.timeline.find((t) => t.workOrderId === 'P3');
    expect(p3.threeC).toEqual(three);
    for (const t of r2.timeline.filter((x) => x.workOrderId !== 'P3')) expect('threeC' in t).toBe(false);
    const { threeC: _t, ...rest } = p3;
    expect(rest).toEqual(r1.timeline.find((t) => t.workOrderId === 'P3'));
    expect(r2.executiveSummary).toEqual(r1.executiveSummary);
  });
});
