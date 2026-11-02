'use strict';
/**
 * telemetry/index.js — read-only performance telemetry (Phase 2a).
 *
 *   track(name, fn, opts)  times a sync or async unit of work and records
 *                          ok/fail. Pure pass-through: returns fn's value
 *                          (synchronously for sync fns), re-throws the SAME
 *                          error object, never swallows. Recording is isolated
 *                          in its own try/catch so telemetry cannot change the
 *                          caller. opts.skip(result) → count as "skipped" (a
 *                          no-op run such as a lock-skipped poll) instead of a
 *                          duration sample.
 *   start(deps)            one unref()'d sampler timer (default 30 s, never
 *                          < 5 s): event-loop delay p50/p99/max (reset per
 *                          window), app.getAppMetrics() per Electron process,
 *                          process.memoryUsage(), BrowserWindow counts. The
 *                          15-min JSON rollup (store key telemetryRollup) and
 *                          the dev dump (env FLEET_TELEMETRY_DUMP=1 →
 *                          <logsDir>/telemetry-snapshot.json) run inside that
 *                          same tick — no second timer. Flag
 *                          settings.telemetry.enabled=false → no histogram,
 *                          no timer, track() becomes `return fn()`.
 *   snapshot(opts)         current state + recent durations (IPC
 *                          telemetry:snapshot).
 *
 * Memory is bounded: recent durations ring 500, samples ring 120, per-name
 * aggregates capped at 64 names (overflow folds into `_other`), persisted
 * rollups capped at 96 (24 h).
 */
const fs = require('fs');
const path = require('path');
const { performance, monitorEventLoopDelay } = require('perf_hooks');
const { createRingBuffer } = require('./ring-buffer');
const logger = require('../utils/logger')('telemetry');

const RECENT_CAP = 500;
const SAMPLES_CAP = 120;
const MAX_NAMES = 64;
const OTHER = '_other';
const ROLLUPS_CAP = 96;
const ROLLUP_MS = 15 * 60 * 1000;
const MIN_SAMPLE_MS = 5000;
const DEFAULT_SAMPLE_MS = 30000;
const WARN_EVERY_MS = 10 * 60 * 1000;
const DUMP_FILE = 'telemetry-snapshot.json';

let _enabled = true;
let _recent = createRingBuffer(RECENT_CAP);
let _samples = createRingBuffer(SAMPLES_CAP);
let _agg = new Map();
let _timer = null;
let _eld = null;
let _startedAt = null;
let _lastRollupAt = null;
let _sampleMs = null;
let _flags = null;
let _deps = {};
let _startResult = null;
let _lastWarnAt = 0;
let _seq = 0;        // monotonic sample counter
let _rollupSeq = 0;  // last sample seq included in a rollup

function _round1(n) { return Math.round(n * 10) / 10; }
function _mb(bytes) { return typeof bytes === 'number' ? _round1(bytes / 1048576) : null; }
function _kbToMb(kb) { return typeof kb === 'number' ? _round1(kb / 1024) : null; }
function _nsToMs(ns) { return typeof ns === 'number' && Number.isFinite(ns) ? _round1(ns / 1e6) : null; }

// ── track() ────────────────────────────────────────────────────────────────
function _aggFor(name) {
  let key = String(name);
  if (!_agg.has(key) && _agg.size >= MAX_NAMES) key = OTHER;
  let a = _agg.get(key);
  if (!a) {
    a = { count: 0, ok: 0, fail: 0, skipped: 0, totalMs: 0, maxMs: 0, lastMs: null, lastAt: null, lastError: null,
      win: { count: 0, ok: 0, fail: 0, skipped: 0, totalMs: 0, maxMs: 0 } };
    _agg.set(key, a);
  }
  return a;
}

function _record(name, t0, ok, err, opts, result) {
  try {
    const at = Date.now();
    const a = _aggFor(name);
    if (ok && opts && typeof opts.skip === 'function') {
      let skipped = false;
      try { skipped = !!opts.skip(result); } catch (_) { skipped = false; }
      if (skipped) { a.skipped++; a.win.skipped++; a.lastAt = at; return; }
    }
    const ms = Math.max(0, _round1(performance.now() - t0));
    _recent.push({ name: String(name), ms, ok, at });
    a.count++; a.win.count++;
    if (ok) { a.ok++; a.win.ok++; } else {
      a.fail++; a.win.fail++;
      const msg = err && err.message != null ? String(err.message) : String(err);
      a.lastError = msg.slice(0, 120);
    }
    a.totalMs += ms; a.win.totalMs += ms;
    if (ms > a.maxMs) a.maxMs = ms;
    if (ms > a.win.maxMs) a.win.maxMs = ms;
    a.lastMs = ms;
    a.lastAt = at;
  } catch (_) { /* telemetry must never affect the caller */ }
}

function track(name, fn, opts) {
  if (!_enabled || typeof fn !== 'function') return fn();
  const t0 = performance.now();
  let r;
  try {
    r = fn();
  } catch (e) {
    _record(name, t0, false, e, opts);
    throw e;
  }
  if (r && typeof r.then === 'function') {
    return r.then(
      (v) => { _record(name, t0, true, null, opts, v); return v; },
      (e) => { _record(name, t0, false, e, opts); throw e; },
    );
  }
  _record(name, t0, true, null, opts, r);
  return r;
}

// ── Sampler ────────────────────────────────────────────────────────────────
function _electron() {
  if (_deps.electron) return _deps.electron;
  try { return require('electron'); } catch (_) { return null; }
}

function _sampleNow() {
  const sample = { seq: ++_seq, at: Date.now(), eventLoop: null, memory: null, processes: null, totals: null, windows: null };
  try {
    if (_eld) {
      sample.eventLoop = {
        p50Ms: _nsToMs(_eld.percentile(50)),
        p99Ms: _nsToMs(_eld.percentile(99)),
        maxMs: _nsToMs(_eld.max),
        meanMs: _nsToMs(_eld.mean),
      };
      _eld.reset();
    }
  } catch (_) { sample.eventLoop = null; }
  try {
    const m = process.memoryUsage();
    sample.memory = { rssMb: _mb(m.rss), heapUsedMb: _mb(m.heapUsed), heapTotalMb: _mb(m.heapTotal), externalMb: _mb(m.external), arrayBuffersMb: _mb(m.arrayBuffers) };
  } catch (_) { sample.memory = null; }
  const electron = _electron();
  try {
    const app = electron && electron.app;
    if (app && typeof app.getAppMetrics === 'function') {
      const procs = (app.getAppMetrics() || []).map((m) => {
        const mem = m.memory || {};
        return {
          type: m.type || null,
          pid: m.pid,
          name: m.name || m.serviceName || null,
          cpuPct: m.cpu && typeof m.cpu.percentCPUUsage === 'number' ? _round1(m.cpu.percentCPUUsage) : null,
          workingSetMb: _kbToMb(mem.workingSetSize),
          privateMb: mem.privateBytes != null ? _kbToMb(mem.privateBytes) : null,
        };
      });
      const sum = (k) => _round1(procs.reduce((s, p) => s + (typeof p[k] === 'number' ? p[k] : 0), 0));
      sample.processes = procs;
      sample.totals = { count: procs.length, workingSetMb: sum('workingSetMb'), privateMb: sum('privateMb'), cpuPct: sum('cpuPct') };
    }
  } catch (_) { sample.processes = null; sample.totals = null; }
  try {
    const BW = electron && electron.BrowserWindow;
    if (BW && typeof BW.getAllWindows === 'function') {
      const wins = (BW.getAllWindows() || []).filter((w) => { try { return !w.isDestroyed(); } catch (_) { return false; } });
      const visible = wins.filter((w) => { try { return w.isVisible(); } catch (_) { return false; } }).length;
      sample.windows = { total: wins.length, visible, hidden: wins.length - visible };
    }
  } catch (_) { sample.windows = null; }
  _samples.push(sample);
  return sample;
}

// ── Rollup (15-min JSON via the store) ─────────────────────────────────────
function _store() { return _deps.store || require('../store'); }

function _rollupNow() {
  const now = Date.now();
  const since = _lastRollupAt || _startedAt || 0;
  // Window by sample sequence, not timestamp, so a sample taken in the same
  // millisecond as the window boundary is counted exactly once.
  const win = _samples.toArray().filter((s) => s.seq > _rollupSeq);
  _rollupSeq = _seq;
  const max = (arr) => { const v = arr.filter((n) => typeof n === 'number'); return v.length ? Math.max(...v) : null; };
  const avg = (arr) => { const v = arr.filter((n) => typeof n === 'number'); return v.length ? _round1(v.reduce((s, n) => s + n, 0) / v.length) : null; };
  const tracks = {};
  for (const [name, a] of _agg) {
    const w = a.win;
    if (w.count || w.skipped) {
      tracks[name] = { count: w.count, ok: w.ok, fail: w.fail, skipped: w.skipped, avgMs: w.count ? _round1(w.totalMs / w.count) : null, maxMs: w.count ? w.maxMs : null };
    }
    a.win = { count: 0, ok: 0, fail: 0, skipped: 0, totalMs: 0, maxMs: 0 };
  }
  const rollup = {
    at: now,
    windowMs: now - since,
    eventLoop: {
      p50MaxMs: max(win.map((s) => s.eventLoop && s.eventLoop.p50Ms)),
      p99MaxMs: max(win.map((s) => s.eventLoop && s.eventLoop.p99Ms)),
      maxMs: max(win.map((s) => s.eventLoop && s.eventLoop.maxMs)),
    },
    memory: {
      rssMaxMb: max(win.map((s) => s.memory && s.memory.rssMb)),
      heapUsedMaxMb: max(win.map((s) => s.memory && s.memory.heapUsedMb)),
    },
    processes: {
      maxCount: max(win.map((s) => s.totals && s.totals.count)),
      workingSetMaxMb: max(win.map((s) => s.totals && s.totals.workingSetMb)),
      privateMaxMb: max(win.map((s) => s.totals && s.totals.privateMb)),
      cpuPctAvg: avg(win.map((s) => s.totals && s.totals.cpuPct)),
    },
    windows: {
      maxTotal: max(win.map((s) => s.windows && s.windows.total)),
      maxVisible: max(win.map((s) => s.windows && s.windows.visible)),
    },
    tracks,
  };
  _lastRollupAt = now;
  const store = _store();
  let doc = store.load('telemetryRollup', { version: 1, rollups: [] });
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.rollups)) doc = { version: 1, rollups: [] };
  doc.version = 1;
  doc.rollups.push(rollup);
  if (doc.rollups.length > ROLLUPS_CAP) doc.rollups = doc.rollups.slice(-ROLLUPS_CAP);
  store.save('telemetryRollup', doc);
  return rollup;
}

// ── Dev dump (env FLEET_TELEMETRY_DUMP=1) ──────────────────────────────────
function _dumpNow() {
  const dir = _deps.logsDir || require('../config/paths').P.logsDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, DUMP_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot(), null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function _tick() {
  try {
    _sampleNow();
    const now = Date.now();
    if (now - (_lastRollupAt || _startedAt || now) >= ROLLUP_MS) _rollupNow();
    const env = _deps.env || process.env;
    if (env.FLEET_TELEMETRY_DUMP === '1') _dumpNow();
  } catch (e) {
    const now = Date.now();
    if (now - _lastWarnAt >= WARN_EVERY_MS) {
      _lastWarnAt = now;
      try { logger.warn('telemetry tick failed (non-fatal): ' + (e && e.message)); } catch (_) {}
    }
  }
}

function start(deps = {}) {
  if (_startResult) return _startResult;
  _deps = deps || {};
  // Flags are resolved once here (restart to change) and echoed in snapshot()
  // so an off/on measurement can confirm which perf flags were active.
  try { _flags = require('../config/perf-flags').load({ load: _deps.loadSettings, env: _deps.env }); } catch (_) { _flags = null; }
  const enabled = typeof _deps.enabled === 'boolean'
    ? _deps.enabled
    : (!_flags || _flags.telemetryEnabled !== false);
  _startedAt = Date.now();
  if (!enabled) {
    _enabled = false;
    try { logger.info('telemetry disabled (settings.telemetry.enabled=false)'); } catch (_) {}
    _startResult = { started: false };
    return _startResult;
  }
  _enabled = true;
  _lastRollupAt = _startedAt;
  _sampleMs = Math.max(MIN_SAMPLE_MS, Number(_deps.sampleMs) || DEFAULT_SAMPLE_MS);
  try {
    _eld = monitorEventLoopDelay({ resolution: 20 });
    _eld.enable();
  } catch (_) { _eld = null; }
  const si = _deps.setInterval || setInterval;
  _timer = si(_tick, _sampleMs);
  if (_timer && typeof _timer.unref === 'function') _timer.unref();
  _startResult = { started: true };
  return _startResult;
}

function stop() {
  if (_timer) {
    const ci = _deps.clearInterval || clearInterval;
    try { ci(_timer); } catch (_) {}
    _timer = null;
  }
  if (_eld) { try { _eld.disable(); } catch (_) {} _eld = null; }
}

// ── Snapshot ───────────────────────────────────────────────────────────────
function _p95(name) {
  const v = _recent.toArray().filter((r) => r.name === name).map((r) => r.ms).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
}

function snapshot(opts = {}) {
  const recentN = opts && opts.recent != null ? opts.recent : 100;
  const tracks = {};
  for (const [name, a] of _agg) {
    tracks[name] = {
      count: a.count, ok: a.ok, fail: a.fail, skipped: a.skipped,
      avgMs: a.count ? _round1(a.totalMs / a.count) : null,
      maxMs: a.count ? a.maxMs : null,
      lastMs: a.lastMs,
      p95Ms: _p95(name),
      lastAt: a.lastAt,
      lastError: a.lastError,
    };
  }
  const samples = _samples.last(20);
  return {
    enabled: _enabled,
    sampling: !!_timer,
    flags: _flags,
    startedAt: _startedAt,
    at: Date.now(),
    sampleMs: _sampleMs,
    latest: samples.length ? samples[samples.length - 1] : null,
    samples,
    sampleCount: _samples.size(),
    tracks,
    recent: _recent.last(recentN),
    lastRollupAt: _lastRollupAt,
    dropped: _recent.dropped(),
    ai: _aiSection(),
  };
}

// AI gateway section (Phase 3): per-priority queue depth + gateway latency
// summary. Never loads relay (and so fleet-brain) as a side effect: only read
// when relay is already in the require cache. Never throws.
function _aiSection() {
  try {
    if (typeof _deps.aiStats === 'function') return _deps.aiStats();
    const relayPath = require.resolve('../orcha/relay');
    if (!require.cache[relayPath]) return null;
    const relay = require.cache[relayPath].exports;
    const trace = require('../ai/trace');
    return {
      queue: typeof relay.queueStats === 'function' ? relay.queueStats() : null,
      gateway: typeof trace.gatewaySummary === 'function' ? trace.gatewaySummary() : null,
    };
  } catch (_) { return null; }
}

// ── Test hooks ─────────────────────────────────────────────────────────────
function _resetForTests() {
  stop();
  _enabled = true;
  _recent = createRingBuffer(RECENT_CAP);
  _samples = createRingBuffer(SAMPLES_CAP);
  _agg = new Map();
  _startedAt = null;
  _lastRollupAt = null;
  _sampleMs = null;
  _flags = null;
  _deps = {};
  _startResult = null;
  _lastWarnAt = 0;
  _seq = 0;
  _rollupSeq = 0;
}
function _setEnabledForTests(v) { _enabled = !!v; }
function _hasHistogramForTests() { return !!_eld; }

module.exports = {
  track, start, stop, snapshot,
  _sampleNow, _rollupNow, _dumpNow, _tick,
  _resetForTests, _setEnabledForTests, _hasHistogramForTests,
  createRingBuffer,
};
