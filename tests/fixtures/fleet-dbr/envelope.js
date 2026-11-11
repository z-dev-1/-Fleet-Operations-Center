// Envelope helpers for the Fleet DBR gate / AI tests (design §3, §12 revision 5).
// F(d, q) = one src.fas item; env({ fas }) = a src envelope; makeCtx builds a synthetic
// (domicile x SCAC) pair through the real builder + evidence module + gateContext.
'use strict';
const { makeUnit } = require('./make-rows');
const { buildFleetDbr } = require('../../../src/dbr/fleet-dbr');
const { buildUnitEvidence } = require('../../../src/dbr/fleet-dbr-evidence');
const { gateContext, syntheticIds } = require('../../../src/dbr/fleet-dbr-gate');

const F = (date, quote) => ({ date, quote });
const env = ({ fas } = {}) => ({ fas: fas || [] });

// units: { [equipmentId]: fields } or [fields] (use equipmentId '' for "(no id)" units).
// enrich: { [downId]: { canonical, manualEntries, email } }.
function makeCtx({ units, enrich = {}, today, fleetIds = [], fasNames = ['Z Santiago'], fasAlias = '' } = {}) {
  const list = Array.isArray(units) ? units : Object.entries(units || {}).map(([id, f]) => Object.assign({ equipmentId: id }, f));
  const rawRows = list.map((f) => makeUnit(Object.assign({ domicileSite: 'TST1', operator: 'TSCA', lifecycleState: 'Unavailable' }, f)));
  const built = buildFleetDbr(rawRows, { today });
  const row = built.rows.find((r) => r.key === 'TST1|TSCA');
  const ids = syntheticIds(row.units);
  const byId = new Map(rawRows.filter((r) => r.equipmentId).map((r) => [r.equipmentId, r]));
  const noId = rawRows.filter((r) => !r.equipmentId);
  let k = 0;
  const evidences = row.units.map((u, i) => {
    const raw = u.id === '(no id)' ? noId[k++] : byId.get(u.id);
    return buildUnitEvidence(raw, Object.assign({}, u, { id: ids[i] }), enrich[ids[i]] || {}, today, fasNames, fasAlias);
  });
  const ctx = gateContext({ row, evidences, fleetIds, today, unitRows: rawRows });
  return { ctx, row, built, rawRows, evidences };
}

module.exports = { F, env, makeCtx };
