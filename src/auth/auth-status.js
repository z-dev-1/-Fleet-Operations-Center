'use strict';
/**
 * src/auth/auth-status.js — pure Midway/AAP auth status model (auth.propagation).
 *
 * deriveStatus(input) -> AuthStatus. No Electron, no I/O, no cookie values.
 * The supervisor (src/auth/midway-health-supervisor.js getStatus()) is the
 * only producer of `input`; every consumer reads the derived object.
 *
 * AuthStatus {
 *   v: 1, seq, at,
 *   state,                             // supervisor STATE, authoritative
 *   level: 'ok'|'busy'|'warn'|'down'|'unknown',
 *   ok: true|false|null,               // true for ok, false for warn/down, null for busy/unknown
 *   action: 'none'|'wait'|'mwinit',
 *   stepUp, failClass, message,
 *   verifiedAt, verifiedBy, lastApiOkAt, lastApiFailAt, nextRetryAt, retryStreak,
 *   evidence: { sessionMin, diskAeaMin, liveAeaMin, aeaCountToMidway, online, at },
 * }
 *
 * Messages are fixed strings (testable) and never recommend `--refresh-aea`
 * or `-f`: that remedy cannot satisfy a Midway step-up.
 */

const STEP_UP_MWINIT_WINDOW_MS = 30 * 60 * 1000;

const MSG = {
  HEALTHY: 'Midway session verified',
  UNKNOWN: 'Verifying Midway session...',
  RECOVERING: 'Recovering Midway session...',
  DEGRADED: 'AAP rejected the session. Re-checking.',
  COOLDOWN: 'AAP is still rejecting the session. Retrying automatically.',
  STEP_UP: 'Midway is asking for a full sign-in. Run mwinit (Ctrl+M). Retrying automatically; this sometimes clears on its own.',
  STEP_UP_AFTER_MWINIT: 'Full sign-in completed; Midway is still rejecting. Retrying automatically.',
  WAITING_FOR_USER: 'Midway session expired. Finish mwinit in the terminal (Ctrl+M starts it).',
  OFFLINE: 'Offline. Will re-verify when the connection returns.',
  FAILED: 'Midway auth failed. Run mwinit (Ctrl+M).',
};

const STEP_UP_STATES = ['COOLDOWN', 'DEGRADED', 'RECOVERING'];

function _ms(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  return null;
}
function _iso(v) { const t = _ms(v); return t == null ? null : new Date(t).toISOString(); }
function _num(v) { return (typeof v === 'number' && Number.isFinite(v) && v >= -1e6 && v <= 1e6) ? v : null; }

function _row(state, stepUp, afterMwinit) {
  if (stepUp && STEP_UP_STATES.includes(state)) {
    return afterMwinit
      ? { level: 'warn', action: 'wait', message: MSG.STEP_UP_AFTER_MWINIT }
      : { level: 'warn', action: 'mwinit', message: MSG.STEP_UP };
  }
  switch (state) {
    case 'HEALTHY': return { level: 'ok', action: 'none', message: MSG.HEALTHY };
    case 'RECOVERING': return { level: 'busy', action: 'wait', message: MSG.RECOVERING };
    case 'DEGRADED': return { level: 'warn', action: 'wait', message: MSG.DEGRADED };
    case 'COOLDOWN': return { level: 'warn', action: 'wait', message: MSG.COOLDOWN };
    case 'WAITING_FOR_USER': return { level: 'down', action: 'mwinit', message: MSG.WAITING_FOR_USER };
    case 'OFFLINE': return { level: 'warn', action: 'wait', message: MSG.OFFLINE };
    case 'FAILED': return { level: 'down', action: 'mwinit', message: MSG.FAILED };
    default: return { level: 'unknown', action: 'wait', message: MSG.UNKNOWN };
  }
}

/**
 * deriveStatus(input) -> AuthStatus
 * input: { state, stepUp, stepUpMwinitAt, now, seq, failClass, verifiedAt,
 *          verifiedBy, lastApiOkAt, lastApiFailAt, nextRetryAt, retryStreak, evidence }
 * Times may be ms epoch, ISO strings or Dates; non-finite -> null.
 */
function deriveStatus(input) {
  const i = (input && typeof input === 'object') ? input : {};
  const now = _ms(i.now) != null ? _ms(i.now) : Date.now();
  const state = typeof i.state === 'string' && i.state ? i.state : 'UNKNOWN';
  const stepUp = i.stepUp === true && STEP_UP_STATES.includes(state);
  const mwAt = _ms(i.stepUpMwinitAt);
  const afterMwinit = stepUp && mwAt != null && now >= mwAt && (now - mwAt) < STEP_UP_MWINIT_WINDOW_MS;
  const row = _row(state, stepUp, afterMwinit);
  const ev = (i.evidence && typeof i.evidence === 'object') ? i.evidence : {};
  return {
    v: 1,
    seq: (typeof i.seq === 'number' && Number.isFinite(i.seq)) ? i.seq : 0,
    at: new Date(now).toISOString(),
    state,
    level: row.level,
    ok: row.level === 'ok' ? true : (row.level === 'warn' || row.level === 'down') ? false : null,
    action: row.action,
    stepUp,
    failClass: stepUp ? 'STEP_UP_REQUIRED' : (typeof i.failClass === 'string' ? i.failClass : null),
    message: row.message,
    verifiedAt: _iso(i.verifiedAt),
    verifiedBy: typeof i.verifiedBy === 'string' ? i.verifiedBy : null,
    lastApiOkAt: _iso(i.lastApiOkAt),
    lastApiFailAt: _iso(i.lastApiFailAt),
    nextRetryAt: _iso(i.nextRetryAt),
    retryStreak: (typeof i.retryStreak === 'number' && Number.isFinite(i.retryStreak)) ? i.retryStreak : 0,
    evidence: {
      sessionMin: _num(ev.sessionMin),
      diskAeaMin: _num(ev.diskAeaMin),
      liveAeaMin: _num(ev.liveAeaMin),
      aeaCountToMidway: _num(ev.aeaCountToMidway),
      online: typeof ev.online === 'boolean' ? ev.online : null,
      at: _iso(ev.at),
    },
  };
}

module.exports = { deriveStatus, MSG, STEP_UP_MWINIT_WINDOW_MS, STEP_UP_STATES };
