// tests/wo-extract-dates.test.js — relay-extract §5 / §6.1 / §6.2 / §6.3 rule (a):
// AC4, AC5, the negation table, consumed spans, markers + MET guard, explicitRepairMiss,
// fractions, year inference, TA-only normalization, amounts, adversarial input.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const D = require('../src/repair-intel/wo-extract-dates');
const { explicitRepairMiss, REPAIR_MISS_MARKER_RE } = require('../src/dbr/fleet-dbr');

const AT = '2026-11-02T15:00:00Z'; // Mon 11/02 10:00 EST
const scan = (t, o = {}) => D.scanEtc(t, Object.assign({ at: AT }, o));
const men = (t, o) => scan(t, o).mentions.map((m) => [m.ymd, m.kind]);

describe('timestamps', () => {
  it('ISO incl. nanoseconds, legacy UTC form, epoch ms, Decisiv form', () => {
    expect(D.parseTs('2026-09-23T18:04:30.934Z')).toBe(Date.parse('2026-09-23T18:04:30.934Z'));
    expect(D.parseTs('2026-09-26T15:00:00.204881915Z')).toBe(Date.parse('2026-09-26T15:00:00.204Z'));
    expect(D.parseTs('11/03/2026 14:05:09')).toBe(Date.UTC(2026, 10, 3, 14, 5, 9));
    expect(D.parseTs(1700000000000)).toBe(1700000000000);
    expect(D.parseTs('11/10/26 10:28 am EST')).toBe(Date.parse('2026-11-10T15:28:00Z'));
    expect(D.parseTs('garbage')).toBe(null);
    expect(D.parseTs(null)).toBe(null);
  });
  it('parseDecisivTs fixed offsets', () => {
    expect(D.parseDecisivTs('09/28/26 02:05 pm EDT')).toBe(Date.parse('2026-09-28T18:05:00Z'));
    expect(D.parseDecisivTs('10/23/2026 03:37 AM PDT')).toBe(Date.parse('2026-10-23T10:37:00Z'));
    expect(D.parseDecisivTs('11/10/26 12:05 am CST')).toBe(Date.parse('2026-11-10T06:05:00Z'));
  });
  it('ymd / md use the local calendar', () => {
    expect(D.ymd(Date.parse('2026-11-04T01:30:00Z'))).toBe('2026-11-03');
    expect(D.md('2026-11-03')).toBe('11/3');
  });
});

describe('AC4 TA normalizers', () => {
  it('TA spaced cents and comma-space amounts', () => {
    expect(D.findAmounts('submitted to 501  $28 895 94', { ta: true }).map((a) => a.value)).toEqual([28895.94]);
    expect(D.findAmounts('Revised estimate uploaded $24 715 13', { ta: true })[0].value).toBe(24715.13);
    expect(D.findAmounts('estimate for $24, 804.13')[0].value).toBe(24804.13);
    expect(D.findAmounts('reject $ 1,720.52')[0].value).toBe(1720.52);
    expect(D.normAmount('24804.126')).toBe(24804.13);
  });
  it('TA one-liner ETA … ETC … -> exactly 10/29 techOnsite + 11/07 repairCompletion', () => {
    expect(men('ETA  10 29 2026 2 30 PM  EDT   ETC  11 07 2026 12 05 PM  EST', { ta: true, at: '2026-10-28T13:00:00Z' }))
      .toEqual([['2026-10-29', 'techOnsite'], ['2026-11-07', 'repairCompletion']]);
  });
  it('nearest keyword: Tech ETA / ETC; Parts ETC tie -> R1', () => {
    expect(men('Tech ETA 11/12, ETC 11/14')).toEqual([['2026-11-12', 'techOnsite'], ['2026-11-14', 'repairCompletion']]);
    expect(men('Parts ETC -10/11/2026')).toEqual([['2026-10-11', 'partsArrival']]);
  });
  it('EXPECTED UPDATE FROM SUPPLIER -> updateExpected', () => {
    expect(men('PARTS ARE ON ORDER   EXPECTED UPDATE FROM SUPPLIER 11 10 26', { ta: true })).toEqual([['2026-11-10', 'updateExpected']]);
  });
  it('eta for parts … friday 11 13 26 -> partsArrival; possible etc -> tentative repairCompletion', () => {
    const r = scan('eta for parts will be in on friday 11 13 26    waiting on hood    possible etc 11 20 26', { ta: true });
    expect(r.mentions.map((m) => [m.ymd, m.kind, !!m.tentative])).toEqual([
      ['2026-11-13', 'partsArrival', false], ['2026-11-20', 'repairCompletion', true],
    ]);
  });
  it('dealer-side non-TA string is not normalized; vendor TA string is', () => {
    const s = 'Qty 1 2 2026 order ref $28 895 94 ETC 11 07 2026 12 05 PM';
    expect(scan(s).mentions.map((m) => m.ymd)).not.toContain('2026-11-07');
    expect(D.findAmounts(s).map((a) => a.value)).not.toContain(28895.94);
    expect(scan(s, { ta: true }).mentions.map((m) => m.ymd)).toContain('2026-11-07');
    expect(D.findAmounts(s, { ta: true }).map((a) => a.value)).toContain(28895.94);
    expect(D.taDigitsToDates('ETC  11 07 2026 12 05 PM', { at: AT }).map((m) => m.ymd)).toEqual(['2026-11-07']);
  });
});

describe('AC5 month-ordinal and relative dates', () => {
  it('DUE IN ON OCT 11TH (note 09/28) -> 2026-10-11 partsArrival', () => {
    expect(men('DUE IN ON OCT 11TH', { at: '2026-09-28T18:05:00Z' })).toEqual([['2026-10-11', 'partsArrival']]);
  });
  it('16th of Sept (comment 09/10) -> repairCompletion 09/16', () => {
    expect(men('Current unit ETC is the 16th of Sept', { at: '2026-09-10T15:00:00Z' })).toEqual([['2026-09-16', 'repairCompletion']]);
  });
  it('early next week 10/27 -> 10/27 approx', () => {
    const r = scan('ETC is early next week 10/27', { at: '2026-10-21T15:00:00Z' }).mentions;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ymd: '2026-10-27', kind: 'repairCompletion', approx: true });
  });
  it('week of 11/09 -> repairStart, approx weekOf', () => {
    const r = scan('repairs are scheduled to begin next week (week of 11/09)').mentions;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ymd: '2026-11-09', kind: 'repairStart', approx: 'weekOf' });
  });
  it('by thurs (Mon 11/02) -> partsArrival 11/05, relative thurs', () => {
    const r = scan('hoping for them to be here by thurs').mentions;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ ymd: '2026-11-05', kind: 'partsArrival', relative: 'thurs' });
  });
  it('year rollover: 12/20 and 1/05 stated 12/18', () => {
    const at = '2026-12-18T15:00:00Z';
    expect(D.findDateMentions('12/20', { at }).map((m) => m.ymd)).toEqual(['2026-12-20']);
    expect(D.findDateMentions('1/05', { at }).map((m) => m.ymd)).toEqual(['2027-01-05']);
    expect(D.findDateMentions('9/17', { at: '2026-09-23T15:00:00Z' }).map((m) => m.ymd)).toEqual(['2026-09-17']);
    expect(D.inferYear(1, 5, Date.parse(at))).toBe(2027);
  });
  it('relativeDate: tomorrow / next week / end of week', () => {
    const at = Date.parse('2026-11-06T15:00:00Z'); // Friday
    expect(D.relativeDate('tomorrow', at)).toEqual({ ymd: '2026-11-07' });
    expect(D.relativeDate('next week', at)).toEqual({ ymd: '2026-11-09', approx: 'week' });
    expect(D.relativeDate('end of week', at)).toEqual({ ymd: '2026-11-13' });
    expect(D.relativeDate('friday', null)).toBe(null);
  });
  it('fractions and invalid numerics are not dates', () => {
    expect(D.findDateMentions('use 3/4 inch line and 1/2 ton jack', { at: AT })).toEqual([]);
    expect(D.findDateMentions('13/45', { at: AT })).toEqual([]);
    expect(D.findDateMentions('filters, belts, etc. 11/12', { at: AT }).length).toBe(1);
    expect(men('filters, belts, etc. 11/12')).toEqual([]);
  });
});

describe('§6.2 negation table', () => {
  const rows = [
    ['No ESD at this time for part#3010287243', false, 'partsShip'],
    ['there is no information on parts ETC yet', false, 'partsArrival'],
    ['No updated parts ETA', false, 'partsArrival'],
    ['ETC: N/A', false, 'repairCompletion'],
    ['ETC - N/A', false, 'repairCompletion'],
    ['ETC TBD', true, 'repairCompletion'],
    ['Pending ETC', true, 'repairCompletion'],
    ['ETA TBD', false, 'techOnsite'],
    ['no eta on the parts', false, 'partsArrival'],
    ['tech has no eta', false, 'techOnsite'],
    ['Parts ETC: TBD', false, 'partsArrival'],
    ['will advise when unit is ready', false, 'repairCompletion'],
  ];
  for (const [text, ta, kind] of rows) {
    it(text + ' -> 1 negated ' + kind, () => {
      const r = scan(text, { ta });
      expect(r.negated.map((n) => n.kind)).toEqual([kind]);
      expect(r.mentions).toEqual([]);
    });
  }
  it('Parts ETC still is 10/11/2026 -> 0 negated, 1 dated partsArrival', () => {
    const r = scan('Parts ETC still is 10/11/2026');
    expect(r.negated).toEqual([]);
    expect(r.mentions.map((m) => [m.ymd, m.kind])).toEqual([['2026-10-11', 'partsArrival']]);
  });
  it('Pending ETC 11/20 -> negated, no dated mention', () => {
    const r = scan('Pending ETC 11/20');
    expect(r.negated.map((n) => n.kind)).toEqual(['repairCompletion']);
    expect(r.mentions).toEqual([]);
  });
  it('ETC TBD, possible etc 11 20 26 (TA) -> 1 negated + 1 dated tentative 11/20', () => {
    const r = scan('ETC TBD, possible etc 11 20 26', { ta: true });
    expect(r.negated.map((n) => n.kind)).toEqual(['repairCompletion']);
    expect(r.mentions.map((m) => [m.ymd, m.kind, m.tentative])).toEqual([['2026-11-20', 'repairCompletion', true]]);
  });
});

describe('markers and consumed spans (§6.3 rule (a))', () => {
  it('findDateMentions honours consumed spans; invalid elements ignored', () => {
    expect(D.findDateMentions('parts received on 11/12', { at: AT, consumed: [{ start: 18, end: 23 }] })).toEqual([]);
    expect(D.findDateMentions('parts received on 11/12', { at: AT }).map((m) => m.ymd)).toEqual(['2026-11-12']);
    expect(D.findDateMentions('parts received on 11/12', { at: AT, consumed: [null, { start: 'x' }, 7] }).length).toBe(1);
    expect(D.findDateMentions('parts received on 11/12', { at: AT, consumed: 'nope' }).length).toBe(1);
  });
  it('cited miss date is consumed; the revision date stays a mention', () => {
    const r = scan('originally scheduled to ship on 10/11; however, the part is now on backorder, with a revised estimated ship date of 10/26', { at: '2026-10-14T15:00:00Z' });
    expect(r.mentions.map((m) => [m.ymd, m.kind])).toEqual([['2026-10-26', 'partsShip']]);
    expect(r.miss.map((m) => [m.chain, m.citedDate])).toEqual([['parts', '2026-10-11']]);
  });
  it('two MISS matches in one comment are both consumed (/g)', () => {
    const r = scan('The part was expected on 10/11 but has not arrived. It was originally scheduled to ship on 10/09.', { at: '2026-10-14T15:00:00Z' });
    expect(r.miss.map((m) => m.citedDate)).toEqual(['2026-10-11', '2026-10-09']);
    expect(r.mentions).toEqual([]);
    expect(D.findMarkers('The part was expected on 10/11 but has not arrived. It was originally scheduled to ship on 10/09.', { at: '2026-10-14T15:00:00Z' }).consumed).toHaveLength(2);
  });
  it('MISS markers sort after mentions; MET events sort by offset', () => {
    const r = scan('ETC revised from 11/07 to 11/14', { at: '2026-11-09T15:00:00Z' });
    expect(r.events.map((e) => e.type)).toEqual(['mention', 'miss']);
    expect(r.events[0]).toMatchObject({ ymd: '2026-11-14', kind: 'repairCompletion' });
    expect(r.events[1]).toMatchObject({ chain: 'repairCompletion', citedDate: '2026-11-07', repair: true });
    const m = scan('All parts arrived. Repair is complete. ETC 11/06', { at: '2026-11-05T15:00:00Z' });
    expect(m.events.map((e) => e.type + ':' + (e.chain || e.kind))).toEqual(['met:parts', 'met:repairCompletion', 'mention:repairCompletion']);
  });
  it('MET guard', () => {
    const guarded = ['Repairs will begin once all parts are in', 'will call when parts received', 'will advise when unit is ready for pick up',
      'customer to be notified after repair is complete', 'have all parts arrived?', 'no parts received yet'];
    for (const t of guarded) expect(scan(t).met, t).toHaveLength(0);
    for (const t of ['11/04 update: all required parts have arrived', 'Parts arrived on 11/03, tech scheduled', 'All parts arrived - pending install', 'Will call. All parts have arrived.']) {
      expect(scan(t).met, t).toHaveLength(1);
    }
    expect(scan('Parts arrived on 11/03, tech scheduled').met[0].citedDate).toBe('2026-11-03');
    expect(scan('Parts arrived on 11/03, tech scheduled').mentions).toEqual([]);
    expect(D.MET_GUARD_RE.flags).not.toContain('g');
    expect(D.MISS_MARKER_RE.flags).toBe('dgi');
    expect(D.MET_MARKER_RE.flags).toBe('dgi');
  });
});

describe('explicitRepairMiss (fleet-dbr shared marker)', () => {
  it('ETC revised from 11/07 to 11/14 (today 11/11) -> 11/07', () => {
    const r = explicitRepairMiss('ETC revised from 11/07 to 11/14', '2026-11-11');
    expect(r).toHaveLength(1);
    expect(r[0].date).toBe('2026-11-07');
    expect('ETC revised from 11/07 to 11/14'.slice(r[0].start, r[0].end)).toBe('11/07');
  });
  it('a bare past ETC is not a miss', () => {
    expect(explicitRepairMiss('ETC 11/07', '2026-11-11')).toEqual([]);
    expect(explicitRepairMiss('', '2026-11-11')).toEqual([]);
  });
  it('every repair alternative', () => {
    const t = '2026-11-11';
    expect(explicitRepairMiss('dealer missed the ETC of 11/07', t).map((x) => x.date)).toEqual(['2026-11-07']);
    expect(explicitRepairMiss('dealer missed ETR', t).map((x) => x.date)).toEqual([null]);
    expect(explicitRepairMiss('unit did not complete by 11/08', t).map((x) => x.date)).toEqual(['2026-11-08']);
    expect(explicitRepairMiss('ETR was pushed out to 11/20', t).map((x) => x.date)).toEqual([null]);
    expect(explicitRepairMiss('revised ETC from 11/06 to 11/18', t).map((x) => x.date)).toEqual(['2026-11-06']);
    expect(explicitRepairMiss('repair pushed to 11/19', t).map((x) => x.date)).toEqual([null]);
    expect(explicitRepairMiss('no longer expected for 11/09', t).map((x) => x.date)).toEqual(['2026-11-09']);
    // a cited date on or after today is not a miss
    expect(explicitRepairMiss('ETC revised from 11/12 to 11/14', t)).toEqual([]);
    expect(REPAIR_MISS_MARKER_RE.flags).toBe('dgi');
  });
  it('the null-date marker span stops before the new date', () => {
    const s = 'ETR was pushed out to 11/20';
    const [r] = explicitRepairMiss(s, '2026-11-11');
    expect(s.slice(r.start, r.end)).toBe('ETR was pushed out to ');
    expect(scan(s, { at: '2026-11-11T15:00:00Z' }).mentions.map((m) => [m.ymd, m.kind])).toEqual([['2026-11-20', 'repairCompletion']]);
  });
});

describe('adversarial input', () => {
  it('200 KB string < 500 ms', () => {
    const chunk = 'ETC 11/12 Part #85152780 no eta $1,234.56 Order #3010287243 was expected on 10/11 but has not arrived 1 2 2026 4 05 PM ';
    let s = '';
    while (s.length < 200 * 1024) s += chunk;
    const t0 = Date.now();
    const r = D.scanEtc(s, { at: AT, ta: true });
    D.findAmounts(s, { ta: true });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(r.mentions.length).toBeGreaterThan(0);
  });
});
