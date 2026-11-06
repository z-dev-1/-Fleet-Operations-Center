'use strict';
/**
 * email-intel/constants.js — frozen limits and thresholds for the Email Triage
 * Intelligence module (design 1.3, plus the F2-07 message-ledger byte cap).
 *
 * Config values are clamped to the *_HARD maximums elsewhere. Nothing in this
 * file may be lowered to increase automation: AUTO_APPLY_MIN_CONFIDENCE is
 * pinned by test, compared with `>=`, and configuration can only raise it.
 */

const CONSTANTS = Object.freeze({
  // Confidence gate for automatic timeline writes. Config may only raise it: max(0.75, cfg).
  AUTO_APPLY_MIN_CONFIDENCE: 0.75,
  PROMPT_VERSION: 'ei-2',
  SCHEMA_VERSION: 2,

  // Reader bounds.
  MAX_EMAILS_DEFAULT: 25, MAX_EMAILS_HARD: 50,            // rows examined to ingest per scan
  MAX_OPEN_DEFAULT: 40, MAX_OPEN_HARD: 60,                // messages opened per scan
  MIN_PER_FOLDER: 3, SCROLL_PAGES: 3, ROWS_EXAMINED_PER_FOLDER: 150,
  FOLDER_SOFT_MS: 90_000, WINDOW_HARD_MS: 240_000,        // existing hard timeout preserved
  RAW_BODY_CAP: 60_000, STORED_BODY_CAP: 12_000, SCAN_RAW_CAP: 2_000_000,

  // AI bounds.
  AI_CALLS_DEFAULT: 24, AI_CALLS_HARD: 40, AI_CALL_TIMEOUT_MS: 60_000,
  AI_CONCURRENCY: 1, AI_CONCURRENCY_HARD: 2,              // scan AI calls in flight (F-17)
  LANE_FAILS_TRIP: 3,                                     // consecutive lane failures that stop AI for the scan (F-16)
  WINDOW_CHARS: 6_000, WINDOW_OVERLAP: 400, MAX_WINDOWS: 3,
  ANALYSIS_ATTEMPTS_MAX: 3,                               // counts invalid-output failures only (F-16)
  EVIDENCE_PROXIMITY_CHARS: 400,

  // Scope, freshness, scan.
  LOOKBACK_DAYS_DEFAULT: 14,
  FLEET_STALE_HOURS: 36,                                  // fleetData older than this => scope unknown (F-25)
  SCAN_DEADLINE_MS: 20 * 60_000,                          // below the supervisor 30 min timeout (F-20)
  PREVIEW_RETRY_MAX: 3,                                   // preview-only rows retried before ingest (F-03)
  TZ_UNPROVABLE_WINDOW_MS: 12 * 3_600_000,                // used until probe P-TZ confirms zones (F-27)

  // Message ledger memory bound (F2-07).
  MAX_MESSAGES_BYTES: 8_000_000,
  MESSAGES_EVICT_TARGET_RATIO: 0.75,
  STORED_BODY_CAP_OLD: 2_000,
  OLD_MESSAGE_AGE_MS: 7 * 86_400_000,

  // Phase A capture details (design 2.2, 2.7, 2.8).
  KNOWN_ROWS_STOP: 8,                                     // consecutive known rows that end a caught-up folder scan (F-04)
  SEEN_ROWS_LRU: 300,                                     // seenRows entries kept per folder checkpoint
  BATCH_MESSAGES: 5,                                      // messages per committed batch
  OPEN_WAIT_MS: 800,                                      // wait after opening a row before reading the pane
  FOLDER_SWITCH_WAIT_MS: 2_000,
  AUTH_GRACE_MS: 12_000,                                  // auth-wall grace before the scan is declared blocked
  DEADLINE_MARGIN_MS: 60_000,                             // reader stops opening rows with less than this left (F-20)
  MAX_PANE_BLOCKS: 12,                                    // blocks read from a first-seen conversation view
  RECIPIENTS_CAP: 200,
  MAX_MESSAGES: 1_500,                                    // retention: messages kept in the ledger
  MESSAGE_RETENTION_MS: 30 * 86_400_000,
  CONFIG_MAX_BYTES: 32 * 1024,                            // set-config payload cap (F-19)
  MAILBOX_FOLDERS_MAX: 12,
  BODY_FOR_LEGACY_CAP: 8_000,                             // bodyText handed to the legacy adapter record

  // Confirmation tokens (design 1.7).
  CONFIRM_TTL_MS: 5 * 60_000,
  CONFIRM_MAX_LIVE_TOKENS: 50,
  CONFIRM_DETAIL_MAX_CHARS: 2_000,
  CONFIRM_LABEL_MAX_CHARS: 60,

  // Store documents (design 1.2).
  STORE_VERSION: 1,
});

module.exports = CONSTANTS;
