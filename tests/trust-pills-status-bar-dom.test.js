// tests/trust-pills-status-bar-dom.test.js
// The fleet trust pills (freshness chip #tb-fresh, auth pill #tb-auth) and the
// step-up banner (#tb-auth-banner) live in the BOTTOM status bar, not the top
// toolbar. The auth pill opens the Midway/AAP Auth Health overlay
// (auth-health-panel.js); the freshness chip keeps its manual refresh. mwinit
// runs only from an explicit Run mwinit click. Uses the real bus, the real
// status-bar / fleet-trust / auth-health modules and an HTML-parsing mini DOM.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createMiniDocument } from './fixtures/mini-dom.js';

const m = vi.hoisted(() => ({
  fleet: {
    getVersion: vi.fn(async () => '9.9.9'),
    getFreshness: vi.fn(async () => ({ ok: false, code: 'NOT_APP_UI' })),
    forceSync: vi.fn(async () => ({ ok: true })),
  },
  auth: {
    statusGet: vi.fn(async () => ({ ok: true, enabled: false, status: null })),
    healthGet: vi.fn(async () => ({
      ok: true, state: 'HEALTHY',
      snapshot: { state: 'HEALTHY', aapApiSmokeTest: { ok: true }, internet: { online: true }, vpn: { connected: false } },
      history: [{ at: '2026-11-17T14:00:00Z', result: 'recovered', note: 'silent' }],
    })),
    healthRetry: vi.fn(async () => ({ ok: true, state: 'HEALTHY', snapshot: { state: 'HEALTHY' } })),
    healthRunMwinit: vi.fn(async () => ({ ok: true, verified: true })),
  },
  dtna: {
    status: vi.fn(async () => ({ ok: true, state: 'signed-out', lastPullAt: null })),
    onStatus: vi.fn((cb) => { m.dtnaCb = cb; return () => {}; }),
    login: vi.fn(async () => ({ ok: true, state: 'connected' })),
    pullUnit: vi.fn(async () => ({ ok: true })),
    listCases: vi.fn(async () => ({ ok: true, count: 0 })),
    bulkPull: vi.fn(async () => ({ ok: true, jobId: 'j1' })),
    sessionTime: vi.fn(async () => ({ ok: true, remainingSec: 27120, periodSec: 28800, expired: false })),
  },
}));
vi.mock('../renderer/src/js/bridge.js', () => ({ fleet: m.fleet, auth: m.auth }));

const require = createRequire(import.meta.url);
const { deriveStatus } = require('../src/auth/auth-status.js');

let doc, container, bus, panel, dtnaPanel, pillCb, initStatusCalls;
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const overlay = () => doc.getElementById('auth-health-overlay');
const dtnaOverlay = () => doc.getElementById('dtna-panel-overlay');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  doc = createMiniDocument();
  globalThis.document = doc;
  if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
  bus = (await import('../renderer/src/js/bus.js')).default;
  globalThis.window.dtna = m.dtna;
  panel = await import('../renderer/src/js/components/auth-health-panel.js');
  dtnaPanel = await import('../renderer/src/js/components/dtna-panel.js');
  const sb = await import('../renderer/src/js/components/status-bar.js');
  container = doc.createElement('div');
  container.id = 'status-bar-mount';
  doc.body.appendChild(container);
  sb.init(container);
  await flush();
  pillCb = m.dtnaCb;
  initStatusCalls = m.dtna.status.mock.calls.length;
});
afterAll(() => { panel.close(); dtnaPanel.close(); vi.useRealTimers(); delete globalThis.document; delete globalThis.window.dtna; });
beforeEach(() => { panel.close(); dtnaPanel.close(); vi.clearAllMocks(); });

describe('trust pills placement', () => {
  it('pills + banner render in the status bar; the bar re-render keeps the same host nodes', () => {
    const fresh = container.querySelector('#tb-fresh');
    const auth = container.querySelector('#tb-auth');
    const banner = container.querySelector('#tb-auth-banner');
    expect(fresh && fresh.tagName).toBe('BUTTON');
    expect(auth && auth.tagName).toBe('BUTTON');
    expect(banner).toBeTruthy();
    expect(container.querySelector('.sb-trust #tb-fresh')).toBe(fresh);
    expect(container.querySelector('.sb-trust #tb-auth')).toBe(auth);
    expect(fresh.className).toBe('tb-fresh tb-fresh--grey');
    expect(fresh.innerHTML).toContain('Fleet data');
    expect(auth.innerHTML).toContain('Auth');
    expect(container.querySelector('.sb-main .sb-bar')).toBeTruthy();
    expect(container.querySelector('.sb-main .sb-version').textContent).toBe('v9.9.9');
    vi.advanceTimersByTime(3000); // status bar re-renders every second
    expect(container.querySelector('#tb-fresh')).toBe(fresh);
    expect(container.querySelector('#tb-auth')).toBe(auth);
    expect(container.querySelector('.sb-main .sb-bar')).toBeTruthy();
  });

  it('the top toolbar no longer hosts or mounts the trust indicators', () => {
    const src = fs.readFileSync(new URL('../renderer/src/js/components/toolbar.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/tb-fresh|tb-auth|mountFleetTrust|fleet-trust-indicator/);
  });
});

describe('auth pill -> Auth Health overlay', () => {
  it('opens the overlay with state, grid, history and the three buttons; nothing runs mwinit', async () => {
    expect(overlay()).toBeNull();
    container.querySelector('#tb-auth').click();
    const ov = overlay();
    expect(ov).toBeTruthy();
    expect(ov.getAttribute('role')).toBe('dialog');
    await flush();
    expect(m.auth.healthGet).toHaveBeenCalledTimes(1);
    expect(ov.querySelector('#auth-health-state').textContent).toContain('Healthy — AAP target verified');
    expect(ov.querySelector('#auth-health-state').className).toBe('sd-status ok');
    const grid = ov.querySelector('#auth-health-grid').innerHTML;
    expect(grid).toContain('AAP target verified');
    expect(grid).toContain('not connected — not required');
    expect(ov.querySelector('#auth-health-history').textContent).toContain('recovered (silent)');
    expect(ov.querySelector('#auth-health-refresh').textContent).toBe('Refresh');
    expect(ov.querySelector('#auth-health-retry').textContent).toBe('Retry now');
    expect(ov.querySelector('#auth-health-mwinit').textContent).toBe('Run mwinit');
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
    // A second click does not stack a second overlay.
    container.querySelector('#tb-auth').click();
    expect(doc.querySelectorAll('#auth-health-overlay').length).toBe(1);
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
  });

  it('Run mwinit in the overlay calls healthRunMwinit once, then reloads health', async () => {
    container.querySelector('#tb-auth').click();
    await flush();
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
    m.auth.healthGet.mockClear();
    const btn = overlay().querySelector('#auth-health-mwinit');
    btn.click();
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Running mwinit…');
    await flush();
    expect(m.auth.healthRunMwinit).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Run mwinit');
    expect(m.auth.healthGet).toHaveBeenCalledTimes(1);
  });

  it('Refresh re-reads health; Retry now calls healthRetry; neither runs mwinit', async () => {
    container.querySelector('#tb-auth').click();
    await flush();
    m.auth.healthGet.mockClear();
    overlay().querySelector('#auth-health-refresh').click();
    await flush();
    expect(m.auth.healthGet).toHaveBeenCalledTimes(1);
    overlay().querySelector('#auth-health-retry').click();
    await flush();
    expect(m.auth.healthRetry).toHaveBeenCalledTimes(1);
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
  });

  it('live-updates on auth:mwinit-status while open, and stops after close', async () => {
    container.querySelector('#tb-auth').click();
    await flush();
    m.auth.healthGet.mockClear();
    bus.emit('auth:mwinit-status', { ok: true });
    await flush();
    expect(m.auth.healthGet).toHaveBeenCalledTimes(1);
    panel.close();
    bus.emit('auth:mwinit-status', { ok: true });
    await flush();
    expect(m.auth.healthGet).toHaveBeenCalledTimes(1);
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
  });

  it('closes on ✕, Escape and backdrop click (not on a click inside the panel)', async () => {
    container.querySelector('#tb-auth').click();
    overlay().querySelector('#auth-health-close').click();
    expect(overlay()).toBeNull();

    container.querySelector('#tb-auth').click();
    doc.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(overlay()).toBeTruthy();
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(overlay()).toBeNull();

    container.querySelector('#tb-auth').click();
    overlay().querySelector('#auth-health-grid').click();
    expect(overlay()).toBeTruthy();
    const ov = overlay();
    ov.dispatchEvent({ type: 'click', target: ov });
    expect(overlay()).toBeNull();
    await flush();
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
  });
});

describe('freshness chip keeps its manual refresh', () => {
  it('click triggers fleet.forceSync and does NOT open the auth overlay', async () => {
    const fresh = container.querySelector('#tb-fresh');
    await Promise.all(fresh.click());
    expect(m.fleet.forceSync).toHaveBeenCalledTimes(1);
    expect(m.fleet.getFreshness).toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(m.auth.healthGet).not.toHaveBeenCalled();
  });
});

describe('step-up banner in the status bar', () => {
  it('shows on a step-up status and its Run mwinit button is the only banner trigger', async () => {
    const banner = container.querySelector('#tb-auth-banner');
    expect(banner.hidden).toBe(true);
    bus.emit('auth:status', deriveStatus({ now: Date.now(), state: 'WAITING_FOR_USER' }));
    await flush();
    expect(banner.hidden).toBe(false);
    expect(container.querySelector('#tb-auth').innerHTML).toContain('STEP-UP NEEDED');
    expect(m.auth.healthRunMwinit).not.toHaveBeenCalled();
    const btn = banner.querySelector('[data-action="run-mwinit"]');
    expect(btn).toBeTruthy();
    await Promise.all(btn.click());
    expect(m.auth.healthRunMwinit).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
  });
});

describe('DTNA pill -> DTNA panel (user-initiated only)', () => {
  it('#tb-dtna is a BUTTON in .sb-trust, reads status() once on init, survives the 1 s re-render', () => {
    expect(initStatusCalls).toBe(1);
    const pill = container.querySelector('#tb-dtna');
    expect(pill && pill.tagName).toBe('BUTTON');
    expect(container.querySelector('.sb-trust #tb-dtna')).toBe(pill);
    expect(pill.textContent).toBe('DTNA: Signed out \u00b7 sign in to refresh');
    expect(pill.className).toBe('tb-dtna tb-dtna--grey');
    expect(pill.getAttribute('aria-haspopup')).toBe('dialog');
    vi.advanceTimersByTime(3000);
    expect(container.querySelector('#tb-dtna')).toBe(pill);
  });

  it('a pushed status updates the pill (connected -> green)', () => {
    expect(typeof pillCb).toBe('function');
    pillCb({ ok: true, state: 'connected', lastPullAt: null });
    const pill = container.querySelector('#tb-dtna');
    expect(pill.textContent).toBe('DTNA: Connected');
    expect(pill.className).toBe('tb-dtna tb-dtna--green');
    pillCb({ ok: true, state: 'signed-out', lastPullAt: null });
  });

  it('click opens #dtna-panel-overlay and calls status only (no login / pull / list)', async () => {
    expect(dtnaOverlay()).toBeNull();
    container.querySelector('#tb-dtna').click();
    const ov = dtnaOverlay();
    expect(ov).toBeTruthy();
    expect(ov.getAttribute('role')).toBe('dialog');
    expect(ov.getAttribute('aria-modal')).toBe('true');
    await flush();
    expect(m.dtna.status).toHaveBeenCalledTimes(1);
    expect(ov.querySelector('#dtna-panel-state').textContent).toBe('DTNA: Signed out \u00b7 sign in to refresh');
    expect(ov.querySelector('#dtna-panel-last').textContent).toBe('never');
    expect(ov.querySelector('#dtna-panel-signin')).toBeTruthy();
    expect(ov.querySelector('#dtna-panel-pull')).toBeTruthy();
    expect(m.dtna.login).not.toHaveBeenCalled();
    expect(m.dtna.pullUnit).not.toHaveBeenCalled();
    expect(m.dtna.listCases).not.toHaveBeenCalled();
    expect(m.dtna.bulkPull).not.toHaveBeenCalled();
    container.querySelector('#tb-dtna').click();
    expect(doc.querySelectorAll('#dtna-panel-overlay').length).toBe(1);
  });

  it('Sign in calls login once, then re-reads status', async () => {
    container.querySelector('#tb-dtna').click();
    await flush();
    m.dtna.status.mockClear();
    const btn = dtnaOverlay().querySelector('#dtna-panel-signin');
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    await flush();
    expect(m.dtna.login).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(m.dtna.status).toHaveBeenCalledTimes(1);
  });

  it('a pushed status while open updates the panel', async () => {
    container.querySelector('#tb-dtna').click();
    await flush();
    m.dtnaCb({ ok: true, state: 'expired', lastPullAt: null });
    expect(dtnaOverlay().querySelector('#dtna-panel-state').textContent).toBe('DTNA: Expired \u00b7 sign in to refresh');
  });

  it('advancing fake timers 10 min never calls status again', async () => {
    m.dtna.status.mockClear();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await flush();
    expect(m.dtna.status).not.toHaveBeenCalled();
    expect(m.dtna.login).not.toHaveBeenCalled();
  });

  it('session time (Phase C): never on init or a timer; once per pill click and once per Check session', async () => {
    m.dtna.sessionTime.mockClear();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await flush();
    expect(m.dtna.sessionTime).not.toHaveBeenCalled();
    m.dtna.status.mockClear();
    container.querySelector('#tb-dtna').click();
    await flush();
    expect(m.dtna.sessionTime).toHaveBeenCalledTimes(1);
    expect(m.dtna.status).toHaveBeenCalledTimes(1);
    expect(dtnaOverlay().querySelector('#dtna-panel-session').textContent).toBe('expires in 7h 32m');
    dtnaOverlay().querySelector('#dtna-panel-check').click();
    await flush();
    expect(m.dtna.sessionTime).toHaveBeenCalledTimes(2);
    expect(m.dtna.status).toHaveBeenCalledTimes(1);
    m.dtna.sessionTime.mockResolvedValueOnce({ ok: true, remainingSec: 0, periodSec: null, expired: true });
    dtnaOverlay().querySelector('#dtna-panel-check').click();
    await flush();
    expect(dtnaOverlay().querySelector('#dtna-panel-session').textContent).toBe('expired \u2014 sign in again');
    m.dtna.sessionTime.mockResolvedValueOnce({ ok: false, code: 'DTNA_NETWORK' });
    dtnaOverlay().querySelector('#dtna-panel-check').click();
    await flush();
    expect(dtnaOverlay().querySelector('#dtna-panel-session').textContent).toBe('could not check (DTNA_NETWORK)');
    expect(initStatusCalls).toBe(1);
    expect(m.dtna.login).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 60 * 1000);
    await flush();
    expect(m.dtna.sessionTime).toHaveBeenCalledTimes(4);
  });

  it('closes on Escape, ✕ and backdrop click', () => {
    container.querySelector('#tb-dtna').click();
    expect(dtnaOverlay()).toBeTruthy();
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(dtnaOverlay()).toBeNull();
    expect(dtnaPanel.isOpen()).toBe(false);
    container.querySelector('#tb-dtna').click();
    dtnaOverlay().querySelector('#dtna-panel-close').click();
    expect(dtnaOverlay()).toBeNull();
    container.querySelector('#tb-dtna').click();
    const ov = dtnaOverlay();
    ov.dispatchEvent({ type: 'click', target: ov });
    expect(dtnaOverlay()).toBeNull();
    expect(m.dtna.login).not.toHaveBeenCalled();
  });
});
