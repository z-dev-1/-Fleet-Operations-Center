/**
 * dev-mock.js -- Browser mock for Electron IPC bridge
 * Injected in dev/Vite mode only. Stubs window.fleet, window.auth, etc.
 * with realistic fake data so the UI renders without Electron.
 */

const MOCK_ROWS = [
  { equipmentId: 'EQ-10021', assetType: 'Forklift',     lifecycleState: 'Available',      lifecycleReason: '',                  domicileSite: 'PDX1', operator: 'J. Rivera',   manufacturer: 'Toyota',  dueDate: '2026-07-15', openUnplanned: 2, geofence: 'PDX1-YARD-A' },
  { equipmentId: 'EQ-10034', assetType: 'Pallet Jack',  lifecycleState: 'Maintenance',    lifecycleReason: 'Scheduled PM',      domicileSite: 'SEA3', operator: 'K. Nguyen',   manufacturer: 'Crown',   dueDate: '2026-07-02', openUnplanned: 0, geofence: 'SEA3-DOCK-2' },
  { equipmentId: 'EQ-10055', assetType: 'Reach Truck',  lifecycleState: 'Unavailable',    lifecycleReason: 'Awaiting Parts',    domicileSite: 'PDX1', operator: 'M. Patel',    manufacturer: 'Raymond', dueDate: '2026-06-30', openUnplanned: 4, geofence: 'PDX1-SHOP'   },
  { equipmentId: 'EQ-10062', assetType: 'Order Picker', lifecycleState: 'Available',      lifecycleReason: '',                  domicileSite: 'SFO5', operator: 'T. Williams', manufacturer: 'Hyster',  dueDate: '2026-08-10', openUnplanned: 1, geofence: 'SFO5-FLOOR'  },
  { equipmentId: 'EQ-10078', assetType: 'Forklift',     lifecycleState: 'Decommissioned', lifecycleReason: 'End of Life',       domicileSite: 'SEA3', operator: '',            manufacturer: 'Toyota',  dueDate: '',           openUnplanned: 0, geofence: ''            },
  { equipmentId: 'EQ-10091', assetType: 'Tugger',       lifecycleState: 'Available',      lifecycleReason: '',                  domicileSite: 'PDX1', operator: 'A. Kim',      manufacturer: 'Cushman', dueDate: '2026-09-01', openUnplanned: 0, geofence: 'PDX1-YARD-B' },
  { equipmentId: 'EQ-10103', assetType: 'Reach Truck',  lifecycleState: 'Maintenance',    lifecycleReason: 'Battery Swap',      domicileSite: 'SFO5', operator: 'D. Torres',   manufacturer: 'Crown',   dueDate: '2026-07-20', openUnplanned: 1, geofence: 'SFO5-CHARGE' },
  { equipmentId: 'EQ-10117', assetType: 'Pallet Jack',  lifecycleState: 'Available',      lifecycleReason: '',                  domicileSite: 'PDX1', operator: 'S. Chen',     manufacturer: 'Raymond', dueDate: '2026-10-05', openUnplanned: 0, geofence: 'PDX1-FLOOR'  },
  { equipmentId: 'EQ-10129', assetType: 'Forklift',     lifecycleState: 'Unavailable',    lifecycleReason: 'Operator Incident', domicileSite: 'SEA3', operator: 'B. Johnson',  manufacturer: 'Hyster',  dueDate: '2026-07-08', openUnplanned: 3, geofence: 'SEA3-YARD'   },
  { equipmentId: 'EQ-10142', assetType: 'Order Picker', lifecycleState: 'Available',      lifecycleReason: '',                  domicileSite: 'SFO5', operator: 'L. Garcia',   manufacturer: 'Toyota',  dueDate: '2026-08-25', openUnplanned: 0, geofence: 'SFO5-FLOOR'  },
];

function noop() {}
function noopAsync() { return Promise.resolve(null); }

// ── window.fleet ─────────────────────────────────────────────────────────
window.fleet = {
  onData: (fn) => { window.__mockFleetCb = fn; setTimeout(() => fn({ rows: MOCK_ROWS, count: MOCK_ROWS.length, syncedAt: new Date().toISOString(), stale: false }), 800); },
  onStatus:    (fn) => setTimeout(() => fn('Synced (mock)'), 420),
  onError:     noop,
  signalReady: noop,
  requestSync: noopAsync,
  forceSync:   noopAsync,
  getVersion:  () => Promise.resolve('3.0.0-dev'),
};

// ── window.auth ───────────────────────────────────────────────────────────
window.auth = {
  onMwinitStatus: (fn) => setTimeout(() => fn({ ok: true, reason: 'mock' }), 200),
  runMwinit:      noopAsync,
  checkMidway:    () => Promise.resolve({ ok: true }),
};

// ── window.ai ─────────────────────────────────────────────────────────────
window.ai = {
  onProgress:           noop,
  onDailyNotesProgress: noop,
  suggest:              noopAsync,
  ask:                  noopAsync,
  chat:                 noopAsync,
  deepProcess:          noopAsync,
  recordCorrection:     noopAsync,
  suggestVendor:        noopAsync,
  getCorrections:       () => Promise.resolve([]),
  test:                 noopAsync,
  runDailyNotes:        noopAsync,
  getDailyNotesLog:     () => Promise.resolve([]),
};

// ── window.sp ─────────────────────────────────────────────────────────────
window.sp = {
  onProgress: noop,
  push:       noopAsync,
  getConfig:  () => Promise.resolve({}),
  saveConfig: noopAsync,
};

// ── window.settings ───────────────────────────────────────────────────────
window.settings = {
  getAll:         () => Promise.resolve({ theme: 'dark', density: 'normal', domiciles: ['PDX1','SEA3','SFO5'] }),
  save:           noopAsync,
  getDomiciles:   () => Promise.resolve(['PDX1','SEA3','SFO5']),
  saveDomiciles:  noopAsync,
  resetDomiciles: noopAsync,
  getOrchaConfig: () => Promise.resolve({}),
};

// ── window.notes ──────────────────────────────────────────────────────────
window.notes = {
  getUnit:    () => Promise.resolve(null),
  getAll:     () => Promise.resolve([]),
  saveUnit:   noopAsync,
  deleteUnit: noopAsync,
};

// ── window.aap ────────────────────────────────────────────────────────────
window.aap = {
  setLifecycle:      noopAsync,
  autofill:          noopAsync,
  runAdaptive:       noopAsync,
  adaptiveExtract:   noopAsync,
  adaptiveScanBatch: noopAsync,
  createWR:          noopAsync,
  onWRProgress:      noop,
  openUrl:           noop,
};

// ── window.slack ──────────────────────────────────────────────────────────
window.slack = {
  send:      noopAsync,
  checkAuth: () => Promise.resolve({ ok: false }),
  login:     noopAsync,
};

// ── window.email ──────────────────────────────────────────────────────────
window.email = {
  send:       noopAsync,
  getConfig:  () => Promise.resolve({}),
  saveConfig: noopAsync,
  preview:    noopAsync,
};

// ── window.geofence ───────────────────────────────────────────────────────
window.geofence = {
  scrape:   noopAsync,
  getCache: () => Promise.resolve([]),
};

// ── window.credentials ────────────────────────────────────────────────────
window.credentials = {
  set:    noopAsync,
  has:    () => Promise.resolve(false),
  delete: noopAsync,
  list:   () => Promise.resolve([]),
};

// ── window.files ──────────────────────────────────────────────────────────
window.files = {
  openUptakeScreenshot: noop,
  getLatestScreenshot:  () => Promise.resolve(null),
  readAsDataUrl:        () => Promise.resolve(null),
  openExternal:         noop,
  openRelayUrl:         noop,
};

// ── window.app ────────────────────────────────────────────────────────────
window.app = {
  windowAction:   noop,
  notify:         noop,
  platform:       'browser-mock',
  onNavigateUnit: noop,
};

// ── window.asana ──────────────────────────────────────────────────────────
window.asana = {
  checkAuth:      () => Promise.resolve({ ok: false }),
  getConfig:      () => Promise.resolve({}),
  saveConfig:     noopAsync,
  getMe:          noopAsync,
  getWorkspaces:  () => Promise.resolve([]),
  getProjects:    () => Promise.resolve([]),
  getSections:    () => Promise.resolve([]),
  getTasks:       () => Promise.resolve([]),
  getTask:        noopAsync,
  getTaskStories: () => Promise.resolve([]),
  searchTasks:    () => Promise.resolve([]),
  createTask:     noopAsync,
  updateTask:     noopAsync,
  addComment:     noopAsync,
  moveTask:       noopAsync,
  linkUnit:       noopAsync,
};

// ── window.partner ────────────────────────────────────────────────────────
window.partner = {
  getQR:        () => Promise.resolve(null),
  getQueue:     () => Promise.resolve([]),
  updateJob:    noopAsync,
  onNewRequest: noop,
};

console.log('[dev-mock] Electron IPC bridge mocked — browser dev mode active');
