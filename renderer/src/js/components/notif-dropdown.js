/**
 * notif-dropdown.js -- Notifications dropdown
 *
 * Mounts on body. Toggle via bus event 'ui:notif-toggle'.
 * Populates from bus event 'ui:notif-push' payloads:
 *   { icon, title, body, tag, time }
 */

import bus from '../bus.js';
import * as notifSounds from '../notif-sounds.js';
import { settings as settingsBridge } from '../bridge.js';

let _items = [];
let _el    = null;

function _render() {
  const list = document.getElementById('notif-list');
  if (!list) return;

  const badge = document.getElementById('tb-notif-badge');
  const unread = _items.filter(i => !i.read).length;
  if (badge) {
    badge.textContent = unread;
    badge.style.display = unread > 0 ? 'flex' : 'none';
  }

  if (_items.length === 0) {
    list.innerHTML = '<div class="notif-empty">No notifications</div>';
    return;
  }

  list.innerHTML = _items.map((n, i) => `
    <div class="notif-item ${n.read ? '' : 'notif-item--unread'}" data-idx="${i}">
      <div class="notif-icon">${n.icon || '🔔'}</div>
      <div class="notif-body">
        <div class="notif-text">${n.body || ''}</div>
        <div class="notif-time">${n.time || ''}</div>
      </div>
    </div>
  `).join('');
}

function _markAllRead() {
  _items.forEach(i => i.read = true);
  _render();
}

export function init() {
  _el = document.createElement('div');
  _el.id = 'notif-dropdown';
  _el.className = 'notif-dropdown';
  _el.innerHTML = `
    <div class="notif-header">
      <span class="notif-title">🔔 Notifications</span>
      <button class="notif-clear" id="notif-clear">Mark all read</button>
    </div>
    <div id="notif-list"></div>
  `;
  document.body.appendChild(_el);

  document.getElementById('notif-clear').addEventListener('click', _markAllRead);

  // FEATURE (2026-07-22): sound notifications -- load saved prefs once on
  // init, and stay live-updated via bus event whenever the user changes
  // the toggle/volume slider in Settings (see settings.js
  // _wireNotifications). See notif-sounds.js for the full design writeup
  // (synthesized tones, no audio asset files, type inferred from icon).
  settingsBridge.getAll().then((all) => {
    const n = (all && all.notifications) || {};
    notifSounds.configure({
      enabled: n.soundsEnabled !== false, // default ON if never set
      volume: typeof n.soundVolume === 'number' ? n.soundVolume : 0.5,
    });
  }).catch(() => {});
  bus.on('notif-sounds:config', (prefs) => notifSounds.configure(prefs));

  // Toggle open/close
  bus.on('ui:notif-toggle', () => {
    _el.classList.toggle('open');
    // close settings if open
    const sd = document.getElementById('settings-drawer-overlay');
    if (sd) sd.classList.remove('open');
  });

  // Push a new notification
  bus.on('ui:notif-push', (n) => {
    _items.unshift({ ...n, read: false, time: n.time || 'just now' });
    if (_items.length > 20) _items.length = 20;
    _render();
    if (_el.classList.contains('open')) _markAllRead();
    notifSounds.playForNotification(n); // FEATURE (2026-07-22)
  });

  // Wire the topbar bell button
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#tb-notif');
    if (btn) { bus.emit('ui:notif-toggle'); return; }
    // Close if clicking outside
    if (_el.classList.contains('open') && !_el.contains(e.target)) {
      _el.classList.remove('open');
    }
  });

  // Seed with fleet events
  bus.on('fleet:status', (msg) => {
    // Only push meaningful status messages
    if (msg && (msg.includes('✅') || msg.includes('⚠') || msg.includes('❌'))) {
      bus.emit('ui:notif-push', { icon: '🔄', body: msg, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
    }
  });

  _render();
}
