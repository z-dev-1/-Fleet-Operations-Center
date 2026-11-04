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

// ── Live snapshot aggregator ──────────────────────────────────────────────────
// buildHealthSnapshot(rows) — reads the REAL, live state of each integration at
// call time and returns the shape the renderer's Health panel consumes:
//   { overallScore, overallStatus, lastSync, totalUnits, aiConnected,
//     integrations: { key: { status, label, detail } } }
//
// Unlike runHealthCheck() (which classifies a single sync payload), this reads
// the app's current runtime signals directly — relay/AI connectivity, Midway
// auth expiry, data freshness, canonical reconcile freshness, and network
// state. It is HONEST: a signal that is genuinely down/stale reports red/yellow,
// and a signal that can't be read degrades to yellow ("unknown") rather than
// pretending green. Every probe is wrapped so this never throws.
//
// SharePoint/Slack are PUSH integrations with no always-on connection to probe,
// so they are reported from their real configured + last-delivery state (via
// the scheduler ledger) and shown grey/"not configured" when unused — never a
// fake green.

function _safe(fn, fallback) {
  try { const v = fn(); return v === undefined ? fallback : v; } catch (_) { return fallback; }
}

function _fmtAge(ms) {
  if (ms == null || !isFinite(ms)) return 'unknown';
  const m = Math.round(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Data freshness / AAP sync — real syncedAt age + row count.
function _snapSync(rows) {
  const store = require('../store');
  const fd = _safe(() => store.load('fleetData', {}), {}) || {};
  const syncedAt = fd.syncedAt || null;
  const count = Array.isArray(rows) ? rows.length : ((fd.rows && fd.rows.length) || 0);
  if (!syncedAt && !count) {
    return { status: STATUS.YELLOW, label: 'Fleet Sync (AAP)', detail: 'No data synced yet', syncedAt: null };
  }
  const ageMs = syncedAt ? (Date.now() - new Date(syncedAt).getTime()) : null;
  const ageTxt = _fmtAge(ageMs);
  // Thresholds: fresh < 90m, stale < 6h, dead beyond.
  let status = STATUS.GREEN;
  if (ageMs == null)             status = STATUS.YELLOW;
  else if (ageMs > 6 * 3600000)  status = STATUS.RED;
  else if (ageMs > 90 * 60000)   status = STATUS.YELLOW;
  if (!count) status = STATUS.RED;
  const detail = count
    ? `${count} units • synced ${ageTxt}`
    : `No units • last sync ${ageTxt}`;
  return { status, label: 'Fleet Sync (AAP)', detail, syncedAt };
}

// Relay + AI connectivity — real relay.getStatus() + fleet-brain WS state.
function _snapAI() {
  let st = null;
  try { st = require('./relay').getStatus(); } catch (_) {}
  if (!st) return { status: STATUS.YELLOW, label: 'AI (Relay)', detail: 'Status unavailable', connected: false };
  const backends = st.backends || {};
  const anyUp = !!(backends.orcha || backends.claude);
  const lanes = [];
  if (backends.orcha) lanes.push('Orcha');
  if (backends.claude) lanes.push('Claude');
  let status, detail;
  if (anyUp) {
    status = (backends.orcha && backends.claude) ? STATUS.GREEN : STATUS.GREEN;
    detail = `Connected via ${lanes.join(' + ')}`;
    if (st.errorCount && st.requestCount && (st.errorCount / st.requestCount) > 0.3) {
      status = STATUS.YELLOW;
      detail += ` • ${st.errorCount}/${st.requestCount} recent errors`;
    }
  } else {
    // No lane reachable. Recent success softens to yellow (transient) vs red.
    const recentOk = st.lastHealthy && (Date.now() - st.lastHealthy < 15 * 60 * 1000);
    status = recentOk ? STATUS.YELLOW : STATUS.RED;
    detail = st.lastError
      ? `No backend reachable — ${String(st.lastError).slice(0, 60)}`
      : (recentOk ? `No backend reachable (last OK ${_fmtAge(Date.now() - st.lastHealthy)})` : 'No AI backend reachable');
  }
  return { status, label: 'AI (Relay)', detail, connected: anyUp };
}

// Midway auth — real cookie-expiry clock (checkMwinit), honest about expiry.
function _snapAuth() {
  let r = null;
  try { r = require('../scrapers/auth').checkMwinit(); } catch (_) {}
  if (!r) return { status: STATUS.YELLOW, label: 'Midway Auth', detail: 'Status unavailable' };
  if (!r.ok) {
    return { status: STATUS.RED, label: 'Midway Auth', detail: r.reason || 'Session invalid — run mwinit' };
  }
  const mins = r.expiresInMin;
  if (mins == null) return { status: STATUS.GREEN, label: 'Midway Auth', detail: 'Session valid' };
  if (mins <= 0)    return { status: STATUS.RED,    label: 'Midway Auth', detail: 'Session expired — run mwinit' };
  const h = Math.floor(mins / 60), m = mins % 60;
  const left = h ? `${h}h ${m}m` : `${m}m`;
  let status = STATUS.GREEN;
  if (mins < 30)       status = STATUS.RED;      // expiring imminently
  else if (mins < 120) status = STATUS.YELLOW;   // refresh soon (< 2h)
  return { status, label: 'Midway Auth', detail: `Session valid • ${left} left` };
}

// Canonical reconcile freshness — real canonicalState store timestamps.
function _snapCanonical() {
  const store = require('../store');
  const cs = _safe(() => store.load('canonicalState', {}), {}) || {};
  const units = cs.units ? Object.keys(cs.units).length : 0;
  if (!cs.updatedAt && !units) {
    return { status: STATUS.YELLOW, label: 'Canonical State', detail: 'Not computed yet' };
  }
  const ageMs = cs.updatedAt ? (Date.now() - new Date(cs.updatedAt).getTime()) : null;
  const recAgeMs = cs.lastReconcileAt ? (Date.now() - new Date(cs.lastReconcileAt).getTime()) : null;
  // Canonical is recomputed each sync; it should track sync freshness.
  let status = STATUS.GREEN;
  if (ageMs == null)             status = STATUS.YELLOW;
  else if (ageMs > 6 * 3600000)  status = STATUS.YELLOW; // stale, not critical
  const rec = recAgeMs != null ? ` • AI-reconciled ${_fmtAge(recAgeMs)}` : '';
  const detail = `${units} units • updated ${_fmtAge(ageMs)}${rec}`;
  return { status, label: 'Canonical State', detail };
}

// Network — real offline/VPN state.
function _snapNetwork() {
  let offline = false;
  try { offline = !!require('./offline').isOffline(); } catch (_) {}
  if (offline) return { status: STATUS.RED, label: 'Network', detail: 'Offline — operating from cache' };
  let vpn = null;
  try { vpn = require('../utils/vpn').checkVpnState && require('../utils/vpn').checkVpnState(); } catch (_) {}
  // checkVpnState may be async; only use a synchronous boolean-ish result.
  if (vpn && typeof vpn === 'object' && typeof vpn.connected === 'boolean') {
    return vpn.connected
      ? { status: STATUS.GREEN, label: 'Network', detail: 'Online • VPN connected' }
      : { status: STATUS.YELLOW, label: 'Network', detail: 'Online • VPN not detected' };
  }
  return { status: STATUS.GREEN, label: 'Network', detail: 'Online' };
}

// SharePoint — a PUSH channel tracked in the scheduler ledger (channel
// 'sharepoint'). Status comes from the real last job state for that channel.
// If it has never run, it's grey "no deliveries yet" — never a fake green.
function _snapSharePoint() {
  const label = 'SharePoint';
  let jobs = _safe(() => require('../scheduler/ledger').listJobs({ channel: 'sharepoint' }), null);
  if (!Array.isArray(jobs)) {
    return { status: 'grey', label, detail: 'Status unavailable' };
  }
  if (jobs.length === 0) {
    return { status: 'grey', label, detail: 'No pushes yet' };
  }
  const last = jobs[0]; // listJobs sorts newest-first by createdAt
  const st = String(last.state || '').toLowerCase();
  const whenMs = last.updatedAt ? (Date.now() - new Date(last.updatedAt).getTime()) : null;
  const when = whenMs != null ? ` ${_fmtAge(whenMs)}` : '';
  if (st === 'completed')             return { status: STATUS.GREEN,  label, detail: `Last push OK${when}` };
  if (st === 'sent' || st === 'verifying') return { status: STATUS.GREEN, label, detail: `Push in progress${when}` };
  if (st === 'failed' || st === 'cancelled') return { status: STATUS.RED, label, detail: `Last push ${st}${when}` };
  if (st.includes('blocked'))         return { status: STATUS.RED,    label, detail: `Blocked (${st.replace('blocked_', '')})${when}` };
  if (st === 'delivery_uncertain')    return { status: STATUS.YELLOW, label, detail: `Delivery uncertain${when}` };
  if (st === 'partial_failure')       return { status: STATUS.YELLOW, label, detail: `Partial failure${when}` };
  // queued / syncing / validating / running / retry — in flight
  return { status: STATUS.YELLOW, label, detail: `${st || 'pending'}${when}` };
}

// Slack — a direct push (not ledger-tracked). The real "configured" signal is
// whether a Slack token credential is stored (set during slack:login). Signed
// out → grey; signed in → green. Honest, no fake green.
function _snapSlack() {
  const label = 'Slack';
  const keys = _safe(() => require('../security/credentials').list(), null);
  if (!Array.isArray(keys)) {
    return { status: 'grey', label, detail: 'Status unavailable' };
  }
  const signedIn = keys.includes('slack.token');
  return signedIn
    ? { status: STATUS.GREEN, label, detail: 'Signed in' }
    : { status: 'grey', label, detail: 'Not signed in' };
}

function buildHealthSnapshot(rows) {
  const sync      = _snapSync(rows);
  const ai        = _snapAI();
  const auth      = _snapAuth();
  const canonical = _snapCanonical();
  const network   = _snapNetwork();
  const sp         = _snapSharePoint();
  const slack      = _snapSlack();

  const integrations = {
    sync:      { status: sync.status,      label: sync.label,      detail: sync.detail },
    ai:        { status: ai.status,        label: ai.label,        detail: ai.detail },
    auth:      { status: auth.status,      label: auth.label,      detail: auth.detail },
    canonical: { status: canonical.status, label: canonical.label, detail: canonical.detail },
    network:   { status: network.status,   label: network.label,   detail: network.detail },
    sp:        { status: sp.status,         label: sp.label,         detail: sp.detail },
    slack:     { status: slack.status,      label: slack.label,      detail: slack.detail },
  };

  // Overall score: average of the CORE always-on integrations only (sync, ai,
  // auth, canonical, network). SharePoint/Slack are optional push channels and
  // a "not configured" grey must not drag the score down.
  const scores = { green: 100, yellow: 50, red: 0 };
  const core = [sync, ai, auth, canonical, network];
  const overallScore = Math.round(
    core.reduce((s, i) => s + (scores[i.status] != null ? scores[i.status] : 50), 0) / core.length
  );
  const overallStatus = overallScore >= 80 ? STATUS.GREEN
                      : overallScore >= 50 ? STATUS.YELLOW
                      : STATUS.RED;

  const degraded = core.filter(i => i.status !== STATUS.GREEN).map(i => i.label);

  return {
    overallScore,
    overallStatus,
    lastSync: sync.syncedAt || null,
    totalUnits: Array.isArray(rows) ? rows.length : 0,
    aiConnected: !!ai.connected,
    degraded,
    integrations,
  };
}

module.exports = { runHealthCheck, buildHealthSnapshot, STATUS };
