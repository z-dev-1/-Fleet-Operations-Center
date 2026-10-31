import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { extractBackorderedParts } = require('../src/repair-intel/parts-extract');

describe('repair-intel parts-extract', () => {
  it('pulls a known part from a back-order comment', () => {
    const out = extractBackorderedParts([
      { text: 'Diagnosed the issue. Waiting on the alternator, it is back-ordered 2 weeks.', timestamp: '2026-01-02' },
    ]);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.map(p => p.part)).toContain('alternator');
    expect(out[0].phrase).toMatch(/alternator/i);
  });

  it('handles multiple parts across comments and dedupes', () => {
    const out = extractBackorderedParts([
      { text: 'EGR valve on order from dealer.' },
      { text: 'Also sourcing a new water pump.' },
      { text: 'Still waiting on the EGR valve.' }, // dup -> once
    ]);
    const parts = out.map(p => p.part);
    expect(parts).toContain('egr valve');
    expect(parts).toContain('water pump');
    // egr valve only once despite two mentions
    expect(parts.filter(p => p === 'egr valve').length).toBe(1);
  });

  it('returns nothing when there is no back-order signal (no fabrication)', () => {
    expect(extractBackorderedParts([{ text: 'Replaced the brake pads, unit returned to service.' }])).toEqual([]);
    expect(extractBackorderedParts([{ text: 'Vehicle is running fine now.' }])).toEqual([]);
    expect(extractBackorderedParts([])).toEqual([]);
    expect(extractBackorderedParts('')).toEqual([]);
  });

  it('captures a novel part via the grammar fallback', () => {
    const out = extractBackorderedParts([{ text: 'Back-ordered the flux capacitor assembly.' }]);
    // not in the vocabulary, but the "back-ordered the <phrase>" grammar catches it
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].part).toMatch(/flux capacitor/);
  });

  it('accepts a raw string too', () => {
    const out = extractBackorderedParts('turbo is on back order');
    expect(out.map(p => p.part)).toContain('turbo');
  });
});
