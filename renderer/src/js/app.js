/**
 * app.js -- Fleet Operations renderer entry point
 *
 * Startup order:
 *   1. DOM ready check
 *   2. Remove #app-loading spinner
 *   3. Mount components: toast, status-bar, toolbar
 *   4. Mount routed views into #views-mount
 *   5. Init settings drawer (mounts on body — not a routed view)
 *   6. Register cross-view routing (ui:view-change)
 *   7. bridge.init() -> signals renderer:ready -> main pushes cache
 */

import { init as initBridge }       from './bridge.js';
import bus                          from './bus.js';

import { init as initToast }              from './components/toast.js';
import { init as initStatusBar }          from './components/status-bar.js';
import { init as initToolbar }            from './components/toolbar.js';
import { init as initVendorActivityBar }  from './components/vendor-activity-bar.js';

import { init as initFleetView }          from './views/fleet.js';
import { init as initUnitDetail }         from './views/unit-detail.js';
import { init as initSettings, applyBootPrefs } from './views/settings.js';
import { init as initSchedulers }         from './views/schedulers.js';
import { init as initAnalytics }          from './views/analytics.js';
import { init as initVendors }            from './views/vendors.js';
import { init as initEmailComposer }      from './views/email-composer.js';
import { init as initDailyNotes }         from './views/daily-notes.js';
import { init as initNotesLinks }         from './views/notes-links.js';

function boot() {
  // ── Remove loading spinner ───────────────────────────────────────────────
  const loadingEl = document.getElementById('app-loading');
  if (loadingEl) loadingEl.remove();

  const appEl = document.getElementById('app');
  if (!appEl) { console.error('[app] #app mount point not found'); return; }

  // ── Layout scaffold ──────────────────────────────────────────────────────
  appEl.innerHTML = `
    <div id="app-shell">
      <div id="status-bar-mount"></div>
      <div id="main-area">
        <div id="toolbar-mount"></div>
        <div id="vnd-activity-bar-mount"></div>
        <div id="content-area">
          <div id="views-mount"></div>
          <div id="detail-mount"></div>
        </div>
      </div>
    </div>
  `;

  // ── Init components ──────────────────────────────────────────────────────
  initToast();
  initStatusBar(document.getElementById('status-bar-mount'));
  initToolbar(document.getElementById('toolbar-mount'));
  initVendorActivityBar(document.getElementById('vnd-activity-bar-mount'));

  // ── Init routed views ────────────────────────────────────────────────────
  const viewsMount  = document.getElementById('views-mount');
  const detailMount = document.getElementById('detail-mount');

  initFleetView(viewsMount);
  initUnitDetail(detailMount);
  initSchedulers(viewsMount);
  initAnalytics(viewsMount);
  initVendors(viewsMount);
  initEmailComposer(viewsMount);
  initDailyNotes(viewsMount);
  initNotesLinks(viewsMount);

  // ── Settings drawer — mounts on body, not a routed view ──────────────────
  initSettings();
  applyBootPrefs();  // restore theme/colors/font before first paint

  // ── Cross-view routing ───────────────────────────────────────────────────
  const fleetView         = document.getElementById('view-fleet');
  const analyticsView     = document.getElementById('view-analytics');
  const vendorsView       = document.getElementById('view-vendors');
  const emailComposerView = document.getElementById('view-email-composer');
  const schedulersView    = document.getElementById('view-schedulers');
  const dailyNotesView    = document.getElementById('view-daily-notes');
  const notesLinksView    = document.getElementById('view-notes-links');

  bus.on('ui:view-change', ({ to }) => {
    // Settings is a drawer overlay — handled inside settings.js
    if (to === 'settings') return;

    if (fleetView)         fleetView.style.display         = to === 'fleet'          ? 'flex' : 'none';
    if (analyticsView)     analyticsView.style.display     = to === 'analytics'      ? 'flex' : 'none';
    if (vendorsView)       vendorsView.style.display       = to === 'vendors'        ? 'flex' : 'none';
    if (emailComposerView) emailComposerView.style.display = to === 'email-composer' ? 'flex' : 'none';
    if (schedulersView)    schedulersView.style.display    = to === 'schedulers'     ? 'flex' : 'none';
    if (dailyNotesView)    dailyNotesView.style.display    = to === 'daily-notes'    ? 'flex' : 'none';
    if (notesLinksView)    notesLinksView.style.display    = to === 'notes-links'    ? 'flex' : 'none';
  });

  // Close detail panel on any view change
  bus.on('ui:view-change', () => bus.emit('ui:unit-deselect'));

  // ── Wire IPC and signal ready ─────────────────────────────────────────────
  initBridge();

  console.log('[app] Fleet Operations renderer boot complete');
}

// ── Entry point ───────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
