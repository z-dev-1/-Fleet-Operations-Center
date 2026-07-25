'use strict';
/**
 * fleet-brain.js — Persistent Orcha Brain for Fleet Operations
 *
 * Maintains ONE long-running AI session with full fleet context.
 * All AI calls from the app route through here.
 *
 * Two modes:
 *   WS mode   — Orcha server is running at ws://localhost:4799.
 *               Uses a real server-side session with streaming.
 *   Local mode — Orcha server is absent. Simulates persistence by
 *               injecting the fleet system context + rolling conversation
 *               history into every prompt, then routing through whatever
 *               AI provider relay.js has working (Claude Code, Bedrock…).
 *               Set via setLocalAskFn() — called by relay.js at init.
 *
 * The caller (relay.js) checks getStatus().ready — true in both modes.
 */

const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { P }     = require('../config/paths');
const store     = require('../store');
const logger    = require('../utils/logger')('fleet-brain');

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const TIMEOUT_MS        = 10000;
const SESSION_FILE      = P.chatSessionId;
const SESSION_MAX_AGE   = 8 * 60 * 60 * 1000;
const AGENT_ID          = 'orcha_default';
const RECONNECT_DELAY   = 3000;
const MAX_QUEUE         = 50;
// After this many consecutive WS failures, stop trying Orcha and switch to
// local mode. Reset and retry Orcha after RETRY_WS_AFTER_MS.
const WS_GIVE_UP_AFTER  = 6;
const RETRY_WS_AFTER_MS = 15 * 60 * 1000; // 15 min

// ─── LOCAL AI FALLBACK ───────────────────────────────────────────────────────
// relay.js calls setLocalAskFn(fn) at startup so fleet-brain can route through
// claude-code (or Bedrock) when Orcha WS isn't available. The fn receives a
// fully-formed prompt string and returns a Promise<string>.
let _localAskFn   = null;
let _wsGaveUp     = false;        // true after WS_GIVE_UP_AFTER failures
let _localHistory = [];           // rolling conversation history
const MAX_HISTORY_TURNS  = 12;    // 6 exchanges
const MAX_HISTORY_CHARS  = 8000;  // trim oldest turns if total chars exceeds this

/**
 * Wire in the fallback AI function. Called by relay.js once _tryClaudeCode
 * is defined there, so fleet-brain doesn't need to require relay itself.
 */
function setLocalAskFn(fn) {
  _localAskFn = fn;
  logger.info('Local AI fallback registered — fleet-brain ready in local mode');
}

function _trimHistory() {
  // Keep at most MAX_HISTORY_TURNS entries
  while (_localHistory.length > MAX_HISTORY_TURNS) _localHistory.shift();
  // Keep total history under MAX_HISTORY_CHARS by dropping oldest exchanges
  while (_localHistory.length >= 2) {
    const total = _localHistory.reduce((s, m) => s + m.content.length, 0);
    if (total <= MAX_HISTORY_CHARS) break;
    _localHistory.splice(0, 2); // drop oldest user+assistant pair
  }
}

function _buildLocalPrompt(userPrompt) {
  const sys = _buildSystemContext();
  let hist = '';
  if (_localHistory.length > 0) {
    hist = '\n\n[CONVERSATION HISTORY \u2014 use for context only]\n' +
      _localHistory
        .map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + m.content)
        .join('\n');
  }
  return sys + hist + '\n\n[CURRENT MESSAGE]\n' + userPrompt;
}

async function _localAsk(prompt) {
  if (!_localAskFn) throw new Error('fleet-brain: no local AI function — call setLocalAskFn() first');
  const fullPrompt = _buildLocalPrompt(prompt);
  const response   = await _localAskFn(fullPrompt);
  // Accumulate history for next call
  _localHistory.push({ role: 'user',      content: prompt   });
  _localHistory.push({ role: 'assistant', content: response });
  _trimHistory();
  return response;
}

// ─── STATE ──────────────────────────────────────────────────────────────────
let _sessionId    = null;
let _sessionTs    = 0;
let _ws           = null;
let _connected    = false;
let _ready        = false;
let _queue        = [];
let _activeReq    = null;
let _requestCount = 0;
let _lastActivity = null;
let _failCount    = 0;

// ─── FLEET SYSTEM CONTEXT ───────────────────────────────────────────────────
function _buildSystemContext() {
  let fleetSummary = '';
  try {
    const data = store.load('fleetData', null);
    if (data && data.rows) {
      const total   = data.rows.length;
      const unavail = data.rows.filter(r => /unavailable/i.test(r.atsState || r.lifecycleState || ''));
      const vendors = {};
      unavail.forEach(r => { const v = r.vendor || 'Unknown'; vendors[v] = (vendors[v] || 0) + 1; });
      const vendorStr = Object.entries(vendors).sort((a, b) => b[1] - a[1]).map(([v, c]) => v + '(' + c + ')').join(', ');
      fleetSummary = '\nFLEET STATE: ' + total + ' total units | ' + unavail.length + ' unavailable | Vendors: ' + vendorStr;
      fleetSummary += '\nLast sync: ' + (data.syncedAt || 'unknown');
    }
  } catch (_) {}

  return 'You are Orcha — the AI brain powering Fleet Operations Center v3.\n' +
    'You are INTEGRATED into this fleet management app. You are not a generic assistant.\n\n' +
    'YOUR ROLE:\n' +
    '- You manage a CNG fleet at ABE40/EWR45/PHL40/AVP40 domiciles\n' +
    '- You monitor ~160 units, track repairs, generate notes, detect issues\n' +
    '- You communicate with the Fleet Asset Specialist who operates this app\n' +
    '- You proactively identify problems and suggest actions\n\n' +
    'YOUR RULES FOR WORK ORDER NOTES:\n' +
    '- Single sentence, 18-40 words preferred, 60 max\n' +
    '- Date format: MM/DD\n' +
    '- Professional fleet terminology\n' +
    '- NO personal names, phone numbers, emails, dollar amounts, VINs, license plates\n' +
    '- Vendor names OK (Amerit, Freightliner, Volvo, PACCAR, Peterbilt, etc.)\n' +
    '- "Tech" allowed instead of real names\n\n' +
    'YOUR RULES FOR CLASSIFICATION:\n' +
    '- Use standard VMRS codes for RCA\n' +
    '- Primary Component, Technician Failure Code, Primary Cause Code, Work Accomplished Code\n' +
    '- Maintenance Code: PM (preventive), UM (unscheduled), MOD (modification)\n' +
    '- Controllable: Y/N\n' +
    fleetSummary + '\n\n' +
    'RESPOND CONCISELY. You are an operational tool, not a chatbot. Facts over filler.';
}

// ─── PORT RESOLUTION ────────────────────────────────────────────────────────
function _getWsUrl() {
  try {
    if (fs.existsSync(P.orchaConfig)) {
      const cfg = JSON.parse(fs.readFileSync(P.orchaConfig, 'utf8'));
      if (cfg.mode === 'remote' && cfg.host) return 'ws://' + cfg.host + ':' + (cfg.port || 4799);
    }
  } catch (_) {}
  try {
    const raw = fs.readFileSync(P.orchaPort, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0) return 'ws://localhost:' + port;
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
// orcha_config.json mode:"local" means "auto-detect Orcha running on THIS
// machine" (the normal case whenever the user has the Orcha desktop app open)
// -- it is NOT a signal that no server will ever be there. So we always
// attempt the WS connection. The problem this used to cause was purely about
// SPEED of detecting "Orcha isn't open right now": on this machine a refused
// connection can hang at the TCP level for a long time before erroring, so a
// single failed attempt could block real answers for minutes. Fix: give each
// connect() attempt a short explicit timeout (CONNECT_TIMEOUT_MS) and force-fail
// it via ws.terminate() if it hasn't opened by then, instead of waiting on the OS.
const CONNECT_TIMEOUT_MS = 3000;

function connect() {
  // Don't attempt WS if we already gave up — local mode handles calls until retry window
  if (_wsGaveUp) return;
  if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;

  const url = _getWsUrl();
  logger.info('Connecting to Orcha at ' + url + '...');

  try { _ws = new WebSocket(url); }
  catch (e) { logger.warn('WS constructor error: ' + e.message); _scheduleReconnect(); return; }

  const connectTimer = setTimeout(() => {
    if (_ws && _ws.readyState === WebSocket.CONNECTING) {
      logger.info('WS connect attempt timed out after ' + CONNECT_TIMEOUT_MS + 'ms (Orcha likely not open) — forcing fast failure');
      _ws.terminate();
    }
  }, CONNECT_TIMEOUT_MS);

  _ws.on('open', () => {
    clearTimeout(connectTimer);
    _failCount = 0;
    logger.info('WS open — waiting for connected signal');
  });

  _ws.on('error', (err) => {
    clearTimeout(connectTimer);
    _failCount++;
    const logFn = _failCount <= 5 ? 'warn' : 'info';
    logger[logFn]('WS error (attempt ' + _failCount + '): ' + (err.message || 'unknown'));
    _connected = false;
    _ready     = false;

    if (_failCount >= WS_GIVE_UP_AFTER && !_wsGaveUp) {
      _wsGaveUp = true;
      logger.info('[fleet-brain] Orcha WS unreachable after ' + _failCount + ' attempts — switching to local AI mode');
      // Flush any queued items through local fallback so callers are not stranded
      if (_localAskFn && _queue.length) {
        logger.info('[fleet-brain] Flushing ' + _queue.length + ' queued request(s) through local AI');
        const queued = _queue.splice(0);
        queued.forEach(req => _localAsk(req.prompt).then(req.resolve).catch(req.reject));
      }
      // Schedule a retry of Orcha WS after RETRY_WS_AFTER_MS
      setTimeout(() => {
        logger.info('[fleet-brain] Retrying Orcha WS after ' + (RETRY_WS_AFTER_MS / 60000) + ' min pause');
        _wsGaveUp  = false;
        _failCount = 0;
        connect();
      }, RETRY_WS_AFTER_MS);
    }
  });

  _ws.on('close', () => {
    clearTimeout(connectTimer);
    logger.info('WS closed');
    _connected = false;
    _ready     = false;
    _ws        = null;
    if (_activeReq) { _activeReq.reject(new Error('WS closed')); _activeReq = null; }
    _scheduleReconnect();
  });

  _ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
    _handleMessage(msg);
  });
}

function _scheduleReconnect() {
  if (_wsGaveUp) return; // don't schedule if we gave up — setTimeout in error handler handles retry
  const delay = Math.min(RECONNECT_DELAY * Math.pow(2, Math.max(0, _failCount - 1)), 5 * 60 * 1000);
  setTimeout(() => {
    if (!_wsGaveUp && (!_ws || _ws.readyState === WebSocket.CLOSED)) connect();
  }, delay);
}

function _handleMessage(msg) {
  switch (msg.type) {
    case 'connected':
      _connected = true;
      logger.info('Orcha server connected');
      _sessionId = _loadSession();
      if (_sessionId) {
        _ws.send(JSON.stringify({ type: 'load_session', session_id: _sessionId }));
      } else {
        _ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet Operations Brain', agent_id: AGENT_ID, system_prompt: _buildSystemContext() }));
      }
      break;
    case 'session_loaded':
      _sessionId = msg.session_id || _sessionId;
      _ready     = true;
      logger.info('Session restored: ' + _sessionId);
      _drainQueue();
      break;
    case 'session_created':
      _saveSession(msg.session_id || msg.sessionId);
      _ready = true;
      logger.info('New session created: ' + _sessionId);
      if (_ws && _ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: 'send_message', session_id: _sessionId, message: '[SYSTEM CONTEXT - DO NOT RESPOND TO THIS, JUST ABSORB]\n\n' + _buildSystemContext(), images: [] }));
      }
      _drainQueue();
      break;
    case 'error':
      if (msg.request_type === 'load_session') {
        logger.info('Session not found — creating new');
        _sessionId = null;
        _ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet Operations Brain', agent_id: AGENT_ID }));
      } else if (_activeReq) {
        _activeReq.reject(new Error(msg.error || 'Orcha error'));
        _activeReq = null;
        _processNext();
      }
      break;
    case 'text_delta':
      if (_activeReq) _activeReq.text += (msg.delta || msg.content || msg.text || '');
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

// ─── REQUEST QUEUE (WS mode) ─────────────────────────────────────────────────
function _drainQueue() {
  if (_queue.length > 0 && !_activeReq) _processNext();
}

function _processNext() {
  if (_queue.length === 0 || _activeReq) return;
  if (!_ready || !_ws || _ws.readyState !== WebSocket.OPEN) return;
  const req = _queue.shift();
  _activeReq = req;
  if (Date.now() - req.createdAt > TIMEOUT_MS) {
    req.reject(new Error('Request timed out in queue'));
    _activeReq = null;
    _processNext();
    return;
  }
  _ws.send(JSON.stringify({ type: 'send_message', session_id: _sessionId, message: req.prompt, images: [] }));
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
 *
 * Routing:
 *   1. WS mode  — Orcha WS connected → queue over WebSocket
 *   2. Local mode — Orcha gave up or not configured → inject context + history,
 *                   call through _localAskFn (claude-code / Bedrock)
 */
function ask(prompt) {
  _requestCount++;
  return new Promise((resolve, reject) => {
    if (_queue.length >= MAX_QUEUE) return reject(new Error('Fleet brain queue full'));

    // Local mode: WS gave up OR WS not connected but local fallback is available
    if ((_wsGaveUp || !_connected) && _localAskFn) {
      _localAsk(prompt).then(resolve).catch(reject);
      return;
    }

    const req = {
      prompt,
      text:      '',
      timer:     null,
      createdAt: Date.now(),
      resolve:   (text) => { clearTimeout(req.timer); resolve(text); },
      reject:    (err)  => { clearTimeout(req.timer); reject(err);   },
    };
    _queue.push(req);
    if (!_ws || _ws.readyState !== WebSocket.OPEN) {
      connect();
    } else if (_ready) {
      _drainQueue();
    }
  });
}

function chat(prompt)     { return ask(prompt); }
function getSessionId()   { return _sessionId; }
function resetSession() {
  _sessionId    = null;
  _ready        = false;
  _localHistory = []; // clear local context too
  try { fs.unlinkSync(SESSION_FILE); } catch (_) {}
  if (_ws && _ws.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet Operations Brain', agent_id: AGENT_ID }));
  }
  logger.info('Session reset — next call creates fresh context');
}

function getStatus() {
  return {
    connected:    _connected,
    ready:        _ready || (_wsGaveUp && !!_localAskFn) || (!_connected && !!_localAskFn),
    localMode:    _wsGaveUp || (!_connected && !!_localAskFn),
    sessionId:    _sessionId,
    queueLength:  _queue.length,
    requestCount: _requestCount,
    lastActivity: _lastActivity,
    wsState:      _ws ? _ws.readyState : -1,
    wsGaveUp:     _wsGaveUp,
  };
}

function init() { connect(); }

module.exports = { init, ask, chat, getSessionId, getStatus, resetSession, setLocalAskFn };
