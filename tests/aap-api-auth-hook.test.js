// tests/aap-api-auth-hook.test.js
// auth.propagation FEAT-002: aap_api._request / _ensureWindow report real AAP
// traffic outcomes through auth-report. Fake browser_provider + fake reporter
// are injected through the additive test seams (_setProviderForTest,
// _setAuthReporterForTest); no Electron, no network.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

const OK_REPORT = { ok: true, source: 'aap-api' };
const FAIL_REPORT = { ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-api' };

// responses: queue of in-page XHR results returned for request scripts.
function mkProvider({ openErr = null, responses = [] } = {}) {
  const page = {
    evaluate: vi.fn(async (script) => {
      if (script.includes('xhr.open(')) return responses.shift();
      if (script.includes('__aapHookInstalled')) return null;
      return 'csrf-token';
    }),
    close: vi.fn(),
  };
  return {
    page,
    openPage: vi.fn(async () => { if (openErr) throw openErr; return page; }),
    kind: () => 'electron',
    shutdown: vi.fn(),
  };
}
function mkReporter(enabled) {
  return { isEnabled: vi.fn(() => enabled), report: vi.fn() };
}
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

let reporter;
afterEach(() => {
  aap.dispose();
  aap._setProviderForTest(null);
  aap._setAuthReporterForTest(null);
});

describe('aap_api auth reporting (flag on)', () => {
  beforeEach(() => { reporter = mkReporter(true); aap._setAuthReporterForTest(reporter); });

  it('200 -> exactly one ok report', async () => {
    aap._setProviderForTest(mkProvider({ responses: [{ ok: true, status: 200, json: { a: 1 } }] }));
    expect(await aap.apiGet('/api/v1/user/details')).toEqual({ a: 1 });
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(reporter.report).toHaveBeenCalledWith(OK_REPORT);
  });

  for (const status of [401, 403]) {
    it(status + ' -> exactly one fail report and the same MIDWAY_SESSION_INVALID error', async () => {
      aap._setProviderForTest(mkProvider({ responses: [{ ok: false, status, text: 'nope' }] }));
      const e = await errOf(aap.apiGet('/api/v1/user/details'));
      expect(e.code).toBe('MIDWAY_SESSION_INVALID');
      expect(e.message).toBe('AAP API ' + status + ' (session rejected)');
      expect(reporter.report).toHaveBeenCalledTimes(1);
      expect(reporter.report).toHaveBeenCalledWith(FAIL_REPORT);
    });
  }

  it('SSO-bounce on open -> exactly one fail report', async () => {
    const bounce = Object.assign(new Error('landed on midway'), { code: 'MIDWAY_SESSION_INVALID' });
    aap._setProviderForTest(mkProvider({ openErr: bounce }));
    const e = await errOf(aap.apiGet('/api/v1/user/details'));
    expect(e.code).toBe('MIDWAY_SESSION_INVALID');
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(reporter.report).toHaveBeenCalledWith(FAIL_REPORT);
  });

  it('successful open then 401 XHR -> exactly one ok:false and NO ok:true', async () => {
    aap._setProviderForTest(mkProvider({ responses: [{ ok: false, status: 401 }] }));
    await errOf(aap.apiGet('/api/v1/user/details'));
    expect(reporter.report).toHaveBeenCalledTimes(1);
    expect(reporter.report.mock.calls[0][0].ok).toBe(false);
    expect(reporter.report.mock.calls.some((c) => c[0].ok === true)).toBe(false);
  });

  it('500 -> no report', async () => {
    aap._setProviderForTest(mkProvider({ responses: [{ ok: false, status: 500, text: 'boom' }] }));
    const e = await errOf(aap.apiGet('/api/v1/user/details'));
    expect(e.code).toBe('AAP_API_ERROR');
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('AAP_API_LOAD_FAILED (provider error that is not an SSO bounce) -> no report', async () => {
    aap._setProviderForTest(mkProvider({ openErr: new Error('net::ERR_TIMED_OUT') }));
    const e = await errOf(aap.apiGet('/api/v1/user/details'));
    expect(e.code).toBe('AAP_API_LOAD_FAILED');
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('a throwing reporter never changes the result', async () => {
    reporter.report.mockImplementation(() => { throw new Error('reporter broke'); });
    aap._setProviderForTest(mkProvider({ responses: [{ ok: true, status: 200, json: { ok: 1 } }] }));
    expect(await aap.apiGet('/api/v1/user/details')).toEqual({ ok: 1 });
  });
});

describe('aap_api auth reporting (flag off)', () => {
  it('reporter.report is never called and thrown errors are identical to flag on', async () => {
    const scenarios = [
      () => mkProvider({ responses: [{ ok: true, status: 200, json: { a: 1 } }] }),
      () => mkProvider({ responses: [{ ok: false, status: 401 }] }),
      () => mkProvider({ responses: [{ ok: false, status: 403 }] }),
      () => mkProvider({ responses: [{ ok: false, status: 500, text: 'boom' }] }),
      () => mkProvider({ openErr: Object.assign(new Error('bounce'), { code: 'MIDWAY_SESSION_INVALID' }) }),
      () => mkProvider({ openErr: new Error('net::ERR_TIMED_OUT') }),
    ];
    const run = async (enabled) => {
      const rep = mkReporter(enabled);
      aap._setAuthReporterForTest(rep);
      const out = [];
      for (const mk of scenarios) {
        aap.dispose();
        aap._setProviderForTest(mk());
        try { out.push({ v: await aap.apiGet('/api/v1/user/details') }); }
        catch (e) { out.push({ code: e.code, message: e.message, status: e.status }); }
      }
      return { out, rep };
    };
    const off = await run(false);
    const on = await run(true);
    expect(off.rep.report).not.toHaveBeenCalled();
    expect(off.out).toEqual(on.out);
    expect(on.rep.report).toHaveBeenCalledTimes(4); // 200, 401, 403, bounce
  });
});
