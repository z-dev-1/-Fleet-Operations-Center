'use strict';
/**
 * autopilot/index.js — public facade of Fleet Autopilot V1 (§B12.1 semantics, plan R3, R4, R5, R13, R14).
 *
 *   boot(ctx)                 registers the supervised worker when the master switch is on,
 *                             runState is not 'stopped' and the supervisor is enabled. No schema,
 *                             no SQL at boot.
 *   status()                  dashboard status; no ap_* SQL while the master switch is OFF
 *   runOnce(opts)             one tick through the shared mutex
 *   control(action)           pause | resume | stop | run-now | enable-supervisor
 *   setConfig(patch)          validated settings.autopilot write (+ R4 register / stop handling);
 *                             runState is rejected (INVALID_INPUT), it changes only through control()
 *   listCases(filter), getCase(caseId, opts), review(caseId, decision, note)
 *   V2: coverage(), listUnits(filter), deepInvestigate(caseId); status() adds coverage, queue,
 *   aiBacklog and sourceMetrics; getCase() adds steps, proposals, record and memory
 *   harnessRun(opts)          lazily requires ./harness and injects runInvestigation + controller
 *                             hooks (R5); { ok:false, code:'UNAVAILABLE' } while ./harness is missing
 *
 * createAutopilot(deps) builds an isolated instance for tests; the module exports a default one.
 */

const configMod = require('./config');
const { STATES, localDate, normUnit, HOUR } = require('./constants');
const { buildScope, unitsNotInFleet } = require('./scope');
const { createController } = require('./controller');

// §10.1: the only ap_step columns autopilot:case returns.
const STEP_COLUMNS = Object.freeze(['step_id', 'run_id', 'seq', 'turn', 'kind', 'tool', 'args_json', 'status', 'code', 'why',
  'summary_json', 'live', 'reused_step_id', 'ai_latency_ms', 'ai_lane', 'started_at', 'ms']);

function _pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function createAutopilot(deps) {
  const d = deps || {};
  const supervisor = d.supervisor || require('../workers/supervisor');
  const cs = d.caseStore || require('./case-store');
  const schema = d.schema || require('./schema');
  const clock = typeof d.now === 'function' ? d.now : Date.now;
  const env = d.env || process.env;
  const cfgDeps = { store: d.settingsStore, env: d.env };
  const runInvestigation = d.runInvestigation || require('./investigate').runInvestigation;
  const controller = d.controller || createController(Object.assign({}, d, { supervisor, caseStore: cs, schema, runInvestigation }));
  const loadCfg = () => configMod.loadAutopilotConfig(cfgDeps);

  function boot(ctx) {
    if (ctx) controller.setCtx(ctx);
    const cfg = loadCfg();
    if (!cfg.enabled || cfg.runState === 'stopped' || !supervisor.isEnabled()) return { registered: false };
    return { registered: controller.ensureRegistered(cfg) };
  }

  function _worker() {
    if (!supervisor.isEnabled()) return 'supervisor_disabled';
    try {
      const s = supervisor.getStatus();
      return (s && Array.isArray(s.workers) && s.workers.find((w) => w && w.name === 'autopilot')) || 'not_registered';
    } catch (_) { return 'unknown'; }
  }

  function status() {
    const cfg = loadCfg();
    const supEnabled = supervisor.isEnabled();
    const base = {
      ok: true,
      enabled: cfg.enabled,
      runState: cfg.runState,
      config: cfg,
      supervisorEnabled: supEnabled,
      supervisorEnvOverride: env.FLEET_WORKERS ?? null,
    };
    if (!cfg.enabled) return base;
    const out = Object.assign(base, { worker: _worker() });
    const ctl = controller.status();
    out.lastTick = ctl.lastTick;
    if (ctl.degraded) out.degraded = ctl.degraded;

    let ports = null;
    try { ports = controller.ports(); } catch (_) { ports = null; }
    try {
      const fleet = ports ? ports.readStore('fleetData') : null;
      const rows = fleet && Array.isArray(fleet.rows) ? fleet.rows : [];
      let fleetDown = 0;
      for (const r of rows) { try { if (ports.isDown(r)) fleetDown++; } catch (_) {} }
      out.scope = { unitsNotInFleet: unitsNotInFleet(buildScope(cfg), rows), units: cfg.scope.units.length, domicile: cfg.scope.domicile, allUnits: cfg.scope.allUnits, fleetDown };
    } catch (_) { out.scope = { unitsNotInFleet: [], units: cfg.scope.units.length, domicile: cfg.scope.domicile, allUnits: cfg.scope.allUnits, fleetDown: null }; }
    try { const j = require('../jobs').getSummary(clock()); out.jobs = j && j.types ? j.types.autopilotInvestigate || null : null; } catch (_) { out.jobs = null; }
    try { out.auth = ports ? ports.authState() : null; } catch (_) { out.auth = null; }
    let isolatedAvailable = null;
    try { isolatedAvailable = ports ? ports.isolatedLaneAvailable() : null; } catch (_) { isolatedAvailable = null; }
    const mem = process.memoryUsage();
    out.resources = { rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), eventLoopP99Ms: null, tickCpuMs: ctl.lastTick ? ctl.lastTick.cpuMs : null };
    try { const s = require('../telemetry').latestSample(); out.resources.eventLoopP99Ms = s && s.eventLoop ? s.eventLoop.p99Ms : null; } catch (_) {}

    // ap_* SQL only when the supervisor is enabled (Autopilot can run) or the schema is already ensured.
    if (!supEnabled && !schema.isEnsured()) { out.counts = null; out.ai = { cap: cfg.dailyCap, isolatedAvailable, cost: 'not reported by AI lanes' }; return out; }
    if (!controller.ensureSchema()) { out.degraded = 'storage_unavailable'; return out; }
    const now = clock();
    try { const ss = typeof schema.status === 'function' ? schema.status() : null; if (ss && ss.degradedCode) out.degraded = ss.degradedCode; } catch (_) {}
    out.counts = cs.counts();
    // V2 blocks (§10.1): coverage, queue, AI backlog and per-source metrics.
    const cap = cfg.ai && Number.isFinite(cfg.ai.dailyCap) ? cfg.ai.dailyCap : cfg.dailyCap;
    try { const cv = cs.coverage(now); out.coverage = { pass: cv.pass, reconcileOk: cv.reconcileOk, groups: cv.groups }; } catch (_) { out.coverage = null; }
    try { out.queue = cs.queueStats(now); } catch (_) { out.queue = null; }
    try { out.aiBacklog = Object.assign({}, cs.aiBacklog(now, { cap }), cs.aiMetrics(now, { cap })); } catch (_) { out.aiBacklog = null; }
    try { out.sourceMetrics = cs.sourceMetrics(now); } catch (_) { out.sourceMetrics = null; }
    out.harnessRanToday = !!cs.getMeta('harness:' + localDate(now));
    const runs = cs.aiRunStats(now - 24 * HOUR);
    const outcomes = {};
    const lanes = {};
    const lat = [];
    const sources = {};
    for (const r of runs) {
      if (r.ai_status) outcomes[r.ai_status] = (outcomes[r.ai_status] || 0) + 1;
      if (r.ai_lane) lanes[r.ai_lane] = (lanes[r.ai_lane] || 0) + 1;
      if (Number.isFinite(r.ai_latency_ms)) lat.push(r.ai_latency_ms);
      const sc = r.source_calls && typeof r.source_calls === 'object' ? r.source_calls : {};
      for (const k of Object.keys(sc)) {
        const v = sc[k] || {};
        const o = sources[k] || (sources[k] = { calls: 0, errors: 0, not_warm: 0, cache_only: 0 });
        o.calls += v.live || 0;
        o.errors += Object.values(v.errors || {}).reduce((a, b) => a + b, 0);
        if (v.status === 'not_warm') o.not_warm++;
        if (typeof v.status === 'string' && v.status.startsWith('cache_only')) o.cache_only++;
      }
    }
    lat.sort((a, b) => a - b);
    let gatewayP95 = null;
    try { const g = require('../ai/trace').gatewaySummary(); gatewayP95 = g && g.bySource && g.bySource.autopilot ? g.bySource.autopilot.p95LatencyMs : null; } catch (_) {}
    out.sources = sources;
    out.ai = {
      today: parseInt(cs.getMeta('ai_calls:' + localDate(now)) || '0', 10) || 0,
      cap: cfg.dailyCap, outcomes, p50: _pct(lat, 50), p95: _pct(lat, 95), gatewayP95, lanes, isolatedAvailable,
      cost: 'not reported by AI lanes',
    };
    return out;
  }

  function runOnce(opts) { return controller.runOnce(opts); }
  function control(action) { return controller.control(action); }

  function setConfig(patch) {
    // Run-state changes go through control() (abort, worker stop / register); set-config cannot change them.
    if (patch && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, 'runState')) return { ok: false, code: 'INVALID_INPUT', field: 'runState' };
    const prev = loadCfg();
    const r = configMod.saveAutopilotPatch(patch, cfgDeps);
    if (!r.ok) return r.key ? { ok: false, code: r.code, field: r.key } : r;
    const next = r.config;
    if (schema.isEnsured()) {
      try { cs.appendEvent({ caseId: null, at: clock(), kind: 'config', actor: 'user', reason: 'set_config', detail: { keys: Object.keys(patch || {}) } }); } catch (_) {}
    }
    controller.onConfigChanged(prev, next);
    // §6.7: a raised AI daily cap releases the cap-deferred cases (ai_retry_at = now; the
    // ai_capacity trigger requeues them on the next tick).
    const capOf = (c) => (c && c.ai && Number.isFinite(c.ai.dailyCap) ? c.ai.dailyCap : (c && Number.isFinite(c.dailyCap) ? c.dailyCap : null));
    const capPrev = capOf(prev);
    const capNext = capOf(next);
    if (capPrev != null && capNext != null && capNext > capPrev && schema.isEnsured()) {
      try { cs.releaseAiDeferred('cap', { now: clock() }); } catch (_) {}
    }
    if (configMod.cfgFp(prev) !== configMod.cfgFp(next)) controller.scheduleRunOnce();
    return { ok: true, config: next };
  }

  function _offList() { return { ok: true, enabled: false, total: 0, items: [] }; }

  function listCases(filter) {
    const cfg = loadCfg();
    if (!cfg.enabled) return _offList();
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const r = cs.listCases(filter || {});
    return { ok: true, total: r.total, items: r.items };
  }

  function getCase(caseId, opts) {
    const cfg = loadCfg();
    if (!cfg.enabled) return _offList();
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const r = cs.getCase(caseId, opts || {});
    if (!r) return { ok: false, code: 'NOT_FOUND' };
    // V2 (§10.1): the step trace (listed columns only, never prompts or model text), proposals, record, memory.
    const steps = cs.listSteps(caseId, { limit: 200 }).map((s) => {
      const o = {};
      for (const k of STEP_COLUMNS) o[k] = s[k] === undefined ? null : s[k];
      return o;
    });
    const rec = cs.getRecord(caseId);
    return Object.assign({ ok: true }, r, {
      steps,
      proposals: cs.listProposals(caseId),
      record: rec ? rec.record : null,
      memory: r.case && r.case.memory !== undefined ? r.case.memory : null,
    });
  }

  /** coverage() -> §10.1 autopilot:coverage payload; { ok:true, enabled:false } (no SQL) while the master switch is off. */
  function coverage() {
    const cfg = loadCfg();
    if (!cfg.enabled) return { ok: true, enabled: false };
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const now = clock();
    const cap = cfg.ai && Number.isFinite(cfg.ai.dailyCap) ? cfg.ai.dailyCap : cfg.dailyCap;
    const cv = cs.coverage(now);
    return {
      ok: true, pass: cv.pass, reconcileOk: cv.reconcileOk, groups: cv.groups,
      queue: cs.queueStats(now),
      ai: Object.assign({}, cs.aiBacklog(now, { cap }), cs.aiMetrics(now, { cap })),
      sources: cs.sourceMetrics(now),
    };
  }

  function listUnits(filter) {
    const cfg = loadCfg();
    if (!cfg.enabled) return _offList();
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const r = cs.listUnits(filter || {});
    return { ok: true, total: r.total, items: r.items };
  }

  /** deepInvestigate(caseId) (§8.7) -> { ok:true, state:'QUEUED' } | { ok:false, code } */
  function deepInvestigate(caseId) {
    const cfg = loadCfg();
    if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
    if (cfg.runState !== 'running') return { ok: false, code: 'NOT_RUNNING' };
    if (!supervisor.isEnabled()) return { ok: false, code: 'SUPERVISOR_DISABLED' };
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const r = cs.requestDeep(caseId, { now: clock() });
    if (!r || !r.ok) return { ok: false, code: (r && r.code) || 'INTERNAL' };
    controller.setPendingTrigger(caseId, 'manual');
    controller.scheduleRunOnce();
    return { ok: true, state: STATES.QUEUED };
  }

  function review(caseId, decision, note) {
    const cfg = loadCfg();
    if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
    if (!controller.ensureSchema()) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    const cur = cs.getCase(caseId);
    if (!cur) return { ok: false, code: 'NOT_FOUND' };
    if (decision === 'rerun' && (cur.case.state === STATES.INVESTIGATING || cur.case.state === STATES.ANALYZING)) return { ok: false, code: 'INVALID_STATE' };
    const r = cs.review(caseId, decision, { note, now: clock() });
    if (r.ok && decision === 'rerun') controller.setPendingTrigger(caseId, 'manual');
    return r;
  }

  async function harnessRun(opts) {
    const cfg = loadCfg();
    if (!cfg.enabled) return { ok: false, code: 'DISABLED' };
    if (!supervisor.isEnabled()) return { ok: false, code: 'SUPERVISOR_DISABLED' };
    let harness;
    try { harness = require('./harness'); } catch (_) { return { ok: false, code: 'UNAVAILABLE' }; }
    if (!harness || typeof harness.run !== 'function') return { ok: false, code: 'UNAVAILABLE' };
    return harness.run(Object.assign({}, opts || {}, {
      runInvestigation,
      controller: {
        withMutex: controller.withMutex, isRunning: controller.isRunning, ensureSchema: controller.ensureSchema,
        ports: controller.ports, limiter: controller.limiter, owner: controller.owner,
        beginExternalRun: controller.beginExternalRun,
      },
      caseStore: cs, config: cfg, loadConfig: loadCfg, now: clock, normUnit,
      supervisorEnabled: () => supervisor.isEnabled(), reason: d.reason, rand: d.rand,
    }));
  }

  return { boot, status, runOnce, control, setConfig, listCases, getCase, review, harnessRun, coverage, listUnits, deepInvestigate, controller };
}

let _default = null;
function _inst() { if (!_default) _default = createAutopilot(); return _default; }

module.exports = {
  createAutopilot,
  boot: (ctx) => _inst().boot(ctx),
  status: () => _inst().status(),
  runOnce: (opts) => _inst().runOnce(opts),
  control: (action) => _inst().control(action),
  setConfig: (patch) => _inst().setConfig(patch),
  listCases: (filter) => _inst().listCases(filter),
  getCase: (caseId, opts) => _inst().getCase(caseId, opts),
  review: (caseId, decision, note) => _inst().review(caseId, decision, note),
  harnessRun: (opts) => _inst().harnessRun(opts),
  coverage: () => _inst().coverage(),
  listUnits: (filter) => _inst().listUnits(filter),
  deepInvestigate: (caseId) => _inst().deepInvestigate(caseId),
};
