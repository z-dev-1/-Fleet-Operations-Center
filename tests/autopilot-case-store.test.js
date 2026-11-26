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
const DAY_MS = 24 * H;

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
    expect(cs.getMeta('schema_version')).toBe('2');
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

describe('V2 leases and steps (FR-12.1)', () => {
  const finding = (field, value) => ({ source: 'aap_cache', field, value, observedAt: T0, retrievedAt: T0, freshness: 'RECENT', confidence: 0.9, trust: 'structured' });
  function leased(owner) {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    expect(cs.leaseRun(caseId, owner || 'p#run1', T0 + 600000, { now: T0 })).toBe(true);
    cs.transition(caseId, 'INVESTIGATING', { now: T0, leaseOwner: owner || 'p#run1' });
    const runId = cs.openRun({ caseId, trigger: 'new', now: T0 });
    return { caseId, runId };
  }

  it('leaseRun takes a free or expired lease; renewLease extends it or throws LEASE_LOST', () => {
    const { caseId } = leased();
    expect(cs.leaseRun(caseId, 'p#run2', T0 + 600000, { now: T0 + 1 })).toBe(false);
    expect(cs.renewLease(caseId, 'p#run1', T0 + 900000, { now: T0 + 2 })).toBe(true);
    expect(caseRow(caseId).lease_until).toBe(T0 + 900000);
    expect(() => cs.renewLease(caseId, 'p#run2', T0 + 900000, { now: T0 + 3 })).toThrow(/LEASE_LOST/);
    expect(cs.leaseRun(caseId, 'p#run2', T0 + 2000000, { now: T0 + 900001 })).toBe(true);
    expect(() => cs.renewLease(caseId, 'p#run1', T0 + 2000000, { now: T0 + 900002 })).toThrow(/LEASE_LOST/);
  });

  it('beginStep writes a pending step with idem / call keys; a repeated (run, seq, kind, tool, args) throws STEP_EXISTS', () => {
    const { caseId, runId } = leased();
    const step = { caseId, runId, seq: 1, turn: 1, kind: 'tool', tool: 'aap_comments', args: { woId: 'svc-1' }, source: 'aap_live', live: true, sourceFp: 'sfp' };
    const s1 = cs.beginStep(step, { leaseOwner: 'p#run1', leaseUntil: T0 + 700000, now: T0 + 10 });
    expect(s1.stepId).toMatch(/^st_[a-f0-9]{16}$/);
    const row = engine.prepare('SELECT * FROM ap_step WHERE step_id = ?').get(s1.stepId);
    expect(row).toMatchObject({ status: 'pending', kind: 'tool', tool: 'aap_comments', live: 1, idem_key: s1.idemKey, call_key: s1.callKey, args_json: '{"woId":"svc-1"}' });
    expect(caseRow(caseId).lease_until).toBe(T0 + 700000);
    expect(() => cs.beginStep(step, { leaseOwner: 'p#run1', now: T0 + 11 })).toThrow(/STEP_EXISTS/);
    expect(() => cs.beginStep(Object.assign({}, step, { seq: 2 }), { leaseOwner: 'p#other', now: T0 + 12 })).toThrow(/LEASE_LOST/);
    expect(engine.prepare('SELECT COUNT(*) AS n FROM ap_step').get().n).toBe(1);
  });

  it('reserveAiTurn bumps ai_calls and inserts the pending model step only below the cap', () => {
    const { caseId, runId } = leased();
    const m = { leaseOwner: 'p#run1', now: T0 };
    expect(cs.reserveAiTurn({ caseId, runId, seq: 1, turn: 1 }, '2026-11-10', 2, m)).toMatchObject({ stepId: expect.any(String) });
    expect(cs.reserveAiTurn({ caseId, runId, seq: 2, turn: 2 }, '2026-11-10', 2, m)).toBeTruthy();
    expect(cs.reserveAiTurn({ caseId, runId, seq: 3, turn: 3 }, '2026-11-10', 2, m)).toBe(false);
    expect(cs.getMeta('ai_calls:2026-11-10')).toBe('2');
    expect(engine.prepare("SELECT COUNT(*) AS n FROM ap_step WHERE kind = 'model' AND status = 'pending'").get().n).toBe(2);
    expect(() => cs.reserveAiTurn({ caseId, runId, seq: 4, turn: 4 }, '2026-11-11', 5, { leaseOwner: 'x', now: T0 })).toThrow(/LEASE_LOST/);
    expect(cs.getMeta('ai_calls:2026-11-11')).toBe(null);
  });

  it('completeStep closes a pending step and writes its findings with step_id; only once', () => {
    const { caseId, runId } = leased();
    const s = cs.beginStep({ caseId, runId, seq: 1, turn: 1, kind: 'tool', tool: 'decisiv_stage', args: {} }, { leaseOwner: 'p#run1', now: T0 });
    const out = cs.completeStep(s.stepId, { status: 'ok', summary: { count: 1 }, resultBytes: 120 }, [finding('stage', 'repair')], { leaseOwner: 'p#run1', now: T0 + 50 });
    expect(out).toEqual({ updated: 1, findings: 1 });
    const st = cs.stepsForRun(runId)[0];
    expect(st).toMatchObject({ status: 'ok', ended_at: T0 + 50, ms: 50, result_bytes: 120, summary: { count: 1 } });
    expect(engine.prepare('SELECT step_id FROM ap_finding WHERE run_id = ?').get(runId).step_id).toBe(s.stepId);
    expect(() => cs.completeStep(s.stepId, { status: 'ok' }, [], { leaseOwner: 'p#run1', now: T0 + 60 })).toThrow(/STEP_NOT_PENDING/);
    expect(cs.listSteps(caseId).length).toBe(1);
  });

  it('LEASE_LOST on transition, writeFindings, appendEvent, writeCheckpoint, writeMemory and persistRun leaves the case unchanged', () => {
    const { caseId, runId } = leased();
    cs.leaseRun(caseId, 'p#run2', T0 + 2000000, { now: T0 + 700000 });   // taken over after expiry
    const m = { leaseOwner: 'p#run1', now: T0 + 700001 };
    const before = caseRow(caseId);
    expect(() => cs.transition(caseId, 'ANALYZING', m)).toThrow(/LEASE_LOST/);
    expect(() => cs.writeFindings(caseId, runId, [finding('x', 1)], m)).toThrow(/LEASE_LOST/);
    expect(() => cs.appendEvent({ caseId, at: T0, kind: 'control', reason: 'x' }, m)).toThrow(/LEASE_LOST/);
    expect(() => cs.writeCheckpoint(runId, { step: 'evidence_done' }, m)).toThrow(/LEASE_LOST/);
    expect(() => cs.writeMemory(caseId, { v: 1 }, m)).toThrow(/LEASE_LOST/);
    expect(() => cs.persistRun(caseId, runId, { repair_phase: 'x' }, 'MONITORING', Object.assign({ run: { outcome: 'recommendation' } }, m))).toThrow(/LEASE_LOST/);
    const after = caseRow(caseId);
    expect(after.state).toBe('INVESTIGATING');
    expect(after.version).toBe(before.version);
    expect(engine.prepare('SELECT COUNT(*) AS n FROM ap_finding').get().n).toBe(0);
    expect(cs.getRun(runId).checkpoint).toBe(null);
    expect(cs.transition(caseId, 'ANALYZING', { leaseOwner: 'p#run2', now: T0 + 700002 })).toBe('INVESTIGATING');
  });

  it('writeMemory rejects memory over 32 KB with MEMORY_TOO_LARGE', () => {
    const { caseId } = leased();
    expect(() => cs.writeMemory(caseId, { v: 1, pad: 'x'.repeat(40000) }, { leaseOwner: 'p#run1', now: T0 })).toThrow(/MEMORY_TOO_LARGE/);
    expect(cs.writeMemory(caseId, { v: 1 }, { leaseOwner: 'p#run1', now: T0 })).toBe(true);
    expect(caseRow(caseId).memory).toEqual({ v: 1 });
  });

  it('persistRun with leaseOwner upserts ap_record and inserts proposals once', () => {
    const { caseId, runId } = leased();
    const prop = { fingerprint: 'fp1', source: 'decisiv', evidenceRef: 'ev_1', basis: 'verified', kind: 'stage', description: 'Stage repair', eventAt: T0 };
    cs.persistRun(caseId, runId, {}, 'MONITORING', { leaseOwner: 'p#run1', run: { outcome: 'recommendation' }, record: { oos_status: 'down', confidence: 0.7, record_json: { a: 1 } }, proposals: [prop, prop], now: T0 + 5 });
    expect(cs.getRecord(caseId)).toMatchObject({ unit_id: 'U1', oos_status: 'down', confidence: 0.7, record: { a: 1 }, investigated_at: T0 + 5 });
    expect(cs.listProposals(caseId).length).toBe(1);
    expect(cs.listProposals(caseId)[0]).toMatchObject({ proposal_id: expect.stringMatching(/^tp_[a-f0-9]{16}$/), status: 'proposed', basis: 'verified', run_id: runId });
  });

  it('recoverAbandoned interrupts pending steps and treats <owner>#<run> leases as ours', () => {
    const { caseId, runId } = leased('boot#run1');
    cs.beginStep({ caseId, runId, seq: 1, turn: 0, kind: 'tool', tool: 't', args: {} }, { leaseOwner: 'boot#run1', now: T0 });
    const r = cs.recoverAbandoned({ owner: 'boot', now: T0 + 1000 });
    expect(r.interruptedSteps).toBe(1);
    expect(r.requeued).toEqual([]);
    expect(cs.stepsForRun(runId)[0]).toMatchObject({ status: 'interrupted', ended_at: T0 + 1000 });
    expect(cs.recoverAbandoned({ owner: 'other', now: T0 + 2000 }).requeued).toEqual([caseId]);
  });

  it('copyRunForResume copies the steps with new ids / idem keys and remaps finding step ids', () => {
    const { caseId, runId } = leased();
    const s = cs.beginStep({ caseId, runId, seq: 1, turn: 1, kind: 'tool', tool: 'aap_comments', args: { a: 1 }, sourceFp: 'f' }, { leaseOwner: 'p#run1', now: T0 });
    cs.completeStep(s.stepId, { status: 'ok' }, [finding('f', 1)], { leaseOwner: 'p#run1', now: T0 + 1 });
    const r2 = cs.openRun({ caseId, trigger: 'recovered', now: T0 + 2 });
    cs.copyRunForResume(runId, r2, { now: T0 + 3 });
    const copy = cs.stepsForRun(r2)[0];
    expect(copy.step_id).not.toBe(s.stepId);
    expect(copy.copied_from).toBe(s.stepId);
    expect(copy.idem_key).not.toBe(s.idemKey);
    expect(copy.call_key).toBe(s.callKey);
    expect(engine.prepare('SELECT step_id FROM ap_finding WHERE run_id = ?').get(r2).step_id).toBe(copy.step_id);
    expect(cs.findReusableStep(caseId, s.callKey, T0 - 1)).toMatchObject({ call_key: s.callKey, status: 'ok' });
    expect(cs.findReusableStep(caseId, s.callKey, T0 + 1)).toBe(null);
  });
});

describe('V2 queue: queued_since, aging, promotion, deep requests', () => {
  it('queued_since is set on entering QUEUED, kept across INVESTIGATING and a deferral back to QUEUED, cleared at rest', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    expect(caseRow(caseId).queued_since).toBe(T0);
    cs.transition(caseId, 'INVESTIGATING', { now: T0 + H });
    expect(caseRow(caseId).queued_since).toBe(T0);
    cs.persistRun(caseId, null, { next_attempt_at: T0 + 2 * H }, 'QUEUED', { run: { outcome: 'deferred' }, now: T0 + H + 1 });
    expect(caseRow(caseId).queued_since).toBe(T0);
    cs.transition(caseId, 'INVESTIGATING', { now: T0 + 3 * H });
    cs.transition(caseId, 'MONITORING', { now: T0 + 3 * H });
    expect(caseRow(caseId).queued_since).toBe(null);
    cs.review(caseId, 'rerun', { now: T0 + 4 * H });
    expect(caseRow(caseId).queued_since).toBe(T0 + 4 * H);
  });

  it('pickQueued adds MIN(cap, hours x boost): +40 exactly at 60 h; the V1 2-arg form ignores aging', () => {
    const old = cs.upsertDetected(cand('OLD'), { now: T0 - 60 * H }).caseId;
    const fresh = cs.upsertDetected(cand('NEW'), { now: T0 }).caseId;
    const mid = cs.upsertDetected(cand('MID'), { now: T0 }).caseId;
    engine.prepare('UPDATE ap_case SET priority = ? WHERE case_id = ?').run(10, old);
    engine.prepare('UPDATE ap_case SET priority = ? WHERE case_id = ?').run(50, fresh);
    engine.prepare('UPDATE ap_case SET priority = ? WHERE case_id = ?').run(49, mid);
    const aging = { boost: 2, cap: 40 };
    // old: 10 + min(40, 60 * 2) = 50 -> ties with fresh 50 and wins on the older queued_since.
    expect(cs.pickQueued(3, T0, aging).map((c) => c.case_id)).toEqual([old, fresh, mid]);
    engine.prepare('UPDATE ap_case SET priority = ? WHERE case_id = ?').run(51, fresh);
    expect(cs.pickQueued(3, T0, aging).map((c) => c.case_id)).toEqual([fresh, old, mid]);
    expect(cs.pickQueued(3, T0, { boost: 2, cap: 60 }).map((c) => c.case_id)).toEqual([old, fresh, mid]);
    expect(cs.pickQueued(3, T0).map((c) => c.case_id)).toEqual([fresh, mid, old]);
    expect(cs.queuedCount()).toBe(3);
  });

  it('promoteDetected moves held cases to QUEUED by priority + aging on created_at', () => {
    const a = cs.upsertDetected(cand('A'), { now: T0 - 30 * H, hold: true }).caseId;
    const b = cs.upsertDetected(cand('B'), { now: T0, hold: true }).caseId;
    const c = cs.upsertDetected(cand('C'), { now: T0, hold: true }).caseId;
    engine.prepare('UPDATE ap_case SET priority = 20 WHERE case_id = ?').run(a);
    engine.prepare('UPDATE ap_case SET priority = 70 WHERE case_id = ?').run(b);
    engine.prepare('UPDATE ap_case SET priority = 60 WHERE case_id = ?').run(c);
    // a: 20 + min(40, 30 * 2) = 60 ties c and wins on created_at.
    expect(cs.promoteDetected(2, { now: T0, boost: 2, cap: 40 })).toEqual([b, a]);
    expect(caseRow(a).state).toBe('QUEUED');
    expect(caseRow(c).state).toBe('DETECTED');
    expect(transitions(a).pop().reason_code).toBe('promoted');
    expect(cs.promoteDetected(0, { now: T0 })).toEqual([]);
  });

  it('requestDeep raises priority to >= 95, requeues (manual) and returns the V2 codes', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    toMonitoring(caseId, T0);
    engine.prepare('UPDATE ap_case SET priority = 20, next_attempt_at = ? WHERE case_id = ?').run(T0 + DAY_MS, caseId);
    const q60 = cs.upsertDetected(cand('U2'), { now: T0 }).caseId;
    engine.prepare('UPDATE ap_case SET priority = 60 WHERE case_id = ?').run(q60);
    expect(cs.requestDeep(caseId, { now: T0 + 1 })).toEqual({ ok: true, state: 'QUEUED' });
    const c = cs.getCase(caseId);
    expect(c.case).toMatchObject({ priority: 95, deep_requested_at: T0 + 1, next_attempt_at: null, state: 'QUEUED' });
    expect(c.events.some((e) => e.kind === 'review' && e.reason_code === 'deep')).toBe(true);
    expect(transitions(caseId).pop()).toMatchObject({ to_state: 'QUEUED', reason_code: 'manual', actor: 'user' });
    expect(cs.pickQueued(1, T0 + 2, { boost: 2, cap: 40 })[0].case_id).toBe(caseId);
    engine.prepare('UPDATE ap_case SET priority = 99 WHERE case_id = ?').run(caseId);
    expect(cs.requestDeep(caseId, { now: T0 + 3 })).toEqual({ ok: true, state: 'QUEUED' });
    expect(caseRow(caseId).priority).toBe(99);
    cs.transition(caseId, 'INVESTIGATING', { now: T0 + 4 });
    expect(cs.requestDeep(caseId, { now: T0 + 5 })).toEqual({ ok: false, code: 'CASE_BUSY' });
    cs.transition(caseId, 'MONITORING', { now: T0 + 6 });
    cs.review(caseId, 'rerun', { now: T0 + 6 });
    expect(cs.pauseCases([caseId], 'master_pause', { now: T0 + 6 })).toEqual([caseId]);
    expect(cs.requestDeep(caseId, { now: T0 + 7 })).toEqual({ ok: false, code: 'INVALID_STATE' });
    expect(cs.requestDeep('nope', { now: T0 })).toEqual({ ok: false, code: 'NOT_FOUND' });
  });
});

describe('V2 coverage writes and reads', () => {
  it('applyPass stores the pass, writes only changed units, deletes vanished units and flags a mismatch', () => {
    const pass = { at: T0, mode: 'fleet', fleet_rows: 2, duplicate_rows: 0, invalid_rows: 0, eligible: 2, down_eligible: 1, case_open: 1, reconcile_ok: 1, tokens_without_rows_json: '["ZZZ9"]' };
    const u = (id, cov) => ({ unit_id: id, eligibility: 'POWER_ELIGIBLE', equipment_class: 'tractor', coverage: cov, is_down: 1, row_hash: id + cov });
    expect(cs.applyPass(pass, [u('A', 'case_open'), u('B', 'not_down')], { now: T0 })).toEqual({ written: 2, deleted: 0 });
    expect(cs.applyPass(Object.assign({}, pass, { at: T0 + 1 }), [u('A', 'case_open'), u('B', 'not_down')], { now: T0 + 1 })).toEqual({ written: 0, deleted: 0 });
    expect(cs.applyPass(Object.assign({}, pass, { at: T0 + 2 }), [u('A', 'below_threshold')], { now: T0 + 2 })).toEqual({ written: 1, deleted: 1 });
    expect(cs.listUnits({}).items.map((x) => [x.unit_id, x.coverage, x.first_seen_at])).toEqual([['A', 'below_threshold', T0]]);
    const cov = cs.coverage(T0 + 3);
    expect(cov.pass).toMatchObject({ at: T0 + 2, tokensWithoutRows: ['ZZZ9'] });
    expect(cov.reconcileOk).toBe(true);
    cs.applyPass(Object.assign({}, pass, { at: T0 + 4, eligible: 5, reconcile_ok: 0 }), [], { now: T0 + 4 });
    const mm = engine.prepare("SELECT detail_json FROM ap_event WHERE kind = 'coverage_mismatch'").all();
    expect(mm.length).toBe(1);
    expect(JSON.parse(mm[0].detail_json)).toMatchObject({ rowsDiff: -3, downDiff: 0 });
  });

  it('queueStats, aiBacklog, aiMetrics and sourceMetrics read the §10.1 definitions', () => {
    const a = cs.upsertDetected(cand('A'), { now: T0 - 2 * H }).caseId;
    cs.upsertDetected(cand('B'), { now: T0, hold: true });
    const qs = cs.queueStats(T0);
    expect(qs).toMatchObject({ detectedHeld: 1, queued: 1, active: 0, oldestQueuedAt: T0 - 2 * H, oldestQueuedAgeMs: 2 * H, queueCoveragePct: 0 });
    const runId = cs.openRun({ caseId: a, trigger: 'new', now: T0 - H });
    cs.persistRun(a, runId, { ai_pending_reason: 'cap' }, null, { run: { outcome: 'recommendation', aiStatus: 'ok', aiLatencyMs: 1200, sourceCalls: { aap_live: { live: 2, errors: { RATE_LIMITED: 1 } } } }, now: T0 - H + 10 });
    expect(cs.queueStats(T0)).toMatchObject({ completedLast6h: 1, processingRatePerHour: 0.2, deferredAi: 1 });
    expect(cs.aiBacklog(T0, { cap: 48 })).toMatchObject({ notYetAi: 2, deferred: { cap: 1 }, completed24h: 1, cap: 48 });
    expect(cs.aiMetrics(T0, { cap: 48 })).toMatchObject({ calls: 1, p50Ms: 1200, p95Ms: 1200, failures: 0, cap: 48 });
    expect(cs.sourceMetrics(T0).aap_live).toMatchObject({ ok: 2, rate_limited: 1 });
    expect(cs.releaseAiDeferred('cap', { now: T0 })).toBe(1);
    expect(caseRow(a).ai_retry_at).toBe(T0);
    expect(cs.setSliceBaseline(a, { comments: 'x' }, { now: T0 })).toBe(true);
    expect(cs.setSliceBaseline(a, { comments: 'y' }, { now: T0 })).toBe(false);
    expect(caseRow(a).slice_fps).toEqual({ comments: 'x' });
  });
});

describe('acceptance fixes: cited earlier-run findings (F1) and source metrics (F2)', () => {
  const fnd = (id, field, extra) => Object.assign({ evidenceId: id, source: 'aap_cache', field, value: field, observedAt: T0, retrievedAt: T0, freshness: 'RECENT', confidence: 0.9, trust: 'structured' }, extra || {});

  it('F1: getCase appends the cited earlier-run findings once, marked cited_from_run with their own run_id', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    const r1 = cs.openRun({ caseId, trigger: 'new', now: T0 });
    cs.writeFindings(caseId, r1, [fnd('ev_a', 'f1'), fnd('ev_b', 'f2', { trust: 'untrusted_text', source: 'email' }), fnd('ev_c', 'f3', { conflictGroup: 'cf_x' }), fnd('ev_z', 'f9')]);
    const rec = { recommendedActions: [{ action: 'x', evidenceIds: ['ev_a', 'ev_b'] }], actionsRequiringApproval: [{ action: 'y', evidenceIds: ['ev_c', 'ev_nope'] }] };
    cs.persistRun(caseId, r1, { recommendation_json: JSON.stringify(rec), ai_findings_json: JSON.stringify({ generatedBy: 'ai', confirmedFacts: [{ statement: 's', evidenceIds: ['ev_a'] }] }) }, null, { run: { outcome: 'recommendation' }, now: T0 + 1 });
    // A later run (harness / cap / unchanged) re-collects only ev_a.
    const r2 = cs.openRun({ caseId, trigger: 'harness', now: T0 + 10 });
    cs.writeFindings(caseId, r2, [fnd('ev_a', 'f1')]);
    cs.persistRun(caseId, r2, {}, null, { run: { outcome: 'unchanged' }, now: T0 + 11 });
    const g = cs.getCase(caseId);
    expect(g.findings.map((f) => [f.evidence_id, f.run_id, !!f.cited_from_run])).toEqual([
      ['ev_a', r2, false], ['ev_b', r1, true], ['ev_c', r1, true],
    ]);
    const b = g.findings.find((f) => f.evidence_id === 'ev_b');
    expect(b).toMatchObject({ source: 'email', trust: 'untrusted_text' });
    // Read only: nothing was copied into the latest run.
    expect(cs.findingsForRun(r2).map((it) => it.evidenceId)).toEqual(['ev_a']);
  });

  it('F2: live tool steps count under the gate source; cache-served ok steps are cache_only; copied steps count once', () => {
    const { caseId } = cs.upsertDetected(cand('U1'), { now: T0 });
    expect(cs.leaseRun(caseId, 'p#run1', T0 + 600000, { now: T0 })).toBe(true);
    const runId = cs.openRun({ caseId, trigger: 'new', now: T0 });
    const M = { leaseOwner: 'p#run1', now: T0 + 1 };
    const step = (seq, tool, source, done) => {
      const s = cs.beginStep({ caseId, runId, seq, turn: 1, kind: 'tool', tool, args: { seq }, source, live: true }, M);
      cs.completeStep(s.stepId, done, [], M);
    };
    step(1, 'aap_comments', 'aap_cache', { status: 'unavailable', code: 'NOT_WARM', summary: { count: 1, cacheServed: true } });
    step(2, 'decisiv_activity', 'decisiv', { status: 'ok', code: 'CACHE_FRESH', summary: { count: 2 } });
    step(3, 'paccar_asist', 'decisiv', { status: 'empty', code: 'NOT_PACCAR', summary: { count: 0 } });
    step(4, 'decisiv_activity', 'decisiv', { status: 'ok', code: null, summary: { count: 3, live: true } });
    const m = cs.sourceMetrics(T0 + 5);
    expect(m.aap_live).toMatchObject({ not_warm: 1, ok: 0 });
    expect(m.aap_cache).toBeUndefined();
    expect(m.decisiv).toMatchObject({ ok: 1, cache_only: 2 });
    // A resumed run copies the steps (they keep their earlier started_at): no double count.
    const r2 = cs.openRun({ caseId, trigger: 'recovered', now: T0 + 10 });
    cs.copyRunForResume(runId, r2, { now: T0 + 11 });
    expect(cs.sourceMetrics(T0 + 12)).toEqual(m);
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
