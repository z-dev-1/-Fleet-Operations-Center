// tests/wo-facts-fill.test.js — relay-extract §9 / §12.3 applyToRow: blank-or-own fills
// (AC11, AC39), derived subVendor (AC12), clearOffsite own-fill records, idempotence,
// flag off (AC24 part).
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as R from './fixtures/extract/relay-39582-volvo.js';
import * as V from './fixtures/extract/relay-vendors.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const F = require('../src/repair-intel/wo-facts');
const { clearOffsite } = require('../src/utils/offsite-owner');
const { buildSalesforceUrl } = require('../src/utils/salesforce-url');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const ON = { enabled: true, aiOutput: true };
const clone = (o) => JSON.parse(JSON.stringify(o));
const relayOf = (comments) => X.extractRelay({
  id: 's', workOrders: [],
  workRequest: { id: 'wr-1', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-11-01T12:00:00Z'), comments },
}, { now: NOW });
const FAS_DEALER = 'M&K Truck Centers – Dunmore, PA';
const fasRf = relayOf([{ timestamp: '2026-11-03T15:00:00Z', createdBy: 'fasuser1', text: 'Called ' + FAS_DEALER + ' (Volvo) at (555) 010-1245 and spoke with Pat.' }]);
const decisivDealer = (name) => X.extractDecisivNotes([], { estimateDetail: { estimate: { dealer: { id: 'AUS0099', name } } }, now: NOW });

describe('AC39 fills are correctable', () => {
  it('refresh 1 fills from FAS prose and records the own fill', () => {
    const row = { equipmentId: 'D1', workRequestId: 'wr-1', dealerName: '', relayFacts: fasRf };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.dealerName).toBe(FAS_DEALER);
    expect(row._factFilled.dealerName).toBe(FAS_DEALER);
    expect(row.subVendor).toBe(FAS_DEALER);
  });
  it('refresh 2: Decisiv outranks FAS prose; conflict listed; subVendor follows', () => {
    const row = { equipmentId: 'D1', workRequestId: 'wr-1', dealerName: '', relayFacts: fasRf };
    F.refreshRowFacts(row, ON, TODAY);
    row.offsiteFacts = decisivDealer('The Peterbilt Store - Hartford');
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.dealerName).toBe('The Peterbilt Store - Hartford');
    expect(row._factFilled.dealerName).toBe('The Peterbilt Store - Hartford');
    expect(row.subVendor).toBe('The Peterbilt Store - Hartford');
    const fs = F.buildFactSet(row, { today: TODAY });
    expect(fs.conflicts.some((c) => c.field === 'dealerName')).toBe(true);
    expect(row.decisivDealerId).toBe('AUS0099');
  });
  it('same nameKey from Decisiv -> Decisiv spelling, no conflict', () => {
    const row = { equipmentId: 'D1', workRequestId: 'wr-1', dealerName: '', relayFacts: fasRf };
    F.refreshRowFacts(row, ON, TODAY);
    row.offsiteFacts = decisivDealer('M & K Truck Centers - Dunmore, PA (Volvo)');
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.dealerName).toBe('M & K Truck Centers - Dunmore, PA (Volvo)');
    expect(F.buildFactSet(row, { today: TODAY }).conflicts.some((c) => c.field === 'dealerName')).toBe(false);
  });
  it('a source-set dealerName is kept on every refresh', () => {
    const row = { equipmentId: 'D2', workRequestId: 'wr-1', dealerName: 'Source Dealer', relayFacts: fasRf, offsiteFacts: decisivDealer('The Peterbilt Store - Hartford') };
    F.refreshRowFacts(row, ON, TODAY);
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.dealerName).toBe('Source Dealer');
    expect(row._factFilled && row._factFilled.dealerName).toBeUndefined();
  });
  it('clearOffsite removes the dealer own-fill records', () => {
    const row = { equipmentId: 'D3', workRequestId: 'wr-1', dealerName: '', relayFacts: fasRf, offsiteFacts: decisivDealer('The Peterbilt Store - Hartford') };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row._factFilled.decisivDealerId).toBe('AUS0099');
    clearOffsite(row);
    expect(row.dealerName).toBe('');
    expect(row._factFilled.dealerName).toBeUndefined();
    expect(row._factFilled.dealerCode).toBeUndefined();
    expect(row._factFilled.decisivDealerId).toBeUndefined();
  });
});

describe('AC11 fills keep source values', () => {
  it('createdBy already set is kept; salesforce case + URL filled', () => {
    const rf = X.extractRelay(V.relay321185, { now: NOW });
    const row = { equipmentId: '321185', createdBy: 'X', relayFacts: rf };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.createdBy).toBe('X');
    expect(row.salesforceCase).toBe('00034983');
    expect(row.salesforceCaseUrl).toBe(buildSalesforceUrl('00034983'));
    expect(row._factFilled.salesforceCase).toBe('00034983');
  });
  it('a DOM-era totalCost string is never overwritten', () => {
    const rf = X.extractRelay(V.relayIND260261, { vendor: 'TA', now: NOW });
    const row = { equipmentId: 'IND', totalCost: '$1,234.56', relayFacts: rf };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.totalCost).toBe('$1,234.56');
    expect(row.estimateApprovedAmount).toBe(24804.13);
  });
});

describe('AC12 subVendor is derived, never the geofence', () => {
  const dealerNote = {
    id: 1, from: { groupId: -1, name: 'Dealer Advisor', location: 'M & K Truck Centers - Dunmore, PA (Volvo)' }, recipients: [],
    subject: 'Status', message: 'Waiting on parts', created_at: '11/09/26 01:38 pm EST',
  };
  it('scrape-era row: dealerName filled from offsite facts, subVendor the same', () => {
    const row = { equipmentId: 'S1', geofence: 'M&K Truck Center...', dealerName: '', subVendor: 'M&K Truck Center...', offsiteFacts: X.extractDecisivNotes([dealerNote], { now: NOW }) };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.dealerName).toBe('M & K Truck Centers - Dunmore, PA (Volvo)');
    expect(row.subVendor).toBe('M & K Truck Centers - Dunmore, PA (Volvo)');
  });
  it('no dealer facts and suppliers VOLVO -> subVendor empty', () => {
    const row = { equipmentId: 'S2', geofence: 'Some Yard', dealerName: '', subVendor: 'Some Yard', suppliers: 'VOLVO' };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.subVendor).toBe('');
  });
  it('a non-OEM supplier name is used', () => {
    const row = { equipmentId: 'S3', dealerName: '', suppliers: 'The Peterbilt Store - Seaford' };
    F.refreshRowFacts(row, ON, TODAY);
    expect(row.subVendor).toBe('The Peterbilt Store - Seaford');
  });
});

describe('idempotence and flag off', () => {
  const rf = X.extractRelay(R.serviceDetail, { now: NOW });
  it('refreshRowFacts(refreshRowFacts(r)) deep-equals refreshRowFacts(r)', () => {
    const a = F.refreshRowFacts({ equipmentId: '39582', workRequestId: 'wr-39582', relayFacts: rf, dealerName: '' }, ON, TODAY);
    const once = clone(a);
    F.refreshRowFacts(a, ON, TODAY);
    expect(clone(a)).toEqual(once);
  });
  it('rows without blocks get blank mirrors and no AI keys', () => {
    const row = F.refreshRowFacts({ equipmentId: 'B', dealerName: '' }, ON, TODAY);
    expect(row.partNumbers).toBe('');
    expect(row.etcMissed).toBe(false);
    expect(row._factsOn).toBeUndefined();
    expect(row._factEtc).toBeUndefined();
    expect(row._factsSig).toBeUndefined();
  });
  it('aiOutput off -> no _fact* keys, mirrors still written', () => {
    const row = F.refreshRowFacts({ equipmentId: '39582', relayFacts: rf }, { enabled: true, aiOutput: false }, TODAY);
    expect(row._factsOn).toBeUndefined();
    expect(row._factEtc).toBeUndefined();
    expect(row.partNumbers).toBe('85152780');
  });
  it('flag off -> applyToRow / refreshRowFacts / refreshFleetFacts leave rows deep-equal', () => {
    const rows = [{ equipmentId: '39582', relayFacts: rf, subVendor: 'Yard', dealerName: '' }, { equipmentId: 'B', geofence: 'G' }];
    const before = clone(rows);
    const off = { enabled: false, aiOutput: true };
    expect(F.refreshFleetFacts(rows, off, TODAY)).toBe(rows);
    for (const r of rows) F.refreshRowFacts(r, off, TODAY);
    F.applyToRow(rows[0], F.buildFactSet(rows[0], { today: TODAY }), off);
    F.refreshFleetFacts(rows, undefined, TODAY);
    expect(clone(rows)).toEqual(before);
  });
});
