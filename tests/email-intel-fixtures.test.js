// tests/email-intel-fixtures.test.js — guards the shared fixtures in tests/fixtures/email-intel/
// so later FEATs can rely on them (F-02 canonical shapes, scope sets, builders, DOM stub).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { IN_SCOPE_IDS, OUT_OF_SCOPE_IDS, fleetData, ME } from './fixtures/email-intel/fleet.js';
import { LMU, canonicalState, canonicalWith } from './fixtures/email-intel/canonical.js';
import { mk, resetSeq, scenarios, person } from './fixtures/email-intel/emails.js';
import { createFakeDom } from './fixtures/email-intel/fake-dom.js';
const require = createRequire(import.meta.url);

describe('fleet fixture', () => {
  it('has 4 in-scope units, 3 disjoint out-of-scope ids, and stale and empty variants', () => {
    expect(IN_SCOPE_IDS).toEqual(['40123', '40456', '40789', '40999']);
    expect(OUT_OF_SCOPE_IDS).toEqual(['51888', '62100', '73001']);
    expect(IN_SCOPE_IDS.filter((i) => OUT_OF_SCOPE_IDS.includes(i))).toEqual([]);
    const now = Date.parse('2026-11-04T15:00:00.000Z');
    expect(fleetData('fresh', now).rows).toHaveLength(4);
    expect(now - Date.parse(fleetData('stale', now).syncedAt)).toBeGreaterThan(36 * 3_600_000);
    expect(fleetData('empty', now).rows).toEqual([]);
    expect(ME.addresses[0]).toMatch(/@example\.test$/);
  });
});

describe('F-02 fixture shape matches getCanonical output', () => {
  it('lastMeaningfulUpdate fixtures use exactly the {source,text,at} keys and sources the real builder produces', () => {
    const real = require('../src/orcha/canonical_state');
    const sample = real._lastMeaningfulUpdate({ asistNotes: 'Nov 4, 2026 02:00 PM - Dealer: truck is repaired and ready for pickup tomorrow', asistScrapedAt: '2026-11-04T19:00:00.000Z' });
    expect(Object.keys(sample).sort()).toEqual(['at', 'source', 'text']);
    expect(['relay', 'offsite', 'timeline']).toContain(sample.source);
    const tl = real._lastMeaningfulUpdate({ repairTimeline: '11/03 - parts ordered with the dealer today' });
    expect(tl).toMatchObject({ source: 'timeline', at: '' });
    for (const v of Object.values(LMU)) {
      expect(Object.keys(v).sort()).toEqual(['at', 'source', 'text']);
      expect(['relay', 'offsite', 'timeline']).toContain(v.source);
    }
    expect(LMU.timelineOnly.at).toBe('');
  });

  it('canonicalState covers ready, awaiting-parts, timeline-only and no-record units', () => {
    const c = canonicalState().units;
    expect(c['40456'].repairPhase).toBe('ready_for_pickup');
    expect(c['40123'].repairPhase).toBe('awaiting_parts');
    expect(c['40789'].lastMeaningfulUpdate.source).toBe('timeline');
    expect(c['40999']).toBeUndefined();
    expect(canonicalWith('40123', 'freeText').units['40123'].lastMeaningfulUpdate.at).toBe('yesterday');
  });
});

describe('email builders', () => {
  it('mk produces unique message ids and a stable conversation id per subject', () => {
    resetSeq();
    const a = mk({ subject: 'Unit 40123 update' }); const b = mk({ subject: 'Unit 40123 update' });
    expect(a.messageId).not.toBe(b.messageId);
    expect(a.conversationId).toBe(b.conversationId);
    expect(person(3).address).toBe('person03@example.test');
  });

  it('scenario builders match the design fixtures (20 To, CC, long body, multi-unit)', () => {
    expect(scenarios.multi20to().to).toHaveLength(20);
    expect(scenarios.ccDealerEta().cc.map((p) => p.address)).toEqual(['zila.santiago@example.test']);
    const long = scenarios.longBody1500().bodyText;
    expect(long.indexOf('40789')).toBeGreaterThan(1500);
    const multi = scenarios.multiUnit().bodyText;
    for (const id of [...IN_SCOPE_IDS.slice(0, 2), ...OUT_OF_SCOPE_IDS.slice(0, 2)].filter((i) => i !== '73001')) expect(multi).toContain(id);
    for (const s of Object.values(scenarios)) expect(JSON.stringify(s())).not.toMatch(/@(?!example\.test|dealer\.example\.test)[a-z]/i);
  });
});

describe('fake dom', () => {
  it('registers elements and dispatches events', () => {
    const { document, add } = createFakeDom();
    const btn = add('go', 'button');
    let n = 0;
    btn.addEventListener('click', () => { n++; });
    document.getElementById('go').click();
    expect(n).toBe(1);
    expect(document.getElementById('nope')).toBeNull();
    btn.classList.add('x');
    expect(btn.classList.contains('x')).toBe(true);
  });
});
