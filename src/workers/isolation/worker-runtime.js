'use strict';
/**
 * workers/isolation/worker-runtime.js — the worker side of protocol v1.
 *
 * Runs inside an Electron utilityProcess (process.parentPort) in production
 * and inside a plain Node child_process.fork (process.send) in tests, the same
 * transport detection as src/justme-context/extract-worker.js. Requires ONLY
 * ./protocol (the require-graph test enforces it): no store, no logger, no
 * relay, no electron, no fs, no network.
 *
 * NOTHING runs at module load (review M1/N5): only startWorker() arms timers
 * and adds listeners.
 *
 * Watchdogs (review M2), armed by startWorker() before any message arrives:
 *   - pre-init: no valid `init` within PRE_INIT_MS → exit(EXIT.NO_INIT = 4)
 *   - parent liveness: poll process.ppid every DEFAULT_PPID_POLL_MS from start;
 *     a valid init switches the target to init.parentPid (and its ppidPollMs)
 *   - silence: after init, no host message for workerSilenceExitMs →
 *     exit(EXIT.PARENT_SILENT = 3); re-armed on every host message
 *   - an invalid FIRST message (anything but a valid init) → exit(EXIT.BAD_INIT = 65)
 *   - after init, an invalid host message is ignored, with at most one `log`
 *     warn per minute (never an exit)
 */

const P = require('./protocol');

const PRE_INIT_MS = 15000;
const DEFAULT_PPID_POLL_MS = 2000;
const DEFAULT_SILENCE_MS = 45000;
const DEFAULT_MAX_LOG_PER_MIN = 50;
const LOG_WINDOW_MS = 60000;

/**
 * _parentAlive(pid, killFn) → boolean. Pure decision for the ppid poll:
 * success or EPERM (exists, not ours to signal) → alive; ESRCH → gone; any
 * other error → alive (the silence timer bounds that case).
 */
function _parentAlive(pid, killFn = process.kill) {
  try { killFn(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}

function _unref(h) { try { if (h && typeof h.unref === 'function') h.unref(); } catch (_) { /* ignore */ } return h; }

/**
 * startWorker({ group, ops, deps? }) — deps (tests only): { exit(code) }.
 * ops: { [op]: (payload, ctx) => result | Promise<result> }
 * ctx: { cancelled, signal, progress(pct, note), log(level, msg), ai(prompt, opts) }
 */
function startWorker({ group, ops, deps } = {}) {
  const d = deps || {};
  const exit = typeof d.exit === 'function' ? d.exit : (code) => process.exit(code);
  const port = process.parentPort;
  const send = port
    ? (m) => { try { port.postMessage(m); } catch (_) { /* parent gone */ } }
    : (m) => { try { if (process.connected) process.send(m); } catch (_) { /* parent gone */ } };
  const onMessage = port ? (fn) => port.on('message', (e) => fn(e && e.data)) : (fn) => process.on('message', fn);
  const opTable = ops && typeof ops === 'object' ? ops : {};

  let inited = false;
  let parentPid = process.ppid;
  let ppidPollMs = DEFAULT_PPID_POLL_MS;
  let maxLogPerMin = DEFAULT_MAX_LOG_PER_MIN;
  let silence = null;
  let silenceMs = DEFAULT_SILENCE_MS;

  // ── watchdogs armed at start (M2) ──
  const preInit = _unref(setTimeout(() => exit(P.EXIT.NO_INIT), PRE_INIT_MS));
  const pollFn = () => { if (Number.isInteger(parentPid) && parentPid > 0 && !_parentAlive(parentPid)) exit(0); };
  let poll = _unref(setInterval(pollFn, ppidPollMs));

  // ── log rate limit (worker side; the host enforces its own as well) ──
  let logWinAt = Date.now();
  let logCount = 0;
  function sendLog(level, msg) {
    const t = Date.now();
    if (t - logWinAt >= LOG_WINDOW_MS) { logWinAt = t; logCount = 0; }
    if (logCount >= maxLogPerMin) return;
    logCount++;
    send({ t: 'log', level: P.LOG_LEVELS.includes(level) ? level : 'info', msg: P.clip(msg, P.LOG_MSG_MAX) });
  }
  let invalidWarnAt = -Infinity;
  function warnInvalid(reason) {
    const t = Date.now();
    if (t - invalidWarnAt < LOG_WINDOW_MS) return;
    invalidWarnAt = t;
    send({ t: 'log', level: 'warn', msg: '[worker:' + group + '] ignored invalid host message (' + P.clip(reason, 40) + ')' });
  }

  // ── requests (serial) ──
  const pending = new Map(); // id → { cancelled, controller }
  const aiPending = new Map(); // aiId → resolve
  let aiSeq = 0;
  let chain = Promise.resolve();

  async function runReq(m, st) {
    if (st.cancelled) { send({ t: 'res', id: m.id, ok: false, error: { code: P.CODES.CANCELLED, message: 'cancelled' } }); return; }
    const fn = Object.prototype.hasOwnProperty.call(opTable, m.op) ? opTable[m.op] : null;
    if (typeof fn !== 'function') { send({ t: 'res', id: m.id, ok: false, error: { code: P.CODES.UNKNOWN_OP, message: P.clip(m.op, 100) } }); return; }
    const ctx = {
      get cancelled() { return st.cancelled; },
      signal: st.controller.signal,
      progress(pct, note) {
        const out = { t: 'progress', id: m.id };
        if (typeof pct === 'number' && Number.isFinite(pct)) out.pct = Math.max(0, Math.min(100, pct));
        if (note != null) out.note = P.clip(note, P.NOTE_MAX);
        send(out);
      },
      log: sendLog,
      ai(prompt, opts) {
        return new Promise((resolve) => {
          const aiId = ++aiSeq;
          aiPending.set(aiId, resolve);
          send({ t: 'ai', aiId, id: m.id, prompt: String(prompt == null ? '' : prompt), opts: Object.assign({}, opts || {}) });
        });
      },
    };
    let result;
    try {
      result = await fn(m.payload, ctx);
    } catch (e) {
      send({ t: 'res', id: m.id, ok: false, error: { code: P.CODES.OP_FAILED, message: P.clip((e && e.message) || String(e), P.RES_MSG_MAX) } });
      return;
    }
    try {
      const msg = { t: 'res', id: m.id, ok: true, result };
      if (port) port.postMessage(msg); else if (process.connected) process.send(msg);
    } catch (e) {
      send({ t: 'res', id: m.id, ok: false, error: { code: P.CODES.OP_FAILED, message: 'result not cloneable: ' + P.clip(e && e.name, 40) } });
    }
  }

  function onInit(m) {
    inited = true;
    clearTimeout(preInit);
    parentPid = m.parentPid;
    ppidPollMs = m.ppidPollMs;
    maxLogPerMin = m.maxLogPerMin;
    clearInterval(poll);
    poll = _unref(setInterval(pollFn, ppidPollMs));
    silenceMs = m.workerSilenceExitMs || DEFAULT_SILENCE_MS;
    silence = _unref(setTimeout(() => exit(P.EXIT.PARENT_SILENT), silenceMs));
    const hello = { t: 'hello', v: P.PROTOCOL_VERSION, group, pid: process.pid, ppid: process.ppid, ops: Object.keys(opTable) };
    if (m.diag === true) hello.diag = { envKeys: Object.keys(process.env), execArgv: process.execArgv.slice() };
    send(hello);
  }

  onMessage((raw) => {
    const v = P.validateFromHost(raw);
    if (!inited) {
      if (v.ok && v.msg.t === 'init' && v.msg.group === group) onInit(v.msg);
      else exit(P.EXIT.BAD_INIT);
      return;
    }
    if (silence) { try { silence.refresh(); } catch (_) { /* ignore */ } }
    if (!v.ok) { warnInvalid(v.reason); return; }
    const m = v.msg;
    switch (m.t) {
      case 'init': warnInvalid('double-init'); return;
      case 'req': {
        const st = { cancelled: false, controller: new AbortController() };
        pending.set(m.id, st);
        chain = chain.then(() => runReq(m, st)).catch(() => {}).then(() => { pending.delete(m.id); });
        return;
      }
      case 'cancel': {
        const st = pending.get(m.id);
        if (st && !st.cancelled) { st.cancelled = true; try { st.controller.abort(); } catch (_) { /* ignore */ } }
        return;
      }
      case 'ping': {
        const mu = process.memoryUsage();
        send({ t: 'pong', seq: m.seq, rss: mu.rss, heapUsed: mu.heapUsed });
        return;
      }
      case 'ai.res': {
        const r = aiPending.get(m.aiId);
        if (r) { aiPending.delete(m.aiId); r(m.ok ? { ok: true, text: m.text || '' } : { ok: false, code: m.code || P.CODES.AI_FAILED }); }
        return;
      }
      case 'shutdown': exit(0); return;
      default: return;
    }
  });

  const fatal = (code) => (e) => {
    send({ t: 'fatal', code, message: P.clip((e && e.message) || String(e), P.RES_MSG_MAX) });
    // Short delay so the fatal message can leave the IPC queue.
    setTimeout(() => exit(P.EXIT.FATAL), 20);
  };
  process.on('uncaughtException', fatal('UNCAUGHT'));
  process.on('unhandledRejection', fatal('UNHANDLED_REJECTION'));

  return { _state: () => ({ inited, parentPid, ppidPollMs, silenceMs }) };
}

module.exports = { startWorker, _parentAlive, PRE_INIT_MS, DEFAULT_PPID_POLL_MS, DEFAULT_SILENCE_MS };
