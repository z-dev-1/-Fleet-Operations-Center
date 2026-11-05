// tests/longdwell-sp-diff.test.js - preview cell classification
// (src/longdwell/sheet-diff.js), end to end on a fixture grid for buildDraft.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { buildWorkbook, unitRow } from './helpers/sheet-fixture.js';
const require = createRequire(import.meta.url);
const D = require('../src/longdwell/sheet-diff');
const G = require('../src/longdwell/xlsx-grid');
const { matchUnits } = require('../src/longdwell/sheet-match');
const C = require('../src/longdwell/sheet-columns');

describe('classifyCell', () => {
  it('empty current -> will-write; identical (CRLF / trailing space) -> no-change; different -> conflict', () => {
    expect(D.classifyCell('', 'x')).toEqual({ state: 'will-write', reason: null });
    expect(D.classifyCell('  ', 'x').state).toBe('will-write');
    expect(D.classifyCell('a\r\nb ', 'a\nb').state).toBe('no-change');
    expect(D.classifyCell('old', 'new').state).toBe('conflict');
    expect(D.classifyCell('Abc', 'abc').state).toBe('conflict');
  });
  it('blocked reasons, evaluated before anything else', () => {
    expect(D.classifyCell('x', '')).toEqual({ state: 'blocked', reason: 'empty-source' });
    expect(D.classifyCell('', '  ')).toEqual({ state: 'blocked', reason: 'empty-source' });
    expect(D.classifyCell('', 'Not a reason', { fieldKey: 'delayReason' })).toEqual({ state: 'blocked', reason: 'invalid-value' });
    expect(D.classifyCell('', 'SEV1', { fieldKey: 'escalationAction' }).reason).toBe('invalid-value');
    expect(D.classifyCell('x', 'x', { formula: true }).reason).toBe('formula');
    expect(D.classifyCell('', 'x', { merged: true }).reason).toBe('merged');
    expect(D.classifyCell('', 'x', { protected: true }).reason).toBe('protected');
    expect(D.classifyCell('', 'Parts Delay', { fieldKey: 'delayReason' }).state).toBe('will-write');
  });
  it('edited text re-derivation: edit equal to the sheet -> no-change, over non-empty -> conflict, over empty -> will-write', () => {
    expect(D.classifyCell('Sheet text', 'Sheet text ').state).toBe('no-change');
    expect(D.classifyCell('Sheet text', 'edited').state).toBe('conflict');
    expect(D.classifyCell('', 'edited').state).toBe('will-write');
  });
});

describe('validateCellText (server-side)', () => {
  it('rejects empty/whitespace, >4000, non-enum; accepts multi-line notes; strips controls and tabs', () => {
    expect(C.validateCellText('notes', '').ok).toBe(false);
    expect(C.validateCellText('notes', ' \n ').ok).toBe(false);
    expect(C.validateCellText('notes', 'y'.repeat(4001)).ok).toBe(false);
    expect(C.validateCellText('delayReason', 'Bogus').ok).toBe(false);
    expect(C.validateCellText('escalationAction', 'sev2').ok).toBe(false);
    expect(C.validateCellText('notes', '- a\n- b\u0001\tc')).toEqual({ ok: true, text: '- a\n- b c' });
  });
});

describe('validation-mismatch chip', () => {
  it('inline list only, case-insensitive exact', () => {
    const v = { kind: 'inline', items: ['Parts Delay', 'Weather'] };
    expect(D.validationMismatch(v, 'parts delay')).toBe(false);
    expect(D.validationMismatch(v, 'Towing')).toBe(true);
    expect(D.validationMismatch({ kind: 'range', items: null }, 'Towing')).toBe(false);
    expect(D.validationMismatch(null, 'Towing')).toBe(false);
  });
});

async function draftFor(tabSpec, units, opts = {}) {
  const bytes = await buildWorkbook({ tabs: [{ name: 'T', ...tabSpec }] });
  const wb = await G.openWorkbook(bytes);
  const res = await G.pickTab(wb);
  expect(res.ok).toBe(true);
  const rows = G.sheetRowsFrom(res.grid, res.headerRow, res.columns);
  const matches = matchUnits(rows, units, { hasWoCol: !!res.columns.woCol, ...opts });
  const cells = D.buildDraft({ units, matches, targets: res.columns.targets, cellInfo: (r, c) => G.cellInfo(res.grid, r, c) });
  return { cells, matches, res };
}
const U = (id, extra = {}) => ({ equipmentId: id, woKey: id + '-w', isPrimary: true, vendor: 'Amerit', delayReason: 'Parts Delay', escalationLevel: 'SEV3', summary: '- line 1\r\n- line 2', ...extra });

describe('buildDraft', () => {
  it('mapping covers only N, O and R (P and Q never produce a cell); ids are <row>:<letter>', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', { P: 'poc', Q: 'link' })] }, [U('AB100')]);
    expect(cells.map((c) => c.id)).toEqual(['2:N', '2:O', '2:R']);
    expect(cells.map((c) => c.header)).toEqual(['Delay Reason', 'Escalation Level Action', 'Required Notes for ALL Units']);
    expect(cells.every((c) => !['P', 'Q'].includes(c.column))).toBe(true);
  });
  it('states, defaults and editors', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', { N: 'Parts Delay', O: 'SEV5' })] }, [U('AB100')]);
    const [n, o, r] = cells;
    expect(n).toMatchObject({ state: 'no-change', selectable: false, defaultChecked: false, editor: 'select' });
    expect(n.options).toEqual(C.FIELD_MAP[0].enum);
    expect(o).toMatchObject({ state: 'conflict', current: 'SEV5', next: 'SEV3', selectable: true, defaultChecked: false, editor: 'select' });
    expect(r).toMatchObject({ state: 'will-write', next: '- line 1\n- line 2', selectable: true, defaultChecked: true, editor: 'textarea' });
    expect(r.options).toBeUndefined();
  });
  it('empty-source and invalid-value are blocked (never clears)', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', { R: 'keep me' })] }, [U('AB100', { delayReason: 'Nope', escalationLevel: '', summary: '' })]);
    expect(cells.map((c) => [c.state, c.reason, c.selectable])).toEqual([
      ['blocked', 'invalid-value', false], ['blocked', 'empty-source', false], ['blocked', 'empty-source', false],
    ]);
  });
  it('formula / merged / protected+locked -> blocked; protected+unlocked -> will-write', async () => {
    const { cells } = await draftFor({
      rows: [unitRow('AB100', {}), unitRow('AB101', {})],
      formulas: { N2: 'A1' }, merges: ['O2:P2'], protection: true, cellStyles: { N3: 1 }, selfClosingCells: ['N3'],
    }, [U('AB100'), U('AB101')]);
    const by = Object.fromEntries(cells.map((c) => [c.id, [c.state, c.reason]]));
    expect(by['2:N']).toEqual(['blocked', 'formula']);
    expect(by['2:O']).toEqual(['blocked', 'merged']);
    expect(by['2:R']).toEqual(['blocked', 'protected']);
    expect(by['3:N']).toEqual(['will-write', null]);
    expect(by['3:O']).toEqual(['blocked', 'protected']);
  });
  it('needsConfirm and vendor matches are never ticked by default', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', {}), unitRow('AB101', { vendor: 'Amerit' }), unitRow('AB101', { vendor: 'Rush' })] },
      [U('AB100'), { ...U('AB100'), woKey: 'second', isPrimary: false }, U('AB101', { vendor: 'RUSH' })]);
    const r2 = cells.filter((c) => c.sheetRow === 2);
    expect(r2.every((c) => c.state === 'will-write' && c.defaultChecked === false && c.warnings.includes('needs-confirm'))).toBe(true);
    const r4 = cells.filter((c) => c.sheetRow === 4);
    expect(r4).toHaveLength(3);
    expect(r4.every((c) => c.defaultChecked === false && c.warnings.includes('vendor-match'))).toBe(true);
  });
  it('validation-mismatch keeps the state but unticks', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', {})], validations: [{ sqref: 'N2:N9', formula1: '"Weather,Towing"' }] }, [U('AB100')]);
    expect(cells[0]).toMatchObject({ state: 'will-write', defaultChecked: false, selectable: true });
    expect(cells[0].warnings).toContain('validation-mismatch');
    expect(cells[1].warnings).not.toContain('validation-mismatch');
  });
  it('a note over 4000 chars is clipped and flagged', async () => {
    const { cells } = await draftFor({ rows: [unitRow('AB100', {})] }, [U('AB100', { summary: 'z'.repeat(4100) })]);
    expect(cells[2].next).toHaveLength(4000);
    expect(cells[2].warnings).toContain('clipped');
  });
  it('unmatched units produce no cell', async () => {
    const { cells, matches } = await draftFor({ rows: [unitRow('AB100', {}), unitRow('AB100', {})] }, [U('AB100'), U('ZZ9')]);
    expect(matches.map((m) => m.match)).toEqual(['ambiguous', 'not-in-sheet']);
    expect(cells).toEqual([]);
  });
});

describe('recheckCell (write time)', () => {
  const pm = { sheetRow: 5, via: 'unit' };
  const ok = { match: 'matched', sheetRow: 5, via: 'unit' };
  it('row moved or rule changed -> changed-since-preview (row-moved)', () => {
    const moved = { status: 'skipped', reason: 'changed-since-preview', detail: 'row-moved' };
    expect(D.recheckCell({ previewMatch: pm, rematch: { ...ok, sheetRow: 6 }, previewCurrent: '', currentNow: '', next: 'x' })).toEqual(moved);
    expect(D.recheckCell({ previewMatch: pm, rematch: { ...ok, via: 'vendor' }, previewCurrent: '', currentNow: '', next: 'x' })).toEqual(moved);
    expect(D.recheckCell({ previewMatch: pm, rematch: { match: 'ambiguous', sheetRow: null }, previewCurrent: '', currentNow: '', next: 'x' })).toEqual(moved);
    expect(D.recheckCell({ previewMatch: pm, rematch: null, previewCurrent: '', currentNow: '', next: 'x' })).toEqual(moved);
  });
  it('value changed -> changed-since-preview (value-changed); now equal -> no-change; else patch', () => {
    expect(D.recheckCell({ previewMatch: pm, rematch: ok, previewCurrent: '', currentNow: 'someone', next: 'x' }))
      .toEqual({ status: 'skipped', reason: 'changed-since-preview', detail: 'value-changed' });
    expect(D.recheckCell({ previewMatch: pm, rematch: ok, previewCurrent: 'x', currentNow: 'x ', next: 'x' })).toEqual({ status: 'skipped', reason: 'no-change' });
    expect(D.recheckCell({ previewMatch: pm, rematch: ok, previewCurrent: 'old', currentNow: 'old', next: 'new' })).toEqual({ status: 'patch' });
    expect(D.recheckCell({ previewMatch: pm, rematch: ok, previewCurrent: '', currentNow: '', next: 'x', formula: true })).toEqual({ status: 'skipped', reason: 'formula' });
  });
});

describe('deriveWriteStatus', () => {
  it('ok / verification-pending / partial-failure / failed / no-op / blocked / auth-failed', () => {
    const w = { status: 'written', verified: true };
    expect(D.deriveWriteStatus({ cells: [w, { status: 'conflict', reason: 'not-approved' }] })).toEqual({ status: 'ok', ok: true });
    expect(D.deriveWriteStatus({ cells: [w, { status: 'written', verified: false }] }).status).toBe('verification-pending');
    expect(D.deriveWriteStatus({ cells: [w, { status: 'failed', reason: 'locked' }] }).status).toBe('partial-failure');
    expect(D.deriveWriteStatus({ cells: [w, { status: 'skipped', reason: 'changed-since-preview' }] }).status).toBe('partial-failure');
    expect(D.deriveWriteStatus({ cells: [{ status: 'failed', reason: 'locked' }] })).toEqual({ status: 'failed', ok: false });
    expect(D.deriveWriteStatus({ cells: [{ status: 'skipped', reason: 'no-change' }] })).toEqual({ status: 'no-op', ok: true });
    expect(D.deriveWriteStatus({ cells: [] })).toEqual({ status: 'no-op', ok: true });
    expect(D.deriveWriteStatus({ gate: 'write-disabled', cells: [w] })).toEqual({ status: 'blocked', ok: false });
    expect(D.deriveWriteStatus({ authFailed: true, cells: [] })).toEqual({ status: 'auth-failed', ok: false });
  });
});
