// tests/fleet-dbr-extract-rules.test.js — relay-extract DBR deterministic cells: AC32 barrier
// rule additions (§12.4), AC35 parseEtc freshness takeover by _factEtc (§14.6), and the Path-B
// counted ETC rule (plan.md "ETC rule"): Missed only with an explicit repair-completion marker.
// Counted conservatively by design; met/revision nuance lives in the Details prose, not the counts.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-11';
const why = (row, id) => (F.classifyBarriers(row, { today: TODAY })[id] || {}).why || null;

describe('AC32 barrier rule additions', () => {
  it('parts: SOURCING_PARTS vendor delay is a parts why; WAITING_FOR_DIAGNOSIS is not', () => {
    expect(why({ vendorDelayReason: 'SOURCING_PARTS' }, 'parts')).toContain('vendor delay SOURCING_PARTS');
    expect(why({ vendorDelayReason: 'WAITING_FOR_DIAGNOSIS' }, 'parts')).toBeNull();
  });
  it('vendor: an onsite vendor with CC - Parts Ordered gets the parts why, not vendor1p', () => {
    const r = { vendor: 'Amerit', vendorDelayReason: 'CC - Parts Ordered' };
    expect(why(r, 'parts')).toContain('vendor delay CC - Parts Ordered');
    expect(why(r, 'vendor1p')).toBeNull();
  });
  it('parts: _factPartsWhy extends an existing parts hit only', () => {
    expect(why({ vendorDelayReason: 'SOURCING_PARTS', _factPartsWhy: 'Part #85152780 (Order #3010287243, VOR) arrived 11/04' }, 'parts'))
      .toContain('Part #85152780');
    expect(why({ _factPartsWhy: 'Part #85152780' }, 'parts')).toBeNull();
  });
  it('estimate: _factEstimateWhy gives the estimate why', () => {
    expect(why({ _factEstimateWhy: 'V2 rejected: Line item cost above expected' }, 'estimate')).toContain('V2 rejected: Line item cost above expected');
  });
  it('OEM: unanswered dealer calls extend an OEM signal and never create one', () => {
    const r = { vendor: 'Volvo (ASIST)', savedRepairStatus: 'Waiting for vendor', dealerCallAttempts: 3 };
    expect(why(r, 'oem')).toMatch(/; 3 unanswered dealer calls$/);
    expect(why({ vendor: 'Volvo (ASIST)', dealerCallAttempts: 3 }, 'oem')).toBeNull();
  });
  it('partner: an Accident row with an SF case adds it to the partner why (rows with facts)', () => {
    expect(why({ lifecycleReason: 'Accident', salesforceCase: '00034983', _factsOn: true }, 'partner')).toContain('SF case 00034983');
  });
  it('flag off: none of the keys -> rules exactly as today', () => {
    expect(why({ lifecycleReason: 'Accident', salesforceCase: '00034983' }, 'partner')).toBe('Accident (carrier/insurance owned)');
    expect(why({ vendor: 'Volvo (ASIST)', savedRepairStatus: 'Waiting for vendor' }, 'oem')).toBe('at OEM/dealer Volvo (ASIST): status Waiting for vendor');
    expect(why({}, 'parts')).toBeNull();
    expect(why({}, 'estimate')).toBeNull();
  });
});

const fe = (o) => Object.assign({ date: null, kind: 'repairCompletion', state: 'none', explicitMissDate: null, source: null, statedAt: null, snippet: '', negated: false, reason: null }, o);

describe('AC35 parseEtc freshness takeover', () => {
  it('a newer repairTimeline line beats _factEtc; the result carries factConflict', () => {
    const r = F.parseEtc({ _factsOn: true, repairTimeline: '11/12 - FAS: dealer says ETC 11/20',
      _factEtc: fe({ state: 'future', date: '2026-11-11', source: 'decisiv', statedAt: '2026-11-10T15:28:00Z', snippet: 'ETR is 11/11/2026' }) }, '2026-11-12');
    expect(r).toMatchObject({ source: 'repairTimeline', date: '2026-11-20', state: 'future', factConflict: { date: '2026-11-11' } });
  });
  it('with only asistNotes and _factEtc, _factEtc wins (stated on/after the entry day)', () => {
    const r = F.parseEtc({ _factsOn: true, asistNotes: '2026-11-09 18:38 Dealer: ETC 11/15',
      _factEtc: fe({ state: 'today', date: TODAY, source: 'decisiv', statedAt: '2026-11-10T15:28:00Z', snippet: 'ETR is 11/11/2026' }) }, TODAY);
    expect(r).toMatchObject({ state: 'today', date: TODAY, source: 'extracted' });
  });
  it('savedNotes / canonical* (no entry date) keep today\'s precedence over _factEtc', () => {
    const f = fe({ state: 'today', date: TODAY, source: 'decisiv', statedAt: '2026-11-10T15:28:00Z' });
    expect(F.parseEtc({ _factsOn: true, savedNotes: 'ETC 11/20', _factEtc: f }, TODAY)).toMatchObject({ source: 'savedNotes', date: '2026-11-20' });
    expect(F.parseEtc({ _factsOn: true, canonicalNextStep: 'ETC 11/20', _factEtc: f }, TODAY)).toMatchObject({ source: 'canonicalNextStep' });
  });
  it('no legacy mention -> _factEtc; a negated _factEtc -> none', () => {
    expect(F.parseEtc({ _factsOn: true, _factEtc: fe({ state: 'future', date: '2026-11-14', source: 'decisiv', statedAt: '2026-11-10T10:00:00Z' }) }, TODAY))
      .toMatchObject({ state: 'future', date: '2026-11-14', source: 'extracted' });
    expect(F.parseEtc({ _factsOn: true, _factEtc: fe({ negated: true, source: 'relaygarage/fas', statedAt: '2026-11-09T10:00:00Z' }) }, TODAY))
      .toMatchObject({ state: 'none', date: null, source: 'extracted' });
  });
});

describe('Path B: counted Missed needs an explicit repair-completion marker', () => {
  it('_factsOn row whose only ETC is a past repairTimeline ETC 11/07 with no marker -> none', () => {
    const r = F.parseEtc({ _factsOn: true, repairTimeline: '11/05 - Dealer: ETC 11/07', _factEtc: fe({}) }, TODAY);
    expect(r).toMatchObject({ state: 'none', date: null });
  });
  it('_factEtc.state missed (ETC revised from 11/07 to 11/14) wins over a future head -> missed, explicitMissDate', () => {
    const r = F.parseEtc({ _factsOn: true, _factEtc: fe({ state: 'missed', date: '2026-11-07', explicitMissDate: '2026-11-07', source: 'relaygarage/fas', statedAt: '2026-11-09T15:00:00Z', snippet: 'ETC revised from 11/07 to 11/14' }) }, TODAY);
    expect(r).toMatchObject({ state: 'missed', date: '2026-11-07', explicitMissDate: '2026-11-07', source: 'extracted' });
  });
  it('an explicit _factEtc miss outranks an older legacy future ETC that does not take over', () => {
    const r = F.parseEtc({ _factsOn: true, savedNotes: 'ETC 11/14',
      _factEtc: fe({ state: 'missed', date: '2026-11-07', explicitMissDate: '2026-11-07', source: 'relaygarage/fas', statedAt: '2026-11-09T15:00:00Z' }) }, TODAY);
    expect(r).toMatchObject({ state: 'missed', date: '2026-11-07' });
  });
  it('_factEtc.state today -> today', () => {
    expect(F.parseEtc({ _factsOn: true, _factEtc: fe({ state: 'today', date: TODAY, source: 'decisiv', statedAt: '2026-11-10T15:28:00Z' }) }, TODAY).state).toBe('today');
  });
  it('legacy missed without a marker and without _factEtc missed -> none; with an explicit marker it stays missed', () => {
    expect(F.parseEtc({ _factsOn: true, savedNotes: 'ETC 11/07' }, TODAY)).toMatchObject({ state: 'none', date: null, source: 'savedNotes' });
    expect(F.parseEtc({ _factsOn: true, repairTimeline: '11/09 - Dealer missed the ETC of 11/07, new date pending' }, TODAY))
      .toMatchObject({ state: 'missed', date: '2026-11-07' });
  });
  it('flag off (no _factsOn): byte-identical to today, arithmetic missed kept', () => {
    expect(F.parseEtc({ savedNotes: 'ETC 11/07' }, TODAY)).toEqual({ state: 'missed', date: '2026-11-07', source: 'savedNotes', snippet: 'ETC 11/07' });
    expect(F.parseEtc({ repairTimeline: '11/05 - Dealer: ETC 11/07', _factEtc: fe({ state: 'today', date: TODAY, source: 'x' }) }, TODAY))
      .toMatchObject({ state: 'missed', source: 'repairTimeline' });
  });
});

describe('buildFleetDbr counts follow the rule', () => {
  const unit = (id, f) => makeUnit(Object.assign({ equipmentId: id, vendor: 'Volvo (ASIST)' }, f));
  const rows = [
    unit('P1', { _factsOn: true, repairTimeline: '11/05 - Dealer: ETC 11/07', _factEtc: fe({}) }),
    unit('P2', { _factsOn: true, _factEtc: fe({ state: 'missed', date: '2026-11-07', explicitMissDate: '2026-11-07', source: 'relaygarage/fas', statedAt: '2026-11-09T15:00:00Z', snippet: 'ETC revised from 11/07 to 11/14' }) }),
    unit('P3', { _factsOn: true, _factEtc: fe({ state: 'today', date: TODAY, source: 'decisiv', statedAt: '2026-11-10T15:28:00Z' }) }),
    unit('P4', { _factsOn: true, _factEtc: fe({}) }),
    unit('P5', { _factsOn: true, _factEtc: fe({ state: 'future', date: '2026-11-20', source: 'decisiv', statedAt: '2026-11-10T15:28:00Z' }) }),
  ];
  it('etcToday / noEtc / missedEtc; the missed why cites explicitMissDate', () => {
    const c = F.buildFleetDbr(rows, { today: TODAY }).rows[0].cells;
    expect(c.etcToday).toBe('1');
    expect(c.noEtc).toBe('2');
    const lines = c.missedEtc.split('\n');
    expect(lines[0]).toBe('1');
    expect(lines[1]).toMatch(/^\u2022 P2 \(ETC 11\/7\): ETC 11\/7 explicitly missed/);
  });
  it('flag off: the same text rows count arithmetic misses exactly as today', () => {
    const off = [unit('P1', { repairTimeline: '11/05 - Dealer: ETC 11/07' }), unit('P4', {})];
    const c = F.buildFleetDbr(off, { today: TODAY }).rows[0].cells;
    expect(c.missedEtc.split('\n')[0]).toBe('1');
    expect(c.noEtc).toBe('1');
  });
  it('evidenceHash includes _factsSig only when present', () => {
    const a = unit('H1', {});
    expect(F.evidenceHash([a])).toBe(F.evidenceHash([Object.assign({}, a)]));
    expect(F.evidenceHash([Object.assign({}, a, { _factsSig: 'abc' })])).not.toBe(F.evidenceHash([a]));
  });
});
