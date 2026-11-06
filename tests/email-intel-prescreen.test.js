// tests/email-intel-prescreen.test.js — cheap AI gate (design 3.3; PG-1, R2.1, R2.7, F2-08).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { ME } from './fixtures/email-intel/fleet.js';
import { mk, person, ZILA, COWORKER, DEALER, scenarios } from './fixtures/email-intel/emails.js';
import { recordOf, scopeIndex } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const { prescreen } = require('../src/email-intel/understand/prescreen');
const scope = require('../src/email-intel/understand/scope');

const cfg = { me: ME };
const run = (m, conv, over, idxVariant) => {
  const rec = recordOf(m, { over });
  const idx = scopeIndex(idxVariant || 'fresh');
  return prescreen(rec, scope.scanMessage(rec, idx), conv || {}, cfg);
};

describe('prescreen triggers', () => {
  it('in-scope and scope-unknown units trigger AI; priority +4 for in-scope', () => {
    const a = run(scenarios.multi20to());
    expect(a.aiNeeded).toBe(true);
    expect(a.triggers).toContain('in-scope-unit');
    expect(a.priority).toBeGreaterThanOrEqual(4);
    const b = run(scenarios.multi20to(), {}, null, 'stale');
    expect(b.triggers).toContain('scope-unknown-unit');
    expect(b.aiNeeded).toBe(true);
  });

  it('my name, an open item on my unit, keyword+unit and the 1:1 rule each trigger', () => {
    expect(run(mk({ to: [COWORKER], subject: 'Lunch', body: 'Zila is joining the meeting' })).triggers).toContain('mentions-me');
    expect(run(mk({ to: [COWORKER], subject: 'Re: hi', body: 'see you' }), { openOnMyUnits: true }).triggers).toContain('open-item-on-my-unit');
    expect(run(mk({ to: [COWORKER], subject: 'parts', body: 'Parts for 51888 shipped' })).triggers).toContain('keyword-and-unit');
    const one = run(mk({ from: DEALER, to: [ZILA], subject: 'Question', body: 'Could you call me back about the schedule this week?' }));
    expect(one.triggers).toEqual(['direct-1to1']);
    expect(one.priority).toBe(2 + 1);
  });

  it('R2.7 skipped-cheap still stored: no trigger gives deterministic informational / noise, nothing deleted', () => {
    const r = run(mk({ to: [COWORKER, person(2)], subject: 'Team lunch', body: 'Pizza on Friday.' }));
    expect(r).toMatchObject({ aiNeeded: false, reason: 'no-trigger', deterministic: { relevance: 'none', category: 'informational' } });
    const n = run(mk({ from: { name: 'Alerts', address: 'no-reply@vendor.example.test' }, to: [ZILA, person(1)], subject: 'Digest', body: 'Weekly digest.' }));
    expect(n.deterministic.category).toBe('noise');
    expect(Object.keys(n)).not.toContain('delete');
  });
});

describe('F2-08 recipient data and prescreen', () => {
  const bodies = [
    { subject: 'Parts update 40123', body: 'Parts arrived for unit 40123, repair starts Monday.' },
    { subject: 'Turbo', body: 'Turbo ETA 11/12 for 51888.' },
    { subject: 'Hello', body: 'Could you take a look at the schedule for next week please?' },
    { subject: 'Lunch', body: 'Pizza on Friday.' },
    { subject: 'Note', body: 'Zila, FYI the yard is closed.' },
  ];
  const variants = [
    { to: [ZILA], cc: [] },
    { to: Array.from({ length: 20 }, (_, i) => (i === 7 ? ZILA : person(i + 1))), cc: [] },
    { to: [COWORKER], cc: [ZILA] },
    { to: [{ name: 'Fleet Ops DL', address: 'fleet-ops@example.test' }], cc: [] },
    { to: [COWORKER, person(4)], cc: [person(5)] },
    { to: [], cc: [] },
  ];
  it('F2-08 recipient data never makes a message ineligible and never lowers relevance, it may only raise priority or add an AI trigger', () => {
    for (const b of bodies) {
      // The baseline evaluation has NO recipient data at all.
      const base = run(mk({ to: [], cc: [], subject: b.subject, body: b.body }), {}, { recipientsKnown: false, to: [], cc: [], toCount: 0, ccCount: 0 });
      for (const v of variants) {
        const r = run(mk({ to: v.to, cc: v.cc, subject: b.subject, body: b.body }));
        if (base.aiNeeded) expect(r.aiNeeded, b.subject).toBe(true);                  // never ineligible because of recipients
        expect(r.priority).toBeGreaterThanOrEqual(base.priority);                       // only raises priority
        for (const t of base.triggers) expect(r.triggers).toContain(t);                 // only adds triggers
        expect(r.triggers.filter((t) => !base.triggers.includes(t)).every((t) => t === 'direct-1to1')).toBe(true);
        if (!r.aiNeeded) expect(r.deterministic).toEqual(base.deterministic);           // relevance never lowered
      }
    }
  });

  it('PG-1 the same dealer update is AI-eligible for sole To, 20 To, CC and DL recipients', () => {
    for (const v of variants) expect(run(mk({ to: v.to, cc: v.cc, subject: 'Parts 40123', body: 'Parts arrived for unit 40123.' })).aiNeeded).toBe(true);
  });
});
