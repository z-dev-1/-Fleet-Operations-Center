'use strict';
/**
 * src/auth/propagation.js — the ONE broadcaster of auth status to the renderer
 * and the recovery fan-out (auth.propagation, default OFF). Electron-free; every
 * dependency is injectable through init({ deps }).
 *
 *   init({ sendRaw, getCtx, deps }) -> handle | null   (null when the flag is off)
 *   handle.broadcast()            mirror 'auth:mwinit-status' (__authStatus:true) THEN 'auth:status'
 *   handle.interceptLegacy(p)     true = swallow a legacy 'auth:mwinit-status' push (fails open: false)
 *   handle.onRecovered(cause)     dispose page / sticky refresh / wake workers / fleet reload / sweep / live AEA
 *   handle.refreshLive()          async live-AEA read -> supervisor.noteEvidence({ liveAeaMin })
 *   handle.shutdown()
 *
 * Module-level interceptLegacy(p) delegates to the current handle (false when
 * not initialised). The dead app:midway-renewing/renewed/expired sends in
 * app.js are deliberately NOT routed here (backlog B8).
 * Status objects carry no cookie contents; logs carry counts and fixed strings only.
 */

let _logger; try { _logger = require('../utils/logger').createLogger('auth-propagation'); } catch (_) { _logger = { debug() {}, info() {}, warn() {}, error() {} }; }

const COALESCE_MS = 200;
const EVIDENCE_MIN_INTERVAL_MS = 60 * 1000;
const LIVE_MIN_INTERVAL_MS = 60 * 1000;
const STICKY_RECOVERED_MIN_INTERVAL_MS = 5 * 60 * 1000;
const INVENTORY_MIN_INTERVAL_MS = 10 * 60 * 1000;
const API_CAUSE_SWEEP_DELAY_MS = 5000;

let _current = null;

const _isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function _defaultTimers() {
  return {
    set: (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; },
    clear: (h) => { try { clearTimeout(h); } catch (_) {} },
  };
}

function _mirror(st) {
  const ev = (st && st.evidence) || {};
  const m = {
    ok: st.ok,
    expiresInMin: _isNum(ev.sessionMin) ? ev.sessionMin : null,
    aeaExpiresInMin: _isNum(ev.diskAeaMin) ? ev.diskAeaMin : null,
    liveAeaMin: _isNum(ev.liveAeaMin) ? ev.liveAeaMin : null,
    state: st.state,
    stepUp: !!st.stepUp,
    __authStatus: true,
  };
  if (st.ok !== true) m.reason = String(st.message || '');
  return m;
}

function _dedupeKey(st) {
  const ev = (st && st.evidence) || {};
  const live = _isNum(ev.liveAeaMin) ? Math.round(ev.liveAeaMin / 5) : null;
  return JSON.stringify([st.state, st.level, !!st.stepUp, st.message, st.nextRetryAt || null, live]);
}

function _shapeOf(p) {
  if (typeof p === 'string') return 'string';
  if (p === null || p === undefined) return 'empty';
  if (typeof p !== 'object') return typeof p;
  return 'object:' + Object.keys(p).filter((k) => /^[A-Za-z_]{1,24}$/.test(k)).sort().join(',').slice(0, 80);
}

function init(opts) {
  opts = opts || {};
  const deps = opts.deps || {};
  const ar = deps.authReport || require('./auth-report');
  if (!ar.isEnabled()) return null;
  if (_current) { try { _current.shutdown(); } catch (_) {} _current = null; }
  _current = _create(opts.sendRaw, opts.getCtx, deps);
  return _current;
}

function _create(sendRaw, getCtx, deps) {
  const log = deps.logger || _logger;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const timers = deps.timers || _defaultTimers();
  const sup = () => deps.supervisor || require('./midway-health-supervisor');
  const seeder = () => deps.seeder || require('./session-seeder');
  const aapApi = () => deps.aapApi || require('../scrapers/aap_api');
  const workers = () => deps.workers || require('../workers/supervisor');
  const scheduler = () => deps.scheduler || require('../scheduler');
  const auth = () => deps.auth || require('../scrapers/auth');
  const stickyDeps = deps.stickyDeps || {};
  const send = typeof sendRaw === 'function' ? sendRaw : () => {};

  let active = true;
  let lastState = null;
  let lastKey = null;
  let lastBroadcastAt = 0;
  let pendingTimer = null;
  let pendingNonEvidence = false;
  let lastLiveAt = null;
  let lastStickyRecoveredAt = null;
  let lastInventoryAt = null;
  let warnedIntercept = false;
  const sweepTimers = new Set();

  try { const s0 = sup().getStatus(); lastState = s0 && s0.state; } catch (_) { lastState = null; }

  function _step(name, fn) {
    try { fn(); return true; }
    catch (e) { try { log.warn('[auth-propagation] recovery step ' + name + ' failed: ' + String((e && e.message) || e).slice(0, 160)); } catch (_) {} return false; }
  }
  function _swallow(p) { if (p && typeof p.catch === 'function') p.catch(() => {}); return p; }

  function broadcast(status) {
    if (!active) return false;
    const st = status || sup().getStatus();
    if (!st) return false;
    try { send('auth:mwinit-status', _mirror(st)); } catch (_) {}
    try { send('auth:status', st); } catch (_) {}
    lastKey = _dedupeKey(st);
    lastBroadcastAt = now();
    return true;
  }

  function _flushBroadcast() {
    pendingTimer = null;
    if (!active) return;
    const nonEvidence = pendingNonEvidence;
    pendingNonEvidence = false;
    let st = null;
    try { st = sup().getStatus(); } catch (_) { st = null; }
    if (!st) return;
    if (!nonEvidence && lastBroadcastAt && (now() - lastBroadcastAt) < EVIDENCE_MIN_INTERVAL_MS) return;
    if (_dedupeKey(st) === lastKey) return;
    broadcast(st);
  }

  function _scheduleBroadcast(evtType) {
    if (evtType !== 'evidence') pendingNonEvidence = true;
    if (pendingTimer != null) return;
    pendingTimer = timers.set(_flushBroadcast, COALESCE_MS);
  }

  async function refreshLive() {
    let v = null;
    try { v = await auth().aeaSessionExpiryMin(); } catch (_) { v = null; }
    const live = _isNum(v) ? v : null;
    try { sup().noteEvidence({ liveAeaMin: live }); } catch (_) {}
    return live;
  }

  function _maybeRefreshLive() {
    const t = now();
    if (lastLiveAt !== null && (t - lastLiveAt) < LIVE_MIN_INTERVAL_MS) return false;
    lastLiveAt = t;
    _swallow(refreshLive());
    return true;
  }

  function _sweep() {
    _step('scheduler-sweep', () => { _swallow(scheduler().recoverBlockedSlots()); });
  }

  function onRecovered(cause) {
    const c = String(cause || '');
    const apiCause = /^(api:|data-source-)/.test(c);
    const steps = [];
    if (!apiCause) { if (_step('dispose', () => { aapApi().dispose(); })) steps.push('dispose'); }
    _step('sticky', () => {
      const t = now();
      if (lastStickyRecoveredAt !== null && (t - lastStickyRecoveredAt) < STICKY_RECOVERED_MIN_INTERVAL_MS) return;
      lastStickyRecoveredAt = t;
      _swallow(seeder().refreshSticky('recovered', stickyDeps));
      steps.push('sticky');
    });
    if (_step('wake', () => { workers().wakeDependents('auth'); })) steps.push('wake');
    const skipReload = apiCause || /^(startup|post-reauth)/.test(c);
    let ctx = null;
    try { ctx = typeof getCtx === 'function' ? getCtx() : null; } catch (_) { ctx = null; }
    let reloaded = false;
    if (!skipReload && ctx && typeof ctx._loadFleetViaApiStartup === 'function') {
      reloaded = _step('reload', () => {
        const p = Promise.resolve(ctx._loadFleetViaApiStartup('auth-recovered'));
        p.then(_sweep, _sweep);
      });
      if (reloaded) steps.push('reload');
    }
    if (!reloaded) {
      const h = timers.set(() => { sweepTimers.delete(h); if (active) _sweep(); }, API_CAUSE_SWEEP_DELAY_MS);
      sweepTimers.add(h);
    }
    if (_step('live', () => { _swallow(refreshLive()); })) steps.push('live');
    try { log.info('[auth-propagation] recovered cause=' + c.replace(/[^A-Za-z0-9:_ .#-]/g, '').slice(0, 60) + ' steps=' + steps.length); } catch (_) {}
    return { steps, reloaded };
  }

  function _leftHealthy() {
    const t = now();
    if (lastInventoryAt !== null && (t - lastInventoryAt) < INVENTORY_MIN_INTERVAL_MS) return;
    lastInventoryAt = t;
    const sd = seeder();
    const build = typeof deps.buildInventory === 'function' ? deps.buildInventory : sd.buildInventory;
    _swallow(Promise.resolve().then(() => build(deps.inventorySession || null, deps)).then((inv) => {
      if (!active || !inv) return;
      try { log.info(sd.formatInventory(inv, 'left-healthy')); } catch (_) {}
      try { sup().noteEvidence({ aeaCountToMidway: inv.aeaCountToMidway }); } catch (_) {}
    }));
  }

  function _onEvent(evt) {
    if (!active || !evt) return;
    const cur = evt.to || (evt.status && evt.status.state) || null;
    const prev = lastState;
    lastState = cur;
    if (cur === 'HEALTHY' && prev !== 'HEALTHY') onRecovered(evt.cause);
    else if (prev === 'HEALTHY' && cur && cur !== 'HEALTHY') _leftHealthy();
    _scheduleBroadcast(evt.type);
  }

  function interceptLegacy(payload) {
    try {
      if (!active) return false;
      if (payload && typeof payload === 'object' && payload.__authStatus === true) return false;   // the mirror passes
      if (payload && typeof payload === 'object' && (_isNum(payload.expiresInMin) || _isNum(payload.aeaExpiresInMin))) {
        // Heartbeat-shaped: evidence only (its truth claim is dropped).
        const ev = {};
        if (_isNum(payload.expiresInMin)) ev.sessionMin = payload.expiresInMin;
        if (_isNum(payload.aeaExpiresInMin)) ev.diskAeaMin = payload.aeaExpiresInMin;
        sup().noteEvidence(ev);
        _maybeRefreshLive();
        // F10: keep the 15-min posture AEA in the sticky partition fresh. Bounded by the
        // seeder's 5-min per-partition limit and its seeded-this-process rule.
        try { _swallow(seeder().refreshSticky('heartbeat', stickyDeps)); } catch (_) {}
        return true;
      }
      try { log.debug('[auth-propagation] legacy auth:mwinit-status dropped shape=' + _shapeOf(payload)); } catch (_) {}
      return true;
    } catch (e) {
      if (!warnedIntercept) { warnedIntercept = true; try { log.warn('[auth-propagation] interceptLegacy failed, passing through: ' + String((e && e.message) || e).slice(0, 160)); } catch (_) {} }
      return false;
    }
  }

  const unsub = sup().subscribe(_onEvent);

  function shutdown() {
    active = false;
    try { if (typeof unsub === 'function') unsub(); } catch (_) {}
    if (pendingTimer != null) { try { timers.clear(pendingTimer); } catch (_) {} pendingTimer = null; }
    for (const h of sweepTimers) { try { timers.clear(h); } catch (_) {} }
    sweepTimers.clear();
    if (_current === handle) _current = null;
  }

  const handle = { broadcast, interceptLegacy, onRecovered, refreshLive, shutdown, _flushBroadcast };
  return handle;
}

function interceptLegacy(payload) {
  try { return _current ? _current.interceptLegacy(payload) : false; } catch (_) { return false; }
}
function shutdown() { if (_current) _current.shutdown(); }
function _reset() { shutdown(); _current = null; }

module.exports = {
  init, interceptLegacy, shutdown,
  COALESCE_MS, EVIDENCE_MIN_INTERVAL_MS, LIVE_MIN_INTERVAL_MS, STICKY_RECOVERED_MIN_INTERVAL_MS,
  INVENTORY_MIN_INTERVAL_MS, API_CAUSE_SWEEP_DELAY_MS,
  _reset, _mirror,
};
