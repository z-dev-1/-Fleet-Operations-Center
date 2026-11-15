// tests/dbr-fas-evidence.test.js — AC44 / AC45 (relay-extract output fix B, D6 + D7): FAS-authored
// fleet_notes lines reach the draft in a protected segment and ground their dates; units without a
// [FAS] line lead with status + next step; the per-clause FAS-claim check is unchanged.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const G = require('../src/dbr/fleet-dbr-gate');
const EV = require('../src/dbr/fleet-dbr-evidence');
const AI = require('../src/dbr/fleet-dbr-ai');
const W = require('../src/repair-intel/wo-facts');
const O = require('../src/repair-intel/wo-fact-output');
const R5 = require('./fixtures/extract/dbr-roc5-fas');

const N = { yn: 'N', details: [] };
function evidences(fx) {
  const built = F.buildFleetDbr(fx.rows, { today: fx.TODAY });
  const row = built.rows.find((r) => r.key === 'ROC5|AUVTE');
  const byId = new Map(fx.rows.map((r) => [r.equipmentId, r]));
  return { built, row, evs: row.units.map((u) => EV.buildUnitEvidence(byId.get(u.id), u, fx.enrich[u.id] || {}, fx.TODAY, fx.FAS_NAMES, '')) };
}
const seg = (ev, kind) => ev.segments.find((s) => s.kind === kind);

describe('AC44 FAS action from fleet_notes is grounded', () => {
  const fx = R5.build({ filler: 4000 });
  const { evs } = evidences(fx);
  const out = EV.allocate(evs, 36000 / 2);
  const byId = (id) => out.find((e) => e.id === id);

  it('after allocate trims the 10-unit row, R0001 keeps its [FAS] line in "FAS actions logged (newest first):"', () => {
    expect(out.some((e, i) => e.text().length < evs[i].text().length)).toBe(true);
    const e = byId('R0001');
    expect(e.text()).toContain('FAS actions logged (newest first):\n[FAS] 11/10 - Called TA, tech ETA 11/12');
    expect(e.fasDates.has('11/10')).toBe(true);
    expect(e.fasLines.length).toBeGreaterThan(0);
  });
  it('the FAS-authored conversation unit is in fasLog (identity match); the [em:]-only unit is [email], never [FAS]', () => {
    expect(seg(byId('R0002'), 'fasLog').lines[0].text).toMatch(/^\[FAS\] 11\/09 - Z Santiago: emailed TA/);
    const e3 = byId('R0003');
    expect(seg(e3, 'fasLog')).toBeUndefined();
    expect(e3.text()).toContain('[email] 11/10 - TA confirmed bay');
    expect(e3.text()).not.toContain('[FAS]');
    expect(e3.fasLines).toEqual([]);
  });
  it('a unit with no FAS-authored line has no fasLog segment', () => {
    expect(seg(byId('R0004'), 'fasLog')).toBeUndefined();
  });
});

describe('AC44 / AC45 through draftRow', () => {
  const fx = R5.build();
  const { built, row } = evidences(fx);
  const run = async (fasActions) => {
    const prompts = [];
    const ask = async (p) => { prompts.push(p); return JSON.stringify({ barriers: { vendor1p: N, oem: N, estimate: N, partner: N, parts: N, common: N }, etc: [], fasActions, support: 'None' }); };
    const r = await AI.draftRow({ row, unitRows: fx.rows, built, ask, enrich: fx.enrich, fasNames: fx.FAS_NAMES, fleetIds: [], today: fx.TODAY, reviewRounds: 0 });
    return { r, prompts, line: (id) => r.cells.fasActions.split('\n').find((l) => l.startsWith('\u2022 ' + id + ': ')) };
  };

  it('the grounded entry renders with its date; a planted FAS claim without a [FAS] line is dropped', async () => {
    const { r, line } = await run([
      { unit: 'R0001', text: '11/10 called TA, tech ETA 11/12; next: confirm tech arrival', src: { fas: [{ date: '11/10', quote: 'Called TA, tech ETA 11/12' }] } },
      { unit: 'R0005', text: '11/09 escalated to MCS; next: follow up' },
    ]);
    expect(r.ok).toBe(true);
    expect(line('R0001')).toBe('\u2022 R0001: 11/10 called TA, tech ETA 11/12; next: confirm tech arrival');
    expect(line('R0001')).not.toContain('No FAS action logged');
    expect(r.dropReasons['unfounded-fas-action']).toBe(1);
  });
  it('AC45: a vendor-only unit\'s status-first entry without src is kept; "No FAS action logged; …" still accepted', async () => {
    const t = 'Waiting on EGR cooler; Dealer update 11/11: ETC 11/08 missed; next: call dealer for a new ETC.';
    const { r, prompts, line } = await run([
      { unit: 'R0004', text: t },
      { unit: 'R0006', text: 'No FAS action logged; TA update 11/09: waiting on parts; next: call TA' },
    ]);
    expect(line('R0004')).toBe('\u2022 R0004: ' + t);
    expect(line('R0006')).toBe('\u2022 R0006: No FAS action logged; TA update 11/09: waiting on parts; next: call TA');
    expect(r.dropReasons).toEqual({});
    expect(prompts[0]).toContain(AI.FAS_RULE);
    expect(prompts[0]).toContain("do not start with 'No FAS action logged'");
    expect(prompts[0]).not.toContain('start "No FAS action logged;"');
  });
  it('Q-FAS asks for the status-first form', () => {
    const fsx = W.buildFactSet({}, { today: fx.TODAY });
    const q = O.buildQuestions(fsx, { consumer: 'dbr', today: fx.TODAY }).find((x) => x.id === 'Q-FAS');
    expect(q.text).toContain('lead with the current status and a concrete next step');
  });
});

describe('AC44 budget floor (24 units)', () => {
  const TODAY = '2026-11-11';
  const long = (s, n) => (s + ' ').repeat(Math.ceil(n / (s.length + 1))).slice(0, n).trim();
  const mk = (i) => {
    const id = 'F' + String(10000 + i);
    const raw = {
      equipmentId: id, vendor: long('Mid Atlantic Heavy Truck Service', 120), savedRepairStatus: long('Waiting for vendor', 120),
      lifecycleReason: long('Offsite Shop Repair', 120), subVendor: long('Sub vendor shop', 120), serviceState: long('In repair', 120),
      delayReasonCodes: long('Tech shortage', 120), vendorWorkOrderId: long('WO-1234567', 150), workRequestId: long('WR-7654321', 150),
      repairTimeline: Array.from({ length: 30 }, (_, k) => '10/' + (k + 1) + ' - Vendor: ' + long('status update from the shop', 120)).join('\n'),
      fullConversation: 'Conversation\n' + [5, 7, 9].map((d) => '11/0' + d + ' - Z Santiago: called the shop ' + long('about the repair status', 600)).join('\n'),
    };
    return EV.buildUnitEvidence(raw, { id, daysDown: 20, barriers: [] }, {}, TODAY, ['Z Santiago'], '');
  };
  const evs = Array.from({ length: 24 }, (_, i) => mk(i));

  it('after allocate(evs, 36000) every block keeps >= 1 fasLog line, "[FAS] M/D - ", <= 160 chars, date grounded', () => {
    for (const e of evs) expect(e.text().length).toBeGreaterThan(1500);
    const out = EV.allocate(evs, 36000);
    for (const e of out) {
      const s = seg(e, 'fasLog');
      expect(s && s.lines.length).toBeGreaterThanOrEqual(1);
      expect(s.lines[0].text).toMatch(/^\[FAS\] \d{1,2}\/\d{1,2} - /);
      expect(s.lines[0].text.length).toBeLessThanOrEqual(160);
      expect(e.fasDates.has(s.lines[0].entryMd)).toBe(true);
      expect(e.fasLines.length).toBeGreaterThanOrEqual(1);
    }
  });
  it('at the MIN_BLOCK floor exactly 1 fasLog line of >= 60 chars survives, overrun <= 100 chars', () => {
    const t = EV.trimEvidence(evs[0], EV.MIN_BLOCK);
    const s = seg(t, 'fasLog');
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0].text.length).toBeGreaterThanOrEqual(60);
    expect(t.text().length).toBeLessThanOrEqual(EV.MIN_BLOCK + 100);
    expect(t.fasDates.has(s.lines[0].entryMd)).toBe(true);
  });
  it('a unit with no FAS-authored line has no fasLog segment', () => {
    const e = EV.buildUnitEvidence({ equipmentId: 'V1', vendor: 'TA', repairTimeline: '11/09 - TA: waiting' }, { id: 'V1' }, {}, TODAY, ['Z Santiago'], '');
    expect(seg(e, 'fasLog')).toBeUndefined();
  });
});
