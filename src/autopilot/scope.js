'use strict';
/**
 * autopilot/scope.js — scope checks (V1 §B6, V2 design §4.2). Pure.
 *
 *   buildScope(cfg)                     -> { units:Set, domicile, allUnits, mode, filter } (once per tick)
 *   matchesFilter(row, scope)           the filter-mode rule (listed unit OR every non-empty dimension)
 *   inScopeNew(row, scope, isDown)      down AND inScopeExisting
 *   inScopeExisting(row, scope)         fleet mode: any row with a unit; filter mode: matchesFilter
 *                                       (no isDown, so a recovered unit stays in scope until resolved)
 *   unitsNotInFleet(scope, rows)        filter-mode unit entries with no fleet row (plan R14); [] in fleet mode
 *   vendorOf(row)                       the only source of ap_case.vendor / ap_unit.vendor
 *
 * mode: a resolved config always carries scope.mode. For unresolved input (V1 tests,
 * raw objects) mode = explicit mode, else allUnits === true -> 'fleet', else 'filter'.
 * Effective filter: when all five filter lists are empty, the legacy V1 pilot
 * { domiciles: [domicile], units } applies (V2 §3.2).
 */

const { normUnit } = require('./constants');

function _lc(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function _list(v) { return Array.isArray(v) ? v : []; }

function vendorOf(row) {
  const r = row || {};
  return String(r.dealerName || r.vendor || '').trim().slice(0, 60);
}

function buildScope(cfg) {
  const s = (cfg && cfg.scope) || {};
  const mode = (s.mode === 'fleet' || s.mode === 'filter') ? s.mode : (s.allUnits === true ? 'fleet' : 'filter');
  const f = s.filter && typeof s.filter === 'object' ? s.filter : {};
  const lists = {
    domiciles: _list(f.domiciles), carriers: _list(f.carriers), scacs: _list(f.scacs),
    vendors: _list(f.vendors), units: _list(f.units),
  };
  const legacy = Object.values(lists).every((l) => l.length === 0);
  const legacyUnits = _list(s.units);
  const domicile = normUnit(s.domicile);
  const filter = legacy
    ? {
      domiciles: new Set(domicile ? [domicile] : []), scacs: new Set(), carriersLc: new Set(), vendorsLc: new Set(),
      units: new Set(legacyUnits.map(normUnit).filter(Boolean)),
    }
    : {
      domiciles: new Set(lists.domiciles.map(normUnit).filter(Boolean)),
      scacs: new Set(lists.scacs.map(normUnit).filter(Boolean)),
      carriersLc: new Set(lists.carriers.map(_lc).filter(Boolean)),
      vendorsLc: new Set(lists.vendors.map(_lc).filter(Boolean)),
      units: new Set(lists.units.map(normUnit).filter(Boolean)),
    };
  return {
    units: filter.units,
    domicile,
    allUnits: mode === 'fleet',
    mode,
    filter,
  };
}

function _hasUnit(row) { return !!row && typeof row.equipmentId === 'string' && normUnit(row.equipmentId) !== ''; }

function matchesFilter(row, scope) {
  if (!_hasUnit(row) || !scope) return false;
  const f = scope.filter || { domiciles: new Set(), scacs: new Set(), carriersLc: new Set(), vendorsLc: new Set(), units: scope.units || new Set() };
  if (f.units && f.units.has(normUnit(row.equipmentId))) return true;
  const dims = [
    [f.domiciles, () => normUnit(row.domicileSite)],
    [f.scacs, () => normUnit(row.operator)],
    [f.carriersLc, null],
    [f.vendorsLc, () => _lc(vendorOf(row))],
  ];
  let any = false;
  for (const [set, valueOf] of dims) {
    if (!set || set.size === 0) continue;
    any = true;
    if (valueOf === null) {
      if (!(set.has(_lc(row.operator)) || set.has(_lc(row.owner)))) return false;
    } else if (!set.has(valueOf())) {
      return false;
    }
  }
  if (any) return true;
  return !(f.units && f.units.size > 0);
}

function inScopeExisting(row, scope) {
  if (!_hasUnit(row) || !scope) return false;
  if (scope.mode === 'fleet' || (scope.mode === undefined && scope.allUnits)) return true;
  return matchesFilter(row, scope);
}

function inScopeNew(row, scope, isDown) {
  if (!_hasUnit(row) || typeof isDown !== 'function' || !isDown(row)) return false;
  return inScopeExisting(row, scope);
}

function unitsNotInFleet(scope, rows) {
  if (!scope || scope.mode === 'fleet' || (scope.mode === undefined && scope.allUnits)) return [];
  const have = new Set();
  for (const r of rows || []) if (_hasUnit(r)) have.add(normUnit(r.equipmentId));
  const units = (scope.filter && scope.filter.units) || scope.units || [];
  return Array.from(units).filter((u) => !have.has(u));
}

module.exports = { buildScope, matchesFilter, inScopeNew, inScopeExisting, unitsNotInFleet, vendorOf };
