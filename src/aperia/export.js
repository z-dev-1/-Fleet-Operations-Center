'use strict';
/**
 * src/aperia/export.js — TSV / Excel export of whitelisted Aperia rows with a formula-injection guard.
 *
 * String cells: tab / CR / LF become spaces and a leading = + - @ gets a "'" prefix. Finite numbers stay
 * plain numbers (a number cannot carry a formula; a negative PSI delta must stay numeric). The map image
 * URL is never exported.
 */
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { generateExcel } = require('../utils/excel-export');

const TIRE_COLUMNS = Object.freeze(['unit', 'domicile', 'group', 'vin', 'position', 'positionName', 'pressurePsi', 'setPointPsi', 'deltaPsi',
  'pctOfSetPoint', 'temperatureF', 'readAtEt', 'flag', 'issueSeverity', 'issueType', 'issueResolveBy', 'issueAction', 'gpsLat',
  'gpsLng', 'gpsAtEt', 'gpsOutsideUs', 'lookup']);
const ISSUE_COLUMNS = Object.freeze(['severity', 'unit', 'domicile', 'group', 'state', 'position', 'positionName', 'detectedEt', 'muted', 'issueId']);
const CROSSLINK_COLUMNS = Object.freeze(['unit', 'domicile', 'criticalCount', 'states', 'positions', 'latestDetectedEt', 'inFleet', 'closedDtnaCases']);

/** cell(v) -> finite number as is | guarded string. */
function cell(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : '';
  let s = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  s = s.replace(/[\t\r\n]+/g, ' ');
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function _n(v) { return typeof v === 'number' && Number.isFinite(v) ? v : ''; }
function _yn(v) { return v ? 'YES' : 'NO'; }
function _keep(domicile) {
  const d = typeof domicile === 'string' ? domicile : '';
  return (row) => !d || row.domicile === d;
}

/** tireRows(results, {domicile}) -> one row per tire; a not-found unit -> one row with lookup 'NOT FOUND'. */
function tireRows(results, opts) {
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== 'object') continue;
    if (!r.found || !r.unit) {
      const row = {};
      for (const c of TIRE_COLUMNS) row[c] = '';
      row.unit = String(r.assetId ?? '');
      row.lookup = !r.code || r.code === 'APERIA_UNIT_NOT_FOUND' ? 'NOT FOUND' : String(r.code);
      out.push(row);
      continue;
    }
    const u = r.unit;
    const g = u.gps;
    const base = {
      unit: u.fleetVehicleId || String(r.assetId ?? ''), domicile: u.domicile || '', group: u.group || '', vin: u.vin || '',
      gpsLat: g ? g.lat : '', gpsLng: g ? g.lng : '', gpsAtEt: g ? g.atEt : '', gpsOutsideUs: g ? _yn(g.outsideUs) : '',
      lookup: 'OK',
    };
    const tires = Array.isArray(u.tires) && u.tires.length ? u.tires : [null];
    for (const t of tires) {
      const x = t || {};
      const iss = x.issue || null;
      out.push(Object.assign({}, base, {
        position: x.position || '', positionName: x.positionName || '',
        pressurePsi: _n(x.pressure), setPointPsi: _n(x.setPoint), deltaPsi: _n(x.deltaPsi), pctOfSetPoint: _n(x.pct),
        temperatureF: _n(x.temperatureF), readAtEt: x.readAtEt || '', flag: x.flag || '',
        issueSeverity: iss ? iss.severity : '', issueType: iss ? iss.type : '', issueResolveBy: iss ? iss.resolveBy : '',
        issueAction: iss && Array.isArray(iss.actions) ? iss.actions.join(' | ') : '',
      }));
    }
  }
  return out.filter(_keep(opts && opts.domicile));
}

/** issueRows(rows, {domicile}) -> export rows from flattened issues. */
function issueRows(rows, opts) {
  return (Array.isArray(rows) ? rows : []).filter((x) => x && typeof x === 'object').map((x) => ({
    severity: x.severity || '', unit: x.fleetVehicleId || '', domicile: x.domicile || '', group: x.group || '',
    state: x.state || '', position: x.position || '', positionName: x.positionName || '', detectedEt: x.detectedEt || '',
    muted: _yn(x.muted === true), issueId: x.issueId || '',
  })).filter(_keep(opts && opts.domicile));
}

/** crossLinkRows(rows, {domicile}) -> export rows from crossLinkCriticalNoCase output. */
function crossLinkRows(rows, opts) {
  return (Array.isArray(rows) ? rows : []).filter((x) => x && typeof x === 'object').map((x) => ({
    unit: x.fleetVehicleId || '', domicile: x.domicile || '', criticalCount: _n(x.criticalCount),
    states: Array.isArray(x.states) ? x.states.join(', ') : '', positions: Array.isArray(x.positions) ? x.positions.join(', ') : '',
    latestDetectedEt: x.latestDetectedEt || '', inFleet: _yn(x.inFleet), closedDtnaCases: _n(x.closedDtnaCases),
  })).filter(_keep(opts && opts.domicile));
}

/** toTSV(columns, rows) -> header + rows, tab separated, CRLF line ends, every cell guarded. */
function toTSV(columns, rows) {
  const lines = [columns.map(cell).join('\t')];
  for (const r of Array.isArray(rows) ? rows : []) lines.push(columns.map((c) => cell(r[c])).join('\t'));
  return lines.join('\r\n') + '\r\n';
}

const _DAY = new Intl.DateTimeFormat('en-CA', { timeZone: C.TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function _ymd(date) {
  const d = date instanceof Date ? date : new Date(Number.isFinite(date) ? date : Date.now());
  return _DAY.format(Number.isFinite(d.getTime()) ? d : new Date());
}

/** writeExport({kind, columns, rows, format:'tsv'|'xls', dir, date}) -> { filename }. */
function writeExport(o) {
  const kind = String((o && o.kind) || '');
  if (!/^[a-z][a-z-]{0,19}$/.test(kind)) throw new Error('invalid export kind');
  const format = o.format === 'xls' ? 'xls' : 'tsv';
  const columns = Array.isArray(o.columns) ? o.columns.slice() : [];
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const filename = 'aperia-' + kind + '-' + _ymd(o.date) + '.' + format;
  const file = path.join(String(o.dir || ''), filename);
  if (format === 'tsv') {
    fs.writeFileSync(file, toTSV(columns, rows), 'utf8');
  } else {
    const strRows = rows.map((r) => {
      const x = {};
      for (const c of columns) x[c] = String(cell(r[c]));
      return x;
    });
    generateExcel(strRows, columns.map((c) => ({ key: c, header: c })), file);
  }
  return { filename };
}

module.exports = { cell, TIRE_COLUMNS, ISSUE_COLUMNS, CROSSLINK_COLUMNS, tireRows, issueRows, crossLinkRows, toTSV, writeExport };
