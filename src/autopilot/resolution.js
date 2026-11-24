'use strict';
/**
 * autopilot/resolution.js — the only producer of RESOLVED tokens (§B11, plan R1).
 *
 * verifyResolution(caseRec, row, fleetMeta, now)
 *   -> { token } | { review: code } | null
 *
 * fleetMeta: { source, syncedAt, buildAtMs, isDown }
 *   buildAtMs = fleet-freshness lastOkAt (only real AAP builds set it). syncedAt
 *   is never used here, because hydrate / PM-fill re-stamp it.
 *   isDown(row) is passed in so this module stays pure; the default is the
 *   canonical_state rule (lifecycle contains "unavail").
 *
 * A token is issued only when the row is API-sourced, not down, lifecycle
 * Active, and the build is newer than the case's last down observation. It
 * never reads AI output. Tokens carry a module-private Symbol brand and are
 * tracked in a WeakSet, so a copied or hand-built object never verifies.
 */

const BRAND = Symbol('autopilot.resolution');
const _issued = new WeakSet();

function _defaultIsDown(row) {
  return String((row && (row.lifecycleState || row.atsState)) || '').toLowerCase().includes('unavail');
}

function verifyResolution(caseRec, row, fleetMeta, now) {
  if (!caseRec || !row) return null;
  const meta = fleetMeta || {};
  const isDown = typeof meta.isDown === 'function' ? meta.isDown : _defaultIsDown;
  if (isDown(row)) return null;

  const lastDown = caseRec.last_down_build_at;
  if (lastDown == null) return { review: 'no_down_observation' };

  const buildAtMs = meta.buildAtMs;
  // The build that would supersede the down observation has not arrived.
  if (buildAtMs == null || !(buildAtMs > lastDown)) return null;

  const apiSourced = meta.source === 'aap-api' || row._apiSourced === true;
  if (!apiSourced) return { review: 'non_api_lifecycle' };

  const lifecycle = String(row.lifecycleState || row.atsState || '').trim();
  if (lifecycle.toLowerCase() !== 'active') return { review: 'lifecycle_not_active' };

  const token = Object.freeze({
    [BRAND]: true,
    lifecycleState: lifecycle,
    source: 'aap-api',
    buildAt: buildAtMs,
    syncedAt: meta.syncedAt || null,
    openWr: !!row.workRequestId && !row.completed,
    canonicalStatus: row.canonicalStatus || null,
    verifiedAt: now == null ? Date.now() : now,
  });
  _issued.add(token);
  return { token };
}

function isVerified(token) {
  return !!token && typeof token === 'object' && _issued.has(token) && token[BRAND] === true;
}

/** Plain JSON payload of a verified token (for resolution_json). */
function payloadOf(token) {
  if (!isVerified(token)) return null;
  const { lifecycleState, source, buildAt, syncedAt, openWr, canonicalStatus, verifiedAt } = token;
  return { lifecycleState, source, buildAt, syncedAt, openWr, canonicalStatus, verifiedAt };
}

module.exports = { verifyResolution, isVerified, payloadOf };
