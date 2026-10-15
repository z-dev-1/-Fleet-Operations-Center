'use strict';
/**
 * asana/client.js — Asana API client  (V-C)
 *
 * Auth:  Personal Access Token (PAT) — stored via store.save('asanaConfig')
 *        or ASANA_PAT env var.
 *
 * V-C changes from V-B:
 *   - All file I/O via store.load / store.save (no raw fs.*)
 *   - Paths via P.asanaConfig / P.asanaAuthState (no hardcoded AppData)
 *   - console.warn/log → logger.*
 *   - Removed redundant CONFIG_DIR mkdir (store.save handles it)
 */

const https  = require('https');
const { P }  = require('../config/paths');
const store  = require('../store');
const logger = require('../utils/logger')('asana:client');

const ASANA_BASE_URL = 'https://app.asana.com/api/1.0';

// ── CONFIG ───────────────────────────────────────────────────────────────────
function loadConfig() {
  return store.load('asanaConfig', {});
}

function saveConfig(config) {
  try {
    store.save('asanaConfig', config);
    return { ok: true };
  } catch (e) {
    logger.error('saveConfig failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// Synchronous PAT lookup (env var or plaintext config). Kept for callers that
// only need the PAT path; the async resolveToken() below is the real entry.
function getToken() {
  return process.env.ASANA_PAT || loadConfig().pat || null;
}

// Resolve the active user's PAT (async for a consistent interface; the
// multi-user manager below reads the encrypted per-user token). Preference:
//   1. Active user's PAT (from the encrypted credentials store).
//   2. ASANA_PAT env var / legacy plaintext pat in asanaConfig (compat).
// Returns null when nothing is configured.
async function resolveToken() {
  try {
    const users = require('./users');
    const tok = await users.getActiveToken();
    if (tok) return tok;
  } catch (e) {
    logger.warn('Active-user token resolve failed, falling back to legacy PAT:', e.message);
  }
  return getToken();
}

// ── API REQUEST ───────────────────────────────────────────────────────────────
async function apiRequest(endpoint, method, body) {
  const token = await resolveToken();
  return new Promise((resolve, reject) => {
    if (!token) {
      reject(new Error('No Asana auth configured. Add a user (PAT) in Settings.'));
      return;
    }

    const url = new URL(endpoint.startsWith('http') ? endpoint : ASANA_BASE_URL + endpoint);
    const options = {
      hostname: url.hostname,
      port:     443,
      path:     url.pathname + url.search,
      method:   method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept':        'application/json',
        'Content-Type':  'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            const msg = parsed.errors
              ? parsed.errors.map((e) => e.message).join(', ')
              : data;
            reject(new Error('Asana API ' + res.statusCode + ': ' + msg));
          } else {
            resolve(parsed.data !== undefined ? parsed.data : parsed);
          }
        } catch (e) {
          reject(new Error('Asana API parse error: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(new Error('Asana API network error: ' + e.message)));
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Asana API timeout (30s)'));
    });

    if (body) req.write(JSON.stringify({ data: body }));
    req.end();
  });
}

// ── PAGINATION HELPER ─────────────────────────────────────────────────────────
async function apiPaginate(endpoint) {
  let allResults = [];
  let nextPage   = endpoint;
  const token = await resolveToken();   // resolve the active user's PAT once for the whole page walk
  while (nextPage) {
    const raw = await new Promise((resolve, reject) => {
      if (!token) { reject(new Error('No Asana auth configured. Log in with Asana or set a PAT.')); return; }
      const url = new URL(nextPage.startsWith('http') ? nextPage : ASANA_BASE_URL + nextPage);
      const options = {
        hostname: url.hostname, port: 443,
        path:     url.pathname + url.search,
        method:   'GET',
        headers:  { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' },
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    if (raw.data) allResults = allResults.concat(raw.data);
    nextPage = (raw.next_page && raw.next_page.uri) ? raw.next_page.uri : null;
  }
  return allResults;
}

// ── PUBLIC API METHODS ────────────────────────────────────────────────────────
async function getMe()                        { return apiRequest('/users/me'); }
async function getWorkspaces()                { return apiRequest('/workspaces'); }

async function getProjects(workspaceGid, opts) {
  const p = new URLSearchParams();
  if (opts && opts.team)            p.set('team',     opts.team);
  if (opts && opts.archived === false) p.set('archived', 'false');
  p.set('opt_fields', 'name,gid,archived,team.name,created_at,modified_at');
  p.set('limit', '100');
  return apiRequest('/workspaces/' + workspaceGid + '/projects?' + p.toString());
}

async function getTasks(projectGid, opts) {
  const p = new URLSearchParams();
  p.set('opt_fields', 'name,gid,assignee.name,due_on,completed,completed_at,notes,custom_fields,created_at,modified_at,tags.name,memberships.section.name');
  if (opts && opts.completed_since) p.set('completed_since', opts.completed_since);
  p.set('limit', '100');
  return apiRequest('/projects/' + projectGid + '/tasks?' + p.toString());
}

async function getTask(taskGid) {
  return apiRequest('/tasks/' + taskGid + '?opt_fields=name,gid,assignee.name,due_on,completed,notes,custom_fields,created_at,modified_at,tags.name,memberships.section.name');
}

async function getTaskStories(taskGid) {
  return apiRequest('/tasks/' + taskGid + '/stories?opt_fields=created_at,created_by.name,text,type,resource_subtype');
}

async function createTask(projectGid, taskData) {
  return apiRequest('/tasks', 'POST', { projects: [projectGid], ...taskData });
}

async function updateTask(taskGid, updates) {
  return apiRequest('/tasks/' + taskGid, 'PUT', updates);
}

async function addComment(taskGid, text) {
  return apiRequest('/tasks/' + taskGid + '/stories', 'POST', { text });
}

async function searchTasks(workspaceGid, query) {
  const p = new URLSearchParams();
  p.set('text',       query);
  p.set('opt_fields', 'name,gid,assignee.name,due_on,completed,projects.name,memberships.section.name');
  p.set('limit',      '25');
  return apiRequest('/workspaces/' + workspaceGid + '/tasks/search?' + p.toString());
}

async function getSections(projectGid) {
  return apiRequest('/projects/' + projectGid + '/sections?opt_fields=name,gid');
}

async function moveTaskToSection(taskGid, sectionGid) {
  return apiRequest('/sections/' + sectionGid + '/addTask', 'POST', { task: taskGid });
}

// ── WORKFLOW HELPERS (active-user "My Tasks") ──────────────────────────────────

// The active user's config (workspace/task-list IDs) from the users manager.
function _activeUser() {
  try { return require('./users').getActiveUser(); } catch (_) { return null; }
}

// Get the active user's assigned tasks via workspace task search.
// opts: { completed, dueBefore, dueAfter, fields, limit }
async function getMyTasks(opts) {
  opts = opts || {};
  const user = _activeUser();
  const wsGid = (user && user.workspaceGid) || (loadConfig().defaults && loadConfig().defaults.workspaceGid) || loadConfig().workspace;
  if (!wsGid) throw new Error('No workspace configured for the active Asana user');
  const p = new URLSearchParams();
  p.set('assignee.any', 'me');
  p.set('completed', String(opts.completed != null ? opts.completed : false));
  p.set('opt_fields', opts.fields || 'name,gid,due_on,completed,assignee_status,notes,projects.name');
  p.set('limit', String(opts.limit || 100));
  if (opts.dueBefore) p.set('due_on.before', opts.dueBefore);
  if (opts.dueAfter)  p.set('due_on.after',  opts.dueAfter);
  return apiPaginate('/workspaces/' + wsGid + '/tasks/search?' + p.toString());
}

async function getTodaysTasks() {
  const today    = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  return getMyTasks({ dueAfter: today, dueBefore: tomorrow, completed: false });
}

async function completeTask(taskGid) {
  return updateTask(taskGid, { completed: true });
}

// Find today's open task by exact name, optionally comment, then complete it.
async function completeDailyTask(taskName, comment) {
  const tasks = await getTodaysTasks();
  const task = tasks.find((t) => t.name === taskName && !t.completed);
  if (!task) { logger.warn('No open task "' + taskName + '" due today'); return { ok: false, reason: 'not_found', taskName }; }
  if (comment) await addComment(task.gid, comment);
  await completeTask(task.gid);
  logger.info('Completed daily task: ' + taskName);
  return { ok: true, taskName, gid: task.gid };
}

async function batchCompleteDailies(taskNames) {
  const results = [];
  for (const name of (taskNames || [])) {
    try {
      const r = await completeDailyTask(name, 'Auto-completed by Fleet Ops at ' + new Date().toLocaleTimeString());
      if (r.ok) results.push(r);
    } catch (e) { logger.warn('batchComplete "' + name + '" failed: ' + e.message); }
  }
  logger.info('Batch complete: ' + results.length + '/' + (taskNames || []).length);
  return { ok: true, completed: results.length, total: (taskNames || []).length, tasks: results };
}

// Create an escalation task (due today) in a project, optionally with an
// external SharePoint link attached.
async function createEscalation(opts) {
  opts = opts || {};
  if (!opts.projectGid) throw new Error('createEscalation requires projectGid');
  const today = new Date().toISOString().split('T')[0];
  const created = await createTask(opts.projectGid, {
    name:    '\u{1F6A8} ' + (opts.title || 'Escalation'),
    due_on:  today,
    notes:   opts.description || '',
  });
  const taskGid = (created && created.gid) || (created && created.data && created.data.gid);
  if (taskGid && opts.sharePointUrl) {
    try { await linkExternalFile(taskGid, opts.sharePointUrl, opts.title || 'Attachment'); }
    catch (e) { logger.warn('escalation link attach failed: ' + e.message); }
  }
  return { ok: true, gid: taskGid };
}

async function getDailySummary() {
  const open = await getMyTasks({ completed: false, dueBefore: new Date(Date.now() + 86400000).toISOString().split('T')[0], dueAfter: new Date().toISOString().split('T')[0] });
  const doneToday = await getMyTasks({ completed: true, dueAfter: new Date().toISOString().split('T')[0], dueBefore: new Date(Date.now() + 86400000).toISOString().split('T')[0] });
  return {
    ok: true,
    date: new Date().toISOString().split('T')[0],
    remaining: open.length,
    completed: doneToday.length,
    remainingTasks: open.map((t) => t.name),
    completedTasks: doneToday.map((t) => t.name),
  };
}

// ── ATTACHMENTS (native-https multipart — no form-data dependency) ─────────────

function _getComments(taskGid) {
  return apiPaginate('/tasks/' + taskGid + '/stories?opt_fields=text,created_by.name,created_at,type');
}

async function getAttachments(taskGid) {
  return apiPaginate('/tasks/' + taskGid + '/attachments?opt_fields=name,download_url,host,created_at,resource_subtype');
}

// Build a multipart/form-data body from text fields + an optional single file.
// field: { name, filename, contentType, buffer }
function _multipart(fields, file) {
  const boundary = '----FleetOpsAsana' + require('crypto').randomBytes(12).toString('hex');
  const CRLF = '\r\n';
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(Buffer.from('--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="' + k + '"' + CRLF + CRLF
      + String(v) + CRLF, 'utf8'));
  }
  if (file && file.buffer) {
    parts.push(Buffer.from('--' + boundary + CRLF
      + 'Content-Disposition: form-data; name="file"; filename="' + (file.filename || 'file') + '"' + CRLF
      + 'Content-Type: ' + (file.contentType || 'application/octet-stream') + CRLF + CRLF, 'utf8'));
    parts.push(file.buffer);
    parts.push(Buffer.from(CRLF, 'utf8'));
  }
  parts.push(Buffer.from('--' + boundary + '--' + CRLF, 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

// Low-level multipart POST to the Asana API using the active user's token.
async function _postMultipart(endpoint, fields, file) {
  const token = await resolveToken();
  if (!token) throw new Error('No Asana auth configured. Add a user (PAT) in Settings.');
  const { body, contentType } = _multipart(fields, file);
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('http') ? endpoint : ASANA_BASE_URL + endpoint);
    const opts = {
      hostname: url.hostname, port: 443, path: url.pathname + url.search, method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        'Content-Type': contentType,
        'Content-Length': body.length,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { reject(new Error('Asana upload parse error: ' + e.message)); return; }
        if (res.statusCode >= 400) {
          const msg = (parsed.errors && parsed.errors.map((x) => x.message).join(', ')) || ('HTTP ' + res.statusCode);
          reject(new Error('Asana upload ' + res.statusCode + ': ' + msg));
        } else {
          resolve(parsed.data !== undefined ? parsed.data : parsed);
        }
      });
    });
    req.on('error', (e) => reject(new Error('Asana upload network error: ' + e.message)));
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Asana upload timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// Upload a local file to a task.
async function uploadFile(taskGid, filePath) {
  const fs = require('fs');
  const path = require('path');
  const buffer = fs.readFileSync(filePath);
  const res = await _postMultipart('/tasks/' + taskGid + '/attachments',
    {}, { filename: path.basename(filePath), buffer });
  logger.info('Uploaded ' + path.basename(filePath) + ' to task ' + taskGid);
  return res;
}

// Upload an in-memory buffer (e.g. a generated PDF/PNG) to a task.
async function uploadBuffer(taskGid, buffer, fileName, contentType) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const res = await _postMultipart('/tasks/' + taskGid + '/attachments',
    {}, { filename: fileName || 'file', buffer: buf, contentType });
  logger.info('Uploaded buffer "' + (fileName || 'file') + '" to task ' + taskGid);
  return res;
}

// Attach an external URL (SharePoint, S3, etc.) to a task.
async function linkExternalFile(taskGid, url, fileName) {
  const res = await _postMultipart('/tasks/' + taskGid + '/attachments', {
    resource_subtype: 'external',
    parent: taskGid,
    url,
    name: fileName || url,
  }, null);
  logger.info('Linked "' + (fileName || url) + '" to task ' + taskGid);
  return res;
}

// ── AUTH STATUS ───────────────────────────────────────────────────────────────
async function checkAuth() {
  try {
    const me = await getMe();
    return { ok: true, user: me.name, email: me.email, gid: me.gid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function hasStorageState() {
  return store.exists('asanaAuthState');
}

module.exports = {
  loadConfig, saveConfig, getToken, resolveToken, checkAuth, hasStorageState,
  getMe, getWorkspaces, getProjects, getTasks, getTask, getTaskStories,
  createTask, updateTask, addComment, searchTasks, getSections, moveTaskToSection,
  apiRequest, apiPaginate,
  // Workflow helpers (active user)
  getMyTasks, getTodaysTasks, completeTask, completeDailyTask,
  batchCompleteDailies, createEscalation, getDailySummary, getComments: _getComments,
  // Attachments (native-https multipart)
  uploadFile, uploadBuffer, linkExternalFile, getAttachments,
  // Multi-user PAT manager (re-exported for convenience)
  setupUser:   (...a) => require('./users').setupUser(...a),
  switchUser:  (...a) => require('./users').switchUser(...a),
  removeUser:  (...a) => require('./users').removeUser(...a),
  listUsers:   (...a) => require('./users').listUsers(...a),
  // Expose raw paths for callers that need the actual file path
  get ASANA_CONFIG_FILE()  { return P.asanaConfig; },
  get ASANA_AUTH_STATE()   { return P.asanaAuthState; },
  ASANA_BASE_URL,
};
