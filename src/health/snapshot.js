'use strict';
/**
 * health/snapshot.js — read-only Worker Health aggregate (Phase 6, 2026-11-03).
 *
 * buildSnapshot(deps?) -> { ok:true, at, workers, ai, auth, slack, scheduler, resources }
 *
 * Calls ONLY existing getters (supervisor, slack poller, relay.queueStats,
 * ai/status.snapshot, midway-health-supervisor, aea-keepalive-service,
 * scheduler.getState, telemetry.latestSample/snapshot). Rules:
 *   - Never initializes a subsystem. Apart from telemetry, the supervisor and
 *     ai/status (required only once orcha/relay is loaded), a module is read
 *     only when it is already in require.cache; otherwise its section is
 *     { status:'unavailable', reason:'not-loaded' }.
 *   - Each section is isolated: a throwing getter makes only that section
 *     { status:'unavailable', reason }. The builder never throws.
 *   - No timers. scheduler.getState() and ai/status.snapshot() are memoized
 *     for SLOW_TTL_MS and recomputed lazily on the next call after expiry.
 *   - Bounded and secret-free: every string goes through _clip (cap + redact),
 *     lists are capped, and recipients / job history / lastResult / owaTriage /
 *     raw samples / pids / process names are never emitted.
 */
const path = require('path');

const SLOW_TTL_MS = 30000;
const MAX_WORKERS = 50;
const MAX_JOBS = 5;
const MAX_REASONS = 5;
const MAX_TRACKS = 8;
const PRIORITIES = ['critical', 'high', 'normal', 'low'];
const CHANNELS = ['sharepoint', 'email', 'dbrAfp', 'dbrDsp'];
const NOT_LOADED = { status: 'unavailable', reason: 'not-loaded' };

const REDACT_KV = /(token|cookie|authorization|bearer|password|secret|session)\s*[=:]\s*\S+/gi;
const REDACT_RUN = /[A-Za-z0-9+/=_-]{32,}/g;

let _memo = { scheduler: null, ai: null, jobs: null };
let _failures = new Map();   // section -> last failure message

// ── Bounding helpers ─────────────────────────────────────────────────────────
function _clip(s, n) {
  let out = String(s == null ? '' : s)
    .replace(REDACT_KV, (_m, k) => k + '=[redacted]')
    .replace(REDACT_RUN, '[redacted]');
  if (out.length > n) out = out.slice(0, Math.max(0, n - 1)) + '…';
  return out;
}
function _str(v, n) { return v == null ? null : _clip(v, n); }
function _num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function _ts(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return _clip(v, 40);
  return null;
}
// Keeps only finite numbers and booleans (nested up to `depth`, ≤maxKeys per level).
function _nums(obj, depth = 2, maxKeys = 20) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  let n = 0;
  for (const k of Object.keys(obj)) {
    if (n >= maxKeys) break;
    const v = obj[k];
    if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean') { out[_clip(k, 40)] = v; n++; }
    else if (depth > 1 && v && typeof v === 'object' && !Array.isArray(v)) { out[_clip(k, 40)] = _nums(v, depth - 1, maxKeys); n++; }
  }
  return out;
}

// ── Module access ────────────────────────────────────────────────────────────
function _loaded(relPath) {
  try {
    const p = require.resolve(path.join(__dirname, relPath));
    const entry = require.cache[p];
    return entry && entry.loaded !== false ? entry.exports : null;
  } catch (_) { return null; }
}
function _mod(deps, key, relPath) {
  if (deps && Object.prototype.hasOwnProperty.call(deps, key)) return deps[key] || null;
  return _loaded(relPath);
}

function _errMsg(e) { return (e && e.message) || String(e); }

function _section(name, fn, log) {
  try {
    const out = Object.assign({ status: 'ok' }, fn());
    if (_failures.has(name)) {
      _failures.delete(name);
      try { log.info('[health] section ' + name + ' recovered'); } catch (_) {}
    }
    return out;
  } catch (e) {
    const msg = _clip(_errMsg(e), 120);
    try {
      if (_failures.get(name) !== msg) log.warn('[health] section ' + name + ' unavailable: ' + msg);
      else log.debug('[health] section ' + name + ' still unavailable: ' + msg);
    } catch (_) {}
    _failures.set(name, msg);
    return { status: 'unavailable', reason: msg };
  }
}

function _memoized(key, now, fn) {
  const m = _memo[key];
  if (m && now - m.at < SLOW_TTL_MS) return m;
  const value = fn();
  _memo[key] = { at: now, value };
  return _memo[key];
}

// ── Sections ─────────────────────────────────────────────────────────────────
// Phase 8 isolation host rows carry a `host` sub-object; legacy rows have none
// and stay byte-identical.
function _hostSub(h) {
  const le = h.lastExit;
  const mm = h.mainMsAvg || {};
  return {
    pid: _num(h.pid),
    hostState: _str(h.hostState, 40),
    rssMb: _num(h.rssMb),
    rssCapMb: _num(h.rssCapMb),
    spawns: _num(h.spawns),
    crashes: _num(h.crashes),
    lastExit: le && typeof le === 'object' ? { code: _num(le.code), reason: _str(le.reason, 40), at: _ts(le.at) } : null,
    fallbacks: _nums(h.fallbacks, 1) || {},
    staleDiscards: _num(h.staleDiscards),
    mainMsAvg: { dispatch: _num(mm.dispatch), commit: _num(mm.commit) },
    workerMsAvg: _num(h.workerMsAvg),
  };
}

function _worker(w) {
  w = w || {};
  const out = _workerBase(w);
  if (w.host && typeof w.host === 'object') out.host = _hostSub(w.host);
  return out;
}

function _workerBase(w) {
  const counts = w.counts || {};
  const sk = w.skipReasons || {};
  const cj = w.currentJob;
  const le = w.lastError;
  return {
    name: _str(w.name, 60),
    group: _str(w.group, 60),
    label: _str(w.label, 60),
    state: _str(w.state, 40),
    waitingOn: Array.isArray(w.waitingOn) ? w.waitingOn.slice(0, 10).map((x) => _clip(x, 60)) : null,
    disabledReason: _str(w.disabledReason, 60),
    breakerState: _str(w.breakerState, 40),
    lastHeartbeatAt: _ts(w.lastHeartbeatAt),
    lastStartAt: _ts(w.lastStartAt),
    lastEndAt: _ts(w.lastEndAt),
    lastDurationMs: _num(w.lastDurationMs),
    currentJob: cj ? { runId: _str(cj.runId, 60), startedAt: _ts(cj.startedAt), trigger: _str(cj.trigger, 40), timedOut: !!cj.timedOut } : null,
    counts: { runs: _num(counts.runs), ok: _num(counts.ok), fail: _num(counts.fail), skip: _num(counts.skip), timeout: _num(counts.timeout) },
    skipReasons: { busy: _num(sk.busy), self: _num(sk.self), dependency: _nums(sk.dependency, 1) || {} },
    consecutiveFailures: _num(w.consecutiveFailures),
    lastError: le ? { message: _clip(le.message, 200), at: _ts(le.at), kind: _str(le.kind, 40) } : null,
    restarts: _num(w.restarts),
    maxRestarts: _num(w.maxRestarts),
    isolations: _num(w.isolations),
    isolationReason: _str(w.isolationReason, 120),
    isolatedUntil: _ts(w.isolatedUntil),
    notified: !!w.notified,
    nextRunAt: _ts(w.nextRunAt),
    intervalMs: _num(w.intervalMs),
    timeoutMs: _num(w.timeoutMs),
    maxFailures: _num(w.maxFailures),
    cooldownMs: _num(w.cooldownMs),
    dependsOn: Array.isArray(w.dependsOn) ? w.dependsOn.slice(0, 10).map((x) => _clip(x, 60)) : [],
    idempotent: !!w.idempotent,
    owner: _str(w.owner, 40),
  };
}

function _workersSection(deps) {
  const sup = deps.supervisor || require('../workers/supervisor');
  const st = sup.getStatus();
  if (!st || !st.enabled) return { enabled: false, shuttingDown: false, summary: null, list: [] };
  if (st.error) throw new Error(st.error);
  const sum = typeof sup.getSummary === 'function' ? sup.getSummary() : null;
  const list = Array.isArray(st.workers) ? st.workers : [];
  return {
    enabled: true,
    shuttingDown: !!st.shuttingDown,
    summary: sum ? { count: _num(sum.count), byState: _nums(sum.byState, 1) || {}, fails: _num(sum.fails), lastErrorAt: _ts(sum.lastErrorAt) } : null,
    total: list.length,
    list: list.slice(0, MAX_WORKERS).map(_worker),
  };
}

function _aiSection(deps, now) {
  const relay = _mod(deps, 'relay', '../orcha/relay');
  if (!relay) return NOT_LOADED;
  const aiStatus = deps.aiStatus || require('../ai/status');
  const memo = _memoized('ai', now, () => aiStatus.snapshot({ metricsLimit: 200 }));
  const s = memo.value || {};
  const q = relay.queueStats() || {};
  const lanes = s.lanes || {};
  const laneStr = (l) => _str(l && l.status, 20) || 'unknown';
  const bp = q.byPriority || {};
  const byPriority = {};
  for (const p of PRIORITIES) byPriority[p] = { active: _num(bp[p] && bp[p].active), waiting: _num(bp[p] && bp[p].waiting) };
  let latency = null;
  if (s.gateway && typeof s.gateway === 'object') {
    const gbp = s.gateway.byPriority || {};
    const lbp = {};
    for (const k of Object.keys(gbp).slice(0, 8)) {
      const v = gbp[k] || {};
      lbp[_clip(k, 20)] = {
        count: _num(v.count), p50LatencyMs: _num(v.p50LatencyMs), p95LatencyMs: _num(v.p95LatencyMs),
        p95QueueWaitMs: _num(v.p95QueueWaitMs), timeout: _num(v.timeout), error: _num(v.error),
      };
    }
    latency = { sampleSize: _num(s.gateway.sampleSize), byPriority: lbp };
  }
  const overall = s.overall || {};
  return {
    at: memo.at,
    overall: {
      status: _str(overall.status, 20) || 'unknown',
      reasons: Array.isArray(overall.reasons) ? overall.reasons.slice(0, MAX_REASONS).map((r) => _clip(r, 120)) : [],
    },
    lanes: { fleetBrain: laneStr(lanes.fleetBrain), orcha: laneStr(lanes.orcha), claude: laneStr(lanes.claude), bedrock: laneStr(lanes.bedrock) },
    queue: {
      active: _num(q.active), waiting: _num(q.waiting), max: _num(q.max), reserve: _num(q.reserve),
      oldestWaitMs: _num(q.oldestWaitMs), byPriority,
    },
    latency,
    claudePool: _nums(q.claudePool),
    flags: _nums(q.flags, 1),
  };
}

function _authSection(deps) {
  const mw = _mod(deps, 'midway', '../auth/midway-health-supervisor');
  if (!mw) return NOT_LOADED;
  const state = _str(mw.getState(), 40) || 'UNKNOWN';
  const snap = typeof mw.getSnapshot === 'function' ? mw.getSnapshot() : null;
  const aea = _mod(deps, 'aeaKeepalive', '../auth/aea-keepalive-service');
  let keepAlive = null;
  if (aea && typeof aea.getState === 'function') {
    const k = aea.getState() || {};
    const last = k.last || null;
    keepAlive = {
      running: !!k.running,
      state: _str(k.state, 40),
      consecutiveFailures: _num(k.consecutiveFailures),
      lastOk: last ? !!last.ok : null,
      lastAt: last ? _ts(last.at) : null,
      lastReason: last ? _str(last.reason, 120) : null,
    };
  }
  const out = {
    state,
    at: snap ? _ts(snap.at) : null,
    online: snap && snap.internet ? (typeof snap.internet.online === 'boolean' ? snap.internet.online : null) : null,
    sessionExpiresInMin: snap && snap.diskSession ? _num(snap.diskSession.expiresInMin) : null,
    aeaExpiresInMin: snap && snap.diskAea ? _num(snap.diskAea.expiresInMin) : null,
    keepAlive,
  };
  // auth.propagation (default OFF, F11): add the live status fields. Flag off
  // the section is byte-equal to the legacy output.
  let propOn = false;
  // Read-only like the other sections: never loads auth-report (the supervisor
  // loads it on its first flag read).
  try { const ar = _mod(deps, 'authReport', '../auth/auth-report'); propOn = !!ar && ar.isEnabled() === true; } catch (_) { propOn = false; }
  if (propOn && typeof mw.getStatus === 'function') {
    const s = mw.getStatus() || {};
    const ev = s.evidence || {};
    out.level = _str(s.level, 20);
    out.action = _str(s.action, 20);
    out.stepUp = !!s.stepUp;
    out.message = _str(s.message, 300);
    out.verifiedAt = _ts(s.verifiedAt);
    out.verifiedBy = _str(s.verifiedBy, 80);
    out.nextRetryAt = _ts(s.nextRetryAt);
    out.liveAea = _num(ev.liveAeaMin);
  }
  return out;
}

function _slackSection(deps) {
  const poller = _mod(deps, 'poller', '../slack/poller');
  if (!poller) return NOT_LOADED;
  const s = poller.getStatus() || {};
  const polls = {};
  const src = s.polls || {};
  for (const kind of Object.keys(src).slice(0, 10)) {
    const p = src[kind] || {};
    polls[_clip(kind, 40)] = {
      inFlight: !!p.inFlight, stalled: !!p.stalled,
      lastEndAt: _ts(p.lastEndAt), lastDurationMs: _num(p.lastDurationMs), nextRunAt: _ts(p.nextRunAt),
      runs: _num(p.runs), fails: _num(p.fails), lastError: _str(p.lastError, 200),
      skipped: _nums(p.skipped, 1) || {},
    };
  }
  const sp = s.speedup || {};
  return {
    mode: _str(s.mode, 20),
    configuredMode: _str(s.configuredMode, 20),
    startedAt: _ts(s.startedAt),
    startError: _str(s.startError, 200),
    polls,
    speedup: s.speedup ? { lane: _nums(sp.lane), dm: _nums(sp.dm), channel: _nums(sp.channel) } : null,
  };
}

function _job(j, withError) {
  if (!j) return null;
  const out = { jobId: _str(j.jobId, 60), slotLabel: _str(j.slotLabel, 40), dateKey: _str(j.dateKey, 20), state: _str(j.state, 40), updatedAt: _ts(j.updatedAt) };
  if (withError) {
    const e = j.lastError;
    out.error = e == null ? null : _clip(typeof e === 'object' ? (e.message || '') : e, 200);
  }
  return out;
}

function _schedulerSection(deps, now) {
  const sch = _mod(deps, 'scheduler', '../scheduler');
  if (!sch) return NOT_LOADED;
  const memo = _memoized('scheduler', now, () => sch.getState());
  const s = memo.value || {};
  const en = s.enabled || {};
  const ns = s.nextSlot || {};
  const slot = (x) => (x ? { label: _str(x.label, 40), when: _str(x.when, 20) } : null);
  const channels = {};
  for (const c of CHANNELS) {
    const ch = s[c];
    if (!ch) { channels[c] = null; continue; }
    const arr = (a) => (Array.isArray(a) ? a : []);
    const blocked = arr(ch.blockedAuth).concat(arr(ch.blockedStale));
    const uncertain = arr(ch.uncertain);
    channels[c] = {
      lastVerified: ch.lastVerified ? { slotLabel: _str(ch.lastVerified.slotLabel, 40), dateKey: _str(ch.lastVerified.dateKey, 20), updatedAt: _ts(ch.lastVerified.updatedAt) } : null,
      lastFailure: ch.lastFailure ? (() => { const f = _job(ch.lastFailure, true); delete f.jobId; return f; })() : null,
      active: arr(ch.active).length,
      retrying: arr(ch.retrying).length,
      blockedCount: blocked.length,
      uncertainCount: uncertain.length,
      blocked: blocked.slice(0, MAX_JOBS).map((j) => _job(j, false)),
      uncertain: uncertain.slice(0, MAX_JOBS).map((j) => _job(j, false)),
    };
  }
  return {
    at: memo.at,
    enabled: { sp: !!en.sp, email: !!en.email, dbr: !!en.dbr },
    nextSlot: { sp: slot(ns.sp), email: slot(ns.email), dbr: slot(ns.dbr) },
    channels,
  };
}

// Phase 7 durable jobs: read-only summary (no SQL when off/degraded).
const JOB_STATES = ['queued', 'claimed', 'running', 'waiting_on_dependency', 'waiting_on_auth', 'waiting_on_approval',
  'verifying', 'completed', 'failed', 'cancelled', 'recovery_required'];
function _jobsSection(deps, now) {
  const jobs = _mod(deps, 'jobs', '../jobs');
  if (!jobs) return NOT_LOADED;
  const memo = _memoized('jobs', now, () => jobs.getSummary(now));
  const s = memo.value || {};
  const types = {};
  const st = s.types || {};
  for (const k of Object.keys(st).slice(0, 10)) {
    const t = st[k] || {};
    types[_clip(k, 40)] = { flag: !!t.flag, effective: !!t.effective, adopted: !!t.adopted, mode: _str(t.mode, 20) };
  }
  const counts = {};
  const sc = s.counts || {};
  for (const k of Object.keys(sc).slice(0, 10)) {
    const c = sc[k] || {};
    const o = {};
    for (const state of JOB_STATES) { const n = _num(c[state]); if (n) o[state] = n; }
    counts[_clip(k, 40)] = o;
  }
  const tot = s.totals || {};
  const or = s.oldestRunning;
  const lr = s.lastRecovery;
  const le = s.lastError;
  return {
    at: memo.at,
    mode: _str(s.mode, 20) || 'off',
    reason: _str(s.reason, 120),
    types,
    counts,
    totals: { open: _num(tot.open) || 0, recoveryRequired: _num(tot.recoveryRequired) || 0, failed24h: _num(tot.failed24h) || 0, foreign: _num(tot.foreign) || 0 },
    oldestRunning: or ? { id: _str(or.id, 60), type: _str(or.type, 40), scopeKey: _str(or.scopeKey, 80), startedAt: _ts(or.startedAt),
      leaseUntil: _ts(or.leaseUntil), attempt: _num(or.attempt), leaseExpired: !!or.leaseExpired } : null,
    recoveryRequiredCount: _num(s.recoveryRequiredCount) || 0,
    recoveryRequired: (Array.isArray(s.recoveryRequired) ? s.recoveryRequired : []).slice(0, MAX_JOBS).map((r) => ({
      id: _str(r && r.id, 60), type: _str(r && r.type, 40), scopeKey: _str(r && r.scopeKey, 80),
      updatedAt: _ts(r && r.updatedAt), lastError: _str(r && r.lastError, 200),
    })),
    lastRecovery: lr ? { at: _ts(lr.at), requeued: _num(lr.requeued), recoveryRequired: _num(lr.recoveryRequired), failed: _num(lr.failed), cancelled: _num(lr.cancelled) } : null,
    lastError: le ? { message: _clip(le.message, 200), at: _ts(le.at) } : null,
  };
}

function _resourcesSection(deps) {
  const tel = deps.telemetry || require('../telemetry');
  const smp = typeof tel.latestSample === 'function' ? tel.latestSample() : null;
  if (!smp) return { status: 'unavailable', reason: 'telemetry not sampling' };
  const procs = Array.isArray(smp.processes) ? smp.processes : [];
  const sum = (list, k) => {
    const v = list.map((p) => p && p[k]).filter((n) => typeof n === 'number' && Number.isFinite(n));
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) * 10) / 10 : null;
  };
  const browser = procs.filter((p) => p && p.type === 'Browser');
  const tabs = procs.filter((p) => p && p.type === 'Tab');
  const el = smp.eventLoop || {};
  const mem = smp.memory || {};
  const tot = smp.totals || {};
  const win = smp.windows || {};
  let topTracks = [];
  try {
    const snap = typeof tel.snapshot === 'function' ? tel.snapshot({ recent: 0 }) : null;
    const tracks = (snap && snap.tracks) || {};
    topTracks = Object.keys(tracks)
      .map((name) => { const t = tracks[name] || {}; return { name: _clip(name, 60), count: _num(t.count), fail: _num(t.fail), p95Ms: _num(t.p95Ms), maxMs: _num(t.maxMs) }; })
      .sort((a, b) => (b.p95Ms || 0) - (a.p95Ms || 0))
      .slice(0, MAX_TRACKS);
  } catch (_) { topTracks = []; }
  return {
    at: _ts(smp.at),
    eventLoop: { p50Ms: _num(el.p50Ms), p99Ms: _num(el.p99Ms), maxMs: _num(el.maxMs) },
    main: { rssMb: _num(mem.rssMb), heapUsedMb: _num(mem.heapUsedMb), cpuPct: sum(browser, 'cpuPct'), workingSetMb: sum(browser, 'workingSetMb') },
    renderer: { count: tabs.length, workingSetMb: sum(tabs, 'workingSetMb'), cpuPct: sum(tabs, 'cpuPct') },
    total: { count: _num(tot.count), workingSetMb: _num(tot.workingSetMb), cpuPct: _num(tot.cpuPct) },
    windows: { total: _num(win.total), visible: _num(win.visible) },
    topTracks,
  };
}

// ── Public ───────────────────────────────────────────────────────────────────
function buildSnapshot(deps) {
  deps = deps || {};
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  let log = deps.logger;
  if (!log) { try { log = require('../utils/logger')('health'); } catch (_) { log = { debug() {}, info() {}, warn() {} }; } }
  return {
    ok: true,
    at: now,
    workers: _section('workers', () => _workersSection(deps), log),
    ai: _section('ai', () => _aiSection(deps, now), log),
    auth: _section('auth', () => _authSection(deps), log),
    slack: _section('slack', () => _slackSection(deps), log),
    scheduler: _section('scheduler', () => _schedulerSection(deps, now), log),
    jobs: _section('jobs', () => _jobsSection(deps, now), log),
    resources: _section('resources', () => _resourcesSection(deps), log),
  };
}

function _resetForTests() {
  _memo = { scheduler: null, ai: null, jobs: null };
  _failures = new Map();
}

module.exports = { buildSnapshot, SLOW_TTL_MS, _clip, _nums, _resetForTests, _worker };
