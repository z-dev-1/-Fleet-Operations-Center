'use strict';
/**
 * autopilot/config.js — `settings.autopilot` resolver (V1 §B3, V2 design §3).
 *
 *   resolveAutopilotConfig(settings, env)  pure; re-validates every field on every read
 *   loadAutopilotConfig({store})           reads the 'settings' doc per call (no memo)
 *   saveAutopilotPatch(patch, {store})     validated read-modify-write of only the autopilot key
 *   enableSupervisorSetting({store})       sets only settings.workers.supervisor.enabled = true
 *   cfgFp(cfg)                             sha1 of {scope:{mode,filter,domicile,units}, oosDays, features, equipment}
 *
 * Write toggles (`writes.*`) always resolve to false, whatever is on disk.
 * There is no env var for any write key. This is the only Autopilot file that
 * requires ../store, and it only touches the 'settings' key. It is also the only
 * Autopilot file that reads settings outside `autopilot` (settings.domiciles ->
 * authorizedTokens, read-only).
 */

const crypto = require('crypto');
const { normUnit } = require('./constants');

const DEFAULT_UNITS = Object.freeze([
  '322283', '321185', '321364', 'FLD260703', '39582', '39351',
  '321963', '321838', 'B13014', 'B62059', 'IND260261', '9010424',
]);

const FEATURE_KEYS = Object.freeze([
  'oosInvestigation', 'longDwellInvestigation', 'evidenceCollection',
  'aiInvestigation', 'multiTurn', 'timelineProposals', 'localHistory', 'liveReads',
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

// Equipment gate settings (§3.1). Frozen; not patchable.
const EQUIPMENT = Object.freeze({
  eligibleAssetTypes: Object.freeze(['tractor', 'boxTruck']),
  excludeTrailers: true,
  excludeHostlers: true,
  unknownType: 'track_only',
});

const RUN_STATES = Object.freeze(['running', 'paused', 'stopped']);
const SCOPE_MODES = Object.freeze(['fleet', 'filter']);

const INT_FIELDS = Object.freeze({
  oosDays: { min: 1, max: 60 },
  maxCasesPerTick: { min: 1, max: 5 },
  intervalMs: { min: 60000, max: 3600000 },
  dailyCap: { min: 0, max: 5000 },
});

const AI_FIELDS = Object.freeze({
  dailyCap: { min: 0, max: 5000 },
  turnTimeoutMs: { min: 10000, max: 120000 },
});
const TIER_NAMES = Object.freeze(['simple', 'standard', 'complex']);
const TIER_FIELDS = Object.freeze({
  maxModelTurns: { min: 1, max: 10 },
  maxToolCalls: { min: 1, max: 20 },
  maxElapsedMs: { min: 30000, max: 420000 },
  maxEvidenceBytes: { min: 8000, max: 64000 },
});
const TOOLS_FIELDS = Object.freeze({ timeoutMs: { min: 5000, max: 30000 } });
const QUEUE_FIELDS = Object.freeze({
  maxConcurrent: { min: 1, max: 4 },
  maxStartsPerTick: { min: 1, max: 20 },
  maxQueued: { min: 100, max: 5000 },
  agingBoostPerHour: { min: 0, max: 10 },
  agingBoostCap: { min: 0, max: 60 },
});

const DEFAULT_TIERS = Object.freeze({
  simple: Object.freeze({ maxModelTurns: 2, maxToolCalls: 3, maxElapsedMs: 120000, maxEvidenceBytes: 24000 }),
  standard: Object.freeze({ maxModelTurns: 4, maxToolCalls: 6, maxElapsedMs: 240000, maxEvidenceBytes: 48000 }),
  complex: Object.freeze({ maxModelTurns: 6, maxToolCalls: 10, maxElapsedMs: 420000, maxEvidenceBytes: 64000 }),
});

const DEFAULTS = Object.freeze({
  enabled: true,
  runState: 'running',
  scope: Object.freeze({
    mode: 'fleet',
    filter: Object.freeze({ domiciles: Object.freeze([]), carriers: Object.freeze([]), scacs: Object.freeze([]), vendors: Object.freeze([]), units: Object.freeze([]) }),
    domicile: 'ABE40', units: DEFAULT_UNITS, allUnits: true,
  }),
  equipment: EQUIPMENT,
  oosDays: 3,
  intervalMs: 300000,
  maxCasesPerTick: 1,
  dailyCap: 48,
  features: Object.freeze(FEATURE_KEYS.reduce((o, k) => { o[k] = true; return o; }, {})),
  ai: Object.freeze({ dailyCap: 48, turnTimeoutMs: 60000, yieldToHighPriority: true }),
  complexityTiers: DEFAULT_TIERS,
  tools: Object.freeze({ timeoutMs: 20000 }),
  authorizedTokens: Object.freeze([]),
  queue: Object.freeze({ maxConcurrent: 2, maxStartsPerTick: 4, maxQueued: 5000, agingBoostPerHour: 2, agingBoostCap: 40 }),
  writes: LOCKED_WRITES,
  protections: FROZEN_ALWAYS_ON,
});

const DOMICILE_RE = /^[A-Z0-9]{2,10}$/;
const UNIT_RE = /^[A-Z0-9_-]{1,32}$/;
const MAX_UNITS = 500;
const TOKEN_RE = /^[A-Z0-9-]{2,12}$/;
const MAX_TOKENS = 100;

// scope.filter lists (§3.2): max entries, normalizer and pattern. `lc` lists compare case-insensitively.
const FILTER_LISTS = Object.freeze({
  domiciles: { max: 50, norm: (v) => String(v).trim().toUpperCase(), re: /^[A-Z0-9]{2,10}$/, lc: false },
  scacs: { max: 50, norm: (v) => String(v).trim().toUpperCase(), re: /^[A-Z0-9]{2,10}$/, lc: false },
  carriers: { max: 50, norm: (v) => String(v).trim(), re: /^[A-Za-z0-9 &.'-]{1,40}$/, lc: true },
  vendors: { max: 50, norm: (v) => String(v).trim(), re: /^[A-Za-z0-9 &.,'()/-]{1,60}$/, lc: true },
  units: { max: MAX_UNITS, norm: (v) => normUnit(v), re: UNIT_RE, lc: false },
});
const FILTER_KEYS = Object.freeze(Object.keys(FILTER_LISTS));

function _isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function _inRange(r, v) { return Number.isInteger(v) && v >= r.min && v <= r.max; }
function _okInt(key, v) { return _inRange(INT_FIELDS[key], v); }
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

// One scope.filter list -> { list, dropped }. Entries past the max count as dropped.
function _normFilterList(key, list) {
  const spec = FILTER_LISTS[key];
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const v of list) {
    const s = (typeof v === 'string' || (key === 'units' && typeof v === 'number')) ? spec.norm(v) : '';
    if (!s || !spec.re.test(s)) { dropped++; continue; }
    const k = spec.lc ? s.toLowerCase() : s;
    if (seen.has(k)) continue;
    if (out.length >= spec.max) { dropped++; continue; }
    seen.add(k);
    out.push(s);
  }
  return { list: out, dropped };
}

function _authorizedTokens(settings) {
  const raw = _isObj(settings) ? settings.domiciles : undefined;
  let src = Array.isArray(raw) && raw.length ? raw : null;
  if (!src) {
    try { src = require('../config/defaults').DEFAULT_DOMICILES; } catch (_) { src = []; }
  }
  const out = [];
  for (const v of Array.isArray(src) ? src : []) {
    if (v == null || typeof v === 'object') continue;
    const t = String(v).trim().toUpperCase();
    if (!TOKEN_RE.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

function _intGroup(src, fields, defaults) {
  const s = _isObj(src) ? src : {};
  const out = {};
  for (const k of Object.keys(fields)) out[k] = _inRange(fields[k], s[k]) ? s[k] : defaults[k];
  return out;
}

/**
 * resolveAutopilotConfig(settings, env) -> effective config (pure).
 * Invalid values fall back to the default; bad unit / filter entries are dropped.
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
  // scope.mode: explicit and valid wins; an invalid mode -> fleet; absent -> legacy allUnits (false -> filter).
  let mode;
  if (sc.mode !== undefined) mode = SCOPE_MODES.includes(sc.mode) ? sc.mode : DEFAULTS.scope.mode;
  else if (typeof sc.allUnits === 'boolean') mode = sc.allUnits ? 'fleet' : 'filter';
  else mode = DEFAULTS.scope.mode;

  const dom = sc.domicile === undefined ? null : _normDomicile(sc.domicile);
  const domicile = dom == null ? DEFAULTS.scope.domicile : dom;
  let units = DEFAULTS.scope.units.slice();
  if (Array.isArray(sc.units)) {
    const r = _normUnits(sc.units.slice(0, MAX_UNITS));
    units = r.units;
    for (let i = 0; i < r.dropped; i++) warnings.push('scope-unit-dropped');
    if (sc.units.length > MAX_UNITS) warnings.push('scope-units-truncated');
  }

  const fsrc = _isObj(sc.filter) ? sc.filter : {};
  const filter = {};
  for (const k of FILTER_KEYS) {
    if (Array.isArray(fsrc[k])) {
      const r = _normFilterList(k, fsrc[k]);
      filter[k] = r.list;
      for (let i = 0; i < r.dropped; i++) warnings.push('scope-filter-dropped');
    } else {
      filter[k] = [];
    }
  }

  const ints = {};
  for (const k of Object.keys(INT_FIELDS)) ints[k] = _okInt(k, ap[k]) ? ap[k] : DEFAULTS[k];

  const fs = _isObj(ap.features) ? ap.features : {};
  const features = {};
  for (const k of FEATURE_KEYS) features[k] = typeof fs[k] === 'boolean' ? fs[k] : DEFAULTS.features[k];

  // ai.dailyCap <-> legacy dailyCap (§3.2): ai.dailyCap, else a valid legacy dailyCap, else 48.
  const aiSrc = _isObj(ap.ai) ? ap.ai : {};
  const ai = {
    dailyCap: _inRange(AI_FIELDS.dailyCap, aiSrc.dailyCap) ? aiSrc.dailyCap : ints.dailyCap,
    turnTimeoutMs: _inRange(AI_FIELDS.turnTimeoutMs, aiSrc.turnTimeoutMs) ? aiSrc.turnTimeoutMs : DEFAULTS.ai.turnTimeoutMs,
    yieldToHighPriority: typeof aiSrc.yieldToHighPriority === 'boolean' ? aiSrc.yieldToHighPriority : DEFAULTS.ai.yieldToHighPriority,
  };

  const tsrc = _isObj(ap.complexityTiers) ? ap.complexityTiers : {};
  const complexityTiers = {};
  for (const t of TIER_NAMES) complexityTiers[t] = _intGroup(tsrc[t], TIER_FIELDS, DEFAULT_TIERS[t]);

  const tools = _intGroup(ap.tools, TOOLS_FIELDS, DEFAULTS.tools);

  // queue.maxStartsPerTick (§3.3): explicit, else a valid legacy maxCasesPerTick, else 4.
  const qsrc = _isObj(ap.queue) ? ap.queue : {};
  const queue = _intGroup(qsrc, QUEUE_FIELDS, DEFAULTS.queue);
  if (!_inRange(QUEUE_FIELDS.maxStartsPerTick, qsrc.maxStartsPerTick)) {
    queue.maxStartsPerTick = _okInt('maxCasesPerTick', ap.maxCasesPerTick) ? ap.maxCasesPerTick : DEFAULTS.queue.maxStartsPerTick;
  }

  const wr = _isObj(ap.writes) ? ap.writes : {};
  for (const k of Object.keys(wr)) {
    if (wr[k] === true) warnings.push('write-toggle-ignored:' + k);
  }

  return {
    enabled,
    runState,
    scope: { mode, filter, domicile, units, allUnits: mode === 'fleet' },
    equipment: EQUIPMENT,
    oosDays: ints.oosDays,
    maxCasesPerTick: ints.maxCasesPerTick,
    intervalMs: ints.intervalMs,
    dailyCap: ai.dailyCap,
    features,
    ai,
    complexityTiers,
    tools,
    authorizedTokens: _authorizedTokens(settings),
    queue,
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

// Validate an object of ints against `fields`. -> { ok:true, clean } | { ok:false, key }
function _patchInts(v, fields, prefix) {
  if (!_isObj(v)) return { ok: false, key: prefix };
  const clean = {};
  for (const k of Object.keys(v)) {
    if (!fields[k] || !_inRange(fields[k], v[k])) return { ok: false, key: prefix + '.' + k };
    clean[k] = v[k];
  }
  return { ok: true, clean };
}

// Validate a patch. -> { ok:true, clean } | { ok:false, code, key }
function _validatePatch(patch) {
  const bad = (code, key) => ({ ok: false, code, key });
  if (!_isObj(patch)) return bad('INVALID_INPUT', '');
  const clean = {};
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (k === 'writes') {
      if (!_isObj(v)) return bad('LOCKED_V2', 'writes');
      const wk = Object.keys(v)[0];
      return bad('LOCKED_V2', 'writes' + (wk ? '.' + wk : ''));
    } else if (k === 'equipment') {
      return bad('INVALID_INPUT', 'equipment');
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
        } else if (sk === 'mode') {
          if (!SCOPE_MODES.includes(sv)) return bad('INVALID_INPUT', 'scope.mode');
          s.mode = sv;
        } else if (sk === 'filter') {
          if (!_isObj(sv)) return bad('INVALID_INPUT', 'scope.filter');
          const f = {};
          for (const fk of Object.keys(sv)) {
            const key = 'scope.filter.' + fk;
            if (!FILTER_LISTS[fk] || !Array.isArray(sv[fk]) || sv[fk].length > FILTER_LISTS[fk].max) return bad('INVALID_INPUT', key);
            const r = _normFilterList(fk, sv[fk]);
            if (r.dropped) return bad('INVALID_INPUT', key);
            f[fk] = r.list;
          }
          s.filter = f;
        } else {
          return bad('INVALID_INPUT', 'scope.' + sk);
        }
      }
      // The V1 "All units" switch keeps working: it also writes scope.mode (an explicit mode wins).
      if (typeof s.allUnits === 'boolean' && s.mode === undefined) s.mode = s.allUnits ? 'fleet' : 'filter';
      clean.scope = s;
    } else if (k === 'features') {
      if (!_isObj(v)) return bad('INVALID_INPUT', k);
      const f = {};
      for (const fk of Object.keys(v)) {
        if (!FEATURE_KEYS.includes(fk) || typeof v[fk] !== 'boolean') return bad('INVALID_INPUT', 'features.' + fk);
        f[fk] = v[fk];
      }
      clean.features = f;
    } else if (k === 'ai') {
      if (!_isObj(v)) return bad('INVALID_INPUT', 'ai');
      const a = {};
      for (const ak of Object.keys(v)) {
        if (ak === 'yieldToHighPriority') {
          if (typeof v[ak] !== 'boolean') return bad('INVALID_INPUT', 'ai.' + ak);
        } else if (!AI_FIELDS[ak] || !_inRange(AI_FIELDS[ak], v[ak])) {
          return bad('INVALID_INPUT', 'ai.' + ak);
        }
        a[ak] = v[ak];
      }
      clean.ai = a;
    } else if (k === 'complexityTiers') {
      if (!_isObj(v)) return bad('INVALID_INPUT', k);
      const t = {};
      for (const tk of Object.keys(v)) {
        if (!TIER_NAMES.includes(tk)) return bad('INVALID_INPUT', 'complexityTiers.' + tk);
        const r = _patchInts(v[tk], TIER_FIELDS, 'complexityTiers.' + tk);
        if (!r.ok) return bad('INVALID_INPUT', r.key);
        t[tk] = r.clean;
      }
      clean.complexityTiers = t;
    } else if (k === 'tools' || k === 'queue') {
      const r = _patchInts(v, k === 'tools' ? TOOLS_FIELDS : QUEUE_FIELDS, k);
      if (!r.ok) return bad('INVALID_INPUT', r.key);
      clean[k] = r.clean;
    } else {
      return bad('INVALID_INPUT', k);
    }
  }
  // ai.dailyCap and the legacy dailyCap are always written together (§3.4).
  const capA = clean.ai && clean.ai.dailyCap !== undefined ? clean.ai.dailyCap : undefined;
  if (capA !== undefined && clean.dailyCap !== undefined && capA !== clean.dailyCap) return bad('INVALID_INPUT', 'dailyCap');
  if (capA !== undefined) clean.dailyCap = capA;
  else if (clean.dailyCap !== undefined) clean.ai = Object.assign({}, clean.ai || {}, { dailyCap: clean.dailyCap });
  return { ok: true, clean };
}

const MERGE_ONE_LEVEL = new Set(['features', 'ai', 'tools', 'queue']);

/**
 * saveAutopilotPatch(patch, deps) -> { ok:true, config } | { ok:false, code, key }
 * The whole patch is rejected on the first error. Only the `autopilot` key of
 * the settings doc changes. Nested objects merge one level deep (scope.filter,
 * ai, queue, tools, complexityTiers.<tier>).
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
        const pv = v.clean[k];
        if (k === 'scope') {
          const prev = _isObj(ap.scope) ? ap.scope : {};
          const s = Object.assign({}, prev, pv);
          if (pv.filter) s.filter = Object.assign({}, _isObj(prev.filter) ? prev.filter : {}, pv.filter);
          ap.scope = s;
        } else if (k === 'complexityTiers') {
          const prev = _isObj(ap.complexityTiers) ? ap.complexityTiers : {};
          const t = Object.assign({}, prev);
          for (const tk of Object.keys(pv)) t[tk] = Object.assign({}, _isObj(prev[tk]) ? prev[tk] : {}, pv[tk]);
          ap.complexityTiers = t;
        } else if (MERGE_ONE_LEVEL.has(k)) {
          ap[k] = Object.assign({}, _isObj(ap[k]) ? ap[k] : {}, pv);
        } else {
          ap[k] = pv;
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
  const s = c.scope || {};
  return crypto.createHash('sha1')
    .update(JSON.stringify({
      scope: { mode: s.mode, filter: s.filter, domicile: s.domicile, units: s.units },
      oosDays: c.oosDays, features: c.features, equipment: c.equipment,
    }))
    .digest('hex');
}

module.exports = {
  DEFAULTS, DEFAULT_UNITS, FEATURE_KEYS, WRITE_KEYS, LOCKED_WRITES, FROZEN_ALWAYS_ON, EQUIPMENT, FILTER_KEYS,
  resolveAutopilotConfig, loadAutopilotConfig, saveAutopilotPatch, enableSupervisorSetting, cfgFp,
};
