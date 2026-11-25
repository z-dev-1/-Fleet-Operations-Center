import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const { setDataDir } = require('../src/config/paths');
let tmpDir;
let store;
let cfgMod;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-config-'));
  setDataDir(tmpDir);
  store = require('../src/store');
  cfgMod = require('../src/autopilot/config');
});
afterAll(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => { try { fs.unlinkSync(path.join(tmpDir, 'settings.json')); } catch (_) {} });

const R = (s, e) => cfgMod.resolveAutopilotConfig(s, e || {});

describe('resolveAutopilotConfig', () => {
  it('returns the approved defaults', () => {
    const c = R({}, {});
    expect(c.enabled).toBe(true);
    expect(c.runState).toBe('running');
    expect(c.scope.domicile).toBe('ABE40');
    expect(c.scope.allUnits).toBe(true);
    expect(c.scope.units).toEqual(['322283', '321185', '321364', 'FLD260703', '39582', '39351', '321963', '321838', 'B13014', 'B62059', 'IND260261', '9010424']);
    expect(c.oosDays).toBe(3);
    expect(c.maxCasesPerTick).toBe(1);
    expect(c.intervalMs).toBe(300000);
    expect(c.dailyCap).toBe(48);
    expect(Object.values(c.features).every((v) => v === true)).toBe(true);
    expect(c.features.liveReads).toBe(true);
    expect(Object.values(c.writes).every((v) => v === false)).toBe(true);
    expect(Object.isFrozen(c.writes)).toBe(true);
    expect(Object.values(c.protections).every((v) => v === true)).toBe(true);
    expect(c.warnings).toEqual([]);
    expect(R(null, undefined).oosDays).toBe(3);
  });

  it('clamps every numeric field to its range (invalid -> default)', () => {
    const ap = (x) => R({ autopilot: x });
    expect(ap({ oosDays: 0 }).oosDays).toBe(3);
    expect(ap({ oosDays: 61 }).oosDays).toBe(3);
    expect(ap({ oosDays: 60 }).oosDays).toBe(60);
    expect(ap({ oosDays: '5' }).oosDays).toBe(3);
    expect(ap({ oosDays: 2.5 }).oosDays).toBe(3);
    expect(ap({ maxCasesPerTick: 6 }).maxCasesPerTick).toBe(1);
    expect(ap({ maxCasesPerTick: 5 }).maxCasesPerTick).toBe(5);
    expect(ap({ intervalMs: 59999 }).intervalMs).toBe(300000);
    expect(ap({ intervalMs: 3600000 }).intervalMs).toBe(3600000);
    expect(ap({ dailyCap: 0 }).dailyCap).toBe(0);
    expect(ap({ dailyCap: 5001 }).dailyCap).toBe(48);
    expect(ap({ dailyCap: 5000 }).dailyCap).toBe(5000);
    expect(ap({ runState: 'bogus' }).runState).toBe('running');
    expect(ap({ runState: 'stopped' }).runState).toBe('stopped');
    expect(ap({ enabled: 'yes' }).enabled).toBe(true);
    expect(ap({ features: { aiInvestigation: 'no', liveReads: false } }).features).toMatchObject({ aiInvestigation: true, liveReads: false });
  });

  it('normalizes the domicile and the unit list, dropping bad entries with a warning', () => {
    const c = R({ autopilot: { scope: { domicile: ' abe40 ', units: [' b13014 ', 'B13014', 'bad unit!', 42, null, 'fld260703'] } } });
    expect(c.scope.domicile).toBe('ABE40');
    expect(c.scope.units).toEqual(['B13014', '42', 'FLD260703']);
    expect(c.warnings.filter((w) => w === 'scope-unit-dropped').length).toBe(2);
    expect(R({ autopilot: { scope: { domicile: 'x' } } }).scope.domicile).toBe('ABE40');
    expect(R({ autopilot: { scope: { domicile: '' } } }).scope.domicile).toBe('');
    expect(R({ autopilot: { scope: { units: 'B13014' } } }).scope.units.length).toBe(12);
  });

  it('FLEET_AUTOPILOT env overrides enabled', () => {
    expect(R({}, { FLEET_AUTOPILOT: '0' }).enabled).toBe(false);
    expect(R({ autopilot: { enabled: false } }, { FLEET_AUTOPILOT: '1' }).enabled).toBe(true);
    expect(R({ autopilot: { enabled: false } }, { FLEET_AUTOPILOT: 'x' }).enabled).toBe(false);
  });

  it('forces every write toggle false even when true on disk', () => {
    const c = cfgMod.resolveAutopilotConfig({ autopilot: { writes: { woCreate: true, slackReplies: true, lifecycleChange: false } } }, {});
    expect(c.writes.woCreate).toBe(false);
    expect(c.writes.slackReplies).toBe(false);
    expect(c.warnings).toContain('write-toggle-ignored:woCreate');
    expect(c.warnings).toContain('write-toggle-ignored:slackReplies');
    expect(c.warnings).not.toContain('write-toggle-ignored:lifecycleChange');
    expect(() => { c.writes.woCreate = true; }).toThrow();
  });
});

describe('saveAutopilotPatch / loadAutopilotConfig', () => {
  it('rejects any write toggle with LOCKED_V2 and stores nothing', () => {
    const r = cfgMod.saveAutopilotPatch({ writes: { woCreate: true } });
    expect(r).toMatchObject({ ok: false, code: 'LOCKED_V2' });
    expect(store.load('settings', null)).toBe(null);
  });

  it('rejects unknown or out-of-range keys with INVALID_INPUT; the whole patch is rejected', () => {
    expect(cfgMod.saveAutopilotPatch({ bogus: 1 })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(cfgMod.saveAutopilotPatch({ oosDays: 0 })).toMatchObject({ ok: false, code: 'INVALID_INPUT', key: 'oosDays' });
    expect(cfgMod.saveAutopilotPatch({ features: { nope: true } })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(cfgMod.saveAutopilotPatch({ scope: { units: ['ok1', 'bad unit'] } })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(cfgMod.saveAutopilotPatch({ oosDays: 5, extra: true })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(cfgMod.saveAutopilotPatch(null)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(store.load('settings', null)).toBe(null);
  });

  it('round-trips toggles and fields through save and reload, touching only the autopilot key', () => {
    store.save('settings', { theme: 'dark', workers: { supervisor: { enabled: false } }, autopilot: { dailyCap: 10 } });
    const r = cfgMod.saveAutopilotPatch({ oosDays: 5, features: { liveReads: false }, scope: { units: [' b13014 ', 'b13014'], allUnits: true } });
    expect(r.ok).toBe(true);
    const disk = store.load('settings', {});
    expect(disk.theme).toBe('dark');
    expect(disk.workers).toEqual({ supervisor: { enabled: false } });
    expect(disk.autopilot.dailyCap).toBe(10);
    expect(disk.autopilot.scope.units).toEqual(['B13014']);
    const c = cfgMod.loadAutopilotConfig({ env: {} });
    expect(c.oosDays).toBe(5);
    expect(c.features.liveReads).toBe(false);
    expect(c.features.aiInvestigation).toBe(true);
    expect(c.scope.allUnits).toBe(true);
    expect(c.dailyCap).toBe(10);
    // No memoization: a disk edit is visible on the next read.
    store.save('settings', Object.assign({}, disk, { autopilot: Object.assign({}, disk.autopilot, { oosDays: 7 }) }));
    expect(cfgMod.loadAutopilotConfig({ env: {} }).oosDays).toBe(7);
  });

  it('a disk edit of writes.* to true still resolves false through loadAutopilotConfig', () => {
    store.save('settings', { autopilot: { writes: { woUpdate: true } } });
    const c = cfgMod.loadAutopilotConfig({ env: {} });
    expect(c.writes.woUpdate).toBe(false);
    expect(c.warnings).toContain('write-toggle-ignored:woUpdate');
  });
});

describe('enableSupervisorSetting', () => {
  it('sets only workers.supervisor.enabled and leaves every other key identical', () => {
    const before = {
      theme: 'dark', ai: { gateway: { priorities: false } }, autopilot: { oosDays: 4 },
      workers: { supervisor: { enabled: false, foo: 1 }, relay: { supervised: false } }, list: [1, 2, 3],
    };
    store.save('settings', before);
    const r = cfgMod.enableSupervisorSetting();
    expect(r).toEqual({ ok: true, restartRequired: true });
    const after = store.load('settings', {});
    expect(after.workers.supervisor.enabled).toBe(true);
    const strip = (d) => { const c = JSON.parse(JSON.stringify(d)); delete c.workers.supervisor.enabled; return c; };
    expect(JSON.stringify(strip(after))).toBe(JSON.stringify(strip(before)));
  });

  it('creates the key path on an empty settings doc', () => {
    expect(cfgMod.enableSupervisorSetting().ok).toBe(true);
    expect(store.load('settings', {})).toEqual({ workers: { supervisor: { enabled: true } } });
  });
});

describe('cfgFp', () => {
  it('changes with scope, oosDays and features, not with intervalMs or dailyCap', () => {
    const base = R({});
    const fp = cfgMod.cfgFp(base);
    expect(cfgMod.cfgFp(R({ autopilot: { oosDays: 4 } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { scope: { units: ['B13014'] } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { scope: { allUnits: false } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { features: { longDwellInvestigation: false } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { intervalMs: 600000 } }))).toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { dailyCap: 5 } }))).toBe(fp);
  });

  it('V2: changes with scope.mode and scope.filter; not with ai, queue, tools or authorizedTokens', () => {
    const fp = cfgMod.cfgFp(R({}));
    expect(cfgMod.cfgFp(R({ autopilot: { scope: { mode: 'filter' } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { scope: { filter: { scacs: ['TUZR'] } } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { ai: { dailyCap: 100 }, queue: { maxConcurrent: 3 }, tools: { timeoutMs: 9000 } } }))).toBe(fp);
    expect(cfgMod.cfgFp(R({ domiciles: ['ZZZ9'] }))).toBe(fp);
  });
});

describe('V2 defaults (AC-1)', () => {
  it('resolveAutopilotConfig({}, {}) is the exact V2 default block', () => {
    const c = R({}, {});
    expect(c.scope).toEqual({
      mode: 'fleet', filter: { domiciles: [], carriers: [], scacs: [], vendors: [], units: [] },
      domicile: 'ABE40', units: cfgMod.DEFAULT_UNITS.slice(), allUnits: true,
    });
    expect(c.equipment).toEqual({ eligibleAssetTypes: ['tractor', 'boxTruck'], excludeTrailers: true, excludeHostlers: true, unknownType: 'track_only' });
    expect(Object.isFrozen(c.equipment)).toBe(true);
    expect(c.features).toEqual({
      oosInvestigation: true, longDwellInvestigation: true, evidenceCollection: true, aiInvestigation: true,
      multiTurn: true, timelineProposals: true, localHistory: true, liveReads: true,
    });
    expect(c.ai).toEqual({ dailyCap: 48, turnTimeoutMs: 60000, yieldToHighPriority: true });
    expect(c.dailyCap).toBe(48);
    expect(c.complexityTiers).toEqual({
      simple: { maxModelTurns: 2, maxToolCalls: 3, maxElapsedMs: 120000, maxEvidenceBytes: 24000 },
      standard: { maxModelTurns: 4, maxToolCalls: 6, maxElapsedMs: 240000, maxEvidenceBytes: 48000 },
      complex: { maxModelTurns: 6, maxToolCalls: 10, maxElapsedMs: 420000, maxEvidenceBytes: 64000 },
    });
    expect(c.tools).toEqual({ timeoutMs: 20000 });
    expect(c.queue).toEqual({ maxConcurrent: 2, maxStartsPerTick: 4, maxQueued: 5000, agingBoostPerHour: 2, agingBoostCap: 40 });
    expect(c.intervalMs).toBe(300000);
    expect(c.oosDays).toBe(3);
    expect(c.maxCasesPerTick).toBe(1);
    expect(Object.values(c.writes).every((v) => v === false)).toBe(true);
    expect(c.authorizedTokens).toEqual(['ABE40', 'EWR45', 'PHL40', 'AVP40', 'AUVTE01']);
    expect(c.warnings).toEqual([]);
  });

  it('the local settings file {"scope":{"allUnits":true}} resolves to fleet mode with 4 starts per tick', () => {
    const c = R({ autopilot: { scope: { allUnits: true } } });
    expect(c.scope.mode).toBe('fleet');
    expect(c.queue.maxStartsPerTick).toBe(4);
  });
});

describe('V2 resolution rules (§3.2, §3.3)', () => {
  const ap = (x, extra) => R(Object.assign({ autopilot: x }, extra || {}));

  it('scope.mode: valid wins, invalid -> fleet, absent -> legacy allUnits', () => {
    expect(ap({ scope: { mode: 'filter' } }).scope).toMatchObject({ mode: 'filter', allUnits: false });
    expect(ap({ scope: { mode: 'bogus', allUnits: false } }).scope.mode).toBe('fleet');
    expect(ap({ scope: { allUnits: false } }).scope).toMatchObject({ mode: 'filter', allUnits: false });
    expect(ap({ scope: { allUnits: true } }).scope.mode).toBe('fleet');
    expect(ap({ scope: { mode: 'fleet', allUnits: false } }).scope.mode).toBe('fleet');
  });

  it('filter lists are normalized; bad entries dropped with scope-filter-dropped', () => {
    const c = ap({ scope: { filter: {
      domiciles: [' abe40 ', 'ABE40', 'x', 7], scacs: ['tuzr', 'TOO-LONG-SCAC'], carriers: [' Penske Logistics ', 'penske logistics', '<bad>'],
      vendors: ["Ryder (O'Hare), Inc.", 'x'.repeat(61)], units: [' b13014 ', 'bad unit!'],
    } } });
    expect(c.scope.filter).toEqual({
      domiciles: ['ABE40'], scacs: ['TUZR'], carriers: ['Penske Logistics'], vendors: ["Ryder (O'Hare), Inc."], units: ['B13014'],
    });
    expect(c.warnings.filter((w) => w === 'scope-filter-dropped').length).toBe(6);
    const many = ap({ scope: { filter: { scacs: Array.from({ length: 60 }, (_, i) => 'S' + String(i).padStart(2, '0')) } } });
    expect(many.scope.filter.scacs.length).toBe(50);
  });

  it('ranges: ai, tiers, tools and queue fall back to their defaults', () => {
    const c = ap({
      ai: { dailyCap: 5001, turnTimeoutMs: 9999, yieldToHighPriority: 'no' },
      complexityTiers: { simple: { maxModelTurns: 11, maxToolCalls: 0, maxElapsedMs: 420001, maxEvidenceBytes: 7999 }, complex: { maxToolCalls: 20 } },
      tools: { timeoutMs: 4999 },
      queue: { maxConcurrent: 5, maxStartsPerTick: 21, maxQueued: 99, agingBoostPerHour: 11, agingBoostCap: 61 },
    });
    expect(c.ai).toEqual({ dailyCap: 48, turnTimeoutMs: 60000, yieldToHighPriority: true });
    expect(c.complexityTiers.simple).toEqual({ maxModelTurns: 2, maxToolCalls: 3, maxElapsedMs: 120000, maxEvidenceBytes: 24000 });
    expect(c.complexityTiers.complex.maxToolCalls).toBe(20);
    expect(c.tools.timeoutMs).toBe(20000);
    expect(c.queue).toEqual({ maxConcurrent: 2, maxStartsPerTick: 4, maxQueued: 5000, agingBoostPerHour: 2, agingBoostCap: 40 });
    const hi = ap({ ai: { dailyCap: 5000, turnTimeoutMs: 120000 }, queue: { maxConcurrent: 4, maxStartsPerTick: 20, maxQueued: 100, agingBoostPerHour: 0, agingBoostCap: 60 } });
    expect(hi.ai.dailyCap).toBe(5000);
    expect(hi.dailyCap).toBe(5000);
    expect(hi.queue).toEqual({ maxConcurrent: 4, maxStartsPerTick: 20, maxQueued: 100, agingBoostPerHour: 0, agingBoostCap: 60 });
  });

  it('aliases: legacy dailyCap feeds ai.dailyCap; legacy maxCasesPerTick feeds queue.maxStartsPerTick', () => {
    expect(ap({ dailyCap: 300 })).toMatchObject({ dailyCap: 300, ai: { dailyCap: 300 } });
    expect(ap({ dailyCap: 300, ai: { dailyCap: 10 } })).toMatchObject({ dailyCap: 10, ai: { dailyCap: 10 } });
    expect(ap({ dailyCap: 9999 }).ai.dailyCap).toBe(48);
    expect(ap({ maxCasesPerTick: 5 }).queue.maxStartsPerTick).toBe(5);
    expect(ap({ maxCasesPerTick: 5, queue: { maxStartsPerTick: 12 } }).queue.maxStartsPerTick).toBe(12);
    expect(ap({ maxCasesPerTick: 6 }).queue.maxStartsPerTick).toBe(4);
  });

  it('authorizedTokens: settings.domiciles normalized (trim, upper, pattern, dedupe, <= 100); missing / empty -> DEFAULT_DOMICILES', () => {
    const { DEFAULT_DOMICILES } = require('../src/config/defaults');
    expect(R({}).authorizedTokens).toEqual(DEFAULT_DOMICILES);
    expect(R({ domiciles: [] }).authorizedTokens).toEqual(DEFAULT_DOMICILES);
    expect(R({ domiciles: 'ABE40' }).authorizedTokens).toEqual(DEFAULT_DOMICILES);
    expect(R({ domiciles: [' abe40 ', 'ABE40', 'zzz9', 'x', 'WAY-TOO-LONG-TOKEN', null, { a: 1 }, 'auv-te01'] }).authorizedTokens)
      .toEqual(['ABE40', 'ZZZ9', 'AUV-TE01']);
    const many = R({ domiciles: Array.from({ length: 150 }, (_, i) => 'D' + i) }).authorizedTokens;
    expect(many.length).toBe(100);
  });

  it('writes stay locked and equipment stays frozen whatever is on disk', () => {
    const c = ap({ writes: { woUpdate: true }, equipment: { eligibleAssetTypes: ['trailer'] } });
    expect(c.writes.woUpdate).toBe(false);
    expect(c.warnings).toContain('write-toggle-ignored:woUpdate');
    expect(c.equipment.eligibleAssetTypes).toEqual(['tractor', 'boxTruck']);
  });
});

describe('V2 saveAutopilotPatch (§3.4)', () => {
  it('writes -> LOCKED_V2 with the key; equipment -> INVALID_INPUT equipment; nothing stored', () => {
    expect(cfgMod.saveAutopilotPatch({ writes: { slackReplies: true } })).toEqual({ ok: false, code: 'LOCKED_V2', key: 'writes.slackReplies' });
    expect(cfgMod.saveAutopilotPatch({ equipment: { excludeTrailers: false } })).toEqual({ ok: false, code: 'INVALID_INPUT', key: 'equipment' });
    expect(store.load('settings', null)).toBe(null);
  });

  it('an invalid filter entry rejects the whole patch with its key', () => {
    expect(cfgMod.saveAutopilotPatch({ oosDays: 5, scope: { filter: { scacs: ['TUZR', 'bad scac!'] } } }))
      .toEqual({ ok: false, code: 'INVALID_INPUT', key: 'scope.filter.scacs' });
    expect(cfgMod.saveAutopilotPatch({ scope: { filter: { nope: [] } } })).toMatchObject({ ok: false, key: 'scope.filter.nope' });
    expect(cfgMod.saveAutopilotPatch({ scope: { filter: { units: 'B13014' } } })).toMatchObject({ ok: false, key: 'scope.filter.units' });
    expect(cfgMod.saveAutopilotPatch({ scope: { mode: 'all' } })).toMatchObject({ ok: false, key: 'scope.mode' });
    expect(cfgMod.saveAutopilotPatch({ queue: { maxConcurrent: 9 } })).toMatchObject({ ok: false, key: 'queue.maxConcurrent' });
    expect(cfgMod.saveAutopilotPatch({ complexityTiers: { huge: { maxModelTurns: 2 } } })).toMatchObject({ ok: false, key: 'complexityTiers.huge' });
    expect(cfgMod.saveAutopilotPatch({ complexityTiers: { simple: { maxModelTurns: 0 } } })).toMatchObject({ ok: false, key: 'complexityTiers.simple.maxModelTurns' });
    expect(cfgMod.saveAutopilotPatch({ ai: { yieldToHighPriority: 1 } })).toMatchObject({ ok: false, key: 'ai.yieldToHighPriority' });
    expect(store.load('settings', null)).toBe(null);
  });

  it('scope.allUnits also writes scope.mode; ai.dailyCap and dailyCap are written together', () => {
    let r = cfgMod.saveAutopilotPatch({ scope: { allUnits: false } });
    expect(r.ok).toBe(true);
    expect(store.load('settings', {}).autopilot.scope).toEqual({ allUnits: false, mode: 'filter' });
    expect(r.config.scope.mode).toBe('filter');
    r = cfgMod.saveAutopilotPatch({ ai: { dailyCap: 200 } });
    expect(store.load('settings', {}).autopilot).toMatchObject({ dailyCap: 200, ai: { dailyCap: 200 } });
    r = cfgMod.saveAutopilotPatch({ dailyCap: 300 });
    expect(store.load('settings', {}).autopilot).toMatchObject({ dailyCap: 300, ai: { dailyCap: 300 } });
    expect(r.config.ai.dailyCap).toBe(300);
    expect(cfgMod.saveAutopilotPatch({ dailyCap: 5, ai: { dailyCap: 6 } })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });

  it('merges scope.filter, ai, queue, tools and complexityTiers.<tier> one level deep', () => {
    store.save('settings', { autopilot: {
      scope: { mode: 'filter', filter: { scacs: ['TUZR'] } }, ai: { turnTimeoutMs: 30000 },
      queue: { maxQueued: 200 }, tools: { timeoutMs: 6000 }, complexityTiers: { simple: { maxModelTurns: 3 }, complex: { maxToolCalls: 12 } },
    } });
    const r = cfgMod.saveAutopilotPatch({
      scope: { filter: { domiciles: ['abe40'] } }, ai: { dailyCap: 10 }, queue: { maxConcurrent: 3 },
      complexityTiers: { simple: { maxToolCalls: 4 } }, features: { multiTurn: false, timelineProposals: false },
    });
    expect(r.ok).toBe(true);
    const disk = store.load('settings', {}).autopilot;
    expect(disk.scope).toEqual({ mode: 'filter', filter: { scacs: ['TUZR'], domiciles: ['ABE40'] } });
    expect(disk.ai).toEqual({ turnTimeoutMs: 30000, dailyCap: 10 });
    expect(disk.queue).toEqual({ maxQueued: 200, maxConcurrent: 3 });
    expect(disk.tools).toEqual({ timeoutMs: 6000 });
    expect(disk.complexityTiers).toEqual({ simple: { maxModelTurns: 3, maxToolCalls: 4 }, complex: { maxToolCalls: 12 } });
    expect(r.config.features).toMatchObject({ multiTurn: false, timelineProposals: false });
    expect(r.config.scope.filter).toMatchObject({ scacs: ['TUZR'], domiciles: ['ABE40'] });
  });
});
