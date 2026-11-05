// tests/auth-propagation-midway-token.test.js
// auth.propagation F8: a cookie-file MIDWAY_STEPUP_REQUIRED from the RCA
// token mint is reported as a step-up signal (reportStepUp, never
// noteApiOutcome) and the original error is rethrown unchanged. Same style as
// tests/rca-midway-token.test.js (deps injection, no network).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const mt = require('../src/rca/midway_token');
const ar = require('../src/auth/auth-report');

// In-app mint always fails so getIdToken takes the cookie-file fallback.
const aapFail = { evaluateInPage: async () => ({ status: 403, body: 'Forbidden' }) };
const CID = 'aap-na.corp.amazon.com';

describe('F8 midway_token step-up reporter', () => {
  beforeEach(() => { mt.clear(); ar._reset(); });
  afterEach(() => { ar._reset(); });

  it('F8: fallback MIDWAY_STEPUP_REQUIRED calls deps.reportStepUp once with source rca and rethrows the same error', async () => {
    const err = Object.assign(new Error('Midway needs a full sign-in'), { code: 'MIDWAY_STEPUP_REQUIRED', status: 401 });
    const reportStepUp = vi.fn();
    let caught = null;
    try {
      await mt.getIdToken(CID, {}, { aap: aapFail, fetchFromFile: async () => { throw err; }, reportStepUp });
    } catch (e) { caught = e; }
    expect(caught).toBe(err);
    expect(caught.code).toBe('MIDWAY_STEPUP_REQUIRED');
    expect(reportStepUp).toHaveBeenCalledTimes(1);
    expect(reportStepUp).toHaveBeenCalledWith({ source: 'rca' });
  });

  it('F8: a throwing reporter does not change the rethrown error', async () => {
    const err = Object.assign(new Error('step-up'), { code: 'MIDWAY_STEPUP_REQUIRED' });
    const reportStepUp = vi.fn(() => { throw new Error('reporter broke'); });
    await expect(mt.getIdToken(CID, {}, { aap: aapFail, fetchFromFile: async () => { throw err; }, reportStepUp })).rejects.toBe(err);
    expect(reportStepUp).toHaveBeenCalledTimes(1);
  });

  it('F8: in-app MIDWAY_TOKEN_FAILED is not reported', async () => {
    const reportStepUp = vi.fn();
    const aap = { evaluateInPage: async () => ({ status: 401, body: 'More authentication needed' }) };
    const tok = await mt.getIdToken(CID, {}, { aap, fetchFromFile: async () => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
      return b64({ alg: 'none' }) + '.' + b64({ exp: Math.floor(Date.now() / 1000) + 900 }) + '.sig';
    }, reportStepUp });
    expect(typeof tok).toBe('string');
    expect(reportStepUp).not.toHaveBeenCalled();
  });

  it('F8: other fallback error codes are not reported', async () => {
    const reportStepUp = vi.fn();
    for (const code of ['MIDWAY_TOKEN_FAILED', 'MIDWAY_SESSION_INVALID', 'ECONNRESET', undefined]) {
      mt.clear();
      const err = Object.assign(new Error('x'), code ? { code } : {});
      await expect(mt.getIdToken(CID, {}, { aap: aapFail, fetchFromFile: async () => { throw err; }, reportStepUp })).rejects.toBe(err);
    }
    expect(reportStepUp).not.toHaveBeenCalled();
  });

  it('F8: default reporter is auth-report.reportStepUp and is a no-op flag off', async () => {
    const sup = require('../src/auth/midway-health-supervisor');
    const spy = vi.spyOn(sup, 'noteStepUpSignal').mockImplementation(() => undefined);
    try {
      const err = Object.assign(new Error('step-up'), { code: 'MIDWAY_STEPUP_REQUIRED' });
      // flag off (tests/setup sets FLEET_AUTH_PROPAGATION=0)
      expect(ar.isEnabled()).toBe(false);
      await expect(mt.getIdToken(CID, {}, { aap: aapFail, fetchFromFile: async () => { throw err; } })).rejects.toBe(err);
      expect(spy).not.toHaveBeenCalled();
      // flag on: the default reporter reaches the supervisor's step-up signal
      ar._setEnabledForTest(true);
      mt.clear();
      await expect(mt.getIdToken(CID, {}, { aap: aapFail, fetchFromFile: async () => { throw err; } })).rejects.toBe(err);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ source: 'rca' });
    } finally {
      spy.mockRestore();
      try { sup._reset(); } catch (_) {}
    }
  });
});
