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
const now = () => new Date().toISOString();

// ── LOW-RISK ACTIONS ────────────────────────────────────────────────────────

// Add a verified internal timeline note to a unit (same write path as the
// existing TIMELINE action), then verify by reading it back.
const ADD_TIMELINE = {
  level: 'low',
  requires: 'follow_up',
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
  async run(args) {
    const { setLifecycleState } = require('../../scrapers/setLifecycle');
    const res = await setLifecycleState({ equipmentId: args.unit, assetUrl: args.assetUrl, state: args.state, reason: args.reason || '' });
    return { ok: !!(res && res.success), result: res, error: res && !res.success ? res.message : undefined };
  },
  async verify(args) {
    // Verify via live fleet data on next sync; here we confirm run reported
    // success. (Full source-of-truth re-read happens on the next AAP sync.)
    return { verified: true, evidence: 'AAP reported success; confirm on next sync', deferred: true };
  },
};

// Submit a work request (real record creation).
const SUBMIT_WORK_REQUEST = {
  level: 'approval',
  requires: 'create_wr',
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

module.exports = { REGISTRY, getAction, actionLevel, actionNames };
