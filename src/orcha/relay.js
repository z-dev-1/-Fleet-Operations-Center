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

const fleetBrain = require('./fleet-brain');
// Wire fleet-brain's local fallback AFTER _tryClaudeCode is defined below.
// setImmediate defers to end-of-tick so the function reference is valid.
setImmediate(() => {
  fleetBrain.setLocalAskFn((prompt) => _tryClaudeCode(prompt));
  logger.info('fleet-brain local AI fallback wired to claude-code');
});

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
let _aiPreference = 'auto'; // 'auto' | 'orcha' | 'claude'

// ── CONCURRENCY ───────────────────────────────────────────────────────────────
const MAX_CONCURRENT = 5;
let _activeCount = 0;
const _waitQueue = [];
let _reqSeq = 0;

function _acquireSlot() {
  return new Promise(resolve => {
    if (_activeCount < MAX_CONCURRENT) { _activeCount++; resolve(); }
    else _waitQueue.push(resolve);
  });
}
function _releaseSlot() {
  _activeCount--;
  if (_waitQueue.length > 0 && _activeCount < MAX_CONCURRENT) { _activeCount++; _waitQueue.shift()(); }
}

// ── ASK ───────────────────────────────────────────────────────────────────────
async function ask(prompt, opts = {}) {
  const signal = opts.signal;
  const requestId = opts.requestId || ('rl' + (++_reqSeq));
  if (signal && signal.aborted) throw new Error('Aborted before start');

  await _acquireSlot();
  _requestCount++;
  logger.info('[' + requestId + '] relay.ask started');

  try {
    // Preference: 'claude' -- skip Orcha entirely, go straight to Claude Code
    if (_aiPreference === 'claude') {
      try {
        const ccText = await _tryClaudeCode(prompt, { signal, requestId });
        if (ccText) {
          _lastHealthy = Date.now(); _status = 'connected-claude'; _saveStatus();
          logger.info('[' + requestId + '] OK via claude-code (preference=claude, ' + ccText.length + ' chars)');
          return ccText;
        }
      } catch (ccErr) { logger.warn('[' + requestId + '] claude-code fast-path failed: ' + ccErr.message); }
      _lastError = 'Claude Code failed'; _status = 'error'; _errorCount++;
      _saveStatus();
      throw new Error('Claude Code unavailable (preference=claude)');
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
      const text = await fleetBrain.ask(prompt, { signal, requestId });
      if (text) {
        const via = _fbStatus.localMode ? 'fleet-brain/local' : 'fleet-brain/ws';
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        logger.info('[' + requestId + '] OK via ' + via + ' (' + text.length + ' chars)');
        _saveStatus();
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
        const text = _fbDown ? null : await _tryWS(prompt, { signal }).catch(() => null);
        if (text) {
          _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
          logger.info('[' + requestId + '] OK via WS fallback (' + text.length + ' chars, attempt ' + attempt + ')');
          _saveStatus();
          return text;
        }
        logger.info('[' + requestId + '] CLI attempt ' + attempt);
        const cliText = await _tryHeadless(prompt, { signal }).catch(() => null);
        if (cliText) {
          _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
          logger.info('[' + requestId + '] OK via CLI fallback (' + cliText.length + ' chars)');
          _saveStatus();
          return cliText;
        }
        // Skip Claude Code fallback when preference is 'orcha'
        if (_aiPreference !== 'orcha') {
          // CLAUDE CODE FALLBACK: claude -p via Cecelia shared account
          try {
            logger.info('[' + requestId + '] Claude Code attempt ' + attempt);
            const ccText = await _tryClaudeCode(prompt, { signal, requestId });
            if (ccText) {
              _lastHealthy = Date.now(); _status = 'connected-claude';
              _saveStatus();
              logger.info('[' + requestId + '] OK via claude-code fallback (' + ccText.length + ' chars)');
              return ccText;
            }
          } catch (ccErr) { logger.warn('[' + requestId + '] claude-code fallback failed: ' + ccErr.message); }
        }

        // BEDROCK FALLBACK: direct Claude call via Bedrock SDK
        try {
          const { askBedrock } = require('../scrapers/bedrock');
          logger.info('[' + requestId + '] Bedrock attempt ' + attempt);
          const brText = await askBedrock(prompt);
          if (brText) {
            _lastHealthy = Date.now(); _status = 'connected-bedrock';
            _saveStatus();
            logger.info('[' + requestId + '] OK via Bedrock fallback (' + brText.length + ' chars)');
            return brText;
          }
        } catch (brErr) { logger.warn('[' + requestId + '] Bedrock failed: ' + brErr.message); }
        throw new Error('All transports failed');
      } catch (e) {
        const msg = e.message || String(e);
        logger.warn('[' + requestId + '] Fallback ERROR attempt ' + attempt + '/' + MAX_RETRIES + ': ' + msg);
        if (signal && signal.aborted) throw new Error('Aborted');
        if (attempt < MAX_RETRIES) { await _sleep(2000); continue; }
        _lastError = msg; _status = 'error'; _errorCount++;
        _saveStatus();
        throw new Error('Orcha AI failed: ' + msg);
      }
    }
    throw new Error('Max retries exhausted');
  } finally {
    // Single, unconditional cleanup point -- every return/throw path above
    // (success at any tier, every-tier-failed, aborted) funnels through here
    // exactly once, so the concurrency slot can never be double-released or
    // leaked no matter how many exit paths get added later.
    _releaseSlot();
    logger.info('[' + requestId + '] relay.ask cleanup completed -- slot released');
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
          ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet AI', agent_id: 'orcha_default', session_id: sessionId }));
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

// ── HEADLESS CLI ─────────────────────────────────────────────────────────────
function _tryHeadless(prompt, opts = {}) {
  const signal = opts.signal;
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Aborted before start'));
    const orchaPath = process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'bin', 'orcha.cmd')
      : path.join(os.homedir(), '.toolbox', 'bin', 'orcha');

    const tmpFile = path.join(P.dataDir, '_headless_prompt.txt');
    try {
      fs.mkdirSync(P.dataDir, { recursive: true });
      fs.writeFileSync(tmpFile, prompt, 'utf8');
    } catch (e) { return reject(new Error('Failed to write temp prompt: ' + e.message)); }

    const args  = ['--headless', '--agent', 'orcha_default', '--prompt-file', tmpFile];
    const timer = setTimeout(() => reject(new Error('Headless timeout')), TIMEOUT_MS);

    // Node's execFile accepts a native AbortSignal via options.signal (v15.7+):
    // aborting kills the child process for us, which is exactly what a
    // caller-triggered cancellation needs here.
    const execOpts = { maxBuffer: 1024 * 1024, timeout: TIMEOUT_MS, shell: process.platform === 'win32' };
    if (signal) execOpts.signal = signal;

    execFile(orchaPath, args, execOpts, (err, stdout, stderr) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (err) {
        const msg = (signal && signal.aborted) ? 'Aborted by caller' : ('Headless error: ' + (err.message || stderr || 'unknown'));
        return reject(new Error(msg));
      }
      const text = (stdout || '').trim();
      if (!text) return reject(new Error('Headless returned empty'));
      resolve(text);
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

// 3-worker pool — lets up to 3 concurrent AI calls run in parallel.
// When DM poll, WR autofill, and long-dwell fill all fire at once, each gets
// its own Claude Code process instead of queuing behind the others.
// Kill-after-job is preserved per worker (prevents context bleed across
// unrelated callers — same correctness guarantee as the old single-worker design).
const WORKER_POOL_SIZE = 3;
const CLAUDE_IDLE_KILL_MS = 10 * 60 * 1000; // kill warm process after 10min idle
function _makeWorker(id) {
  return { id, proc: null, busy: false, currentJob: null, stdoutBuf: '', idleTimer: null };
}
const _workers = Array.from({ length: WORKER_POOL_SIZE }, (_, i) => _makeWorker(i));
const _claudeQueue = [];

// Windows-safe process-tree kill. Node's proc.kill() only terminates the
// immediate handle; on Windows the Toolbox claude.exe spawns child workers
// that survive, accumulating as zombies over time. taskkill /F /T kills the
// entire tree. Falls back to proc.kill() on non-Windows.
function _killClaudeTree(proc) {
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
  if (!fs.existsSync(CLAUDE_BIN)) {
    throw new Error('claude-code not installed — run: toolbox install claude-code');
  }
  logger.info('claude-code[' + worker.id + ']: spawning process');
  // --system-prompt: override default coding-assistant persona with a strict
  // headless-API framing so all callers get reliable JSON/plain-text output
  // without explanations or markdown fences (see original rationale above).
  const proc = spawn(
    CLAUDE_BIN,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
     '--verbose', '--no-session-persistence',
     '--system-prompt',
     'You are a headless automation API, not an interactive coding assistant. ' +
     'Every message you receive contains its own complete formatting instructions ' +
     '(e.g. "respond with only a JSON array"). Follow those instructions exactly and ' +
     'output nothing else -- no explanations, no markdown code fences, no tool calls, ' +
     'no restating the request. If a message asks for JSON, your entire response must ' +
     'be valid JSON and nothing more.'],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  worker.stdoutBuf = '';

  proc.stdout.on('data', (chunk) => {
    worker.stdoutBuf += chunk.toString();
    const lines = worker.stdoutBuf.split('\n');
    worker.stdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj.type === 'result' && worker.currentJob) {
        const job = worker.currentJob;
        clearTimeout(job._timer);
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

  proc.stderr.on('data', (d) => logger.warn('claude-code[' + worker.id + '] stderr: ' + d.toString().slice(0, 300)));

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
    job._timer = setTimeout(() => {
      // Kill-on-timeout: prevents a stale/late response being matched to a
      // later job on the same worker (same correctness guarantee as before).
      logger.warn('claude-code[' + worker.id + ']: job timed out — killing process');
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
    const job = { prompt: trimmed, signal, onAbort: null, done: false };
    job.resolve = (text) => { if (job.done) return; job.done = true; if (signal && job.onAbort) { try { signal.removeEventListener('abort', job.onAbort); } catch (_) {} } resolve(text); };
    job.reject  = (err)  => { if (job.done) return; job.done = true; if (signal && job.onAbort) { try { signal.removeEventListener('abort', job.onAbort); } catch (_) {} } reject(err); };
    if (signal) {
      job.onAbort = () => _abortClaudeJob(job);
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    _claudeQueue.push(job);
    _processClaudeQueue();
  });
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
  return { status: _status, lastHealthy: _lastHealthy, lastError: _lastError, requestCount: _requestCount, errorCount: _errorCount, model: MODEL_ID, region: REGION };
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
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

function setPreference(pref) {
  const valid = ['auto', 'orcha', 'claude'];
  _aiPreference = valid.includes(pref) ? pref : 'auto';
  logger.info('AI preference set to: ' + _aiPreference);
}
function getPreference() { return _aiPreference; }

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
      if (cfg && cfg.claudeTimeoutMs > 0) CLAUDE_TIMEOUT_MS = cfg.claudeTimeoutMs;
    }
  } catch (_) {}
})();

module.exports = { ask, healthCheck, getStatus, runMwinit, refreshCredentials, setPreference, getPreference, setClaudeTimeout, testClaude };
