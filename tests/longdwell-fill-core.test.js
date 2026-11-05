// tests/longdwell-fill-core.test.js — durable longDwellAiFill core: the plan
// decision matrix, counts, result validation and the CSV asset/site guard.
// Pure DI: in-memory annotation + fill stores and a fake jobs facade (no
// store mock, no SQLite).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createCore, valuesHash, localDay } = require('../src/jobs/long-dwell-ai-fill');

const T = new Date(2026, 10, 4, 10, 0, 0).getTime();   // local 2026-11-04 10:00
const DAY = localDay(T);
const YESTERDAY = localDay(T - 24 * 3600 * 1000);
const AI = { delayReason: 'Parts Delay', escalation: 'SEV4', summary: '- Initial Issue: brakes' };

function fakeJobs(o) {
  const calls = [];
  const poisoned = new Set((o && o.poisoned) || []);
  const handle = {
    durable: true, resumed: !!(o && o.resumed), busy: !!(o && o.busy), jobId: 'job_1', attempt: 1,
    start: () => calls.push(['start']),
    isUnitPoisoned: (k) => poisoned.has(k),
    unitsStarted: (k) => calls.push(['started', k]),
    unitsSettled: (e) => calls.push(['settled', e]),
    setCheckpoint: (c) => calls.push(['ckpt', c]),
    complete: (s) => calls.push(['complete', s]),
    fail: (e) => calls.push(['fail', e]),
    cancel: (r) => calls.push(['cancel', r]),
  };
  return { calls, handle, effective: o && o.effective === false ? false : true,
    isEffective(t) { return t === 'longDwellAiFill' && this.effective; },
    begin: () => { calls.push(['begin']); return handle; },
    peek: () => null };
}

function mkCore(opts) {
  const o = opts || {};
  const state = { ann: { computed: o.computed || {}, csv: o.csv || { importedAt: null, columns: [], rows: {} } }, fills: o.fills || { version: 1, entries: {} }, touched: 0 };
  const jobs = o.jobs || fakeJobs();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  let n = 0;
  const core = createCore({
    jobs,
    loadAnnotations: (t) => { state.touched++; return clone(state.ann[t]); },
    updateAnnotations: (t, fn) => { state.touched++; const next = fn(clone(state.ann[t])); state.ann[t] = next; return next; },
    loadFills: () => { state.touched++; return clone(state.fills); },
    updateFills: (fn) => { state.touched++; state.fills = fn(clone(state.fills)); return state.fills; },
    now: () => (o.now ? o.now() : T),
    log: { info() {}, warn() {}, debug() {}, error() {} },
    genRunId: () => 'run' + (++n),
  });
  return { core, state, jobs };
}
const filled = (dr, esc, sum) => ({ equipmentId: 'x', woKey: 'primary', delayReason: dr, escalationLevel: esc, summary: sum, updatedAt: 'x' });
const rec = (table, key, o) => Object.assign({ table, key, day: DAY, filledAt: new Date(T - 60000).toISOString(), fp: 'fp1', outHash: valuesHash(['Parts Delay', 'SEV4', 'note']), jobId: null, fields: ['delayReason', 'escalation', 'summary'] }, o || {});
const unit = (id, fp, extra) => Object.assign({ key: id + '::primary', equipmentId: id, woKey: 'primary', isPrimary: true, fp: fp || 'fp1' }, extra || {});

describe('plan decision matrix (computed)', () => {
  it('every rule, counts and checkpoint', () => {
    const computed = {
      'B::primary': filled('', '', '  '),                                    // blank
      'FT::primary': filled('Parts Delay', 'SEV4', 'note'),                  // filled today, unchanged
      'FP::primary': filled('Parts Delay', 'SEV4', 'note'),                  // filled today, inputs changed
      'PD::primary': filled('Parts Delay', 'SEV4', 'note'),                  // prior day, unedited
      'ED::primary': filled('Parts Delay', 'SEV4', 'note (edited by me)'),   // edited after fill
      'HC::primary': filled('Weather', '', ''),                              // typed by a person, no record
      HCL: filled('Towing', 'SEV5', 'legacy'),                               // legacy unit-only entry -> primary row has content
      'CL::primary': filled('', '', ''),                                     // poisoned
    };
    const fills = { version: 1, entries: {
      'computed|FT::primary': rec('computed', 'FT::primary'),
      'computed|FP::primary': rec('computed', 'FP::primary'),
      'computed|PD::primary': rec('computed', 'PD::primary', { day: YESTERDAY }),
      'computed|ED::primary': rec('computed', 'ED::primary'),
    } };
    const jobs = fakeJobs({ poisoned: ['CL::primary'] });
    const { core } = mkCore({ computed, fills, jobs });
    const r = core.plan({ table: 'computed', units: [
      unit('B'), unit('FT'), unit('FP', 'fp2'), unit('PD'), unit('ED'), unit('HC'), unit('HCL'), unit('CL'), unit('NEW'), unit('B'),
    ] });
    expect(r).toMatchObject({ ok: true, runId: 'run1', durable: true, resumed: false, busy: false });
    expect(r.toFill).toEqual([
      { key: 'B::primary', reason: 'blank' },
      { key: 'FP::primary', reason: 'inputs-changed' },
      { key: 'PD::primary', reason: 'refresh-day' },
      { key: 'NEW::primary', reason: 'blank' },
    ]);
    expect(r.skipped).toEqual([
      { key: 'FT::primary', reason: 'filled-today' },
      { key: 'ED::primary', reason: 'edited' },
      { key: 'HC::primary', reason: 'has-content' },
      { key: 'HCL::primary', reason: 'has-content' },
      { key: 'CL::primary', reason: 'crash-loop' },
      { key: 'B::primary', reason: 'duplicate' },
    ]);
    expect(r.counts).toEqual({ units: 10, planned: 4, filledToday: 1, edited: 1, hasContent: 2, crashLoop: 1, duplicate: 1, notFound: 0,
      filled: 0, failed: 0, editedDuringRun: 0, notRun: 0 });
    const ck = jobs.calls.find((c) => c[0] === 'ckpt')[1];
    expect(ck).toEqual({ table: 'computed', keys: ['B::primary', 'FP::primary', 'PD::primary', 'NEW::primary'], total: 4 });
    expect(jobs.calls.slice(0, 2)).toEqual([['begin'], ['start']]);
  });

  it('a blank row with a stale record is filled (user cleared it)', () => {
    const { core } = mkCore({ computed: { 'A::primary': filled('', '', '') }, fills: { version: 1, entries: { 'computed|A::primary': rec('computed', 'A::primary') } } });
    expect(core.plan({ table: 'computed', units: [unit('A')] }).toFill).toEqual([{ key: 'A::primary', reason: 'blank' }]);
  });

  it('busy handle or a live run on the table -> busy, nothing planned', () => {
    const a = mkCore({ jobs: fakeJobs({ busy: true }) });
    expect(a.core.plan({ table: 'computed', units: [unit('A')] })).toMatchObject({ ok: true, busy: true, runId: null, toFill: [] });
    const b = mkCore();
    expect(b.core.plan({ table: 'computed', units: [unit('A')] }).busy).toBe(false);
    expect(b.core.plan({ table: 'computed', units: [unit('A')] })).toMatchObject({ busy: true, runId: null });
    expect(b.core.plan({ table: 'csv', units: [] }).busy).toBe(false);
  });

  it('input validation -> bad-input', () => {
    const { core } = mkCore();
    expect(core.plan({ table: 'nope', units: [] })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: 'x' })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: new Array(5001).fill(unit('A')) })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: [{ key: 'k'.repeat(257), fp: '' }] })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: [{ key: 'A::primary', fp: 7 }] })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: [unit('A', 'f'.repeat(65))] })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.plan({ table: 'computed', units: [{ key: 'A::wo1', equipmentId: 'B', woKey: 'wo1', fp: '' }] })).toMatchObject({ ok: false, code: 'bad-input' });
  });

  it('flag off: every method but status is {ok:false, code:off} and no store is touched', () => {
    const jobs = fakeJobs({ effective: false });
    const { core, state } = mkCore({ jobs });
    const OFF = { ok: false, code: 'off' };
    expect(core.plan({ table: 'computed', units: [unit('A')] })).toEqual(OFF);
    expect(core.unitStart({ runId: 'x', key: 'A::primary' })).toEqual(OFF);
    expect(core.commit({ runId: 'x', table: 'computed', key: 'A::primary', fp: '', result: AI })).toEqual(OFF);
    expect(core.finish({ runId: 'x' })).toEqual(OFF);
    expect(core.today({ table: 'computed' })).toEqual(OFF);
    expect(core.sweepIdle()).toEqual(OFF);
    expect(core.status()).toEqual({ ok: true, durable: false, day: DAY });
    expect(state.touched).toBe(0);
    expect(jobs.calls).toEqual([]);
  });
});

describe('commit', () => {
  it('validates enums + lengths, writes only non-empty AI fields, settles done, records provenance', () => {
    const { core, state, jobs } = mkCore({ computed: { X: filled('Weather', 'SEV5', 'legacy text') } });
    const p = core.plan({ table: 'computed', units: [unit('A'), unit('B'), unit('C', 'fpC', { woKey: 'wo-9', key: 'C::wo-9', isPrimary: false })] });
    expect(p.toFill.length).toBe(3);
    const r1 = core.commit({ runId: p.runId, table: 'computed', key: 'A::primary', fp: 'fp1', result: { delayReason: 'Banana', escalation: 'sev3', summary: 'x'.repeat(5000) } });
    expect(r1).toMatchObject({ ok: true, outcome: 'filled' });
    expect(state.ann.computed['A::primary']).toMatchObject({ equipmentId: 'A', woKey: 'primary', delayReason: '', escalationLevel: 'SEV3' });
    expect(state.ann.computed['A::primary'].summary.length).toBe(4000);
    expect(state.fills.entries['computed|A::primary']).toMatchObject({ table: 'computed', key: 'A::primary', day: DAY, fp: 'fp1', jobId: 'job_1', fields: ['escalation', 'summary'],
      outHash: valuesHash(['', 'SEV3', 'x'.repeat(4000)]) });
    // all-empty / invalid -> failed, nothing written
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'B::primary', fp: 'fp1', result: { delayReason: 'nope', escalation: '', summary: '  ' } })).toEqual({ ok: true, outcome: 'failed', reason: 'empty' });
    expect(state.ann.computed['B::primary']).toBeUndefined();
    expect(state.fills.entries['computed|B::primary']).toBeUndefined();
    // AI failure reported by the renderer
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'C::wo-9', fp: 'fpC', failed: true })).toEqual({ ok: true, outcome: 'failed', reason: 'ai-failed' });
    // not planned / duplicate / unknown run
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'Z::primary', fp: '', result: AI })).toEqual({ ok: false, code: 'not-planned' });
    expect(core.commit({ runId: p.runId, table: 'computed', key: 'A::primary', fp: 'fp1', result: AI })).toEqual({ ok: false, code: 'duplicate' });
    expect(core.commit({ runId: 'nope', table: 'computed', key: 'A::primary', fp: '', result: AI })).toEqual({ ok: false, code: 'unknown-run' });
    expect(core.commit({ runId: p.runId, table: 'csv', key: 'A::primary', fp: '', result: AI })).toEqual({ ok: false, code: 'unknown-run' });
    const settled = jobs.calls.filter((c) => c[0] === 'settled').map((c) => c[1][0]);
    expect(settled.map((e) => [e.key, e.status])).toEqual([['A::primary', 'done'], ['B::primary', 'failed'], ['C::wo-9', 'failed']]);
    expect(settled[0].sig).toBe('fp1');
    const f = core.finish({ runId: p.runId });
    expect(f).toEqual({ ok: true, counts: expect.objectContaining({ planned: 3, filled: 1, failed: 2, notRun: 0 }) });
    expect(jobs.calls.at(-1)).toEqual(['complete', { counts: f.counts }]);
    expect(core.finish({ runId: p.runId })).toEqual({ ok: false, code: 'unknown-run' });
  });

  it('legacy primary seeding mirrors long-dwell:save-unit', () => {
    // a legacy unit-only entry seeds the 'primary' WO; AI fields overwrite only when non-empty
    const { core, state } = mkCore({ computed: {} , fills: { version: 1, entries: {} } });
    state.ann.computed = { L: { delayReason: '', escalationLevel: '', summary: '' } };
    const p = core.plan({ table: 'computed', units: [unit('L')] });
    core.commit({ runId: p.runId, table: 'computed', key: 'L::primary', fp: 'fp1', result: { delayReason: 'Weather', escalation: '', summary: 'S' } });
    expect(state.ann.computed['L::primary']).toMatchObject({ equipmentId: 'L', woKey: 'primary', delayReason: 'Weather', escalationLevel: '', summary: 'S' });
    expect(state.ann.computed.L).toEqual({ delayReason: '', escalationLevel: '', summary: '' });   // legacy left in place
  });

  it('force commit without a run: base guard, unit identity required', () => {
    const { core, state } = mkCore({ computed: { 'F::primary': filled('Weather', '', 'mine') } });
    const base = { delayReason: 'Weather', escalation: '', summary: 'mine' };
    expect(core.commit({ runId: null, table: 'computed', key: 'F::primary', fp: 'f', result: AI })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.commit({ runId: null, table: 'computed', key: 'F::primary', fp: 'f', result: AI, force: true })).toMatchObject({ ok: false, code: 'bad-input' });
    expect(core.commit({ runId: null, table: 'computed', key: 'F::primary', fp: 'f', result: AI, force: true, base: { delayReason: 'Payment' } }))
      .toEqual({ ok: true, outcome: 'skipped', reason: 'edited-during-run' });
    expect(state.ann.computed['F::primary'].summary).toBe('mine');
    const r = core.commit({ runId: null, table: 'computed', key: 'F::primary', fp: 'f', result: AI, force: true, base });
    expect(r).toMatchObject({ ok: true, outcome: 'filled', unit: { delayReason: 'Parts Delay', escalationLevel: 'SEV4', summary: AI.summary } });
    expect(state.fills.entries['computed|F::primary']).toMatchObject({ jobId: null, fp: 'f' });
  });

  it('prunes records older than 14 days in the same update', () => {
    const old = new Date(T - 15 * 24 * 3600 * 1000).toISOString();
    const { core, state } = mkCore({ fills: { version: 1, entries: { 'computed|OLD::primary': rec('computed', 'OLD::primary', { filledAt: old }), 'computed|NEW::primary': rec('computed', 'NEW::primary') } } });
    const p = core.plan({ table: 'computed', units: [unit('A')] });
    core.commit({ runId: p.runId, table: 'computed', key: 'A::primary', fp: 'fp1', result: AI });
    expect(Object.keys(state.fills.entries).sort()).toEqual(['computed|A::primary', 'computed|NEW::primary']);
  });
});

describe('csv table', () => {
  const row = (assetId, site, manual) => ({ assetId, site, csv: { 'Asset ID': assetId }, manual: Object.assign({ delayReason: '', escalationAction: '', supportPOC: '', asanaLink: '', notes: '' }, manual || {}), updatedAt: 'x' });

  it('writes manual.delayReason/escalationAction/notes like save-row; record keeps asset + site', () => {
    const { core, state } = mkCore({ csv: { importedAt: 'x', columns: [], rows: { 'U1::DXX1::0': row('U1', 'DXX1', { supportPOC: 'pat' }) } } });
    const p = core.plan({ table: 'csv', units: [{ key: 'U1::DXX1::0', fp: 'c1' }, { key: 'GONE::X::9', fp: 'c1' }] });
    expect(p.toFill).toEqual([{ key: 'U1::DXX1::0', reason: 'blank' }]);
    expect(p.skipped).toEqual([{ key: 'GONE::X::9', reason: 'not-found' }]);
    const r = core.commit({ runId: p.runId, table: 'csv', key: 'U1::DXX1::0', fp: 'c1', result: { delayReason: 'Payment', escalation: 'SEV2', summary: 'n'.repeat(9000) } });
    expect(r.outcome).toBe('filled');
    expect(state.ann.csv.rows['U1::DXX1::0'].manual).toEqual({ delayReason: 'Payment', escalationAction: 'SEV2', supportPOC: 'pat', asanaLink: '', notes: 'n'.repeat(8000) });
    expect(state.fills.entries['csv|U1::DXX1::0']).toMatchObject({ assetId: 'U1', site: 'DXX1', day: DAY });
    core.finish({ runId: p.runId });
    expect(core.today({ table: 'csv' }).entries).toEqual({ 'U1::DXX1::0': { filledAt: new Date(T).toISOString() } });
    expect(core.today({ table: 'computed' }).entries).toEqual({});
  });

  it('a record whose asset/site no longer match the row is ignored (has-content, not in today)', () => {
    const csv = { importedAt: 'x', columns: [], rows: { 'K::S::0': row('U2', 'DYY2', { delayReason: 'Parts Delay', escalationAction: 'SEV4', notes: 'note' }) } };
    const fills = { version: 1, entries: { 'csv|K::S::0': rec('csv', 'K::S::0', { assetId: 'U1', site: 'DXX1' }) } };
    const { core } = mkCore({ csv, fills });
    expect(core.today({ table: 'csv' }).entries).toEqual({});
    const p = core.plan({ table: 'csv', units: [{ key: 'K::S::0', fp: 'fp1' }] });
    expect(p.skipped).toEqual([{ key: 'K::S::0', reason: 'has-content' }]);
    const ok = mkCore({ csv, fills: { version: 1, entries: { 'csv|K::S::0': rec('csv', 'K::S::0', { assetId: 'U2', site: 'DYY2' }) } } });
    expect(ok.core.plan({ table: 'csv', units: [{ key: 'K::S::0', fp: 'fp1' }] }).skipped).toEqual([{ key: 'K::S::0', reason: 'filled-today' }]);
  });
});

describe('helpers', () => {
  it('localDay uses the local calendar date; valuesHash trims', () => {
    expect(DAY).toBe('2026-11-04');
    expect(localDay(new Date(2026, 10, 4, 23, 59).getTime())).toBe('2026-11-04');
    expect(localDay(new Date(2026, 10, 5, 0, 1).getTime())).toBe('2026-11-05');
    expect(valuesHash([' a ', null, 'b'])).toBe(valuesHash(['a', '', 'b']));
    expect(valuesHash(['a', '', 'b'])).not.toBe(valuesHash(['a', 'b', '']));
  });
});
