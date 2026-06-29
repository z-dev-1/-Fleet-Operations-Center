/**
 * vendor-bridge.js — Renderer IPC client for the Dealer Work Order Engine
 *
 * S23-8: Push listeners + typed invoke wrappers for all vendor:* channels.
 *
 * Architecture:
 *   preload.js  →  window.vendor.*  →  (here)  →  bus  →  views
 *                                               →  state.vendor.*
 *
 * Channels handled:
 *   PUSH  (main→renderer):
 *     vendor:progress      { vendor, step, ts, workflowId?, unit?, ...extras }
 *     vendor:review-ready  { workflowId, vendor, unit, altId, serviceUrl,
 *                            isDuplicate, caseNumber, caseUrl, _stubbed? }
 *     vendor:complete      { workflowId, vendor, unit, caseNumber, caseUrl,
 *                            altId, serviceUrl }
 *     vendor:error         { workflowId, vendor, unit, error, code }
 *
 *   INVOKE (renderer→main):
 *     vendor:start-paccar  { unit }  → { workflowId, altId }
 *     vendor:start-volvo   { unit }  → { workflowId, altId }
 *     vendor:approve       { workflowId, altId? }  → { ok }
 *     vendor:cancel        { workflowId }  → { ok }
 *     vendor:get-status    ()         → { active: [...] }
 *     vendor:investigate   { unit }   → InvestigationResult
 *
 * State slice (state.vendor):
 *   active   Map workflowId → { workflowId, vendor, unit, step, ts, altId?,
 *                               serviceUrl?, caseNumber?, caseUrl?,
 *                               isDuplicate?, _stubbed?, error? }
 *   lastComplete  { workflowId, vendor, unit, caseNumber, caseUrl, altId,
 *                   serviceUrl, ts } | null
 *   lastError     { workflowId, vendor, unit, error, code, ts } | null
 *
 * Bus events emitted:
 *   vendor:progress      raw progress payload
 *   vendor:review-ready  raw review-ready payload
 *   vendor:complete      raw complete payload
 *   vendor:error         raw error payload
 */

import bus   from './bus.js';
import state from './state.js';

// ── Internal state map (keyed by workflowId) ──────────────────────────────
// We keep a live Map (not in state._state) for O(1) lookups.
// Snapshots are pushed to state.vendor for views to read reactively.
const _workflows = new Map();

function _snap() {
  return {
    active:      Object.fromEntries(_workflows),
    lastComplete: state.slice('vendor').lastComplete || null,
    lastError:    state.slice('vendor').lastError    || null,
  };
}

function _flush() {
  state.update('vendor', { active: Object.fromEntries(_workflows) });
}

// ── Push listener helpers ─────────────────────────────────────────────────

function _onProgress(p) {
  const id = p.workflowId;
  if (id) {
    const existing = _workflows.get(id) || {};
    _workflows.set(id, { ...existing, ...p });
    _flush();
  }
  bus.emit('vendor:progress', p);
}

function _onReviewReady(p) {
  const id = p.workflowId;
  if (id) {
    const existing = _workflows.get(id) || {};
    _workflows.set(id, { ...existing, ...p, step: 'review-ready' });
    _flush();
  }
  bus.emit('vendor:review-ready', p);
}


// S24-5: accumulate per-unit workflow history (max 10 entries)
const HISTORY_MAX = 10;
function _pushHistory(unitId, entry) {
  if (!unitId) return;
  const v    = state.slice("vendor");
  const hist = v.history || {};
  const arr  = (hist[unitId] || []).slice();
  arr.unshift(entry);
  if (arr.length > HISTORY_MAX) arr.length = HISTORY_MAX;
  hist[unitId] = arr;
  state.update("vendor", { history: hist });
  // S25-4: persist to disk after every history mutation
  if (window.vendor && window.vendor.saveHistory) {
    window.vendor.saveHistory(hist).catch(() => {});
  }
}

function _onComplete(p) {
  const id = p.workflowId;
  if (id) {
    _workflows.delete(id);
    _flush();
  }
  const record = { ...p, ts: Date.now() };
  state.update('vendor', { lastComplete: record });
  _pushHistory(p.unit, { workflowId: p.workflowId, vendor: p.vendor, outcome: "complete", caseNumber: p.caseNumber || "", caseUrl: p.caseUrl || "", ts: record.ts });
  bus.emit('vendor:complete', p);
}

function _onError(p) {
  const id = p.workflowId;
  if (id) {
    _workflows.delete(id);
    _flush();
  }
  const record = { ...p, ts: Date.now() };
  state.update('vendor', { lastError: record });
  _pushHistory(p.unit, { workflowId: p.workflowId, vendor: p.vendor, outcome: "error", error: p.error || "", ts: record.ts });
  bus.emit('vendor:error', p);
}

// ── Init: attach preload push listeners ──────────────────────────────────

/** Call once at app startup (from bridge.js init). */
export function init() {
  if (!window.vendor) {
    console.warn('[vendor-bridge] window.vendor not found — preload patch missing');
    return;
  }
  window.vendor.onProgress(   _onProgress    );
  window.vendor.onReviewReady(_onReviewReady );
  window.vendor.onComplete(   _onComplete    );
  window.vendor.onError(      _onError       );

  // S25-4: rehydrate history from disk so chips survive reloads
  if (window.vendor.loadHistory) {
    window.vendor.loadHistory().then((res) => {
      if (res && res.history && typeof res.history === 'object') {
        state.update('vendor', { history: res.history });
        console.log('[vendor-bridge] history rehydrated:', Object.keys(res.history).length, 'units');
      }
    }).catch((err) => console.warn('[vendor-bridge] history load failed:', err.message));
  }
}

// ── Typed invoke wrappers ─────────────────────────────────────────────────

export const vendor = {
  /**
   * Pre-flight check — synchronous gate in main.
   * Returns InvestigationResult before any async work starts.
   * @param {object} unit  fleet unit record
   * @returns {Promise<InvestigationResult>}
   */
  investigate: (unit) =>
    window.vendor.investigate(unit),

  /**
   * Start a PACCAR (Kenworth / Peterbilt) workflow.
   * Returns immediately with { workflowId, altId } — portal work is async.
   * Progress arrives via bus events (vendor:progress / vendor:review-ready).
   * @param {object} unit  fleet unit record
   * @returns {Promise<{ workflowId: string, altId: string }>}
   */
  startPaccar: (unit) =>
    window.vendor.startPaccar(unit),

  /**
   * Start a Volvo / ASIST workflow.
   * @param {object} unit  fleet unit record
   * @returns {Promise<{ workflowId: string, altId: string }>}
   */
  startVolvo: (unit) =>
    window.vendor.startVolvo(unit),

  /**
   * Approve a workflow that is sitting at review-ready.
   * @param {string} workflowId
   * @param {string} [altId]  Corrected Alt ID from operator (optional)
   * @returns {Promise<{ ok: boolean }>}
   */
  approve: (workflowId, altId) =>
    window.vendor.approve(workflowId, altId),

  /**
   * Cancel / abort a workflow at any stage.
   * @param {string} workflowId
   * @returns {Promise<{ ok: boolean }>}
   */
  cancel: (workflowId) =>
    window.vendor.cancel(workflowId),

  /**
   * Snapshot of all currently active workflows.
   * @returns {Promise<{ active: Array<{workflowId,vendor,unit,startedAt,step}> }>}
   */
  getStatus: () =>
    window.vendor.getStatus(),

  // ── Local state helpers (no IPC cost) ──────────────────────────────────

  /** Return the live workflow entry for workflowId, or null. */
  getWorkflow: (workflowId) =>
    _workflows.get(workflowId) || null,

  /** Return all live workflow entries as an array. */
  listActive: () =>
    Array.from(_workflows.values()),

  /**
   * Open a portal URL in the system browser.
   * Used by vendor-review-modal for Reopen portal and View duplicate case links.
   * @param {string} url
   * @returns {Promise<void>}
   */
  openPortalUrl: (url) =>
    window.vendor.openPortalUrl(url).catch(() => {}),
};
