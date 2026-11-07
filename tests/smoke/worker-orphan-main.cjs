'use strict';
// tests/smoke/worker-orphan-main.cjs — child Electron app for the worker smoke (design §11.4
// steps 6–8). Wires the supervisor + isolation registry the way src/app.js does (flags ON
// here), waits for the canonical worker to be ready, prints its pid, then by --mode:
//   exit          → app.exit(0)
//   relaunch-like → app.emit('before-quit') then app.exit(0) in the same tick (Ctrl+R shape, no relaunch)
//   wait          → stays up until the parent smoke kills it (taskkill /F, no /T)
// userData comes from --user-data=<tmp dir>, so it never touches the real Fleet profile.
const path = require('path');
const { app } = require('electron');

const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : ''; };
const mode = arg('mode');
const userData = arg('user-data');
if (userData) app.setPath('userData', userData);

const ROOT = path.join(__dirname, '..', '..');
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const out = (s) => process.stdout.write(s + '\n');
setTimeout(() => { out('ORPHAN_CHILD_TIMEOUT'); app.exit(4); }, 90000).unref();

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const sup = require(path.join(ROOT, 'src', 'workers', 'supervisor.js'));
  const iso = require(path.join(ROOT, 'src', 'workers', 'isolation', 'index.js'));
  sup.init({ flags: { supervisorEnabled: true, supervised: {} }, logger: quiet });
  iso.init({ flags: { enabled: true, groups: { canonical: true } }, supervisor: sup, logger: quiet, deps: { prewarmMs: 0, workerLogger: () => quiet } });
  app.on('before-quit', () => { try { sup.onBeforeQuit(); } catch (_) { /* ignore */ } });
  app.on('will-quit', () => { try { sup.onWillQuit(); } catch (_) { /* ignore */ } });
  const host = iso.getHost('canonical');
  const end = Date.now() + 20000;
  while ((!host || host.state !== 'ready') && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  if (!host || host.state !== 'ready') { out('ORPHAN_CHILD_NOT_READY ' + (host && host.state)); app.exit(3); return; }
  out('WORKER_PID ' + host.pid + ' MAIN_PID ' + process.pid + ' MODE ' + mode);
  // Give stdout a moment to reach the parent, then act.
  setTimeout(() => {
    if (mode === 'exit') app.exit(0);
    else if (mode === 'relaunch-like') { app.emit('before-quit'); app.exit(0); }
    else setInterval(() => {}, 1000);   // 'wait': killed by the parent
  }, 300);
});
