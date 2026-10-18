'use strict';
/**
 * cluster/mode-gate.js — backend-enforced production-side-effect gate (Stage 1).
 *
 * THREE MODES (per the dual-instance spec §5):
 *   ACTIVE       — holds the production leadership lease; production side
 *                  effects are ALLOWED (subject to leadership + local capability).
 *   STANDBY      — synchronized + displays data; performs NO production side
 *                  effects.
 *   DEVELOPMENT  — experimental/testing; production writes and automatic message
 *                  sends are BLOCKED at the service layer (not just the UI); may
 *                  read authorized production data.
 *
 * This gate is the single chokepoint every production side-effect must call
 * BEFORE acting. Enforcement lives HERE (backend), so a UI action can never
 * bypass it — satisfying the spec's "enforce in backend services, not only UI".
 *
 * SIDE-EFFECT CLASSES (so we can fail a subset closed while others fail over):
 *   'slack-send'     — posting a Slack message (production reply/notification).
 *   'fleet-mutate'   — changing a fleet record / lifecycle (AAP etc.).
 *   'email-send'     — sending email (OWA).
 *   'sp-push'        — SharePoint push.
 *   'browser'        — anything requiring a local authenticated Chromium/CDP
 *                      session (lifecycle DOM flips, SP push, OWA send, scrape).
 *                      Fails closed on any host without a local browser.
 *   'schedule-fire'  — firing a scheduled job (SP/email/DBR).
 *
 * STAGE 1 BEHAVIOR: the cluster feature flag is OFF by default, so getMode()
 * returns 'ACTIVE' and assertCanSideEffect() permits everything — i.e. the app
 * behaves EXACTLY as it does today. The gate only starts denying once the
 * feature is enabled and a real role/capability is set by the leadership mgr.
 */

let logger; try { logger = require('../utils/logger')('cluster-gate'); } catch (_) { logger = { info() {}, warn() {} }; }

const MODES = ['ACTIVE', 'STANDBY', 'DEVELOPMENT'];

// Which side-effect classes each mode permits in principle (before the
// per-host capability check). DEVELOPMENT permits NONE of the production
// classes. STANDBY permits none. ACTIVE permits all (capability-gated below).
const MODE_ALLOWS = {
  ACTIVE:      new Set(['slack-send', 'fleet-mutate', 'email-send', 'sp-push', 'browser', 'schedule-fire']),
  STANDBY:     new Set([]),
  DEVELOPMENT: new Set([]),
};

// Mutable runtime state — set by the leadership manager. Defaults make the
// gate a no-op (ACTIVE) so the untouched single-host app is unaffected.
let _enabled = false;         // cluster feature flag (OFF = legacy behavior)
let _mode = 'ACTIVE';         // current role
let _capabilities = {         // what THIS host can physically do
  browser: true,              // local authenticated Chromium available?
};

function setEnabled(on) { _enabled = !!on; }
function isEnabled() { return _enabled; }

function setMode(mode) {
  if (!MODES.includes(mode)) { logger.warn('[cluster-gate] ignoring invalid mode: ' + mode); return _mode; }
  if (mode !== _mode) logger.info('[cluster-gate] mode ' + _mode + ' -> ' + mode);
  _mode = mode;
  return _mode;
}
function getMode() { return _enabled ? _mode : 'ACTIVE'; }

// Declare host capabilities (e.g. a headless Dev Space sets browser:false).
function setCapabilities(caps) { _capabilities = { ..._capabilities, ...(caps || {}) }; }
function getCapabilities() { return { ..._capabilities }; }

/**
 * canSideEffect(kind) -> { ok:boolean, reason:string }
 * Pure predicate: may THIS instance, in its current mode + capability set,
 * perform a production side-effect of class `kind`? Never throws.
 */
function canSideEffect(kind) {
  if (!_enabled) return { ok: true, reason: 'cluster-disabled (legacy single-host)' };
  const mode = getMode();
  const allowed = MODE_ALLOWS[mode] || MODE_ALLOWS.STANDBY;
  if (!allowed.has(kind)) {
    return { ok: false, reason: 'mode ' + mode + ' does not permit "' + kind + '"' };
  }
  // Capability gate: browser-bound classes require a local browser. On a
  // headless host these FAIL CLOSED (never faked, never double-run elsewhere).
  const needsBrowser = kind === 'browser' || kind === 'fleet-mutate' || kind === 'sp-push' || kind === 'email-send';
  if (needsBrowser && !_capabilities.browser) {
    return { ok: false, reason: '"' + kind + '" requires a local browser which this host lacks (headless) — failing closed' };
  }
  return { ok: true, reason: 'permitted in ' + mode };
}

/**
 * assertCanSideEffect(kind) — throws a typed error when not permitted. Call
 * this at the top of every production side-effect path. In Stage 1 (flag OFF)
 * it never throws.
 */
function assertCanSideEffect(kind) {
  const r = canSideEffect(kind);
  if (!r.ok) {
    const err = new Error('[cluster-gate] blocked side-effect "' + kind + '": ' + r.reason);
    err.code = 'CLUSTER_SIDE_EFFECT_BLOCKED';
    err.kind = kind;
    err.mode = getMode();
    throw err;
  }
  return true;
}

// Test/reset hook.
function _reset() { _enabled = false; _mode = 'ACTIVE'; _capabilities = { browser: true }; }

module.exports = {
  MODES, setEnabled, isEnabled, setMode, getMode,
  setCapabilities, getCapabilities, canSideEffect, assertCanSideEffect, _reset,
};
