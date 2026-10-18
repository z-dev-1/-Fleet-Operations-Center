'use strict';
/**
 * cluster/lease-manager.js — heartbeat + leadership lease loop (Stage 2).
 *
 * Drives the active/standby failover state machine on top of the coord-store
 * CAS primitives. One of these runs per instance. Responsibilities:
 *
 *   - ACQUIRE: on start (or when becoming eligible), try to take the leadership
 *     lease via an atomic CAS. If another instance holds a live lease, stay a
 *     FOLLOWER (standby).
 *   - RENEW: while leader, renew the lease every `heartbeatMs` (well inside the
 *     lease TTL) so a healthy leader never loses it. A renew that fails (our
 *     token was fenced out, or the record vanished) means we LOST leadership →
 *     demote to follower immediately and stop all production side-effects.
 *   - TAKE OVER: while follower, poll the leadership record. Attempt acquire
 *     ONLY when the current lease has EXPIRED. The acquire is an atomic CAS, so
 *     if two followers race, exactly one wins and the fencing token strictly
 *     increments. Takeover is NEVER authorized by a missed heartbeat alone —
 *     only by observed lease expiry + a successful CAS (spec §3).
 *   - FAIL CLOSED: if we are enabled but do NOT hold a valid lease, we are not
 *     leader → the mode gate must block production writes.
 *
 * TESTABILITY: the clock (`now`) and the scheduler (`setTimer`/`clearTimer`)
 * are injectable so a test can simulate time passing and leader death
 * deterministically — no real waiting, no flaky timing.
 *
 * This module performs NO production side-effects itself; it only manages the
 * lease and reports role transitions via the onChange callback.
 */

let logger; try { logger = require('../utils/logger')('cluster-lease'); } catch (_) { logger = { info() {}, warn() {} }; }

const DEFAULTS = {
  leaseMs: 30000,       // lease TTL
  heartbeatMs: 10000,   // leader renews this often (must be < leaseMs/2 for safety)
  pollMs: 5000,         // follower checks for takeover this often
  // When we lose/▼release leadership we demote; a small grace avoids flapping.
};

class LeaseManager {
  /**
   * @param {object} opts
   *   coord       — a coord-store instance (tryAcquireLeadership/renew/heartbeat/getLeadership)
   *   instanceId  — this instance's id
   *   mode        — 'ACTIVE' (eligible to lead) | 'STANDBY' | 'DEVELOPMENT'
   *                 STANDBY/DEVELOPMENT NEVER acquire leadership.
   *   leaseMs/heartbeatMs/pollMs — timings (optional)
   *   now()       — clock (ms); injectable for tests
   *   setTimer(fn,ms)/clearTimer(h) — scheduler; injectable for tests
   *   onChange(evt) — called on every role transition / heartbeat result
   */
  constructor(opts) {
    opts = opts || {};
    this.coord = opts.coord;
    this.instanceId = opts.instanceId;
    this.mode = opts.mode || 'ACTIVE';
    this.leaseMs = opts.leaseMs || DEFAULTS.leaseMs;
    this.heartbeatMs = opts.heartbeatMs || DEFAULTS.heartbeatMs;
    this.pollMs = opts.pollMs || DEFAULTS.pollMs;
    this._now = opts.now || (() => Date.now());
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
    this._onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

    this.role = 'follower';        // 'leader' | 'follower'
    this.fencingToken = null;
    this.leaseExpiresAt = null;
    this.lastHeartbeatAt = null;
    this._timer = null;
    this._running = false;
    this._busy = false;            // re-entrancy guard for the async tick
  }

  isLeader() { return this.role === 'leader' && this.fencingToken != null; }

  getState() {
    return {
      role: this.role,
      isLeader: this.isLeader(),
      fencingToken: this.fencingToken,
      leaseExpiresAt: this.leaseExpiresAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      mode: this.mode,
      running: this._running,
    };
  }

  // Eligible to HOLD leadership (i.e. to fail over when the leader dies)?
  // ACTIVE and STANDBY are BOTH eligible — that is the whole point of a
  // standby: it takes over when the primary's lease expires. The difference is
  // a PREFERENCE (see _tickFollower), NOT an eligibility block. Once a STANDBY
  // becomes leader, the MODE GATE still governs WHAT it may do — browser/AEA
  // tasks fail closed on a headless host — so "a standby performs no
  // side-effects it can't safely do" is enforced there, not by refusing to
  // lead. DEVELOPMENT is the ONLY mode that must never lead (isolated dev).
  _eligible() { return this.mode === 'ACTIVE' || this.mode === 'STANDBY'; }

  // Does this instance PREFER to hold the lease proactively (ACTIVE), or only
  // take over when there is no live leader (STANDBY)? Both can lead; this only
  // affects whether we grab an idle lease eagerly vs. wait as the backup.
  _prefersLeadership() { return this.mode === 'ACTIVE'; }

  start() {
    if (this._running) return;
    this._running = true;
    logger.info('[cluster-lease] start instance=' + this.instanceId + ' mode=' + this.mode +
      ' lease=' + this.leaseMs + 'ms hb=' + this.heartbeatMs + 'ms');
    // Kick an immediate tick, then schedule.
    this._scheduleNext(0);
  }

  async stop() {
    this._running = false;
    if (this._timer != null) { this._clearTimer(this._timer); this._timer = null; }
    // Release leadership cleanly so a standby can take over fast (not wait for TTL).
    if (this.isLeader() && this.coord) {
      try { await this.coord.releaseLeadership(this.instanceId, this.fencingToken); } catch (_) {}
      this._demote('stopped');
    }
  }

  _scheduleNext(ms) {
    if (!this._running) return;
    if (this._timer != null) this._clearTimer(this._timer);
    const delay = ms != null ? ms : (this.role === 'leader' ? this.heartbeatMs : this.pollMs);
    this._timer = this._setTimer(() => this._tick(), delay);
  }

  _promote(record, reason) {
    const was = this.role;
    this.role = 'leader';
    this.fencingToken = record.fencingToken;
    this.leaseExpiresAt = record.expiresAt;
    this.lastHeartbeatAt = this._now();
    if (was !== 'leader') {
      logger.info('[cluster-lease] PROMOTED to leader token=' + this.fencingToken + ' (' + reason + ')');
      this._onChange({ type: 'promoted', token: this.fencingToken, reason, state: this.getState() });
    }
  }

  _demote(reason) {
    const was = this.role;
    this.role = 'follower';
    this.fencingToken = null;
    this.leaseExpiresAt = null;
    if (was === 'leader') {
      logger.warn('[cluster-lease] DEMOTED to follower (' + reason + ')');
      this._onChange({ type: 'demoted', reason, state: this.getState() });
    }
  }

  // One iteration of the loop. Pure of its own timing — tests call it directly.
  async _tick() {
    if (!this._running || this._busy || !this.coord) { this._scheduleNext(); return; }
    this._busy = true;
    try {
      if (this.role === 'leader') {
        await this._tickLeader();
      } else {
        await this._tickFollower();
      }
    } catch (e) {
      logger.warn('[cluster-lease] tick error: ' + (e && e.message));
    } finally {
      this._busy = false;
      this._scheduleNext();
    }
  }

  async _tickLeader() {
    // Renew our lease. If renew fails, we lost leadership (fenced out / record
    // gone) → demote immediately so production writes stop.
    const r = await this.coord.renewLeadership(this.instanceId, this.fencingToken, this.leaseMs);
    if (r.ok) {
      this.leaseExpiresAt = r.record.expiresAt;
      this.lastHeartbeatAt = this._now();
      this._onChange({ type: 'heartbeat', token: this.fencingToken, state: this.getState() });
    } else {
      this._demote('renew-failed:' + (r.reason || 'unknown'));
    }
  }

  async _tickFollower() {
    // DEVELOPMENT never acquires leadership — it only observes (isolated dev).
    if (!this._eligible()) {
      const cur = await this.coord.getLeadership();
      this._onChange({ type: 'observe', leader: cur && cur.leader, state: this.getState() });
      return;
    }
    const cur = await this.coord.getLeadership();
    const now = this._now();
    const leaseLive = cur && cur.expiresAt && cur.expiresAt > now && cur.leader;
    if (leaseLive && cur.leader !== this.instanceId) {
      // Someone else holds a LIVE lease — stay follower regardless of our mode.
      // (No heartbeat-only takeover: we wait for genuine expiry — spec §3.)
      this._onChange({ type: 'standby', leader: cur.leader, state: this.getState() });
      return;
    }
    // No live leader (none, or the lease EXPIRED), or it's already us → acquire.
    // BOTH ACTIVE and STANDBY do this: an ACTIVE grabs an idle lease eagerly;
    // a STANDBY takes over precisely because the primary's lease has lapsed
    // (laptop asleep/off/crashed) — that IS the failover. CAS makes a race
    // safe: exactly one wins. The instance's real mode is recorded on the lease.
    const a = await this.coord.tryAcquireLeadership(this.instanceId, this.mode, this.leaseMs);
    if (a.ok) {
      this._promote(a.record, this._prefersLeadership() ? 'acquired' : 'failover-takeover');
    } else {
      // Lost the race (another instance won) — remain follower.
      this._onChange({ type: 'standby', leader: a.record && a.record.leader, state: this.getState() });
    }
  }

  // Test hook: run exactly one tick synchronously-awaitable (no scheduling).
  async _tickOnce() {
    if (this.role === 'leader') return this._tickLeader();
    return this._tickFollower();
  }
}

module.exports = { LeaseManager, DEFAULTS };
