// tests/email-intel-calibration.test.js — confidence calibration on the labeled synthetic set
// (design 3.7; R7.2, F-15). Hard safety checks run on EVERY recording; the 70% accuracy floor is
// asserted only on live-lane recordings with the current prompt version and is reported as skipped
// ("calibration against the live model not performed") when there are none.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tests/fixtures/email-intel/calibration');
const cal = require('../src/email-intel/understand/calibration');
const C = require('../src/email-intel/constants');

const json = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
const set = cal.loadSet(json);
const byId = Object.fromEntries(set.cases.map((c) => [c.id, c]));
const recordings = fs.readdirSync(path.join(DIR, 'recorded')).filter((f) => f.endsWith('.json')).map((f) => Object.assign({ file: f }, JSON.parse(fs.readFileSync(path.join(DIR, 'recorded', f), 'utf8'))));
const live = recordings.filter((r) => r.recordedBy === 'live-lane' && r.promptVersion === C.PROMPT_VERSION);

describe('calibration set', () => {
  it('has at least 40 labeled synthetic cases with PII-free addresses', () => {
    expect(set.cases.length).toBeGreaterThanOrEqual(40);
    const text = JSON.stringify(json);
    for (const m of text.matchAll(/[\w.+-]+@([\w.-]+)/g)) expect(m[1].endsWith('example.test'), m[0]).toBe(true);
    for (const c of set.cases) {
      expect(c).toMatchObject({ id: expect.any(String), pattern: expect.any(String), subject: expect.any(String), body: expect.any(String), labels: { facts: expect.any(Array), owner: expect.any(String), reply: expect.any(String) } });
    }
    expect(new Set(set.cases.map((c) => c.id)).size).toBe(set.cases.length);
  });

  it('F-15 every recording declares recordedBy/model/promptVersion', () => {
    expect(recordings.length).toBeGreaterThan(0);
    for (const r of recordings) {
      expect(['live-lane', 'hand-authored'], r.file).toContain(r.recordedBy);
      expect(r).toHaveProperty('model');
      expect(r.model === null || typeof r.model === 'string').toBe(true);
      expect(typeof r.promptVersion).toBe('string');
      expect(Number.isFinite(Date.parse(r.recordedAt))).toBe(true);
      expect(byId[r.caseId], r.file).toBeTruthy();
      expect(typeof r.rawText).toBe('string');
      if (r.recordedBy === 'hand-authored') expect(r.file.startsWith('live-')).toBe(false);
    }
  });

  it('R7.2 zero wrong auto-applies on labeled set (all files), and every invalid or missing confidence stages', () => {
    let applied = 0; let staged = 0;
    for (const r of recordings) {
      const res = cal.evaluateRecording(byId[r.caseId], r, set);
      expect(res.wrong, r.file).toEqual([]);
      expect(res.invalidAutoApplied, r.file).toEqual([]);
      applied += res.autoApplied.length; staged += res.staged;
    }
    // the hand-authored set exercises both outcomes (it is not vacuous)
    expect(applied).toBeGreaterThan(0);
    expect(staged).toBeGreaterThan(0);
  });

  it('hand-authored traps behave as labeled: invalid / missing / out-of-range confidence, plans, guesses and wrong units never auto-apply', () => {
    const ev = (id) => cal.evaluateRecording(byId[id], recordings.find((r) => r.caseId === id && r.recordedBy === 'hand-authored'), set);
    expect(ev('eta-20to').autoApplied).toEqual([]);              // confidence "0.95" (a string)
    expect(ev('vendor-received').autoApplied).toEqual([]);       // overallConfidence null
    expect(ev('completion-eta').autoApplied).toEqual([]);        // confidence 95 (out of range)
    expect(ev('planned-repair').autoApplied).toEqual([]);        // assertion planned (cap 0.6)
    expect(ev('speculative').autoApplied).toEqual([]);
    expect(ev('coworker-q').autoApplied).toEqual([]);            // reported second-hand
    expect(ev('blocker-approval').autoApplied).toEqual([]);      // wrong unit and unverifiable evidence are dropped
    expect(ev('out-of-scope').autoApplied).toEqual([]);          // other FAS units keep no facts
    expect(ev('multi-unit').autoApplied.map((x) => x.unit).sort()).toEqual(['40123', '40456']);
    expect(ev('eta-sole').autoApplied).toHaveLength(1);
  });

  const floorName = 'F-15 70% floor asserted only on live-lane recordings, else reported skipped'
    + (live.length ? '' : ' (calibration against the live model not performed)');
  it.skipIf(live.length === 0)(floorName, () => {
    let clean = 0; let reached = 0;
    const buckets = cal.BUCKETS.map((b) => ({ range: b, n: 0, correct: 0 }));
    for (const r of live) {
      const res = cal.evaluateRecording(byId[r.caseId], r, set);
      clean += res.clean; reached += res.cleanReached;
      res.buckets.forEach((b, i) => { buckets[i].n += b.n; buckets[i].correct += b.correct; });
    }
    // reliability table: confidence bucket vs accuracy (counts only)
    console.log('[calibration] live-lane reliability: ' + buckets.map((b) => b.range[0] + '-' + Math.min(1, b.range[1]).toFixed(2) + ': ' + b.correct + '/' + b.n).join(' | '));
    expect(clean).toBeGreaterThan(0);
    expect(reached / clean).toBeGreaterThanOrEqual(0.7);
  });
});
