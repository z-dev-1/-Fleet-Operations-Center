/**
 * keyboard-shortcuts.js — Global keyboard shortcuts
 *
 * Ctrl+F / Cmd+F  → Focus search box
 * Arrow Up/Down   → Navigate fleet table rows
 * Enter           → Open selected unit's detail panel
 * Escape          → Close detail drawer / modal / settings
 * Ctrl+R / Cmd+R  → Restart the app (main process, src/window/index.js)
 * Ctrl+Shift+R    → Force sync
 * Ctrl+M / Cmd+M  → Run Midway auth (mwinit)
 * Ctrl+1-5        → Switch views (Fleet, Analytics, Vendors, Settings, WI)
 */

import bus from '../bus.js';

const IS_MAC = navigator.platform.includes('Mac');
const MOD = IS_MAC ? 'metaKey' : 'ctrlKey';

let _selectedRowIdx = -1;
let _initialized = false;

export function initKeyboardShortcuts() {
  if (_initialized) return;
  _initialized = true;

  document.addEventListener('keydown', (e) => {
    // Don't intercept if user is typing in an input/textarea
    const tag = (e.target.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    // Ctrl+F / Cmd+F → Focus search
    if (e[MOD] && e.key === 'f') {
      e.preventDefault();
      const searchEl = document.getElementById('tb-search');
      if (searchEl) { searchEl.focus(); searchEl.select(); }
      return;
    }

    // Ctrl+Shift+R / Cmd+Shift+R → Force sync. (Plain Ctrl+R now RESTARTS the
    // app — handled in the main process so it works even if the UI is frozen.)
    if (e[MOD] && e.shiftKey && (e.key === 'R' || e.key === 'r')) {
      e.preventDefault();
      if (window.fleet && window.fleet.forceSync) window.fleet.forceSync();
      bus.emit('ui:toast', { type: 'info', message: 'Sync triggered', duration: 1500 });
      return;
    }

    // Ctrl+M / Cmd+M → Fix Midway/AAP auth via the ONE supervisor. Global so it
    // works even while typing — a stale session blocks everything else anyway.
    // This runs the FULL recovery ladder (silent AEA refresh → mwinit
    // --refresh-aea → AEA posture-agent self-heal → interactive mwinit only if
    // genuinely needed) and VERIFIES against the real AAP target — instead of
    // blindly spawning an interactive mwinit. So a lapsed AEA (the common case)
    // self-heals with NO YubiKey tap, and the tap only happens when the session
    // is truly dead. Falls back to the bare runMwinit if the supervisor bridge
    // is unavailable.
    if (e[MOD] && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      if (window.auth && window.auth.healthRunMwinit) {
        bus.emit('ui:toast', { type: 'info', message: '🔑 Fixing Midway/AAP auth (refresh AEA + mwinit if needed)…', duration: 2500 });
        window.auth.healthRunMwinit().then((r) => {
          if (r && r.ok && r.verified) {
            bus.emit('ui:toast', { type: 'success', message: '✅ Midway/AAP auth verified', duration: 2500 });
          } else if (r && r.state === 'WAITING_FOR_USER') {
            bus.emit('ui:toast', { type: 'warn', message: '🔑 Complete mwinit in the terminal (PIN + security key)', duration: 4000 });
          } else {
            bus.emit('ui:toast', { type: 'warn', message: '⚠️ Auth not verified yet — auto-retrying', duration: 3000 });
          }
        }).catch(() => {});
      } else if (window.auth && window.auth.runMwinit) {
        // Fallback: bare interactive mwinit (older bridge without the supervisor).
        bus.emit('ui:toast', { type: 'info', message: '🔑 Running Midway auth (mwinit)…', duration: 2500 });
        window.auth.runMwinit().catch(() => {});
      }
      return;
    }

    // Ctrl+1-5 → Switch views
    if (e[MOD] && e.key >= '1' && e.key <= '5') {
      e.preventDefault();
      const views = ['fleet', 'dashboard', 'analytics', 'vendors', 'settings', 'workflow-intelligence'];
      const idx = parseInt(e.key, 10) - 1;
      if (views[idx]) bus.emit('ui:view-change', { to: views[idx] });
      return;
    }

    // Skip remaining shortcuts if in an input field
    if (isInput) return;

    // Escape → Close drawer / modal / settings
    if (e.key === 'Escape') {
      // Settings panel
      const settingsOv = document.getElementById('sd-overlay');
      if (settingsOv && settingsOv.classList.contains('open')) {
        settingsOv.click(); // triggers close handler
        return;
      }
      // Unit detail drawer
      const drawer = document.querySelector('.drawer.open');
      if (drawer) {
        const closeBtn = drawer.querySelector('.dr-close');
        if (closeBtn) closeBtn.click();
        return;
      }
      // Deselect unit
      bus.emit('ui:unit-deselect');
      return;
    }

    // Arrow Down → Select next row in fleet table
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _navigateRow(1);
      return;
    }

    // Arrow Up → Select previous row
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _navigateRow(-1);
      return;
    }

    // Enter → Open detail for selected unit
    if (e.key === 'Enter') {
      const selected = document.querySelector('.fleet-table__row.row--selected');
      if (selected) {
        selected.click();
      }
      return;
    }
  });
}

function _navigateRow(direction) {
  const rows = document.querySelectorAll('.fleet-table__row');
  if (!rows.length) return;

  // Find currently selected
  let currentIdx = -1;
  rows.forEach((r, i) => { if (r.classList.contains('row--selected')) currentIdx = i; });

  let newIdx = currentIdx + direction;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= rows.length) newIdx = rows.length - 1;
  if (newIdx === currentIdx) return;

  // Click the new row (triggers selection + unit-select event)
  rows[newIdx].click();

  // Scroll into view
  rows[newIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  _selectedRowIdx = newIdx;
}
