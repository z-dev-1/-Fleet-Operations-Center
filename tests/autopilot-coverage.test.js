// tests/autopilot-coverage.test.js — Autopilot V2 AC-4: per-pass coverage counts, reconciliation
// identities and authorized-scope tokens (design §4.3) over the fleet-v2 fixture.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TZ = 'America/New_York';

const F = require('./helpers/autopilot-fakes.cjs');
const { buildPass, reconcile } = require('../src/autopilot/coverage');
const { classifyEquipment } = require('../src/autopilot/equipment');
const { detect } = require('../src/autopilot/detect');
const { buildScope } = require('../src/autopilot/scope');
const { resolveAutopilotConfig } = require('../src/autopilot/config');

const NOW = new Date(2026, 10, 20, 12, 0).getTime();
const isDown = (r) => /unavail/i.test(String((r && r.lifecycleState) || ''));
const ALL_ON = { oosInvestigation: true, longDwellInvestigation: true, evidenceCollection: true, aiInvestigation: true, localHistory: true, liveReads: true };

function runPass(opts) {
  const o = opts || {};
  const rows = F.fleetV2();
  const scope = buildScope(resolveAutopilotConfig({ autopilot: { scope: o.scope || {} } }, {}));
  const features = Object.assign({}, ALL_ON, o.features || {});
  const eligible = rows.filter((r) => classifyEquipment(r).cls === 'POWER_ELIGIBLE');
  const cands = detect(eligible, {
    scope, oosDays: 3, features, staleDays: 3, now: NOW, buildAtMs: NOW - 600000, syncedAt: new Date(NOW - 600000).toISOString(),
    isDown, canonical: () => null, longDwell: { store: {}, csvRows: {} }, cacheIndex: { dtna: new Map(), decisiv: new Map() }, riRepeat: () => [],
  });
  const detectCands = new Map(cands.map((c) => [c.unitId, c]));
  return buildPass({
    rows, scope, features, oosDays: 3, isDown, detectCands,
    openCasesByUnit: o.openCasesByUnit || new Map(), authorizedTokens: o.authorizedTokens, now: NOW, buildAtMs: NOW - 600000,
  });
}

describe('fleet-v2 fixture', () => {
  it('has >= 6 domiciles, 6 SCACs, 4 owners, no V1 allowlist id and every equipment class', () => {
    const rows = F.fleetV2();
    const doms = new Set(rows.map((r) => r.domicileSite));
    const scacs = new Set(rows.map((r) => r.operator));
    const owners = new Set(rows.map((r) => r.owner));
    expect(doms.size).toBeGreaterThanOrEqual(6);
    expect(scacs.size).toBe(6);
    expect(owners.size).toBe(4);
    const { DEFAULT_UNITS } = require('../src/autopilot/config');
    expect(rows.some((r) => DEFAULT_UNITS.includes(String(r.equipmentId).trim().toUpperCase()))).toBe(false);
    const classes = new Set(rows.map((r) => classifyEquipment(r).cls));
    expect(classes.size).toBe(7);
  });
});

describe('buildPass (AC-4)', () => {
  it('counts every row and both identities hold (fleet mode, all features on)', () => {
    const { pass, units } = runPass({ openCasesByUnit: new Map([['T100', 'ap_open1']]) });
    expect(pass).toMatchObject({
      mode: 'fleet', fleet_rows: 25, duplicate_rows: 2, invalid_rows: 3,
      eligible: 9, excluded_trailer: 4, excluded_hostler: 4, excluded_unsupported: 1, type_unknown: 1, type_conflict: 1,
      down_eligible: 6, case_open: 5, below_threshold: 1, out_of_filter: 0, feature_off: 0, opened: 4, held: 0, reconcile_ok: 1,
    });
    expect(reconcile(pass)).toEqual({ ok: true, rowsDiff: 0, downDiff: 0 });
    expect(units.length).toBe(20);
    const byId = new Map(units.map((u) => [u.unit_id, u]));
    expect(byId.get('T100')).toMatchObject({ coverage: 'case_open', case_id: 'ap_open1', eligibility: 'POWER_ELIGIBLE', equipment_class: 'tractor', operator: 'TUZR', owner: 'AZNG', vendor: 'Penske Allentown', is_down: 1 });
    expect(byId.get('T101').coverage).toBe('below_threshold');
    expect(byId.get('T103').coverage).toBe('not_down');
    expect(byId.get('TR201')).toMatchObject({ coverage: 'excluded', eligibility: 'EXCLUDED_TRAILER', exclusion_code: 'trailer' });
    expect(byId.get('YT501')).toMatchObject({ coverage: 'excluded', eligibility: 'EXCLUDED_HOSTLER' });
    expect(byId.get('UK600').coverage).toBe('type_unknown');
    expect(byId.get('CF700')).toMatchObject({ coverage: 'type_conflict', exclusion_code: 'body_trailer' });
    for (const u of units) expect(u.row_hash).toMatch(/^[a-f0-9]{40}$/);
    const dom = JSON.parse(pass.by_domicile_json);
    expect(dom.ABE40).toEqual({ eligible: 1, down: 1, case_open: 1 });
    expect(JSON.parse(pass.by_operator_json).TUZR).toEqual({ eligible: 2, down: 1, case_open: 1 });
    expect(Object.keys(JSON.parse(pass.by_owner_json)).sort()).toEqual(['AZNG', 'Element', 'Penske', 'Ryder']);
  });

  it('the last duplicate row wins', () => {
    const { units } = runPass();
    expect(units.filter((u) => u.unit_id === 'T100').map((u) => u.vendor)).toEqual(['Penske Allentown']);
    expect(units.filter((u) => u.unit_id === 'T102').length).toBe(1);
  });

  it('feature_off when an opening rule would apply with both features on', () => {
    const { pass } = runPass({ features: { oosInvestigation: false, longDwellInvestigation: false }, openCasesByUnit: new Map([['T100', 'ap_open1']]) });
    expect(pass).toMatchObject({ down_eligible: 6, case_open: 1, feature_off: 4, below_threshold: 1, out_of_filter: 0, opened: 0, reconcile_ok: 1 });
  });

  it("out_of_filter in filter mode (scacs ['TUZR'])", () => {
    const { pass, units } = runPass({ scope: { mode: 'filter', filter: { scacs: ['TUZR'] } } });
    expect(pass).toMatchObject({ mode: 'filter', down_eligible: 6, case_open: 1, out_of_filter: 5, below_threshold: 0, feature_off: 0, reconcile_ok: 1 });
    expect(units.find((u) => u.unit_id === 'T101').coverage).toBe('out_of_filter');
  });

  it('a counter mismatch makes reconcile false', () => {
    const { pass } = runPass();
    expect(reconcile(Object.assign({}, pass, { eligible: pass.eligible + 1 }))).toEqual({ ok: false, rowsDiff: -1, downDiff: 0 });
    expect(reconcile(Object.assign({}, pass, { case_open: pass.case_open - 1 })).ok).toBe(false);
  });

  it("authorizedTokens ['ABE40','ZZZ9'] -> tokens_without_rows ['ZZZ9'] (matched on domicile or operator)", () => {
    expect(JSON.parse(runPass({ authorizedTokens: ['ABE40', 'ZZZ9'] }).pass.tokens_without_rows_json)).toEqual(['ZZZ9']);
    expect(JSON.parse(runPass({ authorizedTokens: ['tuzr', 'QQQ1', 'AAA1'] }).pass.tokens_without_rows_json)).toEqual(['AAA1', 'QQQ1']);
    expect(JSON.parse(runPass({ authorizedTokens: [] }).pass.tokens_without_rows_json)).toEqual([]);
    expect(runPass({ authorizedTokens: ['ZZZ9'] }).pass.reconcile_ok).toBe(1);
  });

  it('caps the per-value groups at 200 keys plus (other)', () => {
    const rows = [];
    for (let i = 0; i < 250; i++) rows.push({ equipmentId: 'U' + i, domicileSite: 'D' + i, operator: 'OP', owner: 'OW', assetType: 'tractor', lifecycleState: 'Active' });
    const { pass } = buildPass({ rows, scope: buildScope({ scope: { mode: 'fleet' } }), isDown, detectCands: new Map(), now: NOW });
    const dom = JSON.parse(pass.by_domicile_json);
    expect(Object.keys(dom).length).toBe(201);
    expect(dom['(other)'].eligible).toBe(50);
    expect(pass.reconcile_ok).toBe(1);
  });
});
