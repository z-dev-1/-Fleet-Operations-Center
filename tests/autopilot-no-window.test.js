// tests/autopilot-no-window.test.js — fleet-autopilot AC-21 (transport part) and R9/R11.
// Real decisiv_api with electron and ../src/orcha/auto-login faked in the require cache
// (BrowserWindow constructor and attachAutoLogin are spies); real aap_api with a fake
// browser_provider (tests/helpers/fake-aap-page.cjs). The warm-only reads must never
// construct a window, open a page or start auto-login, must fail closed when the window
// or token disappears before the lock body, and must never move AAP auth / timeout state.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

function injectFake(rel, exportsObj) {
  const resolved = require.resolve(rel);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: exportsObj };
}

let constructed = 0;
class FakeWin {
  constructor() { constructed++; this._dead = false; this.webContents = { executeJavaScript: vi.fn(), getURL: () => '' }; }
  isDestroyed() { return this._dead; }
  destroy() { this._dead = true; }
  loadURL() {}
}
const attachAutoLogin = vi.fn();
injectFake('electron', { BrowserWindow: FakeWin });
injectFake('../src/orcha/auto-login', { partitionForUrl: () => 'persist:vendor-test', attachAutoLogin });

const decisiv = require('../src/scrapers/decisiv_api');
const aap = require('../src/scrapers/aap_api');
const { mkRoutedPage, mkProvider } = require('./helpers/fake-aap-page.cjs');

const SR_URL = 'https://volvopg.asist.decisiv.net/fleet/estimates/21350186';
const ORIGIN = 'https://volvopg.asist.decisiv.net';
const SEGMENTS = [{ milestone: 'repair', milestone_display: 'Repair', current: true, repair_statuses: [{ status: 'In Repair', changed_at: '2026-11-10T10:00:00Z', current: true }] }];

function warmDecisiv(execImpl) {
  const st = decisiv._warmStateForTest();
  const win = new FakeWin();
  win.webContents.executeJavaScript.mockImplementation(execImpl || (async () => ({ ok: true, status: 200, json: SEGMENTS })));
  st.wins[ORIGIN] = win;
  st.tokens[ORIGIN] = 'csrf-tok';
  return win;
}

describe('decisiv_api warm-only reads (AC-21, R9, R11)', () => {
  beforeEach(() => { constructed = 0; attachAutoLogin.mockClear(); });
  afterEach(() => { vi.useRealTimers(); decisiv.dispose(); });

  it('a cold origin -> DECISIV_NOT_WARM, zero BrowserWindow constructions, no auto-login', async () => {
    expect(decisiv.isWarm(SR_URL)).toBe(false);
    const r = await decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    expect(r).toMatchObject({ ok: false, code: 'DECISIV_NOT_WARM' });
    await expect(decisiv.getActivityLogsIfWarm('21350186', { srUrl: SR_URL })).rejects.toMatchObject({ code: 'DECISIV_NOT_WARM' });
    expect(constructed).toBe(0);
    expect(attachAutoLogin).not.toHaveBeenCalled();
  });

  it('a warm window answers the case status through the same path as getCaseStatus', async () => {
    const win = warmDecisiv();
    constructed = 0;
    expect(decisiv.isWarm(SR_URL)).toBe(true);
    const r = await decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    expect(r).toMatchObject({ ok: true, stage: 'repair', status: 'In Repair', since: '2026-11-10T10:00:00Z' });
    const script = win.webContents.executeJavaScript.mock.calls[0][0];
    expect(script).toContain(ORIGIN + '/fleet/estimates/21350186/case_repair_status_changes.json');
    expect(script).toContain('csrf-tok');
    expect(constructed).toBe(0);
  });

  it('window destroyed between isWarm() and the lock body -> DECISIV_NOT_WARM, no window constructed', async () => {
    const win = warmDecisiv();
    constructed = 0;
    expect(decisiv.isWarm(SR_URL)).toBe(true);
    const p = decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    win.destroy();   // the teardown timer fires before the queued lock body runs
    const r = await p;
    expect(r).toMatchObject({ ok: false, code: 'DECISIV_NOT_WARM' });
    expect(win.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(constructed).toBe(0);
    expect(attachAutoLogin).not.toHaveBeenCalled();
  });

  it('token deleted by a concurrent 401 -> the queued read fails closed with DECISIV_NOT_WARM', async () => {
    const win = warmDecisiv(async () => ({ ok: false, status: 401, text: 'nope' }));
    constructed = 0;
    const first = decisiv.getActivityLogsIfWarm('21350186', { srUrl: SR_URL });
    const second = decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    await expect(first).rejects.toMatchObject({ code: 'DECISIV_SESSION_INVALID' });
    expect(await second).toMatchObject({ ok: false, code: 'DECISIV_NOT_WARM' });
    expect(decisiv._warmStateForTest().tokens[ORIGIN]).toBeUndefined();
    expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(decisiv.isWarm(SR_URL)).toBe(false);
    expect(constructed).toBe(0);
    expect(attachAutoLogin).not.toHaveBeenCalled();
  });

  it('a hung executeJavaScript releases the lock after 30 s with DECISIV_API_TIMEOUT (no dispose)', async () => {
    vi.useFakeTimers();
    const win = warmDecisiv(() => new Promise(() => {}));
    const p = decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    await vi.advanceTimersByTimeAsync(29999);
    let settled = false;
    p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ ok: false, code: 'DECISIV_API_TIMEOUT' });
    expect(win.isDestroyed()).toBe(false);
    expect(decisiv.isWarm(SR_URL)).toBe(true);
    // The lock is free: the next read runs.
    win.webContents.executeJavaScript.mockImplementation(async () => ({ ok: true, status: 200, json: SEGMENTS }));
    const r2 = await decisiv.getCaseStatusSummaryIfWarm('21350186', { srUrl: SR_URL });
    expect(r2).toMatchObject({ ok: true, stage: 'repair' });
  });
});

describe('aap_api warm-only reads (AC-21)', () => {
  let reporter;
  beforeEach(() => {
    reporter = { isEnabled: vi.fn(() => true), report: vi.fn() };
    aap._setAuthReporterForTest(reporter);
    aap._resetCallStatsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    aap.dispose();
    aap._setWarmForTest(null);
    aap._setProviderForTest(null);
    aap._setAuthReporterForTest(null);
  });

  it('cold page -> AAP_NOT_WARM and provider.openPage is never called', async () => {
    const prov = mkProvider(() => mkRoutedPage(() => ({ ok: true, status: 200, json: {} })));
    aap._setProviderForTest(prov);
    aap._setWarmForTest({ page: null });
    expect(aap.isWarm()).toBe(false);
    await expect(aap.getServiceIfWarm('svc-1')).rejects.toMatchObject({ code: 'AAP_NOT_WARM' });
    // A page without a captured token is not warm either.
    aap._setWarmForTest({ page: mkRoutedPage(() => ({ ok: true, status: 200, json: {} })), token: null });
    await expect(aap.getServiceIfWarm('svc-1')).rejects.toMatchObject({ code: 'AAP_NOT_WARM' });
    expect(prov.opened).toBe(0);
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('warm page -> GET /api/v1/serviceaggregates/<id> on that page, no auth report, call stats unchanged', async () => {
    const prov = mkProvider([]);
    aap._setProviderForTest(prov);
    const page = mkRoutedPage(() => ({ ok: true, status: 200, json: { workRequest: { id: 'svc 1' } } }));
    aap._setWarmForTest({ page, token: 'tok' });
    expect(aap.isWarm()).toBe(true);
    const before = aap.getCallStats();
    expect(await aap.getServiceIfWarm('svc 1')).toEqual({ workRequest: { id: 'svc 1' } });
    expect(page.requests).toEqual([expect.objectContaining({ method: 'GET', path: '/api/v1/serviceaggregates/svc%201' })]);
    expect(aap.getCallStats()).toEqual(before);
    expect(reporter.report).not.toHaveBeenCalled();
    expect(prov.opened).toBe(0);
  });

  it('warm-only 401 -> MIDWAY_SESSION_INVALID without calling the auth report hook', async () => {
    aap._setProviderForTest(mkProvider([]));
    aap._setWarmForTest({ page: mkRoutedPage(() => ({ ok: false, status: 401 })), token: 'tok' });
    await expect(aap.getServiceIfWarm('svc-1')).rejects.toMatchObject({ code: 'MIDWAY_SESSION_INVALID' });
    expect(reporter.report).not.toHaveBeenCalled();
  });

  it('warm-only in-page timeout leaves consecutiveTimeouts unchanged; a normal call still counts it', async () => {
    aap._setProviderForTest(mkProvider([]));
    aap._setWarmForTest({ page: mkRoutedPage(() => ({ ok: false, status: 0, timeout: true })), token: 'tok' });
    await expect(aap.getServiceIfWarm('svc-1')).rejects.toMatchObject({ code: 'AAP_API_ERROR' });
    expect(aap.getCallStats()).toMatchObject({ timeouts: 0, consecutiveTimeouts: 0, lastOkAt: null });
    await expect(aap.getService('svc-1')).rejects.toMatchObject({ code: 'AAP_API_ERROR' });
    expect(aap.getCallStats()).toMatchObject({ timeouts: 1, consecutiveTimeouts: 1 });
  });

  it('warm-only evaluate timeout (AAP_API_TIMEOUT) leaves call stats unchanged', async () => {
    vi.useFakeTimers();
    const prov = mkProvider([]);
    aap._setProviderForTest(prov);
    aap._setWarmForTest({ page: mkRoutedPage(() => ({ ok: true, status: 200, json: {} }), { hangWhen: () => true }), token: 'tok' });
    const p = aap.getServiceIfWarm('svc-1');
    const done = p.then(() => null, (e) => e);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await done).toMatchObject({ code: 'AAP_API_TIMEOUT' });
    expect(aap.getCallStats()).toMatchObject({ timeouts: 0, consecutiveTimeouts: 0, lastTimeoutAt: null });
    expect(prov.opened).toBe(0);
  });

  it('a warm-only success does not reset the timeout streak or set lastOkAt; a normal getService does', async () => {
    const page = mkRoutedPage((req) => (req.path.endsWith('/t') ? { ok: false, status: 0, timeout: true } : { ok: true, status: 200, json: { a: 1 } }));
    aap._setProviderForTest(mkProvider([]));
    aap._setWarmForTest({ page, token: 'tok' });
    await expect(aap.getService('t')).rejects.toMatchObject({ code: 'AAP_API_ERROR' });
    expect(aap.getCallStats().consecutiveTimeouts).toBe(1);
    await aap.getServiceIfWarm('ok');
    expect(aap.getCallStats()).toMatchObject({ consecutiveTimeouts: 1, lastOkAt: null });
    await aap.getService('ok');
    const s = aap.getCallStats();
    expect(s.consecutiveTimeouts).toBe(0);
    expect(s.lastOkAt).not.toBeNull();
    expect(reporter.report).toHaveBeenCalledWith({ ok: true, source: 'aap-api' });
  });
});
