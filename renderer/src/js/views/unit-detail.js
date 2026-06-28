/**
 * unit-detail.js -- Unit detail panel / drawer
 *
 * Slides in from the right when a unit is selected (ui:unit-select).
 * Slides out on close or ui:unit-deselect.
 *
 * Shows: unit fields | relay WOs | Uptake insights | notes | quick actions
 *
 * S9: relay WO cards, Uptake insights, lifecycle change form,
 *     AI Suggest wired (spinner + copy), Create WR → aap.autofill
 */

import bus           from '../bus.js';
import state         from '../state.js';
import { notes, ai, aap, relay } from '../bridge.js';
import { open as openWRModal }    from './wr-modal.js';
import toast         from '../components/toast.js';

let _panel    = null;
let _unit     = null;
let _notesVal = '';

const FIELDS = [
  ['Equipment ID',       'equipmentId'],
  ['Asset Type',         'assetType'],
  ['Lifecycle State',    'lifecycleState'],
  ['Lifecycle Reason',   'lifecycleReason'],
  ['Domicile',           'domicileSite'],
  ['Operator',           'operator'],
  ['Manufacturer',       'manufacturer'],
  ['Body Type',          'bodyType'],
  ['Engine Manufacturer','engineManufacturer'],
  ['Fuel Type',          'fuelType'],
  ['Due Date',           'dueDate'],
  ['Open Unplanned WRs', 'openUnplanned'],
  ['Open Planned WRs',   'openPlanned'],
  ['Last Geofence',      'geofence'],
  ['Lat/Long',           'latLong'],
];

function _esc(s) {
  return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// S9: risk badge
function _riskBadge(score) {
  const n = parseInt(score, 10);
  if (isNaN(n)) return '';
  const cls = n >= 70 ? 'risk-high' : n >= 40 ? 'risk-medium' : 'risk-low';
  return '<span class="badge badge--' + cls + '">' + n + '</span>';
}

// S9: render relay WO section into #dp-relay-wos
function _loadRelayWOs(unit) {
  const el = document.getElementById('dp-relay-wos');
  if (!el) return;
  el.innerHTML = '<p class="dp-empty">Loading work orders...</p>';

  relay.getUnitCache(unit.equipmentId).then((data) => {
    if (!el) return;
    const wos = (data && data.workOrders) ? data.workOrders : [];
    if (wos.length === 0) {
      el.innerHTML = '<p class="dp-empty">No open work orders in Relay.</p>';
      return;
    }
    el.innerHTML = wos.map((wo) => {
      const statusCls = (wo.status || '').toLowerCase().includes('open') ? 'wo-open' : 'wo-closed';
      const ageDays   = wo.createdAt
        ? Math.floor((Date.now() - new Date(wo.createdAt).getTime()) / 86400000)
        : null;
      return `
        <div class="dp-relay-card">
          <span class="dp-relay-card__vendor">${_esc(wo.vendor || '—')}</span>
          <span class="badge badge--${statusCls}">${_esc(wo.status || 'Open')}</span>
          <span class="dp-relay-card__desc">${_esc(wo.description || '')}</span>
          ${ageDays !== null ? '<span class="dp-relay-card__age">' + ageDays + 'd</span>' : ''}
        </div>
      `;
    }).join('');
  }).catch(() => {
    if (el) el.innerHTML = '<p class="dp-empty">Could not load work orders.</p>';
  });
}

// S9: render Uptake insights into #dp-insights-list + risk badge into #dp-risk-badge
function _renderInsights(unit) {
  const badgeEl = document.getElementById('dp-risk-badge');
  if (badgeEl && unit.riskScore) {
    badgeEl.innerHTML = _riskBadge(unit.riskScore);
  }

  const listEl = document.getElementById('dp-insights-list');
  if (!listEl) return;
  const insights = Array.isArray(unit.insights) ? unit.insights : [];
  if (insights.length === 0) {
    listEl.outerHTML = '<p id="dp-insights-list" class="dp-empty">No active Uptake insights.</p>';
    return;
  }
  listEl.innerHTML = insights.map((ins) =>
    '<li class="dp-insight"><span class="dp-insight__type">[' + _esc(ins.type || 'insight') + ']</span> ' +
    _esc(ins.summary || String(ins)) + '</li>'
  ).join('');
}

// S9: lifecycle change form wiring
function _wireLifecycleForm(unit) {
  const btn      = document.getElementById('dp-lc-open');
  const form     = document.getElementById('dp-lc-form');
  const cancelEl = document.getElementById('dp-lc-cancel');
  const confirmEl= document.getElementById('dp-lc-confirm');
  const actionsEl= document.getElementById('dp-quick-actions');
  if (!btn || !form || !cancelEl || !confirmEl || !actionsEl) return;

  btn.addEventListener('click', () => {
    actionsEl.style.display = 'none';
    form.style.display = 'flex';
  });

  cancelEl.addEventListener('click', () => {
    form.style.display = 'none';
    actionsEl.style.display = 'flex';
  });

  confirmEl.addEventListener('click', async () => {
    if (!unit.assetUrl) {
      toast.show('warn', 'No AAP URL for this unit', 3000);
      return;
    }
    const lcState  = document.getElementById('dp-lc-state').value;
    const lcReason = (document.getElementById('dp-lc-reason').value || '').trim();
    confirmEl.disabled = true;
    confirmEl.textContent = 'Saving...';
    try {
      await aap.setLifecycle(unit.equipmentId, unit.assetUrl, lcState, lcReason);
      toast.show('success', 'Lifecycle changed to ' + lcState);
      form.style.display = 'none';
      actionsEl.style.display = 'flex';
    } catch (e) {
      toast.show('error', 'Lifecycle change failed: ' + e.message);
    } finally {
      confirmEl.disabled = false;
      confirmEl.textContent = 'Confirm';
    }
  });
}

// S9: AI Suggest wiring (spinner + copy button)
function _wireAISuggest(unit) {
  const btn      = document.getElementById('dp-ai-suggest');
  const askInput = document.getElementById('dp-ai-ask');
  const askBtn   = document.getElementById('dp-ai-ask-btn');
  const resultEl = document.getElementById('dp-ai-result');
  if (!btn || !resultEl) return;

  async function _runSuggest(promptOverride) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<span class="dp-ai-spinner">⟳ Asking Orcha...</span>';
    try {
      let result;
      if (promptOverride) {
        const fullPrompt = '[Unit: ' + unit.equipmentId + '] ' + promptOverride;
        result = await ai.ask(fullPrompt);
      } else {
        result = await ai.suggest(unit);
      }
      const text = (result && result.text) ? result.text : JSON.stringify(result, null, 2);
      resultEl.innerHTML =
        '<div class="dp-ai-text">' + _esc(text) + '</div>' +
        '<button id="dp-ai-copy" class="detail-panel__btn dp-ai-copy-btn">Copy</button>';
      document.getElementById('dp-ai-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(text).catch(() => {});
        toast.show('info', 'Copied to clipboard', 2000);
      });
    } catch (e) {
      resultEl.innerHTML = '<span class="dp-ai-error">' + _esc(e.message) + '</span>';
    }
  }

  btn.addEventListener('click', () => _runSuggest(null));

  if (askBtn && askInput) {
    askBtn.addEventListener('click', () => {
      const q = askInput.value.trim();
      if (q) _runSuggest(q);
    });
    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = askInput.value.trim(); if (q) _runSuggest(q); }
    });
  }
}

// S11: Create WR -> openWRModal (full modal with vendor/urgency/areas/screenshot)
function _wireCreateWR(unit) {
  const btn = document.getElementById('dp-create-wr');
  if (!btn) return;
  btn.addEventListener('click', () => { openWRModal(unit); });
}

function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;

  const rows = FIELDS
    .filter(([, key]) => unit[key])
    .map(([label, key]) =>
      '<tr><th>' + label + '</th><td>' + _esc(unit[key]) + '</td></tr>'
    ).join('');

  _panel.innerHTML = `
    <div class="detail-panel__header">
      <h2 class="detail-panel__title">${_esc(unit.equipmentId)}</h2>
      <button id="dp-close" class="detail-panel__close" aria-label="Close">&times;</button>
    </div>
    <div class="detail-panel__body">

      <!-- Fields table -->
      <table class="detail-panel__table"><tbody>${rows}</tbody></table>

      <!-- S9: Relay Work Orders -->
      <div class="detail-panel__section">
        <h3>Relay Work Orders</h3>
        <div id="dp-relay-wos" class="dp-relay-list"></div>
      </div>

      <!-- S9: Uptake Insights -->
      <div class="detail-panel__section">
        <h3>Uptake Insights <span id="dp-risk-badge"></span></h3>
        <ul id="dp-insights-list" class="dp-insights-list"></ul>
      </div>

      <!-- Notes -->
      <div class="detail-panel__section">
        <h3>Notes</h3>
        <textarea id="dp-notes" class="detail-panel__notes" placeholder="Add notes for this unit..."></textarea>
        <button id="dp-save-notes" class="detail-panel__btn">Save Notes</button>
      </div>

      <!-- Quick Actions -->
      <div class="detail-panel__section">
        <h3>Quick Actions</h3>
        <div id="dp-quick-actions" class="detail-panel__actions">
          <button id="dp-aap-open"   class="detail-panel__btn">Open in AAP</button>
          <button id="dp-ai-suggest" class="detail-panel__btn">AI Suggest</button>
          <button id="dp-create-wr"  class="detail-panel__btn">Create WR</button>
          <button id="dp-lc-open"    class="detail-panel__btn">Change Lifecycle</button>
        </div>

        <!-- S9: Ask Orcha free-text -->
        <div class="dp-ai-ask-row">
          <input id="dp-ai-ask" class="detail-panel__input" type="text" placeholder="Ask Orcha about this unit..." />
          <button id="dp-ai-ask-btn" class="detail-panel__btn">Ask</button>
        </div>

        <!-- S9: Lifecycle change form (hidden by default) -->
        <div id="dp-lc-form" class="dp-lc-form" style="display:none">
          <select id="dp-lc-state" class="detail-panel__select">
            <option value="Available">Available</option>
            <option value="Unavailable">Unavailable</option>
          </select>
          <input id="dp-lc-reason" class="detail-panel__input" type="text" placeholder="Reason..." />
          <button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button>
          <button id="dp-lc-cancel"  class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
        </div>
      </div>

      <!-- AI result -->
      <div id="dp-ai-result" class="detail-panel__ai-result" style="display:none"></div>

    </div>
  `;

  document.getElementById('dp-close').addEventListener('click', close);

  // Load existing notes
  notes.getUnit(unit.equipmentId).then((n) => {
    const ta = document.getElementById('dp-notes');
    if (ta && n && n.content) { ta.value = n.content; _notesVal = n.content; }
  }).catch(() => {});

  // Save notes
  document.getElementById('dp-save-notes').addEventListener('click', async () => {
    const ta = document.getElementById('dp-notes');
    if (!ta) return;
    try {
      await notes.saveUnit({ unitId: unit.equipmentId, content: ta.value });
      toast.show('success', 'Notes saved');
    } catch (e) {
      toast.show('error', 'Failed to save notes: ' + e.message);
    }
  });

  // Open in AAP
  document.getElementById('dp-aap-open').addEventListener('click', () => {
    if (unit.assetUrl) {
      aap.openUrl(unit.assetUrl);
    } else {
      toast.show('warn', 'No AAP URL for this unit', 3000);
    }
  });

  // S9: wire new sections
  _loadRelayWOs(unit);
  _renderInsights(unit);
  _wireLifecycleForm(unit);
  _wireAISuggest(unit);
  _wireCreateWR(unit);
}

function close() {
  if (_panel) {
    _panel.classList.remove('detail-panel--open');
    setTimeout(() => {
      if (_panel) _panel.innerHTML = '';
      _unit = null;
    }, 300);
  }
  bus.emit('ui:unit-deselect');
}

export function init(container) {
  _panel = document.createElement('div');
  _panel.id = 'detail-panel';
  _panel.className = 'detail-panel';
  container.appendChild(_panel);

  bus.on('ui:unit-select', ({ unit }) => {
    _renderUnit(unit);
    requestAnimationFrame(() => _panel.classList.add('detail-panel--open'));
  });

  bus.on('ui:unit-deselect', () => {
    if (_panel) _panel.classList.remove('detail-panel--open');
  });
}
