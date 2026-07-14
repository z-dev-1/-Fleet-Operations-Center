/**
 * dev-mock.js -- Browser mock for Electron IPC bridge
 * Injected in dev/Vite mode only. Stubs window.fleet, window.auth, etc.
 * with realistic fake data so the UI renders without Electron.
 *
 * SAFETY: This file must NEVER be imported in production builds.
 * It is not referenced in index.html, vite.config.js, or app.js.
 * Manual include only (e.g., <script src="dev-mock.js"> in dev HTML).
 */

// Hard guard: abort if running inside Electron (production)
if (typeof window !== 'undefined' && window.fleet && window.fleet.signalReady) {
  console.warn('[dev-mock] Electron detected — aborting mock injection');
} else {

const MOCK_ROWS = [
  { equipmentId: 'EQ-10021', bodyType: 'Box Truck',    lifecycleState: 'Available',      lifecycleReason: 'In Progress',   domicileSite: 'PDX1', operator: 'TUZR', openUnplanned: 2, openPlanned: 1, pmB: 'Aug 15', pmX: 'Jul 12',   dot: 'overdue',  quarterlyLift: 'Jul 8'   },
  { equipmentId: 'EQ-10034', bodyType: 'Pallet Jack',  lifecycleState: 'Maintenance',    lifecycleReason: 'Pending Parts', domicileSite: 'SEA3', operator: 'SAPB', openUnplanned: 0, openPlanned: 0, pmB: 'Jul 28', pmX: 'overdue',  dot: 'Sep 5',    quarterlyLift: '--'      },
  { equipmentId: 'EQ-10055', bodyType: 'Reach Truck',  lifecycleState: 'Unavailable',    lifecycleReason: 'Offsite Shop',  domicileSite: 'PDX1', operator: 'TUZR', openUnplanned: 4, openPlanned: 0, pmB: 'overdue',pmX: 'overdue',  dot: 'Jul 14',   quarterlyLift: 'Jul 22'  },
  { equipmentId: 'EQ-10062', bodyType: 'Order Picker', lifecycleState: 'Available',      lifecycleReason: 'Available',     domicileSite: 'SFO5', operator: 'PENO', openUnplanned: 1, openPlanned: 2, pmB: 'Sep 30', pmX: 'Sep 10',   dot: 'Sep 20',   quarterlyLift: 'Aug 1'   },
  { equipmentId: 'EQ-10078', bodyType: 'Forklift',     lifecycleState: 'Unavailable',    lifecycleReason: 'Pending Diag',  domicileSite: 'SEA3', operator: 'SAPB', openUnplanned: 0, openPlanned: 0, pmB: '--',     pmX: '--',       dot: '--',       quarterlyLift: '--'      },
  { equipmentId: 'EQ-10091', bodyType: 'Tugger',       lifecycleState: 'Available',      lifecycleReason: 'Available',     domicileSite: 'PDX1', operator: 'TUZR', openUnplanned: 0, openPlanned: 1, pmB: 'Jul 8',  pmX: 'Aug 3',    dot: 'Jul 19',   quarterlyLift: 'Aug 15'  },
  { equipmentId: 'EQ-10103', bodyType: 'Reach Truck',  lifecycleState: 'Maintenance',    lifecycleReason: 'In Progress',   domicileSite: 'SFO5', operator: 'PENO', openUnplanned: 1, openPlanned: 0, pmB: 'Sep 2',  pmX: 'Jul 5',    dot: 'Oct 8',    quarterlyLift: 'Jul 14'  },
  { equipmentId: 'EQ-10117', bodyType: 'Pallet Jack',  lifecycleState: 'Available',      lifecycleReason: 'Available',     domicileSite: 'PDX1', operator: 'AZNG', openUnplanned: 0, openPlanned: 0, pmB: 'Nov 5',  pmX: 'Oct 10',   dot: 'Oct 1',    quarterlyLift: 'Sep 15'  },
  { equipmentId: 'EQ-10129', bodyType: 'Forklift',     lifecycleState: 'Unavailable',    lifecycleReason: 'Offsite Shop',  domicileSite: 'SEA3', operator: 'SAPB', openUnplanned: 3, openPlanned: 1, pmB: 'Jul 3',  pmX: 'overdue',  dot: 'Jul 25',   quarterlyLift: 'overdue' },
  { equipmentId: 'EQ-10142', bodyType: 'Order Picker', lifecycleState: 'Available',      lifecycleReason: 'Available',     domicileSite: 'SFO5', operator: 'PENO', openUnplanned: 0, openPlanned: 0, pmB: 'Dec 10', pmX: 'Nov 20',   dot: 'Oct 20',   quarterlyLift: 'Sep 25'  },
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

console.log('[dev-mock] Electron IPC bridge mocked \u2014 browser dev mode active');

} // end else (Electron guard)
