'use strict';
/**
 * asana/users.js — multi-user PAT manager for Asana.
 *
 * Each teammate adds their own Personal Access Token (PAT). We:
 *   - store the PAT ENCRYPTED via security/credentials.js (key: asana.pat.<alias>)
 *   - auto-discover their identity + IDs via /users/me and /user_task_list
 *   - keep only NON-SECRET metadata (name, email, userGid, workspaceGid,
 *     taskListGid) + the active alias in the asanaConfig store.
 *
 * The active user's PAT is what the Asana client authenticates with
 * (client.resolveToken() -> getActiveToken()).
 *
 * SECURITY: PAT values never leave the main process. listUsers()/status()
 * return only metadata, never a token.
 */

const https  = require('https');
const store  = require('../store');
const creds  = require('../security/credentials');
const logger = require('../utils/logger')('asana:users');

const ASANA_API_BASE = 'https://app.asana.com/api/1.0';
const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;

const _patKey = (alias) => 'asana.pat.' + alias;

// ── Metadata store (non-secret) ────────────────────────────────────────────────
// Shape: { authMode:'pat', defaults:{workspaceGid,requestLimit}, workspace,
//          project, activeAlias, users:{ alias:{name,email,userGid,
//          workspaceGid,taskListGid,addedAt} } }
function _cfg() {
  const c = store.load('asanaConfig', {}) || {};
  if (!c.users) c.users = {};
  return c;
}
function _save(c) { store.save('asanaConfig', c); }

// ── Low-level authed GET against the Asana API using a specific PAT ────────────
function _apiGet(endpoint, pat) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint.startsWith('http') ? endpoint : ASANA_API_BASE + endpoint);
    const opts = {
      hostname: url.hostname, port: 443,
      path: url.pathname + url.search, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + pat, 'Accept': 'application/json' },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (e) { reject(new Error('Asana parse error: ' + e.message)); return; }
        if (res.statusCode >= 400) {
          const msg = (parsed.errors && parsed.errors.map((x) => x.message).join(', ')) || ('HTTP ' + res.statusCode);
          reject(new Error('Asana API ' + res.statusCode + ': ' + msg));
        } else {
          resolve(parsed.data !== undefined ? parsed.data : parsed);
        }
      });
    });
    req.on('error', (e) => reject(new Error('Asana API network error: ' + e.message)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Asana API timeout (30s)')); });
    req.end();
  });
}

// ── setupUser(alias, pat): validate PAT, auto-discover IDs, store encrypted ────
async function setupUser(alias, pat) {
  if (!ALIAS_RE.test(String(alias || ''))) {
    throw new Error('Invalid alias (allowed: A-Z a-z 0-9 . _ - , max 64)');
  }
  if (!pat || typeof pat !== 'string') throw new Error('A Personal Access Token is required');

  // 1. Who is this? (validates the PAT at the same time)
  const me = await _apiGet('/users/me', pat);
  if (!me || !me.gid) throw new Error('Could not resolve Asana user from that PAT');

  // 2. Pick the workspace: prefer the configured default, else the first.
  const cfg = _cfg();
  const defWs = (cfg.defaults && cfg.defaults.workspaceGid) || '';
  const workspaces = Array.isArray(me.workspaces) ? me.workspaces : [];
  const workspace = workspaces.find((w) => w.gid === defWs) || workspaces[0] || null;
  const workspaceGid = (workspace && workspace.gid) || defWs || '';

  // 3. The user's "My Tasks" list for that workspace (best-effort).
  let taskListGid = '';
  if (workspaceGid) {
    try {
      const tl = await _apiGet('/users/' + me.gid + '/user_task_list?workspace=' + workspaceGid, pat);
      taskListGid = (tl && tl.gid) || '';
    } catch (e) {
      logger.warn('user_task_list lookup failed for ' + alias + ': ' + e.message);
    }
  }

  // 4. Persist: PAT encrypted, metadata in the store.
  await creds.set(_patKey(alias), pat);
  cfg.users[alias] = {
    name: me.name || alias,
    email: me.email || '',
    userGid: me.gid,
    workspaceGid,
    taskListGid,
    addedAt: new Date().toISOString(),
  };
  cfg.activeAlias = alias;
  cfg.authMode = 'pat';
  _save(cfg);

  logger.info('Asana user set up: ' + (me.name || alias) + ' (' + alias + ') ws=' + workspaceGid + ' tl=' + taskListGid);
  return { ok: true, alias, name: me.name, email: me.email, userGid: me.gid, workspaceGid, taskListGid };
}

function switchUser(alias) {
  const cfg = _cfg();
  if (!cfg.users[alias]) throw new Error('Asana user "' + alias + '" not configured');
  cfg.activeAlias = alias;
  _save(cfg);
  logger.info('Asana active user -> ' + alias);
  return { ok: true, activeAlias: alias };
}

async function removeUser(alias) {
  const cfg = _cfg();
  try { await creds.delete(_patKey(alias)); } catch (_) {}
  delete cfg.users[alias];
  if (cfg.activeAlias === alias) {
    const remaining = Object.keys(cfg.users);
    cfg.activeAlias = remaining.length ? remaining[0] : null;
  }
  _save(cfg);
  logger.info('Asana user removed: ' + alias);
  return { ok: true, activeAlias: cfg.activeAlias || null };
}

/** listUsers(): metadata only, never a PAT. */
function listUsers() {
  const cfg = _cfg();
  const users = Object.entries(cfg.users).map(([alias, d]) => ({
    alias,
    name: d.name || alias,
    email: d.email || '',
    userGid: d.userGid || '',
    workspaceGid: d.workspaceGid || '',
    taskListGid: d.taskListGid || '',
    active: alias === cfg.activeAlias,
  }));
  return { ok: true, activeAlias: cfg.activeAlias || null, users };
}

/** The active user's config (metadata), or null. */
function getActiveUser() {
  const cfg = _cfg();
  const alias = cfg.activeAlias;
  if (!alias || !cfg.users[alias]) return null;
  return Object.assign({ alias }, cfg.users[alias]);
}

/** The active user's PAT (decrypted). null if none. Main-process only. */
async function getActiveToken() {
  const cfg = _cfg();
  const alias = cfg.activeAlias;
  if (!alias) return null;
  return await creds.get(_patKey(alias));
}

module.exports = {
  setupUser,
  switchUser,
  removeUser,
  listUsers,
  getActiveUser,
  getActiveToken,
};
