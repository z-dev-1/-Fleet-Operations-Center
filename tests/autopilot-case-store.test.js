import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

process.env.TZ = 'America/New_York';

const { setDataDir } = require('../src/config/paths');
let tmpDir;
let engine;
let schema;
let cs;
let resolution;

const T0 = Date.parse('2026-11-10T15:00:00Z');
const H = 3600000;

function freshDb(label) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cs-' + label + '-'));
  setDataDir(tmpDir);
  engine.close();
  schema._resetForTests();
  expect(schema.ensureSchema()).toBe(true);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cs-'));
  setDataDir(tmpDir);
  engine = require('../src/store/sqlite_engine');
  schema = require('../src/autopilot/schema');
  cs = require('../src/autopilot/case-store');
  resolution = require('../src/autopilot/resolution');
});
afterAll(() => { try { engine.close(); } catch (_) {} });
beforeEach(() => { vi.restoreAllMocks(); freshDb('t'); });

const cand = (unit, extra) => Object.assign({
  unitId: unit, domicile: 'abe40', reasons: [{ code: 'OOS' }, { code: 'DWELL_EXCEEDED' }],
  openedBy: 'oos_rule', daysDown: 4, downSince: T0 - 4 * 24 * H, eta: { status: 'NOT_PROVIDED' }, buildAtMs: T0 - H,
}, extra || {});

function toMonitoring(caseId, now) {
  cs.transition(caseId, 'INVESTIGATING', { now });
  cs.transition(caseId, 'MONITORING', { now });
}
const caseRow = (id) => cs.getCase(id).case;
const transitions = (id) => cs.getCase(id).events.filter((e) => e.kind === 'transition');

describe('schema', () => {
  it('creates ap_* tables in the same transactional.sqlite as ri_*', () => {
    require('../src/repair-intel/schema').ensureSchema();
    const names = engine.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    for (const t of ['ap_meta', 'ap_case', 'ap_run', 'ap_finding', 'ap_event', 'ri_repair_event', 'kv']) expect(names).toContain(t);
    expect(cs.getMeta('schema_version')).toBe('1');
    const cols = engine.prepare('PRAGMA table_info(ap_case)').all().map((r) => r.name);
    expect(cols).toContain('last_down_build_at');
    expect(cols).toContain('last_missing_build_at');
    expect(cols).toContain('review_accepted_code');
    expect(cols).not.toContain('last_down_sync_at');
  });

  it('_migrate adds the newer columns to an older ap_case', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cs-mig-'));
    setDataDir(tmpDir);
    engine.close();
    schema._resetForTests();
    let old = schema.DDL;
    for (const c of ['ai_retry_at INTEGER,', 'last_down_build_at INTEGER,', 'last_missing_build_at INTEGER,', 'review_accepted_code TEXT,']) old = old.replace(c, '');
    engine.exec(old);
    let cols = engine.prepare('PRAGMA table_info(ap_case)').all().map((r) => r.name);
    expect(cols).not.toContain('review_accepted_code');
    expect(schema.ensureSchema()).toBe(true);
    cols = engine.prepare('PRAGMA table_info(ap_case)').all().map((r) => r.name);
    for (const c of ['ai_retry_at', 'last_down_build_at', 'last_missing_build_at', 'review_accepted_code']) expect(cols).toContain(c);
  });
});

describe('upsertDetected', () => {
  it('opens one case per unit and moves it to QUEUED in the same transaction', () => {
    const a = cs.upsertDetected(cand(' b13014 '), { now: T0 });
    expect(a.created).toBe(true);
    expect(a.state).toBe('QUEUED');
    const b = cs.upsertDetected(cand('B13014'), { now: T0 + 1000 });
    expect(b).toEqual({ caseId: a.caseId, created: false, state: 'QUEUED' });
    expect(cs.listCases({}).total).toBe(1);
    const c = caseRow(a.caseId);
    expect(c.unit_id).toBe('B13014');
    expect(c.domicile).toBe('ABE40');
    expect(c.last_down_build_at).toBe(T0 - H);
    expect(c.primary_reason).toBe('DWELL_EXCEEDED');
    expect(transitions(a.caseId).map((e) => [e.from_state, e.to_state])).toEqual([[null, 'DETECTED'], ['DETECTED', 'QUEUED']]);
  });

  it('stays DETECTED while the master is paused', () => {
    expect(cs.upsertDetected(cand('U1'), { now: T0, paused: true }).state).toBe('DETECTED');
  });

  it('updates reasons only when the code set changes and writes a detection event', () => {
    const a = cs.upsertDetected(cand('U1'), { now: T0 });
    cs.upsertDetected(cand('U1', { reasons: [{ code: 'DWELL_EXCEEDED' }, { code: 'OOS' }] }), { now: T0 + 1 });
    expect(cs.getCase(a.caseId).events.filter((e) => e.kind === 'detection').length).toBe(0);
    cs.upsertDetected(cand('U1', { reasons: [{ code: 'OOS' }, { code: 'REPAIRED_UNVERIFIED' }] }), { now: T0 + 2 });
    const c = cs.getCase(a.caseId);
    expect(c.events.filter((e) => e.kind === 'detection').length).toBe(1);
    expect(c.case.primary_reason).toBe('REPAIRED_UNVERIFIED');
  });

  it('a tag-only candidate never opens a case; missing required fields throw INVALID_CASE', () => {
    expect(cs.upsertDetected(cand('U2', { openedBy: null }), { now: T0 })).toEqual({ caseId: null, created: false, state: null });
    expect(() => cs.upsertDetected(cand('', {}), { now: T0 })).toThrow(/INVALID_CASE/);
    expect(() => cs.upsertDetected(cand('U3', { reasons: [] }), { now: T0 })).toThrow(/INVALID_CASE/);
    expect(cs.listCases({}).total).toBe(0);
  });

  it('links a new episode to the newest RESOLVED case as prior_case_id', () => {
    const a = cs.upsertDetected(cand('U1'), { now: T0 });
    toMonitoring(a.caseId, T0);
    const r = resolution.verifyResolution(caseRow(a.caseId), { equipmentId: 'U1', lifecycleState: 'Active' }, { source: 'aap-api', buildAtMs: T0 }, T0);
    cs.transition(a.caseId, 'RESOLVED', { resolution: r.token, now: T0 + 1 });
    const b = cs.upsertDetected(cand('U1'), { now: T0 + 2 });
    expect(b.created).toBe(true);
    expect(b.caseId).not.toBe(a.caseId);
    expect(caseRow(b.caseId).prior_case_id).toBe(a.caseId);
  });
});

describe('transactions', () => {
  it('persistRun with a state change runs exactly one BEGIN IMMEDIATE', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    const runId = cs.openRun({ caseId, trigger: 'new', now: T0 });
    const db = engine.getDb();
    const spy = vi.spyOn(db, 'exec');
    const out = cs.persistRun(caseId, runId, { repair_phase: 'in_repair', evidence_fp: 'fp1' }, 'MONITORING', { run: { outcome: 'recommendation', aiStatus: 'not_needed' }, now: T0 + 5 });
    const begins = spy.mock.calls.filter((c) => /BEGIN IMMEDIATE/.test(String(c[0])));
    expect(begins.length).toBe(1);
    expect(out).toEqual({ from: 'INVESTIGATING', to: 'MONITORING' });
    const c = cs.getCase(caseId);
    expect(c.case.repair_phase).toBe('in_repair');
    expect(c.runs[0].outcome).toBe('recommendation');
    expect(c.runs[0].ended_at).toBe(T0 + 5);
  });

  it('an illegal target throws ILLEGAL_TRANSITION and rolls back the column writes', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const runId = cs.openRun({ caseId, trigger: 'new', now: T0 });
    expect(() => cs.persistRun(caseId, runId, { repair_phase: 'x', evidence_fp: 'fp9' }, 'MONITORING', { run: { outcome: 'recommendation' }, now: T0 }))
      .toThrow(/ILLEGAL_TRANSITION/);
    const c = cs.getCase(caseId);
    expect(c.case.state).toBe('QUEUED');
    expect(c.case.repair_phase).toBe(null);
    expect(c.case.evidence_fp).toBe(null);
    expect(c.runs[0].ended_at).toBe(null);
  });

  it('a forged or missing resolution token throws UNVERIFIED_RESOLUTION', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    expect(() => cs.transition(caseId, 'RESOLVED', { now: T0 })).toThrow(/UNVERIFIED_RESOLUTION/);
    const real = resolution.verifyResolution({ last_down_build_at: 1 }, { lifecycleState: 'Active' }, { source: 'aap-api', buildAtMs: 2 }, T0).token;
    const forged = Object.assign({}, real);
    for (const s of Object.getOwnPropertySymbols(real)) forged[s] = real[s];
    expect(() => cs.transition(caseId, 'RESOLVED', { resolution: forged, now: T0 })).toThrow(/UNVERIFIED_RESOLUTION/);
    expect(() => cs.transition(caseId, 'RESOLVED', { resolution: { source: 'aap-api', lifecycleState: 'Active' }, now: T0 })).toThrow(/UNVERIFIED_RESOLUTION/);
    expect(caseRow(caseId).state).toBe('QUEUED');
    cs.transition(caseId, 'RESOLVED', { resolution: real, now: T0 });
    const c = caseRow(caseId);
    expect(c.state).toBe('RESOLVED');
    expect(c.resolution).toMatchObject({ lifecycleState: 'Active', source: 'aap-api', buildAt: 2 });
  });

  it('_updateCaseInTx rejects columns outside the allowlist', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    expect(() => cs.persistRun(caseId, null, { state: 'RESOLVED' }, null, { now: T0 })).toThrow(/INVALID_COLUMN/);
    expect(caseRow(caseId).state).toBe('INVESTIGATING');
  });

  it('persistRun resets ai_defer_count unless the run was deferred', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    cs.persistRun(caseId, null, { ai_defer_count: 2 }, 'QUEUED', { run: { outcome: 'deferred' }, now: T0 });
    expect(caseRow(caseId).ai_defer_count).toBe(2);
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    cs.persistRun(caseId, null, {}, 'MONITORING', { run: { outcome: 'recommendation' }, now: T0 });
    expect(caseRow(caseId).ai_defer_count).toBe(0);
  });

  it('SQLITE_BUSY: retries once after 250 ms, then throws STORE_BUSY', () => {
    const real = engine.tx;
    let calls = 0;
    const busy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
    vi.spyOn(engine, 'tx').mockImplementation((fn) => { calls++; if (calls === 1) throw busy(); return real(fn); });
    const t = Date.now();
    expect(cs.setMeta('k', 'v')).toBe(true);
    expect(Date.now() - t).toBeGreaterThanOrEqual(200);
    expect(calls).toBe(2);
    expect(cs.getMeta('k')).toBe('v');
    vi.spyOn(engine, 'tx').mockImplementation(() => { throw busy(); });
    let err;
    try { cs.setMeta('k', 'w'); } catch (e) { err = e; }
    expect(err && err.code).toBe('STORE_BUSY');
  });
});

describe('reserveAiCallAndMarkPending', () => {
  it('is atomic with the checkpoint, persists across restart and resets on a new local date', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const runId = cs.openRun({ caseId, trigger: 'new', now: T0 });
    expect(cs.reserveAiCallAndMarkPending(runId, '2026-11-10', 2, 'fpA', { now: T0 })).toBe(true);
    expect(cs.getCase(caseId).runs[0].checkpoint).toMatchObject({ step: 'ai_pending', fp: 'fpA' });
    expect(cs.reserveAiCallAndMarkPending(runId, '2026-11-10', 2, 'fpB', { now: T0 })).toBe(true);
    // Simulated restart: close and reopen the same database file.
    engine.close();
    schema._resetForTests();
    schema.ensureSchema();
    expect(cs.getMeta('ai_calls:2026-11-10')).toBe('2');
    expect(cs.reserveAiCallAndMarkPending(runId, '2026-11-10', 2, 'fpC', { now: T0 })).toBe(false);
    expect(cs.getCase(caseId).runs[0].checkpoint.fp).toBe('fpB');
    expect(cs.reserveAiCallAndMarkPending(runId, '2026-11-11', 2, 'fpD', { now: T0 + 24 * H })).toBe(true);
    expect(cs.reserveAiCallAndMarkPending(runId, '2026-11-11', 0, 'fpE', { now: T0 })).toBe(false);
  });
});

describe('runs, checkpoints, findings', () => {
  const finding = (field, value) => ({ source: 'aap_cache', field, value, observedAt: T0, retrievedAt: T0, freshness: 'RECENT', confidence: 0.9, trust: 'structured', authorityTag: 'aap' });

  it('copyRunForResume copies findings, plan and source calls and records a resumed event', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const r1 = cs.openRun({ caseId, trigger: 'new', now: T0 });
    expect(cs.writeFindings(caseId, r1, [finding('lifecycleState', 'Unavailable'), finding('repairEtc', '2026-11-01')])).toBe(2);
    cs.writeCheckpoint(r1, { step: 'evidence_done', fp: 'fp1' }, { plan: [{ source: 'aap_cache', include: true }], sourceCalls: { aap_cache: { cache: 1 } } });
    const r2 = cs.openRun({ caseId, trigger: 'recovered', now: T0 + 1 });
    const cp = cs.copyRunForResume(r1, r2, { now: T0 + 2 });
    expect(cp).toEqual({ step: 'evidence_done', fp: 'fp1' });
    const g = cs.getCase(caseId);
    const run2 = g.runs.find((r) => r.run_id === r2);
    expect(run2.resumed_from).toBe(r1);
    expect(run2.plan).toEqual([{ source: 'aap_cache', include: true }]);
    expect(run2.source_calls).toEqual({ aap_cache: { cache: 1 } });
    const f2 = engine.prepare('SELECT evidence_id FROM ap_finding WHERE run_id = ? ORDER BY id').all(r2).map((r) => r.evidence_id);
    const f1 = engine.prepare('SELECT evidence_id FROM ap_finding WHERE run_id = ? ORDER BY id').all(r1).map((r) => r.evidence_id);
    expect(f2).toEqual(f1);
    expect(g.events.some((e) => e.kind === 'resumed')).toBe(true);
  });

  it('rejects findings without provenance and checkpoints over 64 KB', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const r1 = cs.openRun({ caseId, trigger: 'new', now: T0 });
    expect(() => cs.writeFindings(caseId, r1, [Object.assign(finding('x', 1), { freshness: null })])).toThrow(/INVALID_FINDING/);
    expect(() => cs.writeCheckpoint(r1, { step: 'analysis_done', big: 'x'.repeat(70000) })).toThrow(/CHECKPOINT_TOO_LARGE/);
  });

  it('findResumable returns the newest checkpointed run younger than 30 min', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const r1 = cs.openRun({ caseId, trigger: 'new', now: T0 });
    cs.writeCheckpoint(r1, { step: 'evidence_done', fp: 'a' });
    cs.recoverAbandoned({ owner: 'p2', now: T0 + 60000 });
    expect(cs.findResumable(caseId, T0 + 10 * 60000).run_id).toBe(r1);
    expect(cs.findResumable(caseId, T0 + 31 * 60000)).toBe(null);
  });
});

describe('recoverAbandoned', () => {
  it('requeues with 5 then 15 min backoff and fails a crash loop on the third crash', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const other = cs.upsertDetected(cand('U2'), { now: T0 }).caseId;
    const crash = (now) => {
      cs.lease(caseId, 'old', now + 600000, { now });
      cs.transition(caseId, 'INVESTIGATING', { now });
      cs.openRun({ caseId, trigger: 'scheduled', now });
    };
    crash(T0);
    let r = cs.recoverAbandoned({ owner: 'new1', now: T0 + 1000, rand: () => 0.5 });
    expect(r.requeued).toEqual([caseId]);
    let c = caseRow(caseId);
    expect(c.state).toBe('QUEUED');
    expect(c.attempts).toBe(1);
    expect(c.next_attempt_at).toBe(T0 + 1000 + 5 * 60000);
    expect(c.lease_owner).toBe(null);
    expect(cs.pickQueued(5, T0 + 2000).map((x) => x.case_id)).toEqual([other]);
    crash(T0 + H);
    r = cs.recoverAbandoned({ owner: 'new2', now: T0 + H + 1000, rand: () => 0.5 });
    c = caseRow(caseId);
    expect(c.attempts).toBe(2);
    expect(c.next_attempt_at).toBe(T0 + H + 1000 + 15 * 60000);
    crash(T0 + 2 * H);
    r = cs.recoverAbandoned({ owner: 'new3', now: T0 + 2 * H + 1000, rand: () => 0.5 });
    expect(r.failed).toEqual([caseId]);
    c = cs.getCase(caseId);
    expect(c.case.state).toBe('FAILED');
    expect(c.case.last_error_code).toBe('crash_loop');
    expect(c.events.some((e) => e.kind === 'error' && e.reason_code === 'crash_loop')).toBe(true);
    expect(c.runs.every((x) => x.outcome === 'abandoned')).toBe(true);
  });

  it('leaves a case leased by the current live owner alone', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    cs.lease(caseId, 'me', T0 + 600000, { now: T0 });
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    expect(cs.recoverAbandoned({ owner: 'me', now: T0 + 1000 }).requeued).toEqual([]);
    expect(cs.lease(caseId, 'other', T0 + 600000, { now: T0 + 1000 })).toBe(false);
    expect(cs.lease(caseId, 'other', T0 + 1200000, { now: T0 + 700000 })).toBe(true);
  });
});

describe('prune', () => {
  function runs(caseId, n) {
    for (let i = 0; i < n; i++) {
      const r = cs.openRun({ caseId, trigger: 'scheduled', now: T0 + i * 1000 });
      cs.writeFindings(caseId, r, [{ source: 'aap_cache', field: 'f', value: i, observedAt: T0, retrievedAt: T0, freshness: 'RECENT', confidence: 0.9, trust: 'structured' }]);
      cs.persistRun(caseId, r, {}, null, { run: { outcome: 'unchanged' }, now: T0 + i * 1000 + 1 });
    }
  }
  const count = (t) => engine.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n;

  it('keeps the latest 5 runs per case with localHistory ON and at most every 6 h', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    runs(caseId, 7);
    const r = cs.prune({ now: T0 + 10000, localHistory: true });
    expect(r.runs).toBe(2);
    expect(count('ap_run')).toBe(5);
    expect(count('ap_finding')).toBe(5);
    expect(cs.prune({ now: T0 + 20000, localHistory: true }).skipped).toBe(true);
  });

  it('keeps 1 run with localHistory OFF and prunes events older than 180 days', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    runs(caseId, 3);
    cs.appendEvent({ caseId, at: T0 - 181 * 24 * H, kind: 'control', reason: 'old' });
    const before = count('ap_event');
    const r = cs.prune({ now: T0 + 10000, localHistory: false });
    expect(count('ap_run')).toBe(1);
    expect(count('ap_finding')).toBe(1);
    expect(r.events).toBe(1);
    expect(count('ap_event')).toBe(before - 1);
  });
});

describe('sweepResolution (plan R1 build time, R3 accepted codes)', () => {
  const down = { equipmentId: 'U1', lifecycleState: 'Unavailable' };
  const sweep = (rows, buildAtMs, syncedAt, now, extra) => cs.sweepResolution({
    rowsByUnit: new Map(rows.map((r) => [r.equipmentId.toUpperCase(), r])),
    fleetMeta: Object.assign({ source: 'aap-api', syncedAt, buildAtMs }, extra || {}),
    now,
  });

  it('(a) one build without the unit then two syncedAt re-stamps -> missing_syncs 1; a second build -> NEEDS_REVIEW', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    toMonitoring(caseId, T0);
    const B1 = T0 + H;
    sweep([], B1, new Date(B1).toISOString(), B1 + 1);
    sweep([], B1, new Date(B1 + 5 * 60000).toISOString(), B1 + 6 * 60000);
    sweep([], B1, new Date(B1 + 9 * 60000).toISOString(), B1 + 10 * 60000);
    let c = caseRow(caseId);
    expect(c.missing_syncs).toBe(1);
    expect(c.last_missing_build_at).toBe(B1);
    expect(c.state).toBe('MONITORING');
    sweep([], B1 + H, new Date(B1 + H).toISOString(), B1 + H + 1);
    c = caseRow(caseId);
    expect(c.missing_syncs).toBe(2);
    expect(c.state).toBe('NEEDS_REVIEW');
    expect(transitions(caseId).pop().reason_code).toBe('unit_missing');
    // The row reappearing resets both columns.
    sweep([down], B1 + 2 * H, null, B1 + 2 * H + 1);
    c = caseRow(caseId);
    expect(c.missing_syncs).toBe(0);
    expect(c.last_missing_build_at).toBe(null);
    expect(c.last_down_build_at).toBe(B1 + 2 * H);
  });

  it('a null build time counts nothing and moves nothing', () => {
    const { caseId } = cs.upsertDetected(cand('U1', { buildAtMs: null }), { now: T0 });
    toMonitoring(caseId, T0);
    sweep([], null, new Date(T0).toISOString(), T0 + 1);
    sweep([down], null, new Date(T0).toISOString(), T0 + 2);
    const c = caseRow(caseId);
    expect(c.missing_syncs).toBe(0);
    expect(c.last_down_build_at).toBe(null);
  });

  it('(b) a locally edited Active row plus a re-stamp does not resolve; a later real build does', () => {
    const B1 = T0 + H;
    const { caseId } = cs.upsertDetected(cand('U1', { buildAtMs: T0 }), { now: T0 });
    toMonitoring(caseId, T0);
    sweep([down], B1, new Date(B1).toISOString(), B1 + 1);
    expect(caseRow(caseId).last_down_build_at).toBe(B1);
    const active = { equipmentId: 'U1', lifecycleState: 'Active' };
    const r = sweep([active], B1, new Date(B1 + 30 * 60000).toISOString(), B1 + 31 * 60000);
    expect(r.resolved).toEqual([]);
    expect(caseRow(caseId).state).toBe('MONITORING');
    const r2 = sweep([active], B1 + H, new Date(B1 + H).toISOString(), B1 + H + 1);
    expect(r2.resolved).toEqual([caseId]);
    const c = caseRow(caseId);
    expect(c.state).toBe('RESOLVED');
    expect(c.resolution).toMatchObject({ source: 'aap-api', buildAt: B1 + H, lifecycleState: 'Active' });
  });

  it('a non-API row asks for NEEDS_REVIEW instead of resolving', () => {
    const { caseId } = cs.upsertDetected(cand('U1', { buildAtMs: T0 }), { now: T0 });
    toMonitoring(caseId, T0);
    sweep([{ equipmentId: 'U1', lifecycleState: 'Active' }], T0 + H, null, T0 + H + 1, { source: 'scrape' });
    expect(caseRow(caseId).state).toBe('NEEDS_REVIEW');
    expect(transitions(caseId).pop().reason_code).toBe('non_api_lifecycle');
  });

  it('R3: an accepted lifecycle_not_active stays MONITORING over the same build; a later Active build resolves', () => {
    const { caseId } = cs.upsertDetected(cand('U1', { buildAtMs: T0 }), { now: T0 });
    toMonitoring(caseId, T0);
    const ordered = { equipmentId: 'U1', lifecycleState: 'Ordered' };
    const B2 = T0 + H;
    sweep([ordered], B2, null, B2 + 1);
    expect(caseRow(caseId).state).toBe('NEEDS_REVIEW');
    expect(cs.review(caseId, 'accept', { now: B2 + 2, note: 'known' })).toEqual({ ok: true, state: 'MONITORING' });
    let c = caseRow(caseId);
    expect(c.review_status).toBe('accepted');
    expect(c.review_accepted_code).toBe('lifecycle_not_active');
    const nBefore = transitions(caseId).length;
    for (let i = 0; i < 3; i++) sweep([ordered], B2, null, B2 + 10 + i);
    expect(caseRow(caseId).state).toBe('MONITORING');
    expect(transitions(caseId).length).toBe(nBefore);
    sweep([{ equipmentId: 'U1', lifecycleState: 'Active' }], B2 + H, null, B2 + H + 1);
    c = caseRow(caseId);
    expect(c.state).toBe('RESOLVED');
    expect(c.review_accepted_code).toBe(null);
  });

  it('R3: a different review code or a return to down clears the accepted code', () => {
    const { caseId } = cs.upsertDetected(cand('U1', { buildAtMs: T0 }), { now: T0 });
    toMonitoring(caseId, T0);
    sweep([{ equipmentId: 'U1', lifecycleState: 'Ordered' }], T0 + H, null, T0 + H + 1);
    cs.review(caseId, 'accept', { now: T0 + H + 2 });
    sweep([{ equipmentId: 'U1', lifecycleState: 'Active' }], T0 + 2 * H, null, T0 + 2 * H + 1, { source: 'scrape' });
    let c = caseRow(caseId);
    expect(c.state).toBe('NEEDS_REVIEW');
    expect(c.review_accepted_code).toBe(null);
    cs.review(caseId, 'accept', { now: T0 + 2 * H + 2 });
    expect(caseRow(caseId).review_accepted_code).toBe('non_api_lifecycle');
    sweep([down], T0 + 3 * H, null, T0 + 3 * H + 1);
    c = caseRow(caseId);
    expect(c.review_accepted_code).toBe(null);
    expect(c.review_status).toBe('none');
  });
});

describe('review, pause, requeue', () => {
  it('review returns INVALID_STATE for a wrong state and supports acknowledge / rerun', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    expect(cs.review(caseId, 'acknowledge', { now: T0 })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(cs.review(caseId, 'accept', { now: T0 })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(cs.review(caseId, 'bogus', { now: T0 })).toEqual({ ok: false, code: 'INVALID_INPUT' });
    cs.transition(caseId, 'INVESTIGATING', { now: T0 });
    cs.transition(caseId, 'RECOMMENDATION_READY', { now: T0 });
    expect(cs.review(caseId, 'acknowledge', { now: T0 + 1 })).toEqual({ ok: true, state: 'MONITORING' });
    expect(caseRow(caseId).review_status).toBe('acknowledged');
    expect(cs.review(caseId, 'rerun', { now: T0 + 2 })).toEqual({ ok: true, state: 'QUEUED' });
    expect(transitions(caseId).pop()).toMatchObject({ actor: 'user', reason_code: 'manual' });
    cs.pauseCases([caseId], 'master_pause', { now: T0 + 3 });
    expect(cs.review(caseId, 'rerun', { now: T0 + 4 })).toEqual({ ok: false, code: 'INVALID_STATE' });
  });

  it('pauses and requeues by pause reason', () => {
    const a = cs.upsertDetected(cand('U1'), { now: T0 }).caseId;
    const b = cs.upsertDetected(cand('U2'), { now: T0 }).caseId;
    expect(cs.pauseCases([a, b], 'feature_off', { now: T0 })).toEqual([a, b]);
    expect(cs.pauseCases([a], 'feature_off', { now: T0 })).toEqual([]);
    expect(caseRow(a).pause_reason).toBe('feature_off');
    expect(cs.requeueCases({ pauseReasons: ['master_stop'], trigger: 'resume', now: T0 })).toEqual([]);
    expect(cs.requeueCases({ pauseReasons: ['feature_off'], trigger: 'feature_on', now: T0 + 1 }).sort()).toEqual([a, b].sort());
    const c = caseRow(a);
    expect(c.state).toBe('QUEUED');
    expect(c.pause_reason).toBe(null);
    expect(transitions(a).pop().reason_code).toBe('feature_on');
  });
});

describe('reads', () => {
  it('listCases matches q as a literal prefix (% and _ are not wildcards) and filters', () => {
    for (const u of ['A_1', 'AB1', 'A%2', 'B13014']) cs.upsertDetected(cand(u), { now: T0 });
    expect(cs.listCases({ q: 'a_' }).items.map((c) => c.unit_id)).toEqual(['A_1']);
    expect(cs.listCases({ q: 'A%' }).items.map((c) => c.unit_id)).toEqual(['A%2']);
    expect(cs.listCases({ q: 'A' }).total).toBe(3);
    expect(cs.listCases({ state: 'QUEUED', domicile: 'abe40', reason: 'DWELL_EXCEEDED' }).total).toBe(4);
    expect(cs.listCases({ reason: 'ETA_OVERDUE_VERIFIED' }).total).toBe(0);
    const p = cs.listCases({ limit: 2, offset: 2 });
    expect(p.total).toBe(4);
    expect(p.items.length).toBe(2);
    expect(cs.counts()).toMatchObject({ open: 4, byState: { QUEUED: 4 }, byDomicile: { ABE40: 4 }, byReason: { DWELL_EXCEEDED: 4 } });
  });

  it('getCase pages events by eventsOffset', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    for (let i = 0; i < 5; i++) cs.appendEvent({ caseId, at: T0 + i + 1, kind: 'control', reason: 'r' + i });
    const all = cs.getCase(caseId);
    expect(all.eventsTotal).toBe(7);
    expect(cs.getCase(caseId, { eventsOffset: 5 }).events.map((e) => e.reason_code)).toEqual(['r3', 'r4']);
    expect(cs.getCase('nope')).toBe(null);
  });

  it('bumpCounter accumulates per source and field', () => {
    cs.bumpCounter('2026-11-10', 'aap_live', 'live');
    cs.bumpCounter('2026-11-10', 'aap_live', 'live', 2);
    cs.bumpCounter('2026-11-10', 'decisiv', 'errors');
    expect(JSON.parse(cs.getMeta('counters:2026-11-10'))).toEqual({ aap_live: { live: 3 }, decisiv: { errors: 1 } });
  });
});

describe('guard scan of case-store.js', () => {
  const src = fs.readFileSync(require.resolve('../src/autopilot/case-store.js'), 'utf8');
  function functions() {
    const out = [];
    const re = /^function\s+(\w+)\s*\(/gm;
    let m;
    while ((m = re.exec(src)) !== null) {
      let i = src.indexOf('{', m.index);
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) break; }
      }
      out.push({ name: m[1], body: src.slice(i, j + 1) });
    }
    return out;
  }
  const TX = /(^|[^A-Za-z0-9])tx\(/g;
  const exported = (() => {
    const m = /module\.exports\s*=\s*\{([\s\S]*?)\};/.exec(src);
    return m[1].replace(/\/\/.*$/gm, '').split(/[\s,]+/).filter((x) => /^\w+$/.test(x));
  })();

  it('no _InTx helper body calls tx(', () => {
    const helpers = functions().filter((f) => /InTx$/.test(f.name));
    expect(helpers.length).toBeGreaterThanOrEqual(8);
    for (const h of helpers) expect(h.body.match(TX), h.name).toBe(null);
  });

  it('every exported function calls tx( at most once and no other exported function', () => {
    const fns = functions();
    const exportedFns = fns.filter((f) => exported.includes(f.name));
    expect(exportedFns.length).toBeGreaterThan(20);
    for (const f of exportedFns) {
      expect((f.body.match(TX) || []).length, f.name).toBeLessThanOrEqual(1);
      for (const other of exportedFns) {
        if (other.name === f.name) continue;
        expect(new RegExp('(^|[^A-Za-z0-9_.])' + other.name + '\\(').test(f.body), f.name + ' calls ' + other.name).toBe(false);
      }
    }
  });

  it('write SQL names only ap_* tables and requires only allowed modules', () => {
    const writes = src.match(/\b(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+(\w+)/g) || [];
    expect(writes.length).toBeGreaterThan(10);
    for (const w of writes) {
      const table = w.split(/\s+/).pop();
      if (table === 'SET') continue; // "ON CONFLICT ... DO UPDATE SET"
      expect(table).toMatch(/^ap_/);
    }
    const reqs = (src.match(/require\('([^']+)'\)/g) || []).map((r) => r.slice(9, -2));
    for (const r of reqs) expect(['crypto', '../store/sqlite_engine'].includes(r) || r.startsWith('./')).toBe(true);
  });
});
