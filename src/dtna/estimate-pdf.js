'use strict';
/**
 * src/dtna/estimate-pdf.js — text from a DTNA estimate PDF, plus best-effort line items and totals.
 *
 * Dealer PDFs are untrusted: the text is extracted by the isolated Just-Me extraction worker
 * (src/justme-context/extract-host.js createWorkerSession: an Electron utilityProcess running pdfjs, with
 * a parse timeout, an RSS cap and kill on overrun). No parser library is loaded in this process.
 * Scanned PDFs (no text layer) are status 'scanned' with no OCR / vision. Nothing here logs the text,
 * the file name or any amount.
 */
const C = require('./constants');

function _str(v) { return v == null ? '' : String(v); }

/**
 * openExtractor(deps) -> { extract(buffer, name) -> Promise<{ ok, status:'read'|'scanned'|'failed', text, truncated, fullText?, pages?, code? }>, close() }
 * text is clipped to ATTACHMENT_TEXT_MAX (what is stored); fullText is the worker's text (its own
 * RAW_TEXT_MAX_CHARS cap) for parseEstimateText only, so a grand total past the clip is still found.
 * fullText is never stored, logged or returned further.
 * deps: passed to createWorkerSession (tests: spawnWorker). The caller MUST close() in a finally.
 */
function openExtractor(deps) {
  const { createWorkerSession } = require('../justme-context/extract-host');
  const session = createWorkerSession(deps || {});
  async function extract(buffer, name) {
    let reply;
    try {
      reply = await session.extract({ name: _str(name).slice(0, 120) || 'estimate.pdf', mimetype: 'application/pdf', buffer }, { kind: 'pdf' });
    } catch (_) {
      reply = { ok: false, reason: 'PARSE_FAILED', text: '' };
    }
    const pages = reply && reply.meta && Number.isFinite(reply.meta.pages) ? reply.meta.pages : undefined;
    const clip = (t) => {
      const s = _str(t);
      return s.length > C.ATTACHMENT_TEXT_MAX ? { text: s.slice(0, C.ATTACHMENT_TEXT_MAX), truncated: true } : { text: s, truncated: !!(reply && reply.truncated) };
    };
    const code = (reason) => 'DTNA_PDF_' + (_str(reason).replace(/[^A-Z0-9_]/g, '').slice(0, 30) || 'FAILED');
    let out;
    if (!reply || !reply.ok) out = { ok: false, status: 'failed', text: '', truncated: false, code: code(reply && reply.reason) };
    else if (reply.needsVision && reply.reason === 'PDFJS_UNAVAILABLE') out = { ok: false, status: 'failed', text: '', truncated: false, code: 'DTNA_PDF_READER_UNAVAILABLE' };
    else if (reply.needsVision) {
      const full = _str(reply.text).trim();
      const c = clip(full);
      out = { ok: true, status: 'scanned', text: c.text, truncated: false, fullText: full };
    } else if (!_str(reply.text).trim()) out = { ok: true, status: 'scanned', text: '', truncated: false, fullText: '' };
    else {
      const c = clip(reply.text);
      out = { ok: true, status: 'read', text: c.text, truncated: c.truncated, fullText: _str(reply.text) };
    }
    if (pages !== undefined) out.pages = pages;
    return out;
  }
  return { extract, close: () => { try { session.close(); } catch (_) { /* already gone */ } } };
}

// ── Parsing (pure) ─────────────────────────────────────────────────────────
const AMT = '\\$?\\s?((?:\\d{1,3}(?:,\\d{3})+|\\d+)\\.\\d{2})(?!\\d)';
const AMT_RE = new RegExp(AMT, 'g');
// Labelled grand totals, strongest first. Each is followed (same line or next token) by an amount.
const TOTAL_LABELS = [
  /grand\s+total/i,
  /estimate\s+total|total\s+estimate|total\s+amount|total\s+due|invoice\s+total/i,
];
const PARTS_LABEL = /parts\s+(?:sub)?total|total\s+parts/i;
const LABOR_LABEL = /labou?r\s+(?:sub)?total|total\s+labou?r/i;
const NOT_ITEM_RE = /\b(sub\s*-?total|total|tax|taxes|balance|deposit|discount)\b/i;
const LABOR_RE = /labou?r|\bhrs?\b|hours/i;
const PART_RE = /\b[Pp]arts?\b|[Pp]\/[Nn]|[A-Z0-9]{2,}-[A-Z0-9-]{2,}/;
// Up to 2 trailing word-only columns (<= 12 letters each) after a line item's amount.
const TRAIL_RE = /(?:\s+[A-Za-z]{1,12}){1,2}$/;

function _num(s) {
  const n = Math.round(Number(_str(s).replace(/,/g, '')) * 100) / 100;
  return Number.isFinite(n) ? n : null;
}

/** _labelled(text, labelRe) -> the amount after the LAST occurrence of labelRe | null. */
function _labelled(text, labelRe) {
  const re = new RegExp('(?:' + labelRe.source + ')\\s*[:\\-\\u2013]?\\s*' + AMT, 'gi');
  let m;
  let last = null;
  while ((m = re.exec(text)) !== null) {
    const n = _num(m[1]);
    if (n != null && n > 0) last = n;
  }
  return last;
}

/**
 * parseEstimateText(text) -> { total, totalLabeled, partsTotal, laborTotal, lineItems:[{ desc, amount, kind }] }
 * total: the amount after the strongest grand-total label (last occurrence wins); null when no labelled
 * total exists (an unlabelled largest amount is never reported as the total).
 */
function parseEstimateText(text) {
  const t = _str(text).slice(0, 200000);
  let total = null;
  for (const label of TOTAL_LABELS) {
    total = _labelled(t, label);
    if (total != null) break;
  }
  const lineItems = [];
  for (const raw of t.split(/\r?\n/)) {
    if (lineItems.length >= C.ESTIMATE_LINE_ITEMS_MAX) break;
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || NOT_ITEM_RE.test(line)) continue;
    // The amount may be followed by up to TRAIL_MAX short word columns (status / taxable flag / unit), as in
    // the live dealer layout ('... $245.10 Pending'); those columns are dropped.
    const head = line.replace(TRAIL_RE, '');
    const amts = head.match(AMT_RE);
    if (!amts) continue;
    const lastAmt = amts[amts.length - 1];
    if (!head.endsWith(lastAmt.trim())) continue;
    const m = new RegExp(AMT).exec(lastAmt);
    const amount = m ? _num(m[1]) : null;
    if (amount == null) continue;
    const desc = head.slice(0, head.length - lastAmt.trim().length).replace(/[\s$:\-]+$/, '').trim().slice(0, 120);
    if (!desc) continue;
    const kind = LABOR_RE.test(desc) ? 'labor' : (PART_RE.test(desc) ? 'part' : 'other');
    lineItems.push({ desc, amount, kind });
  }
  return {
    total,
    totalLabeled: total != null,
    partsTotal: _labelled(t, PARTS_LABEL),
    laborTotal: _labelled(t, LABOR_LABEL),
    lineItems,
  };
}

const ESTIMATE_NAME_RE = /estimate|\bE\d{6,}|\bR\d{6,}|quote|invoice/i;
/** isEstimateName(name) -> the file name looks like an estimate / revision / invoice (ranking only). */
function isEstimateName(name) { return ESTIMATE_NAME_RE.test(_str(name)); }

module.exports = { openExtractor, parseEstimateText, isEstimateName };
