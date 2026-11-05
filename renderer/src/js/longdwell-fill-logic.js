// ============================================================================
// longdwell-fill-logic.js — pure logic for the durable Long Dwell AI Fill
// (jobs.longDwellAiFill.durable). No DOM and no window access at import time;
// the views (analytics.js computed table, longdwell-csv.js imported table)
// supply the bridge and the per-unit AI call.
//
// Main (long-dwell-ai:* IPC) is the arbiter: it plans which units to fill or
// skip, commits each result atomically with provenance, and runs the job
// ledger. This module drives that protocol from the renderer:
//   plan -> for each toFill unit: unit-start, fillOne, commit, onUnitDone -> finish
// ============================================================================

import { _sourceContextForRow } from './longdwell-ai.js';

// 53-bit string hash (cyrb53), returned in base 36 (<= 11 chars).
function _hash53(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Fingerprint of the AI-fill prompt inputs for one row: the source context
// block plus vendor / domicile / operator / lifecycle reason. Days-down and
// today's date are deliberately NOT part of it (they change every day).
export function fillFingerprint(promptRow) {
  const row = promptRow || {};
  const parts = [
    _sourceContextForRow(row),
    row.vendor || '',
    row.domicileSite || row.domicile || '',
    row.operator || '',
    row.lifecycleReason || '',
  ].map((v) => String(v));
  return _hash53(parts.join('\u241F'));
}

function _n(v) { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; }

// "12 skipped (already filled today), 5 filled" (+ non-zero extras in order:
// kept from an earlier day, edited by you, already has content, failed).
export function fillSummaryText(counts) {
  const c = counts || {};
  const parts = [_n(c.filledToday) + ' skipped (already filled today)', _n(c.filled) + ' filled'];
  if (_n(c.priorDay)) parts.push(_n(c.priorDay) + ' kept (filled on an earlier day)');
  const edited = _n(c.edited) + _n(c.editedDuringRun);
  if (edited) parts.push(edited + ' skipped (edited by you)');
  if (_n(c.hasContent)) parts.push(_n(c.hasContent) + ' skipped (already has content)');
  if (_n(c.failed)) parts.push(_n(c.failed) + ' failed');
  return parts.join(', ');
}

export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// "✨ filled 14:32" badge for a filled-today record ({ filledAt }).
export function filledBadgeHtml(rec) {
  const t = _hhmm(rec && rec.filledAt);
  const label = '\u2728 filled' + (t ? ' ' + t : '');
  const title = 'AI-filled today' + (t ? ' at ' + t : '') + '; AI Fill All skips it unless its data changes or you edit it';
  return `<span class="ld-fill-badge" title="${escHtml(title)}">${escHtml(label)}</span>`;
}

// Status line text: "<last run summary> · filled today: N".
export function fillStatusText(summary, filledToday) {
  const tail = 'filled today: ' + _n(filledToday);
  return summary ? summary + ' \u00b7 ' + tail : tail;
}

export function fillStatusHtml(id, summary, filledToday) {
  return `<span id="${escHtml(id)}" class="ld-fill-status" role="status" aria-live="polite">${escHtml(fillStatusText(summary, filledToday))}</span>`;
}

// Unit identity sent to main (computed: equipmentId/woKey/isPrimary; csv: assetId/site).
const UNIT_FIELDS = ['key', 'fp', 'equipmentId', 'woKey', 'isPrimary', 'assetId', 'site'];
function _unitOf(c) {
  const u = {};
  for (const f of UNIT_FIELDS) if (c[f] !== undefined) u[f] = c[f];
  return u;
}
function _safeCall(fn, ...args) { try { if (typeof fn === 'function') fn(...args); } catch (_) { /* UI callback */ } }

// Drives one durable fill run. Returns:
//   { legacy:true }                         — durable mode is off: caller runs the legacy loop
//   { ok:true, busy:true, message }         — a run is already live for this table: nothing filled
//   { ok:true, runId, resumed, counts, summary, plan }
//   { ok:false, aborted:true, error, counts } — unexpected loop error (finish({aborted:true}) sent)
//   { ok:false, error }                     — plan rejected
// fillOne(candidate, { index, total }) resolves to { delayReason, escalation, summary, fp? }
// or throws / resolves falsy for a failed unit (counted, the loop continues).
export async function runDurableFill({ table, candidates, bridge, fillOne, onProgress, onUnitDone, resume } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const byKey = new Map();
  for (const c of list) if (c && typeof c.key === 'string' && !byKey.has(c.key)) byKey.set(c.key, c);

  let plan;
  try {
    plan = await bridge.plan({ table, resume: resume === true, units: list.map(_unitOf) });
  } catch (_) {
    return { legacy: true };
  }
  if (!plan || (plan.ok === false && plan.code === 'off')) return { legacy: true };
  if (plan.ok === false) return { ok: false, error: plan.error || plan.code || 'plan failed' };
  if (plan.busy) return { ok: true, busy: true, message: 'AI Fill is already running', counts: plan.counts || {} };

  const runId = plan.runId;
  const toFill = Array.isArray(plan.toFill) ? plan.toFill : [];
  const counts = Object.assign({ filled: 0, failed: 0, editedDuringRun: 0, notFound: 0 }, plan.counts || {});
  const total = toFill.length;
  const filledKeys = new Set();
  let done = 0;
  try {
    for (const item of toFill) {
      const key = item && item.key;
      if (filledKeys.has(key)) continue;          // never fillOne twice for a key
      filledKeys.add(key);
      const cand = byKey.get(key) || { key, fp: '' };
      _safeCall(onProgress, { done, total, key, candidate: cand });
      await bridge.unitStart({ runId, key });
      let out = null;
      try { out = await fillOne(cand, { index: done, total }); } catch (_) { out = null; }
      const ok = !!(out && typeof out === 'object');
      const payload = Object.assign({}, _unitOf(cand), {
        runId, table, key,
        fp: (ok && typeof out.fp === 'string' && out.fp) ? out.fp : String(cand.fp || ''),
        result: ok
          ? { delayReason: String(out.delayReason || ''), escalation: String(out.escalation || ''), summary: String(out.summary || '') }
          : { delayReason: '', escalation: '', summary: '' },
      });
      if (!ok) payload.failed = true;
      const res = await bridge.commit(payload);
      if (res && res.ok) {
        if (res.outcome === 'filled') counts.filled++;
        else if (res.outcome === 'failed') counts.failed++;
        else if (res.reason === 'edited-during-run') counts.editedDuringRun++;
        else if (res.reason === 'not-found') counts.notFound++;
      } else {
        counts.failed++;
        if (res && res.code === 'unknown-run') throw new Error('run is no longer active');
      }
      done++;
      _safeCall(onUnitDone, cand, res || null);
      _safeCall(onProgress, { done, total, key, candidate: cand });
    }
  } catch (e) {
    const error = String((e && e.message) || e || 'aborted');
    try { await bridge.finish({ runId, aborted: true, error }); } catch (_) { /* best effort */ }
    return { ok: false, aborted: true, error, runId, counts };
  }

  let fin = null;
  try { fin = await bridge.finish({ runId }); } catch (_) { fin = null; }
  const finalCounts = fin && fin.ok && fin.counts ? fin.counts : counts;
  return { ok: true, runId, resumed: !!plan.resumed, counts: finalCounts, summary: fillSummaryText(finalCounts), plan };
}
