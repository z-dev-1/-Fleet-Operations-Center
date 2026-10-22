import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const vn = require('../src/repair-intel/vendor-network');

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
    reportedDateTime: new Date(Date.now() - 60 * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - 59 * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 400,
  }, o);
}

describe('repair-intel vendor-network', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-vn-'));
    setDataDir(tmpDir);
    engine.close();
    // Acme does a brake repair on U1, then the SAME brake comes back 20 days
    // later (repeat failure against Acme's completed repair).
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'V1', assetDisplayName: 'U1', vendor: 'Acme Repair',
      reportedDateTime: new Date(Date.now() - 60 * DAY).toISOString(), completedDateTime: new Date(Date.now() - 59 * DAY).toISOString() })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'V2', assetDisplayName: 'U1', vendor: 'Beta Fleet',
      reportedDateTime: new Date(Date.now() - 39 * DAY).toISOString(), completedDateTime: new Date(Date.now() - 38 * DAY).toISOString() })));
    // Acme also handles a lights repair (no repeat).
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'V3', assetDisplayName: 'U2', vendor: 'Acme Repair',
      suggestedItems: [{ level1: 'Lights' }] })));
    // Excluded vendor must be invisible everywhere.
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'V4', assetDisplayName: 'U3', vendor: 'Goodyear Commercial' })));
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('builds vendor scorecards excluding excluded vendors', () => {
    const sc = vn.vendorScorecards({});
    expect(sc.ok).toBe(true);
    const names = sc.vendors.map(v => v.vendor);
    expect(names).toContain('Acme Repair');
    expect(names).toContain('Beta Fleet');
    expect(names).not.toContain('Goodyear Commercial');
    const acme = sc.vendors.find(v => v.vendor === 'Acme Repair');
    expect(acme.events).toBe(2);
    expect(acme.units).toBe(2);
    expect(acme.downtimeCoverage).toBe(100);
    expect(acme.estimateCostTotal).toBe(800);
  });

  it('computes per-vendor repeat-failure rates', () => {
    const rr = vn.vendorRepeatRates({});
    const acme = rr.vendors.find(v => v.vendor === 'Acme Repair');
    // Acme completed the brake repair (V1); the brake returned 20d later (V2) => 1 repeat of 2 basis.
    expect(acme.basis).toBe(2);       // V1 brakes + V3 lights both completed
    expect(acme.repeats).toBe(1);     // only brakes recurred
    expect(acme.repeatRatePct).toBe(50);
  });

  it('flags components spread across multiple vendors', () => {
    const mv = vn.multiVendorComponents({});
    const brakes = mv.components.find(c => c.component.includes('brakes'));
    expect(brakes).toBeTruthy();
    expect(brakes.vendorCount).toBe(2); // Acme + Beta on brakes
  });

  it('buildNetwork returns the combined payload', () => {
    const net = vn.buildNetwork({});
    expect(net.ok).toBe(true);
    expect(net.scorecards.length).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(net.repeatRates)).toBe(true);
    expect(Array.isArray(net.multiVendor)).toBe(true);
  });
});
