'use strict';
/**
 * src/aperia/parsers.js — pure whitelisting parsers for the three allowed Aperia GETs.
 *
 * Every object leaving this module is built field by field: raw API objects never reach IPC, exports or
 * disk. `account` keeps its `name` (the domicile) only; contact blocks, numberOfRecipients and every
 * unlisted key are dropped.
 */
const { tireRow, gpsOf, gpsReason, fmtEt } = require('./rules');

const SHAPE = Object.freeze({ ok: false, code: 'APERIA_SHAPE_UNRECOGNIZED' });

function _obj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _str(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).slice(0, max || 200);
}
function _int(v) { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; }
function _name(o) { return _obj(o) ? _str(o.name, 80) : ''; }

/** unitKey(s) -> upper-case trimmed unit id (the lookup key). */
function unitKey(s) { return String(s ?? '').toUpperCase().trim(); }

function _vehicleRow(v) {
  if (!_obj(v)) return null;
  const id = _str(v.id, 64);
  if (!id) return null;
  const fleetVehicleId = _str(v.fleetVehicleId, 60);
  return {
    id,
    fleetVehicleId,
    unitKey: unitKey(fleetVehicleId),
    vin: _str(v.vin, 40),
    type: _str(v.type, 40),
    domicile: _name(v.account),
    group: _name(v.group),
  };
}

/** parseVehiclesPage(value) -> { ok:true, rows, totalPages, totalElements } | SHAPE. */
function parseVehiclesPage(value) {
  if (!_obj(value) || !Array.isArray(value.vehicles)) return Object.assign({}, SHAPE);
  return {
    ok: true,
    rows: value.vehicles.map(_vehicleRow).filter(Boolean),
    totalPages: _int(value.totalPages),
    totalElements: _int(value.totalElements),
  };
}

/** parseVehicleDetail(value, {now}) -> { ok:true, unit } | SHAPE. */
function parseVehicleDetail(value, opts) {
  if (!_obj(value) || !_str(value.id, 64)) return Object.assign({}, SHAPE);
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  const gw = _obj(value.gateway) ? value.gateway : {};
  const cs = _obj(value.coldSnap) ? value.coldSnap : {};
  const startedAt = _str(cs.startedAt, 40);
  const expiresAt = _str(cs.expiresAt, 40);
  const expMs = Date.parse(expiresAt);
  const pre = _obj(value.latestPreTripInspection) ? value.latestPreTripInspection : {};
  const tires = (Array.isArray(value.sensors) ? value.sensors : [])
    .filter(_obj)
    .map((s) => tireRow(s, now))
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
  const issues = tires.filter((t) => t.issue).map((t) => ({
    position: t.position,
    positionName: t.positionName,
    id: t.issue.id,
    severity: t.issue.severity,
    type: t.issue.type,
    resolveBy: t.issue.resolveBy,
    actions: t.issue.actions.slice(),
    createdAt: t.issue.createdAt,
    createdEt: t.issue.createdEt,
  }));
  return {
    ok: true,
    unit: {
      id: _str(value.id, 64),
      fleetVehicleId: _str(value.fleetVehicleId, 60),
      vin: _str(value.vin, 40),
      type: _str(value.type, 40),
      domicile: _name(value.account),
      group: _name(value.group),
      archived: value.archived === true,
      gateway: { type: _str(gw.type, 40), serialNumber: _str(gw.serialNumber, 60) },
      coldSnap: { active: !!startedAt && (!expiresAt || !Number.isFinite(expMs) || expMs > now), startedAt, expiresAt },
      preTripAt: _str(pre.loggedAt, 40),
      gps: gpsOf(value.latestGeoTag),
      gpsReason: gpsReason(value.latestGeoTag),
      tires,
      issues,
    },
  };
}

function _issueRow(r) {
  if (!_obj(r)) return null;
  const vehicleId = _str(r.id, 64);
  if (!vehicleId) return null;
  return {
    vehicleId,
    fleetVehicleId: _str(r.fleetVehicleId, 60),
    domicile: _name(r.account),
    group: _str(r.vehicleGroupName, 80),
    gatewaySerialNumber: _str(r.gatewaySerialNumber, 60),
    issues: (Array.isArray(r.issues) ? r.issues : []).filter(_obj).map((x) => ({
      id: _str(x.id, 64),
      severity: _str(x.severity, 20),
      state: _str(x.state, 60),
      position: _str(x.position, 20),
      positionName: _str(x.positionName, 60),
      dateDetected: _str(x.dateDetected, 40),
      muted: x.muted === true,
    })).filter((x) => x.id),
  };
}

/** parseIssuesPage(value) -> { ok:true, rows, totalPages, totalElements } | SHAPE. */
function parseIssuesPage(value) {
  if (!_obj(value) || !Array.isArray(value.content)) return Object.assign({}, SHAPE);
  return {
    ok: true,
    rows: value.content.map(_issueRow).filter(Boolean),
    totalPages: _int(value.totalPages),
    totalElements: _int(value.totalElements),
  };
}

/** flattenIssues(rows) -> one object per issue. */
function flattenIssues(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !Array.isArray(r.issues)) continue;
    for (const x of r.issues) {
      out.push({
        issueId: x.id,
        vehicleId: r.vehicleId,
        fleetVehicleId: r.fleetVehicleId,
        domicile: r.domicile,
        group: r.group,
        severity: x.severity,
        state: x.state,
        position: x.position,
        positionName: x.positionName,
        dateDetected: x.dateDetected,
        detectedEt: fmtEt(x.dateDetected),
        muted: x.muted === true,
      });
    }
  }
  return out;
}

/** domicilesOf(rows) -> sorted unique non-empty `domicile` values. */
function domicilesOf(rows) {
  const s = new Set();
  for (const r of Array.isArray(rows) ? rows : []) if (r && typeof r.domicile === 'string' && r.domicile) s.add(r.domicile);
  return Array.from(s).sort();
}

module.exports = { unitKey, parseVehiclesPage, parseVehicleDetail, parseIssuesPage, flattenIssues, domicilesOf };
