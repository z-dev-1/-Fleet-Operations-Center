// tests/awareness-change-digest.test.js
//
// Per-unit change digest (src/orcha/awareness/change-digest.js), design §D2/§D5, test plan §D16.1.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const cd = require('../src/orcha/awareness/change-digest');

const M = 60 * 1000;
const H = 60 * M;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const QUIET = { info() {}, warn() {}, debug() {} };

const sess = (startedAt = 0) => ({ startedAt, live: new Map(), asOf: new Map() });
const liveSess = (ids, at) => { const s = sess(); for (const id of ids) s.live.set(id, at); return s; };
const row = (id, extra) => Object.assign({
  equipmentId: id, lifecycleState: 'Unavailable', lifecycleReason: 'Repair', canonicalStatus: 'in_repair',
  vendor: 'Volvo of Allentown', workRequestId: 'WR1', escalations: '', estimatePendingCost: '',
}, extra);
const base = (rows, opts = {}) => cd.diffUnits(null, rows, opts.now || T0, { asOf: opts.asOf || T0, session: sess() }).nextDoc;
const diff = (doc, rows, opts = {}) => cd.diffUnits(doc, rows, opts.now || T0 + 5 * M,
  { asOf: opts.asOf === undefined ? T0 + 5 * M : opts.asOf, session: opts.session || liveSess(rows.map((r) => r.equipmentId), T0) });

function fakeStore(init = {}) {
  const data = JSON.parse(JSON.stringify(init));
  const calls = [];
  return {
    data, calls,
    load: vi.fn((k, d) => { calls.push('load:' + k); return k in data ? JSON.parse(JSON.stringify(data[k])) : d; }),
    save: vi.fn((k, v) => { calls.push('save:' + k); data[k] = JSON.parse(JSON.stringify(v)); }),
  };
}
function push(fs, d, { now, session, notifier }) {
  cd.onFleetPush(d, { load: fs.load, save: fs.save, now: () => now, notifier, log: QUIET, session });
}

describe('shouldDiff (AC3, AC4)', () => {
  it('rejects partial, usedCache, stale and empty rows; accepts deep-scan and partialMerge', () => {
    const rows = [row('1')];
    expect(cd.shouldDiff({ rows, partial: 'aap' })).toBe(false);
    expect(cd.shouldDiff({ rows, partial: 'relay-batch-2' })).toBe(false);
    expect(cd.shouldDiff({ rows, partial: 'uptake' })).toBe(false);
    expect(cd.shouldDiff({ rows, usedCache: true })).toBe(false);
    expect(cd.shouldDiff({ rows, stale: true })).toBe(false);
    expect(cd.shouldDiff({ rows: [] })).toBe(false);
    expect(cd.shouldDiff({})).toBe(false);
    expect(cd.shouldDiff({ rows, _partial: 'deep-scan' })).toBe(true);
    expect(cd.shouldDiff({ rows, partialMerge: true, _partial: 'relay-refresh-unit' })).toBe(true);
    expect(cd.shouldDiff({ rows })).toBe(true);
  });

  it('partial push does not touch snapshots (no load at all)', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')]) });
    push(fs, { rows: [row('1', { lifecycleState: 'Active' })], partial: 'aap' }, { now: T0, session: sess(), notifier: { enqueue: vi.fn() } });
    expect(fs.load).not.toHaveBeenCalled();
    expect(fs.save).not.toHaveBeenCalled();
  });

  it('partialMerge push diffs only the units it contains (AC4)', () => {
    const doc = base([row('A'), row('B')]);
    const r = diff(doc, [row('A', { lifecycleState: 'Active' })]);
    expect(r.entries.map((e) => e.u)).toEqual(['A']);
    expect(r.nextDoc.units.B).toEqual(doc.units.B);
  });
});

describe('baseline and basic diffs', () => {
  it('no snapshot doc → baselined, 0 entries, doc written, 0 notes (AC1)', () => {
    const r = cd.diffUnits(null, [row('1'), row('2')], T0, { asOf: T0, session: sess() });
    expect(r.baselined).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.dirty).toBe(true);
    expect(Object.keys(r.nextDoc.units)).toEqual(['1', '2']);
    const fs = fakeStore();
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('1'), row('2')], scrapedAt: iso(T0) }, { now: T0, session: sess(T0 - M), notifier });
    expect(fs.data.assistantUnitSnapshots.version).toBe(1);
    expect(fs.data.assistantChangeDigest).toBeUndefined();
    expect(notifier.enqueue).not.toHaveBeenCalled();
  });

  it('version mismatch → baseline', () => {
    const doc = base([row('1')]);
    doc.version = 2;
    const r = diff(doc, [row('1', { lifecycleState: 'Active' })]);
    expect(r.baselined).toBe(true);
    expect(r.entries).toEqual([]);
  });

  it('new unit among known units → no entry for it', () => {
    const doc = base([row('1')]);
    const r = diff(doc, [row('1'), row('NEW', { lifecycleState: 'Active' })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units.NEW).toBeTruthy();
  });

  it('stage diagnosis → repair text (AC2)', () => {
    const doc = base([row('322504', { offsiteStage: 'diagnosis', _stageReadAt: iso(T0) })]);
    const r = diff(doc, [row('322504', { offsiteStage: 'repair', _stageReadAt: iso(T0 + M) })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].text).toBe('322504 Diagnosis → Repair');
    expect(r.entries[0].k).toBe('stage');
  });

  it('empty scalar keeps prior, no entry (AC5)', () => {
    const doc = base([row('1')]);
    const r = diff(doc, [row('1', { vendor: '' })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].v).toBe('Volvo of Allentown');
  });

  it('lifecycle change text', () => {
    const doc = base([row('324040')]);
    const r = diff(doc, [row('324040', { lifecycleState: 'Active' })]);
    expect(r.entries.map((e) => e.text)).toEqual(['324040 Unavailable → Active']);
  });

  it("canonicalStatus 'unknown' → no entry, prior c kept (AC31)", () => {
    const doc = base([row('1')]);
    const r = diff(doc, [row('1', { canonicalStatus: 'unknown' })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].c).toBe('in_repair');
  });

  it('restart: identical rows over the persisted doc → 0 entries, dirty:false (AC24)', () => {
    const doc = JSON.parse(JSON.stringify(base([row('1'), row('2')])));
    const r = cd.diffUnits(doc, [row('1'), row('2')], T0 + H, { asOf: T0 + H, session: sess(T0 + H - M) });
    expect(r.entries).toEqual([]);
    expect(r.dirty).toBe(false);
  });

  it('unchanged push → dirty:false and onFleetPush does not save', () => {
    const doc = base([row('1')]);
    expect(diff(doc, [row('1')]).dirty).toBe(false);
    const fs = fakeStore({ assistantUnitSnapshots: doc });
    push(fs, { rows: [row('1')], scrapedAt: iso(T0 + 5 * M) }, { now: T0 + 5 * M, session: sess(T0 - M), notifier: { enqueue: vi.fn() } });
    expect(fs.save).not.toHaveBeenCalled();
  });
});

describe('stage group (AC6, AC28)', () => {
  const doc0 = () => base([row('1', { offsiteStage: 'repair', _stageReadAt: iso(T0), offsiteStageSince: iso(T0 - H) })]);

  it('older _stageReadAt ignored (AC6)', () => {
    const r = diff(doc0(), [row('1', { offsiteStage: 'diagnosis', _stageReadAt: iso(T0 - M) })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].st).toBe('repair');
    expect(r.nextDoc.units['1'].sr).toBe(iso(T0));
  });

  it('equal ISO _stageReadAt accepted', () => {
    const r = diff(doc0(), [row('1', { offsiteStage: 'diagnosis', _stageReadAt: iso(T0) })]);
    expect(r.entries.map((e) => e.k)).toEqual(['stage']);
  });

  it('no _stageReadAt and unparseable offsiteStageSince → prior kept', () => {
    const r = diff(doc0(), [row('1', { offsiteStage: 'ready', offsiteStageSince: 'bogus' })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].st).toBe('repair');
  });

  it("prior st '' → ready with offsiteStageSince → stage entry + P1a", () => {
    const doc = base([row('1', { offsiteStage: '', _stageReadAt: iso(T0) })]);
    expect(doc.units['1'].st).toBe('');
    const r1 = row('1', { offsiteStage: 'ready', offsiteStageDetail: 'Asset Ready', offsiteStageSince: iso(T0 + M), _stageReadAt: iso(T0 + M) });
    const r = diff(doc, [r1]);
    expect(r.entries.map((e) => e.text)).toEqual(['1 went Ready (Asset Ready)']);
    const c = cd.proactiveCandidates(r.entries, { 1: r1 });
    expect(c.map((x) => x.key)).toEqual(['1|ready-api|WR1']);
  });

  it("repair → '' → no entry, st becomes ''", () => {
    const r = diff(doc0(), [row('1', { offsiteStage: '', _stageReadAt: iso(T0 + M) })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].st).toBe('');
    expect(r.dirty).toBe(true);
  });

  it('prior st undefined → record only', () => {
    const doc = base([row('1')]);
    expect(doc.units['1'].st).toBeUndefined();
    const r = diff(doc, [row('1', { offsiteStage: 'ready', offsiteStageSince: iso(T0), _stageReadAt: iso(T0 + M) })]);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].st).toBe('ready');
  });
});

describe('field kinds', () => {
  it('escalation add and remove', () => {
    const doc = base([row('B62049', { escalations: 'Ops Lead' })]);
    const r = diff(doc, [row('B62049', { escalations: 'MCS Lead; ' })]);
    expect(r.entries.map((e) => [e.k, e.text])).toEqual([
      ['esc-add', 'B62049 escalated to MCS Lead'], ['esc-remove', 'B62049 de-escalated from Ops Lead']]);
  });

  it("escalations '[object Object]; MCS Lead' → only MCS Lead; '[object Object]' alone → unknown", () => {
    const doc = base([row('1')]);
    const r = diff(doc, [row('1', { escalations: '[object Object]; MCS Lead' })]);
    expect(r.entries.map((e) => e.t)).toEqual(['MCS Lead']);
    const doc2 = base([row('1', { escalations: 'Ops Lead' })]);
    const r2 = diff(doc2, [row('1', { escalations: '[object Object]' })]);
    expect(r2.entries).toEqual([]);
    expect(r2.nextDoc.units['1'].x).toEqual(['Ops Lead']);
  });

  it('estimate: Δ<500 none; 18,400 → 29,000 no P3; crossing 30000 → P3 with "≥ $30k"', () => {
    const doc = base([row('1', { estimatePendingCost: '18400' })]);
    expect(diff(doc, [row('1', { estimatePendingCost: '18700' })]).entries).toEqual([]);
    const r = diff(doc, [row('1', { estimatePendingCost: '29000' })]);
    expect(r.entries.map((e) => e.text)).toEqual(['1 estimate $18,400 → $29,000']);
    expect(cd.proactiveCandidates(r.entries, {})).toEqual([]);
    const doc2 = base([row('1', { estimatePendingCost: '29800' })]);
    const r2 = diff(doc2, [row('1', { estimatePendingCost: '30100' })]);
    expect(r2.entries).toHaveLength(1);
    const c = cd.proactiveCandidates(r2.entries, {});
    expect(c).toHaveLength(1);
    expect(c[0].key).toBe('1|estimate-high|WR1');
    expect(c[0].text).toContain('≥ $30k');
  });

  it("estimate read from estimatePendingCost ('$31,200.00' → 31200)", () => {
    const doc = base([row('1', { estimatePendingCost: '$31,200.00' })]);
    expect(doc.units['1'].e).toBe(31200);
    expect(cd.HIGH_ESTIMATE).toBe(30000);
  });

  it('new WR ids (primary and secondary)', () => {
    const doc = base([row('322504')]);
    const r = diff(doc, [row('322504', { _secondaryWRs: [{ workRequestId: '123' }, { workRequestId: '456' }] })]);
    expect(r.entries.map((e) => e.text)).toEqual(['322504 2 new WRs (123, 456)']);
  });

  it("dealer note appended → entry; shortened → silent update; '' → unknown", () => {
    const doc = base([row('1', { asistNotes: 'first note' })]);
    const r = diff(doc, [row('1', { asistNotes: 'first note\nsecond note' })]);
    expect(r.entries.map((e) => e.text)).toEqual(['1 new dealer note']);
    const r2 = diff(r.nextDoc, [row('1', { asistNotes: 'first' })]);
    expect(r2.entries).toEqual([]);
    expect(r2.nextDoc.units['1'].nl).toBe(5);
    const r3 = diff(r.nextDoc, [row('1', { asistNotes: '' })]);
    expect(r3.entries).toEqual([]);
    expect(r3.nextDoc.units['1'].n).toBe(r.nextDoc.units['1'].n);
    expect(r3.nextDoc.units['1'].nl).toBe(r.nextDoc.units['1'].nl);
  });
});

describe('proactive candidates (P1a / P1b)', () => {
  it('canonical → ready_for_pickup without stage-ready → P1b ready-maybe, "not confirmed by the Decisiv API"', () => {
    const doc = base([row('1')]);
    const r = diff(doc, [row('1', { canonicalStatus: 'ready_for_pickup' })]);
    const c = cd.proactiveCandidates(r.entries, {});
    expect(c).toHaveLength(1);
    expect(c[0].key).toBe('1|ready-maybe|WR1');
    expect(c[0].text).toContain('not confirmed by the Decisiv API');
    expect(c[0].source).toBe('digest');
  });

  it('stage → ready with offsiteStageSince plus canonical ready → P1a only', () => {
    const doc = base([row('1', { offsiteStage: 'repair', _stageReadAt: iso(T0) })]);
    const r1 = row('1', { canonicalStatus: 'ready_for_pickup', offsiteStage: 'ready', offsiteStageSince: iso(T0), _stageReadAt: iso(T0 + M) });
    const r = diff(doc, [r1]);
    const c = cd.proactiveCandidates(r.entries, { 1: r1 });
    expect(c.map((x) => x.key)).toEqual(['1|ready-api|WR1']);
    expect(c[0].text).toContain('confirmed by the Decisiv API');
  });

  it('stage → ready without offsiteStageSince → no P1a', () => {
    const doc = base([row('1', { offsiteStage: 'repair', _stageReadAt: iso(T0) })]);
    const r1 = row('1', { offsiteStage: 'ready', _stageReadAt: iso(T0 + M) });
    const r = diff(doc, [r1]);
    expect(r.entries).toHaveLength(1);
    expect(cd.proactiveCandidates(r.entries, { 1: r1 })).toEqual([]);
  });
});

describe('data-as-of guard (AC22)', () => {
  it('older scrapedAt cannot revert non-stage fields; missing scrapedAt diffs and leaves a', () => {
    const T1 = T0 + 10 * M; const T2 = T0 + 20 * M;
    const doc = base([row('1')]);
    const a = cd.diffUnits(doc, [row('1', { lifecycleState: 'Active' })], T2, { asOf: T2, session: liveSess(['1'], T2) });
    expect(a.entries).toHaveLength(1);
    expect(a.nextDoc.units['1'].a).toBe(T2);
    const b = cd.diffUnits(a.nextDoc, [row('1', { lifecycleState: 'Unavailable', vendor: 'Other', escalations: 'MCS Lead', estimatePendingCost: '5000' })],
      T2 + M, { asOf: T1, session: liveSess(['1'], T2) });
    expect(b.entries).toEqual([]);
    const u = b.nextDoc.units['1'];
    expect([u.l, u.v, u.x, u.e, u.a]).toEqual(['Active', 'Volvo of Allentown', [], undefined, T2]);
    const c = cd.diffUnits(a.nextDoc, [row('1', { lifecycleState: 'Unavailable' })], T2 + M, { asOf: 0, session: liveSess(['1'], T2) });
    expect(c.entries).toHaveLength(1);
    expect(c.nextDoc.units['1'].a).toBe(T2);
  });

  it('in-session guard uses session.asOf with no snapshot write in between', () => {
    const T1 = T0 + 10 * M; const T2 = T0 + 20 * M;
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')], { asOf: T0 }) });
    const s = sess(T0 - M);
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('1')], scrapedAt: iso(T2) }, { now: T2, session: s, notifier });
    expect(fs.save).not.toHaveBeenCalled();
    expect(s.asOf.get('1')).toBe(T2);
    push(fs, { rows: [row('1', { lifecycleState: 'Active' })], scrapedAt: iso(T1) }, { now: T2 + M, session: s, notifier });
    expect(fs.data.assistantChangeDigest).toBeUndefined();
    expect(notifier.enqueue).not.toHaveBeenCalled();
  });
});

describe('catch-up marker (per-unit liveness)', () => {
  const doc = () => base([row('1')]);
  const changed = [row('1', { lifecycleState: 'Active' })];
  const now = T0 + 5 * H;

  it('unit absent from session.live → cu:true', () => {
    expect(cd.diffUnits(doc(), changed, now, { asOf: now, session: sess() }).entries[0].cu).toBe(true);
  });
  it('live stamp 3 h old → cu:true', () => {
    expect(cd.diffUnits(doc(), changed, now, { asOf: now, session: liveSess(['1'], now - 3 * H) }).entries[0].cu).toBe(true);
  });
  it('live stamp 5 min old → no cu', () => {
    expect(cd.diffUnits(doc(), changed, now, { asOf: now, session: liveSess(['1'], now - 5 * M) }).entries[0].cu).toBeUndefined();
  });
  it('opts.session omitted → cu:true', () => {
    expect(cd.diffUnits(doc(), changed, now, { asOf: now }).entries[0].cu).toBe(true);
  });
  it('persisted seen 5 min old but unit not live → still cu:true', () => {
    const d = doc();
    d.units['1'].seen = now - 5 * M;
    expect(cd.diffUnits(d, changed, now, { asOf: now, session: sess() }).entries[0].cu).toBe(true);
  });
  it('cu entries produce silent:true candidates', () => {
    const d = base([row('1')]);
    const r = cd.diffUnits(d, [row('1', { escalations: 'MCS Lead' })], now, { asOf: now, session: sess() });
    expect(cd.proactiveCandidates(r.entries, {})[0].silent).toBe(true);
  });
});

describe('seen / dirty (AC33)', () => {
  it('unchanged fresh pushes inside 24 h → no save; 25 h after seen → dirty, seen refreshed, no entry', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')], { now: T0 }) });
    const s = sess(T0 - M);
    for (let t = T0 + 5 * M; t < T0 + 3 * H; t += 5 * M) {
      push(fs, { rows: [row('1')], scrapedAt: iso(t) }, { now: t, session: s, notifier: { enqueue: vi.fn() } });
    }
    expect(fs.save).not.toHaveBeenCalled();
    const r = cd.diffUnits(fs.data.assistantUnitSnapshots, [row('1')], T0 + 25 * H, { asOf: T0 + 25 * H, session: s });
    expect(r.dirty).toBe(true);
    expect(r.entries).toEqual([]);
    expect(r.nextDoc.units['1'].seen).toBe(T0 + 25 * H);
  });

  it('units with seen older than 30 days are pruned', () => {
    const doc = base([row('OLD'), row('1')]);
    doc.units.OLD.seen = T0 - 31 * 24 * H;
    const r = diff(doc, [row('1', { lifecycleState: 'Active' })]);
    expect(r.nextDoc.units.OLD).toBeUndefined();
  });
});

describe('onFleetPush (AC24, AC29)', () => {
  const rdy = (extra) => row('1', Object.assign({ offsiteStage: 'ready', offsiteStageDetail: 'Asset Ready', offsiteStageSince: iso(T0), _stageReadAt: iso(T0 + 4 * H) }, extra));

  it('snapshot save throws → no enqueue, no digest, session unchanged', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')]) });
    fs.save.mockImplementation((k) => { if (k === 'assistantUnitSnapshots') throw new Error('disk'); });
    const s = liveSess(['1'], T0);
    s.asOf.set('1', T0);
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('1', { escalations: 'MCS Lead' })], scrapedAt: iso(T0 + 5 * M) }, { now: T0 + 5 * M, session: s, notifier });
    expect(notifier.enqueue).not.toHaveBeenCalled();
    expect(fs.calls).not.toContain('save:assistantChangeDigest');
    expect(s.live.get('1')).toBe(T0);
    expect(s.asOf.get('1')).toBe(T0);
  });

  it('success: save(snapshots) before enqueue, session.live updated after both', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1', { offsiteStage: 'repair', _stageReadAt: iso(T0) })]) });
    const s = liveSess(['1'], T0);
    const order = [];
    const notifier = { enqueue: vi.fn((c) => { order.push('enqueue:' + s.live.get('1')); }) };
    fs.save.mockImplementation((k, v) => { order.push('save:' + k); fs.data[k] = JSON.parse(JSON.stringify(v)); });
    const now = T0 + 5 * M;
    push(fs, { rows: [rdy({ _stageReadAt: iso(now) })], scrapedAt: iso(now) }, { now, session: s, notifier });
    expect(order).toEqual(['save:assistantUnitSnapshots', 'save:assistantChangeDigest', 'enqueue:' + T0]);
    expect(notifier.enqueue.mock.calls[0][0].map((c) => c.key)).toEqual(['1|ready-api|WR1']);
    expect(notifier.enqueue.mock.calls[0][0][0].silent).toBeUndefined();
    expect(s.live.get('1')).toBe(now);
  });

  it('digest save throws → enqueue still called', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')]) });
    fs.save.mockImplementation((k, v) => { if (k === 'assistantChangeDigest') throw new Error('disk'); fs.data[k] = v; });
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('1', { escalations: 'MCS Lead' })], scrapedAt: iso(T0 + 5 * M) }, { now: T0 + 5 * M, session: liveSess(['1'], T0), notifier });
    expect(notifier.enqueue).toHaveBeenCalledTimes(1);
  });

  it('digest stores source and caps at 10 digests', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1')]) });
    const s = liveSess(['1'], T0);
    for (let i = 0; i < 12; i++) {
      const now = T0 + (i + 1) * M;
      push(fs, { rows: [row('1', { estimatePendingCost: String(1000 * (i + 1)) })], scrapedAt: iso(now), _partial: 'deep-scan' }, { now, session: s, notifier: { enqueue: vi.fn() } });
    }
    expect(fs.data.assistantChangeDigest.digests).toHaveLength(10);
    expect(fs.data.assistantChangeDigest.digests[0].source).toBe('deep-scan');
  });

  it('liveness in-session: 3 h of unchanged fresh 5-min pushes, then stage → ready → non-silent P1a', () => {
    const fs = fakeStore();
    const s = sess(T0 - M);
    const notifier = { enqueue: vi.fn() };
    const r0 = row('1', { offsiteStage: 'repair', _stageReadAt: iso(T0) });
    let t = T0;
    for (; t <= T0 + 3 * H; t += 5 * M) push(fs, { rows: [r0], scrapedAt: iso(t) }, { now: t, session: s, notifier });
    expect(notifier.enqueue).not.toHaveBeenCalled();
    push(fs, { rows: [rdy({ _stageReadAt: iso(t) })], scrapedAt: iso(t) }, { now: t, session: s, notifier });
    const c = notifier.enqueue.mock.calls[0][0];
    expect(c.map((x) => x.key)).toEqual(['1|ready-api|WR1']);
    expect(c[0].silent).toBeUndefined();
  });

  it('restart with identical data → 0 entries, 0 notes; restart with changed data → cu entry + silent P1a, then live P2', () => {
    const fs = fakeStore();
    const sA = sess(T0 - M);
    const notifier = { enqueue: vi.fn() };
    const r0 = row('1', { offsiteStage: 'diagnosis', _stageReadAt: iso(T0) });
    push(fs, { rows: [r0], scrapedAt: iso(T0) }, { now: T0, session: sA, notifier });
    push(fs, { rows: [r0], scrapedAt: iso(T0 + 5 * M) }, { now: T0 + 5 * M, session: sA, notifier });

    // Restart, identical data.
    const sI = sess(T0 + H);
    push(fs, { rows: [r0], scrapedAt: iso(T0 + H + M) }, { now: T0 + H + M, session: sI, notifier });
    expect(fs.data.assistantChangeDigest).toBeUndefined();
    expect(notifier.enqueue).not.toHaveBeenCalled();

    // Restart 8 h later, changed data.
    const sB = sess(T0 + 8 * H);
    const t1 = T0 + 8 * H + M;
    push(fs, { rows: [rdy({ _stageReadAt: iso(t1) })], scrapedAt: iso(t1) }, { now: t1, session: sB, notifier });
    const dg = fs.data.assistantChangeDigest.digests;
    expect(dg).toHaveLength(1);
    expect(dg[0].entries).toHaveLength(1);
    expect(dg[0].entries[0].cu).toBe(true);
    const c1 = notifier.enqueue.mock.calls[0][0];
    expect(c1.map((x) => [x.key, x.silent])).toEqual([['1|ready-api|WR1', true]]);

    const t2 = t1 + 5 * M;
    push(fs, { rows: [rdy({ _stageReadAt: iso(t1), escalations: 'MCS Lead' })], scrapedAt: iso(t2) }, { now: t2, session: sB, notifier });
    const c2 = notifier.enqueue.mock.calls[1][0];
    expect(c2.map((x) => x.key)).toEqual(['1|esc|MCS Lead|WR1']);
    expect(c2[0].silent).toBeUndefined();
  });

  it('F5 replay after restart primes nothing; next fresh change is cu/silent', () => {
    const T = T0;
    const fs = fakeStore();
    push(fs, { rows: [row('1')], scrapedAt: iso(T) }, { now: T, session: sess(T - M), notifier: { enqueue: vi.fn() } });
    const sB = sess(T + 30 * M);
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('1')], scrapedAt: iso(T - 5 * M) }, { now: T + 31 * M, session: sB, notifier });
    expect(sB.live.size).toBe(0);
    push(fs, { rows: [row('1', { escalations: 'MCS Lead' })], scrapedAt: iso(T + 35 * M) }, { now: T + 35 * M, session: sB, notifier });
    const c = notifier.enqueue.mock.calls[0][0];
    expect(c[0].silent).toBe(true);
    expect(fs.data.assistantChangeDigest.digests[0].entries[0].cu).toBe(true);
  });

  it('relay-refresh-unit (no timestamps) never primes; for a live unit its change is non-silent', () => {
    const fs = fakeStore({ assistantUnitSnapshots: base([row('1'), row('2')]) });
    const s = liveSess(['1'], T0);
    const notifier = { enqueue: vi.fn() };
    push(fs, { rows: [row('2')], partialMerge: true, _partial: 'relay-refresh-unit' }, { now: T0 + M, session: s, notifier });
    expect(s.live.has('2')).toBe(false);
    push(fs, { rows: [row('1', { escalations: 'MCS Lead' })], partialMerge: true, _partial: 'relay-refresh-unit' }, { now: T0 + 2 * M, session: s, notifier });
    const c = notifier.enqueue.mock.calls[0][0];
    expect(c[0].key).toBe('1|esc|MCS Lead|WR1');
    expect(c[0].silent).toBeUndefined();
    expect(s.live.get('1')).toBe(T0);
  });
});

describe('module session', () => {
  it('startedAt is the process start, not module load', () => {
    expect(cd._session.startedAt).toBeLessThanOrEqual(Date.now() - process.uptime() * 1000 + 50);
    expect(cd.STALE_SNAPSHOT_MS).toBe(2 * H);
  });
});
