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
const MODEL_ID    = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const REGION      = 'us-east-1';
const MAX_TOKENS  = 4096;
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
  await _acquireSlot();
  _requestCount++;

    // Preference: 'claude' -- skip Orcha entirely, go straight to Claude Code
  if (_aiPreference === 'claude') {
    try {
      const ccText = await _tryClaudeCode(prompt);
      if (ccText) {
        _lastHealthy = Date.now(); _status = 'connected-claude'; _releaseSlot(); _saveStatus();
        logger.info('OK via claude-code (preference=claude, ' + ccText.length + ' chars)');
        return ccText;
      }
    } catch (ccErr) { logger.warn('claude-code fast-path failed: ' + ccErr.message); }
    _lastError = 'Claude Code failed'; _status = 'error'; _errorCount++;
    _saveStatus(); _releaseSlot();
    throw new Error('Claude Code unavailable (preference=claude)');
  }

  // PRIMARY: Route through fleet-brain (persistent session with full fleet context).
  // fleet-brain.getStatus().ready is true in BOTH WS mode (Orcha running) AND
  // local mode (claude-code fallback wired in). Either way fleet-brain manages
  // the system prompt + rolling conversation history so every AI call is context-aware.
  try {
    const _fbStatus = fleetBrain.getStatus ? fleetBrain.getStatus() : {};
    if (!_fbStatus || !_fbStatus.ready) throw new Error('fleet-brain not ready');
    const text = await fleetBrain.ask(prompt);
    if (text) {
      const via = _fbStatus.localMode ? 'fleet-brain/local' : 'fleet-brain/ws';
      _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
      _releaseSlot();
      logger.info('OK via ' + via + ' (' + text.length + ' chars)');
      _saveStatus();
      return text;
    }
  } catch (brainErr) {
    logger.warn('Fleet-brain failed: ' + brainErr.message);
  }

  // FALLBACK: Direct WS (throwaway session, no context).
  // Skip entirely if fleet-brain already confirmed the WS endpoint is unreachable —
  // _tryWS hits the same URL and would just burn the full timeout for nothing.
  const _fbDown = !(fleetBrain.getStatus ? fleetBrain.getStatus().connected : false);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = _fbDown ? null : await _tryWS(prompt).catch(() => null);
      if (text) {
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        _releaseSlot();
        logger.info('OK via WS fallback (' + text.length + ' chars, attempt ' + attempt + ')');
        _saveStatus();
        return text;
      }
      const cliText = await _tryHeadless(prompt).catch(() => null);
      if (cliText) {
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        _releaseSlot();
        logger.info('OK via CLI fallback (' + cliText.length + ' chars)');
        _saveStatus();
        return cliText;
      }
      // Skip Claude Code fallback when preference is 'orcha'
      if (_aiPreference !== 'orcha') {
        // CLAUDE CODE FALLBACK: claude -p via Cecelia shared account
        try {
          logger.info('Trying claude-code fallback...');
          const ccText = await _tryClaudeCode(prompt);
          if (ccText) {
            _lastHealthy = Date.now(); _status = 'connected-claude';
            _saveStatus();
            logger.info('OK via claude-code fallback (' + ccText.length + ' chars)');
            return ccText;
          }
        } catch (ccErr) { logger.warn('claude-code fallback failed: ' + ccErr.message); }
      }

      // BEDROCK FALLBACK: direct Claude call via Bedrock SDK
      try {
        const { askBedrock } = require('../scrapers/bedrock');
        logger.info('Trying Bedrock fallback...');
        const brText = await askBedrock(prompt);
        if (brText) {
          _lastHealthy = Date.now(); _status = 'connected-bedrock';
          _saveStatus();
          return brText;
        }
      } catch (brErr) { logger.warn('Bedrock failed: ' + brErr.message); }
      throw new Error('All transports failed');
    } catch (e) {
      const msg = e.message || String(e);
      logger.warn('Fallback ERROR attempt ' + attempt + '/' + MAX_RETRIES + ': ' + msg);
      if (attempt < MAX_RETRIES) { await _sleep(2000); continue; }
      _lastError = msg; _status = 'error'; _errorCount++;
      _saveStatus(); _releaseSlot();
      throw new Error('Orcha AI failed: ' + msg);
    }
  }
  _releaseSlot();
  throw new Error('Max retries exhausted');
}
// ── WS TRANSPORT ─────────────────────────────────────────────────────────────
function _tryWS(prompt) {
  return new Promise((resolve, reject) => {
    const WebSocket = require('ws');
    const crypto    = require('crypto');
    const wsUrl     = getOrchaUrl();
    const sessionId = 'fleet_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const ws = new WebSocket(wsUrl);
    let fullText = '', resolved = false, timer = null;

    const done = (err, txt) => {
      if (resolved) return; resolved = true;
      clearTimeout(timer); try { ws.close(); } catch (_) {}
      err ? reject(err) : resolve(txt);
    };

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
function _tryHeadless(prompt) {
  return new Promise((resolve, reject) => {
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

    execFile(orchaPath, args, { maxBuffer: 1024 * 1024, timeout: TIMEOUT_MS, shell: process.platform === 'win32' }, (err, stdout, stderr) => {
      clearTimeout(timer);
      try { fs.unlinkSync(tmpFile); } catch (_) {}
      if (err) return reject(new Error('Headless error: ' + (err.message || stderr || 'unknown')));
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
const CLAUDE_TIMEOUT_MS = 60000;

// Persistent claude-code process (stream-json) -- avoids ~13s cold-start
// penalty on every call. First call after idle/spawn still pays startup cost;
// subsequent calls on the same warm process take ~2s (measured).
let _claudeProc = null;
let _claudeBusy = false;
let _claudeCurrentJob = null;
const _claudeQueue = [];
let _claudeStdoutBuf = '';
let _claudeIdleTimer = null;
const CLAUDE_IDLE_KILL_MS = 10 * 60 * 1000; // kill warm process after 10min idle

function _resetClaudeIdleTimer() {
  if (_claudeIdleTimer) clearTimeout(_claudeIdleTimer);
  _claudeIdleTimer = setTimeout(() => {
    if (_claudeProc && !_claudeBusy) {
      logger.info('claude-code: killing idle warm process (10min inactive)');
      _claudeProc.kill();
      _claudeProc = null;
    }
  }, CLAUDE_IDLE_KILL_MS);
}

function _failClaudeQueue(err) {
  if (_claudeCurrentJob) {
    clearTimeout(_claudeCurrentJob._timer);
    _claudeCurrentJob.reject(err);
    _claudeCurrentJob = null;
  }
  while (_claudeQueue.length) {
    const job = _claudeQueue.shift();
    job.reject(err);
  }
  _claudeBusy = false;
}

function _ensureClaudeProcess() {
  if (_claudeProc && !_claudeProc.killed) return;
  if (!fs.existsSync(CLAUDE_BIN)) {
    throw new Error('claude-code not installed — run: toolbox install claude-code');
  }
  logger.info('claude-code: spawning persistent process');
  // FIX (2026-07-23): Claude Code's default system prompt frames it as a
  // coding assistant with tools -- when relay callers (e.g. the AdaptiveWR
  // Submit-WR agent) ask for a strict machine-readable format ("respond with
  // ONLY a JSON array"), the default persona often answers in its own
  // shorthand instead (observed: 'TYPE [8] "B12267"' + newline + 'CLICK [9]'
  // instead of JSON). Downstream JSON.parse() then fails every single step,
  // the agent exhausts its retry budget, and falls back to "fill the wizard
  // in yourself" -- confirmed root cause of "Submit WR opens the right page
  // but the automated steps never run." --system-prompt replaces the default
  // persona for this spawned process with a strict headless-API framing so
  // it reliably obeys per-call formatting instructions (JSON, plain text,
  // etc.) instead of describing actions in its own style.
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
  _claudeStdoutBuf = '';

  proc.stdout.on('data', (chunk) => {
    _claudeStdoutBuf += chunk.toString();
    const lines = _claudeStdoutBuf.split('\n');
    _claudeStdoutBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj.type === 'result' && _claudeCurrentJob) {
        const job = _claudeCurrentJob;
        clearTimeout(job._timer);
        _claudeCurrentJob = null;
        _claudeBusy = false;
        if (obj.is_error) {
          job.reject(new Error('claude-code error: ' + (obj.result || 'unknown')));
        } else {
          const text = (obj.result || '').trim();
          if (!text) job.reject(new Error('claude-code returned empty'));
          else job.resolve(text);
        }
        _resetClaudeIdleTimer();
        _processClaudeQueue();
      }
    }
  });

  proc.stderr.on('data', (d) => logger.warn('claude-code stderr: ' + d.toString().slice(0, 300)));

  proc.on('exit', (code) => {
    logger.warn('claude-code: persistent process exited (code ' + code + ')');
    _claudeProc = null;
    _failClaudeQueue(new Error('claude-code process exited unexpectedly'));
  });

  proc.on('error', (e) => {
    logger.warn('claude-code: persistent process error: ' + e.message);
    _claudeProc = null;
    _failClaudeQueue(new Error('claude-code spawn error: ' + e.message));
  });

  _claudeProc = proc;
  _resetClaudeIdleTimer();
}

function _processClaudeQueue() {
  if (_claudeBusy || _claudeQueue.length === 0) return;
  const job = _claudeQueue.shift();
  _claudeCurrentJob = job;
  _claudeBusy = true;
  job._timer = setTimeout(() => {
    // FIX (2026-07-23): previously just freed the slot and moved on to the
    // next queued job while leaving the SAME warm process running -- if the
    // timed-out turn was still generating server-side and its "result"
    // arrived late, it got matched against whatever job was _claudeCurrentJob
    // by then (a totally unrelated caller), silently handing back the wrong
    // answer. Confirmed live: AdaptiveWR received repair-timeline text meant
    // for a background deep-scan call after one of its steps timed out.
    // Killing + nulling the process on timeout guarantees the stale turn can
    // never emit a response that gets misattributed -- costs one cold-start
    // on the next call, a fine trade for correctness.
    logger.warn('claude-code: job timed out -- killing process to avoid a stale/late response being misattributed to a later job');
    if (_claudeProc) { try { _claudeProc.kill(); } catch (_e) {} }
    _claudeProc = null;
    _claudeCurrentJob = null;
    _claudeBusy = false;
    job.reject(new Error('claude-code timeout'));
    _processClaudeQueue();
  }, CLAUDE_TIMEOUT_MS);
  try {
    // BUG FIX (2026-07-25): a timed-out job kills _claudeProc and sets it to
    // null, then calls _processClaudeQueue() again to move to the next queued
    // job -- but this function never re-spawned the process, it just assumed
    // _claudeProc was still alive and wrote straight to its stdin. That threw
    // "Cannot read properties of null (reading 'stdin')" for every job still
    // in the queue at that moment, instantly cascading the whole backlog to
    // failure instead of just the one job that actually timed out. Re-ensure
    // (spawn if needed) right before writing so each job gets a live process.
    _ensureClaudeProcess();
    const msg = { type: 'user', message: { role: 'user', content: job.prompt } };
    _claudeProc.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    clearTimeout(job._timer);
    _claudeCurrentJob = null;
    _claudeBusy = false;
    job.reject(new Error('claude-code stdin write failed: ' + e.message));
    _processClaudeQueue();
  }
}

function _tryClaudeCode(prompt) {
  return new Promise((resolve, reject) => {
    try {
      _ensureClaudeProcess();
    } catch (e) {
      return reject(e);
    }
    // FIX (2026-07-23): was hard-truncated to 8000 chars, which silently cut off
    // the tail of any longer prompt -- including the final "RESPOND WITH ONLY
    // JSON" formatting instruction on AdaptiveWR's buildPrompt() (~11000 chars
    // with WIZARD_KNOWLEDGE + lessons), and likely the second vendor-conversation
    // block appended in deep-scan.js's dual-WR timeline prompt too. Claude models
    // handle far more context than this; raised to a generous ceiling that only
    // guards against truly pathological input, not normal feature prompts.
    const CLAUDE_PROMPT_MAX_CHARS = 60000;
    const trimmed = prompt.length > CLAUDE_PROMPT_MAX_CHARS ? prompt.slice(0, CLAUDE_PROMPT_MAX_CHARS) + '...[trimmed]' : prompt;
    _claudeQueue.push({ prompt: trimmed, resolve, reject });
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
    }
  } catch (_) {}
})();

module.exports = { ask, healthCheck, getStatus, runMwinit, refreshCredentials, setPreference, getPreference, testClaude };
