'use strict';
/**
 * src/aperia/fleet-scope.js — which Aperia units are "the user's units": the fleet rows (live
 * ctx.lastData.rows, else the stored fleetData rows), keyed by normUnit(equipmentId).
 *
 *   fleetUnitSet(ctx, deps?) -> Set of normUnit(row.equipmentId)  (deps.store test seam)
 *   fromRows(rows)           -> the same Set from an explicit row array
 *   inScope(set, fleetVehicleId) -> boolean (normUnit(fleetVehicleId) in set)
 *
 * Pure reads; never throws (any failure -> empty Set / false).
 */
const { normUnit } = require('../dtna/join');

function fromRows(rows) {
  const out = new Set();
  try {
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r !== 'object') continue;
      const k = normUnit(r.equipmentId);
      if (k) out.add(k);
    }
  } catch (_) { return new Set(); }
  return out;
}

function fleetUnitSet(ctx, deps) {
  try {
    const live = ctx && ctx.lastData && Array.isArray(ctx.lastData.rows) ? ctx.lastData.rows : [];
    if (live.length) return fromRows(live);
    const store = (deps && deps.store) || require('../store');
    const fd = store.load('fleetData', {}) || {};
    return fromRows(Array.isArray(fd.rows) ? fd.rows : []);
  } catch (_) { return new Set(); }
}

function inScope(set, fleetVehicleId) {
  try {
    if (!(set instanceof Set) || !set.size) return false;
    const k = normUnit(fleetVehicleId);
    return !!k && set.has(k);
  } catch (_) { return false; }
}

module.exports = { fleetUnitSet, fromRows, inScope };
