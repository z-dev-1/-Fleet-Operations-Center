'use strict';
/**
 * workers/isolation/spawn.js — process spawners for worker hosts.
 *
 *  - defaultSpawner(spec, deps)  production: electron.utilityProcess.fork. The
 *    ONLY place `electron` is required for isolation, and only when called
 *    (review N2: deps.electron is the smoke-test seam, as in extract-host.js).
 *  - nodeForkSpawner(spec)       tests/benchmark: child_process.fork with the
 *    same minimal env and execArgv, adapted to the same child surface
 *    { pid, postMessage(m), on, once, removeListener, kill() }.
 *
 * Both deliver the raw message object on the child's 'message' event.
 */

const os = require('os');

/** Minimal environment for a worker (copied from extract-host.js workerEnv). */
function workerEnv(env) {
  const e = env || process.env;
  const raw = {
    NODE_ENV: e.NODE_ENV || 'production',
    SystemRoot: e.SystemRoot || e.SYSTEMROOT,
    windir: e.windir || e.WINDIR,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  const out = {};
  for (const k of Object.keys(raw)) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function forkOptions(spec) {
  return {
    serviceName: spec.serviceName,
    execArgv: ['--max-old-space-size=' + spec.heapMb],
    stdio: 'ignore',
    partition: 'fleet-worker-' + spec.group,
    env: workerEnv(),
  };
}

/** defaultSpawner(spec, deps = {}) → Electron UtilityProcess. */
function defaultSpawner(spec, deps = {}) {
  const electron = (deps && deps.electron) || require('electron');
  return electron.utilityProcess.fork(spec.file, [], forkOptions(spec));
}

/** defaultGetChildRss(pid, deps) → working-set bytes | undefined (as extract-host._defaultGetChildRss). */
function defaultGetChildRss(pid, deps = {}) {
  try {
    const electron = (deps && deps.electron) || require('electron');
    const m = electron.app.getAppMetrics().find((x) => x.pid === pid);
    return m && m.memory ? m.memory.workingSetSize * 1024 : undefined;   // KB -> bytes
  } catch (_) { return undefined; }
}

/** nodeForkSpawner(spec) → ChildProcess adapted with postMessage(). */
function nodeForkSpawner(spec) {
  const env = workerEnv();
  if (process.versions && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const c = require('child_process').fork(spec.file, [], {
    execPath: process.execPath,
    execArgv: ['--max-old-space-size=' + spec.heapMb],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env,
    windowsHide: true,
  });
  c.postMessage = (m) => {
    if (!c.connected) throw new Error('worker channel closed');
    c.send(m);
  };
  return c;
}

module.exports = { workerEnv, forkOptions, defaultSpawner, defaultGetChildRss, nodeForkSpawner };
