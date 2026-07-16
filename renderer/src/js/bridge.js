/**
 * bridge.js -- Typed wrappers around all window.* IPC namespaces
 *
 * This is the ONLY file that touches window.fleet, window.ai, etc.
 * All other modules import from here, keeping the bridge seam clean.
 *
 * Two jobs:
 *   1. init() -- attach IPC push-listeners, forward onto bus + state
 *   2. Export async fns that invoke IPC calls and return results
 */

import bus   from './bus.js';
import { init as initVendorBridge } from './vendor-bridge.js';
import state from './state.js';

// ── IPC listener wiring ────────────────────────────────────────────────────

/** Call once at app startup. Attaches all push-listener subscriptions. */
export function init() {
  // Fleet data pushed from main process
  window.fleet.onData((data) => {
    state.update('fleet', {
      rows:     data.rows  || [],
      count:    data.count || 0,
      syncedAt: data.syncedAt || null,
      stale:    !!data.stale,
    });
    state.update('sync', { inProgress: false });
    bus.emit('fleet:data', data);
  });

  window.fleet.onStatus((msg) => {
    state.update('sync', { lastStatus: msg, lastError: null });
    bus.emit('fleet:status', msg);
  });

  window.fleet.onError((err) => {
    state.update('sync', { lastError: err });
    bus.emit('fleet:error', err);
  });

  // S7: structured auth-failure — session-expiry codes (RELAY_SESSION_INVALID /
  // MIDWAY_SESSION_INVALID) arrive here for session-expiry handling
  if (window.fleet.onAuthFailure) {
    window.fleet.onAuthFailure((payload) => {
      bus.emit('fleet:auth-failure', payload);
    });
  }

  // Orcha AI progress
  window.ai.onProgress((p) => {
    const prog = state.slice('sync').orcaProgress;
    prog[p.unitId] = { step: p.step, message: p.message };
    state.update('sync', { orcaProgress: prog });
    bus.emit('orcha:progress', p);
  });

  // Daily notes progress
  window.ai.onDailyNotesProgress((p) => {
    const prog = state.slice('sync').dnProgress;
    prog[p.unitId] = { step: p.step, message: p.message };
    state.update('sync', { dnProgress: prog });
    bus.emit('daily-notes:progress', p);
  });

  // SharePoint progress
  window.sp.onProgress((p) => {
    const prog = state.slice('sync').spProgress;
    prog[p.unitId] = { step: p.step, message: p.message };
    state.update('sync', { spProgress: prog });
    bus.emit('sp:progress', p);
  });

  // Auth status pushed from main process
  window.auth.onMwinitStatus((s) => {
    state.update('auth', { midwayOk: s.ok, midwayReason: s.reason || '' });
    bus.emit('auth:mwinit-status', s);
  });

  // Deep-link navigation from tray / bubble
  window.app.onNavigateUnit((unitId) => {
    bus.emit('navigate:unit', unitId);
  });


  // S28: Auto-email trigger from scheduler — fires email compose flow
  if (window.fleet.onAutoEmail) {
    window.fleet.onAutoEmail((payload) => {
      bus.emit('fleet:auto-email', payload);
    });
  }

  // S28-Sprint1: Orcha monitor results — unit health scores
  if (window.fleet.onMonitor) {
    window.fleet.onMonitor((results) => {
      state.update('monitor', results);
      bus.emit('orcha:monitor', results);
    });
  }

  // S28-Sprint1: Orcha anomaly alerts
  if (window.fleet.onAlerts) {
    window.fleet.onAlerts((alertData) => {
      state.update('alerts', alertData);
      bus.emit('orcha:alerts', alertData);
    });
  }

  // S28-Sprint1: Orcha action recommendations
  if (window.fleet.onRecommendations) {
    window.fleet.onRecommendations((recData) => {
      state.update('recommendations', recData);
      bus.emit('orcha:recommendations', recData);
    });
  }

  // S28-Sprint2: Workflow tracker
  if (window.fleet.onTracker) {
    window.fleet.onTracker((trackerData) => {
      state.update('tracker', trackerData);
      bus.emit('orcha:tracker', trackerData);
    });
  }

  // S28-Sprint2: Auto-prepared drafts
  if (window.fleet.onDrafts) {
    window.fleet.onDrafts((draftData) => {
      bus.emit('orcha:drafts', draftData);
    });
  }

  // S28-Sprint3: System health
  if (window.fleet.onHealth) {
    window.fleet.onHealth((healthData) => {
      state.update('health', healthData);
      bus.emit('orcha:health', healthData);
    });
  }

  // Notes updated (from AI timeline add)
  if (window.fleet.onNotesUpdated) {
    window.fleet.onNotesUpdated((data) => {
      bus.emit('notes:updated', data);
    });
  }

  // WR created from AI chat
  if (window.fleet.onWrCreated) {
    window.fleet.onWrCreated((data) => {
      bus.emit('wr:created', data);
    });
  }

  // Pins updated
  if (window.fleet.onPinsUpdated) {
    window.fleet.onPinsUpdated((pins) => {
      state.update('ui', { pins: pins });
      bus.emit('pins:updated', pins);
    });
  }

  // Email compose from AI
  if (window.fleet.onEmailCompose) {
    window.fleet.onEmailCompose((data) => {
      bus.emit('email:compose', data);
    });
  }

  // Fleet refresh
  if (window.fleet.onFleetRefresh) {
    window.fleet.onFleetRefresh(() => {
      bus.emit('fleet:refresh');
    });
  }



  // S23-8: attach vendor push listeners
  initVendorBridge();

  // ── Global unhandled promise rejection → error toast ───────────────────────
  // Catches any IPC call that throws without a local try/catch.
  window.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason && event.reason.message
      ? event.reason.message
      : String(event.reason || 'Unknown error');
    // Skip noise (ResizeObserver, benign cancellations)
    if (msg.includes('ResizeObserver') || msg.includes('aborted') || msg.includes('cancel')) return;
    console.error('[bridge] Unhandled rejection:', msg);
    bus.emit('ui:toast', { type: 'error', message: msg.slice(0, 120), duration: 4000 });
  });

  // ── Operator derivation: extract operators + domiciles from fleet rows ──
  // Handles 'sp:sync-request' from settings OR auto-fires when fleet data arrives
  function _deriveOperators() {
    const fleetSlice = state.slice('fleet');
    const rows = fleetSlice.rows || [];
    if (!rows.length) return;

    const map = {};
    rows.forEach((r) => {
      const op  = r.operator || r.operatorCode || '';
      const dom = r.domicile || r.domicileCode || r.domicileSite || '';
      if (!op) return;
      if (!map[op]) map[op] = new Set();
      if (dom) map[op].add(dom);
    });

    const operators = Object.keys(map).sort().map((name) => ({
      name,
      domiciles: [...map[name]].sort().map((code) => ({ code })),
    }));

    bus.emit('state:operators', operators);
  }

  bus.on('sp:sync-request', _deriveOperators);
  bus.on('fleet:data', _deriveOperators);

  // Signal renderer ready -- triggers cached-data push from main
  window.fleet.signalReady();


  // Expose bus globally for any components that need event access without import
  window.__fleet_bus = bus;
}

// ── Fleet ──────────────────────────────────────────────────────────────────
export const fleet = {
  requestSync: ()  => window.fleet.requestSync(),
  forceSync:   ()  => window.fleet.forceSync(),
  getVersion:  ()  => window.fleet.getVersion(),
};

// ── Settings ───────────────────────────────────────────────────────────────
export const settings = {
  getAll:         ()       => window.settings.getAll(),
  save:           (k, v)   => window.settings.save(k, v),
  getDomiciles:   ()       => window.settings.getDomiciles(),
  saveDomiciles:  (d)      => window.settings.saveDomiciles(d),
  resetDomiciles: ()       => window.settings.resetDomiciles(),
  getOrchaConfig:    ()       => window.settings.getOrchaConfig(),
  getScheduleSlots:  ()       => window.settings.getScheduleSlots(),
  saveScheduleSlots: (slots)  => window.settings.saveScheduleSlots(slots),
  getSyncInterval:    ()      => window.settings.getSyncInterval(),
  saveSyncInterval:   (m)     => window.settings.saveSyncInterval(m),
};

// ── Notes ──────────────────────────────────────────────────────────────────
export const notes = {
  getUnit:    (id)   => window.notes.getUnit(id),
  getAll:     ()     => window.notes.getAll(),
  saveUnit:   (data) => window.notes.saveUnit(data),
  deleteUnit: (id)   => window.notes.deleteUnit(id),
};

// ── AI / Orcha ─────────────────────────────────────────────────────────────
export const ai = {
  suggest:          (unit)       => window.ai.suggest(unit),
  ask:              (prompt)     => window.ai.ask(prompt),
  chat:             (prompt)     => window.ai.chat(prompt),
  deepProcess:      (unitIds)    => window.ai.deepProcess(unitIds),
  recordCorrection: (data)       => window.ai.recordCorrection(data),
  suggestVendor:    (unit)       => window.ai.suggestVendor(unit),
  getCorrections:   (field, lim) => window.ai.getCorrections(field, lim),
  test:             ()           => window.ai.test(),
  runDailyNotes:    (units)      => window.ai.runDailyNotes(units),
  getDailyNotesLog: ()           => window.ai.getDailyNotesLog(),
  // S28-Sprint1: dismiss anomaly alert
  dismissAlert:     (alertId)    => window.ai.dismissAlert(alertId),
  // S28-Sprint3: Orchestrator execution
  execute:          (intent)     => window.ai.execute(intent),
  getExecutionLog:  ()           => window.ai.getExecutionLog(),
  exportExcel:      (data)       => window.ai.exportExcel(data),
  inferRCA:         (text, ctx)  => window.ai.inferRCA(text, ctx),
};



// ── AAP ────────────────────────────────────────────────────────────────────
export const aap = {
  setLifecycle:      (id, url, st, reason) => window.aap.setLifecycle(id, url, st, reason),
  autofill:          (url, payload)        => window.aap.autofill(url, payload),
  runAdaptive:       (payload)             => window.aap.runAdaptive(payload),
  adaptiveExtract:   (opts)                => window.aap.adaptiveExtract(opts),
  adaptiveScanBatch: (units)               => window.aap.adaptiveScanBatch(units),
  createWR:          (payload, unit)       => window.aap.createWR(payload, unit),
  onWRProgress:      (cb)                  => window.aap.onWRProgress(cb),
  openUrl:           (url)                 => window.aap.openUrl(url),
};

// ── Slack ──────────────────────────────────────────────────────────────────
export const slack = {
  send:         (data) => window.slack.send(data),
  checkAuth:    ()     => window.slack.checkAuth(),
  login:        ()     => window.slack.login(),
  read:         (data) => window.slack.read(data),
  readDMs:      ()     => window.slack.readDMs(),
  getChannels:  ()     => window.slack.getChannels(),
  checkLiveAuth: ()    => window.slack.checkLiveAuth(),
  logout:        ()    => window.slack.logout(),
  sendToChannel: (data) => window.slack.sendToChannel(data),
  searchDirectory: (data) => window.slack.searchDirectory(data),
  openConversation: (data) => window.slack.openConversation(data),
  onIncoming:   (cb)   => window.slack.onIncoming(cb),
};

// ── SharePoint ─────────────────────────────────────────────────────────────
export const sp = {
  push:           (units)   => window.sp.push(units),
  pushDomicile:   (payload) => window.sp.pushDomicile(payload),
  onProgress:     (cb)      => window.sp.onProgress(cb),
  getConfig:      ()        => window.sp.getConfig(),
  saveConfig:     (data)    => window.sp.saveConfig(data),
  getLists:       (siteUrl) => window.sp.getLists(siteUrl),
  discoverSheets: (url)     => window.sp.discoverSheets(url),
};

// ── Auth ───────────────────────────────────────────────────────────────────
export const auth = {
  runMwinit:   () => window.auth.runMwinit(),
  checkMidway: () => window.auth.checkMidway(),
};

// ── Email ──────────────────────────────────────────────────────────────────
export const email = {
  send:         (opts)    => window.email.send(opts),
  getConfig:    ()        => window.email.getConfig(),
  saveConfig:   (config)  => window.email.saveConfig(config),
  preview:      (opts)    => window.email.preview(opts),
  compose:      (payload) => window.email.compose(payload),
  saveOpEmails: (data)    => window.email.saveOpEmails(data),
  loadOpEmails: ()        => window.email.loadOpEmails(),
  getTestMode:  ()        => window.email.getTestMode(),
  setTestMode:  (enabled) => window.email.setTestMode(enabled),
};

// ── Geofence ───────────────────────────────────────────────────────────────
export const geofence = {
  scrape:   () => window.geofence.scrape(),
  getCache: () => window.geofence.getCache(),
};

// ── Credentials ────────────────────────────────────────────────────────────
export const credentials = {
  set:    (key, val) => window.credentials.set(key, val),
  has:    (key)      => window.credentials.has(key),
  delete: (key)      => window.credentials.delete(key),
  list:   ()         => window.credentials.list(),
};

// ── Files / shell ──────────────────────────────────────────────────────────
export const files = {
  openUptakeScreenshot: (p) => window.files.openUptakeScreenshot(p),
  getLatestScreenshot:  ()  => window.files.getLatestScreenshot(),
  readAsDataUrl:        (p) => window.files.readAsDataUrl(p),
  openExternal:         (u) => window.files.openExternal(u),
  openRelayUrl:         (u) => window.files.openRelayUrl(u),
};

// ── App / window ───────────────────────────────────────────────────────────
export const app = {
  windowAction: (action)      => window.app.windowAction(action),
  notify:       (title, body) => window.app.notify(title, body),
  platform:     window.app.platform,
};

// ── Asana ──────────────────────────────────────────────────────────────────
export const asana = {
  checkAuth:      ()                 => window.asana.checkAuth(),
  getConfig:      ()                 => window.asana.getConfig(),
  saveConfig:     (cfg)              => window.asana.saveConfig(cfg),
  getMe:          ()                 => window.asana.getMe(),
  getWorkspaces:  ()                 => window.asana.getWorkspaces(),
  getProjects:    (wsGid, opts)      => window.asana.getProjects(wsGid, opts),
  getSections:    (projGid)          => window.asana.getSections(projGid),
  getTasks:       (projGid, opts)    => window.asana.getTasks(projGid, opts),
  getTask:        (taskGid)          => window.asana.getTask(taskGid),
  getTaskStories: (taskGid)          => window.asana.getTaskStories(taskGid),
  searchTasks:    (wsGid, q)         => window.asana.searchTasks(wsGid, q),
  createTask:     (projGid, data)    => window.asana.createTask(projGid, data),
  updateTask:     (taskGid, upd)     => window.asana.updateTask(taskGid, upd),
  addComment:     (taskGid, text)    => window.asana.addComment(taskGid, text),
  moveTask:       (taskGid, sectGid) => window.asana.moveTask(taskGid, sectGid),
  linkUnit:       (unitId, taskId)   => window.asana.linkUnit(unitId, taskId),
};

// ── Vendor (Dealer Work Order Engine) ──
export { vendor, getPortalUrl } from './vendor-bridge.js';

// ── Partner portal ─────────────────────────────────────────────────────────
export const partner = {
  getQR:        ()           => window.partner.getQR(),
  getQueue:     ()           => window.partner.getQueue(),
  updateJob:    (id, update) => window.partner.updateJob(id, update),
  onNewRequest: (cb)         => window.partner.onNewRequest(cb),
};

// ── Relay cache (S28: now properly exposed via preload window.relay) ──────────
export const relay = {
  getCache: () => {
    if (window.relay && typeof window.relay.getCache === 'function') {
      return window.relay.getCache();
    }
    return Promise.resolve({});
  },
  getUnitCache: (equipmentId) => {
    if (window.relay && typeof window.relay.getUnitCache === 'function') {
      return window.relay.getUnitCache(equipmentId);
    }
    // Fallback: derive from full cache
    return (window.relay && typeof window.relay.getCache === 'function')
      ? window.relay.getCache().then(cache => cache[equipmentId] || { workOrders: [] })
      : Promise.resolve({ workOrders: [] });
  },
};
