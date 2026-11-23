'use strict';
/**
 * src/aperia/watcher.js — the tire alert watcher. OFF at load: requiring this module starts no
 * timer and makes no Aperia call. src/aperia/alerts-auto.js turns it on once Aperia is connected unless the
 * user switched alerts off (aperia_alerts_pref.json); background sign-in itself never starts it.
 *
 *   start({ minutes, ctx, scope }) -> { ok:true, status } | { ok:true, already:true, status } | { ok:false, code }
 *     Needs a captured Bearer (APERIA_SIGNIN_REQUIRED). Primes the seen ids from one issues read WITHOUT
 *     notifying, starts the poll interval (minutes 1..60, default 5) and, when C.APERIA_WS_ENABLED and a WS
 *     token was captured, the alert socket. Every tick polls, whether or not the socket is open. A poll
 *     that fails with a sign-in code sends a { type:'watcher' } status so the pill re-reads status().
 *   stop() -> { ok:true, status }       clears the interval, closes the socket.
 *   pollNow(ctx) -> { ok:true, newCount } | { ok:false, code }   (APERIA_ALERTS_OFF when off)
 *   status() -> { alerts:'off'|'ws'|'polling', minutes, lastPollAt, lastNewCount }
 *
 * One desktop Notification per new non-muted issue id on a fleet-row unit (normUnit(fleetVehicleId) in
 * the scope Set from src/aperia/fleet-scope.js, or the `scope` function passed to start); ids persist in
 * aperia_seen_alerts.json so a restart never re-notifies. Approved extension: when an already-seen id's
 * severity goes UP (MINOR < MAJOR < CRITICAL), one more Notification fires per step up; the highest
 * severity per id persists with the ids. Muted issues (muted:true on the row, or muted in the last list
 * read for a WS frame) and issues on units outside the fleet rows are marked seen and never notify,
 * escalation included. An empty scope (fleet rows not loaded) skips the poll without marking anything
 * seen. The poll itself stays fleet-wide on the wire (Aperia has no per-unit issues feed).
 * Every on/off/mode change is sent as { type:'watcher', status } on 'aperia:alert'.
 * Logs carry counts and codes only.
 */
const C0 = require('./constants');
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

// Test seam: { client, capture, seenStore, createAlertSocket, Notification, send, mainWindow, now, timers, constants, scope }.
let _deps = {};
let _scopeFn = null; // start({ scope }) — () => Set of normUnit ids
function _fleetScope() { return require('./fleet-scope'); }
/** _scopeSet() -> Set of fleet-row unit keys (never throws; failure -> empty Set). */
function _scopeSet() {
  try {
    const fn = typeof _deps.scope === 'function' ? _deps.scope
      : (typeof _scopeFn === 'function' ? _scopeFn : () => _fleetScope().fleetUnitSet(_ctx));
    const s = fn();
    return s instanceof Set ? s : new Set();
  } catch (_) { return new Set(); }
}
function _setDeps(d) { _deps = d || {}; }
function _C() { return _deps.constants || C0; }
function _client() { return _deps.client || require('./client'); }
function _capture() { return _deps.capture || require('./capture'); }
function _seenStore() { return _deps.seenStore || require('./seen-store'); }
function _createSocket() { return _deps.createAlertSocket || require('./ws').createAlertSocket; }
function _now() { return typeof _deps.now === 'function' ? _deps.now() : Date.now(); }
function _timers() {
  return Object.assign({
    setInterval: (...a) => globalThis.setInterval(...a),
    clearInterval: (t) => globalThis.clearInterval(t),
  }, _deps.timers || {});
}
function _Notification() {
  if ('Notification' in _deps) return _deps.Notification;
  try { return require('electron').Notification; } catch (_) { return null; }
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

let _on = false;
let _ctx = null;
let _gen = 0;
let _minutes = C0.ALERT_POLL_DEFAULT_MIN;
let _interval = null;
let _socket = null;
let _seen = new Map();
let _sev = new Map(); // id -> highest severity seen/notified; a step up notifies once more
let _muted = new Set(); // ids muted in the last successful list read (WS frames may lack the flag)
let _lastPollAt = null;
let _lastNewCount = 0;
let _lastMode = 'off';
let _startP = null;
let _pollP = null;

function status() {
  const alerts = !_on ? 'off' : (_socket && _socket.state() === 'open' ? 'ws' : 'polling');
  return { alerts, minutes: _minutes, lastPollAt: _lastPollAt, lastNewCount: _lastNewCount };
}

function _send(ch, payload) {
  try {
    if (typeof _deps.send === 'function') _deps.send(ch, payload);
    else if (_ctx && typeof _ctx.sendToWindow === 'function') _ctx.sendToWindow(ch, payload);
  } catch (e) { log.warn('[aperia] watcher send', { code: 'APERIA_SEND_FAILED', err: safeErr(e) }); }
}

/** _emitStatus(force) — send { type:'watcher', status } when the mode changed (or always when forced). */
function _emitStatus(force) {
  const st = status();
  if (!force && st.alerts === _lastMode) return;
  _lastMode = st.alerts;
  _send('aperia:alert', { type: 'watcher', status: st });
}

function _q(v) { const s = v === null || v === undefined ? '' : String(v); return s || '?'; }

function _notify(alert) {
  const title = `${_q(alert.severity)}: ${_q(alert.fleetVehicleId)}`;
  const body = `${_q(alert.state).replace(/_/g, ' ')} \u2013 ${_q(alert.positionName)} (${_q(alert.domicile)})`;
  const N = _Notification();
  try {
    if (N && typeof N.isSupported === 'function' && N.isSupported()) {
      const n = new N({ title, body, silent: false });
      n.on('click', () => {
        const w = _deps.mainWindow || (_ctx && _ctx.mainWindow);
        if (w) { try { w.show(); w.focus(); } catch (_) {} }
      });
      n.show();
    }
  } catch (e) { log.warn('[aperia] watcher notify', { code: 'APERIA_NOTIFY_FAILED', err: safeErr(e) }); }
  _send('aperia:alert', {
    type: 'alert',
    alert: {
      id: alert.id, severity: alert.severity || '', fleetVehicleId: alert.fleetVehicleId || '', state: alert.state || '',
      positionName: alert.positionName || '', domicile: alert.domicile || '', detectedAt: alert.detectedAt || '',
    },
  });
}

const SEV_RANK = Object.freeze({ MINOR: 1, MAJOR: 2, CRITICAL: 3 });
function _rank(s) { return SEV_RANK[String(s || '').toUpperCase()] || 0; }
function _sevKey(s) { const k = String(s || '').toUpperCase(); return SEV_RANK[k] ? k : ''; }

/**
 * _escalated(id, severity) -> true once per step up for an already-seen id. An id with no recorded
 * severity (older seen file) just records it. Equal or lower severity never notifies or lowers the record.
 */
function _escalated(id, severity) {
  const k = _sevKey(severity);
  if (!k) return false;
  const prev = _sev.get(id);
  if (!prev) { _sev.set(id, k); return false; }
  if (_rank(k) <= _rank(prev)) return false;
  _sev.set(id, k);
  return true;
}

function _noteSev(id, severity) {
  const k = _sevKey(severity);
  if (k && _rank(k) > _rank(_sev.get(id))) _sev.set(id, k);
}

function _rebuildMuted(rows) {
  const m = new Set();
  for (const x of Array.isArray(rows) ? rows : []) {
    const id = x && x.issueId != null ? String(x.issueId) : '';
    if (x && x.muted === true && ID_RE.test(id)) m.add(id);
  }
  _muted = m;
}

function _save() { try { _seenStore().save(_seen, _now(), _sev); } catch (e) { log.warn('[aperia] watcher save', { code: 'APERIA_SEEN_WRITE_FAILED', err: safeErr(e) }); } }

function _validMinutes(m) {
  const C = _C();
  return Number.isInteger(m) && m >= C.ALERT_POLL_MIN && m <= C.ALERT_POLL_MAX ? m : C.ALERT_POLL_DEFAULT_MIN;
}

async function _doStart(opts) {
  const gen = ++_gen;
  const t0 = Date.now();
  const C = _C();
  const ctx = opts.ctx || null;
  const minutes = _validMinutes(opts.minutes);
  if (!_capture().current()) return { ok: false, code: 'APERIA_SIGNIN_REQUIRED' };
  const store = _seenStore();
  const loaded = typeof store.loadAll === 'function' ? store.loadAll(_now()) : { ids: store.load(_now()), sev: new Map() };
  const seen = loaded.ids;
  const sev = loaded.sev;
  let r;
  try { r = await _client().listIssues(ctx); } catch (e) { log.warn('[aperia] watcher start', { code: 'APERIA_INTERNAL', err: safeErr(e) }); r = { ok: false, code: 'APERIA_INTERNAL' }; }
  if (gen !== _gen) return { ok: false, code: 'APERIA_ALERTS_OFF' };
  if (!r || !r.ok) { log.info('[aperia] watcher start', { code: (r && r.code) || 'APERIA_INTERNAL' }); return { ok: false, code: (r && r.code) || 'APERIA_INTERNAL' }; }
  const at = _now();
  let primed = 0;
  _rebuildMuted(r.rows);
  _scopeFn = typeof opts.scope === 'function' ? opts.scope : null;
  for (const x of Array.isArray(r.rows) ? r.rows : []) {
    const id = x && x.issueId != null ? String(x.issueId) : '';
    if (!ID_RE.test(id)) continue;
    if (!seen.has(id)) { seen.set(id, at); primed++; }
    // Priming records the current severity without notifying; only a later step up notifies.
    const k = _sevKey(x.severity);
    if (k && _rank(k) > _rank(sev.get(id))) sev.set(id, k);
  }
  _seen = seen;
  _sev = sev;
  _ctx = ctx;
  _minutes = minutes;
  _on = true;
  _lastPollAt = new Date(at).toISOString();
  _lastNewCount = 0;
  _save();
  _interval = _timers().setInterval(_tick, minutes * 60e3);
  try { if (_interval && typeof _interval.unref === 'function') _interval.unref(); } catch (_) {}
  _emitStatus(true);
  const token = C.APERIA_WS_ENABLED ? _capture().wsToken() : null;
  if (token) {
    const sock = _createSocket()({
      token,
      onAlert: (a) => { if (_socket === sock) _onWsAlert(a); },
      onState: () => { if (_socket === sock) _emitStatus(false); },
    });
    _socket = sock;
    sock.open();
  }
  log.info('[aperia] watcher start', { seen: _seen.size, primed, minutes, ws: !!token, ms: Date.now() - t0 });
  return { ok: true, status: status() };
}

function start(opts) {
  if (_on) return Promise.resolve({ ok: true, already: true, status: status() });
  if (_startP) return _startP;
  _startP = _doStart(opts || {}).finally(() => { _startP = null; });
  return _startP;
}

function stop() {
  _gen++;
  if (_interval) { try { _timers().clearInterval(_interval); } catch (_) {} _interval = null; }
  const sock = _socket;
  _socket = null;
  if (sock) { try { sock.close(); } catch (_) {} }
  const was = _on;
  _on = false;
  if (was) { log.info('[aperia] watcher stop', { seen: _seen.size }); _emitStatus(true); }
  return { ok: true, status: status() };
}

// Every tick polls, socket open or not: the alert-frame format is unverified live and the socket has no
// liveness check, so an open socket alone must never suppress alerts. Seen-id de-dupe prevents doubles.
function _tick() {
  if (!_on) return;
  _poll(_ctx).catch(() => {});
}

const SIGNIN_CODES = new Set(['APERIA_SIGNIN_REQUIRED', 'APERIA_SESSION_EXPIRED']);

function _poll(ctx) {
  if (_pollP) return _pollP;
  _pollP = (async () => {
    const gen = _gen;
    let r;
    try { r = await _client().listIssues(ctx || _ctx); } catch (e) { log.warn('[aperia] watcher poll', { code: 'APERIA_INTERNAL', err: safeErr(e) }); r = { ok: false, code: 'APERIA_INTERNAL' }; }
    if (gen !== _gen || !_on) return { ok: false, code: 'APERIA_ALERTS_OFF' };
    _lastPollAt = new Date(_now()).toISOString();
    if (!r || !r.ok) {
      const code = (r && r.code) || 'APERIA_INTERNAL';
      log.info('[aperia] watcher poll', { code });
      // Lost sign-in: push a watcher status so the pill / panel re-read status() and stop showing Alerts ON.
      if (SIGNIN_CODES.has(code)) _emitStatus(true);
      return { ok: false, code };
    }
    const list = Array.isArray(r.rows) ? r.rows : [];
    _rebuildMuted(list);
    const scope = _scopeSet();
    if (!scope.size) {
      // Fleet rows not loaded yet: notify nothing and mark nothing seen, so the next poll can still alert.
      _lastNewCount = 0;
      log.info('[aperia] watcher poll', { rows: list.length, newCount: 0, skipped: 'no-scope' });
      return { ok: true, newCount: 0, skipped: 'no-scope' };
    }
    const at = _now();
    const fresh = [];
    let dirty = false;
    let scoped = 0; let outOfScope = 0; let muted = 0;
    for (const x of list) {
      if (!x) continue;
      const id = x.issueId != null ? String(x.issueId) : '';
      if (!ID_RE.test(id)) continue;
      const isMuted = x.muted === true;
      const inFleet = _fleetScope().inScope(scope, x.fleetVehicleId);
      if (isMuted) muted++; else if (inFleet) scoped++; else outOfScope++;
      if (isMuted || !inFleet) {
        // Record without notifying (escalation included).
        if (!_seen.has(id)) { _seen.set(id, at); dirty = true; }
        const before = _sev.get(id);
        _noteSev(id, x.severity);
        if (_sev.get(id) !== before) dirty = true;
        continue;
      }
      if (_seen.has(id)) { if (!_escalated(id, x.severity)) continue; } else { _seen.set(id, at); _noteSev(id, x.severity); }
      fresh.push({
        id, severity: x.severity, fleetVehicleId: x.fleetVehicleId, state: x.state,
        positionName: x.positionName, domicile: x.domicile, detectedAt: x.dateDetected,
      });
    }
    if (fresh.length || dirty) _save();
    _lastNewCount = fresh.length;
    for (const a of fresh) _notify(a);
    log.info('[aperia] watcher poll', { rows: list.length, newCount: fresh.length, scoped, outOfScope, muted });
    return { ok: true, newCount: fresh.length };
  })().finally(() => { _pollP = null; });
  return _pollP;
}

async function pollNow(ctx) {
  if (!_on) return { ok: false, code: 'APERIA_ALERTS_OFF' };
  return _poll(ctx || _ctx);
}

/**
 * _onWsAlert(a) — one socket alert: muted (frame flag or last list read) -> record only; skip seen ids;
 * mark seen + save; enrich (best effort); notify only for a fleet-row unit.
 */
async function _onWsAlert(a) {
  if (!_on || !a) return { ok: false, code: 'APERIA_ALERTS_OFF' };
  const id = a.id != null ? String(a.id) : '';
  if (!ID_RE.test(id)) return { ok: true, notified: false };
  if (a.muted === true || _muted.has(id)) {
    if (!_seen.has(id)) _seen.set(id, _now());
    _noteSev(id, a.severity);
    _save();
    return { ok: true, notified: false };
  }
  if (_seen.has(id)) {
    if (!_escalated(id, a.severity)) { _save(); return { ok: true, notified: false }; }
  } else {
    _seen.set(id, _now());
    _noteSev(id, a.severity);
  }
  _save();
  const gen = _gen;
  const alert = {
    id, severity: a.severity, fleetVehicleId: a.fleetVehicleId, state: a.state,
    positionName: '', domicile: '', detectedAt: new Date(_now()).toISOString(),
  };
  try {
    const r = a.vehicleId ? await _client().getVehicle(a.vehicleId, _ctx) : null;
    if (r && r.ok && r.unit) {
      const u = r.unit;
      const hit = (Array.isArray(u.issues) ? u.issues : []).find((x) => x && String(x.id) === id)
        || (Array.isArray(u.tires) ? u.tires : []).find((t) => t && t.issue && String(t.issue.id) === id);
      if (hit) alert.positionName = hit.positionName || '';
      alert.domicile = u.domicile || '';
      if (!alert.fleetVehicleId) alert.fleetVehicleId = u.fleetVehicleId || '';
    } else if (r) {
      log.info('[aperia] watcher enrich', { code: r.code || 'APERIA_INTERNAL' });
    }
  } catch (e) { log.warn('[aperia] watcher enrich', { code: 'APERIA_INTERNAL', err: safeErr(e) }); }
  if (gen !== _gen || !_on) return { ok: false, code: 'APERIA_ALERTS_OFF' };
  // Unknown unit or a unit outside the fleet rows: already recorded as seen, no Notification.
  if (!_fleetScope().inScope(_scopeSet(), alert.fleetVehicleId)) return { ok: true, notified: false };
  _notify(alert);
  return { ok: true, notified: true };
}

function _resetForTests() {
  if (_interval) { try { _timers().clearInterval(_interval); } catch (_) {} }
  if (_socket) { try { _socket.close(); } catch (_) {} }
  _deps = {}; _on = false; _ctx = null; _gen = 0; _minutes = C0.ALERT_POLL_DEFAULT_MIN; _interval = null; _socket = null;
  _seen = new Map(); _sev = new Map(); _muted = new Set(); _scopeFn = null; _lastPollAt = null; _lastNewCount = 0; _lastMode = 'off'; _startP = null; _pollP = null;
}

module.exports = { start, stop, pollNow, status, _onWsAlert, _setDeps, _resetForTests };
