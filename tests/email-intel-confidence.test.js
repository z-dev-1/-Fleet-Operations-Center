// tests/email-intel-confidence.test.js — effective confidence, caps and the pinned threshold
// (design 3.7; R1.5, R7.3, R7.4, AC-0).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { ME } from './fixtures/email-intel/fleet.js';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = require('../src/email-intel/understand/confidence');
const { validateAnalysis } = require('../src/email-intel/understand/validate');
const C = require('../src/email-intel/constants');

const goodCtx = { overallConfidence: 0.95, overallValid: true, bodyStatus: 'complete', receivedAtQuality: 'exact', senderNameEmpty: false, automated: false, forwardedUndated: false, injectionSuspected: false };
const goodFact = { confidence: 0.9, confidenceValid: true, assertion: 'stated', unitAttribution: 'strong', dateInvalid: false, amountUnverified: false };
const eff = (f, c) => conf.effectiveConfidence(Object.assign({}, goodFact, f), Object.assign({}, goodCtx, c)).value;

describe('threshold', () => {
  it('R7.4 threshold pinned at 0.75 with >=, config can only raise', () => {
    expect(C.AUTO_APPLY_MIN_CONFIDENCE).toBe(0.75);
    expect(conf.threshold()).toBe(0.75);
    expect(conf.meetsThreshold(0.75)).toBe(true);
    expect(conf.meetsThreshold(0.7499)).toBe(false);
    expect(conf.threshold({ minConfidence: 0.9 })).toBe(0.9);
    expect(conf.meetsThreshold(0.8, { minConfidence: 0.9 })).toBe(false);
    for (const low of [0.5, 0, -1, NaN, '0.1', null]) expect(conf.threshold({ minConfidence: low })).toBe(0.75);
    expect(conf.meetsThreshold(NaN)).toBe(false);
    expect(conf.meetsThreshold('0.9')).toBe(false);
    // the comparison in source is >= against the constant (no literal 0.7 / 0.4 fallback in the new path)
    const src = fs.readFileSync(path.join(ROOT, 'src/email-intel/understand/confidence.js'), 'utf8');
    expect(src).toMatch(/value >= threshold\(cfg\)/);
    for (const f of ['confidence.js', 'validate.js', 'analyze.js', 'ownership.js']) {
      const p = path.join(ROOT, 'src/email-intel/understand', f);
      if (!fs.existsSync(p)) continue;
      const code = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(code, f).not.toMatch(/[^.\d]0\.[74](?!\d)/);
    }
  });
});

describe('AC-0 / R7.3', () => {
  it('AC-0 invalid confidence matrix', () => {
    const raw = (c) => ({
      schemaVersion: 2, messageRef: 'r', units: [{ unit: '40123', facts: [{ kind: 'parts_eta', value: 'ETA 11/12', state: 'eta_given', assertion: 'stated', evidence: 'Turbo ETA 11/12 for 40123', confidence: c }] }],
      questions: [], answers: [], classification: { category: 'fleet_status_update', intent: 'provide_update', confidence: 0.9 }, overallConfidence: 0.95,
    });
    const vctx = { expectedRef: 'r', candidateUnits: ['40123'], scopeOf: () => 'in', text: 'Turbo ETA 11/12 for 40123', receivedAt: '2026-11-04T14:30:00Z', now: Date.parse('2026-11-04T16:00:00Z'), me: ME };
    const run = (c) => {
      const v = validateAnalysis(raw(c), vctx);
      const f = v.analysis.units[0].facts[0];
      const e = conf.effectiveConfidence(f, Object.assign({}, goodCtx, { overallConfidence: v.analysis.overallConfidence, overallValid: v.analysis.overallValid }));
      return { e, applies: conf.meetsThreshold(e.value) };
    };
    for (const bad of [undefined, 'high', '0.9', null, NaN, -0.2, 1.5, 95]) {
      const r = run(bad);
      expect(r.e.value, String(bad)).toBe(0);
      expect(r.applies).toBe(false);
      expect(r.e.caps.map((x) => x.reason)).toContain('invalid-confidence');
    }
    expect(run(0.75).applies).toBe(true);
    expect(run(0.7499).applies).toBe(false);
    expect(run(1).e.value).toBe(0.95);                       // min(fact, overall)
  });

  it('R7.3 missing/invalid/out-of-range is 0 and stages; an invalid overall confidence zeroes every fact', () => {
    expect(eff({}, { overallValid: false, overallConfidence: null })).toBe(0);
    expect(eff({ confidence: 95, confidenceValid: false })).toBe(0);
    expect(eff({ confidenceValid: true, confidence: 1.2 })).toBe(0);           // defensive: never trusts an out-of-range value
  });
});

describe('caps (design 3.7 table)', () => {
  it.each([
    ['assertion not stated', { assertion: 'planned' }, {}, 0.6],
    ['R1.5 partial content cap 0.6', {}, { bodyStatus: 'truncated-ui' }, 0.6],
    ['weak unit attribution', { unitAttribution: 'weak' }, {}, 0.6],
    ['date invalid', { dateInvalid: true }, {}, 0.6],
    ['amount unverified', { amountUnverified: true }, {}, 0.6],
    ['received time unknown', {}, { receivedAtQuality: 'unknown' }, 0.6],
    ['sender display name empty', {}, { senderNameEmpty: true }, 0.74],
    ['automated sender', {}, { automated: true }, 0.74],
    ['forwarded and undated', {}, { forwardedUndated: true }, 0.74],
    ['injection suspected', {}, { injectionSuspected: true }, 0.74],
    ['validation dropped more than half', {}, { unitDroppedMoreThanHalf: true }, 0.74],
  ])('%s', (_n, f, c, cap) => {
    const v = eff(Object.assign({ confidence: 0.99 }, f), Object.assign({ overallConfidence: 0.99 }, c));
    expect(v).toBe(cap);
    expect(conf.meetsThreshold(v)).toBe(false);
  });
  it('caps never raise a value and stack to the lowest', () => {
    expect(eff({ confidence: 0.3, assertion: 'planned' })).toBe(0.3);
    expect(eff({ assertion: 'planned' }, { injectionSuspected: true })).toBe(0.6);
    expect(eff({})).toBe(0.9);
  });
  it('messageCtx reads the record: forwarded with a parsable Sent: line is not undated', () => {
    const rec = (body, fw) => ({ from: { name: 'Dealer' }, receivedAtQuality: 'exact', flags: { forwarded: fw }, body: { status: 'complete', newContent: body } });
    expect(conf.messageCtx(rec('FYI\nFrom: Dealer\nSent: Tuesday, November 4, 2026 9:12 AM\nUnit ready', true), {}).forwardedUndated).toBe(false);
    expect(conf.messageCtx(rec('FYI\nFrom: Dealer\nUnit ready', true), {}).forwardedUndated).toBe(true);
    expect(conf.messageCtx(rec('Unit ready', false), {}).forwardedUndated).toBe(false);
  });
});
