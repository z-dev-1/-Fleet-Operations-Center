// tests/repair-intel-migration.test.js — additive ri_repair_event columns for
// history dealer links / 3C, on a table created by the legacy DDL.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
const engine = require('../src/store/sqlite_engine');
const schema = require('../src/repair-intel/schema');
const store = require('../src/repair-intel/store');

const NEW_COLS = ['dealer_url', 'dealer_source', 'dealer_label', 'detail_synced_at', 'detail_modified_at', 'wo_evidence', 'wo_3c', 'wo_3c_hash'];
let tmpDir;

const cols = () => engine.prepare('PRAGMA table_info(ri_repair_event)').all().map((c) => c.name);
const rowOf = (sid) => engine.prepare('SELECT * FROM ri_repair_event WHERE source_id = ?').get(sid);

function wo(overrides) {
  return Object.assign({
    workRequestId: 'M1', assetDisplayName: 'UNIT-M', vendor: 'Acme Truck Repair', category: 'Unplanned Repair',
    status: { description: { value: 'COMPLETED' } }, damageDescription: 'air leak',
    reportedDateTime: '2026-10-01T10:00:00Z', completedDateTime: '2026-10-02T10:00:00Z',
    lastModifiedDateTime: '2026-10-02T10:00:00Z',
  }, overrides);
}

describe('repair-intel additive migration', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ri-mig-'));
    setDataDir(tmpDir);
    engine.close();
    // Legacy table: the current DDL has none of the new columns.
    engine.exec(schema.DDL);
    engine.prepare("INSERT INTO ri_repair_event (source_id, equipment_id, vendor, raw_hash, excluded_vendor) VALUES ('LEG1', 'UNIT-L', 'Old Vendor', 'h0', 0)").run();
  });
  afterAll(() => {
    try { engine.close(); } catch (_) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  it('legacy table has none of the new columns before ensureSchema', () => {
    const c = cols();
    for (const n of NEW_COLS) expect(c).not.toContain(n);
  });

  it('ensureSchema adds all 8 columns and keeps the row intact', () => {
    expect(schema.ensureSchema()).toBe(true);
    const c = cols();
    for (const n of NEW_COLS) expect(c).toContain(n);
    const r = rowOf('LEG1');
    expect(r.equipment_id).toBe('UNIT-L');
    expect(r.vendor).toBe('Old Vendor');
    expect(r.dealer_url).toBeNull();
    expect(r.wo_evidence).toBeNull();
  });

  it('_migrate is idempotent', () => {
    expect(() => schema._migrate()).not.toThrow();
    expect(() => schema._migrate()).not.toThrow();
    expect(cols().filter((n) => n === 'dealer_url').length).toBe(1);
  });

  it('new columns survive a changed-hash upsertEvent', () => {
    expect(store.upsertEvent(store.normalizeWorkOrder(wo()))).toBe('added');
    store.setWoDetail('M1', {
      dealer: { url: 'https://pssmfleet.decisiv.net/fleet/estimates/123', source: 'estimate', label: 'Fleet Estimate' },
      evidence: { v: 1, complaint: 'air leak', cause: '', correction: '', comments: [], commentCount: 0, lastCommentAt: null },
      modifiedAt: 111,
    });
    store.setWo3c('M1', { v: 1, complaint: { text: 'air leak', status: 'confirmed' } }, 'hash1');
    expect(store.upsertEvent(store.normalizeWorkOrder(wo({ damageDescription: 'air leak at tank', lastModifiedDateTime: '2026-10-03T10:00:00Z' })))).toBe('updated');
    const r = rowOf('M1');
    expect(r.reported_complaint).toBe('air leak at tank');
    expect(r.dealer_url).toBe('https://pssmfleet.decisiv.net/fleet/estimates/123');
    expect(r.dealer_source).toBe('estimate');
    expect(r.dealer_label).toBe('Fleet Estimate');
    expect(JSON.parse(r.wo_evidence).complaint).toBe('air leak');
    expect(r.detail_modified_at).toBe(111);
    expect(r.detail_synced_at).toBeGreaterThan(0);
    expect(JSON.parse(r.wo_3c).complaint.status).toBe('confirmed');
    expect(r.wo_3c_hash).toBe('hash1');
  });

  it('setWoDetail with dealer:null keeps a prior dealer URL', () => {
    store.setWoDetail('M1', { dealer: null, evidence: null, modifiedAt: 222 });
    const r = rowOf('M1');
    expect(r.dealer_url).toBe('https://pssmfleet.decisiv.net/fleet/estimates/123');
    expect(r.wo_evidence).toBeNull();
    expect(r.detail_modified_at).toBe(222);
  });

  it('setDealerUrlIfEmpty fills only an empty slot', () => {
    store.setDealerUrlIfEmpty('M1', { url: 'https://dtna.my.site.com/Servicetracker/s/case/X1', source: 'unit_row', label: 'Dealer' });
    expect(rowOf('M1').dealer_url).toBe('https://pssmfleet.decisiv.net/fleet/estimates/123');
    store.setDealerUrlIfEmpty('LEG1', { url: 'https://dtna.my.site.com/Servicetracker/s/case/X1', source: 'unit_row', label: 'Dealer' });
    const r = rowOf('LEG1');
    expect(r.dealer_url).toBe('https://dtna.my.site.com/Servicetracker/s/case/X1');
    expect(r.dealer_source).toBe('unit_row');
  });
});
