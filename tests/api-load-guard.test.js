// tests/api-load-guard.test.js
// Single-flight guard + max-age watchdog for the API fleet build
// (src/window/api-load-guard.js, wired into window/index.js). index.js needs
// Electron, so supersede behavior is tested on the extracted guard with a fake
// clock, plus a source-text wiring check on index.js.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const { createApiLoadGuard, API_LOAD_MAX_AGE_MS } = require('../src/window/api-load-guard');

const MIN = 60 * 1000;
function mkClock(t = 1_000_000) { const c = { t, now: () => c.t }; return c; }

describe('api-load-guard', () => {
  it('max age is 10 minutes', () => { expect(API_LOAD_MAX_AGE_MS).toBe(10 * MIN); });

  it('normal path: start, release, pending reason returned once', () => {
    const g = createApiLoadGuard({ now: mkClock().now });
    const a = g.tryStart('startup');
    expect(a).toMatchObject({ started: true, superseded: false });
    expect(g.isBusy()).toBe(true);
    expect(g.tryStart('refresh')).toEqual({ started: false, stale: false });
    expect(g.release(a.token)).toEqual({ released: true, pending: 'refresh' });
    expect(g.isBusy()).toBe(false);
    expect(g.release(a.token)).toEqual({ released: false, pending: null });
  });

  it('a build younger than max age coalesces the new request', () => {
    const c = mkClock();
    const g = createApiLoadGuard({ now: c.now });
    const a = g.tryStart('auth-recovered');
    c.t += 10 * MIN - 1;
    expect(g.tryStart('refresh')).toEqual({ started: false, stale: false });
    expect(g.isCurrent(a.token)).toBe(true);
    expect(g.snapshot().pending).toBe('refresh');
  });

  it('a build that never resolves is superseded once max age passes', () => {
    const c = mkClock();
    const g = createApiLoadGuard({ now: c.now });
    const a = g.tryStart('auth-recovered');   // never released
    c.t += 10 * MIN;
    const b = g.tryStart('refresh');
    expect(b).toMatchObject({ started: true, superseded: true, ageMs: 10 * MIN });
    expect(b.token).not.toBe(a.token);
    expect(g.isCurrent(a.token)).toBe(false);
    expect(g.isCurrent(b.token)).toBe(true);
    expect(g.isBusy()).toBe(true);
    expect(g.snapshot().startedAt).toBe(c.t);
  });

  it("the superseded build's late finally cannot clear the new build or consume its follow-up", () => {
    const c = mkClock();
    const g = createApiLoadGuard({ now: c.now });
    const a = g.tryStart('auth-recovered');
    c.t += 11 * MIN;
    const b = g.tryStart('refresh');
    const bStartedAt = g.snapshot().startedAt;
    c.t += 1 * MIN;
    expect(g.tryStart('sync')).toEqual({ started: false, stale: false }); // B is young: coalesce
    c.t += 5 * MIN;
    // A's evaluate finally settles and its finally runs.
    expect(g.release(a.token)).toEqual({ released: false, pending: null });
    expect(g.isBusy()).toBe(true);
    expect(g.isCurrent(b.token)).toBe(true);
    expect(g.snapshot().startedAt).toBe(bStartedAt);
    expect(g.snapshot().pending).toBe('sync');
    // B's own finally releases and owns the follow-up.
    expect(g.release(b.token)).toEqual({ released: true, pending: 'sync' });
    expect(g.isBusy()).toBe(false);
  });

  it('window/index.js is wired to the guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'window', 'index.js'), 'utf8');
    expect(src).toContain("require('./api-load-guard').createApiLoadGuard()");
    expect(src).toMatch(/_apiLoadGuard\.tryStart\(/);
    expect(src).toMatch(/if \(_start\.superseded\) \{[\s\S]{0,300}require\('\.\.\/scrapers\/aap_api'\)\.dispose\(\)/);
    expect(src).toMatch(/_apiLoadGuard\.release\(_loadToken\)/);
    expect(src).toMatch(/_apiLoadGuard\.isCurrent\(_loadToken\)/);
    expect(src).not.toMatch(/_apiLoadInFlight\s*=/);
    expect(src).not.toMatch(/_apiLoadPendingReason/);
  });
});
