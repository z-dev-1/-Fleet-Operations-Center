import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { LEGAL, canTransition, isTerminal } = require('../src/autopilot/lifecycle');
const { STATES } = require('../src/autopilot/constants');

const ALL = Object.values(STATES);

describe('autopilot lifecycle', () => {
  it('allows every pair in the legal table', () => {
    let n = 0;
    for (const from of Object.keys(LEGAL)) {
      for (const to of LEGAL[from]) {
        expect(canTransition(from === '(new)' ? null : from, to)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('matches the design table exactly for every from/to pair', () => {
    for (const from of ALL) {
      for (const to of ALL) expect(canTransition(from, to)).toBe(LEGAL[from].has(to));
    }
  });

  it('rejects a sample of illegal pairs', () => {
    const bad = [
      ['QUEUED', 'MONITORING'], ['DETECTED', 'INVESTIGATING'], ['ANALYZING', 'RESOLVED'], ['FAILED', 'MONITORING'],
      ['PAUSED', 'INVESTIGATING'], ['NEEDS_REVIEW', 'RECOMMENDATION_READY'], ['MONITORING', 'ANALYZING'],
      ['QUEUED', 'QUEUED'], ['WAITING_FOR_DATA', 'MONITORING'], [null, 'QUEUED'], ['BOGUS', 'QUEUED'],
    ];
    for (const [f, t] of bad) expect(canTransition(f, t)).toBe(false);
  });

  it('new cases start only at DETECTED', () => {
    expect(canTransition(null, 'DETECTED')).toBe(true);
    for (const s of ALL.filter((x) => x !== 'DETECTED')) expect(canTransition(undefined, s)).toBe(false);
  });

  it('RESOLVED is terminal', () => {
    expect(isTerminal('RESOLVED')).toBe(true);
    for (const s of ALL) expect(canTransition('RESOLVED', s)).toBe(false);
  });
});
