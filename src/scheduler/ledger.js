'use strict';
/**
 * scheduler/ledger.js — Durable job ledger for the production backend scheduler.
 *
 * Owns the persistent record of every SharePoint-push and scheduled-OWA-email
 * job: state machine, deterministic idempotency keys, atomic get-or-create,
 * expiring per-channel leases (overlap protection), completed-slot keys that
 * survive restart, crash recovery of expired leases, and the versioned
 * idempotent migration of pre-existing scheduler state.
 *
 * Persistence: store key `schedulerLedger` -> data/scheduler_ledger.json.
 * ALL mutations go through store.updateAsync('schedulerLedger', ...) which is
 * serialized per-key (see src/store/index.js), so concurrent timer-driven
 * writes cannot clobber each other.
 *
 * This module is PURE bookkeeping. It performs NO fleet sync, NO SharePoint
 * push, and NO email send — those are wired in later tasks. It never sends
 * real email or writes real SharePoint. It only records/transitions state.
 *
 * Design reference: the approved design plan (durable ledger, states,
 * idempotency, leases). Migration shape copied from
 * src/orcha/fas/sender-profiles.js migrateSenderProfilesToContacts().
 */

const crypto = require('crypto');
const store  = require('../store');
let logger; try { logger = require('../utils/logger')('scheduler-ledger'); } catch (_) { logger = { info(){}, warn(){}, error(){} }; }

const LEDGER_KEY  = 'schedulerLedger';
const BACKUP_KEY  = 'schedulerLedgerBackup_v1';
const MIGRATION_VERSION = 1;

// ── State machine ───────────────────────────────────────────────────────────
const STATES = Object.freeze({
  QUEUED:              'queued',
  SYNCING:             'syncing',
  VALIDATING:          'validating',
  RUNNING:             'running',
  VERIFYING:           'verifying',
  SENT:                'sent',                 // verified send, pre-commit
  COMPLETED:           'completed',            // terminal success (snapshot + note committed)
  RETRY:               'retry',
  BLOCKED_AUTH:        'blocked-auth',
  BLOCKED_STALE_DATA:  'blocked-stale-data',
  DELIVERY_UNCERTAIN:  'delivery-uncertain',
  PARTIAL_FAILURE:     'partial-failure',
  FAILED:              'failed',               // terminal failure
  CANCELLED:           'cancelled',            // terminal, user-cancelled
});

const TERMINAL_STATES = Object.freeze([STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED]);
// States that represent an active claim on a channel (must not overlap).
const ACTIVE_STATES = Object.freeze([STATES.SYNCING, STATES.VALIDATING, STATES.RUNNING, STATES.VERIFYING]);
// A verified-but-uncommitted send. Recoverable to COMPLETED without resending.
const PRECOMMIT_STATES = Object.freeze([STATES.SENT]);
// Paused states awaiting external action (auth / stale data / reconciliation).
const PAUSED_STATES = Object.freeze([STATES.BLOCKED_AUTH, STATES.BLOCKED_STALE_DATA, STATES.DELIVERY_UNCERTAIN, STATES.PARTIAL_FAILURE, STATES.RETRY]);

const CHANNELS = Object.freeze({ SHAREPOINT: 'sharepoint', EMAIL: 'email' });
const ORIGINS  = Object.freeze({ SCHEDULED: 'scheduled', CATCHUP: 'catchup', MANUAL: 'manual', TEST: 'test' });

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_LEASE_MS = 10 * 60 * 1000; // 10 minutes

// Allowed transitions — any transition not listed is rejected (defensive; a
// caller trying to move sent->running, for instance, is a bug we want to catch).
const TRANSITIONS = Object.freeze({
  [STATES.QUEUED]:              [STATES.SYNCING, STATES.VALIDATING, STATES.RUNNING, STATES.CANCELLED, STATES.BLOCKED_STALE_DATA, STATES.BLOCKED_AUTH, STATES.FAILED],
  [STATES.SYNCING]:             [STATES.VALIDATING, STATES.BLOCKED_STALE_DATA, STATES.RETRY, STATES.FAILED, STATES.CANCELLED],
  [STATES.VALIDATING]:          [STATES.RUNNING, STATES.BLOCKED_STALE_DATA, STATES.RETRY, STATES.FAILED, STATES.CANCELLED],
  [STATES.RUNNING]:             [STATES.VERIFYING, STATES.SENT, STATES.BLOCKED_AUTH, STATES.PARTIAL_FAILURE, STATES.DELIVERY_UNCERTAIN, STATES.RETRY, STATES.FAILED, STATES.CANCELLED],
  [STATES.VERIFYING]:           [STATES.SENT, STATES.COMPLETED, STATES.BLOCKED_AUTH, STATES.PARTIAL_FAILURE, STATES.DELIVERY_UNCERTAIN, STATES.RETRY, STATES.FAILED, STATES.CANCELLED],
  [STATES.SENT]:                [STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED],
  [STATES.RETRY]:               [STATES.QUEUED, STATES.SYNCING, STATES.VALIDATING, STATES.RUNNING, STATES.FAILED, STATES.CANCELLED],
  [STATES.BLOCKED_AUTH]:        [STATES.QUEUED, STATES.RUNNING, STATES.FAILED, STATES.CANCELLED],
  [STATES.BLOCKED_STALE_DATA]:  [STATES.QUEUED, STATES.SYNCING, STATES.FAILED, STATES.CANCELLED],
  [STATES.DELIVERY_UNCERTAIN]:  [STATES.SENT, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED],
  [STATES.PARTIAL_FAILURE]:     [STATES.QUEUED, STATES.RUNNING, STATES.RETRY, STATES.COMPLETED, STATES.FAILED, STATES.CANCELLED],
  [STATES.COMPLETED]:           [],
  [STATES.FAILED]:              [STATES.QUEUED],   // manual retry of a failed job re-queues it
  [STATES.CANCELLED]:           [],
});

// ── Internal helpers ─────────────────────────────────────────────────────────
function _now() { return Date.now(); }
function _iso() { return new Date().toISOString(); }
function _genJobId() { return 'job_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex'); }
function _genMarker() { return 'FOC-' + crypto.randomBytes(8).toString('hex'); }

function _emptyLedger() {
  return { __migrationVersion: 0, __migratedAt: null, jobs: {}, completedSlots: {}, leases: {} };
}

function _normLedger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return _emptyLedger();
  return {
    __migrationVersion: raw.__migrationVersion || 0,
    __migratedAt: raw.__migratedAt || null,
    jobs: (raw.jobs && typeof raw.jobs === 'object') ? raw.jobs : {},
    completedSlots: (raw.completedSlots && typeof raw.completedSlots === 'object') ? raw.completedSlots : {},
    leases: (raw.leases && typeof raw.leases === 'object') ? raw.leases : {},
  };
}

function _load() { return _normLedger(store.load(LEDGER_KEY, null)); }

// ── Idempotency keys (deterministic) ──────────────────────────────────────────
// email:  email|<dateKey>|<slot>|<operator>|<domicile>|<series>|<P|T>
// sp:     sharepoint|<dateKey>|<slot>|<P|T>
function buildIdempotencyKey(spec) {
  const mode = spec.testMode ? 'T' : 'P';
  if (spec.channel === CHANNELS.EMAIL) {
    const scope = spec.scope || {};
    return [
      'email', spec.dateKey, spec.slotLabel,
      String(scope.operator || 'ALL').toUpperCase(),
      String(scope.domicile || 'ALL').toUpperCase(),
      String(scope.series || 'SOS').toUpperCase(),
      mode,
    ].join('|');
  }
  return ['sharepoint', spec.dateKey, spec.slotLabel, mode].join('|');
}

// Completed-slot key — persisted replacement for the in-memory _lastSPSlot /
// _lastEmailSlot dedupe keys that were lost on restart (root-cause defect).
function buildSlotKey(channel, dateKey, slotLabel) {
  return channel === CHANNELS.SHAREPOINT
    ? `${dateKey}-SP-${slotLabel}`
    : `${dateKey}-${slotLabel}`;
}

// ── Job record factory ─────────────────────────────────────────────────────────
function _newJobRecord(spec) {
  const t = _iso();
  return {
    jobId: _genJobId(),
    idempotencyKey: buildIdempotencyKey(spec),
    channel: spec.channel,
    slotLabel: spec.slotLabel,
    dateKey: spec.dateKey,
    scope: spec.scope || null,           // email: {operator,domicile,series}; sp: null
    origin: spec.origin || ORIGINS.SCHEDULED,
    testMode: !!spec.testMode,
    state: STATES.QUEUED,
    attempts: 0,
    maxAttempts: spec.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    nextRetryAt: null,
    lease: null,
    createdAt: t,
    updatedAt: t,
    syncResult: null,
    deliveryResult: null,
    intendedRecipients: Array.isArray(spec.intendedRecipients) ? spec.intendedRecipients : [],
    actualRecipients: Array.isArray(spec.actualRecipients) ? spec.actualRecipients : [],
    oneShotNote: typeof spec.oneShotNote === 'string' ? spec.oneShotNote : '',
    correlationMarker: _genMarker(),
    errors: [],
    history: [{ at: t, from: null, to: STATES.QUEUED, note: `created (${spec.origin || ORIGINS.SCHEDULED})` }],
  };
}

// ── get-or-create by idempotency key (atomic) ─────────────────────────────────
// Returns { job, created }. If a job with the same idempotency key already
// exists this NEVER creates a duplicate. A COMPLETED job is returned as-is
// (no-op — never auto-repeat a verified send). A DELIVERY_UNCERTAIN job is
// returned as-is (never resend until reconciliation). Only when no record
// exists, or the prior record is FAILED/CANCELLED and reopen is allowed, is a
// fresh queued job created.
async function getOrCreateJob(spec, opts) {
  opts = opts || {};
  const idk = buildIdempotencyKey(spec);
  let outcome = { job: null, created: false, reason: null };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const existing = Object.values(led.jobs).find(j => j.idempotencyKey === idk);
    if (existing) {
      // Collapse scheduled/catch-up/manual for the same logical send.
      outcome = { job: existing, created: false, reason: 'exists:' + existing.state };
      return led;
    }
    const job = _newJobRecord({ ...spec, idempotencyKey: idk });
    led.jobs[job.jobId] = job;
    outcome = { job, created: true, reason: 'created' };
    return led;
  }, _emptyLedger());
  if (outcome.created) logger.info(`Job created ${outcome.job.jobId} [${idk}]`);
  return outcome;
}

// ── State transition (validated) ──────────────────────────────────────────────
async function transition(jobId, toState, patch, note) {
  patch = patch || {};
  let result = { ok: false, error: 'not-found' };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const job = led.jobs[jobId];
    if (!job) { result = { ok: false, error: 'not-found' }; return led; }
    const from = job.state;
    const allowed = TRANSITIONS[from] || [];
    if (from !== toState && !allowed.includes(toState)) {
      result = { ok: false, error: `illegal transition ${from} -> ${toState}` };
      return led;
    }
    // Apply whitelisted patch fields.
    const FIELDS = ['attempts', 'maxAttempts', 'nextRetryAt', 'syncResult', 'deliveryResult',
      'intendedRecipients', 'actualRecipients', 'oneShotNote', 'correlationMarker', 'lease'];
    for (const f of FIELDS) if (Object.prototype.hasOwnProperty.call(patch, f)) job[f] = patch[f];
    if (patch.error) {
      job.errors.push({ at: _iso(), class: patch.error.class || 'unknown', message: String(patch.error.message || patch.error).slice(0, 500) });
      if (job.errors.length > 50) job.errors = job.errors.slice(-50);
    }
    job.state = toState;
    job.updatedAt = _iso();
    job.history.push({ at: job.updatedAt, from, to: toState, note: (note || '').slice(0, 300) });
    if (job.history.length > 100) job.history = job.history.slice(-100);
    // Terminal success on a scheduled/catchup email/SP job -> stamp the
    // completed-slot key so it survives restart and is never re-run today.
    if (toState === STATES.COMPLETED) {
      const slotKey = buildSlotKey(job.channel, job.dateKey, job.slotLabel);
      led.completedSlots[slotKey] = { jobId: job.jobId, at: job.updatedAt, scope: job.scope, testMode: job.testMode };
      _releaseLeaseInLedger(led, job.channel, job.jobId);
    }
    if (TERMINAL_STATES.includes(toState) || PAUSED_STATES.includes(toState)) {
      _releaseLeaseInLedger(led, job.channel, job.jobId);
    }
    result = { ok: true, job };
    return led;
  }, _emptyLedger());
  if (result.ok) logger.info(`Job ${jobId} ${result.job.history[result.job.history.length - 1].from} -> ${toState}`);
  else logger.warn(`Transition rejected for ${jobId}: ${result.error}`);
  return result;
}

// ── Leases (per-channel claim, overlap protection) ─────────────────────────────
function _releaseLeaseInLedger(led, channel, jobId) {
  const lease = led.leases[channel];
  if (lease && lease.owner === jobId) delete led.leases[channel];
}

// Atomically claim the channel lease for a job. Fails if another live
// (non-expired) lease is held by a different job. Reclaims expired leases.
async function acquireLease(channel, jobId, leaseMs) {
  const ms = leaseMs || DEFAULT_LEASE_MS;
  let result = { ok: false };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const cur = led.leases[channel];
    const now = _now();
    if (cur && cur.owner !== jobId && cur.expiresAt > now) {
      result = { ok: false, heldBy: cur.owner, expiresAt: cur.expiresAt };
      return led;
    }
    const lease = { owner: jobId, acquiredAt: now, expiresAt: now + ms };
    led.leases[channel] = lease;
    if (led.jobs[jobId]) led.jobs[jobId].lease = lease;
    result = { ok: true, lease };
    return led;
  }, _emptyLedger());
  return result;
}

async function renewLease(channel, jobId, leaseMs) {
  const ms = leaseMs || DEFAULT_LEASE_MS;
  let result = { ok: false };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const cur = led.leases[channel];
    if (!cur || cur.owner !== jobId) { result = { ok: false, error: 'not-owner' }; return led; }
    cur.expiresAt = _now() + ms;
    if (led.jobs[jobId]) led.jobs[jobId].lease = cur;
    result = { ok: true, lease: cur };
    return led;
  }, _emptyLedger());
  return result;
}

async function releaseLease(channel, jobId) {
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    _releaseLeaseInLedger(led, channel, jobId);
    if (led.jobs[jobId] && led.jobs[jobId].lease && led.jobs[jobId].lease.owner === jobId) led.jobs[jobId].lease = null;
    return led;
  }, _emptyLedger());
  return { ok: true };
}

// ── Overlap / duplicate guard ──────────────────────────────────────────────────
// Returns true if there is already an active (non-terminal, non-paused) job on
// this channel that is NOT the given job. Used to prevent scheduled/catch-up/
// manual runs from overlapping.
function isChannelBusy(channel, exceptJobId) {
  const led = _load();
  // A live lease held by a different job means busy.
  const lease = led.leases[channel];
  if (lease && lease.owner !== exceptJobId && lease.expiresAt > _now()) return true;
  return Object.values(led.jobs).some(j =>
    j.channel === channel && j.jobId !== exceptJobId && ACTIVE_STATES.includes(j.state));
}

// Has this slot already completed today (survives restart)?
function isSlotCompleted(channel, dateKey, slotLabel) {
  const led = _load();
  return !!led.completedSlots[buildSlotKey(channel, dateKey, slotLabel)];
}

// ── Crash recovery ──────────────────────────────────────────────────────────────
// Called on startup. Reclaims leases whose owner is terminal or expired, and
// returns jobs that need resumption. Does NOT itself resume work (the pipeline
// task decides how), it only classifies:
//   - resumeCommit    : SENT jobs (verified, must re-commit snapshot/note)
//   - resumeVerify    : VERIFYING jobs (re-run verification, no blind resend)
//   - reevaluate      : SYNCING/VALIDATING/RUNNING jobs orphaned by a crash
//   - retryDue        : RETRY jobs whose nextRetryAt has passed
// Never returns a COMPLETED/FAILED/CANCELLED/DELIVERY_UNCERTAIN job for auto
// resumption (delivery-uncertain requires explicit reconciliation).
async function recoverOnStartup() {
  const out = { reclaimedLeases: 0, resumeCommit: [], resumeVerify: [], reevaluate: [], retryDue: [] };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const now = _now();
    // Reclaim expired / orphaned leases.
    for (const ch of Object.keys(led.leases)) {
      const lease = led.leases[ch];
      const owner = lease && led.jobs[lease.owner];
      const ownerDead = !owner || TERMINAL_STATES.includes(owner.state) || PAUSED_STATES.includes(owner.state);
      if (!lease || lease.expiresAt <= now || ownerDead) { delete led.leases[ch]; out.reclaimedLeases++; }
    }
    for (const job of Object.values(led.jobs)) {
      if (job.state === STATES.SENT) out.resumeCommit.push(job.jobId);
      else if (job.state === STATES.VERIFYING) out.resumeVerify.push(job.jobId);
      else if (ACTIVE_STATES.includes(job.state)) {
        // Orphaned mid-flight: clear lease link and mark for re-evaluation.
        if (job.lease && led.leases[job.channel] === undefined) job.lease = null;
        out.reevaluate.push(job.jobId);
      } else if (job.state === STATES.RETRY && job.nextRetryAt && job.nextRetryAt <= now) {
        out.retryDue.push(job.jobId);
      }
    }
    return led;
  }, _emptyLedger());
  logger.info(`Recovery: reclaimed ${out.reclaimedLeases} lease(s), resumeCommit=${out.resumeCommit.length}, resumeVerify=${out.resumeVerify.length}, reevaluate=${out.reevaluate.length}, retryDue=${out.retryDue.length}`);
  return out;
}

// ── Retry scheduling (bounded exponential backoff) ──────────────────────────────
function computeBackoffMs(attempts) {
  // 1m, 5m, 15m, capped 30m.
  const table = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
  return table[Math.min(attempts, table.length - 1)];
}

async function scheduleRetry(jobId, errInfo) {
  let result = { ok: false };
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    const job = led.jobs[jobId];
    if (!job) { result = { ok: false, error: 'not-found' }; return led; }
    job.attempts += 1;
    if (job.attempts >= job.maxAttempts) {
      job.state = STATES.FAILED;
      job.nextRetryAt = null;
      job.history.push({ at: _iso(), from: STATES.RETRY, to: STATES.FAILED, note: 'attempts exhausted -> manual review' });
      result = { ok: true, exhausted: true, job };
    } else {
      const delay = computeBackoffMs(job.attempts);
      job.state = STATES.RETRY;
      job.nextRetryAt = _now() + delay;
      job.history.push({ at: _iso(), from: job.history.length ? job.history[job.history.length - 1].to : null, to: STATES.RETRY, note: `retry in ${Math.round(delay / 60000)}m (attempt ${job.attempts}/${job.maxAttempts})` });
      result = { ok: true, exhausted: false, nextRetryAt: job.nextRetryAt, job };
    }
    if (errInfo) job.errors.push({ at: _iso(), class: errInfo.class || 'transient', message: String(errInfo.message || errInfo).slice(0, 500) });
    job.updatedAt = _iso();
    _releaseLeaseInLedger(led, job.channel, job.jobId);
    return led;
  }, _emptyLedger());
  return result;
}

// ── Reads ────────────────────────────────────────────────────────────────────
function getJob(jobId) { return _load().jobs[jobId] || null; }
function getJobByIdempotencyKey(idk) { return Object.values(_load().jobs).find(j => j.idempotencyKey === idk) || null; }
function listJobs(filter) {
  filter = filter || {};
  let jobs = Object.values(_load().jobs);
  if (filter.channel) jobs = jobs.filter(j => j.channel === filter.channel);
  if (filter.state) jobs = jobs.filter(j => j.state === filter.state);
  if (filter.dateKey) jobs = jobs.filter(j => j.dateKey === filter.dateKey);
  if (filter.testMode !== undefined) jobs = jobs.filter(j => !!j.testMode === !!filter.testMode);
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

function getState() {
  const led = _load();
  return {
    migrationVersion: led.__migrationVersion,
    migratedAt: led.__migratedAt,
    jobCount: Object.keys(led.jobs).length,
    leases: led.leases,
    completedSlots: led.completedSlots,
  };
}

// Prune old terminal jobs to keep the ledger bounded (default keep 30 days).
async function pruneOldJobs(maxAgeMs) {
  const cutoff = _now() - (maxAgeMs || 30 * 24 * 60 * 60 * 1000);
  let removed = 0;
  await store.updateAsync(LEDGER_KEY, (raw) => {
    const led = _normLedger(raw);
    for (const [id, job] of Object.entries(led.jobs)) {
      if (TERMINAL_STATES.includes(job.state) && new Date(job.updatedAt).getTime() < cutoff) {
        delete led.jobs[id]; removed++;
      }
    }
    // Prune completed-slot keys older than 3 days (they only matter same-day).
    const slotCutoff = _now() - 3 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(led.completedSlots)) {
      if (v && v.at && new Date(v.at).getTime() < slotCutoff) delete led.completedSlots[k];
    }
    return led;
  }, _emptyLedger());
  if (removed) logger.info(`Pruned ${removed} old terminal job(s)`);
  return removed;
}

// ── Migration (versioned, idempotent) ──────────────────────────────────────────
// Establishes the ledger with a versioned immutable backup. There is no prior
// durable scheduler ledger to migrate FROM (completed slots were in-memory,
// history lived in renderer localStorage which the main process cannot read),
// so this migration's job is to (a) create the ledger structure if absent,
// (b) stamp the version, and (c) take a one-time immutable backup — matching
// the abort-on-backup-fail / dryRun / force / no-op shape used elsewhere.
function migrate(opts) {
  opts = opts || {};
  const led = _load();
  const at = _iso();
  const result = { version: MIGRATION_VERSION, at, created: false, noop: false, dryRun: !!opts.dryRun, aborted: null };
  const already = led.__migrationVersion === MIGRATION_VERSION && led.__migratedAt;
  if (already && !opts.force) { result.noop = true; return result; }

  if (!opts.dryRun) {
    const existingBackup = store.load(BACKUP_KEY, null);
    if (!existingBackup) {
      try {
        store.save(BACKUP_KEY, { version: MIGRATION_VERSION, at, ledger: led });
      } catch (e) {
        result.aborted = 'backup-failed';
        result.error = e.message;
        return result;
      }
    }
  }
  if (opts.dryRun) { result.wouldCreate = !led.__migratedAt; return result; }

  led.__migrationVersion = MIGRATION_VERSION;
  led.__migratedAt = at;
  if (!led.jobs) led.jobs = {};
  if (!led.completedSlots) led.completedSlots = {};
  if (!led.leases) led.leases = {};
  try {
    store.save(LEDGER_KEY, led);
    result.created = true;
  } catch (e) {
    result.aborted = 'save-failed';
    result.error = e.message;
  }
  logger.info(`Ledger migration v${MIGRATION_VERSION}: ${result.noop ? 'noop' : result.aborted ? 'aborted:' + result.aborted : 'ok'}`);
  return result;
}

module.exports = {
  STATES, TERMINAL_STATES, ACTIVE_STATES, PRECOMMIT_STATES, PAUSED_STATES,
  CHANNELS, ORIGINS, MIGRATION_VERSION, DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS,
  buildIdempotencyKey, buildSlotKey,
  getOrCreateJob, transition,
  acquireLease, renewLease, releaseLease,
  isChannelBusy, isSlotCompleted,
  recoverOnStartup, scheduleRetry, computeBackoffMs,
  getJob, getJobByIdempotencyKey, listJobs, getState, pruneOldJobs,
  migrate,
  // exported for tests
  _emptyLedger, _normLedger,
};
