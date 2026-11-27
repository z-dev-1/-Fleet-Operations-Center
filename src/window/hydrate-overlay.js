'use strict';
/**
 * src/window/hydrate-overlay.js — save the deep-scan hydrate without rolling
 * the fleet back.
 *
 * The hydrate loop in window/index.js (_maybeRunDeepScanAsync) mutates the rows
 * of the build payload it started from, one `await api.refreshUnit()` per down
 * unit (minutes). Saving that start-time payload wholesale reverted anything a
 * newer build / PM fill / Uptake re-merge saved in between. Instead the loop
 * records, per unit, only the hydrate-owned fields it actually changed, and the
 * save overlays those onto the CURRENT stored rows by equipmentId (the
 * _maybeFillPmAllAsync._applyToStore pattern). WR-level fields only land on a
 * current row still showing the same work request (the build carry-forward rule).
 *
 * Pure: no Electron; the store and clock are injected.
 */

const { OFFSITE_FIELDS, clearOffsite } = require('../utils/offsite-owner');

// Unit-level: PM / location (always apply; vin only fills a blank).
const HYDRATE_UNIT_FIELDS = [
  'pmBDue', 'pmXDue', 'dotDue', 'quarterlyLiftDue', 'pmB', 'pmX', 'dot', 'quarterlyLift', 'geofence',
  'pmADue', 'washDue', 'apuDue', 'svrDue', 'stateInspDue', 'r360Due', 'semiannualLiftDue',
  'pmSchedule', 'vin',
];

// WR-level: conversation, extra WOs, relay fact block, offsite link (same WR only).
const HYDRATE_WR_FIELDS = Array.from(new Set([
  'fullConversation', '_convFetchedAt', '_secondaryWRs', '_plannedWRData',
  'relayFacts', 'relayFactsWr', 'createdBy', 'needBy', 'alternativeId', 'cause', 'correction',
  'totalCost', 'salesforceCase', 'salesforceCaseUrl',
  ...OFFSITE_FIELDS, '_offsiteWrId',
]));

const UNDEF = '\u0000undefined';
const enc = (v) => (v === undefined ? UNDEF : JSON.stringify(v));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Owned-field fingerprint of a row before the hydrate touches it.
function snapshotOwned(row) {
  const snap = {};
  const r = row || {};
  for (const k of HYDRATE_UNIT_FIELDS) snap[k] = enc(r[k]);
  for (const k of HYDRATE_WR_FIELDS) snap[k] = enc(r[k]);
  return snap;
}

// Only the owned fields that differ from `before` (deep-cloned), or null.
function capturePatch(before, row, { ownerWr, offsiteCleared } = {}) {
  const r = row || {};
  const b = before || {};
  const unit = {};
  const wr = {};
  let n = 0;
  for (const k of HYDRATE_UNIT_FIELDS) {
    if (r[k] !== undefined && enc(r[k]) !== b[k]) { unit[k] = clone(r[k]); n++; }
  }
  // After a clear the hydrate owns the row's whole offsite state: carry every
  // offsite value it ended with (a re-set equal to the start value is not a diff
  // but must survive the replayed clear).
  const offsiteOwned = offsiteCleared ? new Set([...OFFSITE_FIELDS, '_offsiteWrId']) : null;
  for (const k of HYDRATE_WR_FIELDS) {
    if (r[k] === undefined) continue;
    if (enc(r[k]) !== b[k] || (offsiteOwned && offsiteOwned.has(k))) { wr[k] = clone(r[k]); n++; }
  }
  if (!n && !offsiteCleared) return null;
  return { ownerWr: String(ownerWr || ''), offsiteCleared: !!offsiteCleared, unit, wr };
}

// Overlay patches (Map equipmentId -> patch) onto `rows` in place. Rows without
// a patch are untouched; patches for units not in `rows` are dropped. Never
// adds, removes or reorders rows. Returns the number of rows touched.
function overlayHydratePatches(rows, patches) {
  if (!Array.isArray(rows) || !patches || !patches.size) return 0;
  let touched = 0;
  for (const row of rows) {
    if (!row) continue;
    const p = patches.get(String(row.equipmentId));
    if (!p) continue;
    let did = false;
    for (const [k, v] of Object.entries(p.unit || {})) {
      if (k === 'vin' && row.vin) continue;
      row[k] = clone(v);
      did = true;
    }
    if (p.ownerWr && String(row.workRequestId || '') === p.ownerWr) {
      if (p.offsiteCleared) { clearOffsite(row); did = true; }
      for (const [k, v] of Object.entries(p.wr || {})) { row[k] = clone(v); did = true; }
    }
    if (did) touched++;
  }
  return touched;
}

// Load the CURRENT fleetData, overlay the patches, save. Only syncedAt changes at
// the top level, and only when a row was patched (same as _applyToStore).
// Returns the saved object, or null when nothing was saved.
function saveHydrateOverlay({ store, patches, now = Date.now, refreshFacts } = {}) {
  const cur = store.load('fleetData', null);
  if (!cur || !Array.isArray(cur.rows)) return null;
  const n = overlayHydratePatches(cur.rows, patches);
  if (!n) return null;
  if (typeof refreshFacts === 'function') { try { refreshFacts(cur.rows); } catch (_) {} }
  cur.syncedAt = new Date(now()).toISOString();
  store.save('fleetData', cur);
  return cur;
}

module.exports = {
  HYDRATE_UNIT_FIELDS, HYDRATE_WR_FIELDS,
  snapshotOwned, capturePatch, overlayHydratePatches, saveHydrateOverlay,
};
