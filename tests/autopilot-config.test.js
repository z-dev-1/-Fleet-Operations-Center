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
    expect(c.scope.allUnits).toBe(false);
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
    expect(ap({ dailyCap: 501 }).dailyCap).toBe(48);
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
  it('rejects any write toggle with LOCKED_V1 and stores nothing', () => {
    const r = cfgMod.saveAutopilotPatch({ writes: { woCreate: true } });
    expect(r).toMatchObject({ ok: false, code: 'LOCKED_V1' });
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
    expect(cfgMod.cfgFp(R({ autopilot: { scope: { allUnits: true } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { features: { longDwellInvestigation: false } } }))).not.toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { intervalMs: 600000 } }))).toBe(fp);
    expect(cfgMod.cfgFp(R({ autopilot: { dailyCap: 5 } }))).toBe(fp);
  });
});
