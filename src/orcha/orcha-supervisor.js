'use strict';
/**
 * orcha-supervisor.js — keep exactly ONE background Orcha agent alive.
 *
 * Why: the old headless CLI fallback (`orcha.cmd --headless`) launched a full
 * extra Orcha (Orcha.exe + its own orcha-daemon) on every failed request, and
 * on timeout only the cmd.exe wrapper was killed. The extra copies' daemons
 * then fought over port 4799, each "reclaiming" (killing) the other's agent —
 * which is what kept dropping the fleet-brain WebSocket mid-request.
 *
 * What this does instead:
 *   - If something already answers on the Orcha port → do nothing.
 *   - If ANY Orcha process (agent / daemon / Orcha.exe) is alive → do nothing;
 *     it is booting or being supervised already (boot can take 1–2 min).
 *   - Otherwise start ONE hidden, detached `orcha-agent.exe --no-auth --port N`
 *     (the same command Orcha's own daemon uses), at most once per cooldown.
 * Never kills anything.
 */

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const net    = require('net');
const { spawn, execFile } = require('child_process');
const logger = require('../utils/logger')('orcha-supervisor');

const ORCHA_TOOLS_DIR   = path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'tools', 'orcha');
const CHECK_THROTTLE_MS = 60 * 1000;      // don't re-check more than once a minute
const SPAWN_COOLDOWN_MS = 5 * 60 * 1000;  // never spawn more than once per 5 min
const PORT_PROBE_MS     = 1500;
const PROC_RE           = /^(orcha-agent|orcha-daemon|orcha-web-daemon|orcha)\.exe$/i;

let _lastCheck = 0;
let _lastSpawn = 0;
let _checking  = null;

function _cmpVer(a, b) {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Newest installed orcha-agent.exe, or null. */
function findAgentExe(toolsDir = ORCHA_TOOLS_DIR) {
  try {
    const vers = fs.readdirSync(toolsDir).filter(v => /^\d+(\.\d+)*$/.test(v)).sort(_cmpVer).reverse();
    for (const v of vers) {
      const exe = path.join(toolsDir, v, 'resources', 'agent', 'orcha-agent.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch (_) {}
  return null;
}

function _portOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { sock.destroy(); } catch (_) {} resolve(ok); };
    sock.setTimeout(PORT_PROBE_MS, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function _orchaProcs() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/fo', 'csv', '/nh'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null); // unknown → caller must NOT spawn
      const names = [];
      String(out).split(/\r?\n/).forEach((l) => {
        const m = l.match(/^"([^"]+)"/);
        if (m && PROC_RE.test(m[1])) names.push(m[1]);
      });
      resolve(names);
    });
  });
}

async function _check(port, deps) {
  if (await deps.portOpen(port)) return 'running';
  const procs = await deps.orchaProcs();
  if (procs === null) return 'unknown-procs';
  if (procs.length) {
    logger.info('Orcha port ' + port + ' not answering yet but ' + procs.length + ' Orcha process(es) alive (' + [...new Set(procs)].join(', ') + ') — waiting, not spawning');
    return 'booting';
  }
  if (Date.now() - _lastSpawn < SPAWN_COOLDOWN_MS) return 'cooldown';
  const exe = deps.findAgentExe();
  if (!exe) { logger.warn('Orcha not installed (no orcha-agent.exe under ' + ORCHA_TOOLS_DIR + ')'); return 'not-installed'; }
  _lastSpawn = Date.now();
  try {
    const child = deps.spawn(exe, ['--no-auth', '--port', String(port)], {
      detached: true, stdio: 'ignore', windowsHide: true, cwd: os.homedir(),
    });
    if (child && child.unref) child.unref();
    logger.info('No Orcha running — started one background agent (pid ' + (child && child.pid) + ') on port ' + port);
    return 'spawned';
  } catch (e) {
    logger.warn('Failed to start Orcha agent: ' + e.message);
    return 'spawn-failed';
  }
}

/**
 * ensureRunning(port) — throttled, single-flight. Safe to call often
 * (e.g. on every WS connect failure). Resolves to a status string.
 */
function ensureRunning(port = 4799, opts = {}) {
  if (process.platform !== 'win32' && !opts.deps) return Promise.resolve('unsupported-platform');
  if (_checking) return _checking;
  if (!opts.force && Date.now() - _lastCheck < CHECK_THROTTLE_MS) return Promise.resolve('throttled');
  _lastCheck = Date.now();
  const deps = Object.assign({ portOpen: _portOpen, orchaProcs: _orchaProcs, findAgentExe, spawn }, opts.deps || {});
  _checking = _check(port, deps)
    .catch((e) => { logger.warn('ensureRunning error: ' + e.message); return 'error'; })
    .finally(() => { _checking = null; });
  return _checking;
}

function _resetForTests() { _lastCheck = 0; _lastSpawn = 0; _checking = null; }

module.exports = { ensureRunning, findAgentExe, _resetForTests };
