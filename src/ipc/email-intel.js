'use strict';
/**
 * ipc/email-intel.js — IPC surface of the Email Triage Intelligence module
 * (design section 9). Registered right after registerEmailTriageIPC.
 *
 * EVERY channel is registered, and each one returns { ok:true, enabled:false } and does nothing
 * while its gate is off (the auth-status:get precedent). Phase A (`capture`) fills in: status, scan,
 * get-config, set-config, dom-probe, set-tz-verified and the send-ready-dm prepare/confirm executor;
 * Phase B adds probe-lane (manual P-LANE probe of the isolated lane, no email content).
 * Phase C adds get-staged and the approve-staged / reject-staged prepare validation (approve needs
 * timelineWrites: TIMELINE_DISABLED while only actionsView is on; conflict-ready needs acknowledgeConflictReady).
 * Phase D adds get-actions, action-update (dismiss/snooze/done/reopen/retry-analysis, local state only) and the
 * delete / delete-batch prepare validation (R7.6 rule in executors.deleteTarget; derived conversation keys excluded).
 * Phase E adds draft-thread-reply (resolved-question gate, isolated lane), get-send-attempts, reconcile-send (read-only
 * Sent Items re-check) and the send-reply / mark-send-resolution prepare validation; boot recovery of send attempts
 * runs at registration when threadReplies is effective.
 * Phase F adds ack-vision-notice (F-28: the one-time vision notice; sets visionNoticeAcknowledged and maxVision).
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
  'emailIntel:set-tz-verified', 'emailIntel:prepare-action', 'emailIntel:confirm-action', 'emailIntel:probe-lane',
  'emailIntel:get-staged', 'emailIntel:get-actions', 'emailIntel:action-update',
  'emailIntel:draft-thread-reply', 'emailIntel:get-send-attempts', 'emailIntel:reconcile-send', 'emailIntel:ack-vision-notice',
]);
const CONV_RE = /^cv_[0-9a-f]{16}$/;
const ATTEMPT_RE = /^sa_[0-9a-f]{16}$/;

/** draft-thread-reply (design 9): { conversationKey, mode:'reply'|'reply-all', guidance? <= 1000, force? boolean }. */
function validateDraftThreadReply(payload) {
  if (!_isPlain(payload)) return BAD('payload');
  if (typeof payload.conversationKey !== 'string' || !CONV_RE.test(payload.conversationKey)) return BAD('conversationKey');
  if (payload.mode !== 'reply' && payload.mode !== 'reply-all') return BAD('mode');
  if (payload.guidance !== undefined && (typeof payload.guidance !== 'string' || payload.guidance.length > 1000)) return BAD('guidance');
  if (payload.force !== undefined && typeof payload.force !== 'boolean') return BAD('force');
  return { conversationKey: payload.conversationKey, mode: payload.mode, guidance: payload.guidance || '', force: payload.force === true };
}
const STAGED_STATES = ['open', 'approved', 'rejected', 'superseded', 'expired', 'all'];
const ACTION_RE = /^ac_[0-9a-f]{16}$/;
const ACTION_CATEGORIES = ['reply', 'decision', 'followup', 'review', 'recorded', 'info', 'outofscope'];
const ACTION_OPS = ['dismiss', 'snooze', 'done', 'reopen', 'retry-analysis'];
const SNOOZE_MAX_MS = 30 * 86_400_000;

/** get-actions (design 5.5): { category?, includeClosed?, limit (clamped 1..200), offset 0..10000 }; unknown keys ignored. */
function validateGetActions(payload) {
  const p = payload == null ? {} : payload;
  if (!_isPlain(p)) return BAD('payload');
  const out = { limit: 50, offset: 0 };
  if (p.category !== undefined) { if (!ACTION_CATEGORIES.includes(p.category)) return BAD('category'); out.category = p.category; }
  if (p.includeClosed !== undefined) { if (typeof p.includeClosed !== 'boolean') return BAD('includeClosed'); out.includeClosed = p.includeClosed; }
  if (p.limit !== undefined) {
    if (typeof p.limit !== 'number' || !Number.isFinite(p.limit)) return BAD('limit');
    out.limit = Math.min(200, Math.max(1, Math.trunc(p.limit)));
  }
  if (p.offset !== undefined) { if (!Number.isInteger(p.offset) || p.offset < 0 || p.offset > 10000) return BAD('offset'); out.offset = p.offset; }
  return out;
}

/** action-update (design 5.5): { actionId ^ac_[0-9a-f]{16}$, op enum, snoozeUntil ISO in (now, now+30d] for snooze }. */
function validateActionUpdate(payload, now) {
  if (!_isPlain(payload)) return BAD('payload');
  if (typeof payload.actionId !== 'string' || !ACTION_RE.test(payload.actionId)) return BAD('actionId');
  if (!ACTION_OPS.includes(payload.op)) return BAD('op');
  const out = { actionId: payload.actionId, op: payload.op };
  if (payload.op === 'snooze') {
    const t = typeof payload.snoozeUntil === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(payload.snoozeUntil) ? Date.parse(payload.snoozeUntil) : NaN;
    if (!Number.isFinite(t) || t <= now || t > now + SNOOZE_MAX_MS) return BAD('snoozeUntil');
    out.snoozeUntil = new Date(t).toISOString();
  }
  return out;
}

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

  // F-28 one-time vision notice: { allowVision: boolean } -> visionNoticeAcknowledged true and maxVision (0 when false).
  // Until this is called no image / scanned-PDF bytes go to the vision reader (policy.visionAllowance is 0).
  handle('emailIntel:ack-vision-notice', (_e, payload) => {
    if (!gateOpen('attachments')) return OFF();
    if (!_isPlain(payload) || typeof payload.allowVision !== 'boolean') return BAD('allowVision');
    let saved = null;
    const u = stores.update('config', (doc) => {
      const next = cfgMod.normalize(doc);
      const cur = next.attachments.maxVision;
      next.attachments.visionNoticeAcknowledged = true;
      next.attachments.maxVision = payload.allowVision ? (cur > 0 ? cur : 2) : 0;
      saved = next.attachments;
      return next;
    });
    if (!u.ok) return { ok: false, code: u.code || 'STORE_ERROR' };
    _notifyUpdated({ kind: 'config' });
    return { ok: true, visionNoticeAcknowledged: true, maxVision: saved ? saved.maxVision : 0 };
  });

  // P-LANE (F-16): one tiny isolated-lane call with no email content, manual only; updates the lane state.
  handle('emailIntel:probe-lane', async () => {
    if (!gateOpen('capture')) return OFF();
    const lane = require('../email-intel/understand/lane');
    let r;
    try { r = await lane.probeLane(); } catch (e) { logger.warn('probe-lane failed ' + safeErr(e)); r = { ok: false, error: 'probe-failed' }; }
    const s = lane.state();
    _notifyUpdated({ kind: 'status' });
    return { ok: !!r.ok, lane: { state: s.state, checkedAt: s.checkedAt }, error: r.ok ? undefined : (r.error || 'unavailable') };
  });

  // Staged facts awaiting review (Phase C). Paging ints; items carry code-built text plus the validated fact and quote.
  handle('emailIntel:get-staged', (_e, payload) => {
    if (!gateOpen(GATES['emailIntel:get-staged'])) return OFF();
    const p = payload == null ? {} : payload;
    if (!_isPlain(p)) return BAD('payload');
    if (p.offset !== undefined && (!Number.isInteger(p.offset) || p.offset < 0 || p.offset > 10000)) return BAD('offset');
    if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit < 1 || p.limit > 200)) return BAD('limit');
    if (p.state !== undefined && !STAGED_STATES.includes(p.state)) return BAD('state');
    const staged = require('../email-intel/facts/staged');
    const doc = staged.load();
    const l = staged.list(doc, { state: p.state || 'open', offset: p.offset || 0, limit: p.limit || 50 });
    return { ok: true, items: l.items, total: l.total, openCount: staged.openCount(doc), expiredCount: doc.expiredCount || 0, overCap: !!doc.overCap, timelineWrites: gateOpen('timelineWrites') };
  });

  // My Email Actions (Phase D). Reading refreshes snoozes, decided staged items and overdue follow-ups (no AI).
  handle('emailIntel:get-actions', (_e, payload) => {
    if (!gateOpen('actionsView')) return OFF();
    const v = validateGetActions(payload);
    if (v.ok === false) return v;
    try { require('../email-intel/actions/stage').refresh({ now: Date.now() }); } catch (e) { logger.warn('actions refresh failed ' + safeErr(e)); }
    const as = require('../email-intel/actions/store');
    const tpl = require('../email-intel/actions/templates');
    const doc = as.load();
    const l = as.list(doc, v);
    return {
      ok: true, counts: l.counts, total: l.total, items: l.items, categories: tpl.CATEGORIES.map((c) => ({ id: c, label: tpl.LABELS[c] })),
      overCap: !!doc.overCap, timelineWrites: gateOpen('timelineWrites'),
    };
  });

  // Local item state only (no confirmation): dismiss | snooze | done | reopen | retry-analysis (failed-permanent only, F-16).
  handle('emailIntel:action-update', (_e, payload) => {
    if (!gateOpen('actionsView')) return OFF();
    const now = Date.now();
    const v = validateActionUpdate(payload, now);
    if (v.ok === false) return v;
    const as = require('../email-intel/actions/store');
    const item = as.load().items[v.actionId];
    if (!item) { logger.info('action-update: unknown action'); return { ok: false, code: 'NOT_FOUND' }; }
    if (v.op === 'retry-analysis') {
      const analyze = require('../email-intel/understand/analyze');
      let retried = false;
      const r = stores.update('messages', (doc) => {
        const rec = doc.messages && (doc.messages[item.latestMessageKey] || doc.messages[item.messageKey]);
        if (rec && rec.analysis && rec.analysis.status === 'failed-permanent') { rec.analysis = analyze.retryAnalysis(rec.analysis); retried = true; }
        return doc;
      });
      if (!r.ok) return { ok: false, code: r.code || 'STORE_ERROR' };
      if (!retried) return BAD('op');
      _notifyUpdated({ kind: 'actions' });
      return { ok: true, actionId: v.actionId, state: item.state, retry: 'queued' };
    }
    let res = null;
    const u = as.update((doc) => { res = as.applyOp(doc, v.actionId, v.op, { snoozeUntil: v.snoozeUntil, now }); });
    if (!u.ok) return { ok: false, code: u.code || 'STORE_ERROR' };
    if (!res || !res.ok) return res || { ok: false, code: 'NOT_FOUND' };
    _notifyUpdated({ kind: 'actions' });
    return { ok: true, actionId: v.actionId, state: res.item.state, snoozeUntil: res.item.snoozeUntil };
  });

  // ── Phase E: thread-aware replies (threadReplies). Sending itself only happens through prepare/confirm-action.
  handle('emailIntel:draft-thread-reply', async (_e, payload) => {
    if (!gateOpen('threadReplies')) return OFF();
    const v = validateDraftThreadReply(payload);
    if (v.ok === false) return v;
    const r = await require('../email-intel/reply/draft').draftThreadReply(v);
    if (r && r.ok) { try { executors.notifyOverlay(require('../scrapers/email_triage').loadResults()); } catch (_) { /* push only */ } _notifyUpdated({ kind: 'actions' }); }
    return r;
  });

  handle('emailIntel:get-send-attempts', (_e, payload) => {
    if (!gateOpen('threadReplies')) return OFF();
    // The preload bridge passes the conversation key itself; an object { conversationKey } is accepted too.
    const p = payload == null ? {} : (typeof payload === 'string' ? { conversationKey: payload } : payload);
    if (!_isPlain(p)) return BAD('payload');
    if (p.conversationKey !== undefined && (typeof p.conversationKey !== 'string' || !CONV_RE.test(p.conversationKey))) return BAD('conversationKey');
    const guard = require('../email-intel/reply/send-guard');
    return { ok: true, attempts: guard.list({ conversationKey: p.conversationKey, limit: 50 }), unreconciled: guard.unreconciledCount() };
  });

  handle('emailIntel:reconcile-send', async (_e, payload) => {
    if (!gateOpen('threadReplies')) return OFF();
    const p = typeof payload === 'string' ? { attemptId: payload } : payload;           // the preload bridge passes the id itself
    if (!_isPlain(p) || typeof p.attemptId !== 'string' || !ATTEMPT_RE.test(p.attemptId)) return BAD('attemptId');
    const r = await require('../email-intel/reply/reconcile-send').reconcileSend(p.attemptId);
    try { executors.notifyOverlay(require('../scrapers/email_triage').loadResults()); } catch (_) { /* push only */ }
    _notifyUpdated({ kind: 'sends' });
    return r;
  });

  // Boot recovery (design 6.5): a send that was mid-click when the app stopped becomes delivery-uncertain.
  if (gateOpen('threadReplies')) {
    try { require('../email-intel/reply/send-guard').bootRecover(); } catch (e) { logger.warn('send boot recovery failed ' + safeErr(e)); }
  }

  handle('emailIntel:prepare-action', (_e, kind, payload) => {
    if (typeof kind !== 'string' || !confirm.KINDS.includes(kind)) {
      return gateOpen('capture') ? BAD('kind') : OFF();
    }
    // Approving needs timelineWrites; with only the review view on, the item is visible but not approvable.
    if (kind === 'approve-staged' && !gateOpen('timelineWrites')) return gateOpen('actionsView') ? { ok: false, code: 'TIMELINE_DISABLED' } : OFF();
    if (!gateOpen(KIND_GATES[kind])) return OFF();
    if (kind === 'approve-staged' || kind === 'reject-staged') {
      const check = executors.validateStaged(kind, payload);
      if (!check.ok) return { ok: false, code: check.code, field: check.field };
    }
    if (kind === 'delete' || kind === 'delete-batch') {
      const check = executors.validateDelete(kind, payload);
      if (!check.ok) return Object.assign({ ok: false, code: check.code, field: check.field }, check.reason ? { reason: check.reason } : {});
    }
    if (kind === 'send-reply') {
      const check = executors.validateSendReply(payload);
      if (!check.ok) return Object.assign({ ok: false, code: check.code }, check.field ? { field: check.field } : {}, check.reason ? { reason: check.reason } : {}, check.attemptId ? { attemptId: check.attemptId, state: check.state } : {});
    }
    if (kind === 'mark-send-resolution') {
      const check = executors.validateResolution(payload);
      if (!check.ok) return Object.assign({ ok: false, code: check.code, field: check.field }, check.reason ? { reason: check.reason } : {});
    }
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

module.exports = { registerEmailIntelIPC, GATES, KIND_GATES, validateScan, validateGetActions, validateActionUpdate, validateDraftThreadReply };
