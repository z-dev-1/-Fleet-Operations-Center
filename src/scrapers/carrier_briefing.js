'use strict';
/**
 * carrier_briefing.js — Daily Carrier Briefing.
 *
 * Once a day, for each operator that has a mapped carrier channel (Operator
 * Channels in Settings), posts a short, AI-WRITTEN snapshot + safety tip to
 * that operator's carrier Slack channel, tagging the operator owner.
 *
 * Design decisions (set by the user):
 *  - Fully settings-configurable: enable toggle, send time + timezone, which
 *    snapshot fields are included, risk threshold, safety-tip on/off. Nothing
 *    is hardcoded for a single operator.
 *  - The AI writes the WHOLE message start to finish — no greeting/closing
 *    templates. We only hand it grounded FACTS; it decides all wording.
 *  - Grounding (never invent): fleet units from fleetData; domicile addresses
 *    from the Contact Book (type === 'domicile'); operator->channel/owner from
 *    operatorChannels. If an address/field isn't on file, it is omitted — never
 *    guessed.
 *  - Guardrails mirror the PM-alert carrier fan-out: Slack-friendly emojis, tag
 *    the owner, NO mention of "Z"/"Zila"/"FAS" or any internal requester.
 *  - AI call uses relay.ask (the robust full-chain path) wrapped in the same
 *    2-attempt × 30s retry the PM-alert fixes use — the carrier message MUST be
 *    AI-written; a deterministic fallback is a LAST RESORT only.
 *  - Dedup: one send per operator per calendar day (in the configured tz),
 *    keyed 'OPERATOR:YYYY-MM-DD' in carrierBriefingLog, so a restart or re-open
 *    mid-morning never double-posts.
 *
 * Field sources (verified against fleetData row shape, relay.js
 * mergeRelayIntoRows): equipmentId, operator, domicileSite, lifecycleState
 * (DOWN when it contains 'unavail'), lifecycleReason / issueDetails, riskScore.
 */

const store = require('../store');
const logger = require('../utils/logger').createLogger('carrier_briefing');
const { getOperatorChannels, resolveOperatorEntry } = require('./pm_alert_reply');

// ── Config ───────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: false,
  sendTime: '07:00',            // HH:MM, 24h, in `timezone`
  timezone: 'America/New_York',
  includeDown: true,
  includeFlagged: true,
  includeActive: true,
  includeDomiciles: true,
  riskThreshold: 80,            // "flagged this week" = riskScore >= this
  tipEnabled: true,
};

function getConfig() {
  const cfg = store.load('carrierBriefingConfig', null);
  if (!cfg || typeof cfg !== 'object') return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(patch) {
  const next = { ...getConfig(), ...(patch || {}) };
  // Normalize / clamp.
  next.enabled = !!next.enabled;
  next.sendTime = _normalizeTime(next.sendTime) || DEFAULT_CONFIG.sendTime;
  next.timezone = String(next.timezone || DEFAULT_CONFIG.timezone).trim() || DEFAULT_CONFIG.timezone;
  next.includeDown = !!next.includeDown;
  next.includeFlagged = !!next.includeFlagged;
  next.includeActive = !!next.includeActive;
  next.includeDomiciles = !!next.includeDomiciles;
  next.tipEnabled = !!next.tipEnabled;
  const rt = parseInt(next.riskThreshold, 10);
  next.riskThreshold = Number.isFinite(rt) ? Math.max(0, Math.min(100, rt)) : DEFAULT_CONFIG.riskThreshold;
  store.save('carrierBriefingConfig', next);
  return next;
}

function _normalizeTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10); const mi = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
}

// ── Timezone helpers ──────────────────────────────────────────────────────────
// Current wall-clock { date:'YYYY-MM-DD', hm:'HH:MM' } in a given IANA tz,
// using Intl so we never depend on the host clock's tz.
function nowInZone(timezone, when) {
  const d = when || new Date();
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
    const hour = parts.hour === '24' ? '00' : parts.hour; // Intl can emit 24 at midnight
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hm: `${hour}:${parts.minute}`,
    };
  } catch (e) {
    // Bad tz string — fall back to host local so the feature still runs.
    const pad = (n) => String(n).padStart(2, '0');
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      hm: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    };
  }
}

// Month-based season label (northern hemisphere) to steer the safety tip.
function _seasonFor(dateStr) {
  const m = parseInt(String(dateStr).slice(5, 7), 10);
  if (m === 12 || m === 1 || m === 2) return 'winter';
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  return 'fall';
}

// ── Fact gathering (grounded; never invents) ─────────────────────────────────
function _rows() {
  try {
    const fd = store.load('fleetData', {}) || {};
    return Array.isArray(fd.rows) ? fd.rows : [];
  } catch (_) { return []; }
}

function _domicileAddressMap() {
  // site code (UPPER) -> "City, ST" from the Contact Book domiciles.
  const map = {};
  try {
    const contacts = store.load('contacts', []) || [];
    for (const c of contacts) {
      if (!c || c.type !== 'domicile') continue;
      const code = String(c.name || '').trim().toUpperCase();
      if (!code) continue;
      const city = String(c.city || '').trim();
      const st = String(c.state || '').trim();
      const loc = [city, st].filter(Boolean).join(', ');
      if (loc) map[code] = loc;
    }
  } catch (_) { /* no contacts — codes shown without city */ }
  return map;
}

const _isDown = (r) => String(r.lifecycleState || '').toLowerCase().includes('unavail');

// gatherOperatorFacts(operator, cfg) -> grounded facts for one operator, or
// null if the operator has no units in fleetData.
function gatherOperatorFacts(operator, cfg) {
  const op = String(operator || '').trim();
  if (!op) return null;
  const opLower = op.toLowerCase();
  const rows = _rows().filter((r) => String(r.operator || '').trim().toLowerCase() === opLower);
  if (!rows.length) return null;

  const threshold = cfg.riskThreshold;
  const addrMap = _domicileAddressMap();
  const domicileCode = (r) => String(r.domicileSite || '').trim().toUpperCase();

  const down = rows.filter(_isDown).map((r) => {
    const code = domicileCode(r);
    const loc = addrMap[code] || '';
    return {
      unit: String(r.equipmentId || '').trim(),
      reason: String(r.lifecycleReason || r.issueDetails || '').trim(),
      domicile: code,
      location: loc, // "" when no Contact Book address on file (never guessed)
    };
  }).filter((d) => d.unit);

  const flaggedCount = rows.filter((r) => !_isDown(r) && Number(r.riskScore || 0) >= threshold).length;
  const activeCount = rows.filter((r) => !_isDown(r)).length;

  const domicileSet = new Map(); // code -> loc
  for (const r of rows) {
    const code = domicileCode(r);
    if (code && !domicileSet.has(code)) domicileSet.set(code, addrMap[code] || '');
  }
  const domiciles = Array.from(domicileSet.entries())
    .map(([code, loc]) => ({ code, location: loc }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    operator: op,
    totalUnits: rows.length,
    down,
    downCount: down.length,
    flaggedCount,
    activeCount,
    domiciles,
    riskThreshold: threshold,
  };
}

// ── Prompt (AI writes the whole message) ──────────────────────────────────────
function buildBriefingPrompt(facts, cfg, ownerTag, dateStr) {
  const season = _seasonFor(dateStr);
  const lines = [];
  lines.push('You are composing ONE short daily Slack message to a trucking carrier/operator partner channel. Write the ENTIRE message yourself — greeting, snapshot, and (if asked) a safety tip. Keep it warm, professional, and concise.');
  lines.push('');
  lines.push('TODAY: ' + dateStr + ' (' + season + ').');
  lines.push('OPERATOR: ' + facts.operator + '.');
  lines.push('');
  lines.push('GROUNDED FACTS — use ONLY these; never invent a unit, number, location, date, or reason:');

  if (cfg.includeDown) {
    if (facts.downCount) {
      lines.push('- Units currently DOWN (' + facts.downCount + '):');
      facts.down.forEach((d) => {
        const where = d.location ? (d.domicile + ' (' + d.location + ')') : d.domicile;
        lines.push('    • ' + d.unit + (d.reason ? ' — ' + d.reason : '') + (where ? ' · ' + where : ''));
      });
    } else {
      lines.push('- Units currently DOWN: none (all units are running).');
    }
  }
  if (cfg.includeFlagged) {
    lines.push('- Units flagged this week (risk score >= ' + facts.riskThreshold + '): ' + facts.flaggedCount + '.');
  }
  if (cfg.includeActive) {
    lines.push('- Active units: ' + facts.activeCount + ' (of ' + facts.totalUnits + ' total).');
  }
  if (cfg.includeDomiciles && facts.domiciles.length) {
    const dl = facts.domiciles.map((d) => d.location ? (d.code + ' (' + d.location + ')') : d.code).join(', ');
    lines.push('- Domiciles: ' + dl + '.');
  }

  lines.push('');
  lines.push('REQUIREMENTS:');
  if (ownerTag) lines.push('- Address the owner by starting with EXACTLY this token so Slack tags them: ' + ownerTag);
  lines.push('- Use Slack-friendly emojis tastefully (e.g. :sunny: :red_circle: :large_yellow_circle: :green_circle: :round_pushpin: :bulb: :truck:).');
  lines.push('- Present the snapshot clearly (short lines or bullets). Only include the facts given above.');
  if (cfg.tipEnabled) {
    lines.push('- Finish with ONE concrete, specific "safety tip of the day" relevant to ' + season + ' driving/fleet operations. Make it practical and specific (not generic). Vary it day to day.');
  }
  lines.push('');
  lines.push('MUST NOT:');
  lines.push('- Mention "Z", "Zila", "FAS", the internal requester, or any internal-only names/roles.');
  lines.push('- Invent any unit, count, address, date, price, or reason not listed above.');
  lines.push('- Exceed ~10 short lines.');

  if (cfg.tipEnabled) {
    const recent = _recentTips();
    if (recent.length) {
      lines.push('');
      lines.push('Do NOT repeat any of these recent safety tips (choose a different topic):');
      recent.forEach((t) => lines.push('    - ' + t));
    }
  }
  return lines.join('\n');
}

// ── AI call (relay.ask + 2×30s retry; AI-written is required) ─────────────────
async function _askAI(prompt, log) {
  const relay = require('../orcha/relay');
  const ATTEMPTS = 2;
  const ATTEMPT_MS = 30000;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const raw = await Promise.race([
        relay.ask(prompt),
        new Promise((_, rej) => setTimeout(() => rej(new Error('ai-timeout')), ATTEMPT_MS)),
      ]);
      const text = (typeof raw === 'string') ? raw.trim() : (raw && raw.text ? String(raw.text).trim() : '');
      if (text) { log('[CarrierBriefing] AI message generated (attempt ' + attempt + ')'); return text; }
      log('[CarrierBriefing] AI returned empty (attempt ' + attempt + '/' + ATTEMPTS + ')');
    } catch (e) {
      log('[CarrierBriefing] AI attempt ' + attempt + '/' + ATTEMPTS + ' failed (' + e.message + ')');
    }
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1500));
  }
  return '';
}

// Deterministic LAST-RESORT message (only if every AI attempt fails) so the
// carrier is still greeted rather than getting nothing.
function _fallbackMessage(facts, cfg, ownerTag) {
  const parts = [];
  if (ownerTag) parts.push(ownerTag + ' :sunny: Good morning — ' + facts.operator + ' fleet snapshot:');
  else parts.push(':sunny: Good morning — ' + facts.operator + ' fleet snapshot:');
  if (cfg.includeDown) {
    if (facts.downCount) {
      parts.push(':red_circle: ' + facts.downCount + ' unit(s) down: ' +
        facts.down.map((d) => d.unit + (d.reason ? ' (' + d.reason + ')' : '')).join(', '));
    } else {
      parts.push(':green_circle: All units active — nothing down.');
    }
  }
  if (cfg.includeFlagged) parts.push(':large_yellow_circle: ' + facts.flaggedCount + ' flagged this week (risk >= ' + facts.riskThreshold + ').');
  if (cfg.includeActive) parts.push(':green_circle: ' + facts.activeCount + ' active units.');
  if (cfg.includeDomiciles && facts.domiciles.length) {
    parts.push(':round_pushpin: Domiciles: ' + facts.domiciles.map((d) => d.location ? (d.code + ' (' + d.location + ')') : d.code).join(', '));
  }
  parts.push(':truck: Have a safe day out there.');
  return parts.join('\n');
}

// ── Safety-tip no-repeat history ──────────────────────────────────────────────
function _log() {
  const l = store.load('carrierBriefingLog', null);
  if (l && typeof l === 'object') return { sent: l.sent || {}, lastRunAt: l.lastRunAt || null, recentTips: Array.isArray(l.recentTips) ? l.recentTips : [] };
  return { sent: {}, lastRunAt: null, recentTips: [] };
}
function _saveLog(l) { store.save('carrierBriefingLog', l); }
function _recentTips() { return _log().recentTips.slice(-10); }

// Best-effort: remember the final line (the tip) to discourage repeats.
function _rememberTip(message) {
  try {
    const l = _log();
    const lines = String(message || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const tip = lines.length ? lines[lines.length - 1] : '';
    if (tip && tip.length > 12) {
      l.recentTips.push(tip);
      if (l.recentTips.length > 10) l.recentTips = l.recentTips.slice(-10);
      _saveLog(l);
    }
  } catch (_) { /* non-fatal */ }
}

// ── Send one operator's briefing ──────────────────────────────────────────────
// deps: { sendToChannel, openConversation, checkLiveAuth }
// opts: { testToSelf?: boolean, force?: boolean } — testToSelf posts to the
// user's own DM and bypasses dedup; force bypasses dedup but still posts to the
// carrier channel.
async function sendOperatorBriefing(operator, deps, opts, log) {
  const doLog = log || ((m) => logger.info(m));
  deps = deps || {};
  opts = opts || {};
  const { sendToChannel, openConversation, checkLiveAuth } = deps;
  const cfg = getConfig();

  const entry = resolveOperatorEntry(operator);
  if (!entry || !entry.channelId) {
    doLog('[CarrierBriefing] ' + operator + ': no mapped carrier channel — skipping');
    return { sent: false, reason: 'no-channel' };
  }

  const facts = gatherOperatorFacts(operator, cfg);
  if (!facts) {
    doLog('[CarrierBriefing] ' + operator + ': no units in fleet data — skipping');
    return { sent: false, reason: 'no-units' };
  }

  const tz = cfg.timezone;
  const today = nowInZone(tz).date;
  const dedupKey = operator.toUpperCase() + ':' + today;

  // Dedup — one send per operator per calendar day (skipped for test/force).
  if (!opts.testToSelf && !opts.force) {
    const l = _log();
    if (l.sent && l.sent[dedupKey]) {
      doLog('[CarrierBriefing] ' + operator + ': already sent today (' + today + ') — skipping');
      return { sent: false, reason: 'already-sent' };
    }
  }

  // Resolve the destination channel.
  let destChannel = entry.channelId;
  if (opts.testToSelf) {
    try {
      const auth = await checkLiveAuth();
      if (!auth || !auth.authenticated || !auth.userId) throw new Error('no slack userId');
      destChannel = await openConversation({ id: auth.userId, type: 'user' });
      if (!destChannel) throw new Error('could not open self-DM');
    } catch (e) {
      doLog('[CarrierBriefing] test: could not open self-DM (' + e.message + ')');
      return { sent: false, reason: 'self-dm-failed' };
    }
  }

  const ownerTag = entry.ownerId ? '<@' + entry.ownerId + '>' : '';
  const prompt = buildBriefingPrompt(facts, cfg, ownerTag, today);

  let message = await _askAI(prompt, doLog);
  let aiWritten = !!message;
  if (!message) {
    doLog('[CarrierBriefing] ' + operator + ': all AI attempts failed — using deterministic fallback');
    message = _fallbackMessage(facts, cfg, ownerTag);
  }
  // Safety net: ensure the owner is actually tagged even if the AI omitted it.
  if (ownerTag && message.indexOf(ownerTag) === -1) message = ownerTag + ' ' + message;
  // For a self-test, prefix a clear marker so it isn't mistaken for a live post.
  if (opts.testToSelf) {
    message = ':test_tube: *Daily Carrier Briefing — TEST preview for ' + facts.operator +
      '* (this would post to <#' + entry.channelId + '>)\n\n' + message;
  }

  try {
    await sendToChannel(destChannel, message); // top-level (no thread_ts)
  } catch (e) {
    doLog('[CarrierBriefing] ' + operator + ': send failed (' + e.message + ')');
    return { sent: false, reason: 'send-failed', error: e.message };
  }

  // Record dedup + tip history for real (non-test) sends.
  if (!opts.testToSelf) {
    const l = _log();
    l.sent = l.sent || {};
    l.sent[dedupKey] = new Date().toISOString();
    // Prune old dedup keys (keep ~400 most recent) so the file never grows forever.
    const keys = Object.keys(l.sent);
    if (keys.length > 400) {
      keys.sort((a, b) => String(l.sent[a]).localeCompare(String(l.sent[b])));
      keys.slice(0, keys.length - 400).forEach((k) => delete l.sent[k]);
    }
    l.lastRunAt = new Date().toISOString();
    _saveLog(l);
    if (aiWritten) _rememberTip(message);
  }

  doLog('[CarrierBriefing] ' + operator + ': ' + (opts.testToSelf ? 'TEST ' : '') + 'posted to ' +
    (opts.testToSelf ? 'self-DM' : entry.channelId) + ' (' + (aiWritten ? 'AI' : 'fallback') + ')');
  return { sent: true, operator, channelId: entry.channelId, aiWritten, testToSelf: !!opts.testToSelf };
}

// ── Run all operators (the daily job) ─────────────────────────────────────────
// Iterates every operator that has a mapped carrier channel; dedup makes it
// safe to call repeatedly. deps as above. opts.force bypasses dedup.
async function runDailyBriefing(deps, opts, log) {
  const doLog = log || ((m) => logger.info(m));
  const cfg = getConfig();
  if (!cfg.enabled && !(opts && opts.force)) {
    doLog('[CarrierBriefing] disabled — skipping run');
    return { ran: false, reason: 'disabled' };
  }
  const channels = getOperatorChannels();
  const operators = (channels.operators || []).filter((o) => o && o.operator && o.channelId);
  if (!operators.length) {
    doLog('[CarrierBriefing] no operators with a mapped channel — nothing to send');
    return { ran: true, results: [] };
  }
  const results = [];
  for (const o of operators) {
    try {
      const r = await sendOperatorBriefing(o.operator, deps, { force: opts && opts.force }, doLog);
      results.push({ operator: o.operator, ...r });
    } catch (e) {
      doLog('[CarrierBriefing] ' + o.operator + ': run error (' + e.message + ')');
      results.push({ operator: o.operator, sent: false, reason: 'error', error: e.message });
    }
  }
  const sent = results.filter((r) => r.sent).length;
  doLog('[CarrierBriefing] run complete — ' + sent + '/' + operators.length + ' sent');
  return { ran: true, results };
}

// ── Scheduler (daily tick) ────────────────────────────────────────────────────
// Mirrors src/orcha/fas/scheduler.js: an idempotent setInterval that unref()s
// so it never keeps the process alive. Ticks every minute; when the current
// wall-clock minute in the configured timezone equals the configured sendTime
// AND today's run hasn't happened, it fires runDailyBriefing. Dedup inside
// sendOperatorBriefing guarantees one send per operator per day even if the
// minute is observed more than once or the app restarts.
let _timer = null;
let _firingFor = null; // guards against overlapping runs within the same minute

function _slackDeps() {
  const { sendToChannel, openConversation, checkLiveAuth } = require('./slack_send');
  return { sendToChannel, openConversation, checkLiveAuth };
}

async function _tick() {
  let cfg;
  try { cfg = getConfig(); } catch (_) { return; }
  if (!cfg.enabled) return;
  const now = nowInZone(cfg.timezone);
  if (now.hm !== cfg.sendTime) return;
  // Only fire once per calendar day. The per-operator dedup is the hard
  // guarantee; this day-guard just avoids re-entering runDailyBriefing every
  // minute during the matching minute window / across the day.
  const dayKey = now.date;
  const l = _log();
  if (l.lastRunDay === dayKey) return;
  if (_firingFor === dayKey) return; // a run for today is already in flight
  _firingFor = dayKey;
  try {
    logger.info('[CarrierBriefing] scheduled run for ' + dayKey + ' at ' + cfg.sendTime + ' ' + cfg.timezone);
    await runDailyBriefing(_slackDeps(), {}, (m) => logger.info(m));
    const after = _log();
    after.lastRunDay = dayKey;
    after.lastRunAt = new Date().toISOString();
    _saveLog(after);
  } catch (e) {
    logger.warn('[CarrierBriefing] scheduled run failed: ' + e.message);
  } finally {
    _firingFor = null;
  }
}

function startScheduler() {
  stopScheduler();
  _timer = setInterval(() => { _tick().catch(() => {}); }, 60 * 1000);
  if (_timer.unref) _timer.unref();
  logger.info('[CarrierBriefing] scheduler started (ticks every 60s)');
  return stopScheduler;
}

function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  DEFAULT_CONFIG,
  getConfig,
  saveConfig,
  nowInZone,
  gatherOperatorFacts,
  buildBriefingPrompt,
  sendOperatorBriefing,
  runDailyBriefing,
  startScheduler,
  stopScheduler,
};
