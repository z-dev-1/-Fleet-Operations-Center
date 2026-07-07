/**
 * defaults.js — Application-wide defaults
 * No hardcoded usernames, no machine-specific paths.
 * All values here can be overridden by user settings or setup wizard.
 */

'use strict';

module.exports = {
  // ── Sync ──────────────────────────────────────────────────────────────────
  SYNC_INTERVAL_MS:      5 * 60 * 1000,   // 5 minutes
  SYNC_TIMEOUT_MS:       10 * 60 * 1000,  // 10 minutes hard cap

  // ── Scraper timeouts ──────────────────────────────────────────────────────
  PAGE_TIMEOUT_MS:       35000,
  PAGE_SETTLE_MS:        3000,
  WO_TAB_SETTLE_MS:      4000,
  MAX_CONCURRENT_UNITS:  5,
  UPTAKE_MASTER_TIMEOUT: 15 * 60 * 1000,
  UPTAKE_PAGE_TIMEOUT:   40000,

  // ── AAP ───────────────────────────────────────────────────────────────────
  DEFAULT_DOMICILES: ['ABE40', 'EWR45', 'PHL40', 'AVP40', 'AUVTE01'],
  AAP_PAGE_SIZE:     1000,
  AAP_BASE_URL:      'https://aap-na.corp.amazon.com',

  // ── AI / Orcha ────────────────────────────────────────────────────────────
  ORCHA_MAX_CONCURRENT:  5,
  ORCHA_TIMEOUT_MS:      90000,
  ORCHA_FALLBACK_PORT:   4799,
  BEDROCK_REGION:        'us-east-1',
  BEDROCK_MODEL_ID:      'us.amazon.nova-pro-v1:0',
  BEDROCK_MAX_TOKENS:    4096,

  // ── Priority engine ───────────────────────────────────────────────────────
  PRIORITY_STALE_DAYS:    3,
  PRIORITY_CRITICAL_DAYS: 7,
  PRIORITY_SLA_WARN_DAYS: 5,

  // ── Partner server ────────────────────────────────────────────────────────
  PARTNER_SERVER_PORT: 3847,

  // ── Email ─────────────────────────────────────────────────────────────────
  EMAIL_SMTP_HOST:    'ballard.amazon.com',
  EMAIL_SMTP_PORT:    1587,
  EMAIL_IMAP_PORT:    1993,

  // ── SharePoint ────────────────────────────────────────────────────────────
  SP_ORIGIN:    'https://amazon.sharepoint.com',
  SP_SITE:      '/sites/AFP-FAS',
  SP_TIMEOUT_MS: 60000,

  // ── FleetNet skip pattern ─────────────────────────────────────────────────
  SKIP_VENDOR_PATTERNS: ['fleetnet', 'fleet net'],

  // ── Logging ───────────────────────────────────────────────────────────────
  LOG_LEVEL: 'INFO',
  LOG_MAX_FILE_BYTES: 2 * 1024 * 1024,

  // ── Learning ──────────────────────────────────────────────────────────────
  MAX_CORRECTIONS: 500,
  DAILY_NOTES_RETENTION_DAYS: 7,

  // ── Setup ─────────────────────────────────────────────────────────────────
  SETUP_REQUIRED_STEPS: [
    'profile', 'domiciles', 'midway', 'slack',
    'sharepoint', 'email', 'orcha', 'database'
  ],
};
