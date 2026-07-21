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
import { fleet as fleetBridge }   from '../bridge.js';

let _suppressFilterEvents = false;

// ── Nav tab → bus view map ──────────────────────────────────────────────────
const TAB_VIEW = {
  dashboard:  'fleet',
  analytics:  'analytics',
  vendors:    'vendors',
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

      <!-- Nav tabs (reduced to 4 core views) -->
      <div class="tb-nav">
        <button class="tb-tab active" data-view="dashboard">
          <span class="tb-tab-icon">⊞</span> Dashboard
        </button>
        <button class="tb-tab" data-view="analytics">
          <span class="tb-tab-icon">📊</span> Analytics
        </button>
        <button class="tb-tab" data-view="vendors">
          <span class="tb-tab-icon">🏢</span> Vendors
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
        <span class="tb-ai-status" id="tb-ai-status" title="Orcha AI connection status">
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
        <button class="tb-pill" data-filter="stuck">Stuck 14d+</button>
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
      bus.emit('ui:view-change', { from: 'fleet', to: view });
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

  

  // ── Settings ──────────────────────────────────────────────────────────────
  document.getElementById('tb-settings').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'fleet', to: 'settings' });
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
      bus.emit('orcha:status', { connected: status && status.status === 'connected' });
    } catch (e) {
      bus.emit('orcha:status', { connected: false });
    }
  }
  _pollAiStatus();
  setInterval(_pollAiStatus, 15000);

  // ── Theme toggle ──────────────────────────────────────────────────────────
  const THEMES = ['dark', 'light', 'midnight'];
  const THEME_ICONS = { dark: '🌙', light: '☀️', midnight: '✦' };
  const THEME_VARS = {
    dark:     { '--bg':'#0d1117','--panel':'#161b22','--card':'#1c2128','--el':'#21262d','--txt':'#f0f6fc','--txt2':'#8b949e','--bdr':'#30363d' },
    light:    { '--bg':'#f6f8fa','--panel':'#ffffff','--card':'#f0f2f5','--el':'#e7eaf0','--txt':'#1c2128','--txt2':'#57606a','--bdr':'#d0d7de' },
    midnight: { '--bg':'#050709','--panel':'#0d1117','--card':'#111418','--el':'#161b22','--txt':'#e6edf3','--txt2':'#7d8590','--bdr':'#21262d' },
  };
  let _themeIdx = THEMES.indexOf(localStorage.getItem('fleet_theme') || 'dark');
  if (_themeIdx < 0) _themeIdx = 0;

  function _applyTheme(name) {
    const vars = THEME_VARS[name] || THEME_VARS.dark;
    Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
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
  bus.on('orcha:status', (status) => {
    const dot = document.getElementById('kpi-ai-dot');
    const lbl = document.getElementById('kpi-ai-label');
    if (!dot) return;
    if (status.connected) {
      dot.className = 'tb-kpi-dot tb-kpi-dot--green';
      if (lbl) lbl.textContent = 'AI ✓';
    } else {
      dot.className = 'tb-kpi-dot tb-kpi-dot--red';
      if (lbl) lbl.textContent = 'AI ✗';
    }
  });

  // ── Show filter bar only on fleet/dashboard view ──────────────────────────
  const filterBar = document.getElementById('tb-filterbar');
  bus.on('ui:view-change', ({ to }) => {
    if (filterBar) filterBar.style.display = (to === 'fleet' || to === 'dashboard') ? 'flex' : 'none';
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
      } else if (f === 'stuck') {
        if (lc) lc.value = '';
        bus.emit('ui:quick-filter', { filter: 'stuck' });
      }
    });
  });


  // ── Avatar / User Profile ─────────────────────────────────────────────
  document.getElementById('tb-avatar').addEventListener('click', () => {
    // Toggle profile popover
    let pop = document.getElementById('tb-profile-pop');
    if (pop) { pop.remove(); return; }

    const profile = JSON.parse(localStorage.getItem('fleet_user_profile') || '{}');

    pop = document.createElement('div');
    pop.id = 'tb-profile-pop';
    pop.style.cssText = 'position:fixed;top:44px;right:12px;width:260px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,0.4);';
    pop.innerHTML = `
      <div style="font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:10px;">👤 User Profile</div>
      <div style="font-size:9px;color:#8b949e;margin-bottom:8px;">Used as default contact for Work Requests</div>
      <input id="up-name" class="sd-input" style="width:100%;margin-bottom:6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 8px;color:#c9d1d9;font-size:11px;" placeholder="Your name" value="${profile.name || ''}" />
      <input id="up-phone" class="sd-input" style="width:100%;margin-bottom:6px;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 8px;color:#c9d1d9;font-size:11px;" placeholder="Phone (1-555-000-0000)" value="${profile.phone || ''}" />
      <input id="up-email" class="sd-input" style="width:100%;margin-bottom:10px;background:#0d1117;border:1px solid #30363d;border-radius:4px;padding:6px 8px;color:#c9d1d9;font-size:11px;" placeholder="Email (optional)" value="${profile.email || ''}" />
      <button id="up-save" style="width:100%;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);border-radius:4px;color:#3fb950;font-size:10px;font-weight:600;padding:6px;cursor:pointer;">Save</button>
    `;
    document.body.appendChild(pop);

    document.getElementById('up-save').addEventListener('click', () => {
      const p = {
        name: document.getElementById('up-name').value.trim(),
        phone: document.getElementById('up-phone').value.trim(),
        email: document.getElementById('up-email').value.trim()
      };
      localStorage.setItem('fleet_user_profile', JSON.stringify(p));
      // Update avatar initials
      const av = document.getElementById('tb-avatar');
      if (av && p.name) {
        const parts = p.name.split(' ');
        av.textContent = (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
      }
      pop.remove();
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
