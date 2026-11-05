'use strict';
/**
 * workers/supervisor.js — Phase 5 worker supervisor (2026-10-30).
 *
 * A CommonJS singleton with NO load-time side effects (no timers, no requires
 * beyond ../config/perf-flags; the logger factory is required inside init()).
 * It owns the scheduling + health shell around existing background loops:
 * heartbeats, strict single in-flight, a per-tick AbortSignal at timeoutMs, a
 * consecutive-failure breaker with backoff + jitter, isolation after
 * maxFailures with one bubble notification, cool-down auto re-enable on the
 * worker's normal grid bounded by maxRestarts, fail-open dependency skips that
 * only READ existing authorities, a non-blocking graceful shutdown on
 * before-quit with a cancelled-quit resume watchdog, and a read-only status API.
 *
 * Ownership: each loop decides exactly once, at its own existing arm site,
 * through claim(spec). claim() is true only when init() ran enabled AND that
 * worker's flag is on; otherwise the legacy timer runs unchanged. With every
 * flag off, init() returns { enabled:false }, claim() is always false and
 * onBeforeQuit()/onWillQuit()/shutdown() are silent no-ops.
 *
 * The supervisor never spawns or kills Orcha and never runs auth recovery.
 * No setInterval, no threads, no child processes; every handle is a
 * setTimeout that is unref()'d.
 *
 * Timers (plan D1, review fix 1 R2): every record has two slots:
 *   slots.next  = { h, at, kind: 'run' | 'cooldown', trigger }
 *   slots.guard = { h, at, kind: 'timeout' | 'hung' }
 * _arm() is the ONLY creator of record timers. It always clears the slot
 * first and arms nothing while shutting down, on an owner-stopped worker
 * (except timeout/hung), for 'run' unless breakerState is 'ok', and for
 * 'cooldown' unless breakerState is 'isolated'. The only other timers are
 * module-level: the shutdown grace delay and the 15 s quit watchdog, each
 * cleared before it is re-armed.
 */

const perfFlags = require('../config/perf-flags');

// ── Constants ────────────────────────────────────────────────────────────────
// Backoff is inert for every Phase 5 worker: all seven Phase 5 specs set
// backoff:false, so a failed tick always keeps the armed gridNext (even one
// that fails late in its interval). Backoff is exercised only by
// synthetic-worker tests and is available to future workers that opt in.
// Copied (not imported) from src/auth/midway-health-supervisor.js _BACKOFF_MS /
// _jitter / _backoffFor, with Math.random made injectable.
const BACKOFF_MS = [30000, 60000, 120000, 300000, 600000, 900000];
const WATCHDOG_MS = 15000;
const DEFAULT_GRACE_MS = 3000;
const DEP_KEYS = ['auth', 'offline', 'cluster.production', 'cluster.livePull', 'ai'];
const AUTH_DOWN = new Set(['OFFLINE', 'WAITING_FOR_USER', 'COOLDOWN', 'RECOVERING', 'FAILED']);
const NAME_RE = /^[a-z][A-Za-z0-9]{1,39}$/;

// ── Module state ─────────────────────────────────────────────────────────────
let _initResult = null;     // memoized init() result
let _initialized = false;   // true only after an ENABLED init()
let _initializedAt = null;
let _flags = null;
let _deps = null;           // { setTimeout, clearTimeout, now, random, notify, logger }
let _records = new Map();   // name → record, in registration order
let _shuttingDown = false;
let _shutdownPromise = null;
let _shutdownResolve = null;
let _drainLogFor = null;    // the shutdown promise the drain log is attached to (fix 7)
let _graceTimer = null;
let _lastGraceMs = DEFAULT_GRACE_MS;
let _watchdog = null;
let _quitProceeding = false;

function _noopLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
function _log(level, msg) { try { _deps.logger[level](msg); } catch (_) {} }
function _now() { return _deps.now(); }

function _jitter(ms) { return Math.round(ms * (0.85 + _deps.random() * 0.3)); } // ±15%
function _backoffFor(streak) {
  const idx = Math.min(Math.max(streak - 1, 0), BACKOFF_MS.length - 1);
  return _jitter(BACKOFF_MS[idx]);
}

function _errMsg(e) {
  try { return String((e && e.message) || e); } catch (_) { return 'unknown error'; }
}

// ── init ─────────────────────────────────────────────────────────────────────
function init(opts = {}) {
  if (_initResult) return _initResult;
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    const flags = o.flags || perfFlags.loadWorkers();
    if (!flags || flags.supervisorEnabled !== true) {
      _initResult = { enabled: false };
      return _initResult;
    }
    const t = o.timers || {};
    let logger = o.logger;
    if (!logger) {
      try { logger = require('../utils/logger')('workers'); } catch (_) { logger = _noopLogger(); }
    }
    _deps = {
      setTimeout: typeof t.setTimeout === 'function' ? t.setTimeout : (fn, ms) => setTimeout(fn, ms),
      clearTimeout: typeof t.clearTimeout === 'function' ? t.clearTimeout : (h) => clearTimeout(h),
      now: typeof o.now === 'function' ? o.now : Date.now,
      random: typeof o.random === 'function' ? o.random : Math.random,
      notify: typeof o.notify === 'function' ? o.notify : null,
      logger,
    };
    const supervised = {};
    const src = flags.supervised && typeof flags.supervised === 'object' ? flags.supervised : {};
    for (const k of Object.keys(src)) supervised[k] = src[k] === true;
    _flags = { supervisorEnabled: true, supervised };
    _initialized = true;
    _initializedAt = _now();
    _initResult = { enabled: true };
  } catch (e) {
    try { (o.logger || require('../utils/logger')('workers')).warn('[workers] init failed, treated as disabled: ' + _errMsg(e)); } catch (_) {}
    _initialized = false;
    _deps = null;
    _initResult = { enabled: false };
  }
  return _initResult;
}

function isEnabled() { return _initialized === true; }

// ── Timer slots (the single choke point, fix 1 R2) ───────────────────────────
function _disarm(rec, slot) {
  const s = rec.slots[slot];
  if (s) { try { _deps.clearTimeout(s.h); } catch (_) {} }
  rec.slots[slot] = null;
}

function _arm(rec, slot, at, kind, trigger) {
  _disarm(rec, slot);
  if (_shuttingDown) return false;
  if (rec.ownerStopped && kind !== 'timeout' && kind !== 'hung') return false;
  if (kind === 'run' && rec.breakerState !== 'ok') return false;
  if (kind === 'cooldown' && rec.breakerState !== 'isolated') return false;
  const runId = rec.inFlight ? rec.inFlight.runId : null;
  const entry = { h: null, at, kind, trigger: trigger || null };
  let fn;
  if (kind === 'run') fn = () => _onNext(rec, entry);
  else if (kind === 'cooldown') fn = () => _onCooldownExpiry(rec);
  else if (kind === 'timeout') fn = () => _onTimeout(rec, runId);
  else fn = () => _onHung(rec, runId);
  const guarded = () => {
    if (rec.slots[slot] !== entry) return;
    rec.slots[slot] = null;
    try { fn(); } catch (e) { _log('warn', '[workers] ' + rec.name + ' ' + kind + ' handler error: ' + _errMsg(e)); }
  };
  entry.h = _deps.setTimeout(guarded, Math.max(0, at - _now()));
  try { if (entry.h && typeof entry.h.unref === 'function') entry.h.unref(); } catch (_) {}
  rec.slots[slot] = entry;
  return true;
}

function _scheduleNext(rec, at, trigger) {
  return _arm(rec, 'next', at, 'run', trigger || 'schedule');
}

// Module-level timer helper (grace delay and quit watchdog only).
function _moduleTimer(fn, ms) {
  const h = _deps.setTimeout(fn, ms);
  try { if (h && typeof h.unref === 'function') h.unref(); } catch (_) {}
  return h;
}

// ── Grid ─────────────────────────────────────────────────────────────────────
// gridNext(t) = smallest anchor + k·intervalMs (k ≥ 1) that is > t.
function _gridNext(rec, t) {
  const iv = rec.spec.intervalMs;
  const k = Math.max(1, Math.floor((t - rec.anchor) / iv) + 1);
  return rec.anchor + k * iv;
}
function _firstAt(rec) {
  return rec.spec.initialDelayMs != null ? rec.anchor + rec.spec.initialDelayMs : rec.anchor + rec.spec.intervalMs;
}

// ── Spec validation (§3.1; full pass before any mutation) ────────────────────
function _isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function _isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }

function _validate(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('worker spec must be an object');
  const { name } = spec;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === 'supervisor') throw new TypeError('invalid worker name: ' + String(name));
  const bad = (f) => new TypeError('worker ' + name + ': invalid ' + f);
  if (typeof spec.group !== 'string' || !spec.group.length || spec.group.length > 40) throw bad('group');
  if (typeof spec.tick !== 'function') throw bad('tick');
  if (spec.start != null && typeof spec.start !== 'function') throw bad('start');
  if (spec.stop != null && typeof spec.stop !== 'function') throw bad('stop');
  if (!_isFiniteNum(spec.intervalMs) || spec.intervalMs < 1000) throw bad('intervalMs');
  if (spec.initialDelayMs != null && (!_isFiniteNum(spec.initialDelayMs) || spec.initialDelayMs < 0)) throw bad('initialDelayMs');
  if (!_isInt(spec.timeoutMs, 1000, 86400000)) throw bad('timeoutMs');
  if (spec.maxFailures != null && !_isInt(spec.maxFailures, 1, 50)) throw bad('maxFailures');
  if (spec.cooldownMs != null && (!_isFiniteNum(spec.cooldownMs) || spec.cooldownMs < 60000 || spec.cooldownMs > 86400000)) throw bad('cooldownMs');
  if (spec.maxRestarts != null && !_isInt(spec.maxRestarts, 0, 10)) throw bad('maxRestarts');
  if (spec.backoff != null && typeof spec.backoff !== 'boolean') throw bad('backoff');
  if (spec.dependsOn != null) {
    if (!Array.isArray(spec.dependsOn)) throw bad('dependsOn');
    for (const k of spec.dependsOn) if (!DEP_KEYS.includes(k)) throw bad('dependsOn key ' + String(k));
  }
  if (typeof spec.idempotent !== 'boolean') throw bad('idempotent');
  if (spec.isSkip != null && typeof spec.isSkip !== 'function') throw bad('isSkip');
  if (spec.label != null && typeof spec.label !== 'string') throw bad('label');
  return {
    name,
    group: spec.group,
    label: (spec.label || name).slice(0, 60),
    tick: spec.tick,
    start: spec.start || null,
    stop: spec.stop || null,
    intervalMs: spec.intervalMs,
    initialDelayMs: spec.initialDelayMs != null ? spec.initialDelayMs : null,
    timeoutMs: spec.timeoutMs,
    maxFailures: spec.maxFailures != null ? spec.maxFailures : 3,
    cooldownMs: spec.cooldownMs != null ? spec.cooldownMs : 30 * 60 * 1000,
    maxRestarts: spec.maxRestarts != null ? spec.maxRestarts : 3,
    backoff: spec.backoff != null ? spec.backoff : true,
    dependsOn: spec.dependsOn ? spec.dependsOn.slice() : [],
    idempotent: spec.idempotent,
    isSkip: spec.isSkip || null,
  };
}

function _effMaxRestarts(spec) { return spec.idempotent === false ? 0 : spec.maxRestarts; }

function _newRecord(spec) {
  return {
    name: spec.name,
    spec,
    effMaxRestarts: _effMaxRestarts(spec),
    anchor: 0,
    slots: { next: null, guard: null },
    // { at, trigger } of the run slot shutdown disarmed (or the first slot a
    // register during shutdown could not arm); consumed by a cancelled-quit
    // resume so the original grid / initialDelayMs is kept.
    resumeSlot: null,
    ownerStopped: false,
    breakerState: 'ok',       // 'ok' | 'isolated' | 'budget-exhausted'
    isolations: 0,
    restarts: 0,
    notified: false,          // "Background worker paused" sent this episode
    disabledNotified: false,  // "Background worker disabled" sent (fix 2)
    isolatedAt: null,
    isolatedUntil: null,
    isolationReason: null,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorActive: false,
    // counts.skip counts self-skips (isSkip(result) true) only; busy and
    // dependency skips never start a tick and are counted in skipReasons.
    counts: { runs: 0, ok: 0, fail: 0, skip: 0, timeout: 0 },
    skipReasons: { busy: 0, self: 0, dependency: {} },
    runId: 0,
    inFlight: null,
    lastHeartbeatAt: null,
    lastStartAt: null,
    lastEndAt: null,
    lastDurationMs: null,
    waitingOn: null,
    depDown: {},
  };
}

// ── register / claim / stop / reEnable ───────────────────────────────────────
function _activeError(name) {
  return Object.assign(new Error('worker already active: ' + name), { code: 'WORKER_ACTIVE' });
}

function register(spec) {
  if (!_initialized) throw Object.assign(new Error('worker supervisor not initialized'), { code: 'NOT_INITIALIZED' });
  const s = _validate(spec);
  const existing = _records.get(s.name);
  if (existing && !existing.ownerStopped) throw _activeError(s.name);

  if (!existing) {
    const rec = _newRecord(s);
    _records.set(s.name, rec);
    if (s.start) {
      try { s.start(); } catch (e) { _records.delete(s.name); throw e; }
    }
    rec.anchor = _now();
    _scheduleNext(rec, _firstAt(rec), 'schedule'); // no-op while shutting down (fix 1 R1)
    if (_shuttingDown) rec.resumeSlot = { at: _firstAt(rec), trigger: 'schedule' };
    return true;
  }

  // Resume of an owner-stopped record: replace the spec, keep counters,
  // breaker state and any in-flight tick.
  const rec = existing;
  rec.spec = s;
  rec.effMaxRestarts = _effMaxRestarts(s);
  rec.ownerStopped = false;
  if (s.start) {
    try { s.start(); } catch (e) { rec.ownerStopped = true; throw e; }
  }
  if (rec.breakerState === 'isolated') {
    if (rec.isolatedUntil != null && rec.isolatedUntil > _now()) _arm(rec, 'next', rec.isolatedUntil, 'cooldown');
    else if (!_shuttingDown) _onCooldownExpiry(rec);
  } else if (rec.breakerState === 'ok') {
    rec.anchor = _now();
    _scheduleNext(rec, _firstAt(rec), 'schedule');
    if (_shuttingDown) rec.resumeSlot = { at: _firstAt(rec), trigger: 'schedule' };
  }
  // budget-exhausted: stays disabled until reEnable() or an app restart.
  return true;
}

function claim(spec) {
  if (!_initialized) return false;
  const name = spec && typeof spec === 'object' ? spec.name : undefined;
  if (!_flags || _flags.supervised[name] !== true) return false;
  // No shutdown short-circuit (fix 1 R1): register creates/replaces the
  // record during shutdown and _arm arms nothing; a cancelled-quit resume
  // then schedules it like any other record.
  try {
    register(spec);
    return true;
  } catch (err) {
    if (err && err.code === 'WORKER_ACTIVE') return true; // already owned (fix 8)
    _log('warn', '[workers] ' + String(name) + ' claim failed, legacy timer keeps ownership: ' + _errMsg(err));
    return false;
  }
}

function stop(name) {
  if (!_initialized) return;
  const rec = _records.get(name);
  if (!rec) return;
  _disarm(rec, 'next'); // includes a pending cool-down; isolatedUntil keeps the remainder
  if (rec.spec.stop) {
    try { rec.spec.stop(); } catch (e) { _log('warn', '[workers] ' + name + ' stop hook failed: ' + _errMsg(e)); }
  }
  rec.ownerStopped = true;
  // An in-flight tick is NOT aborted (legacy clearInterval never cancelled a
  // running cycle); its timeout/hung guard stays armed.
}

function _clearIsolation(rec) {
  rec.breakerState = 'ok';
  rec.isolatedAt = null;
  rec.isolatedUntil = null;
  rec.isolationReason = null;
}

function reEnable(name, { runNow = false } = {}) {
  if (!_initialized || _shuttingDown) return false;
  const rec = _records.get(name);
  if (!rec || rec.ownerStopped) return false;
  if (rec.breakerState !== 'isolated' && rec.breakerState !== 'budget-exhausted') return false;
  rec.consecutiveFailures = 0;
  rec.restarts = 0;
  rec.notified = false;
  rec.disabledNotified = false;
  _clearIsolation(rec);
  if (runNow) _scheduleNext(rec, _now(), 'manual');
  else _scheduleNext(rec, _gridNext(rec, _now()), 'schedule');
  return true;
}

// ── Dependency checks (§6: read-only, fail-open) ─────────────────────────────
function _depDown(key) {
  try {
    if (key === 'offline') return require('../orcha/offline').isOffline() === true;
    if (key === 'auth') return AUTH_DOWN.has(require('../auth/midway-health-supervisor').getState());
    if (key === 'cluster.production') return require('../cluster').mayRunProduction() === false;
    if (key === 'cluster.livePull') return require('../cluster').mayLivePull() === false;
    if (key === 'ai') {
      const p = require.resolve('../orcha/relay');
      if (!require.cache[p]) return false; // not loaded = up; never loads relay
      const st = require.cache[p].exports.getStatus();
      const b = st && st.backends;
      return !!b && b.orcha === false && b.claude === false;
    }
  } catch (_) { return false; }
  return false;
}

function _checkDeps(rec) {
  const down = [];
  for (const key of rec.spec.dependsOn) {
    const isDown = _depDown(key);
    if (isDown !== !!rec.depDown[key]) {
      rec.depDown[key] = isDown;
      _log('info', '[workers] ' + rec.name + ' dependency ' + key + ' ' + (isDown ? 'down — skipping runs' : 'up again'));
    }
    if (isDown) down.push(key);
  }
  return down;
}

// ── Scheduled run (§5.1 order of checks) ─────────────────────────────────────
function _onNext(rec, firedEntry) {
  if (_shuttingDown || rec.ownerStopped || rec.breakerState !== 'ok') return;
  const trigger = (firedEntry && firedEntry.trigger) || 'schedule';
  if (rec.inFlight) {
    rec.skipReasons.busy++;
    _scheduleNext(rec, _gridNext(rec, _now()), 'schedule');
    return;
  }
  const down = _checkDeps(rec);
  if (down.length) {
    for (const k of down) rec.skipReasons.dependency[k] = (rec.skipReasons.dependency[k] || 0) + 1;
    rec.waitingOn = down;
    _scheduleNext(rec, _gridNext(rec, _now()), trigger === 'restart' ? 'restart' : 'schedule');
    return;
  }
  _startTick(rec, trigger);
}

// ── Tick execution (§5.2) ────────────────────────────────────────────────────
function _startTick(rec, trigger) {
  rec.runId++;
  const runId = rec.runId;
  const controller = new AbortController();
  const startedAt = _now();
  const inf = { runId, startedAt, trigger, controller, timedOut: false, promise: null };
  rec.inFlight = inf;
  rec.lastHeartbeatAt = rec.lastStartAt = startedAt;
  rec.counts.runs++;
  rec.waitingOn = null;
  _scheduleNext(rec, _gridNext(rec, startedAt), 'schedule');
  _arm(rec, 'guard', startedAt + rec.spec.timeoutMs, 'timeout');
  let p;
  try { p = Promise.resolve(rec.spec.tick({ signal: controller.signal, runId, trigger })); } catch (e) { p = Promise.reject(e); }
  inf.promise = p.then(
    (r) => { try { _settle(rec, runId, true, r); } catch (_) {} },
    (e) => { try { _settle(rec, runId, false, e); } catch (_) {} },
  );
}

function _settle(rec, runId, ok, val) {
  const inf = rec.inFlight;
  if (!inf || inf.runId !== runId) return;
  const t = _now();
  rec.inFlight = null;
  rec.lastEndAt = rec.lastHeartbeatAt = t;
  rec.lastDurationMs = t - inf.startedAt;
  _disarm(rec, 'guard');

  if (inf.timedOut) {
    // Late settle: counts / streak / lastError unchanged (the timeout counted).
    _log('info', '[workers] ' + rec.name + ' late completion after timeout (' + (ok ? 'ok' : 'fail') + ')');
    if (!rec.slots.next && rec.breakerState === 'ok') _scheduleNext(rec, _gridNext(rec, t), 'schedule');
    return;
  }

  let selfSkip = false;
  if (ok) {
    try { selfSkip = !!(rec.spec.isSkip && rec.spec.isSkip(val)); } catch (_) { selfSkip = false; }
  }

  if (_shuttingDown) {
    // Fix 1 R3: record the outcome only — no breaker, isolation, notify or arm.
    if (ok) { if (selfSkip) { rec.counts.skip++; rec.skipReasons.self++; } else rec.counts.ok++; }
    else { rec.counts.fail++; rec.lastError = { message: _errMsg(val).slice(0, 200), at: t, kind: 'throw' }; }
    return;
  }

  if (ok) {
    if (selfSkip) { rec.counts.skip++; rec.skipReasons.self++; } else rec.counts.ok++;
    rec.consecutiveFailures = 0;
    rec.lastErrorActive = false;
    // Fix 2: an on-time success after a restart is a full recovery, so the
    // next isolation episode deserves a fresh "paused" notice.
    if (!selfSkip && rec.breakerState === 'ok' && rec.restarts > 0) rec.notified = false;
    return; // the armed next (already gridNext) is kept
  }

  rec.consecutiveFailures++;
  rec.counts.fail++;
  const msg = _errMsg(val).slice(0, 200);
  rec.lastError = { message: msg, at: t, kind: 'throw' };
  rec.lastErrorActive = true;
  _log('warn', '[workers] ' + rec.name + ' tick failed (' + rec.consecutiveFailures + '/' + rec.spec.maxFailures + '): ' + msg);
  _breaker(rec, t);
}

function _onTimeout(rec, runId) {
  const inf = rec.inFlight;
  if (!inf || inf.runId !== runId || inf.timedOut) return;
  const t = _now();
  const ms = rec.spec.timeoutMs;
  if (!inf.controller.signal.aborted) {
    try { inf.controller.abort(new Error('worker tick timeout after ' + ms + 'ms')); } catch (_) {}
  }
  inf.timedOut = true;
  rec.consecutiveFailures++;
  rec.counts.fail++;
  rec.counts.timeout++;
  const msg = 'worker tick timeout after ' + ms + 'ms';
  rec.lastError = { message: msg, at: t, kind: 'timeout' };
  rec.lastErrorActive = true;
  _log('warn', '[workers] ' + rec.name + ' tick timed out (' + rec.consecutiveFailures + '/' + rec.spec.maxFailures + '): ' + msg);
  if (rec.spec.idempotent === false) {
    _isolate(rec, 'timeout-non-idempotent');
    return;
  }
  _arm(rec, 'guard', inf.startedAt + 2 * ms, 'hung');
  _breaker(rec, t);
}

function _onHung(rec, runId) {
  const inf = rec.inFlight;
  if (!inf || inf.runId !== runId) return;
  if (rec.breakerState === 'ok') _isolate(rec, 'hung');
}

// ── Breaker, isolation, cool-down (§5.3) ─────────────────────────────────────
// Bound: between reEnable() calls (the whole process in Phase 5, where
// reEnable has no caller): at most (effMaxRestarts + 1) × maxFailures failing
// ticks and effMaxRestarts + 1 isolations per worker; at most isolations + 1
// notifications.
function _breaker(rec, t) {
  if (_shuttingDown || rec.breakerState !== 'ok') return;
  if (rec.consecutiveFailures >= rec.spec.maxFailures) { _isolate(rec, 'max-failures'); return; }
  if (rec.spec.backoff) {
    const at = Math.max(_gridNext(rec, t), t + _backoffFor(rec.consecutiveFailures));
    _scheduleNext(rec, at, 'schedule');
  }
  // backoff:false keeps the armed gridNext (exact-minute loops).
}

function _notify(payload) {
  if (!_deps.notify) return;
  try { _deps.notify(payload); } catch (e) { _log('debug', '[workers] notify failed: ' + _errMsg(e)); }
}

function _isolate(rec, reason) {
  if (_shuttingDown) return; // fix 1 R3 (belt and braces)
  if (rec.breakerState !== 'ok') return; // one isolation per episode
  const t = _now();
  rec.breakerState = 'isolated';
  rec.isolations++;
  rec.isolatedAt = t;
  rec.isolationReason = reason;
  rec.isolatedUntil = t + rec.spec.cooldownMs;
  _disarm(rec, 'guard');
  _arm(rec, 'next', rec.isolatedUntil, 'cooldown'); // clears next; arms nothing if owner-stopped
  const min = Math.round(rec.spec.cooldownMs / 60000);
  const restartLeft = rec.restarts < rec.effMaxRestarts;
  const suffix = restartLeft
    ? '— auto re-enable in ' + min + ' min (' + rec.restarts + '/' + rec.effMaxRestarts + ' restarts used between reEnable() calls, the whole process in Phase 5)'
    : '— manual re-enable or app restart required after cool-down';
  _log('warn', '[workers] ' + rec.name + ' ISOLATED after ' + rec.consecutiveFailures + ' consecutive failures (' + reason + ') ' + suffix);
  if (!rec.notified) {
    rec.notified = true;
    const last = rec.lastError ? rec.lastError.message.slice(0, 120) : 'none';
    const message = rec.spec.label + ' stopped after ' + rec.consecutiveFailures + ' failures '
      + (restartLeft ? '— retrying in ' + min + ' min' : '— will stay paused until the app restarts')
      + '. Last error: ' + last;
    _notify({ title: 'Background worker paused', message, body: message, icon: '⚠️', type: 'worker', worker: rec.name });
  }
}

function _onCooldownExpiry(rec) {
  if (_shuttingDown || rec.ownerStopped || rec.breakerState !== 'isolated') return;
  _disarm(rec, 'next');
  if (rec.restarts >= rec.effMaxRestarts) {
    rec.breakerState = 'budget-exhausted';
    _log('error', '[workers] ' + rec.name + ' DISABLED — restart budget exhausted; manual re-enable or app restart required');
    if (!rec.disabledNotified) {
      rec.disabledNotified = true;
      const last = rec.lastError ? rec.lastError.message.slice(0, 120) : 'none';
      const message = rec.spec.label + ' was disabled after ' + rec.isolations
        + ' failed recoveries. Restart the app to re-enable it. Last error: ' + last;
      _notify({ title: 'Background worker disabled', message, body: message, icon: '⛔', type: 'worker', worker: rec.name });
    }
    return;
  }
  if (rec.inFlight) {
    // A timed-out tick is still unsettled: spend the attempt and re-isolate.
    rec.restarts++;
    _clearIsolation(rec);
    _isolate(rec, 'hung'); // notified is already true → no new notice
    return;
  }
  rec.restarts++;
  rec.consecutiveFailures = 0;
  _clearIsolation(rec);
  _log('info', '[workers] ' + rec.name + ' cool-down over — restarting on its next slot (' + rec.restarts + '/' + rec.effMaxRestarts + ' restarts used)');
  _scheduleNext(rec, _gridNext(rec, _now()), 'restart');
}

// ── Shutdown (§5.5) ──────────────────────────────────────────────────────────
function _pendingNames() {
  const out = [];
  for (const rec of _records.values()) if (rec.inFlight) out.push(rec.name);
  return out;
}

function _finishShutdown(result) {
  if (_graceTimer) { try { _deps.clearTimeout(_graceTimer); } catch (_) {} _graceTimer = null; }
  const r = _shutdownResolve;
  _shutdownResolve = null;
  if (r) r(result);
}

function shutdown({ graceMs = DEFAULT_GRACE_MS } = {}) {
  if (!_initialized) return Promise.resolve({ drained: true, pending: [] });
  if (_shutdownPromise) return _shutdownPromise;
  _shuttingDown = true;
  const promises = [];
  for (const rec of _records.values()) {
    const nx = rec.slots.next;
    rec.resumeSlot = nx && nx.kind === 'run' ? { at: nx.at, trigger: nx.trigger || 'schedule' } : null;
    _disarm(rec, 'next');
    _disarm(rec, 'guard');
    if (rec.spec.stop) { try { rec.spec.stop(); } catch (_) {} }
    if (rec.inFlight) {
      const c = rec.inFlight.controller;
      if (!c.signal.aborted) { try { c.abort(new Error('shutdown')); } catch (_) {} }
      if (rec.inFlight.promise) promises.push(rec.inFlight.promise);
    }
  }
  _shutdownPromise = new Promise((resolve) => { _shutdownResolve = resolve; });
  if (!promises.length) {
    _finishShutdown({ drained: true, pending: [] });
  } else {
    const ms = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : DEFAULT_GRACE_MS;
    _lastGraceMs = ms;
    if (_graceTimer) { try { _deps.clearTimeout(_graceTimer); } catch (_) {} }
    _graceTimer = _moduleTimer(() => {
      _graceTimer = null;
      _finishShutdown({ drained: false, pending: _pendingNames() });
    }, ms);
    Promise.allSettled(promises).then(() => _finishShutdown({ drained: true, pending: [] }));
  }
  return _shutdownPromise;
}

/**
 * onBeforeQuit() — synchronous entry point, the last line of app.js before-quit.
 * Never calls event.preventDefault(), never throws, returns undefined.
 *
 * Quit paths: tray Quit / `app:quit` → `app.exit(0)` (no before-quit);
 * Ctrl+R restart (main-process `before-input-event`, `!input.shift`, 300 ms
 * deferred) → `app.emit('before-quit')` then `app.exit(0)`; `app.quit()`
 * callers → may be cancelled by the hide-to-bubble close handler. For that
 * last case a single unref'd 15 s watchdog resumes the workers when no
 * will-quit follows. A repeated before-quit inside the window keeps ONE
 * watchdog (cleared and re-armed) and the drain log is attached once per
 * shutdown promise (review fix 7).
 */
function onBeforeQuit() {
  if (!_initialized) return undefined;
  try {
    const p = shutdown();
    if (_drainLogFor !== p) {
      _drainLogFor = p;
      p.then((r) => {
        if (!r || r.cancelled) return;
        if (r.drained) _log('info', '[workers] shutdown: drained');
        else _log('warn', '[workers] shutdown: ' + r.pending.join(', ') + ' still running after ' + _lastGraceMs + 'ms');
      }).catch(() => {});
    }
    if (_watchdog) { try { _deps.clearTimeout(_watchdog); } catch (_) {} }
    _watchdog = _moduleTimer(_onWatchdog, WATCHDOG_MS);
  } catch (_) {}
  return undefined;
}

function onWillQuit() {
  if (!_initialized) return undefined;
  _quitProceeding = true;
  if (_watchdog) { try { _deps.clearTimeout(_watchdog); } catch (_) {} _watchdog = null; }
  return undefined;
}

function _onWatchdog() {
  _watchdog = null;
  if (_quitProceeding || !_shuttingDown) return;
  try { _resumeAfterCancelledQuit(); } catch (e) { _log('warn', '[workers] resume after cancelled quit failed: ' + _errMsg(e)); }
}

function _resumeAfterCancelledQuit() {
  _shuttingDown = false;
  const t = _now();
  let n = 0;
  for (const rec of _records.values()) {
    // Fix 1 R4: re-arm timeout / hung detection for EVERY in-flight tick,
    // owner-stopped or not (shutdown cleared the guard slot).
    if (rec.inFlight) {
      const inf = rec.inFlight;
      if (!inf.timedOut) _arm(rec, 'guard', inf.startedAt + rec.spec.timeoutMs, 'timeout');
      else _arm(rec, 'guard', inf.startedAt + 2 * rec.spec.timeoutMs, 'hung');
    }
    const rs = rec.resumeSlot;
    rec.resumeSlot = null;
    if (rec.ownerStopped) continue; // an owner stop during before-quit stays stopped, like legacy
    if (rec.breakerState === 'ok') {
      // Keep the ORIGINAL anchor (review issue 1): re-arm the slot shutdown
      // disarmed (or the firstAt a register during shutdown could not arm, so
      // initialDelayMs is kept). A slot that fell inside the shutdown window
      // fires immediately, exactly once (_arm clamps a past `at` to 0 ms);
      // _startTick then re-arms gridNext from the original anchor, so
      // exact-minute loops do not lose their minute.
      if (rs) _scheduleNext(rec, Math.max(rs.at, t), rs.trigger);
      else _scheduleNext(rec, _gridNext(rec, t), 'schedule');
      n++;
    } else if (rec.breakerState === 'isolated') {
      if (rec.isolatedUntil != null && rec.isolatedUntil > t) _arm(rec, 'next', rec.isolatedUntil, 'cooldown');
      else _onCooldownExpiry(rec); // synchronous (plan D3)
      n++;
    }
  }
  _finishShutdown({ drained: false, pending: _pendingNames(), cancelled: true });
  _shutdownPromise = null;
  _drainLogFor = null;
  _log('info', '[workers] quit was cancelled — resumed ' + n + ' workers');
}

// ── Status (§8) ──────────────────────────────────────────────────────────────
function _displayState(rec) {
  if (_shuttingDown) return { state: 'disabled', disabledReason: 'shutdown' };
  if (rec.ownerStopped) return { state: 'disabled', disabledReason: 'stopped' };
  if (rec.breakerState === 'budget-exhausted') return { state: 'disabled', disabledReason: 'restart-budget-exhausted' };
  if (rec.breakerState === 'isolated') return { state: 'isolated', disabledReason: null };
  if (rec.inFlight && !rec.inFlight.timedOut) return { state: 'busy', disabledReason: null };
  if ((rec.inFlight && rec.inFlight.timedOut) || rec.consecutiveFailures > 0) return { state: 'degraded', disabledReason: null };
  if (rec.waitingOn && rec.waitingOn.length) return { state: 'waiting', disabledReason: null };
  return { state: 'healthy', disabledReason: null };
}

function _processSection() {
  try {
    const p = require.resolve('../telemetry');
    if (!require.cache[p]) return null;
    const t = require.cache[p].exports;
    const s = t && typeof t.latestSample === 'function' ? t.latestSample() : null;
    return s ? {
      rssMb: s.memory ? s.memory.rssMb : null,
      heapUsedMb: s.memory ? s.memory.heapUsedMb : null,
      cpuPct: s.totals ? s.totals.cpuPct : null,
      workingSetMb: s.totals ? s.totals.workingSetMb : null,
      at: s.at,
    } : null;
  } catch (_) { return null; }
}

function _workerStatus(rec) {
  const ds = _displayState(rec);
  const s = rec.spec;
  return {
    name: rec.name,
    group: s.group,
    label: s.label,
    state: ds.state,
    waitingOn: rec.waitingOn && rec.waitingOn.length ? rec.waitingOn.slice() : null,
    disabledReason: ds.disabledReason,
    breakerState: rec.breakerState,
    lastHeartbeatAt: rec.lastHeartbeatAt,
    lastStartAt: rec.lastStartAt,
    lastEndAt: rec.lastEndAt,
    lastDurationMs: rec.lastDurationMs,
    currentJob: rec.inFlight ? { runId: rec.inFlight.runId, startedAt: rec.inFlight.startedAt, trigger: rec.inFlight.trigger, timedOut: rec.inFlight.timedOut } : null,
    counts: Object.assign({}, rec.counts),
    skipReasons: { busy: rec.skipReasons.busy, self: rec.skipReasons.self, dependency: Object.assign({}, rec.skipReasons.dependency) },
    consecutiveFailures: rec.consecutiveFailures,
    lastError: rec.lastError ? Object.assign({}, rec.lastError) : null,
    restarts: rec.restarts,
    // Effective restart budget between reEnable() calls (the whole process in Phase 5).
    maxRestarts: rec.effMaxRestarts,
    isolations: rec.isolations,
    isolationReason: rec.isolationReason,
    isolatedUntil: rec.isolatedUntil,
    notified: rec.notified,
    nextRunAt: rec.slots.next ? rec.slots.next.at : null,
    intervalMs: s.intervalMs,
    timeoutMs: s.timeoutMs,
    maxFailures: s.maxFailures,
    cooldownMs: s.cooldownMs,
    dependsOn: s.dependsOn.slice(),
    idempotent: s.idempotent,
    owner: 'supervisor',
  };
}

function getStatus() {
  if (!_initialized) return { enabled: false, workers: [] };
  try {
    return {
      enabled: true,
      initializedAt: _initializedAt,
      shuttingDown: _shuttingDown,
      at: _now(),
      process: _processSection(),
      workers: Array.from(_records.values()).map(_workerStatus),
    };
  } catch (e) {
    return { enabled: true, error: _errMsg(e), workers: [] };
  }
}

function getSummary() {
  if (!_initialized) return null;
  try {
    const byState = { healthy: 0, busy: 0, waiting: 0, degraded: 0, isolated: 0, disabled: 0 };
    const isolated = [];
    const waiting = [];
    let fails = 0;
    let lastErrorAt = null;
    for (const rec of _records.values()) {
      const { state } = _displayState(rec);
      byState[state]++;
      if (state === 'isolated') isolated.push(rec.name);
      if (state === 'waiting') waiting.push({ name: rec.name, on: rec.waitingOn.slice() });
      fails += rec.counts.fail;
      if (rec.lastError && (lastErrorAt == null || rec.lastError.at > lastErrorAt)) lastErrorAt = rec.lastError.at;
    }
    return { enabled: true, count: _records.size, byState, isolated, waiting, fails, lastErrorAt };
  } catch (_) { return null; }
}

// ── Dependency wake (auth.propagation, additive; inert unless called) ────────
// Reschedules workers that skipped a run because `key` was down so they run
// `delayMs` from now instead of waiting for their own grid. Only workers that
// actually skipped for this key (waitingOn), are idle, have breaker 'ok' and
// are not owner-stopped. _startTick re-arms the normal grid afterwards.
function wakeDependents(key, { delayMs = 2000 } = {}) {
  if (!_initialized || _shuttingDown) return 0;
  let n = 0;
  for (const rec of _records.values()) {
    if (rec.inFlight || rec.ownerStopped || rec.breakerState !== 'ok') continue;
    if (!Array.isArray(rec.spec.dependsOn) || !rec.spec.dependsOn.includes(key)) continue;
    if (!rec.waitingOn || !rec.waitingOn.includes(key)) continue; // only workers that actually skipped for this dependency
    if (_scheduleNext(rec, _now() + delayMs, 'manual')) n++;
  }
  return n;
}

// ── Test hook ────────────────────────────────────────────────────────────────
function _resetForTests() {
  if (_deps) {
    for (const rec of _records.values()) { _disarm(rec, 'next'); _disarm(rec, 'guard'); }
    if (_graceTimer) { try { _deps.clearTimeout(_graceTimer); } catch (_) {} }
    if (_watchdog) { try { _deps.clearTimeout(_watchdog); } catch (_) {} }
  }
  _initResult = null;
  _initialized = false;
  _initializedAt = null;
  _flags = null;
  _deps = null;
  _records = new Map();
  _shuttingDown = false;
  _shutdownPromise = null;
  _shutdownResolve = null;
  _drainLogFor = null;
  _graceTimer = null;
  _watchdog = null;
  _quitProceeding = false;
}

module.exports = {
  init, isEnabled, claim, register, stop, reEnable, getStatus, getSummary,
  shutdown, onBeforeQuit, onWillQuit, _resetForTests,
  wakeDependents,
};
