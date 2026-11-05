// tests/auth-status-model.test.js — pure status model src/auth/auth-status.js (design 3.2 + F9).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { deriveStatus, MSG } = require('../src/auth/auth-status');

const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const d = (state, extra = {}) => deriveStatus(Object.assign({ state, now: NOW }, extra));

const TABLE = [
  // state, stepUp, level, action, ok, message
  ['HEALTHY', false, 'ok', 'none', true, 'Midway session verified'],
  ['HEALTHY', true, 'ok', 'none', true, 'Midway session verified'],
  ['UNKNOWN', false, 'unknown', 'wait', null, 'Verifying Midway session...'],
  ['UNKNOWN', true, 'unknown', 'wait', null, 'Verifying Midway session...'],
  ['RECOVERING', false, 'busy', 'wait', null, 'Recovering Midway session...'],
  ['DEGRADED', false, 'warn', 'wait', false, 'AAP rejected the session. Re-checking.'],
  ['COOLDOWN', false, 'warn', 'wait', false, 'AAP is still rejecting the session. Retrying automatically.'],
  ['COOLDOWN', true, 'warn', 'mwinit', false, MSG.STEP_UP],
  ['DEGRADED', true, 'warn', 'mwinit', false, MSG.STEP_UP],
  ['RECOVERING', true, 'warn', 'mwinit', false, MSG.STEP_UP],
  ['WAITING_FOR_USER', false, 'down', 'mwinit', false, 'Midway session expired. Finish mwinit in the terminal (Ctrl+M starts it).'],
  ['WAITING_FOR_USER', true, 'down', 'mwinit', false, 'Midway session expired. Finish mwinit in the terminal (Ctrl+M starts it).'],
  ['OFFLINE', false, 'warn', 'wait', false, 'Offline. Will re-verify when the connection returns.'],
  ['OFFLINE', true, 'warn', 'wait', false, 'Offline. Will re-verify when the connection returns.'],
  ['FAILED', false, 'down', 'mwinit', false, 'Midway auth failed. Run mwinit (Ctrl+M).'],
  ['FAILED', true, 'down', 'mwinit', false, 'Midway auth failed. Run mwinit (Ctrl+M).'],
];

describe('deriveStatus: state x stepUp table', () => {
  for (const [state, stepUp, level, action, ok, message] of TABLE) {
    it(`${state} stepUp=${stepUp} -> ${level}/${action}`, () => {
      const s = d(state, { stepUp });
      expect(s.state).toBe(state);
      expect(s.level).toBe(level);
      expect(s.action).toBe(action);
      expect(s.ok).toBe(ok);
      expect(s.message).toBe(message);
      const effectiveStepUp = stepUp && ['COOLDOWN', 'DEGRADED', 'RECOVERING'].includes(state);
      expect(s.stepUp).toBe(effectiveStepUp);
      if (effectiveStepUp) expect(s.failClass).toBe('STEP_UP_REQUIRED');
    });
  }

  it('the step-up message is the pinned string', () => {
    expect(MSG.STEP_UP).toBe('Midway is asking for a full sign-in. Run mwinit (Ctrl+M). Retrying automatically; this sometimes clears on its own.');
  });

  it('no message recommends --refresh-aea or -f', () => {
    for (const m of Object.values(MSG)) {
      expect(m).not.toMatch(/refresh-aea/);
      expect(m).not.toMatch(/(^|\s)-f\b/);
    }
  });

  it('unknown or missing state maps to the UNKNOWN row', () => {
    expect(deriveStatus({ now: NOW }).level).toBe('unknown');
    expect(deriveStatus(null).state).toBe('UNKNOWN');
    expect(d('WHATEVER').level).toBe('unknown');
  });
});

describe('deriveStatus: passthrough and normalization', () => {
  it('times become ISO, non-finite become null; evidence numbers validated', () => {
    const s = d('COOLDOWN', {
      seq: 4, failClass: 'AAP_API_UNAUTHORIZED', verifiedAt: NOW - 1000, verifiedBy: 'api:aap-api',
      lastApiOkAt: new Date(NOW - 5000).toISOString(), lastApiFailAt: NaN, nextRetryAt: 'garbage', retryStreak: 2,
      evidence: { sessionMin: 600, diskAeaMin: Infinity, liveAeaMin: 7, aeaCountToMidway: '2', online: true, at: NOW },
    });
    expect(s.v).toBe(1);
    expect(s.seq).toBe(4);
    expect(s.at).toBe(new Date(NOW).toISOString());
    expect(s.failClass).toBe('AAP_API_UNAUTHORIZED');
    expect(s.verifiedAt).toBe(new Date(NOW - 1000).toISOString());
    expect(s.verifiedBy).toBe('api:aap-api');
    expect(s.lastApiOkAt).toBe(new Date(NOW - 5000).toISOString());
    expect(s.lastApiFailAt).toBeNull();
    expect(s.nextRetryAt).toBeNull();
    expect(s.retryStreak).toBe(2);
    expect(s.evidence).toEqual({ sessionMin: 600, diskAeaMin: null, liveAeaMin: 7, aeaCountToMidway: null, online: true, at: new Date(NOW).toISOString() });
  });

  it('out-of-range evidence numbers are null', () => {
    expect(d('HEALTHY', { evidence: { sessionMin: 2e6 } }).evidence.sessionMin).toBeNull();
  });
});

describe('deriveStatus: F9 full sign-in row', () => {
  it('F9: step-up row after a completed full sign-in uses action wait for 30 min', () => {
    for (const state of ['COOLDOWN', 'DEGRADED', 'RECOVERING']) {
      for (const ago of [0, 60 * 1000, 29 * 60 * 1000 + 59 * 1000]) {
        const s = d(state, { stepUp: true, stepUpMwinitAt: NOW - ago });
        expect(s.level).toBe('warn');
        expect(s.action).toBe('wait');
        expect(s.stepUp).toBe(true);
        expect(s.message).toBe('Full sign-in completed; Midway is still rejecting. Retrying automatically.');
      }
    }
  });

  it('F9: after 30 min the row returns to the mwinit step-up row', () => {
    const s = d('COOLDOWN', { stepUp: true, stepUpMwinitAt: NOW - 30 * 60 * 1000 });
    expect(s.action).toBe('mwinit');
    expect(s.message).toBe(MSG.STEP_UP);
  });

  it('F9: stepUpMwinitAt without stepUp does not change the row', () => {
    expect(d('COOLDOWN', { stepUpMwinitAt: NOW }).message).toBe(MSG.COOLDOWN);
    expect(d('WAITING_FOR_USER', { stepUp: true, stepUpMwinitAt: NOW }).action).toBe('mwinit');
  });
});
