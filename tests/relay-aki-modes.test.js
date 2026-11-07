// tests/relay-aki-modes.test.js — N-lane router for the Aki modes (balanced3,
// aki, aki-orcha, aki-claude), the ai.aki.allowUntrusted gate for isolated
// requests and the Aki stats (FEAT-002, plan.md D3-D5). Fake Aki spawner,
// fake claude pool, fake fleet-brain. Never runs a real aki/claude.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EventEmitter } from 'events';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'relay-aki-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const relay = require('../src/orcha/relay');
const fleetBrain = require('../src/orcha/fleet-brain');
const { flush, makeFakeProc, baseRelaySetup, installFakeFleetBrain, GW_OFF } = require('./helpers/ai-gateway-fakes.cjs');
const { AKI_TRUNC_MARKER } = require('../src/orcha/aki-lane');
const T = relay.__test__;
const SENTINEL = 'SENTINEL-AKI-9c1e';
const AKI_BIN = 'C:\\fake\\Aki\\Aki.exe';
const SLOW = 15000; // tests that exhaust the Orcha lane wait its real 2 s retry sleep

let cc, aki, fbCalls;

function makeAkiProc() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.pid = 4242;
  p.kill = vi.fn();
  p.reply = (text, tools = []) => {
    const lines = tools.map((n) => JSON.stringify({ type: 'tool_use', name: n }))
      .concat([JSON.stringify({ type: 'text_delta', content: text }), JSON.stringify({ type: 'done' })]);
    p.stdout.emit('data', Buffer.from(lines.join('\n') + '\n'));
    p.emit('close', 0);
  };
  p.fail = (code = 1, stderr = '') => { if (stderr) p.stderr.emit('data', Buffer.from(stderr)); p.emit('close', code); };
  return p;
}

function installAki(opts = {}) {
  const st = { procs: [], spawns: [], kill: vi.fn(), logs: [], bin: opts.bin !== false };
  T.setAkiLaneDeps({
    spawn: (bin, args, options) => { const p = makeAkiProc(); st.procs.push(p); st.spawns.push({ bin, args, options }); return p; },
    killTree: st.kill,
    resolveBin: () => (st.bin ? AKI_BIN : null),
    mkdirSync: () => {},
    tmpdir: () => os.tmpdir(),
    platform: 'win32',
    env: {},
    logger: { info: (m) => st.logs.push(m), warn: (m) => st.logs.push(m) },
  });
  return st;
}

function setup() {
  baseRelaySetup(relay);
  T.setGatewayFlags(GW_OFF);
  cc = [];
  T.setClaudeBinExists(() => true);
  T.setSpawn((bin, args) => { const p = makeFakeProc(vi); p.args = args; cc.push(p); return p; });
  T.setAkiFlags({ enabled: true });
  aki = installAki();
  fbCalls = installFakeFleetBrain(vi, fleetBrain);
}

function ask(prompt, o) {
  const out = { rec: null };
  out.p = relay.ask(prompt, Object.assign({ __gwOnRecord: (r) => { out.rec = r; } }, o || {}));
  out.p.catch(() => {});
  return out;
}
// Which transport did the request start on?
function started() {
  return { aki: aki.spawns.length, claude: cc.length, fb: fbCalls.length };
}

beforeEach(() => { setup(); });
afterEach(() => {
  vi.useRealTimers();
  T.setAkiFlags(null);
  T.setAkiLaneDeps(null);
  T.setGatewayFlags(null);
  T.reset();
  relay.setPreference('auto');
  fleetBrain.__test__.reset();
  fleetBrain.setLocalAskFn((p, o) => T.localAskFn(p, o));
  vi.restoreAllMocks();
});

describe('preferences', () => {
  it('setPreference accepts the 4 Aki modes', () => {
    for (const p of ['balanced3', 'aki', 'aki-orcha', 'aki-claude']) { relay.setPreference(p); expect(relay.getPreference()).toBe(p); }
  });
  it('pickLaneN: least busy healthy, ties to set order, Aki needs its binary, none healthy -> set[0]', () => {
    expect(T.pickLaneN(['orcha', 'claude', 'aki'])).toBe('orcha');
    T.setLaneBusy('orcha', 1);
    expect(T.pickLaneN(['orcha', 'claude', 'aki'])).toBe('claude');
    T.setLaneBusy('claude', 1);
    expect(T.pickLaneN(['orcha', 'claude', 'aki'])).toBe('aki');
    T.markLaneDown('aki');
    expect(T.pickLaneN(['orcha', 'claude', 'aki'])).toBe('orcha');
    T.reset();
    expect(T.pickLaneN(['aki', 'orcha'])).toBe('aki');
    aki = installAki({ bin: false });
    expect(T.pickLaneN(['aki', 'orcha'])).toBe('orcha');
    T.markLaneDown('orcha');
    expect(T.pickLaneN(['aki', 'orcha'])).toBe('aki');
  });
});

describe("mode 'aki' (strict)", () => {
  it('success -> via aki, connected-aki, stats counted', async () => {
    relay.setPreference('aki');
    const r = ask('classify this repair');
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 0 });
    expect(aki.spawns[0].bin).toBe(AKI_BIN);
    expect(aki.spawns[0].args[aki.spawns[0].args.length - 1]).toBe('classify this repair');
    expect(T.laneState().akiBusy).toBe(1);
    aki.procs[0].reply('ENGINE', ['Bash', 'Read']);
    expect(await r.p).toBe('ENGINE');
    expect(r.rec.via).toBe('aki');
    expect(r.rec.routedLane).toBe('aki');
    expect(T.laneState().akiBusy).toBe(0);
    expect(relay.getStatus().status).toBe('connected-aki');
    expect(relay.getStatus().backends.aki).toBe(true);
    const s = relay.queueStats().akiLane;
    expect(s).toMatchObject({ calls: 1, ok: 1, failed: 0, toolsUsed: 2, state: 'up', enabled: true, active: true, allowUntrusted: false, busy: 0 });
  });
  it('failure -> throws Aki unavailable and tries nothing else', async () => {
    relay.setPreference('aki');
    const r = ask('q');
    await flush();
    aki.procs[0].fail(1);
    await expect(r.p).rejects.toThrow('Aki unavailable (preference=aki)');
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 0 });
    expect(T.laneState().downUntil.aki).toBeGreaterThan(0);
    expect(relay.getStatus().backends.aki).toBe(false);
    expect(relay.queueStats().akiLane.state).toBe('down');
    expect(relay.getStatus().status).toBe('error');
  });
  it('binary missing -> Aki unavailable without spawning, backends.aki false', async () => {
    aki = installAki({ bin: false });
    relay.setPreference('aki');
    const r = ask('q');
    await expect(r.p).rejects.toThrow('Aki unavailable (preference=aki)');
    expect(started()).toEqual({ aki: 0, claude: 0, fb: 0 });
    expect(relay.getStatus().backends.aki).toBe(false);
    expect(relay.queueStats().akiLane.state).toBe('not-found');
  });
  it('long prompt is truncated with the marker (Aki is the only lane), spawned once', async () => {
    relay.setPreference('aki');
    const r = ask('x'.repeat(40000) + 'TAIL');
    await flush();
    expect(aki.spawns).toHaveLength(1);
    const arg = aki.spawns[0].args[aki.spawns[0].args.length - 1];
    expect(arg.endsWith(AKI_TRUNC_MARKER)).toBe(true);
    expect(arg).not.toContain('TAIL');
    aki.procs[0].reply('ok');
    expect(await r.p).toBe('ok');
  });
  it('kill switch (enabled:false) -> runs the auto cascade', async () => {
    T.setAkiFlags({ enabled: false });
    relay.setPreference('aki');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 0, fb: 1 });
    fbCalls[0].fail(new Error('boom'));
    await flush();
    expect(cc).toHaveLength(1); // the cascade keeps its Claude Code fallback here
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');
    expect(relay.getStatus().backends.aki).toBe(false);
    expect(relay.queueStats().akiLane).toMatchObject({ enabled: false, active: false });
  });
});

describe("mode 'balanced3'", () => {
  it('start lane follows busy counters: orcha -> claude -> aki', async () => {
    relay.setPreference('balanced3');
    let r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 0, fb: 1 });
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(r.rec.routedLane).toBe('orcha');

    T.setLaneBusy('orcha', 1);
    r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 1, fb: 1 });
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');

    T.setLaneBusy('claude', 1);
    r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 1, fb: 1 });
    aki.procs[0].reply('aki');
    expect(await r.p).toBe('aki');
    expect(r.rec.routedLane).toBe('aki');
  });
  it('fallthrough aki -> orcha (no Claude fallback inside) -> claude', async () => {
    relay.setPreference('balanced3');
    T.setLaneBusy('orcha', 1); T.setLaneBusy('claude', 1);
    const r = ask('q');
    await flush();
    aki.procs[0].fail(2);
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 1 });
    fbCalls[0].fail(new Error('boom'));
    await vi.waitFor(() => expect(cc).toHaveLength(1), { timeout: 5000 });
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');
    expect(r.rec.routedLane).toBe('aki');
    expect(T.laneState().downUntil.aki).toBeGreaterThan(0);
    expect(T.laneState().downUntil.orcha).toBeGreaterThan(0);
  }, SLOW);
  it('all lanes fail -> All AI lanes failed (preference=balanced3), no safety net', async () => {
    relay.setPreference('balanced3');
    T.setLaneBusy('orcha', 1);
    const r = ask('q');
    await flush();
    cc[0].emit('exit', 1);           // claude (start)
    await flush();
    fbCalls[0].fail(new Error('x')); // orcha
    await vi.waitFor(() => expect(aki.procs).toHaveLength(1), { timeout: 5000 });
    aki.procs[0].fail(1);            // aki
    await expect(r.p).rejects.toThrow('All AI lanes failed (preference=balanced3)');
    expect(started()).toEqual({ aki: 1, claude: 1, fb: 1 });
    expect(relay.getStatus().status).toBe('error');
  }, SLOW);
  it('kill switch -> orcha/claude only', async () => {
    T.setAkiFlags({ enabled: false });
    relay.setPreference('balanced3');
    T.setLaneBusy('orcha', 2); T.setLaneBusy('claude', 1);
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 1, fb: 0 });
    cc[0].emit('exit', 1);
    await flush();
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(aki.spawns).toHaveLength(0);
  });
});

describe("mode 'aki-orcha'", () => {
  it('idle -> aki first; failure -> orcha', async () => {
    relay.setPreference('aki-orcha');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 0 });
    aki.procs[0].fail(1);
    await flush();
    expect(fbCalls).toHaveLength(1);
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(r.rec.via).toBe('fleet-brain/ws');
    expect(r.rec.routedLane).toBe('aki');
  });
  it('Aki busier -> orcha first', async () => {
    relay.setPreference('aki-orcha');
    T.setLaneBusy('aki', 1);
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 0, fb: 1 });
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(r.rec.routedLane).toBe('orcha');
  });
  it('aki and orcha fail -> Claude Code safety net', async () => {
    relay.setPreference('aki-orcha');
    const r = ask('q');
    await flush();
    aki.procs[0].fail(1);
    await flush();
    fbCalls[0].fail(new Error('x'));
    await vi.waitFor(() => expect(cc).toHaveLength(1), { timeout: 5000 });
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');
  }, SLOW);
  it('kill switch -> orcha, then Claude safety net, never Aki', async () => {
    T.setAkiFlags({ enabled: false });
    relay.setPreference('aki-orcha');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 0, fb: 1 });
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
  });
});

describe("mode 'aki-claude'", () => {
  it('idle -> aki; aki fails -> claude', async () => {
    relay.setPreference('aki-claude');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 0 });
    aki.procs[0].fail(1);
    await flush();
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(r.rec.via).toBe('claude-code');
    expect(fbCalls).toHaveLength(0);
  });
  it('Aki busier -> claude first', async () => {
    relay.setPreference('aki-claude');
    T.setLaneBusy('aki', 1);
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 1, fb: 0 });
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
  });
  it('aki and claude fail -> Orcha safety net', async () => {
    relay.setPreference('aki-claude');
    const r = ask('q');
    await flush();
    aki.procs[0].fail(1);
    await flush();
    cc[0].emit('exit', 1);
    await flush();
    expect(fbCalls).toHaveLength(1);
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(cc).toHaveLength(1); // Orcha lane ran without its in-cascade Claude fallback
  });
  it('everything fails -> All AI lanes failed (preference=aki-claude)', async () => {
    relay.setPreference('aki-claude');
    const r = ask('q');
    await flush();
    aki.procs[0].fail(1);
    await flush();
    cc[0].emit('exit', 1);
    await flush();
    fbCalls[0].fail(new Error('x'));
    await expect(r.p).rejects.toThrow('All AI lanes failed (preference=aki-claude)');
    expect(cc).toHaveLength(1);
  }, SLOW);
  it('too-long prompt -> falls through to claude without marking Aki down', async () => {
    relay.setPreference('aki-claude');
    const r = ask('y'.repeat(40000));
    await flush();
    expect(aki.spawns).toHaveLength(0);
    expect(cc).toHaveLength(1);
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(T.laneState().downUntil.aki).toBe(0);
    expect(relay.queueStats().akiLane.tooLong).toBe(1);
  });
  it('binary missing -> skipped, claude used, Aki not marked down', async () => {
    aki = installAki({ bin: false });
    relay.setPreference('aki-claude');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 1, fb: 0 });
    cc[0].result('cc');
    expect(await r.p).toBe('cc');
    expect(T.laneState().downUntil.aki).toBe(0);
    expect(relay.getStatus().backends.aki).toBe(false);
  });
  it('abort during the Aki lane kills it and tries no other lane', async () => {
    relay.setPreference('aki-claude');
    const ac = new AbortController();
    const r = ask('q', { signal: ac.signal });
    await flush();
    expect(aki.procs).toHaveLength(1);
    ac.abort();
    await expect(r.p).rejects.toThrow();
    expect(aki.kill).toHaveBeenCalledTimes(1);
    await flush();
    expect(started()).toEqual({ aki: 1, claude: 0, fb: 0 });
    expect(T.laneState().akiBusy).toBe(0);
    expect(T.laneState().downUntil.aki).toBe(0);
  });
  it('kill switch -> claude, then Orcha safety net, never Aki', async () => {
    T.setAkiFlags({ enabled: false });
    relay.setPreference('aki-claude');
    const r = ask('q');
    await flush();
    expect(started()).toEqual({ aki: 0, claude: 1, fb: 0 });
    cc[0].emit('exit', 1);
    await flush();
    fbCalls[0].ok('fb');
    expect(await r.p).toBe('fb');
    expect(aki.spawns).toHaveLength(0);
  });
});

describe('Aki lane options', () => {
  it('gw.priorities forwards the rank; off -> null; flags applied via configure', async () => {
    T.setAkiFlags({ enabled: true, concurrency: 3, timeoutMs: 30000, profile: 'fleet', model: 'm1' });
    relay.setPreference('aki');
    const spy = vi.spyOn(T.akiLane(), 'ask');
    const cfg = vi.spyOn(T.akiLane(), 'configure');
    T.setGatewayFlags(Object.assign({}, GW_OFF, { priorities: true }));
    let r = ask('q', { priority: 'high' });
    await flush();
    expect(spy.mock.calls[0][1]).toMatchObject({ rank: 1, isolated: false, onTooLong: 'truncate' });
    expect(cfg.mock.calls[0][0]).toEqual({ concurrency: 3, timeoutMs: 30000, profile: 'fleet', model: 'm1' });
    expect(aki.spawns[0].args.slice(0, 5)).toEqual(['--cli', '--profile', 'fleet', '--model', 'm1']);
    aki.procs[0].reply('a');
    await r.p;
    T.setGatewayFlags(GW_OFF);
    r = ask('q', { priority: 'high' });
    await flush();
    expect(spy.mock.calls[1][1].rank).toBeNull();
    aki.procs[1].reply('b');
    await r.p;
  });
  it('dual / balanced3 modes reject (not truncate) long prompts', async () => {
    relay.setPreference('aki-orcha');
    const spy = vi.spyOn(T.akiLane(), 'ask');
    const r = ask('q');
    await flush();
    expect(spy.mock.calls[0][1].onTooLong).toBe('reject');
    aki.procs[0].reply('a');
    await r.p;
  });
});

describe('isolated requests + ai.aki.allowUntrusted', () => {
  const iso = (prompt) => ask(prompt, { isolated: true });
  it('allowUntrusted false -> exactly today\'s single tool-less Claude spawn (every Aki mode)', async () => {
    for (const pref of ['balanced3', 'aki', 'aki-orcha', 'aki-claude']) {
      relay.setPreference(pref);
      const before = cc.length;
      const r = iso('mail');
      await flush();
      expect(cc.length).toBe(before + 1);
      expect(cc[before].args).toEqual(T.isolatedArgs(''));
      cc[before].result('iso');
      expect(await r.p).toBe('iso');
      expect(r.rec.via).toBe('claude-code/isolated');
    }
    expect(aki.spawns).toHaveLength(0);
    expect(fbCalls).toHaveLength(0);
  });
  it('allowUntrusted true but Aki disabled -> Claude only', async () => {
    T.setAkiFlags({ enabled: false, allowUntrusted: true });
    relay.setPreference('aki');
    const r = iso('mail');
    await flush();
    cc[0].result('iso');
    expect(await r.p).toBe('iso');
    expect(aki.spawns).toHaveLength(0);
  });
  for (const pref of ['aki', 'aki-orcha']) {
    it(pref + ': Aki first, failure -> tool-less Claude; never fleet-brain/WS', async () => {
      T.setAkiFlags({ enabled: true, allowUntrusted: true });
      const ws = vi.fn(() => Promise.resolve('ws'));
      T.setTryWS(ws);
      relay.setPreference(pref);
      let r = iso('mail');
      await flush();
      expect(aki.spawns).toHaveLength(1);
      aki.procs[0].reply('akiiso');
      expect(await r.p).toBe('akiiso');
      expect(r.rec.via).toBe('aki/isolated');
      r = iso('mail2');
      await flush();
      aki.procs[1].fail(1);
      await flush();
      expect(cc).toHaveLength(1);
      expect(cc[0].args).toEqual(T.isolatedArgs(''));
      cc[0].result('cciso');
      expect(await r.p).toBe('cciso');
      expect(r.rec.via).toBe('claude-code/isolated');
      expect(fbCalls).toHaveLength(0);
      expect(ws).not.toHaveBeenCalled();
      expect(T.laneState().downUntil.aki).toBe(0); // no lane-health mutation
    });
  }
  it('aki-claude: least loaded, tie -> Aki', async () => {
    T.setAkiFlags({ enabled: true, allowUntrusted: true });
    relay.setPreference('aki-claude');
    const a = iso('m1');
    await flush();
    expect(aki.spawns).toHaveLength(1);       // tie (0/0) -> Aki
    const b = iso('m2');
    await flush();
    expect(cc).toHaveLength(1);               // Aki load 1 > Claude 0 -> Claude
    aki.procs[0].reply('A'); cc[0].result('B');
    expect(await a.p).toBe('A');
    expect(await b.p).toBe('B');
  });
  it('balanced3: least loaded, tie -> tool-less Claude', async () => {
    T.setAkiFlags({ enabled: true, allowUntrusted: true });
    relay.setPreference('balanced3');
    const a = iso('m1');
    await flush();
    expect(cc).toHaveLength(1);               // tie -> Claude
    const b = iso('m2');
    await flush();
    expect(aki.spawns).toHaveLength(1);       // Claude busy 1 > Aki 0 -> Aki
    cc[0].result('A'); aki.procs[0].reply('B');
    expect(await a.p).toBe('A');
    expect(await b.p).toBe('B');
    expect(fbCalls).toHaveLength(0);
  });
  it('isolatedLaneAvailable matrix', () => {
    T.setClaudeBinExists(() => false);
    relay.setPreference('aki');
    T.setAkiFlags({ enabled: true, allowUntrusted: false });
    expect(relay.isolatedLaneAvailable()).toBe(false);
    T.setAkiFlags({ enabled: true, allowUntrusted: true });
    expect(relay.isolatedLaneAvailable()).toBe(true);
    T.setAkiFlags({ enabled: false, allowUntrusted: true });
    expect(relay.isolatedLaneAvailable()).toBe(false);
    T.setAkiFlags({ enabled: true, allowUntrusted: true });
    relay.setPreference('auto');
    expect(relay.isolatedLaneAvailable()).toBe(false);
    relay.setPreference('aki-claude');
    aki = installAki({ bin: false });
    expect(relay.isolatedLaneAvailable()).toBe(false);
    T.setClaudeBinExists(() => true);
    expect(relay.isolatedLaneAvailable()).toBe(true);
  });
  it('isolated Aki errors and logs never contain the prompt / stderr sentinel', async () => {
    T.setAkiFlags({ enabled: true, allowUntrusted: true });
    T.setClaudeBinExists(() => false);
    relay.setPreference('aki');
    const writes = [];
    const cap = (orig) => function (chunk, ...rest) { writes.push(String(chunk)); return orig.call(this, chunk, ...rest); };
    const ow = process.stdout.write.bind(process.stdout);
    const ew = process.stderr.write.bind(process.stderr);
    const so = vi.spyOn(process.stdout, 'write').mockImplementation(cap(ow));
    const se = vi.spyOn(process.stderr, 'write').mockImplementation(cap(ew));
    const r = iso('summarize ' + SENTINEL);
    await flush();
    expect(aki.spawns).toHaveLength(1);
    aki.procs[0].fail(3, 'echo ' + SENTINEL);
    let err = null;
    try { await r.p; } catch (e) { err = e; }
    so.mockRestore(); se.mockRestore();
    expect(err).toBeTruthy();
    expect(err.code).toBe('AKI_EXIT');
    expect(String(err.message)).not.toContain(SENTINEL);
    expect(String(r.rec.error || '')).not.toContain(SENTINEL);
    expect(writes.join('\n')).not.toContain(SENTINEL);
    expect(aki.logs.join('\n')).not.toContain(SENTINEL);
    expect(aki.logs.join('\n')).toContain('[isolated]');
  });
});
