/**
 * intelligence-panel.js — Orcha Intelligence Panel (Sprint 1 UI)
 *
 * Slide-down panel below the toolbar showing:
 *   - Alert summary badges (critical/warning/info)
 *   - Top alerts with dismiss capability
 *   - Action recommendations with one-click triggers
 *   - Collapsible sections
 *
 * Toggled via toolbar "🧠" button or bus event.
 * Auto-updates on orcha:alerts and orcha:recommendations bus events.
 */

import bus   from '../bus.js';
import state from '../state.js';
import { ai } from '../bridge.js';

let _el      = null;
let _open    = false;
let _alerts  = [];
let _recs    = [];
let _alertCounts = { critical: 0, warning: 0, info: 0 };
let _recSummary  = { total: 0 };

const _esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── Render ──────────────────────────────────────────────────────────────────
function _render() {
  if (!_el) return;
  const totalAlerts = _alerts.length;
  const totalRecs   = _recs.length;

  _el.innerHTML = `
    <div class="ip-panel${_open ? ' ip-panel--open' : ' ip-panel--hidden'}">
      <div class="ip-header" id="ip-toggle">
        <div class="ip-header__left">
          <span class="ip-header__icon">🧠</span>
          <span class="ip-header__title">Orcha Intelligence</span>
          <span class="ip-header__summary">
            ${_alertCounts.critical > 0 ? '<span class="ip-badge ip-badge--crit">' + _alertCounts.critical + ' critical</span>' : ''}
            ${_alertCounts.warning > 0 ? '<span class="ip-badge ip-badge--warn">' + _alertCounts.warning + ' warnings</span>' : ''}
            ${_alertCounts.info > 0 ? '<span class="ip-badge ip-badge--info">' + _alertCounts.info + ' info</span>' : ''}
            ${totalRecs > 0 ? '<span class="ip-badge ip-badge--rec">' + totalRecs + ' actions</span>' : ''}
            ${totalAlerts === 0 && totalRecs === 0 ? '<span class="ip-badge ip-badge--ok">All clear</span>' : ''}
          </span>
        </div>
        <div class="ip-header__right">
          <span class="ip-chevron${_open ? ' ip-chevron--open' : ''}">▾</span>
        </div>
      </div>

      ${_open ? `
      <div class="ip-body">
        <div class="ip-cols">

          <!-- Alerts Column -->
          <div class="ip-col">
            <div class="ip-col-title">
              <span>Alerts</span>
              <span class="ip-col-count">${totalAlerts}</span>
            </div>
            <div class="ip-col-scroll">
              ${totalAlerts === 0
                ? '<div class="ip-empty">No alerts — fleet data is healthy</div>'
                : _alerts.slice(0, 15).map(_renderAlert).join('')
              }
            </div>
          </div>

          <!-- Recommendations Column -->
          <div class="ip-col">
            <div class="ip-col-title">
              <span>Recommended Actions</span>
              <span class="ip-col-count">${totalRecs}</span>
            </div>
            <div class="ip-col-scroll">
              ${totalRecs === 0
                ? '<div class="ip-empty">No actions needed — fleet is on track</div>'
                : _recs.slice(0, 15).map(_renderRec).join('')
              }
            </div>
          </div>

        </div>
      </div>
      ` : ''}
    </div>
  `;

  _wireEvents();
}

function _renderAlert(alert) {
  const sevIcon = alert.severity === 'critical' ? '🔴'
                : alert.severity === 'warning'  ? '⚠️'
                : 'i️';
  const sevCls = 'ip-alert--' + alert.severity;
  return `
    <div class="ip-alert ${sevCls}" data-alert-id="${_esc(alert.id)}">
      <div class="ip-alert__header">
        <span class="ip-alert__sev">${sevIcon}</span>
        <span class="ip-alert__unit">${_esc(alert.unit)}</span>
        <span class="ip-alert__op">${_esc(alert.operator)}</span>
        <button class="ip-alert__dismiss" data-dismiss="${_esc(alert.id)}" title="Dismiss">✕</button>
      </div>
      <div class="ip-alert__msg">${_esc(alert.message)}</div>
      <div class="ip-alert__suggest">${_esc(alert.suggestion)}</div>
    </div>
  `;
}

function _renderRec(rec) {
  const meta = rec.meta || {};
  return `
    <div class="ip-rec" data-unit="${_esc(rec.unit)}">
      <div class="ip-rec__header">
        <span class="ip-rec__icon">${meta.icon || '💡'}</span>
        <span class="ip-rec__action">${_esc(meta.label || rec.action)}</span>
        <span class="ip-rec__conf">${rec.confidence}%</span>
      </div>
      <div class="ip-rec__unit">${_esc(rec.unit)} <span class="ip-rec__op">${_esc(rec.operator)} · ${_esc(rec.domicile)}</span></div>
      <div class="ip-rec__reason">${_esc(rec.reason)}</div>
      <div class="ip-rec__footer">
        <span class="ip-rec__suggest">${_esc(rec.suggestion)}</span>
        <button class="ip-rec__exec" data-unit="${_esc(rec.unit)}" data-action="${_esc(rec.action)}" data-payload='${_esc(JSON.stringify(rec.payload || {}))}' title="Execute via Orchestrator">\u26A1</button>
        <button class="ip-rec__go" data-unit="${_esc(rec.unit)}" data-action="${_esc(rec.action)}">\u2192 Go</button>
      </div>
    </div>
  `;
}

// ── Wire Events ─────────────────────────────────────────────────────────────
function _wireEvents() {
  // Toggle panel
  const toggle = document.getElementById('ip-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      _open = !_open;
      _render();
    });
  }

  // Dismiss alerts
  _el.querySelectorAll('.ip-alert__dismiss').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const alertId = btn.dataset.dismiss;
      if (!alertId) return;
      // Remove from local list
      _alerts = _alerts.filter(a => a.id !== alertId);
      _alertCounts = _countAlerts(_alerts);
      // Persist dismiss to backend
      if (ai.dismissAlert) ai.dismissAlert(alertId).catch(() => {});
      _render();
    });
  });

  // Recommendation "Execute" buttons — run through Orchestrator
  _el.querySelectorAll('.ip-rec__exec').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action  = btn.dataset.action;
      const unitId  = btn.dataset.unit;
      let payload = {};
      try { payload = JSON.parse(btn.dataset.payload || '{}'); } catch (_) {}

      btn.disabled = true;
      btn.textContent = '...';

      try {
        const result = await ai.execute({
          type:   action,
          unitId: unitId,
          unit:   unitId,
          data:   payload,
        });

        if (result && result.success) {
          btn.textContent = '✓';
          btn.classList.add('ip-rec__exec--done');
          bus.emit('ui:toast', { type: 'success', message: `${action} executed for ${unitId}`, duration: 3000 });
        } else if (result && result.blocked) {
          btn.textContent = '✕';
          bus.emit('ui:toast', { type: 'warning', message: result.message || 'Blocked by safety checks', duration: 4000 });
        } else {
          btn.textContent = '⚡';
          bus.emit('ui:toast', { type: 'info', message: result && result.errors ? result.errors[0] : 'Action recorded', duration: 3000 });
        }
      } catch (err) {
        btn.textContent = '⚡';
        bus.emit('ui:toast', { type: 'error', message: 'Execution error: ' + (err.message || 'unknown'), duration: 3000 });
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Recommendation "Go" buttons — navigate to unit
  _el.querySelectorAll('.ip-rec__go').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const unitId = btn.dataset.unit;
      if (unitId) {
        bus.emit('navigate:unit', unitId);
        bus.emit('ui:view-change', { from: 'current', to: 'fleet' });
      }
    });
  });

  // Click on rec card — navigate to unit
  _el.querySelectorAll('.ip-rec').forEach(card => {
    card.addEventListener('click', () => {
      const unitId = card.dataset.unit;
      if (unitId) bus.emit('navigate:unit', unitId);
    });
  });
}

function _countAlerts(alerts) {
  const counts = { critical: 0, warning: 0, info: 0 };
  alerts.forEach(a => counts[a.severity]++);
  return counts;
}

// ── Init ────────────────────────────────────────────────────────────────────
export function init() {
  _el = document.createElement('div');
  _el.id = 'intelligence-panel-mount';
  _el.className = 'ip-mount';

  // Insert after toolbar, before body-area
  const bodyArea = document.getElementById('body-area');
  if (bodyArea && bodyArea.parentNode) {
    bodyArea.parentNode.insertBefore(_el, bodyArea);
  } else {
    document.getElementById('app-shell').appendChild(_el);
  }

  _render();

  // Listen for alert updates
  bus.on('orcha:alerts', (data) => {
    _alerts = (data && data.alerts) || [];
    _alertCounts = (data && data.counts) || _countAlerts(_alerts);
    _render();
  });

  // Listen for recommendation updates
  bus.on('orcha:recommendations', (data) => {
    _recs = (data && data.recommendations) || [];
    _recSummary = (data && data.summary) || { total: _recs.length };
    _render();
  });

  // External toggle (toolbar button)
  bus.on('ui:toggle-intelligence', () => {
    _open = !_open;
    _render();
  });
}
