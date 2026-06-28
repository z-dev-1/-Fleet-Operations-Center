/**
 * state.js -- Reactive application state store
 *
 * Single source of truth for all renderer state.
 * Mutations go through update(); views subscribe via bus events.
 *
 * Shape:
 *   fleet    -- raw fleet data from IPC
 *   ui       -- view state, selected unit, filters, search
 *   sync     -- sync status / in-progress flags
 *   auth     -- midway ok/reason
 *   settings -- domiciles, orcha config (loaded on demand)
 */

import bus from './bus.js';

const _state = {
  fleet: {
    rows:     [],
    count:    0,
    syncedAt: null,
    stale:    false,
  },
  ui: {
    view:         'fleet',  // 'fleet' | 'unit' | 'settings'
    selectedUnit: null,
    filter:       {},       // { field: value }
    search:       '',
    loading:      false,
    sidebarOpen:  false,
  },
  sync: {
    inProgress:   false,
    lastStatus:   '',
    lastError:    null,
    orcaProgress: {},       // unitId -> { step, message }
    spProgress:   {},
    dnProgress:   {},
  },
  auth: {
    midwayOk:     null,
    midwayReason: '',
  },
  settings: null,  // loaded lazily
};

function _deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

const state = {
  /** Read current state (frozen snapshot). */
  get() {
    return _deepClone(_state);
  },

  /**
   * Partial update -- merges patch into the named top-level slice.
   * Emits 'state:<slice>' on bus.
   *
   *   state.update('fleet', { rows: [...], count: 42 })
   *   state.update('ui',    { view: 'unit', selectedUnit: unit })
   */
  update(slice, patch) {
    if (!Object.prototype.hasOwnProperty.call(_state, slice)) {
      console.warn('[state] unknown slice:', slice);
      return;
    }
    Object.assign(_state[slice], patch);
    bus.emit('state:' + slice, _deepClone(_state[slice]));
  },

  /** Get a single slice snapshot. */
  slice(name) {
    return _deepClone(_state[name] || {});
  },
};

export default state;
