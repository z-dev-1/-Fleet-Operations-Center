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
  // MIDWAY_SESSION_INVALID) arrive here; auth-bridge.js picks up via __fleet_bus
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

  // Signal renderer ready -- triggers cached-data push from main
  window.fleet.signalReady();

  // S7: expose bus for legacy non-ESM IIFEs (auth-bridge.js) that cannot import bus.js
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
  getOrchaConfig: ()       => window.settings.getOrchaConfig(),
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
  send:      (data) => window.slack.send(data),
  checkAuth: ()     => window.slack.checkAuth(),
  login:     ()     => window.slack.login(),
};

// ── SharePoint ─────────────────────────────────────────────────────────────
export const sp = {
  push:       (units) => window.sp.push(units),
  getConfig:  ()      => window.sp.getConfig(),
  saveConfig: (data)  => window.sp.saveConfig(data),
};

// ── Auth ───────────────────────────────────────────────────────────────────
export const auth = {
  runMwinit:   () => window.auth.runMwinit(),
  checkMidway: () => window.auth.checkMidway(),
};

// ── Email ──────────────────────────────────────────────────────────────────
export const email = {
  send:       (opts)   => window.email.send(opts),
  getConfig:  ()       => window.email.getConfig(),
  saveConfig: (config) => window.email.saveConfig(config),
  preview:    (opts)   => window.email.preview(opts),
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

// ── Partner portal ─────────────────────────────────────────────────────────
export const partner = {
  getQR:        ()           => window.partner.getQR(),
  getQueue:     ()           => window.partner.getQueue(),
  updateJob:    (id, update) => window.partner.updateJob(id, update),
  onNewRequest: (cb)         => window.partner.onNewRequest(cb),
};
