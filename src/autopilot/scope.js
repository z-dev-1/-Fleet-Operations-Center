'use strict';
/**
 * autopilot/scope.js — pilot scope checks (§B6). Pure.
 *
 *   buildScope(cfg)                     -> { units:Set, domicile, allUnits } (once per tick)
 *   inScopeNew(row, scope, isDown)      down AND (allUnits | listed | domicile match)
 *   inScopeExisting(row, scope)         allUnits | listed | domicile match (no isDown,
 *                                       so a recovered ABE40 unit stays in scope until resolved)
 *   unitsNotInFleet(scope, rows)        allowlist entries with no fleet row (plan R14)
 */

const { normUnit } = require('./constants');

function buildScope(cfg) {
  const s = (cfg && cfg.scope) || {};
  return {
    units: new Set((Array.isArray(s.units) ? s.units : []).map(normUnit).filter(Boolean)),
    domicile: normUnit(s.domicile),
    allUnits: s.allUnits === true,
  };
}

function _hasUnit(row) { return !!row && typeof row.equipmentId === 'string' && normUnit(row.equipmentId) !== ''; }

function inScopeExisting(row, scope) {
  if (!_hasUnit(row) || !scope) return false;
  if (scope.allUnits) return true;
  if (scope.units && scope.units.has(normUnit(row.equipmentId))) return true;
  return !!scope.domicile && normUnit(row.domicileSite) === scope.domicile;
}

function inScopeNew(row, scope, isDown) {
  if (!_hasUnit(row) || typeof isDown !== 'function' || !isDown(row)) return false;
  return inScopeExisting(row, scope);
}

function unitsNotInFleet(scope, rows) {
  const have = new Set();
  for (const r of rows || []) if (_hasUnit(r)) have.add(normUnit(r.equipmentId));
  return Array.from((scope && scope.units) || []).filter((u) => !have.has(u));
}

module.exports = { buildScope, inScopeNew, inScopeExisting, unitsNotInFleet };
