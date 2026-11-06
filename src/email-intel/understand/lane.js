'use strict';
/**
 * email-intel/understand/lane.js — the ONLY way email-intel talks to an AI (design 1.6; R7.7, F-16,
 * F-17, F2-04, F2-06).
 *
 *   askIsolated(prompt, { trigger, signal, timeoutMs }) -> { ok:true, text } | { ok:false, kind:'lane', error }
 *   priorityFor(trigger)        'normal' for manual (chat counts as manual), 'low' for scheduled
 *   beginScan({ now })          lane pre-check for a scan: relay.isolatedLaneAvailable(); false => 'unavailable'
 *   recordSuccess() / recordLaneFailure() -> { tripped }
 *   probeLane({ now })          manual P-LANE probe (never automatic)
 *   state()                     { state:'unknown'|'ok'|'unavailable'|'degraded', checkedAt, consecutiveFails }
 *
 * Every call is relay.askWithTimeout(prompt, { isolated:true, source:'email_intel', priority, timeoutMs,
 * signal }): the tool-less isolated Claude lane. There is NO fallback to the normal (tool-enabled)
 * lane: when the isolated lane fails, the caller gets kind:'lane' and fails closed (deterministic
 * analysis, nothing auto-applied). Error strings never carry model text.
 *
 * Health (F-16): LANE_FAILS_TRIP consecutive lane failures in one scan set 'degraded' and the AI queue
 * stops for the rest of the scan; a success sets 'ok'.
 *
 * F2-06 warm-process lane-switch cost: isolated and normal calls do not share warm Claude processes
 * (relay's warm-process guard respawns a worker whose process belongs to the other lane), so the first
 * email-intel call of a scan and the first interactive call after it may each pay a process start.
 * That is why the AI queue keeps a scan's calls back to back (concurrency 1, no interleaving) instead
 * of spreading them over the scan.
 */
const C = require('../constants');

let _relay = null;
let _lane = { state: 'unknown', checkedAt: null, consecutiveFails: 0 };

function relay() {
  if (!_relay) _relay = require('../../orcha/relay');
  return _relay;
}

function priorityFor(trigger) { return trigger === 'manual' ? 'normal' : 'low'; }

function state() { return Object.assign({}, _lane); }

function _set(s, now) { _lane.state = s; _lane.checkedAt = new Date(Number.isFinite(now) ? now : Date.now()).toISOString(); }

/** Scan pre-check. Returns true when AI calls may be made this scan. */
function beginScan(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  _lane.consecutiveFails = 0;
  let ok = false;
  try { ok = relay().isolatedLaneAvailable() === true; } catch (_) { ok = false; }
  if (!ok) { _set('unavailable', now); return false; }
  if (_lane.state === 'unavailable' || _lane.state === 'degraded') _lane.state = 'unknown';   // a new scan may try again
  return true;
}

function recordSuccess(now) { _lane.consecutiveFails = 0; _set('ok', now); }

function recordLaneFailure(now) {
  _lane.consecutiveFails++;
  if (_lane.consecutiveFails >= C.LANE_FAILS_TRIP) { _set('degraded', now); return { tripped: true }; }
  return { tripped: false };
}

/** askIsolated: one isolated-lane call. Classifies every failure as kind 'lane'; output checks are the caller's. */
async function askIsolated(prompt, opts) {
  const o = opts || {};
  if (o.signal && o.signal.aborted) return { ok: false, kind: 'lane', error: 'aborted' };
  let r;
  try { r = relay(); } catch (_) { return { ok: false, kind: 'lane', error: 'relay-unavailable' }; }
  try {
    if (typeof r.isolatedLaneAvailable === 'function' && r.isolatedLaneAvailable() !== true) return { ok: false, kind: 'lane', error: 'lane-unavailable' };
  } catch (_) { return { ok: false, kind: 'lane', error: 'lane-unavailable' }; }
  let text;
  try {
    text = await r.askWithTimeout(prompt, {
      isolated: true, source: 'email_intel', priority: priorityFor(o.trigger),
      timeoutMs: Number.isFinite(o.timeoutMs) ? o.timeoutMs : C.AI_CALL_TIMEOUT_MS, signal: o.signal,
    });
  } catch (e) {
    const timeout = !!(e && (e.code === 'AI_TIMEOUT' || /timed? ?out/i.test(String(e.message || ''))));
    return { ok: false, kind: 'lane', error: timeout ? 'timeout' : (o.signal && o.signal.aborted ? 'aborted' : 'threw') };
  }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, kind: 'lane', error: 'empty' };
  return { ok: true, text };
}

/** P-LANE: manual probe only (emailIntel:probe-lane). Updates the lane state. */
async function probeLane(opts) {
  const now = opts && Number.isFinite(opts.now) ? opts.now : Date.now();
  let available = false;
  try { available = relay().isolatedLaneAvailable() === true; } catch (_) { available = false; }
  if (!available) { _set('unavailable', now); return { ok: false, state: 'unavailable', checkedAt: _lane.checkedAt }; }
  const r = await askIsolated('Reply with exactly {"ok":true}', { trigger: 'manual', timeoutMs: 30_000 });
  let good = false;
  if (r.ok) {
    try { good = !!require('../../orcha/reason').parseJson(r.text); } catch (_) { good = false; }
  }
  if (good) { _lane.consecutiveFails = 0; _set('ok', now); } else _set('unavailable', now);
  return { ok: good, state: _lane.state, checkedAt: _lane.checkedAt, error: good ? undefined : (r.ok ? 'bad-output' : r.error) };
}

function _setRelayForTests(r) { _relay = r || null; }
function _resetForTests() { _relay = null; _lane = { state: 'unknown', checkedAt: null, consecutiveFails: 0 }; }

/** F-17 status: relay.queueStats().flags (priorities, abortOnTimeout, dedupe, routerDecides), read-only, or null. */
function gatewayFlags() {
  try {
    const r = relay();
    const q = typeof r.queueStats === 'function' ? r.queueStats() : null;
    const g = q && q.flags && typeof q.flags === 'object' ? q.flags : null;
    if (!g) return null;
    return { priorities: !!g.priorities, abortOnTimeout: !!g.abortOnTimeout, dedupe: !!g.dedupe, routerDecides: !!g.routerDecides };
  } catch (_) { return null; }
}
module.exports = { askIsolated, priorityFor, beginScan, recordSuccess, recordLaneFailure, probeLane, state, gatewayFlags, _setRelayForTests, _resetForTests };
