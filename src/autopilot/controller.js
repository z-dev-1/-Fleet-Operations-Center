'use strict';
/**
 * autopilot/controller.js — the supervised Autopilot worker (§B10, plan R1, R3, R4, R8).
 *
 * createController(deps) -> controller
 *   ensureRegistered(cfg)   register with the worker supervisor when it is enabled, the master
 *                           switch is on and runState is not 'stopped'. WORKER_ACTIVE = no-op (R4).
 *   tick(ctx)               the supervisor tick; shares the _running mutex with runOnce / harness
 *   runOnce(opts)           one tick outside the schedule (BUSY when the mutex is held)
 *   withMutex(fn)           run fn under the shared mutex (harness)
 *   abortInFlight(reason)   first-reason-wins abort of the current tick / run
 *   control(action)         pause | resume | stop | run-now | enable-supervisor (§B10.5)
 *   onConfigChanged(prev, next)  master OFF/ON and intervalMs handling (R4)
 *   status()                in-memory diagnostics (no SQL)
 *
 * Tick pipeline (§B10.2): config -> ensureSchema once -> boot recovery once -> resolution sweep
 * (build time = fleet-freshness lastOkAt, R1) -> detection when due (generations, cfgFp, 30 min)
 * -> scope + feature sweep (R8) -> triggers -> investigate up to maxCasesPerTick -> prune ->
 * throttled autopilot:changed push. An 8-minute budget aborts the tick before the supervisor's
 * 10-minute timeout. No raw timer drives Autopilot; the supervisor schedules every tick.
 *
 * deps: { supervisor, ports, caseStore, schema, config, settingsStore, env, runInvestigation,
 *         limiter, jobs, reason, now, rand, owner, ctx{sendToWindow, pushBubbleNotification},
 *         defer(fn), telemetry, logger }
 */

const crypto = require('crypto');
const {
  STATES: S, WATCHED_KEYS, OPERATIONAL_CADENCE, normUnit, unitIndex, UNIT_KEY_OF, HOUR, MIN,
} = require('./constants');
const configMod = require('./config');
const { buildScope, inScopeExisting } = require('./scope');
const { detect, openingRulesApply } = require('./detect');
const { dueTriggers, shouldEvalCheapFp, CHEAP_FP_STATES } = require('./triggers');
const { cheapFp } = require('./fingerprint');
const { score } = require('./priority');
const { decisivRef } = require('./plan');
const { createLimiter } = require('./limiter');

let logger;
try { logger = require('../utils/logger')('autopilot'); } catch (_) { logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const WORKER = 'autopilot';
const TICK_BUDGET_MS = 8 * MIN;
const PUSH_THROTTLE_MS = 2000;
const AUTH_NOTICE_SPACING_MS = 2 * HOUR;
const DETECT_KEYS = Object.freeze(['fleetData', 'canonicalState', 'longDwellStore', 'longDwellCsv']);

function _staleDays(doc) {
  const n = Number(doc && doc.staleDays);
  return Number.isFinite(n) ? Math.min(30, Math.max(1, Math.round(n))) : 3;
}

function createController(deps) {
  const d = deps || {};
  const supervisor = d.supervisor || require('../workers/supervisor');
  const cs = d.caseStore || require('./case-store');
  const schema = d.schema || require('./schema');
  const jobs = d.jobs || require('../jobs');
  const runInvestigation = d.runInvestigation || require('./investigate').runInvestigation;
  const clock = typeof d.now === 'function' ? d.now : Date.now;
  const rand = typeof d.rand === 'function' ? d.rand : Math.random;
  const owner = d.owner || ('autopilot:' + process.pid + ':' + crypto.randomBytes(4).toString('hex'));
  const defer = typeof d.defer === 'function' ? d.defer : (fn) => setImmediate(fn);
  const log = d.logger || logger;
  let telemetry = d.telemetry;
  if (telemetry === undefined) { try { telemetry = require('../telemetry'); } catch (_) { telemetry = null; } }
  const cfgDeps = { store: d.settingsStore, env: d.env };
  const limiter = d.limiter || createLimiter({ now: clock, random: rand });

  let _cfg = null;
  let _ports = d.ports || null;
  let _ctx = d.ctx || {};
  let _running = null;         // Promise of the current tick / runOnce / harness section
  let _ac = null;              // AbortController of the current tick
  let _schemaOk = null;        // null = not tried, true / false
  let _recovered = false;
  let _lastDetectAt = null;
  let _prevGens = null;
  const _cheap = { evaluatedOnce: false, prevGens: null, lastEvalAt: null };
  let _lastPushAt = 0;
  let _lastTick = null;
  let _degraded = null;
  const _pendingTrigger = new Map();
  const _authEpisode = { midway: false, aperia: false };

  function _loadCfg() { return configMod.loadAutopilotConfig(cfgDeps); }
  function _portsObj() {
    if (!_ports) _ports = require('./ports').create({ liveReads: () => !!(_cfg && _cfg.features && _cfg.features.liveReads === true) });
    return _ports;
  }

  // ── registration (R4) ───────────────────────────────────────────────────
  function spec(cfg) {
    return {
      name: WORKER, group: 'autopilot', label: 'Fleet Autopilot (shadow)', tick, intervalMs: cfg.intervalMs,
      initialDelayMs: 180000, timeoutMs: 600000, maxFailures: 3, cooldownMs: 1800000, backoff: true,
      dependsOn: ['cluster.production'], idempotent: true, stop: () => abortInFlight('shutdown'),
    };
  }
  function ensureRegistered(cfg) {
    const c = cfg || _loadCfg();
    if (!supervisor.isEnabled() || !c.enabled || c.runState === 'stopped') return false;
    try { supervisor.register(spec(c)); } catch (e) { if (!e || e.code !== 'WORKER_ACTIVE') throw e; }
    return true;
  }

  // ── abort (first reason wins) ───────────────────────────────────────────
  function abortInFlight(reason) {
    if (!_ac || _ac.signal.aborted) return false;
    _ac.abort(reason);
    return true;
  }

  function _ensureSchema() {
    if (_schemaOk === true && schema.isEnsured()) return true;
    let ok = false;
    try { ok = schema.ensureSchema() === true; } catch (_) { ok = false; }
    if (!ok && _schemaOk !== false) { try { log.error('storage unavailable'); } catch (_) {} }
    _schemaOk = ok;
    _degraded = ok ? null : 'storage_unavailable';
    return ok;
  }

  async function withMutex(fn) {
    if (_running) return { ok: false, code: 'BUSY' };
    let release;
    _running = new Promise((r) => { release = r; });
    try { return await fn(); } finally { const r = release; _running = null; r(); }
  }
  function isRunning() { return !!_running; }
  function whenIdle() { return _running || Promise.resolve(); }

  // ── cheap fingerprint per case (§B10.3) ─────────────────────────────────
  function _cheapFpOf(docs, ports, now) {
    return (c, row) => {
      const unit = c.unit_id;
      let dtna = null;
      try { dtna = ports.dtnaCasesForUnit(unit) || null; } catch (_) { dtna = null; }
      const ref = decisivRef(row || {});
      const dec = docs.decisivCaseCache && ref.estimateId ? docs.decisivCaseCache[ref.estimateId] || null : null;
      const pick = (doc, keyOf) => {
        if (!doc || typeof doc !== 'object') return null;
        const keys = unitIndex(doc, keyOf).get(unit) || [];
        return keys.length ? keys.map((k) => doc[k]) : null;
      };
      const csvRows = docs.longDwellCsv && typeof docs.longDwellCsv === 'object' ? (docs.longDwellCsv.rows || null) : null;
      let aperia = null;
      try {
        const a = ports.aperiaCachedIssues();
        if (a && Array.isArray(a.issues)) aperia = a.issues.filter((i) => i && normUnit(i.fleetVehicleId) === unit);
      } catch (_) { aperia = null; }
      let ri = null;
      try {
        const ev = ports.riEvents(row && row.equipmentId ? row.equipmentId : unit, now - 30 * 24 * HOUR);
        const list = Array.isArray(ev) ? ev : [];
        ri = { count: list.length, maxReportedAt: list.reduce((m, e) => (e && e.reported_at && String(e.reported_at) > m ? String(e.reported_at) : m), '') };
      } catch (_) { ri = null; }
      return cheapFp({
        row: row || {},
        slices: {
          dtna, decisiv: dec,
          email: pick(docs.emailEvidence, UNIT_KEY_OF.emailEvidence),
          fas: docs.fasCases && typeof docs.fasCases === 'object' ? docs.fasCases['unit-' + unit.toLowerCase()] || null : null,
          longDwell: pick(docs.longDwellStore, UNIT_KEY_OF.longDwellStore),
          longDwellCsv: pick(csvRows, UNIT_KEY_OF.longDwellCsvRows),
        },
        aperiaIssues: aperia,
        riSummary: ri,
      });
    };
  }

  // ── auth notification (§B10.6) ──────────────────────────────────────────
  function _authNotice(auth, now) {
    const sources = [
      { key: 'midway', active: auth.midway === 'WAITING_FOR_USER', label: 'Midway' },
      { key: 'aperia', active: !!(auth.aperia && auth.aperia.actionNeeded), label: 'Aperia' },
    ];
    for (const s of sources) {
      if (!s.active) { _authEpisode[s.key] = false; continue; }
      if (_authEpisode[s.key]) continue;
      _authEpisode[s.key] = true;
      const last = parseInt(cs.getMeta('last_auth_notice:' + s.key) || '0', 10) || 0;
      if (now - last < AUTH_NOTICE_SPACING_MS) continue;
      cs.setMeta('last_auth_notice:' + s.key, now);
      try {
        if (_ctx && typeof _ctx.pushBubbleNotification === 'function') {
          _ctx.pushBubbleNotification({
            title: 'Autopilot: sign-in needed',
            body: s.label + ' needs you to sign in (MFA). Autopilot keeps using cached data and resumes on its own.',
          });
        }
      } catch (_) { /* a notification failure is ignored */ }
    }
  }

  function _push(now, force) {
    if (!force && now - _lastPushAt < PUSH_THROTTLE_MS) return;
    _lastPushAt = now;
    try {
      if (_ctx && typeof _ctx.sendToWindow === 'function') _ctx.sendToWindow('autopilot:changed', { at: now, counts: cs.counts() });
    } catch (_) { /* push is best effort */ }
  }

  // ── the tick pipeline ───────────────────────────────────────────────────
  async function _pipeline(sctx, opts) {
    const o = opts || {};
    const t0 = clock();
    const cpu0 = process.cpuUsage();
    const cfg = _loadCfg();
    _cfg = cfg;
    if (!cfg.enabled) return { skipped: 'disabled' };
    if (cfg.runState !== 'running') return { skipped: 'paused' };
    if (!_ensureSchema()) return { degraded: 'storage_unavailable' };
    const ports = _portsObj();

    const ac = new AbortController();
    _ac = ac;
    const sig = sctx && sctx.signal;
    const onShutdown = () => abortInFlight('shutdown');
    if (sig) { if (sig.aborted) abortInFlight('shutdown'); else sig.addEventListener('abort', onShutdown, { once: true }); }
    const budget = setTimeout(() => abortInFlight('budget'), TICK_BUDGET_MS);
    if (budget.unref) budget.unref();
    let changed = false;
    const out = { ok: true, investigated: [], detected: 0, triggers: 0, swept: null };
    try {
      // step 3: boot recovery once per process.
      if (!_recovered) {
        const r = cs.recoverAbandoned({ owner, now: clock(), rand });
        _recovered = true;
        for (const id of r.requeued) _pendingTrigger.set(id, 'recovered');
        if (r.requeued.length || r.failed.length) changed = true;
        out.recovered = r;
      }
      limiter.beginTick();

      const docs = {};
      for (const k of ['fleetData', 'canonicalState', 'longDwellStore', 'longDwellCsv', 'relayReconcileConfig', 'decisivCaseCache', 'emailEvidence', 'fasCases']) {
        try { docs[k] = ports.readStore(k); } catch (_) { docs[k] = null; }
      }
      const fleet = docs.fleetData && typeof docs.fleetData === 'object' ? docs.fleetData : {};
      const rows = Array.isArray(fleet.rows) ? fleet.rows : [];
      const rowsByUnit = new Map();
      for (const r of rows) if (r && typeof r.equipmentId === 'string' && normUnit(r.equipmentId)) rowsByUnit.set(normUnit(r.equipmentId), r);
      const now0 = clock();
      const ff = ports.fleetFreshness(now0);
      const buildAtMs = ff && Number.isFinite(ff.lastOkAt) ? ff.lastOkAt : null;
      const isDown = (r) => { try { return !!ports.isDown(r); } catch (_) { return false; } };
      const staleDays = _staleDays(docs.relayReconcileConfig);

      // step 4: resolution sweep (cache only).
      const sw = cs.sweepResolution({ rowsByUnit, fleetMeta: { source: fleet.source, syncedAt: fleet.syncedAt, buildAtMs, isDown }, now: now0 });
      out.swept = { resolved: sw.resolved.length, review: sw.review.length, missing: sw.missing.length };
      if (sw.resolved.length || sw.review.length || sw.updated) changed = true;

      // step 5: detection when due.
      const gens = {};
      for (const k of WATCHED_KEYS) { try { gens[k] = ports.generation(k); } catch (_) { gens[k] = null; } }
      const fpNow = configMod.cfgFp(cfg);
      const genChanged = !_prevGens || DETECT_KEYS.some((k) => gens[k] !== _prevGens[k]);
      const due = o.forceDetect || _lastDetectAt == null || genChanged || fpNow !== cs.getMeta('last_detect_cfg_fp')
        || now0 - _lastDetectAt >= OPERATIONAL_CADENCE.detectEveryMs;
      const scope = buildScope(cfg);
      if (due) {
        const csvRows = docs.longDwellCsv && typeof docs.longDwellCsv === 'object' ? (docs.longDwellCsv.rows || {}) : {};
        const cands = detect(rows, {
          scope, oosDays: cfg.oosDays, features: cfg.features, staleDays, now: now0, buildAtMs, syncedAt: fleet.syncedAt, isDown,
          canonical: (r) => { try { return ports.canonical(r); } catch (_) { return null; } },
          longDwell: { store: docs.longDwellStore || {}, csvRows },
          cacheIndex: {
            dtna: (u) => { try { return ports.dtnaCasesForUnit(u) || []; } catch (_) { return []; } },
            decisiv: docs.decisivCaseCache && typeof docs.decisivCaseCache === 'object' ? docs.decisivCaseCache : null,
          },
          riRepeat: (eq) => { try { return ports.riRepeat(eq); } catch (_) { return []; } },
        });
        for (const c of cands) {
          if (ac.signal.aborted) break;
          const row = rowsByUnit.get(c.unitId) || {};
          const woIds = { primary: row._serviceId || row.workRequestId || null, secondary: (Array.isArray(row._secondaryWRs) ? row._secondaryWRs : []).map((w) => w && (w._serviceId || w.workRequestId)).filter(Boolean) };
          try {
            const r = cs.upsertDetected(Object.assign({}, c, { woIds, priority: score({ reasons: c.reasons, daysDown: c.daysDown, neverInvestigated: true }) }), { now: now0 });
            if (r.created) { out.detected++; changed = true; _pendingTrigger.set(r.caseId, 'new'); }
          } catch (e) { try { log.error('detection upsert failed: ' + (e && e.code)); } catch (_) {} }
        }
        cs.setMeta('last_detect_cfg_fp', fpNow);
        _lastDetectAt = now0;
      }
      _prevGens = gens;

      // Scope + feature sweep (every running tick, R8).
      const open = cs.listOpen();
      const toPauseScope = [];
      const toPauseFeature = [];
      const backInScope = [];
      const featureOn = [];
      for (const c of open) {
        const row = rowsByUnit.get(c.unit_id);
        if (c.state === S.PAUSED) {
          if (c.pause_reason === 'out_of_scope' && row && inScopeExisting(row, scope)) backInScope.push(c.case_id);
          else if (c.pause_reason === 'feature_off' && openingRulesApply(c.reasons, cfg.features)) featureOn.push(c.case_id);
          continue;
        }
        if (c.state === S.INVESTIGATING || c.state === S.ANALYZING) continue;
        if (row && !inScopeExisting(row, scope)) toPauseScope.push(c.case_id);
        else if (!openingRulesApply(c.reasons, cfg.features)) toPauseFeature.push(c.case_id);
      }
      if (toPauseScope.length && cs.pauseCases(toPauseScope, 'out_of_scope', { now: now0 }).length) changed = true;
      if (toPauseFeature.length && cs.pauseCases(toPauseFeature, 'feature_off', { now: now0 }).length) changed = true;
      if (backInScope.length) for (const id of cs.requeueCases({ caseIds: backInScope, trigger: 'in_scope', now: now0 })) { _pendingTrigger.set(id, 'scheduled'); changed = true; }
      if (featureOn.length) for (const id of cs.requeueCases({ caseIds: featureOn, trigger: 'feature_on', now: now0 })) { _pendingTrigger.set(id, 'feature_on'); changed = true; }

      // step 6: triggers.
      let auth = {};
      try { auth = ports.authState() || {}; } catch (_) { auth = {}; }
      _authNotice(auth, now0);
      const cheapOf = _cheapFpOf(docs, ports, now0);
      const cur = cs.listOpen();
      const cheapFps = new Map();
      if (shouldEvalCheapFp({ evaluatedOnce: _cheap.evaluatedOnce, gens, prevGens: _cheap.prevGens, lastEvalAt: _cheap.lastEvalAt, now: now0 })) {
        for (const c of cur) {
          if (!CHEAP_FP_STATES.has(c.state)) continue;
          try { cheapFps.set(c.case_id, cheapOf(c, rowsByUnit.get(c.unit_id) || null)); } catch (_) {}
        }
        _cheap.evaluatedOnce = true;
        _cheap.prevGens = gens;
        _cheap.lastEvalAt = now0;
      }
      const runs = new Map();
      for (const c of cur) runs.set(c.case_id, cs.runsSince(c.case_id, now0 - 24 * HOUR));
      const trig = dueTriggers(cur, now0, { cheapFps, authState: auth, runs, etaFired: cs.etaDueFired(now0 - 7 * 24 * HOUR) });
      for (const t of trig) {
        const reason = t.trigger === 'eta_due' ? 'eta_due:' + t.date : t.trigger;
        if (cs.requeueCases({ caseIds: [t.caseId], trigger: reason, now: now0 }).length) {
          _pendingTrigger.set(t.caseId, t.trigger);
          out.triggers++;
          changed = true;
        }
      }

      // step 7: investigate up to maxCasesPerTick, one at a time.
      const picked = cs.pickQueued(cfg.maxCasesPerTick, clock());
      for (const c of picked) {
        if (ac.signal.aborted) break;
        const trigger = o.trigger || _pendingTrigger.get(c.case_id) || (c.last_checked_at == null ? 'new' : 'retry');
        _pendingTrigger.delete(c.case_id);
        let r;
        try {
          r = await runInvestigation(c.case_id, {
            ports, limiter, cfg, signal: ac.signal, trigger, owner, now: clock, rand, caseStore: cs, jobs,
            reason: d.reason, fleet: { doc: fleet, ff }, docs, staleDays, cheapFpOf: cheapOf,
          });
        } catch (e) {
          r = { ok: false, caseId: c.case_id, code: (e && e.code) || 'INTERNAL' };
          try { log.warn(c.unit_id + ' investigation threw: ' + r.code); } catch (_) {}
        }
        out.investigated.push(r);
        changed = true;
      }

      // step 8: prune at most every 6 h.
      try { cs.prune({ now: clock(), localHistory: cfg.features.localHistory !== false }); } catch (_) {}
      return out;
    } finally {
      clearTimeout(budget);
      if (sig) { try { sig.removeEventListener('abort', onShutdown); } catch (_) {} }
      if (_ac === ac) _ac = null;
      const cpu = process.cpuUsage(cpu0);
      _lastTick = { at: t0, ms: clock() - t0, cpuMs: Math.round((cpu.user + cpu.system) / 1000), outcome: ac.signal.aborted ? 'aborted:' + ac.signal.reason : 'ok' };
      out.cpuMs = _lastTick.cpuMs;
      if (changed) _push(clock(), false);
    }
  }

  function _tracked(fn) {
    if (telemetry && typeof telemetry.track === 'function') return telemetry.track('autopilot.tick', fn);
    return fn();
  }

  async function tick(sctx) {
    if (_running) return { skipped: 'busy' };
    const r = await withMutex(() => _tracked(() => _pipeline(sctx, {})));
    return r;
  }

  async function runOnce(opts) {
    return withMutex(() => _tracked(() => _pipeline(null, opts || {})));
  }

  function _scheduleRunOnce() {
    defer(() => {
      const cfg = _loadCfg();
      if (!cfg.enabled || !supervisor.isEnabled() || cfg.runState !== 'running' || _running) return;
      runOnce({ forceDetect: true }).catch(() => {});
    });
  }

  // ── controls (§B10.5) ───────────────────────────────────────────────────
  async function control(action) {
    const cfg = _loadCfg();
    const save = (patch) => configMod.saveAutopilotPatch(patch, cfgDeps);
    switch (action) {
      case 'pause': {
        const r = save({ runState: 'paused' });
        if (!r.ok) return { ok: false, code: r.code || 'SETTINGS_WRITE_FAILED' };
        abortInFlight('master_pause');
        _event('pause');
        return { ok: true, runState: 'paused' };
      }
      case 'resume': {
        if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
        const r = save({ runState: 'running' });
        if (!r.ok) return { ok: false, code: r.code || 'SETTINGS_WRITE_FAILED' };
        if (!supervisor.isEnabled()) return { ok: true, runState: 'running', worker: 'supervisor_disabled' };
        if (_ensureSchema()) {
          for (const id of cs.requeueCases({ pauseReasons: ['master_pause', 'master_stop'], trigger: 'resume', actor: 'user', now: clock() })) _pendingTrigger.set(id, 'manual');
          _event('resume');
        }
        ensureRegistered(r.config);
        _scheduleRunOnce();
        return { ok: true, runState: 'running' };
      }
      case 'stop': {
        const r = save({ runState: 'stopped' });
        if (!r.ok) return { ok: false, code: r.code || 'SETTINGS_WRITE_FAILED' };
        abortInFlight('master_stop');
        try { supervisor.stop(WORKER); } catch (_) {}
        _event('stop');
        return { ok: true, runState: 'stopped' };
      }
      case 'run-now': {
        if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
        if (!supervisor.isEnabled()) return { ok: false, code: 'SUPERVISOR_DISABLED' };
        if (cfg.runState !== 'running') return { ok: false, code: 'NOT_RUNNING' };
        if (_running) return { ok: false, code: 'BUSY' };
        const p = runOnce({ trigger: undefined });
        p.catch(() => {});
        return { ok: true, runState: 'running', started: true };
      }
      case 'enable-supervisor': {
        const r = configMod.enableSupervisorSetting(cfgDeps);
        if (r.ok && schema.isEnsured()) _event('enable_supervisor');
        if (!r.ok) { try { log.warn('enable-supervisor settings write failed'); } catch (_) {} }
        return r;
      }
      default:
        return { ok: false, code: 'INVALID_INPUT', field: 'action' };
    }
  }

  function _event(code) {
    if (!schema.isEnsured()) return;
    try { cs.appendEvent({ caseId: null, at: clock(), kind: 'control', actor: 'user', reason: code }); } catch (_) {}
  }

  /** R4: master OFF / ON and intervalMs handling after a successful set-config. */
  function onConfigChanged(prev, next) {
    const p = prev || {};
    const n = next || {};
    if (p.enabled && !n.enabled) {
      abortInFlight('master_stop');
      try { supervisor.stop(WORKER); } catch (_) {}
      return 'master_off';
    }
    if (!p.enabled && n.enabled) {
      ensureRegistered(n);
      if (n.runState === 'running' && supervisor.isEnabled() && _ensureSchema()) {
        for (const id of cs.requeueCases({ pauseReasons: ['master_stop'], trigger: 'master_on', actor: 'user', now: clock() })) _pendingTrigger.set(id, 'manual');
      }
      return 'master_on';
    }
    if (n.enabled && p.intervalMs !== n.intervalMs) {
      abortInFlight('reconfigure');
      try { supervisor.stop(WORKER); } catch (_) {}
      ensureRegistered(n);
      return 'reconfigured';
    }
    return null;
  }

  function setPendingTrigger(caseId, trigger) { _pendingTrigger.set(caseId, trigger); }
  function setCtx(ctx) { _ctx = ctx || {}; }

  function status() {
    return { lastTick: _lastTick, degraded: _degraded, running: !!_running, limiter: limiter.snapshot(), owner };
  }

  return {
    ensureRegistered, spec, tick, runOnce, withMutex, isRunning, whenIdle, abortInFlight, control,
    onConfigChanged, scheduleRunOnce: _scheduleRunOnce, setPendingTrigger, setCtx, status,
    ensureSchema: _ensureSchema, ports: _portsObj, limiter, owner, runInvestigation,
  };
}

module.exports = { createController, WORKER, TICK_BUDGET_MS };
