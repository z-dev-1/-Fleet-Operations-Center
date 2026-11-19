// tests/timeline-digest.test.js — FEAT-002: grounded, cached AI digest of the timeline history
// (src/orcha/timeline-digest.js). Brief items (b) keep every important fact / invent nothing,
// (d) cached + regenerated only when the timeline changed, and the digest half of (g).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as F from './fixtures/timeline-summary-fixture.js';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'timeline-digest-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const store = require('../src/store');
const TT = require('../src/orcha/timeline-text');
const D = require('../src/orcha/timeline-digest');
const relay = require('../src/scrapers/relay');
const history = require('../src/orcha/repair-history');

const TIMELINE = TT.cleanTimelineMeta(F.LONG_TIMELINE);
const NS = () => ({ timeline: TIMELINE, priorHistory: F.PREV_TIMELINE });
const TODAY = '2026-11-18';
const LATEST = '11/17 - Repair completed; unit ready for pickup; down 56 days.';

// An AI digest built only from grounded facts; `omit` drops lines matching a pattern.
function aiText(omit) {
  const lines = [
    '06/15 - Unit checked in at M&K Dunmore (ASIST case 975426).',
    '08/31 - Dealer: parts ordered for air dryer; awaiting arrival.',
    '09/23 - Work order created with Volvo (ASIST case 975426) for air leak; status Waiting for vendor.',
    '09/25 - Unit towed to M&K Dunmore.',
    '09/29 - Diagnosis: failed air dryer; status changed to Under diagnosis.',
    '10/02 - Estimate V1 $4,210.30 submitted; internal approval pending.',
    '10/03 - Estimate V1 approved.',
    '10/04 - Parts ordered: air dryer; parts ETA 10/12.',
    '10/15 - Escalated to Uptime team for parts delay.',
    '10/16 - Parts arrived at M&K Dunmore.',
    '10/22 - ETC missed; dealer revised ETC 10/24.',
  ].filter((l) => !(omit && omit.test(l)));
  return 'DIGEST:\n' + lines.map((l) => '- ' + l).join('\n');
}
const covered = (lines, inputLines, row) => {
  const classes = D.IMPORTANT_CLASSES.concat([{ key: 'vendor', re: D.vendorClassRe(row) }]);
  return classes.filter((c) => inputLines.some((l) => c.re.test(l))).filter((c) => !lines.some((l) => c.re.test(l))).map((c) => c.key);
};

describe('splitLatest / buildDigestInput', () => {
  it('latest is the 11/17 entry; gaps and requested-update fillers are excluded', () => {
    const tl = TIMELINE + '\n10/26 - Requested update from vendor.';
    const s = D.splitLatest(tl, F.NOW);
    expect(s.latest).toBe(LATEST);
    expect(s.history.some((l) => /no update logged/i.test(l))).toBe(false);
    expect(s.history.some((l) => /requested update/i.test(l))).toBe(false);
    expect(s.history[0]).toMatch(/^09\/23 - /);
    expect(s.history).not.toContain(LATEST);
  });
  it('includes prior history and the June stage lines; sourceHash is stable and tracks history', () => {
    const r = F.row();
    const a = D.buildDigestInput(r, NS(), F.NOW);
    expect(a.priorLines).toContain('06/15 - Unit checked in at M&K Dunmore (ASIST case 975426).');
    expect(a.priorLines).toContain('06/14 - Dealer case stage: Arrival (Working)');
    expect(a.priorLines.filter((l) => /Dealer case stage/.test(l))).toHaveLength(4);
    expect(a.priorLines.some((l) => /^09\//.test(l))).toBe(false);
    expect(a.inputText).toContain('UNIT FACTS: Vendor: Volvo | Dealer: M&K Dunmore | WO created: 09/23 | Down: 56 days | SF case: 08812345');
    expect(a.inputText).not.toContain(LATEST);
    expect(D.buildDigestInput(F.row(), NS(), F.NOW).sourceHash).toBe(a.sourceHash);
    // the daily-changing down duration does not invalidate the cache
    expect(D.buildDigestInput(F.row({ workDuration: '57 days' }), NS(), F.NOW).sourceHash).toBe(a.sourceHash);
    const ns2 = NS(); ns2.timeline = ns2.timeline.replace('Estimate V1 approved.', 'Estimate V1 approved by fleet.');
    expect(D.buildDigestInput(r, ns2, F.NOW).sourceHash).not.toBe(a.sourceHash);
  });
});

describe('gateDigest', () => {
  const inp = D.buildDigestInput(F.row(), NS(), F.NOW);
  it('drops invented dates, amounts, counts and names; keeps grounded lines', () => {
    const text = 'DIGEST:\n' + [
      '- 09/25 - Unit towed to M&K Dunmore.',
      '- **10/03 - Estimate V1 approved.**',
      '- 10/07 - Parts shipped from Volvo.',
      '- 10/02 - Estimate V1 submitted for $9,999.00.',
      '- 09/25 - 3 tows to M&K Dunmore.',
      '- 10/15 - Mike Jones escalated to Uptime team.',
      '- 10/02 - Estimate V1 $4,210.30 submitted; internal approval pending.',
    ].join('\n');
    const g = D.gateDigest(text, inp.inputText, TODAY);
    expect(g.lines).toEqual([
      '09/25 - Unit towed to M&K Dunmore.',
      '10/03 - Estimate V1 approved.',
      '10/02 - Estimate V1 $4,210.30 submitted; internal approval pending.',
    ]);
    const bad = g.dropped.map((d) => d.line).join('\n');
    expect(bad).toContain('10/07');
    expect(bad).toContain('$9,999.00');
    expect(bad).toContain('3 tows');
    expect(bad).toContain('Mike Jones');
  });
});

describe('buildDigest', () => {
  const inp = D.buildDigestInput(F.row(), NS(), F.NOW);
  const inputLines = inp.priorLines.concat(inp.historyLines);
  it('AI digest missing the tow and escalation -> backfilled verbatim, every class covered', async () => {
    const d = await D.buildDigest(F.row(), NS(), { ask: async () => aiText(/towed|Escalated/), now: F.NOW });
    expect(d.method).toBe('ai+backfill');
    expect(d.lines).toContain('09/25 - Unit towed to M&K Dunmore.');
    expect(d.lines).toContain('10/15 - Escalated to Uptime team for parts delay.');
    expect(covered(d.lines, inputLines, F.row())).toEqual([]);
    expect(d.lines.some((l) => l.includes('$4,210.30'))).toBe(true);   // stored data is unredacted
    expect(d).toMatchObject({ v: D.DIGEST_VERSION, sourceHash: inp.sourceHash, latestEntry: LATEST,
      historyCount: inp.historyLines.length, priorCount: inp.priorLines.length });
    expect(d.lines.join('\n')).not.toContain(LATEST);
  });
  it('a complete grounded AI digest -> method ai', async () => {
    const d = await D.buildDigest(F.row(), NS(), { ask: async () => ({ text: aiText() }), now: F.NOW });
    expect(d.method).toBe('ai');
    expect(d.dropped).toBe(0);
  });
  for (const [label, ask] of [
    ['throws', async () => { throw new Error('down'); }],
    ['returns null', async () => null],
    ['returns garbage', async () => 'Sure! Here is a summary of the unit.'],
  ]) {
    it('ask ' + label + ' -> verbatim fallback covering every class', async () => {
      const d = await D.buildDigest(F.row(), NS(), { ask, now: F.NOW });
      expect(d.method).toBe('fallback');
      expect(d.lines.length).toBeGreaterThan(0);
      expect(covered(d.lines, inputLines, F.row())).toEqual([]);
      for (const l of d.lines) expect(inputLines.some((src) => src.startsWith(l.replace(/\u2026$/, '')))).toBe(true);
      expect(d.lines.some((l) => l.includes('$4,210.30'))).toBe(true);
    });
  }
  it('every IMPORTANT fixture fact survives the fallback', async () => {
    const d = await D.buildDigest(F.row(), NS(), { ask: async () => null, now: F.NOW });
    const all = d.lines.join('\n') + '\n' + d.latestEntry;
    for (const s of F.IMPORTANT) expect(all).toContain(s);
  });
});

describe('refreshTimelineDigests', () => {
  let asks;
  let pushes;
  let askImpl;
  const ask = async (p) => { asks.push(p); return askImpl(p); };
  const run = (rows, o = {}) => D.refreshTimelineDigests(rows, Object.assign({ ask, now: F.NOW, pushData: (p) => pushes.push(p) }, o));
  const ns = () => store.load('notesStore', {});
  beforeEach(() => {
    asks = []; pushes = []; askImpl = async () => aiText();
    store.save('notesStore', { [F.UNIT_ID]: NS() });
  });

  it('generates once, caches, and regenerates only when the timeline changes', async () => {
    const r1 = F.row();
    const c1 = await run([r1]);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain('HISTORY DIGEST');
    expect(c1).toMatchObject({ checked: 1, generated: 1, cached: 0 });
    const d1 = ns()[F.UNIT_ID].timelineDigest;
    expect(d1.method).toBe('ai');
    expect(ns()[F.UNIT_ID].timeline).toBe(TIMELINE);   // raw timeline untouched
    expect(r1.timelineDigest).toEqual(d1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ partialMerge: true, _partial: 'timeline-digest' });
    expect(pushes[0].rows[0].timelineDigest).toEqual(d1);

    const r2 = F.row();
    const c2 = await run([r2]);
    expect(asks).toHaveLength(1);
    expect(c2).toMatchObject({ cached: 1, generated: 0 });
    expect(r2.timelineDigest).toEqual(d1);
    expect(pushes).toHaveLength(1);

    const s = ns(); s[F.UNIT_ID].timeline = s[F.UNIT_ID].timeline.replace('Estimate V1 approved.', 'Estimate V1 approved by fleet.');
    store.save('notesStore', s);
    await run([F.row()]);
    expect(asks).toHaveLength(2);

    const s2 = ns(); s2[F.UNIT_ID].timeline += '\n11/18 - Unit picked up by driver.';
    store.save('notesStore', s2);
    await run([F.row()]);
    expect(asks).toHaveLength(3);
    expect(ns()[F.UNIT_ID].timelineDigest.latestEntry).toBe('11/18 - Unit picked up by driver.');
  });

  it('a fallback digest is retried only after 60 minutes', async () => {
    askImpl = async () => { throw new Error('ai down'); };
    await run([F.row()]);
    expect(ns()[F.UNIT_ID].timelineDigest.method).toBe('fallback');
    askImpl = async () => aiText();
    await run([F.row()], { now: F.NOW + 30 * 60000 });
    expect(asks).toHaveLength(1);
    await run([F.row()], { now: F.NOW + 61 * 60000 });
    expect(asks).toHaveLength(2);
    expect(ns()[F.UNIT_ID].timelineDigest.method).toBe('ai');
  });

  it('<= 3 input lines -> verbatim digest without an AI call', async () => {
    store.save('notesStore', { [F.UNIT_ID]: { timeline: '09/23 - Work order created with Volvo.\n09/25 - Unit towed to M&K Dunmore.\n10/01 - Diagnosis complete.' } });
    await run([F.row({ offsiteStageHistory: [] })]);
    expect(asks).toHaveLength(0);
    const d = ns()[F.UNIT_ID].timelineDigest;
    expect(d.method).toBe('verbatim');
    expect(d.lines).toEqual(['09/23 - Work order created with Volvo.', '09/25 - Unit towed to M&K Dunmore.']);
  });

  it('respects maxUnits', async () => {
    const ids = ['TS9101', 'TS9102', 'TS9103'];
    store.save('notesStore', Object.fromEntries(ids.map((id) => [id, NS()])));
    const c = await run(ids.map((id) => F.row({ equipmentId: id })), { maxUnits: 2 });
    expect(asks).toHaveLength(2);
    expect(c).toMatchObject({ checked: 3, generated: 2, skipped: 1 });
  });
});

describe('notesStore -> row merge and archive', () => {
  const DG = { v: 1, sourceHash: 'abc', lines: ['09/25 - Unit towed to M&K Dunmore.'] };
  it('mergeRelayIntoRows carries timelineDigest / priorHistory, omits them for an active unit with no WR', () => {
    const notes = { [F.UNIT_ID]: { timeline: TIMELINE, timelineDigest: DG, priorHistory: F.PREV_TIMELINE } };
    const [down] = relay.mergeRelayIntoRows([{ equipmentId: F.UNIT_ID, lifecycleState: 'Unavailable' }], {}, notes);
    expect(down.timelineDigest).toEqual(DG);
    expect(down.priorHistory).toBe(F.PREV_TIMELINE);
    const [active] = relay.mergeRelayIntoRows([{ equipmentId: F.UNIT_ID, lifecycleState: 'Active', openUnplanned: '--', openPlanned: '--' }], {}, notes);
    expect('timelineDigest' in active).toBe(false);
    expect('priorHistory' in active).toBe(false);
    const [plain] = relay.mergeRelayIntoRows([{ equipmentId: 'X1', lifecycleState: 'Unavailable' }], {}, notes);
    expect('timelineDigest' in plain).toBe(false);
  });
  it('archiveAndClearTimeline archives priorHistory and clears the digest', () => {
    store.save('notesStore', { [F.UNIT_ID]: { timeline: TIMELINE, timelineDigest: DG, priorHistory: F.PREV_TIMELINE } });
    store.save('fleetData', { rows: [{ equipmentId: F.UNIT_ID, repairTimeline: TIMELINE }] });
    history.archiveAndClearTimeline(F.UNIT_ID);
    const u = store.load('notesStore', {})[F.UNIT_ID];
    expect(u.timeline).toBe('');
    expect('timelineDigest' in u).toBe(false);
    expect('priorHistory' in u).toBe(false);
    expect(u.timelineArchive.at(-1)).toMatchObject({ timeline: TIMELINE, priorHistory: F.PREV_TIMELINE });
  });
});
