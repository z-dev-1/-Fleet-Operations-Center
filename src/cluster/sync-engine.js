'use strict';
/**
 * cluster/sync-engine.js — incremental shared-state synchronization (Stage 4).
 *
 * Keeps both instances converged on the same COMMITTED operational state via
 * the coord-store's append-only event log — WITHOUT ever copying raw SQLite/JSON
 * files across machines (spec rule). Two directions:
 *
 *   PRODUCE (leader only): when a shared-operational store key changes, publish
 *     an event { seq, key, version, doc, instanceId, token, ts }. Only the
 *     leader produces, so a standby can't echo its own applied writes back into
 *     the log (no feedback loop). Each key carries a monotonically increasing
 *     per-key `version` for conflict resolution.
 *
 *   CONSUME (every instance): pull events with seq > lastSyncSeq on a timer and
 *     on reconnect, and APPLY each to the local store — but only when the
 *     incoming `version` is newer than what we already have (last-writer-wins
 *     by version). An instance that was offline simply pulls everything it
 *     missed when it returns (reconnection recovery, spec §2).
 *
 * WHAT SYNCS (SHARED-OPERATIONAL allowlist) vs WHAT DOESN'T (DEVICE-SPECIFIC):
 *   Only keys on SHARED_KEYS are ever published or applied. Device-specific
 *   state — credentials, Midway/AEA cookies, Orcha/DM session ids, local
 *   caches, UI/bubble prefs, the cluster's own coordination records — is NEVER
 *   synced (each host keeps its own, per spec §2/§8).
 *
 * VERSIONING: we keep a tiny sidecar map `clusterSyncVersions` = { key: version }
 * so both producer and consumer agree on per-key versions without mutating the
 * payload documents themselves (which the rest of the app owns).
 *
 * This module performs NO production side-effects and never runs AI/network in
 * a transaction — it only reads/writes local store docs + the event log.
 */

let logger; try { logger = require('../utils/logger')('cluster-sync'); } catch (_) { logger = { info() {}, warn() {} }; }

// ── SHARED-OPERATIONAL allowlist (the single source of what crosses machines) ─
// Grounded in the persistence inventory: fleet truth, canonical state, FAS
// domain, queues/schedules, notes/learning, and the dedup ledgers that must
// fire once fleet-wide. NOTHING device-specific is here.
const SHARED_KEYS = [
  // Fleet truth + canonical
  'fleetData', 'canonicalState', 'fleetHistory', 'repairHistory', 'wbrHistory',
  // FAS domain
  'fasCases', 'fasPlaybook', 'fasKnowledgeDrafts', 'fasCompliance', 'fasCoverage',
  'fasAuditLog', 'fasApprovalQueue', 'slackSenderProfiles', 'contacts',
  // Scheduler / queues / tasks
  'schedulerLedger', 'wrQueue', 'dailyTasks', 'reminders', 'pins', 'schedules',
  // Notes / learning
  'notesStore', 'orchaCorrections', 'orchaVendorRules', 'orchaPatterns',
  'vendorHistory', 'vendorAssignments', 'rcaStore', 'retentionHistory',
  'longDwellStore',
  // Cross-host dedup ledgers (so an action fires once fleet-wide)
  'fasInboundClaims', 'fasIdempotency', 'carrierBriefingLog',
  // Slack auto-reply state (Stage 13) — MUST sync so a promoted standby
  // continues EXACTLY where the leader left off: the config keys carry the
  // enabled flag + per-thread/channel `lastSeenTs` watermark (so the standby
  // answers only NEW messages, never catches up on history), and the reply
  // logs are the fleet-wide dedup ledger (so a message answered on one host is
  // never re-answered on the other). Thread-reply-count + pending-confirm +
  // inbound lifecycle keep thread awareness and in-flight state consistent
  // across failover. Together with the leader gate (_mayPollSlack) and the
  // engines' first-sight baseline, this is what makes leader-time Slack parity
  // safe — no double-reply, no catch-up storm.
  'slackDMAutoReplyConfig', 'slackChannelWatchConfig',
  'slackDMReplies', 'slackChannelReplies',
  'slackDMThreadReplyCount', 'slackMentionThreads',
  'slackJustMePendingConfirm', 'slackInboundLifecycle',
];
const SHARED_SET = new Set(SHARED_KEYS);

// Keys that are EXPLICITLY device-specific — never synced. (Documented so the
// allowlist's intent is auditable; enforcement is the allowlist itself.)
const DEVICE_KEYS = [
  'credentialsStore', 'settings', 'setupState', 'orchaConfig', 'orchaRelayStatus',
  'chatSessionId', 'dmChatSessionId', 'bubbleConfig', 'heartbeatState',
  'aapCache', 'geofenceCache', 'relayCache', 'uptakeHash', 'offlineQueue',
  'clusterLeadership', 'clusterEventLog', 'clusterSyncVersions',
];

const VERSIONS_KEY = 'clusterSyncVersions';

function isShared(key) { return SHARED_SET.has(key); }

class SyncEngine {
  /**
   * @param {object} opts
   *   coord      — coord-store (appendEvent / readEventsSince)
   *   store      — app store (load/save/update)
   *   instanceId — this instance id
   *   isLeader() — predicate: are we the production leader right now?
   *   getToken() — current fencing token (stamped on produced events)
   *   onApplied(key, version) — optional callback after a key is applied
   *   now()      — clock (injectable for tests)
   */
  constructor(opts) {
    opts = opts || {};
    this.coord = opts.coord;
    this.store = opts.store || require('../store');
    this.instanceId = opts.instanceId || 'unknown';
    this._isLeader = typeof opts.isLeader === 'function' ? opts.isLeader : () => true;
    this._getToken = typeof opts.getToken === 'function' ? opts.getToken : () => null;
    this._onApplied = typeof opts.onApplied === 'function' ? opts.onApplied : () => {};
    // Item 3: called when the coordinator fences our write (stale leader) so the
    // facade can demote immediately and stop production.
    this._onFenced = typeof opts.onFenced === 'function' ? opts.onFenced : null;
    this._now = opts.now || (() => Date.now());
    this.lastSyncSeq = 0;
  }

  _versions() { return this.store.load(VERSIONS_KEY, {}) || {}; }
  _bumpVersion(key) {
    let v = 1;
    this.store.update(VERSIONS_KEY, (cur) => {
      const m = (cur && typeof cur === 'object') ? cur : {};
      v = (Number.isFinite(m[key]) ? m[key] : 0) + 1;
      m[key] = v;
      return m;
    }, {});
    return v;
  }
  _setVersion(key, version) {
    this.store.update(VERSIONS_KEY, (cur) => {
      const m = (cur && typeof cur === 'object') ? cur : {};
      if (!Number.isFinite(m[key]) || version > m[key]) m[key] = version;
      return m;
    }, {});
  }
  _getVersion(key) { const m = this._versions(); return Number.isFinite(m[key]) ? m[key] : 0; }

  /**
   * publish(key) — PRODUCER. Called by the leader after it commits a change to
   * a shared key. Reads the current local doc, bumps the per-key version, and
   * appends an event carrying the doc. No-op for non-shared keys or non-leaders.
   */
  async publish(key) {
    if (!isShared(key)) return { ok: false, skipped: 'not-shared' };
    if (!this._isLeader()) return { ok: false, skipped: 'not-leader' };
    if (!this.coord) return { ok: false, skipped: 'no-coord' };
    const doc = this.store.load(key, null);
    const version = this._bumpVersion(key);
    const r = await this.coord.appendEvent({
      key, version, doc, instanceId: this.instanceId, token: this._getToken(), ts: this._now(),
    });
    // Item 3: the coordinator fenced us out (STALE_LEADER) — a higher token
    // holder exists. We are NOT the valid leader anymore. Signal the facade to
    // demote/fail closed; do NOT treat this as a successful publish.
    if (r && r.fenced) {
      logger.warn('[cluster-sync] publish FENCED (' + r.error + ') — stale leader, signalling demotion');
      if (typeof this._onFenced === 'function') { try { this._onFenced(r); } catch (_) {} }
      return { ok: false, fenced: true, error: r.error };
    }
    if (!r || r.ok === false) { logger.warn('[cluster-sync] publish failed for ' + key); return { ok: false }; }
    logger.info('[cluster-sync] published ' + key + ' v' + version + ' seq=' + r.seq);
    return { ok: true, seq: r.seq, version };
  }

  /**
   * pull(limit) — CONSUMER. Fetch events after lastSyncSeq and apply each to the
   * local store when its version is newer. Skips our OWN events (we already have
   * that state) and anything not on the allowlist. Returns a summary.
   * Safe to call on a timer AND on reconnect (incremental + catch-up are the
   * same code path — reconnect just means a bigger gap to replay).
   */
  async pull(limit) {
    if (!this.coord) return { ok: false, skipped: 'no-coord', applied: 0 };
    const res = await this.coord.readEventsSince(this.lastSyncSeq, limit || 2000);
    const events = (res && res.events) || [];
    const lastSeq = res && res.lastSeq;
    const oldestSeq = res && res.oldestSeq;   // item 6: for gap detection
    const _degraded = !!(res && res._degraded); // item 1: coordinator unreachable
    let applied = 0, skipped = 0;
    for (const e of events) {
      // Advance the cursor regardless so we never reprocess, even when skipping.
      if (e.seq > this.lastSyncSeq) this.lastSyncSeq = e.seq;
      if (!e || !isShared(e.key)) { skipped++; continue; }
      if (e.instanceId === this.instanceId) { skipped++; continue; }   // our own echo
      const localV = this._getVersion(e.key);
      if (Number.isFinite(e.version) && e.version <= localV) { skipped++; continue; } // stale
      // Apply: overwrite the local doc with the newer committed version.
      try {
        this.store.save(e.key, e.doc);
        this._setVersion(e.key, e.version);
        applied++;
        this._onApplied(e.key, e.version);
      } catch (err) {
        logger.warn('[cluster-sync] apply failed for ' + e.key + ': ' + (err && err.message));
      }
    }
    if (applied) logger.info('[cluster-sync] applied ' + applied + ' event(s) (skipped ' + skipped + '), cursor=' + this.lastSyncSeq);
    return { ok: true, applied, skipped, lastSeq, oldestSeq, _degraded, cursor: this.lastSyncSeq };
  }

  getState() {
    return { lastSyncSeq: this.lastSyncSeq, sharedKeyCount: SHARED_KEYS.length };
  }
}

module.exports = { SyncEngine, SHARED_KEYS, DEVICE_KEYS, isShared, VERSIONS_KEY };
