// tests/ai-gateway-flags.test.js — Phase 3 AI gateway flags (config/perf-flags.js)
// and relay's cached _gw() reader.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'gw-flags-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
require('../src/config/paths').setDataDir(tmpDir);
const pf = require('../src/config/perf-flags');
const relay = require('../src/orcha/relay');

const OFF = { priorities: false, abortOnTimeout: false, dedupe: false, routerDecides: false, reserveSlots: 2 };

afterEach(() => {
  vi.useRealTimers();
  relay.__test__.setGatewayFlags(null);
  relay.__test__.setGatewayLoader(null);
});

describe('resolveAiGatewayFlags', () => {
  it('defaults: all off, reserve 2', () => {
    expect(pf.resolveAiGatewayFlags({}, {})).toEqual(OFF);
    expect(pf.resolveAiGatewayFlags(null, null)).toEqual(OFF);
    expect(pf.resolveAiGatewayFlags({ ai: 'x' }, {})).toEqual(OFF);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: [] } }, {})).toEqual(OFF);
  });
  it('only === true enables', () => {
    const s = { ai: { gateway: { priorities: true, abortOnTimeout: 'true', dedupe: 1, routerDecides: true } } };
    expect(pf.resolveAiGatewayFlags(s, {})).toEqual({ ...OFF, priorities: true, routerDecides: true });
  });
  it("env '0'/'1' wins over settings; other env values ignored", () => {
    const s = { ai: { gateway: { priorities: true, abortOnTimeout: true } } };
    const env = { FLEET_AI_GW_PRIORITIES: '0', FLEET_AI_GW_ABORT: 'yes', FLEET_AI_GW_DEDUPE: '1', FLEET_AI_GW_ROUTER: '1' };
    expect(pf.resolveAiGatewayFlags(s, env)).toEqual({ ...OFF, priorities: false, abortOnTimeout: true, dedupe: true, routerDecides: true });
  });
  it('reserveSlots: 0..4 integers only (settings and env); garbage falls back', () => {
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: 0 } } }, {}).reserveSlots).toBe(0);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: 4 } } }, {}).reserveSlots).toBe(4);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: 5 } } }, {}).reserveSlots).toBe(2);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: 1.5 } } }, {}).reserveSlots).toBe(2);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: '3' } } }, {}).reserveSlots).toBe(2);
    expect(pf.resolveAiGatewayFlags({}, { FLEET_AI_GW_RESERVE: '3' }).reserveSlots).toBe(3);
    expect(pf.resolveAiGatewayFlags({ ai: { gateway: { reserveSlots: 1 } } }, { FLEET_AI_GW_RESERVE: '9' }).reserveSlots).toBe(1);
    expect(pf.resolveAiGatewayFlags({}, { FLEET_AI_GW_RESERVE: 'x' }).reserveSlots).toBe(2);
  });
  it('loadAiGateway never throws (throwing loader -> defaults) and reads settings', () => {
    expect(pf.loadAiGateway({ load: () => { throw new Error('boom'); }, env: {} })).toEqual(OFF);
    expect(pf.loadAiGateway({ load: () => ({ ai: { gateway: { dedupe: true } } }), env: {} })).toEqual({ ...OFF, dedupe: true });
  });
  it('resolveFlags (perf.*) output is unchanged', () => {
    expect(pf.resolveFlags({}, {})).toEqual({ telemetryEnabled: true, trayAnimateOnlyWhenBusy: false, deepScanMatchPool: false });
  });
  it('settings is a registered store key (flags live in it, no new key)', () => {
    const store = require('../src/store');
    store.save('settings', { ai: { gateway: { priorities: true } } });
    expect(store.load('settings', {}).ai.gateway.priorities).toBe(true);
  });
  it('test setup forces every gateway env flag to 0', () => {
    expect(process.env.FLEET_AI_GW_PRIORITIES).toBe('0');
    expect(process.env.FLEET_AI_GW_ABORT).toBe('0');
    expect(process.env.FLEET_AI_GW_DEDUPE).toBe('0');
    expect(process.env.FLEET_AI_GW_ROUTER).toBe('0');
  });
});

describe('relay _gw() cache', () => {
  it('refreshes after the 15 s TTL, not before', () => {
    vi.useFakeTimers();
    let flags = { ...OFF };
    relay.__test__.setGatewayLoader(() => flags);
    expect(relay.queueStats().flags.priorities).toBe(false);
    flags = { ...OFF, priorities: true };
    vi.advanceTimersByTime(14999);
    expect(relay.queueStats().flags.priorities).toBe(false);
    vi.advanceTimersByTime(2);
    expect(relay.queueStats().flags.priorities).toBe(true);
  });
  it('a throwing loader yields all-off and never throws from relay', async () => {
    relay.__test__.setGatewayLoader(() => { throw new Error('bad settings'); });
    const q = relay.queueStats();
    expect(q.flags).toEqual({ priorities: false, abortOnTimeout: false, dedupe: false, routerDecides: false });
    expect(q.reserve).toBe(2);
  });
  it('env wins through the real loader (setup forces FLEET_AI_GW_PRIORITIES=0)', () => {
    relay.__test__.setGatewayLoader(() => pf.loadAiGateway({ load: () => ({ ai: { gateway: { priorities: true } } }) }));
    expect(relay.queueStats().flags.priorities).toBe(false);
  });
  it('setGatewayFlags normalizes partial objects (reserveSlots defaults to 2)', () => {
    relay.__test__.setGatewayFlags({ priorities: true });
    expect(relay.queueStats().reserve).toBe(2);
    relay.__test__.setGatewayFlags({ priorities: true, reserveSlots: 9 });
    expect(relay.queueStats().reserve).toBe(2);
    relay.__test__.setGatewayFlags({ priorities: true, reserveSlots: 0 });
    expect(relay.queueStats().reserve).toBe(0);
  });
});
