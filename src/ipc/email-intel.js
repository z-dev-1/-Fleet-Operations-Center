'use strict';
/**
 * ipc/email-intel.js — IPC surface of the Email Triage Intelligence module
 * (design section 9). Registered right after registerEmailTriageIPC.
 *
 * EVERY channel is registered, and each one returns { ok:true, enabled:false } and does nothing
 * while its gate is off (the auth-status:get precedent). Phase A (`capture`) fills in: status, scan,
 * get-config, set-config, dom-probe, set-tz-verified and the send-ready-dm prepare/confirm executor.
 * Channels owned by later phases return { ok:false, code:'NOT_IMPLEMENTED' } when their gate is open.
 * The legacy emailTriage:* channels are untouched here.
 *
 * Human proof for consequential actions: emailIntel:prepare-action mints a single-use token
 * (email-intel/confirm.js) and emailIntel:confirm-action runs the registered executor only after a
 * native main-process dialog is accepted. Invalid arguments return { ok:false, code:'BAD_ARG', field }
 * and mint no token. Nothing here logs message content, subjects or addresses.
 */
const os = require('os');
const { handle } = require('./_safe');
const logger = require('../utils/logger')('ipc:email-intel');
const flags = require('../email-intel/flags');
const confirm = require('../email-intel/confirm');
const executors = require('../email-intel/executors');
const stores = require('../email-intel/stores');
const cfgMod = require('../email-intel/config');
const C = require('../email-intel/constants');
const { safeErr } = require('../email-intel/redact');

const TOKEN_RE = /^[0-9a-f]{32}$/;
const PROBE_RE = /^pr_[0-9a-f]{16}$/;

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

// Channels implemented by this build; everything else with an open gate is NOT_IMPLEMENTED.
const IMPLEMENTED = new Set([
  'emailIntel:status', 'emailIntel:scan', 'emailIntel:get-config', 'emailIntel:set-config', 'emailIntel:dom-probe',
  'emailIntel:set-tz-verified', 'emailIntel:prepare-action', 'emailIntel:confirm-action',
]);

const OFF = () => ({ ok: true, enabled: false });
const NOT_YET = () => ({ ok: false, code: 'NOT_IMPLEMENTED', error: 'not available in this build phase' });
const BAD = (field) => ({ ok: false, code: 'BAD_ARG', field });
const _isPlain = (o) => !!o && typeof o === 'object' && !Array.isArray(o);

function effective() {
  try { return flags.get().effective || {}; } catch (_) { return {}; }
}
function gateOpen(gate) {
  if (gate == null) return true;
  const eff = effective();
  return String(gate).split('|').some((g) => eff[g] === true);
}

function _notifyUpdated(payload) {
  try {
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('localhost:5173'));
    if (main) main.webContents.send('emailIntel:updated', payload || { kind: 'status' });
  } catch (_) { /* push only */ }
}

/** F-19: max int 1..50; folders 1..12 strings that must case-insensitively equal a configured folder name. */
function validateScan(payload, configured) {
  const p = payload == null ? {} : payload;
  if (!_isPlain(p)) return BAD('payload');
  const out = { warnings: [] };
  if (p.max !== undefined) {
    if (!Number.isInteger(p.max) || p.max < 1 || p.max > C.MAX_EMAILS_HARD) return BAD('max');
    out.max = p.max;
  }
  if (p.folders !== undefined) {
    if (!Array.isArray(p.folders) || p.folders.length < 1 || p.folders.length > C.MAILBOX_FOLDERS_MAX || p.folders.some((f) => typeof f !== 'string')) return BAD('folders');
    const byLower = new Map((configured || []).map((f) => [String(f).trim().toLowerCase(), String(f).trim()]));
    const keep = [];
    for (const f of p.folders) {
      const hit = byLower.get(String(f).trim().toLowerCase());
      if (hit) { if (!keep.includes(hit)) keep.push(hit); } else if (!out.warnings.includes('unknown-folder')) out.warnings.push('unknown-folder');
    }
    out.folders = keep.length ? keep : undefined;          // none left: the scan uses the configured list
  }
  return out;
}

function _configuredFolders() {
  const cfg = cfgMod.normalize(stores.load('config'));
  if (Array.isArray(cfg.folders) && cfg.folders.length) return cfg.folders;
  try { return require('../scrapers/email_triage').getConfig().folders || ['Inbox']; } catch (_) { return ['Inbox']; }
}

function registerEmailIntelIPC(_ctx) {
  try { executors.registerAll(); } catch (e) { logger.warn('executor registration failed ' + safeErr(e)); }

  // Read-only status: inert while the module is not engaged.
  handle('emailIntel:status', () => {
    if (!flags.engaged()) return OFF();
    return require('../email-intel').getStatus();
  });

  // Plain gated channels owned by later phases: inert closed; NOT_IMPLEMENTED when the gate is open.
  for (const channel of Object.keys(GATES)) {
    if (IMPLEMENTED.has(channel)) continue;
    const gate = GATES[channel];
    handle(channel, () => (gateOpen(gate) ? NOT_YET() : OFF()));
  }

  // Manual scan (capture). Same follow-ups as emailTriage:run: legacy fact apply + overlay push.
  handle('emailIntel:scan', async (_e, payload) => {
    if (!gateOpen('capture')) return OFF();
    const v = validateScan(payload, _configuredFolders());
    if (v.ok === false) return v;
    const intel = require('../email-intel');
    const triage = require('../scrapers/email_triage');
    const res = await intel.runIntelScan({ max: v.max, folders: v.folders }, 'manual');
    try {
      if (res && !res.authBlocked && !res.skipped && triage.getConfig().autoApplyUnitUpdates && Array.isArray(res.emails)) triage.applyPendingUnitUpdates(res);
    } catch (e) { logger.warn('legacy apply failed ' + safeErr(e)); }
    executors.notifyOverlay(res);
    _notifyUpdated({ kind: 'scan' });
    return v.warnings.length ? Object.assign({}, res, { warnings: v.warnings }) : res;
  });

  handle('emailIntel:get-config', () => {
    if (!gateOpen('capture')) return OFF();
    let alias = '';
    try { alias = String(os.userInfo().username || '').slice(0, 60); } catch (_) { alias = ''; }
    return { ok: true, config: cfgMod.normalize(stores.load('config')), suggestions: { alias }, readOnly: stores.isReadOnly('config') };
  });

  handle('emailIntel:set-config', (_e, patch) => {
    if (!gateOpen('capture')) return OFF();
    const prev = stores.load('config');
    const v = cfgMod.validate(patch, prev);
    if (!v.ok) return v;
    const saved = stores.save('config', v.config);
    if (!saved.ok) return { ok: false, code: saved.code || 'STORE_ERROR' };
    _notifyUpdated({ kind: 'config' });
    return { ok: true, config: v.config, warnings: v.warnings };
  });

  handle('emailIntel:dom-probe', async (_e, payload) => {
    if (!gateOpen('capture')) return OFF();
    const p = payload == null ? {} : payload;
    if (!_isPlain(p)) return BAD('payload');
    if (p.n !== undefined && (!Number.isInteger(p.n) || p.n < 1 || p.n > 5)) return BAD('n');
    const probe = require('../email-intel/capture/dom-probe');
    return probe.domProbe({ n: p.n || 1 });
  });

  handle('emailIntel:set-tz-verified', (_e, payload) => {
    if (!gateOpen('capture')) return OFF();
    if (!_isPlain(payload) || typeof payload.probeId !== 'string' || !PROBE_RE.test(payload.probeId)) return BAD('probeId');
    const probe = require('../email-intel/capture/dom-probe');
    const r = probe.consumeTzProbe(payload.probeId);
    if (!r.ok) return r;
    const u = stores.update('config', (doc) => Object.assign({}, doc, { mailboxTzVerified: true }));
    if (!u.ok) return { ok: false, code: u.code || 'STORE_ERROR' };
    _notifyUpdated({ kind: 'config' });
    return { ok: true, mailboxTzVerified: true };
  });

  handle('emailIntel:prepare-action', (_e, kind, payload) => {
    if (typeof kind !== 'string' || !confirm.KINDS.includes(kind)) {
      return gateOpen('capture') ? BAD('kind') : OFF();
    }
    if (!gateOpen(KIND_GATES[kind])) return OFF();
    if (kind === 'send-ready-dm') {
      let results = null;
      try { results = require('../scrapers/email_triage').loadResults(); } catch (_) { results = null; }
      const check = executors.validateReadyDm(payload, results);
      if (!check.ok) return { ok: false, code: check.code, field: check.field };
    }
    const r = confirm.prepare(kind, payload);
    if (!r.ok) return r;
    return { ok: true, token: r.token, summary: r.summary, expiresAt: r.expiresAt };
  });

  handle('emailIntel:confirm-action', async (e, token) => {
    if (!gateOpen('capture')) return OFF();
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return BAD('token');
    return confirm.confirm(token, { event: e });
  });

  logger.info('Email Intelligence IPC handlers registered (' + Object.keys(GATES).length + ' channels; inert unless flags are effective)');
}

module.exports = { registerEmailIntelIPC, GATES, KIND_GATES, validateScan };
