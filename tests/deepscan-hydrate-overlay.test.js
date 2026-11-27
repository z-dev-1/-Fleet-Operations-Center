// tests/deepscan-hydrate-overlay.test.js
// Deep-scan hydrate save must not roll fleetData back to the start-time
// snapshot (src/window/hydrate-overlay.js, wired into window/index.js
// _maybeRunDeepScanAsync). index.js needs Electron, so the overlay is tested on
// the extracted helper with a fake store + clock, plus a source-text wiring pin.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const H = require('../src/window/hydrate-overlay');
const { OFFSITE_FIELDS, clearOffsite } = require('../src/utils/offsite-owner');

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const OLD_SYNC = '2026-11-20T11:00:00.000Z';
const OLD_SCRAPE = '2026-11-20T10:59:00.000Z';
const clone = (v) => JSON.parse(JSON.stringify(v));

function mkStore(init = {}) {
  const data = clone(init);
  const saves = [];
  return {
    data, saves,
    load: (k, d) => (data[k] === undefined ? d : clone(data[k])),
    save: (k, v) => { data[k] = clone(v); saves.push(k); },
  };
}
function fleet(rows, extra = {}) {
  return { rows, count: rows.length, unavailableCount: 1, scrapedAt: OLD_SCRAPE, syncedAt: OLD_SYNC, stale: false, source: 'aap-api', ...extra };
}
// Run a hydrate step on a working (start-time) row and capture its patch.
function hydrate(patches, row, mutate, opts = {}) {
  const before = H.snapshotOwned(row);
  const cleared = mutate(row) === 'cleared';
  const p = H.capturePatch(before, row, { ownerWr: opts.ownerWr || row.workRequestId, offsiteCleared: cleared });
  if (p) patches.set(String(row.equipmentId), p);
  return p;
}

describe('deep-scan hydrate overlay: no rollback', () => {
  it('same row count: newer X value kept, deep-scan-owned fields overlaid', () => {
    // Start-time snapshot (what the hydrate loop works on).
    const snap = [
      { equipmentId: 'X', workRequestId: 'w1', lifecycleState: 'Unavailable', lifecycleReason: 'parts arrived', vendor: 'Shop A' },
      { equipmentId: 'Y', workRequestId: 'w9', lifecycleState: 'Available', vendor: 'Shop B' },
    ];
    // A newer refresh saved during the loop: X moved to 'in repair', Y changed vendor.
    const store = mkStore({ fleetData: fleet([
      { equipmentId: 'X', workRequestId: 'w1', lifecycleState: 'Unavailable', lifecycleReason: 'in repair', vendor: 'Shop A' },
      { equipmentId: 'Y', workRequestId: 'w9', lifecycleState: 'Available', vendor: 'Shop C' },
    ]) });
    const patches = new Map();
    hydrate(patches, snap[0], (r) => {
      r.pmBDue = '2026-12-01'; r.geofence = 'Yard 4';
      r.fullConversation = 'tech: waiting on part'; r._convFetchedAt = '2026-11-20T11:30:00.000Z';
      r.relayFacts = { eta: 'Fri' }; r.relayFactsWr = 'w1';
    });
    const saved = H.saveHydrateOverlay({ store, patches, now: () => NOW });
    const rows = store.data.fleetData.rows;
    expect(saved).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows[0].lifecycleReason).toBe('in repair');
    expect(rows[0]).toMatchObject({ pmBDue: '2026-12-01', geofence: 'Yard 4', fullConversation: 'tech: waiting on part', relayFacts: { eta: 'Fri' }, relayFactsWr: 'w1' });
    expect(rows[1]).toEqual({ equipmentId: 'Y', workRequestId: 'w9', lifecycleState: 'Available', vendor: 'Shop C' });
    expect(snap[0].lifecycleReason).toBe('parts arrived'); // working set untouched
  });

  it('rows added since the snapshot are kept; rows removed since are not resurrected', () => {
    const snapC = { equipmentId: 'C', workRequestId: 'wc', lifecycleState: 'Unavailable' };
    const snapA = { equipmentId: 'A', workRequestId: 'wa', lifecycleState: 'Unavailable' };
    const store = mkStore({ fleetData: fleet([
      { equipmentId: 'A', workRequestId: 'wa', lifecycleState: 'Unavailable' },
      { equipmentId: 'D', workRequestId: 'wd', lifecycleState: 'Unavailable', lifecycleReason: 'new' },
    ]) });
    const patches = new Map();
    hydrate(patches, snapC, (r) => { r.pmBDue = '2026-12-02'; });
    hydrate(patches, snapA, (r) => { r.pmBDue = '2026-12-03'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    const rows = store.data.fleetData.rows;
    expect(rows.map((r) => r.equipmentId)).toEqual(['A', 'D']);
    expect(rows[0].pmBDue).toBe('2026-12-03');
    expect(rows[1]).toEqual({ equipmentId: 'D', workRequestId: 'wd', lifecycleState: 'Unavailable', lifecycleReason: 'new' });
    expect(store.data.fleetData.count).toBe(2);
  });

  it('WR guard: unit fields apply, WR-level fields do not land on a different current WR', () => {
    const snap = { equipmentId: 'A', workRequestId: 'w1', lifecycleState: 'Unavailable' };
    const store = mkStore({ fleetData: fleet([{ equipmentId: 'A', workRequestId: 'w2', lifecycleState: 'Unavailable' }]) });
    const patches = new Map();
    hydrate(patches, snap, (r) => {
      r.pmBDue = '2026-12-04';
      r.fullConversation = 'old WR thread'; r.relayFacts = { a: 1 }; r._secondaryWRs = [{ workRequestId: 'w1b' }];
      r.offsiteShopEventUrl = 'https://dealer/u1'; r._offsiteWrId = 'w1';
    });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    const row = store.data.fleetData.rows[0];
    expect(row.pmBDue).toBe('2026-12-04');
    for (const k of ['fullConversation', 'relayFacts', '_secondaryWRs', 'offsiteShopEventUrl', '_offsiteWrId']) expect(row[k]).toBeUndefined();
  });

  it('offsite clear is replayed on the current row (same WR); a link change ends on the new link', () => {
    const withU1 = () => ({
      equipmentId: 'A', workRequestId: 'w1', offsiteShopEventUrl: 'https://dealer/u1', _offsiteWrId: 'w1',
      offsiteStage: 'Ready', offsiteStageDetail: 'ready', dealerName: 'Dealer 1', _factFilled: { dealerName: 1, other: 1 },
    });
    // Clear only.
    let snap = withU1();
    let store = mkStore({ fleetData: fleet([withU1()]) });
    let patches = new Map();
    hydrate(patches, snap, (r) => { clearOffsite(r); return 'cleared'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    let row = store.data.fleetData.rows[0];
    for (const k of OFFSITE_FIELDS) if (k in row) expect(row[k]).toBe('');
    expect(row._offsiteWrId).toBe('');
    expect(row._factFilled).toEqual({ other: 1 });
    // Link change: clear + new U2.
    snap = withU1();
    store = mkStore({ fleetData: fleet([withU1()]) });
    patches = new Map();
    hydrate(patches, snap, (r) => { clearOffsite(r); r.offsiteShopEventUrl = 'https://dealer/u2'; r._offsiteWrId = 'w1'; return 'cleared'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    row = store.data.fleetData.rows[0];
    expect(row.offsiteShopEventUrl).toBe('https://dealer/u2');
    expect(row._offsiteWrId).toBe('w1');
    expect(row.offsiteStage).toBe('');
    expect(row.dealerName).toBe('');
  });

  it('a newer stage read the hydrate did not touch survives (322504)', () => {
    const snap = { equipmentId: 'A', workRequestId: 'w1', offsiteStage: 'Ready', offsiteStageDetail: 'ready', _stageReadAt: '2026-11-20T09:00:00.000Z' };
    const cur = { equipmentId: 'A', workRequestId: 'w1', offsiteStage: '', offsiteStageDetail: 'No status set by the dealer yet', _stageReadAt: '2026-11-20T11:45:00.000Z' };
    const store = mkStore({ fleetData: fleet([cur]) });
    const patches = new Map();
    hydrate(patches, snap, (r) => { r.pmBDue = '2026-12-05'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    expect(store.data.fleetData.rows[0]).toEqual({ ...cur, pmBDue: '2026-12-05' });
  });

  it('only changed fields travel; nothing changed -> null patch', () => {
    const snap = { equipmentId: 'A', workRequestId: 'w1', totalCost: 100 };
    const store = mkStore({ fleetData: fleet([{ equipmentId: 'A', workRequestId: 'w1', totalCost: 250 }]) });
    const patches = new Map();
    expect(hydrate(patches, { ...snap }, (r) => { r.totalCost = 100; })).toBeNull();
    hydrate(patches, snap, (r) => { r.totalCost = 100; r.pmXDue = '2027-01-01'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    expect(store.data.fleetData.rows[0]).toMatchObject({ totalCost: 250, pmXDue: '2027-01-01' });
  });

  it('vin only fills a blank', () => {
    const store = mkStore({ fleetData: fleet([
      { equipmentId: 'A', workRequestId: 'w1', vin: 'KEEP' },
      { equipmentId: 'B', workRequestId: 'w2' },
    ]) });
    const patches = new Map();
    hydrate(patches, { equipmentId: 'A', workRequestId: 'w1' }, (r) => { r.vin = 'NEW-A'; });
    hydrate(patches, { equipmentId: 'B', workRequestId: 'w2' }, (r) => { r.vin = 'NEW-B'; });
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    expect(store.data.fleetData.rows.map((r) => r.vin)).toEqual(['KEEP', 'NEW-B']);
  });

  it('arrays/objects are captured by value', () => {
    const snap = { equipmentId: 'A', workRequestId: 'w1', pmSchedule: [{ k: 'B', due: 'old' }] };
    const store = mkStore({ fleetData: fleet([{ equipmentId: 'A', workRequestId: 'w1', pmSchedule: [{ k: 'B', due: 'old' }] }]) });
    const patches = new Map();
    hydrate(patches, snap, (r) => { r.pmSchedule = [{ k: 'B', due: 'new' }]; r._secondaryWRs = [{ workRequestId: 'w1b' }]; });
    snap._secondaryWRs.push({ workRequestId: 'leak' });
    snap.pmSchedule[0].due = 'mutated';
    H.saveHydrateOverlay({ store, patches, now: () => NOW });
    const row = store.data.fleetData.rows[0];
    expect(row.pmSchedule).toEqual([{ k: 'B', due: 'new' }]);
    expect(row._secondaryWRs).toEqual([{ workRequestId: 'w1b' }]);
  });
});

describe('deep-scan hydrate overlay: store shape + syncedAt', () => {
  it('shape unchanged; only syncedAt moves; refreshFacts runs on the saved rows before save', () => {
    const stored = fleet([{ equipmentId: 'A', workRequestId: 'w1' }, { equipmentId: 'B', workRequestId: 'w2' }], { stale: true });
    const store = mkStore({ fleetData: stored });
    const patches = new Map();
    hydrate(patches, { equipmentId: 'A', workRequestId: 'w1' }, (r) => { r.pmBDue = '2026-12-06'; });
    const calls = [];
    const saved = H.saveHydrateOverlay({ store, patches, now: () => NOW, refreshFacts: (rs) => calls.push({ rs, savesSoFar: store.saves.length }) });
    const out = store.data.fleetData;
    expect(Object.keys(out).sort()).toEqual(Object.keys(stored).sort());
    for (const k of ['count', 'unavailableCount', 'scrapedAt', 'stale', 'source']) expect(out[k]).toEqual(stored[k]);
    expect(out.scrapedAt).toBe(OLD_SCRAPE); // AAP scrape time is not relabelled
    expect(out.stale).toBe(true);           // stale AAP data stays stale
    expect(out.syncedAt).toBe(new Date(NOW).toISOString());
    expect(calls).toHaveLength(1);
    expect(calls[0].rs).toBe(saved.rows);
    expect(calls[0].savesSoFar).toBe(0);
    expect(store.saves).toEqual(['fleetData']);
  });

  it('no patches / no matching rows: no save, syncedAt not advanced', () => {
    const store = mkStore({ fleetData: fleet([{ equipmentId: 'A', workRequestId: 'w1' }]) });
    expect(H.saveHydrateOverlay({ store, patches: new Map(), now: () => NOW })).toBeNull();
    const patches = new Map();
    hydrate(patches, { equipmentId: 'GONE', workRequestId: 'w1' }, (r) => { r.pmBDue = 'x'; });
    expect(H.saveHydrateOverlay({ store, patches, now: () => NOW })).toBeNull();
    expect(store.saves).toEqual([]);
    expect(store.data.fleetData.syncedAt).toBe(OLD_SYNC);
  });

  it('missing fleetData or no rows array: no save', () => {
    const patches = new Map();
    hydrate(patches, { equipmentId: 'A', workRequestId: 'w1' }, (r) => { r.pmBDue = 'x'; });
    const s1 = mkStore({});
    expect(H.saveHydrateOverlay({ store: s1, patches, now: () => NOW })).toBeNull();
    const s2 = mkStore({ fleetData: { syncedAt: OLD_SYNC } });
    expect(H.saveHydrateOverlay({ store: s2, patches, now: () => NOW })).toBeNull();
    expect(s1.saves.concat(s2.saves)).toEqual([]);
  });
});

describe('window/index.js hydrate save wiring (static)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/window/index.js'), 'utf8');
  it('the hydrate save overlays onto the current store instead of saving the start-time payload', () => {
    const a = src.indexOf('Persist + push the hydrated rows NOW');
    const b = src.indexOf('AI timeline build: hydrated', a);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    const block = src.slice(a, b);
    expect(block).toContain('saveHydrateOverlay(');
    expect(block).toContain('overlayDeepScanFields(payload.rows || [], _cur)');
    expect(block).not.toContain("store.save('fleetData', payload)");
    expect(block).not.toContain('payload.syncedAt =');
    expect(block).not.toContain('ctx.lastData = payload');
  });
  it('the hydrate loop snapshots and captures a patch per unit', () => {
    const loop = src.indexOf('for (const r of downRows) {');
    const end = src.indexOf('Persist + push the hydrated rows NOW', loop);
    const body = src.slice(loop, end);
    expect(body).toContain('_hydOverlay.snapshotOwned(r)');
    expect(body).toContain('_hydOverlay.capturePatch(');
    expect((body.match(/_clr = true;/g) || []).length).toBe(2);
  });
});
