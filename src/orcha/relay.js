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

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await _tryWS(prompt).catch(() => null);
      if (text) {
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        _releaseSlot();
        logger.info(`OK via WS (${text.length} chars, attempt ${attempt})`);
        _saveStatus();
        return text;
      }

      const cliText = await _tryHeadless(prompt);
      if (cliText) {
        _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
        _releaseSlot();
        logger.info(`OK via CLI (${cliText.length} chars)`);
        _saveStatus();
        return cliText;
      }

      throw new Error('Both WS and CLI returned empty');

    } catch (e) {
      const msg = e.message || String(e);
      logger.warn(`ERROR attempt ${attempt}/${MAX_RETRIES}: ${msg}`);
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

    timer = setTimeout(() => done(new Error('WS timeout')), Math.min(TIMEOUT_MS, 8000));
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
        case 'text_delta':       fullText += (msg.delta || msg.content || msg.text || ''); break;
        case 'message_complete': done(null, fullText); break;
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
function runMwinit() {
  return new Promise(resolve => {
    logger.info('Launching mwinit...');
    let child;
    if (process.platform === 'win32') {
      child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', 'mwinit -o'], { detached: true, stdio: 'ignore', shell: true });
    } else {
      child = spawn('open', ['-a', 'Terminal', '--args', 'bash', '-c', 'mwinit -o; exec bash'], { detached: true, stdio: 'ignore' });
    }
    child.unref();
    setTimeout(() => {
      _status = 'unknown'; _lastError = null; _saveStatus();
      logger.info('mwinit launched — client reset for fresh credentials');
      resolve({ ok: true, message: 'mwinit launched — complete auth in terminal window' });
    }, 2000);
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

module.exports = { ask, healthCheck, getStatus, runMwinit, refreshCredentials };
