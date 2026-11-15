// tests/wo-facts-dealer.test.js — relay-extract §7 dealerModel / caseIds / warranty (AC9),
// nameKey grouping (AC33), stageDwell with the episode cut (AC14), cross-block trap (AC34).
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as P from './fixtures/extract/b62281-paccar.js';
import * as R from './fixtures/extract/relay-39582-volvo.js';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import { estimateDetail } from './fixtures/extract/estimate-detail-39582.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const F = require('../src/repair-intel/wo-facts');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const fact = (kind, value, source, extra = {}) => Object.assign({ id: 'f_' + kind + value + source, kind, value, source, at: '2026-11-05T15:00:00.000Z', side: 'dealer', snippet: String(value) }, extra);

describe('AC9 B62281 PACCAR', () => {
  const rf = X.extractRelay(P.relayB62281, { now: NOW });
  const of = X.extractDecisivNotes(P.notesB62281, { estimateId: '21520684', estimateDetail: P.estimateDetailB62281, now: NOW });
  const fs = F.buildFactSet({ relayFacts: rf, offsiteFacts: of }, { today: TODAY });
  it('warranty conflict amazon vs dealer', () => {
    const w = fs.conflicts.find((c) => c.field === 'warranty');
    expect(w).toBeTruthy();
    expect(w.candidates).toHaveLength(2);
    expect(w.candidates.map((c) => c.side).sort()).toEqual(['amazon', 'dealer']);
  });
  it('dealer name, codes, PM added, tow', () => {
    expect(fs.dealer.name).toBe('The Peterbilt Store - Hartford');
    expect(fs.dealer.code).toBe('PCF0013');
    expect(fs.dealer.decisivDealerId).toBe('PCUS00307');
    expect(fs.pmAddedToRo).toBe(true);
    expect(fs.caseIds.tow).toContain('amz-htkt2ed6g9ay7b');
  });
  it('39582: dealerCode 5948D (text), decisivDealerId AUS0014', () => {
    const r39 = X.extractRelay(R.serviceDetail, { now: NOW });
    const o39 = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', estimateDetail, wrCreatedAt: N.WR_CREATED_AT, now: NOW });
    const f39 = F.buildFactSet({ relayFacts: r39, offsiteFacts: o39 }, { today: TODAY });
    expect(f39.dealer.code).toBe('5948D');
    expect(f39.dealer.decisivDealerId).toBe('AUS0014');
    expect(f39.dealer.conflict).toBe(false);
    expect(F.dealerOf(o39)).toBe('M & K Truck Centers - Dunmore, PA');
  });
});

describe('AC33 dealer names', () => {
  it('nameKey', () => {
    expect(F.nameKey('M & K Truck Centers - Dunmore, PA (Volvo)')).toBe('m and k truck centers dunmore pa');
    expect(F.nameKey('M&K Truck Centers – Dunmore, PA')).toBe('m and k truck centers dunmore pa');
  });
  it('spelling variants: conflict false, decisiv spelling displayed', () => {
    const d = F.dealerModel([
      fact('dealer', 'M&K Truck Centers – Dunmore, PA', 'relaygarage/fas', { via: 'fas', side: 'amazon' }),
      fact('dealer', 'M & K Truck Centers - Dunmore, PA (Volvo)', 'decisiv', { via: 'location', at: '2026-11-01T15:00:00.000Z' }),
    ], {}, { today: TODAY });
    expect(d.conflict).toBe(false);
    expect(d.name).toBe('M & K Truck Centers - Dunmore, PA (Volvo)');
  });
  it('distinct dealers conflict', () => {
    const d = F.dealerModel([
      fact('dealer', 'The Peterbilt Store - Hartford', 'decisiv', { via: 'structured' }),
      fact('dealer', 'M&K Truck Centers – Dunmore, PA', 'relaygarage/fas', { via: 'fas' }),
    ], {}, { today: TODAY });
    expect(d.conflict).toBe(true);
    expect(d.name).toBe('The Peterbilt Store - Hartford');
  });
  it('a row.suppliers candidate is tagged fleetdata and ranks last', () => {
    const d = F.dealerModel([fact('dealer', 'Kenworth Northeast (Rochester)', 'relay', { via: 'wr' })], { suppliers: 'The Peterbilt Store - Seaford' }, { today: TODAY });
    expect(d.candidates.find((c) => c.value === 'The Peterbilt Store - Seaford').source).toBe('fleetdata');
    expect(d.name).toBe('Kenworth Northeast (Rochester)');
    expect(F.dealerModel([], { suppliers: 'VOLVO' }).candidates).toEqual([]);
  });
});

describe('AC34 cross-block part/order trap', () => {
  it('offsite part# that is a Relay order becomes an order', () => {
    const rf = X.extractRelay(R.serviceDetail, { now: NOW });
    const of = X.extractDecisivNotes([{ id: 1, from: { groupId: -3, name: 'Uptime Agent', location: 'Originator: Uptime' }, recipients: [],
      subject: 'Parts', message: 'No ESD at this time for part#3010287243', created_at: '09/30/26 11:40 am EDT' }], { now: NOW });
    expect(of.facts.some((f) => f.kind === 'part' && f.value === '3010287243')).toBe(true);
    const fs = F.buildFactSet({ relayFacts: rf, offsiteFacts: of }, { today: TODAY });
    expect(fs.parts.map((p) => p.partNo)).toEqual(['85152780']);
    expect(fs.orders).toContain('3010287243');
  });
});

describe('AC14 stageDwell with since', () => {
  const h = [
    { stage: 'arrival', status: 'Checked-in', at: '2026-06-15T08:03:29-04:00' },
    { stage: 'repair', status: 'Repair (In Progress)', at: '2026-06-16T08:00:00-04:00' },
    { stage: 'ready', status: 'Ready', at: '2026-06-18T08:00:00-04:00' },
    { stage: 'arrival', status: 'Checked-in', at: '2026-09-23T15:00:00-04:00' },
    { stage: 'diagnosis', status: 'Diagnosis', at: '2026-09-24T15:00:00-04:00' },
    { stage: 'approval', status: 'Waiting Approval', at: '2026-09-26T15:00:00-04:00' },
    { stage: 'repair', status: 'Hold (Parts)', at: '2026-09-28T15:00:00-04:00' },
    { stage: 'repair', status: 'Repair (Waiting)', at: '2026-11-02T15:00:00-04:00' },
  ];
  const DAY = 86400000;
  it('only intervals at/after since count; current stage stays open', () => {
    const d = F.stageDwell(h, { now: NOW, since: '2026-09-20T18:04:00.000Z' });
    expect(d.arrival).toBe(DAY);
    expect(d.diagnosis).toBe(2 * DAY);
    expect(d.approval).toBe(2 * DAY);
    expect(d.repair).toBe(Date.parse('2026-11-02T15:00:00-04:00') - Date.parse('2026-09-28T15:00:00-04:00'));
    expect(d.ready).toBe(null);
    expect(d.partsMs).toBe(d.repair);
    expect(d.open).toMatchObject({ stage: 'repair', status: 'Repair (Waiting)', since: '2026-11-02T15:00:00-04:00' });
    expect(d.transitions).toBe(5);
  });
  it('without since no cut is applied and it is flagged', () => {
    const d = F.stageDwell(h, { now: NOW });
    expect(d.noEpisodeCut).toBe(true);
    expect(d.transitions).toBe(8);
  });
  it('buildFactSet applies wrCreatedAt − 3d', () => {
    const rf = X.extractRelay(R.serviceDetail, { now: NOW });
    const fs = F.buildFactSet({ relayFacts: rf, offsiteStageHistory: h }, { today: TODAY });
    expect(fs.stageDwell.transitions).toBe(5);
  });
});
