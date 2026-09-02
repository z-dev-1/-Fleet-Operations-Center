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
  const handler = (_e, ...args) => { try { cb(...args); } catch(e) { console.warn("[preload] err:", channel, e.message); } };
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
  // S28: auto-email trigger from scheduler
  onAutoEmail:  (cb) => on('fleet:auto-email', cb),
  // S28-Sprint1: Orcha unit health monitor results
  onMonitor:    (cb) => on('orcha:monitor', cb),
  // S28-Sprint1: Orcha anomaly alerts
  onAlerts:     (cb) => on('orcha:alerts', cb),
  minimize:     () => ipcRenderer.send('win:minimize'),
  maximize:     () => ipcRenderer.send('win:maximize'),
  closeWindow:  () => ipcRenderer.send('win:close'),
  isMaximized:  () => ipcRenderer.invoke('win:is-maximized'),
  onWindowStateChanged: (cb) => on('win:state-changed', cb),
  onBriefing:   (cb) => on('orcha:morning-briefing', cb),
  onConnectionStatus: (cb) => on('app:connection-status', cb),
  onMidwayStatus: (cb) => { on('app:midway-renewing', (d) => cb({...d, status:'renewing'})); on('app:midway-renewed', (d) => cb({...d, status:'renewed'})); on('app:midway-expired', (d) => cb({...d, status:'expired'})); },
  queueOffline: (uid, text) => ipcRenderer.invoke('offline:queue', uid, text),
  getOfflineCount: () => ipcRenderer.invoke('offline:count'),
  repairHistory: (uid) => ipcRenderer.invoke('fleet:repair-history', uid),
  addTimeline:    (unitId, entry) => ipcRenderer.invoke('notes:add-timeline', unitId, entry),
  hideTimeline:   (unitId, entry) => ipcRenderer.invoke('notes:hide-timeline-entry', unitId, entry),
  editTimeline:   (unitId, oldEntry, newEntry) => ipcRenderer.invoke('notes:edit-timeline-entry', unitId, oldEntry, newEntry),
  onNotesUpdated: (cb) => on('notes:updated', cb),
  onWrCreated:  (cb) => on('wr:created', cb),
  onPinsUpdated:(cb) => on('pins:updated', cb),
  onEmailCompose:(cb) => on('email:compose', cb),
  onFleetRefresh:(cb) => on('fleet:refresh', cb),
  // S28-Sprint1: Orcha action recommendations
  onRecommendations: (cb) => on('orcha:recommendations', cb),
  // S28-Sprint2: Workflow tracker results
  onTracker:         (cb) => on('orcha:tracker', cb),
  // S28-Sprint2: Auto-prepared drafts
  onDrafts:          (cb) => on('orcha:drafts', cb),
  // S28-Sprint3: System health
  onHealth:          (cb) => on('orcha:health', cb),
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
  getOperators:  ()        => ipcRenderer.invoke('settings:get-operators'),
  saveOperators: (ops)     => ipcRenderer.invoke('settings:save-operators', ops),
  getOrchaConfig:    ()        => ipcRenderer.invoke('orcha:get-config'),
  getScheduleSlots:  ()        => ipcRenderer.invoke('settings:get-schedule-slots'),
  saveScheduleSlots: (slots)   => ipcRenderer.invoke('settings:save-schedule-slots', slots),
  getSyncInterval:   ()        => ipcRenderer.invoke('settings:get-sync-interval'),
  saveSyncInterval:  (minutes) => ipcRenderer.invoke('settings:save-sync-interval', minutes),
});

// ── Notes ─────────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('notes', {
  getUnit:   (id)     => ipcRenderer.invoke('notes:get-unit', id),
  getAll:    ()       => ipcRenderer.invoke('notes:get-all'),
  saveUnit:  (data)   => ipcRenderer.invoke('notes:save-unit', data),
  deleteUnit:(id)     => ipcRenderer.invoke('notes:delete-unit', id),
});

// ── Long Dwell Units (Analytics tab) ──────────────────────────────────────
contextBridge.exposeInMainWorld('longDwell', {
  getAll:     ()     => ipcRenderer.invoke('long-dwell:get-all'),
  getUnit:    (id)   => ipcRenderer.invoke('long-dwell:get-unit', id),
  saveUnit:   (data) => ipcRenderer.invoke('long-dwell:save-unit', data),
  deleteUnit: (id)   => ipcRenderer.invoke('long-dwell:delete-unit', id),
});

// ── AI / Orcha ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('ai', {
  suggest:          (unit)        => ipcRenderer.invoke('ai:suggest', unit),
  ask:              (prompt)      => ipcRenderer.invoke('ai:ask', prompt),
  orchaAction:      (msg)         => ipcRenderer.invoke('ai:orcha-action', msg),
  sendEmail:   (data)   => ipcRenderer.invoke('ai:send-email', data),
  buildReport: (opts)   => ipcRenderer.invoke('ai:build-report', opts),
  confirmSend: (item)  => ipcRenderer.invoke('ai:confirm-send', item),
  chat:             (prompt)      => ipcRenderer.invoke('ai:chat', prompt),
  appendTimeline:   (data)        => ipcRenderer.invoke('ai:append-timeline', data),
  deepProcess:      (unitIds)     => ipcRenderer.invoke('orcha:deep-process', unitIds),
  recordCorrection: (data)        => ipcRenderer.invoke('orcha:record-correction', data),
  suggestVendor:    (unit)        => ipcRenderer.invoke('orcha:suggest-vendor', unit),
  getCorrections:   (field, lim)  => ipcRenderer.invoke('orcha:get-corrections', field, lim),
  test:             ()            => ipcRenderer.invoke('orcha:test'),
  // BUG FIX: orcha:status IPC handler (relay.getStatus() -- cheap, in-memory, no
  // network call) has existed in src/ipc/ai.js all along but was never exposed
  // through the context bridge, so the renderer had no way to call it at all.
  status:           ()            => ipcRenderer.invoke('orcha:status'),
  onProgress:       (cb)          => on('orcha:progress', cb),
  runDailyNotes:    (units)       => ipcRenderer.invoke('daily-notes:run', units),
  getDailyNotesLog: ()            => ipcRenderer.invoke('daily-notes:get-log'),
  onDailyNotesProgress: (cb)      => on('daily-notes:progress', cb),
  openDailyWindows: (opts)         => ipcRenderer.invoke('daily-notes:open-windows', opts),
  saveOrchaConfig:  (config)       => ipcRenderer.invoke('orcha:save-config', config),
  refreshCreds:     ()             => ipcRenderer.invoke('orcha:refresh-creds'),
  // AI Config — preference selector + per-backend settings
  getAIConfig:      ()             => ipcRenderer.invoke('ai:get-ai-config'),
  saveAIConfig:     (cfg)          => ipcRenderer.invoke('ai:save-ai-config', cfg),
  testClaude:       ()             => ipcRenderer.invoke('ai:test-claude'),
  onAIStatusChanged:(cb)           => on('ai:status-changed', cb),
  // S28-Sprint1: dismiss anomaly alert
  dismissAlert:     (alertId)      => ipcRenderer.invoke('orcha:dismiss-alert', alertId),
  // S28-Sprint3: Orchestrator execution
  execute:          (intent)       => ipcRenderer.invoke('orcha:execute', intent),
  getExecutionLog:  ()             => ipcRenderer.invoke('orcha:get-execution-log'),
  exportExcel:      (data)         => ipcRenderer.invoke('orcha:export-excel', data),
  inferRCA:         (text, ctx)    => ipcRenderer.invoke('orcha:infer-rca', text, ctx),
  timelineIntel:    ()             => ipcRenderer.invoke('orcha:timeline-intel'),
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
  checkLiveAuth:  ()     => ipcRenderer.invoke('slack:check-live-auth'),
  logout:         ()     => ipcRenderer.invoke('slack:logout'),
  sendToChannel:  (data) => ipcRenderer.invoke('slack:send-to-channel', data),
  searchDirectory: (data) => ipcRenderer.invoke('slack:search-directory', data),
  openConversation: (data) => ipcRenderer.invoke('slack:open-conversation', data),
  getAutoReply:   ()     => ipcRenderer.invoke('slack:get-auto-reply'),
  setAutoReply:   (r)    => ipcRenderer.invoke('slack:set-auto-reply', r),
  onIncoming:     (cb)   => on('slack:incoming', cb),
  // -- Partner Auto-Reply engine (2026-07-21) -- see src/scrapers/slack_channel_watch.js
  getChannelWatchConfig:  ()       => ipcRenderer.invoke('slack:get-channel-watch-config'),
  saveChannelWatchConfig: (config) => ipcRenderer.invoke('slack:save-channel-watch-config', config),
  onConfigUpdated:       (cb)     => on('slack:config-updated', cb),
  checkChannelMembership: (channelId) => ipcRenderer.invoke('slack:check-channel-membership', channelId),
  pollChannelWatch:       ()       => ipcRenderer.invoke('slack:poll-channel-watch'),
  dedupeReplies:          ()       => ipcRenderer.invoke('slack:dedupe-replies'),
  getReviewQueue:         ()       => ipcRenderer.invoke('slack:get-review-queue'),
  getReplyLog:            (limit)  => ipcRenderer.invoke('slack:get-reply-log', limit),
  updateReviewItem:       (data)   => ipcRenderer.invoke('slack:update-review-item', data),
  // -- DM Auto-Reply engine (2026-07-23) -- see src/scrapers/slack_dm_autoreply.js
  getDMAutoReplyConfig:   ()       => ipcRenderer.invoke('slack:get-dm-autoreply-config'),
  saveDMAutoReplyConfig:  (config) => ipcRenderer.invoke('slack:save-dm-autoreply-config', config),
  pollDMAutoReply:        ()       => ipcRenderer.invoke('slack:poll-dm-autoreply'),
  getDMReviewQueue:       ()       => ipcRenderer.invoke('slack:get-dm-review-queue'),
  getDMReplyLog:          (limit)  => ipcRenderer.invoke('slack:get-dm-reply-log', limit),
  updateDMReviewItem:     (data)   => ipcRenderer.invoke('slack:update-dm-review-item', data),
  // Digital FAS (Stage D UI)
  fasGetConfig:           ()       => ipcRenderer.invoke('fas:get-config'),
  fasSaveConfig:          (patch)  => ipcRenderer.invoke('fas:save-config', patch),
  fasGetAudit:            (limit)  => ipcRenderer.invoke('fas:get-audit', limit),
  fasGetSenderProfiles:   ()       => ipcRenderer.invoke('fas:get-sender-profiles'),
  fasSaveSenderProfile:   (p)      => ipcRenderer.invoke('fas:save-sender-profile', p),
  fasResolveSender:       (id)     => ipcRenderer.invoke('fas:resolve-sender', id),
  fasGetApprovalQueue:    (status) => ipcRenderer.invoke('fas:get-approval-queue', status),
  fasApproveAction:       (id)     => ipcRenderer.invoke('fas:approve-action', id),
  fasRejectAction:        (id)     => ipcRenderer.invoke('fas:reject-action', id),
  fasGetReplyQueue:       (status) => ipcRenderer.invoke('fas:get-reply-queue', status),
  fasApproveReply:        (id)     => ipcRenderer.invoke('fas:approve-reply', id),
  fasRejectReply:         (id)     => ipcRenderer.invoke('fas:reject-reply', id),
  fasGetPlaybook:         ()       => ipcRenderer.invoke('fas:get-playbook'),
  fasGetKnowledgeDrafts:  (status) => ipcRenderer.invoke('fas:get-knowledge-drafts', status),
  fasApproveKnowledgeDraft:(data)  => ipcRenderer.invoke('fas:approve-knowledge-draft', data),
  fasRejectKnowledgeDraft:(id)     => ipcRenderer.invoke('fas:reject-knowledge-draft', id),
});

// -- Microsoft Graph mail (2026-07-21) -- see src/graph/client.js for the
//    full "why": bypasses OWA compose's paste sanitizer entirely, and
//    doesn't need VPN (unlike SMTP), unlike this app's other two send
//    paths. Mirrors the Slack block above.
contextBridge.exposeInMainWorld('graphMail', {
  checkAuth:         ()      => ipcRenderer.invoke('graph:check-auth'),
  signIn:            ()      => ipcRenderer.invoke('graph:sign-in'),
  signOut:           ()      => ipcRenderer.invoke('graph:sign-out'),
  send:              (data)  => ipcRenderer.invoke('graph:send-mail', data),
  getCalendarEvents: (opts)  => ipcRenderer.invoke('graph:get-calendar-events', opts),
});


// ── SharePoint ────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('sp', {
  push:           (units)   => ipcRenderer.invoke('sp:push', units),
  pushDomicile:   (payload) => ipcRenderer.invoke('sp:push-domicile', payload),
  onProgress:     (cb)      => on('sp:progress', cb),
  getConfig:      ()        => ipcRenderer.invoke('sp:get-config'),
  saveConfig:     (data)    => ipcRenderer.invoke('sp:save-config', data),
  getLists:       (siteUrl) => ipcRenderer.invoke('sp:get-lists', siteUrl),
  discoverSheets: (url) => ipcRenderer.invoke('sp:discover-sheets', url),
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
  stopAutofill:     ()                       => ipcRenderer.invoke('aap:autofill-stop'),
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
  getTestMode:  ()        => ipcRenderer.invoke('email:get-test-mode'),
  setTestMode:  (enabled) => ipcRenderer.invoke('email:set-test-mode', enabled),
});

// ── Partner portal — removed in Phase 6 (feature no longer used) ─────────────

// ── Screenshots / files ───────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('files', {
  openUptakeScreenshot: (p) => ipcRenderer.invoke('uptake:open-screenshot', p),
  getLatestScreenshot:  ()  => ipcRenderer.invoke('uptake:latest-screenshot'),
  readAsDataUrl:        (p) => ipcRenderer.invoke('file:read-dataurl', p),
  openExternal:         (u) => ipcRenderer.invoke('shell:open-external', u),
  openRelayUrl:         (u) => ipcRenderer.invoke('relay:open-url', u),
});

// ── Relay cache (S28: wiring fix — exposes relay data to renderer) ────────────
contextBridge.exposeInMainWorld('relay', {
  getCache:     ()   => ipcRenderer.invoke('relay:get-cache'),
  getUnitCache: (id) => ipcRenderer.invoke('relay:get-unit-cache', id),
});

// ── Credentials (UI-facing — never returns raw values) ──────────────────────
contextBridge.exposeInMainWorld('credentials', {
  set:    (key, val) => ipcRenderer.invoke('credentials:set', key, val),
  has:    (key)      => ipcRenderer.invoke('credentials:has', key),
  delete: (key)      => ipcRenderer.invoke('credentials:delete', key),
  list:   ()         => ipcRenderer.invoke('credentials:list'),
  // NOTE: credentials:get is intentionally NOT exposed to renderer
  // FEATURE (2026-07-22): opens a real vendor portal window + one real
  // auto-login pass -- see src/ipc/credentials.js docblock for the
  // full design/safety writeup (fixed allowlist, separate from
  // open-popup's).
  testLogin: (vendorId) => ipcRenderer.invoke('credentials:test-login', vendorId),
});


// ── Window / app ──────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('contacts', {
  getAll:   ()      => ipcRenderer.invoke('contacts:get-all'),
  save:     (list)  => ipcRenderer.invoke('contacts:save', list),
  add:      (c)     => ipcRenderer.invoke('contacts:add', c),
  update:   (c)     => ipcRenderer.invoke('contacts:update', c),
  remove:   (id)    => ipcRenderer.invoke('contacts:delete', id),
  search:   (q)     => ipcRenderer.invoke('contacts:search', q),
});

contextBridge.exposeInMainWorld('vendorAssignments', {
  getAll: ()      => ipcRenderer.invoke('vendor-assignments:get-all'),
  upsert: (entry) => ipcRenderer.invoke('vendor-assignments:upsert', entry),
  remove: (unitId) => ipcRenderer.invoke('vendor-assignments:remove', unitId),
});

contextBridge.exposeInMainWorld('app', {
  windowAction:   (action) => ipcRenderer.invoke('window:action', action),
  notify:         (title, body) => ipcRenderer.invoke('notify', title, body),
  onNavigateUnit: (cb)     => on('navigate:unit', cb),
  platform:       process.platform,
  splitView:      (data) => ipcRenderer.invoke('window:split-view', data),
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
  // formData (optional): resolved Dealer WO review-modal values -- see
  // renderer/src/js/views/dealer-wo-modal.js -- threaded through to the
  // vendor orchestrator's fill step.
  startPaccar: (unit, formData) => ipcRenderer.invoke('vendor:start-paccar', { unit, formData }),
  startVolvo:  (unit, formData) => ipcRenderer.invoke('vendor:start-volvo',  { unit, formData }),
  approve:     (workflowId, altId) => ipcRenderer.invoke('vendor:approve', { workflowId, altId }),
  cancel:      (workflowId) => ipcRenderer.invoke('vendor:cancel',       { workflowId }),
  getStatus:   ()           => ipcRenderer.invoke('vendor:get-status'),
  openPortalUrl: (url)       => ipcRenderer.invoke('shell:open-external', url),
  enrichAsist:   (srUrl)     => ipcRenderer.invoke('vendor:enrich-asist',  { srUrl }),
  loadHistory:    ()           => ipcRenderer.invoke('vendor:history-load'),
  saveHistory:    (history)    => ipcRenderer.invoke('vendor:history-save', { history }),
  getPortalUrls:  ()           => ipcRenderer.invoke('vendor:portal-urls'),
});

// -- Workflow Intelligence (Phase 8) -- recorder, library, execution
// See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md for the full design.
contextBridge.exposeInMainWorld('workflowIntel', {
  // Recording session lifecycle
  startRecording:   (meta)               => ipcRenderer.invoke('wi:start-recording', meta),
  recordStep:       (sessionId, step)    => ipcRenderer.invoke('wi:record-step', sessionId, step),
  stopRecording:    (sessionId, finalMeta) => ipcRenderer.invoke('wi:stop-recording', sessionId, finalMeta),
  discardRecording: (sessionId)          => ipcRenderer.invoke('wi:discard-recording', sessionId),
  // Library CRUD
  list:           (filter)     => ipcRenderer.invoke('wi:list-workflows', filter),
  get:            (id)         => ipcRenderer.invoke('wi:get-workflow', id),
  save:           (recording)  => ipcRenderer.invoke('wi:save-workflow', recording),
  delete:         (id)         => ipcRenderer.invoke('wi:delete-workflow', id),
  toggleFavorite: (id)         => ipcRenderer.invoke('wi:toggle-favorite', id),
  // Import / export
  importWorkflow: (bundle) => ipcRenderer.invoke('wi:import-workflow', bundle),
  exportWorkflow: (id)     => ipcRenderer.invoke('wi:export-workflow', id),
  // Execution log (read-only until Phase 4 wires the execution engine)
  getExecutionLog: (limit) => ipcRenderer.invoke('wi:get-execution-log', limit),
  getSuggestionForUnit: (unit) => ipcRenderer.invoke('wi:get-suggestion-for-unit', unit),
  // Phase 4: Execute a recorded workflow
  execute:         (id, variables) => ipcRenderer.invoke('wi:execute-workflow', id, variables),
  onProgress:      (cb) => on('wi:execution-progress', cb),
});

// -- Bubble/mini-FAB window controls (2026-07-24) -- only meaningful when this
// preload is used by the always-on-top bubble window (see showBubble() in
// src/window/index.js), but exposed here too so the SAME preload.js can back
// both windows -- one bridge surface, no drifting second copy. No-op/unused
// in the main window.
contextBridge.exposeInMainWorld('bubble', {
  openMain:       ()       => ipcRenderer.send('bubble:clicked'),
  openUnit:       (unitId) => ipcRenderer.send('bubble:open-unit', unitId),
  hide:           ()       => ipcRenderer.send('bubble:hide'),
  resize:         (w, h)   => ipcRenderer.send('bubble:resize', w, h),
  reposition:     ()       => ipcRenderer.send('bubble:reposition'),
  repositionMini: ()       => ipcRenderer.send('bubble:reposition-mini'),
  // CHAT FLOATER TRANSPARENCY (2026-07-25): exposed on the shared preload
  // so BOTH the main window's Settings panel (to set it) and the bubble
  // window itself (to read/apply it) can use the same API -- the IPC
  // handlers live in the main process regardless of which renderer calls.
  getOpacity:       ()       => ipcRenderer.invoke('bubble:get-opacity'),
  setOpacity:       (v)      => ipcRenderer.send('bubble:set-opacity', v),
  onOpacityChanged: (cb)     => ipcRenderer.on('bubble:opacity-changed', (_e, v) => cb(v)),
  quit:           ()       => ipcRenderer.send('app:quit'),
});

// ── Fleet Ops Companion — removed in Phase 6 (feature no longer used) ────────
