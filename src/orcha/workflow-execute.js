'use strict';
/**
 * workflow-execute.js — Workflow Intelligence Execution Engine [Phase 8, Phase 4]
 *
 * Replays a recorded workflow's steps in a BrowserWindow:
 *   - navigate → loadURL
 *   - click    → executeJavaScript (querySelector + click)
 *   - input    → executeJavaScript (querySelector + set value + dispatch input event)
 *   - wait     → setTimeout
 *   - assert   → executeJavaScript (verify element exists/text)
 *
 * Design:
 *   - Each step has a configurable timeout (default 10s)
 *   - Progress emitted after each step via ctx.send('wi:execution-progress', {...})
 *   - On failure: logs error, stops execution, returns partial result
 *   - Window is always destroyed at the end (success or failure)
 *   - Variables in selectors/values are resolved from workflow.variables + runtime context
 *
 * Usage (from IPC handler):
 *   const { executeWorkflow } = require('../orcha/workflow-execute');
 *   const result = await executeWorkflow(workflow, { ctx, unitId, variables });
 */

const { BrowserWindow } = require('electron');
const store  = require('../store');
const logger = require('../utils/logger')('workflow-execute');

const STEP_TIMEOUT_MS     = 15000;  // per-step timeout
const PAGE_SETTLE_MS      = 2000;   // wait after navigation for page to settle
const MAX_EXECUTION_LOG   = 200;

/**
 * executeWorkflow(workflow, opts)
 * @param {object} workflow - Saved workflow recording { id, name, steps, variables, ... }
 * @param {object} opts     - { ctx, unitId, variables, partition }
 * @returns {object} { success, stepsCompleted, totalSteps, errors, duration }
 */
async function executeWorkflow(workflow, opts = {}) {
  const { ctx, unitId, variables } = opts;
  const partition = opts.partition || '';
  const startTime = Date.now();
  const steps     = workflow.steps || [];
  const vars      = { ...(workflow.variables || {}), ...(variables || {}), unitId: unitId || '' };
  const results   = [];
  const errors    = [];

  logger.info(`[WI-Exec] Starting workflow "${workflow.name}" (${workflow.id}) — ${steps.length} steps`);

  if (!steps.length) {
    return { success: false, stepsCompleted: 0, totalSteps: 0, errors: ['Workflow has no steps'], duration: 0 };
  }

  // Create execution window
  let win = null;
  try {
    win = new BrowserWindow({
      width: 1200, height: 800,
      show: false,
      skipTaskbar: true,
      title: 'Workflow: ' + workflow.name,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition }
    });
  } catch (e) {
    return { success: false, stepsCompleted: 0, totalSteps: steps.length, errors: ['Failed to create window: ' + e.message], duration: 0 };
  }

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 1;

      // Emit progress
      if (ctx && ctx.send) {
        ctx.send('wi:execution-progress', {
          workflowId: workflow.id,
          step: stepNum,
          total: steps.length,
          action: step.type || step.action || 'unknown',
          status: 'running',
        });
      }

      try {
        const result = await _executeStep(win, step, vars);
        results.push({ step: stepNum, action: step.type || step.action, ok: true, ...result });
        logger.info(`[WI-Exec] Step ${stepNum}/${steps.length} OK: ${step.type || step.action}`);
      } catch (e) {
        const error = `Step ${stepNum} (${step.type || step.action}) failed: ${e.message}`;
        errors.push(error);
        results.push({ step: stepNum, action: step.type || step.action, ok: false, error: e.message });
        logger.warn(`[WI-Exec] Step ${stepNum}/${steps.length} FAILED: ${e.message}`);
        break; // Stop on first failure
      }
    }
  } finally {
    // Always destroy window
    try { if (win && !win.isDestroyed()) win.destroy(); } catch (_) {}
  }

  const duration = Date.now() - startTime;
  const success  = errors.length === 0;
  const stepsCompleted = results.filter(r => r.ok).length;

  // Log execution
  _logExecution(workflow, { success, stepsCompleted, totalSteps: steps.length, errors, duration, unitId });

  // Update workflow stats
  _updateStats(workflow.id, { success, duration });

  // Emit completion
  if (ctx && ctx.send) {
    ctx.send('wi:execution-progress', {
      workflowId: workflow.id,
      step: steps.length,
      total: steps.length,
      status: success ? 'complete' : 'failed',
      duration,
      errors,
    });
  }

  logger.info(`[WI-Exec] Workflow "${workflow.name}" ${success ? 'COMPLETE' : 'FAILED'} — ${stepsCompleted}/${steps.length} steps in ${duration}ms`);
  return { success, stepsCompleted, totalSteps: steps.length, errors, duration, results };
}

// ── Step Execution ────────────────────────────────────────────────────────────

async function _executeStep(win, step, vars) {
  const type    = (step.type || step.action || '').toLowerCase();
  const timeout = step.timeout || STEP_TIMEOUT_MS;

  switch (type) {
    case 'navigate':
    case 'navigation':
      return _stepNavigate(win, _resolveVars(step.url || step.value, vars), timeout);

    case 'click':
      return _stepClick(win, _resolveVars(step.selector, vars), timeout);

    case 'input':
    case 'fill':
    case 'type':
      return _stepInput(win, _resolveVars(step.selector, vars), _resolveVars(step.value, vars), timeout);

    case 'wait':
    case 'delay':
      return _stepWait(step.duration || step.value || 2000);

    case 'assert':
    case 'check':
      return _stepAssert(win, _resolveVars(step.selector, vars), step.expected, timeout);

    case 'select':
      return _stepSelect(win, _resolveVars(step.selector, vars), _resolveVars(step.value, vars), timeout);

    default:
      logger.info(`[WI-Exec] Unknown step type "${type}" — skipping`);
      return { skipped: true, reason: 'Unknown step type: ' + type };
  }
}

async function _stepNavigate(win, url, timeout) {
  if (!url) throw new Error('navigate step has no URL');
  await Promise.race([
    win.loadURL(url),
    _timeout(timeout, 'Page load timeout: ' + url.slice(0, 80)),
  ]);
  await _sleep(PAGE_SETTLE_MS);
  return { navigatedTo: win.webContents.getURL() };
}

async function _stepClick(win, selector, timeout) {
  if (!selector) throw new Error('click step has no selector');
  const js = `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true };
  })()`;
  const result = await Promise.race([
    win.webContents.executeJavaScript(js),
    _timeout(timeout, 'Click timeout: ' + selector),
  ]);
  if (result && !result.ok) throw new Error(result.error || 'Click failed');
  await _sleep(500);
  return { clicked: selector };
}

async function _stepInput(win, selector, value, timeout) {
  if (!selector) throw new Error('input step has no selector');
  const js = `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.value = ${JSON.stringify(value || '')};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
  const result = await Promise.race([
    win.webContents.executeJavaScript(js),
    _timeout(timeout, 'Input timeout: ' + selector),
  ]);
  if (result && !result.ok) throw new Error(result.error || 'Input failed');
  await _sleep(300);
  return { filled: selector };
}

async function _stepWait(duration) {
  const ms = Math.min(parseInt(duration, 10) || 2000, 30000);
  await _sleep(ms);
  return { waited: ms };
}

async function _stepAssert(win, selector, expected, timeout) {
  if (!selector) throw new Error('assert step has no selector');
  const js = `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
    return { ok: true, text: (el.textContent || '').trim().slice(0, 200) };
  })()`;
  const result = await Promise.race([
    win.webContents.executeJavaScript(js),
    _timeout(timeout, 'Assert timeout: ' + selector),
  ]);
  if (result && !result.ok) throw new Error(result.error || 'Assert failed');
  if (expected && result.text && !result.text.includes(expected)) {
    throw new Error(`Assert failed: expected "${expected}" but got "${result.text.slice(0, 50)}"`);
  }
  return { asserted: true, text: result.text };
}

async function _stepSelect(win, selector, value, timeout) {
  if (!selector) throw new Error('select step has no selector');
  const js = `(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
    el.value = ${JSON.stringify(value || '')};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`;
  const result = await Promise.race([
    win.webContents.executeJavaScript(js),
    _timeout(timeout, 'Select timeout: ' + selector),
  ]);
  if (result && !result.ok) throw new Error(result.error || 'Select failed');
  await _sleep(300);
  return { selected: value };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _resolveVars(template, vars) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _timeout(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

function _logExecution(workflow, result) {
  try {
    const log = store.load('workflowExecutionLog', { entries: [] });
    log.entries.push({
      id: 'exec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      workflowId: workflow.id,
      workflowName: workflow.name,
      timestamp: new Date().toISOString(),
      success: result.success,
      stepsCompleted: result.stepsCompleted,
      totalSteps: result.totalSteps,
      duration: result.duration,
      errors: result.errors,
      unitId: result.unitId || null,
    });
    // Trim old entries
    if (log.entries.length > MAX_EXECUTION_LOG) {
      log.entries = log.entries.slice(-MAX_EXECUTION_LOG);
    }
    store.save('workflowExecutionLog', log);
  } catch (e) {
    logger.warn('[WI-Exec] Failed to log execution:', e.message);
  }
}

function _updateStats(workflowId, result) {
  try {
    const all = store.load('workflowRecordings', {});
    const wf  = all[workflowId];
    if (!wf || !wf.stats) return;
    wf.stats.timesExecuted = (wf.stats.timesExecuted || 0) + 1;
    if (wf.stats.avgDurationMs) {
      wf.stats.avgDurationMs = Math.round((wf.stats.avgDurationMs + result.duration) / 2);
    } else {
      wf.stats.avgDurationMs = result.duration;
    }
    const total   = wf.stats.timesExecuted;
    const prevOk  = wf.stats.successRate !== null ? Math.round(wf.stats.successRate * (total - 1) / 100) : 0;
    const newOk   = prevOk + (result.success ? 1 : 0);
    wf.stats.successRate = Math.round((newOk / total) * 100);
    wf.updatedAt = new Date().toISOString();
    store.save('workflowRecordings', all);
  } catch (e) {
    logger.warn('[WI-Exec] Failed to update workflow stats:', e.message);
  }
}

module.exports = { executeWorkflow };
