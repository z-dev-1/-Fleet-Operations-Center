'use strict';
// Shared helpers for the Just Me context tests: fixture paths, a real extraction
// worker under plain Node (child_process.fork, advanced serialization), and a fake
// worker child for host unit tests.
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { EventEmitter } = require('events');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'justme-context');
const fx = (name) => fs.readFileSync(path.join(FIXTURES, name));

// Same worker file as production; same V8 heap cap as the utilityProcess execArgv.
function spawnRealWorker(file) {
  return fork(file, [], { execArgv: ['--max-old-space-size=512'], serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}
function spawnLoopWorker() {
  return fork(path.join(FIXTURES, 'loop-worker.cjs'), [], { serialization: 'advanced', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

function makeLogger(vi) {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}
const allLogged = (logger) => ['info', 'warn', 'error', 'debug'].flatMap((k) => logger[k].mock.calls.map((c) => c.join(' '))).join('\n');

// Fake utilityProcess-like child. `onPost(msg, child)` decides what to do with a job.
function makeFakeChild(vi, onPost) {
  const c = new EventEmitter();
  c.pid = 4242;
  c.posted = [];
  c.postMessage = vi.fn((m) => { c.posted.push(m); if (onPost) onPost(m, c); });
  c.kill = vi.fn(() => { setImmediate(() => c.emit('exit', 1)); return true; });
  c.reply = (m) => c.emit('message', m);
  return c;
}
const okReply = (m, extra) => Object.assign({ id: m.id, ok: true, kind: 'text', text: 'hello', truncated: false }, extra || {});

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }

module.exports = { FIXTURES, fx, spawnRealWorker, spawnLoopWorker, makeLogger, allLogged, makeFakeChild, okReply, pidAlive };
