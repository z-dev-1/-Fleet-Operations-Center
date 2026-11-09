// tests/longdwell-summary-callsite.test.js — call-site regression for the Long
// Dwell AI Fill summary normalizer. The real parse + summary lines of BOTH
// _aiFillRow functions (views/analytics.js, views/longdwell-csv.js) are sliced
// and run in a sandbox (same pattern as tests/ai-json-call-sites.test.js, but
// without the relay import) against faked Aki / Claude replies. No model is called.
import { describe, it, expect } from 'vitest';
import * as esm from '../renderer/src/js/util/ai-json.js';
import { _stripCosts } from '../renderer/src/js/longdwell-ai.js';
import { normalizeLongDwellSummary, LD_SUMMARY_LABELS } from '../renderer/src/js/longdwell-summary-format.js';
import {
  AKI_LONGDWELL_REPLY, AKI_LONGDWELL_REPLY_RAW_NL, AKI_LONGDWELL_PROSE_REPLY, LD_PROSE_EXPECTED,
  LD_SUMMARY, LD_EXPECTED, LD_GOLD_B13014,
} from './helpers/aki-style-replies.js';
import { CSV, readLines, sliceLines, includes, exactly, aiFillRowLines } from './helpers/ai-json-callsite-src.js';

function assertSevenBullets(s) {
  const lines = s.split('\n');
  expect(lines).toHaveLength(7);
  lines.forEach((l, i) => expect(l.startsWith('\u2022 ' + LD_SUMMARY_LABELS[i] + ': ')).toBe(true));
  expect(lines[1]).toBe('\u2022 Primary Vendor Rejection: N/A');
  expect(lines[6].startsWith('\u2022 Follow-up date: 11/11/2026')).toBe(true);
}

const VIEWS = [
  {
    name: 'analytics.js _aiFillRow',
    cap: 4000,
    build() {
      const slice = sliceLines(aiFillRowLines('analytics.js#_aiFillRow'), "const text = result.text || '';", includes('let summary'), 'analytics parse');
      const run = new Function('result', 'extractJsonObject', '_stripCosts', 'normalizeLongDwellSummary', slice + '\nreturn { delayReason, escalation: escalationLevel, summary };');
      return (text) => run({ ok: true, text }, esm.extractJsonObject, _stripCosts, normalizeLongDwellSummary);
    },
  },
  {
    name: 'longdwell-csv.js _aiFillRow',
    cap: 8000,
    build() {
      const sanitizeSrc = sliceLines(readLines(CSV), 'function _sanitizeAiJson(', exactly('}'), '_sanitizeAiJson');
      const _sanitizeAiJson = new Function(sanitizeSrc + '\nreturn _sanitizeAiJson;')();
      const slice = sliceLines(aiFillRowLines('longdwell-csv.js#_aiFillRow'), "const textOut = result.text || '';", includes('let notes'), 'csv parse');
      const run = new Function('result', 'extractJsonObject', '_stripCosts', '_sanitizeAiJson', 'normalizeLongDwellSummary', slice + '\nreturn { delayReason, escalation, summary: notes };');
      return (text) => run({ ok: true, text }, esm.extractJsonObject, _stripCosts, _sanitizeAiJson, normalizeLongDwellSummary);
    },
  },
];

for (const view of VIEWS) {
  describe(view.name + ' summary normalization', () => {
    const parse = view.build();
    it('the call site actually runs the normalizer', () => {
      const line = aiFillRowLines(view.name.startsWith('analytics') ? 'analytics.js#_aiFillRow' : 'longdwell-csv.js#_aiFillRow')
        .find((l) => /let (summary|notes)\s*=/.test(l));
      expect(line).toContain('_stripCosts(normalizeLongDwellSummary(');
      expect(line).toContain('{ maxLen: ' + view.cap + ' }');
    });
    it('Aki prose reply (B13014) becomes 7 bullets; delayReason / escalation unchanged', () => {
      const r = parse(AKI_LONGDWELL_PROSE_REPLY);
      assertSevenBullets(r.summary);
      expect(r.delayReason).toBe(LD_PROSE_EXPECTED.delayReason);
      expect(r.escalation).toBe(LD_PROSE_EXPECTED.escalationLevel);
    });
    it('already-correct replies are unchanged (Claude / Orcha parity)', () => {
      const want = _stripCosts(LD_SUMMARY).slice(0, view.cap);
      for (const reply of [AKI_LONGDWELL_REPLY, AKI_LONGDWELL_REPLY_RAW_NL, JSON.stringify(LD_EXPECTED)]) {
        const r = parse(reply);
        expect(r.summary).toBe(want);
        expect(r.delayReason).toBe(LD_EXPECTED.delayReason);
        expect(r.escalation).toBe(LD_EXPECTED.escalationLevel);
      }
    });
    it('clean bare JSON with the gold B13014 summary is byte-identical', () => {
      const r = parse(JSON.stringify({ delayReason: 'Payment', escalationLevel: 'SEV2', summary: LD_GOLD_B13014 }));
      expect(r.summary).toBe(LD_GOLD_B13014);
    });
    it('blank-line separated bullets are no longer collapsed into one line', () => {
      const r = parse(JSON.stringify({ delayReason: 'Payment', escalationLevel: 'SEV2', summary: LD_GOLD_B13014.split('\n').join('\n\n') }));
      expect(r.summary).toBe(LD_GOLD_B13014);
    });
    it('keeps the original error message for non-JSON replies', () => {
      expect(() => parse('no json here')).toThrow(new Error('AI response was not JSON'));
    });
  });
}
