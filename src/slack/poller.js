'use strict';
/**
 * slack/poller.js — Phase 4: single main-process communications poller.
 *
 * FEATURE (2026-11-01): one main-process owner for the three Slack engine
 * polls that the renderer (orcha-fab.js, in BOTH the main and bubble windows)
 * starts on setInterval today:
 *
 *   dmNotify      readDMs(20)               30 s  (first 3 s)  'slack.readDmsNotify' (main-origin only)
 *   channelWatch  pollChannelsOnce(log)     10 s  (first 4 s)  'slack.pollChannelWatch'
 *   dmAutoReply   pollDMAutoReplyOnce(log)  30 s  (first 4 s)  'slack.pollDmAutoReply'
 *
 * Scheduling ONLY. It is not a responder: it calls the existing engine entry
 * points with the same leader gate (cluster.mayRunProduction), the same
 * engine _pollLock and the same telemetry names. Each poll type has a
 * completion-chained timer (one run in flight per type; the next start is
 * the next boundary of the old setInterval grid).
 *
 * Mode = settings.comms.mainProcessPolling / FLEET_COMMS_POLLING, memoized once
 * per process by getMode() (restart to change):
 *   off    (default) today's behavior: no timers, renderer polls via IPC, and
 *          runPoll(origin:'renderer') runs exactly today's statements.
 *   shadow main runs plan-only ticks with ZERO side effects (only mayPollSlack,
 *          the engines' isPollInFlight, store.load read-only and
 *          slack_send.isAuthenticated); the renderer keeps doing the work.
 *   on     main does the real work; renderer-origin poll IPC calls get inert
 *          results (owner gate). Any start failure falls back to 'off' and
 *          broadcasts 'slack:poll-mode' {mode:'off'} so renderers resume.
 *
 * Complete flags-off delta (everything else is identical to today):
 *   - one read-only 'slack:get-poller-status' invoke per renderer window;
 *   - two new ipcRenderer.on listeners per window ('slack:poll-result',
 *     'slack:poll-mode');
 *   - one '[SlackPoller]' info line at start;
 *   - one settings read per pollChannelsOnce run via perfFlags.loadComms();
 *   - a lazy require of this module from email_triage._autoTick /
 *     runTriageForIpc (to read getMode()).
 *
 * Deliberate deviations, only in 'on':
 *   - main polls even when setup is incomplete or no window exists (today no
 *     renderer means no polls). The engines still gate on Slack auth and their
 *     own enabled flags, so no reply work happens without them.
 *   - dmNotify starts when the Slack config file exists rather than after the
 *     renderer's boot-time live auth check.
 *   - both windows receive the same 'slack:poll-result' push.
 *
 * Never eagerly requires electron or the engines (lazy, per call).
 */

const KINDS = ['dmNotify', 'channelWatch', 'dmAutoReply'];

const POLL_SPECS = Object.freeze({
  dmNotify:     Object.freeze({ intervalMs: 30000, firstDelayMs: 3000, trackName: 'slack.readDmsNotify',    stallWarnMs: 120000 }),
  channelWatch: Object.freeze({ intervalMs: 10000, firstDelayMs: 4000, trackName: 'slack.pollChannelWatch', stallWarnMs: 300000 }),
  dmAutoReply:  Object.freeze({ intervalMs: 30000, firstDelayMs: 4000, trackName: 'slack.pollDmAutoReply',  stallWarnMs: 300000 }),
});

// Returned for main-origin dmNotify when Slack is not configured. Identity
// compared in _classify, so it can never be confused with a real empty list.
const NOT_AUTHED = Object.freeze([]);

const STANDBY_RESULT_TEXT = 'standby — not the production leader';
const OWNER_SKIP_TEXT     = 'main-process poller owns polling';
const LOG_WINDOW_MS       = 5 * 60 * 1000;   // overrun / engine-error / shadow summary
const REJECT_LOG_MS       = 60 * 1000;       // renderer rejected (debug)

const _skipOpt = { skip: (r) => !!(r && r._skipped) };

// ── Default dependencies (lazy) ─────────────────────────────────────────────
// The ONE leader-gate implementation (moved from ipc/slack.js _mayPollSlack):
// cluster.mayRunProduction(), fail-open true on any error.
function _defaultMayPollSlack() {
  let cluster;
  try { cluster = require('../cluster'); } catch (_) { return true; }
  try {
    if (typeof cluster.mayRunProduction !== 'function') return true;
    return cluster.mayRunProduction();
  } catch (_) { return true; }
}

// Reads an engine's _pollLock only when the engine is already loaded (an
// engine that was never loaded cannot be polling). Never loads it.
function _cachedLockReader(rel) {
  return () => {
    try {
      const p = require.resolve(rel);
      const m = require.cache[p];
      return !!(m && m.exports && typeof m.exports.isPollInFlight === 'function' && m.exports.isPollInFlight());
    } catch (_) { return false; }
  };
}

function _defaultOwaStatus() {
  try {
    const p = require.resolve('../scrapers/email_triage');
    const m = require.cache[p];
    if (!m || !m.exports || typeof m.exports.getAutoScanStatus !== 'function') return null;
    return m.exports.getAutoScanStatus();
  } catch (_) { return null; }
}

// Phase 4b: speed-up stats for getStatus(). Never loads a module; each part is
// null when that module is absent or its getter throws.
function _cachedExport(rel, fn) {
  try {
    const m = require.cache[require.resolve(rel)];
    return (m && m.exports && typeof m.exports[fn] === 'function') ? m.exports[fn]() : null;
  } catch (_) { return null; }
}
function _defaultSpeedupStats() {
  return {
    lane:    _cachedExport('../scrapers/slack_send', 'getLaneStats'),
    dm:      _cachedExport('../scrapers/slack_dm_autoreply', 'getSpeedupStats'),
    channel: _cachedExport('../scrapers/slack_channel_watch', 'getSpeedupStats'),
  };
}

function _newPollState(kind) {
  return {
    intervalMs: POLL_SPECS[kind].intervalMs,
    inFlight: false, stalled: false,
    lastStartAt: null, lastEndAt: null, lastDurationMs: null, nextRunAt: null,
    runs: 0, fails: 0, lastError: null, lastResult: null,
    skipped: { coalesced: 0, busy: 0, standby: 0, notAuthed: 0 },
    shadow: { wouldRun: 0, wouldSkip: { busy: 0, standby: 0, disabled: 0, notAuthed: 0 }, errors: 0, enabled: null },
    renderer: { calls: 0, rejected: 0, lastAt: null },
    // internal (not in getStatus)
    _timer: null, _watchdog: null,
    _consecFails: 0, _errLog: null,
    _overrun: { at: null, suppressed: 0 },
    _rejectLogAt: null, _standby: null,
    _shadowDecision: null, _shadowSummaryAt: null, _shadowErrAt: null,
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────
function createPoller(deps = {}) {
  const setTimeoutFn   = deps.setTimeout   || setTimeout;
  const clearTimeoutFn = deps.clearTimeout || clearTimeout;
  const now            = deps.now          || (() => Date.now());
  const loadFlags      = deps.loadFlags    || (() => require('../config/perf-flags').loadComms());
  const mayPollSlack   = deps.mayPollSlack || _defaultMayPollSlack;
  const track          = deps.track        || ((name, fn, opts) => require('../telemetry').track(name, fn, opts));
  const engines        = Object.assign({
    channelWatch: (log) => require('../scrapers/slack_channel_watch').pollChannelsOnce(log),
    dmAutoReply:  (log) => require('../scrapers/slack_dm_autoreply').pollDMAutoReplyOnce(log),
    dmNotify:     ()    => require('../scrapers/slack_send').readDMs(20),
  }, deps.engines || {});
  const inFlight       = Object.assign({
    channelWatch: _cachedLockReader('../scrapers/slack_channel_watch'),
    dmAutoReply:  _cachedLockReader('../scrapers/slack_dm_autoreply'),
  }, deps.inFlight || {});
  const isSlackConfigured = deps.isSlackConfigured || (() => require('../scrapers/slack_send').isAuthenticated());
  const readRaw        = deps.readRaw      || ((key) => require('../store').load(key, null));
  const logger         = deps.logger       || require('../utils/logger')('slack:poller');
  // Log fn passed INTO the engines (both origins) so every [SlackWatch]/[SlackDM]
  // line keeps today's 'ipc:slack' tag.
  const engineLog      = deps.engineLog    || (() => { const l = require('../utils/logger')('ipc:slack'); return (m) => l.info(m); })();
  const owaStatus      = deps.owaStatus    || _defaultOwaStatus;
  const speedupStats   = deps.speedupStats || _defaultSpeedupStats;

  let _effectiveMode = null;   // memoized; 'off' after a start fallback
  let _configuredMode = null;
  let _flags = null;
  let _ctx = null;
  let _stopped = false;
  let _startedAt = null;
  let _startError = null;
  const _state = {};
  for (const k of KINDS) _state[k] = _newPollState(k);

  function _safeLog(level, msg) { try { logger[level](msg); } catch (_) {} }

  // ── Mode ──
  function getMode() {
    if (_effectiveMode == null) {
      let mode = 'off';
      try {
        const f = loadFlags() || {};
        _flags = { mainProcessPolling: f.mainProcessPolling, channelWatchClaims: f.channelWatchClaims === true };
        if (['off', 'shadow', 'on'].includes(f.mainProcessPolling)) mode = f.mainProcessPolling;
      } catch (_) { mode = 'off'; }
      _configuredMode = mode;
      _effectiveMode = mode;
    }
    return _effectiveMode;
  }

  function _inert(kind) {
    if (kind === 'dmNotify') return [];
    return { repliedCount: 0, escalatedCount: 0, items: [], _skipped: true, skipped: OWNER_SKIP_TEXT };
  }

  // CHAT HEAD (2026-07-24, moved verbatim from ipc/slack.js): a DM that the AI
  // couldn't confidently auto-answer (escalated -- needs Z's own judgment)
  // pops the desktop bubble up temporarily, Messenger-chat-head style.
  // Auto-answered DMs stay silent here.
  async function _dmAutoReplyWithBubble(p, ctx) {
    const result = await p;
    if (ctx && ctx.pushBubbleNotification && result && result.items && result.items.length) {
      for (const item of result.items) {
        try {
          ctx.pushBubbleNotification({
            title:   'Slack DM: ' + (item.channelName || 'Unknown'),
            message: item.title || item.question || 'New message needs your reply',
            kind:    'slack-dm',
          });
        } catch (_) {}
      }
    }
    return result;
  }

  // ── The single execution path (IPC + main timers) ──
  // Synchronous up to the engine call, so the owner check and the engine's
  // _pollLock acquisition happen in the same JS turn.
  function runPoll(kind, opts = {}) {
    if (!POLL_SPECS[kind]) throw new Error('slack poller: unknown poll kind ' + kind);
    const origin = opts.origin === 'main' ? 'main' : 'renderer';
    const ctx = opts.ctx || (origin === 'main' ? _ctx : null);
    const mode = getMode();
    const s = _state[kind];

    // Owner gate (on only) + defense in depth for main origin.
    if (origin === 'renderer' && mode === 'on') {
      s.renderer.rejected++;
      const t = now();
      if (s._rejectLogAt == null || t - s._rejectLogAt >= REJECT_LOG_MS) {
        s._rejectLogAt = t;
        _safeLog('debug', `[SlackPoller] renderer ${kind} call rejected — main-process poller owns polling (rejected=${s.renderer.rejected})`);
      }
      return _inert(kind);
    }
    if (origin === 'main' && mode !== 'on') return _inert(kind);

    // Shadow comparison data (nothing recorded in off).
    if (origin === 'renderer' && mode === 'shadow') {
      s.renderer.calls++;
      s.renderer.lastAt = now();
    }

    switch (kind) {
      case 'dmNotify':
        if (origin === 'main') {
          if (!isSlackConfigured()) return NOT_AUTHED;
          return track(POLL_SPECS.dmNotify.trackName, () => engines.dmNotify());
        }
        return engines.dmNotify();
      case 'channelWatch':
        if (!mayPollSlack()) return { skipped: STANDBY_RESULT_TEXT };
        return track(POLL_SPECS.channelWatch.trackName, () => engines.channelWatch(engineLog), _skipOpt);
      case 'dmAutoReply':
      default: {
        if (!mayPollSlack()) return { skipped: STANDBY_RESULT_TEXT };
        const p = track(POLL_SPECS.dmAutoReply.trackName, () => engines.dmAutoReply(engineLog), _skipOpt);
        return _dmAutoReplyWithBubble(p, ctx);
      }
    }
  }

  // ── Classification (the single place main-origin counters move) ──
  function _classify(kind, r) {
    const s = _state[kind];
    if (kind === 'dmNotify') {
      if (r === NOT_AUTHED) { s.skipped.notAuthed++; return; }
      s.runs++;
      s.lastResult = { count: Array.isArray(r) ? r.length : 0 };
      return;
    }
    if (r && r._skipped) { s.skipped.busy++; return; }
    if (r && typeof r.skipped === 'string') {
      s.skipped.standby++;
      if (s._standby !== true) { s._standby = true; _safeLog('info', `[SlackPoller] ${kind} skipped — standby (not the production leader)`); }
      return;
    }
    if (s._standby === true) _safeLog('info', `[SlackPoller] ${kind} resumed — production leader`);
    s._standby = false;
    s.runs++;
    s.lastResult = {
      repliedCount: Number(r && r.repliedCount) || 0,
      escalatedCount: Number(r && r.escalatedCount) || 0,
      items: Array.isArray(r && r.items) ? r.items.length : 0,
    };
  }

  function _isActionable(kind, r) {
    if (kind === 'dmNotify') return Array.isArray(r) && r.length > 0;
    return Number(r && r.escalatedCount) > 0;
  }

  function _push(kind, r) {
    const c = _ctx;
    if (c && typeof c.send === 'function') c.send('slack:poll-result', { kind, at: now(), result: r });
  }

  // ── Rate-limited logging (§4.5) ──
  function _logEngineError(kind, e) {
    const s = _state[kind];
    const msg = (e && e.message) || String(e);
    const t = now();
    const L = s._errLog;
    if (L && L.msg === msg && t - L.at < LOG_WINDOW_MS) { L.suppressed++; return; }
    const sup = L && L.msg === msg ? L.suppressed : 0;
    _safeLog('warn', `[SlackPoller] ${kind} run failed: ${msg}` + (sup ? ` (+${sup} suppressed)` : ''));
    s._errLog = { msg, at: t, suppressed: 0 };
  }

  function _noteRecovery(kind) {
    const s = _state[kind];
    if (s._consecFails > 0) _safeLog('info', `[SlackPoller] ${kind} recovered after ${s._consecFails} failure(s)`);
    s._consecFails = 0;
    s._errLog = null;
  }

  function _logOverrun(kind, elapsed, coalesced, next) {
    const s = _state[kind];
    const t = now();
    const o = s._overrun;
    if (o.at != null && t - o.at < LOG_WINDOW_MS) { o.suppressed++; return; }
    const sup = o.suppressed;
    _safeLog('warn', `[SlackPoller] ${kind} run took ${(elapsed / 1000).toFixed(1)}s (> ${POLL_SPECS[kind].intervalMs / 1000}s interval): ` +
      `${coalesced} tick(s) coalesced, no overlap; next run in ${(next / 1000).toFixed(1)}s` + (sup ? ` (+${sup} suppressed)` : ''));
    s._overrun = { at: t, suppressed: 0 };
  }

  // ── Shadow plan: zero side effects ──
  function _shadowPlan(kind) {
    const s = _state[kind];
    try {
      let decision;
      if (kind === 'dmNotify') {
        decision = isSlackConfigured() ? 'run' : 'notAuthed';
      } else if (!mayPollSlack()) {
        decision = 'standby';
      } else if (inFlight[kind] && inFlight[kind]()) {
        decision = 'busy';
      } else {
        const cfg = readRaw(kind === 'channelWatch' ? 'slackChannelWatchConfig' : 'slackDMAutoReplyConfig');
        s.shadow.enabled = cfg == null ? 'default' : cfg.enabled !== false;
        decision = cfg && cfg.enabled === false ? 'disabled' : 'run';
      }
      if (decision === 'run') s.shadow.wouldRun++;
      else s.shadow.wouldSkip[decision]++;

      const t = now();
      if (s._shadowDecision !== decision) {
        _safeLog('info', `[SlackPoller][shadow] ${kind} ${s._shadowDecision == null ? 'first plan' : 'decision changed'}: ${decision === 'run' ? 'wouldRun' : 'wouldSkip ' + decision}`);
        s._shadowDecision = decision;
      }
      if (s._shadowSummaryAt == null) s._shadowSummaryAt = t;
      else if (t - s._shadowSummaryAt >= LOG_WINDOW_MS) {
        s._shadowSummaryAt = t;
        const w = s.shadow.wouldSkip;
        _safeLog('info', `[SlackPoller][shadow] ${kind} 5m: wouldRun=${s.shadow.wouldRun} ` +
          `wouldSkip{busy:${w.busy},standby:${w.standby},disabled:${w.disabled},notAuthed:${w.notAuthed}} ` +
          `renderer{calls:${s.renderer.calls},lastAt:${s.renderer.lastAt}}`);
      }
    } catch (e) {
      s.shadow.errors++;
      const t = now();
      if (s._shadowErrAt == null || t - s._shadowErrAt >= LOG_WINDOW_MS) {
        s._shadowErrAt = t;
        _safeLog('warn', `[SlackPoller][shadow] ${kind} plan error: ${(e && e.message) || e}`);
      }
    }
  }

  // ── Timer loop (per kind, single in-flight, completion-chained) ──
  function _schedule(kind, delay) {
    const s = _state[kind];
    s.nextRunAt = now() + delay;
    const t = setTimeoutFn(() => { _tick(kind); }, delay);
    s._timer = t;
    if (t && typeof t.unref === 'function') t.unref();
  }

  async function _tick(kind) {
    const s = _state[kind];
    const spec = POLL_SPECS[kind];
    s._timer = null;
    s.nextRunAt = null;
    let next = spec.intervalMs;   // default if anything below throws
    try {
      const mode = getMode();
      if (mode === 'off') return;     // only reachable after a start fallback
      if (s.inFlight) return;         // impossible by construction (its own finally re-arms)
      if (mode === 'shadow') { _shadowPlan(kind); return; }
      let r;
      let ok = false;
      const t0 = now();
      s.inFlight = true;
      s.lastStartAt = t0;
      const wd = setTimeoutFn(() => {
        s.stalled = true;
        _safeLog('error', `[SlackPoller] ${kind} in flight > ${spec.stallWarnMs / 1000}s — not starting another run (lock held)`);
      }, spec.stallWarnMs);
      s._watchdog = wd;
      if (wd && typeof wd.unref === 'function') wd.unref();
      try {
        r = await runPoll(kind, { origin: 'main', ctx: _ctx });
        _classify(kind, r);
        ok = true;
        _noteRecovery(kind);
      } catch (e) {
        s.fails++;
        s._consecFails++;
        s.lastError = (e && e.message) || String(e);
        _logEngineError(kind, e);
      } finally {
        if (s._watchdog) { try { clearTimeoutFn(s._watchdog); } catch (_) {} s._watchdog = null; }
        s.stalled = false;
        s.inFlight = false;
        const elapsed = now() - t0;
        s.lastDurationMs = elapsed;
        s.lastEndAt = now();
        const coalesced = Math.floor(elapsed / spec.intervalMs);
        next = spec.intervalMs - (elapsed % spec.intervalMs);   // grid-preserving
        s.skipped.coalesced += coalesced;
        if (coalesced > 0) _logOverrun(kind, elapsed, coalesced, next);
        _safeLog('debug', `[SlackPoller] ${kind} done in ${(elapsed / 1000).toFixed(1)}s`);
        if (ok && _isActionable(kind, r)) { try { _push(kind, r); } catch (_) {} }
      }
    } catch (e) {
      _safeLog('error', `[SlackPoller] ${kind} tick error: ${(e && e.message) || e}`);
    } finally {
      if (!_stopped && getMode() !== 'off' && !s.inFlight && !s._timer) _schedule(kind, next);
    }
  }

  // ── Lifecycle ──
  function stop() {
    _stopped = true;
    for (const k of KINDS) {
      const s = _state[k];
      if (s._timer) { try { clearTimeoutFn(s._timer); } catch (_) {} s._timer = null; }
      if (s._watchdog) { try { clearTimeoutFn(s._watchdog); } catch (_) {} s._watchdog = null; }
      s.nextRunAt = null;
    }
  }

  function _fallbackOff(msg, ctxArg) {
    try { stop(); } catch (_) {}
    _effectiveMode = 'off';
    _startError = msg;
    _safeLog('error', '[SlackPoller] start failed — falling back to renderer polling: ' + msg);
    const c = _ctx || ctxArg;
    try { if (c && typeof c.send === 'function') c.send('slack:poll-mode', { mode: 'off' }); } catch (_) {}
    return { started: false, mode: 'off', error: msg };
  }

  function start(ctx) {
    if (ctx) _ctx = ctx;
    const mode = getMode();
    if (mode === 'off') {
      _safeLog('info', '[SlackPoller] mode=off — renderer polling unchanged');
      return { started: false, mode: 'off' };
    }
    // [FIX 1] Everything after the off check sits in ONE try: any throw falls
    // back to 'off' so Slack is never left unpolled.
    try {
      _stopped = false;
      _startError = null;
      _startedAt = now();
      for (const k of KINDS) _schedule(k, POLL_SPECS[k].firstDelayMs);
      logger.info(`[SlackPoller] started mode=${mode}`);
      return { started: true, mode };
    } catch (e) {
      return _fallbackOff((e && e.message) || String(e), ctx);
    }
  }

  // Same fallback as a failed start; idempotent (no-op + no push when off).
  function forceOff(reason, ctxArg) {
    if (getMode() === 'off') return { started: false, mode: 'off' };
    return _fallbackOff(String(reason || 'forced off'), ctxArg);
  }

  // 'on'-only re-phase of a pending channel timer after a config save.
  function onConfigUpdated(type) {
    if (type !== 'channel-watch') return;
    if (getMode() !== 'on' || _stopped) return;
    const s = _state.channelWatch;
    if (s.inFlight || !s._timer) return;
    try { clearTimeoutFn(s._timer); } catch (_) {}
    s._timer = null;
    _schedule('channelWatch', POLL_SPECS.channelWatch.intervalMs);
  }

  // ── Status (§4.6) ──
  function _pollStatus(kind) {
    const s = _state[kind];
    return {
      intervalMs: s.intervalMs, inFlight: s.inFlight, stalled: s.stalled,
      lastStartAt: s.lastStartAt, lastEndAt: s.lastEndAt, lastDurationMs: s.lastDurationMs, nextRunAt: s.nextRunAt,
      runs: s.runs, fails: s.fails, lastError: s.lastError,
      lastResult: s.lastResult ? Object.assign({}, s.lastResult) : null,
      skipped: Object.assign({}, s.skipped),
      shadow: {
        wouldRun: s.shadow.wouldRun, wouldSkip: Object.assign({}, s.shadow.wouldSkip),
        errors: s.shadow.errors, enabled: s.shadow.enabled,
      },
      renderer: Object.assign({}, s.renderer),
    };
  }

  function getStatus() {
    const mode = getMode();
    let owa = null;
    try { owa = owaStatus(); } catch (_) { owa = null; }
    const polls = {};
    for (const k of KINDS) polls[k] = _pollStatus(k);
    return {
      mode,
      configuredMode: _configuredMode,
      startedAt: _startedAt,
      startError: _startError,
      flags: {
        mainProcessPolling: _configuredMode,
        channelWatchClaims: !!(_flags && _flags.channelWatchClaims),
      },
      polls,
      owaTriage: owa == null ? null : owa,
      speedup: (() => { try { return speedupStats(); } catch (_) { return null; } })(),
    };
  }

  return {
    mayPollSlack, getMode, start, stop, forceOff, runPoll, onConfigUpdated, getStatus,
    // test hooks
    _tickForTests: (kind) => _tick(kind),
    _shadowPlanForTests: (kind) => _shadowPlan(kind),
  };
}

// ── Lazy default singleton (real deps) ──────────────────────────────────────
let _default = null;
function _get() {
  if (!_default) _default = createPoller({});
  return _default;
}

function _resetForTests() {
  if (_default) { try { _default.stop(); } catch (_) {} }
  _default = null;
}

module.exports = {
  createPoller, POLL_SPECS, NOT_AUTHED,
  mayPollSlack:    ()           => _get().mayPollSlack(),
  getMode:         ()           => _get().getMode(),
  start:           (ctx)        => _get().start(ctx),
  stop:            ()           => _get().stop(),
  forceOff:        (reason, c)  => _get().forceOff(reason, c),
  runPoll:         (kind, opts) => _get().runPoll(kind, opts),
  onConfigUpdated: (type)       => _get().onConfigUpdated(type),
  getStatus:       ()           => _get().getStatus(),
  _resetForTests,
};
