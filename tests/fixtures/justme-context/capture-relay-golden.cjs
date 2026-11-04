'use strict';
// Captures the exact claude pool spawn args + spawn options from relay.js
// (non-isolated path) with no model and with model 'm1'. Output:
//   tests/fixtures/justme-context/claude-pool-args.golden.json
// Run with `node <this file>`; it rewrites the golden deterministically.
// The golden was captured from the UNMODIFIED relay.js (base f839cd2), so any
// later relay change that alters non-isolated spawns fails the lane parity test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmp = path.join(os.tmpdir(), 'jmctx-golden-' + process.pid);
fs.mkdirSync(tmp, { recursive: true });
require('../../../src/config/paths').setDataDir(tmp);
const relay = require('../../../src/orcha/relay');
const T = relay.__test__;

function fakeProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = { write() {}, end() {} };
  p.pid = 4242;
  p.killed = false;
  p.kill = () => { p.killed = true; };
  return p;
}

function capture(model) {
  let seen = null;
  T.reset();
  relay.setClaudeModel(model);
  T.setClaudeBinExists(() => true);
  T.setKillTree(() => {});
  T.setSpawn((bin, args, options) => {
    seen = { binIsClaude: /claude(\.exe)?$/i.test(String(bin)), args: JSON.parse(JSON.stringify(args)), options: JSON.parse(JSON.stringify(options)) };
    return fakeProc();
  });
  const p = T.tryClaudeCode('x');
  p.catch(() => {});
  return seen;
}

const out = { noModel: capture(''), model_m1: capture('m1') };
relay.setClaudeModel('');
T.reset();
fs.rmSync(tmp, { recursive: true, force: true });

const target = path.join(__dirname, 'claude-pool-args.golden.json');
fs.writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log('wrote ' + target);
process.exit(0);
