'use strict';
/**
 * relay.js Ã¢â‚¬â€ Orcha AI Relay [V-C]
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
// Initialize fleet-brain connection on module load
// fleet-brain init disabled — direct WS is the primary transport

// Ã¢â€â‚¬Ã¢â€â‚¬ CONFIG Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
const MODEL_ID    = 'us.anthropic.claude-sonnet-4-20250514-v1:0';
const REGION      = 'us-east-1';
const MAX_TOKENS  = 4096;
const TIMEOUT_MS  = 120000;
const MAX_RETRIES = 2;

// Ã¢â€â‚¬Ã¢â€â‚¬ ORCHA URL Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ STATE Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
let _lastHealthy  = null;
let _lastError    = null;
let _status       = 'unknown'; // 'connected' | 'expired' | 'error' | 'unknown'
let _requestCount = 0;
let _errorCount   = 0;
let _aiPreference = 'auto'; // 'auto' | 'orcha' | 'claude'

// Ã¢â€â‚¬Ã¢â€â‚¬ CONCURRENCY Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ ASK Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  // PRIMARY: Route through fleet-brain (persistent session with full context)
  try {
    // Skip fleet-brain if not connected
    const _fbStatus = fleetBrain.getStatus ? fleetBrain.getStatus() : {};
    if (!_fbStatus || !_fbStatus.connected) throw new Error("fleet-brain not connected");
    const text = await fleetBrain.ask(prompt);
    if (text) {
      _lastHealthy = Date.now(); _lastError = null; _status = 'connected';
      _releaseSlot();
      logger.info('OK via fleet-brain (' + text.length + ' chars)');
      _saveStatus();
      return text;
    }
  } catch (brainErr) {
    logger.warn('Fleet-brain failed: ' + brainErr.message + ' -- falling back to direct WS');
    logger.info('[relay] WS URL will be: ' + getOrchaUrl());
  }

  // FALLBACK: Direct WS (throwaway session, no context)
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const text = await _tryWS(prompt).catch(() => null);
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
// Ã¢â€â‚¬Ã¢â€â‚¬ WS TRANSPORT Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ HEADLESS CLI Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

function _tryClaudeCode(prompt) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(CLAUDE_BIN)) {
      return reject(new Error('claude-code not installed — run: toolbox install claude-code'));
    }
    // Trim prompt to practical CLI limit
    const trimmed = prompt.length > 8000 ? prompt.slice(0, 8000) + '...[trimmed]' : prompt;
    const timer = setTimeout(() => reject(new Error('claude-code timeout')), CLAUDE_TIMEOUT_MS);
    execFile(
      CLAUDE_BIN,
      ['-p', trimmed],
      { maxBuffer: 2 * 1024 * 1024, timeout: CLAUDE_TIMEOUT_MS },
      (err, stdout, stderr) => {
        clearTimeout(timer);
        if (err) return reject(new Error('claude-code error: ' + (err.message || stderr || 'unknown')));
        const text = (stdout || '').trim();
        if (!text) return reject(new Error('claude-code returned empty'));
        resolve(text);
      }
    );
  });
}


// Ã¢â€â‚¬Ã¢â€â‚¬ HEALTH Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ MWINIT Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ HELPERS Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ LOAD SAVED STATUS Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
