// tests/aperia-pill-dom.test.js
// Bottom status-bar Aperia pill (#tb-aperia) and the Aperia panel
// (aperia-panel.js). The pill reads aperia.status() once on init and again
// only on an aperia:alert push; opening the panel reads status() only; every
// other Aperia call runs from a panel button. Real bus / status-bar / panel
// modules on the HTML-parsing mini DOM; window.aperia is a fake with vi.fn for
// all 13 preload keys.
process.env.TZ = 'UTC';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { createMiniDocument } from './fixtures/mini-dom.js';

const m = vi.hoisted(() => {
  const s = { cur: { ok: true, state: 'signed-out', alerts: 'off', minutes: 5, lastPullAt: null } };
  const aperia = {
    login: vi.fn(async () => { s.cur = { ...s.cur, state: 'connected' }; return { ok: true, state: 'connected' }; }),
    logout: vi.fn(async () => { s.cur = { ...s.cur, state: 'signed-out', alerts: 'off' }; return { ok: true, state: 'signed-out' }; }),
    status: vi.fn(async () => s.cur),
    unit: vi.fn(async () => ({ ok: true })),
    bulk: vi.fn(async () => ({ ok: true, jobId: 'a1' })),
    fleetTires: vi.fn(async () => ({ ok: true, jobId: 'a2' })),
    issues: vi.fn(async () => ({ ok: true, jobId: 'a3', rows: [] })),
    startAlerts: vi.fn(async () => { s.cur = { ...s.cur, alerts: 'polling' }; return { ok: true }; }),
    stopAlerts: vi.fn(async () => { s.cur = { ...s.cur, alerts: 'off' }; return { ok: true }; }),
    pollNow: vi.fn(async () => ({ ok: true, newCount: 2 })),
    exportBulk: vi.fn(async () => ({ ok: true, filename: 'x.tsv' })),
    onProgress: vi.fn(() => () => {}),
    onAlert: vi.fn((cb) => { s.alertCbs.push(cb); return () => { s.alertCbs = s.alertCbs.filter((f) => f !== cb); }; }),
  };
  s.alertCbs = [];
  return {
    s, aperia,
    fleet: { getVersion: vi.fn(async () => '9.9.9'), getFreshness: vi.fn(async () => ({ ok: false })), forceSync: vi.fn(async () => ({ ok: true })) },
    auth: { statusGet: vi.fn(async () => ({ ok: true, enabled: false })), healthGet: vi.fn(async () => ({ ok: true })) },
  };
});
vi.mock('../renderer/src/js/bridge.js', () => ({ fleet: m.fleet, auth: m.auth }));

const KEYS = ['login', 'logout', 'status', 'unit', 'bulk', 'fleetTires', 'issues', 'startAlerts', 'stopAlerts', 'pollNow', 'exportBulk', 'onProgress', 'onAlert'];
const OTHERS = KEYS.filter((k) => k !== 'status' && k !== 'onAlert');

let doc, container, panel, logic, initCalls;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const ov = () => doc.getElementById('aperia-panel-overlay');
const pill = () => container.querySelector('#tb-aperia');
const expectNoOtherCalls = () => { for (const k of OTHERS) expect(m.aperia[k], k).not.toHaveBeenCalled(); };

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  doc = createMiniDocument();
  globalThis.document = doc;
  if (typeof globalThis.window === 'undefined') globalThis.window = { app: { platform: 'win32' } };
  globalThis.window.aperia = m.aperia;
  logic = await import('../renderer/src/js/components/aperia-pill-logic.js');
  panel = await import('../renderer/src/js/components/aperia-panel.js');
  const sb = await import('../renderer/src/js/components/status-bar.js');
  container = doc.createElement('div');
  container.id = 'status-bar-mount';
  doc.body.appendChild(container);
  sb.init(container);
  await flush();
  initCalls = Object.fromEntries(KEYS.map((k) => [k, m.aperia[k].mock.calls.length]));
});
afterAll(() => { panel.close(); vi.useRealTimers(); delete globalThis.document; delete globalThis.window.aperia; });
beforeEach(() => {
  panel.close();
  vi.clearAllMocks();
  m.s.cur = { ok: true, state: 'signed-out', alerts: 'off', minutes: 5, lastPullAt: null };
});

describe('aperiaPill / alertsLabel / fmtEt (pure)', () => {
  it('pill text and colour for every state', () => {
    const p = (s) => logic.aperiaPill(s);
    expect(p({ state: 'signed-out' })).toMatchObject({ cls: 'tb-aperia tb-aperia--grey', text: 'Aperia: Signed out' });
    expect(p({ state: 'connecting' })).toMatchObject({ cls: 'tb-aperia tb-aperia--grey', text: 'Aperia: Connecting\u2026' });
    expect(p({ state: 'connected', alerts: 'off' })).toMatchObject({ cls: 'tb-aperia tb-aperia--green', text: 'Aperia: Connected' });
    expect(p({ state: 'connected', alerts: 'ws' })).toMatchObject({ cls: 'tb-aperia tb-aperia--green', text: 'Aperia: Alerts ON' });
    expect(p({ state: 'connected', alerts: 'polling' })).toMatchObject({ cls: 'tb-aperia tb-aperia--green', text: 'Aperia: Alerts ON' });
    expect(p({ state: 'expired', alerts: 'polling' })).toMatchObject({ cls: 'tb-aperia tb-aperia--amber', text: 'Aperia: Expired' });
    expect(p(null)).toMatchObject({ cls: 'tb-aperia tb-aperia--grey', text: 'Aperia \u2026' });
    expect(p({ state: 'weird' }).text).toBe('Aperia \u2026');
    expect(p(null).title).toContain('never checks Aperia on its own');
  });
  it('alertsLabel and ET formatting (process TZ is UTC)', () => {
    expect(logic.alertsLabel({ alerts: 'ws' })).toBe('Tire Alerts: ON');
    expect(logic.alertsLabel({ alerts: 'polling' })).toBe('Tire Alerts: ON');
    expect(logic.alertsLabel({ alerts: 'off' })).toBe('Tire Alerts: OFF');
    expect(logic.alertsLabel(null)).toBe('Tire Alerts: OFF');
    expect(logic.fmtEt('2026-11-22T15:00:00Z')).toBe('11/22/2026, 10:00 AM EST');
    expect(logic.fmtEt('nope')).toBe('');
    expect(logic.fmtEt(null)).toBe('');
  });
});

describe('#tb-aperia pill (user-initiated only)', () => {
  it('is a BUTTON in .sb-trust after #tb-dtna, reads status() once on init and nothing else, survives the 1 s re-render', () => {
    expect(initCalls.status).toBe(1);
    expect(initCalls.onAlert).toBe(1);
    for (const k of OTHERS) expect(initCalls[k], k).toBe(0);
    const el = pill();
    expect(el && el.tagName).toBe('BUTTON');
    expect(container.querySelector('.sb-trust #tb-aperia')).toBe(el);
    const trust = container.querySelector('.sb-trust').children.map((c) => c.id);
    expect(trust.indexOf('tb-aperia')).toBe(trust.indexOf('tb-dtna') + 1);
    expect(el.textContent).toBe('Aperia: Signed out');
    expect(el.className).toBe('tb-aperia tb-aperia--grey');
    expect(el.getAttribute('aria-haspopup')).toBe('dialog');
    vi.advanceTimersByTime(3000);
    expect(pill()).toBe(el);
  });

  it('an aperia:alert push re-reads status() and refreshes the pill', async () => {
    m.s.cur = { ok: true, state: 'connected', alerts: 'ws' };
    for (const cb of m.s.alertCbs.slice()) cb({ type: 'watcher', status: { alerts: 'ws' } });
    await flush();
    expect(m.aperia.status).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toBe('Aperia: Alerts ON');
    expect(pill().className).toBe('tb-aperia tb-aperia--green');
    m.s.cur = { ok: true, state: 'signed-out', alerts: 'off' };
    for (const cb of m.s.alertCbs.slice()) cb({ type: 'watcher', status: { alerts: 'off' } });
    await flush();
    expect(pill().textContent).toBe('Aperia: Signed out');
    expectNoOtherCalls();
  });

  it('advancing fake timers 10 min never calls status again', async () => {
    vi.advanceTimersByTime(10 * 60 * 1000);
    await flush();
    expect(m.aperia.status).not.toHaveBeenCalled();
    expectNoOtherCalls();
  });
});

describe('Aperia panel', () => {
  it('click opens one #aperia-panel-overlay that calls status() only', async () => {
    expect(ov()).toBeNull();
    pill().click();
    const o = ov();
    expect(o).toBeTruthy();
    expect(o.getAttribute('role')).toBe('dialog');
    expect(o.getAttribute('aria-modal')).toBe('true');
    await flush();
    expect(m.aperia.status).toHaveBeenCalledTimes(1);
    expectNoOtherCalls();
    expect(o.querySelector('#aperia-panel-state').textContent).toBe('Aperia: Signed out');
    expect(o.querySelector('#aperia-panel-alerts-state').textContent).toBe('Tire Alerts: OFF');
    expect(o.querySelector('#aperia-panel-last').textContent).toBe('never');
    expect(o.textContent).toContain('Aperia is read only when you press a button. Sign out stops a running pull and closes the Aperia sign-in window.');
    expect(o.querySelector('#aperia-panel-alerts-note').textContent).toContain("once more each time an alert's severity goes up");
    for (const id of ['signin', 'signout', 'issues', 'bulk', 'alerts', 'poll']) {
      expect(o.querySelector('#aperia-panel-' + id), id).toBeTruthy();
    }
    expect(o.querySelector('#aperia-panel-poll').disabled).toBe(true);
    pill().click();
    expect(doc.querySelectorAll('#aperia-panel-overlay').length).toBe(1);
  });

  it('shows the last pull in ET', async () => {
    m.s.cur = { ok: true, state: 'connected', alerts: 'off', lastPullAt: '2026-11-22T15:00:00Z' };
    pill().click();
    await flush();
    expect(ov().querySelector('#aperia-panel-last').textContent).toBe('11/22/2026, 10:00 AM EST');
    expect(pill().textContent).toBe('Aperia: Connected');
  });

  it('Sign in calls login() once, then re-reads status and refreshes the pill', async () => {
    pill().click();
    await flush();
    m.aperia.status.mockClear();
    const btn = ov().querySelector('#aperia-panel-signin');
    btn.click();
    expect(btn.disabled).toBe(true);
    btn.click();
    await flush();
    expect(m.aperia.login).toHaveBeenCalledTimes(1);
    expect(m.aperia.status).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(ov().querySelector('#aperia-panel-state').textContent).toBe('Aperia: Connected');
    expect(pill().textContent).toBe('Aperia: Connected');
  });

  it('the alerts toggle calls startAlerts({}) -> Tire Alerts: ON, then stopAlerts() -> OFF', async () => {
    m.s.cur = { ok: true, state: 'connected', alerts: 'off', minutes: 5 };
    pill().click();
    await flush();
    const toggle = ov().querySelector('#aperia-panel-alerts');
    expect(toggle.textContent).toBe('Turn Tire Alerts ON');
    toggle.click();
    await flush();
    expect(m.aperia.startAlerts).toHaveBeenCalledTimes(1);
    expect(m.aperia.startAlerts).toHaveBeenCalledWith({});
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toContain('Tire Alerts: ON');
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toContain('polling every 5 min');
    expect(toggle.textContent).toBe('Turn Tire Alerts OFF');
    expect(pill().textContent).toBe('Aperia: Alerts ON');
    expect(ov().querySelector('#aperia-panel-poll').disabled).toBe(false);
    toggle.click();
    await flush();
    expect(m.aperia.stopAlerts).toHaveBeenCalledTimes(1);
    expect(m.aperia.startAlerts).toHaveBeenCalledTimes(1);
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toBe('Tire Alerts: OFF');
    expect(pill().textContent).toBe('Aperia: Connected');
    expect(ov().querySelector('#aperia-panel-poll').disabled).toBe(true);
  });

  it('Check now calls pollNow() only while alerts are on and shows the new count', async () => {
    m.s.cur = { ok: true, state: 'connected', alerts: 'ws' };
    pill().click();
    await flush();
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toBe('Tire Alerts: ON (live)');
    ov().querySelector('#aperia-panel-poll').click();
    await flush();
    expect(m.aperia.pollNow).toHaveBeenCalledTimes(1);
    expect(ov().querySelector('#aperia-panel-msg').textContent).toBe('2 new tire issues.');
  });

  it('a failed startAlerts shows its code message', async () => {
    m.aperia.startAlerts.mockResolvedValueOnce({ ok: false, code: 'APERIA_SIGNIN_REQUIRED' });
    pill().click();
    await flush();
    ov().querySelector('#aperia-panel-alerts').click();
    await flush();
    expect(ov().querySelector('#aperia-panel-msg').textContent).toBe('Sign in to Aperia first.');
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toBe('Tire Alerts: OFF');
  });

  it('Sign out calls logout() once', async () => {
    m.s.cur = { ok: true, state: 'connected', alerts: 'polling' };
    pill().click();
    await flush();
    ov().querySelector('#aperia-panel-signout').click();
    await flush();
    expect(m.aperia.logout).toHaveBeenCalledTimes(1);
    expect(pill().textContent).toBe('Aperia: Signed out');
  });

  it('subscribes to onAlert while open: a push re-reads status; after close it no longer does', async () => {
    pill().click();
    await flush();
    const before = m.s.alertCbs.length;
    m.aperia.status.mockClear();
    m.s.cur = { ok: true, state: 'connected', alerts: 'ws' };
    for (const cb of m.s.alertCbs.slice()) cb({ type: 'watcher' });
    await flush();
    expect(m.aperia.status).toHaveBeenCalledTimes(2); // status bar + panel
    expect(ov().querySelector('#aperia-panel-alerts-state').textContent).toContain('Tire Alerts: ON');
    panel.close();
    expect(m.s.alertCbs.length).toBe(before - 1);
  });

  it('Issues / Bulk close the panel and call the open hooks (no aperia call)', async () => {
    const openIssues = vi.fn();
    const openBulk = vi.fn();
    panel.open({ aperia: m.aperia, document: doc, openIssues, openBulk });
    await flush();
    ov().querySelector('#aperia-panel-issues').click();
    expect(ov()).toBeNull();
    expect(openIssues).toHaveBeenCalledTimes(1);
    panel.open({ aperia: m.aperia, document: doc, openIssues, openBulk });
    ov().querySelector('#aperia-panel-bulk').click();
    expect(ov()).toBeNull();
    expect(openBulk).toHaveBeenCalledTimes(1);
    await flush();
    expectNoOtherCalls();
  });

  it('closes on ✕, Escape and backdrop click', () => {
    pill().click();
    ov().querySelector('#aperia-panel-close').click();
    expect(ov()).toBeNull();
    pill().click();
    doc.dispatchEvent({ type: 'keydown', key: 'Enter' });
    expect(ov()).toBeTruthy();
    doc.dispatchEvent({ type: 'keydown', key: 'Escape' });
    expect(ov()).toBeNull();
    pill().click();
    ov().querySelector('#aperia-panel-state').click();
    expect(ov()).toBeTruthy();
    const o = ov();
    o.dispatchEvent({ type: 'click', target: o });
    expect(ov()).toBeNull();
    expect(panel.isOpen()).toBe(false);
    expectNoOtherCalls();
  });
});
