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
  // Per-step recipe learning for the AdaptiveWR agent (2026-08): proven action
  // sequences keyed by wizard step name, replayed (payload-hydrated) on future
  // runs so a perfected step is executed without asking the AI. See
  // src/scrapers/aap_adaptive_agent.js (RECIPE_STORE_KEY).
  aapStepRecipes:   () => path.join(P.dataDir, 'aap-step-recipes.json'),
  // Operator -> Slack channel + owner mapping for the PM-alert carrier fan-out
  // (2026-10). See src/scrapers/pm_alert_reply.js. Shape:
  //   { operators: [ { operator, channelId, ownerId, ownerName } ] }
  operatorChannels: () => path.join(P.dataDir, 'operator-channels.json'),
  // Dedup ledger so a PM alert is fanned out to a carrier channel only once.
  pmAlertFanout:    () => path.join(P.dataDir, 'pm-alert-fanout.json'),
  // Dedup ledger for the "unit ready for pickup → notify carrier" message
  // (2026-10). See src/scrapers/ready_pickup_notify.js. Keyed by
  // equipmentId + statusChangedAt so each distinct ready event is sent once.
  readyPickupNotices: () => path.join(P.dataDir, 'ready-pickup-notices.json'),
  // Daily Carrier Briefing (2026-10). See src/scrapers/carrier_briefing.js.
  // Config shape: { enabled, sendTime:'HH:MM', timezone, includeDown,
  //   includeFlagged, includeActive, includeDomiciles, riskThreshold, tipEnabled }.
  carrierBriefingConfig: () => path.join(P.dataDir, 'carrier-briefing-config.json'),
  // Run ledger: per-operator-per-day dedup keys ('OPERATOR:YYYY-MM-DD') + a
  // short rolling history of recent safety tips so the AI avoids repeats.
  // Shape: { sent: { 'OP:2026-08-14': ISO, ... }, lastRunAt, recentTips: [..] }.
  carrierBriefingLog:    () => path.join(P.dataDir, 'carrier-briefing-log.json'),
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
  longDwellCsv:     () => path.join(P.dataDir, 'long_dwell_csv.json'), // FEATURE: imported AAP tracker CSV + team-filled N-R columns
  fasRoster:        () => path.join(P.dataDir, 'fas_roster.json'),    // FEATURE: scraped FAS roster snapshot (FAS personnel)
  slackMentionThreads: () => path.join(P.dataDir, 'slack_mention_threads.json'), // thread-continuation tracking for channel watch
  bubbleConfig:     () => path.join(P.dataDir, 'bubble_config.json'),             // floating bubble opacity setting

  // DTNA (and future vendor) session pre-warm bookkeeping (2026-10). Tracks the
  // last day we silently warmed each vendor portal so the morning pre-warm runs
  // once/day. See src/scrapers/vendor_session.js. Shape: { lastWarmedDay: {dtna:'YYYY-MM-DD'} }.
  vendorWarm:           () => path.join(P.dataDir, 'vendor-warm.json'),
  // DBR DATA (Daily Call) — cached result of the last AFP QuickSight scrape.
  // See src/scrapers/quicksight_dbr.js + src/ipc/scrapers.js 'quicksight:scrape'.
  // Shape: { ok, domicile:[{domicile,uptimePct,unitsUnavailable}],
  //          scac:[{scac,domicile,uptimePct,unitsUnavailable}], scrapedAt, error? }.
  quicksightDbr:        () => path.join(P.dataDir, 'quicksight_dbr.json'),
  // DBR DATA (Daily Call) — DSP section cache. Shape: { ok,
  // scac:[{scac,uptimePct,unitsUnavailable,unitsUnavailableEstimated,assetCount,downtimePct}],
  // scrapedAt, error? }.
  quicksightDbrDsp:     () => path.join(P.dataDir, 'quicksight_dbr_dsp.json'),
  // Daily Tasks / Action Board (2026-10) — replaces the former Workflow
  // Intelligence recorder/library (Phase 8, removed). The "Workflow AI" tab is
  // now an AI-generated + manual daily task board. See src/ipc/daily-tasks.js.
  // Shape: { ai: [task], manual: [task], lastGeneratedDay, lastGeneratedAt }.
  // task: { id, source:'ai'|'manual', text, unitId?, action?, urgency?,
  //         due?, done, dismissed, createdAt, resolvedAt?, dedupeKey }.
  dailyTasks:           () => path.join(P.dataDir, 'daily_tasks.json'),

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
  // Digital FAS shared inbound-message claim ledger (2026-09, spec v2) — the
  // durable, atomic exactly-once owner registry for every inbound Slack message
  // keyed by channelId|ts|threadTs. Acquired BEFORE either engine (Digital FAS
  // or legacy) processes, so the two can never respond concurrently, a retry
  // cannot duplicate, and a restart cannot resend an already-delivered reply.
  // Claims carry a lease so a crashed in-flight claim is recoverable. See
  // src/orcha/fas/inbound-claim.js.
  fasInboundClaims:        () => path.join(P.dataDir, 'fas_inbound_claims.json'),
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
  // Dual-instance coordination — the local coordination-store backend.
  // clusterLeadership holds the single leadership record (leader, fencingToken,
  // lease expiry, mode, heartbeat); it is SQLite-backed so compare-and-set
  // acquire/renew is atomic exactly like the scheduler ledger. clusterEventLog
  // is the append-only incremental-sync log (shared-operational key changes).
  // clusterSyncVersions is the per-key { key: version } sidecar for the sync
  // engine's last-writer-wins conflict resolution (Stage 4).
  clusterLeadership:       () => path.join(P.dataDir, 'cluster_leadership.json'),
  clusterEventLog:         () => path.join(P.dataDir, 'cluster_event_log.json'),
  clusterSyncVersions:     () => path.join(P.dataDir, 'cluster_sync_versions.json'),
  // OWA Inbox Triage (2026-10) — see src/scrapers/owa_reader.js + email_triage.js.
  // Config shape: { enabled, maxEmails, autoApplyUnitUpdates, scanOnOpen,
  //   lastRunAt }. (Reading the inbox + AI triage; all mailbox/DM mutations are
  //   still confirm-gated.)
  emailTriageConfig:       () => path.join(P.dataDir, 'email_triage_config.json'),
  // Triage results — the last read + AI-triaged inbox. Per-email records keep a
  // STABLE id (OWA internetMessageId / conversationId) so the per-email "Reply"
  // option persists across new mail and app restarts (an older email's reply
  // option never disappears just because newer mail arrived). Shape:
  //   { emails: [ { id, from, fromName, subject, receivedAt, importance,
  //       summary, replySuggested, replyDraft?, replyState, attachments:[{name,
  //       type,understood}], unitRefs:[{unit, update, ready}], triagedAt } ],
  //     ranAt, authBlocked? }.
  emailTriageResults:      () => path.join(P.dataDir, 'email_triage_results.json'),
  // Deletion learning (2026-10) — records sender/subject patterns the user
  // DELETES vs KEEPS so the AI triage leans toward their real junk habits and
  // never re-suggests deleting something they chose to keep. Shape:
  //   { deleted: { '<senderKey>': {count,lastAt,samples:[subj..]} },
  //     kept:    { '<senderKey>': {count,lastAt} },
  //     keywords:{ deleted:{word:count}, kept:{word:count} } }.
  emailTriageLearning:     () => path.join(P.dataDir, 'email_triage_learning.json'),
  // Relay ↔ Offsite reconcile (2026-10) — see src/scrapers/relay_reconcile.js.
  // Config: { enabled, autoPostToRelay (MODE A vs MODE B), staleDays,
  //   maxUnitsPerSync, minConfidence }.
  relayReconcileConfig:    () => path.join(P.dataDir, 'relay_reconcile_config.json'),
  // MODE B staging queue: Relay-comment / dealer-ask posts awaiting an explicit
  // confirm before they are written to the real AAP work request. Shape:
  //   { items: [ { id, equipmentId, serviceUrl, kind:'gap-fill'|'dealer-ask',
  //       text, decision, stagedAt, state:'pending'|'posted'|'dismissed' } ] }.
  relayReconcilePending:   () => path.join(P.dataDir, 'relay_reconcile_pending.json'),
  // Dedup ledger so the same gap-fill / dealer-ask isn't re-staged or re-posted
  // on every 5-min rescan. Keyed by equipmentId -> { lastGapSig, lastAskSig, lastAt }.
  relayReconcileLog:       () => path.join(P.dataDir, 'relay_reconcile_log.json'),
  // Fleet Action Board execution config (2026-10) — per-action MODE A/B switch.
  // MODE A (default, all false) = the "Do it" button deep-links into the
  // existing confirm-gated flow. MODE B (true) = one-click execute behind a
  // single YES confirm. Shape: { autoExecute: { <action_slug>: bool } }.
  fleetActionConfig:       () => path.join(P.dataDir, 'fleet_action_config.json'),
  // Canonical state (2026-10) — the ONE AI-reconciled authoritative state
  // record per unit, the single source of truth every reasoning surface reads.
  // No new UI; a few key fields are mirrored onto fleetData rows so existing
  // panels can read it. Two-tier: a cheap deterministic baseline is computed
  // for EVERY unit each sync, upgraded by the AI reconcile for the units that
  // need deeper reasoning (down/offsite/stale), bounded like the reconcile
  // pass. The AI reconciles conflicts (AAP vs Relay vs Offsite) and records
  // which source it trusted + confidence — there is no hardcoded precedence.
  // See src/orcha/canonical_state.js. Shape:
  //   { units: { <equipmentId>: { equipmentId, status, situation, nextStep,
  //       source, confidence, stale, waitingOn, flags:[], aiReconciled,
  //       updatedAt } }, updatedAt, lastReconcileAt }.
  canonicalState:          () => path.join(P.dataDir, 'canonical_state.json'),
  // WBR weekly metric history (2026-10) — rolling per-ISO-Monday-week snapshots
  // of the per-site + fleet-total DOWN metrics (assets down, by-fuel, location
  // split, per-vendor, PM-flagged, canonical status mix). Captured on the first
  // sync of each week (Monday boundary) + on Generate WBR, latest-wins per week.
  // Powers the WBR's real Prior-Week / Trailing-6-Week comparison + unit
  // movement, replacing the former "enter manually" placeholder. See
  // src/orcha/wbr_snapshot.js. Shape: { weeks: [ { week:'YYYY-Www', weekStart,
  //   capturedAt, total:SiteMetrics, sites:{key:SiteMetrics} } ], updatedAt }.
  wbrHistory:              () => path.join(P.dataDir, 'wbr_history.json'),
  // Cached AI analysis for the unit-detail History tab's per-breakdown records
  // (2026-10). Keyed so a breakdown's analysis is generated once and reused on
  // every panel open. See src/ipc/misc.js 'breakdown-history:get' +
  // src/orcha/repair-history.js buildBreakdowns. Shape:
  //   { bySig: { '<sig>': { analysis, at } },
  //     summaries: { '<equipmentId>': { summary, sigKey, at } } }.
  breakdownAnalysis:       () => path.join(P.dataDir, 'breakdown_analysis.json'),
};

function _resolvePath(name) {
  if (REGISTRY[name]) return REGISTRY[name]();
  // Bug B fix: absolute-path fallback removed.
  // If you need a new store, add it to REGISTRY above.
  throw new Error(`Unknown store: "${name}" — add it to REGISTRY in store/index.js`);
}

// ── Critical transactional state → SQLite ───────────────────────────────────
// These store keys hold exactly-once / lease / idempotency ledgers whose
// correctness depends on crash-atomic writes and race-free read-modify-write —
// guarantees the JSON file store cannot give (a crash mid-write can tear the
// whole document; a non-mutexed load→save can let two callers both "win").
//
// For these keys ONLY, load/save/exists/delete and update/updateAsync route
// through the built-in SQLite engine (store/sqlite_engine.js, backed by
// node:sqlite). The whole-document contract is preserved byte-for-byte: each
// key is one JSON document, now stored as one atomic row instead of a file. No
// caller changes; inbound-claim.js, scheduler/ledger.js, fas/executor.js and
// their tests keep calling store.* exactly as before.
//
// If the runtime lacks node:sqlite, the engine reports unavailable and we fall
// back to the JSON file store transparently — the app never hard-fails.
const SQLITE_KEYS = new Set([
  'schedulerLedger',
  'schedulerLedgerBackup_v1',
  'clusterLeadership',   // atomic CAS for the leadership lease / fencing token
  'fasInboundClaims',
  'fasIdempotency',
]);

let _sqlite = null;
function _engine() {
  if (_sqlite === null) {
    try { _sqlite = require('./sqlite_engine'); } catch (_) { _sqlite = false; }
  }
  return _sqlite || null;
}

// True when `name` should be served by SQLite AND the engine is actually
// available on this runtime. Any failure path falls back to JSON files.
function _useSqlite(name) {
  if (!SQLITE_KEYS.has(name)) return false;
  const eng = _engine();
  try { return !!(eng && eng.isAvailable()); } catch (_) { return false; }
}

// One-time import of a pre-existing JSON document into SQLite on first touch.
// If the key already has a SQLite row, this is a no-op. If a legacy JSON file
// exists and SQLite has no row yet, copy the JSON doc in (the JSON file is left
// in place as an automatic, untouched backup of the pre-migration state).
const _migratedKeys = new Set();
function _migrateJsonToSqlite(name) {
  if (_migratedKeys.has(name)) return;
  _migratedKeys.add(name);
  const eng = _engine();
  if (!eng) return;
  try {
    if (eng.hasDoc(name)) return; // already in SQLite
    const filePath = _resolvePath(name);
    if (!fs.existsSync(filePath)) return; // nothing to import
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      // Try the .bak from the JSON store's own recovery path.
      const bak = filePath + '.bak';
      if (!fs.existsSync(bak)) return;
      try { parsed = JSON.parse(fs.readFileSync(bak, 'utf8')); } catch (_) { return; }
    }
    eng.writeDoc(name, parsed);
    logger.info('migrated transactional store "' + name + '" from JSON into SQLite');
  } catch (e) {
    logger.warn('migration of "' + name + '" into SQLite failed (keeping JSON): ' + e.message);
  }
}

/**
 * load(name, defaultValue?) — reads and parses JSON, returns default on any error
 */
function load(key, fallback) {
  if (_useSqlite(key)) {
    _migrateJsonToSqlite(key);
    try {
      const doc = _engine().readDoc(key);
      if (doc !== undefined) return doc;
      return fallback !== undefined ? fallback : null;
    } catch (e) {
      logger.warn('SQLite load("' + key + '") failed, falling back to JSON: ' + e.message);
      // fall through to the JSON path below
    }
  }
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
  if (_useSqlite(key)) {
    _migrateJsonToSqlite(key);
    try { _engine().writeDoc(key, data); return; }
    catch (e) {
      logger.warn('SQLite save("' + key + '") failed, falling back to JSON: ' + e.message);
      // fall through to the JSON path below
    }
  }
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
  if (_useSqlite(name)) {
    _migrateJsonToSqlite(name);
    try {
      // Whole read-modify-write inside ONE IMMEDIATE transaction: crash-atomic
      // and serialized against concurrent writers by SQLite itself.
      const eng = _engine();
      return eng.tx(() => {
        const cur = eng.readDoc(name);
        const current = (cur === undefined) ? defaultValue : cur;
        const updated = mergeFn(current);
        eng.writeDoc(name, updated);
        return updated;
      });
    } catch (e) {
      logger.warn('SQLite update("' + name + '") failed, falling back to JSON: ' + e.message);
      // fall through to the JSON path below
    }
  }
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
    // For SQLite-backed transactional keys, the per-key mutex above already
    // serializes callers in-process, so we don't need to hold a DB transaction
    // open across the (possibly async) merge — which node:sqlite's synchronous
    // transaction API can't do anyway. load() reads from SQLite; the final
    // save() is a single atomic row write (crash-atomic). Non-SQLite keys keep
    // the original JSON read-modify-write.
    const current = load(name, defaultValue);
    const updated = await mergeFn(current);
    save(name, updated);
    return updated;
  } finally {
    release(); // unblock next waiter
  }
}

function exists(name) {
  if (_useSqlite(name)) {
    try {
      _migrateJsonToSqlite(name);
      if (_engine().hasDoc(name)) return true;
      // Not in SQLite yet — a legacy JSON file still counts as "exists".
    } catch (_) {}
  }
  try { return fs.existsSync(_resolvePath(name)); } catch (_) { return false; }
}

function del(name) {
  if (_useSqlite(name)) {
    try { _engine().deleteDoc(name); } catch (e) {
      logger.warn('SQLite delete("' + name + '") failed: ' + e.message);
    }
    // Also remove any legacy JSON file so a later fallback can't resurrect it.
  }
  try { fs.unlinkSync(_resolvePath(name)); } catch (_) {}
}

module.exports = { load, save, update, updateAsync, exists, delete: del, REGISTRY, SQLITE_KEYS };
