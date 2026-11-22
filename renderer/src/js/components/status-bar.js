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
import { absorbFleetSlice, emptyFleet, renderHtml, dtnaPill } from './status-bar-logic.js';
import { mount as mountFleetTrust } from './fleet-trust-indicator.js';
import { open as openAuthHealthPanel } from './auth-health-panel.js';
import { open as openDtnaPanel } from './dtna-panel.js';
import { aperiaPill } from './aperia-pill-logic.js';
import { open as openAperiaPanel } from './aperia-panel.js';

// DTNA bridge (preload expose('dtna')); read directly, not through bridge.js.
const _dtna = () => (typeof window !== 'undefined' && window.dtna) || null;

// Re-export the pure helpers so existing importers/tests can reach them here too.
export { esc, deriveStatus, timeSince, renderHtml } from './status-bar-logic.js';

// Stable shell: the bar itself is re-rendered every second into .sb-main, so the
// fleet trust indicators (freshness chip, auth pill, step-up banner) live in
// sibling hosts that are never rewritten.
const SHELL_HTML =
  '<div id="tb-auth-banner" class="tb-auth-banner" role="alert" hidden></div>' +
  '<div class="sb-row">' +
    '<div class="sb-main"></div>' +
    '<div class="sb-trust">' +
      '<button type="button" class="tb-fresh tb-fresh--grey" id="tb-fresh" title="Fleet data freshness — click to refresh">Fleet data …</button>' +
      '<button type="button" class="tb-auth tb-auth--grey" id="tb-auth" aria-haspopup="dialog">Auth …</button>' +
      '<button type="button" class="tb-dtna tb-dtna--grey" id="tb-dtna" aria-haspopup="dialog">DTNA …</button>' +
      '<button type="button" class="tb-aperia tb-aperia--grey" id="tb-aperia" aria-haspopup="dialog">Aperia …</button>' +
    '</div>' +
  '</div>';

// ── DOM + display state ─────────────────────────────────────────────────────
let _el = null;
let _barEl = null;
let _version = '';           // resolved from the app, not hard-coded
let _aiConnected = false;
let _aiLabel = 'Disconnected'; // 'Orcha + Claude' | 'Orcha' | 'Claude' | 'Disconnected'

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
  if (!_barEl) return;
  _barEl.innerHTML = renderHtml({
    fleet: _fleet,
    now: Date.now(),
    aiConnected: _aiConnected,
    aiLabel: _aiLabel,
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
  _el.innerHTML = SHELL_HTML;
  _barEl = _el.querySelector('.sb-main');

  // Seed from current state so we don't flash "connecting" if data already exists.
  _fleet = absorbFleetSlice(_fleet, state.slice('fleet'));
  _render();

  // ── Fleet trust indicators (freshness chip, auth pill, step-up banner) ──
  // The freshness chip keeps its own click (manual refresh); only the auth
  // pill opens the Auth Health overlay. Opening it never runs mwinit.
  const authEl = _el.querySelector('#tb-auth');
  try { mountFleetTrust({ fresh: _el.querySelector('#tb-fresh'), auth: authEl, banner: _el.querySelector('#tb-auth-banner') }); } catch (_) {}
  if (authEl) authEl.addEventListener('click', () => { try { openAuthHealthPanel(); } catch (_) {} });

  // ── DTNA Service Tracker pill: one status() read now, then pushes only ──
  // (dtna:status-changed). No timer; clicking opens the DTNA panel.
  const dtnaEl = _el.querySelector('#tb-dtna');
  const applyDtna = (s) => {
    if (!dtnaEl) return;
    const p = dtnaPill(s);
    dtnaEl.className = p.cls;
    dtnaEl.textContent = p.text;
    dtnaEl.title = p.title;
  };
  applyDtna(null);
  const dt = _dtna();
  if (dt) {
    try { Promise.resolve(dt.status()).then(applyDtna).catch(() => {}); } catch (_) {}
    try { if (typeof dt.onStatus === 'function') dt.onStatus(applyDtna); } catch (_) {}
  }
  if (dtnaEl) dtnaEl.addEventListener('click', () => { try { openDtnaPanel(); } catch (_) {} });

  // ── Aperia HALO Connect pill: one status() read now, then a re-read on each
  // aperia:alert push (IPC only, no network). No timer; click opens the panel.
  const aperiaEl = _el.querySelector('#tb-aperia');
  const _aperia = () => (typeof window !== 'undefined' && window.aperia) || null;
  const applyAperia = (s) => {
    if (!aperiaEl) return;
    const p = aperiaPill(s);
    aperiaEl.className = p.cls;
    aperiaEl.textContent = p.text;
    aperiaEl.title = p.title;
  };
  applyAperia(null);
  const ap = _aperia();
  const readAperia = () => { try { Promise.resolve(ap.status()).then(applyAperia).catch(() => {}); } catch (_) {} };
  if (ap && typeof ap.status === 'function') {
    readAperia();
    try { if (typeof ap.onAlert === 'function') ap.onAlert(() => readAperia()); } catch (_) {}
  }
  if (aperiaEl) aperiaEl.addEventListener('click', () => { try { openAperiaPanel({ onChange: applyAperia }); } catch (_) {} });

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

  // auth.propagation single auth status (never pushed with the flag off).
  // action 'mwinit' -> "Authentication required" (message shown once per
  // transition); level 'ok' clears the flag this listener set. No modal:
  // step-up can persist for hours and often self-clears.
  let _authStatusRequired = false;
  bus.on('auth:status', (s) => {
    if (!s || typeof s !== 'object') return;
    if (s.action === 'mwinit') {
      if (!_authStatusRequired) {
        _authStatusRequired = true;
        _fleet = { ..._fleet, authRequired: true };
        _showMessage(String(s.message || 'Authentication required'), true);   // includes _render
      }
    } else if (s.level === 'ok') {
      if (_authStatusRequired) {
        _authStatusRequired = false;
        _fleet = { ..._fleet, authRequired: false };
        _render();
      }
    }
  });

  // AI connection indicator — reflect which backends are actually up (Orcha,
  // Claude, or both) using the per-backend `backends` field from
  // relay.getStatus(). The old code read status.connected (a boolean that
  // relay.getStatus() never returns), so it was ALWAYS "Disconnected".
  function _applyBackends(orcha, claude) {
    _aiConnected = orcha || claude;
    _aiLabel = orcha && claude ? 'Orcha + Claude'
             : orcha           ? 'Orcha'
             : claude          ? 'Claude'
             : 'Disconnected';
    _render();
  }
  bus.on('orcha:status', (status) => {
    const be = status && status.backends;
    if (be && typeof be === 'object') { _applyBackends(!!be.orcha, !!be.claude); return; }
    // Legacy fallback: derive from the single status string.
    const s = (status && status.status) || '';
    _applyBackends(s === 'connected', s === 'connected-claude' || s === 'connected-bedrock');
  });
  // Kept in sync with the top-right toolbar indicator via its ai:backends event.
  bus.on('ai:backends', (b) => {
    if (b && typeof b === 'object') _applyBackends(!!b.orcha, !!b.claude);
  });
  bus.on('orcha:health', (h) => {
    if (h && typeof h.aiConnected === 'boolean') { _aiConnected = h.aiConnected; if (!h.aiConnected) _aiLabel = 'Disconnected'; _render(); }
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
