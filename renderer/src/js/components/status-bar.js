/**
 * status-bar.js -- Top status bar component
 *
 * Shows: sync status text | last-sync time | auth badge | version
 *
 * Reacts to bus events -- no direct IPC.
 */

import bus   from '../bus.js';
import state from '../state.js';
import toast              from './toast.js';
import { fleet as fleetBridge } from '../bridge.js';

let _el = null;

function _fmt(isoDate) {
  if (!isoDate) return '--';
  const d = new Date(isoDate);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'status-bar';
  _el.innerHTML = `
    <div class="status-bar__left">
      <span id="sb-status" class="status-bar__status">Connecting...</span>
    </div>
    <div class="status-bar__center">
      <span id="sb-count" class="status-bar__count"></span>
      <span id="sb-sync-time" class="status-bar__sync-time"></span>
    </div>
    <div class="status-bar__right">
      <span id="sb-auth" class="status-bar__auth status-bar__auth--unknown">Auth</span>
      <span id="sb-version" class="status-bar__version"></span>
    </div>
  `;
  container.prepend(_el);

  // Version
  fleetBridge.getVersion().then((v) => {
    const vEl = document.getElementById('sb-version');
    if (vEl) vEl.textContent = 'v' + v;
  }).catch(() => {});

  // Bus subscriptions
  bus.on('fleet:status', (msg) => {
    const el = document.getElementById('sb-status');
    if (el) el.textContent = msg;
  });

  bus.on('fleet:error', (err) => {
    const el = document.getElementById('sb-status');
    if (el) {
      el.textContent = err;
      el.classList.add('status-bar__status--error');
    }
    toast.show('error', err, 6000);
  });

  bus.on('state:fleet', (fleetSlice) => {
    const countEl    = document.getElementById('sb-count');
    const syncEl     = document.getElementById('sb-sync-time');
    const statusEl   = document.getElementById('sb-status');
    if (countEl)  countEl.textContent  = fleetSlice.count + ' units';
    if (syncEl)   syncEl.textContent   = fleetSlice.syncedAt
      ? ('synced ' + _fmt(fleetSlice.syncedAt) + (fleetSlice.stale ? ' (stale)' : ''))
      : '';
    if (statusEl) statusEl.classList.remove('status-bar__status--error');
  });

  bus.on('auth:mwinit-status', (s) => {
    const el = document.getElementById('sb-auth');
    if (!el) return;
    el.className = 'status-bar__auth ' +
      (s.ok ? 'status-bar__auth--ok' : 'status-bar__auth--fail');
    el.title = s.reason || (s.ok ? 'Midway authenticated' : 'Midway auth failed');
    el.textContent = s.ok ? 'Auth ok' : 'Auth fail';
  });
}
