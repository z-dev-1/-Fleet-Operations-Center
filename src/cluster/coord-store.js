'use strict';
/**
 * cluster/coord-store.js — pluggable coordination-store interface (Stage 1).
 *
 * This is the ONE abstraction the entire dual-instance layer talks to. The
 * leadership lease, heartbeat, fencing token, and the incremental event log all
 * live behind this interface so the actual backend is swappable WITHOUT
 * touching any failover logic:
 *
 *   - LocalCoordStore (this file)  — single-process, in the local data dir.
 *       Used today (flag OFF) and for the two-instances-on-one-laptop test
 *       harness. Backed by the app's existing transactional store (node:sqlite
 *       when available) so claims are atomic exactly like the scheduler-ledger.
 *   - (future) HttpCoordStore       — talks to a tiny always-on coordination
 *       service (e.g. hosted on the Dev Space, reached via its port-proxy).
 *   - (future) DynamoCoordStore     — if/when the DevSpaces IAM role is granted
 *       DynamoDB + S3 (currently AccessDenied — verified 2026-10).
 *
 * The contract below is deliberately minimal and backend-agnostic. Every method
 * is async so an HTTP/Dynamo backend drops in unchanged. NOTHING here performs
 * a production side-effect; it only reads/writes coordination metadata.
 *
 * CORE PRIMITIVE — compare-and-set (CAS):
 *   tryAcquireLeadership() and renewLeadership() are atomic CAS operations keyed
 *   on a monotonically increasing FENCING TOKEN. A takeover is only ever valid
 *   when (a) the prior lease has expired AND (b) the CAS succeeds — never on a
 *   missed heartbeat alone. Every production write later carries the token; a
 *   write with a token below the current one is rejected (fencing), so a
 *   paused-then-resumed stale leader can never commit.
 */

const LEADERSHIP_KEY = 'clusterLeadership';   // { leader, instanceId, fencingToken, mode, acquiredAt, expiresAt, heartbeatAt }
const EVENTLOG_KEY    = 'clusterEventLog';     // { seq, events: [{ seq, key, version, instanceId, token, ts }] } (capped)
const EVENTLOG_CAP    = 5000;

let logger; try { logger = require('../utils/logger')('cluster-coord'); } catch (_) { logger = { info() {}, warn() {} }; }

/**
 * The abstract contract (documented for implementers). Methods:
 *   getLeadership()                       -> Promise<record|null>
 *   tryAcquireLeadership(instanceId, mode, leaseMs, opts) -> Promise<{ ok, record, reason? }>
 *   renewLeadership(instanceId, token, leaseMs)           -> Promise<{ ok, record, reason? }>
 *   releaseLeadership(instanceId, token)                  -> Promise<{ ok }>
 *   heartbeat(instanceId, token)                          -> Promise<{ ok, record? }>
 *   appendEvent(evt)                      -> Promise<{ ok, seq }>
 *   readEventsSince(seq, limit)           -> Promise<{ events, lastSeq }>
 *   now()                                 -> number (ms, coordinator clock)
 */

// ── LocalCoordStore ─────────────────────────────────────────────────────────
// Atomic via the app's transactional store (store.update → node:sqlite
// BEGIN IMMEDIATE when available, else serialized JSON). This gives real CAS
// semantics for the single-host + two-local-instances cases.
class LocalCoordStore {
  constructor(deps) {
    // deps.store is injectable for tests; defaults to the app store.
    this._store = (deps && deps.store) || require('../store');
  }

  now() { return Date.now(); }

  async getLeadership() {
    try { return this._store.load(LEADERSHIP_KEY, null); } catch (_) { return null; }
  }

  // Atomic CAS acquire. Succeeds only if there is NO current leader, the current
  // lease has EXPIRED, or we already ARE the leader (re-acquire/renew). On
  // success the fencing token is incremented (strictly monotonic across the
  // store's lifetime) and returned.
  async tryAcquireLeadership(instanceId, mode, leaseMs, opts) {
    opts = opts || {};
    const now = this.now();
    let result = { ok: false, record: null, reason: 'unknown' };
    await this._update(LEADERSHIP_KEY, (cur) => {
      const rec = cur && typeof cur === 'object' ? cur : null;
      const expired = !rec || !rec.expiresAt || rec.expiresAt <= now;
      const isMine = rec && rec.leader === instanceId;
      // A forced handoff (opts.force) only succeeds when the caller presents the
      // CURRENT token (controlled handoff), never blind.
      const forcedOk = opts.force && rec && opts.expectToken === rec.fencingToken;
      if (!expired && !isMine && !forcedOk) {
        result = { ok: false, record: rec, reason: 'held-by-other' };
        return cur; // no change
      }
      const nextToken = (rec && Number.isFinite(rec.fencingToken) ? rec.fencingToken : 0) + 1;
      const next = {
        leader: instanceId,
        instanceId,
        fencingToken: nextToken,
        mode: mode || (rec && rec.mode) || 'ACTIVE',
        acquiredAt: now,
        expiresAt: now + Math.max(1000, leaseMs || 30000),
        heartbeatAt: now,
        previousLeader: rec && rec.leader && rec.leader !== instanceId ? rec.leader : (rec && rec.previousLeader) || null,
      };
      result = { ok: true, record: next, reason: isMine ? 're-acquired' : (forcedOk ? 'forced-handoff' : 'acquired') };
      return next;
    });
    if (result.ok) logger.info('[cluster-coord] leadership ' + result.reason + ' by ' + instanceId + ' token=' + result.record.fencingToken);
    return result;
  }

  // Atomic renew: only the CURRENT leader holding the CURRENT token may extend.
  async renewLeadership(instanceId, token, leaseMs) {
    const now = this.now();
    let result = { ok: false, record: null, reason: 'unknown' };
    await this._update(LEADERSHIP_KEY, (cur) => {
      const rec = cur && typeof cur === 'object' ? cur : null;
      if (!rec || rec.leader !== instanceId || rec.fencingToken !== token) {
        result = { ok: false, record: rec, reason: rec ? 'not-current-leader' : 'no-leader' };
        return cur;
      }
      const next = { ...rec, expiresAt: now + Math.max(1000, leaseMs || 30000), heartbeatAt: now };
      result = { ok: true, record: next, reason: 'renewed' };
      return next;
    });
    return result;
  }

  async heartbeat(instanceId, token) {
    const now = this.now();
    let result = { ok: false, record: null };
    await this._update(LEADERSHIP_KEY, (cur) => {
      const rec = cur && typeof cur === 'object' ? cur : null;
      if (!rec || rec.leader !== instanceId || rec.fencingToken !== token) {
        result = { ok: false, record: rec };
        return cur;
      }
      const next = { ...rec, heartbeatAt: now };
      result = { ok: true, record: next };
      return next;
    });
    return result;
  }

  async releaseLeadership(instanceId, token) {
    let released = false;
    await this._update(LEADERSHIP_KEY, (cur) => {
      const rec = cur && typeof cur === 'object' ? cur : null;
      if (rec && rec.leader === instanceId && rec.fencingToken === token) {
        released = true;
        // Keep the token so the next acquire increments monotonically; just
        // expire the lease immediately and clear the leader.
        return { ...rec, leader: null, instanceId: null, expiresAt: this.now() - 1, heartbeatAt: this.now() };
      }
      return cur;
    });
    return { ok: released };
  }

  // Append-only incremental event log (shared-operational store changes).
  async appendEvent(evt) {
    let seq = 0;
    await this._update(EVENTLOG_KEY, (cur) => {
      const log = (cur && typeof cur === 'object' && Array.isArray(cur.events)) ? cur : { seq: 0, events: [] };
      seq = (log.seq || 0) + 1;
      const e = { seq, key: evt.key, version: evt.version || null, instanceId: evt.instanceId || null, token: evt.token || null, ts: evt.ts || this.now() };
      const events = log.events.concat(e);
      if (events.length > EVENTLOG_CAP) events.splice(0, events.length - EVENTLOG_CAP);
      return { seq, events };
    });
    return { ok: true, seq };
  }

  async readEventsSince(seq, limit) {
    const log = this._store.load(EVENTLOG_KEY, { seq: 0, events: [] });
    const from = Number.isFinite(seq) ? seq : 0;
    const out = (log.events || []).filter(e => e.seq > from).slice(0, limit || 1000);
    return { events: out, lastSeq: log.seq || 0 };
  }

  // Prefer the store's async serialized update when available (per-key mutex /
  // SQLite IMMEDIATE); fall back to sync update.
  async _update(key, fn) {
    if (typeof this._store.updateAsync === 'function') return this._store.updateAsync(key, fn, null);
    if (typeof this._store.update === 'function') return this._store.update(key, fn, null);
    // Last resort: load/save (not atomic — only hit if store API is unexpectedly minimal).
    const cur = this._store.load(key, null);
    const next = fn(cur);
    this._store.save(key, next);
    return next;
  }
}

module.exports = { LocalCoordStore, LEADERSHIP_KEY, EVENTLOG_KEY };
