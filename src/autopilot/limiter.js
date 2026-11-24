'use strict';
/**
 * autopilot/limiter.js — live-read budget, concurrency and deadlines (§B7.6, plan R9).
 * In memory; resets on restart.
 *
 *   hourly token buckets   aap_live 30, decisiv 12 (sliding 1 h window)
 *   per tick               <= 6 live calls (beginTick() resets the counter)
 *   per source             one in-flight call; after a timeout the orphaned call keeps the
 *                          slot until it settles (status busy_orphan meanwhile)
 *   per run                <= 2 live calls in parallel (run() returns a scope)
 *   deadlines              aap_live 20 s, decisiv 30 s, via withDeadline (setTimeout + .then).
 *                          withDeadline is never used for AI calls.
 *   retry                  none after a timeout; one retry after 2 s + 0-1 s jitter only after
 *                          a settled network error or 5xx. Auth codes and *_NOT_WARM never retry.
 *
 * A live call fn() resolves { ok:true, value } | { ok:false, code, status? } (ports.js shape).
 * call() resolves { source, status, value?, code?, attempts, ms, live } and never throws.
 * status: ok | auth_unavailable | not_warm | rate_limited | busy_orphan | cache_only:budget |
 *         cache_only:<gate why> | error:timeout | error:<code> | skipped:aborted
 */

const HOUR = 60 * 60 * 1000;
const HOURLY = Object.freeze({ aap_live: 30, decisiv: 12 });
const DEADLINE_MS = Object.freeze({ aap_live: 20000, decisiv: 30000 });
const MAX_PER_TICK = 6;
const MAX_PARALLEL_PER_RUN = 2;
const RETRY_BASE_MS = 2000;
const RETRY_JITTER_MS = 1000;

const AUTH_CODES = new Set(['MIDWAY_SESSION_INVALID', 'DECISIV_SESSION_INVALID']);
const NOT_WARM_CODES = new Set(['AAP_NOT_WARM', 'DECISIV_NOT_WARM']);
// Answered before any network traffic: the bucket token is refunded.
const PRECALL = Object.freeze({
  LIVE_READS_OFF: 'cache_only:live_reads_off',
  GATE_CLOSED: 'cache_only:gate_closed',
  DECISIV_NO_ORIGIN: 'cache_only:no_origin',
  PORT_MISSING: 'error:PORT_MISSING',
  INVALID_INPUT: 'error:INVALID_INPUT',
  DECISIV_NO_ESTIMATE_ID: 'error:DECISIV_NO_ESTIMATE_ID',
});
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'NETWORK_ERROR']);

/** withDeadline(promise, ms) -> Promise<{value}|{error}|{timedOut:true}>. Never rejects. */
function withDeadline(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
    Promise.resolve(promise).then(
      (value) => { if (!done) { done = true; clearTimeout(t); resolve({ value }); } },
      (error) => { if (!done) { done = true; clearTimeout(t); resolve({ error }); } },
    );
  });
}

function _sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort); resolve(true); }, ms);
    function onAbort() { clearTimeout(t); resolve(false); }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function _isAuth(code, status) { return AUTH_CODES.has(code) || status === 401 || status === 403; }

/** Classify a settled fn() outcome. */
function classifyOutcome(o) {
  if (o.timedOut) return { status: 'error:timeout', retry: false };
  let r = o.value;
  if (o.error) r = { ok: false, code: (o.error && o.error.code) || 'NETWORK_ERROR', status: o.error && o.error.status };
  if (r && r.ok === true) return { status: 'ok', value: r.value, retry: false };
  const code = (r && r.code) || 'UNKNOWN';
  const status = r && r.status;
  if (_isAuth(code, status)) return { status: 'auth_unavailable', code, retry: false };
  if (NOT_WARM_CODES.has(code)) return { status: 'not_warm', code, retry: false };
  if (PRECALL[code]) return { status: PRECALL[code], code, retry: false, precall: true };
  if (/TIMEOUT/.test(code)) return { status: 'error:timeout', code, retry: false };
  const retry = NETWORK_CODES.has(code) || status === 0 || (Number.isFinite(status) && status >= 500);
  return { status: 'error:' + code, code, retry };
}

function createLimiter(opts) {
  const o = opts || {};
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const random = typeof o.random === 'function' ? o.random : Math.random;
  const hourly = Object.assign({}, HOURLY, o.hourly || {});
  const deadlines = Object.assign({}, DEADLINE_MS, o.deadlines || {});
  const maxPerTick = Number.isFinite(o.maxPerTick) ? o.maxPerTick : MAX_PER_TICK;
  const used = {};      // source -> [ts]
  const slots = {};     // source -> { orphan, settled: Promise }
  let tickCalls = 0;

  function _window(source) {
    const t = now();
    const list = (used[source] || []).filter((x) => t - x < HOUR);
    used[source] = list;
    return list;
  }
  function tokensLeft(source) {
    const cap = hourly[source];
    if (!Number.isFinite(cap)) return Infinity;
    return Math.max(0, cap - _window(source).length);
  }
  function _take(source) {
    if (tokensLeft(source) <= 0) return false;
    _window(source).push(now());
    return true;
  }
  function _refund(source) {
    const list = used[source];
    if (list && list.length) list.pop();
  }
  function beginTick() { tickCalls = 0; }
  function tickLeft() { return Math.max(0, maxPerTick - tickCalls); }

  // Acquire the per-source slot. Waits for a normal in-flight call; refuses on an orphan.
  async function _acquireSource(source) {
    for (;;) {
      const s = slots[source];
      if (!s) break;
      if (s.orphan) return null;
      await s.settled;
    }
    let release;
    const settled = new Promise((r) => { release = r; });
    const slot = { orphan: false, settled, release: () => { if (slots[source] === slot) delete slots[source]; release(); } };
    slots[source] = slot;
    return slot;
  }

  function run(runOpts) {
    const ro = runOpts || {};
    const signal = ro.signal || null;
    let active = 0;
    const waiters = [];
    async function _enter() {
      while (active >= MAX_PARALLEL_PER_RUN) await new Promise((r) => waiters.push(r));
      active++;
    }
    function _leave() { active--; const w = waiters.shift(); if (w) w(); }

    async function call(source, fn) {
      const started = now();
      const res = (status, extra) => Object.assign({ source, status, attempts: 0, ms: now() - started, live: false }, extra || {});
      if (signal && signal.aborted) return res('skipped:aborted');
      if (tickCalls >= maxPerTick) return res('cache_only:budget');
      if (slots[source] && slots[source].orphan) return res('busy_orphan');
      if (tokensLeft(source) <= 0) return res('rate_limited');
      await _enter();
      let slot = null;
      try {
        slot = await _acquireSource(source);
        if (!slot) return res('busy_orphan');
        if (signal && signal.aborted) { slot.release(); return res('skipped:aborted'); }
        if (!_take(source)) { slot.release(); return res('rate_limited'); }
        tickCalls++;
        let attempts = 0;
        let out;
        for (;;) {
          attempts++;
          const p = Promise.resolve().then(() => fn());
          const o2 = await withDeadline(p, deadlines[source] || 20000);
          out = classifyOutcome(o2);
          if (o2.timedOut) {
            // The orphan keeps the slot until it settles.
            slot.orphan = true;
            const s = slot;
            p.then(s.release, s.release);
            slot = null;
            break;
          }
          if (out.precall) { _refund(source); tickCalls--; }
          if (!out.retry || attempts >= 2) break;
          if (tickCalls >= maxPerTick || !_take(source)) break;
          tickCalls++;
          const ok = await _sleep(RETRY_BASE_MS + Math.floor(random() * RETRY_JITTER_MS), signal);
          if (!ok) break;
        }
        if (slot) slot.release();
        slot = null;
        const extra = { attempts, live: out.status === 'ok' };
        if (out.code) extra.code = out.code;
        if (out.status === 'ok') extra.value = out.value;
        return res(out.status, extra);
      } finally {
        if (slot) slot.release();
        _leave();
      }
    }
    return { call };
  }

  function snapshot() {
    const out = { tickCalls, tickLeft: tickLeft(), buckets: {}, inFlight: {} };
    for (const s of Object.keys(hourly)) out.buckets[s] = { left: tokensLeft(s), cap: hourly[s] };
    for (const s of Object.keys(slots)) out.inFlight[s] = slots[s].orphan ? 'orphan' : 'busy';
    return out;
  }

  return { run, beginTick, tokensLeft, tickLeft, snapshot, isOrphaned: (s) => !!(slots[s] && slots[s].orphan) };
}

module.exports = {
  createLimiter, withDeadline, classifyOutcome,
  HOURLY, DEADLINE_MS, MAX_PER_TICK, MAX_PARALLEL_PER_RUN, RETRY_BASE_MS, RETRY_JITTER_MS,
};
