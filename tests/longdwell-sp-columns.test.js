// tests/longdwell-sp-columns.test.js - shared column source for the Long Dwell
// SharePoint preview/write feature (src/longdwell/sheet-columns.js) and the
// MANUAL_COLUMNS refactor of src/ipc/long-dwell-csv.js.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csv = require('../src/ipc/long-dwell-csv');
const ld = require('../src/ipc/long-dwell');
const C = require('../src/longdwell/sheet-columns');

describe('MANUAL_COLUMNS refactor keeps the old values', () => {
  it('MANUAL_FIELDS deep-equals the pre-refactor literal', () => {
    expect(csv.MANUAL_FIELDS).toEqual(['delayReason', 'escalationAction', 'supportPOC', 'asanaLink', 'notes']);
    expect(csv.MANUAL_FIELDS).toEqual(csv.MANUAL_COLUMNS.map((c) => c.key));
  });
  it('MANUAL_COLUMNS labels are the tracker N-R headers', () => {
    expect(csv.MANUAL_COLUMNS.map((c) => c.label)).toEqual([
      'Delay Reason', 'Escalation Level Action', 'Support Team POC',
      'Asana Link (If at SEV2)', 'Required Notes for ALL Units',
    ]);
  });
  it('MANUAL_LABELS (lower-cased, used to drop imported N-R values) is unchanged', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ipc/long-dwell-csv.js'), 'utf8');
    expect(src).toMatch(/const MANUAL_LABELS = MANUAL_COLUMNS\.map\(\(c\) => c\.label\.toLowerCase\(\)\);/);
    const derived = csv.MANUAL_COLUMNS.map((c) => c.label.toLowerCase());
    expect(derived).toEqual(['delay reason', 'escalation level action', 'support team poc', 'asana link (if at sev2)', 'required notes for all units']);
  });
  it('sheet-columns re-exports the same arrays', () => {
    expect(C.MANUAL_COLUMNS).toBe(csv.MANUAL_COLUMNS);
    expect(C.TRACKER_COLUMNS).toBe(csv.TRACKER_COLUMNS);
  });
});

describe('EXPECTED_HEADERS', () => {
  it('equals TRACKER_COLUMNS + MANUAL_COLUMNS labels (A to R)', () => {
    expect(C.EXPECTED_HEADERS).toEqual(csv.TRACKER_COLUMNS.concat(csv.MANUAL_COLUMNS.map((c) => c.label)));
    expect(C.EXPECTED_HEADERS).toHaveLength(18);
  });
  it('matches the columns shape pinned in long-dwell-merge.test.js', () => {
    expect(C.EXPECTED_HEADERS.slice(0, 13)).toEqual([
      'FAS', 'UM', 'Asset ID', 'Asset Type', 'Site', 'SCAC',
      'Lifecycle State Reason', 'Days Down', 'RG Vendor Assigned',
      'Vendor Delay Reason', 'Expected ETC', 'Level 1', 'Level 2',
    ]);
  });
  it('TRACKER_INDEX labels are Asset ID / Site / RG Vendor Assigned / Level 1 / Level 2', () => {
    const I = C.TRACKER_INDEX;
    expect(I).toEqual({ assetId: 2, site: 4, vendor: 8, level1: 11, level2: 12 });
    expect([I.assetId, I.site, I.vendor, I.level1, I.level2].map((i) => csv.TRACKER_COLUMNS[i]))
      .toEqual(['Asset ID', 'Site', 'RG Vendor Assigned', 'Level 1', 'Level 2']);
    for (const [k, i] of Object.entries(I)) expect(C.labelOf(k)).toBe(csv.TRACKER_COLUMNS[i]);
  });
});

describe('renderer MANUAL_COLS drift', () => {
  it('renderer MANUAL_COLS (parsed from longdwell-csv.js) equals MANUAL_COLUMNS', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer/src/js/views/longdwell-csv.js'), 'utf8');
    const m = /const MANUAL_COLS = \[([\s\S]*?)\];/.exec(src);
    expect(m).toBeTruthy();
    const items = [...m[1].matchAll(/\{\s*key:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}/g)].map((x) => ({ key: x[1], label: x[2] }));
    expect(items).toEqual(csv.MANUAL_COLUMNS);
  });
});

describe('FIELD_MAP (derived, A9)', () => {
  it('maps only delayReason, escalationLevel and summary to N/O/R keys', () => {
    expect(C.FIELD_MAP.map((f) => [f.from, f.key])).toEqual([
      ['delayReason', 'delayReason'], ['escalationLevel', 'escalationAction'], ['summary', 'notes'],
    ]);
    expect(C.FIELD_MAP.some((f) => f.key === 'supportPOC' || f.key === 'asanaLink')).toBe(false);
  });
  it('FIELD_MAP.header equals labelOf(key) from MANUAL_COLUMNS', () => {
    for (const f of C.FIELD_MAP) {
      expect(f.header).toBe(C.labelOf(f.key));
      expect(csv.MANUAL_COLUMNS.find((c) => c.key === f.key).label).toBe(f.header);
      expect(csv.MANUAL_FIELDS).toContain(f.key);
    }
  });
  it('enums equal ipc/long-dwell.js and notes is multiline max 4000', () => {
    expect(C.FIELD_MAP[0].enum).toBe(ld.DELAY_REASONS);
    expect(C.FIELD_MAP[1].enum).toBe(ld.ESCALATION_LEVELS);
    expect(C.FIELD_MAP[2]).toMatchObject({ multiline: true, max: 4000 });
    expect(C.FIELD_MAP[0].multiline).toBe(false);
  });
  it('every tier-1 alias equals normHeader of the shared label', () => {
    C.TRACKER_KEYS.forEach((k, i) => expect(C.HEADER_TIERS.tier1[k]).toEqual([C.normHeader(csv.TRACKER_COLUMNS[i])]));
    for (const c of csv.MANUAL_COLUMNS) expect(C.HEADER_TIERS.tier1[c.key]).toEqual([C.normHeader(c.label)]);
  });
  it('tier-2 aliases are only the non-canonical forms', () => {
    expect(C.HEADER_TIERS.tier2.escalationAction).toEqual(['escalation level / action', 'escalation action']);
    expect(C.HEADER_TIERS.tier2.notes).toEqual(['required notes', 'notes']);
    expect(C.HEADER_TIERS.tier2.asanaLink).toEqual(['asana link']);
    expect(C.HEADER_TIERS.tier2.assetId).toEqual(['assetid']);
    for (const k of C.ALL_KEYS) for (const a of C.HEADER_TIERS.tier2[k]) expect(C.HEADER_TIERS.tier1[k]).not.toContain(a);
  });
});

describe('normalizers', () => {
  it('normHeader: NFKC, lower, whitespace collapsed, trailing : and * stripped', () => {
    expect(C.normHeader('  Asset   ID: ')).toBe('asset id');
    expect(C.normHeader('Delay Reason*')).toBe('delay reason');
    expect(C.normHeader('\uff21sset ID')).toBe('asset id');
    expect(C.normHeader(null)).toBe('');
  });
  it('normUnitId: NBSP/whitespace, aaid_ prefix, case, numeric .0, leading zeros kept', () => {
    expect(C.normUnitId(' aaid_ab\u00a0123 ')).toBe('AB123');
    expect(C.normUnitId('AAID_x1')).toBe('X1');
    expect(C.normUnitId('520024.0')).toBe('520024');
    expect(C.normUnitId('0123')).toBe('0123');
    expect(C.normUnitId('0123')).not.toBe(C.normUnitId('123'));
  });
  it('normText / normKey semantics (trim, CRLF, case, punctuation)', () => {
    expect(C.normText('  a\r\nb\rc  ')).toBe('a\nb\nc');
    expect(C.normText('a\tb')).toBe('a b');
    expect(C.normText('Abc')).not.toBe(C.normText('abc'));
    expect(C.normText(null)).toBe('');
    expect(C.normKey('Amerit-Fleet, Inc.')).toBe('AMERIT FLEET INC');
    expect(C.normKey('amerit fleet inc')).toBe(C.normKey('AMERIT  FLEET-INC'));
    expect(C.normKey('Amerit')).not.toBe(C.normKey('AMERIT FLEET SOLUTIONS'));
    expect(C.normKey('WO#123')).toBe('WO 123');
  });
  it('sanitizeForCell strips control characters and keeps inner newlines', () => {
    expect(C.sanitizeForCell('a\u0000b\u0007c\n- d\u001f')).toBe('abc\n- d');
    expect(C.sanitizeForCell(undefined)).toBe('');
  });
  it('validateCellText: enums exact, notes multi-line, never empty, max 4000', () => {
    expect(C.validateCellText('delayReason', 'Parts Delay')).toEqual({ ok: true, text: 'Parts Delay' });
    expect(C.validateCellText('delayReason', 'parts delay').ok).toBe(false);
    expect(C.validateCellText('escalationAction', 'SEV2').ok).toBe(true);
    expect(C.validateCellText('escalationAction', 'SEV1').ok).toBe(false);
    expect(C.validateCellText('notes', '- a\r\n- b\t c').text).toBe('- a\n- b  c');
    expect(C.validateCellText('notes', '   ').code).toBe('invalid-text');
    expect(C.validateCellText('notes', 'x'.repeat(4001)).ok).toBe(false);
    expect(C.validateCellText('notes', 'x'.repeat(4000)).ok).toBe(true);
    expect(C.validateCellText('notes', 5).ok).toBe(false);
    expect(C.validateCellText('supportPOC', 'x').ok).toBe(false);
  });
});

describe('source hygiene', () => {
  it('sheet-columns.js is printable ASCII', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/longdwell/sheet-columns.js'), 'utf8');
    expect(/^[\x20-\x7e\r\n]*$/.test(src)).toBe(true);
  });
  it('alias tables contain no backslash escapes', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/longdwell/sheet-columns.js'), 'utf8');
    for (const name of ['EXTRA_ALIASES', 'WO_HEADER_ALIASES']) {
      const m = new RegExp('const ' + name + ' = [\\[{]([\\s\\S]*?)[\\]}];').exec(src);
      expect(m).toBeTruthy();
      expect(m[1].includes('\\')).toBe(false);
    }
  });
});
