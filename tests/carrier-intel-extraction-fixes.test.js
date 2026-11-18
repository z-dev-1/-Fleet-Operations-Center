// tests/carrier-intel-extraction-fixes.test.js — carrier-intel design B2.2: the Phase 1
// extraction fixes M1-M10, replayed from tests/fixtures/carrier-intel/m*.json (and the golden
// g1/g2 rows) through extractRelay -> buildFactSet / rowMirrors / refreshRowFacts,
// historyTrend and formatPmDate, as the validation report did. AC-1..AC-10 extraction halves.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const W = require('../src/repair-intel/wo-facts');
const WH = require('../src/repair-intel/wo-history');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const TODAY = '2026-11-17';

// Replay a fixture input through extractRelay -> buildFactSet -> rowMirrors.
function replay(sd, opts = {}, history = [], nowIso = '2026-11-17T17:27:23.000Z', today = TODAY) {
  const block = X.extractRelay(sd, Object.assign({}, opts, { history, now: Date.parse(nowIso) }));
  const row = { equipmentId: 'U', workRequestId: block.wr, relayFacts: block, relayFactsWr: block.wr, created: (sd.workRequest || {}).createdDateTime };
  const fset = W.buildFactSet(row, { today });
  return { block, row, fs: fset, m: W.rowMirrors(fset) };
}
const replayFx = (fx) => replay(fx.input.serviceDetail, fx.input.opts, fx.input.history || [], fx.now, fx.today);
const negKinds = (block) => block.facts.filter((f) => f.kind === 'etcMention' && f.negated)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.pos - b.pos).map((f) => f.etcKind);
const sdOf = (comments, wo = {}) => ({ id: 'svc-t', workRequest: { id: 'wr-t', createdBy: 'fasuser1', createdDateTime: '2026-11-03T19:49:42.684Z', comments },
  workOrders: [Object.assign({ id: 'wo-t', lineItems: [], comments: [] }, wo)] });
const cm = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });

describe('M1 bare "parts ordered" (AC-1)', () => {
  it('m1: partsStatus ordered with at least one part-status fact', () => {
    const fx = load('m1-cox-bare-parts-ordered.json');
    const r = replayFx(fx);
    expect(r.m.partsStatus).toBe(fx.expected.partsStatus);
    expect(r.block.facts.filter((f) => f.kind === 'partStatus').length).toBeGreaterThanOrEqual(fx.expected.partStatusFactsAtLeast);
  });
  it('the STATUS_NEG_RE guard still applies', () => {
    const r = replay(sdOf([cm('2026-11-05T12:00:00Z', 'COX', 'parts not yet ordered, parts ordered? no')]), { vendor: 'COX' });
    expect(r.block.facts.filter((f) => f.kind === 'partStatus')).toEqual([]);
  });
});

describe('M2 question guard and "we have received parts" (AC-2)', () => {
  it('m2: no fact from the FAS question; KWNE arrival; partsEta met 11/13', () => {
    const fx = load('m2-kwne-question-read-as-arrival.json');
    const r = replayFx(fx);
    const ps = r.block.facts.filter((f) => f.kind === 'partStatus');
    expect(ps.some((f) => f.author === fx.expected.noPartStatusFromAuthor)).toBe(false);
    expect(ps.map((f) => ({ value: f.value, author: f.author, at: f.at }))).toEqual(fx.expected.partStatus);
    expect(r.m.partsEta).toBe('');
    expect(r.m.partsStatus).toBe('arrived');
    expect(r.fs.etc.chainMetAt.parts).toBe(fx.expected.partsEtaMetAt);
    expect(r.fs.etc.partsEta).toEqual({ metAt: fx.expected.partsEtaMetAt });
    expect(r.fs.partsArrivedAt).toBe('2026-11-13T18:20:20.710Z');
  });
});

describe('M3 COX "no eta" kind (AC-3)', () => {
  const fx = load('m3-cox-no-eta-classified-tech-onsite.json');
  it('m3: all four negations on B62059 are partsArrival (template label never counts as a tech word)', () => {
    const r = replayFx(fx);
    expect(negKinds(r.block)).toEqual(fx.expected.negationKinds);
  });
  it('a short "Technician Notes: no eta" after the recorded arrival is partsArrival', () => {
    const r = replay(sdOf([cm('2026-11-06T12:00:00Z', 'COX', 'Technician Notes: no eta')]), { vendor: 'COX' }, fx.input.history);
    expect(negKinds(r.block)).toEqual(['partsArrival']);
  });
  it('"no eta on the second tech" after the arrival stays techOnsite', () => {
    const r = replay(sdOf([cm('2026-11-06T12:00:00Z', 'COX', 'no eta on the second tech')]), { vendor: 'COX' }, fx.input.history);
    expect(negKinds(r.block)).toEqual(['techOnsite']);
  });
  it('a non-COX "no eta for the tech" before any arrival stays techOnsite', () => {
    const r = replay(sdOf([cm('2026-11-03T21:00:00Z', 'Amerit', 'no eta for the tech')]), { vendor: 'Amerit' });
    expect(negKinds(r.block)).toEqual(['techOnsite']);
  });
  it('callers without opts keep the ±20-char rule', () => {
    const D = require('../src/repair-intel/wo-extract-dates');
    expect(D.findNegatedMentions('hood shocks. no eta').negated.map((n) => n.kind)).toEqual(['techOnsite']);
    expect(D.findNegatedMentions('hood shocks. no eta', { afterArrival: true }).negated.map((n) => n.kind)).toEqual(['partsArrival']);
  });
});

describe('M8 COX parts ETA restatements (AC-8 extraction half)', () => {
  it('m8: partsEta 11/16, arrival dates include 11/12 and 11/16, ordered, "in the morning" unparsed', () => {
    const fx = load('m8-cox-parts-eta-restatements-missed.json');
    const r = replayFx(fx);
    expect(r.m.partsEta).toBe(fx.expected.partsEta);
    const dates = r.block.facts.filter((f) => f.kind === 'etcMention' && f.etcKind === 'partsArrival' && f.value).map((f) => f.value);
    for (const d of fx.expected.partsArrivalDatesInclude) expect(dates).toContain(d);
    expect(r.m.partsStatus).toBe(fx.expected.partsStatus);
    const morning = r.block.facts.filter((f) => f.kind === 'etcMention' && f.at === '2026-11-17T04:04:24.902Z' && f.value);
    expect(morning).toEqual([]);
  });
  it('without a part-status phrase, "will be in Monday" stays unclassified', () => {
    const r = replay(sdOf([cm('2026-11-13T21:59:49.915Z', 'COX', 'the tech will be in Monday')]), { vendor: 'COX' });
    expect(r.block.facts.filter((f) => f.kind === 'etcMention' && f.value)).toEqual([]);
  });
});

describe('M4 Relay placeholders are not dealer names (AC-4)', () => {
  const fx = load('m4-dsp-entered-as-dealer-name.json');
  it('m4: dealerName / subVendor blank, no _factFilled.dealerName', () => {
    const row = W.refreshRowFacts(clone(fx.input.row), fx.input.flags, fx.today);
    expect(row.dealerName).toBe('');
    expect(row.subVendor).toBe('');
    expect(row._factFilled && row._factFilled.dealerName).toBeFalsy();
  });
  it('a row already carrying an own-filled DSP_ENTERED is cleared', () => {
    const r0 = Object.assign(clone(fx.input.row), { dealerName: 'DSP_ENTERED', subVendor: 'DSP_ENTERED', _factFilled: { dealerName: 'DSP_ENTERED' } });
    const row = W.refreshRowFacts(r0, fx.input.flags, fx.today);
    expect(row.dealerName).toBe('');
    expect(row.subVendor).toBe('');
    expect(row._factFilled && row._factFilled.dealerName).toBeFalsy();
  });
  it('a user / AAP dealerName is never cleared; every placeholder is rejected', () => {
    const row = W.refreshRowFacts(Object.assign(clone(fx.input.row), { dealerName: 'DSP_ENTERED' }), fx.input.flags, fx.today);
    expect(row.dealerName).toBe('DSP_ENTERED');
    for (const p of fx.placeholdersToReject.concat(['TBD', 'N/A', 'NONE', '--'])) {
      expect(W.PLACEHOLDER_RE.test(p)).toBe(true);
      const r2 = W.refreshRowFacts(Object.assign(clone(fx.input.row), { suppliers: p }), fx.input.flags, fx.today);
      expect(r2.dealerName).toBe('');
    }
  });
});

describe('M5 estimate subtotals (AC-5)', () => {
  it('m5: one version of 10977.48, approved; history trend has one revision', () => {
    const fx = load('m5-estimate-subtotals-counted-as-versions.json');
    const r = replayFx(fx);
    expect(r.m.estimateVersion).toBe(fx.expected.estimateVersion);
    expect(r.fs.estimate.versions.map((v) => v.amount)).toEqual(fx.expected.versionAmounts);
    expect(r.m.estimateStatus).toBe(fx.expected.estimateStatus);
    expect(r.m.estimateApprovedAmount).toBe(fx.expected.estimateApprovedAmount);
    expect(r.fs.estimate.approvedAfterReject).toBe(fx.expected.rejectedThenApproved);
    expect(r.block.historyTrend.estimate.revisions.map((x) => x.to)).toEqual([10977.48]);
  });
  it('COST details that do not sum to one of them are all kept', () => {
    const det = [100, 200, 250].map((v) => ({ field: 'Estimate', oldValue: null, newValue: String(v), displayType: 'COST' }))
      .concat([{ field: 'State', oldValue: 'A', newValue: 'B', displayType: 'ENUM_TEXT' }]);
    expect(WH.collapseCostDetails(det)).toEqual(det);
    const log = { serviceEntityId: 'wo-t', eventDateTime: '2026-11-12T19:29:12.725Z', requester: 'COX', operation: 'EDIT', message: 'Work order edited', serviceChangeDetails: det };
    const t = WH.historyTrend([log], { classify: (q) => X.classifyRelayAuthor(q), now: Date.parse('2026-11-17T17:00:00Z') });
    expect(t.estimate.revisions.map((x) => x.to)).toEqual([100, 200, 250]);
    const r = replay(sdOf([]), { vendor: 'COX' }, [log]);
    expect(r.fs.estimate.versions.map((v) => v.amount)).toEqual([100, 200, 250]);
  });
});

describe('M6 calendar-day ETC moves (AC-6 extraction half)', () => {
  const fx = load('m6-slip-count-counts-subday-retimes.json');
  const trend = (logs) => WH.historyTrend(logs, { classify: (q) => X.classifyRelayAuthor(q), now: Date.parse('2026-11-17T17:00:00Z') });
  for (const unit of ['B12195', 'B13340']) {
    it(unit + ': raw slipCount kept, day counts added', () => {
      const e = trend(fx.input[unit]).etc;
      const exp = fx.expected[unit];
      expect({ slipCount: e.slipCount, daySlipCount: e.daySlipCount, dayPullInCount: e.dayPullInCount, sameDayRetimes: e.sameDayRetimes }).toEqual(exp);
    });
  }
  it('TREND_VERSION stays 1', () => { expect(WH.TREND_VERSION).toBe(1); expect(trend(fx.input.B12195).v).toBe(1); });
});

describe('M7 need-by default mirrored as repairEtc (AC-7)', () => {
  const fx = load('m7-needby-default-mirrored-as-repair-etc.json');
  const flags = { enabled: true, aiOutput: true };
  const rowFor = (sd, history = []) => {
    const r = replay(sd, fx.input.opts, history, fx.now, fx.today);
    return { r, row: W.refreshRowFacts(Object.assign({}, r.row), flags, fx.today) };
  };
  it('m7: repairEtc / repairEtcSource blank, counted none', () => {
    const { r, row } = rowFor(fx.input.serviceDetail);
    expect(r.m.repairEtc).toBe(fx.expected.repairEtc);
    expect(r.m.repairEtcSource).toBe(fx.expected.repairEtcSource);
    expect(row.repairEtc).toBe('');
    expect(row._factEtc.state).toBe(fx.expected['_factEtc.state']);
    expect(r.fs.structEtc).toEqual({ date: '2026-10-27', valueMs: Date.parse('2026-10-27T19:50:40.200Z') });
    expect(r.fs.wrNeedByMs).toBe(Date.parse('2026-10-27T19:55:17.852Z'));
    expect(r.fs.etcRestated).toBe(false);
  });
  it('negative: a vendor history restatement to the same date keeps repairEtc mirrored', () => {
    const hist = [{ serviceEntityId: 'wo-b12258', eventDateTime: '2026-10-27T19:52:00.000Z', requester: 'KWNE', operation: 'EDIT', message: 'Work order edited',
      serviceChangeDetails: [{ field: 'Expected completion date time', oldValue: null, newValue: '2026-10-27T19:52:00Z', displayType: 'DATE_TIME' }] }];
    const { r } = rowFor(fx.input.serviceDetail, hist);
    expect(r.fs.etcRestated).toBe(true);
    expect(r.m.repairEtc).toBe('2026-10-27');
  });
  it('negative: a structured ETC 2 h from wrNeedBy stays mirrored', () => {
    const sd = clone(fx.input.serviceDetail);
    sd.workOrders[0].expectedCompletionDateTime = '2026-10-27T17:55:17.852Z';
    const { r } = rowFor(sd);
    expect(r.m.repairEtc).toBe('2026-10-27');
    expect(r.m.repairEtcSource).not.toBe('');
  });
});

describe('M9 pmOverdue without pmSchedule (AC-9)', () => {
  const fx = load('m9-pm-overdue-missing-without-schedule.json');
  const clean = (row) => { const r = clone(row); for (const k of Object.keys(r)) if (r[k] === '(absent)') delete r[k]; return r; };
  const want = { B12259: 'DOT 7d', B13127: 'DOT 6d', B12268: 'PM B 10d', B12343: 'PM B 2d' };
  for (const row0 of fx.input.rows) {
    it(row0.equipmentId + ': ' + want[row0.equipmentId], () => {
      const row = W.refreshRowFacts(clean(row0), { enabled: true }, fx.today);
      expect(row.pmOverdue).toContain(want[row0.equipmentId]);
      const over = W.pmOverdueList(clean(row0), fx.today).filter((e) => e.overdueDays > 0).map((e) => ({ type: e.type, due: e.due, overdueDays: e.overdueDays }));
      expect(over).toEqual(fx.expected[row0.equipmentId].overdue);
    });
  }
  it('month-only dues are overdue only after the month ends', () => {
    expect(W.pmOverdueList({ quarterlyLiftDue: 'Nov 2026' }, '2026-11-30')[0]).toMatchObject({ type: 'QUARTERLY_LIFT', due: '2026-11-30', overdueDays: null });
    expect(W.pmOverdueList({ quarterlyLiftDue: 'Oct 2026' }, TODAY)[0]).toMatchObject({ due: '2026-10-31', overdueDays: 17 });
    expect(W.pmOverdueList({ dotDue: 'Nov 10, 2026' })).toEqual([]);
  });
  // Pre-fix formatter, kept here to prove schedule rows are byte-identical.
  const PM_SHORT = { PM_A: 'PM A', PM_B: 'PM B', PM_X: 'PM X', WASH: 'Wash', DOT: 'DOT', APU: 'APU', SVR: 'SVR', STATE_DOT: 'State insp',
    STATE: 'State insp', R360_HANDOFF_INSPECTION: 'R360', QUARTERLY_LIFT: 'Lift', SEMIANNUAL_LIFT: 'Lift' };
  const legacy = (schedule) => {
    const list = (Array.isArray(schedule) ? schedule : []).filter((e) => e && Number(e.overdueDays) > 0).sort((a, b) => Number(b.overdueDays) - Number(a.overdueDays));
    let out = '';
    for (const p of list.map((e) => (PM_SHORT[e.type] || String(e.label || e.type)) + ' ' + Number(e.overdueDays) + 'd')) { const n = out ? out + '; ' + p : p; if (n.length > 120) break; out = n; }
    return out;
  };
  for (const g of ['g1-b12195-cox-parts-hold.json', 'g2-b13014-accident-dsp-hold.json', 'g3-b62064-impound-dsp-hold.json']) {
    it(g + ': rows with pmSchedule keep a byte-identical pmOverdue', () => {
      const row0 = load(g).row;
      expect(Array.isArray(row0.pmSchedule) && row0.pmSchedule.length).toBeTruthy();
      const row = W.refreshRowFacts(clone(row0), { enabled: true, aiOutput: true }, TODAY);
      expect(row.pmOverdue).toBe(legacy(row0.pmSchedule));
    });
  }
});

describe('golden rows no longer reproduce M1 / M3 / M4', () => {
  // Rebuild the WR comments from the stored conversation ('MM/DD - Author: text').
  const commentsOf = (conv) => String(conv).replace(/^Conversation\n/, '').split(/\n(?=\d{2}\/\d{2} - )/).map((s, i) => {
    const m = /^(\d{2})\/(\d{2}) - ([^:]+): ([\s\S]*)$/.exec(s);
    return m ? cm('2026-' + m[1] + '-' + m[2] + 'T12:00:' + String(i).padStart(2, '0') + '.000Z', m[3], m[4]) : null;
  }).filter(Boolean);
  it('g1 B12195: partsStatus ordered; no-eta negations after the arrival are partsArrival', () => {
    const g1 = load('g1-b12195-cox-parts-hold.json');
    const hist = [{ serviceEntityId: 'wo-b12195', eventDateTime: '2026-11-09T07:18:47.000Z', requester: 'COX', operation: 'EDIT', message: 'Work order edited',
      serviceChangeDetails: [{ field: 'Actual technician arrival date time', oldValue: null, newValue: '2026-11-09T07:18:47Z', displayType: 'DATE_TIME' }] }];
    const sd = { id: 'svc-b12195', workRequest: { id: 'wr-b12195', createdBy: 'fasuser1', createdDateTime: g1.row.created, comments: commentsOf(g1.row.fullConversation) }, workOrders: [] };
    const r = replay(sd, { vendor: 'COX' }, hist, '2026-11-17T17:27:23.000Z', g1.today);
    expect(r.m.partsStatus).toBe('ordered');
    const kinds = negKinds(r.block);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === 'partsArrival')).toBe(true);
  });
  it('g2 B13014: dealerName / subVendor blank after refreshRowFacts', () => {
    const g2 = load('g2-b13014-accident-dsp-hold.json');
    const row = W.refreshRowFacts(clone(g2.row), { enabled: true, aiOutput: true }, g2.today);
    expect(row.dealerName).toBe('');
    expect(row.subVendor).toBe('');
    expect(row._factFilled && row._factFilled.dealerName).toBeFalsy();
  });
});
