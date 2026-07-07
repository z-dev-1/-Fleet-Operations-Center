'use strict';
/**
 * ipc/asana.js - Asana IPC handlers
 * Auth, workspaces, projects, sections, tasks, task actions.
 * All calls go through the PAT-authenticated client.
 *
 * Stage 4 hardening (2026-06-28):
 *   - Issue #20: all 14 handlers migrated from bare ipcMain.handle to handle()
 *   - Issue #21: asana:link-unit validates unitId format (KEY_RE) and taskId length
 *   - Issue #22: asana:create-task / update-task require plain object, cap key count
 *   - Issue #23: asana:search-tasks caps query string at 256 chars
 *   - asana:add-comment caps comment text at 4096 chars
 */

const logger = require('../utils/logger')('ipc:asana');
const { handle, requireString, requireStringMax, requireObject } = require('./_safe');
const { ConfigError } = require('../utils/errors');

// ── Issue #21: key format validation (mirrors credentials.js pattern) ─────────
const KEY_RE    = /^[A-Za-z0-9._:@-]{1,64}$/;
const MAX_GID   = 32;   // Asana GIDs are numeric strings, 16-18 digits in practice
const MAX_QUERY = 256;
const MAX_COMMENT_LEN = 4096;
const MAX_TASK_KEYS   = 30;   // Issue #22: reasonable upper bound on task data object

function _validateGid(val, field) {
  requireString(val, field);
  if (val.length > MAX_GID) {
    throw new ConfigError(field + ' exceeds maximum length (' + MAX_GID + ')', field);
  }
}

function _validateUnitId(unitId) {
  requireString(unitId, 'unitId');
  if (!KEY_RE.test(unitId)) {
    throw new ConfigError(
      'unitId contains invalid characters (allowed: A-Z a-z 0-9 . _ : @ - , max 64)',
      'unitId'
    );
  }
}

function _validateTaskData(data, field) {
  requireObject(data, field);
  const keyCount = Object.keys(data).length;
  if (keyCount > MAX_TASK_KEYS) {
    throw new ConfigError(
      field + ' object too large (' + keyCount + ' keys, max ' + MAX_TASK_KEYS + ')',
      field
    );
  }
}

function registerAsanaIPC() {
  const asana = require('../asana/client');

  // ── Auth + config ──────────────────────────────────────────────────────────
  handle('asana:check-auth',      async () => asana.checkAuth());
  handle('asana:get-config',      ()       => asana.loadConfig());
  handle('asana:save-config',     (_e, config) => {
    requireObject(config, 'config');
    return asana.saveConfig(config);
  });

  // ── User ───────────────────────────────────────────────────────────────────
  handle('asana:get-me',          async () => asana.getMe());

  // ── Workspaces & Projects ──────────────────────────────────────────────────
  handle('asana:get-workspaces',  async () => asana.getWorkspaces());
  handle('asana:get-projects',    async (_e, wsGid, opts) => {
    _validateGid(wsGid, 'wsGid');
    return asana.getProjects(wsGid, opts);
  });
  handle('asana:get-sections',    async (_e, projGid) => {
    _validateGid(projGid, 'projGid');
    return asana.getSections(projGid);
  });

  // ── Tasks ──────────────────────────────────────────────────────────────────
  handle('asana:get-tasks',       async (_e, projGid, opts) => {
    _validateGid(projGid, 'projGid');
    return asana.getTasks(projGid, opts);
  });
  handle('asana:get-task',        async (_e, taskGid) => {
    _validateGid(taskGid, 'taskGid');
    return asana.getTask(taskGid);
  });
  handle('asana:get-task-stories', async (_e, taskGid) => {
    _validateGid(taskGid, 'taskGid');
    return asana.getTaskStories(taskGid);
  });

  // Issue #23: query string length cap
  handle('asana:search-tasks',    async (_e, wsGid, q) => {
    _validateGid(wsGid, 'wsGid');
    requireStringMax(q, 'query', MAX_QUERY);
    return asana.searchTasks(wsGid, q);
  });

  // Issue #22: task data object validation
  handle('asana:create-task',     async (_e, projGid, data) => {
    _validateGid(projGid, 'projGid');
    _validateTaskData(data, 'data');
    return asana.createTask(projGid, data);
  });
  handle('asana:update-task',     async (_e, taskGid, updates) => {
    _validateGid(taskGid, 'taskGid');
    _validateTaskData(updates, 'updates');
    return asana.updateTask(taskGid, updates);
  });

  // Comment length cap
  handle('asana:add-comment',     async (_e, taskGid, text) => {
    _validateGid(taskGid, 'taskGid');
    requireStringMax(text, 'text', MAX_COMMENT_LEN);
    return asana.addComment(taskGid, text);
  });

  handle('asana:move-task',       async (_e, taskGid, sectGid) => {
    _validateGid(taskGid, 'taskGid');
    _validateGid(sectGid, 'sectGid');
    return asana.moveTaskToSection(taskGid, sectGid);
  });

  // Issue #21: unitId format + taskId length validated before notesStore write
  handle('asana:link-unit', (_e, unitId, taskId) => {
    _validateUnitId(unitId);
    requireStringMax(taskId, 'taskId', MAX_GID);
    const store = require('../store');
    const notes = store.load('notesStore', {});
    const unit  = notes[unitId] || {};
    unit.asanaTaskId   = taskId;
    unit.asanaLinkedAt = new Date().toISOString();
    notes[unitId] = unit;
    store.save('notesStore', notes);
    logger.info('Unit linked to Asana task:', unitId, '->', taskId);
    return { ok: true, unitId, taskId };
  });

  logger.info('Asana IPC handlers registered');
}

module.exports = { registerAsanaIPC };
