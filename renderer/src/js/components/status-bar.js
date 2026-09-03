/**
 * status-bar.js — Bottom application status bar (DOM + event wiring)
 *
 * The authoritative, quick-glance indicator of overall FLEET SYNCHRONIZATION
 * status. (The Scheduler page remains the detailed delivery/job view — this bar
 * is intentionally the lightweight overall-sync indicator, not a second job
 * system.)
 *
 * SOURCE OF TRUTH: the backend fleet payload + the renderer `fleet` state slice.
 * The bar NEVER invents a sync time from Date.now(): it uses the real syncedAt
 * carried in the payload, and preserves the last SUCCESSFUL (fresh + complete)
 * sync time even when a later attempt fails or only cached/partial data arrives.
 *
 * All the state/color/label rules + ordering bookkeeping live in the pure,
 * DOM-free module status-bar-logic.js (unit-tested). This file only wires those
 * rules to the DOM and the event bus.
 */

import bus   from '../bus.js';
import state from '../state.js';
import { fleet as fleetBridge } from '../bridge.js';
import { absorbFleetSlice, emptyFleet, renderHtml } from './status-bar-logic.js';

// Re-export the pure helpers so existing importers/tests can reach them here too.
export { esc, deriveStatus, timeSince, renderHtml } from './status-bar-logic.js';

// ── DOM + display state ─────────────────────────────────────────────────────
let _el = null;
let _version = '';           // resolved from the app, not hard-coded
let _aiConnected = false;

// Message handling: a monotonically increasing token guarantees an OLDER
// clear-timeout can never erase a NEWER message.
let _statusMsg = '';
let _statusIsError = false;
let _msgToken = 0;

// Authoritative status-bar fleet snapshot (see status-bar-logic.js).
let _fleet = emptyFleet();

// ── Rendering ─────────────────────────────────────────────────────────────
// The exact markup lives in the pure renderHtml() (status-bar-logic.js) so the
// rendered output is unit-testable without a DOM. This wiring only injects it.
function _render() {
  if (!_el) return;
  _el.innerHTML = renderHtml({
    fleet: _fleet,
    now: Date.now(),
    aiConnected: _aiConnected,
    version: _version,
    statusMsg: _statusMsg,
    statusIsError: _statusIsError,
  });
}

// ── init ─────────────────────────────────────────────────────────────────────
export function init(container) {
  if (!container) {
    _el = document.createElement('div');
    _el.id = 'status-bar-mount';
    document.body.appendChild(_el);
  } else {
    _el = container;
  }

  // Seed from current state so we don't flash "connecting" if data already exists.
  _fleet = absorbFleetSlice(_fleet, state.slice('fleet'));
  _render();

  // Resolve the REAL app version dynamically (no hard-coded value).
  try {
    Promise.resolve(fleetBridge.getVersion()).then((v) => {
      _version = (typeof v === 'string') ? v.replace(/^v/i, '') : (v && v.version) || '';
      _render();
    }).catch(() => {});
  } catch (_) {}

  // Fleet payloads (partial + final + cache) — the authoritative sync signal.
  // Read from the state slice (the bridge normalizes it with seq +
  // lastSuccessfulSyncAt), keeping one source of truth.
  bus.on('state:fleet', (f) => {
    _fleet = absorbFleetSlice(_fleet, f);
    _render();
  });

  // Live status messages from the sync pipeline. The app emits fleet:status
  // (NOT sync:status — the previous listener was mismatched and silent).
  bus.on('fleet:status', (msg) => {
    _showMessage(String(msg == null ? '' : msg), false);
  });

  // Sync errors -> visible failure state + preserve last successful sync time.
  bus.on('fleet:error', (err) => {
    _fleet = { ..._fleet, failed: true, inProgress: false };
    const text = (err && err.message) ? err.message : String(err == null ? 'Sync failed' : err);
    _showMessage(text, true);   // includes _render
  });

  // Authentication-required signal (session expiry etc.).
  bus.on('fleet:auth-failure', (payload) => {
    _fleet = { ..._fleet, authRequired: true, inProgress: false };
    const msg = (payload && payload.message) ? payload.message : 'Authentication required';
    _showMessage(msg, true);
  });

  // AI connection indicator.
  bus.on('orcha:status', (status) => {
    _aiConnected = !!(status && status.connected);
    _render();
  });
  bus.on('orcha:health', (h) => {
    if (h && typeof h.aiConnected === 'boolean') { _aiConnected = h.aiConnected; _render(); }
  });

  // Continuously refresh the "ago" text so age advances without a new payload.
  setInterval(_render, 1000);
}

// Show a transient status message. A monotonically increasing token ensures a
// stale clear-timeout from an EARLIER message can never wipe a LATER one.
function _showMessage(msg, isError) {
  _statusMsg = msg;
  _statusIsError = !!isError;
  const myToken = ++_msgToken;
  _render();
  const ttl = isError ? 15000 : 8000;
  setTimeout(() => {
    if (myToken !== _msgToken) return;   // a newer message replaced this one
    _statusMsg = '';
    _statusIsError = false;
    _render();
  }, ttl);
}
