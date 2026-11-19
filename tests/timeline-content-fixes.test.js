// tests/timeline-content-fixes.test.js — FEAT-001 timeline content fixes: meta-line cleaning,
// gap reconcile against real event days, pre-WR history carry-forward, gate-drop restore when the
// self-review is skipped (f), the batch-loop result (g), and output-layer sharing redaction in
// both twins and SharePoint column K (e).
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import * as fx from './fixtures/jobs-deep-scan-fixture.js';
import * as S from './fixtures/extract/deep-scan-output-shape.js';
import * as T from './fixtures/timeline-summary-fixture.js';
import { redactForSharing as redactTwin } from '../renderer/src/js/util/redact.js';
const require = createRequire(import.meta.url);

fx.installStubs();
const ds = require('../src/orcha/deep-scan');
const TT = require('../src/orcha/timeline-text');
const { redactForSharing: redactMain } = require('../src/orcha/redact_sharing');
const sp = require('../src/scrapers/sharepoint_push');

const lines = (t) => String(t || '').split('\n');
const NOWD = new Date(T.NOW);

describe('cleanTimelineMeta', () => {
  it('drops Next: / (AI unavailable) lines and strips a trailing Next: tail', () => {
    const out = TT.cleanTimelineMeta([
      '10/22 - ETC missed; dealer revised ETC 10/24. Next: chase dealer.',
      '10/23 - Next: chase dealer for revised ETC.',
      '11/05 - (AI unavailable) Scheduled Next: follow up with dealer.',
      '11/06 - Scheduled Next: call dealer.',
    ].join('\n'));
    expect(lines(out)).toEqual(['10/22 - ETC missed; dealer revised ETC 10/24.']);
  });
  it('drops CONFLICT / PM-overdue / status-field clauses and lines left empty', () => {
    const out = TT.cleanTimelineMeta([
      '10/24 - Parts arrived. CONFLICT: ETR 10/24 vs 10/26.',
      '10/24 - CONFLICT: ETR 10/24 vs 10/26 per internal log.',
      '10/25 - PM A is 311 days overdue; recommend scheduling.',
      '10/26 - Status field still shows Waiting.',
      '10/27 - [Planned] PM-B status noted.',
    ].join('\n'));
    expect(lines(out)).toEqual(['10/24 - Parts arrived.', '10/25 - recommend scheduling.']);
    expect(out).not.toMatch(/conflict|overdue|status field/i);
  });
  it('keeps real PM events, the [em:] marker, undated lines; normalizes plain gaps', () => {
    const keep = ['(earlier history trimmed)', '10/21 - Dealer: PM-B to be done when tech reassigned.', '10/29 - [Planned] PM B service scheduled.', '10/28 - Dealer update logged. [em:0a1b2c3d]'];
    expect(TT.cleanTimelineMeta(keep.join('\n'))).toBe(keep.join('\n'));
    expect(TT.cleanTimelineMeta('10/27 - Dealer called back. Next: confirm ETC. [em:0a1b2c3d]')).toBe('10/27 - Dealer called back. [em:0a1b2c3d]');
    expect(TT.cleanTimelineMeta('10/10-10/14 - No update logged.')).toBe('10/10-10/14 - [no update logged]');
    expect(TT.cleanTimelineMeta('10/09 - no activity logged')).toBe('10/09 - [no update logged]');
  });
});

describe('reconcileGapRanges', () => {
  it('splits a range around source event days; no run covers an event day; 1-day runs dropped', () => {
    const text = ['10/14 - Parts ETA confirmed.', '10/15-10/25 - [no update logged]', '10/26 - Dealer update.'].join('\n');
    const out = TT.reconcileGapRanges(text, ['10/16', '10/19'], NOWD);
    expect(lines(out)).toEqual(['10/14 - Parts ETA confirmed.', '10/17-10/18 - [no update logged]', '10/20-10/25 - [no update logged]', '10/26 - Dealer update.']);
  });
  it('drops a range or a single-day gap that sits on event days; keeps an event-free single day normalized', () => {
    const text = ['10/16 - Parts arrived.', '10/16-10/17 - [no update logged]', '10/17 - Dealer update.', '10/16 - [no update logged]', '10/20 - No update logged.'].join('\n');
    expect(lines(TT.reconcileGapRanges(text, [], NOWD))).toEqual(['10/16 - Parts arrived.', '10/17 - Dealer update.', '10/20 - [no update logged]']);
  });
});

describe('sourceEventMds', () => {
  it('takes line-start dates only and maps a UTC ISO stamp to the local day', () => {
    const mds = TT.sourceEventMds(T.row({ fullConversation: T.CONV + '\nnote: dealer said 10/30 maybe' }), NOWD);
    const utc = new Date(Date.UTC(2026, 9, 20, 0, 36));
    const local = String(utc.getMonth() + 1).padStart(2, '0') + '/' + String(utc.getDate()).padStart(2, '0');
    expect(mds).toEqual(expect.arrayContaining(['09/23', '09/29', '10/16', '10/19', local, '10/04']));
    expect(mds).not.toContain('10/30');
    expect(mds).not.toContain('10/21');
    expect(new Set(mds).size).toBe(mds.length);
  });
  it('never throws on missing fields', () => {
    expect(TT.sourceEventMds(null)).toEqual([]);
    expect(TT.sourceEventMds({ _secondaryWRs: [null, {}] })).toEqual([]);
  });
});

describe('carryPriorHistory', () => {
  const base = { prevTimeline: T.PREV_TIMELINE + '\n09/23 - Work order created.', prevPrior: '', newTimeline: T.LONG_TIMELINE, createdIso: T.CREATED, now: NOWD };
  it('carries lines dated before the WR created day, chronologically', () => {
    expect(TT.carryPriorHistory(base)).toBe(T.PREV_TIMELINE);
  });
  it('excludes lines already in the new timeline or hidden; dedupes against prevPrior', () => {
    expect(TT.carryPriorHistory({ ...base, newTimeline: '06/15 - Unit checked in at M&K Dunmore (ASIST case 975426).' })).toBe(lines(T.PREV_TIMELINE)[1]);
    expect(TT.carryPriorHistory({ ...base, hiddenEntries: ['08/31 - Dealer: parts ordered for air dryer; awaiting arrival.'] })).toBe(lines(T.PREV_TIMELINE)[0]);
    expect(TT.carryPriorHistory({ ...base, prevPrior: '05/02 - Older repair closed.\n' + lines(T.PREV_TIMELINE)[0] })).toBe('05/02 - Older repair closed.\n' + T.PREV_TIMELINE);
  });
  it('honours the cap (newest kept) and returns prevPrior on an unparseable created date', () => {
    expect(TT.carryPriorHistory({ ...base, max: 1 })).toBe(lines(T.PREV_TIMELINE)[1]);
    expect(TT.carryPriorHistory({ ...base, prevPrior: 'kept as is', createdIso: 'not a date' })).toBe('kept as is');
  });
});

describe('(f) gate-dropped line restored when the self-review is skipped', () => {
  beforeEach(() => { fx.resetRecorders(); vi.useFakeTimers({ toFake: ['Date'], now: S.NOW }); });
  afterEach(() => { vi.useRealTimers(); });
  const PRIOR = '11/02 - Dealer moved repair to Waiting.';
  const DRAFT = ['09/23 - Work order created with Volvo for harness repair. Unit waiting for vendor.', '11/02 - Dealer quoted Part #85152799 instead.', '11/03 - [Unplanned] Unit in bay; diagnosis started.'];
  const run = (notes, tlRun, onDraft) => ds._processUnit(S.unitRow(), notes, async () => { if (onDraft) onDraft(); return { ok: true, text: S.draftText(DRAFT) }; }, tlRun);
  const flags = { enabled: true, aiOutput: true, reviewRounds: 1, reviewMaxPerRun: 200 };
  it('budget skip: the prior 11/02 line comes back and tlGate.restored = 1', async () => {
    const r = await run({ 39582: { timeline: PRIOR } }, { flags, budget: { left: 0 } });
    expect(r.tlGate.reviewSkipped).toBe('budget');
    expect(lines(r.timeline)).toContain(PRIOR);
    expect(r.timeline).not.toContain('85152799');
    expect(r.tlGate.restored).toBe(1);
  });
  it('deadline skip: same restore', async () => {
    const r = await run({ 39582: { timeline: PRIOR } }, { flags, budget: { left: 5 } }, () => vi.setSystemTime(S.NOW + ds.TL_DEADLINE_MS));
    expect(r.tlGate.reviewSkipped).toBe('deadline');
    expect(lines(r.timeline)).toContain(PRIOR);
    expect(r.tlGate.restored).toBe(1);
  });
  it('no prior timeline: nothing restored and no restored key', async () => {
    const r = await run({}, { flags, budget: { left: 0 } });
    expect(lines(r.timeline)).not.toContain(PRIOR);
    expect('restored' in r.tlGate).toBe(false);
  });
});

describe('(g) batch loop: stored and row timeline are cleaned; prior WR history carried', () => {
  beforeEach(() => { fx.resetRecorders(); vi.useFakeTimers({ toFake: ['Date'], now: T.NOW }); });
  afterEach(() => { vi.useRealTimers(); });
  it('no plain gap, no gap over 10/16, no Next:/CONFLICT/PM-overdue; priorHistory = PREV_TIMELINE', async () => {
    fx.rec.store.set('notesStore', { [T.UNIT_ID]: { timeline: T.PREV_TIMELINE, manualEntries: T.MANUAL_ENTRIES.slice() } });
    fx.rec.relayImpl = async () => T.draftText(T.LONG_TIMELINE_LINES);
    const rows = [T.row()];
    await ds.runOrchaDeepScan(rows, { pushData: () => {}, pushStatus: () => {}, payload: {}, force: true });
    const ns = fx.rec.store.get('notesStore')[T.UNIT_ID];
    for (const tl of [ns.timeline, rows[0].repairTimeline]) {
      expect(tl).toContain('10/16 - Parts arrived at M&K Dunmore.');
      expect(tl).not.toMatch(/(^|\n)[^\n]*- No update logged/);
      expect(tl).not.toMatch(/next\s*:|conflict|overdue|AI unavailable/i);
      for (const l of lines(tl)) {
        const m = /^(\d{2})\/(\d{2})-(\d{2})\/(\d{2}) - \[no update logged\]$/.exec(l);
        if (m) expect(m[1] + m[2] <= '1016' && m[3] + m[4] >= '1016').toBe(false);
      }
      expect(tl).toContain('10/19 - Called M&K Dunmore; air dryer install in progress.');
    }
    expect(ns.manualEntries).toEqual(T.MANUAL_ENTRIES);
    expect(ns.priorHistory).toBe(T.PREV_TIMELINE);
    expect(rows[0].priorHistory).toBe(T.PREV_TIMELINE);
    expect(ns.timeline).not.toContain('06/15');
  });
  it('a unit with nothing to carry gets no priorHistory key', async () => {
    fx.rec.store.set('notesStore', {});
    fx.rec.relayImpl = async () => T.draftText(T.LONG_TIMELINE_LINES);
    const rows = [T.row()];
    await ds.runOrchaDeepScan(rows, { pushData: () => {}, pushStatus: () => {}, payload: {}, force: true });
    expect('priorHistory' in fx.rec.store.get('notesStore')[T.UNIT_ID]).toBe(false);
    expect('priorHistory' in rows[0]).toBe(false);
  });
});

describe('(e) sharing redaction: both twins and SharePoint column K', () => {
  const text = T.LONG_TIMELINE + '\n10/20 - Dealer confirmed install (per Uptime Center email 10/20).';
  const check = (out) => {
    expect(out).not.toContain('Christy Adriaansen');
    expect(out).not.toContain('Santiago, Z');
    expect(out).not.toContain('$4,210.30');
    expect(out).not.toContain('$');
    for (const k of ['M&K Dunmore', 'Volvo', 'ASIST case 975426', 'Uptime', 'per Uptime Center email']) expect(out).toContain(k);
  };
  it('main and renderer twins give identical output, whole text and per line', () => {
    expect(redactTwin(text)).toBe(redactMain(text));
    for (const l of lines(text)) expect(redactTwin(l)).toBe(redactMain(l));
    check(redactMain(text));
    check(lines(text).map(redactMain).join('\n'));
    expect(redactMain(lines(T.LONG_TIMELINE)[3])).toBe('10/02 - M&K Dunmore (Service Advisor) submitted estimate V1; internal approval pending.');
  });
  it('SharePoint column K is the per-line sharing redaction; stored row text untouched', () => {
    const unit = { ...T.row(), repairTimeline: text };
    const k = sp.buildRowValues(unit).values[10];
    expect(k).toBe(lines(text).map((l) => redactMain(l)).join('\n'));
    expect(lines(k)).toHaveLength(lines(text).length);
    check(k);
    expect(unit.repairTimeline).toBe(text);
  });
});
