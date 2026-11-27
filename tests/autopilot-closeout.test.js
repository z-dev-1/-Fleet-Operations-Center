// tests/autopilot-closeout.test.js — "repair complete, awaiting return tow / case close-out"
// (READY_PENDING_CLOSEOUT): the analyze.js predicate on the 322283 and FLD260703 evidence shapes,
// the ambiguous shapes that must keep today's status_conflict output, and the fallback actions.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { analyze, closeoutApplies, CLOSEOUT_BLOCKER } = require('../src/autopilot/analyze');
const { deterministicRecommendation } = require('../src/autopilot/fallback');
const { buildConflicts } = require('../src/autopilot/conflicts');
const { SUB_STATES } = require('../src/autopilot/constants');
const evidence = require('../src/autopilot/evidence');

const NOW = Date.parse('2026-11-26T08:13:00Z');
const ms = (s) => Date.parse(s);
const R322283 = ['OOS', 'DWELL_EXCEEDED', 'LONG_DWELL_LISTED', 'STATUS_CONFLICT', 'REPAIRED_UNVERIFIED', 'RECURRING_DEFECT'];
const RFLD = ['OOS', 'DWELL_EXCEEDED', 'LONG_DWELL_LISTED', 'ETA_NOT_PROVIDED', 'STATUS_CONFLICT', 'REPAIRED_UNVERIFIED', 'RECURRING_DEFECT'];

/**
 * Build a pack. o: { life ('Unavailable'), mirror (aap_cache offsiteStage value or null), mirrorSince,
 *   decisiv: [{ value, since, live, flags }], dtna: [{ value, since }], canonical ('ready_for_pickup' or null),
 *   dealerNames: [[source, name]], untrustedAt }
 */
function mkPack(o) {
  const col = evidence.createCollector({ now: NOW });
  const ids = {};
  if (o.life) ids.life = col.add('aap_cache', 'lifecycleState', o.life, { row: {}, buildAtMs: NOW }, { sourceRef: 'row/lifecycleState' }).evidenceId;
  if (o.mirror) ids.mirror = col.add('aap_cache', 'offsiteStage', o.mirror, { row: { offsiteStageSince: o.mirrorSince }, buildAtMs: NOW }, { sourceRef: 'row/offsiteStage' }).evidenceId;
  col.add('aap_cache', 'partsStatus', 'arrived', { row: {}, buildAtMs: NOW }, { sourceRef: 'row/partsStatus' });
  ids.decisiv = (o.decisiv || []).map((d, k) => col.add('decisiv', 'stage', d.value, { entry: { since: d.since }, retrievedAt: NOW },
    { sourceRef: 'decisiv/' + k, live: !!d.live, retrievedAt: NOW, flags: d.flags }).evidenceId);
  ids.dtna = (o.dtna || []).map((d, k) => col.add('dtna', 'offsiteStage', d.value, { entry: { stageSince: d.since, pulledAt: NOW } }, { sourceRef: 'dtna/c' + k }).evidenceId);
  for (const [src, name] of o.dealerNames || []) {
    if (src === 'aap_cache') col.add('aap_cache', 'dealerName', name, { row: {}, buildAtMs: NOW }, { sourceRef: 'row/dealerName' });
    else col.add(src, 'dealerName', name, { entry: { stageSince: o.mirrorSince, pulledAt: NOW } }, { sourceRef: src + '/dn' });
  }
  if (o.canonical) ids.canon = col.add('canonical', 'status', o.canonical, { record: {} }, { sourceRef: 'canonical/status' }).evidenceId;
  if (o.untrustedAt) col.add('slack', 'message', 'Ready for Pickup - Action: arrange tow/return', { message: { ts: o.untrustedAt }, retrievedAt: NOW }, { sourceRef: 'slack/1' });
  const items = col.items;
  const conflicts = buildConflicts(items, { isDown: true });
  for (const it of items) { const g = conflicts.memberOf[it.evidenceId]; it.conflictGroup = g && g.length ? g[0] : null; }
  return { pack: { items, conflicts }, ids };
}

const caseRec = (unit, reasons, downSince, extra) => Object.assign({
  unit_id: unit, reasons_json: JSON.stringify(reasons.map((code) => ({ code }))), down_since: downSince,
  days_down: Math.round((NOW - downSince) / 864e4) / 10, eta_json: JSON.stringify({ status: 'NOT_PROVIDED', date: null, source: null }),
}, extra || {});

// 322283: decisiv stage ready (cache + live duplicate), AAP mirror ready, canonical ready_for_pickup, AAP Unavailable.
function shape322283(over) {
  return mkPack(Object.assign({
    life: 'Unavailable', mirror: 'ready', mirrorSince: '2026-11-25T20:27:00Z', canonical: 'ready_for_pickup',
    decisiv: [{ value: 'ready', since: '2026-11-24T14:00:00Z' }, { value: 'ready', since: '2026-11-25T16:00:00Z', live: true }],
  }, over || {}));
}
// FLD260703: dtna offsiteStage ready (observed > 3 days before NOW, so STALE), no decisiv.
function shapeFld(over) {
  return mkPack(Object.assign({
    life: 'Unavailable', mirror: 'ready', mirrorSince: '2026-11-22T09:00:00Z', canonical: 'ready_for_pickup',
    dtna: [{ value: 'ready', since: '2026-11-22T09:00:00Z' }],
  }, over || {}));
}
const DOWN_322283 = ms('2026-09-16T12:00:00Z');
const DOWN_FLD = ms('2026-11-17T12:00:00Z');

describe('closeout predicate (analyze)', () => {
  it('322283 shape (decisiv ready) -> READY_PENDING_CLOSEOUT with the four evidence kinds', () => {
    const { pack, ids } = shape322283();
    expect(pack.conflicts.groups.map((g) => g.group)).toEqual(['cf_status']);
    const a = analyze(pack, caseRec('322283', R322283, DOWN_322283), {});
    expect(a.closeout).toBeTruthy();
    expect(a.closeout.subState).toBe(SUB_STATES.READY_PENDING_CLOSEOUT);
    expect(a.closeout.readySources).toEqual(['aap_cache offsiteStage', 'decisiv stage']);
    expect(a.closeout.readySince).toBe(ms('2026-11-24T14:00:00Z'));
    for (const id of [ids.life, ids.mirror, ...ids.decisiv, ids.canon]) expect(a.closeout.evidenceIds).toContain(id);
    expect(a.repairPhase).toBe('ready_for_pickup');
    expect(closeoutApplies(a, a.conflictGroups)).toBe(a.closeout);
  });

  it('FLD260703 shape (dtna ready, STALE, ETA_NOT_PROVIDED) -> READY_PENDING_CLOSEOUT', () => {
    const { pack, ids } = shapeFld();
    const dt = pack.items.find((i) => i.evidenceId === ids.dtna[0]);
    expect(dt.freshness).toBe('STALE');
    const a = analyze(pack, caseRec('FLD260703', RFLD, DOWN_FLD), {});
    expect(a.closeout && a.closeout.subState).toBe('READY_PENDING_CLOSEOUT');
    expect(a.closeout.readySources).toEqual(['aap_cache offsiteStage', 'dtna offsiteStage']);
    expect(a.closeout.evidenceIds).toEqual(expect.arrayContaining([ids.life, ids.mirror, ids.dtna[0], ids.canon]));
  });

  const AMBIGUOUS = [
    ['211022: canonical ready + Unavailable only, DOWN_SINCE_UNKNOWN, no REPAIRED_UNVERIFIED',
      () => mkPack({ life: 'Unavailable', canonical: 'ready_for_pickup' }), ['OOS', 'DOWN_SINCE_UNKNOWN', 'STATUS_CONFLICT'], null],
    ['later FLD260703: new WO, no aap offsiteStage, cf_dealerName group',
      () => shapeFld({ mirror: null, dealerNames: [['aap_cache', 'FleetNet America'], ['dtna', 'Berman Trucks']] }), RFLD, DOWN_FLD],
    ['pilot FLD260703: dtna repair + canonical ready', () => shapeFld({ dtna: [{ value: 'repair', since: '2026-11-23T21:43:00Z' }] }), RFLD, DOWN_FLD],
    ['aap mirror ready only (no dealer item)', () => shapeFld({ dtna: [] }), RFLD, DOWN_FLD],
    ['decisiv repair + aap mirror ready', () => shape322283({ decisiv: [{ value: 'repair', since: '2026-11-24T14:00:00Z' }] }), R322283, DOWN_322283],
    ['conflicting dealer sources (decisiv ready, dtna repair)',
      () => shape322283({ dtna: [{ value: 'repair', since: '2026-11-24T15:00:00Z' }] }), R322283, DOWN_322283],
    ['dealer ready observed before down_since (prior episode)', () => shapeFld(), RFLD, ms('2026-11-24T00:00:00Z')],
    ['WAITING_PARTS present', () => shape322283(), R322283.concat('WAITING_PARTS'), DOWN_322283],
    ['missing down_since', () => shape322283(), R322283, null],
    ['newer untrusted text', () => shape322283({ untrustedAt: NOW + 60000 }), R322283, DOWN_322283],
    ['a ready item with wo_association_mismatch',
      () => shape322283({ decisiv: [{ value: 'ready', since: '2026-11-24T14:00:00Z', flags: ['wo_association_mismatch'] }] }), R322283, DOWN_322283],
    ['AAP lifecycle Active', () => shape322283({ life: 'Active' }), R322283, DOWN_322283],
    ['missing canonical status', () => shape322283({ canonical: null }), R322283, DOWN_322283],
  ];
  for (const [name, build, reasons, down] of AMBIGUOUS) {
    it('no close-out: ' + name, () => {
      const { pack } = build();
      const a = analyze(pack, caseRec('U1', reasons, down), {});
      if (name.startsWith('newer untrusted')) expect(a.untrustedNewer).toBe(true);
      expect(a.closeout).toBe(null);
    });
  }

  it('closeoutApplies is null when a published group is not cf_status', () => {
    const { pack } = shape322283();
    const a = analyze(pack, caseRec('322283', R322283, DOWN_322283), {});
    expect(closeoutApplies(a, a.conflictGroups.concat([{ group: 'cf_dealerName' }]))).toBe(null);
    expect(closeoutApplies(a, [])).toBe(null);
    expect(closeoutApplies({}, a.conflictGroups)).toBe(null);
    expect(CLOSEOUT_BLOCKER).toBe('ready_pending_closeout');
  });
});

describe('closeout recommendation (fallback)', () => {
  const run = (shape, unit, reasons, down) => {
    const { pack, ids } = shape();
    const a = analyze(pack, caseRec(unit, reasons, down, { dealer: undefined }), {});
    return { a, pack, ids, out: deterministicRecommendation(a, pack, { now: NOW }) };
  };

  for (const [unit, shape, reasons, down, srcs] of [
    ['322283', shape322283, R322283, DOWN_322283, 'aap_cache offsiteStage and decisiv stage'],
    ['FLD260703', shapeFld, RFLD, DOWN_FLD, 'aap_cache offsiteStage and dtna offsiteStage'],
  ]) {
    it(unit + ': specific close-out actions, closeable summary, not stalled', () => {
      const { a, out } = run(shape, unit, reasons, down);
      const all = out.recommendedActions.concat(out.actionsRequiringApproval);
      expect(out.recommendedActions[0]).toMatchObject({ actionClass: 'verify_in_system' });
      expect(out.recommendedActions[0].action).toMatch(/^Repair complete: .* report ready since \d{4}-\d{2}-\d{2}\. Check whether the unit went Active in AAP; this case is closeable/);
      expect(out.recommendedActions[0].action).toContain(srcs);
      expect(out.actionsRequiringApproval.slice(0, 3).map((x) => x.actionClass)).toEqual(['vendor_follow_up', 'lifecycle_change', 'wo_update']);
      expect(out.actionsRequiringApproval[0].action).toMatch(/^Arrange the return tow from .* to the yard if it is not already scheduled\.$/);
      expect(out.actionsRequiringApproval[1].action).toMatch(/^Set the unit Active in AAP once it is back/);
      expect(out.actionsRequiringApproval[2].action).toBe('Close out the RelayGarage case for this repair once the unit is Active in AAP.');
      for (const x of out.actionsRequiringApproval) expect(x).toMatchObject({ requiresApproval: true, executed: false });
      for (const x of out.actionsRequiringApproval.slice(0, 3)) expect(x.evidenceIds).toEqual(a.closeout.evidenceIds);
      expect(all.some((x) => /^Review the conflicting status/.test(x.action))).toBe(true);
      expect(all.some((x) => /^Confirm return to service/.test(x.action))).toBe(false);
      expect(all.some((x) => /for an ETC/.test(x.action))).toBe(false);
      expect(out.missingInfo.map((m) => m.item)).not.toContain('Repair ETC');
      expect(out.summary).toMatch(/repair complete, awaiting return tow \/ case close-out \(closeable, not a stalled repair\)/);
      expect(out.summary.length).toBeLessThanOrEqual(400);
      expect(out.stageStall).toMatchObject({ stalled: false, stage: 'ready' });
      expect(out.stageStall.evidenceIds).toEqual(a.closeout.evidenceIds);
      expect(out.urgency).toBe('normal');
      expect(out.nextReviewInHours).toBe(4);
    });
  }

  it('the same analysis without closeout keeps today\'s generic output (regression guard)', () => {
    const { a, pack } = run(shapeFld, 'FLD260703', RFLD, DOWN_FLD);
    const out = deterministicRecommendation(Object.assign({}, a, { closeout: null }), pack, { now: NOW });
    const all = out.recommendedActions.concat(out.actionsRequiringApproval);
    expect(all.find((x) => x.actionClass === 'lifecycle_change').action).toMatch(/^Confirm return to service/);
    expect(all.some((x) => /^Ask .* for an ETC/.test(x.action))).toBe(true);
    expect(out.missingInfo.map((m) => m.item)).toContain('Repair ETC');
    expect(out.stageStall).toEqual({ stalled: null, stage: 'unknown', reasoning: 'not assessed (AI unavailable)', confidence: 0, evidenceIds: [] });
    expect(out.summary).not.toMatch(/closeable/);
  });

  for (const [name, shape, reasons, down] of [
    ['211022 shape', () => mkPack({ life: 'Unavailable', canonical: 'ready_for_pickup' }), ['OOS', 'DOWN_SINCE_UNKNOWN', 'STATUS_CONFLICT', 'REPAIRED_UNVERIFIED'], null],
    ['mirror-only shape', () => shapeFld({ dtna: [] }), RFLD, DOWN_FLD],
  ]) {
    it(name + ': output equals the closeout:null output; lifecycle action is the generic one', () => {
      const { a, pack } = run(shape, 'U1', reasons, down);
      expect(a.closeout).toBe(null);
      const out = deterministicRecommendation(a, pack, { now: NOW });
      expect(out).toEqual(deterministicRecommendation(Object.assign({}, a, { closeout: null }), pack, { now: NOW }));
      expect(out.actionsRequiringApproval.find((x) => x.actionClass === 'lifecycle_change').action).toMatch(/^Confirm return to service/);
    });
  }
});
