'use strict';
/**
 * orchestrator.js — Orcha Decision Engine [V-C]
 * V-C changes vs V-B:
 *   - console.log replaced with namespaced logger
 *   - require paths updated to V-C layout (scrapers at ../../src/scrapers/...)
 *   - No file I/O in orchestrator — all state via context module
 */

const context  = require('./context');
const relay    = require('./relay');
const { calculatePriority } = require('./priority');
const logger   = require('../utils/logger')('orchestrator');

// ── INTENT TYPES ──────────────────────────────────────────────────────────────
const INTENT_TYPES = {
  CREATE_WR:     'create_wr',
  SP_PUSH:       'sp_push',
  SEND_EMAIL:    'send_email',
  DAILY_NOTES:   'daily_notes',
  FLIP_STATE:    'flip_state',
  ASSIGN_VENDOR: 'assign_vendor',
  DEEP_SCAN:     'deep_scan',
  CLASSIFY:      'classify',
};

// ── ORCHESTRATOR CLASS ────────────────────────────────────────────────────────
class Orchestrator {
  constructor() {
    this._handlers = new Map();
    this._hooks    = { beforeValidate: [], afterComplete: [] };
    this._log      = [];
    this._registerDefaults();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════════

  async execute(intent) {
    const startTime  = Date.now();
    const workflowId = context.startWorkflow({
      type: intent.type, unitId: intent.unitId, data: intent.data, source: intent.source || 'user',
    });

    const execution = { intent, workflowId, steps: [], errors: [], warnings: [] };

    try {
      this._step(execution, 'validate', 'Validating intent...');
      const validation = await this._validate(intent);

      if (!validation.valid) {
        execution.errors.push(...validation.errors);
        context.completeWorkflow(workflowId, { success: false, errors: validation.errors });
        this._logExecution(execution, 'rejected');
        return { success: false, rejected: true, errors: validation.errors, warnings: validation.warnings || [] };
      }
      if (validation.warnings && validation.warnings.length > 0) execution.warnings.push(...validation.warnings);

      this._step(execution, 'enrich',  'Enriching with context...');
      const enriched = await this._enrich(intent);

      this._step(execution, 'plan',    'Planning execution steps...');
      const plan = await this._plan(enriched);

      this._step(execution, 'execute', `Executing ${plan.steps.length} steps...`);
      const result = await this._executePlan(plan, execution);

      this._step(execution, 'verify',  'Verifying outcome...');
      const verified = await this._verify(intent, result);

      if (!verified.ok) {
        execution.errors.push('Verification failed: ' + verified.reason);
        context.completeWorkflow(workflowId, { success: false, errors: execution.errors });
        this._logExecution(execution, 'verification_failed');
        return { success: false, errors: execution.errors, result, warnings: execution.warnings };
      }

      context.completeWorkflow(workflowId, { success: true, result, duration: Date.now() - startTime });
      this._logExecution(execution, 'success');
      return { success: true, result, steps: execution.steps, warnings: execution.warnings };

    } catch (e) {
      execution.errors.push(e.message);
      context.completeWorkflow(workflowId, { success: false, errors: [e.message] });
      this._logExecution(execution, 'error');
      return { success: false, errors: [e.message], warnings: execution.warnings };
    }
  }

  async validate(intent) { return this._validate(intent); }

  async suggest(unitId) {
    const unit = context.getUnit(unitId);
    if (!unit) return { actions: [], reason: 'Unit not found in context' };

    const priority  = calculatePriority(unit);
    const activeWfs = context.getWorkflowsForUnit(unitId);
    const hasActiveWR = activeWfs.some(w => w.type === 'create_wr' && w.status === 'active');
    const actions = [];

    if (!unit.savedNotes) actions.push({ type: 'review', label: 'Add initial notes', priority: 3 });
    if (!unit.vendor || unit.vendor === '--' || unit.vendor === 'UNASSIGNED') actions.push({ type: INTENT_TYPES.ASSIGN_VENDOR, label: 'Assign vendor', priority: 5 });
    if (unit.atsState === 'Unavailable' && !hasActiveWR && !unit.workRequestId) actions.push({ type: INTENT_TYPES.CREATE_WR, label: 'Create Work Request', priority: 4 });
    if (unit.atsState === 'Unavailable' && unit.relayStatus === 'Available') actions.push({ type: INTENT_TYPES.FLIP_STATE, label: 'Flip to Available', priority: 5 });

    const days = parseInt(unit.duration) || 0;
    if (days >= (unit.slaTarget || 5)) actions.push({ type: 'escalate', label: `SLA breach (${days} days)`, priority: 5 });

    actions.sort((a, b) => b.priority - a.priority);
    return { unitId, priority, actions, activeWorkflows: activeWfs.length };
  }

  getLog(limit = 20) { return this._log.slice(-limit); }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  async _validate(intent) {
    const errors = [], warnings = [];

    if (!intent.type) { errors.push('Intent has no type'); return { valid: false, errors, warnings }; }

    if (intent.unitId) {
      const unit = context.getUnit(intent.unitId);
      if (!unit) { errors.push(`Unit ${intent.unitId} not found in context — run a sync first`); return { valid: false, errors, warnings }; }

      const activeWfs = context.getActiveWorkflows().filter(w => w.unitId === intent.unitId && w.type === intent.type);
      if (activeWfs.length > 0) warnings.push(`Unit ${intent.unitId} already has an active ${intent.type} workflow (started ${new Date(activeWfs[0].startedAt).toLocaleTimeString()})`);

      switch (intent.type) {
        case INTENT_TYPES.CREATE_WR:
          if (unit.atsState === 'Available') errors.push(`Unit ${intent.unitId} is Available — cannot create WR for available unit`);
          if (!unit.vendor || unit.vendor === '--') warnings.push('No vendor assigned — WR will need vendor before submission');
          if (!unit.issue && !intent.data?.issue) warnings.push('No issue details — WR will be incomplete');
          break;
        case INTENT_TYPES.FLIP_STATE:
          if (!intent.data?.targetState) errors.push('flip_state requires data.targetState (Available or Unavailable)');
          if (intent.data?.targetState === unit.atsState) errors.push(`Unit is already ${unit.atsState}`);
          break;
        case INTENT_TYPES.SP_PUSH:
          if (context.stats.unavailable === 0) warnings.push('No unavailable units to push to SharePoint');
          break;
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERNAL: ENRICHMENT / PLANNING / EXECUTION / VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  async _enrich(intent) {
    const enriched = { ...intent };
    if (intent.unitId) {
      const unit = context.getUnit(intent.unitId);
      if (unit) {
        enriched._unit        = unit;
        enriched._unitContext = context.buildPromptContext('unit:' + intent.unitId);
        enriched._priority    = calculatePriority(unit);
      }
    }
    if (intent.type === INTENT_TYPES.SP_PUSH || intent.type === INTENT_TYPES.SEND_EMAIL) {
      enriched._fleetContext = context.buildPromptContext('summary');
    }
    return enriched;
  }

  async _plan(enriched) {
    const handler = this._handlers.get(enriched.type);
    if (handler && handler.plan) return handler.plan(enriched);
    return { steps: [{ action: enriched.type, data: enriched.data }], requiresPlaywright: false, estimatedDuration: 5000 };
  }

  async _executePlan(plan, execution) {
    const handler = this._handlers.get(execution.intent.type);
    if (handler && handler.execute) return handler.execute(plan, execution);
    this._step(execution, 'default_execute', 'No handler registered — intent recorded only');
    return { executed: false, reason: 'No handler for type: ' + execution.intent.type };
  }

  async _verify(intent, result) {
    const handler = this._handlers.get(intent.type);
    if (handler && handler.verify) return handler.verify(intent, result);
    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HANDLER REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  registerHandler(type, handler) { this._handlers.set(type, handler); }

  _registerDefaults() {
    // CLASSIFY — pure AI
    this.registerHandler(INTENT_TYPES.CLASSIFY, {
      plan: (enriched) => ({ steps: [{ action: 'ai_classify', data: enriched._unit }], requiresPlaywright: false, estimatedDuration: 10000 }),
      execute: async (plan, execution) => {
        // V-C: scrapers path updated
        const { suggestDropdowns } = require('../scrapers/orcha_ws');
        this._step(execution, 'ai_classify', 'Running AI classification...');
        return suggestDropdowns(plan.steps[0].data);
      },
      verify: (intent, result) => {
        if (!result || !result.ok) return { ok: false, reason: result?.error || 'Classification failed' };
        if (!result.primaryComponent || !result.repairStatus) return { ok: false, reason: 'Incomplete classification' };
        return { ok: true };
      },
    });

    // DEEP_SCAN — pure AI
    this.registerHandler(INTENT_TYPES.DEEP_SCAN, {
      plan: (enriched) => ({ steps: [{ action: 'deep_scan', unitIds: enriched.data?.unitIds || [] }], requiresPlaywright: false, estimatedDuration: 60000 }),
      execute: async (plan, execution) => {
        this._step(execution, 'deep_scan', `Scanning ${plan.steps[0].unitIds.length} units...`);
        return { executed: true, note: 'Deep scan delegated to deep-scan module' };
      },
      verify: () => ({ ok: true }),
    });

    // CREATE_WR — requires Playwright
    this.registerHandler(INTENT_TYPES.CREATE_WR, {
      plan: (enriched) => ({
        steps: [
          { action: 'open_aap',          url: 'https://aap-na.corp.amazon.com' },
          { action: 'navigate_to_unit',  unitId: enriched._unit?.id },
          { action: 'fill_wr_form',      data: enriched.data },
          { action: 'submit_wr' },
          { action: 'capture_confirmation' },
        ],
        requiresPlaywright: true,
        estimatedDuration: 45000,
      }),
      execute: async (plan, execution) => {
        this._step(execution, 'create_wr', 'WR creation requires Playwright — delegating...');
        return { executed: false, requiresPlaywright: true, plan: plan.steps };
      },
      verify: () => ({ ok: true }),
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  _step(execution, name, detail) {
    const step = { ts: Date.now(), name, detail };
    execution.steps.push(step);
    context.updateWorkflow(execution.workflowId, { step });
  }

  _logExecution(execution, outcome) {
    this._log.push({
      ts: Date.now(), type: execution.intent.type, unitId: execution.intent.unitId,
      outcome, steps: execution.steps.length, errors: execution.errors, warnings: execution.warnings,
      duration: Date.now() - (execution.steps[0]?.ts || Date.now()),
    });
    if (this._log.length > 100) this._log.splice(0, this._log.length - 100);
  }
}

// Singleton
const orchestrator = new Orchestrator();

module.exports = orchestrator;
module.exports.INTENT_TYPES = INTENT_TYPES;
