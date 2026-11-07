// tests/relay-preference-parity.test.js — golden behavior of the legacy AI
// preferences (auto / orcha / claude / balanced) after the N-lane router and
// the _orchaCascade extraction (FEAT-002). The Aki lane is installed with fake
// deps and its flags ON in every test to prove old modes never reach it.
// No real AI / socket / process.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'relay-parity-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, makeFakeProc, baseRelaySetup, installFakeFleetBrain, GW_OFF } = require('./helpers/ai-gateway-fakes.cjs');
const T = relay.__test__;

let ccProcs, akiSpawns, fbCalls;
function setup() {
  baseRelaySetup(relay);
  T.setGatewayFlags(GW_OFF);
  ccProcs = [];
  akiSpawns = [];
  T.setClaudeBinExists(() => true);
  T.setSpawn(() => { const p = makeFakeProc(vi); ccProcs.push(p); return p; });
  T.setAkiFlags({ enabled: true, allowUntrusted: true });
  T.setAkiLaneDeps({
    spawn: (bin, args) => {
      akiSpawns.push(args);
      const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.pid = 1; p.kill = () => {};
      return p;
    },
    killTree: () => {}, resolveBin: () => 'C:\\fake\\Aki\\Aki.exe', mkdirSync: () => {}, tmpdir: () => os.tmpdir(),
    platform: 'win32', env: {}, logger: { info() {}, warn() {} },
  });
  fbCalls = installFakeFleetBrain(vi, fleetBrain);
}
function ask(prompt, o) {
  const out = { rec: null };
  out.p = relay.ask(prompt, Object.assign({ __gwOnRecord: (r) => { out.rec = r; } }, o || {}));
  out.p.catch(() => {});
  return out;
}

beforeEach(() => { setup(); });
afterEach(() => {
  T.setAkiFlags(null);
  T.setAkiLaneDeps(null);
  T.setGatewayFlags(null);
  T.reset();
  relay.setPreference('auto');
  fleetBrain.__test__.reset();
  fleetBrain.setLocalAskFn((p, o) => T.localAskFn(p, o));
  vi.restoreAllMocks();
});

describe('setPreference / VALID_PREFERENCES', () => {
  it('exports the 8 preferences and maps unknown values to auto', () => {
    expect(relay.VALID_PREFERENCES).toEqual(['auto', 'orcha', 'claude', 'balanced', 'balanced3', 'aki', 'aki-orcha', 'aki-claude']);
    for (const p of relay.VALID_PREFERENCES) { relay.setPreference(p); expect(relay.getPreference()).toBe(p); }
    relay.setPreference('nope'); expect(relay.getPreference()).toBe('auto');
    relay.setPreference(undefined); expect(relay.getPreference()).toBe('auto');
  });
});

describe("preference 'claude' (unchanged)", () => {
  it('success -> via claude-code, no fleet-brain', async () => {
    relay.setPreference('claude');
    const r = ask('q');
    await flush();
    expect(ccProcs).toHaveLength(1);
    ccProcs[0].result('cc-answer');
    expect(await r.p).toBe('cc-answer');
    expect(r.rec.via).toBe('claude-code');
    expect(fbCalls).toHaveLength(0);
    expect(akiSpawns).toHaveLength(0);
    expect(relay.getStatus().status).toBe('connected-claude');
  });
  it('failure -> throws Claude Code unavailable, no fallback', async () => {
    relay.setPreference('claude');
    const r = ask('q');
    await flush();
    ccProcs[0].emit('exit', 1);
    await expect(r.p).rejects.toThrow('Claude Code unavailable (preference=claude)');
    expect(fbCalls).toHaveLength(0);
    expect(ccProcs).toHaveLength(1);
    expect(akiSpawns).toHaveLength(0);
  });
});

describe("preference 'orcha' (unchanged)", () => {
  it('fleet-brain success -> via fleet-brain/ws', async () => {
    relay.setPreference('orcha');
    const r = ask('q');
    await flush();
    expect(fbCalls).toHaveLength(1);
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(r.rec.via).toBe('fleet-brain/ws');
    expect(ccProcs).toHaveLength(0);
    expect(akiSpawns).toHaveLength(0);
  });
  it('fleet-brain failure -> WS; never Claude, never Aki', async () => {
    relay.setPreference('orcha');
    T.setTryWS(() => Promise.resolve('ws-text'));
    const r = ask('q');
    await flush();
    fbCalls[0].fail(new Error('boom'));
    expect(await r.p).toBe('ws-text');
    expect(r.rec.via).toBe('ws');
    expect(ccProcs).toHaveLength(0);
    expect(akiSpawns).toHaveLength(0);
  });
});

describe("preference 'auto' (unchanged)", () => {
  it('fleet-brain down -> WS (none) -> Claude Code', async () => {
    const r = ask('q');
    await flush();
    fbCalls[0].fail(new Error('boom'));
    await flush();
    expect(ccProcs).toHaveLength(1);
    ccProcs[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');
    expect(akiSpawns).toHaveLength(0);
  });
});

describe("preference 'balanced' (unchanged)", () => {
  it('_pickLane truth table (== pickLaneN([orcha, claude]))', () => {
    const both = () => [T.pickLane(), T.pickLaneN(['orcha', 'claude'])];
    expect(both()).toEqual(['orcha', 'orcha']);            // both healthy, idle -> Orcha
    T.setLaneBusy('orcha', 2); T.setLaneBusy('claude', 1);
    expect(both()).toEqual(['claude', 'claude']);          // claudeBusy < orchaBusy
    T.setLaneBusy('claude', 2);
    expect(both()).toEqual(['orcha', 'orcha']);            // tie -> Orcha
    T.setLaneBusy('orcha', 0); T.setLaneBusy('claude', 0);
    T.markLaneDown('orcha');
    expect(both()).toEqual(['claude', 'claude']);          // Orcha down -> Claude
    T.reset();
    T.markLaneDown('claude');
    expect(both()).toEqual(['orcha', 'orcha']);            // Claude down -> Orcha
    T.markLaneDown('orcha');
    expect(both()).toEqual(['orcha', 'orcha']);            // both down -> Orcha
  });
  it('Orcha lane -> fleet-brain, busy counter released', async () => {
    relay.setPreference('balanced');
    const r = ask('q');
    await flush();
    expect(T.laneState().orchaBusy).toBe(1);
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(T.laneState().orchaBusy).toBe(0);
    expect(akiSpawns).toHaveLength(0);
  });
  it('Claude lane success -> via balanced/claude', async () => {
    relay.setPreference('balanced');
    T.setLaneBusy('orcha', 1);
    const r = ask('q');
    await flush();
    ccProcs[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('balanced/claude');
    expect(fbCalls).toHaveLength(0);
  });
  it('Claude lane failure -> marks Claude down and falls into the cascade', async () => {
    relay.setPreference('balanced');
    T.setLaneBusy('orcha', 1);
    const r = ask('q');
    await flush();
    ccProcs[0].emit('exit', 1);
    await flush();
    expect(fbCalls).toHaveLength(1);
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(r.rec.via).toBe('fleet-brain/ws');
    expect(T.laneState().downUntil.claude).toBeGreaterThan(0);
    expect(T.laneState().claudeBusy).toBe(0);
    expect(akiSpawns).toHaveLength(0);
  });
});

describe('legacy modes never reach Aki (flags on, allowUntrusted on)', () => {
  for (const pref of ['auto', 'orcha', 'claude', 'balanced']) {
    it(pref + ': isolated request -> exactly one tool-less Claude spawn', async () => {
      relay.setPreference(pref);
      const r = ask('secret mail', { isolated: true });
      await flush();
      expect(ccProcs).toHaveLength(1);
      ccProcs[0].result('iso');
      expect(await r.p).toBe('iso');
      expect(r.rec.via).toBe('claude-code/isolated');
      expect(akiSpawns).toHaveLength(0);
      expect(fbCalls).toHaveLength(0);
      expect(relay.getStatus().backends.aki).toBe(false);
      expect(relay.queueStats().akiLane.active).toBe(false);
    });
  }
  it('isolatedLaneAvailable unchanged in legacy modes (claude binary only)', () => {
    T.setClaudeBinExists(() => false);
    for (const pref of ['auto', 'orcha', 'claude', 'balanced']) {
      relay.setPreference(pref);
      expect(relay.isolatedLaneAvailable()).toBe(false);
    }
    T.setClaudeBinExists(() => true);
    expect(relay.isolatedLaneAvailable()).toBe(true);
  });
});
