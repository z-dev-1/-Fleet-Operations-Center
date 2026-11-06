'use strict';
/**
 * ipc/email-intel.js — IPC surface of the Email Triage Intelligence module
 * (design section 9). Registered right after registerEmailTriageIPC.
 *
 * Phase 0 skeleton: EVERY channel is registered, and each one returns
 * { ok:true, enabled:false } and does nothing while its gate is off (the
 * auth-status:get precedent). Phases A-G replace the open-gate bodies; the
 * channel names, gates and the preload `emailIntel` bridge do not change.
 * The legacy emailTriage:* channels are untouched.
 *
 * Human proof for consequential actions: emailIntel:prepare-action mints a
 * single-use token (email-intel/confirm.js) and emailIntel:confirm-action runs
 * the registered executor only after a native main-process dialog is accepted.
 */
const { handle } = require('./_safe');
const logger = require('../utils/logger')('ipc:email-intel');
const flags = require('../email-intel/flags');
const confirm = require('../email-intel/confirm');

const TOKEN_RE = /^[0-9a-f]{32}$/;

// channel -> gate. A gate is an effective-flag name, 'timelineWrites|actionsView' (either), or null (read-only, always registered).
const GATES = Object.freeze({
  'emailIntel:status': null,
  'emailIntel:scan': 'capture',
  'emailIntel:probe-lane': 'capture',
  'emailIntel:get-config': 'capture',
  'emailIntel:set-config': 'capture',
  'emailIntel:get-actions': 'actionsView',
  'emailIntel:action-update': 'actionsView',
  'emailIntel:get-staged': 'timelineWrites|actionsView',
  'emailIntel:prepare-action': 'per-kind',
  'emailIntel:confirm-action': 'capture',
  'emailIntel:draft-thread-reply': 'threadReplies',
  'emailIntel:get-send-attempts': 'threadReplies',
  'emailIntel:reconcile-send': 'threadReplies',
  'emailIntel:dom-probe': 'capture',
  'emailIntel:set-tz-verified': 'capture',
  'emailIntel:ack-vision-notice': 'attachments',
});

// prepare-action: the effective flag each kind needs (design 9, F-19 table).
const KIND_GATES = Object.freeze({
  'send-reply': 'threadReplies',
  'delete': 'actionsView',
  'delete-batch': 'actionsView',
  'approve-staged': 'timelineWrites',
  'reject-staged': 'actionsView',
  'mark-send-resolution': 'threadReplies',
  'send-ready-dm': 'capture',
});

const OFF = () => ({ ok: true, enabled: false });
const NOT_YET = () => ({ ok: false, code: 'NOT_IMPLEMENTED', error: 'not available in this build phase' });

function effective() {
  try { return flags.get().effective || {}; } catch (_) { return {}; }
}
function gateOpen(gate) {
  if (gate == null) return true;
  const eff = effective();
  return String(gate).split('|').some((g) => eff[g] === true);
}

function registerEmailIntelIPC(_ctx) {
  // Read-only status: inert while the module is not engaged.
  handle('emailIntel:status', () => {
    if (!flags.engaged()) return OFF();
    return { ok: true, enabled: true, phase: 0, flags: effective() };
  });

  // Plain gated channels: inert closed; the open-gate body arrives with the owning phase.
  for (const channel of Object.keys(GATES)) {
    if (channel === 'emailIntel:status' || channel === 'emailIntel:prepare-action' || channel === 'emailIntel:confirm-action') continue;
    const gate = GATES[channel];
    handle(channel, () => (gateOpen(gate) ? NOT_YET() : OFF()));
  }

  handle('emailIntel:prepare-action', (_e, kind, payload) => {
    if (typeof kind !== 'string' || !confirm.KINDS.includes(kind)) {
      return gateOpen('capture') ? { ok: false, code: 'BAD_ARG', field: 'kind' } : OFF();
    }
    if (!gateOpen(KIND_GATES[kind])) return OFF();
    const r = confirm.prepare(kind, payload);
    if (!r.ok) return r;
    return { ok: true, token: r.token, summary: r.summary, expiresAt: r.expiresAt };
  });

  handle('emailIntel:confirm-action', async (e, token) => {
    if (!gateOpen('capture')) return OFF();
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { ok: false, code: 'BAD_ARG', field: 'token' };
    return confirm.confirm(token, { event: e });
  });

  logger.info('Email Intelligence IPC handlers registered (' + Object.keys(GATES).length + ' channels; inert unless flags are effective)');
}

module.exports = { registerEmailIntelIPC, GATES, KIND_GATES };
