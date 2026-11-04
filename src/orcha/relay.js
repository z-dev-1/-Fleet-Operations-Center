'use strict';
/**
 * relay.js — Orcha AI Relay [V-C]
 * V-C changes vs V-B:
 *   - All hardcoded AppData\Roaming paths replaced with P.* from config/paths.js
 *   - console.log replaced with namespaced file-rotating logger
 *   - Cross-platform headless path (win32 vs darwin/linux)
 *   - Cross-platform mwinit spawn
 *   - _saveStatus uses atomic tmp->rename write
 */

const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { spawn, execFile } = require('child_process');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('relay');

// ── Claude Code diagnostics ───────────────────────────────────────────────────
// "Works then crashes" was traced to claude-code jobs intermittently HANGING
// past the timeout (not a hard credential failure). This optional debug layer
// captures WHY a job stalls: per-job phase timing (dispatch -> first stdout ->
// result), full (untruncated) stderr, and a dump on timeout. Off by default;
// enable with env FLEET_CLAUDE_DEBUG=1. Writes to the normal relay logger so it
// lands in relay.log alongside the existing lines.
const CLAUDE_DEBUG = process.env.FLEET_CLAUDE_DEBUG === '1';
function _cdbg(msg) { if (CLAUDE_DEBUG) logger.info('[claude-dbg] ' + msg); }

const fleetBrain = require('./fleet-brain');
// Wire fleet-brain's local fallback AFTER _tryClaudeCode is defined below.
// setImmediate defers to end-of-tick so the function reference is valid.
// Phase 3: with ai.gateway.abortOnTimeout the caller's signal reaches the Claude
// pool (abort frees the single worker); with ai.gateway.priorities the relay
// priority orders the pool queue. Both flags off: _tryClaudeCode(prompt, {}),
// identical to the old (prompt) => _tryClaudeCode(prompt).
function _localAskFn(prompt, o) {
  const gw = _gw();
  return _tryClaudeCode(prompt, {
    ...(gw.abortOnTimeout && o && o.signal ? { signal: o.signal } : {}),
    ...(gw.priorities && o && o.priority ? { prio: o.priority } : {}),
  });
}
setImmediate(() => {
  fleetBrain.setLocalAskFn(_localAskFn);
  logger.info('fleet-brain local AI fallback wired to claude-code');
});

// ── AI GATEWAY FLAGS (Phase 3) ────────────────────────────────────────────────
// All default OFF (config/perf-flags.js loadAiGateway: settings.ai.gateway.* +
// FLEET_AI_GW_* env). Cached for GW_FLAG_TTL_MS so a settings change applies
// without a restart and there is no sync settings read per ask. With every
// flag off the legacy paths below behave exactly as before Phase 3.
const perfFlags = require('../config/perf-flags');
const GW_FLAG_TTL_MS = 15000;
const _GW_DEFAULTS = Object.freeze({ priorities: false, abortOnTimeout: false, dedupe: false, routerDecides: false, reserveSlots: 2 });
let _gwOverride = null;   // test seam: setGatewayFlags
let _gwLoader = null;     // test seam: setGatewayLoader
let _gwCache = null;
let _gwCacheAt = 0;
function _normGwFlags(f) {
  const o = Object.assign({}, _GW_DEFAULTS, (f && typeof f === 'object') ? f : {});
  const out = {
    priorities: o.priorities === true,
    abortOnTimeout: o.abortOnTimeout === true,
    dedupe: o.dedupe === true,
    routerDecides: o.routerDecides === true,
    reserveSlots: (Number.isInteger(o.reserveSlots) && o.reserveSlots >= 0 && o.reserveSlots <= 4) ? o.reserveSlots : 2,
  };
  return Object.freeze(out);
}
function _gw() {
  if (_gwOverride) return _gwOverride;
  const now = Date.now();
  if (_gwCache && (now - _gwCacheAt) < GW_FLAG_TTL_MS && now >= _gwCacheAt) return _gwCache;
  let f = null;
  try { f = (_gwLoader || perfFlags.loadAiGateway)(); } catch (_) { f = null; }
  _gwCache = _normGwFlags(f);
  _gwCacheAt = now;
  return _gwCache;
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
const DEFAULTS  = require('../config/defaults');
const MODEL_ID    = DEFAULTS.AI_MODEL_ID;
const REGION      = DEFAULTS.AI_REGION;
const MAX_TOKENS  = DEFAULTS.AI_MAX_TOKENS;
const TIMEOUT_MS  = 120000;
const MAX_RETRIES = 2;

// ── ORCHA URL ─────────────────────────────────────────────────────────────────
function getOrchaUrl() {
  try {
    if (fs.existsSync(P.orchaConfig)) {
      const cfg = JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      if (cfg.mode === 'remote' && cfg.host) return `ws://${cfg.host}:${cfg.port || 4799}`;
    }
  } catch (_) {}
  try {
    const raw  = fs.readFileSync(P.orchaPort, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0) return `ws://localhost:${port}`;
  } catch (_) {}
  return 'ws://localhost:4799';
}

// ── STATE ─────────────────────────────────────────────────────────────────────
let _lastHealthy  = null;
let _lastError    = null;
let _status       = 'unknown'; // 'connected' | 'expired' | 'error' | 'unknown'
let _requestCount = 0;
let _errorCount   = 0;
let _aiPreference = 'auto'; // 'auto' | 'orcha' | 'claude' | 'balanced'
// Orcha agent id used for every WS/headless request (Settings -> AI -> Orcha
// Agent). The agent selects the server-side model. Was hardcoded to
// 'orcha_default' in both transports, so the Settings dropdown had no effect.
let _orchaAgentId = 'orcha_default';
// Bedrock fallback (direct Claude via Bedrock SDK) is OFF by default: this
// account's Isengard role lacks bedrock:InvokeModel, so the call always fails
// with "not authorized" — it only added latency + log noise to every failure.
// Kept behind a flag (env FLEET_ENABLE_BEDROCK=1) so it can be re-enabled if the
// role is ever granted Bedrock access, without ripping out the code.
let _bedrockEnabled = process.env.FLEET_ENABLE_BEDROCK === '1'; // let: test seam setBedrockEnabled

// ── CONCURRENCY ───────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 5;
let _activeCount = 0;
const _waitQueue = [];
let _reqSeq = 0;

// ── BALANCED-MODE LANE ROUTER ─────────────────────────────────────────────────
// Two "lanes" — Orcha (fleet-brain/WS/CLI) and Claude (claude-code/Bedrock).
// In 'balanced' mode, a new request is dispatched to the least-busy HEALTHY
// lane so the two run side by side (Orcha busy -> next goes to Claude), instead
// of everything single-filing through Orcha. Each task still runs on ONE lane
// (no doubled calls / no extra quota). If a lane is in a health cooldown, ALL
// requests go to the other lane — so if Orcha is down everything uses Claude,
// and vice versa. Whichever lane is chosen still falls through to the other on
// a real failure, so the full fallback safety net is preserved.
let _orchaBusy = 0;
let _claudeBusy = 0;
let _orchaDownUntil  = 0;  // epoch ms; while now < this, treat Orcha lane as down
let _claudeDownUntil = 0;
const LANE_COOLDOWN_MS = 60000; // how long a lane stays "down" after a failure

function _laneHealthy(lane) {
  const now = Date.now();
  return lane === 'orcha' ? now >= _orchaDownUntil : now >= _claudeDownUntil;
}
function _markLaneDown(lane) {
  const until = Date.now() + LANE_COOLDOWN_MS;
  if (lane === 'orcha') _orchaDownUntil = until; else _claudeDownUntil = until;
  logger.warn('[balanced] lane "' + lane + '" marked down for ' + (LANE_COOLDOWN_MS / 1000) + 's');
}
function _markLaneHealthy(lane) {
  if (lane === 'orcha') _orchaDownUntil = 0; else _claudeDownUntil = 0;
}

// Decide which lane a new balanced-mode request should START on.
function _pickLane() {
  const orchaOk  = _laneHealthy('orcha');
  const claudeOk = _laneHealthy('claude');
  // If exactly one lane is healthy, use it exclusively (single-backend mode).
  if (orchaOk && !claudeOk) return 'orcha';
  if (claudeOk && !orchaOk) return 'claude';
  if (!orchaOk && !claudeOk) return 'orcha'; // both cooling down — try Orcha, it'll fall through
  // Both healthy: least-busy wins; ties go to Orcha (primary).
  return _claudeBusy < _orchaBusy ? 'claude' : 'orcha';
}

// ── SLOT GATE: PRIORITIES, RESERVATION, AGING (Phase 3) ──────────────────────
// Legacy mode (ai.gateway.priorities off): exactly the old gate — a free slot
// is taken immediately, 'high' waits ahead of everything non-high (behind other
// highs), everything else is FIFO; release grants the head of the queue.
// Gateway mode: four levels critical | high | normal | low, picked by rank then
// FIFO; low may not take the last `reserveSlots` slots (until it has waited
// LOW_RESERVE_LIFT_MS); waiting entries age one level per AGE_STEP_MS (capped at
// high-equivalent, never outranking critical). No preemption.
// Both modes share one queue and grant ONLY through _grant(), so accounting
// (_activeCount/_activeBy) stays consistent across a flag flip.
const PRIORITIES = ['critical', 'high', 'normal', 'low'];
const _BASE_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
const AGE_STEP_MS = 30000;
const LOW_RESERVE_LIFT_MS = 120000;
const _activeBy = { critical: 0, high: 0, normal: 0, low: 0 };
let _slotSeq = 0;
let _liftTimer = null;
let _underflows = 0; // defensive accounting check (never expected; pinned by tests)
function _noop() {}

// Source → priority (gateway mode only; an explicit opts.priority wins). Call
// sites tag `source` instead of passing new priority literals so that legacy
// mode (which only honors the literal 'high') keeps today's ordering.
const SOURCE_PRIORITY = Object.freeze({
  // high: Slack DM / Just Me / channel replies, FAS inbound, PM alert replies
  fas_agent: 'high',
  'orcha_action:slack-justme': 'high',
  slack_dm_legacy: 'high',
  slack_channel_draft: 'high',
  slack_directed_gate: 'high',
  pm_alert_reply: 'high',
  pm_alert_fanout: 'high',
  ready_pickup_reply: 'high',
  vision_fas_attachment: 'high',
  // normal: chat, RCA, briefings, user-forced single-unit work
  'orcha_action:fab': 'normal',
  'orcha_action:chat': 'normal',
  ui_ai_ask: 'normal',
  rca_autofill: 'normal',
  email_actions: 'normal',
  breakdown_analysis: 'normal',
  breakdown_summary: 'normal',
  briefing: 'normal',
  carrier_briefing: 'normal',
  dbr_parse: 'normal',
  volvo_ck82: 'normal',
  ready_pickup_notice: 'normal',
  slack_chime_in_gate: 'normal',
  deep_scan_unit: 'normal',
  repair_intel_unit: 'normal',
  escalation_suggest: 'normal',
  vision_image: 'normal',
  vision_document: 'normal',
  vision: 'normal',
  // low: background analysis
  deep_scan: 'low',
  repair_intel_analysis: 'low',
  'reason:tasks': 'low',
  fas_shadow: 'low',
  offline_rewrite: 'low',
});

function _normSource(s) {
  if (typeof s !== 'string') return 'unknown';
  const t = s.trim();
  return /^[a-z0-9_:.\-]{1,64}$/i.test(t) ? t : 'unknown';
}

// opts: { priority, source (normalized) }
function _effectivePriority(opts, gw) {
  if (!gw.priorities) return opts.priority === 'high' ? 'high' : 'normal';
  if (PRIORITIES.includes(opts.priority)) return opts.priority;
  return SOURCE_PRIORITY[opts.source] || 'normal';
}

function _abortedQueuedErr() { return Object.assign(new Error('Aborted while queued'), { code: 'ABORTED' }); }
function _abortedErr() { return Object.assign(new Error('Aborted'), { code: 'ABORTED' }); }
function _timeoutErr(ms) { return Object.assign(new Error('AI timeout after ' + Math.round(ms / 1000) + 's'), { code: 'AI_TIMEOUT' }); }

function _grant(e) {
  _activeCount++;
  _activeBy[e.prio] = (_activeBy[e.prio] || 0) + 1;
  e.state = 'granted';
  try { e.cleanup(); } catch (_) {}
  e.go(e.prio);
}

// _acquireSlot(prio, signal, cancellable) -> Promise<label>. `cancellable`
// (= abortOnTimeout && signal) lets an abort remove a still-waiting entry.
function _acquireSlot(prio, signal, cancellable) {
  if (!PRIORITIES.includes(prio)) prio = 'normal';
  return new Promise((resolve, reject) => {
    if (cancellable && signal.aborted) { reject(_abortedQueuedErr()); return; }
    const e = { go: resolve, fail: reject, high: prio === 'critical' || prio === 'high', prio,
      seq: ++_slotSeq, enqAt: Date.now(), state: 'waiting', cleanup: _noop };
    const gw = _gw();
    if (!gw.priorities) {
      if (_activeCount < MAX_CONCURRENT) { _grant(e); return; }
      if (e.high) {
        const at = _waitQueue.findIndex((w) => !w.high);
        _waitQueue.splice(at === -1 ? _waitQueue.length : at, 0, e);
      } else _waitQueue.push(e);
    } else {
      _waitQueue.push(e);
      _dispatch(gw);
    }
    if (cancellable && e.state === 'waiting') {
      const onAbort = () => {
        if (e.state !== 'waiting') return;
        const i = _waitQueue.indexOf(e);
        if (i !== -1) _waitQueue.splice(i, 1);
        e.state = 'cancelled';
        logger.info('[relay] dequeued after ' + (Date.now() - e.enqAt) + 'ms (aborted)');
        reject(_abortedQueuedErr());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      e.cleanup = () => { try { signal.removeEventListener('abort', onAbort); } catch (_) {} };
    }
  });
}

function _releaseSlot(label) {
  const l = PRIORITIES.includes(label) ? label : 'normal';
  if (_activeCount <= 0) { _underflows++; logger.warn('[relay] slot accounting underflow (active)'); }
  if (_activeBy[l] <= 0) { _underflows++; logger.warn('[relay] slot accounting underflow (' + l + ')'); }
  _activeCount = Math.max(0, _activeCount - 1);
  _activeBy[l] = Math.max(0, _activeBy[l] - 1);
  _pump();
}

// Grant according to the CURRENT mode (shared by release and the lift timer).
function _pump() {
  const gw = _gw();
  if (gw.priorities) { _dispatch(gw); return; }
  while (_activeCount < MAX_CONCURRENT && _waitQueue.length) {
    const n = _waitQueue.shift();
    if (n.state === 'waiting') { _grant(n); break; }
  }
}

function _rankOf(e, now) {
  if (e.prio === 'critical') return 0;
  return Math.max(1, _BASE_RANK[e.prio] - Math.floor((now - e.enqAt) / AGE_STEP_MS));
}

function _dispatch(gw) {
  gw = gw || _gw();
  while (_activeCount < MAX_CONCURRENT && _waitQueue.length) {
    const now = Date.now();
    let best = -1, bestRank = 0, bestSeq = 0;
    for (let i = 0; i < _waitQueue.length; i++) {
      const e = _waitQueue[i];
      if (e.state !== 'waiting') continue;
      if (e.prio === 'low' && _activeCount >= MAX_CONCURRENT - gw.reserveSlots && (now - e.enqAt) < LOW_RESERVE_LIFT_MS) continue; // reservation
      const rank = _rankOf(e, now);
      if (best === -1 || rank < bestRank || (rank === bestRank && e.seq < bestSeq)) { best = i; bestRank = rank; bestSeq = e.seq; }
    }
    if (best === -1) break;
    const [e] = _waitQueue.splice(best, 1);
    _grant(e);
  }
  _armLiftTimer();
}

// One unref'd timer at the earliest reservation lift among waiting lows, so a
// low blocked only by reservation is granted at its lift time even when no
// release happens. Only needed while a slot is actually free.
function _armLiftTimer() {
  if (_liftTimer) { clearTimeout(_liftTimer); _liftTimer = null; }
  if (_activeCount >= MAX_CONCURRENT) return;
  let earliest = Infinity;
  for (const e of _waitQueue) {
    if (e.state === 'waiting' && e.prio === 'low') earliest = Math.min(earliest, e.enqAt + LOW_RESERVE_LIFT_MS);
  }
  if (earliest === Infinity) return;
  const delay = Math.max(10, earliest - Date.now());
  _liftTimer = setTimeout(() => { _liftTimer = null; _pump(); }, delay);
  if (_liftTimer && typeof _liftTimer.unref === 'function') _liftTimer.unref();
}

function queueStats() {
  const gw = _gw();
  const now = Date.now();
  const byPriority = {};
  for (const p of PRIORITIES) byPriority[p] = { active: _activeBy[p] || 0, waiting: 0 };
  let oldest = null;
  for (const e of _waitQueue) {
    if (e.state !== 'waiting') continue;
    byPriority[e.prio].waiting++;
    const w = now - e.enqAt;
    if (oldest == null || w > oldest) oldest = w;
  }
  return {
    active: _activeCount, waiting: _waitQueue.length, max: MAX_CONCURRENT,
    reserve: gw.reserveSlots,
    byPriority,
    oldestWaitMs: oldest,
    inflightDedupe: _inflight.size,
    flags: { priorities: gw.priorities, abortOnTimeout: gw.abortOnTimeout, dedupe: gw.dedupe, routerDecides: gw.routerDecides },
    claudePool: _claudePoolStats(),
  };
}

// ── ASK ───────────────────────────────────────────────────────────────────────
// ask(prompt, opts) is a thin wrapper: optional in-flight dedupe (only with an
// explicit opts.dedupeKey AND ai.gateway.dedupe), else _askCore, which owns the
// slot gate, cancellation and telemetry around the unchanged cascade
// (_runCascade). Options (all optional):
//   signal, requestId, priority ('critical'|'high'|'normal'|'low'), source,
//   timeoutMs (honored only with ai.gateway.abortOnTimeout), dedupeKey, task,
//   routeMessage (router input, ai.gateway.routerDecides), trace (AiCore handle).
const _inflight = new Map(); // dedupeKey -> { prompt, promise, controller, refs, record }

async function ask(prompt, opts = {}) {
  opts = opts || {};
  const gw = _gw();
  return (gw.dedupe && _validDedupeKey(opts.dedupeKey))
    ? _joinInflight(prompt, opts, gw)
    : _askCore(prompt, opts, gw);
}

function _isSignal(s) { return !!(s && typeof s === 'object' && 'aborted' in s && typeof s.addEventListener === 'function'); }
function _validTimeout(t) { return typeof t === 'number' && Number.isFinite(t) && t > 0; }

// Internal AbortController linked to the caller's signal, aborted by the
// caller or by an optional timer (sets linked.timedOut).
function _linkSignal(callerSignal, timeoutMs, requestId) {
  const ac = new AbortController();
  const linked = { signal: ac.signal, timedOut: false, cleanup: _noop };
  let onCaller = null;
  let timer = null;
  if (callerSignal) {
    if (callerSignal.aborted) ac.abort();
    else { onCaller = () => ac.abort(); callerSignal.addEventListener('abort', onCaller, { once: true }); }
  }
  if (timeoutMs && !ac.signal.aborted) {
    timer = setTimeout(() => {
      timer = null;
      linked.timedOut = true;
      logger.warn('[' + requestId + '] relay.ask timed out after ' + timeoutMs + 'ms — aborting');
      ac.abort();
    }, timeoutMs);
  }
  linked.cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (onCaller) { try { callerSignal.removeEventListener('abort', onCaller); } catch (_) {} onCaller = null; }
  };
  return linked;
}

let _traceMod = null;
function _trace() {
  if (_traceMod) return _traceMod;
  try { _traceMod = require('../ai/trace'); } catch (_) { _traceMod = null; }
  return _traceMod;
}
function _emitGatewayRecord(rec, traceHandle) {
  let stored = null;
  try { const t = _trace(); if (t && typeof t.recordGateway === 'function') stored = t.recordGateway(rec); } catch (_) {}
  if (traceHandle && typeof traceHandle.setGateway === 'function') {
    try { traceHandle.setGateway(stored || rec); } catch (_) {}
  }
  return stored || rec;
}

function _classify(ok, err, linked, meta, callerSignal) {
  if (ok) return (meta && meta.timedOut) ? { outcome: 'timeout', late: true } : { outcome: 'ok' };
  if ((linked && linked.timedOut) || (meta && meta.timedOut) || (err && err.code === 'AI_TIMEOUT')) return { outcome: 'timeout' };
  if (callerSignal && callerSignal.aborted) return { outcome: 'aborted' };
  if (err && err.code === 'ABORTED') return { outcome: 'aborted' };
  return { outcome: 'error' };
}

async function _askCore(prompt, opts = {}, gwIn) {
  opts = opts || {};
  const gw = gwIn || _gw();
  const callerSignal = opts.signal;
  const requestId = opts.requestId || ('rl' + (++_reqSeq));
  if (callerSignal && callerSignal.aborted) throw new Error('Aborted before start');
  const source = _normSource(opts.source);
  const prio = _effectivePriority({ priority: opts.priority, source }, gw);
  const meta = (opts.__gwMeta && typeof opts.__gwMeta === 'object') ? opts.__gwMeta : null;
  const t0 = Date.now();

  // Linkage (ai.gateway.abortOnTimeout only): opts.timeoutMs and the caller's
  // signal drive one internal controller; flag off = caller signal as-is and
  // timeoutMs ignored (as before).
  let linked = null;
  let timeoutMs = null;
  if (gw.abortOnTimeout) {
    if (opts.timeoutMs !== undefined && opts.timeoutMs !== null) {
      if (_validTimeout(opts.timeoutMs)) timeoutMs = opts.timeoutMs;
      else logger.debug && logger.debug('[' + requestId + '] ignoring invalid timeoutMs');
    }
    if (timeoutMs || callerSignal) linked = _linkSignal(callerSignal, timeoutMs, requestId);
  }
  const signal = linked ? linked.signal : callerSignal;
  const cancellable = !!(gw.abortOnTimeout && signal);
  const rec = { requestId, source, priority: prio, legacy: !gw.priorities, via: null, routedLane: null, routeRationale: null,
    timeoutMs: timeoutMs || (meta && meta.timeoutMs) || null };

  let granted = false;
  let label = null;
  let tGranted = null;
  let ok = false;
  let err = null;
  try {
    try { label = await _acquireSlot(prio, signal, cancellable); }
    catch (e) { if (linked && linked.timedOut) throw _timeoutErr(timeoutMs); throw e; }
    granted = true;
    tGranted = Date.now();
    _requestCount++;
    logger.info('[' + requestId + '] relay.ask started');

    const ctx = {
      signal, requestId, prio, source, opts, gw, rec,
      fbPriority: gw.priorities ? ((prio === 'critical' || prio === 'high') ? 'high' : prio) : opts.priority,
    };
    const cascadeP = _runCascade(prompt, ctx);
    let result;
    if (linked) {
      cascadeP.catch(() => {});
      const abortP = new Promise((_, reject) => {
        const fire = () => reject(linked.timedOut ? _timeoutErr(timeoutMs) : _abortedErr());
        if (linked.signal.aborted) { fire(); return; }
        linked.signal.addEventListener('abort', fire, { once: true });
      });
      abortP.catch(() => {});
      try { result = await Promise.race([cascadeP, abortP]); }
      catch (e) { if (linked.timedOut) throw _timeoutErr(timeoutMs); throw e; }
    } else {
      result = await cascadeP;
    }
    ok = true;
    return result;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    // Single, unconditional cleanup point -- every return/throw path (success
    // at any tier, every-tier-failed, aborted, timed out) funnels through here
    // exactly once, so a granted slot can never be double-released or leaked.
    if (granted) {
      _releaseSlot(label);
      logger.info('[' + requestId + '] relay.ask cleanup completed -- slot released');
    }
    if (linked) linked.cleanup();
    try {
      const now = Date.now();
      const c = _classify(ok, err, linked, meta, callerSignal);
      const full = Object.assign({}, rec, {
        at: new Date(t0).toISOString(),
        queueWaitMs: (tGranted || now) - t0,
        runMs: tGranted ? now - tGranted : null,
        latencyMs: now - t0,
        outcome: c.outcome,
      });
      if (c.late) full.late = true;
      if (!ok && err) full.error = String(err.message || err).slice(0, 200);
      const stored = _emitGatewayRecord(full, opts.trace);
      if (typeof opts.__gwOnRecord === 'function') { try { opts.__gwOnRecord(stored); } catch (_) {} }
    } catch (_) {}
  }
}

// Options for the cascade's Claude pool calls: unchanged unless priorities on.
function _ccOpts(ctx) {
  return { signal: ctx.signal, requestId: ctx.requestId, ...(ctx.gw.priorities ? { prio: ctx.prio } : {}) };
}

// The relay cascade (fleet-brain → direct WS → Claude Code → optional Bedrock,
// plus the 'claude' and 'balanced' preference branches), moved verbatim from
// the old ask() body. Flag-gated additions only: router pre-step, detach
// option for fleet-brain, abortable retry sleep, pre-Bedrock abort guard.
async function _runCascade(prompt, ctx) {
  const { signal, requestId, gw, rec } = ctx;
  const opts = ctx.opts;
  // Set true when balanced mode routes this call to the Orcha lane, so the
  // finally can decrement _orchaBusy exactly once (per-call local — must
  // NOT be module scope or concurrent calls would corrupt the counter).
  let _balancedOrchaHeld = false;

  try {
    // Optional router pre-step (ai.gateway.routerDecides, preference 'auto',
    // caller-supplied task/routeMessage only). Never classifies the full prompt.
    if (gw.routerDecides && _aiPreference === 'auto') {
      const routed = await _routerPrestep(prompt, ctx);
      if (routed) return routed;
    }

    // Preference: 'claude' -- skip Orcha entirely, go straight to Claude Code
    if (_aiPreference === 'claude') {
      try {
        const ccText = await _tryClaudeCode(prompt, _ccOpts(ctx));
        if (ccText) {
          _lastHealthy = Date.now(); _status = 'connected-claude'; _saveStatus();
          logger.info('[' + requestId + '] OK via claude-code (preference=claude, ' + ccText.length + ' chars)');
          rec.via = 'claude-code';
          return ccText;
        }
      } catch (ccErr) { logger.warn('[' + requestId + '] claude-code fast-path failed: ' + ccErr.message); }
      _lastError = 'Claude Code failed'; _status = 'error'; _errorCount++;
      _saveStatus();
      throw new Error('Claude Code unavailable (preference=claude)');
    }

    // Preference: 'balanced' -- two-lane load balancer. Dispatch to the
    // least-busy healthy lane so Orcha and Claude run side by side; if one lane
    // is down, everything goes to the other. Whichever lane is picked still
    // falls through to the other on failure (safety net preserved).
    if (_aiPreference === 'balanced') {
      const lane = _pickLane();
      logger.info('[' + requestId + '] balanced -> lane "' + lane + '" (orchaBusy=' + _orchaBusy + ' claudeBusy=' + _claudeBusy + ')');
      if (lane === 'claude') {
        _claudeBusy++;
        try {
          const t = await _tryClaudeCode(prompt, _ccOpts(ctx));
          if (t) {
            _markLaneHealthy('claude');
            _lastHealthy = Date.now(); _lastError = null; _status = 'connected-claude'; _saveStatus();
            logger.info('[' + requestId + '] OK via balanced/claude (' + t.length + ' chars)');
            rec.via = 'balanced/claude';
            return t;
          }
          throw new Error('claude-code empty');
        } catch (ccErr) {
          if (signal && signal.aborted) throw ccErr;
          _markLaneDown('claude');
          logger.warn('[' + requestId + '] balanced/claude failed (' + ccErr.message + ') — falling through to Orcha lane');
          // fall through to the Orcha cascade below
        } finally {
          _claudeBusy--;
        }
      } else {
        // lane === 'orcha' — count it as Orcha-busy for the duration of the
        // Orcha cascade below. Decrement in the finally via a flag.
        _orchaBusy++;
        _balancedOrchaHeld = true;
      }
    }

    // PRIMARY: Route through fleet-brain (persistent session with full fleet context).
    // fleet-brain.getStatus().ready is true in BOTH WS mode (Orcha running) AND
    // local mode (claude-code fallback wired in). Either way fleet-brain manages
    // the system prompt + rolling conversation history so every AI call is context-aware.
    let _fbJustTimedOut = false;
    try {
      const _fbStatus = fleetBrain.getStatus ? fleetBrain.getStatus() : {};
      if (!_fbStatus || !_fbStatus.ready) throw new Error('fleet-brain not ready');
      logger.info('[' + requestId + '] Fleet Brain attempt started');
      // abortOnTimeout: a relay abort DETACHES the active WS request instead of
      // terminating the one shared Orcha session (fleet-brain §6.5).
      const fbOpts = { signal, requestId, priority: ctx.fbPriority };
      if (gw.abortOnTimeout) fbOpts.detachActiveOnAbort = true;
      const text = await fleetBrain.ask(prompt, fbOpts);
      if (text) {
        const via = _fbStatus.localMode ? 'fleet-brain/local' : 'fleet-brain/ws';
        _markLaneHealthy(_fbStatus.localMode ? 'claude' : 'orcha');
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        logger.info('[' + requestId + '] OK via ' + via + ' (' + text.length + ' chars)');
        _saveStatus();
        rec.via = via;
        return text;
      }
    } catch (brainErr) {
      if (signal && signal.aborted) throw brainErr;
      logger.warn('[' + requestId + '] Fleet-brain failed: ' + brainErr.message);
      // If fleet-brain JUST failed with a timeout, that alone proves the WS
      // endpoint isn't answering right now -- retrying the identical Orcha URL
      // via _tryWS below is guaranteed to burn another ~60s doing nothing
      // (this was silently eating the last 40s of budget before CLI/Claude
      // Code ever got a chance to run). Treat a timeout as equivalent to
      // "down" regardless of what fleetBrain.getStatus().connected reports,
      // since that flag doesn't reliably flip immediately after ws.terminate().
      _fbJustTimedOut = /timeout/i.test(brainErr.message || '');
    }

    // FALLBACK: Direct WS (throwaway session, no context).
    // Skip entirely if fleet-brain already confirmed the WS endpoint is unreachable,
    // or just proved it via a timeout -- _tryWS hits the same URL and would just
    // burn the full timeout for nothing, starving CLI/Claude Code/Bedrock of time.
    const _fbDown = _fbJustTimedOut || !(fleetBrain.getStatus ? fleetBrain.getStatus().connected : false);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (signal && signal.aborted) throw new Error('Aborted');
      try {
        logger.info('[' + requestId + '] WebSocket attempt ' + attempt);
        const text = _fbDown ? null : await _tryWSImpl(prompt, { signal }).catch(() => null);
        if (text) {
          _markLaneHealthy('orcha');
          _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
          logger.info('[' + requestId + '] OK via WS fallback (' + text.length + ' chars, attempt ' + attempt + ')');
          _saveStatus();
          rec.via = 'ws';
          return text;
        }
        // Headless CLI fallback (`orcha --headless`) intentionally removed from
        // the cascade: each call launched a full extra Orcha + daemon that was
        // never cleaned up, and those copies killed each other's agent on port
        // 4799. orcha-supervisor.js now keeps ONE background agent alive and
        // fleet-brain reaches it over the WebSocket.
        // Skip Claude Code fallback when preference is 'orcha'
        if (_aiPreference !== 'orcha') {
          // CLAUDE CODE FALLBACK: claude -p via Cecelia shared account
          try {
            logger.info('[' + requestId + '] Claude Code attempt ' + attempt);
            const ccText = await _tryClaudeCode(prompt, _ccOpts(ctx));
            if (ccText) {
              _markLaneHealthy('claude');
              _lastHealthy = Date.now(); _status = 'connected-claude';
              _saveStatus();
              logger.info('[' + requestId + '] OK via claude-code fallback (' + ccText.length + ' chars)');
              rec.via = 'claude-code';
              return ccText;
            }
          } catch (ccErr) { logger.warn('[' + requestId + '] claude-code fallback failed: ' + ccErr.message); }
        }

        // BEDROCK FALLBACK: direct Claude call via Bedrock SDK.
        // Disabled by default (see _bedrockEnabled above) because this account
        // is not authorized for bedrock:InvokeModel — the call always fails and
        // just slowed down every "all transports failed" path. Set
        // FLEET_ENABLE_BEDROCK=1 to re-enable if the role gains Bedrock access.
        if (_bedrockEnabled) {
          // askBedrock cannot be aborted: never START it after an abort
          // (abortOnTimeout only; legacy behavior unchanged).
          if (gw.abortOnTimeout && signal && signal.aborted) throw new Error('Aborted');
          try {
            const { askBedrock } = require('../scrapers/bedrock');
            logger.info('[' + requestId + '] Bedrock attempt ' + attempt);
            const brText = await askBedrock(prompt);
            if (brText) {
              _markLaneHealthy('claude');
              _lastHealthy = Date.now(); _status = 'connected-bedrock';
              _saveStatus();
              logger.info('[' + requestId + '] OK via Bedrock fallback (' + brText.length + ' chars)');
              rec.via = 'bedrock';
              return brText;
            }
          } catch (brErr) { logger.warn('[' + requestId + '] Bedrock failed: ' + brErr.message); }
        }
        throw new Error('All transports failed');
      } catch (e) {
        const msg = e.message || String(e);
        logger.warn('[' + requestId + '] Fallback ERROR attempt ' + attempt + '/' + MAX_RETRIES + ': ' + msg);
        if (signal && signal.aborted) throw new Error('Aborted');
        if (attempt < MAX_RETRIES) { await _sleep(2000, gw.abortOnTimeout ? signal : null); continue; }
        // Whole Orcha-first cascade exhausted — in balanced mode this means the
        // Orcha lane is unhealthy right now, so cool it down and let subsequent
        // balanced requests route to the Claude lane instead.
        _markLaneDown('orcha');
        _lastError = msg; _status = 'error'; _errorCount++;
        _saveStatus();
        throw new Error('Orcha AI failed: ' + msg);
      }
    }
    throw new Error('Max retries exhausted');
  } finally {
    if (_balancedOrchaHeld) _orchaBusy--; // release the balanced Orcha-lane hold
  }
}

// Router pre-step (ai.gateway.routerDecides + preference 'auto'). Returns the
// Claude-first text when the router picks 'claude' and it succeeds, else null
// (normal auto cascade). Vision tasks throw NO_VISION_LANE: every relay lane is
// text-only (vision goes through bedrock.readFileWithVision).
async function _routerPrestep(prompt, ctx) {
  const { opts, rec, requestId, signal } = ctx;
  const task = (opts.task && typeof opts.task === 'object' && !Array.isArray(opts.task)) ? opts.task : null;
  const routeMessage = typeof opts.routeMessage === 'string' ? opts.routeMessage.slice(0, 2000) : null;
  if (!task && routeMessage == null) return null;
  let decision = null;
  try {
    const b = getStatus().backends || {};
    decision = require('../ai/router').decide({ source: ctx.source, message: routeMessage || '', task: task || undefined },
      { preference: 'auto', laneHealth: { orcha: !!b.orcha, claude: !!b.claude } });
  } catch (e) {
    logger.warn('[' + requestId + '] router.decide failed: ' + e.message);
    decision = null;
  }
  const needsVision = (task && task.requiresVision === true) || !!(decision && decision.task && decision.task.requiresVision);
  if (needsVision) {
    rec.routedLane = 'none';
    rec.routeRationale = 'vision request: no relay lane';
    logger.warn('[' + requestId + '] router: vision request cannot be served by any relay lane');
    throw Object.assign(new Error('relay.ask cannot satisfy a vision request; use bedrock.readFileWithVision'), { code: 'NO_VISION_LANE' });
  }
  if (!decision) return null;
  rec.routedLane = decision.effectiveLane || null;
  rec.routeRationale = decision.rationale ? String(decision.rationale).slice(0, 120) : null;
  if (decision.effectiveLane !== 'claude') return null;
  try {
    const t = await _tryClaudeCode(prompt, _ccOpts(ctx));
    if (t) {
      _markLaneHealthy('claude');
      _lastHealthy = Date.now(); _lastError = null; _status = 'connected-claude'; _saveStatus();
      logger.info('[' + requestId + '] OK via router/claude (' + t.length + ' chars)');
      rec.via = 'router/claude';
      return t;
    }
  } catch (e) {
    if (signal && signal.aborted) throw e;
    logger.warn('[' + requestId + '] router claude-first failed (' + e.message + ') — falling through to auto cascade');
  }
  return null;
}

// ── IN-FLIGHT DEDUPE (ai.gateway.dedupe) ─────────────────────────────────────
// Only with an explicit, valid opts.dedupeKey. Never dedupes by prompt text.
function _validDedupeKey(k) {
  if (typeof k !== 'string') return false;
  const n = k.trim().length;
  return n >= 1 && n <= 200;
}

async function _joinInflight(prompt, opts = {}, gwIn) {
  opts = opts || {};
  const gw = gwIn || _gw();
  if (opts.signal && opts.signal.aborted) throw new Error('Aborted before start');
  const key = opts.dedupeKey.trim();
  let entry = _inflight.get(key);
  if (entry && entry.prompt !== prompt) {
    logger.warn('[relay] dedupe key collision with different prompt; running independently (' + key.slice(0, 60) + ')');
    return _askCore(prompt, opts, gw);
  }
  let isLeader = false;
  if (!entry) {
    isLeader = true;
    const e = { prompt, promise: null, controller: new AbortController(), refs: 0, record: null };
    _inflight.set(key, e);
    // The leader's private __gwMeta / trace / timeoutMs are stripped: each
    // participant records its own outcome below.
    const under = Object.assign({}, opts, {
      dedupeKey: undefined, timeoutMs: undefined, __gwMeta: undefined, trace: undefined,
      signal: e.controller.signal, __gwOnRecord: (r) => { e.record = r; },
    });
    e.promise = _askCore(prompt, under, gw).finally(() => { if (_inflight.get(key) === e) _inflight.delete(key); });
    e.promise.catch(() => {});
    entry = e;
  }
  entry.refs++;
  return _participant(entry, key, opts, gw, isLeader);
}

function _participant(entry, key, opts, gw, isLeader) {
  const t0 = Date.now();
  const source = _normSource(opts.source);
  const prio = _effectivePriority({ priority: opts.priority, source }, gw);
  const meta = (opts.__gwMeta && typeof opts.__gwMeta === 'object') ? opts.__gwMeta : null;
  const sig = opts.signal;
  const timeoutMs = (gw.abortOnTimeout && _validTimeout(opts.timeoutMs)) ? opts.timeoutMs : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const done = (outcome, value, err, detached) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (sig && onAbort) { try { sig.removeEventListener('abort', onAbort); } catch (_) {} }
      if (detached) {
        if (--entry.refs === 0) { if (_inflight.get(key) === entry) _inflight.delete(key); entry.controller.abort(); }
      } else {
        entry.refs = Math.max(0, entry.refs - 1);
      }
      try {
        let r;
        if (isLeader && !detached && entry.record) {
          r = Object.assign({}, entry.record);
          if (meta && meta.timedOut) { r.outcome = 'timeout'; r.late = true; }
        } else {
          r = _emitGatewayRecord({
            requestId: opts.requestId || null, at: new Date(t0).toISOString(), source, priority: prio, legacy: !gw.priorities,
            queueWaitMs: 0, runMs: null, latencyMs: Date.now() - t0, outcome, deduped: true,
            late: !!(outcome === 'timeout' && meta && meta.timedOut && !err),
            via: entry.record ? entry.record.via : null, timeoutMs: timeoutMs || (meta && meta.timeoutMs) || null,
            error: err ? String(err.message || err).slice(0, 200) : undefined,
          }, null);
        }
        if (opts.trace && typeof opts.trace.setGateway === 'function') { try { opts.trace.setGateway(r); } catch (_) {} }
      } catch (_) {}
      if (err) reject(err); else resolve(value);
    };
    if (sig) {
      // askWithTimeout aborts its participant signal right after its timer
      // fired: classify that detach as a timeout (meta.timedOut).
      onAbort = () => done((meta && meta.timedOut) ? 'timeout' : 'aborted', null, _abortedErr(), true);
      sig.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs) timer = setTimeout(() => done('timeout', null, _timeoutErr(timeoutMs), true), timeoutMs);
    entry.promise.then(
      (v) => done((meta && meta.timedOut) ? 'timeout' : 'ok', v, null, false),
      (e) => done(_classify(false, e, null, meta, sig).outcome, null, e, false),
    );
  });
}

// ── TIMEOUT HELPERS ───────────────────────────────────────────────────────────
// runWithTimeout(run, { timeoutMs, signal, timeoutMessage, timeoutResult, source, trace })
//   run: (signal, meta) => Promise|value
// Flag off (ai.gateway.abortOnTimeout): exact Promise.race([run(), timer])
// parity — the inner call gets the caller's signal unchanged and is never
// aborted. Flag on: the inner call gets a linked signal that is aborted right
// after the timeout settles the race, so relay releases the slot and cancels
// the transport. Timeout = resolve `timeoutResult` when the key is present,
// else reject Error(timeoutMessage) (code 'AI_TIMEOUT').
function runWithTimeout(run, o) {
  o = o || {};
  const timeoutMs = o.timeoutMs;
  if (!_validTimeout(timeoutMs)) return Promise.reject(new TypeError('askWithTimeout: timeoutMs must be a positive number'));
  const gw = _gw();
  const callerSignal = _isSignal(o.signal) ? o.signal : undefined;
  const message = typeof o.timeoutMessage === 'string' ? o.timeoutMessage : ('AI timeout after ' + Math.round(timeoutMs / 1000) + 's');
  const hasResult = Object.prototype.hasOwnProperty.call(o, 'timeoutResult');
  const source = _normSource(o.source);
  const meta = { timedOut: false, timeoutMs };
  let ac = null;
  let onCaller = null;
  let sig = callerSignal;
  if (gw.abortOnTimeout) {
    ac = new AbortController();
    if (callerSignal) {
      if (callerSignal.aborted) ac.abort();
      else { onCaller = () => ac.abort(); callerSignal.addEventListener('abort', onCaller, { once: true }); }
    }
    sig = ac.signal;
  }
  const t0 = Date.now();
  let timer = null;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (onCaller) { try { callerSignal.removeEventListener('abort', onCaller); } catch (_) {} onCaller = null; }
  };
  let p;
  try { p = Promise.resolve(run(sig, meta)); } catch (e) { p = Promise.reject(e); }
  const timeoutP = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timer = null;
      meta.timedOut = true;
      if (o.trace && typeof o.trace.setGateway === 'function') {
        try { o.trace.setGateway({ source, outcome: 'timeout', timeoutMs, latencyMs: Date.now() - t0 }); } catch (_) {}
      }
      if (hasResult) resolve(o.timeoutResult);
      else reject(Object.assign(new Error(message), { code: 'AI_TIMEOUT' }));
      if (ac) {
        logger.warn('[askWithTimeout] ' + source + ' timed out after ' + timeoutMs + 'ms (aborted)');
        ac.abort();
      }
      cleanup();
    }, timeoutMs);
  });
  p.then(cleanup, cleanup);
  return Promise.race([p, timeoutP]);
}

// askWithTimeout(prompt, { timeoutMs, timeoutMessage, timeoutResult, signal, ...askOpts })
// The timeout options are NEVER forwarded to ask (askWithTimeout alone owns the
// site timeout). module.exports.ask is late-bound so vi.spyOn(relay, 'ask')
// keeps intercepting.
function askWithTimeout(prompt, opts) {
  const o = opts || {};
  const { timeoutMs, timeoutMessage, timeoutResult, signal, ...askOpts } = o; // eslint-disable-line no-unused-vars
  const rwtOpts = { timeoutMs, signal, timeoutMessage, source: askOpts.source, trace: askOpts.trace };
  if (Object.prototype.hasOwnProperty.call(o, 'timeoutResult')) rwtOpts.timeoutResult = timeoutResult;
  return runWithTimeout((sig, meta) => module.exports.ask(prompt, { ...askOpts, signal: sig, __gwMeta: meta }), rwtOpts);
}

// runInSlot(fn, { priority, source, signal }) — run non-relay AI work (vision)
// inside the slot gate. ai.gateway.priorities off: fn() directly (today).
async function runInSlot(fn, o = {}) {
  o = o || {};
  const gw = _gw();
  if (!gw.priorities) return fn();
  const source = _normSource(o.source);
  const prio = _effectivePriority({ priority: o.priority, source }, gw);
  const signal = _isSignal(o.signal) ? o.signal : undefined;
  const t0 = Date.now();
  let label;
  try {
    label = await _acquireSlot(prio, signal, !!(gw.abortOnTimeout && signal));
  } catch (e) {
    _emitGatewayRecord({ source, priority: prio, legacy: false, queueWaitMs: Date.now() - t0, runMs: null, latencyMs: Date.now() - t0,
      outcome: 'aborted', via: 'vision', error: e.message }, null);
    throw e;
  }
  const tG = Date.now();
  let result;
  let err = null;
  try {
    result = await fn();
    return result;
  } catch (e) {
    err = e;
    throw e;
  } finally {
    _releaseSlot(label);
    const now = Date.now();
    _emitGatewayRecord({ source, priority: prio, legacy: false, queueWaitMs: tG - t0, runMs: now - tG, latencyMs: now - t0,
      outcome: (!err && result && result.ok) ? 'ok' : 'error', via: 'vision',
      error: err ? err.message : (result && !result.ok ? result.error : undefined) }, null);
  }
}

// ── WS TRANSPORT ─────────────────────────────────────────────────────────────
function _tryWS(prompt, opts = {}) {
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted before start'));
    const WebSocket = require('ws');
    const crypto    = require('crypto');
    const wsUrl     = getOrchaUrl();
    const sessionId = 'fleet_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const ws = new WebSocket(wsUrl);
    let fullText = '', resolved = false, timer = null;

    const done = (err, txt) => {
      if (resolved) return; resolved = true;
      clearTimeout(timer);
      if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
      try { ws.terminate ? ws.terminate() : ws.close(); } catch (_) {}
      err ? reject(err) : resolve(txt);
    };

    let onAbort = null;
    if (signal) {
      onAbort = () => done(new Error('Aborted by caller'));
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timer = setTimeout(() => done(new Error('WS timeout')), Math.min(TIMEOUT_MS, 60000));
    ws.on('error', err => done(err));
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
      switch (msg.type) {
        case 'connected':
          ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet AI', agent_id: _orchaAgentId, session_id: sessionId }));
          break;
        case 'session_created':
          clearTimeout(timer);
          timer = setTimeout(() => done(new Error('WS response timeout')), TIMEOUT_MS);
          ws.send(JSON.stringify({ type: 'send_message', session_id: msg.session_id || sessionId, message: prompt, images: [] }));
          break;
        case 'text_delta':
        case 'assistant_chunk':
        case 'content_delta':
          fullText += (msg.delta || msg.content || msg.text || ''); break;
        case 'reasoning_delta':
        case 'stream_start':
          break;
        case 'message_complete':
        case 'response_complete':
        case 'stream_end':
          done(null, fullText); break;
        case 'error':
          if (msg.request_type === 'send_message' || msg.request_type === 'create_session')
            done(new Error(msg.error || 'Orcha WS error'));
          break;
      }
    });
  });
}

// -- CLAUDE CODE FALLBACK ------------------------------------------------------
// Fires when Orcha quota is exhausted. Uses claude -p (Claude Code toolbox,
// Cecelia shared Bedrock account) — no extra credentials needed beyond Midway.
const CLAUDE_BIN = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'bin', 'claude.exe')
  : path.join(os.homedir(), '.toolbox', 'bin', 'claude');
let CLAUDE_TIMEOUT_MS = 60000; // mutable — updated by setClaudeTimeout() when Settings change
// Optional model id for the Claude Code lane (passed as `--model`). Empty =
// let claude-code use its own default. Set from Settings (claudeModelId) so the
// user can pin a specific Claude model for the fallback lane + attachment reads.
let CLAUDE_MODEL_ID = '';

// 3-worker pool — lets up to 3 concurrent AI calls run in parallel.
// When DM poll, WR autofill, and long-dwell fill all fire at once, each gets
// its own Claude Code process instead of queuing behind the others.
// Kill-after-job is preserved per worker (prevents context bleed across
// unrelated callers — same correctness guarantee as the old single-worker design).
// POOL SIZE 1 (was 3): diagnostics (FLEET_CLAUDE_DEBUG) proved that 3 parallel
// claude.exe processes RACE on startup to write the same file —
//   "failed to copy production safety rules to
//    ~/.claude/rules/amazon-production-safety-do-not-delete.md: The process
//    cannot access the file because it is being used by another process (os error 32)"
// — and that contention (plus a slow Midway credential probe) pushed first-stdout
// to 35-53s, blowing the 60s timeout intermittently ("works then crashes", and
// deep-scan units silently kept stale timelines when their job was killed).
// Serializing to ONE worker removes the self-inflicted file-lock race; jobs run
// one at a time but actually COMPLETE instead of sabotaging each other. Override
// with env FLEET_CLAUDE_POOL if more concurrency is ever wanted again.
// Pool size is now RUNTIME-ADJUSTABLE from Settings -> AI (setClaudePoolSize),
// persisted as claudePoolSize in orchaConfig, with env FLEET_CLAUDE_POOL as the
// initial default. Default 1 because parallel claude.exe workers race on a
// startup file (os error 32) — see the pool-fix commit. 1-5 allowed.
let WORKER_POOL_SIZE = Math.min(5, Math.max(1, parseInt(process.env.FLEET_CLAUDE_POOL || '1', 10) || 1));
const CLAUDE_IDLE_KILL_MS = 10 * 60 * 1000; // kill warm process after 10min idle
function _makeWorker(id) {
  return { id, proc: null, busy: false, currentJob: null, stdoutBuf: '', idleTimer: null };
}
let _workers = Array.from({ length: WORKER_POOL_SIZE }, (_, i) => _makeWorker(i));
const _claudeQueue = [];

// Resize the Claude worker pool at runtime. Growing adds idle workers (they
// spawn lazily on the next job); shrinking kills + drops the extra workers once
// they're free (a busy one finishes its current job first, then is pruned on
// the next resize/idle). Clamped to 1-5. Safe to call repeatedly.
function setClaudePoolSize(n) {
  const size = Math.min(5, Math.max(1, parseInt(n, 10) || 1));
  if (size === WORKER_POOL_SIZE) return WORKER_POOL_SIZE;
  if (size > WORKER_POOL_SIZE) {
    for (let i = WORKER_POOL_SIZE; i < size; i++) _workers.push(_makeWorker(i));
  } else {
    // Remove workers from the tail; kill any process they hold.
    const removed = _workers.splice(size);
    for (const w of removed) {
      try { if (w.idleTimer) clearTimeout(w.idleTimer); } catch (_) {}
      if (w.proc) { _killClaudeTree(w.proc); w.proc = null; }
    }
  }
  WORKER_POOL_SIZE = size;
  logger.info('Claude worker pool size set to: ' + WORKER_POOL_SIZE);
  return WORKER_POOL_SIZE;
}
function getClaudePoolSize() { return WORKER_POOL_SIZE; }

// Windows-safe process-tree kill. Node's proc.kill() only terminates the
// immediate handle; on Windows the Toolbox claude.exe spawns child workers
// that survive, accumulating as zombies over time. taskkill /F /T kills the
// entire tree. Falls back to proc.kill() on non-Windows.
function _killClaudeTree(proc) { return _killTreeImpl(proc); }
function _killClaudeTreeReal(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      require('child_process').spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { detached: true, stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch (_e) {}
}

function _resetClaudeIdleTimer(worker) {
  if (worker.idleTimer) clearTimeout(worker.idleTimer);
  worker.idleTimer = setTimeout(() => {
    if (worker.proc && !worker.busy) {
      logger.info('claude-code[' + worker.id + ']: killing idle warm process (10min inactive)');
      _killClaudeTree(worker.proc);
      worker.proc = null;
    }
  }, CLAUDE_IDLE_KILL_MS);
}

function _failClaudeQueue(err) {
  // Fail the current job on every busy worker, then drain the shared queue.
  for (const w of _workers) {
    if (w.currentJob) {
      clearTimeout(w.currentJob._timer);
      w.currentJob.reject(err);
      w.currentJob = null;
    }
    w.busy = false;
  }
  while (_claudeQueue.length) {
    const job = _claudeQueue.shift();
    job.reject(err);
  }
}

function _ensureClaudeProcess(worker) {
  if (worker.proc && !worker.proc.killed) return;
  if (!_claudeBinExists()) {
    throw new Error('claude-code not installed — run: toolbox install claude-code');
  }
  logger.info('claude-code[' + worker.id + ']: spawning process' + (CLAUDE_MODEL_ID ? ' (model ' + CLAUDE_MODEL_ID + ')' : ''));
  // --system-prompt: override default coding-assistant persona with a strict
  // headless-API framing so all callers get reliable JSON/plain-text output
  // without explanations or markdown fences (see original rationale above).
  // --model (optional): pin the Claude-lane model when the user chose one in
  // Settings; omitted entirely when blank so claude-code uses its own default.
  const _args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
     '--verbose', '--no-session-persistence'];
  if (CLAUDE_MODEL_ID) _args.push('--model', CLAUDE_MODEL_ID);
  _args.push('--system-prompt',
     'You are a headless automation API, not an interactive coding assistant. ' +
     'Every message you receive contains its own complete formatting instructions ' +
     '(e.g. "respond with only a JSON array"). Follow those instructions exactly and ' +
     'output nothing else -- no explanations, no markdown code fences, no tool calls, ' +
     'no restating the request. If a message asks for JSON, your entire response must ' +
     'be valid JSON and nothing more.');
  const _spawnT0 = Date.now();
  const proc = _spawnImpl(CLAUDE_BIN, _args, { stdio: ['pipe', 'pipe', 'pipe'] });
  worker.stdoutBuf = '';
  worker.stderrBuf = '';              // full stderr for this process (debug dumps)
  worker._firstStdoutAt = 0;         // when the first stdout byte arrived
  _cdbg('worker[' + worker.id + '] spawned pid=' + proc.pid + ' in ' + (Date.now() - _spawnT0) + 'ms'
    + (CLAUDE_MODEL_ID ? ' model=' + CLAUDE_MODEL_ID : ''));

  proc.stdout.on('data', (chunk) => {
    // Stale-process guard (ai.gateway.abortOnTimeout): a killed proc whose tree
    // is still dying (win32 taskkill is detached/no-wait) must never feed the
    // next job on this worker -- not its result line, not partial chunks.
    if (proc !== worker.proc && _gw().abortOnTimeout) return;
    if (!worker._firstStdoutAt) {
      worker._firstStdoutAt = Date.now();
      if (worker.currentJob && worker.currentJob._dispatchedAt) {
        _cdbg('worker[' + worker.id + '] pid=' + proc.pid + ' first stdout after '
          + (worker._firstStdoutAt - worker.currentJob._dispatchedAt) + 'ms');
      }
    }
    worker.stdoutBuf += chunk.toString();
    const lines = worker.stdoutBuf.split('\n');
    worker.stdoutBuf = lines.pop();
    for (const line of lines) {
      if (proc !== worker.proc && _gw().abortOnTimeout) break; // this proc was replaced mid-chunk
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj.type === 'result' && worker.currentJob) {
        const job = worker.currentJob;
        clearTimeout(job._timer);
        if (CLAUDE_DEBUG && job._dispatchedAt) {
          _cdbg('worker[' + worker.id + '] RESULT in ' + (Date.now() - job._dispatchedAt) + 'ms is_error=' + !!obj.is_error + ' len=' + ((obj.result || '').length));
        }
        worker.currentJob = null;
        worker.busy = false;
        if (obj.is_error) {
          job.reject(new Error('claude-code error: ' + (obj.result || 'unknown')));
        } else {
          const text = (obj.result || '').trim();
          if (!text) job.reject(new Error('claude-code returned empty'));
          else job.resolve(text);
        }
        // Kill after every completed job — prevents context bleed across
        // unrelated callers (WR autofill, DM draft, long-dwell summaries all
        // sharing the pool). Next call re-spawns a clean process.
        if (worker.proc) { _killClaudeTree(worker.proc); }
        worker.proc = null;
        _processClaudeQueue();
      }
    }
  });

  proc.stderr.on('data', (d) => {
    if (proc !== worker.proc && _gw().abortOnTimeout) return; // stale-process guard (see stdout)
    const s = d.toString();
    // Keep the full stderr for this process so a timeout dump shows the REAL
    // last words (the truncated warn below often cuts off the actual error).
    if (CLAUDE_DEBUG) { worker.stderrBuf = (worker.stderrBuf + s).slice(-4000); }
    logger.warn('claude-code[' + worker.id + '] stderr: ' + s.slice(0, 300));
  });

  proc.on('exit', (code) => {
    // Guard: if this worker's proc was already replaced (killed after a
    // completed job), its delayed exit event must NOT fail a new job.
    if (proc !== worker.proc) { logger.warn('claude-code[' + worker.id + ']: stale process exited (code ' + code + ') — ignoring'); return; }
    logger.warn('claude-code[' + worker.id + ']: process exited (code ' + code + ')');
    worker.proc = null;
    if (worker.currentJob) {
      const job = worker.currentJob;
      clearTimeout(job._timer);
      worker.currentJob = null;
      worker.busy = false;
      job.reject(new Error('claude-code process exited unexpectedly'));
      _processClaudeQueue();
    }
  });

  proc.on('error', (e) => {
    if (proc !== worker.proc) { logger.warn('claude-code[' + worker.id + ']: stale process error — ignoring'); return; }
    logger.warn('claude-code[' + worker.id + ']: process error: ' + e.message);
    worker.proc = null;
    if (worker.currentJob) {
      const job = worker.currentJob;
      clearTimeout(job._timer);
      worker.currentJob = null;
      worker.busy = false;
      job.reject(new Error('claude-code spawn error: ' + e.message));
      _processClaudeQueue();
    }
  });

  worker.proc = proc;
  _resetClaudeIdleTimer(worker);
}

function _processClaudeQueue() {
  // Drain queue: assign each pending job to the next idle worker.
  // With WORKER_POOL_SIZE=3, up to 3 jobs run concurrently without waiting.
  while (_claudeQueue.length > 0) {
    const worker = _workers.find(w => !w.busy);
    if (!worker) return; // all 3 workers busy — remaining jobs stay queued
    const job = _claudeQueue.shift();
    worker.currentJob = job;
    worker.busy = true;
    job._dispatchedAt = Date.now();
    _cdbg('worker[' + worker.id + '] dispatch job (prompt ' + (job.prompt ? job.prompt.length : 0) + ' chars, timeout ' + Math.round(CLAUDE_TIMEOUT_MS / 1000) + 's)');
    job._timer = setTimeout(() => {
      // Kill-on-timeout: prevents a stale/late response being matched to a
      // later job on the same worker (same correctness guarantee as before).
      logger.warn('claude-code[' + worker.id + ']: job timed out — killing process');
      // DIAGNOSTIC DUMP: classify WHERE it stalled so "works then crashes" has
      // evidence instead of a guess. Did the process ever emit stdout? What was
      // its full stderr? How long did it actually run vs. the timeout?
      if (CLAUDE_DEBUG) {
        const ran = Date.now() - (job._dispatchedAt || Date.now());
        const gotStdout = worker._firstStdoutAt ? ('yes, after ' + (worker._firstStdoutAt - job._dispatchedAt) + 'ms') : 'NO stdout at all';
        const phase = worker._firstStdoutAt ? 'STALLED MID-RESPONSE (started replying then hung)' : 'STALLED BEFORE ANY OUTPUT (spawn/auth/startup hang)';
        _cdbg('TIMEOUT worker[' + worker.id + '] pid=' + (worker.proc ? worker.proc.pid : '?')
          + ' ran=' + ran + 'ms | first stdout: ' + gotStdout + ' | phase: ' + phase);
        _cdbg('TIMEOUT worker[' + worker.id + '] full stderr: ' + (worker.stderrBuf || '(none captured)'));
        _cdbg('TIMEOUT worker[' + worker.id + '] partial stdout buffer: ' + ((worker.stdoutBuf || '').slice(-500) || '(empty)'));
      }
      if (worker.proc) { _killClaudeTree(worker.proc); }
      worker.proc = null;
      worker.currentJob = null;
      worker.busy = false;
      job.reject(new Error('claude-code timeout'));
      _processClaudeQueue();
    }, CLAUDE_TIMEOUT_MS);
    try {
      // Spawn a fresh process for this worker if needed (re-ensure after any
      // prior kill — timeout, abort, or completed-job kill).
      _ensureClaudeProcess(worker);
      const msg = { type: 'user', message: { role: 'user', content: job.prompt } };
      worker.proc.stdin.write(JSON.stringify(msg) + '\n');
    } catch (e) {
      clearTimeout(job._timer);
      worker.currentJob = null;
      worker.busy = false;
      job.reject(new Error('claude-code stdin write failed: ' + e.message));
      _processClaudeQueue();
    }
  }
}

function _abortClaudeJob(job) {
  if (job.done) return;
  const qi = _claudeQueue.indexOf(job);
  if (qi !== -1) {
    // Still waiting its turn — drop from queue, nothing to kill.
    _claudeQueue.splice(qi, 1);
    job.reject(new Error('Aborted by caller'));
    return;
  }
  // Find which worker is running this job and kill its process.
  const worker = _workers.find(w => w.currentJob === job);
  if (worker) {
    logger.warn('claude-code[' + worker.id + ']: active job aborted by caller — killing process');
    clearTimeout(job._timer);
    if (worker.proc) { _killClaudeTree(worker.proc); }
    worker.proc = null;
    worker.currentJob = null;
    worker.busy = false;
    job.reject(new Error('Aborted by caller'));
    _processClaudeQueue();
  }
}

function _tryClaudeCode(prompt, opts = {}) {
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted before start'));
    const CLAUDE_PROMPT_MAX_CHARS = 60000;
    const trimmed = prompt.length > CLAUDE_PROMPT_MAX_CHARS ? prompt.slice(0, CLAUDE_PROMPT_MAX_CHARS) + '...[trimmed]' : prompt;
    const job = { prompt: trimmed, signal, onAbort: null, done: false,
      rank: (opts.prio && _CQ_RANK[opts.prio] != null) ? _CQ_RANK[opts.prio] : null, enqAt: Date.now() };
    job.resolve = (text) => { if (job.done) return; job.done = true; if (signal && job.onAbort) { try { signal.removeEventListener('abort', job.onAbort); } catch (_) {} } resolve(text); };
    job.reject  = (err)  => { if (job.done) return; job.done = true; if (signal && job.onAbort) { try { signal.removeEventListener('abort', job.onAbort); } catch (_) {} } reject(err); };
    if (signal) {
      job.onAbort = () => _abortClaudeJob(job);
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    if (job.rank != null && _gw().priorities) {
      // Priority insertion (ai.gateway.priorities): FIFO within a rank, better
      // ranks ahead of worse ones, but never in front of a job that has already
      // waited CQ_NO_JUMP_MS (floor = right after the LAST such job). Jobs
      // without a rank count as normal.
      const now = job.enqAt;
      let floor = 0;
      for (let i = 0; i < _claudeQueue.length; i++) {
        if (now - _claudeQueue[i].enqAt >= CQ_NO_JUMP_MS) floor = i + 1;
      }
      let at = -1;
      for (let i = floor; i < _claudeQueue.length; i++) {
        const r = _claudeQueue[i].rank != null ? _claudeQueue[i].rank : 2;
        if (r > job.rank) { at = i; break; }
      }
      _claudeQueue.splice(at === -1 ? _claudeQueue.length : at, 0, job);
    } else {
      _claudeQueue.push(job); // legacy / no prio: exactly as before
    }
    _processClaudeQueue();
  });
}

const _CQ_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
const CQ_NO_JUMP_MS = 60000;

function _claudePoolStats() {
  const queuedByPriority = { critical: 0, high: 0, normal: 0, low: 0, none: 0 };
  const names = ['critical', 'high', 'normal', 'low'];
  for (const j of _claudeQueue) {
    if (j.rank != null && names[j.rank]) queuedByPriority[names[j.rank]]++; else queuedByPriority.none++;
  }
  return { size: WORKER_POOL_SIZE, busy: _workers.filter((w) => w.busy).length, queued: _claudeQueue.length, queuedByPriority };
}


// ── HEALTH ───────────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const text = await ask('Reply with exactly one word: CONNECTED', { maxTokens: 20 });
    return { ok: true, status: 'connected', response: text.trim(), lastHealthy: _lastHealthy, lastError: null, requestCount: _requestCount, errorCount: _errorCount, model: MODEL_ID };
  } catch (e) {
    return { ok: false, status: _status, response: null, lastHealthy: _lastHealthy, lastError: e.message, requestCount: _requestCount, errorCount: _errorCount, model: MODEL_ID };
  }
}

function getStatus() {
  // Per-backend availability so the UI can show which AIs are actually
  // connected (Orcha, Claude, or both) rather than just the last one used.
  // A lane counts as "up" when it is not in a failure cooldown AND its
  // transport is actually reachable:
  //   - Orcha: WS endpoint / fleet-brain reachable (or a recent success).
  //   - Claude: the claude-code binary is installed (Bedrock is a further
  //     fallback, but claude-code presence is the primary local signal).
  let orchaReachable = false;
  try {
    orchaReachable = !!(fleetBrain.getStatus && fleetBrain.getStatus().connected);
  } catch (_) {}
  // Treat a very recent Orcha success as reachable too (covers WS/CLI paths
  // where fleet-brain's connected flag lags).
  const recentOrchaOk = _status === 'connected' && _lastHealthy && (Date.now() - _lastHealthy < 5 * 60 * 1000);
  const orchaUp  = _laneHealthy('orcha') && (orchaReachable || recentOrchaOk);
  let claudeInstalled = false;
  try { claudeInstalled = _claudeBinExists(); } catch (_) {}
  const claudeUp = _laneHealthy('claude') && claudeInstalled;

  return {
    status: _status,
    lastHealthy: _lastHealthy,
    lastError: _lastError,
    requestCount: _requestCount,
    errorCount: _errorCount,
    model: MODEL_ID,
    region: REGION,
    preference: _aiPreference,
    backends: { orcha: orchaUp, claude: claudeUp },
  };
}

// ── MWINIT ───────────────────────────────────────────────────────────────────
// FIX (2026-07-21): was hardcoded to `mwinit -o` (forces OTP mode) on both
// platforms -- same bug as src/scrapers/auth.js's runMwinit(), see that
// file's comment for the full root-cause writeup (OTP's short validity
// window made auth spawned by this app meaningfully more prone to a
// used_too_late/freshness rejection than plain `mwinit`'s default
// WebAuthn/Hello flow). No confirmed UI path calls this specific function
// currently, but fixing it anyway rather than leaving the same landmine
// live in a second place.
// FIX (2026-07-21) round 2: was an independent spawn (its own cmd.exe/bash
// terminal), completely separate from src/scrapers/auth.js's runMwinit() and
// its in-flight guard. Even after removing the `-o` flag above, this
// function could still open a SECOND, unguarded mwinit terminal at the same
// moment the app's auto-renewal timer or SSO auth-poller was already running
// one via auth.js's guarded runMwinit() -- confirmed live: two mwinit
// terminal windows opening at once, only one surviving. Two concurrent
// mwinit attempts racing for the same Midway session is a direct cause of
// "AEA verification failed: used_too_late". Delegating to the shared,
// guarded function so every mwinit-launching path in this app -- this one,
// misc.js's Settings button, app.js's auto-renewal timer, and
// window/index.js's auth-poller -- now goes through the exact same lock.
function runMwinit() {
  return require('../scrapers/auth').runMwinit().then(() => {
    _status = 'unknown'; _lastError = null; _saveStatus();
    logger.info('mwinit launched -- client reset for fresh credentials');
    return { ok: true, message: 'mwinit launched -- complete auth in terminal window' };
  }).catch(e => {
    logger.error('mwinit failed:', e.message);
    return { ok: false, error: e.message };
  });
}

function refreshCredentials() {
  _status = 'unknown'; _lastError = null;
  logger.info('Credentials refreshed manually');
  _saveStatus();
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
// With a signal (ai.gateway.abortOnTimeout only) the sleep resolves early on
// abort and never leaves a listener behind. Never rejects.
function _sleep(ms, signal) {
  if (!signal) return new Promise(r => setTimeout(r, ms));
  return new Promise((r) => {
    if (signal.aborted) { r(); return; }
    let t = null;
    const onAbort = () => { clearTimeout(t); r(); };
    t = setTimeout(() => { try { signal.removeEventListener('abort', onAbort); } catch (_) {} r(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function _saveStatus() {
  try {
    fs.mkdirSync(P.logsDir, { recursive: true });
    const tmp = P.orchaRelayStatus + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      status: _status, lastHealthy: _lastHealthy, lastError: _lastError,
      requestCount: _requestCount, errorCount: _errorCount, updatedAt: Date.now(),
    }, null, 2));
    fs.renameSync(tmp, P.orchaRelayStatus);
  } catch (_) {}
}

// ── LOAD SAVED STATUS ────────────────────────────────────────────────────────
(function _loadSavedStatus() {
  try {
    if (fs.existsSync(P.orchaRelayStatus)) {
      const saved = JSON.parse(fs.readFileSync(P.orchaRelayStatus, 'utf8'));
      _lastHealthy  = saved.lastHealthy  || null;
      _lastError    = saved.lastError    || null;
      _status       = saved.status       || 'unknown';
      _requestCount = saved.requestCount || 0;
      _errorCount   = saved.errorCount   || 0;
    }
  } catch (_) {}
})();

// -- AI PREFERENCE -------------------------------------------------------
// Runtime switch — no restart needed. Persisted to orchaConfig on save.
function setClaudeTimeout(ms) {
  const clamped = Math.max(10000, Math.min(300000, Number(ms) || 60000)); // 10s–300s
  CLAUDE_TIMEOUT_MS = clamped;
  logger.info('Claude timeout set to: ' + clamped + 'ms');
}

// -- CLAUDE MODEL (fallback-lane model selection) ------------------------
// Pin the Claude Code lane to a specific model (passed as `--model`). Empty
// means "let claude-code use its default". Runtime switch — persisted to
// orchaConfig as claudeModelId. Also consumed by bedrock.readFileWithVision
// (attachment reading) so the chosen model applies there too.
function setClaudeModel(id) {
  CLAUDE_MODEL_ID = (typeof id === 'string' ? id.trim() : '');
  logger.info('Claude model set to: ' + (CLAUDE_MODEL_ID || '(default)'));
}
function getClaudeModel() { return CLAUDE_MODEL_ID; }

// detectClaudeModel() — ask the Claude Code lane which model it's actually
// running on right now. claude's "models" reply is conversational prose, so we
// just extract a recognizable model id / name from it rather than relying on a
// rigid format. Best-effort: returns { ok, model?, raw?, error? }.
function detectClaudeModel() {
  const q = 'In one short line, output ONLY the id of the model you are currently running as, e.g. ' +
    'claude-opus-5-5. No other words.';
  return _tryClaudeCode(q)
    .then(text => {
      const raw = String(text || '').trim();
      // Pull a claude-* / nova-* style id, else the first token.
      const m = raw.match(/\b((?:global\.|us\.)?(?:anthropic\.)?claude-[a-z0-9.\-\[\]]+|[a-z]+-(?:opus|sonnet|haiku|fable|pro|lite|micro)-[0-9.\-]+)\b/i);
      const model = m ? m[1] : (raw.split(/\s+/)[0] || '');
      return { ok: !!model, model, raw: raw.slice(0, 200) };
    })
    .catch(e => ({ ok: false, error: e.message }));
}

function setPreference(pref) {
  const valid = ['auto', 'orcha', 'claude', 'balanced'];
  _aiPreference = valid.includes(pref) ? pref : 'auto';
  logger.info('AI preference set to: ' + _aiPreference);
}
function getPreference() { return _aiPreference; }

// setAgent() -- select which Orcha agent answers WS/headless requests.
// Runtime switch; persisted to orchaConfig as orchaAgentId by ipc/ai.js.
function setAgent(id) {
  const v = (typeof id === 'string') ? id.trim() : '';
  _orchaAgentId = /^[a-z0-9][a-z0-9_-]*$/i.test(v) ? v : 'orcha_default';
  logger.info('Orcha agent set to: ' + _orchaAgentId);
}
function getAgent() { return _orchaAgentId; }

// testClaude() — direct health-check of the Claude Code path
function testClaude() {
  return _tryClaudeCode('Reply with exactly one word: ONLINE')
    .then(text => ({ ok: true, response: text.trim().slice(0, 80) }))
    .catch(e  => ({ ok: false, error: e.message }));
}


// Load saved AI preference from orchaConfig on startup
(function _loadSavedPreference() {
  try {
    if (fs.existsSync(P.orchaConfig)) {
      const cfg = JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      if (cfg && cfg.aiPreference) setPreference(cfg.aiPreference);
      if (cfg && typeof cfg.orchaAgentId === 'string' && cfg.orchaAgentId.trim()) setAgent(cfg.orchaAgentId);
      if (cfg && cfg.claudePoolSize > 0) setClaudePoolSize(cfg.claudePoolSize);
      if (cfg && cfg.claudeTimeoutMs > 0) CLAUDE_TIMEOUT_MS = cfg.claudeTimeoutMs;
      if (cfg && typeof cfg.claudeModelId === 'string') CLAUDE_MODEL_ID = cfg.claudeModelId.trim();
    }
  } catch (_) {}
})();

// ── AGENT DISCOVERY ────────────────────────────────────────────────────────
// The Orcha agent (chosen in Settings → AI → Orcha Agent) determines the
// server-side model that answers every AI request. Rather than hardcode the
// agent list in the Settings UI (which goes stale when the Orcha team adds or
// removes agents), discover it live from the toolbox: `orcha --list-agents`
// prints one agent per line as "Display Name (agent_id)". We parse that into
// [{ id, name }] so the dropdown always reflects exactly what THIS machine can
// actually call. Cached briefly so opening Settings repeatedly is cheap.
const ORCHA_CLI = process.platform === 'win32'
  ? path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'bin', 'orcha.cmd')
  : path.join(os.homedir(), '.toolbox', 'bin', 'orcha');
// Per-agent config files (authoritative model/region per agent) live here.
const ORCHA_AGENTS_DIR = path.join(os.homedir(), '.orcha', 'agents');
let _agentCache = null;
let _agentCacheAt = 0;
const AGENT_CACHE_MS = 5 * 60 * 1000;

function _parseAgentLines(text) {
  const out = [];
  const seen = new Set();
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.trim();
    // Match "Display Name (agent_id)" — id is lowercase/underscore/digits.
    const m = line.match(/^(.*?)\s*\(([a-z0-9][a-z0-9_-]*)\)\s*$/i);
    if (m) {
      const name = m[1].trim();
      const id = m[2].trim();
      if (id && !seen.has(id)) { seen.add(id); out.push({ id, name: name || id }); }
    }
  });
  return out;
}

// Turn a raw Orcha model id into a friendly label. e.g.
// "claude-opus-4-6" -> "Claude Opus 4.6", "claude-sonnet-4-6" -> "Claude Sonnet 4.6".
function _prettyModel(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  const cl = m.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (cl) return 'Claude ' + cl[1][0].toUpperCase() + cl[1].slice(1) + ' ' + cl[2] + '.' + cl[3];
  const nova = m.match(/nova-(pro|lite|micro)/i);
  if (nova) return 'Nova ' + nova[1][0].toUpperCase() + nova[1].slice(1);
  return m; // unknown shape — show the raw id
}

// Read the authoritative model/region for one agent from its config file.
// Returns { model, modelLabel, region } or {} if unreadable.
function _agentModelInfo(id) {
  try {
    const p = path.join(ORCHA_AGENTS_DIR, id + '.json');
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const model = (j && typeof j.model === 'string') ? j.model : '';
    return { model, modelLabel: _prettyModel(model), region: (j && j.region) || '' };
  } catch (_) { return {}; }
}

/**
 * listAgents(opts) -> Promise<{ ok, agents: [{id,name,model,modelLabel,region}], cached?, error? }>
 * Discovers agents via `orcha --list-agents`, then enriches each with the REAL
 * model it maps to by reading ~/.orcha/agents/<id>.json (the authoritative
 * per-agent config). Never throws; on failure returns ok:false + empty list so
 * the caller can fall back to its built-in defaults.
 */
function listAgents(opts = {}) {
  const now = Date.now();
  if (!opts.force && _agentCache && (now - _agentCacheAt < AGENT_CACHE_MS)) {
    return Promise.resolve({ ok: true, agents: _agentCache, cached: true });
  }
  return new Promise((resolve) => {
    if (!fs.existsSync(ORCHA_CLI)) {
      return resolve({ ok: false, agents: [], error: 'orcha CLI not found (toolbox not installed)' });
    }
    execFile(ORCHA_CLI, ['--list-agents'],
      { timeout: 15000, maxBuffer: 256 * 1024, shell: process.platform === 'win32' },
      (err, stdout, stderr) => {
        const agents = _parseAgentLines(stdout);
        if (!agents.length) {
          logger.warn('[relay] listAgents: no agents parsed (' + (err ? err.message : (stderr || 'empty output')) + ')');
          return resolve({ ok: false, agents: [], error: (err && err.message) || 'no agents found' });
        }
        // Enrich with the REAL model each agent maps to (from its config file).
        agents.forEach(a => {
          const info = _agentModelInfo(a.id);
          a.model = info.model || '';
          a.modelLabel = info.modelLabel || '';
          a.region = info.region || '';
        });
        _agentCache = agents;
        _agentCacheAt = Date.now();
        logger.info('[relay] listAgents: discovered ' + agents.length + ' agent(s): ' +
          agents.map(a => a.id + (a.model ? '=' + a.model : '')).join(', '));
        resolve({ ok: true, agents });
      });
  });
}

// ── TEST SEAMS ───────────────────────────────────────────────────────────────
// Transport/process call points route through these impl variables (default =
// the real functions) so tests never touch a real socket or claude.exe.
let _tryWSImpl = _tryWS;
let _spawnImpl = spawn;
let _killTreeImpl = _killClaudeTreeReal;
let _claudeBinExists = () => fs.existsSync(CLAUDE_BIN);

const __test__ = {
  setGatewayFlags(obj) { _gwOverride = obj ? _normGwFlags(obj) : null; },
  setGatewayLoader(fn) { _gwLoader = fn || null; _gwCache = null; _gwCacheAt = 0; },
  setTryWS(fn) { _tryWSImpl = fn || _tryWS; },
  setSpawn(fn) { _spawnImpl = fn || spawn; },
  setKillTree(fn) { _killTreeImpl = fn || _killClaudeTreeReal; },
  setClaudeBinExists(fn) { _claudeBinExists = fn || (() => fs.existsSync(CLAUDE_BIN)); },
  setBedrockEnabled(b) { _bedrockEnabled = !!b; },
  tryClaudeCode: (p, o) => _tryClaudeCode(p, o),
  localAskFn: (p, o) => _localAskFn(p, o),
  askCore: (p, o) => _askCore(p, o),
  sleep: (ms, s) => _sleep(ms, s),
  dispatch: () => _dispatch(),
  claudePoolState() {
    return {
      queue: _claudeQueue.map((j) => ({ prompt: j.prompt, rank: j.rank, enqAt: j.enqAt })),
      workers: _workers.map((w) => ({ id: w.id, busy: w.busy, hasProc: !!w.proc, currentPrompt: w.currentJob ? w.currentJob.prompt : null, stdoutBuf: w.stdoutBuf })),
      stats: _claudePoolStats(),
    };
  },
  inflight: () => _inflight,
  waitQueue: () => _waitQueue.map((e) => ({ prio: e.prio, seq: e.seq, enqAt: e.enqAt, state: e.state })),
  activeBy: () => Object.assign({}, _activeBy),
  underflows: () => _underflows,
  liftTimerArmed: () => !!_liftTimer,
  constants: { MAX_CONCURRENT, AGE_STEP_MS, LOW_RESERVE_LIFT_MS, CQ_NO_JUMP_MS, GW_FLAG_TTL_MS, SOURCE_PRIORITY },
  // Reset gateway state between tests. Callers must have released every slot.
  reset() {
    const leaked = _activeCount;
    _waitQueue.length = 0;
    _inflight.clear();
    if (_liftTimer) { clearTimeout(_liftTimer); _liftTimer = null; }
    _activeCount = 0;
    for (const p of PRIORITIES) _activeBy[p] = 0;
    _claudeQueue.length = 0;
    for (const w of _workers) {
      try { if (w.idleTimer) clearTimeout(w.idleTimer); } catch (_) {}
      if (w.currentJob && w.currentJob._timer) clearTimeout(w.currentJob._timer);
      w.proc = null; w.busy = false; w.currentJob = null; w.stdoutBuf = ''; w.idleTimer = null;
    }
    _orchaDownUntil = 0; _claudeDownUntil = 0; _orchaBusy = 0; _claudeBusy = 0;
    return leaked;
  },
};

module.exports = { ask, askWithTimeout, runWithTimeout, runInSlot, queueStats, healthCheck, getStatus, runMwinit, refreshCredentials, setPreference, getPreference, setAgent, getAgent, setClaudePoolSize, getClaudePoolSize, setClaudeTimeout, setClaudeModel, getClaudeModel, detectClaudeModel, testClaude, listAgents, __test__ };
