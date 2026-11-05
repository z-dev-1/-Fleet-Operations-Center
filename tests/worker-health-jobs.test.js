// tests/worker-health-jobs.test.js — T14: renderer jobsStatus() precedence and
// the read-only Durable jobs card (Phase 7, design §10). Pure ES modules; no DOM.
import { describe, it, expect } from 'vitest';
import { jobsStatus, STATUS_LABELS } from '../renderer/src/js/views/worker-health-logic.js';
import { _jobsCard } from '../renderer/src/js/views/worker-health.js';

const base = (o) => Object.assign({ status: 'ok', mode: 'active', reason: null, totals: { open: 0, recoveryRequired: 0, failed24h: 0, foreign: 0 }, recoveryRequiredCount: 0, oldestRunning: null }, o || {});
const check = (s, key) => {
  expect(s.key).toBe(key);
  expect(Object.keys(STATUS_LABELS)).toContain(s.key);
  expect(s.cls).toBe('wh-st wh-st--' + key);
};

describe('T14 jobsStatus', () => {
  it('section unavailable -> unknown/Unavailable', () => {
    const s = jobsStatus({ status: 'unavailable', reason: 'not-loaded' });
    check(s, 'unknown'); expect(s.label).toBe('Unavailable'); expect(s.reason).toBe('not-loaded');
    check(jobsStatus(null), 'unknown');
  });
  it('off -> disabled', () => { const s = jobsStatus(base({ mode: 'off' })); check(s, 'disabled'); expect(s.reason).toBe('durable jobs off'); });
  it('active clean -> healthy', () => check(jobsStatus(base()), 'healthy'));
  it('degraded -> degraded with the reason', () => { const s = jobsStatus(base({ mode: 'degraded', reason: 'node:sqlite unavailable' })); check(s, 'degraded'); expect(s.reason).toBe('node:sqlite unavailable'); });
  it('foreign only -> degraded "1 row(s) from a newer build"', () => {
    const s = jobsStatus(base({ totals: { open: 0, recoveryRequired: 0, failed24h: 0, foreign: 1 } }));
    check(s, 'degraded'); expect(s.reason).toBe('1 row(s) from a newer build');
  });
  it('expired lease -> degraded', () => {
    const s = jobsStatus(base({ oldestRunning: { type: 'deepScan', leaseExpired: true } }));
    check(s, 'degraded'); expect(s.reason).toBe('lease expired: deepScan');
  });
  it('failed24h -> degraded', () => { const s = jobsStatus(base({ totals: { failed24h: 2 } })); check(s, 'degraded'); expect(s.reason).toBe('2 failed in 24h'); });
  it('recovery_required -> failed / Needs reconciliation', () => {
    const s = jobsStatus(base({ recoveryRequiredCount: 2 }));
    check(s, 'failed'); expect(s.label).toBe('Needs reconciliation'); expect(s.reason).toBe('2 need reconciliation');
  });
  it('precedence: recovery_required + degraded -> failed', () => {
    check(jobsStatus(base({ mode: 'degraded', reason: 'x', recoveryRequiredCount: 1 })), 'failed');
    check(jobsStatus(base({ mode: 'degraded', reason: 'x', totals: { foreign: 3, failed24h: 1 } })), 'degraded');
  });
});

describe('T14 Durable jobs card', () => {
  it('renders mode, types, counts, oldest running and recovery list with every string escaped', () => {
    const html = _jobsCard(base({
      mode: 'active', reason: '<img src=x onerror=alert(1)>',
      types: { deepScan: { mode: 'durable' }, longDwellAiFill: { mode: 'off' } },
      counts: { deepScan: { running: 1, '<b>': 2 } },
      totals: { open: 1, failed24h: 0, foreign: 0 },
      oldestRunning: { type: 'deepScan', scopeKey: '<script>x</script>', startedAt: Date.now() - 5000, attempt: 2, leaseExpired: true },
      recoveryRequired: [{ type: 'deepScan', scopeKey: 'fleet', lastError: '"><svg onload=1>' }],
      recoveryRequiredCount: 1,
      lastRecovery: { at: Date.now(), requeued: 1, recoveryRequired: 0, failed: 0, cancelled: 0 },
    }));
    expect(html.startsWith('<dl class="wh-kv">')).toBe(true);
    expect(html).not.toMatch(/<script>|<img |<svg |<b>/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('deferred');
    expect(html).toContain('lease expired');
    expect(html).toContain('Needs reconciliation');
  });

  it('lists longDwellAiFill with mode durable and its job counts when flagged', () => {
    const html = _jobsCard(base({
      types: { deepScan: { mode: 'off' }, longDwellAiFill: { mode: 'durable' } },
      counts: { longDwellAiFill: { running: 1, completed: 3 } },
    }));
    expect(html).toContain('<dt>longDwellAiFill</dt><dd>durable</dd>');
    expect(html).toContain('longDwellAiFill jobs');
    expect(html).toContain('running 1 · completed 3');
  });
});
