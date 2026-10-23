/**
 * toolbar.js -- Fleet Ops topbar (Final Redesign)
 *
 * Layout (left → right):
 *   Brand "Fleet Ops"
 *   Nav: Dashboard · Analytics · Vendors · Scheduler
 *   KPI strip: Unavail (red) · Avail (green) · Offsite (amber) · AI Status
 *   Right: Live pulse · Clock · ↻ Sync · 🧠 Intel · 🔔 Notif · ⚙ Settings · Avatar
 *
 * Sub-bar: Search + Lifecycle + Domicile + Quick pills (only on Dashboard)
 */

import bus                        from '../bus.js';
import { fleet as fleetBridge, settings as settingsBridge } from '../bridge.js';

let _suppressFilterEvents = false;

// ── Nav tab → bus view map ──────────────────────────────────────────────────
const TAB_VIEW = {
  'fleet-table': 'fleet',
  dashboard:  'fleet',
  analytics:  'analytics',
  trends:     'trends',
  scheduler:  'schedulers',
  'email-composer': 'email-composer',
  'daily-call': 'daily-call',
  'workflow-intel': 'workflow-intel',
};

export function init(container) {
  const el = document.createElement('div');
  el.id = 'topbar-wrap';
  el.innerHTML = `
    <!-- ══ TOPBAR ══ -->
    <nav id="topbar">

      <!-- Brand -->
      <div class="tb-brand">
        <div class="tb-brand-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="2" fill="#58a6ff"/>
            <rect x="9" y="1" width="6" height="6" rx="2" fill="#79c0ff" opacity=".7"/>
            <rect x="1" y="9" width="6" height="6" rx="2" fill="#79c0ff" opacity=".7"/>
            <rect x="9" y="9" width="6" height="3" rx="1.5" fill="#d2a8ff"/>
            <circle cx="12" cy="14" r="2" fill="#7ee787"/>
          </svg>
        </div>
        <span class="tb-brand-text">Fleet Ops</span>
      </div>

      <!-- Nav tabs -->
      <div class="tb-nav">
        <button class="tb-tab active" data-view="fleet-table">
          <span class="tb-tab-icon">📋</span> Fleet
        </button>
        <button class="tb-tab" data-view="dashboard">
          <span class="tb-tab-icon">⊞</span> Dashboard
        </button>
        <button class="tb-tab" data-view="analytics">
          <span class="tb-tab-icon">⏳</span> Long Dwell
        </button>
        <button class="tb-tab" data-view="trends">
          <span class="tb-tab-icon">📈</span> Trends
        </button>
        <button class="tb-tab" data-view="scheduler">
          <span class="tb-tab-icon">⏱</span> Scheduler
        </button>
        <button class="tb-tab" data-view="workflow-intel">
          <span class="tb-tab-icon">&#129504;</span> Workflow AI
        </button>
        <button class="tb-tab" data-view="email-composer">
          <span class="tb-tab-icon">📧</span> Email</button><button class="tb-tab" data-view="daily-call"><span class="tb-tab-icon">📞</span> Daily Call
        </button>
      </div>

      
      <!-- Right side -->
      <div class="tb-right">
        <span class="tb-ai-status" id="tb-ai-status" title="AI settings — click to configure" style="cursor:pointer">
          <span class="tb-kpi-dot tb-kpi-dot--unknown" id="kpi-ai-dot"></span>
          <span id="kpi-ai-label">AI …</span>
        </span>
        <span class="tb-clock" id="tb-clock">--:--:--</span>
        <button class="tb-sync-btn" id="tb-sync" title="Force sync">
          <span class="tb-sync-icon">\u21BB</span>
        </button>
        
        <div class="tb-icon-btn" id="tb-intel" title="Intelligence Panel">🧠</div>
        <div class="tb-icon-btn" id="tb-contacts" title="Contact Book">📇</div>
        <div class="tb-icon-btn" id="tb-inbox" title="Incoming Work Requests">📋<span class="tb-notif-badge" id="tb-inbox-badge" style="display:none">0</span></div>
        <div class="tb-icon-btn" id="tb-email-triage" title="Inbox Triage (AI)">📨</div>
        <div class="tb-icon-btn" id="tb-relay-reconcile" title="Relay ↔ Offsite updates (AI)">🔁</div>
        <div class="tb-icon-btn" id="tb-notif" title="Notifications">
          🔔<span class="tb-notif-badge" id="tb-notif-badge" style="display:none">0</span>
        </div>
        <div class="tb-icon-btn" id="tb-settings" title="Settings">⚙</div>
        <button class="tb-theme-toggle" id="tb-theme-toggle" title="Toggle theme">
          <span id="tb-theme-icon">🌙</span>
        </button>
        <div class="tb-avatar" id="tb-avatar" title="Account">ZS</div>
        <div class="tb-window-controls"><button class="tb-win-btn" id="tb-win-minimize" title="Minimize">&#x2500;</button><button class="tb-win-btn" id="tb-win-maximize" title="Maximize">&#x25A1;</button><button class="tb-win-btn tb-win-close" id="tb-win-close" title="Close">&#x2715;</button></div>
      </div>
    </nav>

    <!-- ══ FILTER BAR (Dashboard only) ══ -->
    <div id="tb-filterbar">
      <div class="tb-search-wrap">
        <span class="tb-search-icon">🔍</span>
        <input
          id="tb-search"
          class="tb-search"
          type="search"
          placeholder="Search unit ID, vendor, domicile..."
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="tb-filters">
        <select id="tb-lifecycle" class="tb-select">
          <option value="">All States</option>
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
          <option value="ordered">Ordered</option>
          <option value="decommissioned">Decommissioned</option>
          <option value="in_maintenance">In Maintenance</option>
        </select>
        <select id="tb-domicile" class="tb-select">
          <option value="">All Domiciles</option>
        </select>
        <select id="tb-vendor" class="tb-select">
          <option value="">All Vendors</option>
        </select>
        <select id="tb-operator" class="tb-select">
          <option value="">All Operators</option>
        </select>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-pills" id="tb-pills">
        <button class="tb-pill active" data-filter="all">All</button>
        <button class="tb-pill" data-filter="unavailable">Unavailable</button>
        <button class="tb-pill" data-filter="offsite">Offsite</button>
        <button class="tb-pill" data-filter="high-risk">High Risk</button>
        <button class="tb-pill" data-filter="has-risk">Has Score</button>
        <button class="tb-pill" data-filter="stuck">Stuck 14d+</button>
        <button class="tb-pill" data-filter="fleetnet">FleetNet</button>
      </div>
      <div class="tb-sep" id="tb-op-sep" style="display:none"></div>
      <div class="tb-pills" id="tb-op-pills" style="display:none"></div>
    </div>
  `;

  container.appendChild(el);

  // ── Nav tabs ────────────────────────────────────────────────────────────
  el.querySelectorAll('.tb-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.tb-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const view = TAB_VIEW[btn.dataset.view] || 'fleet';
      // Pass the raw tab key too: "Fleet" and "Dashboard" both route to the
      // fleet view, but the Fleet Overview strip only shows on Dashboard.
      bus.emit('ui:view-change', { from: 'fleet', to: view, tab: btn.dataset.view });
    });
  });

  // ── Window controls (minimize, maximize, close) ─────────────────────────
  // FIX: these were previously wired *inside* the nav-tab click handler
  // above, so on a fresh launch they silently did nothing at all until the
  // user clicked a nav tab once (that's the first moment the listeners
  // actually got attached, and even then they'd get re-attached again on
  // every subsequent tab click, stacking duplicates). Wired here at init
  // time instead, so they work immediately and exactly once.
  const winMinBtn    = document.getElementById('tb-win-minimize');
  const winMaxBtn    = document.getElementById('tb-win-maximize');
  const winCloseBtn  = document.getElementById('tb-win-close');

  if (winMinBtn) winMinBtn.addEventListener('click', () => {
    if (window.fleet && window.fleet.minimize) window.fleet.minimize();
  });
  if (winMaxBtn) winMaxBtn.addEventListener('click', () => {
    if (window.fleet && window.fleet.maximize) window.fleet.maximize();
  });
  if (winCloseBtn) winCloseBtn.addEventListener('click', () => {
    if (window.fleet && window.fleet.closeWindow) window.fleet.closeWindow();
  });

  // Swap the maximize glyph to a "restore" glyph while maximized -- native
  // titlebars do this automatically; now that the window is frameless
  // (src/window/index.js) this custom button has to track it by hand.
  function _setMaxIcon(maximized) {
    if (!winMaxBtn) return;
    winMaxBtn.innerHTML = maximized ? '&#x25A3;' : '&#x25A1;';
    winMaxBtn.title = maximized ? 'Restore' : 'Maximize';
  }
  if (window.fleet && window.fleet.isMaximized) {
    window.fleet.isMaximized().then(_setMaxIcon).catch(() => {});
  }
  if (window.fleet && window.fleet.onWindowStateChanged) {
    window.fleet.onWindowStateChanged(({ maximized }) => _setMaxIcon(maximized));
  }

  // Double-click the drag region to maximize/restore -- standard OS
  // titlebar behavior that a frameless window loses unless replicated by hand.
  const topbarEl = document.getElementById('topbar');
  if (topbarEl) {
    topbarEl.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, a, input, select, .tb-window-controls')) return;
      if (window.fleet && window.fleet.maximize) window.fleet.maximize();
    });
  }

  // ── Connection status indicator ──────────────────────────────────────────
  if (window.fleet && window.fleet.onConnectionStatus) {
    window.fleet.onConnectionStatus((data) => {
      let dot = document.getElementById('connection-dot');
      if (!dot) {
        dot = document.createElement('span');
        dot.id = 'connection-dot';
        dot.style.cssText = 'width:6px;height:6px;border-radius:50%;display:inline-block;margin-left:4px;transition:background .3s;';
        const syncEl = document.getElementById('tb-sync');
        if (syncEl) syncEl.parentNode.insertBefore(dot, syncEl.nextSibling);
      }
      dot.style.background = data.online ? '#3fb950' : '#f85149';
      dot.title = data.online ? 'Online' : 'Offline \u2014 entries queued';
    });
  }


  // ── Intelligence Panel toggle
  document.getElementById("tb-intel").addEventListener("click", () => {
    bus.emit("ui:toggle-intelligence");
  });

  // ── Contact Book toggle ─────────────────────────────────────────────
  document.getElementById('tb-contacts').addEventListener('click', () => {
    bus.emit('ui:contacts-toggle');
  });

  // ── Inbox Panel toggle ─────────────────────────────────────────────
  document.getElementById('tb-inbox').addEventListener('click', () => {
    bus.emit('ui:inbox-toggle');
  });

  // ── Inbox Triage (AI) overlay toggle ───────────────────────────────
  const emailTriageBtn = document.getElementById('tb-email-triage');
  if (emailTriageBtn) emailTriageBtn.addEventListener('click', () => {
    bus.emit('ui:email-triage-toggle');
  });

  // ── Relay ↔ Offsite reconcile overlay toggle ───────────────────────
  const relayReconcileBtn = document.getElementById('tb-relay-reconcile');
  if (relayReconcileBtn) relayReconcileBtn.addEventListener('click', () => {
    bus.emit('ui:relay-reconcile-toggle');
  });

  

  // ── Settings ──────────────────────────────────────────────────────────────
  document.getElementById('tb-settings').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'fleet', to: 'settings' });
  });

  // ── AI status pill → AI Config overlay ─────────────────────────────────────
  const aiStatusEl = document.getElementById('tb-ai-status');
  if (aiStatusEl) aiStatusEl.addEventListener('click', () => {
    bus.emit('ui:ai-config-toggle');
  });

  // ── Sync ──────────────────────────────────────────────────────────────────
  const syncBtn = document.getElementById('tb-sync');
  syncBtn.addEventListener('click', async () => {
    syncBtn.classList.add('tb-sync-btn--spinning');
    syncBtn.disabled = true;
    bus.emit('ui:toast', { type: 'info', message: 'Sync triggered...', duration: 2000 });
    try {
      await fleetBridge.forceSync();
    } catch (e) {
      bus.emit('ui:toast', { type: 'error', message: 'Sync failed: ' + (e.message || e), duration: 4000 });
    }
    syncBtn.classList.remove('tb-sync-btn--spinning');
    syncBtn.disabled = false;
  });

  // ── Clock ─────────────────────────────────────────────────────────────────
  function _tick() {
    const el = document.getElementById('tb-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }
  _tick();
  setInterval(_tick, 1000);

  // ── AI (Orcha) connectivity poll ─────────────────────────────────────────
  // BUG FIX: bus.on('orcha:status', ...) below has always existed and correctly
  // updates #kpi-ai-dot / #kpi-ai-label, but nothing ever called bus.emit
  // ('orcha:status', ...) -- the IPC handler (relay.getStatus(), cheap/in-memory,
  // no network call) existed in the main process but was never exposed through
  // the context bridge. Both gaps are now closed (preload.js + this poll), so
  // the AI status pill in the toolbar actually reflects real connectivity.
  async function _pollAiStatus() {
    try {
      if (!window.ai || !window.ai.status) return;
      const status = await window.ai.status();
      bus.emit('orcha:status', status || { status: 'unknown' });
    } catch (e) {
      bus.emit('orcha:status', { status: 'error' });
    }
  }
  _pollAiStatus();
  setInterval(_pollAiStatus, 15000);

  // ── Theme toggle ──────────────────────────────────────────────────────────
  // Unified theme system — uses the full token set from settings.js (25+ vars)
  // instead of the old partial 7-var override. Includes all 4 themes.
  const THEMES = ['dark', 'light', 'midnight', 'ocean'];
  const THEME_ICONS = { dark: '🌙', light: '☀️', midnight: '✦', ocean: '🌊' };

  // Import the full theme applier from settings (applies 25+ CSS vars + body class)
  let _applyFullTheme = null;
  import('../views/settings.js').then(mod => { _applyFullTheme = mod.applyTheme; }).catch(() => {});

  let _themeIdx = THEMES.indexOf(localStorage.getItem('fleet_theme') || 'dark');
  if (_themeIdx < 0) _themeIdx = 0;

  function _applyTheme(name) {
    // Full theme application via settings.js (25+ vars, body class, persists to store)
    if (_applyFullTheme) _applyFullTheme(name);
    document.documentElement.setAttribute('data-theme', name);
    localStorage.setItem('fleet_theme', name);
    const icon = document.getElementById('tb-theme-icon');
    if (icon) icon.textContent = THEME_ICONS[name] || '🌙';
  }

  _applyTheme(THEMES[_themeIdx]);

  document.getElementById('tb-theme-toggle').addEventListener('click', () => {
    _themeIdx = (_themeIdx + 1) % THEMES.length;
    _applyTheme(THEMES[_themeIdx]);
    bus.emit('ui:toast', {
      type: 'info',
      message: THEMES[_themeIdx].charAt(0).toUpperCase() + THEMES[_themeIdx].slice(1) + ' theme',
      duration: 1200
    });
  });

  // Sync toolbar icon when theme changes from settings panel
  bus.on('nexus:theme-change', () => {
    // Read current theme from body class
    let current = 'dark';
    if (document.body.classList.contains('light-mode'))    current = 'light';
    if (document.body.classList.contains('midnight-mode')) current = 'midnight';
    if (document.body.classList.contains('ocean-mode'))    current = 'ocean';
    _themeIdx = THEMES.indexOf(current);
    if (_themeIdx < 0) _themeIdx = 0;
    const icon = document.getElementById('tb-theme-icon');
    if (icon) icon.textContent = THEME_ICONS[current] || '🌙';
  });

  // ── Search ────────────────────────────────────────────────────────────────
  let _searchTimer = null;
  document.getElementById('tb-search').addEventListener('input', (e) => {
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(() => {
      bus.emit('ui:search', { query: e.target.value.trim() });
    }, 200);
  });

  // ── Lifecycle filter ──────────────────────────────────────────────────────
  document.getElementById('tb-lifecycle').addEventListener('change', (e) => {
    bus.emit('ui:filter-change', { field: 'lifecycleState', value: e.target.value });
  });

  // ── Domicile filter ───────────────────────────────────────────────────────
  document.getElementById('tb-domicile').addEventListener('change', (e) => {
    if (_suppressFilterEvents) return;
    bus.emit('ui:filter-change', { field: 'domicileSite', value: e.target.value });
  });

  // ── Vendor filter ─────────────────────────────────────────────────────────
  document.getElementById('tb-vendor').addEventListener('change', (e) => {
    bus.emit('ui:filter-change', { field: 'vendor', value: e.target.value });
  });

  // ── Operator filter ──────────────────────────────────────────────────────
  document.getElementById('tb-operator').addEventListener('change', (e) => {
    if (_suppressFilterEvents) return;
    bus.emit('ui:filter-change', { field: 'operator', value: e.target.value });
  });

  // ── KPI counts — update from fleet state ──────────────────────────────────
  bus.on('state:fleet', (fleetSlice) => {
    const rows = fleetSlice.rows || [];

    let unavail = 0, avail = 0, offsite = 0;
    const vendors = new Set();
    const domiciles = new Set();
    const operators = new Set();
    const operatorUnavail = {};
    rows.forEach((r) => {
      const lc = (r.lifecycleState || '').toLowerCase();
      if (lc === 'unavailable') unavail++;
      if (lc === 'available')   avail++;
      if (r.isOffsite || /offsite/i.test(r.lifecycleReason || '')) offsite++;
      if (r.vendor) vendors.add(r.vendor);
      if (r.domicileSite) domiciles.add(r.domicileSite);
      if (r.operator) {
        operators.add(r.operator);
        if (lc === 'unavailable') operatorUnavail[r.operator] = (operatorUnavail[r.operator] || 0) + 1;
      }
    });

    const setKpi = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setKpi('kpi-unavail-num', unavail);
    setKpi('kpi-avail-num',   avail);
    setKpi('kpi-offsite-num', offsite);

    // Domicile dropdown rebuild
    const domicileEl = document.getElementById('tb-domicile');
    if (domicileEl) {
      const current = domicileEl.value;
      _suppressFilterEvents = true;
      domicileEl.innerHTML = '<option value="">All Domiciles</option>';
      [...domiciles].sort().forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d; opt.textContent = d;
        if (d === current) opt.selected = true;
        domicileEl.appendChild(opt);
      });
      _suppressFilterEvents = false;
    }

    // Vendor dropdown rebuild
    const vendorEl = document.getElementById('tb-vendor');
    if (vendorEl) {
      const current = vendorEl.value;
      vendorEl.innerHTML = '<option value="">All Vendors</option>';
      [...vendors].sort().forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        if (v === current) opt.selected = true;
        vendorEl.appendChild(opt);
      });
    }

    // Operator dropdown rebuild -- auto-populates from whichever operators
    // are actually present in the currently synced fleet data. No hardcoded
    // operator list to maintain -- it's always in sync with what came back
    // from the last sync.
    const operatorEl = document.getElementById('tb-operator');
    if (operatorEl) {
      const current = operatorEl.value;
      _suppressFilterEvents = true;
      operatorEl.innerHTML = '<option value="">All Operators</option>';
      [...operators].sort().forEach((o) => {
        const opt = document.createElement('option');
        opt.value = o; opt.textContent = o;
        if (o === current) opt.selected = true;
        operatorEl.appendChild(opt);
      });
      _suppressFilterEvents = false;
    }

    // Operator quick-shortcuts -- one chip per synced operator that
    // currently has unavailable units, labeled with a live count. Click =
    // jump straight to "this operator's unavailable units"
    // (lifecycleState=unavailable + operator=<name>) in one action instead
    // of two dropdown picks. Rebuilt every sync so it never drifts from
    // what's actually in the fleet data (no manual maintenance).
    const opPillsEl = document.getElementById('tb-op-pills');
    const opSepEl   = document.getElementById('tb-op-sep');
    if (opPillsEl) {
      const activeOperator = opPillsEl.dataset.active || '';
      const opsWithUnavail = [...operators]
        .filter(o => operatorUnavail[o] > 0)
        .sort((a, b) => (operatorUnavail[b] || 0) - (operatorUnavail[a] || 0));

      if (opsWithUnavail.length > 0) {
        opPillsEl.innerHTML = opsWithUnavail.map((o) => {
          const isActive = o === activeOperator;
          const safe = o.replace(/"/g, '&quot;');
          return `<button class="tb-pill${isActive ? ' active' : ''}" data-operator="${safe}" title="Show ${o}'s unavailable units">${o} (${operatorUnavail[o]})</button>`;
        }).join('');
        opPillsEl.style.display = 'flex';
        if (opSepEl) opSepEl.style.display = 'block';

        opPillsEl.querySelectorAll('.tb-pill').forEach((chip) => {
          chip.addEventListener('click', () => {
            const name = chip.dataset.operator;
            const isReclick = opPillsEl.dataset.active === name;
            opPillsEl.dataset.active = isReclick ? '' : name;
            opPillsEl.querySelectorAll('.tb-pill').forEach(c => c.classList.remove('active'));
            if (!isReclick) chip.classList.add('active');

            // Deselect the standard pills row -- this is a different filter
            // mode, never show two conflicting "active" selections at once.
            el.querySelectorAll('#tb-pills .tb-pill').forEach(p => p.classList.remove('active'));

            const lc = document.getElementById('tb-lifecycle');
            if (lc) lc.value = isReclick ? '' : 'unavailable';
            bus.emit('ui:filter-change', { field: 'lifecycleState', value: isReclick ? '' : 'unavailable' });

            if (operatorEl) { _suppressFilterEvents = true; operatorEl.value = isReclick ? '' : name; _suppressFilterEvents = false; }
            bus.emit('ui:filter-change', { field: 'operator', value: isReclick ? '' : name });
          });
        });
      } else {
        opPillsEl.innerHTML = '';
        opPillsEl.style.display = 'none';
        if (opSepEl) opSepEl.style.display = 'none';
      }
    }
  });

  // ── AI connection status ──────────────────────────────────────────────────
  // Reflects which backends are actually connected (Orcha, Claude, or both)
  // using the per-backend `backends` field from relay.getStatus(). Falls back
  // to the legacy single-status label for older payloads without `backends`.
  bus.on('orcha:status', (status) => {
    const dot = document.getElementById('kpi-ai-dot');
    const lbl = document.getElementById('kpi-ai-label');
    if (!dot) return;

    const be = status && status.backends;
    if (be && typeof be === 'object') {
      const orcha = !!be.orcha, claude = !!be.claude;
      let cls, label;
      if (orcha && claude)      { cls = 'tb-kpi-dot--green'; label = 'AI: Orcha + Claude'; }
      else if (orcha)           { cls = 'tb-kpi-dot--green'; label = 'AI: Orcha'; }
      else if (claude)          { cls = 'tb-kpi-dot--blue';  label = 'AI: Claude'; }
      else                      { cls = 'tb-kpi-dot--red';   label = 'AI: Offline'; }
      dot.className = 'tb-kpi-dot ' + cls;
      dot.title = 'Orcha: ' + (orcha ? 'connected' : 'down') + ' · Claude: ' + (claude ? 'connected' : 'down');
      if (lbl) lbl.textContent = label;
      // Broadcast a simple connected/down signal for the bottom status bar so
      // the two indicators never disagree.
      bus.emit('ai:backends', { orcha, claude, anyUp: orcha || claude });
      return;
    }

    // Legacy fallback (no per-backend info).
    const s = (status && status.status) || (status && status.connected ? 'connected' : 'unknown');
    const MAP = {
      'connected':         { cls: 'tb-kpi-dot--green',   label: 'AI: Orcha'   },
      'connected-claude':  { cls: 'tb-kpi-dot--blue',    label: 'AI: Claude'  },
      'connected-bedrock': { cls: 'tb-kpi-dot--amber',   label: 'AI: Bedrock' },
      'error':             { cls: 'tb-kpi-dot--red',     label: 'AI: Offline' },
      'unknown':           { cls: 'tb-kpi-dot--unknown', label: 'AI …'   },
    };
    const d = MAP[s] || MAP['unknown'];
    dot.className = 'tb-kpi-dot ' + d.cls;
    if (lbl) lbl.textContent = d.label;
    bus.emit('ai:backends', { orcha: s === 'connected', claude: s === 'connected-claude' || s === 'connected-bedrock', anyUp: s.startsWith('connected') });
  });

  // ── Show filter bar only on fleet/dashboard view ──────────────────────────
  const filterBar = document.getElementById('tb-filterbar');
  bus.on('ui:view-change', ({ to }) => {
    if (filterBar) filterBar.style.display = (to === 'fleet') ? 'flex' : 'none';
  });

  // ── Quick-filter pills ──────────────────────────────────────────
  el.querySelectorAll('.tb-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      el.querySelectorAll('.tb-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      const f = pill.dataset.filter;
      const lc  = document.getElementById('tb-lifecycle');
      const dom = document.getElementById('tb-domicile');
      const op  = document.getElementById('tb-operator');
      if (dom) { _suppressFilterEvents = true; dom.value = ''; _suppressFilterEvents = false; }
      // Clicking a standard pill exits "operator shortcut" mode -- clear it
      // so a stale active-operator flag doesn't reappear on the next
      // state:fleet rebuild (see operator shortcut chips below).
      if (op) { _suppressFilterEvents = true; op.value = ''; _suppressFilterEvents = false; }
      const opPillsEl = document.getElementById('tb-op-pills');
      if (opPillsEl) opPillsEl.dataset.active = '';
      bus.emit('ui:filter-change', { field: 'operator', value: '' });

      if (f === 'all') {
        if (lc) lc.value = '';
        bus.emit('ui:filter-change', { field: 'lifecycleState', value: '' });
        bus.emit('ui:filter-change', { field: 'lifecycleReason', value: '' });
        bus.emit('ui:quick-filter', { filter: 'all' });
      } else if (f === 'unavailable') {
        if (lc) lc.value = 'unavailable';
        bus.emit('ui:filter-change', { field: 'lifecycleState', value: 'unavailable' });
      } else if (f === 'offsite') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'offsite' });
      } else if (f === 'high-risk') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'high-risk' });
      } else if (f === 'has-risk') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'has-risk' });
      } else if (f === 'stuck') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'stuck' });
      } else if (f === 'fleetnet') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'fleetnet' });
      }
    });
  });


  // ── Avatar / User Profile ─────────────────────────────────────────────
  document.getElementById('tb-avatar').addEventListener('click', () => {
    // Toggle profile popover
    let pop = document.getElementById('tb-profile-pop');
    if (pop) { pop.remove(); return; }

    const profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}');
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    pop = document.createElement('div');
    pop.id = 'tb-profile-pop';
    pop.className = 'tb-profile-pop';
    pop.innerHTML = `
      <div class="tbp-section">
        <div class="tbp-title">👤 User Profile</div>
        <div class="tbp-hint">Used as the default contact on Work Requests.</div>
        <label class="tbp-label">Name</label>
        <input id="up-name" class="tbp-input" placeholder="Your name" value="${esc(profile.name)}" />
        <label class="tbp-label">Phone</label>
        <input id="up-phone" class="tbp-input" placeholder="1-555-000-0000" value="${esc(profile.phone)}" />
        <label class="tbp-label">Email</label>
        <input id="up-email" class="tbp-input" placeholder="you@amazon.com (optional)" value="${esc(profile.email)}" />
      </div>

      <div class="tbp-section">
        <div class="tbp-title">📍 Managed Domiciles</div>
        <div class="tbp-hint">The AAP sites this app pulls fleet data for. Changing these re-scans the fleet.</div>
        <div class="tbp-chips" id="up-dom-chips"></div>
        <div class="tbp-dom-add">
          <input id="up-dom-input" class="tbp-input" placeholder="Add a site code (e.g. ABE40) + Enter" />
          <button id="up-dom-reset" class="tbp-btn tbp-btn--ghost" type="button" title="Reset to defaults">Reset</button>
        </div>
      </div>

      <div class="tbp-section">
        <div class="tbp-title">🪪 Baseball Card</div>
        <div class="tbp-hint">Your AFP FAS performance card. AI fills what the app knows (name, sites, SCACs, fleet size, vendor); you fill the rest. Export the filled .docx anytime.</div>
        <button id="up-bbcard" class="tbp-btn tbp-btn--ghost" type="button">Open Baseball Card</button>
      </div>

      <button id="up-save" class="tbp-btn tbp-btn--save">Save</button>
      <div id="up-status" class="tbp-status" style="display:none"></div>
    `;
    document.body.appendChild(pop);

    // ── Baseball Card panel ───────────────────────────────────────────────
    pop.querySelector('#up-bbcard').addEventListener('click', () => {
      const prof = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}');
      _openBaseballCard(prof.name || '');
    });

    // ── Domicile chip editor ──────────────────────────────────────────────
    let _domiciles = [];
    const chipsEl = pop.querySelector('#up-dom-chips');
    const domInput = pop.querySelector('#up-dom-input');

    function _renderChips() {
      if (!_domiciles.length) {
        chipsEl.innerHTML = '<span class="tbp-chips-empty">No sites — the app will pull ALL fleets.</span>';
        return;
      }
      chipsEl.innerHTML = _domiciles.map((d, i) =>
        '<span class="tbp-chip">' + esc(d) + '<button class="tbp-chip-x" data-i="' + i + '" title="Remove">✕</button></span>'
      ).join('');
      chipsEl.querySelectorAll('.tbp-chip-x').forEach((b) => {
        b.addEventListener('click', (e) => {
          // stopPropagation: _renderChips() replaces this button's HTML during
          // the click, detaching e.target from the DOM. Without this, the
          // document-level outside-click closer then sees pop.contains(e.target)
          // === false (target is detached) and closes the whole popover — so the
          // removal looked like it "did nothing". Keep the click contained.
          e.preventDefault();
          e.stopPropagation();
          _domiciles.splice(parseInt(b.dataset.i, 10), 1);
          _renderChips();
        });
      });
    }
    function _addDomicile(raw) {
      (raw || '').split(/[\n,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((code) => {
        if (!_domiciles.includes(code)) _domiciles.push(code);
      });
      _renderChips();
    }
    // Load current domiciles from the backend (source of truth, not localStorage).
    settingsBridge.getDomiciles().then((list) => { _domiciles = Array.isArray(list) ? list.slice() : []; _renderChips(); }).catch(() => _renderChips());

    domInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); _addDomicile(domInput.value); domInput.value = ''; }
    });
    domInput.addEventListener('blur', () => { if (domInput.value.trim()) { _addDomicile(domInput.value); domInput.value = ''; } });

    pop.querySelector('#up-dom-reset').addEventListener('click', () => {
      settingsBridge.resetDomiciles().then((r) => {
        _domiciles = (r && r.domiciles) || [];
        _renderChips();
        _showStatus('✅ Domiciles reset to defaults — re-scanning', 'ok');
      }).catch((e) => _showStatus('❌ ' + (e.message || 'Reset failed'), 'err'));
    });

    function _showStatus(text, cls) {
      const st = pop.querySelector('#up-status');
      if (!st) return;
      st.textContent = text; st.className = 'tbp-status ' + (cls || ''); st.style.display = '';
    }

    // ── Save (profile → localStorage, domiciles → backend) ─────────────────
    pop.querySelector('#up-save').addEventListener('click', async () => {
      const p = {
        name:  pop.querySelector('#up-name').value.trim(),
        phone: pop.querySelector('#up-phone').value.trim(),
        email: pop.querySelector('#up-email').value.trim(),
      };
      localStorage.setItem('fleet_user_profile', JSON.stringify(p));
      const av = document.getElementById('tb-avatar');
      if (av && p.name) {
        const parts = p.name.split(' ');
        av.textContent = (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
      }
      // Domiciles: only call the backend (which triggers a rescan) when the
      // list actually has codes. An empty list is rejected by the backend, so
      // guide the user to Reset instead of silently failing.
      try {
        if (_domiciles.length) {
          await settingsBridge.saveDomiciles(_domiciles);
          _showStatus('✅ Saved', 'ok');
          setTimeout(() => pop.remove(), 700);
        } else {
          _showStatus('⚠️ Add at least one site, or click Reset for defaults', 'warn');
        }
      } catch (e) {
        _showStatus('❌ ' + (e.message || 'Save failed'), 'err');
      }
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!pop.contains(e.target) && e.target.id !== 'tb-avatar') {
          pop.remove();
          document.removeEventListener('click', _close);
        }
      });
    }, 50);
  });

}

// ── Baseball Card modal ────────────────────────────────────────────────────────
// Full overlay to view/edit/export the AFP FAS performance card. EVERY field
// has its own ✨ button:
//   data  = AI fills from app data / Phonetool (never invented)
//   prose = AI rewrites the user's rough note into the required format
//   user  = plain entry (✨ still offers a polish)
// Reporting-chain order: Skip-Level (top) → Manager → You.
const BBCARD_SECTIONS = [
  { title: 'Identity', fields: [
    { key: 'name', label: 'Name', ai: 'data' },
    { key: 'alias', label: 'Alias (alias@)', ai: 'data', hint: 'from Phonetool' },
    { key: 'managerId', label: 'Manager', ai: 'data', hint: 'from Phonetool' },
    { key: 'hireDate', label: 'Amazon Hire Date (MM/YYYY)', ai: 'data', hint: 'from Phonetool' },
    { key: 'geoFlex', label: 'Geographic Flexibility (Yes/No — preferred locations)', ai: 'prose' },
    { key: 'mentors', label: 'Mentors (name(s) + relationship)', ai: 'prose' },
  ]},
  { title: 'Portfolio Overview', fields: [
    { key: 'regionZone', label: 'Region / Zone (domicile city + state)', ai: 'data' },
    { key: 'sites', label: 'Assigned Sites', ai: 'data' },
    { key: 'fleetSize', label: 'Fleet Size', ai: 'data' },
    { key: 'operators', label: 'Operators / SCACs', ai: 'data' },
    { key: 'primaryVendor', label: 'Primary Vendor (COX / TA / Amerit)', ai: 'data' },
  ]},
  { title: 'Reporting Chain (Skip → Manager → You)', fields: [
    { key: 'skipLevelId', label: 'Skip-Level (top)', ai: 'data', hint: 'from Phonetool' },
    { key: 'managerId2', label: 'Manager', ai: 'data', hint: 'from Phonetool' },
  ]},
  { title: 'Summary', fields: [
    { key: 'summaryName', label: 'Summary — Name', ai: 'data' },
    { key: 'summaryYears', label: 'Summary — Years at Amazon', ai: 'data', hint: 'from Phonetool' },
    { key: 'summaryMonths', label: 'Summary — Months', ai: 'data', hint: 'from Phonetool tenure' },
    { key: 'summaryContext', label: 'Summary — current role context', ai: 'prose', area: true },
  ]},
  { title: 'Super Powers — Top 3 Leadership Principles', fields: [
    { key: 'lp1Name', label: 'LP 1 (auto-picked)', ai: 'user' },
    { key: 'lp1Desc', label: 'LP 1 — rough note → ✨ picks the LP + writes it', ai: 'lp', area: true },
    { key: 'lp2Name', label: 'LP 2 (auto-picked)', ai: 'user' },
    { key: 'lp2Desc', label: 'LP 2 — rough note → ✨ (different LP)', ai: 'lp', area: true },
    { key: 'lp3Name', label: 'LP 3 (auto-picked)', ai: 'user' },
    { key: 'lp3Desc', label: 'LP 3 — rough note → ✨ (different LP)', ai: 'lp', area: true },
  ]},
  { title: 'Growth Ideas — LP-backed', fields: [
    { key: 'growth1Name', label: 'Growth LP 1 (auto-picked)', ai: 'user' },
    { key: 'growth1Desc', label: 'Growth 1 — rough note → ✨ picks the LP + writes it', ai: 'lp', area: true },
    { key: 'growth2Name', label: 'Growth LP 2 (auto-picked)', ai: 'user' },
    { key: 'growth2Desc', label: 'Growth 2 — rough note → ✨ (different LP)', ai: 'lp', area: true },
    { key: 'growth3Name', label: 'Growth LP 3 (optional)', ai: 'user' },
    { key: 'growth3Desc', label: 'Growth 3 — rough note → ✨ (optional)', ai: 'lp', area: true },
  ]},
  { title: 'Biggest Accomplishments (STAR)', fields: [
    { key: 'accomp1', label: 'Accomplishment 1', ai: 'prose', area: true },
    { key: 'accomp2', label: 'Accomplishment 2', ai: 'prose', area: true },
    { key: 'accomp3', label: 'Accomplishment 3', ai: 'prose', area: true },
    { key: 'accomp4', label: 'Accomplishment 4', ai: 'prose', area: true },
  ]},
  { title: 'Accomplishments Outside Core Role', fields: [
    { key: 'outside1', label: 'Contribution 1', ai: 'prose' },
    { key: 'outside2', label: 'Contribution 2', ai: 'prose' },
    { key: 'outside3', label: 'Contribution 3', ai: 'prose' },
  ]},
  { title: 'Current Initiatives / Actions', fields: [
    { key: 'init1', label: 'Initiative 1', ai: 'prose' },
    { key: 'init1Out', label: 'Initiative 1 — target outcome', ai: 'user' },
    { key: 'init1Time', label: 'Initiative 1 — timeline', ai: 'user' },
    { key: 'init2', label: 'Initiative 2', ai: 'prose' },
    { key: 'init2Out', label: 'Initiative 2 — target outcome', ai: 'user' },
    { key: 'init2Time', label: 'Initiative 2 — timeline', ai: 'user' },
    { key: 'init3', label: 'Initiative 3', ai: 'prose' },
    { key: 'init3Out', label: 'Initiative 3 — target outcome', ai: 'user' },
    { key: 'init3Time', label: 'Initiative 3 — timeline', ai: 'user' },
  ]},
  { title: 'Tenure & Development', fields: [
    { key: 'startDate', label: 'Start Date (MM/YYYY)', ai: 'data', hint: 'from Phonetool' },
    { key: 'timeInRole', label: 'Time in Role (X years, X months)', ai: 'user' },
    { key: 'previousRoles', label: 'Previous Roles (✨ dedupes + may ask about other roles)', ai: 'data', hint: 'from Phonetool' },
    { key: 'developmentGoals', label: 'Development Goals', ai: 'prose', area: true },
  ]},
  { title: 'Personal / Fun Facts', fields: [
    { key: 'funFacts', label: 'Hobbies / interests / fun fact', ai: 'prose', area: true },
  ]},
];

function _openBaseballCard(profileName) {
  if (document.getElementById('bbcard-overlay')) return;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ov = document.createElement('div');
  ov.id = 'bbcard-overlay';
  ov.className = 'bbcard-overlay';

  const sectionsHtml = BBCARD_SECTIONS.map((sec) => {
    const rows = sec.fields.map((f) => {
      const inputId = 'bbc-' + f.key;
      const tagTitle = f.ai === 'data' ? 'AI fills this from app data / Phonetool (never invented)'
        : f.ai === 'lp' ? 'Type a rough note, then ✨ — AI picks the best-fit Leadership Principle (distinct from your others) and writes the entry'
        : f.ai === 'prose' ? 'Type a rough note, then ✨ — AI rewrites it professionally in the right format'
        : 'Your entry — ✨ offers a professional polish';
      const tagLabel = f.ai === 'data' ? 'AI' : (f.ai === 'prose' || f.ai === 'lp') ? '✨' : '✎';
      const hint = f.hint ? '<span class="bbc-hint-src">' + esc(f.hint) + '</span>' : '';
      const aiBtn = '<button class="bbc-ai-btn" type="button" data-aikey="' + f.key + '" data-aimode="' + (f.ai || 'user') + '" title="' + tagTitle + '">✨</button>';
      const control = f.area
        ? '<textarea id="' + inputId + '" class="bbc-input bbc-textarea" rows="2" data-key="' + f.key + '"></textarea>'
        : '<input id="' + inputId + '" class="bbc-input" type="text" data-key="' + f.key + '" />';
      return '<label class="bbc-field"><span class="bbc-label">' + esc(f.label) +
        ' <span class="bbc-ai-tag" title="' + tagTitle + '">' + tagLabel + '</span>' + hint + '</span>' +
        '<div class="bbc-field-row">' + control + aiBtn + '</div></label>';
    }).join('');
    return '<div class="bbc-section"><div class="bbc-section-title">' + esc(sec.title) + '</div>' + rows + '</div>';
  }).join('');

  ov.innerHTML =
    '<div class="bbcard-panel">' +
      '<div class="bbcard-head">' +
        '<div class="bbcard-title">🪪 AFP FAS Baseball Card</div>' +
        '<button id="bbc-close" class="bbcard-close" title="Close">✕</button>' +
      '</div>' +
      '<div class="bbcard-hint">Each field has its own <b>✨</b>. <b>AI</b> fields fill from the app/Phonetool (never invented). <b>✨</b> (prose) fields: type a rough note and ✨ rewrites it professionally in the right format (STAR, third-person LP, etc.). Use <b>Fetch Phonetool</b> for manager, skip-level, hire date, alias & previous roles, then <b>AI Fill All</b>, then Download the filled .docx.</div>' +
      '<div class="bbcard-body">' + sectionsHtml + '</div>' +
      '<div class="bbcard-actions">' +
        '<button id="bbc-atoz" class="tbp-btn tbp-btn--ghost">🔐 Sign in to A to Z</button>' +
        '<button id="bbc-phonetool" class="tbp-btn tbp-btn--ghost">🔎 Fetch Phonetool</button>' +
        '<button id="bbc-ai" class="tbp-btn tbp-btn--ghost">✨ AI Fill All (data)</button>' +
        '<button id="bbc-save" class="tbp-btn tbp-btn--save">Save</button>' +
        '<button id="bbc-preview" class="tbp-btn tbp-btn--ghost">👁 Preview</button>' +
        '<button id="bbc-export" class="tbp-btn tbp-btn--save">⬇ Download .docx</button>' +
        '<span id="bbc-status" class="bbc-status"></span>' +
      '</div>' +
      '<div id="bbc-preview-pane" class="bbc-preview-pane" style="display:none"></div>' +
    '</div>';
  document.body.appendChild(ov);

  const setVal = (key, v) => { const el = ov.querySelector('[data-key="' + key + '"]'); if (el) el.value = v == null ? '' : v; };
  const getAll = () => {
    const out = {};
    ov.querySelectorAll('[data-key]').forEach((el) => { out[el.getAttribute('data-key')] = el.value; });
    return out;
  };
  const status = (t, cls) => { const s = ov.querySelector('#bbc-status'); if (s) { s.textContent = t; s.className = 'bbc-status ' + (cls || ''); } };

  // Interview UI: show the AI's clarifying questions under a field with an
  // answer box plus an explicit "Submit answers" button (clearer than
  // re-clicking ✨; Ctrl+Enter also submits).
  function _showInterview(key, questions, btn) {
    _clearInterview(key);
    const field = btn && btn.closest ? btn.closest('.bbc-field') : null;
    if (!field) return;
    const box = document.createElement('div');
    box.className = 'bbc-interview';
    box.id = 'bbc-iv-' + key;
    box.innerHTML = '<div class="bbc-iv-q">💬 ' + (questions || []).map(q => '• ' + esc(q)).join('<br>') + '</div>' +
      '<textarea id="bbc-q-' + key + '" class="bbc-input bbc-textarea" rows="2" placeholder="Type your answer here…"></textarea>' +
      '<div class="bbc-iv-actions">' +
        '<button type="button" class="tbp-btn tbp-btn--save bbc-iv-submit" data-key="' + key + '">➤ Submit answer</button>' +
        '<span class="bbc-iv-hint">or press Ctrl+Enter</span>' +
      '</div>';
    field.appendChild(box);
    const ta = box.querySelector('#bbc-q-' + key);
    if (ta) {
      ta.focus();
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); btn.click(); } });
    }
    const sub = box.querySelector('.bbc-iv-submit');
    if (sub) sub.addEventListener('click', () => btn.click()); // re-run ✨ with the typed answer
  }
  function _clearInterview(key) { const b = ov.querySelector('#bbc-iv-' + key); if (b) b.remove(); }

  // Load saved card into the fields.
  (async () => {
    try { const card = await window.baseballCard.get(); if (card) Object.keys(card).forEach((k) => setVal(k, card[k])); }
    catch (_) {}
  })();

  ov.querySelector('#bbc-close').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });

  // AI fill — fills ONLY known fields that are still blank; never overwrites.
  ov.querySelector('#bbc-ai').addEventListener('click', async () => {
    status('Filling…');
    try {
      // Save current edits first so autofill merges onto them.
      await window.baseballCard.save(getAll());
      const res = await window.baseballCard.autofill({ profileName: profileName || '' });
      if (res && res.ok && res.card) {
        Object.keys(res.card).forEach((k) => setVal(k, res.card[k]));
        status('✅ Filled ' + ((res.filled && res.filled.length) || 0) + ' field(s) from app data', 'ok');
      } else { status('Nothing to fill', 'warn'); }
    } catch (e) { status('❌ ' + (e.message || 'AI fill failed'), 'err'); }
  });

  // Sign in to A to Z — opens the login window; persists the session so
  // Fetch Phonetool works. A to Z is a separate login from Midway/AAP.
  ov.querySelector('#bbc-atoz').addEventListener('click', async () => {
    status('Opening A to Z sign-in…');
    try {
      const res = await window.baseballCard.signinAtoZ();
      if (res && res.ok) status('✅ Signed in to A to Z — now click Fetch Phonetool', 'ok');
      else status('⚠️ ' + ((res && res.detail) || 'Sign-in not completed'), 'warn');
    } catch (e) { status('❌ ' + (e.message || 'Sign-in failed'), 'err'); }
  });

  // Shared Phonetool fetch (optionally auto-triggered after a sign-in).
  async function _doFetchPhonetool() {
    status('Fetching Phonetool…');
    const res = await window.baseballCard.fetchPhonetool({ user: 'zilasant' });
    if (res && res.ok) {
      await window.baseballCard.save(getAll());
      const af = await window.baseballCard.autofill({ profileName: profileName || '' });
      if (af && af.card) Object.keys(af.card).forEach((k) => setVal(k, af.card[k]));
      const got = Object.keys(res.data || {}).filter(k => res.data[k]);
      status(got.length ? '✅ Phonetool: ' + got.join(', ') : '⚠️ Phonetool returned nothing readable — fill manually', got.length ? 'ok' : 'warn');
      return true;
    }
    // Not signed in to A to Z → offer to sign in, then retry once.
    if (res && res.error === 'atoz-login') {
      status('🔐 A to Z sign-in required — opening login…', 'warn');
      const si = await window.baseballCard.signinAtoZ();
      if (si && si.ok) { return _doFetchPhonetool(); }
      status('⚠️ Sign in to A to Z, then click Fetch Phonetool again', 'warn');
      return false;
    }
    status('❌ ' + ((res && res.detail) || (res && res.error) || 'Phonetool fetch failed'), 'err');
    return false;
  }

  ov.querySelector('#bbc-phonetool').addEventListener('click', async () => {
    try { await _doFetchPhonetool(); } catch (e) { status('❌ ' + (e.message || 'Phonetool failed'), 'err'); }
  });

  // Per-field ✨: data fields pull from app data; prose fields rewrite the note.
  ov.querySelectorAll('.bbc-ai-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.getAttribute('data-aikey');
      const el = ov.querySelector('[data-key="' + key + '"]');
      const note = el ? el.value : '';
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '…';
      status('🤖 AI thinking… (can take up to a minute)', 'warn');
      try {
        // Include any answers the user typed into this field's interview box.
        const qbox = ov.querySelector('#bbc-q-' + key);
        const answers = qbox ? qbox.value.trim() : '';
        const res = await window.baseballCard.aiField({ key, note, answers, profileName: profileName || '', card: getAll() });
        if (res && res.ok && res.needsAnswers) {
          // Interviewer asked clarifying questions — show them inline for answers.
          _showInterview(key, res.questions || [], btn);
          status('💬 The AI needs a bit more — answer below, then ✨ again', 'warn');
        } else if (res && res.ok && res.value != null) {
          setVal(key, res.value);
          _clearInterview(key);
          if (res.lpNameKey && res.lpName) { setVal(res.lpNameKey, res.lpName); status('✅ ' + res.lpName + ' — written', 'ok'); }
          else status('✅ Filled ' + key, 'ok');
        } else {
          status('⚠️ ' + ((res && res.error) || 'nothing to fill for ' + key), 'warn');
        }
      } catch (e) { status('❌ ' + (e.message || 'AI failed'), 'err'); }
      finally { btn.disabled = false; btn.textContent = orig; }
    });
  });

  ov.querySelector('#bbc-save').addEventListener('click', async () => {
    try { await window.baseballCard.save(getAll()); status('✅ Saved', 'ok'); }
    catch (e) { status('❌ ' + (e.message || 'Save failed'), 'err'); }
  });

  // Preview — show exactly what will export (filled values + which fields stay
  // as [placeholder]) before writing the .docx.
  ov.querySelector('#bbc-preview').addEventListener('click', async () => {
    status('Building preview…');
    const pane = ov.querySelector('#bbc-preview-pane');
    try {
      const res = await window.baseballCard.preview(getAll());
      if (!res || !res.ok) { status('❌ Preview failed', 'err'); return; }
      const secMap = {};
      BBCARD_SECTIONS.forEach(s => s.fields.forEach(f => { secMap[f.key] = s.title; }));
      let html = '<div class="bbc-preview-title">👁 Export Preview — this is what the .docx will contain</div>';
      let curSec = '';
      res.items.forEach(it => {
        const sec = secMap[it.key] || 'Other';
        if (sec !== curSec) { html += '<div class="bbc-prev-sec">' + esc(sec) + '</div>'; curSec = sec; }
        const val = it.filled ? esc(it.value) : '<span class="bbc-prev-empty">[will stay blank / placeholder]</span>';
        html += '<div class="bbc-prev-row"><span class="bbc-prev-label">' + esc(it.label) + '</span><span class="bbc-prev-val">' + val + '</span></div>';
      });
      const filledN = res.items.filter(i => i.filled).length;
      html = '<div class="bbc-prev-summary">' + filledN + ' of ' + res.items.length + ' fields filled</div>' + html;
      pane.innerHTML = html;
      pane.style.display = '';
      pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
      status('✅ Preview ready — review below, then Download', 'ok');
    } catch (e) { status('❌ ' + (e.message || 'Preview failed'), 'err'); }
  });

  ov.querySelector('#bbc-export').addEventListener('click', async () => {
    status('Exporting…');
    try {
      await window.baseballCard.save(getAll());
      const res = await window.baseballCard.export({});
      if (res && res.ok) status('✅ Downloaded: ' + res.path, 'ok');
      else status('❌ ' + ((res && res.error) || 'Export failed'), 'err');
    } catch (e) { status('❌ ' + (e.message || 'Export failed'), 'err'); }
  });
}
