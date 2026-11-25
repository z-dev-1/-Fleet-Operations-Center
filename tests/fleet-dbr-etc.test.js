// Fleet DBR ETC parsing: best-effort, never fabricated. No parsed date => NO ETC (date null).
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');

// _localDay(_factEtc.statedAt) is exercised below.
vi.stubEnv('TZ', 'America/New_York');

const TODAY = '2026-11-10';
const etc = (fields) => F.parseEtc(makeUnit(fields), TODAY);

describe('parseEtc classification', () => {
  it('date == today -> today', () => {
    expect(etc({ canonicalNextStep: 'ETC 11/10 per shop' })).toMatchObject({ state: 'today', date: '2026-11-10', source: 'canonicalNextStep' });
    expect(etc({ savedNotes: 'estimated completion 11/10' }).state).toBe('today');
  });
  it('no mention -> none with date null (never fabricated)', () => {
    expect(etc({ savedNotes: 'waiting on carrier', repairTimeline: '11/09 - towed to shop' }))
      .toEqual({ state: 'none', date: null, source: null, snippet: '', statedDay: null });
  });
  it('D16: a past date with no miss marker -> none + missDowngraded; with a marker it stays missed; future -> future', () => {
    expect(etc({ savedNotes: 'ETC 11/05' })).toMatchObject({ state: 'none', date: null, missDowngraded: true, source: 'savedNotes' });
    expect(etc({ repairTimeline: '11/09 - Dealer missed the ETC of 11/05, new date pending' })).toMatchObject({ state: 'missed', date: '2026-11-05' });
    expect(etc({ savedNotes: 'ETC 11/20' })).toMatchObject({ state: 'future', date: '2026-11-20' });
  });
  it('"etc." (et cetera) and bare ETA are ignored; ETR counts', () => {
    expect(etc({ savedNotes: 'brakes, tires etc. 11/12' }).state).toBe('none');
    expect(etc({ savedNotes: 'Parts ETA 11/11' }).state).toBe('none');
    expect(etc({ savedNotes: 'ETR 11/12' })).toMatchObject({ state: 'future', date: '2026-11-12' });
  });
  it('negated "no ETC yet" in savedNotes beats a dated timeline ETC', () => {
    expect(etc({ savedNotes: 'no ETC yet', repairTimeline: '11/09 - ETC 11/10' })).toMatchObject({ state: 'none', date: null, source: 'savedNotes' });
  });
  it('"no ETC until parts arrive 11/12" -> none (R8)', () => {
    expect(etc({ canonicalNextStep: 'no ETC until parts arrive 11/12' })).toMatchObject({ state: 'none', date: null });
    expect(etc({ savedNotes: 'ETC: TBD 11/12' }).state).toBe('none');
  });
  it('negated ETC phrases are not dated ETCs (no "estimated completion" + a parts ETA)', () => {
    expect(etc({ savedNotes: 'No estimated completion yet; parts ETA 11/12' })).toMatchObject({ state: 'none', date: null });
    expect(etc({ savedNotes: 'pending estimated completion date 11/12' })).toMatchObject({ state: 'none', date: null });
    expect(etc({ savedNotes: 'repair ETA: TBD, parts 11/12' })).toMatchObject({ state: 'none', date: null });
    expect(etc({ savedNotes: 'estimated completion 11/12' })).toMatchObject({ state: 'future', date: '2026-11-12' });
  });
  it('a higher-priority source decides even when a lower one has a date', () => {
    expect(etc({ canonicalNextStep: 'ETC 11/05', savedNotes: 'ETC 11/10' })).toMatchObject({ state: 'none', missDowngraded: true, source: 'canonicalNextStep' });
  });
  it('latest-dated timeline line wins regardless of order', () => {
    const a = etc({ repairTimeline: '11/08 - ETC 11/20\n11/01 - ETC 11/15' });
    const b = etc({ repairTimeline: '11/01 - ETC 11/15\n11/08 - ETC 11/20' });
    expect(a).toMatchObject({ date: '2026-11-20', source: 'repairTimeline' });
    expect(b.date).toBe('2026-11-20');
    expect(etc({ repairTimeline: '11/01 - ETC 11/15\n11/08 - no ETC from dealer' }).state).toBe('none');
  });
  it('invalid dates are ignored (not negated)', () => {
    expect(etc({ savedNotes: 'ETC 2/30' }).state).toBe('none');
    expect(etc({ savedNotes: 'ETC 13/02' }).date).toBeNull();
    expect(etc({ savedNotes: 'ETC 2/30', repairTimeline: '11/09 - ETC 11/10' })).toMatchObject({ state: 'today', source: 'repairTimeline' });
  });
});

describe('inferDate', () => {
  it('explicit years', () => {
    expect(F.inferDate('11', '12', '25', TODAY)).toBe('2025-11-12');
    expect(F.inferDate('1', '3', '2027', TODAY)).toBe('2027-01-03');
  });
  it('Dec -> Jan rollover and > 60 days ahead -> previous year', () => {
    expect(F.inferDate('1', '5', null, '2026-12-20')).toBe('2027-01-05');
    expect(F.inferDate('12', '20', null, '2026-01-05')).toBe('2025-12-20');
    expect(F.inferDate('12', '31', null, '2026-10-15')).toBe('2025-12-31');
    expect(F.inferDate('12', '1', null, TODAY)).toBe('2026-12-01');
    expect(F.inferDate('3', '1', null, TODAY)).toBe('2026-03-01');
  });
  it('invalid dates -> null', () => {
    expect(F.inferDate('2', '30', null, TODAY)).toBeNull();
    expect(F.inferDate('13', '02', null, TODAY)).toBeNull();
  });
});

describe('parseTimelineLines', () => {
  it('parses M/D - text lines and keeps undated lines', () => {
    const l = F.parseTimelineLines('11/09 - towed\nfree text\n10/18: arrived', TODAY);
    expect(l.map((x) => [x.date, x.text])).toEqual([['2026-11-09', 'towed'], [null, 'free text'], ['2026-10-18', 'arrived']]);
  });
});

describe('ETC cells', () => {
  const row = F.buildFleetDbr([
    makeUnit({ equipmentId: 'E1', canonicalNextStep: 'ETC 11/10', workDuration: '5d' }),
    makeUnit({ equipmentId: 'E2', savedNotes: 'ETC 11/05', workDuration: '20d' }),
    makeUnit({ equipmentId: 'E3', savedNotes: 'ETR 11/1', workDuration: '30d' }),
    makeUnit({ equipmentId: 'E4', savedNotes: 'ETC 11/25' }),
    makeUnit({ equipmentId: 'E5', savedNotes: 'nothing yet' }),
    makeUnit({ equipmentId: 'E6', savedNotes: 'ETC 11/05', lifecycleState: 'Active' }),
    makeUnit({ equipmentId: 'E7', repairTimeline: '11/09 - Dealer missed the ETC of 11/05, new date pending', workDuration: '10d' }),
  ], { today: TODAY }).rows[0];

  it('the three cells are bare whole numbers (D16: unmarked past dates are NO ETC); the Missed why is row.missedWhy', () => {
    expect(row.cells.etcToday).toBe('1');
    expect(row.cells.noEtc).toBe('4');
    expect(row.cells.missedEtc).toBe('1');
    expect(row.missedWhy).toEqual([{ unit: 'E7', date: '2026-11-05', why: "'11/09 - Dealer missed the ETC of 11/05, new date pending'", overrode: null }]);
    expect(row.userEtcOverrides).toEqual([]);
    expect(row.etcInvariant).toBe(true);
    // The ETC cells never list unit IDs (FAS Actions now names them: composer text).
    expect(JSON.stringify([row.cells.etcToday, row.cells.noEtc, row.cells.missedEtc])).not.toMatch(/E1|E4|E5|E6|E7/);
    // IDs stay in units[].etc for the drill-down.
    expect(row.units.find((u) => u.id === 'E1').etc.state).toBe('today');
    expect(row.units.find((u) => u.id === 'E5').etc.state).toBe('none');
    expect(row.units.find((u) => u.id === 'E4').etc).toMatchObject({ state: 'future', date: '2026-11-25' });
    expect(row.units.find((u) => u.id === 'E5').etc.date).toBeNull();
  });
  it('empty buckets are "0"', () => {
    const r = F.buildFleetDbr([makeUnit({ equipmentId: 'Z1', lifecycleState: 'Active' })], { today: TODAY }).rows[0];
    expect([r.cells.etcToday, r.cells.noEtc, r.cells.missedEtc]).toEqual(['0', '0', '0']);
  });
});

describe('etcMentionDates (AC21 ETC source)', () => {
  const T = '2026-11-12';
  it('accepts expectation phrasing', () => {
    for (const s of ['dealer says ready 11/12', 'expected to be complete 11/12', 'should be ready by 11/12', 'promised ready 11/12']) {
      expect(F.etcMentionDates(s, T), s).toEqual(['11/12']);
    }
  });
  it('excludes bare parts ETAs, past-tense events and delivery wording', () => {
    for (const s of ['Parts ETA 11/08 turbo', 'diagnosis completed 11/05', 'PM done 11/03', 'estimate completed 11/04', 'parts delivered and ready 11/12']) {
      expect(F.etcMentionDates(s, T), s).toEqual([]);
    }
  });
  it('returns every positive ETC date (not only the winner), unpadded and de-duplicated; negated ones are skipped', () => {
    expect(F.etcMentionDates('ETC 11/08; later new ETC 11/14 and ETR 11/14', T)).toEqual(['11/8', '11/14']);
    expect(F.etcMentionDates('no ETC yet; parts should be ready by 11/20', T)).toEqual([]);
    expect(F.etcMentionDates('brakes, filters etc. 11/12', T)).toEqual([]);
  });
  it('parseEtc reads expectation phrasing too, and still ignores the excluded lines', () => {
    expect(etc({ savedNotes: 'dealer says ready 11/12' })).toMatchObject({ state: 'future', date: '2026-11-12' });
    expect(etc({ savedNotes: 'diagnosis completed 11/05' }).state).toBe('none');
    expect(etc({ savedNotes: 'parts delivered and ready 11/12' }).state).toBe('none');
  });
});

describe('evidenceHash', () => {
  const a = makeUnit({ equipmentId: 'H1', vendor: 'TA', repairTimeline: '11/09 - towed' });
  const b = makeUnit({ equipmentId: 'H2', savedNotes: 'called TA' });
  it('is stable, order-independent and set on every built row next to unitsHash', () => {
    expect(F.evidenceHash([a, b])).toBe(F.evidenceHash([b, a]));
    expect(F.evidenceHash([a, b])).toMatch(/^[0-9a-f]{40}$/);
    const built = F.buildFleetDbr([a, b], { today: TODAY });
    for (const r of built.rows) expect(r.evidenceHash).toMatch(/^[0-9a-f]{40}$/);
    expect(built.rows[0].evidenceHash).toBe(F.evidenceHash([a, b]));
  });
  it('changes when only repairTimeline changes (unitsHash does not)', () => {
    const a2 = Object.assign({}, a, { repairTimeline: '11/09 - towed\n11/10 - at dealer' });
    expect(F.evidenceHash([a2, b])).not.toBe(F.evidenceHash([a, b]));
    expect(F.unitsHash([a2, b])).toBe(F.unitsHash([a, b]));
  });
  it('changes on notes, conversation, ASIST notes and status fields', () => {
    const base = F.evidenceHash([a, b]);
    for (const patch of [{ savedNotes: 'x' }, { fullConversation: 'Conversation\n11/10 - X Y: hi' }, { asistNotes: 'case 1' }, { savedRepairStatus: 'Parts ordered' }]) {
      expect(F.evidenceHash([Object.assign({}, a, patch), b])).not.toBe(base);
    }
  });
});

// ── FEAT-002: ETC buckets need evidence (design §3.2-§3.5, §14) ─────────────
const fe = (o) => Object.assign({ date: null, kind: 'repairCompletion', state: 'none', explicitMissDate: null, source: null, statedAt: null, snippet: '', negated: false, reason: null }, o);
const T25 = '2026-11-25';
const AT25 = '2026-11-25T15:00:00Z';      // 10:00 ET on 11/25
const on = (fields) => makeUnit(Object.assign({ _factsOn: true }, fields));
const relayToday = (o) => fe(Object.assign({ state: 'today', date: T25, source: 'relay', statedAt: AT25, snippet: 'Expected completion 11/25' }, o));
const bucket = (row, today = T25) => F.countedEtc(row, F.parseEtc(row, today), today);

describe('D2 negation regexes (probes, savedNotes, today 11/24)', () => {
  const T24 = '2026-11-24';
  const p = (s) => F.parseEtc(makeUnit({ savedNotes: s }), T24);
  it('AC4 and the other negated phrasings -> none', () => {
    for (const s of ['ETC not yet known, parts 11/14', 'ETC not known yet; parts ETA 11/24', 'ETC TBD, parts 11/24', 'No ETC provided.', 'repair ETC not stated', 'ETR remains unknown']) {
      expect(p(s), s).toMatchObject({ state: 'none', date: null });
    }
  });
  it('"at risk", appointments and "no diagnosis yet" still parse as ETC Today (countedEtc rejects them)', () => {
    for (const s of ['Battery cable arrived 11/24; ETR 11/24 at risk', 'ETR 11/24 at risk - batteries no ETA', 'Tech appointment 11/24; ETR 11/24', 'ETR 11/24 (vendor default), no diagnosis yet']) {
      expect(p(s), s).toMatchObject({ state: 'today', date: '2026-11-24' });
    }
    expect(bucket(makeUnit({ savedNotes: 'Battery cable arrived 11/24; ETR 11/24 at risk' }), T24)).toMatchObject({ bucket: 'none', reason: 'newer-negation' });
    expect(bucket(makeUnit({ savedNotes: 'Tech appointment 11/24; ETR 11/24' }), T24)).toMatchObject({ bucket: 'none', reason: 'appointment' });
    expect(bucket(makeUnit({ savedNotes: 'ETR 11/24 (vendor default), no diagnosis yet' }), T24)).toMatchObject({ bucket: 'none', reason: 'not-started' });
  });
  it('etcKeywordNegated shares the regexes', () => {
    expect(F.etcKeywordNegated('ETC not yet known, parts 11/14', 0, 3)).toBe(true);
    expect(F.etcKeywordNegated('No new repair ETC set', 14, 17)).toBe(true);
    expect(F.etcKeywordNegated('ETC 11/14 per dealer', 0, 3)).toBe(false);
  });
});

describe('D3 / DR2-2 build-time recompute of _factEtc', () => {
  const p = (f) => F.parseEtc(on({ _factEtc: fe(f) }), T25);
  it('{today, 11/24} built 11/25 -> none + missDowngraded (passedDate 11/24)', () => {
    expect(p({ state: 'today', date: '2026-11-24', source: 'relay', statedAt: '2026-11-24T15:00:00Z' }))
      .toMatchObject({ state: 'none', date: null, source: 'extracted', missDowngraded: true, passedDate: '2026-11-24' });
  });
  it('{future, 11/25} built 11/25 -> today', () => {
    expect(p({ state: 'future', date: T25, source: 'relay', statedAt: '2026-11-24T15:00:00Z' })).toMatchObject({ state: 'today', date: T25, explicitMissDate: null });
  });
  it('DR2-2: {today, 11/24, explicitMissDate 11/20} built 11/25 -> missed 11/20', () => {
    expect(p({ state: 'today', date: '2026-11-24', explicitMissDate: '2026-11-20', source: 'relay', statedAt: '2026-11-24T15:00:00Z' }))
      .toMatchObject({ state: 'missed', date: '2026-11-20', source: 'extracted', explicitMissDate: '2026-11-20' });
  });
  it('the same recompute applies in the non-take branch', () => {
    const stale = { state: 'today', date: '2026-11-24', source: 'relay', statedAt: '2026-11-24T15:00:00Z' };
    expect(F.parseEtc(on({ savedNotes: 'ETC 11/30', _factEtc: fe(stale) }), T25)).toMatchObject({ state: 'future', source: 'savedNotes' });
    expect(F.parseEtc(on({ savedNotes: 'ETC 11/30', _factEtc: fe(Object.assign({ explicitMissDate: '2026-11-20' }, stale)) }), T25))
      .toMatchObject({ state: 'missed', date: '2026-11-20', source: 'extracted', overrode: { field: 'savedNotes', was: 'future' } });
  });
});

describe('D4 structured-only revision (_factEtc.structuredMiss)', () => {
  const sm = { date: '2026-11-20', at: '2026-11-21T15:00:00Z', snippet: 'missed the ETC of 11/20' };
  it('structured-only miss -> missed 11/20, source extracted', () => {
    expect(F.parseEtc(on({ _factEtc: fe({ structuredMiss: sm }) }), T25))
      .toMatchObject({ state: 'missed', date: '2026-11-20', source: 'extracted', explicitMissDate: '2026-11-20', snippet: 'missed the ETC of 11/20' });
  });
  it('a current today head keeps precedence and carries explicitMissDate; an unsupported today then goes to Missed', () => {
    const row = on({ _factEtc: relayToday({ structuredMiss: sm }) });
    expect(F.parseEtc(row, T25)).toMatchObject({ state: 'today', explicitMissDate: '2026-11-20' });
    expect(bucket(row)).toMatchObject({ bucket: 'today' });
    expect(bucket(Object.assign({}, row, { savedRepairStatus: 'Under diagnosis' }))).toMatchObject({ bucket: 'missed', reason: 'not-started' });
  });
  it('an invalid or future structuredMiss date is ignored', () => {
    expect(F.parseEtc(on({ _factEtc: fe({ structuredMiss: { date: '2026-11-30' } }) }), T25).state).toBe('none');
    expect(F.parseEtc(on({ _factEtc: fe({ structuredMiss: { date: '11/20' } }) }), T25).state).toBe('none');
  });
});

describe('D5 Path-B provenance and the user Q9 rule', () => {
  const miss = fe({ state: 'missed', date: '2026-11-20', explicitMissDate: '2026-11-20', source: 'relay', statedAt: '2026-11-21T15:00:00Z', snippet: 'missed the ETC of 11/20' });
  const passed = { date: '2026-11-23', statedAt: '2026-11-21T15:00:00Z', source: 'relay' };
  it('user No ETC + extracted explicit miss -> missed + overrode', () => {
    const r = F.parseEtc(on({ savedNotes: '11/22 - No ETC', _factEtc: miss }), T25);
    expect(r).toMatchObject({ state: 'missed', date: '2026-11-20', source: 'extracted', explicitMissDate: '2026-11-20' });
    expect(r.overrode).toEqual({ field: 'savedNotes', was: 'none', userSnippet: '11/22 - No ETC' });
  });
  it('overrode is set only for user note fields', () => {
    const r = F.parseEtc(on({ repairTimeline: '11/22 - No ETC from dealer', _factEtc: miss }), T25);
    expect(r).toMatchObject({ state: 'missed', source: 'extracted' });
    expect(r.overrode).toBeUndefined();
    const c = F.parseEtc(on({ canonicalNextStep: 'ETC 11/30', _factEtc: miss }), T25);
    expect(c.overrode).toEqual({ field: 'canonicalNextStep', was: 'future', userSnippet: 'ETC 11/30' });
  });
  it('Q9: saved "No ETC" + a passed extracted ETC (passedHead) -> Missed with the override marker', () => {
    const row = on({ equipmentId: 'Q1', savedNotes: '11/22 - No ETC', _factEtc: fe({ passedHead: passed }) });
    const r = F.parseEtc(row, T25);
    expect(r).toMatchObject({ state: 'missed', date: '2026-11-23', source: 'extracted', explicitMissDate: null, viaPassedHead: true });
    expect(r.overrode).toEqual({ field: 'savedNotes', was: 'none', userSnippet: '11/22 - No ETC' });
    expect(F.countedEtc(row, r, T25)).toMatchObject({ bucket: 'missed', reason: 'no-etc-note-passed-etr' });
    const built = F.buildFleetDbr([row], { today: T25 }).rows[0];
    expect(built.cells.missedEtc).toBe('1');
    expect(built.units[0].etc.overrode).toBeTruthy();
    expect(built.userEtcOverrides).toEqual([{ unit: 'Q1', date: '2026-11-23', userSnippet: '11/22 - No ETC', extractedSnippet: '' }]);
  });
  it('Q9 other side: a passed ETR with no "No ETC" note and no marker -> none, missDowngraded, no overrode', () => {
    const r = F.parseEtc(on({ _factEtc: fe({ passedHead: passed }) }), T25);
    expect(r).toMatchObject({ state: 'none', missDowngraded: true, passedDate: '2026-11-23' });
    expect(r.overrode).toBeUndefined();
    const s = F.parseEtc(on({ savedNotes: '11/22 - waiting on parts', _factEtc: fe({ passedHead: passed }) }), T25);
    expect(s).toMatchObject({ state: 'none', missDowngraded: true });
    expect(s.overrode).toBeUndefined();
  });
  it('saved "No ETC" with no passedHead and no explicit miss -> NO ETC', () => {
    const row = on({ equipmentId: 'Q2', savedNotes: '11/22 - No ETC', _factEtc: fe({}) });
    expect(F.parseEtc(row, T25)).toMatchObject({ state: 'none', source: 'savedNotes' });
    const built = F.buildFleetDbr([row], { today: T25 }).rows[0];
    expect([built.cells.etcToday, built.cells.noEtc, built.cells.missedEtc]).toEqual(['0', '1', '0']);
    expect(built.userEtcOverrides).toEqual([]);
  });
});

describe('countedEtc (design §3.2)', () => {
  it('AC3 shapes from 2026-11-25: B12195 / B12261 / B62020 / B62049 -> none', () => {
    const b12195 = on({ vendor: 'COX', savedRepairStatus: 'Parts ordered',
      repairTimeline: '11/25 - Battery delivery delayed. Repair remains blocked pending battery delivery. No ETC provided.',
      _factEtc: relayToday({ snippet: 'Expected completion date time 2026-11-26T04:31Z', slip: { count: 13, seq: [] } }) });
    const b12261 = makeUnit({ vendor: 'COX', savedRepairStatus: 'Waiting for vendor', savedNotes: 'The latest vendor-set ETR is 11/25, due today',
      repairTimeline: '11/25 - No diagnosis or repair update has been logged' });
    const b62020 = on({ vendor: 'COX', partsStatus: 'ordered',
      repairTimeline: '11/25 - Parts ETA pending; repair blocked pending supplier response', _factEtc: relayToday() });
    const b62049 = on({ vendor: 'COX', repairTimeline: '11/25 - ETR 11/24 has passed. No new repair ETC set', _factEtc: relayToday() });
    expect(bucket(b12195)).toMatchObject({ bucket: 'none', reason: 'newer-negation' });
    expect(bucket(b12195).undercut).toMatch(/^11\/25 - Battery delivery delayed\. Repair remains blocked/);
    expect(bucket(b12195).undercut.length).toBeLessThanOrEqual(80);
    expect(bucket(b12261)).toMatchObject({ bucket: 'none', reason: 'not-started' });
    expect(bucket(b62020)).toMatchObject({ bucket: 'none', reason: 'newer-negation' });
    expect(bucket(b62049)).toMatchObject({ bucket: 'none', reason: 'newer-negation' });
  });
  it('AC3 shapes 320170 / 521008 / 321549 -> today', () => {
    const s320170 = on({ vendor: 'Amerit', partsStatus: 'ordered', partsEta: T25,
      repairTimeline: '11/25 - ETR 11/25; repair completion confirmation pending', _factEtc: relayToday() });
    const s521008 = on({ vendor: 'Amerit', partsStatus: 'ordered', partsEta: T25, _factEtc: relayToday() });
    const s321549 = on({ vendor: 'Amerit', repairTimeline: '11/25 - repair ETR 11/25', _factEtc: relayToday() });
    for (const r of [s320170, s521008, s321549]) expect(bucket(r)).toEqual({ bucket: 'today', reason: 'etc-today', undercut: null });
  });
  it('rules 1-3: missed -> Missed, future / none -> NO ETC', () => {
    expect(F.countedEtc({}, { state: 'missed', date: '2026-11-20' }, T25)).toMatchObject({ bucket: 'missed', reason: 'explicit-miss' });
    expect(F.countedEtc({}, { state: 'future', date: '2026-11-26' }, T25)).toMatchObject({ bucket: 'none', reason: 'future' });
    expect(F.countedEtc({}, { state: 'none', date: null }, T25)).toMatchObject({ bucket: 'none', reason: 'no-etc' });
    expect(F.countedEtc(null, null, T25)).toMatchObject({ bucket: 'none', reason: 'no-etc' });
  });
  it('(a) newer negation: a line dated on/after the stated day; older lines do not count', () => {
    expect(bucket(on({ canonicalNextStep: 'Completion is on hold', _factEtc: relayToday() }))).toMatchObject({ bucket: 'none', reason: 'newer-negation', undercut: 'Completion is on hold' });
    expect(bucket(on({ repairTimeline: '11/24 - No ETC provided', _factEtc: relayToday() }))).toMatchObject({ bucket: 'today' });
    expect(bucket(on({ asistNotes: '2026-11-25 11:00 Dealer: ETR not confirmed', _factEtc: relayToday() }))).toMatchObject({ reason: 'newer-negation' });
  });
  it('DR2-3: pattern 3 ignores an older, different date', () => {
    const rev = on({ repairTimeline: '11/25 - ETR 11/24 missed, new ETR 11/25 confirmed', _factEtc: relayToday({ explicitMissDate: '2026-11-24' }) });
    expect(bucket(rev)).toMatchObject({ bucket: 'today' });
    const risk = on({ repairTimeline: '11/25 - ETR 11/25 at risk', _factEtc: relayToday() });
    expect(bucket(risk)).toMatchObject({ bucket: 'none', reason: 'newer-negation' });
  });
  it('(b) parts-wait / parts-ok', () => {
    expect(bucket(on({ partsStatus: 'ordered', partsEta: '2026-11-18', _factEtc: relayToday() }))).toMatchObject({ bucket: 'none', reason: 'parts-wait' });
    expect(bucket(on({ partsStatus: 'ordered', partsEta: T25, _factEtc: relayToday() }))).toMatchObject({ bucket: 'today' });
    expect(bucket(on({ partsStatus: 'arrived', _factEtc: relayToday() }))).toMatchObject({ bucket: 'today' });
  });
  it('(c) not started: status, vendor delay, delay code, "no diagnosis" line', () => {
    expect(bucket(on({ savedRepairStatus: 'Under diagnosis', _factEtc: relayToday() }))).toMatchObject({ reason: 'not-started', undercut: null });
    expect(bucket(on({ savedRepairStatus: 'Vehicle arrived', _factEtc: relayToday() }))).toMatchObject({ reason: 'not-started' });
    expect(bucket(on({ vendorDelayReason: 'WAITING_FOR_DIAGNOSIS', _factEtc: relayToday() }))).toMatchObject({ reason: 'not-started' });
    expect(bucket(on({ delayReasonCodes: 'Waiting for diagnosis', _factEtc: relayToday() }))).toMatchObject({ reason: 'not-started' });
    expect(bucket(on({ repairTimeline: '11/25 - no repair update received', _factEtc: relayToday() }))).toMatchObject({ reason: 'not-started', undercut: '11/25 - no repair update received' });
    expect(bucket(on({ savedRepairStatus: 'Repair in progress', _factEtc: relayToday() }))).toMatchObject({ bucket: 'today' });
  });
  it('(d) appointment, not completion', () => {
    expect(bucket(makeUnit({ savedNotes: 'Tech appointment 11/25; ETR 11/25' }))).toMatchObject({ bucket: 'none', reason: 'appointment' });
    expect(bucket(makeUnit({ savedNotes: 'Tech appointment 11/24; ETR 11/25' }))).toMatchObject({ bucket: 'today' });
  });
  it('(e) rolling vendor ETR', () => {
    expect(bucket(on({ _factEtc: relayToday({ slip: { count: 5, seq: [] } }) }))).toMatchObject({ bucket: 'none', reason: 'rolling-etr' });
    expect(bucket(on({ _factEtc: relayToday({ slip: { count: 4, seq: [] } }) }))).toMatchObject({ bucket: 'today' });
  });
  it('(f) stale ETR: stated more than 7 days ago', () => {
    expect(bucket(on({ _factEtc: relayToday({ statedAt: '2026-11-17T15:00:00Z' }) }))).toMatchObject({ bucket: 'none', reason: 'stale-etr' });
    expect(bucket(on({ _factEtc: relayToday({ statedAt: '2026-11-18T15:00:00Z' }) }))).toMatchObject({ bucket: 'today' });
  });
  it('Path-B fallback: today + explicitMissDate 11/20 + a newer "No ETC provided" -> Missed', () => {
    const row = on({ repairTimeline: '11/25 - No ETC provided', _factEtc: relayToday({ explicitMissDate: '2026-11-20' }) });
    expect(F.parseEtc(row, T25)).toMatchObject({ state: 'today', explicitMissDate: '2026-11-20' });
    expect(bucket(row)).toMatchObject({ bucket: 'missed', reason: 'newer-negation' });
  });
});

describe('explicitMissDate on every today result; statedDay; D18 redaction', () => {
  it('take branch, kept-legacy-today branch and legacy rows', () => {
    expect(F.parseEtc(on({ _factEtc: relayToday() }), T25)).toMatchObject({ state: 'today', explicitMissDate: null });
    expect(F.parseEtc(on({ _factEtc: relayToday({ explicitMissDate: '2026-11-20' }) }), T25)).toMatchObject({ state: 'today', explicitMissDate: '2026-11-20' });
    const kept = F.parseEtc(on({ savedNotes: 'ETC 11/25', _factEtc: fe({ state: 'missed', date: '2026-11-20', explicitMissDate: '2026-11-20', source: 'relay', statedAt: AT25 }) }), T25);
    expect(kept).toMatchObject({ state: 'today', source: 'savedNotes', explicitMissDate: '2026-11-20' });
    expect(F.parseEtc(makeUnit({ savedNotes: 'ETC 11/25' }), T25)).toMatchObject({ state: 'today', explicitMissDate: null });
    expect(F.parseEtc(makeUnit({ savedNotes: 'Dealer missed the ETC of 11/20, new ETC 11/25' }), T25)).toMatchObject({ state: 'today', explicitMissDate: '2026-11-20' });
  });
  it('statedDay per source', () => {
    expect(F.parseEtc(makeUnit({ repairTimeline: '11/24 - ETC 11/26' }), T25).statedDay).toBe('2026-11-24');
    expect(F.parseEtc(makeUnit({ savedNotes: 'older\n11/23 - ETC 11/26' }), T25).statedDay).toBe('2026-11-23');
    expect(F.parseEtc(makeUnit({ savedNotes: 'ETC 11/26' }), T25).statedDay).toBeNull();
    expect(F.parseEtc(makeUnit({ asistNotes: '2026-11-22 10:00 Dealer: ETC 11/26' }), T25).statedDay).toBe('2026-11-22');
    expect(F.parseEtc(makeUnit({ canonicalNextStep: 'ETC 11/26' }), T25).statedDay).toBeNull();
    expect(F.parseEtc(on({ _factEtc: relayToday({ statedAt: '2026-11-25T03:00:00Z' }) }), T25).statedDay).toBe('2026-11-24');
  });
  it('D18: an ISO date/time survives redaction; phones are still redacted', () => {
    const r = F.parseEtc(on({ _factEtc: relayToday({ snippet: 'Expected completion date time 2026-11-26T04:31Z' }) }), T25);
    expect(r.snippet).toContain('2026-11-26T04:31Z');
    const p = F.parseEtc(on({ _factEtc: relayToday({ snippet: 'call 555-123-4567 re ETC' }) }), T25);
    expect(p.snippet).toContain('[redacted]');
    expect(p.snippet).not.toContain('4567');
  });
});
