'use strict';
/**
 * ipc/workflow-intel.js — Workflow Intelligence: Recorder + Library CRUD [Phase 8]
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md for the full design.
 *
 * This file covers Phase 1 backend plumbing only:
 *   - Recording session lifecycle (start/record-step/stop/discard)
 *   - Workflow library CRUD (list/get/save/delete/toggle-favorite)
 *   - Import/export
 *   - Execution log read (write side ships with Phase 4 / orchestrator RUN_WORKFLOW intent)
 *
 * Deliberately NOT in scope here (later chunks):
 *   - src/window/action_capture.js (external-site DOM capture injection)
 *   - src/orcha/workflow-learn.js (Phase 2 pattern mining)
 *   - orchestrator.js RUN_WORKFLOW intent (Phase 4 execution)
 *
 * Redaction: any step whose value looks like a credential (explicit `sensitive`
 * flag, or fieldType === 'password') is redacted to '[REDACTED]' the moment it
 * is recorded — never persisted, never round-tripped to the renderer. This is
 * enforced here (session buffer), not just at the capture-script layer, so it
 * holds even if a future capture surface forgets to redact upstream.
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:workflow-intel');
const { handle, requireString, requireObject } = require('./_safe');
const { ConfigError } = require('../utils/errors');

const MAX_STEPS_PER_SESSION = 500;
const MAX_EXECUTION_LOG_ENTRIES = 200;

// ── In-memory recording sessions (not persisted until stop-recording saves them) ──
// sessionId → { id, startedAt, meta, steps: [] }
const _sessions = new Map();

function _genId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function _isSensitiveStep(step) {
  if (!step || typeof step !== 'object') return false;
  if (step.sensitive === true) return true;
  const ft = (step.fieldType || '').toLowerCase();
  if (ft === 'password' || ft === 'secret' || ft === 'token') return true;
  const sel = (step.selector || '').toLowerCase();
  if (sel.includes('password') || sel.includes('secret')) return true;
  return false;
}

function _redactStep(step) {
  if (_isSensitiveStep(step)) {
    return { ...step, value: '[REDACTED]', redacted: true };
  }
  return step;
}

function _validRecording(rec) {
  if (!rec || typeof rec !== 'object') return 'recording must be an object';
  if (typeof rec.name !== 'string' || !rec.name.trim()) return 'recording.name is required';
  if (!Array.isArray(rec.steps)) return 'recording.steps must be an array';
  return null;
}

function _appendStepToSession(sessionId, step) {
  const session = _sessions.get(sessionId);
  if (!session) throw new ConfigError(`No active recording session: ${sessionId}`, 'sessionId');
  if (session.steps.length >= MAX_STEPS_PER_SESSION) {
    throw new ConfigError(
      `Recording session ${sessionId} exceeded ${MAX_STEPS_PER_SESSION} steps -- stop and save, or split into multiple workflows`,
      'steps'
    );
  }
  const safeStep = _redactStep({ id: _genId('step'), ts: new Date().toISOString(), ...step });
  session.steps.push(safeStep);
  return { ok: true, count: session.steps.length };
}

/**
 * Active recording session id, if any (single-session model -- matches the
 * one-recording-at-a-time enforcement in renderer/src/js/workflow-recorder.js).
 * Used by src/window/action_capture.js to decide whether a newly-opened
 * popup window (open-popup in ipc/orcha.js) should have capture attached.
 */
function getActiveSessionId() {
  const keys = Array.from(_sessions.keys());
  return keys.length ? keys[0] : null;
}

/**
 * Direct main-process append, bypassing IPC entirely -- action_capture.js
 * already runs inside the main process (it drives a BrowserWindow directly),
 * so there is no renderer round-trip needed or possible here.
 */
function recordStepFromMain(sessionId, step) {
  return _appendStepToSession(sessionId, step);
}

function registerWorkflowIntelIPC(ctx) {
  // ── Recording session lifecycle ──────────────────────────────────────────

  handle('wi:start-recording', async (_e, meta) => {
    const m = meta && typeof meta === 'object' ? meta : {};
    const id = _genId('sess');
    const session = {
      id,
      startedAt: new Date().toISOString(),
      meta: {
        name: m.name || '',
        category: m.category || '',
        triggerContext: m.triggerContext || {},
        unitId: m.unitId || null,
      },
      steps: [],
    };
    _sessions.set(id, session);
    logger.info(`Recording session started: ${id}`);
    return { id, startedAt: session.startedAt };
  });

  handle('wi:record-step', async (_e, sessionId, step) => {
    requireString(sessionId, 'sessionId');
    requireObject(step, 'step');
    const session = _sessions.get(sessionId);
    if (!session) throw new ConfigError(`No active recording session: ${sessionId}`, 'sessionId');

    if (session.steps.length >= MAX_STEPS_PER_SESSION) {
      throw new ConfigError(
        `Recording session ${sessionId} exceeded ${MAX_STEPS_PER_SESSION} steps — stop and save, or split into multiple workflows`,
        'steps'
      );
    }

    const safeStep = _redactStep({
      id: _genId('step'),
      ts: new Date().toISOString(),
      ...step,
    });
    session.steps.push(safeStep);
    return { ok: true, count: session.steps.length };
  });

  handle('wi:discard-recording', async (_e, sessionId) => {
    requireString(sessionId, 'sessionId');
    const existed = _sessions.delete(sessionId);
    logger.info(`Recording session discarded: ${sessionId} (existed=${existed})`);
    return { ok: true };
  });

  handle('wi:stop-recording', async (_e, sessionId, finalMeta) => {
    requireString(sessionId, 'sessionId');
    const session = _sessions.get(sessionId);
    if (!session) throw new ConfigError(`No active recording session: ${sessionId}`, 'sessionId');

    const fm = finalMeta && typeof finalMeta === 'object' ? finalMeta : {};
    const name = (fm.name || session.meta.name || '').trim();
    if (!name) throw new ConfigError('A workflow name is required to save a recording', 'name');

    const now = new Date().toISOString();
    const recording = {
      id: _genId('wf'),
      name,
      description: fm.description || '',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      category: fm.category || session.meta.category || 'Uncategorized',
      favorite: !!fm.favorite,
      steps: session.steps,
      triggerContext: fm.triggerContext || session.meta.triggerContext || {},
      variables: fm.variables && typeof fm.variables === 'object' ? fm.variables : {},
      createdAt: now,
      updatedAt: now,
      source: 'recorded',
      stats: { timesExecuted: 0, timesSuggested: 0, timesAccepted: 0, avgDurationMs: 0, successRate: null },
    };

    const all = store.load('workflowRecordings', {});
    all[recording.id] = recording;
    store.save('workflowRecordings', all);

    // Phase 2 pattern mining -- advisory only, must never block the save.
    try {
      require('../orcha/workflow-learn').recordNewWorkflow(recording);
    } catch (e) {
      logger.warn('Workflow pattern mining failed (non-fatal):', e.message);
    }

    _sessions.delete(sessionId);
    logger.info(`Recording saved: "${recording.name}" (${recording.id}, ${recording.steps.length} steps)`);
    return recording;
  });

  // ── Library CRUD ──────────────────────────────────────────────────────────

  handle('wi:list-workflows', async (_e, filter) => {
    const f = filter && typeof filter === 'object' ? filter : {};
    const all = store.load('workflowRecordings', {});
    let list = Object.values(all);

    if (f.search) {
      const q = String(f.search).toLowerCase();
      list = list.filter(w =>
        (w.name || '').toLowerCase().includes(q) ||
        (w.description || '').toLowerCase().includes(q) ||
        (w.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    if (f.category) list = list.filter(w => w.category === f.category);
    if (f.tag) list = list.filter(w => (w.tags || []).includes(f.tag));
    if (f.favoriteOnly) list = list.filter(w => w.favorite);

    list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return list;
  });

  handle('wi:get-workflow', async (_e, id) => {
    requireString(id, 'id');
    const all = store.load('workflowRecordings', {});
    return all[id] || null;
  });

  handle('wi:save-workflow', async (_e, recording) => {
    requireObject(recording, 'recording');
    const err = _validRecording(recording);
    if (err) throw new ConfigError(err, 'recording');

    const all = store.load('workflowRecordings', {});
    const existing = recording.id ? all[recording.id] : null;
    const id = existing ? existing.id : _genId('wf');
    const now = new Date().toISOString();

    const saved = {
      ...(existing || {}),
      ...recording,
      id,
      steps: recording.steps.map(s => _redactStep(s)),
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      source: existing ? existing.source : (recording.source || 'recorded'),
      stats: existing ? existing.stats : (recording.stats || { timesExecuted: 0, timesSuggested: 0, timesAccepted: 0, avgDurationMs: 0, successRate: null }),
    };

    all[id] = saved;
    store.save('workflowRecordings', all);
    logger.info(`Workflow saved: "${saved.name}" (${id})`);
    return saved;
  });

  handle('wi:delete-workflow', async (_e, id) => {
    requireString(id, 'id');
    const all = store.load('workflowRecordings', {});
    if (!all[id]) return { ok: true, deleted: false };
    delete all[id];
    store.save('workflowRecordings', all);
    logger.info(`Workflow deleted: ${id}`);
    return { ok: true, deleted: true };
  });

  handle('wi:toggle-favorite', async (_e, id) => {
    requireString(id, 'id');
    const all = store.load('workflowRecordings', {});
    const rec = all[id];
    if (!rec) throw new ConfigError(`Workflow not found: ${id}`, 'id');
    rec.favorite = !rec.favorite;
    rec.updatedAt = new Date().toISOString();
    store.save('workflowRecordings', all);
    return { ok: true, favorite: rec.favorite };
  });

  // ── Import / Export ────────────────────────────────────────────────────────

  handle('wi:import-workflow', async (_e, bundle) => {
    requireObject(bundle, 'bundle');
    const err = _validRecording(bundle);
    if (err) throw new ConfigError('Invalid workflow bundle: ' + err, 'bundle');

    const now = new Date().toISOString();
    const imported = {
      ...bundle,
      id: _genId('wf'),
      steps: bundle.steps.map(s => _redactStep(s)),
      createdAt: now,
      updatedAt: now,
      source: 'imported',
      stats: { timesExecuted: 0, timesSuggested: 0, timesAccepted: 0, avgDurationMs: 0, successRate: null },
    };

    const all = store.load('workflowRecordings', {});
    all[imported.id] = imported;
    store.save('workflowRecordings', all);
    logger.info(`Workflow imported: "${imported.name}" (${imported.id})`);
    return imported;
  });

  handle('wi:export-workflow', async (_e, id) => {
    requireString(id, 'id');
    const all = store.load('workflowRecordings', {});
    const rec = all[id];
    if (!rec) throw new ConfigError(`Workflow not found: ${id}`, 'id');
    return rec; // renderer serializes + triggers a save-file flow
  });

  // ── Execution log (read side; write side ships with Phase 4) ───────────────

  handle('wi:get-execution-log', async (_e, limit) => {
    const lim = Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_EXECUTION_LOG_ENTRIES) : 50;
    const log = store.load('workflowExecutionLog', { entries: [] });
    return (log.entries || []).slice(-lim).reverse();
  });

  // -- On-demand suggestion (Phase 3) -- mirrors the existing on-demand
  // "Analyze" pattern already used for ai:suggest-vendor in ipc/orcha.js,
  // rather than depending on the (currently dormant) runRecommendations()
  // sync-cycle pipeline. See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md.
  handle('wi:get-suggestion-for-unit', async (_e, unit) => {
    requireObject(unit, 'unit');
    const { suggestWorkflowForUnit } = require('../orcha/recommend');
    return suggestWorkflowForUnit(unit);
  });

  logger.info('Workflow Intelligence IPC handlers registered (Phases 1+3: recorder + library + on-demand suggestions)');
}

module.exports = { registerWorkflowIntelIPC, getActiveSessionId, recordStepFromMain };
