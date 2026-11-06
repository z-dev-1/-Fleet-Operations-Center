// tests/email-intel-status.test.js — R1.7 outcome and per-folder statuses, R8.5 auth surfacing (read-only,
// no auth-report writes), F2-10 warning severities.
import { describe, it, expect, afterEach } from 'vitest';
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
    // The module never imports or writes the auth modules (owaAuth is local state only).
    for (const f of ['src/email-intel/reliability/status.js', 'src/email-intel/index.js', 'src/email-intel/capture/owa_capture.js']) {
      const src = fs.readFileSync(require.resolve('../' + f), 'utf8');
      expect(src, f).not.toMatch(/require\([^)]*auth/);
      expect(src, f).not.toMatch(/\.report\(/);
    }
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
