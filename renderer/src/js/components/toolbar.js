/**
 * toolbar.js -- Filter / search toolbar
 *
 * Renders: search box | lifecycle filter | domicile filter | sync button
 * Emits bus events; does not hold state itself.
 */

import bus                  from '../bus.js';
import { fleet as fleetBridge } from '../bridge.js';

let _suppressFilterEvents = false; // prevent spurious filter events during domicile rebuild

export function init(container) {
  const el = document.createElement('div');
  el.id = 'toolbar';
  el.innerHTML = `
    <div class="toolbar__search-wrap">
      <input
        id="tb-search"
        class="toolbar__search"
        type="search"
        placeholder="Search units..."
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="toolbar__filters">
      <select id="tb-lifecycle" class="toolbar__select">
        <option value="">All lifecycle states</option>
        <option value="available">Available</option>
        <option value="unavailable">Unavailable</option>
        <option value="decommissioned">Decommissioned</option>
        <option value="in_maintenance">In Maintenance</option>
      </select>
      <select id="tb-domicile" class="toolbar__select">
        <option value="">All domiciles</option>
      </select>
    </div>
    <div class="toolbar__actions">
      <button id="tb-sync" class="toolbar__btn toolbar__btn--primary" title="Force sync">
        Sync Now
      </button>
      <button id="tb-settings" class="toolbar__btn" title="Settings">
        Settings
      </button>
      <button id="tb-schedulers" class="toolbar__btn" title="Schedulers">
        ⏱ Schedulers
      </button>
    </div>
  `;
  container.appendChild(el);

  // Search
  const searchEl = document.getElementById('tb-search');
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      bus.emit('ui:search', { query: searchEl.value.trim() });
    }, 200);
  });

  // Lifecycle filter
  document.getElementById('tb-lifecycle').addEventListener('change', (e) => {
    bus.emit('ui:filter-change', { field: 'lifecycleState', value: e.target.value });
  });

  // Domicile filter
  document.getElementById('tb-domicile').addEventListener('change', (e) => {
    if (_suppressFilterEvents) return;
    bus.emit('ui:filter-change', { field: 'domicileSite', value: e.target.value });
  });

  // Sync button
  document.getElementById('tb-sync').addEventListener('click', () => {
    bus.emit('ui:toast', { type: 'info', message: 'Sync triggered...', duration: 2000 });
    fleetBridge.forceSync();
  });

  // Settings button
  document.getElementById('tb-settings').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'fleet', to: 'settings' });
  });

  // Schedulers button
  document.getElementById('tb-schedulers').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'fleet', to: 'schedulers' });
  });

  // Populate domicile options from fleet data
  bus.on('state:fleet', (fleetSlice) => {
    const domicileEl = document.getElementById('tb-domicile');
    if (!domicileEl) return;
    const current = domicileEl.value;
    const seen = new Set();
    (fleetSlice.rows || []).forEach((r) => {
      if (r.domicileSite) seen.add(r.domicileSite);
    });
    // Rebuild options preserving selection
    const sorted = [...seen].sort();
    _suppressFilterEvents = true;
    domicileEl.innerHTML = '<option value="">All domiciles</option>';
    sorted.forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      if (d === current) opt.selected = true;
      domicileEl.appendChild(opt);
    });
    _suppressFilterEvents = false;
  });
}
