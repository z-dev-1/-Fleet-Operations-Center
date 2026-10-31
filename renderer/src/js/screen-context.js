/**
 * screen-context.js -- publishes "what Z is looking at" to the main process
 *
 * Main window only (NOT imported by bubble-fab.html). Tracks the current
 * view, open unit, unit-detail tab, toolbar filters, quick filter and search
 * from bus events, and sends a small payload through
 * assistant.setScreenContext (debounced 300 ms). A 60 s heartbeat re-sends the
 * payload while the window is visible so main knows the context is fresh.
 * The main-side holder (src/orcha/awareness/screen-context.js) validates it
 * and keeps it in memory only.
 */

import bus from './bus.js';
import { assistant } from './bridge.js';

var DEBOUNCE_MS  = 300;
var HEARTBEAT_MS = 60 * 1000;

var _state = {
  view: null,
  unitId: null,
  tab: null,
  wrId: null,
  secondaryWrCount: 0,
  filters: {},
  quickFilter: null,
  search: null,
};
var _lastTabEvent = null;
var _timer = null;
var _heartbeat = null;
var _inited = false;

function _str(v, max) {
  if (v == null || v === '') return null;
  return String(v).slice(0, max);
}

/**
 * Pure: build the IPC payload from a state object. Strings are clipped to the
 * main-side limits so a long search box value can't make the whole payload
 * fail validation.
 */
export function buildPayload(s) {
  s = s || {};
  var filters = {};
  var src = s.filters || {};
  Object.keys(src).forEach(function (k) {
    if (src[k] != null && src[k] !== '') filters[k] = String(src[k]);
  });
  return {
    view: _str(s.view, 32),
    unitId: _str(s.unitId, 32),
    tab: s.tab || null,
    wrId: _str(s.wrId, 64),
    secondaryWrCount: s.secondaryWrCount || 0,
    filters: filters,
    quickFilter: _str(s.quickFilter, 32),
    search: _str(s.search, 80),
  };
}

function _sendNow() {
  _timer = null;
  try {
    var p = assistant.setScreenContext(buildPayload(_state));
    if (p && typeof p.catch === 'function') p.catch(function () {});
  } catch (_) { /* bridge missing -- ignore */ }
}

function _schedule() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_sendNow, DEBOUNCE_MS);
}

function _onUnitSelect(p) {
  p = p || {};
  var u = p.unit;
  var id = typeof u === 'string' ? u : (u && u.equipmentId);
  _state.unitId = id || null;
  if (u && typeof u === 'object') {
    _state.wrId = u.workRequestId || null;
    _state.secondaryWrCount = Array.isArray(u._secondaryWRs) ? u._secondaryWRs.length : 0;
  } else {
    _state.wrId = null;
    _state.secondaryWrCount = 0;
  }
  _state.tab = p.tab || (_lastTabEvent && _lastTabEvent.unitId === id ? _lastTabEvent.tab : null);
  _schedule();
}

function _onUnitDeselect() {
  _state.unitId = null;
  _state.tab = null;
  _state.wrId = null;
  _state.secondaryWrCount = 0;
  _schedule();
}

function _onTabChange(p) {
  p = p || {};
  _lastTabEvent = { unitId: p.unitId || null, tab: p.tab || null };
  if (_state.unitId == null && p.unitId) _state.unitId = p.unitId;
  if (p.unitId === _state.unitId) {
    _state.tab = p.tab || null;
    _schedule();
  }
}

function _onFilterChange(p) {
  if (!p || !p.field) return;
  if (p.value == null || p.value === '') delete _state.filters[p.field];
  else _state.filters[p.field] = p.value;
  _schedule();
}

/** Call once from app.js boot (main window only). */
export function init() {
  if (_inited) return;
  _inited = true;

  bus.on('ui:view-change', function (p) { _state.view = (p && p.to) || null; _schedule(); });
  bus.on('ui:unit-select', _onUnitSelect);
  bus.on('ui:unit-deselect', _onUnitDeselect);
  bus.on('ui:unit-tab-change', _onTabChange);
  bus.on('ui:filter-change', _onFilterChange);
  bus.on('ui:quick-filter', function (p) { _state.quickFilter = (p && p.filter) || null; _schedule(); });
  bus.on('ui:search', function (p) { _state.search = (p && p.query) || null; _schedule(); });

  _heartbeat = setInterval(function () {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') _sendNow();
  }, HEARTBEAT_MS);
}
