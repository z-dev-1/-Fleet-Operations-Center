'use strict';
/**
 * longdwell/xlsx-grid.js - read and patch the weekly Long Dwell .xlsx.
 *
 * This is the ONLY code that mutates worksheet XML for the feature, so the hard
 * invariants live here, at the lowest layer:
 *   - never columns A to M (index < 13) and never a column outside allowedCols
 *     (the resolved N/O/R target columns; P and Q are therefore impossible);
 *   - never clear a cell (empty text throws);
 *   - never add a row (a missing <row> throws; only a missing <c> is inserted);
 *   - formula and merged cells are refused.
 * selfCheck() proves on the real bytes that nothing else changed.
 *
 * Every entry read goes through readEntryCapped() (streamed inflate with a
 * running byte count), the real zip-bomb bound. Pure module: no Electron, no
 * logging, never echoes cell text in errors.
 */
const JSZip = require('jszip');
const C = require('./sheet-columns');

const MiB = 1024 * 1024;
const DEFAULT_CAPS = Object.freeze({
  maxEntries: 2000,
  entryBytes: 100 * MiB,   // inflate cap per entry (readEntryCapped)
  totalBytes: 200 * MiB,   // inflate cap for the whole workbook
  cdEntryBytes: 100 * MiB, // best-effort central-directory sanity bounds
  cdTotalBytes: 200 * MiB,
  xmlChars: 60 * 1000 * 1000,
  maxRows: 20000,
  headerScanRows: 60,
  maxBytes: 8 * MiB,
});
const MIN_TARGET_COL = 13; // N
const QUALIFY_SCORE = 14;
const CRITICAL_KEYS = ['assetId'].concat(C.TARGET_KEYS);

// ── errors (fixed messages, never built from input) ─────────────────────────
class GridError extends Error {
  constructor(code) { super('workbook: ' + code); this.name = 'GridError'; this.code = code; }
}
function _patchError(name, code, message) {
  const E = class extends Error {
    constructor() { super(message); this.name = name; this.code = code; }
  };
  Object.defineProperty(E, 'name', { value: name });
  return E;
}
const ForbiddenColumnError = _patchError('ForbiddenColumnError', 'forbidden-column', 'patch column is not an allowed target column');
const EmptyPatchError = _patchError('EmptyPatchError', 'empty-patch', 'patch text is empty');
const RowMissingError = _patchError('RowMissingError', 'row-missing', 'patch row does not exist');
const FormulaError = _patchError('FormulaError', 'formula', 'patch target holds a formula');
const MergedError = _patchError('MergedError', 'merged', 'patch target is inside a merged range');
const DuplicatePatchError = _patchError('DuplicatePatchError', 'duplicate-patch', 'two patches target the same cell');

// ── cell references ─────────────────────────────────────────────────────────
function colLetter(i) {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function parseRef(ref) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(ref || '').trim());
  return m ? { col: colIndex(m[1]), row: parseInt(m[2], 10) } : null;
}
// "A1:B2" | "A1" | "N:N" | "2:3" -> {c1,r1,c2,r2}
function parseRange(ref) {
  const s = String(ref || '').trim().replace(/\$/g, '');
  let m = /^([A-Za-z]{1,3})(\d+)(?::([A-Za-z]{1,3})(\d+))?$/.exec(s);
  if (m) {
    const c1 = colIndex(m[1]), r1 = +m[2];
    const c2 = m[3] ? colIndex(m[3]) : c1, r2 = m[4] ? +m[4] : r1;
    return { c1: Math.min(c1, c2), r1: Math.min(r1, r2), c2: Math.max(c1, c2), r2: Math.max(r1, r2) };
  }
  m = /^([A-Za-z]{1,3}):([A-Za-z]{1,3})$/.exec(s);
  if (m) return { c1: colIndex(m[1]), r1: 1, c2: colIndex(m[2]), r2: 1048576 };
  m = /^(\d+):(\d+)$/.exec(s);
  if (m) return { c1: 0, r1: +m[1], c2: 16383, r2: +m[2] };
  return null;
}
function _inRange(rg, row, col) { return rg && row >= rg.r1 && row <= rg.r2 && col >= rg.c1 && col <= rg.c2; }
function _sqref(s) { return String(s || '').split(/\s+/).filter(Boolean).map(parseRange).filter(Boolean); }

// ── XML helpers ─────────────────────────────────────────────────────────────
function parseAttrs(str) {
  const out = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(String(str || '')))) out[m[1]] = decodeXml(m[2] !== undefined ? m[2] : m[3]);
  return out;
}
function decodeXml(s) {
  return String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (all, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch (_) { return ''; }
  });
}
function decodeOoxmlEscapes(s) {
  return String(s).replace(/_x([0-9A-Fa-f]{4})_/g, (all, h) => String.fromCharCode(parseInt(h, 16)));
}
function _decodeText(raw) { return decodeOoxmlEscapes(decodeXml(raw)); }
// Concatenated <t> runs, phonetic runs (<rPh>) ignored.
function _runsText(inner) {
  const s = String(inner || '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(s))) if (m[1] !== undefined) out += _decodeText(m[1]);
  return out;
}
function escText(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
    .replace(/\n/g, '&#10;');
}
function escAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function _rootIsPrefixed(xml, local) {
  const m = new RegExp('<([A-Za-z_][\\w.-]*:)?' + local + '[\\s>/]').exec(xml);
  if (!m) return null;
  return !!m[1];
}
function _bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const _decoder = new TextDecoder('utf-8', { ignoreBOM: true });

// ── capped inflate ──────────────────────────────────────────────────────────
// Streams one entry and aborts with 'too-large' as soon as the inflated byte
// count passes maxBytes. The central-directory size field is NOT trusted.
function readEntryCapped(zip, name, maxBytes) {
  const f = zip && zip.file(name);
  if (!f) return Promise.reject(new GridError('missing-part'));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, done = false, h;
    const fail = (code) => { if (done) return; done = true; try { h && h.pause(); } catch (_) { /* ignore */ } reject(new GridError(code)); };
    try { h = f.internalStream('uint8array'); } catch (_) { fail('unsupported-workbook'); return; }
    h.on('data', (chunk) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) { fail('too-large'); return; }
      chunks.push(chunk);
    });
    h.on('error', () => fail('unsupported-workbook'));
    h.on('end', () => {
      if (done) return;
      done = true;
      const out = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      resolve(out);
    });
    h.resume();
  });
}

// Best-effort sanity check on the central-directory sizes. A missing size field
// does not reject (readEntryCapped is the real bound).
function _centralDirSanity(zip, caps) {
  let sum = 0;
  for (const name of Object.keys(zip.files || {})) {
    const f = zip.files[name];
    const u = f && f._data && f._data.uncompressedSize;
    if (typeof u !== 'number' || !Number.isFinite(u)) continue;
    if (u > caps.cdEntryBytes) throw new GridError('unsupported-workbook');
    sum += u;
    if (sum > caps.cdTotalBytes) throw new GridError('unsupported-workbook');
  }
}

function _caps(opts) { return { ...DEFAULT_CAPS, ...((opts && opts.caps) || {}) }; }
function _isPk(bytes) { return bytes && bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b; }

async function _loadZip(bytes, caps) {
  if (!_isPk(bytes)) throw new GridError('unsupported-workbook');
  let zip;
  try { zip = await JSZip.loadAsync(bytes); } catch (_) { throw new GridError('unsupported-workbook'); }
  const names = Object.keys(zip.files);
  if (names.length > caps.maxEntries) throw new GridError('unsupported-workbook');
  _centralDirSanity(zip, caps);
  return zip;
}

async function openWorkbook(bytes, opts) {
  const caps = _caps(opts);
  const zip = await _loadZip(bytes, caps);
  const names = Object.keys(zip.files);
  if (!zip.file('xl/workbook.xml')) throw new GridError('unsupported-workbook');
  if (zip.file('xl/workbook.bin') || names.some((n) => /(^|\/)EncryptedPackage$/i.test(n))) throw new GridError('unsupported-workbook');
  return { zip, caps, budget: { used: 0 }, _text: new Map(), _grids: new Map(), _styles: null, _sst: null };
}

// Reads a part as text through the capped reader, with the workbook-wide total cap.
async function _readText(wb, name, { bigXml = false, optional = false } = {}) {
  if (wb._text.has(name)) return wb._text.get(name);
  if (!wb.zip.file(name)) {
    if (optional) return null;
    throw new GridError('unsupported-workbook');
  }
  const remaining = wb.caps.totalBytes - wb.budget.used;
  if (remaining <= 0) throw new GridError('too-large');
  const bytes = await readEntryCapped(wb.zip, name, Math.min(wb.caps.entryBytes, remaining));
  wb.budget.used += bytes.length;
  const text = _decoder.decode(bytes);
  if (bigXml && text.length > wb.caps.xmlChars) throw new GridError('too-large');
  wb._text.set(name, text);
  return text;
}

function _resolveTarget(target) {
  let t = String(target || '');
  const parts = (t.startsWith('/') ? t.slice(1) : 'xl/' + t).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}

// ── tabs ────────────────────────────────────────────────────────────────────
async function listTabs(wb) {
  const wbXml = await _readText(wb, 'xl/workbook.xml');
  if (_rootIsPrefixed(wbXml, 'workbook')) throw new GridError('unsupported-xml');
  const relsXml = await _readText(wb, 'xl/_rels/workbook.xml.rels');
  const rels = {};
  const rre = /<Relationship\b([^>]*?)\/?>/g;
  let m;
  while ((m = rre.exec(relsXml))) {
    const a = parseAttrs(m[1]);
    if (a.Id) rels[a.Id] = { target: _resolveTarget(a.Target), type: String(a.Type || '') };
  }
  const tabs = [];
  const sre = /<sheet\s([^>]*?)\/?>/g;
  while ((m = sre.exec(wbXml))) {
    const a = parseAttrs(m[1]);
    const ridKey = Object.keys(a).find((k) => /(^|:)id$/.test(k) && k !== 'sheetId');
    const rel = ridKey ? rels[a[ridKey]] : null;
    const kind = !rel ? 'other' : /\/worksheet$/.test(rel.type) ? 'worksheet' : /\/chartsheet$/.test(rel.type) ? 'chartsheet' : 'other';
    const state = a.state || 'visible';
    tabs.push({
      name: String(a.name || ''), part: rel ? rel.target : null, kind, state,
      available: kind === 'worksheet' && state === 'visible' && !!(rel && wb.zip.file(rel.target)),
    });
  }
  return tabs;
}

// ── shared strings and styles ───────────────────────────────────────────────
async function _sharedStrings(wb) {
  if (wb._sst) return wb._sst;
  const xml = await _readText(wb, 'xl/sharedStrings.xml', { bigXml: true, optional: true });
  const out = [];
  if (xml) {
    if (_rootIsPrefixed(xml, 'sst')) throw new GridError('unsupported-xml');
    const re = /<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g;
    let m;
    while ((m = re.exec(xml))) out.push(m[1] === undefined ? '' : _runsText(m[1]));
  }
  wb._sst = out;
  return out;
}

function parseStyles(xml) {
  const locked = [], wrap = [];
  if (xml) {
    const sec = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (sec) {
      const re = /<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g;
      let m;
      while ((m = re.exec(sec[1]))) {
        const inner = m[2] || '';
        const p = /<protection\b([^>]*?)\/?>/.exec(inner);
        const pa = p ? parseAttrs(p[1]) : {};
        locked.push(!(pa.locked === '0' || pa.locked === 'false'));
        const al = /<alignment\b([^>]*?)\/?>/.exec(inner);
        const aa = al ? parseAttrs(al[1]) : {};
        wrap.push(aa.wrapText === '1' || aa.wrapText === 'true');
      }
    }
  }
  return { locked, wrap };
}

async function _styles(wb) {
  if (wb._styles) return wb._styles;
  const xml = await _readText(wb, 'xl/styles.xml', { optional: true });
  wb._styles = parseStyles(xml);
  return wb._styles;
}

// ── worksheet scanner ───────────────────────────────────────────────────────
// Tolerant scanner over <sheetData>: self-closing rows and cells, attributes in
// any order, every t= type. Positions are kept so the patcher edits in place.
function scanWorksheet(xml, { maxRows = Infinity } = {}) {
  const prefixed = _rootIsPrefixed(xml, 'worksheet');
  if (prefixed === null || prefixed) throw new GridError('unsupported-xml');
  const out = { rows: [], rowByNum: new Map(), truncated: false, sdStart: -1, sdEnd: -1, sdSelfClosing: false };
  const sd = /<sheetData\b[^>]*?(\/?)>/.exec(xml);
  if (!sd) {
    if (/<[A-Za-z_][\w.-]*:sheetData\b/.test(xml)) throw new GridError('unsupported-xml');
    return out;
  }
  out.sdStart = sd.index;
  if (sd[1] === '/') { out.sdSelfClosing = true; out.sdEnd = sd.index + sd[0].length; out.contentStart = out.contentEnd = out.sdEnd; return out; }
  const contentStart = sd.index + sd[0].length;
  const contentEnd = xml.indexOf('</sheetData>', contentStart);
  if (contentEnd < 0) throw new GridError('unsupported-xml');
  out.contentStart = contentStart;
  out.contentEnd = contentEnd;
  out.sdEnd = contentEnd + '</sheetData>'.length;
  const re = /<row\b([^>]*?)(\/?)>|<\/row>|<c\b([^>]*?)(\/?)>/g;
  re.lastIndex = contentStart;
  let cur = null, lastRow = 0, lastCol = -1, m;
  while ((m = re.exec(xml)) && m.index < contentEnd) {
    if (m[0].charAt(1) === 'r') {
      if (cur) throw new GridError('unsupported-xml');
      const attrs = parseAttrs(m[1]);
      const r = attrs.r ? parseInt(attrs.r, 10) : lastRow + 1;
      if (!Number.isFinite(r) || r < 1) throw new GridError('unsupported-xml');
      lastRow = r; lastCol = -1;
      if (out.rows.length >= maxRows) { out.truncated = true; break; }
      const row = { r, start: m.index, openEnd: re.lastIndex, attrsRaw: m[1], attrs, selfClosing: m[2] === '/', cells: [], cellByCol: new Map(), closeStart: -1, end: -1 };
      if (row.selfClosing) { row.closeStart = row.end = re.lastIndex; } else cur = row;
      out.rows.push(row);
      if (!out.rowByNum.has(r)) out.rowByNum.set(r, row);
    } else if (m[0] === '</row>') {
      if (!cur) throw new GridError('unsupported-xml');
      cur.closeStart = m.index; cur.end = re.lastIndex; cur = null;
    } else {
      if (!cur) throw new GridError('unsupported-xml');
      const attrs = parseAttrs(m[3]);
      let inner = '', end;
      if (m[4] === '/') end = re.lastIndex;
      else {
        const close = xml.indexOf('</c>', re.lastIndex);
        if (close < 0 || close > contentEnd) throw new GridError('unsupported-xml');
        inner = xml.slice(re.lastIndex, close);
        end = close + 4;
        re.lastIndex = end;
      }
      const pr = attrs.r ? parseRef(attrs.r) : null;
      const col = pr ? pr.col : lastCol + 1;
      lastCol = col;
      const cell = { col, row: cur.r, start: m.index, end, attrs, inner, hasF: /<f[\s>/]/.test(inner) };
      cur.cells.push(cell);
      if (!cur.cellByCol.has(col)) cur.cellByCol.set(col, cell);
    }
  }
  if (cur) throw new GridError('unsupported-xml');
  return out;
}

function cellType(cell) {
  const t = cell && cell.attrs.t;
  return t || 'n';
}

function cellText(cell, sst) {
  if (!cell) return '';
  const t = cellType(cell);
  if (t === 'inlineStr') {
    const is = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cell.inner);
    return is ? _runsText(is[1]) : '';
  }
  const v = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(cell.inner);
  const raw = v && v[1] !== undefined ? v[1] : '';
  if (t === 's') {
    const i = parseInt(decodeXml(raw), 10);
    return Number.isInteger(i) && sst && sst[i] !== undefined ? sst[i] : '';
  }
  if (t === 'str' || t === 'e' || t === 'b') return _decodeText(raw);
  return decodeXml(raw).trim();
}

function _parseSheetMeta(xml) {
  const meta = { merges: [], protectionEnabled: false, cols: [], dimension: null, validations: [], cfRanges: [], tableParts: 0 };
  let m;
  const mre = /<mergeCell\b([^>]*?)\/?>/g;
  while ((m = mre.exec(xml))) { const rg = parseRange(parseAttrs(m[1]).ref); if (rg) meta.merges.push(rg); }
  const sp = /<sheetProtection\b([^>]*?)\/?>/.exec(xml);
  if (sp) { const a = parseAttrs(sp[1]); meta.protectionEnabled = a.sheet === '1' || a.sheet === 'true'; }
  const colsSec = /<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml);
  if (colsSec) {
    const cre = /<col\b([^>]*?)\/?>/g;
    while ((m = cre.exec(colsSec[1]))) {
      const a = parseAttrs(m[1]);
      meta.cols.push({ min: parseInt(a.min, 10), max: parseInt(a.max, 10), style: a.style !== undefined ? parseInt(a.style, 10) : null });
    }
  }
  const dim = /<dimension\b([^>]*?)\/?>/.exec(xml);
  if (dim) meta.dimension = parseAttrs(dim[1]).ref || null;
  const vre = /<dataValidation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/dataValidation>)/g;
  while ((m = vre.exec(xml))) {
    const a = parseAttrs(m[1]);
    if (a.type !== 'list') continue;
    const f1 = /<formula1\b[^>]*>([\s\S]*?)<\/formula1>/.exec(m[2] || '');
    const f = f1 ? decodeXml(f1[1]).trim() : '';
    const inline = f.length >= 2 && f.charAt(0) === '"' && f.charAt(f.length - 1) === '"';
    meta.validations.push({
      ranges: _sqref(a.sqref),
      kind: inline ? 'inline' : 'range',
      items: inline ? f.slice(1, -1).split(',').map((x) => x.trim()) : null,
    });
  }
  const cfre = /<conditionalFormatting\b([^>]*?)>/g;
  while ((m = cfre.exec(xml))) meta.cfRanges.push(..._sqref(parseAttrs(m[1]).sqref));
  meta.tableParts = (xml.match(/<tablePart\b/g) || []).length;
  return meta;
}

// Grid for one tab: rows (capped at caps.maxRows), cell texts, sheet metadata.
async function readGrid(wb, tabName) {
  if (wb._grids.has(tabName)) return wb._grids.get(tabName);
  const tabs = await listTabs(wb);
  const tab = tabs.find((t) => t.name === tabName);
  if (!tab || !tab.part || tab.kind !== 'worksheet') throw new GridError('tab-unavailable');
  const xml = await _readText(wb, tab.part, { bigXml: true });
  const scan = scanWorksheet(xml, { maxRows: wb.caps.maxRows });
  const sst = await _sharedStrings(wb);
  const styles = await _styles(wb);
  const grid = { tab: tab.name, part: tab.part, scan, sst, styles, ..._parseSheetMeta(xml), truncated: scan.truncated };
  grid.rowByNum = scan.rowByNum;
  grid.cell = (row, col) => { const r = scan.rowByNum.get(row); return r ? r.cellByCol.get(col) || null : null; };
  grid.text = (row, col) => cellText(grid.cell(row, col), sst);
  wb._grids.set(tabName, grid);
  return grid;
}

// ── header detection ────────────────────────────────────────────────────────
function _rowTexts(grid, row) {
  const r = grid.rowByNum.get(row);
  const out = [];
  if (r) for (const c of r.cells) out[c.col] = cellText(c, grid.sst);
  return out;
}

function _matchHeader(cells, aliases) {
  const out = [];
  const set = new Set(aliases);
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === undefined) continue;
    const h = C.normHeader(cells[i]);
    if (h && set.has(h)) out.push(i);
  }
  return out;
}

// Number of the 18 expected headers present (any tier).
function scoreHeaderRow(cells) {
  let score = 0;
  for (const k of C.ALL_KEYS) {
    const hits = _matchHeader(cells, C.HEADER_TIERS.tier1[k].concat(C.HEADER_TIERS.tier2[k]));
    if (hits.length) score++;
  }
  return score;
}

// Tiered resolution: tier 1 (canonical label) first; tier 2 only when tier 1
// finds no column. Duplicates are judged inside the winning tier only.
function resolveColumns(cells) {
  const cols = {}, duplicates = {}, missing = [];
  for (const k of C.ALL_KEYS) {
    let hits = _matchHeader(cells, C.HEADER_TIERS.tier1[k]);
    if (!hits.length) hits = _matchHeader(cells, C.HEADER_TIERS.tier2[k]);
    if (hits.length > 1) duplicates[k] = hits.map(colLetter);
    cols[k] = hits.length === 1 ? { index: hits[0], letter: colLetter(hits[0]) } : null;
    if (!hits.length) missing.push(C.labelOf(k));
  }
  const woHits = _matchHeader(cells, C.WO_HEADER_ALIASES.map(C.normHeader));
  if (woHits.length > 1) duplicates.wo = woHits.map(colLetter);
  const woCol = woHits.length === 1 ? { index: woHits[0], letter: colLetter(woHits[0]) } : null;
  const score = scoreHeaderRow(cells);
  const targets = { delayReason: cols.delayReason, escalationAction: cols.escalationAction, notes: cols.notes };
  const base = { columns: cols, woCol, targets, duplicates, missing, score };
  const critDup = CRITICAL_KEYS.filter((k) => duplicates[k]);
  if (critDup.length) {
    const d = {};
    for (const k of critDup) d[k] = duplicates[k];
    return { ...base, ok: false, code: 'header-duplicate', duplicates: d };
  }
  if (CRITICAL_KEYS.some((k) => !cols[k])) return { ...base, ok: false, code: 'header-mismatch' };
  let maxTracker = -1;
  for (const k of C.TRACKER_KEYS) if (cols[k]) maxTracker = Math.max(maxTracker, cols[k].index);
  for (const k of C.TARGET_KEYS) {
    const t = cols[k];
    if (t.index < MIN_TARGET_COL || t.index <= maxTracker) return { ...base, ok: false, code: 'header-mismatch', reason: 'target-position' };
  }
  return { ...base, ok: true };
}

function _dataRowCount(grid, headerRow) {
  let n = 0;
  for (const r of grid.scan.rows) if (r.r > headerRow) n++;
  return n;
}

async function _evaluateTab(wb, tab) {
  if (!tab.available) return { name: tab.name, available: false, qualifies: false };
  const grid = await readGrid(wb, tab.name);
  let first = null, best = null, bestOk = null;
  for (const row of grid.scan.rows) {
    if (row.r > wb.caps.headerScanRows) break;
    const cells = _rowTexts(grid, row.r);
    const res = resolveColumns(cells);
    const hasCrit = CRITICAL_KEYS.every((k) => res.columns[k] || (res.duplicates && res.duplicates[k]));
    if (!best || res.score > best.res.score) best = { row: row.r, res };
    if (res.ok && (!bestOk || res.score > bestOk.res.score)) bestOk = { row: row.r, res };
    if (!first && hasCrit && res.score >= QUALIFY_SCORE) first = { row: row.r, res };
  }
  const info = { name: tab.name, available: true, grid, best, bestOk };
  if (first) {
    info.headerRow = first.row;
    info.res = first.res;
    info.score = first.res.score;
    info.qualifies = first.res.ok;
    info.code = first.res.ok ? null : first.res.code;
  } else {
    info.headerRow = null;
    info.score = best ? best.res.score : 0;
    info.qualifies = false;
    info.code = 'header-mismatch';
  }
  info.missing = (first ? first.res : best ? best.res : { missing: C.EXPECTED_HEADERS.slice() }).missing;
  info.dataRows = info.headerRow ? _dataRowCount(grid, info.headerRow) : 0;
  return info;
}

function _tabSummary(e) {
  return {
    name: e.name, available: !!e.available, qualifies: !!e.qualifies,
    score: e.score || 0, headerRow: e.headerRow || null, dataRows: e.dataRows || 0,
    missing: e.missing ? e.missing.slice() : [],
  };
}

function _picked(e, row, res, tabCount) {
  return { ok: true, tab: e.name, part: e.grid.part, headerRow: row, columns: res, grid: e.grid, tabCount };
}

// Picks the tab holding the tracker. opts.tab = explicit user choice,
// opts.storedTab = the week's remembered choice (used only if it still qualifies).
async function pickTab(wb, opts = {}) {
  const tabs = await listTabs(wb);
  const evals = [];
  for (const t of tabs) evals.push(await _evaluateTab(wb, t));
  const summary = evals.map(_tabSummary);
  const tabCount = tabs.length;
  if (typeof opts.tab === 'string' && opts.tab) {
    const e = evals.find((x) => x.name === opts.tab);
    if (!e || !e.available) return { ok: false, code: 'tab-unavailable', tabs: summary };
    if (e.qualifies) return _picked(e, e.headerRow, e.res, tabCount);
    if (e.code === 'header-duplicate') return { ok: false, code: 'header-duplicate', duplicates: e.res.duplicates, tabs: summary };
    if (e.bestOk) return _picked(e, e.bestOk.row, e.bestOk.res, tabCount);
    return { ok: false, code: 'header-mismatch', missing: e.missing.slice(), tabs: summary };
  }
  if (typeof opts.storedTab === 'string' && opts.storedTab) {
    const e = evals.find((x) => x.name === opts.storedTab && x.qualifies);
    if (e) return _picked(e, e.headerRow, e.res, tabCount);
  }
  const q = evals.filter((e) => e.qualifies);
  if (q.length === 1) return _picked(q[0], q[0].headerRow, q[0].res, tabCount);
  if (q.length > 1) return { ok: false, code: 'needs-tab-choice', tabs: summary.filter((s) => s.available) };
  const dup = evals.find((e) => e.code === 'header-duplicate');
  if (dup) return { ok: false, code: 'header-duplicate', duplicates: dup.res.duplicates, tabs: summary };
  const bestTab = evals.filter((e) => e.available).sort((a, b) => (b.score || 0) - (a.score || 0))[0];
  return { ok: false, code: 'header-mismatch', missing: bestTab ? bestTab.missing.slice() : C.EXPECTED_HEADERS.slice(), tabs: summary };
}

// Data rows under the header, for matching. Blank Asset ID rows are skipped.
function sheetRowsFrom(grid, headerRow, res) {
  const c = res.columns;
  const out = [];
  for (const row of grid.scan.rows) {
    if (row.r <= headerRow) continue;
    const id = grid.text(row.r, c.assetId.index);
    if (!C.normUnitId(id)) continue;
    out.push({
      sheetRow: row.r,
      unitKey: id,
      vendor: c.vendor ? grid.text(row.r, c.vendor.index) : '',
      site: c.site ? grid.text(row.r, c.site.index) : '',
      wo: res.woCol ? grid.text(row.r, res.woCol.index) : '',
    });
  }
  return out;
}

// ── lock / style / validation lookups ───────────────────────────────────────
function _int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// Effective style index of a cell position: cell s; for a missing cell the row
// s when customFormat, else the <col> style covering it, else 0.
function _effectiveStyleFrom(rowObj, cols, row, col) {
  const cell = rowObj ? rowObj.cellByCol.get(col) : null;
  if (cell) return _int(cell.attrs.s, 0);
  if (rowObj && (rowObj.attrs.customFormat === '1' || rowObj.attrs.customFormat === 'true') && rowObj.attrs.s !== undefined) return _int(rowObj.attrs.s, 0);
  const cs = (cols || []).find((x) => col + 1 >= x.min && col + 1 <= x.max && x.style !== null && Number.isFinite(x.style));
  return cs ? cs.style : 0;
}
function effectiveStyle(grid, row, col) { return _effectiveStyleFrom(grid.rowByNum.get(row), grid.cols, row, col); }
function isStyleLocked(grid, idx) { return grid.styles.locked[idx] !== false; }
function isTargetProtected(grid, row, col) {
  return !!grid.protectionEnabled && isStyleLocked(grid, effectiveStyle(grid, row, col));
}
function isMerged(merges, row, col) { return (merges || []).some((rg) => _inRange(rg, row, col)); }
function validationFor(grid, row, col) {
  const v = (grid.validations || []).find((x) => x.ranges.some((rg) => _inRange(rg, row, col)));
  return v ? { kind: v.kind, items: v.items ? v.items.slice() : null } : null;
}

// Everything the diff needs about one target cell.
function cellInfo(grid, row, col) {
  const cell = grid.cell(row, col);
  return {
    exists: !!cell,
    current: cellText(cell, grid.sst),
    formula: !!(cell && cell.hasF),
    merged: isMerged(grid.merges, row, col),
    protected: isTargetProtected(grid, row, col),
    validation: validationFor(grid, row, col),
  };
}

// ── diagnostics (counts and booleans only; never text or names) ─────────────
function collectDiagnostics(grid, ctx = {}) {
  const res = ctx.columns;
  const headerRow = ctx.headerRow || 0;
  const d = {
    idCells: { shared: 0, inline: 0, numeric: 0 },
    targets: { styled: 0, wrap: 0, formulas: 0, merged: 0, tables: grid.tableParts || 0,
      protection: { enabled: !!grid.protectionEnabled, locked: 0, unlocked: 0 }, cfOverlap: 0 },
    validations: [], dupAssetIds: 0, hasWoCol: !!(res && res.woCol), vendorEq: 0, vendorNeq: 0,
  };
  if (!res || !res.columns || !res.columns.assetId) return d;
  const idCol = res.columns.assetId.index;
  const targetCols = C.TARGET_KEYS.map((k) => res.targets[k]).filter(Boolean).map((t) => t.index);
  const counts = new Map();
  const unitVendor = new Map();
  for (const u of ctx.units || []) {
    const k = C.normUnitId(u && u.equipmentId);
    if (k && !unitVendor.has(k)) unitVendor.set(k, C.normKey(u.vendor));
  }
  for (const row of grid.scan.rows) {
    if (row.r <= headerRow) continue;
    const idCell = row.cellByCol.get(idCol);
    const id = C.normUnitId(cellText(idCell, grid.sst));
    if (!id) continue;
    const t = cellType(idCell);
    if (t === 's') d.idCells.shared++;
    else if (t === 'inlineStr' || t === 'str') d.idCells.inline++;
    else d.idCells.numeric++;
    counts.set(id, (counts.get(id) || 0) + 1);
    if (unitVendor.has(id) && res.columns.vendor) {
      const v = C.normKey(grid.text(row.r, res.columns.vendor.index));
      if (v && v === unitVendor.get(id)) d.vendorEq++; else d.vendorNeq++;
    }
    for (const col of targetCols) {
      const c = row.cellByCol.get(col);
      const s = effectiveStyle(grid, row.r, col);
      if (s) d.targets.styled++;
      if (grid.styles.wrap[s]) d.targets.wrap++;
      if (c && c.hasF) d.targets.formulas++;
      if (isMerged(grid.merges, row.r, col)) d.targets.merged++;
      if (isStyleLocked(grid, s)) d.targets.protection.locked++; else d.targets.protection.unlocked++;
    }
  }
  for (const n of counts.values()) if (n > 1) d.dupAssetIds++;
  for (const rg of grid.cfRanges || []) if (targetCols.some((c) => c >= rg.c1 && c <= rg.c2 && rg.r2 > headerRow)) d.targets.cfOverlap++;
  for (const key of C.TARGET_KEYS) {
    const t = res.targets[key];
    if (!t) continue;
    const f = C.fieldByKey(key);
    for (const v of grid.validations || []) {
      if (!v.ranges.some((rg) => t.index >= rg.c1 && t.index <= rg.c2)) continue;
      const items = v.items || [];
      const inEnum = f && f.enum ? items.filter((x) => f.enum.includes(x)).length : 0;
      d.validations.push({ col: t.letter, kind: v.kind, inEnum, notInEnum: v.kind === 'inline' ? items.length - inEnum : 0 });
    }
  }
  return d;
}

// ── patcher ─────────────────────────────────────────────────────────────────
function _stripSpans(attrsRaw) { return String(attrsRaw).replace(/\s+spans\s*=\s*(?:"[^"]*"|'[^']*')/, ''); }

function _newCellXml(ref, s, text) {
  const sa = s !== undefined && s !== null && s !== '' ? ' s="' + escAttr(s) + '"' : '';
  return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + escText(text) + '</t></is></c>';
}

function _validatePatches(patches, allowedCols) {
  if (!Array.isArray(patches)) throw new TypeError('patches must be an array');
  const allowed = new Set((allowedCols || []).filter((c) => Number.isInteger(c) && c >= MIN_TARGET_COL));
  const seen = new Set();
  return patches.map((p) => {
    const row = p && p.row, col = p && p.col;
    if (!Number.isInteger(col) || col < MIN_TARGET_COL || !allowed.has(col)) throw new ForbiddenColumnError();
    if (!Number.isInteger(row) || row < 1) throw new RowMissingError();
    const text = C.normText(p.text);
    if (text === '') throw new EmptyPatchError();
    const k = row + ':' + col;
    if (seen.has(k)) throw new DuplicatePatchError();
    seen.add(k);
    return { row, col, text };
  });
}

function _extendDimension(xml, sdStart, maxRow, maxCol) {
  const head = xml.slice(0, sdStart);
  const m = /<dimension\b([^>]*?)\bref\s*=\s*"([^"]*)"/.exec(head);
  if (!m) return xml;
  const rg = parseRange(m[2]);
  if (!rg) return xml;
  if (maxRow <= rg.r2 && maxCol <= rg.c2) return xml;
  const ref = colLetter(rg.c1) + rg.r1 + ':' + colLetter(Math.max(rg.c2, maxCol)) + Math.max(rg.r2, maxRow);
  const start = m.index + m[0].length - m[2].length - 1;
  return xml.slice(0, start) + ref + xml.slice(start + m[2].length);
}

// Patches the worksheet `part` inside `zip` in place. Returns {patched, inserted}.
async function applyCellPatches(zip, part, patches, opts = {}) {
  const caps = _caps(opts);
  const list = _validatePatches(patches, opts.allowedCols);
  const xml = _decoder.decode(await readEntryCapped(zip, part, caps.entryBytes));
  if (xml.length > caps.xmlChars) throw new GridError('too-large');
  const scan = scanWorksheet(xml);
  const meta = _parseSheetMeta(xml);
  const byRow = new Map();
  for (const p of list) {
    const row = scan.rowByNum.get(p.row);
    if (!row) throw new RowMissingError();
    const cell = row.cellByCol.get(p.col);
    if (cell && cell.hasF) throw new FormulaError();
    if (isMerged(meta.merges, p.row, p.col)) throw new MergedError();
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(p);
  }
  let inserted = 0, maxRow = 0, maxCol = 0;
  const rowEdits = [];
  for (const [row, ps] of byRow) {
    ps.sort((a, b) => a.col - b.col);
    const open = '<row' + _stripSpans(row.attrsRaw) + '>';
    let inner = row.selfClosing ? '' : xml.slice(row.openEnd, row.closeStart);
    const edits = [];
    for (const p of ps) {
      maxRow = Math.max(maxRow, p.row); maxCol = Math.max(maxCol, p.col);
      const ref = colLetter(p.col) + p.row;
      const cell = row.cellByCol.get(p.col);
      if (cell) {
        edits.push({ start: cell.start - row.openEnd, end: cell.end - row.openEnd, text: _newCellXml(ref, cell.attrs.s, p.text), col: p.col });
      } else {
        const s = _effectiveStyleFrom(row, meta.cols, p.row, p.col);
        const next = row.cells.find((c) => c.col > p.col);
        const lastCell = row.cells[row.cells.length - 1];
        const pos = next ? next.start - row.openEnd : lastCell ? lastCell.end - row.openEnd : 0;
        edits.push({ start: pos, end: pos, text: _newCellXml(ref, s ? String(s) : null, p.text), col: p.col });
        inserted++;
      }
    }
    // apply from the end; inserts at the same position keep column order
    edits.sort((a, b) => (b.start - a.start) || (b.col - a.col));
    for (const e of edits) inner = inner.slice(0, e.start) + e.text + inner.slice(e.end);
    rowEdits.push({ start: row.start, end: row.end, text: open + inner + '</row>' });
  }
  rowEdits.sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of rowEdits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  out = _extendDimension(out, scan.sdStart, maxRow, maxCol);
  zip.file(part, out);
  return { patched: list.length, inserted };
}

// Loads b0, patches, and generates the new workbook bytes.
async function patchWorkbookBytes(b0, part, patches, opts = {}) {
  const caps = _caps(opts);
  const zip = await _loadZip(b0, caps);
  const r = await applyCellPatches(zip, part, patches, opts);
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return { bytes, ...r };
}

// ── self-check (before any upload) ──────────────────────────────────────────
function _headTail(xml, scan) {
  if (scan.sdStart < 0) return { head: xml.replace(/<dimension\b[^>]*?\/?>/, ''), tail: '' };
  return { head: xml.slice(0, scan.sdStart).replace(/<dimension\b[^>]*?\/?>/, ''), tail: xml.slice(scan.sdEnd) };
}

async function selfCheck(b0, b1, part, patches, opts = {}) {
  const caps = _caps(opts);
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (!_isPk(b1)) return fail('not-zip');
    if (b1.length > caps.maxBytes) return fail('too-large');
    const z0 = await _loadZip(b0, caps);
    const z1 = await _loadZip(b1, caps);
    const n0 = Object.keys(z0.files), n1 = Object.keys(z1.files);
    if (n0.length !== n1.length || n0.some((n, i) => n !== n1[i])) return fail('entries-differ');
    if (!z0.file(part) || !z1.file(part)) return fail('entries-differ');
    for (const name of n0) {
      if (name === part) continue;
      if (z0.files[name].dir !== z1.files[name].dir) return fail('entries-differ');
      if (z0.files[name].dir) continue;
      const a = await readEntryCapped(z0, name, caps.entryBytes);
      const b = await readEntryCapped(z1, name, caps.entryBytes);
      if (!_bytesEqual(a, b)) return fail('part-changed');
    }
    const x0 = _decoder.decode(await readEntryCapped(z0, part, caps.entryBytes));
    const x1 = _decoder.decode(await readEntryCapped(z1, part, caps.entryBytes));
    const s0 = scanWorksheet(x0), s1 = scanWorksheet(x1);
    const ht0 = _headTail(x0, s0), ht1 = _headTail(x1, s1);
    if (ht0.head !== ht1.head || ht0.tail !== ht1.tail) return fail('part-changed');
    const r0 = s0.rows.map((r) => r.r), r1 = s1.rows.map((r) => r.r);
    if (r0.length !== r1.length || r0.some((r, i) => r !== r1[i])) return fail('rows-differ');
    const meta0 = _parseSheetMeta(x0);
    const want = new Map();
    for (const p of patches || []) {
      if (!Number.isInteger(p.col) || p.col < MIN_TARGET_COL) return fail('forbidden-column');
      want.set(p.row + ':' + p.col, C.normText(p.text));
    }
    let cells0 = 0, cells1 = 0, inserted = 0;
    for (let i = 0; i < s0.rows.length; i++) {
      const a = s0.rows[i], b = s1.rows[i];
      cells0 += a.cells.length; cells1 += b.cells.length;
      const touched = [...want.keys()].some((k) => k.startsWith(a.r + ':'));
      if (!touched) {
        if (x0.slice(a.start, a.end) !== x1.slice(b.start, b.end)) return fail('cell-changed');
        continue;
      }
      if (_stripSpans(a.attrsRaw).replace(/\s+$/, '') !== _stripSpans(b.attrsRaw).replace(/\s+$/, '')) return fail('cell-changed');
      const cols = new Set([...a.cellByCol.keys(), ...b.cellByCol.keys()]);
      if (a.cells.length !== a.cellByCol.size || b.cells.length !== b.cellByCol.size) return fail('cell-changed');
      for (const col of cols) {
        const ca = a.cellByCol.get(col), cb = b.cellByCol.get(col);
        const k = a.r + ':' + col;
        if (want.has(k)) {
          if (!cb || cellType(cb) !== 'inlineStr' || cellText(cb, null) !== want.get(k)) return fail('patch-mismatch');
          if (ca) {
            if (ca.attrs.s !== cb.attrs.s) return fail('patch-mismatch');
          } else {
            inserted++;
            const s = _effectiveStyleFrom(a, meta0.cols, a.r, col);
            const expect = s ? String(s) : undefined;
            if (cb.attrs.s !== expect) return fail('patch-mismatch');
          }
        } else {
          if (!ca || !cb) return fail('cell-changed');
          if (x0.slice(ca.start, ca.end) !== x1.slice(cb.start, cb.end)) return fail('cell-changed');
        }
      }
    }
    for (const k of want.keys()) {
      const [row] = k.split(':');
      if (!s0.rowByNum.has(parseInt(row, 10))) return fail('rows-differ');
    }
    if (cells1 - cells0 !== inserted) return fail('cell-count');
    return { ok: true };
  } catch (e) {
    return fail(e && e.code === 'too-large' ? 'too-large' : 'unreadable');
  }
}

module.exports = {
  DEFAULT_CAPS, MIN_TARGET_COL, QUALIFY_SCORE,
  GridError, ForbiddenColumnError, EmptyPatchError, RowMissingError, FormulaError, MergedError, DuplicatePatchError,
  colLetter, colIndex, parseRef, parseRange, decodeXml, escText,
  readEntryCapped, openWorkbook, listTabs, scanWorksheet, cellText, readGrid, parseStyles,
  scoreHeaderRow, resolveColumns, pickTab, sheetRowsFrom,
  effectiveStyle, isTargetProtected, isMerged, validationFor, cellInfo, collectDiagnostics,
  applyCellPatches, patchWorkbookBytes, selfCheck,
  _centralDirSanity,
};
