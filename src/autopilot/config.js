'use strict';
/**
 * autopilot/config.js — `settings.autopilot` resolver (§B3).
 *
 *   resolveAutopilotConfig(settings, env)  pure; re-validates every field on every read
 *   loadAutopilotConfig({store})           reads the 'settings' doc per call (no memo)
 *   saveAutopilotPatch(patch, {store})     validated read-modify-write of only the autopilot key
 *   enableSupervisorSetting({store})       sets only settings.workers.supervisor.enabled = true
 *   cfgFp(cfg)                             sha1 of {scope, oosDays, features}
 *
 * Write toggles (`writes.*`) always resolve to false in V1, whatever is on disk.
 * There is no env var for any write key. This is the only Autopilot file that
 * requires ../store, and it only touches the 'settings' key.
 */

const crypto = require('crypto');
const { normUnit } = require('./constants');

const DEFAULT_UNITS = Object.freeze([
  '322283', '321185', '321364', 'FLD260703', '39582', '39351',
  '321963', '321838', 'B13014', 'B62059', 'IND260261', '9010424',
]);

const FEATURE_KEYS = Object.freeze([
  'oosInvestigation', 'longDwellInvestigation', 'evidenceCollection',
  'aiInvestigation', 'localHistory', 'liveReads',
]);

const WRITE_KEYS = Object.freeze([
  'slackReplies', 'emailReplies', 'vendorFollowUps', 'woCreate', 'woUpdate',
  'lifecycleChange', 'estimateApproval', 'externalEscalation', 'futureAutonomous',
]);

const LOCKED_WRITES = Object.freeze(WRITE_KEYS.reduce((o, k) => { o[k] = false; return o; }, {}));

const FROZEN_ALWAYS_ON = Object.freeze({
  permissions: true,
  securityChecks: true,
  approvalEnforcement: true,
  auditLogging: true,
  duplicateActionProtection: true,
});

const RUN_STATES = Object.freeze(['running', 'paused', 'stopped']);

const INT_FIELDS = Object.freeze({
  oosDays: { min: 1, max: 60 },
  maxCasesPerTick: { min: 1, max: 5 },
  intervalMs: { min: 60000, max: 3600000 },
  dailyCap: { min: 0, max: 500 },
});

const DEFAULTS = Object.freeze({
  enabled: true,
  runState: 'running',
  scope: Object.freeze({ domicile: 'ABE40', units: DEFAULT_UNITS, allUnits: false }),
  oosDays: 3,
  maxCasesPerTick: 1,
  intervalMs: 300000,
  dailyCap: 48,
  features: Object.freeze(FEATURE_KEYS.reduce((o, k) => { o[k] = true; return o; }, {})),
});

const DOMICILE_RE = /^[A-Z0-9]{2,10}$/;
const UNIT_RE = /^[A-Z0-9_-]{1,32}$/;
const MAX_UNITS = 500;

function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _okInt(key, v) {
  const r = INT_FIELDS[key];
  return Number.isInteger(v) && v >= r.min && v <= r.max;
}
function _normDomicile(v) {
  if (typeof v !== 'string') return null;
  const d = v.trim().toUpperCase();
  return d === '' || DOMICILE_RE.test(d) ? d : null;
}

// -> { units, dropped }
function _normUnits(list) {
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const v of list) {
    const u = (typeof v === 'string' || typeof v === 'number') ? normUnit(v) : '';
    if (!UNIT_RE.test(u)) { dropped++; continue; }
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return { units: out, dropped };
}

/**
 * resolveAutopilotConfig(settings, env) -> effective config (pure).
 * Invalid values fall back to the default; bad unit entries are dropped.
 */
function resolveAutopilotConfig(settings, env) {
  const ap = _isObj(settings) && _isObj(settings.autopilot) ? settings.autopilot : {};
  const e = env || {};
  const warnings = [];

  let enabled = typeof ap.enabled === 'boolean' ? ap.enabled : DEFAULTS.enabled;
  if (e.FLEET_AUTOPILOT === '0') enabled = false;
  else if (e.FLEET_AUTOPILOT === '1') enabled = true;

  const runState = RUN_STATES.includes(ap.runState) ? ap.runState : DEFAULTS.runState;

  const sc = _isObj(ap.scope) ? ap.scope : {};
  const dom = sc.domicile === undefined ? null : _normDomicile(sc.domicile);
  const domicile = dom == null ? DEFAULTS.scope.domicile : dom;
  let units = DEFAULTS.scope.units.slice();
  if (Array.isArray(sc.units)) {
    const r = _normUnits(sc.units.slice(0, MAX_UNITS));
    units = r.units;
    for (let i = 0; i < r.dropped; i++) warnings.push('scope-unit-dropped');
    if (sc.units.length > MAX_UNITS) warnings.push('scope-units-truncated');
  }
  const allUnits = typeof sc.allUnits === 'boolean' ? sc.allUnits : DEFAULTS.scope.allUnits;

  const ints = {};
  for (const k of Object.keys(INT_FIELDS)) ints[k] = _okInt(k, ap[k]) ? ap[k] : DEFAULTS[k];

  const fs = _isObj(ap.features) ? ap.features : {};
  const features = {};
  for (const k of FEATURE_KEYS) features[k] = typeof fs[k] === 'boolean' ? fs[k] : DEFAULTS.features[k];

  const wr = _isObj(ap.writes) ? ap.writes : {};
  for (const k of Object.keys(wr)) {
    if (wr[k] === true) warnings.push('write-toggle-ignored:' + k);
  }

  return {
    enabled,
    runState,
    scope: { domicile, units, allUnits },
    oosDays: ints.oosDays,
    maxCasesPerTick: ints.maxCasesPerTick,
    intervalMs: ints.intervalMs,
    dailyCap: ints.dailyCap,
    features,
    writes: LOCKED_WRITES,
    protections: FROZEN_ALWAYS_ON,
    warnings,
  };
}

function _store(deps) { return (deps && deps.store) || require('../store'); }

/** Reads the 'settings' doc on every call (no memoization). */
function loadAutopilotConfig(deps) {
  const s = _store(deps).load('settings', {});
  const env = (deps && deps.env) || process.env;
  return resolveAutopilotConfig(s, env);
}

// Validate a patch. -> { ok:true, clean } | { ok:false, code, key }
function _validatePatch(patch) {
  const bad = (code, key) => ({ ok: false, code, key });
  if (!_isObj(patch)) return bad('INVALID_INPUT', '');
  const clean = {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (k === 'writes') {
      if (!_isObj(v)) return bad('LOCKED_V1', 'writes');
      const wk = Object.keys(v)[0];
      return bad('LOCKED_V1', 'writes' + (wk ? '.' + wk : ''));
    } else if (k === 'enabled') {
      if (typeof v !== 'boolean') return bad('INVALID_INPUT', k);
      clean.enabled = v;
    } else if (k === 'runState') {
      if (!RUN_STATES.includes(v)) return bad('INVALID_INPUT', k);
      clean.runState = v;
    } else if (INT_FIELDS[k]) {
      if (!_okInt(k, v)) return bad('INVALID_INPUT', k);
      clean[k] = v;
    } else if (k === 'scope') {
      if (!_isObj(v)) return bad('INVALID_INPUT', k);
      const s = {};
      for (const sk of Object.keys(v)) {
        const sv = v[sk];
        if (sk === 'domicile') {
          const d = _normDomicile(sv);
          if (d == null) return bad('INVALID_INPUT', 'scope.domicile');
          s.domicile = d;
        } else if (sk === 'units') {
          if (!Array.isArray(sv) || sv.length > MAX_UNITS) return bad('INVALID_INPUT', 'scope.units');
          const r = _normUnits(sv);
          if (r.dropped) return bad('INVALID_INPUT', 'scope.units');
          s.units = r.units;
        } else if (sk === 'allUnits') {
          if (typeof sv !== 'boolean') return bad('INVALID_INPUT', 'scope.allUnits');
          s.allUnits = sv;
        } else {
          return bad('INVALID_INPUT', 'scope.' + sk);
        }
      }
      clean.scope = s;
    } else if (k === 'features') {
      if (!_isObj(v)) return bad('INVALID_INPUT', k);
      const f = {};
      for (const fk of Object.keys(v)) {
        if (!FEATURE_KEYS.includes(fk) || typeof v[fk] !== 'boolean') return bad('INVALID_INPUT', 'features.' + fk);
        f[fk] = v[fk];
      }
      clean.features = f;
    } else {
      return bad('INVALID_INPUT', k);
    }
  }
  return { ok: true, clean };
}

/**
 * saveAutopilotPatch(patch, deps) -> { ok:true, config } | { ok:false, code, key }
 * The whole patch is rejected on the first error. Only the `autopilot` key of
 * the settings doc changes.
 */
function saveAutopilotPatch(patch, deps) {
  const v = _validatePatch(patch);
  if (!v.ok) return v;
  const store = _store(deps);
  let next;
  try {
    next = store.update('settings', (cur) => {
      const doc = _isObj(cur) ? cur : {};
      const ap = _isObj(doc.autopilot) ? Object.assign({}, doc.autopilot) : {};
      for (const k of Object.keys(v.clean)) {
        if (k === 'scope' || k === 'features') {
          ap[k] = Object.assign({}, _isObj(ap[k]) ? ap[k] : {}, v.clean[k]);
        } else {
          ap[k] = v.clean[k];
        }
      }
      return Object.assign({}, doc, { autopilot: ap });
    }, {});
  } catch (_) {
    return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
  }
  const env = (deps && deps.env) || process.env;
  return { ok: true, config: resolveAutopilotConfig(next, env) };
}

/** Sets only settings.workers.supervisor.enabled = true. A user action; never called by Autopilot itself. */
function enableSupervisorSetting(deps) {
  try {
    _store(deps).update('settings', (cur) => {
      const doc = _isObj(cur) ? cur : {};
      const workers = _isObj(doc.workers) ? doc.workers : {};
      const sup = _isObj(workers.supervisor) ? workers.supervisor : {};
      return Object.assign({}, doc, {
        workers: Object.assign({}, workers, { supervisor: Object.assign({}, sup, { enabled: true }) }),
      });
    }, {});
    return { ok: true, restartRequired: true };
  } catch (_) {
    return { ok: false, code: 'SETTINGS_WRITE_FAILED' };
  }
}

function cfgFp(cfg) {
  const c = cfg || {};
  return crypto.createHash('sha1')
    .update(JSON.stringify({ scope: c.scope, oosDays: c.oosDays, features: c.features }))
    .digest('hex');
}

module.exports = {
  DEFAULTS, DEFAULT_UNITS, FEATURE_KEYS, WRITE_KEYS, LOCKED_WRITES, FROZEN_ALWAYS_ON,
  resolveAutopilotConfig, loadAutopilotConfig, saveAutopilotPatch, enableSupervisorSetting, cfgFp,
};
