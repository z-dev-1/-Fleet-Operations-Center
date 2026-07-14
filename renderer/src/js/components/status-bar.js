/**
 * status-bar.js — Bottom status bar
 *
 * Always visible. Shows:
 *   Left:  Last sync time · Fleet count · Sync status message
 *   Right: AI status · Orcha connection · Version
 */

import bus   from '../bus.js';
import state from '../state.js';

let _el = null;
let _lastSync = null;
let _statusMsg = '';
let _unitCount = 0;
let _unavailCount = 0;
let _aiConnected = false;

function _render() {
  if (!_el) return;
  const ago = _lastSync ? _timeSince(_lastSync) : 'never';
  _el.innerHTML = `
    <div class="sb-bar">
      <div class="sb-left">
        <span class="sb-item sb-sync-ago">
          <span class="sb-dot ${_lastSync && (Date.now() - _lastSync < 600000) ? 'sb-dot--green' : 'sb-dot--amber'}"></span>
          Last sync: ${ago}
        </span>
        <span class="sb-sep">│</span>
        <span class="sb-item">${_unitCount} units</span>
        <span class="sb-sep">│</span>
        <span class="sb-item sb-unavail">${_unavailCount} unavailable</span>
        ${_statusMsg ? '<span class="sb-sep">│</span><span class="sb-item sb-msg">' + _esc(_statusMsg) + '</span>' : ''}
      </div>
      <div class="sb-right">
        <span class="sb-item">
          <span class="sb-dot ${_aiConnected ? 'sb-dot--green' : 'sb-dot--red'}"></span>
          AI: ${_aiConnected ? 'Connected' : 'Disconnected'}
        </span>
        <span class="sb-sep">│</span>
        <span class="sb-item sb-version">v3.0.0</span>
      </div>
    </div>
  `;
}

function _esc(s) { return String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function _timeSince(ts) {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return sec + 's ago';
  const min = Math.round(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.round(min / 60);
  return hr + 'h ago';
}

export function init(container) {
  if (!container) {
    _el = document.createElement('div');
    _el.id = 'status-bar-mount';
    document.body.appendChild(_el);
  } else {
    _el = container;
  }

  _render();

  // Update on sync complete
  bus.on('state:fleet', (fleetSlice) => {
    _lastSync = Date.now();
    const rows = fleetSlice.rows || [];
    _unitCount = rows.length;
    _unavailCount = rows.filter(r => /unavailable/i.test(r.lifecycleState || '')).length;
    _render();
  });

  // Sync status messages (from sync pipeline)
  bus.on('sync:status', (msg) => {
    _statusMsg = msg;
    _render();
    // Clear after 8s
    setTimeout(() => { _statusMsg = ''; _render(); }, 8000);
  });

  // AI connection
  bus.on('orcha:status', (status) => {
    _aiConnected = !!(status && status.connected);
    _render();
  });

  // Periodic refresh (update "ago" text)
  setInterval(_render, 30000);
}
