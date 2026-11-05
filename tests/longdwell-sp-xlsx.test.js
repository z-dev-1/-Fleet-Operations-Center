// tests/longdwell-sp-xlsx.test.js - OOXML grid reader / patcher / self-check
// (src/longdwell/xlsx-grid.js) on synthetic workbooks from tests/helpers/sheet-fixture.js.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { createRequire } from 'module';
import { buildWorkbook, unitRow, readPart, EXPECTED_HEADERS, SECRET_CELL_TEXT } from './helpers/sheet-fixture.js';
const require = createRequire(import.meta.url);
const G = require('../src/longdwell/xlsx-grid');

const PART = 'xl/worksheets/sheet1.xml';
const N = 13, O = 14, P = 15, Q = 16, R = 17;
const ALLOWED = [N, O, R];

function baseRows() {
  return [
    unitRow('AB100', { N: 'Parts Delay', R: 'existing note' }),
    unitRow('AB101', {}),
    unitRow('AB102', { O: 'SEV3', P: 'poc', Q: 'https://asana.example/1' }),
  ];
}
async function base(extra = {}) { return buildWorkbook({ tabs: [{ name: 'Tracker', rows: baseRows(), ...extra }] }); }
async function pick(bytes, opts) { const wb = await G.openWorkbook(bytes, opts); return { wb, res: await G.pickTab(wb, opts || {}) }; }
async function tamper(bytes, fn) {
  const z = await JSZip.loadAsync(bytes);
  await fn(z);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
function cellsOfRow(xml, r) {
  const m = new RegExp('<row r="' + r + '"[^>]*?(?:/>|>([\\s\\S]*?)</row>)').exec(xml);
  return m ? m[1] || '' : null;
}
function cellXml(xml, ref) {
  const m = new RegExp('<c r="' + ref + '"[^>]*?(?:/>|>[\\s\\S]*?</c>)').exec(xml);
  return m ? m[0] : null;
}

describe('openWorkbook guards', () => {
  it('rejects non-zip bytes and missing workbook.xml', async () => {
    await expect(G.openWorkbook(new Uint8Array([1, 2, 3, 4]))).rejects.toMatchObject({ code: 'unsupported-workbook' });
    const z = new JSZip(); z.file('a.txt', 'x');
    await expect(G.openWorkbook(await z.generateAsync({ type: 'uint8array' }))).rejects.toMatchObject({ code: 'unsupported-workbook' });
  });
  it('rejects .xlsb (workbook.bin) and too many entries', async () => {
    const b = await buildWorkbook({ extraFiles: { 'xl/workbook.bin': 'x' } });
    await expect(G.openWorkbook(b)).rejects.toMatchObject({ code: 'unsupported-workbook' });
    const b2 = await base();
    await expect(G.openWorkbook(b2, { caps: { maxEntries: 3 } })).rejects.toMatchObject({ code: 'unsupported-workbook' });
  });
  it('central-directory size check is best-effort: a missing size field does not reject', () => {
    const caps = G.DEFAULT_CAPS;
    expect(() => G._centralDirSanity({ files: { a: {}, b: { _data: {} }, c: { _data: { uncompressedSize: undefined } } } }, caps)).not.toThrow();
    expect(() => G._centralDirSanity({ files: { a: { _data: { uncompressedSize: caps.cdEntryBytes + 1 } } } }, caps)).toThrow(/unsupported-workbook/);
    expect(() => G._centralDirSanity({ files: { a: { _data: { uncompressedSize: 60 * 1048576 } }, b: { _data: { uncompressedSize: 60 * 1048576 } }, c: { _data: { uncompressedSize: 90 * 1048576 } } } }, caps)).toThrow(/unsupported-workbook/);
  });
});

describe('readEntryCapped', () => {
  it('reads an entry fully under the cap', async () => {
    const z = await JSZip.loadAsync(await base());
    const bytes = await G.readEntryCapped(z, PART, 10 * 1048576);
    expect(new TextDecoder().decode(bytes)).toBe(await z.file(PART).async('string'));
  });
  it('aborts past the cap with too-large (cap lowered by injection)', async () => {
    const z = await JSZip.loadAsync(await base());
    await expect(G.readEntryCapped(z, PART, 100)).rejects.toMatchObject({ code: 'too-large' });
    const wb = await G.openWorkbook(await base(), { caps: { entryBytes: 200 } });
    await expect(G.pickTab(wb)).rejects.toMatchObject({ code: 'too-large' });
  });
  it('total budget across entries is enforced', async () => {
    const wb = await G.openWorkbook(await base(), { caps: { totalBytes: 1500 } });
    await expect(G.pickTab(wb)).rejects.toMatchObject({ code: 'too-large' });
  });
  it('sharedStrings.xml over the char cap -> too-large', async () => {
    const wb = await G.openWorkbook(await base(), { caps: { xmlChars: 500 } });
    await expect(G.pickTab(wb)).rejects.toMatchObject({ code: 'too-large' });
  });
  it('missing entry rejects', async () => {
    const z = await JSZip.loadAsync(await base());
    await expect(G.readEntryCapped(z, 'nope.xml', 10)).rejects.toMatchObject({ code: 'missing-part' });
  });
});

describe('tabs and header detection', () => {
  it('single qualifying tab: letters C, N, O, R and header row 1', async () => {
    const { res } = await pick(await base());
    expect(res.ok).toBe(true);
    expect(res.tab).toBe('Tracker');
    expect(res.headerRow).toBe(1);
    expect(res.columns.columns.assetId.letter).toBe('C');
    expect(res.columns.targets.delayReason.letter).toBe('N');
    expect(res.columns.targets.escalationAction.letter).toBe('O');
    expect(res.columns.targets.notes.letter).toBe('R');
    expect(res.columns.woCol).toBe(null);
    expect(res.tabCount).toBe(1);
  });
  it('title rows above the header are skipped', async () => {
    const { res } = await pick(await base({ titleRows: 3 }));
    expect(res.ok).toBe(true);
    expect(res.headerRow).toBe(4);
  });
  it('a header below row 60 is not found', async () => {
    const { res } = await pick(await base({ titleRows: 60 }));
    expect(res).toMatchObject({ ok: false, code: 'header-mismatch' });
  });
  it('lists tabs; hidden and chart tabs are not available', async () => {
    const b = await buildWorkbook({ tabs: [
      { name: 'Tracker', rows: baseRows() },
      { name: 'Old', state: 'hidden', rows: baseRows() },
      { name: 'Chart', kind: 'chartsheet' },
    ] });
    const wb = await G.openWorkbook(b);
    const tabs = await G.listTabs(wb);
    expect(tabs.map((t) => [t.name, t.kind, t.available])).toEqual([['Tracker', 'worksheet', true], ['Old', 'worksheet', false], ['Chart', 'chartsheet', false]]);
    const res = await G.pickTab(wb);
    expect(res.ok && res.tab).toBe('Tracker');
    expect(await G.pickTab(wb, { tab: 'Old' })).toMatchObject({ ok: false, code: 'tab-unavailable' });
  });
  it('several qualifying tabs -> needs-tab-choice; explicit and stored tab honored', async () => {
    const b = await buildWorkbook({ tabs: [{ name: 'Week 44', rows: baseRows() }, { name: 'Week 45', rows: baseRows() }] });
    const wb = await G.openWorkbook(b);
    const r = await G.pickTab(wb);
    expect(r.code).toBe('needs-tab-choice');
    expect(r.tabs.map((t) => [t.name, t.qualifies, t.headerRow, t.dataRows])).toEqual([['Week 44', true, 1, 3], ['Week 45', true, 1, 3]]);
    expect((await G.pickTab(wb, { tab: 'Week 45' })).tab).toBe('Week 45');
    expect((await G.pickTab(wb, { storedTab: 'Week 44' })).tab).toBe('Week 44');
    expect((await G.pickTab(wb, { storedTab: 'Gone' })).code).toBe('needs-tab-choice');
  });
  it('no qualifying tab -> header-mismatch with header names only', async () => {
    const headers = EXPECTED_HEADERS.slice(); headers[17] = 'Comments';
    const b = await buildWorkbook({ tabs: [{ name: 'Tracker', headers, rows: [unitRow('AB100', { R: SECRET_CELL_TEXT })] }] });
    const { res } = await pick(b);
    expect(res).toMatchObject({ ok: false, code: 'header-mismatch' });
    expect(res.missing).toEqual(['Required Notes for ALL Units']);
    expect(JSON.stringify(res)).not.toContain(SECRET_CELL_TEXT);
    expect(JSON.stringify(res)).not.toContain('Comments');
  });
  it('non-qualifying tab choice: selectable only when Asset ID and the three targets resolve uniquely', async () => {
    const few = EXPECTED_HEADERS.map((h, i) => ([2, 13, 14, 17].includes(i) ? h : 'x' + i));
    const b = await buildWorkbook({ tabs: [{ name: 'Few', headers: few, rows: baseRows() }] });
    const wb = await G.openWorkbook(b);
    const auto = await G.pickTab(wb);
    expect(auto.code).toBe('header-mismatch');
    expect(auto.tabs[0]).toMatchObject({ name: 'Few', qualifies: false, headerRow: null });
    const chosen = await G.pickTab(wb, { tab: 'Few' });
    expect(chosen.ok).toBe(true);
    expect(chosen.headerRow).toBe(1);
    const bad = few.slice(); bad[17] = 'nothing';
    const wb2 = await G.openWorkbook(await buildWorkbook({ tabs: [{ name: 'Few', headers: bad, rows: baseRows() }] }));
    expect(await G.pickTab(wb2, { tab: 'Few' })).toMatchObject({ ok: false, code: 'header-mismatch' });
  });
  it('targets left of N are rejected', async () => {
    const h = EXPECTED_HEADERS.slice();
    // Move Delay Reason to column M and Level 2 to N.
    h[12] = 'Delay Reason'; h[13] = 'Level 2';
    const { res } = await pick(await buildWorkbook({ tabs: [{ name: 'T', headers: h, rows: baseRows() }] }));
    expect(res).toMatchObject({ ok: false, code: 'header-mismatch' });
  });
  it('shifted columns resolve by header text (targets right of the tracker columns)', async () => {
    const h = [''].concat(EXPECTED_HEADERS); // everything shifted one column right
    const rows = [{ cells: { D: 'AB100', S: 'note' } }];
    const { res, wb } = await pick(await buildWorkbook({ tabs: [{ name: 'T', headers: h, rows }] }));
    expect(res.ok).toBe(true);
    expect(res.columns.columns.assetId.letter).toBe('D');
    expect(res.columns.targets.notes.letter).toBe('S');
    const sr = G.sheetRowsFrom(res.grid, res.headerRow, res.columns);
    expect(sr).toEqual([{ sheetRow: 2, unitKey: 'AB100', vendor: '', site: '', wo: '' }]);
    expect(wb).toBeTruthy();
  });
  it('duplicate Asset ID header -> header-duplicate with letters only', async () => {
    const h = EXPECTED_HEADERS.slice(); h[3] = 'Asset ID';
    const { res } = await pick(await buildWorkbook({ tabs: [{ name: 'T', headers: h, rows: baseRows() }] }));
    expect(res.code).toBe('header-duplicate');
    expect(res.duplicates).toEqual({ assetId: ['C', 'D'] });
  });
});

describe('tiered aliases (A8)', () => {
  it("both 'Required Notes for ALL Units' and 'Notes': notes resolves to the canonical column, other column byte-identical", async () => {
    const rows = [unitRow('AB100', { extra: { S: 'side note' } })];
    const b = await buildWorkbook({ tabs: [{ name: 'T', rows, extraHeaders: [{ col: 'S', text: 'Notes' }] }] });
    const { res } = await pick(b);
    expect(res.ok).toBe(true);
    expect(res.columns.targets.notes.letter).toBe('R');
    const out = await G.patchWorkbookBytes(b, res.part, [{ row: 2, col: R, text: 'new note' }], { allowedCols: ALLOWED });
    const x0 = await readPart(b, PART), x1 = await readPart(out.bytes, PART);
    expect(cellXml(x1, 'S2')).toBe(cellXml(x0, 'S2'));
    expect(cellXml(x1, 'S1')).toBe(cellXml(x0, 'S1'));
  });
  it("only 'Notes': resolves to it", async () => {
    const h = EXPECTED_HEADERS.slice(); h[17] = 'Notes';
    const { res } = await pick(await buildWorkbook({ tabs: [{ name: 'T', headers: h, rows: baseRows() }] }));
    expect(res.ok).toBe(true);
    expect(res.columns.targets.notes.letter).toBe('R');
  });
  it('two canonical columns: header-duplicate with letters only', async () => {
    const b = await buildWorkbook({ tabs: [{ name: 'T', rows: baseRows(), extraHeaders: [{ col: 'S', text: 'Required Notes for ALL Units' }] }] });
    const { res } = await pick(b);
    expect(res.code).toBe('header-duplicate');
    expect(res.duplicates).toEqual({ notes: ['R', 'S'] });
  });
  it('duplicate in tier 2 only: header-duplicate', async () => {
    const h = EXPECTED_HEADERS.slice(); h[17] = 'Notes';
    const b = await buildWorkbook({ tabs: [{ name: 'T', headers: h, rows: baseRows(), extraHeaders: [{ col: 'S', text: 'Required notes' }] }] });
    const { res } = await pick(b);
    expect(res.code).toBe('header-duplicate');
    expect(res.duplicates).toEqual({ notes: ['R', 'S'] });
  });
  it("tier-2 aliases resolve: 'Escalation Action', 'Escalation Level / Action', 'AssetID'", () => {
    const h = EXPECTED_HEADERS.slice();
    h[14] = 'Escalation Action'; h[2] = 'AssetID';
    let r = G.resolveColumns(h);
    expect(r.ok).toBe(true);
    expect(r.targets.escalationAction.index).toBe(O);
    expect(r.columns.assetId.index).toBe(2);
    h[14] = 'Escalation Level / Action';
    r = G.resolveColumns(h);
    expect(r.targets.escalationAction.index).toBe(O);
  });
  it('exact match only: near-miss headers do not match', () => {
    const h = EXPECTED_HEADERS.slice();
    h[17] = 'Notes for ops';
    expect(G.resolveColumns(h)).toMatchObject({ ok: false, code: 'header-mismatch' });
    h[17] = EXPECTED_HEADERS[17]; h[13] = 'Delay Reason Code';
    expect(G.resolveColumns(h)).toMatchObject({ ok: false, code: 'header-mismatch' });
  });
  it('work-order column aliases', () => {
    for (const a of ['Work Order', 'WO #', 'AMZ WO', 'Vendor Work Order', 'LT ID']) {
      const h = EXPECTED_HEADERS.slice(); h[18] = a;
      expect(G.resolveColumns(h).woCol).toEqual({ index: 18, letter: 'S' });
    }
  });
  it('scoreHeaderRow counts the 18 expected headers', () => {
    expect(G.scoreHeaderRow(EXPECTED_HEADERS)).toBe(18);
    expect(G.scoreHeaderRow(['Asset ID'])).toBe(1);
  });
});

describe('worksheet scanner', () => {
  it('shared / inline / numeric Asset IDs, rich text, entities, _x000D_', async () => {
    const rows = [
      unitRow('AB100', { idType: 's', N: 'A &amp; B <c>' }),
      unitRow('AB101', { idType: 'inlineStr' }),
      unitRow('520024', { idType: 'n' }),
      unitRow('AB103', { R: 'line1_x000D_\nline2' }),
    ];
    const b = await buildWorkbook({ tabs: [{ name: 'T', rows, richText: { R2: ['Run one ', 'run two'] } }] });
    const { res } = await pick(b);
    const g = res.grid;
    expect([2, 3, 4, 5].map((r) => g.text(r, 2))).toEqual(['AB100', 'AB101', '520024', 'AB103']);
    expect(g.text(2, N)).toBe('A &amp; B <c>');
    expect(g.text(2, R)).toBe('Run one run two');
    expect(g.text(5, R)).toBe('line1\r\nline2');
  });
  it('self-closing rows and cells do not swallow the next row', async () => {
    const rows = [{ ...unitRow('AB100', {}), r: 3 }, { ...unitRow('AB101', { N: 'Parts Delay' }), r: 5 }];
    const b = await buildWorkbook({ tabs: [{ name: 'T', rows, emptyRows: [2, 4], selfClosingCells: ['N3', 'R3'] }] });
    const x = await readPart(b, PART);
    expect(x).toContain('<row r="2" spans="1:19"/>');
    expect(x).toContain('<c r="N3" s="1"/>');
    const wb = await G.openWorkbook(b);
    const g = await G.readGrid(wb, 'T');
    expect(g.scan.rows.map((r) => r.r)).toEqual([1, 2, 3, 4, 5]);
    expect(g.rowByNum.get(2).selfClosing).toBe(true);
    expect(g.rowByNum.get(4).cells).toHaveLength(0);
    expect(g.cell(3, N)).toBeTruthy();
    expect(g.text(3, N)).toBe('');
    expect(g.text(5, N)).toBe('Parts Delay');
    expect(g.text(5, 2)).toBe('AB101');
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 3, col: N, text: 'Weather' }, { row: 4, col: R, text: 'n4' }], { allowedCols: ALLOWED });
    const y = await readPart(out.bytes, PART);
    expect(cellXml(y, 'N3')).toBe('<c r="N3" s="1" t="inlineStr"><is><t xml:space="preserve">Weather</t></is></c>');
    expect(y).toContain('<row r="4"><c r="R4" t="inlineStr">');
    expect(await G.selfCheck(b, out.bytes, PART, [{ row: 3, col: N, text: 'Weather' }, { row: 4, col: R, text: 'n4' }])).toEqual({ ok: true });
  });
  it('prefixed namespace -> unsupported-xml', async () => {
    const raw = '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"/></x:sheetData></x:worksheet>';
    const b = await buildWorkbook({ tabs: [{ name: 'T', rawXml: raw }] });
    const wb = await G.openWorkbook(b);
    await expect(G.readGrid(wb, 'T')).rejects.toMatchObject({ code: 'unsupported-xml' });
  });
  it('inline <dataValidation> list parsing; range-referenced lists carry no items', async () => {
    const b = await base({ validations: [{ sqref: 'N2:N500', formula1: '"Parts Delay,Weather,Bogus"' }, { sqref: 'O2:O500', formula1: 'Lists!$A$1:$A$4' }] });
    const { res } = await pick(b);
    expect(G.validationFor(res.grid, 3, N)).toEqual({ kind: 'inline', items: ['Parts Delay', 'Weather', 'Bogus'] });
    expect(G.validationFor(res.grid, 3, O)).toEqual({ kind: 'range', items: null });
    expect(G.validationFor(res.grid, 3, R)).toBe(null);
  });
});

describe('patcher invariants', () => {
  it('writes an inline string keeping the existing s=, escapes &/< and newlines, = stays text', async () => {
    const b = await base({ cellStyles: { N2: 2 } });
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 2, col: N, text: '=SUM(A1) & <b>\n- two' }], { allowedCols: ALLOWED });
    const x = await readPart(out.bytes, PART);
    expect(cellXml(x, 'N2')).toBe('<c r="N2" s="2" t="inlineStr"><is><t xml:space="preserve">=SUM(A1) &amp; &lt;b&gt;&#10;- two</t></is></c>');
    const wb = await G.openWorkbook(out.bytes);
    const g = await G.readGrid(wb, 'Tracker');
    expect(g.text(2, N)).toBe('=SUM(A1) & <b>\n- two');
    expect(g.cell(2, N).hasF).toBe(false);
  });
  it('inserts missing cells in column order, drops spans, extends the dimension', async () => {
    const b = await base({ dimension: 'A1:N4' });
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 3, col: R, text: 'r3' }, { row: 3, col: O, text: 'SEV2' }, { row: 3, col: N, text: 'Weather' }], { allowedCols: ALLOWED });
    expect(out.inserted).toBe(3);
    const x = await readPart(out.bytes, PART);
    const row3 = /<row r="3"[^>]*>/.exec(x)[0];
    expect(row3).not.toContain('spans');
    const refs = [...cellsOfRow(x, 3).matchAll(/<c r="([A-Z]+)3"/g)].map((m) => m[1]);
    expect(refs).toEqual(['C', 'E', 'I', 'N', 'O', 'R']);
    expect(x).toContain('<dimension ref="A1:R4"/>');
    expect(/<row r="2"[^>]*>/.exec(x)[0]).toContain('spans');
  });
  it('expands a self-closing row', async () => {
    const b = await base({ rows: baseRows().concat([{ selfClosing: true }]) });
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 5, col: N, text: 'Towing' }], { allowedCols: ALLOWED });
    const x = await readPart(out.bytes, PART);
    expect(x).toContain('<row r="5"><c r="N5" t="inlineStr"><is><t xml:space="preserve">Towing</t></is></c></row>');
  });
  it('never A to M: column 12 throws; A-M cells byte-identical after a legitimate patch', async () => {
    const b = await base();
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: 12, text: 'x' }], { allowedCols: [12, N, O, R] })).rejects.toBeInstanceOf(G.ForbiddenColumnError);
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: 2, text: 'x' }], { allowedCols: ALLOWED })).rejects.toMatchObject({ name: 'ForbiddenColumnError' });
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 2, col: R, text: 'n' }, { row: 3, col: N, text: 'Payment' }], { allowedCols: ALLOWED });
    const x0 = await readPart(b, PART), x1 = await readPart(out.bytes, PART);
    for (const r of [1, 2, 3, 4]) for (const L of 'ABCDEFGHIJKLM') expect(cellXml(x1, L + r)).toBe(cellXml(x0, L + r));
  });
  it('never P or Q (not in allowedCols)', async () => {
    const b = await base();
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: P, text: 'x' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.ForbiddenColumnError);
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: Q, text: 'x' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.ForbiddenColumnError);
  });
  it('never clear: empty or whitespace text throws', async () => {
    const b = await base();
    for (const t of ['', '   ', '\r\n', null]) {
      await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: R, text: t }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.EmptyPatchError);
    }
  });
  it('never add rows: a missing row throws; the row set is identical after a patch', async () => {
    const b = await base();
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 50, col: R, text: 'x' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.RowMissingError);
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 4, col: R, text: 'x' }], { allowedCols: ALLOWED });
    const rs = (x) => [...x.matchAll(/<row r="(\d+)"/g)].map((m) => m[1]);
    expect(rs(await readPart(out.bytes, PART))).toEqual(rs(await readPart(b, PART)));
  });
  it('formula and merged targets are refused; duplicate patches refused', async () => {
    const b = await base({ formulas: { N3: 'A1&B1' }, merges: ['O4:P4'] });
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 3, col: N, text: 'Payment' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.FormulaError);
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 4, col: O, text: 'SEV2' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.MergedError);
    await expect(G.patchWorkbookBytes(b, PART, [{ row: 2, col: R, text: 'a' }, { row: 2, col: R, text: 'b' }], { allowedCols: ALLOWED })).rejects.toBeInstanceOf(G.DuplicatePatchError);
  });
  it('error messages are fixed and carry no text', async () => {
    const b = await base();
    try { await G.patchWorkbookBytes(b, PART, [{ row: 99, col: R, text: SECRET_CELL_TEXT }], { allowedCols: ALLOWED }); }
    catch (e) { expect(e.message).not.toContain(SECRET_CELL_TEXT); expect(e.code).toBe('row-missing'); }
  });
});

describe('protection (A19)', () => {
  const rows = () => [unitRow('AB100', {}), unitRow('AB101', {}), { assetId: 'AB102', site: 'S', vendor: 'V', rowAttrs: 's="1" customFormat="1"', cells: {} }];
  it('protected sheet + locked target: blocked; + unlocked target: not blocked', async () => {
    const b = await buildWorkbook({ tabs: [{ name: 'T', protection: true, rows: [unitRow('AB100', { N: 'Payment', R: 'x' }), unitRow('AB101', {})], cellStyles: { R2: 1 } }] });
    const { res } = await pick(b);
    expect(G.isTargetProtected(res.grid, 2, N)).toBe(true);   // s=0 default locked
    expect(G.isTargetProtected(res.grid, 2, R)).toBe(false);  // s=1 unlocked
    expect(G.cellInfo(res.grid, 2, N).protected).toBe(true);
  });
  it("sheet='0' is ignored", async () => {
    const b = await buildWorkbook({ tabs: [{ name: 'T', protection: 'off', rows: rows() }] });
    const { res } = await pick(b);
    expect(G.isTargetProtected(res.grid, 2, N)).toBe(false);
  });
  it('missing cell inherits col/row style for lock and for the inserted <c> s=', async () => {
    const b = await buildWorkbook({ tabs: [{ name: 'T', protection: true, rows: rows(), cols: [{ min: 18, max: 18, style: 1 }, { min: 14, max: 14, style: 3 }] }] });
    const { res } = await pick(b);
    expect(G.effectiveStyle(res.grid, 2, R)).toBe(1);
    expect(G.isTargetProtected(res.grid, 2, R)).toBe(false);
    expect(G.effectiveStyle(res.grid, 2, N)).toBe(3);
    expect(G.isTargetProtected(res.grid, 2, N)).toBe(true);
    expect(G.effectiveStyle(res.grid, 4, N)).toBe(1); // row style with customFormat wins over <col>
    expect(G.isTargetProtected(res.grid, 4, N)).toBe(false);
    expect(G.effectiveStyle(res.grid, 2, O)).toBe(0);
    const out = await G.patchWorkbookBytes(b, PART, [{ row: 2, col: R, text: 'a' }, { row: 4, col: N, text: 'Payment' }, { row: 3, col: O, text: 'SEV2' }], { allowedCols: ALLOWED });
    const x = await readPart(out.bytes, PART);
    expect(cellXml(x, 'R2')).toContain('<c r="R2" s="1" t="inlineStr">');
    expect(cellXml(x, 'N4')).toContain('<c r="N4" s="1" t="inlineStr">');
    expect(cellXml(x, 'O3')).toContain('<c r="O3" t="inlineStr">');
    expect(await G.selfCheck(b, out.bytes, PART, [{ row: 2, col: R, text: 'a' }, { row: 4, col: N, text: 'Payment' }, { row: 3, col: O, text: 'SEV2' }])).toEqual({ ok: true });
  });
});

describe('selfCheck', () => {
  const patches = [{ row: 2, col: O, text: 'SEV4' }, { row: 3, col: R, text: '- a\n- b' }];
  async function good() {
    const b0 = await base();
    const { bytes } = await G.patchWorkbookBytes(b0, PART, patches, { allowedCols: ALLOWED });
    return { b0, b1: bytes };
  }
  it('passes on a good build', async () => {
    const { b0, b1 } = await good();
    expect(await G.selfCheck(b0, b1, PART, patches)).toEqual({ ok: true });
  });
  it('fails when another part changed', async () => {
    const { b0, b1 } = await good();
    const t = await tamper(b1, async (z) => { z.file('xl/sharedStrings.xml', (await z.file('xl/sharedStrings.xml').async('string')).replace('AB100', 'AB109')); });
    expect(await G.selfCheck(b0, t, PART, patches)).toEqual({ ok: false, reason: 'part-changed' });
  });
  it('fails when an untouched cell changed', async () => {
    const { b0, b1 } = await good();
    const t = await tamper(b1, async (z) => { z.file(PART, (await z.file(PART).async('string')).replace(/<c r="N2"[^>]*>[\s\S]*?<\/c>/, '<c r="N2" t="inlineStr"><is><t>Weather</t></is></c>')); });
    expect((await G.selfCheck(b0, t, PART, patches)).ok).toBe(false);
  });
  it('fails on an extra row', async () => {
    const { b0, b1 } = await good();
    const t = await tamper(b1, async (z) => { z.file(PART, (await z.file(PART).async('string')).replace('</sheetData>', '<row r="99"><c r="R99" t="inlineStr"><is><t>x</t></is></c></row></sheetData>')); });
    expect(await G.selfCheck(b0, t, PART, patches)).toEqual({ ok: false, reason: 'rows-differ' });
  });
  it('fails on wrong patched text', async () => {
    const { b0, b1 } = await good();
    expect(await G.selfCheck(b0, b1, PART, [{ row: 2, col: O, text: 'SEV3' }, patches[1]])).toEqual({ ok: false, reason: 'patch-mismatch' });
  });
  it('fails on a changed entry list and on a non-zip', async () => {
    const { b0, b1 } = await good();
    const t = await tamper(b1, async (z) => { z.file('xl/extra.xml', '<x/>'); });
    expect(await G.selfCheck(b0, t, PART, patches)).toEqual({ ok: false, reason: 'entries-differ' });
    expect(await G.selfCheck(b0, new Uint8Array([1, 2, 3, 4]), PART, patches)).toEqual({ ok: false, reason: 'not-zip' });
  });
  it('reads every entry through readEntryCapped (lowered cap -> too-large)', async () => {
    const { b0, b1 } = await good();
    expect(await G.selfCheck(b0, b1, PART, patches, { caps: { entryBytes: 300 } })).toEqual({ ok: false, reason: 'too-large' });
  });
  it('fails when the patched output exceeds the byte cap', async () => {
    const { b0, b1 } = await good();
    expect(await G.selfCheck(b0, b1, PART, patches, { caps: { maxBytes: 100 } })).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('collectDiagnostics (counts and booleans only)', () => {
  it('counts encodings, styles, wrap, formulas, merges, tables, protection, cfOverlap, validations', async () => {
    const rows = [
      unitRow('AB100', { idType: 's', vendor: 'Amerit', R: SECRET_CELL_TEXT }),
      unitRow('AB101', { idType: 'inlineStr', vendor: 'Other' }),
      unitRow('520024', { idType: 'n' }),
      unitRow('AB100', { idType: 's', vendor: 'Amerit' }),
    ];
    const b = await buildWorkbook({ tabs: [{
      name: 'T', rows, protection: true, table: true, formulas: { O3: 'A1' }, merges: ['N4:N5'], cellStyles: { R2: 2 },
      cf: ['N2:N100', 'A1:B2'], validations: [{ sqref: 'N2:N500', formula1: '"Parts Delay,Weather,Bogus"' }, { sqref: 'O2:O9', formula1: 'L!$A$1:$A$4' }],
    }] });
    const { res } = await pick(b);
    const d = G.collectDiagnostics(res.grid, { headerRow: res.headerRow, columns: res.columns, units: [{ equipmentId: 'AB100', vendor: 'AMERIT' }, { equipmentId: 'AB101', vendor: 'Amerit' }] });
    expect(d.idCells).toEqual({ shared: 2, inline: 1, numeric: 1 });
    expect(d.dupAssetIds).toBe(1);
    expect(d.hasWoCol).toBe(false);
    expect(d.vendorEq).toBe(2);
    expect(d.vendorNeq).toBe(1);
    expect(d.targets.tables).toBe(1);
    expect(d.targets.formulas).toBe(1);
    expect(d.targets.merged).toBe(2);
    expect(d.targets.styled).toBe(1);
    expect(d.targets.wrap).toBe(1);
    expect(d.targets.cfOverlap).toBe(1);
    expect(d.targets.protection).toEqual({ enabled: true, locked: 12, unlocked: 0 });
    expect(d.validations).toEqual([
      { col: 'N', kind: 'inline', inEnum: 2, notInEnum: 1 },
      { col: 'O', kind: 'range', inEnum: 0, notInEnum: 0 },
    ]);
    const s = JSON.stringify(d);
    expect(s).not.toContain(SECRET_CELL_TEXT);
    expect(s).not.toContain('AB100');
    expect(s).not.toContain('Amerit');
  });
});
