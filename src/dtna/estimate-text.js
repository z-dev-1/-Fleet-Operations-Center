'use strict';
/**
 * src/dtna/estimate-text.js — the bounded estimate-PDF context string for the unit timeline / AI context.
 * Pure: works on a dtnaCaseCache entry only (no network). Requires only ./constants.
 * The result goes onto the fleet row (row.dtnaEstimateText) and into the deep-scan / AI prompts; it is
 * never logged.
 */
const C = require('./constants');

function _str(v) { return v == null ? '' : String(v); }
function _ms(v) { const ms = v ? Date.parse(String(v)) : NaN; return Number.isFinite(ms) ? ms : 0; }
function _money(n) { return '$' + Number(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

/** readPdfs(entry) -> the entry's extracted ('read') PDF attachments, newest first (ties keep list order). */
function readPdfs(entry) {
  const list = entry && Array.isArray(entry.attachments) ? entry.attachments : [];
  return list.map((a, i) => ({ a, i }))
    .filter((x) => x.a && typeof x.a === 'object' && x.a.status === 'read' && x.a.kind === 'pdf')
    .sort((x, y) => (_ms(y.a.createdAt) - _ms(x.a.createdAt)) || (x.i - y.i))
    .map((x) => x.a);
}

/**
 * estimateContextText(entry, max) -> '' when no read PDFs, else newest-first blocks:
 *   [<name>, <date>] Grand total $X (labelled)
 *   - desc  $amount (kind)     (up to 12)
 *   <extracted text, clipped>
 * total length <= max (default ESTIMATE_CONTEXT_MAX).
 */
function estimateContextText(entry, max) {
  const cap = Number.isFinite(max) && max > 0 ? max : C.ESTIMATE_CONTEXT_MAX;
  const pdfs = readPdfs(entry);
  if (!pdfs.length) return '';
  const blocks = [];
  for (const a of pdfs) {
    const head = '[' + (_str(a.name).slice(0, 120) || 'estimate PDF') + (a.createdAt ? ', ' + _str(a.createdAt).slice(0, 10) : '') + ']';
    const lines = [];
    if (typeof a.total === 'number' && Number.isFinite(a.total)) lines.push(head + ' Grand total ' + _money(a.total) + (a.totalLabeled ? ' (labelled)' : ' (unlabelled)'));
    else lines.push(head);
    const items = Array.isArray(a.lineItems) ? a.lineItems.slice(0, 12) : [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || !Number.isFinite(it.amount)) continue;
      lines.push('- ' + _str(it.desc).slice(0, 120) + '  ' + _money(it.amount) + ' (' + _str(it.kind || 'other') + ')');
    }
    const text = _str(a.text).trim();
    if (text) lines.push(text);
    blocks.push(lines.join('\n'));
  }
  const out = blocks.join('\n\n');
  return out.length > cap ? out.slice(0, cap) : out;
}

module.exports = { estimateContextText, readPdfs };
