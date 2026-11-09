// tests/longdwell-summary-format.test.js — the deterministic Long Dwell summary
// normalizer (renderer/src/js/longdwell-summary-format.js). Aki returns the
// 7-bullet summary as one prose paragraph; the normalizer re-shapes it without
// inventing anything, and leaves already-correct output byte-identical.
import { describe, it, expect } from 'vitest';
import {
  normalizeLongDwellSummary as normalize, isLongDwellSummaryFormatted, LD_SUMMARY_LABELS,
  LD_PLACEHOLDER_NA, LD_PLACEHOLDER_UNKNOWN,
} from '../renderer/src/js/longdwell-summary-format.js';
import { _stripCosts } from '../renderer/src/js/longdwell-ai.js';
import {
  LD_SUMMARY, LD_AKI_B13014_PROSE, LD_GOLD_B13014, LD_GOLD_EXAMPLE_1, LD_GOLD_EXAMPLE_2,
} from './helpers/aki-style-replies.js';

const digitRuns = (s) => new Set(s.match(/\d+/g) || []);
const fullDates = (s) => new Set(s.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || []);
const values = (out) => out.split('\n').map((l, i) => l.slice(('\u2022 ' + LD_SUMMARY_LABELS[i] + ': ').length));

function assertShape(out) {
  expect(out).not.toMatch(/\r/);
  expect(out).not.toMatch(/\s{2,}/);
  const lines = out.split('\n');
  expect(lines).toHaveLength(7);
  lines.forEach((l, i) => expect(l.startsWith('\u2022 ' + LD_SUMMARY_LABELS[i] + ': ')).toBe(true));
  lines.forEach((l, i) => expect(l.charAt(('\u2022 ' + LD_SUMMARY_LABELS[i] + ': ').length)).toMatch(/\S/));
  expect(isLongDwellSummaryFormatted(out)).toBe(true);
  expect(normalize(out)).toBe(out); // idempotent
}

// Every digit run and full date in `out` already appears in `input`.
function assertNoNewNumbers(input, out) {
  const have = digitRuns(input);
  for (const d of digitRuns(out)) expect(have.has(d), 'digit run ' + d).toBe(true);
  const dates = fullDates(input);
  for (const d of fullDates(out)) expect(dates.has(d), 'date ' + d).toBe(true);
}
// Every word in `out` (minus labels/placeholders) appears in `input`.
function assertNoNewWords(input, out) {
  const words = (s) => s.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const have = new Set(words(input));
  const allowed = new Set(words(LD_SUMMARY_LABELS.join(' ') + ' ' + LD_PLACEHOLDER_NA + ' ' + LD_PLACEHOLDER_UNKNOWN));
  for (const w of words(out)) expect(have.has(w) || allowed.has(w), 'word ' + w).toBe(true);
}

const GOLDS = { LD_GOLD_B13014, LD_GOLD_EXAMPLE_1, LD_GOLD_EXAMPLE_2, LD_SUMMARY };
const GOLD_LINES = LD_GOLD_B13014.split('\n');

describe('already-correct summaries pass through byte-identical', () => {
  for (const [name, x] of Object.entries(GOLDS)) {
    it(name, () => {
      expect(isLongDwellSummaryFormatted(x)).toBe(true);
      expect(normalize(x)).toBe(x);
      expect(normalize(x, { maxLen: 4000 })).toBe(x);
      expect(normalize(x, { maxLen: 8000 })).toBe(x);
    });
  }
  it('Claude-style parity: _stripCosts(normalize(x)) === _stripCosts(x)', () => {
    for (const x of Object.values(GOLDS)) expect(_stripCosts(normalize(x, { maxLen: 4000 }))).toBe(_stripCosts(x));
  });
  it('empty input stays empty', () => {
    expect(normalize('')).toBe('');
    expect(normalize('   ')).toBe('');
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
  });
});

describe('labels present but not in the exact format are re-segmented', () => {
  const stripped = GOLD_LINES.map((l) => l.slice(2));
  const cases = {
    'no bullets': stripped.join('\n'),
    'dash bullets': stripped.map((l) => '- ' + l).join('\n'),
    'bold labels': stripped.map((l) => l.replace(/^([^:]+):/, '**$1:**')).join('\n'),
    'bold labels inside colon': stripped.map((l) => l.replace(/^([^:]+):/, '**$1**:')).join('\n'),
    'CRLF line endings': GOLD_LINES.join('\r\n'),
    'blank lines between bullets': GOLD_LINES.join('\n\n'),
    'numbered list': stripped.map((l, i) => (i + 1) + '. ' + l).join('\n'),
    'collapsed onto one line (what _stripCosts did to \\n\\n)': GOLD_LINES.join(' '),
  };
  for (const [name, input] of Object.entries(cases)) {
    it(name, () => {
      const out = normalize(input, { maxLen: 4000 });
      expect(out).toBe(LD_GOLD_B13014);
      assertShape(out);
    });
  }
  it('wrong label order is put back in canonical order', () => {
    const shuffled = [GOLD_LINES[6], GOLD_LINES[0], GOLD_LINES[3], GOLD_LINES[1], GOLD_LINES[5], GOLD_LINES[2], GOLD_LINES[4]].join('\n');
    expect(normalize(shuffled)).toBe(LD_GOLD_B13014);
  });
});

describe('prose containing the label phrases', () => {
  const input = 'Initial issue reported: Coolant leak at radiator. Primary barrier: Radiator on back order from the dealer. Repair status: At dealer, teardown done. ETC: none given.';
  it('maps each labelled clause to its field and fills the rest with placeholders', () => {
    const out = normalize(input);
    assertShape(out);
    const v = values(out);
    expect(v[0]).toBe('Coolant leak at radiator.');
    expect(v[1]).toBe(LD_PLACEHOLDER_NA);
    expect(v[2]).toBe('Radiator on back order from the dealer.');
    expect(v[3]).toBe(LD_PLACEHOLDER_UNKNOWN);
    expect(v[4]).toBe('At dealer, teardown done.');
    expect(v[5]).toBe('none given.');
    expect(v[6]).toBe(LD_PLACEHOLDER_UNKNOWN);
    assertNoNewNumbers(input, out);
    assertNoNewWords(input, out);
  });
});

describe('pure paragraph: the real Aki B13014 reply', () => {
  const out = normalize(LD_AKI_B13014_PROSE, { maxLen: 4000 });
  const v = values(out);
  it('becomes exactly 7 bullets in the canonical order', () => { assertShape(out); });
  it('places each sentence in the expected field', () => {
    expect(v[0]).toBe('B13014 (box truck, DSP carrier AUVTE, domicile ROC5) has been down 60 days in Accident status with front-end damage (driver-side hood detached).');
    expect(v[1]).toBe('N/A');
    expect(v[2]).toContain('The carrier owns vendor selection for DSP-managed accident repairs.');
    expect(v[2]).toContain("The insurance claim is filed, but the adjuster is still waiting on the accident report to settle with the other party's insurer.");
    expect(v[2]).toContain('FAS cannot flip or repair this unit, and ARC/insurance owns the claim.');
    expect(v[3]).toBe('The unit was towed to ROC5 on 10/18.');
    expect(v[4]).toContain('The timeline shows long gaps with no updates.');
    expect(v[4]).toContain('Severity is SEV2 because the unit is past 14 days down and has no clear path.');
    expect(v[4]).toContain('Watch the upcoming DOT inspection due 12/05 and PM-B due 12/07.');
    expect(v[5]).toBe('No repair vendor is assigned and there is no estimate or ETC.');
    expect(out.split('\n')[6].startsWith('\u2022 Follow-up date: 11/11/2026 \u2014 Next step:')).toBe(true);
    expect(v[6]).toContain('If nothing arrives by then, ask the carrier which local repair vendor was assigned and request the drop-off date, estimate and ETC.');
    expect(v[6]).toContain('If there is still no answer, escalate to the Uptime Manager and document it in the FAS2UM SIM.');
  });
  it('drops nothing except the label-only follow-up date sentence', () => {
    const sentences = LD_AKI_B13014_PROSE.split(/(?<=[.!?])\s+(?=[A-Z(])/);
    expect(sentences.length).toBe(13);
    for (const s of sentences) {
      if (s === 'Follow-up date: Wed 11/11/2026.') continue;
      expect(out).toContain(s);
    }
  });
  it('invents no numbers, dates or words', () => {
    assertNoNewNumbers(LD_AKI_B13014_PROSE, out);
    assertNoNewWords(LD_AKI_B13014_PROSE, out);
  });
});

describe('missing labels get neutral placeholders, never invented content', () => {
  it('structured input with only 3 labels', () => {
    const input = '• Initial Issue Reported: Air leak rear axle (9/2).\n• Repair Status: At dealer, chamber replaced.\n• ETC: 9/30/2026.';
    const out = normalize(input);
    assertShape(out);
    const v = values(out);
    expect(v[0]).toBe('Air leak rear axle (9/2).');
    expect(v[1]).toBe(LD_PLACEHOLDER_NA);
    expect(v[2]).toBe(LD_PLACEHOLDER_UNKNOWN);
    expect(v[3]).toBe(LD_PLACEHOLDER_UNKNOWN);
    expect(v[4]).toBe('At dealer, chamber replaced.');
    expect(v[5]).toBe('9/30/2026.');
    expect(v[6]).toBe(LD_PLACEHOLDER_UNKNOWN);
    assertNoNewNumbers(input, out);
    assertNoNewWords(input, out);
  });
  it('a short prose reply with no follow-up date does not get one', () => {
    const input = 'Unit reported a coolant leak. Waiting on parts from the dealer.';
    const out = normalize(input);
    assertShape(out);
    expect(values(out)[6]).toBe(LD_PLACEHOLDER_UNKNOWN);
    assertNoNewNumbers(input, out);
    assertNoNewWords(input, out);
  });
  it('a follow-up date without a year is not given a year', () => {
    const input = 'Unit reported a coolant leak. Next step: follow up with the dealer on 11/11.';
    const out = normalize(input);
    assertShape(out);
    expect(values(out)[6]).toBe('Next step: follow up with the dealer on 11/11.');
    assertNoNewNumbers(input, out);
  });
  it('preamble before the first label is kept', () => {
    const input = 'Here is the status.\nPrimary Barrier: Parts.\nActions Taken: Opened SIM.\nRepair Status: Waiting.';
    const out = normalize(input);
    assertShape(out);
    expect(values(out)[0]).toBe('Here is the status.');
  });
});

describe('length cap', () => {
  const bigProse = Array.from({ length: 12 }, () => LD_AKI_B13014_PROSE).join(' ');
  // Unbulleted, so it is not already in the exact shape (an exact-shape input
  // passes through byte-identical even when long; the caller's slice applies).
  const bigStructured = GOLD_LINES.map((l, i) => (i === 3 ? l + ' ' + 'Reached out to dealer for status update again. '.repeat(200).trim() : l).slice(2)).join('\n');
  for (const [name, input] of Object.entries({ bigProse, bigStructured })) {
    for (const cap of [4000, 8000]) {
      it(name + ' fits in ' + cap, () => {
        expect(input.length).toBeGreaterThan(cap);
        const out = normalize(input, { maxLen: cap });
        expect(out.length).toBeLessThanOrEqual(cap);
        assertShape(out);
        expect(values(out).some((v) => v.endsWith('\u2026'))).toBe(true);
        assertNoNewNumbers(input, out);
        // The caller's slice is then a no-op.
        expect(_stripCosts(out).slice(0, cap)).toBe(out);
      });
    }
  }
  it('the cut is spread out: the Follow-up date survives', () => {
    expect(normalize(bigProse, { maxLen: 4000 }).split('\n')[6].startsWith('\u2022 Follow-up date: 11/11/2026 \u2014 ')).toBe(true);
  });
  it('an exact-shape input over the cap still passes through (caller slice applies, as before)', () => {
    const long = GOLD_LINES.map((l, i) => (i === 3 ? l + ' ' + 'x'.repeat(5000) : l)).join('\n');
    expect(normalize(long, { maxLen: 4000 })).toBe(long);
  });
  it('without maxLen nothing is shortened', () => {
    expect(normalize(bigProse)).not.toContain('\u2026');
  });
});
