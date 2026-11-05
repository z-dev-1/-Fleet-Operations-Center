// tests/helpers/sheet-fixture.js - synthetic weekly Long Dwell workbooks for
// the SharePoint preview/write tests. Headers come from EXPECTED_HEADERS (never
// retyped). No real-sheet data lives here.
//
//   buildWorkbook({ tabs: [tabSpec...], styles })      -> Promise<Uint8Array>
//   tabSpec (tracker layout):
//     name, state ('visible'|'hidden'|'veryHidden'), kind ('worksheet'|'chartsheet')
//     titleRows      number of title rows above the header row (default 0)
//     headers        full header array override (default EXPECTED_HEADERS)
//     woHeader       text of an extra work-order header appended at column S
//     extraHeaders   [{ col: <letter>, text }] extra header cells
//     rows           [{ assetId, site, vendor, wo, idType, cells: { N: 'x', ... },
//                       rowAttrs: 's="2" customFormat="1"', selfClosing }]
//     idType         's' (shared, default) | 'inlineStr' | 'n'
//     formulas       { 'N5': 'A1&B1' }   (cell gets <f>)
//     merges         ['N5:O5']
//     protection     true -> <sheetProtection sheet="1">, 'off' -> sheet="0"
//     cellStyles     { 'N5': 1 }         (s= on an existing cell)
//     cols           [{ min, max, style }]
//     validations    [{ sqref: 'N2:N500', formula1: '"a,b"' }]
//     cf             ['N2:N100']
//     table          true -> a table part
//     emptyRows      [r] self-closing <row r="r"/> entries (kept in row order)
//     selfClosingCells ['N7'] -> <c r="N7" s="1"/> placeholders
//     richText       { 'R5': ['run one', 'run two'] } shared rich-text strings
//     rawXml         full worksheet XML override
//   styles: xfs list [{ locked: true|false|undefined, wrap: bool }]; default
//     index 0 = default (locked), 1 = unlocked, 2 = wrap, 3 = explicit locked.
//
//   createFakeTransport({ bytes, etag, modified }) -> programmable fake of the
//     FEAT-002 transport (download/meta/upload, locked, 412, lag, unknown
//     outcome, concurrent edit, metadata failure). Records every upload.
import JSZip from 'jszip';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const C = require('../../src/longdwell/sheet-columns');

export const SECRET_CELL_TEXT = 'SECRET_CELL_TEXT';
export const EXPECTED_HEADERS = C.EXPECTED_HEADERS;

export function colLetter(i) {
  let n = i + 1, s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
export function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
}

class Sst {
  constructor() { this.items = []; this.map = new Map(); }
  idx(text) {
    const k = 'p:' + text;
    if (!this.map.has(k)) { this.map.set(k, this.items.length); this.items.push({ plain: String(text) }); }
    return this.map.get(k);
  }
  rich(runs) { this.items.push({ runs }); return this.items.length - 1; }
  xml() {
    const body = this.items.map((it) => it.runs
      ? '<si>' + it.runs.map((r) => '<r><rPr><b/></rPr><t xml:space="preserve">' + esc(r) + '</t></r>').join('') + '<rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>'
      : '<si><t xml:space="preserve">' + esc(it.plain) + '</t></si>').join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + this.items.length + '" uniqueCount="' + this.items.length + '">' + body + '</sst>';
  }
}

function cellXml(ref, value, type, sst, s) {
  const sa = s !== undefined && s !== null ? ' s="' + s + '"' : '';
  if (type === 'n') return '<c r="' + ref + '"' + sa + '><v>' + esc(value) + '</v></c>';
  if (type === 'inlineStr') return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t>' + esc(value) + '</t></is></c>';
  if (type === 'str') return '<c r="' + ref + '"' + sa + ' t="str"><v>' + esc(value) + '</v></c>';
  return '<c r="' + ref + '"' + sa + ' t="s"><v>' + sst.idx(value) + '</v></c>';
}

export function trackerSheetXml(spec, sst) {
  if (spec.rawXml) return spec.rawXml;
  const headers = (spec.headers || EXPECTED_HEADERS).slice();
  if (spec.woHeader) headers[18] = spec.woHeader;
  for (const e of spec.extraHeaders || []) headers[colIndex(e.col)] = e.text;
  const titleRows = spec.titleRows || 0;
  const rowsXml = [];
  const styles = spec.cellStyles || {};
  const formulas = spec.formulas || {};
  const rich = spec.richText || {};
  const selfClosing = new Set(spec.selfClosingCells || []);
  let lastRow = 0;
  const emptyRows = new Set(spec.emptyRows || []);
  const pushEmptyUpTo = (r) => { for (const e of [...emptyRows].sort((a, b) => a - b)) if (e < r) { rowsXml.push('<row r="' + e + '" spans="1:19"/>'); emptyRows.delete(e); } };
  for (let t = 1; t <= titleRows; t++) {
    pushEmptyUpTo(t);
    rowsXml.push('<row r="' + t + '"><c r="A' + t + '" t="s"><v>' + sst.idx('Weekly Long Dwell Tracker ' + t) + '</v></c></row>');
    lastRow = t;
  }
  const hr = titleRows + 1;
  pushEmptyUpTo(hr);
  rowsXml.push('<row r="' + hr + '" spans="1:19">' + headers.map((h, i) => h === undefined || h === null ? '' : cellXml(colLetter(i) + hr, h, 's', sst)).join('') + '</row>');
  lastRow = hr;
  let r = hr;
  for (const row of spec.rows || []) {
    r = row.r || r + 1;
    pushEmptyUpTo(r);
    lastRow = r;
    const attrs = row.rowAttrs ? ' ' + row.rowAttrs : '';
    if (row.selfClosing) { rowsXml.push('<row r="' + r + '"' + attrs + '/>'); continue; }
    const cells = {};
    if (row.assetId !== undefined) cells.C = { v: row.assetId, t: row.idType || spec.idType || 's' };
    if (row.site !== undefined) cells.E = { v: row.site };
    if (row.vendor !== undefined) cells.I = { v: row.vendor };
    if (row.wo !== undefined && row.wo !== '') cells.S = { v: row.wo };
    for (const [k, v] of Object.entries(row.cells || {})) cells[k] = { v };
    const parts = [];
    const letters = new Set(Object.keys(cells));
    for (const ref of selfClosing) { const m = /^([A-Z]+)(\d+)$/.exec(ref); if (m && +m[2] === r) letters.add(m[1]); }
    for (const ref of Object.keys(formulas)) { const m = /^([A-Z]+)(\d+)$/.exec(ref); if (m && +m[2] === r) letters.add(m[1]); }
    for (const ref of Object.keys(rich)) { const m = /^([A-Z]+)(\d+)$/.exec(ref); if (m && +m[2] === r) letters.add(m[1]); }
    const sorted = [...letters].sort((a, b) => colIndex(a) - colIndex(b));
    for (const L of sorted) {
      const ref = L + r;
      const s = styles[ref];
      if (formulas[ref] !== undefined) { parts.push('<c r="' + ref + '"' + (s !== undefined ? ' s="' + s + '"' : '') + ' t="str"><f>' + esc(formulas[ref]) + '</f><v>' + esc((cells[L] && cells[L].v) || 'calc') + '</v></c>'); continue; }
      if (rich[ref]) { parts.push('<c r="' + ref + '"' + (s !== undefined ? ' s="' + s + '"' : '') + ' t="s"><v>' + sst.rich(rich[ref]) + '</v></c>'); continue; }
      if (selfClosing.has(ref) && !cells[L]) { parts.push('<c r="' + ref + '" s="' + (s !== undefined ? s : 1) + '"/>'); continue; }
      const c = cells[L];
      parts.push(cellXml(ref, c.v, c.t || 's', sst, s));
    }
    rowsXml.push('<row r="' + r + '" spans="1:19"' + attrs + '>' + parts.join('') + '</row>');
  }
  pushEmptyUpTo(Infinity);
  const maxCol = spec.woHeader ? 'S' : 'R';
  const dim = spec.dimension || ('A1:' + maxCol + lastRow);
  const colsXml = spec.cols && spec.cols.length
    ? '<cols>' + spec.cols.map((c) => '<col min="' + c.min + '" max="' + c.max + '" width="20" customWidth="1"' + (c.style !== undefined ? ' style="' + c.style + '"' : '') + '/>').join('') + '</cols>'
    : '';
  const prot = spec.protection === true ? '<sheetProtection sheet="1" objects="1" scenarios="1"/>' : spec.protection === 'off' ? '<sheetProtection sheet="0"/>' : '';
  const merges = spec.merges && spec.merges.length ? '<mergeCells count="' + spec.merges.length + '">' + spec.merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>' : '';
  const cf = (spec.cf || []).map((q, i) => '<conditionalFormatting sqref="' + q + '"><cfRule type="containsBlanks" dxfId="0" priority="' + (i + 1) + '"><formula>LEN(TRIM(N2))=0</formula></cfRule></conditionalFormatting>').join('');
  const dv = spec.validations && spec.validations.length
    ? '<dataValidations count="' + spec.validations.length + '">' + spec.validations.map((v) => '<dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="' + v.sqref + '"><formula1>' + esc(v.formula1) + '</formula1></dataValidation>').join('') + '</dataValidations>'
    : '';
  const table = spec.table ? '<tableParts count="1"><tablePart r:id="rIdT1"/></tableParts>' : '';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<dimension ref="' + dim + '"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>'
    + colsXml + '<sheetData>' + rowsXml.join('') + '</sheetData>' + prot + merges + cf + dv
    + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' + table + '</worksheet>';
}

const DEFAULT_XFS = [{}, { locked: false }, { wrap: true }, { locked: true }];

function stylesXml(xfs) {
  const list = (xfs || DEFAULT_XFS).map((x) => {
    const inner = (x.wrap ? '<alignment wrapText="1"/>' : '') + (x.locked === false ? '<protection locked="0"/>' : x.locked === true ? '<protection locked="1"/>' : '');
    const attrs = ' numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"' + (x.locked !== undefined ? ' applyProtection="1"' : '') + (x.wrap ? ' applyAlignment="1"' : '');
    return inner ? '<xf' + attrs + '>' + inner + '</xf>' : '<xf' + attrs + '/>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
    + '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="' + (xfs || DEFAULT_XFS).length + '">' + list + '</cellXfs><dxfs count="1"><dxf/></dxfs></styleSheet>';
}

// Builds a workbook; returns Uint8Array. Tabs default to one 'Tracker' tab.
export async function buildWorkbook(opts = {}) {
  const tabs = opts.tabs && opts.tabs.length ? opts.tabs : [{ name: 'Tracker', rows: [] }];
  const sst = new Sst();
  const zip = new JSZip();
  const ct = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>', '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'];
  const sheetsXml = [], relsXml = [];
  tabs.forEach((t, i) => {
    const n = i + 1;
    const chart = t.kind === 'chartsheet';
    const part = chart ? 'chartsheets/sheet' + n + '.xml' : 'worksheets/sheet' + n + '.xml';
    sheetsXml.push('<sheet name="' + esc(t.name) + '" sheetId="' + n + '"' + (t.state && t.state !== 'visible' ? ' state="' + t.state + '"' : '') + ' r:id="rId' + n + '"/>');
    relsXml.push('<Relationship Id="rId' + n + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + (chart ? 'chartsheet' : 'worksheet') + '" Target="' + part + '"/>');
    if (chart) {
      zip.file('xl/' + part, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<chartsheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"/></sheetViews></chartsheet>');
      ct.push('<Override PartName="/xl/' + part + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.chartsheet+xml"/>');
      return;
    }
    zip.file('xl/' + part, trackerSheetXml(t, sst));
    ct.push('<Override PartName="/xl/' + part + '" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    if (t.table) {
      zip.file('xl/worksheets/_rels/sheet' + n + '.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdT1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table' + n + '.xml"/></Relationships>');
      zip.file('xl/tables/table' + n + '.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="' + n + '" name="Table' + n + '" displayName="Table' + n + '" ref="A1:R2"><tableColumns count="1"><tableColumn id="1" name="FAS"/></tableColumns></table>');
      ct.push('<Override PartName="/xl/tables/table' + n + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>');
    }
  });
  relsXml.push('<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>');
  relsXml.push('<Relationship Id="rIdY" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  ct.push('<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>');
  ct.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' + ct.join('') + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetsXml.join('') + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + relsXml.join('') + '</Relationships>');
  zip.file('xl/sharedStrings.xml', opts.sstXml || sst.xml());
  zip.file('xl/styles.xml', stylesXml(opts.styles));
  for (const [name, content] of Object.entries(opts.extraFiles || {})) zip.file(name, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

// Convenience: a tracker row for unit `id` with the given manual-column values.
export function unitRow(id, { site = 'DXX1', vendor = 'Amerit', wo, N, O, P, Q, R, idType, extra } = {}) {
  const cells = {};
  if (N !== undefined) cells.N = N;
  if (O !== undefined) cells.O = O;
  if (P !== undefined) cells.P = P;
  if (Q !== undefined) cells.Q = Q;
  if (R !== undefined) cells.R = R;
  Object.assign(cells, extra || {});
  return { assetId: id, site, vendor, wo, idType, cells };
}

// Reads a worksheet part as text (no capped reader; test-side only).
export async function readPart(bytes, part) {
  const zip = await JSZip.loadAsync(bytes);
  return zip.file(part).async('string');
}

// ── fake transport (consumed by the FEAT-002 service tests) ─────────────────
// state.bytes is the "server" file. Behaviors:
//   meta()          -> {ok, etag, modified} | {ok:false, code:'network'} when metaFail
//   download()      -> {ok, bytes}; lag>0 serves the pre-upload bytes for that many reads
//   upload(bytes, headers) -> records; uploadResult 'locked'|'precondition'|'unknown'|'http-500'
//   beforeUpload    async hook (concurrent edit between read and write)
export function createFakeTransport({ bytes, etag = '"{AAAAAAAA-0000-0000-0000-000000000001},1"', modified = '2026-11-05T10:00:00Z' } = {}) {
  const state = { bytes, etag, modified, version: 1, uploads: [], downloads: 0, metas: 0, lag: 0, metaFail: false, uploadResult: 'ok', beforeUpload: null, staleBytes: null, calls: [] };
  const bump = () => { state.version++; state.etag = '"{AAAAAAAA-0000-0000-0000-000000000001},' + state.version + '"'; state.modified = new Date(Date.parse(state.modified) + 60000).toISOString().replace('.000', ''); };
  return {
    state,
    // Someone else saves the file (bytes replaced, etag/modified bumped).
    externalEdit(newBytes) { state.bytes = newBytes; bump(); },
    async resolve() { state.calls.push('resolve'); return { ok: true, host: 'contoso.sharepoint.com', site: '/sites/Fleet', serverRelativeUrl: '/sites/Fleet/Shared Documents/Tracker.xlsx', uniqueId: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Tracker.xlsx' }; },
    async meta() {
      state.calls.push('meta'); state.metas++;
      if (state.metaFail) return { ok: false, code: 'network' };
      return { ok: true, etag: state.etag, modified: state.modified, length: state.bytes.length };
    },
    async download() {
      state.calls.push('download'); state.downloads++;
      if (state.lag > 0 && state.staleBytes) { state.lag--; return { ok: true, bytes: state.staleBytes }; }
      return { ok: true, bytes: state.bytes };
    },
    async upload(newBytes, headers = {}) {
      state.calls.push('upload');
      if (state.beforeUpload) { const f = state.beforeUpload; state.beforeUpload = null; await f(state); }
      state.uploads.push({ bytes: newBytes, headers: { ...headers } });
      const r = state.uploadResult;
      if (r === 'locked') return { ok: false, code: 'locked', http: 423 };
      if (r === 'precondition') return { ok: false, code: 'precondition', http: 412 };
      if (r === 'http-500') return { ok: false, code: 'http-500', http: 500 };
      if (r === 'unknown-applied') { state.staleBytes = state.bytes; state.bytes = newBytes; bump(); return { ok: false, code: 'network', sent: true }; }
      if (r === 'unknown-lost') return { ok: false, code: 'network', sent: true };
      state.staleBytes = state.bytes;
      state.bytes = newBytes;
      bump();
      return { ok: true, http: 200 };
    },
  };
}
