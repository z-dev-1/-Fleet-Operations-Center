// AC46: the example JSON embedded in OUTPUT_CONTRACT / MAP_CONTRACT / REDUCE_CONTRACT (design §3),
// parsed out of the contract text itself and run through the gate against the §3 example
// evidence (tests/fixtures/fleet-dbr/contract-example-evidence.js), gives 0 drops, 0 name flags,
// 0 unbound dates and 0 envOver. Also the comma form "11/10 called TA, bay confirmed for 11/12".
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const AI = require('../src/dbr/fleet-dbr-ai');
const G = require('../src/dbr/fleet-dbr-gate');
const { extractJsonObject } = require('../src/utils/ai-json');
const { makeCtx } = require('./fixtures/fleet-dbr/envelope');
const X = require('./fixtures/fleet-dbr/contract-example-evidence');

const s = makeCtx({ units: X.UNITS, enrich: X.ENRICH, today: X.TODAY, fasNames: X.FAS_NAMES });
function exampleOf(contract) {
  const at = contract.indexOf(AI.EXAMPLE_LABEL);
  expect(at).toBeGreaterThan(0);
  const obj = extractJsonObject(contract.slice(at + AI.EXAMPLE_LABEL.length));
  expect(obj && typeof obj).toBe('object');
  return obj;
}
function clean(view) {
  expect(view.removals).toEqual([]);
  expect(view.dropReasons).toEqual({});
  expect(view.unverifiedNames).toEqual([]);
  expect(view.unboundDates).toEqual([]);
  expect(view.envOver).toBe(0);
}

describe('AC46 contract examples pass the gate', () => {
  it('OUTPUT_CONTRACT row example', () => {
    const ex = exampleOf(AI.OUTPUT_CONTRACT);
    expect(ex).toEqual(JSON.parse(JSON.stringify(AI.ROW_EXAMPLE)));
    const d = G.validateRowDraft(ex, s.ctx, { kind: 'row' });
    expect(d.ok).toBe(true);
    const view = G.renderCells(d, s.ctx);
    clean(view);
    expect(view.etcDisagreements).toEqual([]);
    expect(Object.keys(d.fas).sort()).toEqual(['B61001', 'B61002', 'B61004']);
    for (const b of ['vendor1p', 'oem', 'partner', 'parts']) expect(d.barriers[b].entries).toHaveLength(1);
    expect(d.support.entries).toHaveLength(1);
  });

  it('MAP_CONTRACT example', () => {
    const ex = exampleOf(AI.MAP_CONTRACT);
    const r = G.validateMapFacts(ex, ['B61001'], s.ctx);
    expect(r.ok).toBe(true);
    expect(r.meta.removals).toEqual([]);
    expect(r.meta.envOver).toBe(0);
    const u = r.units.B61001;
    expect(u.missing).toBe(false);
    expect(u.barriers.vendor1p.fact).toBe('TA Rochester: no diesel tech until 11/12');
    expect(u.fasAction).toMatchObject({ names: [], unbound: [] });
    expect(u.etc).toMatchObject({ state: 'future', origin: 'ai' });
  });

  it('REDUCE_CONTRACT example', () => {
    const ex = exampleOf(AI.REDUCE_CONTRACT);
    const d = G.validateRowDraft(ex, s.ctx, { kind: 'reduce' });
    expect(d.ok).toBe(true);
    clean(G.renderCells(d, s.ctx));
    expect(d.barriers.vendor1p.entries).toHaveLength(1);
  });

  it('every SHEET_EXAMPLES cell passes validateSheet against evidence built from its own units', () => {
    // The 11-11 golden ROC5|AUVTE units (synthetic fields worded like the golden cells).
    const u = (vendor, savedRepairStatus, issueSummary, workDuration, extra) => Object.assign({ vendor, savedRepairStatus, issueSummary, workDuration }, extra || {});
    const g = makeCtx({ today: '2026-11-11', units: {
      B12267: u('COX', 'Parts ordered', 'Turbo seals leaking, CAC line', '20d'),
      B62059: u('COX', 'Parts ordered', 'Hood shocks broken, air drain lines worn', '8d'),
      B12263: u('COX', 'Parts ordered', 'Crankcase seal leaking oil', '6d'),
      B12195: u('COX', 'Parts ordered', 'Corroded battery terminals, batteries and cables', '4d'),
      B12275: u('KWNE', 'Parts ordered', 'Key snapped in ignition during PM-B, CNG filter housing and tumbler', '13d'),
      B12258: u('KWNE', 'Parts ordered', 'CEL harness repin', '15d'),
      B12271: u('Freightliner', 'Under diagnosis', 'Compression loss, cyl 3 misfire', '3d'),
      B13014: u('DSP_ENTERED', 'Awaiting estimate', 'Accident, hood detached', '59d', { lifecycleReason: 'Accident' }),
      B62064: u('FLEETNET', 'Waiting for vendor', 'Impounded, fee payment required before tow to ROC5', '15d', { lifecycleReason: 'Impounded Tow' }),
      B20038: u('', 'Waiting for vendor', 'Tach parasitic drain', '2d'),
    } });
    const ex = AI.SHEET_EXAMPLES;
    expect(Object.keys(ex)).toEqual(['vendor1pDetails', 'oemDetails', 'partnerDetails', 'partsDetails', 'commonDetails', 'fasActions', 'support']);
    for (const b of ['vendor1p', 'oem', 'partner', 'parts', 'common']) expect(g.ctx.rules[b].yn, b).toBe('Y');
    const r = G.validateSheet({ sheet: ex }, g.ctx);
    expect(r.drops).toEqual({});
    expect(r.sheet).toEqual(ex);
  });

  it('the comma form passes too', () => {
    const g = G.gateEntry('11/10 called TA, bay confirmed for 11/12', { fas: [{ date: '11/10', quote: 'called TA re tech callout' }] }, ['B61001'], s.ctx, { field: 'fasActions' });
    expect(g).toMatchObject({ ok: true, names: [], unbound: [], envOver: false });
  });
});
