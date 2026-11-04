import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const store = require('../src/repair-intel/store');
const { brainContext } = require('../src/repair-intel/brain-context');

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
    reportedDateTime: new Date(Date.now() - 30 * DAY).toISOString(),
    completedDateTime: new Date(Date.now() - 29 * DAY).toISOString(),
    totalEstimatePendingApprovalCost: 400,
  }, o);
}

describe('repair-intel brain-context', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-bc-'));
    setDataDir(tmpDir);
    engine.close();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns empty string when the engine has no data', () => {
    expect(brainContext()).toBe('');
  });

  it('produces a compact grounded snapshot once data exists', () => {
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'C1', assetDisplayName: 'U1' })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'C2', assetDisplayName: 'U2', suggestedItems: [{ level1: 'Lights' }] })));
    store.upsertEvent(store.normalizeWorkOrder(wo({ workRequestId: 'C3', assetDisplayName: 'U3', vendor: 'Goodyear Commercial' }))); // excluded

    const ctx = brainContext();
    expect(ctx).toContain('REPAIR INTELLIGENCE');
    expect(ctx).toContain('2 repair events'); // Goodyear excluded
    expect(ctx).toContain('ADVISORY');
    // Goodyear appears only in the "excludes ..." disclaimer line, never as a
    // busiest-vendor entry — verify it's not listed with a count.
    expect(ctx).not.toMatch(/Goodyear\s*\(\d/);
    expect(ctx).toContain('Acme Repair');
    // Short: a handful of lines, not a wall of text.
    expect(ctx.split('\n').length).toBeLessThan(12);
  });
});
