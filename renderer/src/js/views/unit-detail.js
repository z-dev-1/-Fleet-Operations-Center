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
import { notes, ai, aap, relay, vendor } from '../bridge.js';
import { open as openWRModal }    from './wr-modal.js';
import { open as openVendorReview } from './vendor-review-modal.js';
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


// S23-9: Dealer WO panel helpers ----------------------------------------

function _checkIcon(s) { return s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✗'; }
function _checkCls(s)  { return s === 'pass' ? 'pass' : s === 'warn' ? 'warn' : 'fail'; }

function _renderInvestigation(result) {
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) return;
  const { eligible, vendor: v, warnings = [], blocking = [], checks = {}, existingWO } = result;

  const ORDER = ['unit_data','vendor','lifecycle','offsite_match','relay_wo','mileage'];
  const checkRows = ORDER.filter(id => checks[id]).map(id => {
    const c = checks[id];
    const cls = _checkCls(c.status);
    return '<div class="dp-vnd-check dp-vnd-check--' + cls + '">' +
      '<span class="dp-vnd-check__icon">' + _checkIcon(c.status) + '</span>' +
      '<span class="dp-vnd-check__name">' + _esc(c.name || id) + '</span>' +
      '<span class="dp-vnd-check__detail">' + _esc(c.detail || '') + '</span>' +
      '</div>';
  }).join('');

  const blockHtml = blocking.length
    ? '<div class="dp-vnd-blocking">' +
        blocking.map(b => '<div class="dp-vnd-blocking__row">✗ ' + _esc(b) + '</div>').join('') +
      '</div>'
    : '';

  const warnHtml = warnings.length
    ? '<div class="dp-vnd-warnings">' +
        warnings.map(w => '<div class="dp-vnd-warn-row">⚠ ' + _esc(w) + '</div>').join('') +
      '</div>'
    : '';

  const existHtml = existingWO
    ? '<div class="dp-vnd-existing">' +
        '<span class="dp-vnd-existing__label">Existing case:</span> ' +
        (existingWO.url
          ? '<a class="dp-vnd-link" href="' + _esc(existingWO.url) + '" target="_blank" rel="noreferrer">' +
              _esc(existingWO.title || existingWO.caseNumber || 'Open') + '</a>'
          : '<span>' + _esc(existingWO.title || existingWO.caseNumber || '') + '</span>') +
      '</div>'
    : '';

  const vendorLabel = v === 'paccar' ? 'PACCAR / Kenworth / Peterbilt'
                    : v === 'volvo'  ? 'Volvo / ASIST'
                    : (v || 'Unknown');

  const startHtml = eligible
    ? '<button id="dp-vnd-start" class="detail-panel__btn detail-panel__btn--vendor" data-vendor="' + _esc(v) + '">Start ' + _esc(vendorLabel) + ' Portal</button>'
    : '<div class="dp-vnd-blocked">Cannot start Dealer WO. Resolve errors above.</div>';
  sec.innerHTML =
    '<div class="dp-vnd-header">' +
      '<span class="dp-vnd-badge dp-vnd-badge--' + _esc(v || 'unknown') + '">' + _esc(vendorLabel) + '</span>' +
      '<span class="dp-vnd-status dp-vnd-status--' + (eligible ? 'eligible' : 'blocked') + '">' +
        (eligible ? 'Eligible' : 'Blocked') + '</span>' +
    '</div>' +
    '<div class="dp-vnd-checks">' + checkRows + '</div>' +
    blockHtml + warnHtml + existHtml +
    '<div id="dp-vnd-actions" class="dp-vnd-actions">' + startHtml + '</div>' +
    '<div id="dp-vnd-progress" class="dp-vnd-progress" style="display:none"></div>';

  if (eligible) {
    document.getElementById('dp-vnd-start')
      .addEventListener('click', () => _startVendorWF(result.unit || _unit, v));
  }
}

function _renderProgress(p) {
  const el = document.getElementById('dp-vnd-progress');
  if (!el) return;
  el.style.display = 'block';
  const stepCls = (p.step || '').includes('error')    ? 'dp-vnd-step--error'
                : (p.step || '').includes('complete')  ? 'dp-vnd-step--done'
                : 'dp-vnd-step--active';
  el.innerHTML += '<div class="dp-vnd-step ' + stepCls + '">' +
    '<span class="dp-vnd-step__ts">' + new Date(p.ts || Date.now()).toLocaleTimeString() + '</span>' +
    '<span class="dp-vnd-step__label">' + _esc(p.step || '') + '</span>' +
    (p.detail ? '<span class="dp-vnd-step__detail">' + _esc(p.detail) + '</span>' : '') +
    '</div>';
  el.scrollTop = el.scrollHeight;
}

function _showApproveCancel(workflowId, reviewPayload) {
  const payload = reviewPayload || { workflowId, unit: _unit && (_unit.id || _unit.equipmentId) || '' };
  openVendorReview(payload, {
    onApprove: () => {
      const actEl = document.getElementById('dp-vnd-actions');
      if (actEl) actEl.innerHTML = '<span class="dp-vnd-step dp-vnd-step--active">Submitting...</span>';
    },
    onCancel: () => {
      const sec = document.getElementById('dp-vendor-section');
      if (sec) sec.dataset.workflowId = '';
      const actEl = document.getElementById('dp-vnd-actions');
      if (actEl) {
        actEl.innerHTML = '<button id="dp-vnd-reinvest" class="detail-panel__btn detail-panel__btn--secondary">Re-check eligibility</button>';
        const ri = document.getElementById('dp-vnd-reinvest');
        if (ri) ri.addEventListener('click', () => _wireVendorPanel(_unit));
      }
    },
  });
}
async function _startVendorWF(unit, vendorKey) {
  const startBtn = document.getElementById('dp-vnd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting...'; }
  const progressEl = document.getElementById('dp-vnd-progress');
  if (progressEl) { progressEl.style.display = 'block'; progressEl.innerHTML = ''; }
  try {
    const fn = vendorKey === 'paccar' ? vendor.startPaccar : vendor.startVolvo;
    const { workflowId } = await fn(unit);
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.dataset.workflowId = workflowId;
    _showApproveCancel(workflowId);
    toast.show('info', 'Dealer WO workflow started', 3000);
  } catch (e) {
    toast.show('error', 'Failed to start workflow: ' + e.message);
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Retry'; }
  }
}

async function _approveWF(workflowId) {
  const btn = document.getElementById('dp-vnd-approve');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }
  try {
    await vendor.approve(workflowId);
    toast.show('success', 'Dealer WO approved and submitted');
  } catch (e) {
    toast.show('error', 'Approve failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Submit'; }
  }
}

async function _cancelWF(workflowId) {
  const btn = document.getElementById('dp-vnd-cancel');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }
  try {
    await vendor.cancel(workflowId);
    toast.show('info', 'Dealer WO workflow cancelled');
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.dataset.workflowId = '';
    const actEl = document.getElementById('dp-vnd-actions');
    if (actEl) {
      actEl.innerHTML = '<button id="dp-vnd-reinvest" class="detail-panel__btn detail-panel__btn--secondary">Re-check eligibility</button>';
      const ri = document.getElementById('dp-vnd-reinvest');
      if (ri) ri.addEventListener('click', () => _wireVendorPanel(_unit));
    }
  } catch (e) {
    toast.show('error', 'Cancel failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// S23-13: off-fns for vendor bus listeners
let _vendorUnsubs = [];
function _teardownVendorBus() {
  _vendorUnsubs.forEach((fn) => fn());
  _vendorUnsubs = [];
}

function _wireVendorPanel(unit) {
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) return;
  _teardownVendorBus();
  sec.innerHTML = '<p class="dp-empty">Checking eligibility...</p>';
  vendor.investigate(unit).then((result) => {
    _renderInvestigation(result);
    _vendorUnsubs.push(
      bus.on('vendor:progress', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress(p);
      }),
      bus.on('vendor:review-ready', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'review-ready', detail: 'Portal ready. Review then approve.' });
        _showApproveCancel(sec.dataset.workflowId, p);
      }),
      bus.on('vendor:complete', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'complete', detail: 'Case: ' + (p.caseNumber || '') });
        const actEl = document.getElementById('dp-vnd-actions');
        if (actEl) actEl.innerHTML = '<span class="dp-vnd-complete">✓ Dealer WO created' + (p.caseNumber ? ' — case ' + _esc(p.caseNumber) : '') + '</span>';
        toast.show('success', 'Dealer WO submitted successfully');
        _teardownVendorBus();
      }),
      bus.on('vendor:error', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'error', detail: p.error || 'Unknown error' });
        toast.show('error', 'Dealer WO error: ' + (p.error || 'unknown'));
        _teardownVendorBus();
      }),
    );
  }).catch((e) => {
    if (sec) sec.innerHTML = '<p class="dp-empty dp-empty--error">Investigation failed: ' + _esc(e.message) + '</p>';
  });
}

// S23-9: Dealer WO quick-action button -- scroll to vendor section
function _wireDealerWOBtn(unit) {
  const btn = document.getElementById('dp-dealer-wo');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
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


      <!-- S23-9: Dealer WO Engine -->
      <div class="detail-panel__section">
        <h3>Dealer Work Order</h3>
        <div id="dp-vendor-section" class="dp-vendor-section">
          <p class="dp-empty">Loading eligibility check...</p>
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
  _wireVendorPanel(unit);
}

function close() {
  if (_panel) {
    _panel.classList.remove('detail-panel--open');
    setTimeout(() => {
      if (_panel) _panel.innerHTML = '';
      _unit = null;
      _teardownVendorBus();
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


// S23-12: Race-guarded handler for context-menu Dealer WO shortcut
let _pendingDealerWO = null; // { unit, attempts } | null

function _tryDealerWO(unit, attempts) {
  // Guard 1: stale request — user has switched to a different unit
  if (!_unit || (_unit.equipmentId !== unit.equipmentId && _unit.id !== unit.equipmentId)) {
    _pendingDealerWO = null;
    return;
  }
  // Guard 2: panel DOM not yet painted (sec created by _renderUnit sync, so this is very rare)
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) {
    if (attempts >= 12) { _pendingDealerWO = null; return; } // give up after ~200ms
    _pendingDealerWO = { unit, attempts: attempts + 1 };
    requestAnimationFrame(() => {
      if (_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts);
    });
    return;
  }
  // Guard 3: already investigating this unit — don't re-trigger
  if (sec.dataset.investigating === unit.equipmentId) {
    _pendingDealerWO = null;
    sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  _pendingDealerWO = null;
  sec.dataset.investigating = unit.equipmentId;
  _wireVendorPanel(unit);
  sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

bus.on('ui:dealer-wo-request', ({ unit }) => {
  _pendingDealerWO = { unit, attempts: 0 };
  // Use rAF so ui:unit-select's _renderUnit (synchronous) always runs first
  requestAnimationFrame(() => {
    if (_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts);
  });
});
