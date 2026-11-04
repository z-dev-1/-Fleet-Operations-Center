'use strict';
/**
 * jobs/handle.js — durable job handle + NOOP handle (Phase 7, design §4/§6/§9).
 *
 * Synchronous API; never throws into the job body. Bodies call it only
 * BETWEEN their own awaits. Every write carries the owner+attempt fence.
 *
 *   - Lost lease (fence changes=0) -> non-durable for the rest of the run, warn once.
 *   - Busy circuit: the first busy from any write/renewal stops all further
 *     progress SQL; one final terminal attempt + one unref'd 2 s retry.
 *   - Hard error -> NOOP for the rest of the run, warn once.
 *   - start() not landed (busy) -> the terminal write is claimed -> cancelled
 *     with a note, never the illegal claimed -> completed (round-3 fix 4).
 */

const { MAX_CKPT } = require('./store');

const START_NOT_LANDED_NOTE = 'start not recorded (busy); ran non-durably';

function _noop(extra) {
  const h = Object.assign({
    durable: false, resumed: false, attempt: 0, jobId: null, blockedBy: null, busy: false, degraded: false,
    checkpoint: Object.freeze({}),
    start() {}, isUnitDone() { return false; }, isUnitPoisoned() { return false; },
    unitsStarted() {}, unitsSettled() {}, setCheckpoint() {},
    complete() {}, fail() {}, cancel() {}, _abandonForTests() {},
  }, extra || {});
  return Object.freeze(h);
}

const NOOP_HANDLE = _noop();

function _plain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function _errText(e) { return String((e && e.message) || e || 'failed').slice(0, 500); }

function createHandle(store, o) {
  const row = o.row;
  const def = o.def;
  const type = o.type || row.type;
  const log = o.log || { warn() {}, info() {} };
  const fence = Object.freeze({ id: row.id, owner: store.owner, attempt: row.attempt });
  const claimCkpt = (() => { try { const v = JSON.parse(row.checkpoint_json || '{}'); return _plain(v) ? v : {}; } catch (_) { return {}; } })();
  const units = new Map();
  for (const u of (o.checkpoints || [])) {
    let detail = null; try { detail = u.detail_json ? JSON.parse(u.detail_json) : null; } catch (_) { detail = null; }
    units.set(u.unit_key, { status: u.status, sig: u.sig, attempts: u.attempts, detail });
  }

  let mode = 'durable';          // 'durable' | 'busy' (circuit tripped) | 'noop'
  let landed = 'claimed';        // the state the row is known to be in
  let terminal = false;
  let warned = false;
  let timer = null;
  let retryTimer = null;
  let ck = Object.assign({}, claimCkpt);
  const startedAt = store.now();

  function _warnOnce(msg) { if (warned) return; warned = true; try { log.warn(msg); } catch (_) {} }
  function _stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function _leave() { _stopTimer(); store._active.delete(fence.id); store._handles.delete(h); }

  function _onFail(r, op) {
    if (r.code === 'busy') {
      mode = 'busy'; _stopTimer();
      _warnOnce('[jobs] ' + type + ' job ' + fence.id + ': database busy — durability suspended for this run');
    } else if (r.code === 'lost') {
      mode = 'noop'; _stopTimer();
      _warnOnce('[jobs] ' + type + ' job ' + fence.id + ': lease lost (' + op + ') — continuing non-durably');
    } else {
      mode = 'noop'; _stopTimer();
      _warnOnce('[jobs] ' + type + ' job ' + fence.id + ': ' + op + ' failed (' + (r.code || 'error') + ') — continuing non-durably');
    }
  }

  function _renewTick() {
    if (mode !== 'durable') { _stopTimer(); return; }
    const t = store.now();
    if (t - startedAt >= def.maxRunMs) { _stopTimer(); return; }  // lease lapses; never stolen while in _active
    const r = store.renew(fence, t + def.leaseMs);
    if (!r.ok) _onFail(r, 'renew');
  }

  function _final(to, patch, note) {
    if (terminal) return;
    terminal = true;
    _stopTimer();
    if (mode === 'noop') { _leave(); return; }
    let target = to;
    let n = note;
    if (landed === 'claimed') {
      target = 'cancelled';
      n = mode === 'busy' ? START_NOT_LANDED_NOTE : 'ended before start';
    }
    const attemptOnce = () => store.transition(fence.id, target, { expectFrom: landed, owner: fence.owner, attempt: fence.attempt, patch, note: n });
    const r = attemptOnce();
    if (r.ok || r.code !== 'busy') {
      if (!r.ok) _warnOnce('[jobs] ' + type + ' job ' + fence.id + ': final ' + target + ' not recorded (' + (r.code || r.error) + ')');
      _leave();
      return;
    }
    _onFail(r, target);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const r2 = attemptOnce();
      if (!r2.ok) { try { log.warn('[jobs] ' + type + ' job ' + fence.id + ': final ' + target + ' retry failed (' + (r2.code || r2.error) + '); boot recovery will requeue it'); } catch (_) {} }
      _leave();
    }, 2000);
    if (retryTimer.unref) retryTimer.unref();
  }

  const h = {
    get durable() { return mode === 'durable'; },
    get resumed() { return !!o.resumed; },
    get attempt() { return fence.attempt; },
    get jobId() { return fence.id; },
    blockedBy: null,
    busy: false,
    degraded: false,
    checkpoint: Object.freeze(Object.assign({}, claimCkpt)),

    start() {
      if (mode !== 'durable' || landed !== 'claimed' || terminal) return;
      const r = store.transition(fence.id, 'running', { expectFrom: 'claimed', owner: fence.owner, attempt: fence.attempt });
      if (r.ok) landed = 'running'; else _onFail(r, 'start');
    },
    isUnitDone(key, sig) {
      const u = units.get(key);
      return !!(o.resumed && u && u.status === 'done' && u.sig != null && typeof sig === 'string' && u.sig === sig);
    },
    isUnitPoisoned(key) {
      const u = units.get(key);
      return !!(o.resumed && u && u.status === 'skipped' && u.detail && u.detail.reason === 'crash-loop guard');
    },
    unitsStarted(keys) {
      if (mode !== 'durable' || terminal) return;
      const r = store.unitsStarted(fence, keys);
      if (!r.ok) _onFail(r, 'unitsStarted');
    },
    unitsSettled(entries) {
      if (mode !== 'durable' || terminal) return;
      const r = store.unitsSettled(fence, entries);
      if (!r.ok) _onFail(r, 'unitsSettled');
    },
    setCheckpoint(obj) {
      if (mode !== 'durable' || terminal || !_plain(obj)) return;
      const merged = Object.assign({}, ck, obj);
      let json;
      try { json = JSON.stringify(merged); } catch (_) { return; }
      if (json.length > MAX_CKPT) { try { log.warn('[jobs] ' + type + ' job ' + fence.id + ': checkpoint over 16 KB dropped'); } catch (_) {} return; }
      const r = store.setCheckpoint(fence, json);
      if (r.ok) ck = merged; else _onFail(r, 'setCheckpoint');
    },
    complete(summary) {
      const merged = _plain(summary) ? Object.assign({}, ck, summary) : ck;
      let json = null;
      try { json = JSON.stringify(merged); } catch (_) { json = null; }
      if (json && json.length > MAX_CKPT) json = null;
      _final('completed', json ? { checkpoint_json: json } : {}, 'completed');
    },
    fail(err) { _final('failed', { last_error: _errText(err) }, 'failed'); },
    cancel(reason) { _final('cancelled', { last_error: reason ? _errText(reason) : null }, 'cancelled'); },

    // Test-only: simulate the process dying mid-run (no SQL write).
    _abandonForTests() { terminal = true; mode = 'noop'; _leave(); },
    _stopTimersForTests() { _stopTimer(); if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; } },
    _state() { return { mode, landed, terminal }; },
  };

  store._active.add(fence.id);
  store._handles.add(h);
  if (def.leaseMs > 0) {
    timer = setInterval(_renewTick, Math.max(1, Math.floor(def.leaseMs / 3)));
    if (timer.unref) timer.unref();
  }
  return h;
}

module.exports = { createHandle, NOOP_HANDLE, _noop, START_NOT_LANDED_NOTE };
