// Extracted from settings.js
// Function: _wireNotifications
// Can be imported back when ready to modularize

function _wireNotifications() {
  // No-op on change — preferences stored in _populate / settingsBridge
  ['notif-auth-fail','notif-sync-ok','notif-sync-err'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      settingsBridge.save('notifications', {
        authFail:  document.getElementById('notif-auth-fail').checked,
        syncOk:    document.getElementById('notif-sync-ok').checked,
        syncErr:   document.getElementById('notif-sync-err').checked,
      }).catch(() => {});
    });
  });
}
