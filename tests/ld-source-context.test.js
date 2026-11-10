// tests/ld-source-context.test.js — Long Dwell AI Fill SOURCE DATA assembly
// (FEAT-003). Synthetic B20038-shaped fixture only (no real names / PII).
// Pins: whole-feed delivery when it fits, newest-first trimming with a marker
// + KEY LINES when it does not, no invented lines, the legacy (fullContext
// false) sizes, fingerprint sensitivity, and renderer/main keepNewest parity.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import {
  buildAIFillPromptWithMeta, sourceContextWithMeta, keepNewest, TRIM_MARKER_RE,
  buildCsvPromptRow, withRelayCacheBackfill, LD_PROMPT_MAX,
} from '../renderer/src/js/longdwell-ai.js';
import { fillFingerprint } from '../renderer/src/js/longdwell-fill-logic.js';

const require = createRequire(import.meta.url);
const mainBudget = require('../src/orcha/source-budget.js');

const KB = 'K'.repeat(26689);
const pad2 = (n) => String(n).padStart(2, '0');
const mmdd = (d) => pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate());
const dayOf = (start, off) => new Date(Date.UTC(2026, start[0] - 1, start[1] + off));

// 52 comment lines 09/08 -> 11/06 (oldest first), 3 "$" amounts + 9 ETC mentions after 09/16.
function makeConversation() {
  const lines = [];
  const money = { 12: 'estimate v1 $4,210.55 submitted for review', 25: 'estimate v2 $6,880.10 submitted after teardown', 38: 'estimate v3 $7,145.92 approved per portal' };
  const etc = new Set([14, 18, 22, 27, 31, 35, 41, 46, 50]);
  for (let i = 0; i < 52; i++) {
    const d = dayOf([9, 8], Math.round(i * 59 / 51));
    let body;
    if (money[i]) body = 'Vendor update: ' + money[i];
    else if (etc.has(i)) body = 'Vendor update: projected ETC moved, waiting on shop capacity, item ' + i;
    else body = 'Vendor update: unit in bay, technician working the coolant leak, checkpoint ' + i;
    lines.push(mmdd(d) + '/2026 08:' + pad2(i % 60) + ' AM ' + body + ' -- synthetic note text for sizing only.');
  }
  return { header: 'Conversation', lines };
}

// 43 timeline lines 09/08 -> 11/09 (oldest first).
function makeTimeline() {
  const lines = [];
  for (let i = 0; i < 43; i++) {
    const d = dayOf([9, 8], Math.round(i * 62 / 42));
    lines.push(mmdd(d) + ' - Timeline entry ' + i + ': status reviewed and the vendor thread checked for movement.');
  }
  return lines;
}

function makeRow() {
  const conv = makeConversation();
  const tl = makeTimeline();
  return {
    equipmentId: 'UNIT-TEST-1',
    vendor: 'Test Dealer North',
    domicileSite: 'SITE1',
    operator: 'CARR1',
    lifecycleReason: 'Repair',
    issueDetails: 'Coolant leak at radiator',
    issueSummary: 'Unit at dealer for coolant leak repair',
    savedNotes: 'SAVED_NOTES_MARK follow up with dealer on the coolant estimate',
    fullConversation: conv.header + '\n' + conv.lines.join('\n'),
    repairTimeline: tl.join('\n'),
    asistNotes: '10/02/2026 Offsite note: dealer confirmed bay slot\n10/20/2026 Offsite note: dealer waiting on radiator core',
    _secondaryWRs: [{ vendor: 'Mobile Vendor A', workRequestId: 'WR-2', fullConversation: 'Conversation\n10/05/2026 Secondary thread: tire replaced on axle 2' }],
    canonicalStatus: 'AT VENDOR',
    canonicalWaitingOn: 'dealer',
    canonicalSituation: 'Dealer repairing coolant leak',
    canonicalNextStep: 'Request updated ETC',
    canonicalStatusChangeReason: 'CANON_REASON_MARK estimate approved and parts ordered',
    canonicalPhase: 'repair',
    canonicalLocation: 'Test Dealer North',
    canonicalUpdatedAt: '2026-11-01',
    csvDaysDown: '58',
    csvExpectedEtc: '11/20/2026',
    csvVendorDelayReason: 'Parts on order',
    needBy: '2026-11-15',
    created: '2026-09-08',
    serviceState: 'Scheduled',
    subState: 'In Progress',
    pmB: '12/01/2026',
    dot: '12/05/2026',
    _conv: conv, _tl: tl,
  };
}

const sourceBlock = (prompt) => prompt.slice(prompt.indexOf('SOURCE DATA:\n') + 'SOURCE DATA:\n'.length, prompt.indexOf('\n\nMY ROLE (FAS)'));

describe('LD source context: fits whole (B20038-shaped)', () => {
  const row = makeRow();
  const { prompt, meta } = buildAIFillPromptWithMeta(row, 58, { knowledge: KB, fullContext: true });

  it('carries every comment, timeline line, fact and the canonical reason', () => {
    for (const l of row._conv.lines) expect(prompt).toContain(l);
    for (const l of row._tl) expect(prompt).toContain(l);
    expect(prompt).toContain('11/06/2026');
    expect(prompt).toContain('11/09 - Timeline entry 42');
    for (const amt of ['$4,210.55', '$6,880.10', '$7,145.92']) expect(prompt).toContain(amt);
    expect(row._conv.lines.filter((l) => /ETC/.test(l)).length).toBe(9);
    expect(prompt).toContain('SAVED_NOTES_MARK');
    for (const f of ['Days Down: 58', 'Expected ETC: 11/20/2026', 'Vendor delay reason: Parts on order', 'WO created: 2026-09-08',
      'Need by: 2026-11-15', 'Service state: Scheduled', 'Sub-state: In Progress', 'PM-B: 12/01/2026', 'DOT: 12/05/2026']) {
      expect(prompt).toContain(f);
    }
    expect(prompt).toContain('status change reason: CANON_REASON_MARK');
    expect(prompt).toContain('Offsite/dealer notes:\n10/02/2026 Offsite note');
    expect(prompt).toContain('[WO #1 Mobile Vendor A]\nConversation\n10/05/2026 Secondary thread');
  });

  it('is untrimmed, under the ceiling, with the full instructions and JSON tail', () => {
    expect(TRIM_MARKER_RE.test(prompt)).toBe(false);
    expect(prompt).not.toContain('KEY LINES');
    expect(meta.totalTrimmed).toBe(0);
    expect(prompt.length).toBeLessThanOrEqual(LD_PROMPT_MAX);
    expect(meta.length).toBeLessThanOrEqual(meta.budget);
    for (const s of ['TASK -- return exactly three fields', 'FOLLOW-UP DATE RULE', 'FILL RULES', 'EXAMPLE 1:', 'EXAMPLE 2:']) expect(prompt).toContain(s);
    expect(prompt.endsWith('{"delayReason": "...", "escalationLevel": "...", "summary": "..."}')).toBe(true);
  });

  it('(F) keeps the anti-fabrication rules verbatim', () => {
    expect(prompt).toContain('Ground EVERY field ONLY in the SOURCE DATA above. NEVER invent a part, link, owner,');
    expect(prompt).toContain('do NOT invent actions, vendor calls, or follow-ups');
  });
});

// 60k oldest-first conversation: anchor complaint first, a dropped estimate line early.
function makeBigRow() {
  const lines = ['Conversation', '01/02/2026 ANCHOR_COMPLAINT unit reported coolant leak and overheating'];
  let i = 0;
  while (lines.join('\n').length < 60000) {
    const d = dayOf([1, 3], Math.floor(i / 2));
    const body = i === 20 ? 'Dealer note: estimate v2 $12,345.67 submitted for the radiator and hoses'
      : 'Dealer note: routine status check number ' + i + ', no change reported by the shop today';
    lines.push(mmdd(d) + '/2026 ' + body);
    i++;
  }
  lines.push('11/01/2026 NEWEST_LINE dealer reports the unit is ready for pickup');
  return { equipmentId: 'UNIT-TEST-2', fullConversation: lines.join('\n'), _lines: lines };
}

describe('LD source context: oversize', () => {
  const row = makeBigRow();
  const { prompt, meta } = buildAIFillPromptWithMeta(row, 300, { knowledge: KB, fullContext: true });

  it('keeps newest + anchor, marks the gap and lifts trimmed estimate lines', () => {
    expect(prompt.length).toBeLessThanOrEqual(LD_PROMPT_MAX);
    expect(prompt).toContain('NEWEST_LINE');
    expect(prompt).toContain('ANCHOR_COMPLAINT');
    expect(TRIM_MARKER_RE.test(prompt)).toBe(true);
    expect(meta.trimmed.conversation).toBeGreaterThan(0);
    expect(meta.totalTrimmed).toBe(meta.trimmed.conversation);
    const src = sourceBlock(prompt);
    const key = src.indexOf('KEY LINES FROM TRIMMED HISTORY (newest first):');
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThan(src.indexOf('Vendor/WO conversation:'));
    const keySection = src.slice(key, src.indexOf('Vendor/WO conversation:'));
    expect(keySection).toContain('$12,345.67');
    expect(meta.length).toBeLessThanOrEqual(meta.budget);
  });

  it('(C) a descending-dated feed keeps the head (newest)', () => {
    const tl = [];
    for (let k = 0; k < 400; k++) tl.push(mmdd(dayOf([11, 1], -Math.floor(k / 2))) + '/2026 - desc timeline entry ' + k + ' with filler text for size');
    const out = sourceContextWithMeta({ repairTimeline: tl.join('\n') }, { budget: 6000, fullContext: true });
    expect(out.text).toContain(tl[0]);
    expect(out.text).toContain(tl[1]);
    expect(out.text).not.toContain(tl[200]);
    expect(TRIM_MARKER_RE.test(out.text)).toBe(true);
    expect(out.meta.trimmed.timeline).toBeGreaterThan(0);
    expect(out.text.length).toBeLessThanOrEqual(6000);
  });
});

describe('LD source context: no fabrication (D)', () => {
  const HEADERS = new Set(['Vendor/WO conversation:', 'Repair timeline:', 'Offsite/dealer notes:', 'Other work orders:',
    'KEY LINES FROM TRIMMED HISTORY (newest first):',
    'CANONICAL STATE (reconciled summary — if a NEWER dated line below conflicts with it, the newer line wins):']);
  const PREFIXES = ['Canonical status: ', 'waiting on: ', 'situation: ', 'reconciled next step: ', 'status change reason: ',
    'phase: ', 'location: ', 'updated: ', 'Issue: ', 'Summary so far: ', 'Notes: '];
  const inputsOf = (row) => Object.entries(row).filter(([k]) => !k.startsWith('_') || k === '_secondaryWRs')
    .map(([, v]) => (Array.isArray(v) ? v.map((w) => w.fullConversation + '\n' + w.vendor).join('\n') : String(v))).join('\n');

  function check(row, prompt) {
    const inputs = inputsOf(row);
    const src = sourceBlock(prompt);
    let checked = 0;
    for (const line of src.split('\n')) {
      if (!line || HEADERS.has(line) || TRIM_MARKER_RE.test(line) || /^\[WO #\d+ .+\]$/.test(line)) continue;
      const pieces = line.startsWith('UNIT FACTS: ')
        ? line.slice('UNIT FACTS: '.length).split(' | ').map((p) => p.replace(/^[^:]+: /, ''))
        : [PREFIXES.reduce((s, p) => (s.startsWith(p) ? s.slice(p.length) : s), line)];
      for (const p of pieces) { expect(inputs, 'invented: ' + p.slice(0, 40)).toContain(p); checked++; }
    }
    expect(checked).toBeGreaterThan(10);
  }

  it('every SOURCE DATA line traces to an input field (fits + oversize)', () => {
    const a = makeRow();
    check(a, buildAIFillPromptWithMeta(a, 58, { knowledge: KB, fullContext: true }).prompt);
    const b = makeBigRow();
    check(b, buildAIFillPromptWithMeta(b, 300, { knowledge: KB, fullContext: true }).prompt);
  });
});

describe('LD source context: fullContext=false (E)', () => {
  const row = makeRow();
  const src = sourceContextWithMeta(row, { fullContext: false }).text;

  it('legacy sizes, newest-first, no new feeds', () => {
    const conv = src.slice(src.indexOf('Vendor/WO conversation:\n') + 'Vendor/WO conversation:\n'.length, src.indexOf('\n\nRepair timeline:'));
    expect(conv.length).toBeLessThanOrEqual(1500);
    expect(conv).toContain(row._conv.lines[51]);
    expect(conv.startsWith('Conversation')).toBe(true); // anchor
    expect(TRIM_MARKER_RE.test(conv)).toBe(true);
    const tl = src.slice(src.indexOf('Repair timeline:\n') + 'Repair timeline:\n'.length);
    expect(tl.length).toBeLessThanOrEqual(1200);
    expect(tl).toContain(row._tl[42]);
    expect(src).not.toContain('Offsite/dealer notes');
    expect(src).not.toContain('Other work orders');
    expect(src).not.toContain('KEY LINES');
    expect(src).not.toContain('status change reason:');
    expect(src).not.toContain('SAVED_NOTES_MARK'); // legacy: notes only without a timeline
  });
});

describe('fillFingerprint (G)', () => {
  it('changes when a newer comment is appended to a 20k conversation', () => {
    const lines = ['Conversation'];
    for (let k = 0; lines.join('\n').length < 20000; k++) lines.push(mmdd(dayOf([9, 1], Math.floor(k / 4))) + '/2026 status line ' + k + ' with routine filler text');
    const row = { equipmentId: 'UNIT-TEST-3', fullConversation: lines.join('\n') };
    const before = fillFingerprint(row);
    const after = fillFingerprint(Object.assign({}, row, { fullConversation: row.fullConversation + '\n11/30/2026 brand new vendor update' }));
    expect(after).not.toBe(before);
  });
});

describe('keepNewest parity renderer vs main (H)', () => {
  const asc = Array.from({ length: 200 }, (_, k) => mmdd(dayOf([1, 1], k)) + ' asc line ' + k + ' filler').join('\n');
  const desc = Array.from({ length: 200 }, (_, k) => mmdd(dayOf([12, 1], -k)) + '/2026 desc line ' + k).join('\n');
  const dom = Array.from({ length: 150 }, (_, k) => {
    const d = dayOf([3, 1], k);
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCDate() + ', 2026 06:07 PM dom line ' + k;
  }).join('\n');
  const undated = Array.from({ length: 120 }, (_, k) => 'undated note ' + k + ' with some words').join('\n');
  const emoji = Array.from({ length: 60 }, (_, k) => '10/' + pad2((k % 28) + 1) + ' note ✓ 🚚 Café ' + k).join('\n') + '\n' + '🚚'.repeat(400);
  const cases = [[asc, 1500, 300], [desc, 2000, 0], [dom, 1800, 200], [undated, 900, 0], [emoji, 500, 100]];

  it('produces identical output on 5 shared fixtures', () => {
    for (const [text, budget, anchor] of cases) {
      expect(keepNewest(text, budget, { anchor })).toEqual(mainBudget.keepNewest(text, budget, { anchor }));
    }
  });
});

describe('prompt-row helpers (I)', () => {
  it('buildCsvPromptRow maps CSV facts and the extra live keys', () => {
    const csv = { 'Asset ID': ' UNIT-TEST-4 ', 'Days Down': '58', 'Expected ETC': '11/20/2026', 'Vendor Delay Reason': 'Parts on order', 'Site': 'SITE1', 'Level 1': 'Engine', 'Level 2': 'Coolant' };
    const secs = [{ vendor: 'V', fullConversation: 'x' }];
    const planned = { vendor: 'P', fullConversation: 'y' };
    const live = { issueSummary: 'live summary', asistNotes: 'offsite', needBy: '2026-11-15', created: '2026-09-08', serviceState: 'Scheduled',
      subState: 'In Progress', vendorWorkOrderId: 'VWO-1', pmB: '12/01', pmX: '--', dot: '12/05', canonicalPhase: 'repair', canonicalLocation: 'loc',
      canonicalStatusChangeReason: 'reason', canonicalUpdatedAt: '2026-11-01', _secondaryWRs: secs, _plannedWRData: planned, emptyField: '' };
    const r = buildCsvPromptRow(csv, live);
    expect(r.equipmentId).toBe('UNIT-TEST-4');
    expect(r.csvDaysDown).toBe('58');
    expect(r.csvExpectedEtc).toBe('11/20/2026');
    expect(r.csvVendorDelayReason).toBe('Parts on order');
    expect(r.issueSummary).toBe('live summary');
    expect(r.issueDetails).toBe('Engine / Coolant');
    for (const k of ['asistNotes', 'needBy', 'created', 'serviceState', 'subState', 'vendorWorkOrderId', 'pmB', 'pmX', 'dot',
      'canonicalPhase', 'canonicalLocation', 'canonicalStatusChangeReason', 'canonicalUpdatedAt']) expect(r[k]).toBe(live[k]);
    expect(r._secondaryWRs).toBe(secs);
    expect(r._plannedWRData).toBe(planned);
    expect(buildCsvPromptRow(csv, { _secondaryWRs: [] })._secondaryWRs).toBeUndefined();
    expect(buildCsvPromptRow(csv, null).issueSummary).toBe('Parts on order');
  });

  it('withRelayCacheBackfill fills only empty fields', () => {
    const row = { equipmentId: 'U', fullConversation: 'row conv', asistNotes: '  ', needBy: '' };
    const cache = { fullConversation: 'cache conv', asistNotes: 'cache offsite', needBy: '2026-11-15', created: '2026-09-08', serviceState: 7, _cachedAt: 1 };
    const out = withRelayCacheBackfill(row, cache);
    expect(out).not.toBe(row);
    expect(out.fullConversation).toBe('row conv');
    expect(out.asistNotes).toBe('cache offsite');
    expect(out.needBy).toBe('2026-11-15');
    expect(out.created).toBe('2026-09-08');
    expect(out.serviceState).toBeUndefined();
    expect(out._cachedAt).toBeUndefined();
    expect(row.asistNotes).toBe('  ');
    expect(withRelayCacheBackfill(row, null)).toBe(row);
  });
});
