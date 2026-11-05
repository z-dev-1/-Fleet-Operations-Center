// tests/auth-propagation-readers.test.js
// auth.propagation FEAT-002 readers: F3 (Uptake / QuickSight / long-dwell pure
// helpers + call-site pins), F2 (_authMsg for the six window/index.js toasts),
// F11 (orcha/health _snapAuth). Fakes are injected through parameters or the
// auth-report test seams; no vi.mock, no Electron.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const ar = require('../src/auth/auth-report');

const ST = {
  ok:      { level: 'ok',      message: 'Midway session verified' },
  busy:    { level: 'busy',    message: 'Checking Midway...' },
  unknown: { level: 'unknown', message: 'Midway status unknown' },
  warn:    { level: 'warn',    message: 'Midway is asking for a full sign-in. Run mwinit (Ctrl+M).' },
  down:    { level: 'down',    message: 'Midway session expired. Run mwinit (Ctrl+M).' },
};
const fakeAr = (enabled, st) => ({ isEnabled: () => enabled, currentStatus: () => st, report: vi.fn() });

beforeEach(() => ar._reset());
afterEach(() => ar._reset());

// ── F3 Uptake ──────────────────────────────────────────────────────────────
describe('F3 uptake _authMessageFor', () => {
  const { _authMessageFor } = require('../src/scrapers/uptake').__test__;

  it('F3: _authMessageFor returns the message only for warn/down on an empty unauthenticated result', () => {
    expect(_authMessageFor([], false, fakeAr(true, ST.warn))).toBe(ST.warn.message);
    expect(_authMessageFor([], false, fakeAr(true, ST.down))).toBe(ST.down.message);
  });

  it('F3: _authMessageFor is null for ok/busy/unknown/null status, non-empty result, authDone and flag off', () => {
    for (const s of [ST.ok, ST.busy, ST.unknown, null]) expect(_authMessageFor([], false, fakeAr(true, s))).toBeNull();
    expect(_authMessageFor([{ unit: 'x' }], false, fakeAr(true, ST.warn))).toBeNull();
    expect(_authMessageFor([], true, fakeAr(true, ST.warn))).toBeNull();
    expect(_authMessageFor([], false, fakeAr(false, ST.warn))).toBeNull();
    expect(_authMessageFor([], false, { isEnabled: () => { throw new Error('x'); } })).toBeNull();
  });

  it('F3: _authMessageFor default reporter is auth-report (null flag off, message flag on)', () => {
    expect(_authMessageFor([], false)).toBeNull();
    ar._setEnabledForTest(true);
    ar._setStatusForTest(ST.down);
    expect(_authMessageFor([], false)).toBe(ST.down.message);
  });

  it('F3: uptake finish calls _authMessageFor', () => {
    const src = read('scrapers/uptake.js');
    const start = src.indexOf('const finish = (units, screenshotPath) => {');
    const end = src.indexOf('const navTo = async', start);
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, end);
    expect(body).toContain('_authMessageFor(arr, authDone)');
    expect(body).toMatch(/if \(authMessage\) \{\s*out\.authMessage = authMessage;/);
    expect(body).toContain('resolve(out);');
  });
});

// ── F3 QuickSight ──────────────────────────────────────────────────────────
describe('F3 quicksight _ssoFailureResult', () => {
  const { _ssoFailureResult } = require('../src/scrapers/quicksight_dbr').__test__;
  const ORIG = { ok: false, error: 'Not logged in to QuickSight/Midway — open the dashboard once in a browser to establish SSO, then retry.' };

  it('F3: _ssoFailureResult returns st.message for warn/down and the original text otherwise', () => {
    expect(_ssoFailureResult(fakeAr(true, ST.warn))).toEqual({ ok: false, error: ST.warn.message });
    expect(_ssoFailureResult(fakeAr(true, ST.down))).toEqual({ ok: false, error: ST.down.message });
    for (const s of [ST.ok, ST.busy, ST.unknown, null]) expect(_ssoFailureResult(fakeAr(true, s))).toEqual(ORIG);
    expect(_ssoFailureResult(fakeAr(false, ST.warn))).toEqual(ORIG);
    expect(_ssoFailureResult({ isEnabled: () => { throw new Error('x'); } })).toEqual(ORIG);
    expect(_ssoFailureResult()).toEqual(ORIG); // real auth-report, flag off
  });

  it('F3: quicksight SSO branch returns _ssoFailureResult()', () => {
    const src = read('scrapers/quicksight_dbr.js');
    expect(src).toMatch(/logger\.warn\('Stuck on SSO\/login page, not QuickSight:', curUrl\);\s*return _ssoFailureResult\(\);/);
  });

  it('F3: quicksight awaits injectCookies only under the flag check', () => {
    const src = read('scrapers/quicksight_dbr.js');
    expect(src.split("await require('./auth').injectCookies()").length - 1).toBe(1);
    expect(src).toMatch(/if \(_propOn\(\)\) \{[^}]*try \{ await require\('\.\/auth'\)\.injectCookies\(\); \}/);
    // flag-off branch keeps the original fire-and-forget statement verbatim
    expect(src).toMatch(/\} else \{\s*try \{ require\('\.\/auth'\)\.injectCookies\(\); \} catch \(e\) \{ logger\.warn\('injectCookies skipped:', e\.message\); \}\s*\}/);
  });
});

// ── F3 long-dwell ──────────────────────────────────────────────────────────
describe('F3 aap_longdwell _reportSsoBounce', () => {
  const { _reportSsoBounce } = require('../src/scrapers/aap_longdwell').__test__;

  it('F3: _reportSsoBounce reports MIDWAY_SESSION_INVALID with source aap-longdwell only when enabled', () => {
    const on = fakeAr(true, null);
    _reportSsoBounce(on);
    expect(on.report).toHaveBeenCalledTimes(1);
    expect(on.report).toHaveBeenCalledWith({ ok: false, err: { code: 'MIDWAY_SESSION_INVALID' }, source: 'aap-longdwell' });
    const off = fakeAr(false, null);
    _reportSsoBounce(off);
    expect(off.report).not.toHaveBeenCalled();
    expect(() => _reportSsoBounce({ isEnabled: () => true, report: () => { throw new Error('x'); } })).not.toThrow();
    expect(() => _reportSsoBounce()).not.toThrow(); // real auth-report, flag off
  });

  it('F3: longdwell calls _reportSsoBounce() before finish(', () => {
    const src = read('scrapers/aap_longdwell.js');
    expect(src).toMatch(/landed on Midway SSO — session invalid'\);\s*_reportSsoBounce\(\);\s*finish\(/);
  });

  it('F3: fas_roster.js is not wired to the reporter', () => {
    expect(read('scrapers/fas_roster.js')).not.toContain('auth-report');
  });
});

// ── F2 window/index.js _authMsg ────────────────────────────────────────────
describe('F2 window/index.js _authMsg', () => {
  const WIN = path.join(SRC, 'window', 'index.js');
  const winSrc = fs.readFileSync(WIN, 'utf8');
  // window/index.js cannot be loaded in a unit test (top-level Electron), so
  // the one-line helper is extracted and evaluated with a require rooted at
  // the window module: '../auth/auth-report' resolves to the real, cached
  // auth-report used by these tests.
  const line = winSrc.split(/\r?\n/).find((l) => l.startsWith('const _authMsg = '));
  const expr = line.slice('const _authMsg = '.length).replace(/;\s*$/, '');
  const _authMsg = new Function('require', 'return (' + expr + ');')(createRequire(WIN));
  const ORIG = 'AAP still rejecting the session. Run `mwinit --refresh-aea` (or `mwinit -f`) in a terminal, then click Sync.';

  it('F2: _authMsg is exported via __test__', () => {
    expect(winSrc).toContain('module.exports.__test__ = { _authMsg };');
  });

  it('F2: _authMsg returns the original for ok/busy/unknown/null status and flag off', () => {
    expect(_authMsg(ORIG)).toBe(ORIG); // flag off
    expect(_authMsg(ORIG, 'boom')).toBe(ORIG);
    ar._setStatusForTest(ST.warn);
    expect(_authMsg(ORIG)).toBe(ORIG); // stub applies only while enabled
    ar._setEnabledForTest(true);
    for (const s of [ST.ok, ST.busy, ST.unknown]) { ar._setStatusForTest(s); expect(_authMsg(ORIG)).toBe(ORIG); }
    ar._setStatusForTest(() => null);
    expect(_authMsg(ORIG)).toBe(ORIG);
  });

  it('F2: _authMsg returns st.message for warn and down', () => {
    ar._setEnabledForTest(true);
    ar._setStatusForTest(ST.warn);
    expect(_authMsg(ORIG)).toBe(ST.warn.message);
    ar._setStatusForTest(ST.down);
    expect(_authMsg(ORIG)).toBe(ST.down.message);
  });

  it('F2: _authMsg appends the detail for the two diagnostic sites', () => {
    ar._setEnabledForTest(true);
    ar._setStatusForTest(ST.warn);
    expect(_authMsg('Re-auth failed: boom', 'boom')).toBe(ST.warn.message + ' (boom)');
    const long = 'x'.repeat(500);
    expect(_authMsg('orig', long)).toBe(ST.warn.message + ' (' + 'x'.repeat(200) + ')');
  });

  it('F2: _authMsg returns the original when currentStatus throws', () => {
    const throwing = new Function('require', 'return (' + expr + ');')(() => ({ currentStatus: () => { throw new Error('x'); } }));
    expect(throwing(ORIG)).toBe(ORIG);
    const badRequire = new Function('require', 'return (' + expr + ');')(() => { throw new Error('cannot load'); });
    expect(badRequire(ORIG, 'd')).toBe(ORIG);
  });

  it('F2: Midway session verified is never substituted into a toast', () => {
    ar._setEnabledForTest(true);
    ar._setStatusForTest(ST.ok);
    expect(_authMsg(ORIG)).not.toContain('verified');
    expect(_authMsg(ORIG, 'd')).toBe(ORIG);
  });

  it('F2: no pushError site still contains mwinit --refresh-aea or mwinit -f outside _authMsg(...)', () => {
    const sites = winSrc.split(/\r?\n/).filter((l) => l.includes('pushError(') && /mwinit --refresh-aea|mwinit -f/.test(l));
    expect(sites.length).toBe(6);
    for (const l of sites) expect(l).toContain('pushError(_authMsg(');
    // the two diagnostic sites keep their error text as `detail`
    expect(sites.filter((l) => /, (e|err)\.message\)\);/.test(l)).length).toBe(3);
  });

  it('F2: no currentMessage reference in window/index.js', () => {
    expect(winSrc).not.toContain('currentMessage');
  });
});

// ── F11 orcha/health _snapAuth ─────────────────────────────────────────────
describe('F11 orcha/health _snapAuth', () => {
  const health = require('../src/orcha/health');
  const { STATUS } = health;
  const { _snapAuth } = health.__test__;
  const L = 'Midway Auth';

  // The pre-change body, written inline from src/orcha/health.js at d8ac226.
  function legacy(r) {
    if (!r) return { status: STATUS.YELLOW, label: L, detail: 'Status unavailable' };
    if (!r.ok) return { status: STATUS.RED, label: L, detail: r.reason || 'Session invalid — run mwinit' };
    const mins = r.expiresInMin;
    if (mins == null) return { status: STATUS.GREEN, label: L, detail: 'Session valid' };
    if (mins <= 0) return { status: STATUS.RED, label: L, detail: 'Session expired — run mwinit' };
    const h = Math.floor(mins / 60), m = mins % 60;
    const left = h ? `${h}h ${m}m` : `${m}m`;
    let status = STATUS.GREEN;
    if (mins < 30) status = STATUS.RED;
    else if (mins < 120) status = STATUS.YELLOW;
    return { status, label: L, detail: `Session valid • ${left} left` };
  }
  const CASES = [null, { ok: false }, { ok: false, reason: 'cookie missing' }, { ok: true }, { ok: true, expiresInMin: 0 },
    { ok: true, expiresInMin: 20 }, { ok: true, expiresInMin: 90 }, { ok: true, expiresInMin: 200 }];

  it('F11: _snapAuth warn -> YELLOW with st.message', () => {
    const out = _snapAuth({ authReport: fakeAr(true, ST.warn), checkMwinit: () => ({ ok: true, expiresInMin: 600 }) });
    expect(out).toEqual({ status: STATUS.YELLOW, label: L, detail: ST.warn.message });
  });

  it('F11: _snapAuth down -> RED', () => {
    const out = _snapAuth({ authReport: fakeAr(true, ST.down), checkMwinit: () => ({ ok: true, expiresInMin: 600 }) });
    expect(out).toEqual({ status: STATUS.RED, label: L, detail: ST.down.message });
  });

  it('F11: _snapAuth ok -> GREEN AAP verified', () => {
    const out = _snapAuth({ authReport: fakeAr(true, ST.ok), checkMwinit: () => ({ ok: true, expiresInMin: 10 }) });
    expect(out).toEqual({ status: STATUS.GREEN, label: L, detail: 'AAP verified' });
  });

  it('F11: _snapAuth null status -> legacy output byte-for-byte', () => {
    for (const r of CASES) {
      const exp = JSON.stringify(legacy(r));
      // explicit null status
      expect(JSON.stringify(_snapAuth({ authReport: fakeAr(true, null), checkMwinit: () => r }))).toBe(exp);
      // busy/unknown also fall through to the legacy body
      expect(JSON.stringify(_snapAuth({ authReport: fakeAr(true, ST.busy), checkMwinit: () => r }))).toBe(exp);
      // real auth-report with the flag off
      expect(JSON.stringify(_snapAuth({ checkMwinit: () => r }))).toBe(exp);
    }
    // a throwing checkMwinit is "Status unavailable", same as before
    expect(JSON.stringify(_snapAuth({ checkMwinit: () => { throw new Error('x'); } }))).toBe(JSON.stringify(legacy(null)));
  });
});
