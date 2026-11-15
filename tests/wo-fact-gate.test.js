// tests/wo-fact-gate.test.js — AC15 (relay-extract §14.3): the fact gate is the merged
// fleet-dbr-gate, reused through wo-fact-output (no fork), with the typed-ref and parts-vs-repair
// ETC stages; planted fabrications drop, copied facts pass; same verdict in both consumers.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { TODAY, row39582, sourceText } from './fixtures/extract/fact-39582.js';
const require = createRequire(import.meta.url);
const G = require('../src/dbr/fleet-dbr-gate');
const W = require('../src/repair-intel/wo-facts');
const O = require('../src/repair-intel/wo-fact-output');

const row = row39582();
const fsx = W.buildFactSet(row, { today: TODAY });
const sheet = O.factSheet(fsx, { purpose: 'dbr', row });
const mk = (promptText) => O.factContext(fsx, { promptText, sheetText: sheet.text, rowDates: sheet.rowDates, today: TODAY });
const ctx = mk(sourceText);
const verdict = (g) => (g.ok ? 'kept' : g.code);
const both = (text, c = ctx) => {
  const a = verdict(O.gateText(text, c));
  const b = verdict(G.gateEntry(text, undefined, ['U'], c, { field: 'details' }));
  return { a, b };
};

describe('AC15 planted fabrications are dropped', () => {
  const cases = [
    ['Dealer: harness Part #85152799 on backorder', 'unknown-ref'],
    ['Per ASIST case #20944799 dealer diagnosed the harness', 'unknown-ref'],
    ['Estimate approved at $4,800 for the harness', 'unknown-ref'],
    ['Part #3010287243 on backorder at the dealer', 'misclassified-ref'],
    ['Dealer gave ETC 10/26 for the unit', 'parts-date-as-etc'],
    // 11/09 is an evidence date (week of 11/09) but no parts / ETC date.
    ['Parts ETC 11/09 per the dealer', 'unknown-etc-date'],
    // 11/30 is in no evidence at all, so the E3'(a) date stage (which runs first) drops it.
    ['Parts ETC 11/30 per the dealer', 'unknown-date'],
  ];
  for (const [t, code] of cases) {
    it(t + ' -> ' + code, () => {
      const { a, b } = both(t);
      expect(a).toBe(code);
      expect(b).toBe(code);
    });
  }
});

describe('AC15 copied facts are kept', () => {
  it('kept cases', () => {
    for (const t of [
      'Dealer: harness Part #85152780 on backorder, revised ship 10/26',
      'Parts ETC 10/26 per Uptime', 'parts ETA 10/26 per Uptime', 'ETR 11/11 per Uptime',
      'RO 30319SP at the dealer', 'RO-30319SP at the dealer', 'needs a 3/4 ton jack',
      'harness Part #85152780 under Order #3010287243', 'ASIST case 20944704 open',
    ]) expect(both(t), t).toEqual({ a: 'kept', b: 'kept' });
  });
  it('ship 11/11 is kept with a soft unbound-date flag', () => {
    const g = O.gateText('harness ship 11/11 per the dealer', ctx);
    expect(g.ok).toBe(true);
    expect(g.unbound.length).toBeGreaterThan(0);
  });
  it('a labelled ref present only untyped in the source is kept with untyped-ref', () => {
    const fsU = W.buildFactSet({ equipmentId: 'U1' }, { today: TODAY });
    const c = O.factContext(fsU, { promptText: '11/09 - Dealer: waiting on part 85152780', sheetText: '', today: TODAY });
    expect(c.strict).toBe(true);
    const g = O.gateText('Part #85152780 still on order', c);
    expect(g.ok).toBe(true);
    expect(g.untyped).toEqual(['85152780']);
  });
  it('prompt-only refs: a secondary-WR part # in the prompt passes; one in no text drops', () => {
    const c = mk(sourceText + '\n11/08 - Secondary WR conversation: replaced part #A12345 on the hood latch');
    expect(verdict(O.gateText('Hood latch part #A12345 replaced', c))).toBe('kept');
    expect(verdict(O.gateText('Hood latch part #A12399 replaced', c))).toBe('unknown-ref');
  });
  it('an instruction-only amount / date never licenses a token', () => {
    expect(verdict(O.gateText('Approved $13,977.68 on 07/01', ctx))).not.toBe('kept');
  });
});

describe('gateTimeline (§14.3.3)', () => {
  it('keeps clean lines, drops planted ones, normalizes single-digit dates, ignores gap ranges in the ratio', () => {
    const t = [
      '9/26 - Dealer diagnosed failed harness per ASIST case #20944704.',
      '10/14 - Harness on backorder, revised ship 10/26.',
      '10/28-11/03 - Awaiting vendor update.',
      '11/04 - All required parts have arrived at the dealership.',
      '11/05 - Dealer quoted Part #85152799 instead.',
      '(earlier history trimmed)',
    ].join('\n');
    const g = O.gateTimeline(t, ctx, { today: TODAY });
    expect(g.kept[0]).toBe('09/26 - Dealer diagnosed failed harness per ASIST case #20944704.');
    expect(g.kept).toContain('10/28-11/03 - Awaiting vendor update.');
    expect(g.dropped.map((d) => d.code)).toEqual(['unknown-ref']);
    expect(g.gapLines).toBe(1);
    expect(g.contentLines).toBe(4);
    expect(g.ratio).toBe(0.25);
  });
  it('a prefix date in no evidence drops unknown-date; a malformed line drops bad-line', () => {
    const g = O.gateTimeline('05/02 - Dealer checked in.\nnot a timeline line', ctx, { today: TODAY });
    expect(g.dropped.map((d) => d.code)).toEqual(['unknown-date', 'bad-line']);
  });
});

describe('fact sheet (§14.2)', () => {
  it('counted repair ETC renders ETR M/D/YYYY; parts dates never as ETC; misses listed for the Details', () => {
    expect(sheet.text).toContain('repair ETR 11/11/2026');
    expect(sheet.text).toContain('ship 10/11 MISSED');
    expect(sheet.text).toContain('ship 10/26 MISSED');
    expect(sheet.text).not.toMatch(/ETC 10\/(11|26)/);
    expect(sheet.lines.every((l) => /^F\d+ /.test(l))).toBe(true);
    expect(sheet.text).toContain('[phone]');
    expect(sheet.text).not.toMatch(/555/);
  });
  it('timeline purpose has no $, no contact names, no [phone]', () => {
    const t = O.factSheet(fsx, { purpose: 'timeline', row }).text;
    expect(t).not.toContain('$');
    expect(t).not.toContain('[phone]');
    expect(t).not.toContain('Pat');
  });
  it('budget drops the events section first; CURRENT is never dropped', () => {
    const s = O.factSheet(fsx, { purpose: 'dbr', row, budget: 100 });
    expect(s.text).toContain('CURRENT');
    expect(s.text).not.toContain('TIMELINE OF EVENTS');
  });
});

describe('gate reuse: no fork (AC15 static)', () => {
  const names = ['ID_TOKEN_RE', 'REF_RE', 'TICKET_RE', 'URL_RE', 'AMOUNT_RE', 'REL_DATE_RE', 'GATE_ETC_ABBR_RE', 'GATE_ETC_PHRASE_RE', 'TYPED_REF_RE'];
  const fns = ['proseTokens', 'freeDateProblem', 'parseEnvelope', 'nameFlags', 'dateBindingFlags', 'mdDates'];
  for (const f of ['wo-fact-output.js', 'wo-facts.js', 'wo-extract.js', 'wo-extract-dates.js']) {
    it(f + ' defines no gate token rule', () => {
      const src = fs.readFileSync(path.join('src/repair-intel', f), 'utf8');
      for (const n of names) expect(src, n).not.toMatch(new RegExp('\\b(?:const|let|var)\\s+' + n + '\\b'));
      for (const n of fns) expect(src, n).not.toMatch(new RegExp('\\bfunction\\s+' + n + '\\b|\\b' + n + '\\s*=\\s*(?:function|\\()'));
    });
  }
  it('src/utils/fact-tokens.js does not exist; wo-fact-output requires the shared gate', () => {
    expect(fs.existsSync('src/utils/fact-tokens.js')).toBe(false);
    expect(fs.readFileSync('src/repair-intel/wo-fact-output.js', 'utf8')).toContain("require('../dbr/fleet-dbr-gate')");
  });
});
