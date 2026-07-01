/**
 * toolbar.js -- Fleet Ops topbar (redesigned)
 *
 * Layout (left → right):
 *   Brand logo + "Fleet Ops"
 *   Nav tabs: Dashboard · Analytics · Vendors · ⏱ Schedulers · Email · 📋 Notes
 *   KPI pills: Unavail (red) · Avail (green) · Hi-Risk (orange)
 *   Right: Live pill → Clock → ↻ Sync → 🔔 Notifications → ⚙ Settings → ZS avatar
 *
 * Search + lifecycle + domicile filters moved into a sub-bar below the topbar.
 */

import bus                        from '../bus.js';
import { fleet as fleetBridge }   from '../bridge.js';

let _suppressFilterEvents = false;

// ── Nav tab → bus view map ──────────────────────────────────────────────────
const TAB_VIEW = {
  dashboard:  'fleet',
  analytics:  'analytics',
  vendors:    'vendors',
  schedulers: 'schedulers',
  email:      'email-composer',
  notes:      'daily-notes',
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
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="6" height="6" rx="1.5" fill="#58a6ff"/>
            <rect x="9" y="1" width="6" height="6" rx="1.5" fill="#79c0ff" opacity=".7"/>
            <rect x="1" y="9" width="6" height="6" rx="1.5" fill="#79c0ff" opacity=".7"/>
            <rect x="9" y="9" width="6" height="3" rx="1.5" fill="#d2a8ff"/>
            <circle cx="12" cy="13.5" r="1.5" fill="#7ee787"/>
          </svg>
        </div>
        <span class="tb-brand-text">Fleet Ops</span>
      </div>

      <!-- Nav tabs -->
      <div class="tb-nav">
        <button class="tb-tab active" data-view="dashboard">Dashboard</button>
        <button class="tb-tab"        data-view="analytics">Analytics</button>
        <button class="tb-tab"        data-view="vendors">Vendors</button>
        <button class="tb-tab"        data-view="schedulers">⏱ Schedulers</button>
        <button class="tb-tab"        data-view="email">Email</button>
        <button class="tb-tab"        data-view="notes">📋 Notes</button>
      </div>

      <!-- KPI pills -->
      <div class="tb-kpi-strip">
        <div class="tb-kpi tb-kpi--unavail" id="kpi-unavail" title="Unavailable units">
          <span class="tb-kpi-num" id="kpi-unavail-num">—</span>
          <span class="tb-kpi-lbl">Unavail</span>
        </div>
        <div class="tb-kpi tb-kpi--avail" id="kpi-avail" title="Available units">
          <span class="tb-kpi-num" id="kpi-avail-num">—</span>
          <span class="tb-kpi-lbl">Avail</span>
        </div>
        <div class="tb-kpi tb-kpi--risk" id="kpi-risk" title="High-risk units">
          <span class="tb-kpi-num" id="kpi-risk-num">—</span>
          <span class="tb-kpi-lbl">Hi-Risk</span>
        </div>
      </div>

      <!-- Right side -->
      <div class="tb-right">
        <div class="tb-live"><div class="tb-live-dot"></div>Live</div>
        <span class="tb-clock" id="tb-clock">--:--:--</span>
        <button class="tb-sync-btn" id="tb-sync" title="Force sync">
          <span class="tb-sync-icon">↻</span> Sync
        </button>
        <div class="tb-icon-btn" id="tb-notif" title="Notifications">
          🔔<span class="tb-notif-badge" id="tb-notif-badge" style="display:none">0</span>
        </div>
        <div class="tb-icon-btn" id="tb-settings" title="Settings">⚙</div>
        <div class="tb-avatar" id="tb-avatar" title="Account">ZS</div>
      </div>
    </nav>

    <!-- ══ FILTER SUB-BAR ══ -->
    <div id="tb-filterbar">
      <div class="tb-search-wrap">
        <input
          id="tb-search"
          class="tb-search"
          type="search"
          placeholder="Search units..."
          autocomplete="off"
          spellcheck="false"
        />
      </div>
      <div class="tb-filters">
        <select id="tb-lifecycle" class="tb-select">
          <option value="">All lifecycle states</option>
          <option value="available">Available</option>
          <option value="unavailable">Unavailable</option>
          <option value="decommissioned">Decommissioned</option>
          <option value="in_maintenance">In Maintenance</option>
        </select>
        <select id="tb-domicile" class="tb-select">
          <option value="">All domiciles</option>
        </select>
      </div>
    </div>
  `;

  container.appendChild(el);

  // ── Nav tabs ──────────────────────────────────────────────────────────────
  el.querySelectorAll('.tb-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.tb-tab').forEach((t) => t.classList.remove('active'));
      btn.classList.add('active');
      const view = TAB_VIEW[btn.dataset.view] || 'fleet';
      bus.emit('ui:view-change', { from: 'fleet', to: view });
    });
  });

  // ── Settings ──────────────────────────────────────────────────────────────
  document.getElementById('tb-settings').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'fleet', to: 'settings' });
  });

  // ── Sync ──────────────────────────────────────────────────────────────────
  document.getElementById('tb-sync').addEventListener('click', () => {
    bus.emit('ui:toast', { type: 'info', message: 'Sync triggered...', duration: 2000 });
    fleetBridge.forceSync();
  });

  // ── Clock ─────────────────────────────────────────────────────────────────
  function _tick() {
    const el = document.getElementById('tb-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('en-US', { hour12: false });
  }
  _tick();
  setInterval(_tick, 1000);

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

  // ── KPI counts — update from fleet state ──────────────────────────────────
  bus.on('state:fleet', (fleetSlice) => {
    const rows = fleetSlice.rows || [];

    // KPI counts
    let unavail = 0, avail = 0, risk = 0;
    rows.forEach((r) => {
      const lc = (r.lifecycleState || '').toLowerCase();
      if (lc === 'unavailable') unavail++;
      if (lc === 'available')   avail++;
      if (r.riskScore >= 70)    risk++;
    });
    const setKpi = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
    setKpi('kpi-unavail-num', unavail);
    setKpi('kpi-avail-num',   avail);
    setKpi('kpi-risk-num',    risk);

    // Domicile dropdown rebuild
    const domicileEl = document.getElementById('tb-domicile');
    if (!domicileEl) return;
    const current = domicileEl.value;
    const seen = new Set();
    rows.forEach((r) => { if (r.domicileSite) seen.add(r.domicileSite); });
    _suppressFilterEvents = true;
    domicileEl.innerHTML = '<option value="">All domiciles</option>';
    [...seen].sort().forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d; opt.textContent = d;
      if (d === current) opt.selected = true;
      domicileEl.appendChild(opt);
    });
    _suppressFilterEvents = false;
  });

  // ── Show filter bar only on fleet/dashboard view ──────────────────────────
  const filterBar = document.getElementById('tb-filterbar');
  bus.on('ui:view-change', ({ to }) => {
    if (filterBar) filterBar.style.display = (to === 'fleet' || to === 'dashboard') ? 'flex' : 'none';
  });
}
