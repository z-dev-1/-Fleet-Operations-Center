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

function getToken() {
  return process.env.ASANA_PAT || loadConfig().pat || null;
}

// ── API REQUEST ───────────────────────────────────────────────────────────────
function apiRequest(endpoint, method, body) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) {
      reject(new Error('No Asana PAT configured. Set ASANA_PAT env var or configure in Settings.'));
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
  while (nextPage) {
    const raw = await new Promise((resolve, reject) => {
      const token = getToken();
      if (!token) { reject(new Error('No Asana PAT')); return; }
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
  loadConfig, saveConfig, getToken, checkAuth, hasStorageState,
  getMe, getWorkspaces, getProjects, getTasks, getTask, getTaskStories,
  createTask, updateTask, addComment, searchTasks, getSections, moveTaskToSection,
  apiRequest, apiPaginate,
  // Expose raw paths for callers that need the actual file path
  get ASANA_CONFIG_FILE()  { return P.asanaConfig; },
  get ASANA_AUTH_STATE()   { return P.asanaAuthState; },
  ASANA_BASE_URL,
};
