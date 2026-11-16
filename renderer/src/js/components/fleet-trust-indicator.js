/**
 * fleet-trust-indicator.js — wires the toolbar trust indicators to the DOM.
 *
 *   #tb-fresh        fleet-data freshness chip (click = existing manual refresh,
 *                    fleet.forceSync -> fleet:force-scan)
 *   #tb-auth         auth badge (auth:status push + auth-status:get; flag-off
 *                    fallback auth-health:get state)
 *   #tb-auth-banner  persistent step-up banner with a "Run mwinit" button
 *
 * All decisions live in fleet-trust-logic.js. mwinit runs ONLY from the banner
 * button click handler below; mount, render and the bus handlers never start it.
 */

import bus from '../bus.js';
import { fleet as fleetBridge, auth as authBridge } from '../bridge.js';
import {
  deriveFreshness, renderFreshnessHtml,
  deriveAuthBadge, renderAuthBadgeHtml,
  deriveStepUpBanner, renderBannerHtml,
} from './fleet-trust-logic.js';

const RENDER_EVERY_MS = 30 * 1000;
const REFETCH_EVERY_MS = 60 * 1000;
const HEALTH_THROTTLE_MS = 60 * 1000;

function defaultDeps() {
  return {
    getFreshness: () => fleetBridge.getFreshness(),
    forceSync: () => fleetBridge.forceSync(),
    statusGet: () => authBridge.statusGet(),
    healthGet: () => authBridge.healthGet(),
    healthRunMwinit: authBridge.healthRunMwinit,
    on: (ev, fn) => bus.on(ev, fn),
    emit: (ev, d) => bus.emit(ev, d),
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
  };
}

export function mount(els, deps = defaultDeps()) {
  const fresh = (els && els.fresh) || null;
  const authEl = (els && els.auth) || null;
  const banner = (els && els.banner) || null;
  const d = deps || {};
  const now = () => (typeof d.now === 'function' ? d.now() : Date.now());
  const emit = (ev, p) => { try { if (typeof d.emit === 'function') d.emit(ev, p); } catch (_) {} };
  const call = (fn) => {
    try { return typeof fn === 'function' ? Promise.resolve(fn()) : Promise.resolve(null); } catch (e) { return Promise.reject(e); }
  };

  let payload = null;
  let status = null;
  let health = null;
  let lastHealthAt = -Infinity;
  let refreshing = false;
  let mwinitRunning = false;
  let bannerHtml = null;
  let destroyed = false;
  const unsubs = [];
  const timers = [];

  function render() {
    if (destroyed) return;
    const t = now();
    try {
      if (fresh) {
        const v = deriveFreshness(payload, { now: t });
        fresh.className = 'tb-fresh tb-fresh--' + v.level;
        fresh.innerHTML = renderFreshnessHtml(v);
        fresh.title = v.title;
      }
      if (authEl) {
        const b = deriveAuthBadge(status, health, { now: t });
        authEl.className = 'tb-auth tb-auth--' + b.level;
        authEl.innerHTML = renderAuthBadgeHtml(b);
        authEl.title = b.title;
      }
      if (banner) {
        const bn = deriveStepUpBanner(status, health);
        banner.hidden = !bn.show;
        const html = renderBannerHtml(bn, { busy: mwinitRunning });
        // Only rewrite when it changed, so the periodic render does not
        // recreate the button under the user's cursor.
        if (html !== bannerHtml) { banner.innerHTML = html; bannerHtml = html; }
      }
    } catch (_) { /* indicators must never break the toolbar */ }
  }

  function _needHealth() {
    if (!status) return true;
    try { return deriveStepUpBanner(status, health).show; } catch (_) { return false; }
  }

  function maybeHealth() {
    if (destroyed || !_needHealth()) return Promise.resolve();
    const t = now();
    if (t - lastHealthAt < HEALTH_THROTTLE_MS) return Promise.resolve();
    lastHealthAt = t;
    return call(d.healthGet)
      .then((h) => { health = (h && typeof h === 'object' && h.ok !== false) ? h : null; })
      .catch(() => { health = null; })
      .then(render);
  }

  function refetchFreshness() {
    if (destroyed) return Promise.resolve();
    return call(d.getFreshness)
      .then((r) => {
        payload = (r && typeof r === 'object' && r.ok !== false && r.snapshot) ? { snapshot: r.snapshot, evaluation: r.evaluation || null } : null;
      })
      .catch(() => { payload = null; })
      .then(render);
  }

  function loadStatus() {
    return call(d.statusGet)
      .then((r) => { status = (r && r.enabled && r.status && typeof r.status === 'object') ? r.status : null; })
      .catch(() => { status = null; })
      .then(() => { render(); return maybeHealth(); });
  }

  async function onFreshClick() {
    if (refreshing || !fresh) return;
    refreshing = true;
    fresh.disabled = true;
    emit('ui:toast', { type: 'info', message: 'Refreshing fleet data…', duration: 2000 });
    try {
      await call(d.forceSync);
    } catch (e) {
      emit('ui:toast', { type: 'error', message: 'Refresh failed: ' + ((e && e.message) || e), duration: 4000 });
    } finally {
      refreshing = false;
      fresh.disabled = false;
      await refetchFreshness();
    }
  }

  function _mwinitTarget(ev) {
    const t = ev && ev.target;
    if (!t) return null;
    if (typeof t.closest === 'function') return t.closest('[data-action="run-mwinit"]');
    return t.dataset && t.dataset.action === 'run-mwinit' ? t : null;
  }

  // The ONLY place mwinit is started: an explicit click on the banner button.
  function onBannerClick(ev) {
    const btn = _mwinitTarget(ev);
    if (!btn || mwinitRunning) return Promise.resolve();
    mwinitRunning = true;
    btn.disabled = true;
    emit('ui:toast', { type: 'info', message: '🔑 Fixing Midway/AAP auth (refresh AEA + mwinit if needed)…', duration: 2500 });
    let p;
    try { p = Promise.resolve(d.healthRunMwinit()); } catch (e) { p = Promise.reject(e); }
    return p.then((r) => {
      if (r && r.ok && r.verified) {
        emit('ui:toast', { type: 'success', message: '✅ Midway/AAP auth verified', duration: 2500 });
      } else if (r && r.state === 'WAITING_FOR_USER') {
        emit('ui:toast', { type: 'warn', message: '🔑 Complete mwinit in the terminal (PIN + security key)', duration: 4000 });
      } else {
        emit('ui:toast', { type: 'warn', message: '⚠️ Auth not verified yet — auto-retrying', duration: 3000 });
      }
    }).catch(() => {
      emit('ui:toast', { type: 'warn', message: '⚠️ Auth not verified yet — auto-retrying', duration: 3000 });
    }).then(() => {
      mwinitRunning = false;
      btn.disabled = false;
      bannerHtml = null;
      lastHealthAt = -Infinity;
      render();
      return maybeHealth();
    });
  }

  if (fresh && typeof fresh.addEventListener === 'function') fresh.addEventListener('click', onFreshClick);
  if (banner && typeof banner.addEventListener === 'function') banner.addEventListener('click', onBannerClick);

  if (typeof d.on === 'function') {
    const sub = (ev, fn) => { try { const u = d.on(ev, fn); if (typeof u === 'function') unsubs.push(u); } catch (_) {} };
    sub('fleet:freshness', (p) => { payload = (p && typeof p === 'object' && p.snapshot) ? p : null; render(); });
    sub('auth:status', (s) => { if (s && typeof s === 'object') status = s; render(); maybeHealth(); });
    sub('state:fleet', () => { refetchFreshness(); });
  }

  if (typeof d.setInterval === 'function') {
    try { timers.push(d.setInterval(render, RENDER_EVERY_MS)); } catch (_) {}
    try { timers.push(d.setInterval(() => { refetchFreshness(); maybeHealth(); }, REFETCH_EVERY_MS)); } catch (_) {}
  }

  render();
  const ready = Promise.all([refetchFreshness(), loadStatus()]).then(() => {});

  function destroy() {
    destroyed = true;
    for (const u of unsubs.splice(0)) { try { u(); } catch (_) {} }
    for (const id of timers.splice(0)) { try { if (typeof d.clearInterval === 'function') d.clearInterval(id); } catch (_) {} }
  }

  return { render, destroy, ready, refresh: refetchFreshness };
}
