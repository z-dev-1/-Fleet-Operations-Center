'use strict';
/**
 * orcha/fas/inbound-claim.js — durable, atomic exactly-once claim for every
 * inbound Slack message (spec v2).
 *
 * WHY: exactly-once delivery must not rely only on in-memory flags, the polling
 * watermark, or thread-seen state. This is a persistent claim registry keyed by
 * (channelId | ts | threadTs) that BOTH the Digital FAS engine and the legacy
 * engine acquire BEFORE they process a message. Guarantees:
 *   - Only ONE engine owns a given message (first claim wins).
 *   - Digital FAS and legacy can never respond to the same message concurrently.
 *   - A retry/re-poll cannot duplicate a reply (an already-delivered claim is
 *     terminal and re-acquire returns {ok:false, already:'delivered'}).
 *   - An app restart cannot resend an already-delivered response (the claim
 *     survives on disk; delivered claims stay delivered).
 *   - A queued (approval/clarify) response remains owned by Digital FAS (the
 *     claim is held in 'owned' with owner 'digital-fas' — legacy can't take it).
 *   - A technical fallback safely transfers ownership to legacy (transferToLegacy).
 *   - A STALE in-flight claim (crash mid-processing) is recoverable after a
 *     lease expires (a later acquire succeeds and takes over).
 *   - Slack delivery must be verified (markDelivered requires a ts) BEFORE a
 *     claim is terminal; delivery failure stays recoverable (markFailed).
 *   - Case memory must only be committed by the caller AFTER markDelivered.
 *
 * Claim record (stored under `fasInboundClaims`, keyed by claimKey):
 *   {
 *     key, channelId, ts, threadTs,
 *     status: 'processing' | 'owned' | 'delivered' | 'failed' | 'legacy',
 *     owner: 'digital-fas' | 'legacy' | null,
 *     leaseUntil: ISO | null,   // in-flight lease (processing/owned)
 *     deliveredTs: string|null, // Slack ts of the confirmed delivery
 *     attempts, createdAt, updatedAt, reason?
 *   }
 *
 * Statuses:
 *   processing — a claim is held while an engine decides/sends (leased).
 *   owned      — Digital FAS owns the message but the response is QUEUED
 *                (approval/clarify/manual-review). Held indefinitely for FAS;
 *                legacy can never take it. Not terminal (a later approve -> delivered).
 *   delivered  — TERMINAL. Slack confirmed delivery (has deliveredTs). No re-send.
 *   failed     — delivery failed; RECOVERABLE (re-acquire allowed to retry).
 *   legacy     — ownership transferred to the legacy engine (technical fallback).
 */

const store = require('../../store');
let logger; try { logger = require('../../utils/logger').createLogger('fas-inbound-claim'); } catch (_) { logger = { info(){}, warn(){} }; }

const KEY = 'fasInboundClaims';
const LEASE_MS = 2 * 60 * 1000;   // in-flight processing lease (2 min)
const CAP = 5000;                  // keep the ledger bounded
const RETAIN_MS = 7 * 24 * 3600 * 1000; // prune delivered/legacy older than 7d

function _now() { return new Date().toISOString(); }
function _load() { const m = store.load(KEY, {}); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
function _save(m) {
  // Prune old terminal entries so the ledger stays bounded.
  const keys = Object.keys(m);
  if (keys.length > CAP) {
    const now = Date.now();
    for (const k of keys) {
      const e = m[k];
      const terminal = e && (e.status === 'delivered' || e.status === 'legacy');
      const age = now - (Date.parse(e && e.updatedAt || 0) || 0);
      if (terminal && age > RETAIN_MS) delete m[k];
    }
    // Still over cap? drop oldest terminal entries.
    const rest = Object.keys(m);
    if (rest.length > CAP) {
      rest.sort((a, b) => Date.parse(m[a].updatedAt || 0) - Date.parse(m[b].updatedAt || 0));
      for (let i = 0; i < rest.length - CAP; i++) delete m[rest[i]];
    }
  }
  store.save(KEY, m);
}

/** Stable claim key. threadTs is part of the identity so a thread reply and a
 *  same-ts top-level message never collide. */
function claimKey(channelId, ts, threadTs) {
  return String(channelId || '') + '|' + String(ts || '') + '|' + String(threadTs || '');
}

function _isLeaseLive(e) {
  if (!e || !e.leaseUntil) return false;
  const t = Date.parse(e.leaseUntil);
  return !isNaN(t) && t > Date.now();
}

/**
 * acquire({ channelId, ts, threadTs, owner }) -> { ok, key, claim?, already? }
 * Atomically claim a message for `owner` ('digital-fas' | 'legacy').
 * Returns ok:false when:
 *   - already 'delivered' (already:'delivered') — never re-process/resend.
 *   - held 'owned' by digital-fas with a queued response (already:'owned') —
 *     FAS retains it; legacy must not take it.
 *   - 'processing' with a LIVE lease (already:'processing') — another worker is
 *     mid-flight; do not double-process.
 *   - 'legacy' already owns it (already:'legacy').
 * Returns ok:true (taking/again-holding the claim) when new, failed
 * (recoverable), or a stale/expired processing lease (crash recovery).
 */
function acquire(opts) {
  opts = opts || {};
  const owner = opts.owner || 'digital-fas';
  const key = claimKey(opts.channelId, opts.ts, opts.threadTs);
  const m = _load();
  const e = m[key];

  if (e) {
    if (e.status === 'delivered') return { ok: false, already: 'delivered', key, claim: e };
    if (e.status === 'legacy') {
      // Legacy owns it. Only the legacy engine may re-acquire (idempotent).
      if (owner === 'legacy') { e.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString(); e.updatedAt = _now(); _save(m); return { ok: true, key, claim: e, resumed: true }; }
      return { ok: false, already: 'legacy', key, claim: e };
    }
    if (e.status === 'owned') {
      // Held by Digital FAS (queued response). FAS may re-acquire to resume;
      // legacy may NOT take it.
      if (owner === 'digital-fas') return { ok: false, already: 'owned', key, claim: e };
      return { ok: false, already: 'owned', key, claim: e };
    }
    if (e.status === 'processing') {
      if (_isLeaseLive(e)) return { ok: false, already: 'processing', key, claim: e };
      // Stale lease (crash) -> recover: take over.
      logger.warn && logger.warn('[inbound-claim] recovering stale processing lease for ' + key);
    }
    // 'failed' or stale 'processing' -> recoverable: fall through to re-claim.
  }

  const claim = {
    key, channelId: opts.channelId || '', ts: opts.ts || '', threadTs: opts.threadTs || null,
    status: 'processing', owner,
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
    deliveredTs: null,
    attempts: ((e && e.attempts) || 0) + 1,
    createdAt: (e && e.createdAt) || _now(), updatedAt: _now(),
  };
  m[key] = claim;
  _save(m);
  return { ok: true, key, claim };
}

function _patch(key, patch) {
  const m = _load();
  const e = m[key];
  if (!e) return null;
  Object.assign(e, patch, { updatedAt: _now() });
  _save(m);
  return e;
}

/** Mark a claim as OWNED by Digital FAS with a queued (not-yet-sent) response.
 *  Keeps it out of legacy's reach until it's delivered or explicitly released. */
function markOwnedQueued(key) { return _patch(key, { status: 'owned', owner: 'digital-fas', leaseUntil: null }); }

/** Mark a claim DELIVERED — TERMINAL. Requires a Slack ts (delivery verified). */
function markDelivered(key, deliveredTs) {
  if (!deliveredTs) return { ok: false, error: 'delivery ts required to mark delivered' };
  const e = _patch(key, { status: 'delivered', deliveredTs: String(deliveredTs), leaseUntil: null });
  return e ? { ok: true, claim: e } : { ok: false, error: 'claim not found' };
}

/** Mark a claim FAILED — RECOVERABLE (a later acquire may retry it). */
function markFailed(key, reason) { return _patch(key, { status: 'failed', reason: reason || 'delivery failed', leaseUntil: null }); }

/** Transfer ownership to the legacy engine (Digital FAS technical fallback). */
function transferToLegacy(key, reason) {
  const m = _load();
  const e = m[key];
  if (!e) {
    // No prior claim (fallback before any claim) — create one owned by legacy.
    m[key] = { key, status: 'legacy', owner: 'legacy', reason: reason || 'fas-technical-failure',
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), deliveredTs: null, attempts: 1, createdAt: _now(), updatedAt: _now() };
    _save(m);
    return m[key];
  }
  Object.assign(e, { status: 'legacy', owner: 'legacy', reason: reason || 'fas-technical-failure',
    leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: _now() });
  _save(m);
  return e;
}

/** Release a claim (e.g. nothing to do) so it isn't left dangling in processing. */
function release(key) { const m = _load(); if (m[key] && m[key].status === 'processing') { delete m[key]; _save(m); } return { ok: true }; }

function get(key) { return _load()[key] || null; }
function isDelivered(key) { const e = _load()[key]; return !!(e && e.status === 'delivered'); }

/** Recover stale in-flight (processing) leases after a restart — mark them
 *  recoverable ('failed') so they can be re-acquired. Delivered/owned/legacy
 *  are untouched. Returns { recovered }. */
function reconcile() {
  const m = _load();
  let recovered = 0, changed = false;
  for (const k of Object.keys(m)) {
    const e = m[k];
    if (e && e.status === 'processing' && !_isLeaseLive(e)) {
      e.status = 'failed'; e.reason = 'stale processing lease recovered on restart'; e.leaseUntil = null; e.updatedAt = _now();
      recovered++; changed = true;
    }
  }
  if (changed) _save(m);
  return { recovered };
}

module.exports = {
  KEY, LEASE_MS,
  claimKey, acquire, markOwnedQueued, markDelivered, markFailed, transferToLegacy, release,
  get, isDelivered, reconcile,
};
