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
 *   vendor   -- active workflows, lastComplete, lastError
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
  vendor: {
    active:       {},   // workflowId -> live workflow entry
    lastComplete: null, // { workflowId, vendor, unit, caseNumber, caseUrl, altId, serviceUrl, ts }
    lastError:    null, // { workflowId, vendor, unit, error, code, ts }
    history:      {},  // equipmentId -> [{ workflowId, vendor, outcome, caseNumber, caseUrl, error, ts }] max 10
  },
  // S28-Sprint1: Orcha monitor intelligence results
  monitor: {
    results: [],   // per-unit health scores
    summary: null, // fleet-wide summary
  },
  // S28-Sprint1: Orcha anomaly alerts
  alerts: {
    alerts: [],    // active alert objects
    counts: { critical: 0, warning: 0, info: 0 },
  },
  // S28-Sprint1: Orcha action recommendations
  recommendations: {
    recommendations: [],
    summary: { total: 0, byAction: {}, byUrgency: {} },
  },
  // S28-Sprint2: Workflow progress tracker
  tracker: {
    tracked: [],
    stuck: [],
    summary: { total: 0, stuck: 0, stageCounts: {}, avgProgress: 0 },
  },
  // S28-Sprint3: System health
  health: {},
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
