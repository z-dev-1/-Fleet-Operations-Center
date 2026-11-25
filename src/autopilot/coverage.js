'use strict';
/**
 * autopilot/coverage.js — per-pass coverage counts and ap_unit rows (V2 design §4.3). Pure.
 *
 *   buildPass({ rows, scope, features, oosDays, isDown, detectCands, openCasesByUnit,
 *               authorizedTokens, now, buildAtMs, opened, held, ms }) -> { pass, units[] }
 *   reconcile(pass) -> { ok, rowsDiff, downDiff }
 *
 * Every fleet row is accounted for. Duplicate units: the last row wins and the
 * extra rows count in pass.duplicate_rows. Counts, ids and ASCII codes only.
 */

const crypto = require('crypto');
const { normUnit } = require('./constants');
const { classifyEquipment, CLASSES } = require('./equipment');
const { inScopeExisting, vendorOf } = require('./scope');
const { openingRule } = require('./detect');

const GROUP_CAP = 200;
const TOKENS_CAP = 100;
const ALL_FEATURES_ON = Object.freeze({ oosInvestigation: true, longDwellInvestigation: true });

const COVERAGE = Object.freeze({
  EXCLUDED: 'excluded', TYPE_UNKNOWN: 'type_unknown', TYPE_CONFLICT: 'type_conflict', INVALID: 'invalid',
  NOT_DOWN: 'not_down', OUT_OF_FILTER: 'out_of_filter', CASE_OPEN: 'case_open',
  FEATURE_OFF: 'feature_off', BELOW_THRESHOLD: 'below_threshold',
});

function _sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function _str(v, n) { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n || 60) : null; }
function _mapGet(m, k) {
  if (!m) return undefined;
  if (m instanceof Map) return m.get(k);
  if (m instanceof Set) return m.has(k) ? true : undefined;
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : undefined;
}

// { value -> {eligible, down, case_open} } capped at GROUP_CAP keys (largest eligible first), the rest in '(other)'.
function _capGroups(groups) {
  const keys = Object.keys(groups).sort((a, b) => (groups[b].eligible - groups[a].eligible) || (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length <= GROUP_CAP) {
    const out = {};
    for (const k of keys.sort()) out[k] = groups[k];
    return out;
  }
  const keep = keys.slice(0, GROUP_CAP);
  const out = {};
  for (const k of keep.slice().sort()) out[k] = groups[k];
  const other = { eligible: 0, down: 0, case_open: 0 };
  for (const k of keys.slice(GROUP_CAP)) {
    other.eligible += groups[k].eligible; other.down += groups[k].down; other.case_open += groups[k].case_open;
  }
  out['(other)'] = other;
  return out;
}
function _bump(groups, key, u) {
  const k = key || '(none)';
  const g = groups[k] || (groups[k] = { eligible: 0, down: 0, case_open: 0 });
  if (u.eligibility === CLASSES.POWER_ELIGIBLE) {
    g.eligible++;
    if (u.is_down) g.down++;
  }
  if (u.coverage === COVERAGE.CASE_OPEN) g.case_open++;
}

function rowHash(u) {
  return _sha1(JSON.stringify([u.unit_id, u.eligibility, u.equipment_class, u.exclusion_code, u.domicile, u.operator,
    u.owner, u.vendor, u.is_down, u.coverage, u.case_id]));
}

function reconcile(pass) {
  const p = pass || {};
  const n = (k) => Number(p[k]) || 0;
  const rowsDiff = (n('fleet_rows') - n('duplicate_rows')) - (n('invalid_rows') + n('eligible') + n('excluded_trailer')
    + n('excluded_hostler') + n('excluded_unsupported') + n('type_unknown') + n('type_conflict'));
  const downDiff = n('down_eligible') - (n('case_open') + n('below_threshold') + n('out_of_filter') + n('feature_off'));
  return { ok: rowsDiff === 0 && downDiff === 0, rowsDiff, downDiff };
}

function buildPass(input) {
  const i = input || {};
  const rows = Array.isArray(i.rows) ? i.rows : [];
  const isDown = typeof i.isDown === 'function' ? i.isDown : () => false;
  const scope = i.scope || null;
  const now = Number.isFinite(i.now) ? i.now : Date.now();
  const pass = {
    pass_id: null, at: now, build_at_ms: Number.isFinite(i.buildAtMs) ? i.buildAtMs : null,
    mode: (scope && scope.mode) || 'fleet',
    fleet_rows: rows.length, duplicate_rows: 0, invalid_rows: 0,
    eligible: 0, excluded_trailer: 0, excluded_hostler: 0, excluded_unsupported: 0, type_unknown: 0, type_conflict: 0,
    down_eligible: 0, case_open: 0, below_threshold: 0, out_of_filter: 0, feature_off: 0, opened: 0, held: 0,
    reconcile_ok: 0, by_domicile_json: null, by_operator_json: null, by_owner_json: null, tokens_without_rows_json: null,
    ms: Number.isFinite(i.ms) ? i.ms : null,
  };

  // Authorized-scope tokens seen on any row (any class), matched like the fleet sync does.
  const tokens = Array.isArray(i.authorizedTokens) ? i.authorizedTokens.map(normUnit).filter(Boolean) : [];
  const seenTokens = new Set();

  const byUnit = new Map();
  for (const row of rows) {
    if (tokens.length && row) {
      seenTokens.add(normUnit(row.domicileSite));
      seenTokens.add(normUnit(row.operator));
    }
    const u = row && typeof row.equipmentId === 'string' ? normUnit(row.equipmentId) : '';
    if (!u) { pass.invalid_rows++; continue; }
    if (byUnit.has(u)) { pass.duplicate_rows++; byUnit.delete(u); }
    byUnit.set(u, row);
  }

  let openedCount = 0;
  const units = [];
  const byDom = {};
  const byOp = {};
  const byOwner = {};
  for (const [unit, row] of byUnit) {
    const eq = classifyEquipment(row);
    const down = !!isDown(row);
    const openCase = _mapGet(i.openCasesByUnit, unit);
    const cand = _mapGet(i.detectCands, unit);
    let coverage;
    switch (eq.cls) {
      case CLASSES.EXCLUDED_TRAILER: pass.excluded_trailer++; coverage = COVERAGE.EXCLUDED; break;
      case CLASSES.EXCLUDED_HOSTLER: pass.excluded_hostler++; coverage = COVERAGE.EXCLUDED; break;
      case CLASSES.EXCLUDED_UNSUPPORTED: pass.excluded_unsupported++; coverage = COVERAGE.EXCLUDED; break;
      case CLASSES.TYPE_UNKNOWN: pass.type_unknown++; coverage = COVERAGE.TYPE_UNKNOWN; break;
      case CLASSES.TYPE_CONFLICT: pass.type_conflict++; coverage = COVERAGE.TYPE_CONFLICT; break;
      case CLASSES.INVALID_ROW: pass.invalid_rows++; coverage = COVERAGE.INVALID; break;
      default: {
        pass.eligible++;
        if (!down) { coverage = COVERAGE.NOT_DOWN; break; }
        pass.down_eligible++;
        const openedNow = !!(cand && cand.openedBy != null);
        if (!inScopeExisting(row, scope)) coverage = COVERAGE.OUT_OF_FILTER;
        else if (openCase !== undefined && openCase !== null && openCase !== false) coverage = COVERAGE.CASE_OPEN;
        else if (openedNow) { coverage = COVERAGE.CASE_OPEN; openedCount++; }
        else if (cand && openingRule(cand.reasons, ALL_FEATURES_ON) != null) coverage = COVERAGE.FEATURE_OFF;
        else coverage = COVERAGE.BELOW_THRESHOLD;
        if (coverage === COVERAGE.CASE_OPEN) pass.case_open++;
        else if (coverage === COVERAGE.OUT_OF_FILTER) pass.out_of_filter++;
        else if (coverage === COVERAGE.FEATURE_OFF) pass.feature_off++;
        else pass.below_threshold++;
      }
    }
    const rec = {
      unit_id: unit,
      eligibility: eq.cls,
      equipment_class: eq.equipmentClass,
      exclusion_code: eq.cls === CLASSES.POWER_ELIGIBLE ? null : eq.code,
      domicile: normUnit(row.domicileSite) || null,
      operator: normUnit(row.operator).slice(0, 40) || null,
      owner: _str(row.owner, 60),
      vendor: vendorOf(row) || null,
      is_down: down ? 1 : 0,
      coverage,
      case_id: typeof openCase === 'string' ? openCase : null,
    };
    rec.row_hash = rowHash(rec);
    units.push(rec);
    _bump(byDom, rec.domicile, rec);
    _bump(byOp, rec.operator, rec);
    _bump(byOwner, rec.owner, rec);
  }

  pass.opened = Number.isInteger(i.opened) ? i.opened : openedCount;
  pass.held = Number.isInteger(i.held) ? i.held : 0;
  pass.by_domicile_json = JSON.stringify(_capGroups(byDom));
  pass.by_operator_json = JSON.stringify(_capGroups(byOp));
  pass.by_owner_json = JSON.stringify(_capGroups(byOwner));
  const missing = Array.from(new Set(tokens)).filter((t) => !seenTokens.has(t)).sort().slice(0, TOKENS_CAP);
  pass.tokens_without_rows_json = JSON.stringify(missing);
  pass.reconcile_ok = reconcile(pass).ok ? 1 : 0;
  pass.pass_id = 'dp_' + _sha1([now, pass.fleet_rows, pass.eligible, pass.down_eligible, crypto.randomBytes(4).toString('hex')].join('|')).slice(0, 16);
  return { pass, units };
}

module.exports = { buildPass, reconcile, rowHash, COVERAGE, GROUP_CAP };
