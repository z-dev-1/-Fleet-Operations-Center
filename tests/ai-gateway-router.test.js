// tests/ai-gateway-router.test.js — router.decide as lane selector only with
// ai.gateway.routerDecides + preference 'auto' + caller-supplied task/routeMessage.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-router-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const router = require('../src/ai/router');
const trace = require('../src/ai/trace');
const { flush, installFakeFleetBrain, baseRelaySetup, makeFakeProc } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
let calls, procs, wsCalls;
const CLASSIFY = { taskType: 'classification' };

function claudeHealthy(answer) {
  procs = [];
  T.setClaudeBinExists(() => true);
  T.setSpawn(() => {
    const p = makeFakeProc(vi); procs.push(p);
    if (answer instanceof Error) setTimeout(() => p.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', is_error: true, result: answer.message }) + '\n')), 0);
    else setTimeout(() => p.result(answer), 0);
    return p;
  });
}

beforeEach(() => {
  baseRelaySetup(relay);
  calls = installFakeFleetBrain(vi, fleetBrain);
  wsCalls = 0;
  T.setTryWS(() => { wsCalls++; return Promise.reject(new Error('no ws')); });
  procs = [];
  trace._resetGatewayForTests();
});
afterEach(async () => {
  for (let i = 0; i < 10; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); }
  relay.setPreference('auto');
  T.setGatewayFlags(null);
  expect(T.reset()).toBe(0);
  vi.restoreAllMocks();
});

it('flag off: fleet-brain first even with a task', async () => {
  T.setGatewayFlags({});
  claudeHealthy('claude');
  const decide = vi.spyOn(router, 'decide');
  const p = relay.ask('q', { task: CLASSIFY });
  await flush();
  expect(calls.length).toBe(1);
  expect(decide).not.toHaveBeenCalled();
  calls[0].ok('fb');
  expect(await p).toBe('fb');
});

it('on + auto + classification + claude healthy -> Claude-first; fleet-brain not called', async () => {
  T.setGatewayFlags({ routerDecides: true });
  claudeHealthy('from-claude');
  const p = relay.ask('q', { task: CLASSIFY, source: 'slack_chime_in_gate' });
  expect(await p).toBe('from-claude');
  expect(calls.length).toBe(0);
  const rec = trace.gatewayRecent(1)[0];
  expect(rec.routedLane).toBe('claude');
  expect(rec.via).toBe('router/claude');
});

it('Claude-first failure falls through to fleet-brain; lane health unchanged by the router branch', async () => {
  T.setGatewayFlags({ routerDecides: true });
  claudeHealthy(new Error('boom'));
  const before = relay.getStatus().backends.claude;
  const p = relay.ask('q', { task: CLASSIFY });
  for (let i = 0; i < 20 && !calls.length; i++) await new Promise((r) => setTimeout(r, 5));
  expect(relay.getStatus().backends.claude).toBe(before);
  expect(calls.length).toBe(1);
  calls[0].ok('fb');
  expect(await p).toBe('fb');
});

it.each(['balanced', 'orcha', 'claude'])('preference %s -> router.decide not called', async (pref) => {
  T.setGatewayFlags({ routerDecides: true });
  claudeHealthy('c');
  relay.setPreference(pref);
  const decide = vi.spyOn(router, 'decide');
  const p = relay.ask('q', { task: CLASSIFY });
  p.catch(() => {});
  await flush();
  for (let i = 0; i < 5; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await new Promise((r) => setTimeout(r, 5)); }
  await p.catch(() => {});
  expect(decide).not.toHaveBeenCalled();
});

it('no task / routeMessage -> router not consulted', async () => {
  T.setGatewayFlags({ routerDecides: true });
  const decide = vi.spyOn(router, 'decide');
  const p = relay.ask('q');
  await flush();
  calls[0].ok('fb');
  await p;
  expect(decide).not.toHaveBeenCalled();
});

it('router.decide throwing -> normal cascade', async () => {
  T.setGatewayFlags({ routerDecides: true });
  vi.spyOn(router, 'decide').mockImplementation(() => { throw new Error('router bug'); });
  const p = relay.ask('q', { task: CLASSIFY });
  await flush();
  calls[0].ok('fb');
  expect(await p).toBe('fb');
});

describe('vision capability: NO_VISION_LANE, no transport called', () => {
  let spawnCalls;
  beforeEach(() => {
    T.setGatewayFlags({ routerDecides: true });
    spawnCalls = 0;
    T.setSpawn(() => { spawnCalls++; throw new Error('no'); });
  });
  async function expectNoVision(opts) {
    await expect(relay.ask('img', opts)).rejects.toMatchObject({ code: 'NO_VISION_LANE' });
    expect(spawnCalls).toBe(0);
    expect(calls.length).toBe(0);
    expect(wsCalls).toBe(0);
    expect(relay.queueStats().active).toBe(0);
    const rec = trace.gatewayRecent(1)[0];
    expect(rec).toMatchObject({ routedLane: 'none', outcome: 'error' });
  }
  it('(a) explicit requiresVision, Claude healthy', async () => {
    T.setClaudeBinExists(() => true);
    await expectNoVision({ task: { requiresVision: true } });
  });
  it('(b) explicit requiresVision, Claude down', async () => {
    T.setClaudeBinExists(() => false);
    await expectNoVision({ task: { requiresVision: true } });
  });
  it('(c) router-inferred vision', async () => {
    vi.spyOn(router, 'decide').mockReturnValue({ effectiveLane: 'claude', task: { requiresVision: true }, rationale: 'x' });
    await expectNoVision({ task: CLASSIFY });
  });
});
