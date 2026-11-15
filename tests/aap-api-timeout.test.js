// tests/aap-api-timeout.test.js
// Every aap_api page.evaluate is bounded. A hung evaluate rejects with
// AAP_API_TIMEOUT, disposes the window and releases the serialization lock so
// the next caller goes through. AAP_API_TIMEOUT is non-auth (no auth report).
// Fake browser_provider + reporter via the existing test seams; fake timers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const aap = require('../src/scrapers/aap_api');

const never = () => new Promise(() => {});

// hang: 'request' | 'hook' | null. respond: in-page XHR result for request scripts.
function mkPage({ hang = null, respond = null } = {}) {
  return {
    scripts: [],
    evaluate: vi.fn(function (script) {
      this.scripts.push(script);
      if (script.includes('xhr.open(')) return hang === 'request' ? never() : Promise.resolve(respond);
      if (hang === 'hook') return never();
      if (script.includes('__aapHookInstalled')) return Promise.resolve(null);
      return Promise.resolve('csrf-token');
    }),
    close: vi.fn(),
  };
}
function mkProvider(pages) {
  const queue = pages.slice();
  return {
    openPage: vi.fn(async () => queue.shift()),
    kind: () => 'electron',
    shutdown: vi.fn(),
  };
}
const mkReporter = () => ({ isEnabled: vi.fn(() => true), report: vi.fn() });
async function errOf(p) { try { await p; return null; } catch (e) { return e; } }

let reporter;
beforeEach(() => {
  vi.useFakeTimers();
  reporter = mkReporter();
  aap._setAuthReporterForTest(reporter);
});
afterEach(() => {
  aap.dispose();
  aap._setProviderForTest(null);
  aap._setAuthReporterForTest(null);
  vi.useRealTimers();
});

describe('aap_api evaluate timeouts', () => {
  it('a request evaluate that never resolves rejects AAP_API_TIMEOUT after 60s and disposes the window', async () => {
    const page = mkPage({ hang: 'request' });
    aap._setProviderForTest(mkProvider([page]));
    let settled = false;
    const p = errOf(aap.apiGet('/api/v1/user/details')).then((e) => { settled = true; return e; });
    await vi.advanceTimersByTimeAsync(59000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    const e = await p;
    expect(e && e.code).toBe('AAP_API_TIMEOUT');
    expect(e.message).not.toMatch(/session expired|session rejected|re-authenticate/i);
    expect(page.close).toHaveBeenCalled();
  });

  it('releases the lock: a call queued behind the hung one goes through on a fresh window', async () => {
    const hung = mkPage({ hang: 'request' });
    const good = mkPage({ respond: { ok: true, status: 200, json: { a: 1 } } });
    const prov = mkProvider([hung, good]);
    aap._setProviderForTest(prov);
    const first = errOf(aap.apiGet('/api/v1/one'));
    const second = aap.apiGet('/api/v1/two');
    await vi.advanceTimersByTimeAsync(60000);
    expect((await first).code).toBe('AAP_API_TIMEOUT');
    expect(await second).toEqual({ a: 1 });
    expect(prov.openPage).toHaveBeenCalledTimes(2);
  });

  it('a hung hook/token evaluate in _ensureWindow rejects AAP_API_TIMEOUT after 20s (not rewrapped)', async () => {
    const page = mkPage({ hang: 'hook' });
    aap._setProviderForTest(mkProvider([page]));
    const p = errOf(aap.apiGet('/api/v1/user/details'));
    await vi.advanceTimersByTimeAsync(20000);
    const e = await p;
    expect(e && e.code).toBe('AAP_API_TIMEOUT');
    expect(page.close).toHaveBeenCalled();
    expect(page.scripts.some((s) => s.includes('xhr.open('))).toBe(false);
  });

  it('evaluateInPage is bounded too', async () => {
    const page = mkPage();
    page.evaluate.mockImplementation(function (script) {
      if (script === 'HANG') return never();
      return Promise.resolve(script.includes('__aapHookInstalled') ? null : 'csrf-token');
    });
    aap._setProviderForTest(mkProvider([page]));
    const p = errOf(aap.evaluateInPage('HANG'));
    await vi.advanceTimersByTimeAsync(60000);
    expect((await p).code).toBe('AAP_API_TIMEOUT');
  });

  it('AAP_API_TIMEOUT is non-auth: the auth reporter is never called', async () => {
    aap._setProviderForTest(mkProvider([mkPage({ hang: 'request' }), mkPage({ hang: 'hook' })]));
    const a = errOf(aap.apiGet('/api/v1/a'));
    const b = errOf(aap.apiGet('/api/v1/b'));
    await vi.advanceTimersByTimeAsync(80000);
    expect((await a).code).toBe('AAP_API_TIMEOUT');
    expect((await b).code).toBe('AAP_API_TIMEOUT');
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('an in-page xhr timeout result yields AAP_API_ERROR with no auth report', async () => {
    aap._setProviderForTest(mkProvider([mkPage({ respond: { ok: false, status: 0, timeout: true } })]));
    const e = await errOf(aap.apiGet('/api/v1/user/details'));
    expect(e.code).toBe('AAP_API_ERROR');
    expect(e.message).toMatch(/request timed out/);
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('the request script sets xhr.timeout = 45000 with an ontimeout handler', async () => {
    const page = mkPage({ respond: { ok: true, status: 200, json: {} } });
    aap._setProviderForTest(mkProvider([page]));
    await aap.apiGet('/api/v1/user/details');
    const s = page.scripts.find((x) => x.includes('xhr.open('));
    expect(s).toContain('xhr.timeout = 45000');
    expect(s).toMatch(/xhr\.ontimeout = function \(\) \{ resolve\(\{ ok: false, status: 0, timeout: true \}\); \}/);
  });

  it('a late rejection of the abandoned evaluate is not an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (r) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      let rejectLate;
      const page = mkPage();
      page.evaluate.mockImplementation(function (script) {
        if (script.includes('xhr.open(')) return new Promise((_, rej) => { rejectLate = rej; });
        return Promise.resolve(script.includes('__aapHookInstalled') ? null : 'csrf-token');
      });
      aap._setProviderForTest(mkProvider([page]));
      const p = errOf(aap.apiGet('/api/v1/user/details'));
      await vi.advanceTimersByTimeAsync(60000);
      expect((await p).code).toBe('AAP_API_TIMEOUT');
      rejectLate(new Error('context destroyed'));
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
