'use strict';
// Shared fakes for the Phase 3 AI gateway tests. No real AI / socket / process.
const { EventEmitter } = require('events');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Drain pending microtasks (relay.ask has several awaits before the transport).
async function flush(n = 40) { for (let i = 0; i < n; i++) await Promise.resolve(); }

// Fake fleet-brain transport: every ask() returns a controllable deferred that
// rejects 'Aborted by caller' when its signal aborts (like the real one).
function installFakeFleetBrain(vi, fleetBrain, opts = {}) {
  const calls = [];
  vi.spyOn(fleetBrain, 'getStatus').mockReturnValue(Object.assign({ ready: true, connected: true, localMode: false }, opts.status || {}));
  vi.spyOn(fleetBrain, 'ask').mockImplementation((prompt, o) => {
    const d = deferred();
    d.prompt = prompt;
    d.opts = o;
    d.settled = false;
    const done = (fn) => (v) => { if (d.settled) return; d.settled = true; fn(v); };
    d.ok = done(d.resolve);
    d.fail = done(d.reject);
    // Rejects synchronously inside the abort event, like the real transport.
    if (o && o.signal) o.signal.addEventListener('abort', () => d.fail(new Error('Aborted by caller')), { once: true });
    calls.push(d);
    return d.promise;
  });
  return calls;
}

// Fake claude child process: stdout/stderr emitters, stdin.write spy.
let _pid = 1000;
function makeFakeProc(vi) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = ++_pid;
  proc.killed = false;
  proc.kill = vi.fn(() => { proc.killed = true; });
  proc.written = () => proc.stdin.write.mock.calls.map((c) => { try { return JSON.parse(c[0]).message.content; } catch (_) { return null; } });
  proc.result = (text) => proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: text }) + '\n'));
  return proc;
}

function baseRelaySetup(relay) {
  relay.setPreference('auto');
  relay.__test__.setTryWS(() => Promise.reject(new Error('no ws (test)')));
  relay.__test__.setClaudeBinExists(() => false);
  relay.__test__.setSpawn(() => { throw new Error('spawn not allowed in tests'); });
  relay.__test__.setKillTree(() => {});
  relay.__test__.setBedrockEnabled(false);
}

const GW_OFF = { priorities: false, abortOnTimeout: false, dedupe: false, routerDecides: false, reserveSlots: 2 };

module.exports = { deferred, flush, installFakeFleetBrain, makeFakeProc, baseRelaySetup, GW_OFF };
