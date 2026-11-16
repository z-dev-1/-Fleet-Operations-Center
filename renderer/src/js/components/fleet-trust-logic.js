/**
 * fleet-trust-logic.js — Pure logic for the toolbar trust indicators
 * (fleet-data freshness chip, auth badge, step-up banner).
 *
 * NO DOM, NO bus, NO bridge imports — unit-testable under vitest's node
 * environment (precedent: status-bar-logic.js). fleet-trust-indicator.js wires
 * these to the DOM + event bus.
 *
 * Freshness levels mirror src/health/fleet-freshness.js evaluate() (plan.md D2)
 * and are recomputed here with the renderer's clock so the chip ages between
 * main-process pushes. tests/fleet-trust-freshness-dom.test.js holds the parity
 * table against the main-process module.
 */

export const INFLIGHT_AMBER_MS = 5 * 60 * 1000;
export const INFLIGHT_RED_MS = 10 * 60 * 1000;      // = API_LOAD_MAX_AGE_MS (src/window/api-load-guard.js)
export const AMBER_AGE_FACTOR = 2;
export const RED_AGE_FACTOR = 3;
export const AAP_TIMEOUT_STREAK_RED = 3;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // = DEFAULTS.SYNC_INTERVAL_MS
export const AUTH_BANNER_MIN_STREAK = 3;

/** HTML-escape text before rendering. */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Coerce epoch ms / ISO string / Date to epoch ms, or null. */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) { const t = v.getTime(); return Number.isFinite(t) ? t : null; }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
}

/** Local 24h 'HH:MM', or '' for a missing time. */
export function fmtHHMM(ms) {
  const t = toMs(ms);
  if (t == null) return '';
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function _mins(ms) { return Math.max(0, Math.floor((ms || 0) / 60000)); }

/**
 * levelFor(snapshot, now) -> { level, reasons, ageMs, inFlightMs, intervalMs }
 * Same rules, order and reason codes as fleet-freshness.js evaluate().
 */
export function levelFor(snapshot, now) {
  const s = (snapshot && typeof snapshot === 'object') ? snapshot : null;
  const t = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  if (!s) return { level: 'grey', reasons: ['no-success-yet'], ageMs: null, inFlightMs: 0, intervalMs: DEFAULT_INTERVAL_MS };
  const intervalMs = (typeof s.intervalMs === 'number' && Number.isFinite(s.intervalMs) && s.intervalMs > 0) ? s.intervalMs : DEFAULT_INTERVAL_MS;
  const lastOkAt = toMs(s.lastOkAt);
  const lastSupersededAt = toMs(s.lastSupersededAt);
  const lastFailAt = toMs(s.lastFailAt);
  const startedAt = toMs(s.buildStartedAt);
  const inFlight = !!s.buildInFlight;
  const ageMs = lastOkAt != null ? Math.max(0, t - lastOkAt) : null;
  const inFlightMs = inFlight && startedAt != null ? Math.max(0, t - startedAt) : 0;
  const streak = s.aap && typeof s.aap.consecutiveTimeouts === 'number' ? s.aap.consecutiveTimeouts : 0;

  const red = [];
  if (ageMs != null && ageMs > RED_AGE_FACTOR * intervalMs) red.push('age>3x');
  if (lastSupersededAt != null && lastSupersededAt > (lastOkAt || 0)) red.push('superseded');
  if (inFlight && inFlightMs >= INFLIGHT_RED_MS) red.push('wedged');
  if (streak >= AAP_TIMEOUT_STREAK_RED) red.push('aap-timeouts');

  let level;
  let reasons;
  if (red.length) {
    level = 'red'; reasons = red;
  } else {
    const amber = [];
    if (ageMs != null && ageMs > AMBER_AGE_FACTOR * intervalMs) amber.push('age>2x');
    if (inFlight && inFlightMs > INFLIGHT_AMBER_MS) amber.push('in-flight>5m');
    if (amber.length) {
      level = 'amber'; reasons = amber;
    } else if (lastOkAt == null) {
      level = 'grey'; reasons = ['no-success-yet'];
    } else {
      level = 'green'; reasons = [];
      if (ageMs >= intervalMs) reasons.push('aging');
    }
  }
  if (lastFailAt != null && lastFailAt > (lastOkAt || 0)) reasons.push('last-build-failed');
  return { level, reasons, ageMs, inFlightMs, intervalMs };
}

function _reasonText(code, s, ev) {
  switch (code) {
    case 'age>3x': return 'last good refresh ' + _mins(ev.ageMs) + ' min ago (over 3× the interval)';
    case 'age>2x': return 'last good refresh ' + _mins(ev.ageMs) + ' min ago (over 2× the interval)';
    case 'aging': return 'older than the refresh interval';
    case 'superseded': return 'build superseded by watchdog';
    case 'wedged':
    case 'in-flight>5m': return 'build in flight ' + _mins(ev.inFlightMs) + ' min';
    case 'aap-timeouts': return 'AAP calls timing out (' + ((s.aap && s.aap.consecutiveTimeouts) || 0) + ' in a row)';
    case 'no-success-yet': return 'no successful refresh yet';
    case 'last-build-failed': {
      const at = fmtHHMM(s.lastFailAt);
      return 'last refresh failed' + (at ? ' ' + at : '') + (s.lastFailCode ? ': ' + s.lastFailCode : '');
    }
    default: return String(code);
  }
}

/**
 * deriveFreshness(payload, { now }) -> { level, text, title, reasons }
 * payload = { snapshot, evaluation } (fleet:get-freshness / fleet:freshness) or null.
 */
export function deriveFreshness(payload, opts) {
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const s = payload && typeof payload === 'object' && payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot : null;
  if (!s) {
    return { level: 'grey', text: 'Fleet data: waiting for first refresh', title: 'No fleet refresh recorded yet\nClick to refresh', reasons: ['no-success-yet'] };
  }
  const ev = levelFor(s, now);
  const lastOk = fmtHHMM(s.lastOkAt);
  const mins = _mins(ev.ageMs);
  let text;
  if (ev.level === 'green') text = 'Fleet data as of ' + lastOk + ' (' + mins + ' min old)';
  else if (ev.level === 'amber') text = ev.ageMs != null ? 'Fleet data may be stale (' + mins + ' min old)' : 'Fleet data may be stale (no good refresh yet)';
  else if (ev.level === 'red') text = lastOk ? 'STALE — last good ' + lastOk : 'STALE — no good refresh yet';
  else text = 'Fleet data: waiting for first refresh';

  const lines = [];
  if (lastOk) lines.push('Last good refresh ' + lastOk + (typeof s.lastOkCount === 'number' ? ' (' + s.lastOkCount + ' units)' : ''));
  for (const r of ev.reasons) lines.push(_reasonText(r, s, ev));
  lines.push('Refresh interval ' + _mins(ev.intervalMs) + ' min');
  lines.push('Click to refresh');
  return { level: ev.level, text, title: lines.join('\n'), reasons: ev.reasons.slice() };
}

/** Inner HTML for the freshness chip. */
export function renderFreshnessHtml(view) {
  const v = view || {};
  return '<span class="tb-fresh__dot"></span><span class="tb-fresh__text">' + esc(v.text || '') + '</span>';
}

const _STATE_KEY = {
  HEALTHY: 'HEALTHY',
  COOLDOWN: 'COOLDOWN',
  DEGRADED: 'COOLDOWN',
  RECOVERING: 'COOLDOWN',
  OFFLINE: 'OFFLINE',
  WAITING_FOR_USER: 'STEP-UP NEEDED',
  FAILED: 'STEP-UP NEEDED',
};
const _KEY_LEVEL = { HEALTHY: 'green', COOLDOWN: 'amber', OFFLINE: 'amber', 'STEP-UP NEEDED': 'red', CHECKING: 'grey' };

function _authState(status, health) {
  if (status && typeof status === 'object') return typeof status.state === 'string' ? status.state : null;
  if (health && typeof health === 'object' && typeof health.state === 'string') return health.state;
  return null;
}

/**
 * deriveAuthBadge(status, health, { now }) -> { key, level, text, title }
 * status = AuthStatus (src/auth/auth-status.js) or null (auth.propagation off);
 * health = auth-health:get result ({ state, snapshot }) for the flag-off fallback.
 */
export function deriveAuthBadge(status, health, opts) { // eslint-disable-line no-unused-vars
  const st = (status && typeof status === 'object') ? status : null;
  const state = _authState(st, health);
  let key;
  if (st && (st.stepUp === true || st.action === 'mwinit')) key = 'STEP-UP NEEDED';
  else if (st && st.level === 'ok') key = 'HEALTHY';
  else key = _STATE_KEY[state] || 'CHECKING';

  const verifiedAt = st ? toMs(st.verifiedAt) : null;
  const text = key === 'HEALTHY' && verifiedAt != null
    ? 'Auth HEALTHY · verified ' + fmtHHMM(verifiedAt)
    : 'Auth ' + key;

  const lines = [];
  if (st && st.message) lines.push(String(st.message));
  if (state) lines.push('State: ' + state);
  if (verifiedAt != null) lines.push('Last verified ' + fmtHHMM(verifiedAt));
  if (st && typeof st.retryStreak === 'number' && st.retryStreak > 0) lines.push('Silent retries failed: ' + st.retryStreak);
  if (st && toMs(st.nextRetryAt) != null) lines.push('Next retry ' + fmtHHMM(st.nextRetryAt));
  if (key === 'STEP-UP NEEDED') lines.push('Run mwinit (Ctrl+M)');
  return { key, level: _KEY_LEVEL[key], text, title: lines.join('\n') || 'Checking Midway/AAP auth…' };
}

/**
 * deriveStepUpBanner(status, health) -> { show, reason, causes[] }
 * Shown for STEP-UP NEEDED, or COOLDOWN/DEGRADED after >= AUTH_BANNER_MIN_STREAK
 * failed silent retries.
 */
export function deriveStepUpBanner(status, health) {
  const st = (status && typeof status === 'object') ? status : null;
  const h = (health && typeof health === 'object') ? health : null;
  const badge = deriveAuthBadge(st, h);
  const state = _authState(st, h);
  const streak = st && typeof st.retryStreak === 'number' ? st.retryStreak : 0;
  const streakCase = (state === 'COOLDOWN' || state === 'DEGRADED') && streak >= AUTH_BANNER_MIN_STREAK;
  const show = badge.key === 'STEP-UP NEEDED' || streakCase;

  let reason = '';
  if (show) {
    if (st && st.stepUp === true) reason = 'AAP session needs re-sign-in (Midway step-up)';
    else if (state === 'WAITING_FOR_USER') reason = 'Midway session expired — finish mwinit';
    else if (state === 'FAILED') reason = 'Midway auth failed';
    else if (streakCase) reason = 'AAP keeps rejecting the session (' + streak + ' silent retries failed)';
    else reason = 'Midway sign-in needed';
  }

  const causes = [];
  const snap = h && h.snapshot && typeof h.snapshot === 'object' ? h.snapshot : null;
  const vpn = snap && snap.vpn;
  if (vpn && vpn.connected === false && vpn.status && vpn.status !== 'not-installed') {
    causes.push('VPN disconnected (' + vpn.status + ')');
  }
  const evd = st && st.evidence && typeof st.evidence === 'object' ? st.evidence : null;
  if ((evd && evd.online === false) || (snap && snap.internet && snap.internet.online === false)) causes.push('Offline');
  if (evd && typeof evd.liveAeaMin === 'number' && evd.liveAeaMin <= 0) {
    causes.push('AEA cookie expired — the AEA browser extension is broken on this machine; a full mwinit restores it');
  }
  return { show, reason, causes: show ? causes : [] };
}

/** Inner HTML for the auth badge. */
export function renderAuthBadgeHtml(badge) {
  const b = badge || {};
  return '<span class="tb-auth__dot"></span><span class="tb-auth__text">' + esc(b.text || 'Auth …') + '</span>';
}

/** Inner HTML for the step-up banner ('' when hidden). opts.busy disables the button. */
export function renderBannerHtml(banner, opts) {
  const b = banner || {};
  if (!b.show) return '';
  const causes = Array.isArray(b.causes) && b.causes.length
    ? '<span class="tb-auth-banner__causes">Likely cause: ' + b.causes.map(esc).join('; ') + '</span>'
    : '';
  const busy = !!(opts && opts.busy);
  return '<span class="tb-auth-banner__reason">' + esc(b.reason || '') + '</span>' +
    causes +
    '<button type="button" class="tb-auth-banner__btn" data-action="run-mwinit"' + (busy ? ' disabled' : '') + '>Run mwinit (Ctrl+M)</button>';
}
