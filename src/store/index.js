/**
 * store/index.js — Unified data store
 * Replaces the scattered load/save functions in cache.js (V-B).
 * All reads and writes go through here — one place, consistent error handling.
 *
 * Usage:
 *   const store = require('./store');
 *   const data  = store.load('fleetData');           // returns {} on missing
 *   store.save('fleetData', { rows: [...] });         // atomic write
 *   store.exists('relayCache');                       // boolean
 *
 * Stage 4 Bug B fix (2026-06-28):
 *   - Removed the absolute-path fallback in _resolvePath().
 *     Previously any caller could pass an absolute path and bypass the registry
 *     entirely — no access control, no path containment.
 *   - Added '_healthcheck' to REGISTRY (was previously exploiting the fallback
 *     via setup:verify-step → store.save('_healthcheck', ...)).
 *   - _resolvePath now throws on any name not in REGISTRY.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../utils/logger')('store');
const { P }  = require('../config/paths');

// Registry — maps store name → file path
// ALL legitimate store names must be registered here.
// No fallback for unknown names or absolute paths.
const REGISTRY = {
  fleetData:        () => P.fleetData,
  relayCache:       () => P.relayCache,
  uptakeHash:       () => P.uptakeHash,
  notesStore:       () => P.notesStore,
  settings:         () => P.settings,
  opEmails:         () => P.opEmails,
  aapCache:         () => P.aapCache,
  geofenceCache:    () => P.geofenceCache,
  wrQueue:          () => P.wrQueue,
  spConfig:         () => P.spConfig,
  orchaCorrections: () => P.orcaCorrections,
  orchaVendorRules: () => P.orchaVendorRules,
  orchaConfig:      () => P.orchaConfig,
  dailyNotesSnap:   () => P.dailyNotesSnap,
  chatHistory:      () => path.join(P.dataDir, 'chat-history.json'),
  repairHistory:    () => path.join(P.dataDir, 'repair-history.json'),
  aapLessons:       () => path.join(P.dataDir, 'aap-lessons.json'),
  offlineQueue:     () => path.join(P.dataDir, 'offline-queue.json'),
  orchaPatterns:    () => path.join(P.dataDir, 'orcha-patterns.json'),
  pins:             () => path.join(P.dataDir, 'pins.json'),
  schedules:        () => path.join(P.dataDir, 'schedules.json'),
  dailyNotesLog:    () => P.dailyNotesLog,
  dailyNotesDec:    () => P.dailyNotesDec,
  setupState:       () => P.setupState,
  asanaConfig:      () => P.asanaConfig,
  asanaAuthState:   () => P.asanaAuthState,
  // Bug B fix: _healthcheck now has a proper registered path instead of
  // relying on the removed absolute-path fallback.
  reminders:             () => path.join(P.dataDir, 'reminders.json'),
  contacts:              () => path.join(P.dataDir, 'contacts.json'),
  vendorAssignments:     () => path.join(P.dataDir, 'vendor-assignments.json'),
  partnerWRs_review:    () => path.join(P.dataDir, 'partner_review.json'),
  partnerWRs_scheduled: () => path.join(P.dataDir, 'partner_scheduled.json'),
  partnerWRs_processed: () => path.join(P.dataDir, 'partner_processed.json'),
  partnerFormsConfig:   () => path.join(P.dataDir, 'partner_forms_config.json'),
    _healthcheck:     () => path.join(P.dataDir, '_healthcheck.json'),
  vendorHistory:    () => P.vendorHistory,
  heartbeatState:   () => P.heartbeatState,
  rcaStore:         () => P.rcaStore,
  retentionHistory: () => P.retentionHistory,
  slackAutoReply:   () => path.join(P.dataDir, 'slack_auto_reply.json'), // FEATURE (2026-07-16)
  longDwellStore:   () => path.join(P.dataDir, 'long_dwell.json'), // FEATURE (2026-07-20): Analytics -> Long Dwell Units tab
  slackMentionThreads: () => path.join(P.dataDir, 'slack_mention_threads.json'), // thread-continuation tracking for channel watch
  bubbleConfig:     () => path.join(P.dataDir, 'bubble_config.json'),             // floating bubble opacity setting

  // Workflow Intelligence (Phase 8, 2026-07-19) - see docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md
  workflowRecordings:   () => path.join(P.dataDir, 'workflow_recordings.json'),
  workflowExecutionLog: () => path.join(P.dataDir, 'workflow_execution_log.json'),
  workflowPatterns:     () => path.join(P.dataDir, 'workflow_patterns.json'),

  // Slack Partner Auto-Reply (2026-07-21) -- see src/scrapers/slack_channel_watch.js
  slackChannelWatchConfig: () => path.join(P.dataDir, 'slack_channel_watch_config.json'),

  // Cloud Companion phone chat bridge (2026-07-24)
  cloudCompanion: () => path.join(P.dataDir, 'cloud_companion.json'),
  cloudCompanionPendingConfirm: () => path.join(P.dataDir, 'cloud_companion_pending_confirm.json'),
  slackJustMePendingConfirm: () => path.join(P.dataDir, 'slack_justme_pending_confirm.json'),
  slackChannelReplies:     () => path.join(P.dataDir, 'slack_channel_replies.json'),
  slackDMAutoReplyConfig:  () => path.join(P.dataDir, 'slack_dm_autoreply_config.json'),
  slackDMReplies:          () => path.join(P.dataDir, 'slack_dm_replies.json'),
  // RELIABILITY FIX (2026-09-02): slackDMThreadReplyCount was saved/loaded by
  // slack_dm_autoreply.js but never registered here — so store.load threw and
  // the thread-reply baseline cold-started on every launch. Registered now.
  slackDMThreadReplyCount: () => path.join(P.dataDir, 'slack_dm_thread_reply_count.json'),
  // Slack inbound pipeline reliability stores (2026-09, slack_inbound_support.js):
  //   - contact-save failures that need attention (surfaced in system health)
  //   - temporary send-block registry (restricted_action, with recheck TTL)
  //   - structured per-message lifecycle / activity history
  slackContactSaveFailures: () => path.join(P.dataDir, 'slack_contact_save_failures.json'),
  slackSendBlocks:          () => path.join(P.dataDir, 'slack_send_blocks.json'),
  slackInboundLifecycle:    () => path.join(P.dataDir, 'slack_inbound_lifecycle.json'),
  // Digital FAS agent (2026-09-02) — see src/orcha/fas/*.
  // Sender profiles (seeded from contacts), persistent case memory, FAS
  // playbook, knowledge-draft review queue, and agent config/audit.
  slackSenderProfiles:     () => path.join(P.dataDir, 'slack_sender_profiles.json'),
  fasCases:                () => path.join(P.dataDir, 'fas_cases.json'),
  fasPlaybook:             () => path.join(P.dataDir, 'fas_playbook.json'),
  fasKnowledgeDrafts:      () => path.join(P.dataDir, 'fas_knowledge_drafts.json'),
  fasConfig:               () => path.join(P.dataDir, 'fas_config.json'),
  fasAuditLog:             () => path.join(P.dataDir, 'fas_audit_log.json'),
  // Digital FAS coverage profile (2026-09) — Zila's assigned coverage derived
  // from the distinct operators (SCAC/carrier) + domiciles present in the
  // authoritative synced fleetData. Verified-vs-stale tracked; refreshed on
  // startup/sync/schedule/manual; stale coverage is preserved, never wiped by
  // an empty/failed refresh. See src/orcha/fas/coverage.js.
  fasCoverage:             () => path.join(P.dataDir, 'fas_coverage.json'),
  // Digital FAS versioned DOT/FMCSA compliance knowledge source (2026-09) —
  // searchable regulation records (jurisdiction, reg id, equipment, requirement,
  // effective + last-verified dates, authoritative source, FAS interpretation).
  // Seeded from a bundled baseline; correctable/extendable. Compliance
  // conclusions must be evidence-gated against this source, never invented.
  // See src/orcha/fas/compliance.js.
  fasCompliance:           () => path.join(P.dataDir, 'fas_compliance.json'),
  fasApprovalQueue:        () => path.join(P.dataDir, 'fas_approval_queue.json'),
  fasIdempotency:          () => path.join(P.dataDir, 'fas_idempotency.json'),
  fasMigrationLog:         () => path.join(P.dataDir, 'fas_migration_log.json'),
  contactsBackup:          () => path.join(P.dataDir, 'contacts_backup.json'),
  slackSenderProfilesBackup: () => path.join(P.dataDir, 'slack_sender_profiles_backup.json'),
  fasMigrationBackup_v1:   () => path.join(P.dataDir, 'fas_migration_backup_v1.json'),
  contactsTombstones:      () => path.join(P.dataDir, 'contacts_tombstones.json'),
  emailLastSnapshot:       () => path.join(P.dataDir, 'email_last_snapshot.json'),
  proactiveAlertHistory:  () => path.join(P.dataDir, 'proactive_alert_history.json'),
  proactiveLastScores:   () => path.join(P.dataDir, 'proactive_last_scores.json'),
  // Production backend scheduler (2026-08) — durable job ledger for SharePoint
  // push + scheduled OWA email jobs. See src/scheduler/ledger.js. Owns job
  // state machine, idempotency keys, expiring leases, completed-slot keys,
  // and per-scope snapshot bookkeeping. The immutable versioned migration
  // backup is stored under schedulerLedgerBackup_v1.
  schedulerLedger:         () => path.join(P.dataDir, 'scheduler_ledger.json'),
  schedulerLedgerBackup_v1: () => path.join(P.dataDir, 'scheduler_ledger_backup_v1.json'),
};

function _resolvePath(name) {
  if (REGISTRY[name]) return REGISTRY[name]();
  // Bug B fix: absolute-path fallback removed.
  // If you need a new store, add it to REGISTRY above.
  throw new Error(`Unknown store: "${name}" — add it to REGISTRY in store/index.js`);
}

/**
 * load(name, defaultValue?) — reads and parses JSON, returns default on any error
 */
function load(key, fallback) {
  const filePath = _resolvePath(key);
  if (!fs.existsSync(filePath)) return fallback !== undefined ? fallback : null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return fallback !== undefined ? fallback : null;
    return JSON.parse(raw);
  } catch (e) {
    // Corrupted JSON — try backup
    const bakPath = filePath + '.bak';
    if (fs.existsSync(bakPath)) {
      try { return JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch (_) {}
    }
    console.error('[store] Corrupted file:', filePath, e.message);
    return fallback !== undefined ? fallback : null;
  }
}

/**
 * save(name, data) — atomic write (write to .tmp then rename)
 */
function save(key, data) {
  const filePath = _resolvePath(key);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = filePath + '.tmp';
  const bakPath = filePath + '.bak';
  // BUG FIX (2026-07-14): load()'s corruption-recovery path below reads
  // `filePath + '.bak'` on a JSON parse failure, but until this fix NOTHING
  // in the codebase ever wrote a .bak file (confirmed via full-repo grep --
  // exactly one hit for ".bak" anywhere, the read side below). That fallback
  // was dead code giving false confidence: ANY corrupted store (fleetData,
  // notesStore, relayCache -- every store in REGISTRY) would silently fall
  // straight through to the caller's default value with zero chance of
  // recovery, no matter how recently it had been saved successfully.
  // Snapshot the last known-good file to .bak before each overwrite --
  // best-effort; if this fails (e.g. first-ever save) proceed with the write
  // anyway, there's simply no prior version yet to preserve.
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, bakPath); } catch (_) {}
  }
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // Cleanup temp file on failure
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
}

/**
 * update(name, mergeFn) — read-modify-write with merge function
 * mergeFn receives current value and returns new value.
 * NOTE: This synchronous version has no concurrency protection. For async
 * contexts where multiple callers may update the same store concurrently,
 * use updateAsync() below which serializes access per-store.
 */
function update(name, mergeFn, defaultValue = {}) {
  const current = load(name, defaultValue);
  const updated = mergeFn(current);
  save(name, updated);
  return updated;
}

// ── Phase 3: Per-store async mutex for safe concurrent updates ──────────────
// Simple promise-chain lock: each updateAsync() call for the same store key
// waits for the previous one to finish before entering read-modify-write.
// No external dependencies, no deadlock risk (each chain link always resolves).
const _locks = {};

/**
 * updateAsync(name, mergeFn, defaultValue?) — serialized read-modify-write
 * Same as update() but guarantees that concurrent callers for the SAME store
 * key are serialized (second caller waits for first to finish).
 * mergeFn may be sync or async (its return value is awaited).
 */
async function updateAsync(name, mergeFn, defaultValue = {}) {
  // Chain onto any pending operation for this store key
  const prev = _locks[name] || Promise.resolve();
  let release;
  _locks[name] = new Promise(resolve => { release = resolve; });

  try {
    await prev; // wait for prior operation to complete
    const current = load(name, defaultValue);
    const updated = await mergeFn(current);
    save(name, updated);
    return updated;
  } finally {
    release(); // unblock next waiter
  }
}

function exists(name) {
  try { return fs.existsSync(_resolvePath(name)); } catch (_) { return false; }
}

function del(name) {
  try { fs.unlinkSync(_resolvePath(name)); } catch (_) {}
}

module.exports = { load, save, update, updateAsync, exists, delete: del, REGISTRY };
