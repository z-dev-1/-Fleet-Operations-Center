'use strict';
/**
 * orcha_ws.js — Orcha WebSocket client for Fleet App [V-C]
 * Connects to the local Orcha server (port read from ~/.orcha/agent_port)
 * and sends a one-shot prompt, collecting the streaming text response.
 */

const WebSocket = require('ws');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const { P }     = require('../config/paths');
const logger    = require('../utils/logger')('orcha_ws');

const PORT_FILE  = P.orchaPort;
const TIMEOUT_MS = 90000;  // 90s max wait for response (large prompts need time)

// Orcha connection config — supports local or remote
const ORCHA_CONFIG_FILE = P.orchaConfig;

function loadOrchaConfig() {
  try {
    if (fs.existsSync(ORCHA_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(ORCHA_CONFIG_FILE, 'utf8'));
    }
  } catch(e) {}
  return { mode: 'local', host: 'localhost', port: null }; // default: local auto-detect
}

function saveOrchaConfig(config) {
  try {
    const dir = path.dirname(ORCHA_CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ORCHA_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch(e) {}
}

function getOrchaUrl() {
  const config = loadOrchaConfig();
  if (config.mode === 'remote' && config.host) {
    const port = config.port || 4799;
    return `ws://${config.host}:${port}`;
  }
  // Local: read from port file
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0) return `ws://localhost:${port}`;
  } catch (e) {}
  return 'ws://localhost:4799';
}

/**
 * sendOrchaPrompt(prompt)
 * Routes ALL AI calls through the Orcha Relay (src/orcha/relay.js).
 * The relay handles Bedrock calls, credential management, retries, and logging.
 * No WebSocket or manual Bedrock client needed here.
 */
const relay = require('../orcha/relay');

function sendOrchaPrompt(prompt) {
  return relay.ask(prompt);
}

// ── PERSISTENT CHAT SESSION ───────────────────────────────────────────────
// Fleet Chat uses a single persistent session so Orcha remembers context across restarts.
let _fleetChatSessionId = null;
const FLEET_CHAT_SESSION_FILE = P.chatSessionId;

function getFleetChatSessionId() {
  if (_fleetChatSessionId) return _fleetChatSessionId;
  // Try to load saved session ID from disk (persists across restarts)
  try {
    const saved = fs.readFileSync(FLEET_CHAT_SESSION_FILE, 'utf8').trim();
    if (saved && saved.startsWith('ct_')) {
      _fleetChatSessionId = saved;
      logger.info('[Fleet Chat] Restored persistent session:', saved);
      return _fleetChatSessionId;
    }
  } catch (_) {}
  // No saved session — return null (will create new on first chat)
  return null;
}

// Reset chat session (clears memory — starts fresh next message)
function resetFleetChatSession() {
  _fleetChatSessionId = null;
  try { fs.unlinkSync(FLEET_CHAT_SESSION_FILE); } catch (_) {}
  logger.info('[Fleet Chat] Session reset — next message will create fresh session');
}
// ──────────────────────────────────────────────────────────────────────────

function sendOrchaViaWS(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const wsUrl = getOrchaUrl();
    const ws        = new WebSocket(wsUrl);
    let fullText    = '';
    let resolved    = false;
    let timer       = null;

    const done = (err, text) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(text);
    };

    timer = setTimeout(() => done(new Error('Orcha WS timeout'), null), TIMEOUT_MS);
    ws.on('error', err => done(err, null));

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type:       'create_session',
        title:      'Fleet AI (ephemeral)',
        agent_id:   'orcha_default',
        session_id: sessionId,
      }));
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      switch (msg.type) {
        case 'session_created': {
          const sid = msg.sessionId || msg.session_id;
          if (!sid) break;
          ws.send(JSON.stringify({
            type:       'send_message',
            session_id: sid,
            message:    prompt,
            images:     [],
          }));
          break;
        }
        case 'text_delta': {
          fullText += (msg.delta || msg.content || '');
          break;
        }
        case 'message_complete': {
          done(null, fullText);
          break;
        }
        case 'error': {
          if (msg.request_type === 'send_message' || msg.request_type === 'create_session') {
            done(new Error(msg.error || 'Orcha error'), null);
          }
          break;
        }
      }
    });
  });
}

/**
 * sendOrchaChat(prompt)
 * Persistent chat — reuses the same Orcha session across calls and restarts.
 */
function sendOrchaChat(prompt) {
  const savedSessionId = getFleetChatSessionId();
  return new Promise((resolve, reject) => {
    const wsUrl = getOrchaUrl();
    const ws = new WebSocket(wsUrl);
    let fullText = '';
    let resolved = false;
    let timer = null;
    let connected = false; // eslint-disable-line no-unused-vars

    const done = (err, text) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { ws.close(); } catch (_) {}
      if (err) reject(err);
      else resolve(text);
    };

    timer = setTimeout(() => done(new Error('Orcha WS timeout'), null), TIMEOUT_MS);
    ws.on('error', err => done(err, null));

    ws.on('open', () => {
      // Wait for 'connected' message before sending
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      switch (msg.type) {
        case 'connected': {
          connected = true;
          if (savedSessionId) {
            ws.send(JSON.stringify({ type: 'load_session', session_id: savedSessionId }));
          } else {
            ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet Chat', agent_id: 'orcha_default' }));
          }
          break;
        }
        case 'session_loaded': {
          const sid = msg.session_id || savedSessionId;
          logger.info('[Fleet Chat] Resumed session:', sid);
          ws.send(JSON.stringify({ type: 'send_message', session_id: sid, message: prompt, images: [] }));
          break;
        }
        case 'session_created': {
          const sid = msg.session_id;
          _fleetChatSessionId = sid;
          try { fs.writeFileSync(FLEET_CHAT_SESSION_FILE, sid); } catch (_) {}
          logger.info('[Fleet Chat] New session created:', sid);
          ws.send(JSON.stringify({ type: 'send_message', session_id: sid, message: prompt, images: [] }));
          break;
        }
        case 'error': {
          if (msg.request_type === 'load_session') {
            logger.info('[Fleet Chat] Session not found, creating new...');
            _fleetChatSessionId = null;
            ws.send(JSON.stringify({ type: 'create_session', title: 'Fleet Chat', agent_id: 'orcha_default' }));
            break;
          }
          if (msg.request_type === 'send_message' || msg.request_type === 'create_session') {
            done(new Error(msg.error || 'Orcha error'), null);
          }
          break;
        }
        case 'text_delta': {
          fullText += (msg.delta || msg.content || '');
          break;
        }
        case 'message_complete': {
          done(null, fullText);
          break;
        }
        default: break;
      }
    });
  });
}

/**
 * localClassify(unit)
 * Deterministic keyword-based classification — no AI call needed for clear cases.
 */
function localClassify(unit) {
  const issue  = (unit.issue  || '').toLowerCase();
  const notes  = (unit.notes  || '').toLowerCase();
  const vendor = (unit.vendor || '').toLowerCase();
  const relay  = (unit.relayStatus || '').toLowerCase();

  const noteLines = notes.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const latestNote = noteLines.length > 0 ? noteLines[noteLines.length - 1] : '';
  const signal = latestNote || issue;

  // ── PRIMARY COMPONENT ──────────────────────────────────────────────────────
  const PC_RULES = [
    {
      pc: 'ENGINE/MOTOR SYSTEMS',
      kw: ['engine','motor','transmission','oil leak','oil pressure','coolant','cooling','overheat',
           'no start','won\'t start','will not start','does not start','crank','cranks','idle',
           'def','dpf','egr','turbo','exhaust','fuel','misfire','check engine','regen','regeneration',
           'emissions','after-treatment','aftertreatment','water pump','thermostat','radiator',
           'power loss','loss of power','rev','rpm','stall','stalling']
    },
    {
      pc: 'CAB/CLIMATE CONTROL/INSTRUMENTATION',
      kw: ['ac ','a/c','air conditioning','air condition','hvac','heat','blowing hot','blowing cold',
           'no heat','no cool','climate','cab','dash','dashboard','instrument','interior',
           'door','mirror','seat','window','windshield','wiper','horn','odor','smell',
           'defroster','defrost','fan','blower','vent','heater']
    },
    {
      pc: 'CHASSIS',
      kw: ['brake','tire','tyre','wheel','axle','suspension','steering','frame','alignment',
           'hub','bearing','leaf spring','air bag','kingpin','driveline','driveshaft',
           'u-joint','fifth wheel','landing gear','slack adjuster','lining','rotor','caliper',
           'abs','air leak','air line','glad hand','glad-hand']
    },
    {
      pc: 'ELECTRICAL',
      kw: ['battery','alternator','wiring','wire','lights','light','fuse','fusible',
           'relay','sensor','module','ecm','tcm','pcm','bcm','abs module',
           'telematics','charging','short circuit','warning light','check light',
           'electrical','no power','dead','won\'t power','inverter','converter',
           'bulb','led','blink','flicker','fault code','dtc']
    },
    {
      pc: 'ACCESSORIES',
      kw: ['lift gate','liftgate','gps','camera','cargo','strap','load bar',
           'accessory','accessories','pallet jack','dolly','e-track']
    }
  ];

  let primaryComponent = null;
  let pcReason = '';
  for (const rule of PC_RULES) {
    if (rule.kw.some(k => issue.includes(k))) {
      primaryComponent = rule.pc;
      pcReason = 'issue text matched ' + rule.pc.toLowerCase();
      break;
    }
  }

  if (primaryComponent === 'CHASSIS') {
    const engineKwInNotes = ['engine','motor','starter','transmission','coolant','overheat','no start',
                             'def','dpf','egr','turbo','exhaust','fuel','misfire','check engine','regen',
                             'crank','idle','oil','power loss','stall'];
    if (engineKwInNotes.some(k => notes.includes(k) || issue.includes('start') || issue.includes('crank'))) {
      primaryComponent = 'ENGINE/MOTOR SYSTEMS';
      pcReason = 'engine keywords in notes override chassis match';
    }
  }

  // ── REPAIR STATUS ───────────────────────────────────────────────────────────
  let vendorFamily = 'OSR';
  let repairStatus = null;
  let rsReason = '';

  if (vendor.includes('amerit'))        vendorFamily = 'AMERIT';
  else if (vendor.includes('kooner'))   vendorFamily = 'KOONER';
  else if (vendor.includes('cox'))      vendorFamily = 'COX';
  else if (vendor.includes('goodyear')) vendorFamily = 'GOODYEAR';
  else if (vendor.includes('ta fleet') || /\bta\b/.test(vendor)) vendorFamily = 'TA';

  const isAccident = relay.includes('accident');
  if (isAccident) {
    return {
      primaryComponent: primaryComponent || 'CHASSIS',
      repairStatus: 'ACCIDENT / CEI',
      confidence: 'high',
      reason: 'relay status is Accident'
    };
  }

  const hasParts    = signal.match(/parts (on order|ordered|pending)|waiting for parts|parts wait/);
  const hasProgress = signal.match(/in progress|repairs started|repair underway|working on it|currently repair/);
  const hasEst      = signal.match(/estimat|quote|waiting for est|est pending/);
  const hasDiag     = signal.match(/diag|inspect|assess|evaluat|check out|looking at/);
  const hasBay      = signal.match(/waiting for bay|pending bay|bay avail/);
  const hasPickup   = signal.match(/pending.*pickup|waiting.*pickup/);
  const hasDropoff  = signal.match(/pending.*drop.?off|drop.?off/);
  const hasTow      = signal.match(/tow|towing/);

  if (hasTow)          { repairStatus = 'PENDING TOW';   rsReason = 'tow keyword'; }
  else if (hasPickup)  { repairStatus = 'PENDING PARTNER PICKUP'; rsReason = 'pickup keyword'; }
  else if (hasDropoff) { repairStatus = 'PENDING PARTNER DROP OFF'; rsReason = 'dropoff keyword'; }
  else if (vendorFamily === 'GOODYEAR') {
    repairStatus = 'GOODYEAR'; rsReason = 'goodyear vendor';
  }
  else if (vendorFamily === 'AMERIT') {
    if (hasProgress)   { repairStatus = 'AMERIT REPAIRS IN PROGRESS'; rsReason = 'repairs in progress'; }
    else if (hasParts) { repairStatus = 'AMERIT PARTS'; rsReason = 'parts keyword'; }
    else if (hasEst)   { repairStatus = 'PENDING ESTIMATE APPROVAL'; rsReason = 'estimate keyword'; }
    else               { repairStatus = 'AMERIT DIAG'; rsReason = 'amerit default'; }
  }
  else if (vendorFamily === 'KOONER') {
    if (hasProgress)   { repairStatus = 'KOONER REPAIRS IN PROGRESS'; rsReason = 'repairs in progress'; }
    else if (hasParts) { repairStatus = 'KOONER PARTS'; rsReason = 'parts keyword'; }
    else               { repairStatus = 'KOONER DIAG'; rsReason = 'kooner default'; }
  }
  else if (vendorFamily === 'COX') {
    if (hasProgress)   { repairStatus = 'COX REPAIR IN PROGRESS'; rsReason = 'repairs in progress'; }
    else if (hasParts) { repairStatus = 'COX PARTS'; rsReason = 'parts keyword'; }
    else               { repairStatus = 'COX DIAG'; rsReason = 'cox default'; }
  }
  else if (vendorFamily === 'TA') {
    if (hasProgress)   { repairStatus = 'TA REPAIRS IN PROGRESS'; rsReason = 'repairs in progress'; }
    else if (hasParts) { repairStatus = 'TA PENDING PARTS'; rsReason = 'parts keyword'; }
    else               { repairStatus = 'TA C/A'; rsReason = 'ta default'; }
  }
  else {
    if (hasProgress)   { repairStatus = 'OSR- REPAIRS IN PROGRESS'; rsReason = 'repairs in progress'; }
    else if (hasParts) { repairStatus = 'OSR- PENDING PARTS'; rsReason = 'parts keyword'; }
    else if (hasEst)   { repairStatus = 'OSR- PENDING EST'; rsReason = 'estimate keyword'; }
    else if (hasBay)   { repairStatus = 'OSR- PENDING BAY'; rsReason = 'bay keyword'; }
    else if (hasDiag)  { repairStatus = 'OSR- PENDING DIAG'; rsReason = 'diag keyword'; }
    else               { repairStatus = 'OSR- PENDING DIAG'; rsReason = 'osr default'; }
  }

  if (primaryComponent && repairStatus) {
    return { primaryComponent, repairStatus, confidence: 'high', reason: pcReason + ' · ' + rsReason };
  }
  return { primaryComponent, repairStatus, _partial: true, pcReason, rsReason };
}

/**
 * suggestDropdowns(unit)
 * Always calls Orcha AI with full unit data.
 */
async function suggestDropdowns(unit) {
  const subsystemSummary = Array.isArray(unit.subsystems) && unit.subsystems.length
    ? unit.subsystems.map(s => `${s.n}: ${s.s}%`).join(', ')
    : '(none)';

  const prompt = `You are a fleet vehicle classification assistant for an Amazon delivery fleet manager.
Read ALL the unit data below carefully — especially the issue details, all note lines (most recent last), and vendor name.
Pick the single best PRIMARY_COMPONENT and REPAIR_STATUS.

=== PRIMARY_COMPONENT — pick exactly one ===
CAB/CLIMATE CONTROL/INSTRUMENTATION | CHASSIS | ELECTRICAL | ENGINE/MOTOR SYSTEMS | ACCESSORIES

Rules (issue details are your primary signal):
  ENGINE/MOTOR SYSTEMS → engine, motor, transmission, oil, coolant, cooling, overheat, no start, won't start, DEF, DPF, EGR, turbo, exhaust, fuel, misfire, check engine, crank, idle, starter, regen, power loss, stall
  CAB/CLIMATE CONTROL/INSTRUMENTATION → AC, a/c, air conditioning, air condition, heat, HVAC, climate, blowing hot, blowing cold, no heat, no cool, cab, dash, instrument, interior, door, mirror, seat, window, windshield, wiper, horn, defroster, blower, vent, heater, odor, smell
  CHASSIS → brake, tire, wheel, axle, suspension, steering, frame, alignment, hub, bearing, leaf spring, kingpin, driveline, driveshaft, slack adjuster, rotor, caliper, lining, glad hand, air line, landing gear
  ELECTRICAL → battery, alternator, wiring, lights, fuse, sensor, module, ECM, TCM, ABS module, telematics, warning light, short circuit, no power, inverter, fault code, DTC, bulb, blink, flicker
  ACCESSORIES → lift gate, liftgate, GPS, camera (physical unit), cargo, strap, load bar, pallet jack, dolly

=== REPAIR_STATUS — pick exactly one ===
AMERIT DIAG | AMERIT PARTS | AMERIT REPAIRS IN PROGRESS |
ACCIDENT / CEI |
OSR- PENDING BAY | OSR- PENDING DIAG | OSR- PENDING EST | OSR- PENDING PARTS | OSR- REPAIRS IN PROGRESS |
TA C/A | TA PENDING PARTS | TA REPAIRS IN PROGRESS |
GOODYEAR |
PENDING ESTIMATE APPROVAL | PENDING PARTNER PICKUP | PENDING PARTNER DROP OFF | PENDING TOW |
END OF LIFE | LEGAL HOLD |
KOONER DIAG | KOONER PARTS | KOONER REPAIRS IN PROGRESS |
COX DIAG | COX PARTS | COX REPAIR IN PROGRESS

Rules — apply strictly in this order:
STEP 1 — Vendor family determines which status group to use.
STEP 2 — ACCIDENT / CEI: ONLY if relay status field explicitly contains "Accident".
STEP 3 — Pick sub-status from most recent note line.

=== PAST CORRECTIONS ===
${(() => { try { const { getCorrectionsContext } = require('./orcha_learn'); return getCorrectionsContext(null, 8) || 'No corrections yet.'; } catch(_) { return 'No corrections yet.'; } })()}

=== UNIT DATA ===
Unit ID:       ${unit.id          || '(none)'}
Model:         ${unit.model       || '(none)'}
Fuel type:     ${unit.fuelType    || '(none)'}
Vendor:        ${unit.vendor      || '(none)'}
ATS State:     ${unit.atsState    || '(none)'}
Relay status:  ${unit.relayStatus || '(none)'}
Issue details: ${unit.issue       || '(none)'}
Duration down: ${unit.duration    || '(none)'}
Subsystems:    ${subsystemSummary}
Uptake notes:  ${unit.insights    || '(none)'}

Unit notes (most recent is last):
${unit.notes ? unit.notes.trim() : '(none)'}

Reply ONLY with valid JSON, no markdown:
{"primaryComponent":"...","repairStatus":"...","confidence":"high|medium|low","reason":"one sentence","noteSuggestion":"short next action or empty string"}`;

  try {
    const raw   = await sendOrchaPrompt(prompt);
    const match = raw.match(/\{[\s\S]*?\}/);
    if (!match) {
      logger.warn('[Orcha WS] No JSON in response:', raw.slice(0, 200));
      const local = localClassify(unit);
      if (local && !local._partial) {
        const noteSuggestion = generateNoteSuggestion(unit, local);
        return { ok: true, ...local, noteSuggestion };
      }
      return { ok: false, error: 'No JSON in response' };
    }

    const parsed = JSON.parse(match[0]);

    // ── Guardrail: JS classifier catches clear hallucinations ────────────────
    const vendor = (unit.vendor || '').toLowerCase();
    const relayLower = (unit.relayStatus || '').toLowerCase();
    const isAccident = relayLower.includes('accident');

    const vendorFamily = vendor.includes('amerit') ? 'AMERIT'
      : vendor.includes('kooner') ? 'KOONER'
      : vendor.includes('cox')    ? 'COX'
      : vendor.includes('goodyear') ? 'GOODYEAR'
      : (vendor.includes('ta fleet') || /\bta\b/.test(vendor)) ? 'TA'
      : 'OSR';

    const rs = (parsed.repairStatus || '');
    const rsFamily = rs.startsWith('AMERIT') ? 'AMERIT'
      : rs.startsWith('KOONER') ? 'KOONER'
      : rs.startsWith('COX')    ? 'COX'
      : rs === 'GOODYEAR'       ? 'GOODYEAR'
      : rs.startsWith('TA')     ? 'TA'
      : rs === 'ACCIDENT / CEI' ? 'ACCIDENT'
      : 'OSR';

    if (rsFamily !== vendorFamily && rsFamily !== 'ACCIDENT' && !(rsFamily === 'OSR' && vendorFamily === 'OSR')) {
      const local = localClassify(unit);
      if (local && local.repairStatus) {
        logger.warn('[Guardrail] AI picked wrong vendor family ('+rsFamily+' vs '+vendorFamily+'), using local RS:', local.repairStatus);
        parsed.repairStatus = local.repairStatus;
      }
    }

    if (rs === 'ACCIDENT / CEI' && !isAccident) {
      const local = localClassify(unit);
      if (local && local.repairStatus) {
        logger.warn('[Guardrail] Relay is not Accident, overriding ACCIDENT/CEI with:', local.repairStatus);
        parsed.repairStatus = local.repairStatus;
      }
    }

    logger.info('[Orcha WS] AI suggest result:', parsed);
    const localNote = generateNoteSuggestion(unit, parsed);
    const noteSuggestion = localNote || parsed.noteSuggestion || null;
    return { ok: true, ...parsed, noteSuggestion };

  } catch (e) {
    logger.error('[Orcha WS] suggestDropdowns error:', e.message);
    const local = localClassify(unit);
    if (local && !local._partial) {
      const noteSuggestion = generateNoteSuggestion(unit, local);
      return { ok: true, ...local, noteSuggestion };
    }
    return { ok: false, error: e.message };
  }
}

/**
 * askOrcha(prompt)
 * General-purpose Orcha call — returns plain text response.
 */
async function askOrcha(prompt, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const text = await sendOrchaPrompt(prompt);
      return { ok: true, text };
    } catch (e) {
      const isTimeout = e.message && e.message.includes('timeout');
      logger.error(`[Orcha WS] askOrcha error (attempt ${attempt}/${retries}): ${e.message}`);

      if (isTimeout) {
        try { fs.appendFileSync(P.orchaTimeoutLog, `[${new Date().toISOString()}] Timeout on attempt ${attempt}. Prompt length: ${prompt.length} chars\n`); } catch(_) {}
      }

      if (attempt < retries) {
        logger.info('[Orcha WS] Retrying in 3s...');
        await new Promise(r => setTimeout(r, 3000));
      } else {
        return { ok: false, error: e.message };
      }
    }
  }
  return { ok: false, error: 'Max retries reached' };
}

/**
 * generateNoteSuggestion(unit, aiResult)
 */
function generateNoteSuggestion(unit, aiResult) {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const prefix = mm + '/' + dd + ' - ';

  const issue = (unit.issue || '').trim();
  const vendor = (unit.vendor || '').trim();
  const notes = (unit.notes || '').trim();
  const noteLines = notes.split('\n').filter(l => l.trim());
  const lastNote = noteLines.length ? noteLines[noteLines.length - 1].toLowerCase() : '';

  if (noteLines.length > 0) {
    if (/pending.*tow|pending.*drop/i.test(lastNote))
      return prefix + 'Unit arrived at ' + (vendor || 'vendor') + ' – pending diagnostic.';
    if (/pending.*diag|awaiting.*diag/i.test(lastNote))
      return prefix + 'Diagnostic complete – awaiting estimate from ' + (vendor || 'vendor') + '.';
    if (/estimate.*received|pending.*approval/i.test(lastNote))
      return prefix + 'Estimate approved – repairs authorized to proceed.';
    if (/repairs.*in.*progress|authorized/i.test(lastNote))
      return prefix + 'Repairs in progress – following up with ' + (vendor || 'vendor') + ' for ETA.';
    if (/pending.*parts|parts.*order/i.test(lastNote))
      return prefix + 'Parts received – repairs resuming at ' + (vendor || 'vendor') + '.';
    if (/complete|road.*test|pickup/i.test(lastNote))
      return prefix + 'Unit picked up – road test satisfactory, returning to service.';
    if (/following.*up|called|emailed/i.test(lastNote))
      return prefix + 'Follow-up with ' + (vendor || 'vendor') + ' – awaiting update on repair status.';
  }

  const issueCap = issue ? issue.charAt(0).toUpperCase() + issue.slice(1).substring(0, 55) + (issue.length > 55 ? '...' : '') : '';

  if (!noteLines.length || !lastNote) {
    if (issue && vendor)  return prefix + issueCap + ' – pending diag at ' + vendor + '.';
    if (issue)            return prefix + issueCap + ' – pending diag.';
    if (vendor)           return prefix + 'Unit at ' + vendor + ' – pending diag.';
    return prefix + 'Unit down – pending vendor assignment/diag.';
  }

  if (issue && vendor)  return prefix + 'Following up with ' + vendor + ' on ' + issueCap.substring(0, 40) + '.';
  if (vendor)           return prefix + 'Following up with ' + vendor + ' for status update.';
  return prefix + 'Awaiting update – ' + (issueCap || 'pending diag') + '.';
}

module.exports = { suggestDropdowns, askOrcha, sendOrchaChat, resetFleetChatSession, loadOrchaConfig, saveOrchaConfig, getOrchaUrl };
