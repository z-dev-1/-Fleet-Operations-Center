// tests/worker-health-fleet.test.js — fleetDataStatus + workerStatus degradedReason
// (renderer/src/js/views/worker-health-logic.js, plan.md D6).
import { describe, it, expect } from 'vitest';
import { fleetDataStatus, fleetReasonText, workerStatus } from '../renderer/src/js/views/worker-health-logic.js';

describe('fleetDataStatus', () => {
  it('missing / unavailable -> Unavailable', () => {
    expect(fleetDataStatus(null)).toMatchObject({ key: 'unknown', label: 'Unavailable' });
    expect(fleetDataStatus({ status: 'unavailable', reason: 'boom' })).toMatchObject({ key: 'unknown', label: 'Unavailable', reason: 'boom' });
  });

  it('unhealthy -> failed with the first reason text', () => {
    expect(fleetDataStatus({ status: 'ok', health: 'unhealthy', reasons: ['aap-timeouts', 'wedged'] }))
      .toMatchObject({ key: 'failed', reason: 'AAP calls timing out', cls: 'wh-st wh-st--failed' });
    expect(fleetDataStatus({ status: 'ok', health: 'unhealthy', reasons: ['superseded'] }).reason).toBe('fleet build wedged/superseded');
    expect(fleetDataStatus({ status: 'ok', health: 'unhealthy', reasons: ['age>3x'], ageMs: 190 * 60000 }).reason).toBe('no successful fleet push in 190m');
  });

  it('degraded -> degraded; healthy -> healthy; unknown -> unknown', () => {
    expect(fleetDataStatus({ status: 'ok', health: 'degraded', reasons: ['age>2x'], ageMs: 125 * 60000 }))
      .toMatchObject({ key: 'degraded', reason: 'no successful fleet push in 125m' });
    expect(fleetDataStatus({ status: 'ok', health: 'healthy', reasons: ['aging'] })).toMatchObject({ key: 'healthy', reason: '' });
    expect(fleetDataStatus({ status: 'ok', health: 'unknown', reasons: ['no-success-yet'] })).toMatchObject({ key: 'unknown', label: 'Unknown' });
  });

  it('fleetReasonText covers in-flight>5m', () => {
    expect(fleetReasonText('in-flight>5m', { inFlightMs: 7 * 60000 })).toBe('fleet build in flight for 7m');
  });
});

describe('workerStatus degradedReason', () => {
  it('prefers degradedReason when present', () => {
    expect(workerStatus({ state: 'degraded', degradedReason: 'AAP calls timing out', consecutiveFailures: 0 }))
      .toMatchObject({ key: 'degraded', reason: 'AAP calls timing out' });
  });
  it('falls back to the legacy reasons without it', () => {
    expect(workerStatus({ state: 'degraded', consecutiveFailures: 2 }).reason).toBe('2 consecutive failures');
    expect(workerStatus({ state: 'degraded', degradedReason: '', currentJob: { timedOut: true } }).reason).toBe('tick timed out');
  });
});
