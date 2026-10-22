import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const trends = require('../src/repair-intel/trends');

const DAY = 24 * 3600 * 1000;
let tmpDir;

function wo(o) {
  return Object.assign({
    workRequestId: 'WR' + Math.random().toString(36).slice(2),
    assetDisplayName: 'U1',
    vendor: 'Acme Repair',
    category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } },
    suggestedItems: [{ level1: 'Brakes' }],
    assetDomicileSite: 'ABE1',
    operator: 'DSP-A',
    reportedDateTime: new Date(Date.now() - 40 * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - 39 * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 300,
  }, o);
}

describe('repair-intel trends (fleet aggregation)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-trends-'));
    setDataDir(tmpDir);
    engine.close();
    // 3 units, 2 vendors, 2 domiciles, a PM, and one excluded (Goodyear).
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'T1', assetDisplayName: 'U1', vendor: 'Acme Repair', assetDomicileSite: 'ABE1' })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'T2', assetDisplayName: 'U2', vendor: 'Acme Repair', assetDomicileSite: 'ABE1',
      reportedDateTime: new Date(Date.now() - 100 * DAY).toISOString(), completedDateTime: new Date(Date.now() - 99 * DAY).toISOString() })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'T3', assetDisplayName: 'U3', vendor: 'Beta Fleet', assetDomicileSite: 'DEN2', operator: 'DSP-B' })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'T4', assetDisplayName: 'U1', category: 'Preventive Maintenance', suggestedItems: [{ level1: 'Oil' }] })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'T5', assetDisplayName: 'U2', vendor: 'Goodyear Commercial' }))); // excluded
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('totals exclude excluded vendors and count units/PM/corrective', () => {
    const d = trends.buildTrends({});
    expect(d.ok).toBe(true);
    expect(d.totals.events).toBe(4);      // Goodyear excluded
    expect(d.totals.units).toBe(3);
    expect(d.totals.pm).toBe(1);
    expect(d.totals.corrective).toBe(3);
    expect(d.totals.downtimeHours).toBeGreaterThan(0);
    expect(d.totals.downtimeCoverage).toBe(100);
    expect(d.totals.estimateCostTotal).toBe(1200); // 4 x 300
  });

  it('groups by vendor and domicile correctly', () => {
    const d = trends.buildTrends({});
    const acme = d.byVendor.find(v => v.key === 'Acme Repair');
    expect(acme.count).toBe(3);
    expect(d.byVendor.find(v => v.key === 'Goodyear Commercial')).toBeUndefined();
    const abe = d.byDomicile.find(v => v.key === 'ABE1');
    expect(abe.count).toBe(3);
  });

  it('applies filters', () => {
    const d = trends.buildTrends({ vendor: 'Beta Fleet' });
    expect(d.totals.events).toBe(1);
    expect(d.totals.units).toBe(1);
    const pm = trends.buildTrends({ woType: 'PM' });
    expect(pm.totals.events).toBe(1);
  });

  it('rolls up parts / back-order from delay reason codes', () => {
    // Add a unit with a PARTS_DELAY signal; it should appear in backorder only.
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'BO1', assetDisplayName: 'U9', vendor: 'Acme Repair',
      suggestedItems: [{ level1: 'Engine' }], delayReasonCodes: ['PARTS_DELAY'] })));
    const d = trends.buildTrends({});
    expect(d.backorder).toBeTruthy();
    expect(d.backorder.events).toBeGreaterThanOrEqual(1);
    expect(d.backorder.byComponent.some(c => /engine/i.test(c.key))).toBe(true);
    // a non-parts event is not counted as back-order
    expect(d.backorder.events).toBeLessThan(d.totals.events);
    // the "which part/system + reason" breakdowns are present
    expect(Array.isArray(d.backorder.byReason)).toBe(true);
    expect(d.backorder.byReason.some(r => /parts/i.test(r.key))).toBe(true);
    expect(Array.isArray(d.backorder.bySubcomponent)).toBe(true);
    // drilling parts-on-order returns the events (with complaint naming the part)
    const drill = trends.drillEvents('partsOnOrder', 'x', { sinceMs: 0 });
    expect(drill.ok).toBe(true);
    expect(drill.totalEvents).toBeGreaterThanOrEqual(1);
    // every drilled event is genuinely flagged parts-on-order
    expect(drill.units.every(u => u.events.every(e => e.partsOnOrder === true))).toBe(true);
  });

  it('drills into a component trend and returns the units + why fields', () => {
    const res = trends.drillEvents('component', 'Brakes');
    expect(res.ok).toBe(true);
    // Brakes were on U1 and U2 (and excluded Goodyear U3 must NOT appear).
    expect(res.unitCount).toBeGreaterThanOrEqual(2);
    const u1 = res.units.find(u => u.equipmentId === 'U1');
    expect(u1).toBeTruthy();
    expect(u1.events[0]).toHaveProperty('complaint');
    expect(u1.events[0]).toHaveProperty('delayReason');
    expect(u1.events[0]).toHaveProperty('url');
    // no excluded vendor leaks in
    expect(res.units.every(u => u.events.every(e => e.vendor !== 'Goodyear Commercial'))).toBe(true);
  });

  it('monthly buckets carry a full status breakdown', () => {
    const d = trends.buildTrends({});
    const m = d.monthly.find(x => x.count > 0);
    expect(m).toBeTruthy();
    // every breakdown field present and numeric
    for (const k of ['completed', 'cancelled', 'inProgress', 'pm', 'unitsAffected']) {
      expect(typeof m[k]).toBe('number');
    }
    // completed + cancelled + inProgress + transferred <= total
    expect((m.completed + m.cancelled + m.inProgress + m.transferred)).toBeLessThanOrEqual(m.count);
  });

  it('drills into a specific month', () => {
    const d = trends.buildTrends({});
    const m = d.monthly.find(x => x.count > 0);
    const res = trends.drillEvents('month', m.month);
    expect(res.ok).toBe(true);
    expect(res.totalEvents).toBe(m.count);
    expect(res.units.length).toBe(m.unitsAffected);
  });

  it('deepSlice distinguishes one-unit-many-times from many-units-once', () => {
    // Seed a clean scenario: unit U-REPEAT gets 3 airbag repairs; 3 distinct
    // units each get ONE wiper repair. Airbag ratio should be 3.0 (1 unit),
    // wiper ratio 1.0 (3 units).
    for (let i = 0; i < 3; i++) {
      store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'AB' + i, assetDisplayName: 'U-REPEAT',
        suggestedItems: [{ level1: 'Airbag' }], reportedDateTime: new Date(Date.now() - (10 + i) * DAY).toISOString() })));
    }
    ['WU1', 'WU2', 'WU3'].forEach((u, i) => {
      store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'WP' + i, assetDisplayName: u,
        suggestedItems: [{ level1: 'Wiper' }] })));
    });
    const slice = trends.deepSlice('component');
    const airbag = slice.groups.find(g => g.key === 'Airbag');
    const wiper = slice.groups.find(g => g.key === 'Wiper');
    expect(airbag.events).toBe(3);
    expect(airbag.units).toBe(1);
    expect(airbag.repeatRatio).toBe(3);        // one unit, three times
    expect(airbag.repeatUnits[0].equipmentId).toBe('U-REPEAT');
    expect(wiper.events).toBe(3);
    expect(wiper.units).toBe(3);
    expect(wiper.repeatRatio).toBe(1);         // three units, once each
    expect(wiper.repeatUnitCount).toBe(0);
  });

  it('repeatOffenders lists units with the same component 2+ times', () => {
    const res = trends.repeatOffenders();
    const ab = res.offenders.find(o => o.equipmentId === 'U-REPEAT' && o.component === 'Airbag');
    expect(ab).toBeTruthy();
    expect(ab.count).toBe(3);
    // a once-only unit must not appear
    expect(res.offenders.some(o => o.equipmentId === 'WU1')).toBe(false);
  });

  it('builds monthly buckets and filter options', () => {
    const d = trends.buildTrends({});
    expect(Array.isArray(d.monthly)).toBe(true);
    expect(d.monthly.length).toBeGreaterThanOrEqual(1);
    const opts = trends.filterOptions();
    expect(opts.vendors).toContain('Acme Repair');
    expect(opts.vendors).not.toContain('Goodyear Commercial');
    expect(opts.domiciles).toContain('ABE1');
  });
});
