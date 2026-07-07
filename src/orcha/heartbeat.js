'use strict';
/**
 * src/orcha/heartbeat.js — Orcha Proactive Automation Engine
 *
 * The Heartbeat makes V-C autonomous. Runs after every sync cycle.
 * Takes action WITHOUT user input:
 *   1. Stale units (>3 days no update) → auto-generates follow-up note
 *   2. Vendor unresponsive (>5 days) → posts Slack alert
 *   3. New UNAVAILABLE transitions → queues relay detail fetch
 *   4. RCA fields empty on returned units → auto-infers codes
 *   5. Pushes intelligence feed to renderer
 *
 * Called by sync/index.js after merge + priority complete.
 * Non-blocking — does NOT hold up sync. Runs fully async.
 */

const store  = require('../store');
const logger = require('../utils/logger')('heartbeat');
const { P }  = require('../config/paths');

// ─── CONFIGURATION ──────────────────────────────────────────────────────────
const STALE_DAYS_FOLLOWUP      = 3;    // days with no note update → generate follow-up
const VENDOR_UNRESPONSIVE_DAYS = 5;    // days at vendor with no conversation update
const MAX_SLACK_ALERTS_PER_RUN = 10;   // prevent Slack spam
const MAX_NOTES_PER_RUN        = 15;   // cap AI calls per heartbeat
const COOLDOWN_HOURS           = 4;    // don't re-alert same unit within N hours
const RCA_AUTO_INFER_ENABLED   = true;

// ─── STATE PERSISTENCE ──────────────────────────────────────────────────────
function _loadState() {
  return store.load('heartbeatState', {
    alerts: {},
    lastRun: null,
    _prevUnavailIds: [],
    stats: { runs: 0, notesGenerated: 0, slackAlerts: 0, rcaInferred: 0 },
  });
}
function _saveState(s) { store.save('heartbeatState', s); }

// ═════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * runHeartbeat(mergedRows, ctx)
 * @param {Array} mergedRows - fully merged fleet data (AAP + Uptake + Relay)
 * @param {Object} ctx - app context { send, getMainWindow, pushStatus }
 * @returns {Object} summary of actions taken
 */
async function runHeartbeat(mergedRows, ctx) {
  const state = _loadState();
  const now   = Date.now();
  state.lastRun = new Date().toISOString();
  state.stats.runs++;

  const actions = {
    notesGenerated: [],
    slackAlerts:    [],
    rcaInferred:    [],
    relayQueued:    [],
    errors:         [],
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. STALE UNIT DETECTION → Auto-generate follow-up notes
    // ═══════════════════════════════════════════════════════════════════════
    const staleUnits = _findStaleUnits(mergedRows);
    if (staleUnits.length > 0) {
      logger.info('Found ' + staleUnits.length + ' stale units (>' + STALE_DAYS_FOLLOWUP + 'd no update)');
      const noteResults = await _generateFollowUpNotes(staleUnits.slice(0, MAX_NOTES_PER_RUN));
      actions.notesGenerated = noteResults.filter(r => r.success);
      state.stats.notesGenerated += actions.notesGenerated.length;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. VENDOR UNRESPONSIVE → Slack alert
    // ═══════════════════════════════════════════════════════════════════════
    const unresponsive = _findUnresponsiveVendors(mergedRows, state);
    if (unresponsive.length > 0) {
      logger.info('Found ' + unresponsive.length + ' vendor-unresponsive units');
      const slackResults = await _postSlackAlerts(unresponsive.slice(0, MAX_SLACK_ALERTS_PER_RUN), state);
      actions.slackAlerts = slackResults.filter(r => r.sent);
      state.stats.slackAlerts += actions.slackAlerts.length;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. NEW UNAVAILABLE TRANSITIONS → queue relay detail fetch
    // ═══════════════════════════════════════════════════════════════════════
    const newUnavail = _findNewUnavailable(mergedRows, state);
    if (newUnavail.length > 0) {
      logger.info(newUnavail.length + ' new unavailable units — queuing relay fetch');
      actions.relayQueued = newUnavail.map(u => u.equipmentId || u.id);
      // Signal renderer to show these in priority drawer
      if (ctx.send) ctx.send('heartbeat:relay-queue', newUnavail.map(u => ({
        equipmentId: u.equipmentId || u.id,
        operator: u.operator || '',
        altId: u.altId || u.alternativeId || '',
      })));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. RCA AUTO-INFERENCE → fill empty codes on returned units
    // ═══════════════════════════════════════════════════════════════════════
    if (RCA_AUTO_INFER_ENABLED) {
      const rcaCandidates = _findRCACandidates(mergedRows);
      if (rcaCandidates.length > 0) {
        logger.info(rcaCandidates.length + ' units need RCA inference');
        const rcaResults = await _autoInferRCA(rcaCandidates.slice(0, 10));
        actions.rcaInferred = rcaResults.filter(r => r.inferred);
        state.stats.rcaInferred += actions.rcaInferred.length;
      }
    }

  } catch (e) {
    logger.error('Fatal heartbeat error:', e.message);
    actions.errors.push(e.message);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUSH INTELLIGENCE FEED → renderer
  // ═══════════════════════════════════════════════════════════════════════
  const summary = {
    ranAt:          state.lastRun,
    notesGenerated: actions.notesGenerated.length,
    slackAlerts:    actions.slackAlerts.length,
    rcaInferred:    actions.rcaInferred.length,
    relayQueued:    actions.relayQueued.length,
    errors:         actions.errors.length,
    totalRuns:      state.stats.runs,
  };

  if (ctx.send) ctx.send('heartbeat:summary', summary);
  _saveState(state);
  logger.info('Complete: notes=' + summary.notesGenerated + ' slack=' + summary.slackAlerts +
    ' rca=' + summary.rcaInferred + ' relay=' + summary.relayQueued);
  return summary;
}

// ═════════════════════════════════════════════════════════════════════════════
// DETECTION FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

function _findStaleUnits(rows) {
  const notesStore = store.load('notesStore', {});
  const relayCache = store.load('relayCache', {});
  const now = Date.now();
  const staleMs = STALE_DAYS_FOLLOWUP * 24 * 60 * 60 * 1000;

  return rows.filter(r => {
    if (!/unavailable/i.test(r.atsState || r.lifecycleState || '')) return false;
    const unitId = r.equipmentId || r.id;
    if (!unitId) return false;

    const note = notesStore[unitId] || {};
    const noteAge = note.timelineBuiltAt
      ? (now - new Date(note.timelineBuiltAt).getTime()) : Infinity;

    const rc = relayCache[unitId] || {};
    const lastConvoUpdate = rc.lastConversationAt
      ? (now - new Date(rc.lastConversationAt).getTime()) : Infinity;

    // Stale if BOTH note and conversation are older than threshold
    return noteAge > staleMs && lastConvoUpdate > staleMs;
  });
}

function _findUnresponsiveVendors(rows, state) {
  const relayCache = store.load('relayCache', {});
  const now = Date.now();
  const unrespMs = VENDOR_UNRESPONSIVE_DAYS * 24 * 60 * 60 * 1000;
  const cooldownMs = COOLDOWN_HOURS * 60 * 60 * 1000;

  return rows.filter(r => {
    if (!/unavailable/i.test(r.atsState || r.lifecycleState || '')) return false;
    const unitId = r.equipmentId || r.id;
    if (!unitId) return false;

    const vendor = r.vendor || '';
    if (!vendor || /fleetnet/i.test(vendor)) return false;

    const rc = relayCache[unitId] || {};
    const lastActivity = rc.lastConversationAt || rc.scrapedAt || r.created || '';
    if (!lastActivity) return false;

    const activityAge = now - new Date(lastActivity).getTime();
    if (activityAge < unrespMs) return false;

    // Cooldown — don't re-alert same unit within COOLDOWN_HOURS
    const lastAlert = (state.alerts[unitId] || {}).lastSlackAt;
    if (lastAlert && (now - new Date(lastAlert).getTime()) < cooldownMs) return false;

    return true;
  });
}

function _findNewUnavailable(rows, state) {
  const currentUnavail = rows.filter(r =>
    /unavailable/i.test(r.atsState || r.lifecycleState || '')
  );
  const currentIds = currentUnavail.map(r => r.equipmentId || r.id);
  const prevSet = new Set(state._prevUnavailIds || []);

  // Update snapshot for next run
  state._prevUnavailIds = currentIds;

  // New = in current but NOT in previous
  return currentUnavail.filter(r => !prevSet.has(r.equipmentId || r.id));
}

function _findRCACandidates(rows) {
  // Retention history is stored via direct file I/O in retention.js → P.fleetHistory
  let retentionHistory = { transitions: [] };
  try {
    const { getEvents } = require('./retention');
    retentionHistory = { transitions: getEvents ? getEvents() : [] };
  } catch (_) {}
  const recentReturns = (retentionHistory.transitions || []).filter(t => {
    if (t.type !== 'lifecycle') return false;
    if (!/available/i.test(t.to || '')) return false;
    if (!/unavailable/i.test(t.from || '')) return false;
    const age = Date.now() - new Date(t.timestamp || 0).getTime();
    return age < 7 * 24 * 60 * 60 * 1000; // within 7 days
  }).map(t => t.equipmentId);

  if (!recentReturns.length) return [];

  const rcaStore = store.load('rcaStore', {});
  return recentReturns.filter(id => {
    const rca = rcaStore[id] || {};
    return !rca.primaryComponent && !rca.primaryCauseCode;
  }).map(id => {
    const row = rows.find(r => (r.equipmentId || r.id) === id);
    return row || { equipmentId: id };
  }).filter(Boolean);
}

// ═════════════════════════════════════════════════════════════════════════════
// ACTION FUNCTIONS
// ═════════════════════════════════════════════════════════════════════════════

async function _generateFollowUpNotes(staleUnits) {
  const results = [];
  let askOrcha;
  try {
    askOrcha = require('../scrapers/orcha_ws').askOrcha;
  } catch (e) {
    logger.warn('Orcha WS not available:', e.message);
    return results;
  }

  const notesStore = store.load('notesStore', {});
  const relayCache = store.load('relayCache', {});

  for (const r of staleUnits) {
    const unitId = r.equipmentId || r.id;
    try {
      const existing = notesStore[unitId] || {};
      const rc = relayCache[unitId] || {};
      const vendor = r.vendor || rc.vendor || 'unknown';
      const daysSince = existing.timelineBuiltAt
        ? Math.round((Date.now() - new Date(existing.timelineBuiltAt).getTime()) / 86400000)
        : '?';

      const prompt =
        'Unit ' + unitId + ' at vendor "' + vendor + '" — no update for ' + daysSince + ' days.\n' +
        'Current timeline:\n' + (existing.notes || '(none)').substring(0, 2000) + '\n' +
        'Latest relay conversation:\n' + ((rc.conversation || '').substring(0, 1500) || '(none)') + '\n\n' +
        'Generate ONE follow-up note line: MM/DD - [follow-up needed: specific reason]\n' +
        'Use today date. Be specific (missing ETA, parts status, diagnosis, etc).\n' +
        'ONLY the single timeline line. No explanation.';

      const result = await askOrcha(prompt);
      const text = (result && result.text) ? result.text.trim() : (typeof result === 'string' ? result.trim() : '');

      if (text && /^\d{2}\/\d{2}/.test(text)) {
        const line = text.split('\n')[0].trim();
        const currentNotes = existing.notes || '';
        notesStore[unitId] = {
          ...existing,
          notes: currentNotes + (currentNotes ? '\n' : '') + line,
          timelineBuiltAt: new Date().toISOString(),
          lastFollowUp: new Date().toISOString(),
        };
        results.push({ unitId, note: line, success: true });
        logger.info('Follow-up: ' + unitId + ' → ' + line);
      } else {
        results.push({ unitId, success: false, reason: 'invalid AI response' });
      }
    } catch (e) {
      results.push({ unitId, success: false, reason: e.message });
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  if (results.filter(r => r.success).length > 0) {
    store.save('notesStore', notesStore);
  }
  return results;
}

async function _postSlackAlerts(unresponsiveUnits, state) {
  const results = [];
  let sendSlackMessage, isAuthenticated;
  try {
    const slack = require('../scrapers/slack_send');
    sendSlackMessage = slack.sendSlackMessage;
    isAuthenticated  = slack.isAuthenticated;
  } catch (e) {
    logger.warn('Slack module not available:', e.message);
    return results;
  }

  if (!isAuthenticated()) {
    logger.info('Slack not authenticated — skipping alerts');
    return results;
  }

  const settings = store.load('settings', {});
  const alertChannel = settings.slackAlertChannel || '#fleet-alerts';

  for (const r of unresponsiveUnits) {
    const unitId = r.equipmentId || r.id;
    const vendor = r.vendor || 'unknown';
    const altId  = r.altId || r.alternativeId || '';
    const rc     = store.load('relayCache', {})[unitId] || {};
    const daysSince = rc.lastConversationAt
      ? Math.round((Date.now() - new Date(rc.lastConversationAt).getTime()) / 86400000)
      : '5+';

    const message =
      ':rotating_light: *Vendor Unresponsive*\n' +
      '> *Unit:* `' + unitId + '`' + (altId ? ' (`' + altId + '`)' : '') + '\n' +
      '> *Vendor:* ' + vendor + '\n' +
      '> *Last update:* ' + daysSince + ' days ago\n' +
      '> *Issue:* ' + ((rc.issue || r.issue || 'Unknown').substring(0, 100)) + '\n' +
      '> :point_right: Follow up with vendor for status/ETA';

    try {
      await sendSlackMessage(alertChannel, message);
      results.push({ unitId, sent: true, channel: alertChannel });
      if (!state.alerts[unitId]) state.alerts[unitId] = {};
      state.alerts[unitId].lastSlackAt = new Date().toISOString();
      logger.info('Slack alert → ' + unitId + ' → ' + alertChannel);
    } catch (e) {
      results.push({ unitId, sent: false, error: e.message });
      logger.warn('Slack failed for ' + unitId + ':', e.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return results;
}

async function _autoInferRCA(candidates) {
  const results = [];
  let askOrcha;
  try {
    askOrcha = require('../scrapers/orcha_ws').askOrcha;
  } catch (e) {
    logger.warn('Orcha WS not available for RCA:', e.message);
    return results;
  }

  const relayCache = store.load('relayCache', {});
  const rcaStore   = store.load('rcaStore', {});

  for (const r of candidates) {
    const unitId = r.equipmentId || r.id;
    try {
      const rc = relayCache[unitId] || {};
      const issue = r.issue || rc.issue || '';
      const conversation = rc.conversation || '';

      if (!issue && !conversation) {
        results.push({ unitId, inferred: false, reason: 'no data' });
        continue;
      }

      const prompt =
        'Infer RCA codes for unit ' + unitId + '.\n' +
        'Issue: ' + issue.substring(0, 500) + '\n' +
        'Conversation: ' + conversation.substring(0, 2000) + '\n\n' +
        'Respond ONLY with this JSON (no other text):\n' +
        '{"primaryComponent":"...","technicianFailureCode":"...","primaryCauseCode":"...","workAccomplishedCode":"...","maintenanceCode":"PM|UM|MOD","controllable":"Y|N"}\n' +
        'Use standard VMRS codes. "UNKNOWN" if unsure.';

      const result = await askOrcha(prompt);
      const text = (result && result.text) ? result.text.trim() : (typeof result === 'string' ? result.trim() : '');

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        rcaStore[unitId] = {
          ...rcaStore[unitId],
          ...parsed,
          inferredAt: new Date().toISOString(),
          source: 'heartbeat-auto',
        };
        results.push({ unitId, inferred: true, codes: parsed });
        logger.info('RCA inferred: ' + unitId + ' → ' + (parsed.primaryComponent || '?'));
      } else {
        results.push({ unitId, inferred: false, reason: 'response not JSON' });
      }
    } catch (e) {
      results.push({ unitId, inferred: false, reason: e.message });
    }
    await new Promise(resolve => setTimeout(resolve, 600));
  }

  if (results.filter(r => r.inferred).length > 0) {
    store.save('rcaStore', rcaStore);
  }
  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═════════════════════════════════════════════════════════════════════════════
module.exports = { runHeartbeat };
