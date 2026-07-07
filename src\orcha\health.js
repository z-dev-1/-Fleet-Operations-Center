'use strict';
/**
 * health.js — System Integration Health Monitor (Sprint 3, Module 7)
 *
 * Tracks success/failure rates of all integrations per sync cycle:
 *   - AAP scraper
 *   - Uptake scraper
 *   - Relay scraper
 *   - Orcha AI (WebSocket/Bedrock)
 *   - Midway auth (cookie expiry)
 *   - SharePoint push
 *   - Email send
 *
 * Outputs:
 *   - Per-integration status: green (healthy) / yellow (degraded) / red (failing)
 *   - Overall system health score
 *   - Alerts when integrations degrade
 *
 * Persists rolling history (last 20 cycles) for trend detection.
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('health');
const { P }  = require('../config/paths');

// ── State file ───────────────────────────────────────────────────────────────
const STATE_FILE = path.join(P.dataDir, 'health_state.json');
const MAX_HISTORY = 20;

function _loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (_) {}
  return { history: [], lastCheck: null };
}

function _saveState(data) {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (_) {}
}

// ── Integration status classification ────────────────────────────────────────
const STATUS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };

// ── Check individual integrations ────────────────────────────────────────────

function _checkAAP(syncPayload) {
  const count = syncPayload.count || 0;
  if (count >= 100) return { status: STATUS.GREEN, detail: `${count} units` };
  if (count >= 10)  return { status: STATUS.YELLOW, detail: `Only ${count} units (expected 100+)` };
  return { status: STATUS.RED, detail: count === 0 ? 'No data — scrape may have failed' : `Only ${count} units` };
}

function _checkUptake(syncPayload) {
  const count = syncPayload.uptakeCount;
  if (count === null || count === undefined) return { status: STATUS.YELLOW, detail: 'Not yet scraped this cycle' };
  if (count >= 5) return { status: STATUS.GREEN, detail: `${count} units enriched` };
  if (count > 0)  return { status: STATUS.YELLOW, detail: `Only ${count} units (low coverage)` };
  return { status: STATUS.RED, detail: 'Uptake returned 0 units' };
}

function _checkRelay(syncPayload) {
  const count = syncPayload.relayCount;
  if (count === null || count === undefined) return { status: STATUS.YELLOW, detail: 'Not yet scraped this cycle' };
  if (count >= 10) return { status: STATUS.GREEN, detail: `${count} units detailed` };
  if (count > 0)   return { status: STATUS.YELLOW, detail: `Only ${count} units (expected more)` };
  return { status: STATUS.RED, detail: 'Relay returned 0 — possible auth issue' };
}

function _checkAI(logPath) {
  // Read last 50 lines of app.log and count WS successes vs timeouts
  try {
    if (!fs.existsSync(logPath)) return { status: STATUS.YELLOW, detail: 'No log available' };
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').slice(-100);
    const okCount = lines.filter(l => l.includes('OK via WS')).length;
    const timeouts = lines.filter(l => l.includes('unit timeout')).length;
    const errors = lines.filter(l => l.includes('[relay] ERROR')).length;

    const total = okCount + timeouts + errors;
    if (total === 0) return { status: STATUS.YELLOW, detail: 'No AI calls yet this cycle' };

    const successRate = okCount / total;
    if (successRate >= 0.7) return { status: STATUS.GREEN, detail: `${okCount}/${total} calls OK (${Math.round(successRate*100)}%)` };
    if (successRate >= 0.4) return { status: STATUS.YELLOW, detail: `${okCount}/${total} calls OK — degraded (${Math.round(successRate*100)}%)` };
    return { status: STATUS.RED, detail: `${okCount}/${total} calls OK — AI severely degraded (${Math.round(successRate*100)}%)` };
  } catch (_) {
    return { status: STATUS.YELLOW, detail: 'Cannot read log' };
  }
}

function _checkMidway() {
  // Check cookie file for expiry
  try {
    const cookiePath = path.join(require('os').homedir(), '.midway', 'cookie');
    if (!fs.existsSync(cookiePath)) return { status: STATUS.RED, detail: 'Midway cookie not found — run mwinit' };

    const stat = fs.statSync(cookiePath);
    const ageHours = (Date.now() - stat.mtimeMs) / 3600000;

    if (ageHours < 8)  return { status: STATUS.GREEN, detail: `Cookie refreshed ${Math.round(ageHours)}h ago` };
    if (ageHours < 11) return { status: STATUS.YELLOW, detail: `Cookie ${Math.round(ageHours)}h old — refresh soon` };
    return { status: STATUS.RED, detail: `Cookie ${Math.round(ageHours)}h old — likely expired` };
  } catch (_) {
    return { status: STATUS.YELLOW, detail: 'Cannot check midway status' };
  }
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * runHealthCheck(syncPayload)
 * @param {Object} syncPayload - { count, uptakeCount, relayCount, syncedAt }
 * @returns {{ integrations: Object, overallScore: Number, overallStatus: String, degraded: Array }}
 */
function runHealthCheck(syncPayload) {
  const logPath = P.appLog || path.join(P.logsDir, 'app.log');

  const integrations = {
    aap:     { label: 'AAP Fleet Monitoring', ..._checkAAP(syncPayload) },
    uptake:  { label: 'Uptake Predictive',    ..._checkUptake(syncPayload) },
    relay:   { label: 'Relay Garage',         ..._checkRelay(syncPayload) },
    ai:      { label: 'Orcha AI (Bedrock)',   ..._checkAI(logPath) },
    midway:  { label: 'Midway Auth',          ..._checkMidway() },
  };

  // Score: green=100, yellow=50, red=0
  const scores = { green: 100, yellow: 50, red: 0 };
  const values = Object.values(integrations);
  const overallScore = Math.round(
    values.reduce((sum, i) => sum + scores[i.status], 0) / values.length
  );

  const overallStatus = overallScore >= 80 ? STATUS.GREEN
                      : overallScore >= 50 ? STATUS.YELLOW
                      : STATUS.RED;

  const degraded = values.filter(i => i.status !== STATUS.GREEN).map(i => i.label);

  // Persist to rolling history
  const state = _loadState();
  state.history.push({
    ts: new Date().toISOString(),
    score: overallScore,
    status: overallStatus,
    integrations: Object.fromEntries(
      Object.entries(integrations).map(([k, v]) => [k, v.status])
    ),
  });
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  state.lastCheck = new Date().toISOString();
  _saveState(state);

  logger.info(
    `Health: ${overallScore}% ${overallStatus.toUpperCase()} | ` +
    Object.entries(integrations).map(([k, v]) => `${k}=${v.status}`).join(' ')
  );

  return { integrations, overallScore, overallStatus, degraded };
}

module.exports = { runHealthCheck, STATUS };
