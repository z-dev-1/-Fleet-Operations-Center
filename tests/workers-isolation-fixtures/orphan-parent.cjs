'use strict';
// Node parent that forks the real canonical worker, then exits WITHOUT any
// cleanup, so the worker's own watchdogs must end it (review M2).
//   default:    send a valid init, wait for hello, print "PID <pid>", exit(0)
//   --no-init:  print "PID <pid>" right after fork and exit(0) (pre-init watchdog)
const path = require('path');
const { fork } = require('child_process');

const entry = path.join(__dirname, '..', '..', 'src', 'workers', 'isolation', 'entries', 'canonical-worker.js');
const noInit = process.argv.includes('--no-init');
const c = fork(entry, [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });

function done() { process.stdout.write('PID ' + c.pid + '\n', () => process.exit(0)); }

if (noInit) {
  done();
} else {
  c.on('message', (m) => { if (m && m.t === 'hello') done(); });
  c.send({ t: 'init', v: 1, group: 'canonical', parentPid: process.pid, ppidPollMs: 2000, maxLogPerMin: 50, workerSilenceExitMs: 45000, diag: false });
  setTimeout(() => process.exit(2), 15000).unref();
}
