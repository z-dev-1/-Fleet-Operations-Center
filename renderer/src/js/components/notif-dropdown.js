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

function _clearAll() {
  _items = [];
  _render();
}

// Human labels for the 5 notification categories + the selectable tones.
const _CAT_LABELS = {
  alert:   '🚨 Alerts / critical',
  message: '📩 Messages / DMs',
  success: '✅ Success',
  error:   '❌ Errors / warnings',
  info:    'ℹ️ Info / general',
};
const _TONE_LABELS = {
  alert:   'Alert beep',
  dm:      'Message chime',
  success: 'Success chime',
  info:    'Soft tap',
  warning: 'Warning tone',
  off:     'Off (silent)',
};

// Build the inline settings panel. Reads current config from the live
// notif-sounds module (which was configured from settings.notifications on
// init) + settings.notifications for the OS-notification toggles.
function _buildSettingsPanel(panel) {
  const cfg = notifSounds.getConfig();           // { enabled, volume, soundMap }
  const categories = notifSounds.getSoundCategories();
  const tones = notifSounds.getToneNames();      // alert, dm, success, info, warning
  const toneOpts = ['off', ...tones];

  settingsBridge.getAll().then((all) => {
    const n = (all && all.notifications) || {};
    const volPct = Math.round((cfg.volume != null ? cfg.volume : 0.5) * 100);

    panel.innerHTML = `
      <div class="notif-set-group">
        <label class="notif-set-row">
          <span>Sound notifications</span>
          <input type="checkbox" id="ns-enabled" ${cfg.enabled !== false ? 'checked' : ''}/>
        </label>
        <label class="notif-set-row">
          <span>Volume</span>
          <input type="range" id="ns-volume" min="0" max="100" value="${volPct}" style="width:120px"/>
        </label>
      </div>
      <div class="notif-set-group">
        <div class="notif-set-title">Sound per category</div>
        ${categories.map((cat) => `
          <div class="notif-set-row">
            <span>${_CAT_LABELS[cat] || cat}</span>
            <span style="display:flex;gap:6px;align-items:center">
              <select class="notif-set-select" data-cat="${cat}">
                ${toneOpts.map((t) => `<option value="${t}" ${cfg.soundMap[cat] === t ? 'selected' : ''}>${_TONE_LABELS[t] || t}</option>`).join('')}
              </select>
              <button class="notif-set-preview" data-cat="${cat}" title="Preview">▶</button>
            </span>
          </div>
        `).join('')}
      </div>
      <div class="notif-set-group">
        <div class="notif-set-title">OS notifications</div>
        <label class="notif-set-row"><span>Midway auth failure</span><input type="checkbox" id="ns-auth-fail" ${n.authFail !== false ? 'checked' : ''}/></label>
        <label class="notif-set-row"><span>Sync complete</span><input type="checkbox" id="ns-sync-ok" ${n.syncOk !== false ? 'checked' : ''}/></label>
        <label class="notif-set-row"><span>Sync error</span><input type="checkbox" id="ns-sync-err" ${n.syncErr !== false ? 'checked' : ''}/></label>
      </div>
      <div class="notif-set-actions">
        <button class="notif-set-btn" id="ns-test">Test all sounds</button>
      </div>
    `;

    // Wire controls — any change persists the whole notifications object.
    panel.querySelectorAll('#ns-enabled, #ns-auth-fail, #ns-sync-ok, #ns-sync-err, .notif-set-select')
      .forEach((el) => el.addEventListener('change', _saveNotifSettings));
    const volEl = panel.querySelector('#ns-volume');
    if (volEl) volEl.addEventListener('input', _saveNotifSettings);

    // Per-category preview buttons — save first so the preview reflects the
    // currently selected tone, then play it.
    panel.querySelectorAll('.notif-set-preview').forEach((btn) => {
      btn.addEventListener('click', () => {
        _saveNotifSettings();
        notifSounds.previewCategory(btn.dataset.cat);
      });
    });

    const testBtn = panel.querySelector('#ns-test');
    if (testBtn) testBtn.addEventListener('click', () => {
      const prev = notifSounds.getConfig();
      notifSounds.configure({ enabled: true });
      ['alert', 'dm', 'success', 'info', 'warning'].forEach((t, i) => setTimeout(() => notifSounds.play(t), i * 600));
      setTimeout(() => notifSounds.configure(prev), 5 * 600 + 300);
    });
  }).catch(() => {});
}

// Collect + persist the full notifications object (settings:save REPLACES the
// value, so every field must be included), then live-update the sound module.
function _saveNotifSettings() {
  const panel = document.getElementById('notif-settings');
  if (!panel) return;
  const enabled = !!(panel.querySelector('#ns-enabled') || {}).checked;
  const volPct = parseInt((panel.querySelector('#ns-volume') || {}).value, 10);
  const volume = (Number.isFinite(volPct) ? volPct : 50) / 100;
  const soundMap = {};
  panel.querySelectorAll('.notif-set-select').forEach((sel) => { soundMap[sel.dataset.cat] = sel.value; });

  const payload = {
    authFail:     !!(panel.querySelector('#ns-auth-fail') || {}).checked,
    syncOk:       !!(panel.querySelector('#ns-sync-ok') || {}).checked,
    syncErr:      !!(panel.querySelector('#ns-sync-err') || {}).checked,
    soundsEnabled: enabled,
    soundVolume:  volume,
    soundMap,
  };
  settingsBridge.save('notifications', payload).catch(() => {});
  // Live-update the running sound module immediately.
  notifSounds.configure({ enabled, volume, soundMap });
  bus.emit('notif-sounds:config', { enabled, volume, soundMap });
}

export function init() {
  _el = document.createElement('div');
  _el.id = 'notif-dropdown';
  _el.className = 'notif-dropdown';
  _el.innerHTML = `
    <div class="notif-header">
      <span class="notif-title">🔔 Notifications</span>
      <div class="notif-header-actions">
        <button class="notif-gear" id="notif-gear" title="Notification settings">⚙</button>
        <button class="notif-clear" id="notif-clear">Mark all read</button>
        <button class="notif-clear" id="notif-clear-all" title="Remove all notifications">Clear all</button>
      </div>
    </div>
    <div class="notif-settings" id="notif-settings" style="display:none"></div>
    <div id="notif-list"></div>
  `;
  document.body.appendChild(_el);

  document.getElementById('notif-clear').addEventListener('click', _markAllRead);
  document.getElementById('notif-clear-all').addEventListener('click', _clearAll);

  // ⚙ gear toggles the inline notification settings panel.
  const gearBtn = document.getElementById('notif-gear');
  const settingsPanel = document.getElementById('notif-settings');
  if (gearBtn && settingsPanel) gearBtn.addEventListener('click', () => {
    const showing = settingsPanel.style.display !== 'none';
    if (showing) { settingsPanel.style.display = 'none'; }
    else { _buildSettingsPanel(settingsPanel); settingsPanel.style.display = ''; }
  });

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
      soundMap: n.soundMap || undefined,  // undefined → keep defaults
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
