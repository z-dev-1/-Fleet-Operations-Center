// tests/email-intel-cases.test.js — acceptance cases (design 11, 12.2). FEAT-003 covers D, E and F at
// ANALYSIS level (facts and determinations only; nothing is written). FEAT-004 adds the runIntelScan-level
// versions with the timeline writer, and the remaining cases arrive with their phases.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { mk, scenarios, ZILA } from './fixtures/email-intel/emails.js';
import { recordOf, docOf, analyzeDoc, scriptedRelay, aiFixture, refOf } from './fixtures/email-intel/records.js';
const require = createRequire(import.meta.url);
const lane = require('../src/email-intel/understand/lane');
const C = require('../src/email-intel/constants');

beforeEach(() => lane._resetForTests());
afterEach(() => lane._resetForTests());

async function analyzed(m, answer, over) {
  const rec = recordOf(m);
  const doc = docOf([rec]);
  const relay = scriptedRelay(typeof answer === 'function' ? answer : () => aiFixture(answer));
  await analyzeDoc(doc, relay, over);
  return { a: doc.messages[rec.messageKey].analysis, rec: doc.messages[rec.messageKey], relay };
}

describe('acceptance cases at analysis level (FEAT-003)', () => {
  it('case D: coworker question about my unit captures fact, reply not assigned to me', async () => {
    const { a } = await analyzed(scenarios.coworkerQuestion(), 'coworker-question');
    expect(a.status).toBe('ok');
    const u = a.result.units.find((x) => x.unit === '40123');
    expect(u.facts).toHaveLength(1);
    expect(u.facts[0]).toMatchObject({ kind: 'parts_eta', date: '2026-11-14', assertion: 'reported-secondhand' });
    const d = a.determinations;
    expect(d.actionOwnership.items[0]).toMatchObject({ type: 'question', owner: 'other-person', addressee: 'named-other' });
    expect(d.replyRequirement.value).toBe('none');
    expect(d.otherResponsible).toMatchObject({ value: true, who: 'other-person' });
    expect(d.informationRelevance.level).toBe('high');                  // the fact is still relevant to me
  });

  it('case E: multi-unit email updates only my units; other FAS units counted out of scope', async () => {
    const { a, relay } = await analyzed(scenarios.multiUnit(), 'multi-unit');
    expect(a.status).toBe('ok');
    expect(a.result.units.map((u) => u.unit).sort()).toEqual(['40123', '40456']);
    expect(a.result.units.every((u) => u.scope === 'in')).toBe(true);
    expect(a.validation.otherUnits).toBe(2);
    expect(a.validation.dropped.outOfScopeFacts).toBe(2);
    // the prompt told the model which candidates are mine; the whole fleet list was not sent
    const cand = JSON.parse(/CANDIDATE UNITS[^\n]*\n(\[.*\])/.exec(relay.calls[0].prompt)[1]);
    expect(Object.fromEntries(cand.map((c) => [c.id, c.scope]))).toEqual({ 40123: 'in', 40456: 'in', 51888: 'out', 62100: 'out' });
    expect(relay.calls[0].prompt).not.toContain('40789');
    expect(a.deterministic.units.filter((u) => u.scope === 'out').map((u) => u.unit).sort()).toEqual(['51888', '62100']);
  });

  it('case F: unit after char 1500 extracted (window selection and unsent-window fallback)', async () => {
    // (1) the unit sits after character 1,500: it is found deterministically and the window that holds it is sent
    const { a, rec, relay } = await analyzed(scenarios.longBody1500(), 'long-body');
    const at = rec.body.newContent.indexOf('40789');
    expect(at).toBeGreaterThan(1500);
    expect(relay.calls[0].prompt).toContain('unit 40789 will be ready 11/15');
    expect(a.result.units[0]).toMatchObject({ unit: '40789', scope: 'in' });
    expect(a.result.units[0].facts[0]).toMatchObject({ kind: 'estimated_completion', date: '2026-11-15' });
    expect(a.unprocessedUnits).toEqual([]);
    expect(a.coverage).toMatchObject({ charsTotal: rec.body.newContent.length, charsSent: rec.body.newContent.length });

    // (2) more windows than MAX_WINDOWS (window size shrunk for the test; production windows are 6,000 chars):
    // at most MAX_WINDOWS calls, and a unit only in unsent windows gets the marker, never a fact
    const para = (s) => s + '\n\n';
    let body = '';
    for (let i = 0; i < 9; i++) body += para('Section ' + i + ' ' + 'routine fleet text '.repeat(40));
    body = body.replace('Section 3 ', 'Section 3 unit 40123 parts ETA 11/12 repair estimate ')
      .replace('Section 5 ', 'Section 5 unit 40456 ready for pickup parts ')
      .replace('Section 7 ', 'Section 7 unit 40999 approval estimate vendor ')
      .replace('Section 8 ', 'Section 8 note 40789 ');
    const sent = [];
    const out = await analyzed(mk({ to: [ZILA], subject: 'Big report', body }), (prompt) => {
      sent.push(prompt);
      const units = JSON.parse(/CANDIDATE UNITS[^\n]*\n(\[.*\])/.exec(prompt)[1]);
      return { schemaVersion: 2, messageRef: refOf(prompt), relevance: { level: 'medium', reason: 'report', confidence: 0.8 }, units: units.filter((u) => u.scope === 'in').map((u) => ({ unit: u.id, facts: [] })), questions: [], requests: [], answers: [], commitments: [], classification: { category: 'data_report', intent: 'provide_data', confidence: 0.8 }, overallConfidence: 0.8 };
    }, { windowOpts: { windowChars: 1000, overlap: 100 } });
    expect(out.relay.calls.length).toBeLessThanOrEqual(C.MAX_WINDOWS);
    expect(out.a.coverage.windowsTotal).toBeGreaterThan(C.MAX_WINDOWS);
    expect(out.a.coverage.windowsSent).toBe(C.MAX_WINDOWS);
    expect(out.a.coverage.charsSent).toBeLessThan(out.a.coverage.charsTotal);
    expect(out.a.unprocessedUnits.length).toBeGreaterThanOrEqual(1);
    for (const u of out.a.unprocessedUnits) {
      expect(u.reason).toBe('unprocessed-window');
      for (const p of sent) expect(p.split('<<<UNTRUSTED_EMAIL')[1]).not.toContain(u.unit);
      expect(out.a.result.units.some((x) => x.unit === u.unit && x.facts.length)).toBe(false);
    }
    // every in-scope unit is either in an analyzed window or carries the marker: none is lost
    const markers = new Set(out.a.unprocessedUnits.map((u) => u.unit));
    for (const id of ['40123', '40456', '40999', '40789']) {
      const inSent = sent.some((p) => p.split('<<<UNTRUSTED_EMAIL')[1].includes(id));
      expect(inSent || markers.has(id), id).toBe(true);
    }

    // (3) a unit that appears only past the stored body cap is reported as unprocessed, not lost
    const long = 'Routine weekly status text. '.repeat(Math.ceil((C.STORED_BODY_CAP + 400) / 28)) + ' unit 40999 will be ready 11/20';
    const capped = await analyzed(mk({ to: [ZILA], subject: 'Weekly status 40123', body: long }), () => aiFixture('multi20to'));
    expect(capped.rec.body.newContent.length).toBe(C.STORED_BODY_CAP);
    expect(capped.rec.body.unitsBeyondCap).toEqual(['40999']);
    expect(capped.a.unprocessedUnits).toContainEqual({ unit: '40999', scope: 'in', reason: 'unprocessed-window' });
    expect(capped.a.coverage.storedTruncated).toBe(true);
    expect(capped.a.coverage.charsTotal).toBeGreaterThan(capped.a.coverage.charsSent);
  });
});
