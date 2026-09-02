'use strict';
/**
 * orcha/fas/action-registry.js — Digital FAS Stage 6/7: action tools + verify.
 *
 * Each action declares:
 *   - level: 'low' (auto-runnable when configured+authorized) or 'approval'
 *            (lifecycle changes, WR submission, external sends, etc.)
 *   - requires: sender permission needed to even propose it
 *   - run(args, ctx): performs the REAL app action, returns { ok, result?, error? }
 *   - verify(args, ctx, runResult): confirms via the SOURCE system that it
 *     actually happened; returns { verified: bool, evidence?, error? }
 *
 * CRITICAL: an action is never reported as succeeded on the model's say-so.
 * The executor runs run() then verify() and only reports success if verify
 * passes. Nothing here executes on its own — the executor (executor.js) decides
 * based on mode + level + authorization + approvals.
 */

const store = require('../../store');
const profiles = require('./sender-profiles');
const crypto = require('crypto');
const now = () => new Date().toISOString();

// Stable idempotency key from a namespace + semantic parts. Retries of the
// SAME logical action (same unit + same content) produce the same key so the
// executor can skip a duplicate note/reminder/case/WR/message/lifecycle change.
function _idem(ns, parts) {
  const h = crypto.createHash('sha1').update(ns + '|' + JSON.stringify(parts)).digest('hex').slice(0, 16);
  return ns + ':' + h;
}

// ── LOW-RISK ACTIONS ────────────────────────────────────────────────────────

// Add a verified internal timeline note to a unit (same write path as the
// existing TIMELINE action), then verify by reading it back.
const ADD_TIMELINE = {
  level: 'low',
  requires: 'follow_up',
  idempotencyKey(args) { return _idem('ADD_TIMELINE', { unit: String(args.unit || '').trim().toUpperCase(), entry: String(args.entry || '').trim() }); },
  run(args) {
    const unit = String(args.unit || '').trim();
    const entry = String(args.entry || '').trim();
    if (!unit || !entry) return { ok: false, error: 'unit and entry required' };
    const ns = store.load('notesStore', {}) || {};
    const u = ns[unit] || {};
    u.timeline = u.timeline ? (u.timeline + '\n' + entry) : entry;
    u.notesUpdatedAt = now();
    ns[unit] = u;
    store.save('notesStore', ns);
    return { ok: true, result: { unit, entry } };
  },
  verify(args) {
    const ns = store.load('notesStore', {}) || {};
    const tl = (ns[String(args.unit || '').trim()] || {}).timeline || '';
    const verified = tl.split('\n').includes(String(args.entry || '').trim());
    return { verified, evidence: verified ? 'timeline contains the entry' : 'entry not found after write' };
  },
};

// Schedule a follow-up reminder for a unit/case.
const CREATE_REMINDER = {
  level: 'low',
  requires: 'follow_up',
  idempotencyKey(args) { return _idem('CREATE_REMINDER', { unit: args.unit || null, note: String(args.note || '').slice(0, 300), when: args.when || null }); },
  run(args) {
    const rem = store.load('reminders', []) || [];
    const id = 'rem_' + Date.now().toString(36);
    const item = { id, unit: args.unit || null, note: String(args.note || '').slice(0, 300), when: args.when || null, createdAt: now(), source: 'fas' };
    rem.push(item);
    store.save('reminders', rem);
    return { ok: true, result: item };
  },
  verify(args, ctx, runResult) {
    const rem = store.load('reminders', []) || [];
    const verified = rem.some(r => r.id === (runResult.result && runResult.result.id));
    return { verified, evidence: verified ? 'reminder persisted' : 'reminder not found after write' };
  },
};

// Create/append a follow-up case in FAS case memory.
const CREATE_FOLLOWUP_CASE = {
  level: 'low',
  requires: 'follow_up',
  idempotencyKey(args) { return _idem('CREATE_FOLLOWUP_CASE', { unit: args.unit || null, summary: args.summary || '', promise: args.promise || '', dueAt: args.dueAt || null }); },
  run(args) {
    const caseStore = require('./case-store');
    const unit = args.unit ? String(args.unit).trim() : null;
    const caseId = unit ? caseStore.caseIdForUnit(unit) : caseStore.caseIdForSender(args.slackId || 'unknown');
    const c = caseStore.upsert(caseId, {
      unit,
      currentSummary: args.summary || '',
      openQuestions: args.openQuestion ? [args.openQuestion] : [],
      promises: args.promise ? [{ text: args.promise, madeAt: now() }] : [],
      responsibleParty: args.owner || '',
      nextFollowUpAt: args.dueAt || null,
    }, unit);
    return { ok: true, result: { caseId: c.caseId } };
  },
  verify(args, ctx, runResult) {
    const caseStore = require('./case-store');
    const c = caseStore.getCase(runResult.result && runResult.result.caseId);
    return { verified: !!c, evidence: c ? 'case persisted' : 'case not found after write' };
  },
};

// ── APPROVAL-REQUIRED ACTIONS ────────────────────────────────────────────────
// These perform real, hard-to-reverse or external effects. They are NEVER
// auto-executed; the executor queues them for human approval (except in
// autonomous mode AND only if explicitly whitelisted — still verified).

// Change a unit lifecycle state in AAP (real mutation).
const MOVE_UNIT = {
  level: 'approval',
  requires: 'lifecycle_change',
  // A lifecycle change to the SAME target state is idempotent — retrying must
  // not double-apply. Keyed by unit + target state + reason.
  idempotencyKey(args) { return _idem('MOVE_UNIT', { unit: String(args.unit || '').trim().toUpperCase(), state: String(args.state || '').trim().toUpperCase(), reason: String(args.reason || '').trim() }); },
  async run(args) {
    const { setLifecycleState } = require('../../scrapers/setLifecycle');
    const res = await setLifecycleState({ equipmentId: args.unit, assetUrl: args.assetUrl, state: args.state, reason: args.reason || '' });
    return { ok: !!(res && res.success), result: res, error: res && !res.success ? res.message : undefined };
  },
  async verify(args, ctx, runResult) {
    // SPEC: do NOT report verified success just because the write returned ok.
    // Read the lifecycle state back from the SOURCE (AAP). If the setLifecycle
    // automation read back the post-apply state, use it. Otherwise attempt a
    // read-back via a provided reader; if none is available, hold in a
    // VERIFYING (deferred, NOT verified) state until the next sync confirms.
    const want = String(args.state || '').trim().toUpperCase();
    // (a) automation-reported post-apply state, if present.
    const readBack = runResult && runResult.result &&
      (runResult.result.verifiedState || runResult.result.newState || runResult.result.currentState);
    if (readBack) {
      const ok = String(readBack).trim().toUpperCase() === want;
      return ok
        ? { verified: true, evidence: 'AAP read-back confirms lifecycle=' + readBack }
        : { verified: false, error: 'AAP read-back shows ' + readBack + ', expected ' + want };
    }
    // (b) optional injected reader (tests) — takes a unit, returns state string.
    const injected = ctx && typeof ctx.readLifecycle === 'function' ? ctx.readLifecycle : null;
    if (injected) {
      try {
        const cur = await injected(args.unit);
        const ok = String(cur || '').trim().toUpperCase() === want;
        return ok
          ? { verified: true, evidence: 'source read-back confirms lifecycle=' + cur }
          : { verified: false, error: 'source read-back shows ' + cur + ', expected ' + want };
      } catch (e) { return { verified: false, deferred: true, error: 'read-back failed: ' + e.message }; }
    }
    // (c) REAL authenticated AAP read-back of the SAME asset page we mutated.
    //     Requires assetUrl + a live Midway session; runs a hidden BrowserWindow
    //     in the main process. On any failure we DEFER (verifying) rather than
    //     falsely claim success — the next fleet sync reconciles it.
    try {
      const { readLifecycle } = require('../../scrapers/readLifecycle');
      const cur = await readLifecycle(args.assetUrl);
      if (cur && cur.state) {
        const ok = String(cur.state).trim().toUpperCase() === want;
        return ok
          ? { verified: true, evidence: 'AAP read-back confirms lifecycle=' + cur.state + (cur.reason ? (' / ' + cur.reason) : '') }
          : { verified: false, error: 'AAP read-back shows ' + cur.state + ', expected ' + want };
      }
      // Could not read live (no session / page miss) -> defer for sync reconcile.
      return { verified: false, deferred: true, error: 'live AAP read-back unavailable; awaiting sync reconcile' };
    } catch (e) {
      return { verified: false, deferred: true, error: 'read-back error: ' + e.message + '; awaiting sync reconcile' };
    }
  },
};

// Submit a work request (real record creation).
const SUBMIT_WORK_REQUEST = {
  level: 'approval',
  requires: 'create_wr',
  idempotencyKey(args) { return _idem('SUBMIT_WORK_REQUEST', { unit: String(args.unit || '').trim().toUpperCase(), payload: args.payload || {} }); },
  async run(args) {
    const { BrowserWindow } = (() => { try { return require('electron'); } catch (_) { return {}; } })();
    // Reuse the app's create-WR path via IPC-equivalent function.
    const createWr = require('../../scrapers/aap_create_wr');
    if (!createWr || !createWr.createWorkRequest) return { ok: false, error: 'create-WR unavailable' };
    const res = await createWr.createWorkRequest(args.payload, args.unit, () => {});
    return { ok: !!(res && res.ok), result: res, error: res && res.error };
  },
  verify(args, ctx, runResult) {
    const wrId = runResult.result && runResult.result.workRequestId;
    return { verified: !!wrId, evidence: wrId ? ('WR created: ' + wrId) : 'no WR id returned' };
  },
};

// Send a Slack message (external effect).
const SEND_SLACK_MESSAGE = {
  level: 'approval',
  requires: 'follow_up',
  idempotencyKey(args) { return _idem('SEND_SLACK_MESSAGE', { channelId: args.channelId || '', message: String(args.message || ''), threadTs: args.threadTs || null }); },
  async run(args) {
    const { sendToChannel } = require('../../scrapers/slack_send');
    const res = await sendToChannel(args.channelId, args.message, args.threadTs || undefined);
    return { ok: !!(res && res.ts), result: res, error: (res && res.ts) ? undefined : 'no ts returned' };
  },
  verify(args, ctx, runResult) {
    // Slack returns a message ts on success — that IS the verification.
    const ts = runResult.result && runResult.result.ts;
    return { verified: !!ts, evidence: ts ? ('sent, ts=' + ts) : 'no message ts' };
  },
};

const REGISTRY = {
  ADD_TIMELINE,
  CREATE_REMINDER,
  CREATE_FOLLOWUP_CASE,
  MOVE_UNIT,
  SUBMIT_WORK_REQUEST,
  SEND_SLACK_MESSAGE,
};

function getAction(name) { return REGISTRY[name] || null; }
function actionLevel(name) { const a = REGISTRY[name]; return a ? a.level : null; }
function actionNames() { return Object.keys(REGISTRY); }

// Plain-language descriptions + automatic-eligibility for the Settings UI
// (Part 12). Only 'low'-risk actions are eligible to be enabled as automatic;
// 'approval'-level actions (lifecycle changes, WR submission, outbound sends)
// ALWAYS require approval and can never be made automatic.
const DESCRIPTIONS = {
  ADD_TIMELINE: 'Add a note to a unit\u2019s repair timeline (internal record only).',
  CREATE_REMINDER: 'Create a reminder/task for yourself to follow up (internal only).',
  CREATE_FOLLOWUP_CASE: 'Open or update an internal follow-up case for a unit.',
  MOVE_UNIT: 'Change a unit\u2019s lifecycle state in AAP (e.g. Active/Unavailable).',
  SUBMIT_WORK_REQUEST: 'Submit a work request in AAP for a unit.',
  SEND_SLACK_MESSAGE: 'Send a Slack message on your behalf.',
};

function listActionCatalog() {
  return actionNames().map(name => {
    const a = REGISTRY[name];
    return {
      name,
      level: a.level,                          // 'low' | 'approval'
      requires: a.requires || null,
      description: DESCRIPTIONS[name] || '',
      // Only low-risk actions may EVER run automatically; approval-level
      // actions always require human approval.
      eligibleForAutomatic: a.level === 'low',
      isMutation: a.level === 'approval' || /MOVE_UNIT|SUBMIT_WORK_REQUEST|SEND_SLACK/.test(name),
    };
  });
}

module.exports = { REGISTRY, getAction, actionLevel, actionNames, listActionCatalog, DESCRIPTIONS };
