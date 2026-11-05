'use strict';
/**
 * longdwell/sheet-diff.js - turn matched units into preview cells and classify
 * each target cell. Only the three mapped columns (Delay Reason, Escalation
 * Level Action, Required Notes for ALL Units) ever produce a cell; Support Team
 * POC and Asana Link are never written.
 *
 * States (evaluated in this order): blocked -> no-change -> will-write -> conflict.
 *   blocked     empty-source | invalid-value | formula | merged | protected
 *               (protected only when the sheet is protected AND the target is locked)
 *   no-change   normText(current) === normText(next)
 *   will-write  current empty, next non-empty (ticked unless a confirm chip applies)
 *   conflict    current non-empty and different (never ticked by default)
 * Pure; no logging.
 */
const C = require('./sheet-columns');

function classifyCell(current, next, ctx = {}) {
  const field = ctx.fieldKey ? C.fieldByKey(ctx.fieldKey) : null;
  const n = C.normText(next);
  const cur = C.normText(current);
  if (n === '') return { state: 'blocked', reason: 'empty-source' };
  if (field && field.enum && !field.enum.includes(n)) return { state: 'blocked', reason: 'invalid-value' };
  if (ctx.formula) return { state: 'blocked', reason: 'formula' };
  if (ctx.merged) return { state: 'blocked', reason: 'merged' };
  if (ctx.protected) return { state: 'blocked', reason: 'protected' };
  if (cur === n) return { state: 'no-change', reason: null };
  if (cur === '') return { state: 'will-write', reason: null };
  return { state: 'conflict', reason: null };
}

// True when an inline dropdown list covers the cell and the text is not in it.
function validationMismatch(validation, text) {
  if (!validation || validation.kind !== 'inline' || !Array.isArray(validation.items)) return false;
  const t = C.normText(text).toLowerCase();
  return !validation.items.some((x) => C.normText(x).toLowerCase() === t);
}

// args: { units, matches (same order as units), targets: {key:{index,letter}},
//         cellInfo(row, col) -> {current, formula, merged, protected, validation} }
function buildDraft({ units, matches, targets, cellInfo }) {
  const cells = [];
  (matches || []).forEach((m, i) => {
    if (!m || m.match !== 'matched') return;
    const u = (units || [])[i] || {};
    for (const f of C.FIELD_MAP) {
      const t = targets && targets[f.key];
      if (!t) continue;
      const info = cellInfo(m.sheetRow, t.index) || {};
      const warnings = [];
      let next = C.sanitizeForCell(u[f.from]);
      if (next.length > C.MAX_CELL_CHARS) { next = next.slice(0, C.MAX_CELL_CHARS).trim(); warnings.push('clipped'); }
      const current = String(info.current == null ? '' : info.current);
      const { state, reason } = classifyCell(current, next, { fieldKey: f.key, formula: info.formula, merged: info.merged, protected: info.protected });
      if (m.needsConfirm) warnings.push('needs-confirm');
      if (m.via === 'vendor') warnings.push('vendor-match');
      if (state !== 'blocked' && validationMismatch(info.validation, next)) warnings.push('validation-mismatch');
      const selectable = state === 'will-write' || state === 'conflict';
      const defaultChecked = state === 'will-write' && !m.needsConfirm && m.via !== 'vendor' && !warnings.includes('validation-mismatch');
      cells.push({
        id: m.sheetRow + ':' + t.letter,
        equipmentId: m.equipmentId, woKey: m.woKey, sheetRow: m.sheetRow,
        column: t.letter, colIndex: t.index, header: f.header, fieldKey: f.key,
        current, next, state, reason, selectable, defaultChecked,
        editor: f.enum ? 'select' : 'textarea',
        options: f.enum ? f.enum.slice() : undefined,
        warnings,
      });
    }
  });
  return cells;
}

// Write-time decision for one working cell after the fresh download.
// args: { previewCurrent, currentNow, next, previewMatch:{sheetRow, via},
//         rematch:{match, sheetRow, via}|null, formula, merged }
function recheckCell(a) {
  const pm = a.previewMatch || {};
  const rm = a.rematch;
  if (!rm || rm.match !== 'matched' || rm.sheetRow !== pm.sheetRow || rm.via !== pm.via) {
    return { status: 'skipped', reason: 'changed-since-preview', detail: 'row-moved' };
  }
  if (a.formula) return { status: 'skipped', reason: 'formula' };
  if (a.merged) return { status: 'skipped', reason: 'merged' };
  if (C.normText(a.currentNow) !== C.normText(a.previewCurrent)) {
    return { status: 'skipped', reason: 'changed-since-preview', detail: 'value-changed' };
  }
  if (C.normText(a.currentNow) === C.normText(a.next)) return { status: 'skipped', reason: 'no-change' };
  return { status: 'patch' };
}

// Overall report status, in the style of sharepoint_push _deriveSpStatus.
// args: { gate: code|null, authFailed: bool, cells: [{status, reason, verified}] }
function deriveWriteStatus({ gate, authFailed, cells } = {}) {
  if (gate) return { status: 'blocked', ok: false };
  if (authFailed) return { status: 'auth-failed', ok: false };
  const approved = (cells || []).filter((c) => c && c.reason !== 'not-approved' && c.status !== 'conflict');
  const written = approved.filter((c) => c.status === 'written');
  const failed = approved.filter((c) => c.status === 'failed');
  const skippedOther = approved.filter((c) => c.status === 'skipped' && c.reason !== 'no-change');
  if (!written.length && !failed.length && !skippedOther.length) return { status: 'no-op', ok: true };
  if (!written.length) return { status: 'failed', ok: false };
  if (failed.length || skippedOther.length) return { status: 'partial-failure', ok: false };
  if (written.some((c) => c.verified === false)) return { status: 'verification-pending', ok: false };
  return { status: 'ok', ok: true };
}

module.exports = { classifyCell, validationMismatch, buildDraft, recheckCell, deriveWriteStatus };
