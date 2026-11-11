// Fleet DBR evidence module (design §4): per-unit block fields, conversation parsing, redaction
// (AC19), FAS tagging and fasDates (AC20, AC33), email ordering, water-filling / maximal
// trimming, UNIT_HARD_MAX and the planBatches worked cases (§4.4). Pure, synthetic data only.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const E = require('../src/dbr/fleet-dbr-evidence');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-12';
const FAS = ['Z Santiago'];
const unitOf = (id, extra = {}) => Object.assign({ id, daysDown: 9, barriers: [], etc: { state: 'none', date: null, source: null } }, extra);
const ev = (fields, enrich, opts = {}) => {
  const raw = makeUnit(Object.assign({ equipmentId: 'B61001' }, fields));
  return E.buildUnitEvidence(raw, unitOf(raw.equipmentId, opts.unit), enrich || {}, TODAY, opts.fasNames || FAS, opts.alias || '');
};
const tagOf = (e, needle) => (e.lines.find((l) => l.norm.includes(needle)) || {}).tag;

// A unit whose block is about `chars` long (timeline of ~100-char lines, oldest first).
function sized(id, chars) {
  const lines = [];
  let n = 0;
  for (let i = 0; n < chars; i++) {
    const l = '11/01 - entry ' + i + ' ' + 'x'.repeat(80);
    lines.push(l);
    n += l.length + 1;
  }
  return E.buildUnitEvidence(makeUnit({ equipmentId: id, repairTimeline: lines.join('\n') }), unitOf(id), {}, TODAY, [], '');
}

describe('constants', () => {
  it('match §4.4', () => {
    expect([E.EVIDENCE_BUDGET, E.SINGLE_MAX_UNITS, E.MAP_MAX_UNITS, E.MAX_MAP_BATCHES, E.MAX_UNITS_AI]).toEqual([36000, 16, 24, 4, 96]);
    expect([E.MIN_BLOCK, E.UNIT_HARD_MAX, E.GAP_EVIDENCE_MAX, E.GAP_FAS_MAX]).toEqual([600, 14000, 18000, 16]);
    expect(typeof E.FAS_ACT_SRC).toBe('string');
    expect(new RegExp('^(?:' + E.FAS_ACT_SRC + ')$', 'i').test('followed up')).toBe(true);
  });
});

describe('buildUnitEvidence block (§4.1)', () => {
  const raw = {
    lifecycleReason: 'Offsite Shop Repair', vendor: 'Volvo', subVendor: 'MHC Kenworth', savedRepairStatus: 'Under diagnosis',
    serviceState: 'In Repair', delayReasonCodes: 'Waiting _ for diagnosis', offsiteStage: 'diagnosis', offsiteStageDetail: 'No status set by the dealer',
    escalations: 'Dealer escalation', estimatePendingCost: '$4,800', urgent: 'true', created: '2026-11-01', workDuration: '11d 2h',
    savedPrimaryComponent: 'Turbo', dealerName: 'MHC Kenworth Syracuse',
    vendorWorkOrderId: 'WO-77881', workRequestId: 'WR-55120', serviceUrl: 'https://svc.example/s/1', assetUrl: 'https://svc.example/a/1',
    offsiteShopEventUrl: 'https://svc.example/o/1', salesforceCase: '00012345678', savedSalesforceCase: '00099887766', openCases: 'CASE-4411',
    issueSummary: 'Turbo failure', issueDetails: 'Loss of boost under load', savedNotes: '11/10 called dealer re diagnosis',
    insights: 'repeat turbo on this unit', repairTimeline: '11/03 - dropped at MHC Kenworth\n11/09 - RO 448812 under diagnosis',
    fullConversation: 'Conversation\n11/09 - Dealer Desk: tech assigned', asistNotes: 'ASIST: case 7712345 open',
  };
  const enrich = {
    canonical: { situation: 'At dealer for turbo', nextStep: 'Await diagnosis', waitingOn: 'Dealer', vendorMessage: 'diag tomorrow', updatedAt: '2026-11-11' },
    manualEntries: ['11/11 - dealer says diag 11/13'],
    email: [{ observedAt: '2026-11-08T12:00:00Z', informationType: 'new', field: 'eta', value: 'turbo ETA 11/14', sender: 'Parts Desk' }],
  };
  const e = ev(raw, enrich, { unit: { daysDown: 11, barriers: ['oem'], etc: { state: 'future', date: '2026-11-14', source: 'savedNotes' } } });
  const text = e.text();

  it('contains every §4.1 field', () => {
    const needles = [
      'lifecycle: Offsite Shop Repair', 'sub-vendor: MHC Kenworth', 'service state: In Repair', 'delay codes: Waiting _ for diagnosis',
      'offsite: diagnosis / No status set by the dealer', 'escalations: Dealer escalation', 'estimate pending: $4,800', 'urgent: true',
      'created: 2026-11-01', 'work duration: 11d 2h', 'component: Turbo', 'dealer: MHC Kenworth Syracuse',
      'WO WO-77881', 'WR WR-55120', 'https://svc.example/s/1', 'https://svc.example/a/1', 'https://svc.example/o/1',
      'SF case 00012345678', 'SF case 00099887766', 'open cases CASE-4411', 'issue: Turbo failure \u2014 Loss of boost under load',
      '[FAS notes] 11/10 called dealer re diagnosis', 'insights: repeat turbo on this unit',
      '11/09 - RO 448812 under diagnosis', '11/03 - dropped at MHC Kenworth', '11/09 - Dealer Desk: tech assigned', 'ASIST: case 7712345 open',
      'situation: At dealer for turbo', 'next step: Await diagnosis', 'waiting on: Dealer', 'vendor message: diag tomorrow', 'updated: 2026-11-11',
    ];
    for (const n of needles) expect(text, n).toContain(n);
    expect(text.indexOf('11/09 - RO 448812')).toBeLessThan(text.indexOf('11/03 - dropped'));
    expect(text).toMatch(/^\[B61001\] 11d down \| status: Under diagnosis \| vendor: Volvo/);
    expect(text).toContain('rule hints (may be wrong): oem');
    expect(text).toContain('parsed ETC: future 11/14 (from savedNotes)');
    expect(text).toContain('dealer says diag 11/13');
    expect(text).toContain('turbo ETA 11/14');
    expect(text).toContain('derived summary \u2014 verify against raw lines');
    expect(e.demand).toBe(text.length);
  });
  it('orders segments: head, refs, issue, [FAS notes], canonical, insights, timeline, manual, conversation, email, ASIST', () => {
    expect(e.segments.map((s) => s.kind)).toEqual(['head', 'refs', 'issue', 'fasNotes', 'canonical', 'insights', 'timeline', 'manual', 'conv', 'email', 'asist']);
    expect(text).toContain('[FAS notes] 11/10 called dealer re diagnosis');
  });
  it('objects become compact JSON clipped to 600', () => {
    const big = ev({ insights: { a: 'y'.repeat(2000) } });
    const line = big.text().split('\n').find((l) => l.startsWith('insights: '));
    expect(line.length).toBeLessThanOrEqual('insights: '.length + 600);
  });
});

describe('conversationEntries (§4.2)', () => {
  it('splits dated, "- " undated and unauthored entries; multiline bodies; newest first', () => {
    const c = E.conversationEntries('Conversation\n11/08 - Dealer Desk: line one\ncontinued here\n- Parts Team: no date\n11/10 - no colon here\n11/11 - Z Santiago: called TA');
    expect(c).toEqual([
      { date: '11/11', author: 'Z Santiago', body: 'called TA' },
      { date: '', author: '', body: '11/10 - no colon here' },
      { date: '', author: 'Parts Team', body: 'no date' },
      { date: '11/08', author: 'Dealer Desk', body: 'line one continued here' },
    ]);
  });
  it('drops Yard Location noise and empty bodies; de-dups keeping the newest copy', () => {
    const c = E.conversationEntries('Conversation\n11/05 - A B: parts ordered\n11/06 - Yard Bot: Yard Location Update: row 4\n11/07 - C D:\n11/09 - A B: Parts  ordered');
    expect(c).toEqual([{ date: '11/09', author: 'A B', body: 'Parts ordered' }]);
  });
  it('clips each entry to 600 chars', () => {
    const c = E.conversationEntries('11/05 - A B: ' + 'z'.repeat(900));
    expect(c[0].body.length).toBe(600);
  });
  it('no dated entry -> one undated segment with the last 4,000 chars', () => {
    const c = E.conversationEntries('free text '.repeat(600));
    expect(c).toHaveLength(1);
    expect(c[0].author).toBe('');
    expect(c[0].body.length).toBeLessThanOrEqual(4000);
    expect(c[0].body.endsWith('free text')).toBe(true);
    expect(E.conversationEntries('')).toEqual([]);
  });
  it('rendered newest first in the block', () => {
    const e = ev({ fullConversation: 'Conversation\n11/08 - Dealer Desk: older\n11/10 - Dealer Desk: newest' });
    const t = e.text();
    expect(t.indexOf('newest')).toBeLessThan(t.indexOf('older'));
  });
});

describe('redactEvidence (AC19)', () => {
  it('keeps case / SF / ASIST / RO numbers', () => {
    for (const s of ['case 7712345 11/10', 'SF 00012345678', 'ASIST 1-2345678901', 'RO 448812']) expect(E.redactEvidence(s)).toBe(s);
  });
  it('redacts separator phones and emails', () => {
    for (const s of ['(555) 123-4567', '555-123-4567', '+1 555.123.4567', 'a.b@c.com']) {
      expect(E.redactEvidence('call ' + s + ' now')).toBe('call [redacted] now');
    }
  });
  it('is applied to the block', () => {
    const e = ev({ savedNotes: 'called 555-123-4567 and a.b@c.com, case 7712345 11/10' });
    expect(e.text()).not.toMatch(/555-123-4567|a\.b@c\.com/);
    expect(e.text()).toContain('case 7712345 11/10');
  });
});

describe('FAS identity and tagging (AC20, AC33)', () => {
  it('AC20: a conversation line by the FAS is [FAS]; a vendor line with the same words is not', () => {
    const e = ev({ fullConversation: 'Conversation\n11/09 - TA Desk: called TA dispatch, bay 11/12\n11/10 - Z Santiago: called TA, bay 11/12' });
    expect(e.text()).toContain('[FAS] 11/10 - Z Santiago: called TA, bay 11/12');
    expect(e.text()).toMatch(/\n11\/09 - TA Desk: called TA dispatch/);
    expect(e.fasLines).toHaveLength(1);
    expect([...e.fasLines[0].mds]).toEqual(['11/10']);
    expect(e.fasLines[0].norm).toBe('called ta bay 11/12');
    expect(e.fasDates.has('11/10')).toBe(true);
    expect(e.fasDates.has('11/12')).toBe(false);
    expect(e.fasDates.has('11/9')).toBe(false);
  });
  it('fasNameMatch: >= 2-token sets, single tokens never, alias exact only', () => {
    expect(E.fasNameMatch('Santiago, Z', ['Z Santiago'])).toBe(true);
    expect(E.fasNameMatch('z  SANTIAGO', ['Z Santiago'])).toBe(true);
    expect(E.fasNameMatch('Santiago', ['Santiago'])).toBe(false);
    expect(E.fasNameMatch('Z Santiago Jr', ['Z Santiago'])).toBe(false);
    expect(E.fasNameMatch('zilasant', [], 'zilasant')).toBe(true);
    expect(E.fasNameMatch('ZILASANT', [], 'zilasant')).toBe(true);
    expect(E.fasNameMatch('zilasant2', [], 'zilasant')).toBe(false);
    expect(E.fasNameMatch('zilasant tech', [], 'zilasant')).toBe(false);
    expect(E.fasNameMatch('', ['Z Santiago'], 'zilasant')).toBe(false);
  });
  it('alias tags a conversation author exactly', () => {
    const e = ev({ fullConversation: 'Conversation\n11/10 - zilasant: emailed Volvo regional' }, {}, { fasNames: [], alias: 'zilasant' });
    expect(e.text()).toContain('[FAS] 11/10 - zilasant: emailed Volvo regional');
  });
  it('AC33 classifyManual verb position', () => {
    expect(E.classifyManual('11/10 - status update [em:1a2b3c4d]')).toBe('email');
    for (const s of ['11/10 called TA', '11/10 FAS emailed Volvo', '11/10 followed up with TA', '11/10 - I called TA']) expect(E.classifyManual(s), s).toBe('fas');
    for (const s of ['11/10 Dealer submitted estimate', '11/10 TA scheduled bay 11/12', '11/09 Volvo sent quote', '11/08 MCS requested photos', '11/10 dealer says parts ETA 11/14']) {
      expect(E.classifyManual(s), s).toBe('logged');
    }
  });
  it('AC33 manual entries in the block: [email] / [FAS] / [logged], marker stripped, email dates not FAS dates', () => {
    const e = ev({ repairTimeline: '11/09 - Volvo update: estimate submitted [em:1a2b3c4d]\n11/10 - called TA' }, {
      manualEntries: ['11/09 - Volvo update: estimate submitted [em:1a2b3c4d]', '11/11 - Volvo regional ETA [em:9f9f9f9f]', '11/10 - called TA', '11/10 dealer says parts ETA 11/14', '11/10 Dealer submitted estimate'],
    });
    const t = e.text();
    expect(t).not.toMatch(/\[em:/);
    expect(t).toContain('[email] 11/09 - Volvo update: estimate submitted');
    expect(t).toContain('[FAS] 11/10 - called TA');
    expect(t).toContain('[email] 11/11 - Volvo regional ETA');
    expect(t).toContain('[logged] 11/10 dealer says parts ETA 11/14');
    expect(t).toContain('[logged] 11/10 Dealer submitted estimate');
    expect(tagOf(e, 'volvo update estimate submitted')).toBe('email');
    expect([...e.fasDates]).toEqual(['11/10']);
    expect(e.fasDates.has('11/9') || e.fasDates.has('11/11') || e.fasDates.has('11/14')).toBe(false);
  });
  it('a conversation entry whose body matches a FAS manual entry is [FAS] even without a name match', () => {
    const e = ev({ fullConversation: 'Conversation\n11/10 - Desk Bot: called TA re tech' }, { manualEntries: ['11/10 - called TA re tech'] }, { fasNames: [] });
    expect(e.text()).toContain('[FAS] 11/10 - Desk Bot: called TA re tech');
  });
  it('fasDates: leading date + verb-attached dates only (window stops at , ; ( ))', () => {
    expect([...ev({ savedNotes: '11/10 called TA, they said parts ETA 11/20' }).fasDates]).toEqual(['11/10']);
    expect([...ev({ savedNotes: 'escalated to Volvo 11/09 about bay 11/12' }).fasDates]).toEqual(['11/9']);
    expect([...ev({ savedNotes: 'waiting on dealer since 11/05' }).fasDates]).toEqual([]);
    const e = ev({ repairTimeline: '11/10 - TA scheduled bay 11/12' });
    expect(e.fasDates.size).toBe(0);
    expect(tagOf(e, 'ta scheduled bay')).toBe('other');
  });
  it('line index: every rendered line has tag, mds (incl. entry date) and norm', () => {
    const e = ev({ fullConversation: 'Conversation\n11/10 - Dealer Desk: bay ok for 11/12' });
    const conv = e.lines.find((l) => l.tag === 'conv');
    expect([...conv.mds].sort()).toEqual(['11/10', '11/12']);
    expect(conv.norm).toBe('bay ok for 11/12');
  });
});

describe('email evidence ordering', () => {
  it('usedInConclusion first, then newest; stale / contradiction labels; FAS sender tagged; max 15', () => {
    const email = [
      { observedAt: '2026-11-05T10:00:00Z', informationType: 'new', field: 'eta', value: 'old fact', sender: 'Parts Desk', usedInConclusion: false },
      { observedAt: '2026-11-09T10:00:00Z', informationType: 'stale', field: 'eta', value: 'stale fact', sender: 'Parts Desk' },
      { observedAt: '2026-11-03T10:00:00Z', informationType: 'new', field: 'status', value: 'concluded fact', sender: 'Parts Desk', usedInConclusion: true },
      { observedAt: '2026-11-10T10:00:00Z', informationType: 'contradiction', field: 'eta', value: 'contra fact', sender: 'Z Santiago' },
    ];
    for (let i = 0; i < 20; i++) email.push({ observedAt: '2026-10-01T00:00:00Z', informationType: 'new', field: 'x', value: 'filler ' + i, sender: 'P Q' });
    const seg = ev({}, { email }).segments.find((s) => s.kind === 'email');
    expect(seg.lines).toHaveLength(15);
    expect(seg.lines.slice(0, 4).map((l) => l.text)).toEqual([
      '11/3 \u00b7 new/status: concluded fact (Parts Desk)',
      '[FAS] (contradicts other evidence) 11/10 \u00b7 contradiction/eta: contra fact (Z Santiago)',
      '(stale) 11/9 \u00b7 stale/eta: stale fact (Parts Desk)',
      '11/5 \u00b7 new/eta: old fact (Parts Desk)',
    ]);
  });
});

describe('normQuote', () => {
  it('lowercases, drops tags, markers, the leading date and punctuation', () => {
    expect(E.normQuote('[FAS] 11/10 - Called TA, re: TECH! [em:1a2b3c4d]')).toBe('called ta re tech');
    expect(E.normQuote('[FAS notes] RO# 4488 $4,800.00 11/12')).toBe('ro# 4488 $4 800.00 11/12');
    expect(E.normQuote('  Checked   alternate source  ')).toBe('checked alternate source');
  });
});

describe('allocate (water-filling, §4.3)', () => {
  it('fits: returns the same blocks untouched', () => {
    const a = sized('A1', 2000);
    const b = sized('A2', 3000);
    const out = E.allocate([a, b], 36000);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(b);
  });
  it('small units stay whole, large ones are trimmed oldest first, keep lines and marker survive', () => {
    const small = sized('S1', 1500);
    const big1 = sized('L1', 13000);
    const big2 = sized('L2', 13000);
    const out = E.allocate([small, big1, big2], 15000);
    expect(out[0]).toBe(small);
    expect(out.reduce((n, e) => n + e.text().length, 0)).toBeLessThanOrEqual(15000);
    for (const e of out.slice(1)) {
      const t = e.text();
      expect(t).toMatch(/^\[L\d\] /);
      expect(t).toMatch(/\(\+\d+ older lines not shown\)/);
      const tl = e.segments.find((s) => s.kind === 'timeline');
      expect(tl.lines.length).toBeGreaterThanOrEqual(E.KEEP.timeline);
      // newest (last written) line survives, oldest goes first
      expect(t).toContain(big1.segments.find((s) => s.kind === 'timeline').lines[0].text);
      expect(t).not.toContain('entry 0 ');
    }
    expect(out[1].demand).toBe(big1.demand);
  });
  it('trims conversation beyond keep before timeline, and rebuilds lines / fasLines', () => {
    const conv = ['Conversation'];
    for (let i = 1; i <= 20; i++) conv.push('11/' + String(i).padStart(2, '0') + ' - Z Santiago: called TA about item ' + i + ' ' + 'q'.repeat(150));
    const e = ev({ fullConversation: conv.join('\n'), repairTimeline: '11/10 - towed' });
    expect(e.fasLines).toHaveLength(20);
    const t = E.trimEvidence(e, e.text().length - 1500);
    const cs = t.segments.find((s) => s.kind === 'conv');
    expect(cs.lines.length).toBeLessThan(20);
    expect(cs.lines.length).toBeGreaterThanOrEqual(E.KEEP.conv);
    expect(t.segments.find((s) => s.kind === 'timeline').lines).toHaveLength(1);
    expect(t.fasLines).toHaveLength(cs.lines.length);
    expect(t.fasDates.has('11/20')).toBe(true);
    expect(t.fasDates.has('11/1')).toBe(false);
    expect(t.lines.length).toBeLessThan(e.lines.length);
  });
  it('maximal trimming reaches MIN_BLOCK and keeps the head line', () => {
    const e = ev({
      savedNotes: 'n '.repeat(800), issueSummary: 'Turbo', issueDetails: 'd '.repeat(800), insights: 'i '.repeat(400),
      repairTimeline: Array.from({ length: 40 }, (_, i) => '11/01 - line ' + i + ' ' + 'w'.repeat(60)).join('\n'),
      fullConversation: 'Conversation\n' + Array.from({ length: 12 }, (_, i) => '11/02 - A B: c' + i + ' ' + 'v'.repeat(60)).join('\n'),
      asistNotes: 'a'.repeat(3000), vendorWorkOrderId: 'WO-1', vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor',
    }, { canonical: { situation: 's '.repeat(200) }, manualEntries: ['11/03 - called TA ' + 'm'.repeat(50)] });
    const t = E.trimEvidence(e, E.MIN_BLOCK);
    expect(t.text().length).toBeLessThanOrEqual(E.MIN_BLOCK);
    expect(t.text()).toMatch(/^\[B61001\] 9d down \| status: Waiting for vendor \| vendor: Volvo/);
    expect(t.text()).toMatch(/\(\+\d+ older lines not shown\)$/);
    expect(t.lines[0].tag).toBe('other');
    const out = E.allocate([e, sized('Q1', 9000), sized('Q2', 9000)], 1800);
    expect(out).toHaveLength(3);
    for (const x of out) expect(x.text().length).toBeLessThanOrEqual(E.MIN_BLOCK);
  });
  it('UNIT_HARD_MAX caps one block before planning (newest lines kept)', () => {
    const e = sized('H1', 30000);
    expect(e.rawDemand).toBeGreaterThan(E.UNIT_HARD_MAX);
    expect(e.demand).toBeLessThanOrEqual(E.UNIT_HARD_MAX);
    expect(e.text().length).toBe(e.demand);
    expect(e.text()).toMatch(/\(\+\d+ older lines not shown\)/);
  });
});

describe('planBatches (§4.4)', () => {
  const many = (n, chars, p = 'U') => Array.from({ length: n }, (_, i) => sized(p + String(i).padStart(3, '0'), chars));
  const check = (evs, sizes) => {
    const plan = E.planBatches(evs);
    expect(plan.mode).toBe('mapreduce');
    expect(plan.batches.map((b) => b.length)).toEqual(sizes);
    expect(plan.batches.length).toBeLessThanOrEqual(evs.length);
    // every unit exactly once, contiguous, builder order
    expect(plan.batches.flat().map((e) => e.id)).toEqual(evs.map((e) => e.id));
    for (const b of plan.batches) expect(b.reduce((n, e) => n + e.text().length, 0)).toBeLessThanOrEqual(E.EVIDENCE_BUDGET);
    expect(plan.demand).toBe(evs.reduce((n, e) => n + e.demand, 0));
    return plan;
  };
  it('9 x 14k -> 3,2,2,2 (the 3-unit group is water-filled)', () => {
    const evs = many(9, 20000);
    for (const e of evs) expect(e.demand).toBeGreaterThan(13500);
    const plan = check(evs, [3, 2, 2, 2]);
    expect(plan.batches[0][0].text().length).toBeLessThan(evs[0].demand);
    expect(plan.batches[1][0]).toBe(evs[3]);
  });
  it('10 x 13k -> 3,3,2,2', () => { check(many(10, 13000), [3, 3, 2, 2]); });
  it('40 x 2.5k -> 14,13,13 (no trim)', () => {
    const evs = many(40, 2300);
    const total = evs.reduce((n, e) => n + e.demand, 0);
    expect(total).toBeGreaterThan(72000);
    expect(total).toBeLessThanOrEqual(108000);
    const plan = check(evs, [14, 13, 13]);
    expect(plan.batches.flat().every((e, i) => e === evs[i])).toBe(true);
  });
  it('21 small -> 11,10; 17 small -> 9,8; 96 small -> 24 x 4', () => {
    check(many(21, 300), [11, 10]);
    check(many(17, 300), [9, 8]);
    check(many(96, 300), [24, 24, 24, 24]);
  });
  it('97 units -> too-large; n <= 16 within 1.15 x budget -> single (water-filled)', () => {
    expect(E.planBatches(many(97, 200)).mode).toBe('too-large');
    const evs = many(4, 10000);
    const total = evs.reduce((n, e) => n + e.demand, 0);
    expect(total).toBeGreaterThan(36000);
    expect(total).toBeLessThanOrEqual(41400);
    const plan = E.planBatches(evs);
    expect(plan.mode).toBe('single');
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0].reduce((n, e) => n + e.text().length, 0)).toBeLessThanOrEqual(36000);
    expect(E.planBatches(many(16, 300)).mode).toBe('single');
    expect(E.planBatches(many(5, 9000)).mode).toBe('mapreduce');   // 45k > 41,400
  });
});
