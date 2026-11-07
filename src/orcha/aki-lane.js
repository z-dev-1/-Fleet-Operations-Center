'use strict';
/**
 * orcha/aki-lane.js — Aki CLI as an AI lane (one-shot `aki --cli ... <prompt>`).
 *
 * Every call spawns the Aki binary directly (never a .cmd/.bat shim, never a
 * shell), with the prompt as ONE argv element, stdin ignored, no --thread
 * (each call is a throwaway Aki thread), cwd in a private temp sandbox and a
 * scrubbed environment (AWS/Midway creds kept, Fleet/Slack/token keys dropped).
 * Output is `--output-format stream-json` JSONL, parsed incrementally:
 * text_delta content is the answer, tool_use events are counted by name.
 *
 * Never logs prompt, response or stderr content: one line per call with exit
 * code, latency, text length and tool counts only.
 *
 * All side effects go through injectable deps so unit tests never run aki:
 *   createAkiLane({ spawn, killTree, resolveBin, mkdirSync, tmpdir, platform,
 *                   env, now, logger, setTimeout, clearTimeout })
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { StringDecoder } = require('string_decoder');

// CreateProcessW lpCommandLine max is 32,767 UTF-16 chars incl. NUL; keep a margin.
const AKI_CMDLINE_MAX_WIN32 = 32000;
const AKI_CMDLINE_MAX_OTHER = 120000;
const AKI_CMDLINE_MAX = process.platform === 'win32' ? AKI_CMDLINE_MAX_WIN32 : AKI_CMDLINE_MAX_OTHER;
const AKI_SANDBOX_DIRNAME = 'fleet-aki-lane';
const AKI_TRUNC_MARKER = '\n\n[…truncated by Fleet: prompt exceeded the Windows command-line limit for Aki]';
const AKI_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,40}$/;
const BIN_CACHE_MS = 60 * 1000;
const DEFAULTS = Object.freeze({ concurrency: 2, timeoutMs: 120000, maxStdoutBytes: 4 * 1024 * 1024, profile: '', model: '' });

function cmdLineMax(platform) { return platform === 'win32' ? AKI_CMDLINE_MAX_WIN32 : AKI_CMDLINE_MAX_OTHER; }

function _err(code, message) { return Object.assign(new Error(message), { code }); }

// ── Pure helpers ────────────────────────────────────────────────────────────

/** JSONL stream parser; push() chunks as they arrive, end() flushes the tail. */
function createStreamParser() {
  const st = { text: '', tools: {}, toolCount: 0, badLines: 0, events: 0, done: false };
  let tail = '';
  function _line(line) {
    const s = line.trim();
    if (!s) return;
    let ev;
    try { ev = JSON.parse(s); } catch (_) { st.badLines++; return; }
    if (!ev || typeof ev !== 'object') { st.badLines++; return; }
    st.events++;
    if (ev.type === 'text_delta') {
      if (typeof ev.content === 'string') st.text += ev.content;
    } else if (ev.type === 'tool_use') {
      const raw = ev.name != null ? ev.name : (ev.tool_name != null ? ev.tool_name : ev.tool);
      const name = typeof raw === 'string' && TOOL_NAME_RE.test(raw) ? raw : 'other';
      st.toolCount++;
      st.tools[name] = (st.tools[name] || 0) + 1;
    } else if (ev.type === 'turn_complete' || ev.type === 'done') {
      st.done = true;
    }
    // thinking_delta, tool_result and unknown types are ignored.
  }
  return {
    push(chunk) {
      tail += chunk;
      let i;
      while ((i = tail.indexOf('\n')) !== -1) {
        _line(tail.slice(0, i));
        tail = tail.slice(i + 1);
      }
    },
    end() { if (tail) { _line(tail); tail = ''; } return st; },
    state: st,
  };
}

/** Parse a complete stream-json stdout. */
function parseStreamJson(text) {
  const p = createStreamParser();
  p.push(String(text == null ? '' : text));
  const st = p.end();
  return { text: st.text, tools: { ...st.tools }, toolCount: st.toolCount, badLines: st.badLines, events: st.events, done: st.done };
}

/** argv for one-shot mode. Prompt starting with '-' gets a leading space so it is never a flag. */
function buildArgs(prompt, opts = {}) {
  const p = String(prompt == null ? '' : prompt);
  const args = ['--cli'];
  if (opts.profile) args.push('--profile', String(opts.profile));
  if (opts.model) args.push('--model', String(opts.model));
  args.push('--output-format', 'stream-json');
  args.push(p.startsWith('-') ? ' ' + p : p);
  return args;
}

/** Length of one argument after libuv quote_cmd_arg (UTF-16 units, like String.length). */
function winQuotedLength(arg) {
  const s = String(arg);
  if (s.length === 0) return 2;
  if (!/[ \t"]/.test(s)) return s.length;
  if (!/["\\]/.test(s)) return s.length + 2;
  // Walk backwards like libuv: backslashes before a quote or the closing quote are doubled.
  let n = 2;
  let quoteHit = true;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    n++;
    if (quoteHit && c === '\\') {
      n++;
    } else if (c === '"') {
      quoteHit = true;
      n++;
    } else {
      quoteHit = false;
    }
  }
  return n;
}

/** Full command line length libuv builds for [bin, ...args] (separating spaces included, NUL excluded). */
function cmdLineLength(bin, args) {
  const all = [bin, ...(args || [])];
  let n = all.length - 1;
  for (const a of all) n += winQuotedLength(a);
  return n;
}

/**
 * Fit a prompt in the command-line budget.
 * mode 'reject' (default) throws AKI_PROMPT_TOO_LONG; 'truncate' cuts the prompt
 * (never inside a surrogate pair) and appends AKI_TRUNC_MARKER.
 * Returns { prompt, args, truncated, length }.
 */
function fitPrompt(bin, argsFor, prompt, mode = 'reject', opts = {}) {
  const max = Number.isInteger(opts.max) ? opts.max : AKI_CMDLINE_MAX;
  const p = String(prompt == null ? '' : prompt);
  let args = argsFor(p);
  let len = cmdLineLength(bin, args);
  if (len <= max) return { prompt: p, args, truncated: false, length: len };
  const tooLong = () => _err('AKI_PROMPT_TOO_LONG', `prompt too long for the aki command line (${len} > ${max})`);
  if (mode !== 'truncate') throw tooLong();
  const cut = (k) => {
    let end = k;
    if (end > 0 && end < p.length) {
      const c = p.charCodeAt(end - 1);
      if (c >= 0xD800 && c <= 0xDBFF) end--; // keep surrogate pairs whole
    }
    return p.slice(0, end) + AKI_TRUNC_MARKER;
  };
  const fits = (k) => cmdLineLength(bin, argsFor(cut(k))) <= max;
  if (!fits(0)) throw tooLong();
  let lo = 0;
  let hi = p.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid; else hi = mid - 1;
  }
  const out = cut(lo);
  args = argsFor(out);
  return { prompt: out, args, truncated: true, length: cmdLineLength(bin, args) };
}

const ENV_DROP_KEY = [/^FLEET_/i, /^ELECTRON_/i, /^NODE_OPTIONS$/i, /SLACK|COOKIE|XOX[ABPCD]/i];
const ENV_SECRET_KEY = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY/i;
const ENV_SLACK_VALUE = /^xox[a-z]-/i;

/** Shallow copy of env without Fleet/Electron/Slack/secret keys (AWS_* kept for Midway). Never adds keys. */
function akiChildEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (ENV_DROP_KEY.some((re) => re.test(k))) continue;
    if (ENV_SECRET_KEY.test(k) && !/^AWS_/i.test(k)) continue;
    if (typeof v === 'string' && ENV_SLACK_VALUE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

function _envGet(env, name) {
  if (!env) return undefined;
  if (env[name] != null) return env[name];
  const k = Object.keys(env).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? env[k] : undefined;
}

/**
 * Locate the Aki binary. win32: %LOCALAPPDATA%\Aki\Aki.exe, then PATH dirs + Aki.exe
 * (never a .cmd/.bat: Node refuses those with shell:false). Else ~/.aki/bin/aki, then PATH aki.
 */
function resolveAkiBin(opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const existsSync = opts.existsSync || fs.existsSync;
  const homedir = opts.homedir || os.homedir;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exe = win ? 'Aki.exe' : 'aki';
  const candidates = [];
  if (win) {
    const lad = _envGet(env, 'LOCALAPPDATA');
    if (lad) candidates.push(P.join(lad, 'Aki', exe));
  } else {
    try { const h = homedir(); if (h) candidates.push(P.join(h, '.aki', 'bin', exe)); } catch (_) {}
  }
  const rawPath = _envGet(env, 'PATH') || '';
  for (const dir of String(rawPath).split(win ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (d) candidates.push(P.join(d, exe));
  }
  for (const c of candidates) {
    if (win && /\.(cmd|bat)$/i.test(c)) continue;
    try { if (existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function _killTreeReal(proc, platform, spawnFn) {
  if (!proc) return;
  try {
    if (platform === 'win32' && proc.pid) {
      spawnFn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { detached: true, stdio: 'ignore' });
    } else {
      proc.kill();
    }
  } catch (_) {}
}

function _validName(v) { return typeof v === 'string' && AKI_NAME_RE.test(v) ? v : ''; }
function _intIn(v, lo, hi, dflt) { return (Number.isInteger(v) && v >= lo && v <= hi) ? v : dflt; }

// ── Lane factory ────────────────────────────────────────────────────────────

function createAkiLane(deps = {}) {
  const d = {
    spawn: deps.spawn || require('child_process').spawn,
    mkdirSync: deps.mkdirSync || fs.mkdirSync,
    tmpdir: deps.tmpdir || os.tmpdir,
    platform: deps.platform || process.platform,
    env: deps.env || process.env,
    now: deps.now || Date.now,
    logger: deps.logger || require('../utils/logger')('aki-lane'),
    setTimeout: deps.setTimeout || setTimeout,
    clearTimeout: deps.clearTimeout || clearTimeout,
  };
  // Default kill tree uses the (possibly injected) spawner, so tests never reach a real process.
  d.killTree = deps.killTree || ((proc) => _killTreeReal(proc, d.platform, d.spawn));
  d.resolveBin = deps.resolveBin || (() => resolveAkiBin({ platform: d.platform, env: d.env }));

  let cfg;
  let queue;
  let active;
  let seq;
  let binCache;
  let notFound;
  let health;
  let counters;

  function reset() {
    cfg = { ...DEFAULTS };
    queue = [];
    active = 0;
    seq = 0;
    binCache = null; // { bin, at }
    notFound = false;
    health = null;
    counters = {
      calls: 0, ok: 0, failed: 0, timeouts: 0, aborted: 0, tooLong: 0, toolsUsed: 0,
      lastTools: {}, lastLatencyMs: null, lastErrorCode: null,
    };
  }
  reset();

  function _warn(msg) { try { d.logger.warn(msg); } catch (_) {} }
  function _info(msg) { try { d.logger.info(msg); } catch (_) {} }

  function configure(o = {}) {
    if (o.concurrency !== undefined) cfg.concurrency = _intIn(o.concurrency, 1, 4, DEFAULTS.concurrency);
    if (o.timeoutMs !== undefined) cfg.timeoutMs = _intIn(o.timeoutMs, 10000, 600000, DEFAULTS.timeoutMs);
    if (o.maxStdoutBytes !== undefined) {
      cfg.maxStdoutBytes = (Number.isInteger(o.maxStdoutBytes) && o.maxStdoutBytes > 0) ? o.maxStdoutBytes : DEFAULTS.maxStdoutBytes;
    }
    for (const k of ['profile', 'model']) {
      if (o[k] === undefined) continue;
      const v = _validName(o[k]);
      if (o[k] && !v) _warn(`[aki] ignoring invalid ${k} (not logged)`);
      cfg[k] = v;
    }
    _pump();
    return { ...cfg };
  }

  function _bin() {
    const t = d.now();
    if (binCache && t - binCache.at < BIN_CACHE_MS) return binCache.bin;
    let bin = null;
    try { bin = d.resolveBin() || null; } catch (_) { bin = null; }
    binCache = { bin, at: t };
    notFound = !bin;
    return bin;
  }

  function available() { return !!_bin(); }
  function load() { return active + queue.length; }
  function markState(s) { health = (s === 'up' || s === 'down') ? s : null; }

  function stats() {
    const state = notFound ? 'not-found' : (health || (active > 0 || counters.ok > 0 ? 'up' : 'idle'));
    return {
      state, active, queued: queue.length, max: cfg.concurrency,
      calls: counters.calls, ok: counters.ok, failed: counters.failed, timeouts: counters.timeouts,
      aborted: counters.aborted, tooLong: counters.tooLong, toolsUsed: counters.toolsUsed,
      lastTools: { ...counters.lastTools }, lastLatencyMs: counters.lastLatencyMs, lastErrorCode: counters.lastErrorCode,
    };
  }

  function _abortErr() { return _err('ABORTED', 'Aborted by caller'); }

  function ask(prompt, opts = {}) {
    return new Promise((resolve, reject) => {
      counters.calls++;
      const signal = opts.signal || null;
      if (signal && signal.aborted) {
        counters.aborted++;
        counters.lastErrorCode = 'ABORTED';
        reject(_abortErr());
        return;
      }
      const bin = _bin();
      if (!bin) {
        counters.failed++;
        counters.lastErrorCode = 'AKI_NOT_FOUND';
        reject(_err('AKI_NOT_FOUND', 'aki not found'));
        return;
      }
      let fitted;
      try {
        const argOpts = { profile: cfg.profile, model: cfg.model };
        fitted = fitPrompt(bin, (p) => buildArgs(p, argOpts), prompt, opts.onTooLong === 'truncate' ? 'truncate' : 'reject',
          { max: cmdLineMax(d.platform) });
      } catch (e) {
        counters.tooLong++;
        counters.lastErrorCode = e.code || 'AKI_PROMPT_TOO_LONG';
        reject(e);
        return;
      }
      const job = {
        id: ++seq, bin, args: fitted.args, truncated: fitted.truncated,
        requestId: opts.requestId || `aki-${seq}`, isolated: opts.isolated === true,
        rank: (opts.rank != null && Number.isFinite(Number(opts.rank))) ? Number(opts.rank) : null,
        signal, resolve, reject, started: false, settle: null, onAbort: null,
      };
      if (signal) {
        job.onAbort = () => {
          const qi = queue.indexOf(job);
          if (qi !== -1) {
            queue.splice(qi, 1);
            signal.removeEventListener('abort', job.onAbort);
            counters.aborted++;
            counters.lastErrorCode = 'ABORTED';
            reject(_abortErr());
          } else if (job.settle) {
            job.settle('abort');
          }
        };
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      if (job.rank != null) {
        let at = -1;
        for (let i = 0; i < queue.length; i++) {
          const r = queue[i].rank != null ? queue[i].rank : 2;
          if (r > job.rank) { at = i; break; }
        }
        queue.splice(at === -1 ? queue.length : at, 0, job);
      } else {
        queue.push(job);
      }
      _pump();
    });
  }

  function _pump() {
    while (active < cfg.concurrency && queue.length) {
      const job = queue.shift();
      active++;
      _run(job);
    }
  }

  function _run(job) {
    const t0 = d.now();
    const cwd = path.join(d.tmpdir(), AKI_SANDBOX_DIRNAME);
    const parser = createStreamParser();
    const decoder = new StringDecoder('utf8');
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrHead = '';
    let proc = null;
    let timer = null;
    let settled = false;
    let exitCode = null;

    const onStdout = (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stdoutBytes += buf.length;
      if (stdoutBytes > cfg.maxStdoutBytes) { finish('cap'); return; }
      parser.push(decoder.write(buf));
    };
    const onStderr = (chunk) => {
      const s = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stderrBytes += Buffer.byteLength(s);
      if (!job.isolated && stderrHead.length < 200) stderrHead = (stderrHead + s).slice(0, 200);
    };
    const onError = (e) => finish('error', e);
    const onClose = (code) => { exitCode = code; finish('close'); };

    function finish(kind, e) {
      if (settled) return;
      settled = true;
      job.settle = null;
      if (timer) { d.clearTimeout(timer); timer = null; }
      if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
      if (proc) {
        try { proc.stdout && proc.stdout.removeListener('data', onStdout); } catch (_) {}
        try { proc.stderr && proc.stderr.removeListener('data', onStderr); } catch (_) {}
        try { proc.removeListener('close', onClose); } catch (_) {}
        // keep an error listener so a late 'error' after settle never becomes an uncaught exception
        try { proc.removeListener('error', onError); proc.on('error', () => {}); } catch (_) {}
      }
      if ((kind === 'timeout' || kind === 'abort' || kind === 'cap') && proc) {
        try { d.killTree(proc); } catch (_) {}
      }
      if (kind === 'close') parser.push(decoder.end());
      const st2 = parser.end();
      const text = st2.text;
      const ms = d.now() - t0;
      let err = null;
      let value;
      if (kind === 'close') {
        if (exitCode === 0) {
          const out = text.trim();
          if (out) value = out;
          else err = _err('AKI_EMPTY', 'aki returned an empty response');
        } else {
          let msg = `aki exited with code ${exitCode}`;
          if (!job.isolated && stderrHead.trim()) msg += `: ${stderrHead.trim()}`;
          err = _err('AKI_EXIT', msg);
        }
      } else if (kind === 'timeout') {
        err = _err('AKI_TIMEOUT', `aki timed out after ${cfg.timeoutMs}ms`);
      } else if (kind === 'abort') {
        err = _abortErr();
      } else if (kind === 'cap') {
        err = _err('AKI_STDOUT_CAP', `aki output exceeded ${cfg.maxStdoutBytes} bytes`);
      } else {
        const code = e && e.code;
        if (code === 'ENOENT') {
          binCache = null;
          notFound = true;
          err = _err('AKI_NOT_FOUND', 'aki not found');
        } else {
          err = _err('AKI_SPAWN', `aki spawn failed${code ? ` (${code})` : ''}`);
        }
      }

      counters.lastLatencyMs = ms;
      counters.toolsUsed += st2.toolCount;
      counters.lastTools = { ...st2.tools };
      if (err) {
        counters.lastErrorCode = err.code;
        if (err.code === 'ABORTED') counters.aborted++;
        else {
          counters.failed++;
          if (err.code === 'AKI_TIMEOUT') counters.timeouts++;
        }
      } else {
        counters.ok++;
        counters.lastErrorCode = null;
        notFound = false;
      }

      const toolList = Object.entries(st2.tools).map(([n, c]) => `${n}×${c}`).join(', ');
      const exitStr = kind === 'close' ? String(exitCode) : kind;
      _info(`[aki] ${job.requestId} exit=${exitStr} ${ms}ms text=${text.length}ch tools=${st2.toolCount}`
        + (toolList ? ` (${toolList})` : '')
        + (err ? ` err=${err.code}` : '')
        + (job.truncated ? ' [truncated]' : '')
        + (job.isolated ? ' [isolated]' : '')
        + ` stderr=${stderrBytes}b`);

      active--;
      if (err) job.reject(err); else job.resolve(value);
      _pump();
    }

    job.settle = (kind) => finish(kind);
    job.started = true;

    try { d.mkdirSync(cwd, { recursive: true }); } catch (_) {}
    try {
      proc = d.spawn(job.bin, job.args, {
        cwd,
        env: akiChildEnv(d.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (e) {
      proc = null;
      finish('error', e);
      return;
    }
    if (!proc) { finish('error', null); return; }
    if (proc.stdout) proc.stdout.on('data', onStdout);
    if (proc.stderr) proc.stderr.on('data', onStderr);
    proc.on('error', onError);
    proc.on('close', onClose);
    timer = d.setTimeout(() => finish('timeout'), cfg.timeoutMs);
  }

  return { ask, configure, available, load, stats, markState, reset };
}

module.exports = {
  createAkiLane,
  createStreamParser,
  parseStreamJson,
  buildArgs,
  winQuotedLength,
  cmdLineLength,
  cmdLineMax,
  fitPrompt,
  akiChildEnv,
  resolveAkiBin,
  AKI_CMDLINE_MAX,
  AKI_SANDBOX_DIRNAME,
  AKI_TRUNC_MARKER,
};
