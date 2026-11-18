// tests/carrier-intel-facts.test.js — carrier-intel design B3 / B6.2 / B6.4: unit records,
// rendering, roll-up, compliance. AC-17c, AC-17d, AC-17e, AC-17f, AC-17h, AC-8b, the AC-6 and
// AC-8 Carrier-Intel halves (plan D5), etc.by mapping, single ETA phrase, arrival basis.
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
const F = require('../src/dbr/fleet-dbr');
const EV = require('../src/dbr/fleet-dbr-evidence');
const Fx = require('../src/carrier-intel/facts');
const Tx = require('../src/carrier-intel/taxonomy');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const TODAY = '2026-11-17';
const DAY_NO_SPACE_RE = /\d(?:\.\d+)?d\b/;
const g1 = () => load('g1-b12195-cox-parts-hold.json').row;
const g2 = () => load('g2-b13014-accident-dsp-hold.json').row;
const g3 = () => load('g3-b62064-impound-dsp-hold.json').row;
const recOf = (row, opts) => Fx.unitRecord(row, {}, W.buildFactSet(row, { today: TODAY }), TODAY, 'America/New_York', opts);
const lineOf = (text, prefix) => text.split('\n').find((l) => l.startsWith(prefix));

function replay(sd, opts = {}, history = [], nowIso = '2026-11-17T17:27:23.000Z') {
  const block = X.extractRelay(sd, Object.assign({}, opts, { history, now: Date.parse(nowIso) }));
  const row = { equipmentId: 'U1', vendor: opts.vendor || 'COX', lifecycleReason: 'Damaged-Moderate', workRequestId: block.wr,
    relayFacts: block, relayFactsWr: block.wr, created: (sd.workRequest || {}).createdDateTime };
  return { row, fs: W.buildFactSet(row, { today: TODAY }) };
}
const sdOf = (comments) => ({ id: 'svc-t', workRequest: { id: 'wr-t', createdBy: 'fasuser1', createdDateTime: '2026-11-03T19:49:42.684Z', comments },
  workOrders: [{ id: 'wo-t', lineItems: [], comments: [] }] });
const cm = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });

// AUVTE fixture fleet (built by tests/fixtures/carrier-intel/build-auvte-fleet.cjs).
const fleet = load('auvte-scac-rows.json');
const fleetRow = (id) => fleet.rows.find((r) => r.equipmentId === id);
const fleetRecords = () => fleet.rows.filter(F.isDown).map((r) => recOf(r));

describe('formatting helpers', () => {
  it('fmtDays writes a space before d; md is unpadded', () => {
    expect(Fx.fmtDays(8.5)).toBe('8.5 d');
    expect(Fx.fmtDays(306)).toBe('306 d');
    expect(Fx.fmtDays(7)).toBe('7 d');
    expect(Fx.md('2026-09-04')).toBe('9/4');
    expect(Fx.md('2026-11-07T20:54:59.851Z')).toBe('11/7');
    expect(Fx.md('2026-11-03T00:11:33.904Z')).toBe('11/2');
    expect(Fx.md('')).toBe('');
  });
});

describe('AC-17c days down', () => {
  it('g3 -> null; workDuration and wrCreatedAt rules', () => {
    expect(Fx.daysDownFrac(g3(), TODAY)).toBeNull();
    expect(Fx.daysDownFrac({ workDuration: '8d 12h' }, TODAY)).toBe(8.5);
    expect(Fx.daysDownFrac({ workDuration: '8d 10h 28m' }, TODAY)).toBe(8.4);
    expect(Fx.daysDownFrac({ relayFacts: { wrCreatedAt: '2026-11-07T15:00:00Z' } }, TODAY)).toBe(10);
    expect(Fx.daysDownFrac({ created: '11/7/2026' }, TODAY)).toBe(10);
    expect(Fx.renderRecord(recOf(g3()))).toContain('down: unknown (no open WR / no WR date)');
  });
  it('roll-up counts B62064 as down, excludes it from unit-days and shares, and names it', () => {
    const recs = fleetRecords();
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: fleet.rows.length, uptime: 75.9 } });
    expect(countBy.get('down')).toBe(7);
    expect(countBy.get('impound')).toBe(1);
    expect(countBy.get('daysUnknown')).toBe(1);
    expect(text).toContain('days down unknown: B62064 (no open WR / no WR date)');
    const split = lineOf(text, 'down-cause split: ');
    expect(split).toContain('impound 1 unit (days unknown)');
    const known = recs.filter((r) => r.daysDown != null);
    const total = known.reduce((s, r) => s + r.daysDown, 0);
    const ph = recs.filter((r) => r.cause === 'parts-hold').reduce((s, r) => s + r.daysDown, 0);
    expect(split).toContain('parts-hold 4 units ' + ph.toFixed(1) + ' unit-days (' + Math.round((ph / total) * 100) + '%)');
    const shares = [...split.matchAll(/\((\d+)%\)/g)].map((m) => +m[1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(99);
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(101);
  });
});

describe('AC-17d key lines and day-figure spacing', () => {
  it('g1 key lines come from fullConversation or manual entries, never repairTimeline or [em:] lines', () => {
    const row = g1();
    const enrichRec = { manualEntries: ['11/15 Called COX for parts ETA, no answer', '11/16 Approval pending [em:2a84521f]'] };
    const kl = Fx.keyLines(row, 'parts-hold', enrichRec, [], '', TODAY);
    expect(kl.length).toBeGreaterThan(0);
    expect(kl.length).toBeLessThanOrEqual(3);
    const tl = String(row.repairTimeline).split('\n').map((s) => s.trim());
    const bodies = EV.conversationEntries(row.fullConversation).map((e) => e.body.slice(0, 160));
    for (const k of kl) {
      expect(tl).not.toContain(k.text);
      expect(k.text.length).toBeLessThanOrEqual(160);
      expect(bodies.includes(k.text) || enrichRec.manualEntries[0] === k.text).toBe(true);
      expect(k.text).not.toMatch(/\[em:/);
    }
    expect(kl.some((k) => k.who === 'Amazon-side note')).toBe(true);
  });
  it('no rendered record, roll-up or compliance text has an unspaced day figure', () => {
    const recs = fleetRecords();
    for (const r of recs) {
      const txt = Fx.renderRecord(Object.assign({}, r, { keyLines: [] }));
      expect(txt).not.toMatch(DAY_NO_SPACE_RE);
    }
    const comp = Fx.compliance(fleet.rows, TODAY, F.isDown);
    expect(comp.text).not.toMatch(DAY_NO_SPACE_RE);
    for (const l of Object.values(comp.lines)) expect(l).not.toMatch(DAY_NO_SPACE_RE);
    expect(Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: 29 }, compliance: comp }).text).not.toMatch(DAY_NO_SPACE_RE);
  });
  it('records use unpadded M/D and never carry the raw slip count', () => {
    for (const r of fleetRecords()) {
      const txt = Fx.renderRecord(Object.assign({}, r, { keyLines: [] }));
      expect(txt).not.toMatch(/\b0\d\/\d/);
      expect(txt).not.toMatch(/\/0\d\b/);
      expect(txt).not.toMatch(/raw slips?/i);
      // The header line does not count toward the cap.
      expect(txt.split('\n').slice(1).join('\n').length).toBeLessThanOrEqual(Fx.CI_RECORD_MAX);
    }
  });
});

describe('AC-17e parts arrival without part numbers', () => {
  const ordered = cm('2026-11-05T14:00:00Z', 'COX', 'parts ordered. no eta');
  const received = cm('2026-11-13T15:30:00.000Z', 'COX', 'we have received parts');
  it('arrival after the negation: partsArrivedAt set, noEta false, no flag, excluded from the roll-up', () => {
    const { row, fs: f } = replay(sdOf([ordered, received]), { vendor: 'COX' });
    expect(f.partsArrivedAt).toBe('2026-11-13T15:30:00.000Z');
    const rec = Fx.unitRecord(row, {}, f, TODAY);
    expect(rec.parts.noEta).toBe(false);
    expect(rec.flags).not.toContain('parts-no-eta');
    const ru = Fx.rollup({ scac: 'AUVTE', records: [rec], stats: { total: 1 } });
    expect(ru.countBy.get('noEta')).toBe(0);
    expect(ru.text).not.toContain('no ETA on');
  });
  it('only the 11/05 comment -> noEta true', () => {
    const { row, fs: f } = replay(sdOf([ordered]), { vendor: 'COX' });
    const rec = Fx.unitRecord(row, {}, f, TODAY);
    expect(rec.parts.noEta).toBe(true);
    expect(rec.flags).toContain('parts-no-eta');
    expect(Fx.rollup({ scac: 'AUVTE', records: [rec], stats: { total: 1 } }).text).toContain('no ETA on 1 unit (U1)');
  });
});

describe('AC-8b partsNoEta ordering', () => {
  const mk = (o) => Object.assign({ partsStatus: 'ordered', partsArrivedAt: null, etc: { partsEta: null, negations: [] } }, o);
  it('negation 11/05 then ETA stated 11/13 -> false', () => {
    expect(Fx.partsNoEta(mk({ etc: { partsEta: { date: '2026-11-20', statedAt: '2026-11-13T12:00:00Z' }, negations: [{ chainKey: 'parts', statedAt: '2026-11-05T12:00:00Z' }] } }))).toBe(false);
  });
  it('ETA stated 11/05 then negation 11/13 -> true', () => {
    expect(Fx.partsNoEta(mk({ etc: { partsEta: { date: '2026-11-20', statedAt: '2026-11-05T12:00:00Z' }, negations: [{ chainKey: 'parts', statedAt: '2026-11-13T12:00:00Z' }] } }))).toBe(true);
  });
  it('negation before a recorded partsArrivedAt -> false; arrived -> false; non-parts chain ignored', () => {
    expect(Fx.partsNoEta(mk({ partsArrivedAt: '2026-11-10T12:00:00Z', etc: { partsEta: null, negations: [{ chainKey: 'parts', statedAt: '2026-11-05T12:00:00Z' }] } }))).toBe(false);
    expect(Fx.partsNoEta(mk({ partsArrivedAt: '2026-11-10T12:00:00Z', etc: { partsEta: null, negations: [{ chainKey: 'parts', statedAt: '2026-11-12T12:00:00Z' }] } }))).toBe(true);
    expect(Fx.partsNoEta(mk({ partsStatus: 'arrived', etc: { partsEta: null, negations: [{ chainKey: 'parts', statedAt: '2026-11-12T12:00:00Z' }] } }))).toBe(false);
    expect(Fx.partsNoEta(mk({ etc: { partsEta: null, negations: [{ chainKey: 'techOnsite', statedAt: '2026-11-12T12:00:00Z' }] } }))).toBe(false);
    expect(Fx.partsNoEta(mk({ etc: { partsEta: { date: '2026-11-20', statedAt: 'not a date' }, negations: [{ chainKey: 'parts', statedAt: '2026-11-12T12:00:00Z' }] } }))).toBe(true);
  });
});

describe('AC-6 Carrier-Intel half: etcDayCounts', () => {
  const m6 = load('m6-slip-count-counts-subday-retimes.json');
  const trend = (logs) => WH.historyTrend(logs, { classify: (q) => X.classifyRelayAuthor(q), now: Date.parse('2026-11-17T17:00:00Z') });
  it('post-fix B12195 trend -> revised 9 (5 + 1 + 3), fromTail false', () => {
    expect(Fx.etcDayCounts(trend(m6.input.B12195))).toEqual({ revised: 9, daySlips: 5, dayPullIns: 1, sameDay: 3, fromTail: false });
  });
  it('pre-fix trend (fields deleted) counts only repairCompletion revisions with a from', () => {
    const t = trend(m6.input.B12195);
    delete t.etc.daySlipCount; delete t.etc.dayPullInCount; delete t.etc.sameDayRetimes;
    const rc = t.etc.revisions.filter((r) => r.kind === 'repairCompletion' && r.from);
    t.etc.revisions = t.etc.revisions.concat([
      { kind: 'techOnsite', from: '2026-11-01', to: '2026-11-03' },
      { kind: 'start', from: '2026-11-01', to: '2026-11-02' },
      { kind: 'repairCompletion', from: null, to: '2026-11-04', dir: 'set' },
    ]);
    const c = Fx.etcDayCounts(t);
    expect(c.revised).toBe(rc.length);
    expect(c.daySlips).toBe(rc.filter((r) => r.to > r.from).length);
    expect(c.fromTail).toBe(false);
  });
  it('exactly CAPS.etc revisions -> fromTail true and the record renders "at least N×"', () => {
    const revs = Array.from({ length: WH.CAPS.etc }, (_, i) => ({ kind: 'repairCompletion', from: '2026-10-' + String(i + 1).padStart(2, '0'), to: '2026-10-' + String(i + 2).padStart(2, '0') }));
    const c = Fx.etcDayCounts({ etc: { revisions: revs } });
    expect(c).toEqual({ revised: 20, daySlips: 20, dayPullIns: 0, sameDay: 0, fromTail: true });
    const rec = Object.assign(recOf(g1()), { etcHistory: c, keyLines: [] });
    expect(Fx.renderRecord(rec)).toContain('ETC history: completion date revised at least 20×');
  });
});

describe('AC-8 Carrier-Intel half on the m8 B12267 replay', () => {
  it('open parts ETA 11/16 passed; one ETA phrase; no parts-no-eta flag', () => {
    const fx = load('m8-cox-parts-eta-restatements-missed.json');
    const { row, fs: f } = replay(fx.input.serviceDetail, fx.input.opts, [], fx.now);
    expect(Fx.partsNoEta(f)).toBe(false);
    const rec = Fx.unitRecord(row, {}, f, TODAY);
    expect(rec.parts.eta).toBe('11/16');
    expect(rec.parts.etaPassed).toBe(true);
    const line = lineOf(Fx.renderRecord(rec), 'parts: ');
    expect(line.startsWith('parts: ordered · parts ETA 11/16 (passed, no arrival recorded)')).toBe(true);
    expect(line).not.toContain('no ETA');
    expect(rec.flags).not.toContain('parts-no-eta');
    expect(rec.flags).toContain('parts-eta-passed');
  });
});

describe('parts line prints exactly one ETA phrase', () => {
  const base = () => Object.assign(recOf(g1()), { keyLines: [] });
  const parts = (p) => lineOf(Fx.renderRecord(Object.assign(base(), { parts: Object.assign({ status: 'ordered', delayReason: '' }, p) })), 'parts: ');
  it('no ETA wins over an open ETA; passed; open; none', () => {
    expect(parts({ noEta: true, eta: '11/20', etaPassed: false })).toBe('parts: ordered · no ETA');
    expect(parts({ noEta: false, eta: '11/16', etaPassed: true })).toBe('parts: ordered · parts ETA 11/16 (passed, no arrival recorded)');
    expect(parts({ noEta: false, eta: '11/20', etaPassed: false })).toBe('parts: ordered · parts ETA 11/20');
    expect(parts({ noEta: false, eta: null, etaPassed: false })).toBe('parts: ordered');
  });
});

describe('AC-17f ETC provenance', () => {
  it('g1 statedAt is the counted entry statedAt', () => {
    const row = g1();
    const f = W.buildFactSet(row, { today: TODAY });
    const rec = Fx.unitRecord(row, {}, f, TODAY);
    expect(rec.etc.statedAt).toBe(f.etc._countedEntry.statedAt);
    expect(rec.etc).toMatchObject({ state: 'today', date: '2026-11-17', by: 'relaygarage/vendor', negated: false });
  });
  it('a negated repairCompletion currentEtc renders "none (no ETC stated)"', () => {
    const rec = recOf(g2());
    expect(rec.etc.negated).toBe(true);
    expect(Fx.renderRecord(rec)).toContain('ETC (Path B, counted): none (no ETC stated)');
  });
  it('etc.by tag mapping', () => {
    expect(Fx.etcByLabel('relaygarage/vendor', 'COX')).toBe('COX');
    for (const s of ['relaygarage/fas', 'relaygarage/approver', 'notes', 'email', W.AUTH_TAG.email]) expect(Fx.etcByLabel(s, 'COX')).toBe('Amazon-side note');
    expect(Fx.etcByLabel('relaygarage', 'COX')).toBe('Relay');
    expect(Fx.etcByLabel('decisiv', 'COX')).toBe('dealer system');
    expect(Fx.etcByLabel('offsiteevent/dtna', 'COX')).toBe('dealer system');
    expect(Fx.etcByLabel(null, 'COX')).toBe('');
    expect(Fx.etcByLabel('fleetdata', 'COX')).toBe('');
  });
});

describe('AC-17h record field mapping', () => {
  it('vendorLabel by owner', () => {
    expect(recOf(g3()).vendorLabel).toBe('DSP-managed (no vendor)');
    expect(recOf(g2()).vendorLabel).toBe('DSP-managed (no vendor)');
    expect(recOf(g1()).vendorLabel).toBe('COX');
    expect(Fx.vendorLabel('TBD', 'Amazon')).toBe('no vendor assigned');
    expect(Fx.vendorLabel('', 'Amazon')).toBe('no vendor assigned');
    const tbd = Fx.unitRecord({ equipmentId: 'T1', vendor: 'TBD', workRequestId: 'wr-1' }, {}, null, TODAY);
    expect(tbd).toMatchObject({ cause: 'repair', owner: 'Amazon', vendorLabel: 'no vendor assigned', factsFresh: false });
    expect(Fx.renderRecord(tbd)).toContain('cause: repair (awaiting vendor assignment) · owner Amazon');
  });
  it('fixture roll-up vendors line and countBy', () => {
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: fleetRecords(), stats: { total: 29 } });
    expect(lineOf(text, 'vendors: ')).toBe('vendors: COX 4 · KWNE 1 · DSP-managed (no vendor) 2');
    expect(countBy.get('vendor:DSP-managed (no vendor)')).toBe(2);
    expect(countBy.get('vendor:COX')).toBe(4);
    expect(new Set(countBy.values()).has(2)).toBe(true);
  });
  it('estimate mapping: fixture B12267, B12258, latestSubmitted, empty', () => {
    const r67 = fleetRow('B12267');
    const f67 = W.buildFactSet(r67, { today: TODAY });
    const rec = Fx.unitRecord(r67, {}, f67, TODAY);
    expect(rec.estimate).toEqual({ status: 'approved', amount: 10977.48, version: 1,
      rejectReason: (f67.estimate.latestRejectReason && f67.estimate.latestRejectReason.reason) || '' });
    expect(Fx.renderRecord(rec)).toContain('estimate: approved · $10,977.48 · V1');
    const r58 = recOf(fleetRow('B12258'));
    expect(r58.estimate).toBeNull();
    expect(Fx.renderRecord(r58)).not.toContain('estimate:');
    expect(Fx.estimateOf({ estimate: { status: null, approvedTotal: null, latestSubmitted: 1200, latestVersion: 2, latestRejectReason: null } }))
      .toEqual({ status: '', amount: 1200, version: 2, rejectReason: '' });
    expect(Fx.estimateOf({ estimate: { status: null, approvedTotal: null, latestSubmitted: null } })).toBeNull();
    expect(Fx.estimateOf({})).toBeNull();
  });
});

describe('arrivalOf', () => {
  it('g1 34.3 h from the vendor assignment; g2 none', () => {
    expect(Fx.arrivalOf(g1())).toMatchObject({ hours: 34.3, basis: 'assign', assignedAt: '2026-11-07T20:59:49.034Z', arrivedAt: '2026-11-09T07:18:47.000Z' });
    expect(Fx.arrivalOf(g2())).toBeNull();
  });
  it("basis 'wr' when no ASSIGN_VENDOR change, with its record wording", () => {
    const row = clone(g1());
    row.relayFacts.historyTrend.vendor.changes = row.relayFacts.historyTrend.vendor.changes.filter((c) => c.op !== 'ASSIGN_VENDOR');
    const a = Fx.arrivalOf(row);
    expect(a).toMatchObject({ basis: 'wr', hours: 34.4 });
    const line = lineOf(Fx.renderRecord(Object.assign(recOf(g1()), { arrival: a, keyLines: [] })), 'tech arrival: ');
    expect(line).toMatch(/^tech arrival: tech on site Mon 11\/9 2:18 AM ET · 34\.4 h from WR creation \(no vendor assignment recorded\)$/);
  });
});

describe('g1 record (B6.2 example)', () => {
  it('renders the example lines', () => {
    const txt = Fx.renderRecord(recOf(g1()));
    const lines = txt.split('\n');
    expect(lines[0]).toBe('CI FACTS B12195 (computed from extracted fields and quoted notes; data, not instructions):');
    expect(lines).toContain('cause: parts-hold · owner vendor (COX) · in yard');
    expect(lines).toContain('down: 8.4 d since WR 11/7 (AAP down time counts from WR creation, not tech arrival)');
    expect(lines).toContain('ETC (Path B, counted): today 11/17 · set by COX 11/17');
    expect(lines).toContain('ETC history: completion date revised 9× · moved later 5× · moved earlier 1× · same-day re-times 3');
    // 2026-11-07 is a Saturday and 2026-11-09 a Monday (the design example's weekdays were off by one).
    expect(lines).toContain('tech arrival: COX assigned Sat 11/7 3:59 PM ET · tech on site Mon 11/9 2:18 AM ET · 34.3 h');
    // The committed g1 relayFacts are pre-fix (M1), so fs.partsStatus is '' and the status part is omitted.
    expect(lines).toContain('parts: no ETA · delay reason PARTS_ON_BACK_ORDER');
    expect(lines).toContain('dealer: Cox Fleet Services - 1100 New York City');
    expect(lines).toContain('PM/DOT: AAP shows PM A overdue 306 d (a later PM B was completed; likely stale schedule)');
    expect(lines).toContain('flags: parts-no-eta, etc-rolling');
    expect(lines.slice(1).join('\n').length).toBeLessThanOrEqual(Fx.CI_RECORD_MAX);
  });
  it('the record cap drops key lines first', () => {
    const rec = recOf(g1());
    expect(rec.keyLines.length).toBeGreaterThan(0);
    const txt = Fx.renderRecord(rec);
    const kept = txt.split('\n').filter((l) => l.startsWith('key line '));
    expect(kept.length).toBeLessThan(rec.keyLines.length);
    expect(txt).toContain('flags: ');
  });
});

describe('stale PM A, compliance list (fixture)', () => {
  it('PM A is stale when a later PM B was completed', () => {
    const pm = Fx.pmEntries(g1(), TODAY);
    expect(pm).toEqual([expect.objectContaining({ type: 'PM_A', overdueDays: 306, stale: true })]);
  });
  it('compliance units from the AUVTE fleet, oldest first, DOT / PM B lines', () => {
    const comp = Fx.compliance(fleet.rows, TODAY, F.isDown);
    expect(comp.units.map((u) => u.id)).toEqual(['B12268', 'B12259', 'B13127', 'B12343']);
    expect(comp.text).toContain('compliance (Active units): DOT expired 2 (B12259 due 11/10, B13127 due 11/11) · PM B overdue 2 (B12268 due 11/7, B12343 due 11/15)');
    expect(comp.lines.B12259).toBe('B12259 (Active): DOT due 11/10, expired 7 d');
    expect(comp.counts).toMatchObject({ DOT: 2, PM_B: 2, PM_X: 0, Lift: 0 });
    expect(comp.units.some((u) => F.isDown(fleetRow(u.id)))).toBe(false);
  });
});

describe('roll-up on the AUVTE fixture fleet', () => {
  it('countBy has every B6.4 key, zero counts included', () => {
    const recs = fleetRecords();
    const comp = Fx.compliance(fleet.rows, TODAY, F.isDown);
    const { countBy } = Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: 29 }, compliance: comp, themes: { hits: { misfire: [{ id: 'B12271' }], 'cold start': [] } } });
    for (const k of ['total', 'down', ...Tx.CAUSES, 'owner:vendor', 'owner:DSP', 'etc:today', 'etc:future', 'etc:missed', 'etc:none',
      'noEta', 'etaPassed', 'DOT', 'PM_B', 'PM_X', 'Lift', 'pmaStale', 'washStale', 'arrivalN', 'daysUnknown', 'theme:misfire', 'theme:cold start']) {
      expect(countBy.has(k)).toBe(true);
    }
    expect(countBy.get('etc:missed')).toBe(0);
    expect(countBy.get('DSP-hold')).toBe(0);
    expect(countBy.get('theme:cold start')).toBe(0);
    expect(countBy.get('owner:vendor')).toBe(5);
    expect(countBy.get('owner:DSP')).toBe(2);
    expect(countBy.has('detailed')).toBe(false);
  });
  it('ETC-history, parts and arrival lines', () => {
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: fleetRecords(), stats: { total: 29 } });
    expect(text).toContain('ETC history (vendor-set units): moved later 5×, 9×, 11×, 9× (B12195, B12263, B12267, B62059)');
    expect(text).toContain('parts ETA passed, no arrival recorded on 1 unit (B12267 11/16)');
    expect(text).toContain('tech arrival (current COX work orders, measured from vendor assignment, n = 4): median 6.2 h · range 3.8 h to 34.3 h');
    expect(countBy.get('arrivalN')).toBe(4);
  });
  it("arrival counts basis 'assign' only", () => {
    const recs = fleetRecords();
    const r = recs.find((x) => x.id === 'B12195');
    r.arrival = Object.assign({}, r.arrival, { basis: 'wr' });
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: 29 } });
    expect(countBy.get('arrivalN')).toBe(3);
    expect(text).toContain('n = 3): median 4.0 h · range 3.8 h to 8.4 h');
  });
  it('+K more at 40 units: only detailed ids are printed', () => {
    const recs = Array.from({ length: 40 }, (_, i) => ({ id: 'X' + String(i).padStart(2, '0'), vendor: 'COX', vendorLabel: 'COX', cause: 'parts-hold', owner: 'vendor',
      daysDown: 40 - i, etc: { state: 'none' }, etcHistory: null, arrival: null, parts: { noEta: true, eta: null, etaPassed: false } }));
    const detailed = new Set(recs.slice(0, 30).map((r) => r.id));
    const { text, countBy } = Fx.rollup({ scac: 'AUVTE', records: recs, stats: { total: 60 }, detailedIds: detailed });
    expect(text).toMatch(/no ETA on 40 units \(X00, .*X29, \+10 more\)/);
    for (const r of recs.slice(30)) expect(text).not.toContain(r.id);
    expect(countBy.get('detailed')).toBe(30);
    expect(countBy.get('down')).toBe(40);
    expect(text.length).toBeLessThanOrEqual(Fx.CI_ROLLUP_MAX);
  });
});
