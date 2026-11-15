// tests/fleet-dbr-gate-typed.test.js — relay-extract §14.3.1 additions to the merged gate:
// gateContext({typed}) strict mode, the parts-labelled ETC branch, typedRefProblem, gateEntry /
// gateProse / textContext, _datesAfterAt kwAt, EV.textEvidence. Inert without `typed`.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const G = require('../src/dbr/fleet-dbr-gate');
const EV = require('../src/dbr/fleet-dbr-evidence');

const TODAY = '2026-11-11';
const TEXT = [
  '10/14 - Uptime: harness Part #85152780 on backorder, revised ship 10/26',
  '10/28 - Dealer: Order #3010287243 no tracking yet; Parts ETC 10/26 was the plan',
  '11/10 - Uptime: ETR is 11/11/2026; RO # 30319SP; dealer code 5948D',
].join('\n');
const typed = () => ({
  tokenText: '85152780 3010287243 30319SP 5948D 20944704 10/26 11/11',
  byKind: {
    part: new Set(['85152780']), order: new Set(['3010287243']), ro: new Set(['30319SP']), dealerCode: new Set(['5948D']),
    tow: new Set(), fleetnet: new Set(),
    case: { salesforce: new Set(), decisivCase: new Set(['20944704']), oemCase: new Set(), unknown: new Set() },
  },
  etcRepair: new Set(['11/11']), partsDates: new Set(['10/26']), factIds: new Map(),
});
const strict = () => G.textContext({ text: TEXT, today: TODAY, typed: typed() });
const plain = () => G.textContext({ text: TEXT, today: TODAY });
const v = (g) => (g.ok ? 'kept' : g.code);

describe('inert without typed', () => {
  it('gateContext without typed has no strict keys', () => {
    const c = plain();
    expect(c.strict).toBeUndefined();
    expect(c.typed).toBeUndefined();
    expect(c.repairEtcDates).toBeUndefined();
    expect(c.partsDates).toBeUndefined();
  });
  it('non-strict: the ETC check is the base whitelist (Parts ETC 10/26 and ETC 10/26 both pass as today)', () => {
    const c = plain();
    expect(v(G.gateEntry('ETC 10/26 per dealer', undefined, ['U'], c))).toBe('kept');
    expect(G.proseTokens('Parts ETC 10/26', ['U'], c, { part: 'tokens' })).toBeNull();
    expect(G.gateEntry('Part #3010287243 on order', undefined, ['U'], c).untyped).toBeUndefined();
  });
});

describe('strict ctx (typed present)', () => {
  it('sets strict, typed, repairEtcDates, partsDates; tokenText extends the evidence sets', () => {
    const c = strict();
    expect(c.strict).toBe(true);
    expect(c.repairEtcDates.U.has('11/11')).toBe(true);
    expect(c.repairEtcDates.U.has('10/26')).toBe(false);
    expect(c.partsDates.U.has('10/26')).toBe(true);
    expect(c.refs.U.has('20944704')).toBe(true);
    expect(c.etcDates.U.has('11/11')).toBe(true);
  });
  it('proseTokens (d): a parts date written as a repair ETC -> parts-date-as-etc; parts-labelled kept', () => {
    const c = strict();
    expect(v(G.gateEntry('Dealer ETC 10/26 for the unit', undefined, ['U'], c))).toBe('parts-date-as-etc');
    expect(v(G.gateEntry('Parts ETC 10/26 per Uptime', undefined, ['U'], c))).toBe('kept');
    expect(v(G.gateEntry('ETR 11/11 per Uptime', undefined, ['U'], c))).toBe('kept');
    expect(v(G.gateEntry('Parts ETC 10/14 per Uptime', undefined, ['U'], c))).toBe('unknown-etc-date');
  });
  it('typedRefProblem: misclassified-ref, unknown-ref, soft untyped-ref', () => {
    const c = strict();
    expect(G.typedRefProblem('Part #3010287243', ['U'], c)).toEqual({ code: 'misclassified-ref' });
    expect(G.typedRefProblem('dealer code 5948X', ['U'], c)).toEqual({ code: 'unknown-ref' });
    expect(G.typedRefProblem('Part #85152780 under Order #3010287243', ['U'], c)).toEqual({ untyped: [] });
    const c2 = G.textContext({ text: TEXT + '\n11/09 - Dealer: part 77123456 used', today: TODAY, typed: typed() });
    expect(G.typedRefProblem('Part #77123456', ['U'], c2)).toEqual({ untyped: ['77123456'] });
    expect(G.typedRefProblem('case #20944704', ['U'], c)).toEqual({ untyped: [] });
  });
  it('gateEntry runs S6 only when strict and returns untyped', () => {
    const c = strict();
    expect(v(G.gateEntry('Part #3010287243 on order', undefined, ['U'], c))).toBe('misclassified-ref');
    expect(G.gateEntry('Part #85152780 on order', undefined, ['U'], c).untyped).toEqual([]);
  });
  it('gateProse = gateEntry codes minus E2/E4; ownDates license a relative phrase on that dated line', () => {
    const c = G.textContext({ text: '11/02 - KWNE: still waiting on pins, hoping for them by thurs', today: TODAY });
    expect(v(G.gateProse('Vendor hoping for the pins by thurs.', undefined, ['U'], c, { ownDates: ['11/2'] }))).toBe('kept');
    expect(v(G.gateProse('Parts arriving tomorrow.', undefined, ['U'], c, { ownDates: ['11/2'] }))).toBe('unknown-rel-date');
    expect(v(G.gateProse('11/10 called TA', undefined, ['U'], c))).toBe('unknown-date');
    expect(v(G.gateProse('x', 'bad', ['U'], c))).toBe('bad-envelope');
  });
  it('exports the new vocabulary; GATE codes include parts-date-as-etc / misclassified-ref through removalLine', () => {
    expect(G.TYPED_REF_RE).toBeInstanceOf(RegExp);
    expect(G.PARTS_LABEL_BEFORE_RE.test('Parts ')).toBe(true);
    expect(G.removalLine({ unit: 'U', field: 'details', code: 'parts-date-as-etc' })).toBe('U \u00b7 details \u00b7 parts-date-as-etc');
  });
});

describe('textEvidence', () => {
  it('one data segment, one line per input line, entryMd carried down from the nearest dated line', () => {
    const ev = EV.textEvidence('U', '11/02 - header\n  continued text\n11/05 - next', TODAY);
    expect(ev.segments.map((s) => s.kind)).toEqual(['data']);
    expect(ev.segments[0].lines.map((l) => l.entryMd)).toEqual(['11/2', '11/2', '11/5']);
    expect(ev.text()).toBe('11/02 - header\n  continued text\n11/05 - next');
    expect(ev.fasLines).toEqual([]);
  });
});
