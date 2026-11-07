'use strict';
/**
 * workers/isolation/protocol.js — Phase 8 worker protocol v1 (design §5.1).
 *
 * Shared by main (host.js) and the worker (worker-runtime.js). Pure: NO
 * requires, no side effects. Validators check SHAPE only and return
 * `{ ok:true, msg }` (a clean copy with strings clipped) or
 * `{ ok:false, reason }`. Correlation (issued ids, ping seqs, hello order) is
 * the host's job, not the validator's.
 */

const PROTOCOL_VERSION = 1;

/** host → worker message types */
const TO_WORKER = Object.freeze({
  INIT: 'init', REQ: 'req', CANCEL: 'cancel', PING: 'ping', AI_RES: 'ai.res', SHUTDOWN: 'shutdown',
});

/** worker → host message types */
const FROM_WORKER = Object.freeze({
  HELLO: 'hello', RES: 'res', PROGRESS: 'progress', PONG: 'pong', LOG: 'log', AI: 'ai', FATAL: 'fatal',
});

const CODES = Object.freeze({
  NOT_READY: 'NOT_READY',
  OVERFLOW: 'OVERFLOW',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  CRASHED: 'CRASHED',
  RSS_LIMIT: 'RSS_LIMIT',
  PROTOCOL: 'PROTOCOL',
  INVALID_RESULT: 'INVALID_RESULT',
  OP_FAILED: 'OP_FAILED',
  UNKNOWN_OP: 'UNKNOWN_OP',
  CLONE_ERROR: 'CLONE_ERROR',
  SHUTDOWN: 'SHUTDOWN',
  AI_NOT_ALLOWED: 'AI_NOT_ALLOWED',
  AI_LIMIT: 'AI_LIMIT',
  AI_TIMEOUT: 'AI_TIMEOUT',
  AI_FAILED: 'AI_FAILED',
});

/**
 * Worker exit codes. PARENT_SILENT (3) and NO_INIT (4) are the worker's own
 * watchdogs: the host never counts them as crashes (design §7, review M2).
 */
const EXIT = Object.freeze({ PARENT_SILENT: 3, NO_INIT: 4, BAD_INIT: 65, FATAL: 70 });

const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const CODE_RE = /^[A-Z_]{1,40}$/;
const RES_MSG_MAX = 200;
const NOTE_MAX = 200;
const LOG_MSG_MAX = 500;
const NAME_MAX = 100;

// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001F\u007F]/g;

/** clip(str, n) → string without control characters, at most n chars. */
function clip(str, n) {
  const s = String(str == null ? '' : str).replace(CTRL_RE, '');
  return s.length > n ? s.slice(0, n) : s;
}

function _plain(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const p = Object.getPrototypeOf(o);
  return p === Object.prototype || p === null;
}
const _int = (v, lo) => Number.isInteger(v) && v >= lo;
const _fin = (v) => typeof v === 'number' && Number.isFinite(v);
const _str = (v, max) => typeof v === 'string' && v.length <= max;
const _bad = (reason) => ({ ok: false, reason });
const _good = (msg) => ({ ok: true, msg });

/** validateFromWorker(msg) — shape check of a worker → host message. */
function validateFromWorker(msg) {
  if (!_plain(msg)) return _bad('not-object');
  if (typeof msg.t !== 'string') return _bad('no-type');
  switch (msg.t) {
    case 'hello': {
      if (msg.v !== PROTOCOL_VERSION) return _bad('version');
      if (!_str(msg.group, 40) || !msg.group) return _bad('group');
      if (!_int(msg.pid, 1)) return _bad('pid');
      if (!_int(msg.ppid, 0)) return _bad('ppid');
      if (!Array.isArray(msg.ops) || msg.ops.length > 64 || !msg.ops.every((o) => _str(o, NAME_MAX))) return _bad('ops');
      const out = { t: 'hello', v: msg.v, group: msg.group, pid: msg.pid, ppid: msg.ppid, ops: msg.ops.slice() };
      if (msg.diag !== undefined) {
        const d = msg.diag;
        const strs = (a) => Array.isArray(a) && a.length <= 500 && a.every((x) => _str(x, 500));
        if (!_plain(d) || !strs(d.envKeys) || !strs(d.execArgv)) return _bad('diag');
        out.diag = { envKeys: d.envKeys.slice(), execArgv: d.execArgv.slice() };
      }
      return _good(out);
    }
    case 'res': {
      if (!Number.isInteger(msg.id)) return _bad('id');
      if (typeof msg.ok !== 'boolean') return _bad('ok');
      if (msg.ok) return _good({ t: 'res', id: msg.id, ok: true, result: msg.result });
      const e = msg.error;
      if (!_plain(e) || typeof e.code !== 'string' || !CODE_RE.test(e.code) || typeof e.message !== 'string') return _bad('error');
      return _good({ t: 'res', id: msg.id, ok: false, error: { code: e.code, message: clip(e.message, RES_MSG_MAX) } });
    }
    case 'progress': {
      if (!Number.isInteger(msg.id)) return _bad('id');
      const out = { t: 'progress', id: msg.id };
      if (msg.pct !== undefined) {
        if (!_fin(msg.pct) || msg.pct < 0 || msg.pct > 100) return _bad('pct');
        out.pct = msg.pct;
      }
      if (msg.note !== undefined) {
        if (typeof msg.note !== 'string') return _bad('note');
        out.note = clip(msg.note, NOTE_MAX);
      }
      return _good(out);
    }
    case 'pong': {
      if (!Number.isInteger(msg.seq)) return _bad('seq');
      if (!_fin(msg.rss) || msg.rss < 0 || !_fin(msg.heapUsed) || msg.heapUsed < 0) return _bad('mem');
      return _good({ t: 'pong', seq: msg.seq, rss: msg.rss, heapUsed: msg.heapUsed });
    }
    case 'log': {
      if (!LOG_LEVELS.includes(msg.level)) return _bad('level');
      if (typeof msg.msg !== 'string') return _bad('msg');
      return _good({ t: 'log', level: msg.level, msg: clip(msg.msg, LOG_MSG_MAX) });
    }
    case 'ai': {
      if (!_int(msg.aiId, 1)) return _bad('aiId');
      if (!Number.isInteger(msg.id)) return _bad('id');
      if (typeof msg.prompt !== 'string') return _bad('prompt');
      if (msg.opts !== undefined && !_plain(msg.opts)) return _bad('opts');
      return _good({ t: 'ai', aiId: msg.aiId, id: msg.id, prompt: msg.prompt, opts: Object.assign({}, msg.opts || {}) });
    }
    case 'fatal': {
      if (typeof msg.code !== 'string' || typeof msg.message !== 'string') return _bad('fatal');
      return _good({ t: 'fatal', code: clip(msg.code, 40), message: clip(msg.message, RES_MSG_MAX) });
    }
    default:
      return _bad('unknown-type');
  }
}

/** validateFromHost(msg) — shape check of a host → worker message. */
function validateFromHost(msg) {
  if (!_plain(msg)) return _bad('not-object');
  if (typeof msg.t !== 'string') return _bad('no-type');
  switch (msg.t) {
    case 'init': {
      if (msg.v !== PROTOCOL_VERSION) return _bad('version');
      if (!_str(msg.group, 40) || !msg.group) return _bad('group');
      if (!_int(msg.parentPid, 1)) return _bad('parentPid');
      if (msg.pingTimeoutMs !== undefined && !_int(msg.pingTimeoutMs, 0)) return _bad('pingTimeoutMs');
      if (!_int(msg.ppidPollMs, 1)) return _bad('ppidPollMs');
      if (!_int(msg.maxLogPerMin, 0)) return _bad('maxLogPerMin');
      if (msg.workerSilenceExitMs !== undefined && !_int(msg.workerSilenceExitMs, 1)) return _bad('workerSilenceExitMs');
      if (typeof msg.diag !== 'boolean') return _bad('diag');
      return _good({
        t: 'init', v: msg.v, group: msg.group, parentPid: msg.parentPid, pingTimeoutMs: msg.pingTimeoutMs,
        ppidPollMs: msg.ppidPollMs, maxLogPerMin: msg.maxLogPerMin, workerSilenceExitMs: msg.workerSilenceExitMs, diag: msg.diag,
      });
    }
    case 'req':
      if (!_int(msg.id, 1)) return _bad('id');
      if (!_str(msg.op, NAME_MAX) || !msg.op) return _bad('op');
      return _good({ t: 'req', id: msg.id, op: msg.op, payload: msg.payload });
    case 'cancel':
      if (!_int(msg.id, 1)) return _bad('id');
      return _good({ t: 'cancel', id: msg.id });
    case 'ping':
      if (!_int(msg.seq, 1)) return _bad('seq');
      return _good({ t: 'ping', seq: msg.seq });
    case 'ai.res': {
      if (!_int(msg.aiId, 1)) return _bad('aiId');
      if (typeof msg.ok !== 'boolean') return _bad('ok');
      if (msg.text !== undefined && typeof msg.text !== 'string') return _bad('text');
      if (msg.code !== undefined && (typeof msg.code !== 'string' || !CODE_RE.test(msg.code))) return _bad('code');
      const out = { t: 'ai.res', aiId: msg.aiId, ok: msg.ok };
      if (msg.text !== undefined) out.text = msg.text;
      if (msg.code !== undefined) out.code = msg.code;
      return _good(out);
    }
    case 'shutdown':
      return _good({ t: 'shutdown' });
    default:
      return _bad('unknown-type');
  }
}

module.exports = {
  PROTOCOL_VERSION, TO_WORKER, FROM_WORKER, CODES, EXIT, LOG_LEVELS, CODE_RE,
  RES_MSG_MAX, NOTE_MAX, LOG_MSG_MAX,
  clip, validateFromWorker, validateFromHost,
};
