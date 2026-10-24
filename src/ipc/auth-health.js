'use strict';
/**
 * ipc/auth-health.js — Midway/AAP auth health panel backend (Phase E).
 *
 * Exposes the single auth supervisor's live state to the renderer so the
 * Settings "Auth Health" panel can show:
 *   - current STATE (HEALTHY / DEGRADED / WAITING_FOR_USER / COOLDOWN / ...)
 *   - whether the REAL AAP target verified (authority — not VPN, not cookies)
 *   - Midway session + AEA minutes remaining (evidence only)
 *   - "VPN not required" (vpn.required is ALWAYS false)
 *   - next auto-retry time (bounded backoff)
 *   - recovery history
 *
 * Channels:
 *   auth-health:get           → { ok, state, snapshot, history }
 *   auth-health:retry         → force a convergence attempt now (no prompt)
 *   auth-health:run-mwinit    → escalate to interactive mwinit (prompt allowed)
 *
 * The supervisor is a process-wide singleton module, so we require it directly
 * — the same instance the window/startup paths drive.
 */

const { handle } = require('./_safe');
const logger = require('../utils/logger')('ipc:auth-health');

function _supervisor() {
  try { return require('../auth/midway-health-supervisor'); } catch (_) { return null; }
}

function registerAuthHealthIPC(ctx) {
  // Read-only snapshot of the supervisor. Never triggers recovery.
  handle('auth-health:get', async () => {
    const sup = _supervisor();
    if (!sup) return { ok: false, error: 'auth supervisor unavailable' };
    let snapshot = null;
    try { snapshot = sup.getSnapshot(); } catch (_) {}
    // If nothing has driven the supervisor yet, build a fresh read-only snapshot
    // (buildSnapshot is side-effect free — it does NOT run the ladder/prompt).
    if (!snapshot && typeof sup.buildSnapshot === 'function') {
      try { snapshot = await sup.buildSnapshot({ state: sup.getState() }); } catch (_) {}
    }
    return {
      ok: true,
      state: (typeof sup.getState === 'function') ? sup.getState() : null,
      snapshot: snapshot || null,
      history: (typeof sup.getHistory === 'function') ? sup.getHistory() : [],
    };
  });

  // Force a convergence attempt now. No interactive prompt — this is the
  // "Retry" button: silent rungs + VERIFY against the real target.
  handle('auth-health:retry', async () => {
    const sup = _supervisor();
    if (!sup || typeof sup.ensureHealthyConverging !== 'function') {
      return { ok: false, error: 'auth supervisor unavailable' };
    }
    logger.info('[auth-health] manual retry requested (no prompt)');
    const r = await sup.ensureHealthyConverging({ reason: 'ui:retry', allowPrompt: false });
    // Refresh dependent data source if we just recovered.
    try { if (r && r.ok && r.verified) require('../scrapers/aap_api').dispose(); } catch (_) {}
    return {
      ok: !!(r && r.ok && r.verified),
      state: (typeof sup.getState === 'function') ? sup.getState() : null,
      snapshot: (typeof sup.getSnapshot === 'function') ? sup.getSnapshot() : null,
      verified: !!(r && r.verified),
      reason: r && r.reason,
    };
  });

  // Escalate to interactive mwinit (user clicked "Run mwinit"). allowPrompt
  // lets the ladder reach the interactive mwinit rung (PIN + YubiKey). The
  // prompt happens in the user's own terminal / mwinit flow.
  handle('auth-health:run-mwinit', async () => {
    const sup = _supervisor();
    if (!sup || typeof sup.ensureHealthyConverging !== 'function') {
      return { ok: false, error: 'auth supervisor unavailable' };
    }
    logger.info('[auth-health] interactive mwinit requested (prompt allowed)');
    const r = await sup.ensureHealthyConverging({ reason: 'ui:run-mwinit', allowPrompt: true });
    try { if (r && r.ok && r.verified) require('../scrapers/aap_api').dispose(); } catch (_) {}
    return {
      ok: !!(r && r.ok && r.verified),
      state: (typeof sup.getState === 'function') ? sup.getState() : null,
      snapshot: (typeof sup.getSnapshot === 'function') ? sup.getSnapshot() : null,
      verified: !!(r && r.verified),
      prompted: !!(r && r.prompted),
      reason: r && r.reason,
    };
  });

  logger.info('Auth health IPC handlers registered');
}

module.exports = { registerAuthHealthIPC };
