/**
 * paths.js — Centralized file path registry
 * Cross-platform: uses app.getPath() for all user data.
 * NEVER hardcode AppData\\Roaming or /home/user — always use this module.
 */

'use strict';

const path  = require('path');
const os    = require('os');

// Lazy-resolve so this module can be required before app is ready
let _dataDir = null;
function getDataDir() {
  if (_dataDir) return _dataDir;
  try {
    const { app } = require('electron');
    _dataDir = app.getPath('userData');
  } catch (_) {
    // Fallback for tests / CLI usage
    _dataDir = path.join(os.homedir(), '.fleet-ops');
  }
  return _dataDir;
}

// Allow override for tests
function setDataDir(dir) { _dataDir = dir; }

// ── Chrome user data dir (cross-platform) ────────────────────────────────────
function getChromeUserData() {
  if (process.platform === 'win32')
    return path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  if (process.platform === 'darwin')
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  // Linux
  return path.join(os.homedir(), '.config', 'google-chrome');
}

// ── AEA extension path (cross-platform, best-effort) ─────────────────────────
function getAeaExtensionPath() {
  const base = getChromeUserData();
  const extId = 'bkbighdlgofgdhcjnhocalbkiehhpdei';
  if (process.platform === 'win32')
    return path.join(base, 'Default', 'Extensions', extId, '2.0.0.5_0');
  if (process.platform === 'darwin')
    return path.join(base, 'Default', 'Extensions', extId, '2.0.0.5_0');
  return path.join(base, 'Default', 'Extensions', extId, '2.0.0.5_0');
}

const P = {
  // ── Core data dir ──────────────────────────────────────────────────────────
  get dataDir()              { return getDataDir(); },

  // ── Data files ─────────────────────────────────────────────────────────────
  get fleetData()            { return path.join(getDataDir(), 'fleet_data.json'); },
  get relayCache()           { return path.join(getDataDir(), 'relay_cache.json'); },
  get uptakeHash()           { return path.join(getDataDir(), 'uptake_hash.json'); },
  get notesStore()           { return path.join(getDataDir(), 'fleet_notes.json'); },
  get settings()             { return path.join(getDataDir(), 'settings.json'); },
  get opEmails()             { return path.join(getDataDir(), 'op_emails.json'); },
  get aapCache()             { return path.join(getDataDir(), 'aap_cache.json'); },
  get geofenceCache()        { return path.join(getDataDir(), 'geofence_cache.json'); },
  get wrQueue()              { return path.join(getDataDir(), 'wr_queue.json'); },
  get spConfig()             { return path.join(getDataDir(), 'sp_push_config.json'); },
  get orcaCorrections()      { return path.join(getDataDir(), 'orcha_corrections.json'); },
  get orchaVendorRules()     { return path.join(getDataDir(), 'orcha_vendor_rules.json'); },
  get orchaConfig()          { return path.join(getDataDir(), 'orcha_config.json'); },
  get emailConfig()          { return path.join(getDataDir(), 'email_config.json'); },
  get slackConfig()          { return path.join(getDataDir(), 'slack_config.json'); },
  get chatSessionId()        { return path.join(getDataDir(), 'chat_session_id.txt'); },

  // ── Daily notes ────────────────────────────────────────────────────────────
  get dailyNotesSnap()       { return path.join(getDataDir(), 'daily_notes_snapshots.json'); },
  get dailyNotesLog()        { return path.join(getDataDir(), 'daily_notes_log.json'); },
  get dailyNotesDec()        { return path.join(getDataDir(), 'daily_notes_decisions.json'); },
  get dailyNotesGenerated()  { return path.join(getDataDir(), 'daily_notes_generated.json'); },

  // ── Setup / credentials ────────────────────────────────────────────────────
  get setupState()           { return path.join(getDataDir(), 'setup_state.json'); },
  get credentialsStore()     { return path.join(getDataDir(), 'credentials.enc'); },

  // ── Asana ──────────────────────────────────────────────────────────────────
  get asanaConfig()          { return path.join(getDataDir(), 'asana_config.json'); },
  get asanaAuthState()       { return path.join(getDataDir(), 'asana_auth_state.json'); },
  get vendorHistory()        { return path.join(getDataDir(), 'vendor_history.json'); },
  get heartbeatState()       { return path.join(getDataDir(), 'heartbeat_state.json'); },
  get rcaStore()             { return path.join(getDataDir(), 'rca_store.json'); },
  get retentionHistory()     { return path.join(getDataDir(), 'retention_history.json'); },

  // ── Logs ───────────────────────────────────────────────────────────────────
  get logsDir()              { return path.join(getDataDir(), 'logs'); },
  get relayLog()             { return path.join(getDataDir(), 'logs', 'relay.log'); },
  get uptakeLog()            { return path.join(getDataDir(), 'logs', 'uptake.log'); },
  get appLog()               { return path.join(getDataDir(), 'logs', 'app.log'); },
  get orchaTimeoutLog()      { return path.join(getDataDir(), 'logs', 'orcha_timeouts.log'); },

  // ── Orcha engine state files ───────────────────────────────────────────────
  get orchaRelayStatus()     { return path.join(getDataDir(), 'orcha_relay_status.json'); },
  get orchaContext()         { return path.join(getDataDir(), 'orcha_context.json'); },
  get fleetHistory()         { return path.join(getDataDir(), 'fleet_history.json'); },

  // ── Orcha logs ─────────────────────────────────────────────────────────────
  get orchaRelayLog()        { return path.join(getDataDir(), 'logs', 'relay.log'); },
  get playwrightLog()        { return path.join(getDataDir(), 'logs', 'playwright_bridge.log'); },

  // ── Orcha port file ────────────────────────────────────────────────────────
  get orchaPort()            { return path.join(os.homedir(), '.orcha', 'agent_port'); },

  // ── Screenshots ────────────────────────────────────────────────────────────
  get screenshotsDir()       { return path.join(getDataDir(), 'screenshots'); },

  // ── Midway cookie (cross-platform) ─────────────────────────────────────────
  get midwayCookie()         { return path.join(os.homedir(), '.midway', 'cookie'); },

  // ── Playwright profile (OS-level, not in userData) ─────────────────────────
  get playwrightProfile()    { return path.join(os.homedir(), '.fleet-playwright-profile'); },

  // ── Chrome paths (cross-platform, best-effort) ─────────────────────────────
  get chromeUserData()       { return getChromeUserData(); },
  get aeaExtension()         { return getAeaExtensionPath(); },
};

module.exports = { P, setDataDir, getDataDir };
