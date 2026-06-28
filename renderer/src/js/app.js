/**
 * app.js -- Fleet Operations renderer entry point
 *
 * Startup order:
 *   1. DOM ready check
 *   2. Remove #app-loading spinner
 *   3. Init bus listeners (bridge.init)
 *   4. Mount components: toast, status-bar, toolbar
 *   5. Mount views: fleet-table, unit-detail, settings
 *   6. Register cross-view routing (ui:view-change)
 *   7. bridge.init() -> signals renderer:ready -> main pushes cache
 */

import { init as initBridge } from './bridge.js';
import bus from './bus.js';

import { init as initToast }     from './components/toast.js';
import { init as initStatusBar } from './components/status-bar.js';
import { init as initToolbar }   from './components/toolbar.js';
import { init as initFleetView } from './views/fleet.js';
import { init as initUnitDetail }from './views/unit-detail.js';
import { init as initSettings }  from './views/settings.js';
import { init as initSchedulers } from './views/schedulers.js';
import { init as initAnalytics }     from './views/analytics.js';
import { init as initVendors }       from './views/vendors.js';
import { init as initEmailComposer } from './views/email-composer.js';
import { init as initDailyNotes } from './views/daily-notes.js';

function boot() {
  // ── Remove loading spinner ───────────────────────────────────────────────
  const loadingEl = document.getElementById('app-loading');
  if (loadingEl) loadingEl.remove();

  const appEl = document.getElementById('app');
  if (!appEl) {
    console.error('[app] #app mount point not found');
    return;
  }

  // ── Layout scaffold ──────────────────────────────────────────────────────
  appEl.innerHTML = `
    <div id="app-shell">
      <div id="status-bar-mount"></div>
      <div id="main-area">
        <div id="toolbar-mount"></div>
        <div id="content-area">
          <div id="views-mount"></div>
          <div id="detail-mount"></div>
        </div>
      </div>
    </div>
  `;

  // ── Init components ──────────────────────────────────────────────────────
  initToast();   // bus-driven, no container needed
  initStatusBar(document.getElementById('status-bar-mount'));
  initToolbar(document.getElementById('toolbar-mount'));

  // ── Init views ───────────────────────────────────────────────────────────
  const viewsMount  = document.getElementById('views-mount');
  const detailMount = document.getElementById('detail-mount');

  initFleetView(viewsMount);
  initUnitDetail(detailMount);
  initSettings(viewsMount);
  initSchedulers(viewsMount);
  initAnalytics(viewsMount);
  initVendors(viewsMount);
  initEmailComposer(viewsMount);
  initDailyNotes(viewsMount);

  // ── Cross-view routing ───────────────────────────────────────────────────
  const fleetView    = document.getElementById('view-fleet');
  const settingsView = document.getElementById('view-settings');

  const analyticsView     = document.getElementById('view-analytics');
  const vendorsView       = document.getElementById('view-vendors');
  const emailComposerView = document.getElementById('view-email-composer');
  const schedulersView       = document.getElementById('view-schedulers');
  const dailyNotesView       = document.getElementById('view-daily-notes');

  bus.on('ui:view-change', ({ to }) => {
    if (fleetView)         fleetView.style.display         = to === 'fleet'          ? 'flex' : 'none';
    if (settingsView)      settingsView.style.display      = to === 'settings'       ? 'flex' : 'none';
    if (analyticsView)     analyticsView.style.display     = to === 'analytics'      ? 'flex' : 'none';
    if (vendorsView)       vendorsView.style.display       = to === 'vendors'        ? 'flex' : 'none';
    if (emailComposerView) emailComposerView.style.display = to === 'email-composer' ? 'flex' : 'none';
    if (schedulersView)       schedulersView.style.display       = to === 'schedulers'       ? 'flex' : 'none';
    if (dailyNotesView)       dailyNotesView.style.display       = to === 'daily-notes'     ? 'flex' : 'none';
  });

  // Close detail panel when switching views
  bus.on('ui:view-change', () => bus.emit('ui:unit-deselect'));

  // ── Wire IPC and signal ready ─────────────────────────────────────────────
  // initBridge() attaches all push-listeners then calls window.fleet.signalReady()
  // which triggers main process to push cached fleet data immediately.
  initBridge();

  console.log('[app] Fleet Operations renderer boot complete');
}

// ── Entry point ───────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
