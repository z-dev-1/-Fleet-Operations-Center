// tests/wo-history-facts.test.js — Relay history trend through the fact layer: the Relay block's
// historyTrend, buildFactSet().history, rowMirrors.etcSlipCount, _factEtc.slip, the DBR Missed ETC
// suffix, the _factEstimateWhy suffix, no-history parity and the Decisiv create-only degrade.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import * as V from './fixtures/extract/relay-vendors.js';
import * as H from './fixtures/extract/history-shapes.js';
const require = createRequire(import.meta.url);
const X = require('../src/repair-intel/wo-extract');
const W = require('../src/repair-intel/wo-facts');
const F = require('../src/dbr/fleet-dbr');
const { makeUnit } = require('./fixtures/fleet-dbr/make-rows');
const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const FLAGS = { enabled: true, aiOutput: true };
const relay = (sd, o = {}) => X.extractRelay(sd, Object.assign({ now: NOW }, o));
const rowOf = (rf, extra = {}) => Object.assign({ equipmentId: 'U1', workRequestId: 'wr-x', relayFacts: rf, created: '2026-11-01T12:00:00Z' }, extra);

describe('block + fact set + mirrors', () => {
  const rf = relay(V.relayB12195, { history: H.histB12195Full, vendor: 'COX' });
  it('extractRelay attaches historyTrend when history is given', () => {
    expect(rf.historyTrend.etc.slipCount).toBe(1);
    expect(rf.historyTrend.etc.seq).toHaveLength(3);
  });
  it('buildFactSet carries history; rowMirrors.etcSlipCount; applyToRow -> _factEtc.slip', () => {
    const fs = W.buildFactSet(rowOf(rf), { today: TODAY });
    expect(fs.history).toBe(rf.historyTrend);
    expect(W.rowMirrors(fs).etcSlipCount).toBe(1);
    const row = W.applyToRow(rowOf(rf), fs, FLAGS);
    expect(row.etcSlipCount).toBe(1);
    expect(row._factEtc.slip).toEqual({ count: 1, seq: ['2026-11-09', '2026-11-08', '2026-11-10'] });
  });
  it('DBR: a missed unit with slips ends its Missed ETC line with the moved suffix', () => {
    const fs = W.buildFactSet(rowOf(rf), { today: TODAY });
    const row = W.applyToRow(rowOf(rf), fs, FLAGS);
    const fe = Object.assign({}, row._factEtc, { state: 'missed', date: '2026-11-10', explicitMissDate: '2026-11-10', source: 'relaygarage/vendor', snippet: 'ETC missed' });
    const u = makeUnit({ equipmentId: 'B12195', _factsOn: true, _factEtc: fe });
    expect(F.parseEtc(u, TODAY).slip).toEqual({ count: 1, seq: ['2026-11-09', '2026-11-08', '2026-11-10'] });
    const out = F.buildFleetDbr([u], { today: TODAY }).rows[0];
    // FEAT-002: the Missed ETC cell is the bare count; the why line moved to row.missedWhy.
    expect(out.cells.missedEtc).toBe('1');
    expect(out.missedWhy[0].why).toMatch(/; ETC moved 1\u00d7 \(11\/9\u219211\/8\u219211\/10\)$/);
  });
  it('DBR rows without slip are unchanged (same parseEtc result, same why)', () => {
    const fe = { date: '2026-11-10', kind: 'repairCompletion', state: 'missed', explicitMissDate: '2026-11-10', source: 'x', statedAt: null, snippet: 'ETC missed', negated: false, reason: null };
    const u = makeUnit({ equipmentId: 'B1', _factsOn: true, _factEtc: fe });
    expect('slip' in F.parseEtc(u, TODAY)).toBe(false);
    const why = (row) => { const r = F.buildFleetDbr([row], { today: TODAY }).rows[0]; return [r.cells.missedEtc, r.missedWhy.map((w) => w.unit + ': ' + w.why)]; };
    expect(why(u)).toEqual(['1', ["B1: ETC 11/10 explicitly missed: 'ETC missed'"]]);
    const zero = makeUnit({ equipmentId: 'B1', _factsOn: true, _factEtc: Object.assign({}, fe, { slip: { count: 0, seq: ['2026-11-10'] } }) });
    expect(why(zero)).toEqual(['1', ["B1: ETC 11/10 explicitly missed: 'ETC missed'"]]);
  });
});

describe('_factEstimateWhy suffix', () => {
  it('IND260261 approved after the rejections: no suffix (early return kept)', () => {
    const rf = relay(V.relayIND260261, { history: H.histIND260261, vendor: 'TA' });
    const row = W.applyToRow(rowOf(rf), W.buildFactSet(rowOf(rf), { today: TODAY }), FLAGS);
    expect(row._factEstimateWhy).toBe('');
  });
  it('still rejected: \' · rejected 3× since 10/31; $A→$B\', <= 160 chars', () => {
    const sd = Object.assign({}, V.relayIND260261, {
      workRequest: Object.assign({}, V.relayIND260261.workRequest, { comments: V.relayIND260261.workRequest.comments.slice(0, 3) }),
      workOrders: [Object.assign({}, V.relayIND260261.workOrders[0], {
        estimate: { state: 'REJECTED', totalCost: 24804.13, estimateUpdatedAt: null, estimateRejectionReason: 'Question/Concern' } })],
    });
    const rf = relay(sd, { history: H.histIND260261NoApproval, vendor: 'TA' });
    const row = W.applyToRow(rowOf(rf), W.buildFactSet(rowOf(rf), { today: TODAY }), FLAGS);
    expect(row._factEstimateWhy).toContain(' \u00b7 rejected 3\u00d7 since 10/31; $28,895.94\u2192$24,804.13');
    expect(row._factEstimateWhy.length).toBeLessThanOrEqual(160);
  });
});

describe('no-history parity and degrade', () => {
  it('a block built without history has no historyTrend key; fact set history null; mirror blank', () => {
    const b = relay(V.relay322355, { vendor: 'Amerit' });
    expect(JSON.stringify(b)).not.toContain('historyTrend');
    expect(JSON.stringify(relay(V.relay322355, { vendor: 'Amerit', history: [] }))).toBe(JSON.stringify(b));
    const fs = W.buildFactSet(rowOf(b), { today: TODAY });
    expect(fs.history).toBeNull();
    expect(W.rowMirrors(fs).etcSlipCount).toBe('');
    const row = W.applyToRow(rowOf(b), fs, FLAGS);
    expect('slip' in row._factEtc).toBe(false);
    expect('history' in W.digestForRi(fs)).toBe(false);
  });
  it('Decisiv create-only: no slip, etcSlipCount 0', () => {
    const rf = relay(V.relay322355, { history: H.hist39582CreateOnly });
    const fs = W.buildFactSet(rowOf(rf), { today: TODAY });
    expect(fs.history.createOnly).toBe(true);
    expect(W.rowMirrors(fs).etcSlipCount).toBe(0);
    const row = W.applyToRow(rowOf(rf), fs, FLAGS);
    expect('slip' in row._factEtc).toBe(false);
  });
  it('TA without ETC fields: no slip on _factEtc', () => {
    const rf = relay(V.relayIND260261, { history: H.histTaNoEtc, vendor: 'TA' });
    const row = W.applyToRow(rowOf(rf), W.buildFactSet(rowOf(rf), { today: TODAY }), FLAGS);
    expect(row.etcSlipCount).toBe(0);
    expect('slip' in row._factEtc).toBe(false);
  });
});
