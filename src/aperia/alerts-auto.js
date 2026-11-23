'use strict';
/**
 * src/aperia/alerts-auto.js — Tire Alerts on by default. Started once from src/app.js (after the Aperia
 * background sign-in starter); kept separate so background sign-in itself never turns alerts on.
 *
 *   start(ctx, deps) -> { ok:true } | { ok:true, already:true }   idempotent. Subscribes to session status and
 *                       calls ensure() once.
 *   ensure()         -> Promise<void>. Starts the watcher (single-flight) when the saved choice is ON
 *                       (src/aperia/alerts-pref.js, default ON), Aperia is connected and alerts are off.
 *                       Also called after each sync-cycle issues read (src/sync/index.js). No-op before start().
 *   stop()           -> unsubscribes.
 *
 * No timers. The user's toggle (the start / stop alerts IPC in src/ipc/aperia.js) saves the choice; a saved OFF
 * stays off across restarts. Logs: { op, code } only.
 */
const { safeErr } = require('./redact');
const log = require('../utils/logger')('aperia');

// Test seam: { session, watcher, pref }.
let _deps = {};
function _session() { return _deps.session || require('./session'); }
function _watcher() { return _deps.watcher || require('./watcher'); }
function _pref() { return _deps.pref || require('./alerts-pref'); }

let _started = false;
let _ctx = null;
let _off = null;
let _startP = null;

function ensure() {
  if (!_started) return Promise.resolve();
  if (_startP) return _startP;
  try {
    if (!_pref().load().enabled) return Promise.resolve();
    const s = _session().status();
    if (!s || s.state !== 'connected') return Promise.resolve();
    const w = _watcher().status();
    if (!w || w.alerts !== 'off') return Promise.resolve();
  } catch (e) {
    log.warn('[aperia] alerts-auto', { op: 'check', code: 'APERIA_INTERNAL', err: safeErr(e) });
    return Promise.resolve();
  }
  _startP = Promise.resolve()
    .then(() => _watcher().start({ ctx: _ctx }))
    .then((r) => {
      const code = r && r.ok ? 'OK' : String((r && r.code) || 'APERIA_INTERNAL').slice(0, 40);
      log.info('[aperia] alerts-auto', { op: 'start', code });
    }, (e) => { log.warn('[aperia] alerts-auto', { op: 'start', code: 'APERIA_INTERNAL', err: safeErr(e) }); })
    .finally(() => { _startP = null; });
  return _startP;
}

function start(ctx, deps) {
  if (_started) return { ok: true, already: true };
  _deps = deps || {};
  _ctx = ctx || null;
  _started = true;
  try {
    _off = _session().onStatus((s) => { if (s && s.state === 'connected') ensure().catch(() => {}); });
  } catch (e) { log.warn('[aperia] alerts-auto', { op: 'subscribe', code: 'APERIA_INTERNAL', err: safeErr(e) }); _off = null; }
  ensure().catch(() => {});
  return { ok: true };
}

function stop() {
  try { if (_off) _off(); } catch (_) {}
  _off = null;
  _started = false;
  _ctx = null;
}

function _resetForTests() { stop(); _deps = {}; _startP = null; }

module.exports = { start, ensure, stop, _resetForTests };
