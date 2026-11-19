/**
 * dbr-view.js — first-class "📊 DBR" tab. Hosts the Fleet DBR controller
 * (fleet-dbr-panel.js, view mode) inside #view-dbr instead of a body modal.
 *
 * On every open the controller compares the fleet sync time with the cached
 * build's fleetSyncedAt and auto-runs fleet-dbr:build when fleet data is newer;
 * otherwise the cached build is shown. Leaving the tab closes the controller
 * (pending edits are flushed, same as closing the old modal).
 */
import bus from '../bus.js';
import state from '../state.js';
import { openFleetDbrView } from './fleet-dbr-panel.js';

let _el = null;
let _host = null;
let _ctl = null;
let _opening = null;

function _fleetSyncedAt() {
  const f = state.slice('fleet') || {};
  return f.lastSuccessfulSyncAt || f.syncedAt || null;
}

function _viewHtml() {
  return `
    <div class="an-header">
      <div class="an-header__left">
        <span class="an-title">DBR \u2014 Daily Business Review</span>
        <span class="an-subtitle">Built from your live fleet data; rebuilds automatically when fleet data is newer.</span>
      </div>
      <div class="an-header__actions">
        <button id="dbr-back" class="detail-panel__btn">Back to Fleet</button>
      </div>
    </div>
    <div id="dbr-view-host" style="display:flex;flex-direction:column;flex:1 1 auto;min-height:0;"></div>
  `;
}

export function init(container, deps = {}) {
  const openView = deps.openView || openFleetDbrView;
  _el = document.createElement('div');
  _el.id = 'view-dbr';
  _el.className = 'view view--dbr';
  _el.style.display = 'none';
  _el.innerHTML = _viewHtml();
  container.appendChild(_el);
  _host = _el.querySelector('#dbr-view-host');

  _el.querySelector('#dbr-back').addEventListener('click', () => {
    bus.emit('ui:view-change', { from: 'dbr', to: 'fleet' });
  });

  bus.on('ui:view-change', async ({ to } = {}) => {
    if (to === 'settings') return; // Settings is an overlay, not a view
    if (to === 'dbr') {
      _el.style.display = 'flex';
      if (_ctl || _opening) return;
      _opening = Promise.resolve(openView(_host, { getFleetSyncedAt: _fleetSyncedAt }));
      try { _ctl = await _opening; } catch (err) { console.warn('[dbr-view] open failed', err); _ctl = null; }
      _opening = null;
      // Left the tab while the controller was being created.
      if (_ctl && _el.style.display === 'none') { _close(); }
      return;
    }
    _el.style.display = 'none';
    _close();
  });

  return _el;
}

function _close() {
  const c = _ctl;
  _ctl = null;
  if (c && typeof c.close === 'function') { try { c.close(); } catch (_) { /* already closed */ } }
}

export const __test__ = {
  get el() { return _el; },
  get host() { return _host; },
  get controller() { return _ctl; },
  fleetSyncedAt: _fleetSyncedAt,
};
