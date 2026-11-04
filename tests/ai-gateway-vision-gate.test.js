// tests/ai-gateway-vision-gate.test.js — bedrock.readFileWithVision runs inside
// relay's slot gate (relay.runInSlot) when ai.gateway.priorities is on.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-vision-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const bedrock = require('../src/scrapers/bedrock');
const trace = require('../src/ai/trace');
const { flush, installFakeFleetBrain, baseRelaySetup, makeFakeProc } = require('./helpers/ai-gateway-fakes.cjs');

const T = relay.__test__;
const PNG = { name: 'shot.png', mimetype: 'image/png', buffer: Buffer.from([1, 2, 3]) };
let calls, spawnInfo;
function fakeVisionSpawn() {
  spawnInfo = [];
  bedrock.__test__.setBinExists(() => true);
  bedrock.__test__.setSpawn(() => {
    const p = makeFakeProc(vi);
    spawnInfo.push({ activeAtSpawn: relay.queueStats().active });
    setTimeout(() => p.result('UNIT 320160 at ABE40'), 0);
    return p;
  });
}
async function fill5() { const ps = []; for (let i = 0; i < 5; i++) { const p = relay.ask('f' + i); p.catch(() => {}); ps.push(p); } await flush(); return ps; }
async function freeAll() { for (let i = 0; i < 10; i++) { calls.filter((c) => !c.settled).forEach((c) => c.ok('ok')); await flush(); } }

beforeEach(() => {
  baseRelaySetup(relay);
  calls = installFakeFleetBrain(vi, fleetBrain);
  fakeVisionSpawn();
  trace._resetGatewayForTests();
});
afterEach(async () => {
  await freeAll();
  bedrock.__test__.setSpawn(null);
  bedrock.__test__.setBinExists(null);
  T.setGatewayFlags(null);
  expect(T.reset()).toBe(0);
  vi.restoreAllMocks();
});

it('runInSlot flag on: waits while 5 slots are busy, holds a slot while running, releases after, records', async () => {
  T.setGatewayFlags({ priorities: true });
  await fill5();
  let ran = false;
  const p = relay.runInSlot(async () => { ran = true; return { ok: true }; }, { source: 'vision_image' });
  await flush();
  expect(ran).toBe(false);
  calls[0].ok('x');
  await p;
  expect(ran).toBe(true);
  expect(trace.gatewayRecent(1)[0]).toMatchObject({ via: 'vision', outcome: 'ok', source: 'vision_image' });
});

it('validation failures return without touching the gate', async () => {
  T.setGatewayFlags({ priorities: true });
  const spy = vi.spyOn(relay, 'runInSlot');
  expect(await bedrock.readFileWithVision({ name: 'x.png', buffer: Buffer.alloc(0) })).toMatchObject({ ok: false, error: 'no file bytes' });
  expect((await bedrock.readFileWithVision({ name: 'x.zip', mimetype: 'application/zip', buffer: Buffer.from([1]) })).ok).toBe(false);
  bedrock.__test__.setBinExists(() => false);
  expect(await bedrock.readFileWithVision(PNG)).toMatchObject({ ok: false, error: 'claude-code not installed' });
  expect(spy).not.toHaveBeenCalled();
});

it('valid png: slot held during the spawn; temp dir only created after the grant', async () => {
  T.setGatewayFlags({ priorities: true });
  const mk = vi.spyOn(fs, 'mkdtempSync');
  await fill5();
  const p = bedrock.readFileWithVision(PNG, { source: 'vision_image' });
  await flush();
  expect(mk).not.toHaveBeenCalled();
  calls[0].ok('x');
  const res = await p;
  expect(res).toMatchObject({ ok: true, kind: 'image', text: 'UNIT 320160 at ABE40' });
  expect(mk).toHaveBeenCalledTimes(1);
  expect(spawnInfo[0].activeAtSpawn).toBe(5); // 4 fills + this vision read
});

it('flag off: runs ungated (no slot), same result', async () => {
  T.setGatewayFlags({});
  const res = await bedrock.readFileWithVision(PNG);
  expect(res.ok).toBe(true);
  expect(spawnInfo[0].activeAtSpawn).toBe(0);
});

it('gate error mapping: abort while queued -> { ok:false, "vision gate: Aborted while queued" }', async () => {
  T.setGatewayFlags({ priorities: true, abortOnTimeout: true });
  await fill5();
  const ac = new AbortController();
  const p = bedrock.readFileWithVision(PNG, { signal: ac.signal });
  await flush();
  ac.abort();
  expect(await p).toEqual({ ok: false, kind: 'image', error: 'vision gate: Aborted while queued' });
});

it.each([[{}], [{ priorities: true, abortOnTimeout: true }]])('mkdtempSync throwing still rejects (flags %j)', async (flags) => {
  T.setGatewayFlags(flags);
  vi.spyOn(fs, 'mkdtempSync').mockImplementation(() => { throw new Error('EPERM tmp'); });
  await expect(bedrock.readFileWithVision(PNG)).rejects.toThrow('EPERM tmp');
  expect(relay.queueStats().active).toBe(0);
});
