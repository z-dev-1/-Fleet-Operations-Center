'use strict';
// extractors/office.js — worker only. DOCX (mammoth), PPTX (jszip <a:t> scan),
// XLSX/XLSM/XLS/ODS (SheetJS). ZIP containers are already vet-checked by
// extract.verifyZip before these run. Failures return REASONS keys + errCode.

const { LIMITS } = require('../constants');
const { errTag } = require('../log-safe');

function _ok(kind, text, extra) {
  let t = String(text || '');
  let truncated = !!(extra && extra.truncated);
  if (t.length > LIMITS.RAW_TEXT_MAX_CHARS) { t = t.slice(0, LIMITS.RAW_TEXT_MAX_CHARS); truncated = true; }
  return Object.assign({ ok: true, kind, text: t, truncated }, extra || {}, { truncated });
}

async function extractDocx(buf, ctx, deps) {
  const mammoth = (deps && deps.mammoth) || require('mammoth');
  try {
    const r = await mammoth.extractRawText({ buffer: buf });
    const text = String((r && r.value) || '').trim();
    return text ? _ok('docx', text) : { ok: false, kind: 'docx', reason: 'EMPTY' };
  } catch (e) {
    return { ok: false, kind: 'docx', reason: 'DOCX_FAILED', errCode: errTag(e) };
  }
}

// Linear <a:t>…</a:t> scan (indexOf only), XML entities decoded.
function _atText(xml) {
  const parts = [];
  let i = 0;
  while (i < xml.length) {
    const open = xml.indexOf('<a:t', i);
    if (open === -1) break;
    const next = xml.charCodeAt(open + 4);
    const gt = xml.indexOf('>', open);
    if (gt === -1) break;
    if (next !== 62 && next !== 32) { i = gt + 1; continue; }        // <a:tbl etc.
    if (xml.charCodeAt(gt - 1) === 47) { i = gt + 1; continue; }     // self-closing
    const close = xml.indexOf('</a:t>', gt);
    if (close === -1) break;
    parts.push(xml.slice(gt + 1, close));
    i = close + 6;
  }
  return require('../extract').decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

async function extractPptx(buf, ctx, deps) {
  const JSZip = (deps && deps.jszip) || require('jszip');
  try {
    const zip = await JSZip.loadAsync(buf);
    const bynum = (re) => Object.keys(zip.files)
      .map((n) => { const m = n.match(re); return m ? { n, num: parseInt(m[1], 10) } : null; })
      .filter(Boolean).sort((a, b) => a.num - b.num);
    const slides = bynum(/^ppt\/slides\/slide(\d+)\.xml$/);
    const notes = new Map(bynum(/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/).map((x) => [x.num, x.n]));
    const used = slides.slice(0, LIMITS.PPTX_MAX_SLIDES);
    const out = [];
    let len = 0;
    let truncated = slides.length > used.length;
    for (const s of used) {
      if (ctx && ctx.cancelled) break;
      let t = _atText(await zip.file(s.n).async('string'));
      const nn = notes.get(s.num);
      if (nn) {
        const nt = _atText(await zip.file(nn).async('string'));
        if (nt) t += (t ? '\n' : '') + 'Notes: ' + nt;
      }
      const block = '## Slide ' + s.num + '\n' + t;
      out.push(block);
      len += block.length;
      if (len > LIMITS.RAW_TEXT_MAX_CHARS) { truncated = true; break; }
    }
    const text = out.join('\n\n');
    return text.replace(/## Slide \d+\n?/g, '').trim() ? _ok('pptx', text, { truncated, meta: { slides: slides.length } }) : { ok: false, kind: 'pptx', reason: 'EMPTY' };
  } catch (e) {
    return { ok: false, kind: 'pptx', reason: 'PPTX_FAILED', errCode: errTag(e) };
  }
}

async function extractSheet(buf, kind, ctx, deps) {
  const XLSX = (deps && deps.xlsx) || require('xlsx');
  try {
    const wb = XLSX.read(buf, { type: 'buffer', sheetRows: LIMITS.SHEET_ROWS, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false, dense: true });
    const names = (wb.SheetNames || []).slice(0, LIMITS.SHEET_MAX);
    const out = [];
    let rowsCut = false;
    for (const name of names) {
      if (ctx && ctx.cancelled) break;
      const ws = wb.Sheets[name];
      if (!ws) continue;
      if (ws['!fullref'] && ws['!ref'] && ws['!fullref'] !== ws['!ref']) rowsCut = true;
      out.push('## Sheet: ' + name + '\n' + XLSX.utils.sheet_to_csv(ws, { blankrows: false }).trim());
    }
    const truncated = rowsCut || (wb.SheetNames || []).length > names.length;
    const text = out.join('\n\n');
    if (!text.replace(/## Sheet: [^\n]*\n?/g, '').trim()) return { ok: false, kind, reason: 'EMPTY' };
    return _ok(kind, text, { truncated, meta: { sheets: (wb.SheetNames || []).length, note: rowsCut ? 'SHEET_ROWS_CUT' : undefined } });
  } catch (e) {
    return { ok: false, kind, reason: 'SHEET_FAILED', errCode: errTag(e) };
  }
}

module.exports = { extractDocx, extractPptx, extractSheet };
