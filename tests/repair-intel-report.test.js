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

const DAY = 24 * 3600 * 1000;
let tmpDir;

// Seed a raw-like work order the normalizer accepts.
function wo(overrides) {
  return Object.assign({
    workRequestId: 'WR' + Math.random().toString(36).slice(2),
    assetDisplayName: 'UNIT-1',
    vendor: 'Acme Truck Repair',
    category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } },
    suggestedItems: [{ level1: 'Brakes', level2: 'Pads' }],
    damageDescription: 'grinding noise when braking',
    reportedDateTime: new Date(Date.now() - 10 * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - 9 * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 500,
  }, overrides);
}

describe('repair-intel report (deterministic)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-report-'));
    setDataDir(tmpDir);
    engine.close(); // force reopen against tmp dir
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('builds a summary with correct counts and excludes excluded vendors', () => {
    const now = Date.now();
    // Two brake repairs 30 days apart (repeat failure), one PM, one excluded vendor.
    store.upsertEvent(store.normalizeWorkOrder(wo({
      workRequestId: 'A1',
      reportedDateTime: new Date(now - 60 * DAY).toISOString(),
      completedDateTime: new Date(now - 59 * DAY).toISOString(),
    })));
    store.upsertEvent(store.normalizeWorkOrder(wo({
      workRequestId: 'A2',
      reportedDateTime: new Date(now - 30 * DAY).toISOString(),
      completedDateTime: new Date(now - 29 * DAY).toISOString(),
    })));
    store.upsertEvent(store.normalizeWorkOrder(wo({
      workRequestId: 'A3',
      category: 'Preventive Maintenance',
      suggestedItems: [{ level1: 'Oil', level2: 'Filter' }],
    })));
    store.upsertEvent(store.normalizeWorkOrder(wo({
      workRequestId: 'A4',
      vendor: 'Goodyear Commercial',
    })));

    const rep = report.buildUnitReport('UNIT-1');
    expect(rep.equipmentId).toBe('UNIT-1');
    // excluded vendor (Goodyear) must NOT appear
    expect(rep.executiveSummary.totalRepairEvents).toBe(3);
    expect(rep.executiveSummary.pmEvents).toBe(1);
    expect(rep.executiveSummary.correctiveRepairs).toBe(2);
    // the two brake events form a repeat-failure group
    const brakeGroup = rep.repeatFailures.find(g => g.component.includes('brakes'));
    expect(brakeGroup).toBeTruthy();
    expect(brakeGroup.count).toBe(2);
    // timeline newest first
    expect(rep.timeline.length).toBe(3);
    expect(rep.timeline[0].reportedAt).toBeGreaterThanOrEqual(rep.timeline[1].reportedAt);
  });

  it('classifies effectiveness and totals downtime deterministically', () => {
    const events = store.eventsForUnit('UNIT-1');
    const eff = report.classifyEffectiveness(events);
    // all 3 completed; the two brake jobs repeat -> resolvedRepeated for the earlier one
    expect(eff.resolved + eff.resolvedRepeated).toBe(3);
    const dt = report.downtimeTotals(events);
    expect(dt.eventsCounted).toBe(3);
    expect(dt.totalHours).toBeGreaterThan(0);
    expect(dt.coverage).toBe(100);
  });
});
