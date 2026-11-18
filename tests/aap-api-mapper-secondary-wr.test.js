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
