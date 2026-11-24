import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TZ = 'America/New_York';

const { detect, etaStatus, daysDownOf, parseWorkDuration, openingRule, openingRulesApply } = require('../src/autopilot/detect');
const { buildScope } = require('../src/autopilot/scope');
const { resolveAutopilotConfig } = require('../src/autopilot/config');
const { isAuthoritativeEtcTag, unitIndex, UNIT_KEY_OF, localDate } = require('../src/autopilot/constants');
const { newestLoggedUpdate } = require('../src/autopilot/updates');

const MIN = 60000;
const DAY = 86400000;
const NOW = new Date(2026, 10, 10, 12, 0).getTime(); // 2026-11-10 12:00 local
const TODAY = '2026-11-10';
const BUILD = NOW - 10 * MIN;
const isDown = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');
const ALL_ON = { oosInvestigation: true, longDwellInvestigation: true, evidenceCollection: true, aiInvestigation: true, localHistory: true, liveReads: true };

function ctx(extra) {
  return Object.assign({
    scope: buildScope(resolveAutopilotConfig({}, {})), oosDays: 3, features: ALL_ON, staleDays: 3, now: NOW,
    buildAtMs: BUILD, syncedAt: new Date(BUILD).toISOString(), isDown, canonical: () => null,
    longDwell: { store: {}, csvRows: {} }, cacheIndex: { dtna: new Map(), decisiv: new Map() }, riRepeat: () => [],
  }, extra || {});
}
const row = (extra) => Object.assign({
  equipmentId: 'X1', domicileSite: 'ABE40', lifecycleState: 'Unavailable', workDuration: '1d 0h 0m',
  fullConversation: '11/10 - Vendor: still on it', repairEtc: '2026-11-20', repairEtcSource: 'decisiv',
}, extra || {});
const codes = (c) => c.reasons.map((r) => r.code);
const one = (r, x) => detect([r], ctx(x))[0];

describe('scope filter (AC-1)', () => {
  it('creates candidates only for in-scope down units', () => {
    const rows = [
      row({ equipmentId: 'A1' }),
      row({ equipmentId: 'B13014', domicileSite: 'DFW7' }),
      row({ equipmentId: 'OUT1', domicileSite: 'DFW7', workDuration: '30d' }),
      row({ equipmentId: 'A2', lifecycleState: 'Active' }),
    ];
    expect(detect(rows, ctx()).map((c) => c.unitId)).toEqual(['A1', 'B13014']);
    const all = ctx({ scope: buildScope({ scope: { domicile: 'ABE40', units: [], allUnits: true } }) });
    expect(detect(rows, all).map((c) => c.unitId)).toEqual(['A1', 'B13014', 'OUT1']);
  });

  it('a listed " b13014 " matches row B13014', () => {
    const s = buildScope(resolveAutopilotConfig({ autopilot: { scope: { domicile: '', units: [' b13014 '] } } }, {}));
    const out = detect([row({ equipmentId: 'B13014', domicileSite: 'DFW7', workDuration: '5d' })], ctx({ scope: s }));
    expect(out.map((c) => c.unitId)).toEqual(['B13014']);
    expect(out[0].openedBy).toBe('oos_rule');
  });

  it('out-of-scope rows never reach reason computation (riRepeat spy)', () => {
    const riRepeat = vi.fn(() => []);
    const canonical = vi.fn(() => null);
    detect([row({ equipmentId: 'OUT1', domicileSite: 'DFW7' }), row({ equipmentId: 'OUT2', domicileSite: 'SEA1' })], ctx({ riRepeat, canonical }));
    expect(riRepeat).not.toHaveBeenCalled();
    expect(canonical).not.toHaveBeenCalled();
    detect([row({ equipmentId: 'b13014', domicileSite: 'DFW7' })], ctx({ riRepeat }));
    expect(riRepeat).toHaveBeenCalledWith('b13014');
  });
});

describe('days down and DWELL_EXCEEDED (AC-2, R1)', () => {
  it('parses "Nd Nh Nm" with missing parts', () => {
    expect(parseWorkDuration('2d 23h 50m')).toBeCloseTo(2 + 23 / 24 + 50 / 1440, 9);
    expect(parseWorkDuration('5h')).toBeCloseTo(5 / 24, 9);
    expect(parseWorkDuration('3d')).toBe(3);
    expect(parseWorkDuration('')).toBe(null);
    expect(parseWorkDuration('n/a')).toBe(null);
  });

  it('"2d 23h 50m" plus time since the build crosses oosDays 3 at 10 minutes', () => {
    const r = row({ workDuration: '2d 23h 50m' });
    const before = one(r, { buildAtMs: NOW - 9 * MIN });
    expect(codes(before)).not.toContain('DWELL_EXCEEDED');
    expect(before.openedBy).toBe(null);
    const after = one(r, { buildAtMs: NOW - 11 * MIN });
    expect(codes(after)).toContain('DWELL_EXCEEDED');
    expect(after.openedBy).toBe('oos_rule');
  });

  it('oosDays - 1 days with no other opening reason opens nothing; oosDays opens oos_rule', () => {
    const at = (wd) => one(row({ workDuration: wd }), { buildAtMs: NOW });
    expect(at('2d').openedBy).toBe(null);
    expect(at('3d').openedBy).toBe('oos_rule');
    expect(one(row({ workDuration: '4d' }), { buildAtMs: NOW, oosDays: 5 }).openedBy).toBe(null);
  });

  it('(c) daysDown uses the build time, so a syncedAt re-stamp does not change it', () => {
    const r = row({ workDuration: '2d' });
    const a = daysDownOf(r, { now: NOW, buildAtMs: BUILD, syncedAt: new Date(BUILD).toISOString() });
    const b = daysDownOf(r, { now: NOW, buildAtMs: BUILD, syncedAt: new Date(NOW - MIN).toISOString() });
    expect(b).toBe(a);
    expect(a).toBeCloseTo(2 + 10 / 1440, 9);
    expect(daysDownOf(r, { now: NOW, buildAtMs: null, syncedAt: new Date(NOW - 60 * MIN).toISOString() })).toBeCloseTo(2 + 60 / 1440, 9);
  });

  it('falls back to the WR created date, else null days down with DOWN_SINCE_UNKNOWN', () => {
    expect(daysDownOf(row({ workDuration: null, created: new Date(NOW - 4 * DAY).toISOString() }), { now: NOW })).toBeCloseTo(4, 6);
    const c = one(row({ workDuration: null, created: null }));
    expect(c.daysDown).toBe(null);
    expect(c.downSince).toBe(null);
    expect(codes(c)).toContain('DOWN_SINCE_UNKNOWN');
    expect(codes(c)).not.toContain('DWELL_EXCEEDED');
  });

  it('down_since = now - daysDown', () => {
    const c = one(row({ workDuration: '2d' }), { buildAtMs: NOW });
    expect(c.downSince).toBe(NOW - 2 * DAY);
    expect(c.buildAtMs).toBe(NOW);
  });
});

describe('ETC classes (AC-4)', () => {
  it('isAuthoritativeEtcTag truth table', () => {
    const yes = ['decisiv', 'DECISIV', 'offsiteevent', 'offsiteevent/dtna', 'OffsiteEvent/DTNA', 'relaygarage/vendor', 'relaygarage/vendor/x', 'decisiv/x'];
    const no = ['', null, undefined, 'notes', 'notes/email', 'relaygarage', 'relaygarage/fas', 'relaygarage/approver', 'fleetdata', 'relaygarage/vendorx', 'xdecisiv'];
    for (const t of yes) expect(isAuthoritativeEtcTag(t), String(t)).toBe(true);
    for (const t of no) expect(isAuthoritativeEtcTag(t), String(t)).toBe(false);
  });

  it('_factEtc missed -> VERIFIED_OVERDUE; missing _factEtc counts as none', () => {
    expect(etaStatus(row({ _factEtc: { state: 'missed', date: '2026-11-01', source: 'relaygarage' } }), [], TODAY, NOW).status).toBe('VERIFIED_OVERDUE');
    expect(etaStatus(row({ etcMissed: true }), [], TODAY, NOW).status).toBe('VERIFIED_OVERDUE');
    expect(etaStatus(row({ repairEtc: null }), [], TODAY, NOW).status).toBe('NOT_PROVIDED');
  });

  it('a past repairEtc from an authoritative source is VERIFIED_OVERDUE; from others PAST_UNVERIFIED only', () => {
    for (const src of ['decisiv', 'offsiteevent/dtna', 'relaygarage/vendor']) {
      const c = one(row({ repairEtc: '2026-11-05', repairEtcSource: src }));
      expect(codes(c), src).toContain('ETA_OVERDUE_VERIFIED');
      expect(codes(c), src).not.toContain('ETA_PAST_UNVERIFIED');
      expect(c.openedBy).toBe('hard_condition');
    }
    for (const src of ['notes', 'notes/email', 'relaygarage', 'relaygarage/fas', 'relaygarage/approver']) {
      const c = one(row({ repairEtc: '2026-11-05', repairEtcSource: src }));
      expect(codes(c), src).toContain('ETA_PAST_UNVERIFIED');
      expect(codes(c), src).not.toContain('ETA_OVERDUE_VERIFIED');
      expect(c.openedBy, src).toBe(null);
    }
    expect(etaStatus(row({ repairEtc: '2026-11-05', repairEtcSource: 'decisiv', completed: true }), [], TODAY, NOW).status).toBe('PAST_UNVERIFIED');
  });

  it('no ETC date from any source -> ETA_NOT_PROVIDED; a cache ETC counts', () => {
    const c = one(row({ repairEtc: null, repairEtcSource: null }));
    expect(codes(c)).toContain('ETA_NOT_PROVIDED');
    const withCache = one(row({ repairEtc: null, decisivCaseId: 'E1' }), { cacheIndex: { dtna: new Map(), decisiv: new Map([['E1', { stage: 'repair', repairEtc: '2026-11-03' }]]) } });
    expect(codes(withCache)).toContain('ETA_PAST_UNVERIFIED');
    expect(codes(withCache)).not.toContain('ETA_NOT_PROVIDED');
  });

  it('at most one ETC class applies', () => {
    const variants = [
      row({ _factEtc: { state: 'missed', date: '2026-11-01' }, repairEtc: '2026-11-02', repairEtcSource: 'notes' }),
      row({ repairEtc: '2026-11-02', repairEtcSource: 'notes', _factEtc: { state: 'future', date: '2026-12-01' } }),
      row({ repairEtc: null }), row({ repairEtc: '2026-12-01' }),
    ];
    for (const r of variants) {
      const etaCodes = codes(one(r)).filter((x) => x.startsWith('ETA_'));
      expect(etaCodes.length).toBeLessThanOrEqual(1);
    }
  });

  it('future / today / negated', () => {
    expect(etaStatus(row({ repairEtc: '2026-11-12' }), [], TODAY, NOW)).toMatchObject({ status: 'FUTURE', date: '2026-11-12' });
    expect(etaStatus(row({ repairEtc: TODAY }), [], TODAY, NOW).status).toBe('TODAY');
    expect(etaStatus(row({ repairEtc: '11/12' }), [], TODAY, NOW)).toMatchObject({ status: 'FUTURE', date: '2026-11-12' });
    expect(etaStatus(row({ repairEtc: null, _factEtc: { state: 'none', negated: true } }), [], TODAY, NOW).status).toBe('NEGATED');
  });

  it('local-date boundary: ETC = today at 23:59 vs 00:01 the next day under a fixed TZ', () => {
    const r = row({ repairEtc: '2026-11-10', repairEtcSource: 'decisiv' });
    const late = new Date(2026, 10, 10, 23, 59).getTime();
    const early = new Date(2026, 10, 11, 0, 1).getTime();
    expect(localDate(late)).toBe('2026-11-10');
    expect(localDate(early)).toBe('2026-11-11');
    expect(codes(one(r, { now: late, buildAtMs: late }))).not.toContain('ETA_OVERDUE_VERIFIED');
    expect(codes(one(r, { now: early, buildAtMs: early }))).toContain('ETA_OVERDUE_VERIFIED');
  });
});

describe('other reason codes', () => {
  it('UPDATE_STALE uses fullConversation dates with the year rule and never _convFetchedAt', () => {
    const sync = new Date(2027, 0, 2, 12, 0).getTime();
    expect(newestLoggedUpdate('12/30 - Bob: hi\n01/01 - Ann: ok', new Date(sync).toISOString())).toBe(new Date(2027, 0, 1).getTime());
    expect(newestLoggedUpdate('12/30 - Bob: hi', new Date(sync).toISOString())).toBe(new Date(2026, 11, 30).getTime());
    const r = row({ fullConversation: '12/28 - Bob: waiting', _convFetchedAt: new Date(sync).toISOString(), _stageReadAt: new Date(sync).toISOString(), repairEtc: '2027-01-10' });
    const c = one(r, { now: sync, buildAtMs: sync, syncedAt: new Date(sync).toISOString() });
    expect(codes(c)).toContain('UPDATE_STALE');
    const fresh = one(row({ fullConversation: '01/01 - Bob: ok', repairEtc: '2027-01-10' }), { now: sync, buildAtMs: sync, syncedAt: new Date(sync).toISOString() });
    expect(codes(fresh)).not.toContain('UPDATE_STALE');
  });

  it('UPDATE_STALE with no update times falls back to daysDown >= staleDays; canonical stale forces it', () => {
    expect(codes(one(row({ fullConversation: '', workDuration: '4d' })))).toContain('UPDATE_STALE');
    expect(codes(one(row({ fullConversation: '', workDuration: '1d' })))).not.toContain('UPDATE_STALE');
    expect(codes(one(row(), { canonical: () => ({ stale: true }) }))).toContain('UPDATE_STALE');
  });

  it('ANNOTATION_STALE when the long-dwell annotation is older than staleDays', () => {
    const store = { 'x1::wo1': { updatedAt: new Date(NOW - 5 * DAY).toISOString() } };
    const c = one(row(), { longDwell: { store, csvRows: {} } });
    expect(codes(c)).toContain('LONG_DWELL_LISTED');
    expect(codes(c)).toContain('ANNOTATION_STALE');
    expect(c.openedBy).toBe('long_dwell');
  });

  it('waiting parts / estimate / scheduling', () => {
    expect(codes(one(row({ partsStatus: 'Backorder' })))).toContain('WAITING_PARTS');
    expect(codes(one(row(), { canonical: () => ({ status: 'awaiting_parts' }) }))).toContain('WAITING_PARTS');
    expect(codes(one(row({ offsiteStage: 'approval' })))).toContain('WAITING_ESTIMATE_APPROVAL');
    expect(codes(one(row(), { canonical: () => ({ status: 'awaiting_estimate_approval' }) }))).toContain('WAITING_ESTIMATE_APPROVAL');
    expect(codes(one(row({ serviceState: 'Created' })))).toContain('AWAITING_SCHEDULING');
    expect(codes(one(row({ subState: 'Waiting for work order' })))).toContain('AWAITING_SCHEDULING');
    expect(codes(one(row({ serviceState: 'Created', vendorWorkOrderId: 'V1' })))).not.toContain('AWAITING_SCHEDULING');
    expect(codes(one(row({ serviceState: 'Created', offsiteStage: 'repair' })))).not.toContain('AWAITING_SCHEDULING');
  });

  it('REPAIRED_UNVERIFIED from canonical, offsite stage, cache stage or completed', () => {
    expect(codes(one(row(), { canonical: () => ({ status: 'ready_for_pickup' }) }))).toContain('REPAIRED_UNVERIFIED');
    expect(codes(one(row({ offsiteStage: 'Ready' })))).toContain('REPAIRED_UNVERIFIED');
    expect(codes(one(row({ completed: '2026-11-09' })))).toContain('REPAIRED_UNVERIFIED');
    const dt = new Map([['X1', [{ unitId: 'X1', offsiteStage: 'ready' }]]]);
    const c = one(row(), { cacheIndex: { dtna: dt, decisiv: new Map() } });
    expect(codes(c)).toContain('REPAIRED_UNVERIFIED');
    expect(c.openedBy).toBe('hard_condition');
  });

  it('STATUS_CONFLICT from row fields or disagreeing cached DTNA / Decisiv stages', () => {
    expect(codes(one(row({ canonicalConflictCount: 1 })))).toContain('STATUS_CONFLICT');
    expect(codes(one(row({ factConflicts: 2 })))).toContain('STATUS_CONFLICT');
    const dt = new Map([['X1', [{ offsiteStage: 'repair' }]]]);
    const dec = new Map([['E1', { stage: 'approval' }]]);
    expect(codes(one(row({ decisivCaseId: 'E1' }), { cacheIndex: { dtna: dt, decisiv: dec } }))).toContain('STATUS_CONFLICT');
    const same = new Map([['E1', { stage: 'repair' }]]);
    expect(codes(one(row({ decisivCaseId: 'E1' }), { cacheIndex: { dtna: dt, decisiv: same } }))).not.toContain('STATUS_CONFLICT');
  });

  it('RECURRING_DEFECT when repeatOffenders lists the unit', () => {
    expect(codes(one(row(), { riRepeat: () => [{ component: 'brakes', count: 2 }] }))).toContain('RECURRING_DEFECT');
    expect(codes(one(row()))).not.toContain('RECURRING_DEFECT');
  });
});

describe('opening rules per feature toggle (and R8)', () => {
  it('oosInvestigation OFF opens nothing for dwell / hard conditions; longDwell OFF ignores the listing', () => {
    const r = row({ workDuration: '5d' });
    expect(one(r, { features: Object.assign({}, ALL_ON, { oosInvestigation: false }) }).openedBy).toBe(null);
    const listed = { longDwell: { store: { X1: { updatedAt: new Date(NOW).toISOString() } }, csvRows: {} } };
    expect(one(row(), Object.assign({ features: Object.assign({}, ALL_ON, { longDwellInvestigation: false }) }, listed)).openedBy).toBe(null);
    expect(one(row(), listed).openedBy).toBe('long_dwell');
    expect(one(row({ workDuration: '5d' }), Object.assign({ features: Object.assign({}, ALL_ON, { oosInvestigation: false }) }, listed)).openedBy).toBe('long_dwell');
  });

  it('long-dwell CSV rows are matched by assetId', () => {
    const csvRows = { 'x1::ABE40::0': { assetId: ' x1 ', csv: {} } };
    expect(codes(one(row(), { longDwell: { store: {}, csvRows } }))).toContain('LONG_DWELL_LISTED');
  });

  it('R8: a long_dwell case that also has DWELL_EXCEEDED is not paused when only Long-Dwell is off', () => {
    const reasons = [{ code: 'OOS' }, { code: 'LONG_DWELL_LISTED' }, { code: 'DWELL_EXCEEDED' }];
    expect(openingRulesApply(reasons, Object.assign({}, ALL_ON, { longDwellInvestigation: false }))).toBe(true);
    expect(openingRulesApply([{ code: 'OOS' }, { code: 'LONG_DWELL_LISTED' }], Object.assign({}, ALL_ON, { longDwellInvestigation: false }))).toBe(false);
    expect(openingRulesApply(reasons, Object.assign({}, ALL_ON, { oosInvestigation: false }))).toBe(true);
    expect(openingRulesApply(reasons, Object.assign({}, ALL_ON, { oosInvestigation: false, longDwellInvestigation: false }))).toBe(false);
    expect(openingRulesApply([{ code: 'ETA_PAST_UNVERIFIED' }, { code: 'UPDATE_STALE' }], ALL_ON)).toBe(false);
    expect(openingRule(['OOS', 'STATUS_CONFLICT'], ALL_ON)).toBe('hard_condition');
  });
});

describe('unitIndex lookups for row B13014', () => {
  it('finds emailEvidence[" b13014"], a lowercase longDwellStore key and fasCases["unit-b13014"]', () => {
    expect(unitIndex({ ' b13014': [{}], OTHER: [] }, UNIT_KEY_OF.emailEvidence).get('B13014')).toEqual([' b13014']);
    expect(unitIndex({ 'b13014::wo9': {}, B13014: {} }, UNIT_KEY_OF.longDwellStore).get('B13014')).toEqual(['b13014::wo9', 'B13014']);
    expect(unitIndex({ 'unit-b13014': {} }, UNIT_KEY_OF.fasCases).get('B13014')).toEqual(['unit-b13014']);
    expect(unitIndex(null).size).toBe(0);
  });
});
