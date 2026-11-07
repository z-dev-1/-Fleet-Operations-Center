'use strict';
/**
 * workers/isolation/host.js — WorkerHost: one worker process per group.
 *
 * createHost(spec, deps) → handle. State machine (design §7):
 *   idle → starting → ready ⇄ busy; crash → backoff → starting;
 *   ≥ maxCrashes in crashWindowMs → isolated (cool-down) → … → disabled;
 *   any → stopping → stopped (shutdown); stopped → idle (resume).
 *
 * Protocol correlation (design §5.1): transport violations kill the worker
 * (reason 'protocol', counted as a crash); late / stale messages for an id that
 * WAS issued but is no longer outstanding, and old pongs, are ignored at DEBUG.
 * request() never rejects. Every timer is unref()'d. Nothing runs at require.
 *
 * deps (all optional, injectable for tests):
 *   spawn(spec) → child, timers{setTimeout,clearTimeout}, now(), random(),
 *   getChildRss(pid), relay{ask}, logger, workerLogger(group), notify(payload),
 *   processKill(pid, sig), onSpawn(pid), onExit(pid), diag, prewarmMs,
 *   electron (forwarded to the default spawner / RSS reader).
 */

const P = require('./protocol');

const LOG_WINDOW_MS = 60000;
const SHUTDOWN_KILL_MS = 1500;
const RESUME_SPAWN_MS = 2000;
const PREWARM_MS = 30000;
const PRIORITY_RANK = { low: 0, normal: 1, high: 2, critical: 3 };
const MB = 1024 * 1024;

function _noopLogger() { return { debug() {}, info() {}, warn() {}, error() {} }; }
function _errMsg(e) { try { return String((e && e.message) || e); } catch (_) { return 'unknown error'; } }

function _codeToKind(reason) {
  switch (reason) {
    case 'rss': return 'rss';
    case 'timeout': return 'timeout';
    case 'hung': return 'hung';
    case 'protocol': return 'protocol';
    case 'start-timeout': return 'start';
    default: return 'crash';
  }
}
function _reasonToCode(reason) {
  switch (reason) {
    case 'rss': return P.CODES.RSS_LIMIT;
    case 'protocol': return P.CODES.PROTOCOL;
    case 'shutdown': return P.CODES.SHUTDOWN;
    default: return P.CODES.CRASHED;
  }
}

function createHost(spec, deps = {}) {
  const d = deps || {};
  const tm = d.timers || {};
  const setT = typeof tm.setTimeout === 'function' ? tm.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clrT = typeof tm.clearTimeout === 'function' ? tm.clearTimeout : (h) => clearTimeout(h);
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const random = typeof d.random === 'function' ? d.random : Math.random;
  const spawnFn = typeof d.spawn === 'function' ? d.spawn : (s) => require('./spawn').defaultSpawner(s, { electron: d.electron });
  const getChildRss = typeof d.getChildRss === 'function' ? d.getChildRss : (pid) => require('./spawn').defaultGetChildRss(pid, { electron: d.electron });
  const processKill = typeof d.processKill === 'function' ? d.processKill : (pid, sig) => process.kill(pid, sig);
  const notifyFn = typeof d.notify === 'function' ? d.notify : null;
  const group = spec.group;
  const tag = '[worker:' + group + ']';

  let _log = d.logger || null;
  function log(level, msg) {
    try {
      if (!_log) { try { _log = require('../../utils/logger')('workers-isolation'); } catch (_) { _log = _noopLogger(); } }
      _log[level](msg);
    } catch (_) { /* never let logging break the host */ }
  }
  let _wlog = null;
  function wlog(level, msg) {
    try {
      if (!_wlog) {
        if (typeof d.workerLogger === 'function') _wlog = d.workerLogger(group);
        else { try { _wlog = require('../../utils/logger')('worker-' + group); } catch (_) { _wlog = _noopLogger(); } }
      }
      _wlog[level](msg);
    } catch (_) { /* ignore */ }
  }

  function timer(fn, ms) {
    const h = setT(() => { try { fn(); } catch (e) { log('warn', '[workers:isolation] ' + group + ' timer error: ' + _errMsg(e)); } }, Math.max(0, ms));
    try { if (h && typeof h.unref === 'function') h.unref(); } catch (_) { /* ignore */ }
    return h;
  }
  function clear(h) { if (h != null) { try { clrT(h); } catch (_) { /* ignore */ } } return null; }

  // ── state ──
  let state = 'idle';
  let disabledReason = null;       // 'spawn-unsupported' | 'restart-budget-exhausted'
  let child = null;
  let childPid = null;
  let childGen = 0;
  let exitObserved = true;
  let helloSeen = false;
  let hello = null;
  let killReason = null;
  let lastIssuedId = 0;
  let inFlight = null;             // { id, op, payload, startedAt, settled, timedOut, resolve, ... }
  let lastSentSeq = 0;
  let lastAckedSeq = 0;
  let missedPings = 0;
  const T = { start: null, ping: null, rss: null, grace: null, backoff: null, cooldown: null, prewarm: null, shutdownKill: null, resume: null };
  let graceReason = null;
  let crashTimes = [];
  let consecutiveCrashes = 0;
  let restarts = 0;
  let isolations = 0;
  let isolationReason = null;
  let isolatedUntil = null;
  let notified = false;
  let disabledNotified = false;
  let nextRestartAt = null;
  let spawns = 0;
  let crashes = 0;
  let lastExit = null;
  let rssBytes = null;
  let lastError = null;
  let lastHeartbeatAt = null;
  let lastStartAt = null;
  let lastEndAt = null;
  let lastDurationMs = null;
  const counts = { runs: 0, ok: 0, fail: 0, skip: 0, timeout: 0 };
  const fallbacks = {};
  let overflowCount = 0;
  let staleDiscards = 0;
  const timing = { dispatchSum: 0, dispatchN: 0, commitSum: 0, commitN: 0, workerSum: 0, workerN: 0 };
  let episodeWarned = new Set();
  let aiWarned = false;
  let aiConcurrent = 0;
  let logWinAt = now();
  let logCount = 0;
  let logDropped = 0;
  let spawnWarned = false;
  let preShutdown = null;          // { state, disabledReason, isolatedUntil } to restore on resume
  let resumePending = false;

  function setState(s) {
    if (s !== 'ready' && s !== 'busy' && s !== state) episodeWarned = new Set();
    state = s;
  }
  function warnOnce(key) {
    if (episodeWarned.has(key)) return false;
    episodeWarned.add(key);
    return true;
  }
  function post(m) {
    if (!child || exitObserved) return false;
    try { child.postMessage(m); return true; } catch (_) { return false; }
  }
  function jitter(ms) { return Math.round(ms * (0.85 + random() * 0.3)); }

  // ── spawn ──
  function _noteSpawned(c, gen) {
    if (gen !== childGen || childPid != null) return;
    const pid = c.pid;
    if (!Number.isInteger(pid)) return;
    childPid = pid;
    log('info', '[workers:isolation] spawned group=' + group + ' pid=' + pid);
    if (typeof d.onSpawn === 'function') { try { d.onSpawn(pid); } catch (_) { /* ignore */ } }
  }

  function _spawn() {
    T.prewarm = clear(T.prewarm);
    T.backoff = clear(T.backoff);
    T.resume = clear(T.resume);
    nextRestartAt = null;
    if (state !== 'idle' && state !== 'backoff') return;
    if (child && !exitObserved) return;
    let c;
    try {
      c = spawnFn(spec);
      if (!c || typeof c.postMessage !== 'function' || typeof c.on !== 'function') throw new Error('spawner returned no child');
    } catch (e) {
      setState('disabled');
      disabledReason = 'spawn-unsupported';
      if (!spawnWarned) { spawnWarned = true; log('warn', '[workers:isolation] spawn failed group=' + group + ' (running in-process): ' + _errMsg(e)); }
      return;
    }
    const gen = ++childGen;
    child = c;
    childPid = null;
    exitObserved = false;
    helloSeen = false;
    hello = null;
    killReason = null;
    lastSentSeq = 0;
    lastAckedSeq = 0;
    missedPings = 0;
    spawns++;
    setState('starting');
    c.on('message', (m) => { if (gen === childGen && !exitObserved) _onMessage(m); });
    c.on('exit', (code) => _onExit(gen, code));
    try { c.on('error', () => {}); } catch (_) { /* ignore */ }
    if (Number.isInteger(c.pid)) _noteSpawned(c, gen);
    else { try { c.once('spawn', () => _noteSpawned(c, gen)); } catch (_) { /* ignore */ } }
    T.start = timer(() => {
      T.start = null;
      if (gen === childGen && !helloSeen && !exitObserved) {
        log('warn', '[workers:isolation] ' + group + ' worker sent no hello within ' + spec.startTimeoutMs + ' ms — killing');
        _kill('start-timeout');
      }
    }, spec.startTimeoutMs);
    const init = {
      t: 'init', v: P.PROTOCOL_VERSION, group, parentPid: process.pid,
      pingTimeoutMs: spec.pingIntervalMs * spec.pingMissLimit,
      ppidPollMs: spec.ppidPollMs, maxLogPerMin: spec.maxLogPerMin,
      workerSilenceExitMs: spec.workerSilenceExitMs, diag: d.diag === true,
    };
    if (!post(init)) _kill('protocol');
  }

  function _kill(reason) {
    if (!child || exitObserved) return;
    if (!killReason) killReason = reason;
    if (inFlight && !inFlight.settled) _settle(inFlight, { ok: false, code: _reasonToCode(reason), message: reason });
    try { child.kill(); } catch (_) { /* ignore */ }
  }

  function _violation(why) {
    log('warn', '[workers:isolation] ' + group + ' protocol violation (' + why + ') — killing worker');
    _kill('protocol');
  }

  // ── messages ──
  function _classify(id) {
    if (!Number.isInteger(id) || id <= 0 || id > lastIssuedId) return 'never';
    if (inFlight && inFlight.id === id && !inFlight.settled) return 'outstanding';
    return 'stale';
  }

  function _onMessage(raw) {
    const v = P.validateFromWorker(raw);
    if (!v.ok) return _violation('shape:' + v.reason);
    const m = v.msg;
    if (!helloSeen) {
      if (m.t !== 'hello') return _violation('pre-hello');
      return _onHello(m);
    }
    switch (m.t) {
      case 'hello': return _violation('double-hello');
      case 'res': {
        const cls = _classify(m.id);
        if (cls === 'never') return _violation('res-id');
        if (cls === 'stale') {
          log('debug', '[workers:isolation] ' + group + ' late res id=' + m.id + ' ignored');
          if (inFlight && inFlight.id === m.id && T.grace) {
            // The worker proved it is alive and idle again: disarm the grace kill.
            T.grace = clear(T.grace);
            graceReason = null;
            _release(inFlight);
          }
          return undefined;
        }
        return _onRes(m);
      }
      case 'progress': {
        const cls = _classify(m.id);
        if (cls === 'never') return _violation('progress-id');
        if (cls === 'stale') { log('debug', '[workers:isolation] ' + group + ' late progress ignored'); return undefined; }
        lastHeartbeatAt = now();
        if (typeof inFlight.onProgress === 'function') { try { inFlight.onProgress({ pct: m.pct, note: m.note }); } catch (_) { /* ignore */ } }
        return undefined;
      }
      case 'pong': {
        if (m.seq <= 0 || m.seq > lastSentSeq) return _violation('pong-seq');
        if (m.seq <= lastAckedSeq) { log('debug', '[workers:isolation] ' + group + ' old pong ' + m.seq + ' dropped'); return undefined; }
        lastAckedSeq = m.seq;
        missedPings = 0;
        lastHeartbeatAt = now();
        rssBytes = m.rss;
        _checkRss(m.rss);
        return undefined;
      }
      case 'log': return _routeLog(m.level, m.msg);
      case 'ai': return _onAi(m);
      case 'fatal':
        log('error', '[workers:isolation] ' + group + ' worker fatal ' + m.code + ': ' + m.message);
        return undefined;
      default: return _violation('unknown-type');
    }
  }

  function _onHello(m) {
    const ops = Array.isArray(spec.ops) ? spec.ops : [];
    if (m.group !== group || !ops.every((o) => m.ops.includes(o))) return _violation('bad-hello');
    if (m.diag && d.diag !== true) return _violation('unexpected-diag');
    helloSeen = true;
    hello = { pid: m.pid, ppid: m.ppid, ops: m.ops.slice(), diag: m.diag || null, parentPid: process.pid };
    T.start = clear(T.start);
    lastHeartbeatAt = now();
    setState('ready');
    _armPing();
    _armRss();
    return undefined;
  }

  function _armPing() {
    T.ping = clear(T.ping);
    T.ping = timer(_onPingTimer, spec.pingIntervalMs);
  }
  function _onPingTimer() {
    T.ping = null;
    if (!child || exitObserved || !helloSeen) return;
    // Miss rule: evaluated BEFORE sending the next ping.
    if (lastSentSeq > 0 && lastAckedSeq < lastSentSeq) {
      missedPings++;
      if (missedPings >= spec.pingMissLimit) {
        log('warn', '[workers:isolation] ' + group + ' missed ' + missedPings + ' pongs — killing (hung)');
        _kill('hung');
        return;
      }
    }
    post({ t: 'ping', seq: ++lastSentSeq });
    _armPing();
  }

  function _armRss() {
    T.rss = clear(T.rss);
    if (!child || exitObserved) return;
    T.rss = timer(() => {
      T.rss = null;
      if (!child || exitObserved) return;
      let rss;
      try { rss = childPid != null ? getChildRss(childPid) : undefined; } catch (_) { rss = undefined; }
      if (typeof rss === 'number' && Number.isFinite(rss)) { rssBytes = rss; if (_checkRss(rss)) return; }
      _armRss();
    }, inFlight ? spec.rssPollBusyMs : spec.rssPollIdleMs);
  }
  function _checkRss(rss) {
    if (rss > spec.rssCapMb * MB) {
      log('warn', '[workers:isolation] ' + group + ' worker rss ' + Math.round(rss / MB) + ' MB > cap ' + spec.rssCapMb + ' MB — killing');
      _kill('rss');
      return true;
    }
    return false;
  }

  function _routeLog(level, msg) {
    const t = now();
    if (t - logWinAt >= LOG_WINDOW_MS) {
      if (logDropped) wlog('warn', tag + ' dropped ' + logDropped + ' log lines');
      logWinAt = t; logCount = 0; logDropped = 0;
    }
    if (logCount >= spec.maxLogPerMin) { logDropped++; return; }
    logCount++;
    wlog(P.LOG_LEVELS.includes(level) ? level : 'info', msg);
  }

  // ── requests ──
  function _settle(req, result) {
    if (req.settled) return;
    req.settled = true;
    req.timer = clear(req.timer);
    if (req.signal && req.onAbort) { try { req.signal.removeEventListener('abort', req.onAbort); } catch (_) { /* ignore */ } }
    try { req.aiController.abort(); } catch (_) { /* ignore */ }
    lastEndAt = now();
    lastDurationMs = lastEndAt - req.startedAt;
    try { req.resolve(result); } catch (_) { /* ignore */ }
  }
  function _release(req) {
    if (inFlight !== req) return;
    inFlight = null;
    if (state === 'busy') setState('ready');
    _armRss();
  }

  function _onRes(m) {
    const req = inFlight;
    if (m.ok) {
      let val;
      try { val = typeof spec.validateResult === 'function' ? spec.validateResult(req.op, m.result, req.payload) : { ok: true, value: m.result }; }
      catch (e) { val = { ok: false, rule: 'validator-threw' }; }
      if (!val || val.ok !== true) {
        const rule = (val && val.rule) || 'invalid';
        counts.fail++;
        lastError = { message: 'invalid result (' + rule + ')', at: now(), kind: 'invalid-result' };
        if (warnOnce('invalid-result')) log('warn', tag + ' invalid result (' + rule + ')');
        _settle(req, { ok: false, code: P.CODES.INVALID_RESULT, message: rule });
      } else {
        counts.ok++;
        consecutiveCrashes = 0;
        if (restarts > 0) notified = false;
        const workerMs = now() - req.startedAt;
        timing.workerSum += workerMs; timing.workerN++;
        _settle(req, { ok: true, result: val.value, workerMs });
      }
    } else {
      const code = Object.prototype.hasOwnProperty.call(P.CODES, m.error.code) ? m.error.code : P.CODES.OP_FAILED;
      counts.fail++;
      lastError = { message: P.clip(code + ': ' + m.error.message, 200), at: now(), kind: 'op' };
      log('warn', tag + ' op ' + req.op + ' failed: ' + code);
      _settle(req, { ok: false, code, message: m.error.message });
    }
    _release(req);
  }

  function _onReqTimeout(req) {
    req.timer = null;
    if (req.settled || inFlight !== req) return;
    req.timedOut = true;
    counts.timeout++;
    counts.fail++;
    lastError = { message: 'request timeout after ' + req.timeoutMs + 'ms', at: now(), kind: 'timeout' };
    log('warn', tag + ' request ' + req.op + ' timed out after ' + req.timeoutMs + ' ms — cancelling');
    _settle(req, { ok: false, code: P.CODES.TIMEOUT, message: 'timeout' });
    _beginGrace(req, 'timeout');
  }
  function _onCallerCancel(req) {
    if (req.settled || inFlight !== req) return;
    _settle(req, { ok: false, code: P.CODES.CANCELLED, message: 'cancelled' });
    _beginGrace(req, 'cancel-kill');
  }
  function _beginGrace(req, reason) {
    post({ t: 'cancel', id: req.id });
    graceReason = reason;
    T.grace = clear(T.grace);
    T.grace = timer(() => {
      T.grace = null;
      if (inFlight === req) _kill(graceReason || reason);
    }, spec.cancelGraceMs);
  }

  function request(op, payload, opts = {}) {
    const o = opts || {};
    return new Promise((resolve) => {
      if (state !== 'ready' || inFlight || !child || exitObserved) {
        resolve({ ok: false, code: P.CODES.NOT_READY, message: state });
        return;
      }
      if (o.signal && o.signal.aborted) { resolve({ ok: false, code: P.CODES.CANCELLED, message: 'cancelled' }); return; }
      const id = ++lastIssuedId;
      const timeoutMs = Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 ? o.timeoutMs : spec.requestTimeoutMs;
      const req = {
        id, op, payload, startedAt: now(), settled: false, timedOut: false, resolve, timeoutMs,
        onProgress: o.onProgress, signal: o.signal || null, onAbort: null, timer: null,
        aiController: new AbortController(), aiCount: 0,
      };
      try {
        child.postMessage({ t: 'req', id, op, payload });
      } catch (e) {
        log('warn', tag + ' request ' + op + ' could not be posted (' + P.clip(e && e.name, 40) + ')');
        resolve({ ok: false, code: P.CODES.CLONE_ERROR, message: P.clip(e && e.name, 40) });
        return;
      }
      inFlight = req;
      setState('busy');
      counts.runs++;
      lastStartAt = req.startedAt;
      req.timer = timer(() => _onReqTimeout(req), timeoutMs);
      if (req.signal) {
        req.onAbort = () => _onCallerCancel(req);
        try { req.signal.addEventListener('abort', req.onAbort, { once: true }); } catch (_) { /* ignore */ }
      }
      _armRss();
    });
  }

  // ── AI proxy (design §5.4, exact check order) ──
  function _aiReply(gen, m, out) {
    if (gen !== childGen || exitObserved) return;
    post(Object.assign({ t: 'ai.res', aiId: m.aiId }, out));
  }
  function _onAi(m) {
    const ai = spec.ai || {};
    const gen = childGen;
    // 1. zero budget → AI_NOT_ALLOWED before anything else is evaluated.
    if (!(ai.maxPerRequest > 0)) {
      if (!aiWarned) { aiWarned = true; log('warn', tag + ' ai request refused: ' + P.CODES.AI_NOT_ALLOWED); }
      return _aiReply(gen, m, { ok: false, code: P.CODES.AI_NOT_ALLOWED });
    }
    // 2. parent request must be outstanding.
    const cls = _classify(m.id);
    if (cls === 'never') return _violation('ai-id');
    if (cls === 'stale') { log('debug', '[workers:isolation] ' + group + ' ai for a finished request ignored'); return undefined; }
    const req = inFlight;
    // 3. per-request budget, 4. concurrency.
    if (req.aiCount >= ai.maxPerRequest || aiConcurrent >= ai.maxConcurrent) {
      if (warnOnce('ai-limit')) log('warn', tag + ' ai request refused: ' + P.CODES.AI_LIMIT);
      return _aiReply(gen, m, { ok: false, code: P.CODES.AI_LIMIT });
    }
    // 5. prompt length.
    if (typeof m.prompt !== 'string' || m.prompt.length < 1 || m.prompt.length > ai.maxPromptChars) {
      if (warnOnce('ai-prompt')) log('warn', tag + ' ai request refused: ' + P.CODES.AI_NOT_ALLOWED + ' (prompt length)');
      return _aiReply(gen, m, { ok: false, code: P.CODES.AI_NOT_ALLOWED });
    }
    // 6. clamps (never reject).
    const o = m.opts || {};
    const maxRank = Math.min(PRIORITY_RANK[ai.maxPriority] != null ? PRIORITY_RANK[ai.maxPriority] : 0, PRIORITY_RANK.normal);
    let priority = typeof o.priority === 'string' && PRIORITY_RANK[o.priority] != null ? o.priority : 'low';
    if (PRIORITY_RANK[priority] > maxRank) priority = Object.keys(PRIORITY_RANK).find((k) => PRIORITY_RANK[k] === maxRank);
    const tReq = Number.isFinite(o.timeoutMs) ? o.timeoutMs : ai.maxTimeoutMs;
    const timeoutMs = Math.max(1000, Math.min(ai.maxTimeoutMs, tReq));
    const askOpts = { priority, source: 'worker_' + group, timeoutMs, signal: req.aiController.signal, isolated: ai.isolatedOnly === true };
    if (ai.isolatedOnly !== true && typeof o.dedupeKey === 'string' && o.dedupeKey.length <= 128) askOpts.dedupeKey = 'worker:' + group + ':' + o.dedupeKey;
    req.aiCount++;
    aiConcurrent++;
    let p;
    try { p = Promise.resolve((d.relay || require('../../orcha/relay')).ask(m.prompt, askOpts)); } catch (e) { p = Promise.reject(e); }
    p.then((text) => {
      if (inFlight === req && !req.settled) _aiReply(gen, m, { ok: true, text: String(text == null ? '' : text) });
    }, (e) => {
      const code = (e && (e.name === 'AbortError' || /timeout|timed out/i.test(_errMsg(e)))) ? P.CODES.AI_TIMEOUT : P.CODES.AI_FAILED;
      log('warn', tag + ' ai failed: ' + code);
      if (inFlight === req && !req.settled) _aiReply(gen, m, { ok: false, code });
    }).then(() => { aiConcurrent = Math.max(0, aiConcurrent - 1); });
    return undefined;
  }

  // ── exit, backoff, isolation ──
  function _clearChildTimers() {
    T.start = clear(T.start);
    T.ping = clear(T.ping);
    T.rss = clear(T.rss);
    T.grace = clear(T.grace);
    T.shutdownKill = clear(T.shutdownKill);
    graceReason = null;
  }

  function _onExit(gen, code) {
    if (gen !== childGen || exitObserved) return;
    exitObserved = true;
    const pid = childPid;
    _clearChildTimers();
    const reason = killReason || (code === P.EXIT.PARENT_SILENT ? 'parent-silent' : code === P.EXIT.NO_INIT ? 'no-init'
      : code === P.EXIT.FATAL ? 'fatal' : (state === 'stopping' ? 'shutdown' : 'exit'));
    killReason = null;
    lastExit = { code: Number.isInteger(code) ? code : null, reason, at: now() };
    log('info', '[workers:isolation] exited group=' + group + ' pid=' + (pid == null ? '?' : pid) + ' code=' + (Number.isInteger(code) ? code : '?') + ' reason=' + reason);
    if (pid != null && typeof d.onExit === 'function') { try { d.onExit(pid); } catch (_) { /* ignore */ } }
    child = null;
    childPid = null;
    helloSeen = false;
    const req = inFlight;
    inFlight = null;
    if (req && !req.settled) _settle(req, { ok: false, code: state === 'stopping' ? P.CODES.SHUTDOWN : _reasonToCode(reason), message: reason });

    if (state === 'stopping' || state === 'stopped') {
      setState('stopped');
      if (resumePending) { resumePending = false; _resume(); }
      return;
    }
    if (state === 'disabled') return;

    const notCrash = reason === 'parent-silent' || reason === 'no-init' || reason === 'cancel-kill';
    if (!notCrash) {
      const t = now();
      crashTimes.push(t);
      crashTimes = crashTimes.filter((x) => t - x <= spec.crashWindowMs);
      consecutiveCrashes++;
      crashes++;
      if (reason !== 'timeout') counts.fail++;   // a timeout already counted its failure
      lastError = { message: 'worker ' + reason + ' (exit code ' + (Number.isInteger(code) ? code : '?') + ')', at: t, kind: _codeToKind(reason) };
      log('warn', '[workers:isolation] ' + group + ' worker crashed (' + reason + ', ' + crashTimes.length + '/' + spec.maxCrashes + ' in window)');
      if (crashTimes.length >= spec.maxCrashes) { _isolate(reason); return; }
    }
    const idx = notCrash ? 0 : Math.min(Math.max(consecutiveCrashes - 1, 0), spec.backoffMs.length - 1);
    const delay = jitter(spec.backoffMs[idx]);
    setState('backoff');
    nextRestartAt = now() + delay;
    T.backoff = timer(() => { T.backoff = null; _spawn(); }, delay);
  }

  function _notify(payload) {
    if (!notifyFn) return;
    try { notifyFn(payload); } catch (e) { log('debug', '[workers:isolation] notify failed: ' + _errMsg(e)); }
  }

  function _isolate(reason) {
    setState('isolated');
    isolations++;
    isolationReason = reason;
    isolatedUntil = now() + spec.cooldownMs;
    T.cooldown = clear(T.cooldown);
    T.cooldown = timer(_onCooldownExpiry, spec.cooldownMs);
    const min = Math.round(spec.cooldownMs / 60000);
    const restartLeft = restarts < spec.maxRestarts;
    log('warn', '[workers:isolation] ' + group + ' ISOLATED after ' + crashTimes.length + ' crashes (' + reason + ') — '
      + (restartLeft ? 'auto restart in ' + min + ' min (' + restarts + '/' + spec.maxRestarts + ' restarts used)' : 'manual re-enable or app restart required after cool-down')
      + '; canonical work runs in-process meanwhile');
    if (!notified) {
      notified = true;
      const last = lastError ? lastError.message.slice(0, 120) : 'none';
      const message = spec.label + ' stopped after ' + crashTimes.length + ' failures '
        + (restartLeft ? '— retrying in ' + min + ' min' : '— will stay paused until the app restarts')
        + '. Last error: ' + last;
      _notify({ title: 'Background worker paused', message, body: message, icon: '⚠️', type: 'worker', worker: spec.name });
    }
  }

  function _onCooldownExpiry() {
    T.cooldown = null;
    if (state !== 'isolated') return;
    if (restarts >= spec.maxRestarts) {
      setState('disabled');
      disabledReason = 'restart-budget-exhausted';
      log('error', '[workers:isolation] ' + group + ' DISABLED — restart budget exhausted; manual re-enable or app restart required');
      if (!disabledNotified) {
        disabledNotified = true;
        const last = lastError ? lastError.message.slice(0, 120) : 'none';
        const message = spec.label + ' was disabled after ' + isolations
          + ' failed recoveries. Restart the app to re-enable it. Last error: ' + last;
        _notify({ title: 'Background worker disabled', message, body: message, icon: '⛔', type: 'worker', worker: spec.name });
      }
      return;
    }
    restarts++;
    crashTimes = [];
    consecutiveCrashes = 0;
    isolatedUntil = null;
    isolationReason = null;
    setState('idle');
    log('info', '[workers:isolation] ' + group + ' cool-down over — restarting (' + restarts + '/' + spec.maxRestarts + ' restarts used)');
    _spawn();
  }

  // ── public lifecycle ──
  function start() {
    if (state !== 'idle' || T.prewarm || child) return false;
    const ms = Number.isFinite(d.prewarmMs) ? d.prewarmMs : PREWARM_MS;
    T.prewarm = timer(() => { T.prewarm = null; _spawn(); }, ms);
    return true;
  }

  function reEnable() {
    const budget = state === 'disabled' && disabledReason === 'restart-budget-exhausted';
    if (state !== 'isolated' && !budget) return false;
    T.cooldown = clear(T.cooldown);
    crashTimes = [];
    consecutiveCrashes = 0;
    restarts = 0;
    notified = false;
    disabledNotified = false;
    isolatedUntil = null;
    isolationReason = null;
    disabledReason = null;
    setState('idle');
    _spawn();
    return true;
  }

  function shutdown() {
    if (state === 'stopping' || state === 'stopped') return false;   // repeat → no-op (N5)
    preShutdown = (state === 'isolated' || state === 'disabled') ? { state, disabledReason, isolatedUntil } : null;
    T.prewarm = clear(T.prewarm);
    T.backoff = clear(T.backoff);
    T.cooldown = clear(T.cooldown);
    T.resume = clear(T.resume);
    T.ping = clear(T.ping);
    T.rss = clear(T.rss);
    T.start = clear(T.start);
    T.grace = clear(T.grace);
    nextRestartAt = null;
    setState('stopping');
    const req = inFlight;
    if (req && !req.settled) _settle(req, { ok: false, code: P.CODES.SHUTDOWN, message: 'shutdown' });
    inFlight = null;
    if (child && !exitObserved) {
      post({ t: 'shutdown' });
      T.shutdownKill = timer(() => {
        T.shutdownKill = null;
        if (child && !exitObserved) { if (!killReason) killReason = 'shutdown'; try { child.kill(); } catch (_) { /* ignore */ } }
      }, SHUTDOWN_KILL_MS);
    } else {
      setState('stopped');
    }
    return true;
  }

  function _resume() {
    const prev = preShutdown;
    preShutdown = null;
    if (prev && prev.state === 'isolated') {
      setState('isolated');
      const left = prev.isolatedUntil != null ? Math.max(0, prev.isolatedUntil - now()) : 0;
      isolatedUntil = prev.isolatedUntil;
      T.cooldown = timer(_onCooldownExpiry, left);
      return;
    }
    if (prev && prev.state === 'disabled') { setState('disabled'); disabledReason = prev.disabledReason; return; }
    setState('idle');
    T.resume = timer(() => { T.resume = null; _spawn(); }, RESUME_SPAWN_MS);
  }

  function resume() {
    if (state === 'stopping') { resumePending = true; return true; }
    if (state !== 'stopped') return false;
    _resume();
    return true;
  }

  /** killSync() — synchronous, never throws (design §8 layer 2). */
  function killSync() {
    const c = child;
    const pid = childPid != null ? childPid : (c && Number.isInteger(c.pid) ? c.pid : null);
    if (!c || exitObserved) return false;
    try { c.kill(); } catch (_) { /* async request; may never be delivered inside 'exit' */ }
    if (pid != null) {
      try { processKill(pid, 0); processKill(pid); } catch (e) {
        if (!e || e.code !== 'ESRCH') { try { log('error', '[workers:isolation] killSync pid=' + pid + ' failed: ' + _errMsg(e)); } catch (_) { /* ignore */ } }
      }
    }
    return true;
  }

  function noteFallback(why) {
    const k = String(why || 'unknown');
    fallbacks[k] = (fallbacks[k] || 0) + 1;
    counts.skip++;
    if (k === 'overflow') overflowCount++;
    if (k === 'stale') staleDiscards++;
  }
  function noteTiming(t) {
    if (!t) return;
    if (Number.isFinite(t.dispatchMs)) { timing.dispatchSum += t.dispatchMs; timing.dispatchN++; }
    if (Number.isFinite(t.commitMs)) { timing.commitSum += t.commitMs; timing.commitN++; }
  }
  const _avg = (s, n) => (n ? Math.round((s / n) * 10) / 10 : null);

  function _rowState() {
    switch (state) {
      case 'idle': case 'ready': return 'healthy';
      case 'busy': return 'busy';
      case 'starting': return 'waiting';
      case 'backoff': return 'degraded';
      case 'isolated': return 'isolated';
      default: return 'disabled';   // disabled, stopping, stopped
    }
  }

  function getStatusRow() {
    const rs = _rowState();
    const budget = state === 'disabled' && disabledReason === 'restart-budget-exhausted';
    return {
      name: spec.name,
      group: 'isolation',
      label: spec.label,
      state: rs,
      waitingOn: state === 'starting' ? ['spawn'] : null,
      disabledReason: state === 'disabled' ? disabledReason : (state === 'stopping' || state === 'stopped') ? 'shutdown' : null,
      breakerState: state === 'isolated' ? 'isolated' : budget ? 'budget-exhausted' : 'ok',
      lastHeartbeatAt,
      lastStartAt,
      lastEndAt,
      lastDurationMs,
      currentJob: inFlight ? { runId: inFlight.id, startedAt: inFlight.startedAt, trigger: inFlight.op, timedOut: inFlight.timedOut === true } : null,
      counts: Object.assign({}, counts),
      skipReasons: { busy: overflowCount, self: staleDiscards, dependency: {} },
      consecutiveFailures: consecutiveCrashes,
      lastError: lastError ? Object.assign({}, lastError) : null,
      restarts,
      maxRestarts: spec.maxRestarts,
      isolations,
      isolationReason,
      isolatedUntil,
      notified,
      nextRunAt: state === 'backoff' ? nextRestartAt : state === 'isolated' ? isolatedUntil : null,
      intervalMs: null,
      timeoutMs: spec.requestTimeoutMs,
      maxFailures: spec.maxCrashes,
      cooldownMs: spec.cooldownMs,
      dependsOn: [],
      idempotent: true,
      owner: 'host',
      host: {
        pid: childPid,
        hostState: state,
        rssMb: rssBytes != null ? Math.round(rssBytes / MB) : null,
        rssCapMb: spec.rssCapMb,
        spawns,
        crashes,
        lastExit: lastExit ? Object.assign({}, lastExit) : null,
        fallbacks: Object.assign({}, fallbacks),
        staleDiscards,
        mainMsAvg: { dispatch: _avg(timing.dispatchSum, timing.dispatchN), commit: _avg(timing.commitSum, timing.commitN) },
        workerMsAvg: _avg(timing.workerSum, timing.workerN),
      },
    };
  }

  /** Clears every timer without touching the child (tests / registry reset). */
  function _dispose() {
    for (const k of Object.keys(T)) T[k] = clear(T[k]);
  }

  return {
    name: spec.name,
    group,
    spec,
    get state() { return state; },
    get pid() { return childPid; },
    get hello() { return hello; },
    get child() { return child; },
    start, request, shutdown, resume, reEnable, killSync, getStatusRow,
    noteFallback, noteTiming, warnOnce, _dispose,
  };
}

module.exports = { createHost, SHUTDOWN_KILL_MS, RESUME_SPAWN_MS, PREWARM_MS };
