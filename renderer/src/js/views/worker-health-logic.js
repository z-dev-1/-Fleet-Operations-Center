/**
 * worker-health-logic.js — pure helpers for the Worker Health section (Phase 6).
 *
 * No DOM, no window access: status label/class mapping, relative time, HTML
 * escaping and the visible-only poller. Unit-tested in
 * tests/worker-health-logic.test.js.
 */

export const STATUS_LABELS = {
  healthy: 'Healthy',
  busy: 'Busy',
  waiting: 'Waiting',
  auth: 'Authentication required',
  recovering: 'Recovering',
  degraded: 'Degraded',
  failed: 'Failed / Isolated',
  disabled: 'Disabled',
  unknown: 'Unknown',
};

function _st(key, reason, label) {
  return { key, label: label || STATUS_LABELS[key], reason: reason || '', cls: 'wh-st wh-st--' + key };
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function truncate(s, n = 80) {
  const str = String(s == null ? '' : s);
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + '…' : str;
}

function _toMs(ts) {
  if (ts == null || ts === '') return NaN;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') return new Date(ts).getTime();
  return NaN;
}

/** Compact duration: 12s / 3m / 2h / 1d. */
export function dur(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/** relTime(ts, now) → "5s ago" / "in 3m" / "now" / "—". Accepts ms or ISO. */
export function relTime(ts, now = Date.now()) {
  const t = _toMs(ts);
  if (!Number.isFinite(t)) return '—';
  const diff = now - t;
  if (Math.abs(diff) < 1000) return 'now';
  return diff > 0 ? dur(diff) + ' ago' : 'in ' + dur(-diff);
}

export function workerStatus(w, now = Date.now()) {
  if (!w) return _st('unknown');
  switch (w.state) {
    case 'healthy': return _st('healthy');
    case 'busy': {
      const t = w.currentJob ? _toMs(w.currentJob.startedAt) : NaN;
      return _st('busy', Number.isFinite(t) ? 'running ' + dur(Math.max(0, now - t)) : 'running');
    }
    case 'waiting': {
      const on = Array.isArray(w.waitingOn) && w.waitingOn.length ? w.waitingOn.join(', ') : '';
      return _st('waiting', on ? 'waiting on ' + on : 'waiting');
    }
    case 'degraded': {
      if (w.currentJob && w.currentJob.timedOut) return _st('degraded', 'tick timed out');
      const n = Number(w.consecutiveFailures) || 0;
      return _st('degraded', n + ' consecutive failure' + (n === 1 ? '' : 's'));
    }
    case 'isolated': {
      const budgetLeft = typeof w.restarts === 'number' && typeof w.maxRestarts === 'number' && w.restarts < w.maxRestarts;
      if (budgetLeft) return _st('recovering', 'auto-retry ' + relTime(w.isolatedUntil, now));
      return _st('failed', w.isolationReason || 'isolated');
    }
    case 'disabled':
      if (w.disabledReason === 'restart-budget-exhausted') return _st('failed', 'restart budget exhausted');
      return _st('disabled', w.disabledReason || '');
    default: return _st('unknown');
  }
}

export function authStatus(auth) {
  if (!auth || auth.status !== 'ok') return _st('unknown', auth && auth.reason ? 'unavailable — ' + auth.reason : 'unavailable');
  // auth.propagation (fields present only with the flag on): Midway step-up
  // that needs a full sign-in. After a completed full sign-in the status
  // action is 'wait' (F9) and this falls through to the state mapping.
  if (auth.stepUp === true && auth.action === 'mwinit') return _st('auth', 'sign in needed');
  switch (auth.state) {
    case 'HEALTHY': return _st('healthy');
    case 'WAITING_FOR_USER': return _st('auth', 'sign in needed');
    case 'RECOVERING': return _st('recovering');
    case 'COOLDOWN': return _st('recovering', 'cooling down');
    case 'DEGRADED': return _st('degraded');
    case 'OFFLINE': return _st('waiting', 'offline');
    case 'FAILED': return _st('failed');
    default: return _st('unknown');
  }
}

export function laneStatus(s) {
  if (s === 'up') return _st('healthy');
  if (s === 'down') return _st('failed', '', 'Failed');
  if (s === 'fallback') return _st('waiting', 'fallback only');
  return _st('unknown');
}

/** Aki lane pill from relay queueStats().akiLane.state. */
export function akiLaneStatus(s) {
  if (s === 'up') return _st('healthy');
  if (s === 'down') return _st('failed', '', 'Failed');
  if (s === 'not-found') return _st('failed', 'aki not found', 'Not found');
  return _st('unknown');
}

export function aiOverall(s) {
  if (s === 'up') return _st('healthy');
  if (s === 'degraded') return _st('degraded');
  if (s === 'down') return _st('failed', '', 'Failed');
  return _st('unknown');
}

/** Section pill for an unavailable section. */
export function unavailableStatus(section) {
  return _st('unknown', section && section.reason ? section.reason : '', 'Unavailable');
}

/**
 * Durable jobs (Phase 7) section pill. First matching rule wins:
 * unavailable → off → recovery_required → degraded → foreign rows →
 * expired lease → failed in 24h → healthy.
 */
export function jobsStatus(sec) {
  if (!sec || sec.status !== 'ok') return unavailableStatus(sec);
  if (sec.mode === 'off') return _st('disabled', 'durable jobs off');
  const n = Number(sec.recoveryRequiredCount) || 0;
  if (n > 0) return _st('failed', n + ' need reconciliation', 'Needs reconciliation');
  if (sec.mode === 'degraded') return _st('degraded', sec.reason || '');
  const tot = sec.totals || {};
  const foreign = Number(tot.foreign) || 0;
  if (foreign > 0) return _st('degraded', foreign + ' row(s) from a newer build');
  const or = sec.oldestRunning;
  if (or && or.leaseExpired) return _st('degraded', 'lease expired: ' + (or.type || ''));
  const f24 = Number(tot.failed24h) || 0;
  if (f24 > 0) return _st('degraded', f24 + ' failed in 24h');
  return _st('healthy');
}

export function canReEnable(w) {
  return !!w && (w.state === 'isolated' || (w.state === 'disabled' && w.disabledReason === 'restart-budget-exhausted'));
}

/**
 * createVisiblePoller — setTimeout chain that runs only while the view is
 * open AND the document is visible. The next fetch is armed only after the
 * previous one settles (no overlap). refreshNow() during an in-flight fetch
 * is coalesced into exactly one extra run after it settles.
 */
export function createVisiblePoller(opts) {
  const o = opts || {};
  const run = o.run;
  const isVisible = typeof o.isVisible === 'function' ? o.isVisible : () => true;
  const st = o.setTimeout || ((f, ms) => setTimeout(f, ms));
  const ct = o.clearTimeout || ((h) => clearTimeout(h));
  const intervalMs = Math.min(15000, Math.max(10000, Number(o.intervalMs) || 15000));
  let open = false;
  let stopped = false;
  let inFlight = false;
  let pending = false;
  let timer = null;

  const active = () => open && !stopped && isVisible();
  function disarm() { if (timer != null) { ct(timer); timer = null; } }
  function arm() { disarm(); if (active()) timer = st(() => { timer = null; fire(); }, intervalMs); }
  function fire() {
    if (!active()) return Promise.resolve();
    if (inFlight) { pending = true; return Promise.resolve(); }
    disarm();
    inFlight = true;
    let p;
    try { p = Promise.resolve(run()); } catch (e) { p = Promise.reject(e); }
    return p.catch(() => {}).then(() => {
      inFlight = false;
      if (pending && active()) { pending = false; return fire(); }
      pending = false;
      arm();
      return undefined;
    });
  }

  return {
    intervalMs,
    setOpen(b) {
      open = !!b;
      if (open) return fire();
      disarm(); pending = false;
      return Promise.resolve();
    },
    onVisibilityChange() {
      if (!open) return Promise.resolve();
      if (isVisible()) return fire();
      disarm();
      return Promise.resolve();
    },
    refreshNow() { return open ? fire() : Promise.resolve(); },
    stop() { stopped = true; open = false; pending = false; disarm(); },
    isArmed() { return timer != null; },
  };
}
