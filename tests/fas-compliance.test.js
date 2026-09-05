// tests/fas-compliance.test.js
//
// Digital FAS DOT/FMCSA compliance knowledge source: versioned + searchable
// records, and a STRICT evidence-gated classifier that never invents a
// regulation and never declares a confirmed status without a matching record +
// qualifying condition.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { setDataDir } = require('../src/config/paths');

let store, compliance;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fas-comp-'));
  setDataDir(tmp);
  delete require.cache[require.resolve('../src/store')];
  delete require.cache[require.resolve('../src/orcha/fas/compliance')];
  store = require('../src/store');
  compliance = require('../src/orcha/fas/compliance');
});

describe('compliance knowledge source — versioned + searchable records', () => {
  it('seeds a baseline with the required auditable fields', () => {
    const recs = compliance.search({ topic: 'tires' });
    expect(recs.length).toBeGreaterThan(0);
    const r = recs[0];
    for (const f of ['id', 'jurisdiction', 'regId', 'equipment', 'requirement', 'effectiveDate', 'lastVerified', 'source', 'interpretation']) {
      expect(r).toHaveProperty(f);
    }
    expect(r.regId).toMatch(/393\.75/);
  });

  it('search finds requirements by keyword', () => {
    const brakes = compliance.search({ query: 'brake out of adjustment' });
    expect(brakes.some(r => /393/.test(r.regId))).toBe(true);
  });

  it('upsertRecord adds a correctable/extendable record (requires mandatory fields)', () => {
    const bad = compliance.upsertRecord({ id: 'x' });
    expect(bad.ok).toBe(false);
    const ok = compliance.upsertRecord({ id: 'site-policy-1', regId: 'POLICY:tire-swap', requirement: 'Swap steer tires at 5/32 per site policy', source: 'Site SOP', topic: 'tires' });
    expect(ok.ok).toBe(true);
    expect(compliance.getRecord('site-policy-1')).toBeTruthy();
  });
});

describe('compliance.classify — strict, evidence-gated, never invents', () => {
  it('classifies a recognized OOS condition as confirmed-oos with a cited basis', () => {
    const c = compliance.classify({ observation: 'flat tire on the steer axle', equipment: 'day-cab' });
    expect(c.class).toBe('confirmed-oos');
    expect(c.basis.length).toBeGreaterThan(0);
    expect(c.confidence).toBeGreaterThan(0.6);
  });

  it('classifies a fuel leak as confirmed-oos', () => {
    const c = compliance.classify({ observation: 'fuel leak under the cab' });
    expect(c.class).toBe('confirmed-oos');
  });

  it('returns insufficient-evidence for a vague/unmatched observation (no invented conclusion)', () => {
    const c = compliance.classify({ observation: 'the truck looks kind of rough' });
    expect(['insufficient-evidence', 'potential-concern']).toContain(c.class);
    expect(c.class).not.toBe('confirmed-violation');
    expect(c.class).not.toBe('confirmed-oos');
  });

  it('returns insufficient-evidence with no observation', () => {
    const c = compliance.classify({});
    expect(c.class).toBe('insufficient-evidence');
    expect(c.confidence).toBe(0);
  });

  it('a matched requirement without a confirmed qualifying condition is potential-concern (inspection required), not a confirmed status', () => {
    const c = compliance.classify({ observation: 'question about windshield crack location' });
    expect(c.needsInspection === true || c.class === 'potential-concern').toBe(true);
    expect(c.class).not.toBe('confirmed-oos');
  });

  it('only uses the declared conclusion classes', () => {
    const c = compliance.classify({ observation: 'flat tire' });
    expect(compliance.CONCLUSION_CLASSES).toContain(c.class);
  });
});
