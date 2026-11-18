// tests/aap-api-mapper-secondary-wr.test.js
// toSecondaryWR (src/scrapers/aap_api_mapper.js): the secondary WR card shape the
// unit-detail repair pane reads, and the optional opts.wrType override the bulk
// build / refreshUnit pass when they know which category search a WO came from.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { mkWo } from './fixtures/fleet-build/aap-fleet-fixture.js';

const require = createRequire(import.meta.url);
const mapper = require('../src/scrapers/aap_api_mapper');

const KEYS = ['workRequestId', 'vendor', 'serviceState', 'subState', 'serviceCategory', 'issueDetails', 'level1', 'level2',
  'created', 'completed', 'totalCost', 'fullConversation', 'repairTimeline', '_wrType', '_serviceUUID', '_relayUrl'];

describe('toSecondaryWR', () => {
  it('returns exactly the card keys with the Relay URL for the WO', () => {
    const s = mapper.toSecondaryWR(mkWo({ id: 'svc-x1', aaid: 'a', unit: 'X1' }), null);
    expect(Object.keys(s)).toEqual(KEYS);
    expect(s.workRequestId).toBe('svc-x1');
    expect(s._serviceUUID).toBe('svc-x1');
    expect(s._relayUrl).toBe('https://aap-na.corp.amazon.com/v2/service/svc-x1');
  });
  it('_wrType from category, and from opts.wrType when category is missing', () => {
    expect(mapper.toSecondaryWR(mkWo({ id: 'p', category: 'PLANNED' }))._wrType).toBe('planned');
    expect(mapper.toSecondaryWR(mkWo({ id: 'u', category: 'UNPLANNED' }))._wrType).toBe('unplanned');
    const bare = mkWo({ id: 'b' }); delete bare.category;
    expect(mapper.toSecondaryWR(bare)._wrType).toBe('unplanned');
    expect(mapper.toSecondaryWR(bare, null, { wrType: 'planned' })._wrType).toBe('planned');
    expect(mapper.toSecondaryWR(mkWo({ id: 'p2', category: 'PLANNED' }), null, { wrType: 'unplanned' })._wrType).toBe('unplanned');
    expect(mapper.toSecondaryWR(bare, null, { wrType: 'bogus' })._wrType).toBe('unplanned');
  });
  it('two-arg calls are unchanged by the new opts argument', () => {
    const wo = mkWo({ id: 'svc-x2', category: 'PLANNED', status: 'SCHEDULED' });
    const detail = { workRequest: { comments: [{ timestamp: '2026-11-10T14:00:00Z', createdBy: 'Vendor', text: 'pm booked' }] } };
    expect(mapper.toSecondaryWR(wo, detail, {})).toEqual(mapper.toSecondaryWR(wo, detail));
    expect(mapper.toSecondaryWR(wo, detail, undefined)).toEqual(mapper.toSecondaryWR(wo, detail));
    expect(mapper.toSecondaryWR(wo, detail).fullConversation).toMatch(/^Conversation\n.*pm booked/);
    expect(mapper.toSecondaryWR(null)).toBe(null);
  });
});

// keepPrevSecondaryWRs: used by hydration (refreshUnit's PLANNED search failed)
// and by the bulk-rebuild carry-forward in src/window/index.js.
describe('keepPrevSecondaryWRs', () => {
  const planned = mapper.toSecondaryWR(mkWo({ id: 'svc-m1-p', category: 'PLANNED', status: 'SCHEDULED' }), null, { wrType: 'planned' });
  const unpl2 = mapper.toSecondaryWR(mkWo({ id: 'svc-m1-u2' }), null, { wrType: 'unplanned' });
  // The bulk row for a 122269-shaped unit (1 unplanned primary + 1 planned).
  const bulkRow = { workRequestId: 'svc-m1-u', _secondaryWRs: [planned], _plannedWRData: planned };

  it('hydration, PLANNED search failed: the bulk-attached planned WO is kept', () => {
    const fr = { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: false };
    const k = mapper.keepPrevSecondaryWRs(fr, bulkRow, { planned: fr._plannedPassOk === false });
    expect(k.secondary.map((s) => s.workRequestId)).toEqual(['svc-m1-p']);
    expect(k.secondary[0]._wrType).toBe('planned');
    expect(k.planned.workRequestId).toBe('svc-m1-p');
    expect(fr._secondaryWRs).toEqual([]); // input not modified
  });
  it('hydration, PLANNED search failed, FLD260703 shape: fresh unplanned secondary + kept planned, no duplicates', () => {
    const freshU2 = Object.assign({}, unpl2, { fullConversation: 'Conversation\nlive' });
    const fr = { workRequestId: 'svc-m3-u1', _secondaryWRs: [freshU2], _plannedWRData: null };
    const prev = { workRequestId: 'svc-m3-u1', _secondaryWRs: [unpl2, planned], _plannedWRData: planned };
    const k = mapper.keepPrevSecondaryWRs(fr, prev, { planned: true });
    expect(k.secondary.map((s) => s.workRequestId)).toEqual(['svc-m1-u2', 'svc-m1-p']);
    expect(k.secondary[0].fullConversation).toBe('Conversation\nlive');
  });
  it('PLANNED search succeeded: the fresh result wins, so a closed planned WO drops off', () => {
    const fr = { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: true };
    const k = mapper.keepPrevSecondaryWRs(fr, bulkRow, { planned: fr._plannedPassOk === false });
    expect(k.secondary).toEqual([]);
    expect(k.planned).toBe(null);
  });
  it('never re-adds the fresh primary as a secondary or as the planned card', () => {
    const fr = { workRequestId: 'svc-m1-p', _secondaryWRs: [], _plannedWRData: null };
    const k = mapper.keepPrevSecondaryWRs(fr, bulkRow, { planned: true, unplanned: true });
    expect(k.secondary).toEqual([]);
    expect(k.planned).toBe(null);
  });
  it('unplanned entries are carried only with keep.unplanned', () => {
    const fresh = { workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null };
    const prev = { workRequestId: 'svc-m1-u', _secondaryWRs: [unpl2, planned], _plannedWRData: planned };
    expect(mapper.keepPrevSecondaryWRs(fresh, prev, { planned: false, unplanned: false }).secondary).toEqual([]);
    expect(mapper.keepPrevSecondaryWRs(fresh, prev, { planned: false, unplanned: true }).secondary.map((s) => s.workRequestId)).toEqual(['svc-m1-u2']);
  });
});

// Planned WOs only the widened per-unit PLANNED search can see (outside the
// bulk program/fleet/lifecycle filters): hydration tags them, carry-forward
// keeps them across successful rebuilds, the next hydration drops closed ones.
describe('markOutsideBulkPlanned + keepPrevSecondaryWRs outsideBulk', () => {
  const planned = mapper.toSecondaryWR(mkWo({ id: 'svc-m1-p', category: 'PLANNED', status: 'SCHEDULED' }), null, { wrType: 'planned' });
  const damage = mapper.toSecondaryWR(mkWo({ id: 'svc-dmg-p', category: 'PLANNED', status: 'SCHEDULED' }), null, { wrType: 'planned' });
  const unpl2 = mapper.toSecondaryWR(mkWo({ id: 'svc-m1-u2' }), null, { wrType: 'unplanned' });

  it('tags only planned entries the bulk row did not have; inputs untouched', () => {
    const bulk = { workRequestId: 'svc-m1-u', _secondaryWRs: [planned], _plannedWRData: planned };
    const kept = { secondary: [unpl2, planned, damage], planned };
    const t = mapper.markOutsideBulkPlanned(kept, bulk);
    expect(t.secondary.map((s) => !!s._outsideBulk)).toEqual([false, false, true]);
    expect(t.secondary[2].workRequestId).toBe('svc-dmg-p');
    expect(t.planned._outsideBulk).toBeUndefined();
    expect(damage._outsideBulk).toBeUndefined();
  });
  it('the planned card and its secondary entry share one tagged copy', () => {
    const t = mapper.markOutsideBulkPlanned({ secondary: [damage], planned: damage }, { workRequestId: 'svc-x', _secondaryWRs: [], _plannedWRData: null });
    expect(t.planned._outsideBulk).toBe(true);
    expect(t.planned).toBe(t.secondary[0]);
  });
  it('successful rebuild that cannot see the tagged WO keeps it; one that sees it uses the bulk entry', () => {
    const tagged = Object.assign({}, damage, { _outsideBulk: true });
    const prev = { workRequestId: 'svc-x', _secondaryWRs: [tagged], _plannedWRData: tagged };
    const blind = { workRequestId: 'svc-x', _secondaryWRs: [], _plannedWRData: null };
    const k = mapper.keepPrevSecondaryWRs(blind, prev, { planned: false, unplanned: true, outsideBulk: true });
    expect(k.secondary.map((s) => s.workRequestId)).toEqual(['svc-dmg-p']);
    expect(k.planned.workRequestId).toBe('svc-dmg-p');
    const sees = { workRequestId: 'svc-x', _secondaryWRs: [damage], _plannedWRData: damage };
    const k2 = mapper.keepPrevSecondaryWRs(sees, prev, { planned: false, outsideBulk: true });
    expect(k2.secondary).toEqual([damage]);
    expect(k2.planned).toBe(damage);
  });
  it('untagged planned entries still drop on a successful rebuild (closed WO)', () => {
    const prev = { workRequestId: 'svc-m1-u', _secondaryWRs: [planned], _plannedWRData: planned };
    const k = mapper.keepPrevSecondaryWRs({ workRequestId: 'svc-m1-u', _secondaryWRs: [], _plannedWRData: null }, prev, { planned: false, outsideBulk: true });
    expect(k.secondary).toEqual([]);
    expect(k.planned).toBe(null);
  });
  it('next hydration whose PLANNED search succeeds without it drops the tagged WO', () => {
    const tagged = Object.assign({}, damage, { _outsideBulk: true });
    const r = { workRequestId: 'svc-x', _secondaryWRs: [tagged], _plannedWRData: tagged };
    const fr = { workRequestId: 'svc-x', _secondaryWRs: [], _plannedWRData: null, _plannedPassOk: true };
    const t = mapper.markOutsideBulkPlanned(mapper.keepPrevSecondaryWRs(fr, r, { planned: fr._plannedPassOk === false }), r);
    expect(t.secondary).toEqual([]);
    expect(t.planned).toBe(null);
  });
});
