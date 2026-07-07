/**
 * app.js -- Fleet Operations renderer entry point (Final Redesign)
 *
 * Core views: Dashboard (fleet table) · Analytics · Vendors · Scheduler
 * Overlays:   Unit Detail panel · Nexus Sidebar · Notifications
 * Secondary:  Email Composer · Notes · RCA Queue (accessible via actions, not nav)
 */

import { init as initBridge }       from './bridge.js';
import bus                          from './bus.js';

import { init as initToast }              from './components/toast.js';
import { init as initToolbar }            from './components/toolbar.js';
import { init as initVendorActivityBar }  from './components/vendor-activity-bar.js';
import { init as initPriorityDrawer }     from './components/priority-drawer.js';
import { init as initNotifDropdown }      from './components/notif-dropdown.js';
import { init as initOrchaFab }           from './components/orcha-fab.js';
import { init as initNexusSidebar }       from './components/nexus-sidebar.js';
import { init as initMorningBriefing }   from './components/morning-briefing.js';
import { init as initContactBook }       from './components/contact-book.js';
import { init as initDraftInbox }         from './components/draft-inbox.js';
import { init as initTimeline }           from './components/workflow-timeline.js';
import { init as initStatusBar }          from './components/status-bar.js';
import { initTheme }                      from './nexus-theme.js';

import { init as initFleetView }          from './views/fleet.js';
import { init as initUnitDetail }         from './views/unit-detail.js';
import { init as initSettings, applyBootPrefs } from './views/settings.js';
import { init as initSchedulers }         from './views/schedulers.js';
import { init as initAnalytics }          from './views/analytics.js';
import { init as initVendors }            from './views/vendors.js';
import { init as initEmailComposer }      from './views/email-composer.js';
import { init as initDailyNotes }         from './views/daily-notes.js';
import { init as initNotesLinks }         from './views/notes-links.js';
import { init as initRcaQueue }           from './views/rca-queue.js';

function boot() {
  // Global error boundary — prevent white screen
  window.onerror = (msg, src, line, col, err) => {
    console.error('[FATAL]', msg, src, line);
    const toast = document.getElementById('toast-container');
    if (toast) {
      const el = document.createElement('div');
      el.className = 'toast toast--error';
      el.textContent = 'Error: ' + (msg || 'Unknown').substring(0, 80);
      toast.appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }
    return true; // Prevent default error handling
  };
  window.onunhandledrejection = (e) => {
    console.error('[UNHANDLED]', e.reason);
    return true;
  };

  const loadingEl = document.getElementById('app-loading');
  if (loadingEl) loadingEl.remove();

  const appEl = document.getElementById('app');
  if (!appEl) { console.error('[app] #app mount point not found'); return; }

  // ── Layout scaffold ────────────────────────────────────────────────────────
  appEl.innerHTML = `
    <div id="app-shell">
      <div id="toolbar-mount"></div>
      <div id="vnd-activity-bar-mount"></div>
      <div id="body-area">
        <div id="priority-drawer-mount"></div>
        <div id="content-area">
          <div id="views-mount"></div>
          <div id="detail-mount"></div>
        </div>
      </div>
      <div id="status-bar-mount"></div>
    </div>
  `;

  // ── Components ─────────────────────────────────────────────────────────────
  initToast();
  initToolbar(document.getElementById('toolbar-mount'));
  initVendorActivityBar(document.getElementById('vnd-activity-bar-mount'));
  initPriorityDrawer(document.getElementById('priority-drawer-mount'));

  // Body-level overlays (mount on document.body)
  initNotifDropdown();
  initOrchaFab();
initDraftInbox();
initNexusSidebar();
  initMorningBriefing();
  initContactBook();
  initTimeline();
initStatusBar(document.getElementById('status-bar-mount'));
  initTheme();

  // ── Routed views ───────────────────────────────────────────────────────────
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
  initRcaQueue(viewsMount);

  // ── Settings drawer ────────────────────────────────────────────────────────
  initSettings();
  applyBootPrefs();

  // ── Cross-view routing ─────────────────────────────────────────────────────
  const fleetView         = document.getElementById('view-fleet');
  const analyticsView     = document.getElementById('view-analytics');
  const vendorsView       = document.getElementById('view-vendors');
  const emailComposerView = document.getElementById('view-email-composer');
  const schedulersView    = document.getElementById('view-schedulers');
  const dailyNotesView    = document.getElementById('view-daily-notes');
  const notesLinksView    = document.getElementById('view-notes-links');
  const rcaQueueView      = document.getElementById('view-rca-queue');

  bus.on('ui:view-change', ({ to }) => {
    if (to === 'settings') return;
    if (fleetView)         fleetView.style.display         = to === 'fleet'          ? 'flex' : 'none';
    if (analyticsView)     analyticsView.style.display     = to === 'analytics'      ? 'flex' : 'none';
    if (vendorsView)       vendorsView.style.display       = to === 'vendors'        ? 'flex' : 'none';
    if (emailComposerView) emailComposerView.style.display = to === 'email-composer' ? 'flex' : 'none';
    if (schedulersView)    schedulersView.style.display    = to === 'schedulers'     ? 'flex' : 'none';
    if (dailyNotesView)    dailyNotesView.style.display    = to === 'daily-notes'    ? 'flex' : 'none';
    if (notesLinksView)    notesLinksView.style.display    = to === 'notes-links'    ? 'flex' : 'none';
    if (rcaQueueView)      rcaQueueView.style.display      = to === 'rca-queue'      ? 'flex' : 'none';
  });

  bus.on('ui:view-change', () => bus.emit('ui:unit-deselect'));

  // ── IPC ready ──────────────────────────────────────────────────────────────
  initBridge();

  // ── Auth-failure re-auth dialog ────────────────────────────────────────────
  // Listens for fleet:auth-failure (Midway/Relay session expired) and shows
  // a modal prompting the user to re-authenticate.
  let _authModalOpen = false;
  bus.on('fleet:auth-failure', (payload) => {
    if (_authModalOpen) return;  // debounce multiple rapid failures
    _authModalOpen = true;

    const code    = (payload && payload.code) || 'SESSION_EXPIRED';
    const message = (payload && payload.message) || 'Your session has expired. Re-authenticate to continue.';

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'auth-failure-overlay';
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:99999;
      background:rgba(0,0,0,.75); backdrop-filter:blur(4px);
      display:flex; align-items:center; justify-content:center;
    `;

    overlay.innerHTML = `
      <div style="
        background:var(--bg2,#1a1a2e); border:1px solid var(--border,#333);
        border-radius:12px; padding:32px 40px; max-width:440px; width:90%;
        text-align:center; box-shadow:0 8px 32px rgba(0,0,0,.5);
      ">
        <div style="font-size:40px;margin-bottom:12px">\u26A0\uFE0F</div>
        <h2 style="margin:0 0 8px;color:var(--fg,#eee);font-size:18px">Session Expired</h2>
        <p style="margin:0 0 20px;color:var(--fg2,#aaa);font-size:14px;line-height:1.5">
          ${message}<br><small style="opacity:.6">Code: ${code}</small>
        </p>
        <button id="auth-reauth-btn" style="
          background:var(--acc,#00d4ff); color:#000; border:none;
          padding:10px 28px; border-radius:6px; font-size:14px; font-weight:600;
          cursor:pointer; margin-right:12px;
        ">Re-authenticate</button>
        <button id="auth-dismiss-btn" style="
          background:transparent; color:var(--fg2,#aaa); border:1px solid var(--border,#444);
          padding:10px 20px; border-radius:6px; font-size:14px; cursor:pointer;
        ">Dismiss</button>
        <div id="auth-reauth-status" style="margin-top:16px;font-size:13px;color:var(--fg2,#888);display:none"></div>
      </div>
    `;

    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector('#auth-reauth-status');

    overlay.querySelector('#auth-reauth-btn').addEventListener('click', async () => {
      statusEl.style.display = 'block';
      statusEl.textContent = 'Running mwinit...';
      try {
        const r = await window.auth.runMwinit();
        if (r && r.ok) {
          statusEl.textContent = '\u2705 Authenticated! Resyncing...';
          setTimeout(() => {
            overlay.remove();
            _authModalOpen = false;
            window.fleet.requestSync();
          }, 1000);
        } else {
          statusEl.textContent = '\u274C Failed: ' + (r && r.reason || 'unknown error');
        }
      } catch (e) {
        statusEl.textContent = '\u274C Error: ' + e.message;
      }
    });

    overlay.querySelector('#auth-dismiss-btn').addEventListener('click', () => {
      overlay.remove();
      _authModalOpen = false;
    });
  });

  console.log('[app] Fleet Operations boot complete');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
