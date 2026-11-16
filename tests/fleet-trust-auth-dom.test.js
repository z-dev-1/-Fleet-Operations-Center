// tests/fleet-trust-auth-dom.test.js
// FEAT-002 / plan.md D7: toolbar auth badge + persistent step-up banner.
// Inputs are built with the REAL src/auth/auth-status.js deriveStatus so the
// renderer mapping tracks the supervisor's status model. mount() runs against
// fake DOM elements with injected deps; mwinit must run only on a button click.
process.env.TZ = 'America/New_York';

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

vi.mock('../renderer/src/js/bridge.js', () => ({ fleet: {}, auth: {} }));
vi.mock('../renderer/src/js/bus.js', () => ({ default: { on() { return () => {}; }, emit() {} } }));

const L = await import('../renderer/src/js/components/fleet-trust-logic.js');
const { mount } = await import('../renderer/src/js/components/fleet-trust-indicator.js');
const require = createRequire(import.meta.url);
const { deriveStatus } = require('../src/auth/auth-status.js');

const NOW = Date.parse('2026-11-16T15:00:00Z'); // 10:00 America/New_York
const MIN = 60 * 1000;
const st = (over) => deriveStatus({ now: NOW, ...over });

describe('deriveAuthBadge', () => {
  it('HEALTHY with verifiedAt -> "verified HH:MM", banner hidden', () => {
    const s = st({ state: 'HEALTHY', verifiedAt: NOW - 3 * MIN });
    const b = L.deriveAuthBadge(s, null, { now: NOW });
    expect(b.key).toBe('HEALTHY');
    expect(b.level).toBe('green');
    expect(b.text).toBe('Auth HEALTHY · verified 09:57');
    expect(L.deriveStepUpBanner(s, null).show).toBe(false);
    expect(L.renderBannerHtml(L.deriveStepUpBanner(s, null))).toBe('');
  });
  it('HEALTHY without verifiedAt -> plain text', () => {
    expect(L.deriveAuthBadge(st({ state: 'HEALTHY' }), null).text).toBe('Auth HEALTHY');
  });
  it('COOLDOWN retryStreak 1 -> COOLDOWN, banner hidden', () => {
    const s = st({ state: 'COOLDOWN', retryStreak: 1 });
    const b = L.deriveAuthBadge(s, null);
    expect(b.key).toBe('COOLDOWN');
    expect(b.level).toBe('amber');
    expect(L.deriveStepUpBanner(s, null).show).toBe(false);
  });
  it('COOLDOWN retryStreak 3 -> banner shown with the retry count', () => {
    const s = st({ state: 'COOLDOWN', retryStreak: 3 });
    const bn = L.deriveStepUpBanner(s, null);
    expect(bn.show).toBe(true);
    expect(bn.reason).toBe('AAP keeps rejecting the session (3 silent retries failed)');
    expect(L.renderBannerHtml(bn)).toContain('(3 silent retries failed)');
  });
  it('DEGRADED / RECOVERING map to COOLDOWN; OFFLINE; UNKNOWN -> CHECKING', () => {
    expect(L.deriveAuthBadge(st({ state: 'DEGRADED' }), null).key).toBe('COOLDOWN');
    expect(L.deriveAuthBadge(st({ state: 'RECOVERING' }), null).key).toBe('COOLDOWN');
    expect(L.deriveAuthBadge(st({ state: 'OFFLINE' }), null).key).toBe('OFFLINE');
    expect(L.deriveAuthBadge(st({ state: 'UNKNOWN' }), null).key).toBe('CHECKING');
    expect(L.deriveAuthBadge(null, null).key).toBe('CHECKING');
    expect(L.deriveAuthBadge(null, null).level).toBe('grey');
  });
  it('step-up COOLDOWN -> STEP-UP NEEDED with the mwinit button and step-up reason', () => {
    const s = st({ state: 'COOLDOWN', stepUp: true, retryStreak: 1 });
    const b = L.deriveAuthBadge(s, null);
    expect(b.key).toBe('STEP-UP NEEDED');
    expect(b.level).toBe('red');
    const bn = L.deriveStepUpBanner(s, null);
    expect(bn.show).toBe(true);
    const h = L.renderBannerHtml(bn);
    expect(h).toContain('AAP session needs re-sign-in');
    expect(h).toContain('<button type="button" class="tb-auth-banner__btn" data-action="run-mwinit">Run mwinit (Ctrl+M)</button>');
  });
  it('WAITING_FOR_USER -> STEP-UP NEEDED, "finish mwinit"; FAILED -> "Midway auth failed"', () => {
    const w = st({ state: 'WAITING_FOR_USER' });
    expect(L.deriveAuthBadge(w, null).key).toBe('STEP-UP NEEDED');
    expect(L.deriveStepUpBanner(w, null).reason).toBe('Midway session expired — finish mwinit');
    const f = st({ state: 'FAILED' });
    expect(L.deriveAuthBadge(f, null).key).toBe('STEP-UP NEEDED');
    expect(L.deriveStepUpBanner(f, null).reason).toBe('Midway auth failed');
  });
  it('flag-off fallback: status null + health.state', () => {
    expect(L.deriveAuthBadge(null, { ok: true, state: 'COOLDOWN' }).key).toBe('COOLDOWN');
    expect(L.deriveAuthBadge(null, { ok: true, state: 'HEALTHY' }).key).toBe('HEALTHY');
    expect(L.deriveAuthBadge(null, { ok: true, state: 'WAITING_FOR_USER' }).key).toBe('STEP-UP NEEDED');
    expect(L.deriveStepUpBanner(null, { ok: true, state: 'WAITING_FOR_USER' }).show).toBe(true);
  });
  it('escapes messages in the title / html', () => {
    const b = L.deriveAuthBadge({ state: 'COOLDOWN', level: 'warn', message: '<img src=x>' }, null);
    expect(b.title).toContain('<img src=x>'); // title is set via the .title property (not HTML)
    expect(L.renderAuthBadgeHtml({ text: '<script>' })).toContain('&lt;script&gt;');
    const h = L.renderBannerHtml({ show: true, reason: '<b>r</b>', causes: ['"q"&'] });
    expect(h).toContain('&lt;b&gt;r&lt;/b&gt;');
    expect(h).toContain('&quot;q&quot;&amp;');
    expect(h).not.toContain('<b>');
  });
});

describe('deriveStepUpBanner causes', () => {
  const stepUp = st({ state: 'COOLDOWN', stepUp: true });
  it('VPN disconnected (status)', () => {
    const bn = L.deriveStepUpBanner(stepUp, { ok: true, state: 'COOLDOWN', snapshot: { vpn: { connected: false, status: 'disconnected', required: false } } });
    expect(bn.causes).toContain('VPN disconnected (disconnected)');
  });
  it('vpn not-installed -> no VPN cause', () => {
    const bn = L.deriveStepUpBanner(stepUp, { ok: true, snapshot: { vpn: { connected: false, status: 'not-installed' } } });
    expect(bn.causes.some((c) => c.startsWith('VPN'))).toBe(false);
  });
  it('Offline from evidence or the health snapshot', () => {
    expect(L.deriveStepUpBanner(st({ state: 'COOLDOWN', stepUp: true, evidence: { online: false } }), null).causes).toContain('Offline');
    expect(L.deriveStepUpBanner(stepUp, { snapshot: { internet: { online: false } } }).causes).toContain('Offline');
  });
  it('liveAeaMin 0 -> AEA cause', () => {
    const bn = L.deriveStepUpBanner(st({ state: 'COOLDOWN', stepUp: true, evidence: { liveAeaMin: 0 } }), null);
    expect(bn.causes).toContain('AEA cookie expired — the AEA browser extension is broken on this machine; a full mwinit restores it');
    expect(L.renderBannerHtml(bn)).toContain('AEA cookie expired');
  });
});

// ── mount() ────────────────────────────────────────────────────────────────
function el() {
  return {
    className: '', innerHTML: '', title: '', disabled: false, hidden: false, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    fire(ev, target) { return Promise.all((this.listeners[ev] || []).map((f) => f({ target: target || this }))); },
  };
}
function mwinitBtn() {
  const b = { disabled: false, dataset: { action: 'run-mwinit' } };
  b.closest = (sel) => (sel === '[data-action="run-mwinit"]' ? b : null);
  return b;
}
function fakeBus() {
  const h = {};
  return {
    on(ev, fn) { (h[ev] = h[ev] || []).push(fn); return () => {}; },
    fire(ev, p) { (h[ev] || []).forEach((f) => f(p)); },
  };
}
function deps(over = {}) {
  const b = fakeBus();
  let t = NOW;
  return {
    bus: b,
    tick(ms) { t += ms; },
    getFreshness: vi.fn(async () => null),
    forceSync: vi.fn(async () => {}),
    statusGet: vi.fn(async () => ({ ok: true, enabled: true, status: st({ state: 'HEALTHY', verifiedAt: NOW - MIN }) })),
    healthGet: vi.fn(async () => ({ ok: true, state: 'HEALTHY', snapshot: { vpn: { connected: false, status: 'disconnected' } } })),
    healthRunMwinit: vi.fn(async () => ({ ok: true, verified: true })),
    on: b.on, emit: vi.fn(),
    now: () => t,
    setInterval: vi.fn(() => 1), clearInterval: vi.fn(),
    ...over,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('mount() auth badge + banner', () => {
  it('renders HEALTHY from statusGet; healthGet not needed', async () => {
    const auth = el(); const banner = el();
    const d = deps();
    const m = mount({ fresh: null, auth, banner }, d);
    await m.ready;
    expect(auth.className).toBe('tb-auth tb-auth--green');
    expect(auth.innerHTML).toContain('Auth HEALTHY · verified 09:59');
    expect(banner.hidden).toBe(true);
    expect(banner.innerHTML).toBe('');
    expect(d.healthGet).not.toHaveBeenCalled();
  });

  it('flag off (status null) falls back to healthGet state', async () => {
    const auth = el();
    const d = deps({
      statusGet: vi.fn(async () => ({ ok: true, enabled: false, status: null })),
      healthGet: vi.fn(async () => ({ ok: true, state: 'COOLDOWN', snapshot: null })),
    });
    const m = mount({ auth }, d);
    await m.ready;
    expect(d.healthGet).toHaveBeenCalledTimes(1);
    expect(auth.className).toBe('tb-auth tb-auth--amber');
    expect(auth.innerHTML).toContain('Auth COOLDOWN');
  });

  it('never runs mwinit on mount or on an auth:status step-up push; runs exactly once per button click', async () => {
    const auth = el(); const banner = el();
    const d = deps();
    const m = mount({ auth, banner }, d);
    await m.ready;
    expect(d.healthRunMwinit).not.toHaveBeenCalled();

    d.bus.fire('auth:status', st({ state: 'COOLDOWN', stepUp: true, retryStreak: 2 }));
    await flush();
    expect(banner.hidden).toBe(false);
    expect(banner.innerHTML).toContain('Run mwinit (Ctrl+M)');
    expect(banner.innerHTML).toContain('AAP session needs re-sign-in');
    expect(banner.innerHTML).toContain('VPN disconnected (disconnected)'); // healthGet fetched for the banner
    expect(auth.innerHTML).toContain('Auth STEP-UP NEEDED');
    expect(d.healthGet).toHaveBeenCalledTimes(1);
    m.render(); m.render();
    d.bus.fire('auth:status', st({ state: 'COOLDOWN', stepUp: true, retryStreak: 3 }));
    await flush();
    expect(d.healthRunMwinit).not.toHaveBeenCalled();
    expect(d.healthGet).toHaveBeenCalledTimes(1); // throttled to once per 60 s

    // A click elsewhere in the banner does nothing.
    await banner.fire('click', { closest: () => null });
    expect(d.healthRunMwinit).not.toHaveBeenCalled();

    const btn = mwinitBtn();
    const p = banner.fire('click', btn);
    expect(btn.disabled).toBe(true);
    await p;
    expect(d.healthRunMwinit).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(false);
    expect(d.emit).toHaveBeenCalledWith('ui:toast', expect.objectContaining({ type: 'success' }));
    m.destroy();
  });

  it('a second click while mwinit is running is ignored; a failing mwinit toasts a warning', async () => {
    const banner = el();
    let release;
    const d = deps({
      statusGet: vi.fn(async () => ({ ok: true, enabled: true, status: st({ state: 'WAITING_FOR_USER' }) })),
      healthRunMwinit: vi.fn(() => new Promise((_, rej) => { release = rej; })),
    });
    const m = mount({ banner }, d);
    await m.ready;
    expect(banner.hidden).toBe(false);
    expect(d.healthRunMwinit).not.toHaveBeenCalled();
    const btn = mwinitBtn();
    const p1 = banner.fire('click', btn);
    const p2 = banner.fire('click', btn);
    expect(d.healthRunMwinit).toHaveBeenCalledTimes(1);
    release(new Error('x'));
    await Promise.all([p1, p2]);
    expect(d.emit).toHaveBeenCalledWith('ui:toast', expect.objectContaining({ type: 'warn' }));
    expect(d.healthRunMwinit).toHaveBeenCalledTimes(1);
  });
});
