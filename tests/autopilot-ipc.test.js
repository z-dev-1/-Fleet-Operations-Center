// tests/autopilot-ipc.test.js — fleet-autopilot §B12.1 IPC channels (src/ipc/autopilot.js).
// electron is a stub that captures the handlers; the facade is a real createAutopilot() over the
// shared fakes (tmp SQLite, fake supervisor, fake ports, fake reason). Covers every channel's
// validation, the literal q prefix (% and _), eventsOffset paging, INVALID_STATE, set-config
// persistence and LOCKED_V1, enable-supervisor, SUPERVISOR_DISABLED and master OFF with an
// engine SQL spy, plus the preload block, the ipc/index.js line and R12.
process.env.TZ = 'America/New_York';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
vi.setConfig({ testTimeout: 30000 });
const F = require('./helpers/autopilot-fakes.cjs');

const ROOT = path.join(__dirname, '..');
const handlers = {};
{
  const resolved = require.resolve('electron');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } } };
}
const { registerAutopilotIPC } = require('../src/ipc/autopilot');

const CHANNELS = ['autopilot:status', 'autopilot:cases', 'autopilot:case', 'autopilot:set-config', 'autopilot:control', 'autopilot:review', 'autopilot:harness-run',
  'autopilot:coverage', 'autopilot:units', 'autopilot:deep-investigate'];
const call = (ch, arg) => handlers[ch]({}, arg);
const apSql = (spy) => spy.mock.calls.map((c) => String(c[0])).filter((q) => /\bap_/.test(q));

let env;
let pushes;
function setup(opts) {
  F.freshDb('ipc');
  env = F.mkEnv(opts);
  pushes = [];
  for (const k of Object.keys(handlers)) delete handlers[k];
  registerAutopilotIPC({ sendToWindow: (ch, p) => pushes.push([ch, p]) }, { autopilot: env.ap });
  return env;
}
function seed(unit, extra) {
  F.schema.ensureSchema();
  return F.seedCase(unit, extra).caseId;
}

beforeEach(() => { vi.restoreAllMocks(); setup(); });

describe('registration', () => {
  it('registers exactly the ten channels and boots the facade (worker registered)', () => {
    expect(Object.keys(handlers).sort()).toEqual(CHANNELS.slice().sort());
    expect(env.supervisor.registerCalls).toBe(1);
    expect(env.supervisor.active()).toBe(true);
  });

  it('a throwing facade returns { ok:false, code } instead of throwing', async () => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    registerAutopilotIPC({}, { autopilot: { boot() { throw new Error('x'); }, status() { const e = new Error('boom'); e.code = 'STORE_BUSY'; throw e; } } });
    expect(await call('autopilot:status')).toEqual({ ok: false, code: 'STORE_BUSY' });
  });
});

describe('autopilot:cases validation', () => {
  const bad = [
    [{ state: 'NOPE' }, 'state'], [{ state: 3 }, 'state'], [{ reason: 'MADE_UP' }, 'reason'], [{ domicile: 'a' }, 'domicile'],
    [{ domicile: 'ABCDEFGHIJK' }, 'domicile'], [{ q: 'X'.repeat(41) }, 'q'], [{ q: 5 }, 'q'], [{ limit: 0 }, 'limit'], [{ limit: 201 }, 'limit'],
    [{ limit: 1.5 }, 'limit'], [{ offset: -1 }, 'offset'], [{ offset: 100001 }, 'offset'], [{ other: 1 }, 'other'], ['str', 'filter'],
  ];
  for (const [arg, field] of bad) {
    it('rejects ' + JSON.stringify(arg) + ' -> INVALID_INPUT ' + field + ' with no SQL', async () => {
      const prep = vi.spyOn(F.engine, 'prepare');
      expect(await call('autopilot:cases', arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field });
      expect(apSql(prep)).toEqual([]);
    });
  }

  it('accepts valid filters; domicile and q are normalized; limit / offset page', async () => {
    seed('322283');
    seed('321185', { domicile: 'abe40' });
    seed('B13014', { domicile: 'ROC5' });
    let r = await call('autopilot:cases', {});
    expect(r).toMatchObject({ ok: true, total: 3 });
    r = await call('autopilot:cases', { domicile: ' roc5 ' });
    expect(r.items.map((c) => c.unit_id)).toEqual(['B13014']);
    r = await call('autopilot:cases', { q: ' b13 ' });
    expect(r.items.map((c) => c.unit_id)).toEqual(['B13014']);
    r = await call('autopilot:cases', { state: 'QUEUED', reason: 'DWELL_EXCEEDED', limit: 1, offset: 1 });
    expect(r.total).toBe(3);
    expect(r.items.length).toBe(1);
    r = await call('autopilot:cases', { state: 'RESOLVED' });
    expect(r).toMatchObject({ ok: true, total: 0, items: [] });
    r = await call('autopilot:cases');
    expect(r.total).toBe(3);
  });

  it('q with % and _ is matched as a literal prefix (no LIKE)', async () => {
    seed('X_1');
    seed('XA1');
    seed('X%9');
    expect((await call('autopilot:cases', { q: 'X_' })).items.map((c) => c.unit_id)).toEqual(['X_1']);
    expect((await call('autopilot:cases', { q: 'X%' })).items.map((c) => c.unit_id)).toEqual(['X%9']);
    expect((await call('autopilot:cases', { q: '%' })).total).toBe(0);
    expect((await call('autopilot:cases', { q: '_' })).total).toBe(0);
    expect((await call('autopilot:cases', { q: 'X' })).total).toBe(3);
  });
});

describe('autopilot:case', () => {
  it('validates caseId and eventsOffset', async () => {
    for (const arg of [undefined, 'ap_0123456789abcdef', { caseId: 'ap_123' }, { caseId: 'AP_0123456789ABCDEF' }, { caseId: 'ap_0123456789abcdeg' }, { caseId: "ap_0123456789abcdef' OR 1=1" }]) {
      expect(await call('autopilot:case', arg), JSON.stringify(arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'caseId' });
    }
    for (const eventsOffset of [-1, 100001, 2.5, '0']) {
      expect(await call('autopilot:case', { caseId: 'ap_0123456789abcdef', eventsOffset })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'eventsOffset' });
    }
    F.schema.ensureSchema();
    expect(await call('autopilot:case', { caseId: 'ap_0123456789abcdef' })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('pages events by eventsOffset (500 per page) and groups findings by source with conflicts', async () => {
    await env.supervisor.runTick();
    const id = F.cs.listCases({}).items[0].case_id;
    for (let i = 0; i < 520; i++) F.cs.appendEvent({ caseId: id, at: F.T0 + i, kind: 'evidence', reason: 'filler' });
    const p0 = await call('autopilot:case', { caseId: id });
    expect(p0.ok).toBe(true);
    expect(p0.events.length).toBe(500);
    expect(p0.eventsTotal).toBeGreaterThan(520);
    const p1 = await call('autopilot:case', { caseId: id, eventsOffset: 500 });
    expect(p1.events.length).toBe(p0.eventsTotal - 500);
    expect(p1.events[0].id).not.toBe(p0.events[0].id);
    expect(p0.runs.length).toBe(1);
    expect(p0.findings.length).toBeGreaterThan(0);
    const total = Object.values(p0.findingsBySource).reduce((a, l) => a + l.length, 0);
    expect(total).toBe(p0.findings.length);
    expect(Object.keys(p0.findingsBySource)).toContain('aap_cache');
    expect(typeof p0.conflicts).toBe('object');
  });
});

describe('autopilot:review', () => {
  it('validates caseId, decision and note', async () => {
    const id = 'ap_0123456789abcdef';
    expect(await call('autopilot:review', { caseId: 'x', decision: 'accept' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'caseId' });
    expect(await call('autopilot:review', { caseId: id, decision: 'resolve' })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'decision' });
    expect(await call('autopilot:review', { caseId: id, decision: 'accept', note: 'x'.repeat(501) })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'note' });
    expect(await call('autopilot:review', { caseId: id, decision: 'accept', note: 5 })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'note' });
  });

  it('a decision that does not apply to the state -> INVALID_STATE with no write; acknowledge works from RECOMMENDATION_READY', async () => {
    const id = seed('322283');
    const n = F.cs.getCase(id).events.length;
    expect(await call('autopilot:review', { caseId: id, decision: 'acknowledge' })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(await call('autopilot:review', { caseId: id, decision: 'accept' })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(await call('autopilot:review', { caseId: id, decision: 'rerun' })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(F.cs.getCase(id).events.length).toBe(n);
    expect(F.cs.getCase(id).case.state).toBe('QUEUED');
    await env.supervisor.runTick();
    expect(F.cs.getCase(id).case.state).toBe('RECOMMENDATION_READY');
    expect(await call('autopilot:review', { caseId: id, decision: 'acknowledge', note: 'seen' })).toEqual({ ok: true, state: 'MONITORING' });
    expect(F.cs.getCase(id).case).toMatchObject({ review_status: 'acknowledged', review_note: 'seen' });
    expect(await call('autopilot:review', { caseId: id, decision: 'rerun' })).toEqual({ ok: true, state: 'QUEUED' });
    expect(pushes.filter(([ch, p]) => ch === 'autopilot:changed' && p && p.source === 'user').length).toBe(2);
  });
});

describe('autopilot:set-config', () => {
  it('persists a valid patch; rejects writes.* with LOCKED_V1 and unknown keys with INVALID_INPUT', async () => {
    expect(await call('autopilot:set-config', null)).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'patch' });
    expect(await call('autopilot:set-config', [1])).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'patch' });
    const r = await call('autopilot:set-config', { oosDays: 5, scope: { units: [' b13014 ', '322283'] } });
    expect(r.ok).toBe(true);
    expect(r.config.oosDays).toBe(5);
    expect(env.settings.doc.autopilot).toMatchObject({ oosDays: 5, scope: { units: ['B13014', '322283'] } });
    expect((await call('autopilot:status')).config.oosDays).toBe(5);
    expect(await call('autopilot:set-config', { writes: { woCreate: true } })).toEqual({ ok: false, code: 'LOCKED_V2', field: 'writes.woCreate' });
    expect(await call('autopilot:set-config', { bogus: 1 })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'bogus' });
    expect(await call('autopilot:set-config', { oosDays: 6, dailyCap: -1 })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'dailyCap' });
    expect(env.settings.doc.autopilot.oosDays).toBe(5);
    expect(env.settings.doc.autopilot.writes).toBe(undefined);
  });
});

describe('autopilot:control', () => {
  it('validates the action', async () => {
    for (const a of [undefined, {}, { action: 'delete' }, { action: 5 }]) {
      expect(await call('autopilot:control', a)).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'action' });
    }
  });

  it('enable-supervisor changes only settings.workers.supervisor.enabled and returns restartRequired:true', async () => {
    const settings = F.settingsStore({
      autopilot: { features: { liveReads: true } },
      workers: { supervisor: { enabled: false, note: 'keep' }, emailTriage: { supervised: false } },
      jobs: { enabled: false }, aap: { url: 'https://x', nested: { a: [1, 2] } }, theme: 'dark',
    });
    setup({ settings, supervisorEnabled: false });
    const before = JSON.parse(JSON.stringify(settings.doc));
    expect(await call('autopilot:control', { action: 'enable-supervisor' })).toEqual({ ok: true, restartRequired: true });
    const after = JSON.parse(JSON.stringify(settings.doc));
    expect(after.workers.supervisor.enabled).toBe(true);
    after.workers.supervisor.enabled = before.workers.supervisor.enabled;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('pause / resume / stop round trip through settings', async () => {
    expect(await call('autopilot:control', { action: 'pause' })).toEqual({ ok: true, runState: 'paused' });
    expect(env.settings.doc.autopilot.runState).toBe('paused');
    expect(await call('autopilot:control', { action: 'run-now' })).toEqual({ ok: false, code: 'NOT_RUNNING' });
    expect((await call('autopilot:control', { action: 'resume' })).ok).toBe(true);
    expect(await call('autopilot:control', { action: 'stop' })).toEqual({ ok: true, runState: 'stopped' });
    expect(env.supervisor.active()).toBe(false);
  });
});

describe('autopilot:harness-run validation', () => {
  it('runs must be an integer 20..30', async () => {
    for (const runs of [19, 31, 24.5, '24', null]) {
      expect(await call('autopilot:harness-run', { runs })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'runs' });
    }
    expect(await call('autopilot:harness-run', 'x')).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'runs' });
  });

  it('default runs = 24 is passed to the facade', async () => {
    const seen = [];
    for (const k of Object.keys(handlers)) delete handlers[k];
    registerAutopilotIPC({}, { autopilot: { boot() {}, harnessRun: async (o) => { seen.push(o); return { ok: false, code: 'BUSY' }; } } });
    expect(await call('autopilot:harness-run')).toEqual({ ok: false, code: 'BUSY' });
    expect(await call('autopilot:harness-run', { runs: 30 })).toEqual({ ok: false, code: 'BUSY' });
    expect(seen).toEqual([{ runs: 24 }, { runs: 30 }]);
  });
});

describe('V2 autopilot:cases filter keys (§10.1, AC-27)', () => {
  const bad = [
    [{ carrier: 'x'.repeat(41) }, 'carrier'], [{ carrier: 'a;b' }, 'carrier'], [{ carrier: 5 }, 'carrier'],
    [{ scac: 'a' }, 'scac'], [{ scac: 'ABCDEFGHIJK' }, 'scac'], [{ scac: 'A-B' }, 'scac'],
    [{ vendor: 'v'.repeat(61) }, 'vendor'], [{ vendor: 'a<b>' }, 'vendor'],
    [{ phase: 'broken' }, 'phase'], [{ phase: 3 }, 'phase'],
    [{ downtimeMin: -1 }, 'downtimeMin'], [{ downtimeMin: 3651 }, 'downtimeMin'], [{ downtimeMin: '2' }, 'downtimeMin'], [{ downtimeMax: NaN }, 'downtimeMax'],
    [{ downtimeMin: 10, downtimeMax: 5 }, 'downtimeMax'],
    [{ priorityMin: 101 }, 'priorityMin'], [{ priorityMin: 1.5 }, 'priorityMin'], [{ priorityMin: -1 }, 'priorityMin'],
    [{ group: 'everything' }, 'group'], [{ state: 'QUEUED', group: 'queued' }, 'group'],
    [{ aiPending: 'yes' }, 'aiPending'], [{ aiPending: 1 }, 'aiPending'],
    [{ tier: 'huge' }, 'tier'], [{ sort: 'priority DESC; DROP TABLE ap_case' }, 'sort'], [{ sort: 'name' }, 'sort'],
  ];
  for (const [arg, field] of bad) {
    it('rejects ' + JSON.stringify(arg) + ' -> INVALID_INPUT ' + field + ' with no SQL', async () => {
      const prep = vi.spyOn(F.engine, 'prepare');
      expect(await call('autopilot:cases', arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field });
      expect(apSql(prep)).toEqual([]);
    });
  }

  it('the enum copies match classify.js, coverage.js and equipment.js', () => {
    const { ENUMS } = require('../src/ipc/autopilot');
    const classify = require('../src/autopilot/classify');
    const { CLASSES } = require('../src/autopilot/equipment');
    expect(ENUMS.CANONICAL_STATUSES).toEqual(classify.CANONICAL_STATUSES);
    expect(ENUMS.STAGES).toEqual(classify.STAGES);
    expect(ENUMS.ELIGIBILITY_CLASSES.slice().sort()).toEqual(Object.values(CLASSES).sort());
    const covSrc = fs.readFileSync(path.join(ROOT, 'src', 'autopilot', 'coverage.js'), 'utf8');
    const block = covSrc.slice(covSrc.indexOf('const COVERAGE = Object.freeze({'), covSrc.indexOf('});', covSrc.indexOf('const COVERAGE')));
    expect([...block.matchAll(/:\s*'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(ENUMS.UNIT_COVERAGES.slice().sort());
    const L = fs.readFileSync(path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot-logic.js'), 'utf8');
    for (const g of ENUMS.GROUPS) expect(L).toContain("['" + g + "', ");
  });

  it('valid V2 keys filter with parameterized SQL; group, aiPending, tier and sort work', async () => {
    const a = seed('T1', { operator: 'TUZR', owner: 'AZNG', vendor: 'Penske Truck Leasing', daysDown: 5 });
    const b = seed('T2', { operator: 'KNXP', owner: 'KNXP', vendor: "Rush Truck Center's", daysDown: 40 });
    const c = seed('T3', { operator: 'SWFT', owner: 'Swift Leasing', vendor: 'Other', daysDown: 12 });
    const set = (id, sql, ...v) => F.engine.prepare('UPDATE ap_case SET ' + sql + ' WHERE case_id = ?').run(...v, id);
    set(a, 'priority = ?, repair_phase = ?, complexity = ?, ai_investigated_at = ?, days_down = ?', 80, 'repair', 'complex', F.T0, 5);
    set(b, 'priority = ?, repair_phase = NULL, complexity = ?, ai_investigated_at = NULL, days_down = ?, updated_at = ?', 30, 'simple', 40, F.T0 + 5);
    set(c, "priority = ?, repair_phase = ?, complexity = ?, ai_investigated_at = ?, ai_pending_reason = 'cap', days_down = ?, state = 'MONITORING', awaiting_sources = 'decisiv'", 50, 'awaiting_parts', 'standard', F.T0, 12);
    const units = async (f) => (await call('autopilot:cases', f)).items.map((x) => x.unit_id);
    expect(await units({ carrier: 'tuzr' })).toEqual(['T1']);
    expect(await units({ carrier: 'Swift Leasing' })).toEqual(['T3']);
    expect(await units({ scac: ' knxp ' })).toEqual(['T2']);
    expect(await units({ vendor: "rush truck center's" })).toEqual(['T2']);
    expect(await units({ phase: 'unknown' })).toEqual(['T2']);
    expect(await units({ phase: 'awaiting_parts' })).toEqual(['T3']);
    expect(await units({ downtimeMin: 10 })).toEqual(['T3', 'T2']);
    expect(await units({ downtimeMin: 10, downtimeMax: 12 })).toEqual(['T3']);
    expect(await units({ priorityMin: 50 })).toEqual(['T1', 'T3']);
    expect(await units({ group: 'queued' })).toEqual(['T1', 'T2']);
    expect(await units({ group: 'monitoring' })).toEqual(['T3']);
    expect(await units({ group: 'waiting' })).toEqual(['T3']);
    expect(await units({ group: 'resolved' })).toEqual([]);
    expect(await units({ aiPending: true })).toEqual(['T3', 'T2']);
    expect(await units({ aiPending: false })).toEqual(['T1', 'T3', 'T2']);
    expect(await units({ tier: 'complex' })).toEqual(['T1']);
    expect(await units({ sort: 'downtime' })).toEqual(['T2', 'T3', 'T1']);
    expect((await units({ sort: 'updated' }))[0]).toBe('T2');
    expect((await units({ sort: 'queued' })).length).toBe(3);
    expect(await units({ sort: 'priority' })).toEqual(['T1', 'T3', 'T2']);
  });
});

describe('V2 channels: autopilot:coverage, autopilot:units, autopilot:deep-investigate (§10.1, AC-27)', () => {
  const FLEET = { autopilot: { scope: { mode: 'fleet' } } };
  function fleetEnv() {
    const settings = F.settingsStore({ autopilot: F.v1Defaults({ scope: { mode: 'fleet' } }), domiciles: ['ABE40', 'ZZZ9'] });
    const world = F.mkWorld({ rows: F.fleetV2() });
    const runInvestigation = async (caseId) => ({ ok: true, caseId, outcome: 'noop' });
    return setup({ settings, world, runInvestigation });
  }

  it('coverage input validation', async () => {
    for (const arg of [5, 'x', [], { a: 1 }]) expect(await call('autopilot:coverage', arg), JSON.stringify(arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'input' });
    for (const arg of [undefined, null, {}]) expect((await call('autopilot:coverage', arg)).ok).toBe(true);
  });

  it('coverage returns the reconciled pass with tokensWithoutRows, groups, queue, ai and sources', async () => {
    const env = fleetEnv();
    await env.ctl.runOnce({ forceDetect: true });
    const r = await call('autopilot:coverage');
    expect(r.ok).toBe(true);
    expect(r.reconcileOk).toBe(true);
    const p = r.pass;
    expect(p.fleet_rows - p.duplicate_rows).toBe(p.invalid_rows + p.eligible + p.excluded_trailer + p.excluded_hostler + p.excluded_unsupported + p.type_unknown + p.type_conflict);
    expect(p.down_eligible).toBe(p.case_open + p.below_threshold + p.out_of_filter + p.feature_off);
    expect(p.fleet_rows).toBe(25);
    expect(p.tokensWithoutRows).toEqual(['ZZZ9']);
    expect(Object.keys(p.by_domicile)).toContain('ABE40');
    expect(r.groups).toMatchObject({ queued: expect.any(Number), active: expect.any(Number) });
    expect(r.queue).toMatchObject({ queueCoveragePct: expect.any(Number) });
    expect(r.ai).toMatchObject({ notYetAi: expect.any(Number), calls: expect.any(Number) });
    expect(typeof r.sources).toBe('object');
  });

  it('units validation and the TYPE_UNKNOWN reason', async () => {
    const bad = [
      [{ coverage: 'all' }, 'coverage'], [{ eligibility: 'TRACTOR' }, 'eligibility'], [{ domicile: 'a' }, 'domicile'],
      [{ scac: 'A-B' }, 'scac'], [{ q: 'X'.repeat(41) }, 'q'], [{ q: 3 }, 'q'], [{ limit: 0 }, 'limit'], [{ limit: 201 }, 'limit'],
      [{ offset: -1 }, 'offset'], [{ offset: 100001 }, 'offset'], [{ other: 1 }, 'other'], ['x', 'filter'],
    ];
    for (const [arg, field] of bad) {
      const prep = vi.spyOn(F.engine, 'prepare');
      expect(await call('autopilot:units', arg), JSON.stringify(arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field });
      expect(apSql(prep)).toEqual([]);
      prep.mockRestore();
    }
    const env = fleetEnv();
    await env.ctl.runOnce({ forceDetect: true });
    const unk = await call('autopilot:units', { coverage: 'type_unknown' });
    expect(unk.ok).toBe(true);
    expect(unk.items.map((u) => [u.unit_id, u.eligibility, u.reason])).toEqual([['UK600', 'TYPE_UNKNOWN', 'unknown equipment type']]);
    const tc = await call('autopilot:units', { eligibility: 'TYPE_CONFLICT' });
    for (const u of tc.items) expect(u.reason).toBe('equipment type conflict');
    expect((await call('autopilot:units', { domicile: ' abe40 ', eligibility: 'POWER_ELIGIBLE' })).items.map((u) => u.unit_id)).toEqual(['T100']);
    expect((await call('autopilot:units', { scac: 'swft', q: 't10' })).items.map((u) => u.unit_id)).toEqual(['T102', 'T107']);
    const page = await call('autopilot:units', { limit: 2, offset: 1 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBeGreaterThan(3);
  });

  it('units q with % and _ is a literal prefix', async () => {
    const world = F.mkWorld({ rows: [F.baseRow({ equipmentId: 'X_1' }), F.baseRow({ equipmentId: 'XA1', _serviceId: 's2' }), F.baseRow({ equipmentId: 'X%9', _serviceId: 's3' })] });
    const env = setup({ world, autopilot: FLEET.autopilot, runInvestigation: async (caseId) => ({ ok: true, caseId, outcome: 'noop' }) });
    await env.ctl.runOnce({ forceDetect: true });
    expect((await call('autopilot:units', { q: 'X_' })).items.map((u) => u.unit_id)).toEqual(['X_1']);
    expect((await call('autopilot:units', { q: 'X%' })).items.map((u) => u.unit_id)).toEqual(['X%9']);
    expect((await call('autopilot:units', { q: '%' })).total).toBe(0);
    expect((await call('autopilot:units', { q: 'X' })).total).toBe(3);
  });

  it('deep-investigate validation, codes and the autopilot:changed push on success', async () => {
    for (const arg of [undefined, 'ap_0123456789abcdef', { caseId: 'ap_1' }, { caseId: 'AP_0123456789ABCDEF' }]) {
      expect(await call('autopilot:deep-investigate', arg), JSON.stringify(arg)).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'caseId' });
    }
    expect(await call('autopilot:deep-investigate', { caseId: 'ap_0123456789abcdef', deep: true })).toEqual({ ok: false, code: 'INVALID_INPUT', field: 'deep' });
    const env = fleetEnv();
    await env.ctl.runOnce({ forceDetect: true });
    const id = F.cs.listOpen()[0].case_id;
    expect(await call('autopilot:deep-investigate', { caseId: 'ap_0000000000000000' })).toEqual({ ok: false, code: 'NOT_FOUND' });
    F.cs.transition(id, 'INVESTIGATING', { now: env.clock.now() });
    expect(await call('autopilot:deep-investigate', { caseId: id })).toEqual({ ok: false, code: 'CASE_BUSY' });
    F.cs.transition(id, 'MONITORING', { now: env.clock.now() });
    pushes.length = 0;
    expect(await call('autopilot:deep-investigate', { caseId: id })).toEqual({ ok: true, state: 'QUEUED' });
    expect(pushes.filter(([ch]) => ch === 'autopilot:changed').length).toBe(1);
    expect((await call('autopilot:control', { action: 'pause' })).ok).toBe(true);
    pushes.length = 0;
    expect(await call('autopilot:deep-investigate', { caseId: id })).toEqual({ ok: false, code: 'NOT_RUNNING' });
    expect(pushes.length).toBe(0);
    env.supervisor.enabled = false;
    expect((await call('autopilot:control', { action: 'resume' })).ok).toBe(true);
    expect(await call('autopilot:deep-investigate', { caseId: id })).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
  });

  it('LOCKED_V2 for writes.* through set-config', async () => {
    expect(await call('autopilot:set-config', { writes: { slackReplies: true } })).toEqual({ ok: false, code: 'LOCKED_V2', field: 'writes.slackReplies' });
  });
});

describe('supervisor disabled and master OFF: zero ap_* SQL', () => {
  it('supervisor disabled -> run-now and harness-run SUPERVISOR_DISABLED with zero ap_* SQL; status names the env override (R13)', async () => {
    const prep = vi.spyOn(F.engine, 'prepare');
    const exec = vi.spyOn(F.engine, 'exec');
    F.schema._resetForTests();
    setup({ supervisorEnabled: false, env: { FLEET_WORKERS: '0' } });
    expect(env.supervisor.registerCalls).toBe(0);
    expect(await call('autopilot:control', { action: 'run-now' })).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    expect(await call('autopilot:harness-run', { runs: 24 })).toEqual({ ok: false, code: 'SUPERVISOR_DISABLED' });
    const s = await call('autopilot:status');
    expect(s).toMatchObject({ ok: true, enabled: true, supervisorEnabled: false, supervisorEnvOverride: '0', worker: 'supervisor_disabled', counts: null });
    expect(apSql(prep)).toEqual([]);
    expect(apSql(exec)).toEqual([]);
  });

  for (const [name, opts] of [['settings enabled:false', { autopilot: { enabled: false } }], ['FLEET_AUTOPILOT=0', { env: { FLEET_AUTOPILOT: '0' } }]]) {
    it(name + ' -> status / cases / case return enabled:false and run zero ap_* SQL', async () => {
      const prep = vi.spyOn(F.engine, 'prepare');
      const exec = vi.spyOn(F.engine, 'exec');
      F.schema._resetForTests();
      setup(opts);
      expect(env.supervisor.registerCalls).toBe(0);
      const s = await call('autopilot:status');
      expect(s).toMatchObject({ ok: true, enabled: false });
      expect(s.counts).toBe(undefined);
      expect(await call('autopilot:cases', {})).toEqual({ ok: true, enabled: false, total: 0, items: [] });
      expect(await call('autopilot:case', { caseId: 'ap_0123456789abcdef' })).toEqual({ ok: true, enabled: false, total: 0, items: [] });
      expect(await call('autopilot:control', { action: 'run-now' })).toEqual({ ok: false, code: 'DISABLED' });
      expect(await call('autopilot:harness-run', {})).toEqual({ ok: false, code: 'DISABLED' });
      expect(await call('autopilot:review', { caseId: 'ap_0123456789abcdef', decision: 'accept' })).toEqual({ ok: false, code: 'DISABLED' });
      expect(await call('autopilot:coverage')).toEqual({ ok: true, enabled: false });
      expect(await call('autopilot:units', {})).toEqual({ ok: true, enabled: false, total: 0, items: [] });
      expect(await call('autopilot:deep-investigate', { caseId: 'ap_0123456789abcdef' })).toEqual({ ok: false, code: 'DISABLED' });
      expect(apSql(prep)).toEqual([]);
      expect(apSql(exec)).toEqual([]);
    });
  }
});

describe('shared-file edits (B13)', () => {
  const pre = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8').replace(/\r\n/g, '\n');

  it('preload exposes autopilot directly after the zoomMeet block with the eleven pinned keys', () => {
    const zm = pre.indexOf("expose('zoomMeet'");
    const zmEnd = pre.indexOf('\n});\n', zm) + 5;
    const ap = pre.indexOf("expose('autopilot'");
    expect(zm).toBeGreaterThan(0);
    expect(ap).toBeGreaterThan(zmEnd - 1);
    const between = pre.slice(zmEnd, ap);
    expect(between.replace(/\/\/[^\n]*\n/g, '').trim()).toBe('');
    const block = pre.slice(ap, pre.indexOf('\n});\n', ap));
    const keys = [...block.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
    expect(keys).toEqual(['status', 'cases', 'getCase', 'setConfig', 'control', 'review', 'harnessRun', 'coverage', 'units', 'deepInvestigate', 'onChanged']);
    // V2 §10.2: the three added lines, exactly.
    expect(block).toContain("  coverage:        ()        => ipcRenderer.invoke('autopilot:coverage'),\n");
    expect(block).toContain("  units:           (filter)  => ipcRenderer.invoke('autopilot:units', filter || {}),\n");
    expect(block).toContain("  deepInvestigate: (caseId)  => ipcRenderer.invoke('autopilot:deep-investigate', { caseId }),\n");
    for (const ch of CHANNELS) expect(block).toContain("'" + ch + "'");
    expect(block).toContain("on('autopilot:changed', cb)");
    // The aperia block stays last.
    expect(pre.lastIndexOf('expose(')).toBe(pre.indexOf("expose('aperia'"));
    expect(ap).toBeLessThan(pre.indexOf("expose('aperia'"));
  });

  it('src/ipc/index.js registers Autopilot once, right after registerRepairIntelIPC(ctx);', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'ipc', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const line = "  try { require('./autopilot').registerAutopilotIPC(ctx); } catch (e) { logger.warn('Autopilot IPC registration failed: ' + e.message); }";
    expect(src.split(line).length - 1).toBe(1);
    expect(src).toContain('  registerRepairIntelIPC(ctx);\n' + line + '\n');
  });

  it('R12: no aperia:<letter> in the Autopilot IPC, renderer and preload block', () => {
    const files = [
      path.join(ROOT, 'src', 'ipc', 'autopilot.js'),
      path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot.js'),
      path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot-logic.js'),
      path.join(ROOT, 'renderer', 'src', 'js', 'views', 'autopilot-api.js'),
    ];
    for (const f of files) expect(/aperia:[a-z]/.test(fs.readFileSync(f, 'utf8')), f).toBe(false);
    const ap = pre.indexOf("expose('autopilot'");
    expect(/aperia:[a-z]/.test(pre.slice(ap, pre.indexOf('\n});\n', ap)))).toBe(false);
  });
});
