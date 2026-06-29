/**
 * preload.js — Context Bridge for Fleet Operations App v3.0.0
 *
 * Exposes a clean, typed API surface to the renderer process.
 * NEVER expose ipcRenderer directly — always wrap in named functions.
 * NEVER expose Node.js APIs directly.
 *
 * Bridge namespaces:
 *   window.fleet        — Fleet data, sync, status
 *   window.notes        — Unit notes (save/load)
 *   window.ai           — Orcha AI features
 *   window.slack        — Slack messaging
 *   window.sp           — SharePoint push
 *   window.auth         — Midway auth
 *   window.aap          — AAP scraper actions
 *   window.email        — Email sending
 *   window.partner      — Partner portal
 *   window.settings     — User settings
 *   window.credentials  — Secure credential UI
 *   window.app          — App / window controls
 *   window.setup        — Setup wizard
 *   window.asana        — Asana integration
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ── Helper: one-way listener (returns cleanup function) ─────────────────────
function on(channel, cb) {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ── Fleet data ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('fleet', {
  onData:       (cb) => on('fleet:data', cb),
  onStatus:     (cb) => on('fleet:status', cb),
  onError:      (cb) => on('fleet:error', cb),
  // S7: structured auth-failure payload { code, message } for session-expiry errors
  onAuthFailure:(cb) => on('fleet:auth-failure', cb),
  signalReady:  ()  => ipcRenderer.send('renderer:ready'),
  requestSync:  ()  => ipcRenderer.send('fleet:request-sync'),
  forceSync:    ()  => ipcRenderer.invoke('fleet:force-scan'),
  getVersion:   ()  => ipcRenderer.invoke('app:version'),
});

// ── Settings & Domiciles ───────────────────────────────────────────────────
contextBridge.exposeInMainWorld('settings', {
  getDomiciles:  ()        => ipcRenderer.invoke('settings:get-domiciles'),
  saveDomiciles: (d)       => ipcRenderer.invoke('settings:save-domiciles', d),
  resetDomiciles:()        => ipcRenderer.invoke('settings:reset-domiciles'),
  getAll:        ()        => ipcRenderer.invoke('settings:get-all'),
  save:          (key, val)=> ipcRenderer.invoke('settings:save', key, val),
  getOrchaConfig:()        => ipcRenderer.invoke('orcha:get-config'),
});

// ── Notes ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('notes', {
  getUnit:   (id)     => ipcRenderer.invoke('notes:get-unit', id),
  getAll:    ()       => ipcRenderer.invoke('notes:get-all'),
  saveUnit:  (data)   => ipcRenderer.invoke('notes:save-unit', data),
  deleteUnit:(id)     => ipcRenderer.invoke('notes:delete-unit', id),
});

// ── AI / Orcha ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('ai', {
  suggest:          (unit)        => ipcRenderer.invoke('ai:suggest', unit),
  ask:              (prompt)      => ipcRenderer.invoke('ai:ask', prompt),
  chat:             (prompt)      => ipcRenderer.invoke('ai:chat', prompt),
  deepProcess:      (unitIds)     => ipcRenderer.invoke('orcha:deep-process', unitIds),
  recordCorrection: (data)        => ipcRenderer.invoke('orcha:record-correction', data),
  suggestVendor:    (unit)        => ipcRenderer.invoke('orcha:suggest-vendor', unit),
  getCorrections:   (field, lim)  => ipcRenderer.invoke('orcha:get-corrections', field, lim),
  test:             ()            => ipcRenderer.invoke('orcha:test'),
  onProgress:       (cb)          => on('orcha:progress', cb),
  runDailyNotes:    (units)       => ipcRenderer.invoke('daily-notes:run', units),
  getDailyNotesLog: ()            => ipcRenderer.invoke('daily-notes:get-log'),
  onDailyNotesProgress: (cb)      => on('daily-notes:progress', cb),
  openDailyWindows: (opts)         => ipcRenderer.invoke('daily-notes:open-windows', opts),
  saveOrchaConfig:  (config)       => ipcRenderer.invoke('orcha:save-config', config),
  refreshCreds:     ()             => ipcRenderer.invoke('orcha:refresh-creds'),
});

// ── Slack ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('slack', {
  send:      (data) => ipcRenderer.invoke('slack:send', data),
  checkAuth: ()     => ipcRenderer.invoke('slack:check-auth'),
  login:     ()     => ipcRenderer.invoke('slack:login'),
  // S22: read, channels, auto-reply
  read:           (data) => ipcRenderer.invoke('slack:read', data),
  readDMs:        ()     => ipcRenderer.invoke('slack:read-dms'),
  getChannels:    ()     => ipcRenderer.invoke('slack:get-channels'),
  getAutoReply:   ()     => ipcRenderer.invoke('slack:get-auto-reply'),
  setAutoReply:   (r)    => ipcRenderer.invoke('slack:set-auto-reply', r),
  onIncoming:     (cb)   => on('slack:incoming', cb),
});


// ── SharePoint ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('sp', {
  push:       (units)  => ipcRenderer.invoke('sp:push', units),
  onProgress: (cb)     => on('sp:progress', cb),
  getConfig:  ()       => ipcRenderer.invoke('sp:get-config'),
  saveConfig: (data)   => ipcRenderer.invoke('sp:save-config', data),
});

// ── Auth ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('auth', {
  runMwinit:     ()   => ipcRenderer.invoke('auth:run-mwinit'),
  onMwinitStatus:(cb) => on('auth:mwinit-status', cb),
  checkMidway:   ()   => ipcRenderer.invoke('auth:check-midway'),
});

// ── AAP actions ───────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('aap', {
  setLifecycle:     (id, url, state, reason) => ipcRenderer.invoke('aap:set-lifecycle', { equipmentId: id, assetUrl: url, state, reason }),
  autofill:         (url, payload)           => ipcRenderer.invoke('aap:autofill', url, payload),
  runAdaptive:      (payload)                => ipcRenderer.invoke('aap:adaptive', payload),
  adaptiveExtract:  (opts)                   => ipcRenderer.invoke('adaptive:extract', opts),
  adaptiveScanBatch:(units)                  => ipcRenderer.invoke('adaptive:scan-batch', units),
  createWR:         (payload, unit)          => ipcRenderer.invoke('aap:create-wr', payload, unit),
  onWRProgress:     (cb)                     => on('wr:progress', cb),
  openUrl:          (url)                    => ipcRenderer.invoke('aap:open-url', url),
});

// ── Geofence ──────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('geofence', {
  scrape:   () => ipcRenderer.invoke('geofence:scrape'),
  getCache: () => ipcRenderer.invoke('geofence:get-cache'),
});

// ── Email ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('email', {
  send:         (opts)    => ipcRenderer.invoke('email:send', opts),
  getConfig:    ()        => ipcRenderer.invoke('email:get-config'),
  saveConfig:   (config)  => ipcRenderer.invoke('email:save-config', config),
  preview:      (opts)    => ipcRenderer.invoke('email:preview', opts),
  compose:      (payload) => ipcRenderer.invoke('email:compose', payload),
  saveOpEmails: (data)    => ipcRenderer.invoke('email:save-op-emails', data),
  loadOpEmails: ()        => ipcRenderer.invoke('email:load-op-emails'),
});

// ── Partner portal ───────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('partner', {
  getQR:         ()          => ipcRenderer.invoke('partner:get-qr'),
  getQueue:      ()          => ipcRenderer.invoke('partner:get-queue'),
  updateJob:     (id, update)=> ipcRenderer.invoke('partner:update-job', id, update),
  onNewRequest:  (cb)        => on('partner:new-request', cb),
});

// ── Screenshots / files ───────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('files', {
  openUptakeScreenshot: (p) => ipcRenderer.invoke('uptake:open-screenshot', p),
  getLatestScreenshot:  ()  => ipcRenderer.invoke('uptake:latest-screenshot'),
  readAsDataUrl:        (p) => ipcRenderer.invoke('file:read-dataurl', p),
  openExternal:         (u) => ipcRenderer.invoke('shell:open-external', u),
  openRelayUrl:         (u) => ipcRenderer.invoke('relay:open-url', u),
});

// ── Credentials (UI-facing — never returns raw values) ──────────────────────
contextBridge.exposeInMainWorld('credentials', {
  set:    (key, val) => ipcRenderer.invoke('credentials:set', key, val),
  has:    (key)      => ipcRenderer.invoke('credentials:has', key),
  delete: (key)      => ipcRenderer.invoke('credentials:delete', key),
  list:   ()         => ipcRenderer.invoke('credentials:list'),
  // NOTE: credentials:get is intentionally NOT exposed to renderer
});

// ── Window / app ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('app', {
  windowAction:   (action) => ipcRenderer.invoke('window:action', action),
  notify:         (title, body) => ipcRenderer.invoke('notify', title, body),
  onNavigateUnit: (cb)     => on('navigate:unit', cb),
  platform:       process.platform,
});

// ── Setup wizard ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('setup', {
  getState:       ()         => ipcRenderer.invoke('setup:get-state'),
  saveStep:       (step, data) => ipcRenderer.invoke('setup:save-step', step, data),
  verifyStep:     (step)     => ipcRenderer.invoke('setup:verify-step', step),
  complete:       ()         => ipcRenderer.invoke('setup:complete'),
  reset:          ()         => ipcRenderer.invoke('setup:reset'),
  onProgress:     (cb)       => on('setup:progress', cb),
});

// ── Asana ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('asana', {
  checkAuth:     ()                    => ipcRenderer.invoke('asana:check-auth'),
  getConfig:     ()                    => ipcRenderer.invoke('asana:get-config'),
  saveConfig:    (cfg)                 => ipcRenderer.invoke('asana:save-config', cfg),
  getMe:         ()                    => ipcRenderer.invoke('asana:get-me'),
  getWorkspaces: ()                    => ipcRenderer.invoke('asana:get-workspaces'),
  getProjects:   (wsGid, opts)         => ipcRenderer.invoke('asana:get-projects', wsGid, opts),
  getSections:   (projGid)             => ipcRenderer.invoke('asana:get-sections', projGid),
  getTasks:      (projGid, opts)       => ipcRenderer.invoke('asana:get-tasks', projGid, opts),
  getTask:       (taskGid)             => ipcRenderer.invoke('asana:get-task', taskGid),
  getTaskStories:(taskGid)             => ipcRenderer.invoke('asana:get-task-stories', taskGid),
  searchTasks:   (wsGid, q)            => ipcRenderer.invoke('asana:search-tasks', wsGid, q),
  createTask:    (projGid, data)       => ipcRenderer.invoke('asana:create-task', projGid, data),
  updateTask:    (taskGid, upd)        => ipcRenderer.invoke('asana:update-task', taskGid, upd),
  addComment:    (taskGid, text)       => ipcRenderer.invoke('asana:add-comment', taskGid, text),
  moveTask:      (taskGid, sectGid)    => ipcRenderer.invoke('asana:move-task', taskGid, sectGid),
  linkUnit:      (unitId, taskId)      => ipcRenderer.invoke('asana:link-unit', unitId, taskId),
});

// -- Vendor / Dealer Work Order Engine (S23-8)
contextBridge.exposeInMainWorld('vendor', {
  onProgress:    (cb) => on('vendor:progress',     cb),
  onReviewReady: (cb) => on('vendor:review-ready', cb),
  onComplete:    (cb) => on('vendor:complete',     cb),
  onError:       (cb) => on('vendor:error',        cb),
  investigate: (unit)       => ipcRenderer.invoke('vendor:investigate',  { unit }),
  startPaccar: (unit)       => ipcRenderer.invoke('vendor:start-paccar', { unit }),
  startVolvo:  (unit)       => ipcRenderer.invoke('vendor:start-volvo',  { unit }),
  approve:     (workflowId, altId) => ipcRenderer.invoke('vendor:approve', { workflowId, altId }),
  cancel:      (workflowId) => ipcRenderer.invoke('vendor:cancel',       { workflowId }),
  getStatus:   ()           => ipcRenderer.invoke('vendor:get-status'),
  openPortalUrl: (url)       => ipcRenderer.invoke('shell:open-external', url),
  loadHistory:    ()           => ipcRenderer.invoke('vendor:history-load'),
  saveHistory:    (history)    => ipcRenderer.invoke('vendor:history-save', { history }),
});
