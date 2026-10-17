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
  // AI MODEL SELECTION — IMPORTANT, read before changing AI_MODEL_ID:
  //   The LIVE model is NOT chosen here. All real AI goes through the Orcha
  //   agent (fleet-brain/relay) whose server-side model is selected by
  //   `orchaAgentId` in orcha_config.json (Settings → AI → Orcha Agent / the
  //   Claude Code model picker). To upgrade the model (e.g. Claude Sonnet 4.6
  //   for stronger WO/screenshot reading), change it THERE — not here.
  //   Recommendation: a "Medium"-speed Sonnet, NOT an Opus. Every Opus tier is
  //   "Slow"; that is exactly what caused the 2026-08-17 regression where
  //   responses hit ~90s+ and blew past the per-feature timeouts (Slack
  //   auto-reply 20s, Daily Call 25s, Fleet Chat 60s).
  //
  //   AI_MODEL_ID below ONLY feeds the DIRECT Bedrock SDK fallback in
  //   bedrock.js. That path is effectively DEAD: the Cecelia shared IAM role is
  //   not authorized to call bedrock:InvokeModel on any model (verified 2026-10
  //   — AccessDenied on every id). It is kept as a last-resort name only; it
  //   does NOT determine the model any working feature uses.
  AI_MODEL_ID:           'us.amazon.nova-pro-v1:0',
  AI_REGION:             'us-east-1',
  AI_BEDROCK_REGION:     'us-east-1',
  AI_MAX_TOKENS:         4096,
  // NOTE on vision/attachment reading (FAS): there is deliberately NO separate
  // "better model" id here. The Cecelia shared Bedrock role canNOT call
  // bedrock:InvokeModel directly (verified 2026-10 — every model returns
  // AccessDenied), so a direct Converse multimodal call is impossible with
  // these creds. Attachment reading (bedrock.readFileWithVision) instead goes
  // through the Claude Code toolbox binary's Read tool, which handles images +
  // PDFs on the auth path the SDK role lacks. The model is whatever that
  // toolbox is configured to use — not selectable from here.

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
