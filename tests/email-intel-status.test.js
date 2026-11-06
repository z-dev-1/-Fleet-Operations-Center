// tests/email-intel-status.test.js — R1.7 outcome and per-folder statuses, R8.5 auth surfacing (read-only,
// no auth-report writes), F2-10 warning severities.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import { inboxRows, rowsScenarios } from './fixtures/email-intel/emails.js';
import { AUTH_URL } from './fixtures/email-intel/fake-owa.js';
import { makeHarness } from './fixtures/email-intel/scan-harness.js';
const require = createRequire(import.meta.url);
const st = require('../src/email-intel/reliability/status');
const cfg = require('../src/email-intel/config');

const F = (status, extra) => Object.assign({ folder: 'X', status, backlog: false, backlogRemaining: 0 }, extra || {});

describe('R1.7 outcome derivation', () => {
  it('R1.7 outcome and per-folder statuses accurate (derivation matrix)', () => {
    const D = (reader, extra) => st.deriveOutcome(Object.assign({ reader, committed: 1 }, extra || {}));
    expect(D({ ok: true, folders: [F('ok'), F('ok')] })).toEqual({ outcome: 'complete', partial: false, readError: null, errorCode: null });
    expect(D({ ok: true, folders: [F('ok'), F('skipped-budget', { backlog: true, backlogRemaining: 4 })] })).toMatchObject({ outcome: 'partial', readError: 'partial: budget' });
    expect(D({ ok: true, folders: [F('ok'), F('not-found')] })).toMatchObject({ outcome: 'partial', readError: 'partial: folder-not-found' });
    expect(D({ ok: true, timedOut: true, folders: [F('timeout')] })).toMatchObject({ outcome: 'partial', readError: 'partial: timeout' });
    expect(D({ ok: true, folders: [F('skipped-budget', { deadline: true })] })).toMatchObject({ outcome: 'partial', readError: 'partial: deadline' });
    expect(D({ ok: true, folders: [F('ok', { retried: 1 })] })).toMatchObject({ outcome: 'partial', readError: 'partial: preview-retry' });
    expect(D({ ok: true, folders: [F('ok')] }, { pendingAnalysis: 3 })).toMatchObject({ outcome: 'partial', readError: 'partial: pending-analysis' });
    expect(D({ ok: false, authBlocked: true, folders: [F('ok'), F('partial'), F('not-reached')] })).toEqual({ outcome: 'auth-blocked', partial: true, readError: 'auth blocked', errorCode: 'auth' });
    expect(D({ ok: false, authBlocked: true, folders: [] }, { committed: 0 })).toMatchObject({ outcome: 'auth-blocked', partial: false });
    expect(D({ ok: false, aborted: true, folders: [F('partial')] })).toMatchObject({ outcome: 'aborted', partial: true });
    expect(D({ ok: false, folders: [F('not-found')], error: 'no-folder-read' }, { committed: 0 })).toMatchObject({ outcome: 'failed', readError: 'read failed' });
    expect(D(null)).toMatchObject({ outcome: 'failed' });
    expect(D({ ok: true, folders: [F('ok')] }, { storeError: 'store' })).toMatchObject({ outcome: 'failed', errorCode: 'store' });
    expect(st.deriveOutcome({ skipped: true })).toMatchObject({ outcome: 'skipped' });
  });

  let h = null;
  afterEach(() => { if (h) h.cleanup(); h = null; });

  it('R1.7 the status document reports the last scan, per-folder checkpoints and backlog counts', async () => {
    h = makeHarness(rowsScenarios.busyInbox());
    await h.run({ max: 25 });
    const s = h.idx.getStatus();
    expect(s).toMatchObject({ ok: true, enabled: true, scan: { running: false, current: null } });
    expect(s.scan.last).toMatchObject({ outcome: 'partial', partial: true });
    const inbox = s.checkpoints.folders.find((f) => f.folder === 'Inbox');
    expect(inbox).toMatchObject({ caughtUp: false, backlog: true, backlogRemaining: 41, lastOutcome: 'skipped-budget' });
    expect(s.checkpoints.folders.find((f) => f.folder === 'DOMO')).toMatchObject({ caughtUp: true, backlog: false, lastOutcome: 'ok' });
    expect(s.backlog.pendingAnalysis).toBe(25);                      // Phase A: v2 analysis is pending for every ingested message
    expect(s.identity).toEqual({ set: false });
    expect(JSON.stringify(s)).not.toMatch(/@example\.test|Body for/);
  });
});

describe('R8.5 auth surfacing', () => {
  let h = null;
  afterEach(() => { if (h) h.cleanup(); h = null; });
  it('R8.5 auth block visible, midway read-only, no auth-report writes', async () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 6) }, { onExec: async (kind, n, api, world) => { if (kind === 'open' && world.openLog.length === 2) api.navigate(AUTH_URL); } });
    await h.run({ max: 25 });
    const s = h.idx.getStatus();
    expect(s.owaAuth).toMatchObject({ state: 'blocked', blockedCount: 1 });
    expect(s.owaAuth.lastBlockedAt).toEqual(expect.any(String));
    expect(s.warnings).toContain('auth-blocked');
    expect(s.warningDetails.find((w) => w.code === 'auth-blocked').severity).toBe('error');
    expect(s.midway).toBeNull();
    // The module never writes the auth modules (owaAuth is local state only). status.js is the single
    // read-only reader of auth-report (currentStatus(), design 8.6); nothing calls .report(.
    for (const f of ['src/email-intel/reliability/status.js', 'src/email-intel/index.js', 'src/email-intel/capture/owa_capture.js']) {
      const src = fs.readFileSync(require.resolve('../' + f), 'utf8');
      const requires = Array.from(src.matchAll(/require\(\s*'([^']*auth[^']*)'\s*\)/g)).map((m) => m[1]);
      expect(requires, f).toEqual(f.endsWith('status.js') ? ['../../auth/auth-report'] : []);
      expect(src, f).not.toMatch(/\.report\(/);
    }
  });

  it('R8.5 midway is the read-only auth-report currentStatus(); owaAuth never reaches any auth module', async () => {
    const ar = require('../src/auth/auth-report');
    const report = vi.spyOn(ar, 'report');
    const stepUp = vi.spyOn(ar, 'reportStepUp');
    ar._setEnabledForTest(true);
    ar._setStatusForTest({ state: 'HEALTHY', level: 'ok' });
    try {
      h = makeHarness({ Inbox: inboxRows('Inbox', 2) });
      await h.run({ _warm: async () => ({ authWall: true, url: AUTH_URL }) });
      const s = h.idx.getStatus();
      expect(s.owaAuth.state).toBe('blocked');
      expect(s.midway).toEqual({ state: 'HEALTHY', level: 'ok' });
      expect(report).not.toHaveBeenCalled();
      expect(stepUp).not.toHaveBeenCalled();
    } finally { ar._reset(); report.mockRestore(); stepUp.mockRestore(); }
  });
});

describe('F2-05 supervisor, jobs and paused-until surfacing', () => {
  let h = null;
  afterEach(() => { if (h) h.cleanup(); h = null; vi.restoreAllMocks(); });
  const WORKER = (over) => Object.assign({
    name: 'emailTriage', group: 'comms', label: 'Email triage auto-scan', state: 'healthy', breakerState: 'ok', isolations: 0, isolatedUntil: null,
    nextRunAt: 1_800_000_600_000, consecutiveFailures: 0, disabledReason: null, lastEndAt: 1_800_000_000_000, counts: { runs: 4 },
  }, over || {});

  it('F2-05 status.supervisor carries state, breakerState, isolatedUntil and nextRunAt for the emailTriage worker', async () => {
    const sup = require('../src/workers/supervisor');
    vi.spyOn(sup, 'getStatus').mockReturnValue({ enabled: true, workers: [WORKER({ name: 'repairIntel' }), WORKER()] });
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    const s = h.idx.getStatus();
    expect(s.supervisor).toEqual({ state: 'healthy', breakerState: 'ok', isolatedUntil: null, nextRunAt: 1_800_000_600_000, isolations: 0, consecutiveFailures: 0, disabledReason: null, lastEndAt: 1_800_000_000_000 });
    expect(s.scheduledPausedUntil).toBeNull();
    expect(s.jobs).toMatchObject({ type: 'emailTriage', mode: 'off', effective: false, open: null });
    // no supervisor entry (legacy timer, supervisor off) -> null
    sup.getStatus.mockReturnValue({ enabled: false, workers: [] });
    expect(h.idx.getStatus().supervisor).toBeNull();
    // the supervisor module is only read
    expect(fs.readFileSync(require.resolve('../src/email-intel/reliability/status.js'), 'utf8')).not.toMatch(/supervisor'\)\.(claim|stop|reEnable|wake)/);
  });

  it('F2-05 scheduledPausedUntil is set only when the supervisor entry is isolated', async () => {
    const until = 1_800_003_600_000;
    expect(st.pausedUntil(WORKER({ state: 'isolated', breakerState: 'isolated', isolatedUntil: until }))).toBe(until);
    expect(st.pausedUntil(WORKER({ state: 'degraded', breakerState: 'ok', isolatedUntil: until }))).toBeNull();
    expect(st.pausedUntil(WORKER({ state: 'disabled', breakerState: 'budget-exhausted', isolatedUntil: until }))).toBeNull();
    expect(st.pausedUntil(WORKER({ state: 'isolated', isolatedUntil: null }))).toBeNull();
    expect(st.pausedUntil(null)).toBeNull();
    const sup = require('../src/workers/supervisor');
    vi.spyOn(sup, 'getStatus').mockReturnValue({ enabled: true, workers: [WORKER({ state: 'isolated', breakerState: 'isolated', isolations: 1, isolatedUntil: until, nextRunAt: until })] });
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    const s = h.idx.getStatus();
    expect(s.scheduledPausedUntil).toBe(until);
    expect(s.supervisor).toMatchObject({ state: 'isolated', breakerState: 'isolated', isolatedUntil: until, isolations: 1 });
    expect(s.warnings).toContain('scheduled-paused');
    // a manual scan still runs while scheduled scans are paused
    const res = await h.run({ max: 25 });
    expect(res.intel.outcome).toBe('complete');
    // the IPC status channel returns the same field
    expect(h.idx.getStatus().scheduledPausedUntil).toBe(until);
  });

  it('F-17 gateway flags are relay queueStats().flags, read-only, only while multiRecipient is effective', () => {
    h = makeHarness({ Inbox: inboxRows('Inbox', 1) });
    const lane = require('../src/email-intel/understand/lane');
    const relay = { isolatedLaneAvailable: () => true, queueStats: () => ({ queued: 3, flags: { priorities: true, abortOnTimeout: false, dedupe: true, routerDecides: false, reserveSlots: 2 } }) };
    lane._setRelayForTests(relay);
    try {
      expect(h.idx.getStatus().aiGateway).toBeNull();                          // capture only: relay is not consulted
      h.flags._setForTests({ enabled: true, capture: true, multiRecipient: true });
      expect(h.idx.getStatus().aiGateway).toEqual({ priorities: true, abortOnTimeout: false, dedupe: true, routerDecides: false });
      relay.queueStats = () => { throw new Error('relay down'); };
      expect(h.idx.getStatus().aiGateway).toBeNull();
    } finally { lane._resetForTests(); }
  });
});

describe('F2-10 identity and FAS-name warnings', () => {
  it('F2-10 fas-name-not-set is an info warning when me.fasName is empty; identity-not-set is a warning', () => {
    const empty = st.buildWarnings({ config: cfg.defaults() });
    expect(empty).toEqual([{ code: 'identity-not-set', severity: 'warning' }, { code: 'fas-name-not-set', severity: 'info' }]);
    const named = st.buildWarnings({ config: cfg.validate({ me: { names: ['Zila Santiago'] } }).config });
    expect(named).toEqual([{ code: 'fas-name-not-set', severity: 'info' }]);
    const full = st.buildWarnings({ config: cfg.validate({ me: { names: ['Zila Santiago'], fasName: 'Zila S' } }).config });
    expect(full).toEqual([]);
    expect(st.WARNING_SEVERITY['fas-name-not-set']).toBe('info');
    expect(st.WARNING_SEVERITY['identity-not-set']).toBe('warning');
    expect(st.severityOf('clamped-caps.maxEmails')).toBe('info');
  });

  it('flag warnings and newer-version stores are surfaced', () => {
    const w = st.buildWarnings({ config: null, flagWarnings: ['timelineWrites-needs-actionsView'], readOnlyStores: [false, true] }).map((x) => x.code);
    expect(w).toEqual(['timelineWrites-needs-actionsView', 'storeVersionNewer']);
  });
});
