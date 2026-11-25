// tests/wo-facts-etc.test.js — relay-extract §6.3 ETC model + Path-B counted value
// (plan.md "ETC rule"): 39582 parts Details vs counted repair ETC, IND260261 TA one-liner
// and structured chain, No ETC, explicit Missed, AC40 two repair source heads.
// Counted conservatively by design; met/revision nuance lives in the Details prose.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as R from './fixtures/extract/relay-39582-volvo.js';
import * as N from './fixtures/extract/decisiv-39582-notes.js';
import { estimateDetail } from './fixtures/extract/estimate-detail-39582.js';
import * as V from './fixtures/extract/relay-vendors.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const F = require('../src/repair-intel/wo-facts');
const DBR = require('../src/dbr/fleet-dbr');

const NOW = Date.parse('2026-11-11T15:00:00Z');
const ON = { enabled: true, aiOutput: true };
const c = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });
const wr = (comments) => ({
  id: 'svc-T', workOrders: [], workOrderLineItems: [],
  workRequest: { id: 'wr-T', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-11-01T12:00:00Z'), comments },
});
const relayOf = (comments) => X.extractRelay(wr(comments), { now: NOW });
const fsOf = (row, today = '2026-11-11') => F.buildFactSet(row, { today });

describe('39582: parts misses are Details only; counted repair ETC is today', () => {
  const rf = X.extractRelay(R.serviceDetail, { now: NOW });
  const of = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', estimateDetail, wrCreatedAt: N.WR_CREATED_AT, now: NOW, pages: 3 });
  const fs = fsOf({ relayFacts: rf, offsiteFacts: of });
  const etc = fs.etc;

  it('two partsShip entries, both missed, with reasons; late arrival 11/04', () => {
    expect(etc.chains.partsShip.map((e) => [e.date, e.kind, e.status, e.reason])).toEqual([
      ['2026-10-11', 'partsShip', 'missed', 'backorder'],
      ['2026-10-26', 'partsShip', 'missed', 'no-tracking'],
    ]);
    expect(etc.chains.partsArrival).toEqual([]);
    expect(etc.partsMissCount).toBe(2);
    expect(etc.chains.partsShip[1].arrivedAt).toBe('2026-11-04');
    expect(etc.partsEta).toEqual({ metAt: '2026-11-04' });
  });

  it('no parts date ever reaches the repair chain', () => {
    const repDates = etc.chains.repairCompletion.map((e) => e.date);
    expect(repDates).toEqual(['2026-11-11']);
    for (const d of ['2026-10-11', '2026-10-26']) expect(repDates).not.toContain(d);
    expect(etc.chains.repairCompletion[0]).toMatchObject({ tag: 'decisiv', status: 'open' });
  });

  it('counted = today 11/11; ship-date misses never count', () => {
    expect(etc.counted).toMatchObject({ state: 'today', date: '2026-11-11', explicitMissDate: null });
    expect(etc.etcMissCount).toBe(0);
    const row = { equipmentId: '39582', relayFacts: rf, offsiteFacts: of };
    F.refreshRowFacts(row, ON, '2026-11-11');
    expect(row.etcMissed).toBe(false);
    expect(row.etcMissCount).toBe(0);
    expect(row.partsMissCount).toBe(2);
    expect(row._factEtc).toMatchObject({ date: '2026-11-11', kind: 'repairCompletion', state: 'today', explicitMissDate: null, source: 'decisiv', negated: false });
    expect(row._factEtc.snippet).toContain('11/11/2026');
  });
});

describe('IND260261: TA one-liner, structured chain, conflict, no arithmetic miss', () => {
  const full = X.extractRelay(V.relayIND260261, { vendor: 'TA', now: NOW });
  const cut = JSON.parse(JSON.stringify(V.relayIND260261));
  for (const w of cut.workOrders) w.comments = w.comments.filter((x) => x.timestamp < '2026-11-08');
  cut.workRequest.comments = cut.workRequest.comments.filter((x) => x.timestamp < '2026-11-08');
  const cutRf = X.extractRelay(cut, { vendor: 'TA', now: NOW });

  it('ETA … ETC … -> techOnsite 10/29 + repairCompletion 11/07; structured 10/30 only in etc.structured', () => {
    const etc = fsOf({ relayFacts: cutRf }).etc;
    expect(etc.chains.techOnsite.map((e) => e.date)).toContain('2026-10-29');
    expect(etc.chains.repairCompletion.map((e) => [e.date, e.tag])).toEqual([['2026-11-07', 'relaygarage/vendor']]);
    expect(etc.structured.repairCompletion.map((e) => e.date)).toEqual(['2026-10-30']);
    expect(etc.chains.repairCompletion.map((e) => e.date)).not.toContain('2026-10-30');
  });

  it('cut at 11/08: repairEtc conflict 10/30 (relay) vs 11/07 (relaygarage/vendor); counted none', () => {
    const etc = fsOf({ relayFacts: cutRf }).etc;
    const cf = etc.conflicts.find((x) => x.field === 'repairEtc');
    expect(cf).toBeTruthy();
    expect(cf.candidates.map((x) => [x.value, x.source]).sort()).toEqual([['2026-10-30', 'relaygarage'], ['2026-11-07', 'relaygarage/vendor']]);
    expect(etc.currentEtc).toMatchObject({ date: '2026-11-07', source: 'relaygarage/vendor' });
    expect(etc.counted.state).toBe('none');
    expect(etc.etcMissCount).toBe(0);
  });

  it('full thread (possible etc 11 20 26, tentative): counted none, never missed', () => {
    const etc = fsOf({ relayFacts: full }).etc;
    expect(etc.counted.state).toBe('none');
    expect(etc.counted.state).not.toBe('missed');
    expect(etc.explicitMisses).toEqual([]);
  });
});

describe('No ETC is the normal case', () => {
  it('no repair-completion date -> none; _factEtc.state none', () => {
    const row = { equipmentId: 'U1', relayFacts: relayOf([c('2026-11-09T15:00:00Z', 'fasuser1', 'Unit at dealer, diag in progress.')]) };
    expect(fsOf(row).etc.counted.state).toBe('none');
    F.refreshRowFacts(row, ON, '2026-11-11');
    expect(row._factEtc).toMatchObject({ state: 'none', date: null, kind: 'repairCompletion' });
    expect(row.etcMissed).toBe(false);
  });
  for (const neg of ['ETC: N/A', 'Pending ETC', 'Dealer will advise when unit is ready']) {
    it('newest "' + neg + '" -> none (overrides an older future ETC)', () => {
      const rf = relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/20'), c('2026-11-09T15:00:00Z', 'fasuser1', neg)]);
      const etc = fsOf({ relayFacts: rf }).etc;
      expect(etc.counted.state).toBe('none');
      expect(etc.currentEtc).toMatchObject({ date: null, negated: true, kind: 'repairCompletion' });
    });
  }
});

describe('explicit Missed needs a repair-miss marker', () => {
  it('ETC 11/07 then "ETC revised from 11/07 to 11/14" -> missed 11/07', () => {
    const rf = relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07'), c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/14')]);
    const etc = fsOf({ relayFacts: rf }).etc;
    expect(etc.counted).toMatchObject({ state: 'missed', explicitMissDate: '2026-11-07', date: '2026-11-07' });
    expect(etc.etcMissCount).toBe(1);
    const row = { equipmentId: 'U2', relayFacts: rf };
    F.refreshRowFacts(row, ON, '2026-11-11');
    expect(row.etcMissed).toBe(true);
    expect(row.etcMissCount).toBe(1);
    expect(row._factEtc).toMatchObject({ state: 'missed', explicitMissDate: '2026-11-07' });
  });
  it('only "ETC 11/07" (past, no marker) -> none, no arithmetic miss', () => {
    const etc = fsOf({ relayFacts: relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07')]) }).etc;
    expect(etc.counted.state).toBe('none');
    expect(etc.etcMissCount).toBe(0);
  });
  it('miss then a newer "ETC: N/A" -> still missed in the mirrors and in parseEtc; statedAt = marker time', () => {
    const rf = relayOf([
      c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07'),
      c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/14'),
      c('2026-11-10T15:00:00Z', 'fasuser1', 'ETC: N/A'),
    ]);
    const row = { equipmentId: 'U3', relayFacts: rf };
    F.refreshRowFacts(row, ON, '2026-11-11');
    expect(row.etcMissed).toBe(true);
    expect(row._factEtc).toMatchObject({ state: 'missed', explicitMissDate: '2026-11-07' });
    expect(Date.parse(row._factEtc.statedAt)).toBe(Date.parse('2026-11-09T15:00:00Z'));
    expect(DBR.parseEtc(row, '2026-11-11')).toMatchObject({ state: 'missed', date: '2026-11-07', source: 'extracted' });
  });
  it('a revision whose cited date was never stated on its own is not a miss (conservative, pinned)', () => {
    const etc = fsOf({ relayFacts: relayOf([c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/14')]) }).etc;
    expect(etc.explicitMisses).toEqual([]);
    expect(etc.counted.state).toBe('future');
    expect(etc.etcMissCount).toBe(0);
  });
  it('current head == today with a prior explicit miss -> today', () => {
    const rf = relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07'), c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/11')]);
    const etc = fsOf({ relayFacts: rf }).etc;
    expect(etc.counted).toMatchObject({ state: 'today', date: '2026-11-11', explicitMissDate: '2026-11-07' });
  });
});

describe('AC40 two repair source heads', () => {
  const note = (created_at, message) => ({
    id: created_at, from: { groupId: -3, name: 'Uptime Agent', location: 'Originator: Uptime' }, recipients: [],
    subject: 'Current Case', message, created_at,
  });
  const rf = relayOf([c('2026-11-11T15:00:00Z', 'fasuser1', 'dealer ETC 11/20')]);
  it('decisiv 11/11 and relaygarage/fas 11/20 both open; currentEtc decisiv; conflict listed', () => {
    const of = X.extractDecisivNotes([note('11/10/26 10:28 am EST', 'ETR 11/11/2026')], { now: NOW });
    const etc = fsOf({ relayFacts: rf, offsiteFacts: of }).etc;
    expect(etc.chains.repairCompletion.map((e) => [e.date, e.tag, e.status]).sort()).toEqual([
      ['2026-11-11', 'decisiv', 'open'], ['2026-11-20', 'relaygarage/fas', 'open'],
    ]);
    expect(etc.currentEtc).toMatchObject({ date: '2026-11-11', source: 'decisiv' });
    const cf = etc.conflicts.find((x) => x.field === 'repairEtc');
    expect(cf.candidates.map((x) => [x.value, x.source]).sort()).toEqual([['2026-11-11', 'decisiv'], ['2026-11-20', 'relaygarage/fas']]);
  });
  it('a later Decisiv ETR 11/13 supersedes only the Decisiv head (11/11 missed at 11/12)', () => {
    const of = X.extractDecisivNotes([note('11/12/26 09:00 am EST', 'ETR 11/13/2026'), note('11/10/26 10:28 am EST', 'ETR 11/11/2026')], { now: NOW });
    const etc = fsOf({ relayFacts: rf, offsiteFacts: of }, '2026-11-12').etc;
    const byKey = Object.fromEntries(etc.chains.repairCompletion.map((e) => [e.date + '|' + e.tag, e]));
    expect(byKey['2026-11-11|decisiv']).toMatchObject({ status: 'missed', missedAt: '2026-11-12' });
    expect(byKey['2026-11-13|decisiv'].status).toBe('open');
    expect(byKey['2026-11-20|relaygarage/fas'].status).toBe('open');
    expect(etc.counted.state).not.toBe('missed');
  });
});

describe('FEAT-002 additive fields: structuredMiss and passedHead (counted unchanged)', () => {
  const T = '2026-11-25';
  const structured = { id: 's1', kind: 'etcMention', at: '2026-11-18T15:00:00Z', source: 'relay', via: 'structured', value: '2026-11-20', etcKind: 'repairCompletion', snippet: 'expectedCompletionDateTime: 2026-11-20' };
  const marker = { id: 'm1', kind: 'etcMention', at: '2026-11-21T15:00:00Z', source: 'relay', via: 'text', value: '2026-11-20', marker: 'miss', chain: 'repairCompletion', repair: true, snippet: 'missed the ETC of 11/20' };
  const NONE = { state: 'none', date: null, explicitMissDate: null, reason: null };

  it('structured-only revision: an unattached dated repair marker matching a structured entry -> structuredMiss; counted unchanged', () => {
    const etc = F.etcModel([structured, marker], { today: T });
    expect(etc.counted).toEqual(NONE);
    expect(etc._countedEntry).toBeNull();
    expect(etc.explicitMisses).toEqual([]);
    expect(etc.structuredExplicitMiss).toEqual({ date: '2026-11-20', at: '2026-11-21T15:00:00Z', snippet: 'missed the ETC of 11/20' });
  });
  it('structuredMiss stays null without a matching structured entry, for non-repair markers and when the marker attaches to a text entry', () => {
    expect(F.etcModel([marker], { today: T }).structuredExplicitMiss).toBeNull();
    expect(F.etcModel([structured, Object.assign({}, marker, { repair: false })], { today: T }).structuredExplicitMiss).toBeNull();
    expect(F.etcModel([structured, Object.assign({}, marker, { chain: 'parts' })], { today: T }).structuredExplicitMiss).toBeNull();
    const text = { id: 't1', kind: 'etcMention', at: '2026-11-17T15:00:00Z', source: 'relay', via: 'text', value: '2026-11-20', etcKind: 'repairCompletion', snippet: 'ETC 11/20' };
    const attached = F.etcModel([structured, text, marker], { today: T });
    expect(attached.structuredExplicitMiss).toBeNull();
    expect(attached.counted).toMatchObject({ state: 'missed', explicitMissDate: '2026-11-20' });
  });
  it('passedHead for a passed, unmarked head; null for today / future / explicit miss / no head', () => {
    const rf = relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07')]);
    const etc = fsOf({ relayFacts: rf }).etc;
    expect(etc.counted).toEqual(NONE);
    expect(etc.passedHead).toMatchObject({ date: '2026-11-07' });
    expect(Date.parse(etc.passedHead.statedAt)).toBe(Date.parse('2026-11-05T15:00:00Z'));
    const row = { equipmentId: 'P1', relayFacts: rf };
    F.refreshRowFacts(row, ON, '2026-11-11');
    expect(row._factEtc).toMatchObject({ state: 'none', date: null, source: null, statedAt: null, negated: false, structuredMiss: null });
    expect(row._factEtc.passedHead).toMatchObject({ date: '2026-11-07' });
    expect(DBR.parseEtc(row, '2026-11-11')).toMatchObject({ state: 'none', missDowngraded: true, passedDate: '2026-11-07' });
    expect(fsOf({ relayFacts: relayOf([c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC 11/11')]) }).etc.passedHead).toBeNull();
    expect(fsOf({ relayFacts: relayOf([c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC 11/20')]) }).etc.passedHead).toBeNull();
    expect(fsOf({ relayFacts: relayOf([c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07'), c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/14')]) }).etc.passedHead).toBeNull();
    expect(fsOf({ relayFacts: relayOf([c('2026-11-09T15:00:00Z', 'fasuser1', 'Unit at dealer, diag in progress.')]) }).etc.passedHead).toBeNull();
  });
});
