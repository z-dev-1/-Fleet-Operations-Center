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
window.fleet=(function(){var _d=null,_s=null,_e=null;function run(){var now=new Date().toISOString();var a=MOCK_ROWS.slice(0,7);setTimeout(function(){if(_s)_s("\uD83D\uDD04 Reading AAP inventory...");},300);setTimeout(function(){if(_s)_s("AAP: 7 units loaded \u2014 syncing Uptake...");if(_d)_d({rows:a,count:a.length,aapScrapedAt:now,uptakeScrapedAt:null,uptakeCount:0,relayCount:0,syncedAt:now,stale:false,partial:"aap"});},700);setTimeout(function(){if(_s)_s("\u26A1 Syncing Uptake + Relay in parallel...");},950);var R=[72,85,34,61,0,20,48];var ur=MOCK_ROWS.slice(0,7).map(function(r,i){return Object.assign({},r,{riskScore:R[i]||0});});setTimeout(function(){if(_s)_s("\uD83D\uDD0D Uptake: 7 units enriched \u2014 Relay finishing...");if(_d)_d({rows:ur,count:ur.length,aapScrapedAt:now,uptakeScrapedAt:now,uptakeCount:7,relayCount:0,syncedAt:now,stale:false,partial:"uptake"});},1600);var b1=MOCK_ROWS.slice(0,4).map(function(r){return Object.assign({},r,{relayStatus:"In Progress",durationMs:259200000});}).concat(MOCK_ROWS.slice(4,7));setTimeout(function(){if(_s)_s("\uD83D\uDD27 Relay: 4 units detailed (batch 1)...");if(_d)_d({rows:b1,count:b1.length,aapScrapedAt:now,uptakeScrapedAt:now,uptakeCount:7,relayCount:4,syncedAt:now,stale:false,partial:"relay-batch-1"});},2400);var RL=["In Progress","Pending Parts","Available","Offsite Shop","Pending Diag","In Progress","Available","Pending Parts","Offsite Shop","Available"];var RK=[72,85,34,61,0,20,48,55,90,15];var DU=[259200000,604800000,0,172800000,0,0,86400000,345600000,777600000,0];var fr=MOCK_ROWS.map(function(r,i){return Object.assign({},r,{relayStatus:RL[i]||"Available",riskScore:RK[i]||0,durationMs:DU[i]||0,lifecycleState:(i===2||i===8)?"Unavailable":r.lifecycleState});});setTimeout(function(){var t=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});if(_s)_s("\u2705 Live \u00B7 10 units \u00B7 7 Uptake \u00B7 10 Relay \u00B7 "+t);if(_d)_d({rows:fr,count:fr.length,aapScrapedAt:now,uptakeScrapedAt:now,uptakeCount:7,relayCount:10,syncedAt:now,stale:false});},3200);}return{onData:function(fn){_d=fn;},onStatus:function(fn){_s=fn;},onError:function(fn){_e=fn;},onAuthFailure:noop,signalReady:function(){run();},requestSync:function(){run();return Promise.resolve();},forceSync:function(){run();return Promise.resolve();},getVersion:function(){return Promise.resolve("3.0.0-dev");}};})();

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
