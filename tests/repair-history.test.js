import { describe, it, expect } from 'vitest';

// Isolated repair history logic
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function filterHistory(entries) {
  return entries.filter(e => (Date.now() - e.ts) < THREE_MONTHS_MS);
}

function createEvent(unit, summary, vendor, outcome) {
  return {
    date: new Date().toISOString().split('T')[0],
    summary: (summary || '').substring(0, 120),
    vendor: vendor || '',
    outcome: outcome || 'in-progress',
    ts: Date.now()
  };
}

function detectTransition(prev, current) {
  const wasUnavail = (prev.lifecycleState || '').toLowerCase().includes('unavail');
  const nowAvail = (current.lifecycleState || '').toLowerCase().includes('available') &&
                   !(current.lifecycleState || '').toLowerCase().includes('unavail');
  return wasUnavail && nowAvail;
}

describe('Repair History', () => {
  it('should create event with correct fields', () => {
    const event = createEvent('322472', 'Hub leak repair', 'Amerit', 'completed');
    expect(event.summary).toBe('Hub leak repair');
    expect(event.vendor).toBe('Amerit');
    expect(event.outcome).toBe('completed');
    expect(event.ts).toBeGreaterThan(0);
  });

  it('should truncate summary to 120 chars', () => {
    const long = 'A'.repeat(200);
    const event = createEvent('322472', long, '', '');
    expect(event.summary.length).toBe(120);
  });

  it('should filter out entries older than 3 months', () => {
    const entries = [
      { ts: Date.now() - (91 * 24 * 60 * 60 * 1000), summary: 'old' },
      { ts: Date.now() - (30 * 24 * 60 * 60 * 1000), summary: 'recent' },
      { ts: Date.now(), summary: 'today' }
    ];
    const filtered = filterHistory(entries);
    expect(filtered.length).toBe(2);
    expect(filtered[0].summary).toBe('recent');
  });

  it('should detect unavailable → available transition', () => {
    const prev = { equipmentId: 'B62148', lifecycleState: 'Unavailable' };
    const current = { equipmentId: 'B62148', lifecycleState: 'Available' };
    expect(detectTransition(prev, current)).toBe(true);
  });

  it('should NOT detect available → available', () => {
    const prev = { equipmentId: 'B62148', lifecycleState: 'Available' };
    const current = { equipmentId: 'B62148', lifecycleState: 'Available' };
    expect(detectTransition(prev, current)).toBe(false);
  });

  it('should NOT detect unavailable → unavailable', () => {
    const prev = { equipmentId: 'B62148', lifecycleState: 'Unavailable' };
    const current = { equipmentId: 'B62148', lifecycleState: 'Unavailable' };
    expect(detectTransition(prev, current)).toBe(false);
  });
});
