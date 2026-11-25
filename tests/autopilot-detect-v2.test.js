// tests/autopilot-detect-v2.test.js — Autopilot V2 full-fleet detection at the controller level
// (design §4.4, §8.3): AC-2 every eligible down unit with an opening rule on the fleet-v2 fixture
// gets a case in fleet mode with no allowlist in settings, AC-3 non-power units never do, AC-5 the
// equipment sweep pauses / requeues the same case_id, the SAFETY_CRITICAL tag and coverage counts.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });
const F = require('./helpers/autopilot-fakes.cjs');
const { classifyEquipment } = require('../src/autopilot/equipment');
const { normUnit } = require('../src/autopilot/constants');

const { MIN } = F;
const FLEET = { scope: { mode: 'fleet' } };
const OPENED = ['T100', 'T102', 'T104', 'T107', 'T108'];

beforeEach(() => { vi.restoreAllMocks(); F.freshDb('detv2'); });

// The pool runs a stub so the cases stay where detection and the sweeps put them.
function mkEnv(over) {
  const o = over || {};
  const world = o.world || F.mkWorld({ rows: F.fleetV2() });
  const calls = [];
  const runInvestigation = async (caseId, deps) => { calls.push({ caseId, trigger: deps.trigger }); return { ok: true, caseId, outcome: 'noop' }; };
  const env = F.mkEnv(Object.assign({ world, autopilot: FLEET, runInvestigation }, o));
  env.calls = calls;
  return env;
}
const byUnit = () => new Map(F.cs.listOpen().map((c) => [c.unit_id, c]));
const rowOf = (env, unit) => env.world.rows.find((r) => typeof r.equipmentId === 'string' && normUnit(r.equipmentId) === unit);

describe('full-fleet detection (AC-2, AC-3)', () => {
  it('every eligible down unit with an opening rule gets a QUEUED case in fleet mode; no allowlist in settings', async () => {
    const env = mkEnv();
    expect(env.settings.doc.domiciles).toBeUndefined();
    expect(env.ap.status().config.scope.mode).toBe('fleet');
    const r = await env.ctl.runOnce({ forceDetect: true });
    expect(r.detected).toBe(OPENED.length);
    const open = byUnit();
    expect([...open.keys()].sort()).toEqual(OPENED);
    for (const c of open.values()) {
      expect(c.state).toBe('QUEUED');
      expect(['tractor', 'boxTruck']).toContain(c.equipment_class);
      expect(c.operator).toBeTruthy();
    }
    // Every unit that is down, power-eligible and has an opening rule is covered by a case.
    const covered = F.cs.listUnits({ coverage: 'case_open', limit: 200 }).items.map((u) => u.unit_id).sort();
    expect(covered).toEqual(OPENED);
  });

  it('non-power units never get a case, even when down for weeks (AC-3)', async () => {
    const env = mkEnv();
    await env.ctl.runOnce({ forceDetect: true });
    env.clock.advance(40 * MIN);
    await env.ctl.runOnce({ forceDetect: true });
    const open = byUnit();
    for (const r of F.fleetV2()) {
      if (typeof r.equipmentId !== 'string' || !normUnit(r.equipmentId)) continue;
      if (classifyEquipment(r).cls !== 'POWER_ELIGIBLE') expect(open.has(normUnit(r.equipmentId)), r.equipmentId).toBe(false);
    }
    const excluded = F.cs.listUnits({ coverage: 'excluded', limit: 200 }).items;
    expect(excluded.length).toBe(9);
    for (const u of excluded) expect(u.case_id).toBe(null);
  });

  it('coverage counts reconcile against the full fleet row count', async () => {
    const env = mkEnv();
    const r = await env.ctl.runOnce({ forceDetect: true });
    expect(r.coverage).toMatchObject({ reconcileOk: true, held: 0 });
    const cv = F.cs.coverage(env.clock.now());
    expect(cv.reconcileOk).toBe(true);
    expect(cv.pass).toMatchObject({
      mode: 'fleet', fleet_rows: F.fleetV2().length, duplicate_rows: 2, invalid_rows: 3, eligible: 9, excluded_trailer: 4,
      excluded_hostler: 4, excluded_unsupported: 1, type_unknown: 1, type_conflict: 1, down_eligible: 6, case_open: 5,
      below_threshold: 1, out_of_filter: 0, feature_off: 0, opened: 5, held: 0,
    });
    // fleet_rows - duplicates = every class count; the ap_unit table has one row per unit.
    expect(F.cs.listUnits({ limit: 200 }).total).toBe(F.fleetV2().length - 2 - 3);
    expect(env.ap.status().coverage.reconcileOk).toBe(true);
  });
});

describe('SAFETY_CRITICAL tag (§8.3)', () => {
  it('Damaged-Severe, Sensor Detected Damage and an accident down cause are tagged; others are not', async () => {
    const world = F.mkWorld({ rows: F.fleetV2() });
    const ports = Object.assign({}, F.fakePorts(world), { downCause: (row) => (row && row.equipmentId === 'T104' ? { cause: 'accident' } : null) });
    const env = mkEnv({ world, ports });
    await env.ctl.runOnce({ forceDetect: true });
    const open = byUnit();
    for (const u of ['T102', 'T107', 'T104']) {
      const c = open.get(u);
      expect(c.safety, u).toBe(1);
      expect(c.reasons.find((x) => x.code === 'SAFETY_CRITICAL'), u).toEqual({ code: 'SAFETY_CRITICAL', fields: ['lifecycleReason'] });
      expect(c.priority, u).toBeGreaterThanOrEqual(80);
    }
    for (const u of ['T100', 'T108']) {
      expect(open.get(u).safety, u).toBe(0);
      expect(open.get(u).reasons.some((x) => x.code === 'SAFETY_CRITICAL'), u).toBe(false);
      expect(open.get(u).priority, u).toBeLessThanOrEqual(54);
    }
    // The tag orders the queue: safety cases are picked first.
    expect(env.calls.slice(0, 3).map((x) => F.cs.getCase(x.caseId).case.unit_id).sort()).toEqual(['T102', 'T104', 'T107']);
  });
});

describe('equipment sweep (AC-5)', () => {
  it('a unit switched to trailer -> PAUSED not_power_unit; back to a box truck -> QUEUED with the same case_id', async () => {
    const env = mkEnv();
    await env.ctl.runOnce({ forceDetect: true });
    const id = byUnit().get('T104').case_id;
    rowOf(env, 'T104').assetType = 'trailer';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    let c = F.cs.getCase(id).case;
    expect(c).toMatchObject({ state: 'PAUSED', pause_reason: 'not_power_unit' });
    rowOf(env, 'T104').assetType = 'Box Truck';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    c = F.cs.getCase(id).case;
    expect(c.case_id).toBe(id);
    expect(c.state).toBe('QUEUED');
    const tr = F.cs.getCase(id).events.filter((e) => e.kind === 'transition').pop();
    expect(tr).toMatchObject({ to_state: 'QUEUED', reason_code: 'eligible' });
    expect(F.cs.listOpen().filter((x) => x.unit_id === 'T104').length).toBe(1);
    expect(env.calls.some((x) => x.caseId === id && x.trigger === 'eligible')).toBe(true);
  });

  it('an empty asset type -> PAUSED type_unverified', async () => {
    const env = mkEnv();
    await env.ctl.runOnce({ forceDetect: true });
    const id = byUnit().get('T108').case_id;
    rowOf(env, 'T108').assetType = '';
    env.clock.advance(MIN);
    await env.ctl.runOnce();
    expect(F.cs.getCase(id).case).toMatchObject({ state: 'PAUSED', pause_reason: 'type_unverified' });
  });
});
