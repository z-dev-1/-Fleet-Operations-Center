/**
 * workflow-recorder.js -- In-app action capture engine [Phase 8, Phase 1]
 *
 * See docs/PHASE8_WORKFLOW_INTELLIGENCE_PLAN.md for the full design.
 *
 * Captures clicks/inputs/selects at the document level (capture phase) plus
 * semantic bus events already flowing through this app (ui:view-change,
 * ui:unit-select) into a WorkflowStep[] buffer, persisted step-by-step via
 * the workflowIntel IPC bridge (src/ipc/workflow-intel.js).
 *
 * This module owns NO UI -- renderer/src/js/components/workflow-recorder-hud.js
 * is the visual control surface and is the only thing that should call
 * start()/pause()/resume()/stop()/discard() directly.
 *
 * Scope note: this file covers IN-APP capture only. External-site capture
 * (Relay Garage, PACCAR, ASIST, Outlook, Slack, SharePoint popup windows) is
 * src/window/action_capture.js -- a separate, not-yet-built main-process
 * module, per the phased rollout in the design doc (§10).
 */

import bus            from './bus.js';
import { workflowIntel } from './bridge.js';
import state from './state.js';

// -- Elements the recorder must never record clicks on (its own HUD controls,
//    toasts, and the Orcha FAB/panel -- those are meta-UI, not the workflow) --
const IGNORE_SELECTOR = '[data-wi-ignore], .wi-hud, #toast-container, .toast, #orcha-fab, #orcha-panel';

const MAX_STEPS = 500; // mirrors MAX_STEPS_PER_SESSION in ipc/workflow-intel.js

let _sessionId   = null;
let _status      = 'idle'; // 'idle' | 'recording' | 'paused'
let _stepCount   = 0;
let _startedAt   = null;
let _clickHandler  = null;
let _changeHandler = null;
let _busUnsubs      = [];

// -- Resilient selector builder (same strategy family as aap_autofill_engine.js's
//    multi-fallback approach: id -> data-* -> class+nth-of-type) --------------
function _selectorFor(el) {
  if (!el || el === document || el === document.body) return 'body';
  if (el.id) return '#' + el.id;

  if (el.dataset) {
    const keys = Object.keys(el.dataset);
    if (keys.length) {
      const k = keys[0];
      const v = el.dataset[k];
      return `[data-${k}="${v}"]`;
    }
  }

  const tag = el.tagName ? el.tagName.toLowerCase() : 'div';
  const cls = el.className && typeof el.className === 'string'
    ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
    : '';

  // nth-of-type fallback among same-tag siblings for uniqueness
  let nth = '';
  if (el.parentElement) {
    const siblings = Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName);
    if (siblings.length > 1) nth = `:nth-of-type(${siblings.indexOf(el) + 1})`;
  }
  return tag + cls + nth;
}

function _isSensitiveField(el) {
  if (!el) return false;
  if ((el.type || '').toLowerCase() === 'password') return true;
  const name = ((el.name || '') + ' ' + (el.id || '')).toLowerCase();
  return name.includes('password') || name.includes('secret') || name.includes('token');
}

function _labelFor(el) {
  return (el && (el.getAttribute('aria-label') || el.title || el.textContent || '')).trim().slice(0, 60);
}

async function _pushStep(step) {
  if (_status !== 'recording' || !_sessionId) return;
  if (_stepCount >= MAX_STEPS) {
    bus.emit('ui:toast', { type: 'warning', message: `Recording hit the ${MAX_STEPS}-step cap -- stop and save.` });
    return;
  }
  try {
    const res = await workflowIntel.recordStep(_sessionId, step);
    if (res && typeof res.count === 'number') _stepCount = res.count;
    else _stepCount++;
    bus.emit('wi:recording-step', { sessionId: _sessionId, count: _stepCount, step });
  } catch (e) {
    console.warn('[workflow-recorder] record-step failed:', e.message);
  }
}

// -- DOM capture handlers ------------------------------------------------------

function _onClick(e) {
  if (_status !== 'recording') return;
  const el = e.target.closest && e.target.closest(IGNORE_SELECTOR);
  if (el) return; // ignore clicks on meta-UI (HUD, toasts, Orcha FAB)

  const target = e.target.closest('button, a, [role="button"], input[type="checkbox"], input[type="radio"], select, td, tr, li') || e.target;
  // Selects/checkboxes fire their own semantic 'change' step -- skip the raw click here.
  if (target.tagName === 'SELECT') return;

  _pushStep({
    type: 'click',
    app: 'internal',
    selector: _selectorFor(target),
    label: _labelFor(target),
  });
}

function _onChange(e) {
  if (_status !== 'recording') return;
  const el = e.target;
  if (el.closest && el.closest(IGNORE_SELECTOR)) return;

  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'select') {
    _pushStep({
      type: 'select',
      app: 'internal',
      selector: _selectorFor(el),
      value: el.value,
      label: _labelFor(el),
    });
    return;
  }

  if (tag === 'input' || tag === 'textarea') {
    const sensitive = _isSensitiveField(el);
    _pushStep({
      type: 'type',
      app: 'internal',
      selector: _selectorFor(el),
      value: sensitive ? undefined : el.value,
      sensitive,
      fieldType: (el.type || 'text').toLowerCase(),
      label: _labelFor(el),
    });
  }
}

// -- Semantic bus events (richer than raw DOM -- these already carry meaning) --

function _wireSemanticEvents() {
  _busUnsubs.push(bus.on('ui:view-change', ({ to }) => {
    _pushStep({ type: 'navigate', app: 'internal', selector: 'view:' + to, value: to, label: 'Switched to ' + to });
  }));
  _busUnsubs.push(bus.on('ui:unit-select', ({ unit }) => {
    if (unit && unit.equipmentId) {
      _pushStep({ type: 'search', app: 'internal', selector: 'unit:' + unit.equipmentId, value: unit.equipmentId, label: 'Selected unit ' + unit.equipmentId });
    }
  }));
}

function _unwireSemanticEvents() {
  _busUnsubs.forEach(unsub => { try { unsub(); } catch (_) {} });
  _busUnsubs = [];
}

// -- Trigger-context capture (Phase 2 mining signal) ---------------------------
// Best-effort snapshot of "what situation was this recording made in" --
// pulled from whichever unit is selected in the fleet view at record-start
// time. Absent a selected unit, this returns {} and the recording simply
// carries no mining signal (workflow-learn.js skips signature-less recordings).
function _captureTriggerContext() {
  try {
    const unit = state.slice('ui').selectedUnit;
    if (!unit) return {};
    return {
      unitId: unit.equipmentId || null,
      make: unit.make || '',
      vendor: unit.vendor || '',
      component: unit.savedPrimaryComponent || unit.primaryComponent || '',
      lifecycleReason: unit.lifecycleReason || '',
      domicile: unit.domicileSite || '',
      issueKeyword: (unit.issueSummary || unit.issueDetails || '').slice(0, 80),
    };
  } catch (_) {
    return {};
  }
}

// -- Public API ----------------------------------------------------------------

export function getStatus() {
  return { status: _status, sessionId: _sessionId, stepCount: _stepCount, startedAt: _startedAt };
}

export async function start(meta) {
  if (_status !== 'idle') throw new Error('A recording is already in progress');
  // Auto-capture trigger context from whatever unit is selected right now
  // (Phase 2 pattern mining needs a "situation" to group recordings by --
  // see src/orcha/workflow-learn.js). Explicit meta.triggerContext wins if given.
  const auto = _captureTriggerContext();
  const mergedMeta = { ...(meta || {}), triggerContext: { ...auto, ...((meta || {}).triggerContext || {}) } };
  const res = await workflowIntel.startRecording(mergedMeta);
  _sessionId = res.id;
  _startedAt = res.startedAt;
  _stepCount = 0;
  _status = 'recording';

  document.addEventListener('click', _onClick, true);
  document.addEventListener('change', _onChange, true);
  _wireSemanticEvents();

  bus.emit('wi:recording-started', { sessionId: _sessionId, startedAt: _startedAt });
  return { sessionId: _sessionId, startedAt: _startedAt };
}

export function pause() {
  if (_status !== 'recording') return;
  _status = 'paused';
  bus.emit('wi:recording-paused', { sessionId: _sessionId });
}

export function resume() {
  if (_status !== 'paused') return;
  _status = 'recording';
  bus.emit('wi:recording-resumed', { sessionId: _sessionId });
}

function _teardown() {
  document.removeEventListener('click', _onClick, true);
  document.removeEventListener('change', _onChange, true);
  _unwireSemanticEvents();
  _sessionId = null;
  _startedAt = null;
  _stepCount = 0;
  _status = 'idle';
}

export async function stop(finalMeta) {
  if (_status === 'idle' || !_sessionId) throw new Error('No active recording to stop');
  const sessionId = _sessionId;
  const saved = await workflowIntel.stopRecording(sessionId, finalMeta || {});
  _teardown();
  bus.emit('wi:recording-stopped', { workflow: saved });
  return saved;
}

export async function discard() {
  if (_status === 'idle' || !_sessionId) return;
  const sessionId = _sessionId;
  try { await workflowIntel.discardRecording(sessionId); }
  finally {
    _teardown();
    bus.emit('wi:recording-discarded', { sessionId });
  }
}
