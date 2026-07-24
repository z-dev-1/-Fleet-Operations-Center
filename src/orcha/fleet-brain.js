'use strict';
/**
 * fleet-brain.js — Persistent Orcha Brain for Fleet Operations
 *
 * This module creates and maintains a SINGLE persistent Orcha session
 * that has full fleet context. All AI calls from the app route through here.
 *
 * Instead of throwaway sessions with zero context, this:
 *   1. Maintains ONE long-running session with Orcha
 *   2. Injects a fleet system prompt so Orcha knows the fleet state
 *   3. Accumulates context across calls (Orcha remembers prior analysis)
 *   4. Shares the session with the chat panel (same conversation thread)
 *
 * This is the difference between "dumb AI relay" and "Orcha running your fleet."
 */

const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { P }     = require('../config/paths');
const store     = require('../store');
const logger    = require('../utils/logger')('fleet-brain');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const TIMEOUT_MS        = 10000;  // 10s - fail fast, Bedrock fallback handles the rest  // 2 min for complex fleet analysis
const SESSION_FILE      = P.chatSessionId;  // shared with chat panel
const SESSION_MAX_AGE   = 8 * 60 * 60 * 1000;  // 8h before refresh
const AGENT_ID          = 'orcha_default';  // TODO: create fleet-specific agent
const RECONNECT_DELAY   = 3000;
const MAX_QUEUE         = 50;

// ─── STATE ──────────────────────────────────────────────────────────────────
let _sessionId    = null;
let _sessionTs    = 0;
let _ws           = null;
let _connected    = false;
let _ready        = false;  // true after session created/loaded
let _queue        = [];     // pending requests while connecting
let _activeReq    = null;   // current in-flight request
let _requestCount = 0;
let _lastActivity = null;
let _failCount    = 0;        // consecutive WS failures — drives exponential backoff

// ─── FLEET SYSTEM CONTEXT ───────────────────────────────────────────────────
function _buildSystemContext() {
  // Build a rich context from live fleet data so Orcha knows the current state
  let fleetSummary = '';
  try {
    const data = store.load('fleetData', null);
    if (data && data.rows) {
      const total = data.rows.length;
      const unavail = data.rows.filter(r => /unavailable/i.test(r.atsState || r.lifecycleState || ''));
      const vendors = {};
      unavail.forEach(r => {
        const v = r.vendor || 'Unknown';
        vendors[v] = (vendors[v] || 0) + 1;
      });
      const vendorStr = Object.entries(vendors)
        .sort((a, b) => b[1] - a[1])
        .map(([v, c]) => `${v}(${c})`)
        .join(', ');

      fleetSummary = `\nFLEET STATE: ${total} total units | ${unavail.length} unavailable | Vendors: ${vendorStr}`;
      fleetSummary += `\nLast sync: ${data.syncedAt || 'unknown'}`;
    }
  } catch (_) {}

  return `You are Orcha — the AI brain powering Fleet Operations Center v3.
You are INTEGRATED into this fleet management app. You are not a generic assistant.

YOUR ROLE:
- You manage a CNG fleet at ABE40/EWR45/PHL40/AVP40 domiciles
- You monitor ~160 units, track repairs, generate notes, detect issues
- You communicate with the Fleet Asset Specialist who operates this app
- You proactively identify problems and suggest actions

YOUR RULES FOR WORK ORDER NOTES:
- Single sentence, 18-40 words preferred, 60 max
- Date format: MM/DD
- Professional fleet terminology
- NO personal names, phone numbers, emails, dollar amounts, VINs, license plates
- Vendor names OK (Amerit, Freightliner, Volvo, PACCAR, Peterbilt, etc.)
- "Tech" allowed instead of real names

YOUR RULES FOR CLASSIFICATION:
- Use standard VMRS codes for RCA
- Primary Component, Technician Failure Code, Primary Cause Code, Work Accomplished Code
- Maintenance Code: PM (preventive), UM (unscheduled), MOD (modification)
- Controllable: Y/N
${fleetSummary}

RESPOND CONCISELY. You are an operational tool, not a chatbot. Facts over filler.`;
}

// ─── PORT RESOLUTION ────────────────────────────────────────────────────────
function _getWsUrl() {
  try {
    if (fs.existsSync(P.orchaConfig)) {
      const cfg = JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      if (cfg.mode === 'remote' && cfg.host) return `ws://${cfg.host}:${cfg.port || 4799}`;
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(P.orchaPort, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0) return `ws://localhost:${port}`;
  } catch (_) {}
  return 'ws://localhost:4799';
}

// ─── SESSION MANAGEMENT ─────────────────────────────────────────────────────
function _loadSession() {
  try {
    const saved = fs.readFileSync(SESSION_FILE, 'utf8').trim();
    if (saved && saved.startsWith('ct_')) {
      const stat = fs.statSync(SESSION_FILE);
      if (Date.now() - stat.mtimeMs > SESSION_MAX_AGE) {
        logger.info('Saved session expired (>8h) — will create new');
        try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
        return null;
      }
      _sessionTs = stat.mtimeMs;
      return saved;
    }
  } catch (_) {}
  return null;
}

function _saveSession(sid) {
  _sessionId = sid;
  _sessionTs = Date.now();
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, sid);
  } catch (_) {}
}

// ─── CONNECTION ─────────────────────────────────────────────────────────────
function connect() {
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = _getWsUrl();
  logger.info('Connecting to Orcha at ' + url + '...');

  try {
    _ws = new WebSocket(url);
  } catch (e) {
    logger.warn('WS constructor error: ' + e.message);
    _scheduleReconnect();
    return;
  }

  _ws.on('open', () => {
    _failCount = 0;
    logger.info('WS open — waiting for connected signal');
  });

  _ws.on('error', (err) => {
    _failCount++;
    // After 5 consecutive failures Orcha WS is clearly not running — log at INFO
    // so the log stays clean while the app happily uses Claude Code / Bedrock instead.
    const logFn = _failCount <= 5 ? 'warn' : 'info';
    logger[logFn]('WS error (attempt ' + _failCount + '): ' + (err.message || 'unknown'));
    _connected = false;
    _ready = false;
  });

  _ws.on('close', () => {
    logger.info('WS closed');
    _connected = false;
    _ready = false;
    _ws = null;
    // Reject active request if any
    if (_activeReq) {
      _activeReq.reject(new Error('WS closed'));
      _activeReq = null;
    }
    _scheduleReconnect();
  });

  _ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    _handleMessage(msg);
  });
}

function _scheduleReconnect() {
  // Exponential backoff: 3s → 6s → 12s → ... capped at 5 min.
  // Once Orcha WS is clearly absent the app runs fine on Claude Code / Bedrock,
  // so hammering reconnects every 3s just pollutes logs for no benefit.
  const delay = Math.min(RECONNECT_DELAY * Math.pow(2, Math.max(0, _failCount - 1)), 5 * 60 * 1000);
  setTimeout(() => {
    if (!_ws || _ws.readyState === WebSocket.CLOSED) {
      connect();
    }
  }, delay);
}

function _handleMessage(msg) {
  switch (msg.type) {
    case 'connected':
      _connected = true;
      logger.info('Orcha server connected');
      // Load or create session
      _sessionId = _loadSession();
      if (_sessionId) {
        _ws.send(JSON.stringify({ type: 'load_session', session_id: _sessionId }));
      } else {
        _ws.send(JSON.stringify({
          type: 'create_session',
          title: 'Fleet Operations Brain',
          agent_id: AGENT_ID,
          system_prompt: _buildSystemContext(),
        }));
      }
      break;

    case 'session_loaded':
      _sessionId = msg.session_id || _sessionId;
      _ready = true;
      logger.info('Session restored: ' + _sessionId);
      _drainQueue();
      break;

    case 'session_created':
      _saveSession(msg.session_id || msg.sessionId);
      _ready = true;
      logger.info('New session created: ' + _sessionId);
      // Send system context as first message so Orcha knows who it is
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({
          type: 'send_message',
          session_id: _sessionId,
          message: '[SYSTEM CONTEXT - DO NOT RESPOND TO THIS, JUST ABSORB]\n\n' + _buildSystemContext(),
          images: [],
        }));
        // Don't wait for response — it will come as message_complete, just ignore it
        // The REAL first request will come from the queue
      }
      _drainQueue();
      break;

    case 'error':
      if (msg.request_type === 'load_session') {
        logger.info('Session not found — creating new');
        _sessionId = null;
        _ws.send(JSON.stringify({
          type: 'create_session',
          title: 'Fleet Operations Brain',
          agent_id: AGENT_ID,
        }));
      } else if (_activeReq) {
        _activeReq.reject(new Error(msg.error || 'Orcha error'));
        _activeReq = null;
        _processNext();
      }
      break;

    case 'text_delta':
      if (_activeReq) {
        _activeReq.text += (msg.delta || msg.content || msg.text || '');
      }
      break;

    case 'message_complete':
      if (_activeReq) {
        const text = _activeReq.text;
        _activeReq.resolve(text);
        _activeReq = null;
        _lastActivity = Date.now();
        _processNext();
      }
      break;
  }
}

// ─── REQUEST QUEUE ──────────────────────────────────────────────────────────
function _drainQueue() {
  if (_queue.length > 0 && !_activeReq) {
    _processNext();
  }
}

function _processNext() {
  if (_queue.length === 0 || _activeReq) return;
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return;

  const req = _queue.shift();
  _activeReq = req;

  // Check timeout
  if (Date.now() - req.createdAt > TIMEOUT_MS) {
    req.reject(new Error('Request timed out in queue'));
    _activeReq = null;
    _processNext();
    return;
  }

  _ws.send(JSON.stringify({
    type: 'send_message',
    session_id: _sessionId,
    message: req.prompt,
    images: [],
  }));

  // Set response timeout
  req.timer = setTimeout(() => {
    if (_activeReq === req) {
      req.reject(new Error('Response timeout'));
      _activeReq = null;
      _processNext();
    }
  }, TIMEOUT_MS);
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

/**
 * ask(prompt) — Send a prompt to the fleet brain, get text response.
 * Queues if not connected yet. Uses persistent session with full fleet context.
 */
function ask(prompt) {
  _requestCount++;
  return new Promise((resolve, reject) => {
    if (_queue.length >= MAX_QUEUE) {
      return reject(new Error('Fleet brain queue full'));
    }

    const req = {
      prompt,
      text: '',
      timer: null,
      createdAt: Date.now(),
      resolve: (text) => {
        clearTimeout(req.timer);
        resolve(text);
      },
      reject: (err) => {
        clearTimeout(req.timer);
        reject(err);
      },
    };

    _queue.push(req);

    // Ensure connected
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
      connect();
    } else if (_ready) {
      _drainQueue();
    }
  });
}

/**
 * chat(prompt) — Same as ask() but explicitly for the chat panel.
 * Uses the same persistent session so chat and automation share context.
 */
function chat(prompt) {
  return ask(prompt);
}

/**
 * getSessionId() — Returns current session ID (for chat panel sync)
 */
function getSessionId() { return _sessionId; }

/**
 * getStatus() — Connection health
 */
function getStatus() {
  return {
    connected: _connected,
    ready: _ready,
    sessionId: _sessionId,
    queueLength: _queue.length,
    requestCount: _requestCount,
    lastActivity: _lastActivity,
    wsState: _ws ? _ws.readyState : -1,
  };
}

/**
 * resetSession() — Force new session (clear context)
 */
function resetSession() {
  _sessionId = null;
  _ready = false;
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({
      type: 'create_session',
      title: 'Fleet Operations Brain',
      agent_id: AGENT_ID,
    }));
  }
  logger.info('Session reset — next call creates fresh context');
}

/**
 * init() — Start the persistent connection. Call once at app startup.
 */
function init() {
  connect();
}

module.exports = { init, ask, chat, getSessionId, getStatus, resetSession };
