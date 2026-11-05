// tests/longdwell-fill-logic.test.js — pure renderer logic for the durable
// Long Dwell AI Fill: fingerprint, summary/status/badge strings (escaping),
// and the runDurableFill orchestrator against a fake bridge.
import { describe, it, expect } from 'vitest';
import {
  fillFingerprint, fillSummaryText, filledBadgeHtml, fillStatusText, fillStatusHtml, escHtml, runDurableFill,
} from '../renderer/src/js/longdwell-fill-logic.js';

const ROW = {
  equipmentId: 'U1', vendor: 'Acme', domicileSite: 'DXX1', operator: 'OPR', lifecycleReason: 'Repair',
  repairTimeline: '- 11/01 towed in', issueDetails: 'brakes', downDays: 20,
};

describe('fillFingerprint', () => {
  it('is stable for the same inputs and fits the 64-char IPC limit', () => {
    const a = fillFingerprint(ROW);
    expect(a).toBe(fillFingerprint({ ...ROW }));
    expect(typeof a).toBe('string');
    expect(a.length).toBeGreaterThan(0);
    expect(a.length).toBeLessThanOrEqual(64);
  });
  it('ignores days-down and today', () => {
    expect(fillFingerprint({ ...ROW, downDays: 99, today: '2030-01-01', daysDown: 5 })).toBe(fillFingerprint(ROW));
  });
  it('changes when the repair timeline, notes or prompt identity fields change', () => {
    const base = fillFingerprint(ROW);
    expect(fillFingerprint({ ...ROW, repairTimeline: '- 11/02 parts ordered' })).not.toBe(base);
    const noTl = { ...ROW, repairTimeline: '' };
    expect(fillFingerprint({ ...noTl, savedNotes: 'a' })).not.toBe(fillFingerprint({ ...noTl, savedNotes: 'b' }));
    expect(fillFingerprint({ ...ROW, vendor: 'Other' })).not.toBe(base);
    expect(fillFingerprint({ ...ROW, operator: 'X' })).not.toBe(base);
    expect(fillFingerprint({ ...ROW, lifecycleReason: 'PM' })).not.toBe(base);
  });
});

describe('fillSummaryText', () => {
  it('exact strings', () => {
    expect(fillSummaryText({ filledToday: 12, filled: 5 })).toBe('12 skipped (already filled today), 5 filled');
    expect(fillSummaryText({ filledToday: 17, filled: 0 })).toBe('17 skipped (already filled today), 0 filled');
    expect(fillSummaryText({ filledToday: 12, filled: 5, edited: 1, editedDuringRun: 1, hasContent: 1, failed: 1 }))
      .toBe('12 skipped (already filled today), 5 filled, 2 skipped (edited by you), 1 skipped (already has content), 1 failed');
    expect(fillSummaryText({ filledToday: 0, filled: 3, failed: 1 })).toBe('0 skipped (already filled today), 3 filled, 1 failed');
    expect(fillSummaryText(null)).toBe('0 skipped (already filled today), 0 filled');
  });
});

describe('badge / status HTML', () => {
  it('badge shows local HH:MM', () => {
    const iso = new Date(2026, 10, 4, 14, 32, 0).toISOString();
    expect(filledBadgeHtml({ filledAt: iso })).toContain('>\u2728 filled 14:32</span>');
    expect(filledBadgeHtml({ filledAt: iso })).toContain('class="ld-fill-badge"');
    expect(filledBadgeHtml({ filledAt: 'nope' })).toContain('>\u2728 filled</span>');
  });
  it('escapes everything it emits', () => {
    expect(escHtml('<b>"x"&\'y\'</b>')).toBe('&lt;b&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/b&gt;');
    const h = fillStatusHtml('an-ld-fill-status', '<img src=x onerror=1>', 3);
    expect(h).not.toContain('<img');
    expect(h).toContain('&lt;img src=x onerror=1&gt; \u00b7 filled today: 3');
    expect(h).toContain('role="status"');
    expect(fillStatusText('', 2)).toBe('filled today: 2');
    expect(filledBadgeHtml({ filledAt: '<script>' })).not.toContain('<script>');
  });
});

function fakeBridge(planRes, o = {}) {
  const calls = [];
  const bridge = {
    plan: async (p) => { calls.push(['plan', p]); if (o.planThrows) throw new Error('ipc'); return planRes; },
    unitStart: async (p) => { calls.push(['unitStart', p.key]); if (o.unitStartThrowsAt === p.key) throw new Error('boom'); return { ok: true }; },
    commit: async (p) => {
      calls.push(['commit', p.key, p.failed === true, p.result]);
      if (p.failed) return { ok: true, outcome: 'failed', reason: 'ai-failed' };
      if (o.editedKey === p.key) return { ok: true, outcome: 'skipped', reason: 'edited-during-run' };
      return { ok: true, outcome: 'filled', filledAt: '2026-11-04T10:00:00.000Z' };
    },
    finish: async (p) => { calls.push(['finish', p]); return o.finishRes || { ok: false, code: 'unknown-run' }; },
  };
  return { bridge, calls };
}
const cands = (n) => Array.from({ length: n }, (_, i) => ({ key: 'K' + (i + 1), fp: 'fp' + (i + 1), extra: { dom: true } }));
const plan = (keys, extra) => Object.assign({ ok: true, runId: 'r1', durable: true, resumed: false, busy: false,
  toFill: keys.map((key) => ({ key, reason: 'blank' })), skipped: [], counts: { units: 3, filledToday: 1, planned: keys.length } }, extra || {});

describe('runDurableFill', () => {
  it('runs plan -> (unitStart, fillOne, commit, onUnitDone)* -> finish in order', async () => {
    const { bridge, calls } = fakeBridge(plan(['K1', 'K2']));
    const seen = [];
    const res = await runDurableFill({
      table: 'computed', candidates: cands(3), bridge,
      fillOne: async (c) => { seen.push(['fill', c.key]); calls.push(['fillOne', c.key]); return { delayReason: 'Parts Delay', escalation: 'SEV4', summary: 's', fp: 'new-' + c.key }; },
      onUnitDone: (c, r) => calls.push(['done', c.key, r.outcome]),
    });
    expect(calls.map((c) => c.slice(0, 2).join(':'))).toEqual([
      'plan:[object Object]', 'unitStart:K1', 'fillOne:K1', 'commit:K1', 'done:K1',
      'unitStart:K2', 'fillOne:K2', 'commit:K2', 'done:K2', 'finish:[object Object]',
    ]);
    // plan gets only the unit identity fields, not UI extras
    expect(calls[0][1]).toEqual({ table: 'computed', resume: false, units: cands(3).map(({ key, fp }) => ({ key, fp })) });
    expect(calls.find((c) => c[0] === 'finish')[1]).toEqual({ runId: 'r1' });
    expect(res).toMatchObject({ ok: true, runId: 'r1', counts: { filledToday: 1, filled: 2, failed: 0 } });
    expect(res.summary).toBe('1 skipped (already filled today), 2 filled');
  });

  it('never calls fillOne twice for one key (duplicate toFill entries)', async () => {
    const { bridge } = fakeBridge(plan(['K1', 'K1', 'K2']));
    const fills = [];
    await runDurableFill({ table: 'csv', candidates: cands(2), bridge, fillOne: async (c) => { fills.push(c.key); return { summary: 'x' }; } });
    expect(fills).toEqual(['K1', 'K2']);
  });

  it('a failed unit (throw or falsy) is committed as failed and the loop continues', async () => {
    const { bridge, calls } = fakeBridge(plan(['K1', 'K2', 'K3']));
    const res = await runDurableFill({
      table: 'computed', candidates: cands(3), bridge,
      fillOne: async (c) => { if (c.key === 'K1') throw new Error('ai down'); if (c.key === 'K2') return false; return { summary: 'ok' }; },
    });
    const commits = calls.filter((c) => c[0] === 'commit');
    expect(commits.map((c) => [c[1], c[2]])).toEqual([['K1', true], ['K2', true], ['K3', false]]);
    expect(res.counts).toMatchObject({ filled: 1, failed: 2 });
    expect(res.summary).toBe('1 skipped (already filled today), 1 filled, 2 failed');
  });

  it('counts an edit made during the call as skipped (edited by you)', async () => {
    const { bridge } = fakeBridge(plan(['K1', 'K2']), { editedKey: 'K2' });
    const res = await runDurableFill({ table: 'computed', candidates: cands(2), bridge, fillOne: async () => ({ summary: 'ok' }) });
    expect(res.summary).toBe('1 skipped (already filled today), 1 filled, 1 skipped (edited by you)');
  });

  it('uses the final counts from finish when main returns them', async () => {
    const { bridge } = fakeBridge(plan(['K1']), { finishRes: { ok: true, counts: { filledToday: 12, filled: 5 } } });
    const res = await runDurableFill({ table: 'computed', candidates: cands(1), bridge, fillOne: async () => ({ summary: 'ok' }) });
    expect(res.summary).toBe('12 skipped (already filled today), 5 filled');
  });

  it('an unexpected loop error calls finish({aborted:true}) and stops', async () => {
    const { bridge, calls } = fakeBridge(plan(['K1', 'K2', 'K3']), { unitStartThrowsAt: 'K2' });
    const fills = [];
    const res = await runDurableFill({ table: 'computed', candidates: cands(3), bridge, fillOne: async (c) => { fills.push(c.key); return { summary: 'ok' }; } });
    expect(fills).toEqual(['K1']);
    expect(res).toMatchObject({ ok: false, aborted: true, error: 'boom' });
    expect(calls[calls.length - 1]).toEqual(['finish', { runId: 'r1', aborted: true, error: 'boom' }]);
  });

  it('busy -> no fill and an "already running" result', async () => {
    const { bridge, calls } = fakeBridge({ ok: true, busy: true, runId: null, toFill: [], skipped: [], counts: {} });
    let n = 0;
    const res = await runDurableFill({ table: 'computed', candidates: cands(2), bridge, fillOne: async () => { n++; return {}; } });
    expect(n).toBe(0);
    expect(res).toMatchObject({ ok: true, busy: true, message: 'AI Fill is already running' });
    expect(calls.map((c) => c[0])).toEqual(['plan']);
  });

  it('off (or a plan IPC error) -> {legacy:true}, nothing filled', async () => {
    for (const [p, o] of [[{ ok: false, code: 'off' }, {}], [null, { planThrows: true }]]) {
      const { bridge, calls } = fakeBridge(p, o);
      let n = 0;
      const res = await runDurableFill({ table: 'csv', candidates: cands(2), bridge, fillOne: async () => { n++; return {}; } });
      expect(res).toEqual({ legacy: true });
      expect(n).toBe(0);
      expect(calls.map((c) => c[0])).toEqual(['plan']);
    }
  });

  it('passes resume:true through to plan', async () => {
    const { bridge, calls } = fakeBridge(plan([], { resumed: true }));
    const res = await runDurableFill({ table: 'csv', candidates: cands(1), bridge, resume: true, fillOne: async () => ({}) });
    expect(calls[0][1].resume).toBe(true);
    expect(res.resumed).toBe(true);
  });
});
