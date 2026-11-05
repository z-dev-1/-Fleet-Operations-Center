// DBR lookup target resolver: exact codes only, never guesses a near miss.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { buildCatalog, normKey, resolveTarget, sanitizeTarget, levenshtein } = require('../src/dbr/target-resolver');

const ROWS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dbr-lookup', 'fleet-rows.json'), 'utf8')).rows;
const AFP = { ok: true, domicile: [{ domicile: 'AUVT1', uptimePct: 80, unitsUnavailable: 3 }], scac: [{ scac: 'QSAFP', domicile: 'MKE40', uptimePct: 70, unitsUnavailable: 2 }] };
const DSP = { ok: true, scac: [{ scac: 'DSPONLY', uptimePct: 75, unitsUnavailable: 4, unitsUnavailableEstimated: true }] };
const CONTACTS = [{ type: 'domicile', name: 'BOOKONLY' }, { type: 'person', name: 'NOTASITE' }];
const cat = () => buildCatalog({ rows: ROWS, contacts: CONTACTS, qsAfp: AFP, qsDsp: DSP });

describe('normKey / sanitizeTarget / levenshtein', () => {
  it('normKey strips punctuation and uppercases', () => {
    expect(normKey('oak-w')).toBe('OAKW');
    expect(normKey('OAK W')).toBe('OAKW');
    expect(normKey(null)).toBe('');
  });
  it('sanitizeTarget accepts codes and rejects garbage', () => {
    expect(sanitizeTarget(' AUVTE ')).toBe('AUVTE');
    expect(sanitizeTarget('oak w')).toBe('oak w');
    expect(sanitizeTarget('<!channel>')).toBeNull();
    expect(sanitizeTarget('x'.repeat(200))).toBeNull();
    expect(sanitizeTarget('')).toBeNull();
    expect(sanitizeTarget(null)).toBeNull();
    expect(sanitizeTarget(42)).toBeNull();
  });
  it('levenshtein', () => {
    expect(levenshtein('AUVET', 'AUVTE')).toBe(2);
    expect(levenshtein('', 'ABC')).toBe(3);
    expect(levenshtein('ABC', 'ABC')).toBe(0);
  });
});

describe('resolveTarget', () => {
  it('exact domicile, any case', () => {
    for (const raw of ['auvte', 'AUVTE', 'Auvte']) {
      expect(resolveTarget(raw, undefined, cat())).toEqual({ status: 'ok', kind: 'domicile', code: 'AUVTE' });
    }
  });
  it('punctuation-insensitive', () => {
    expect(resolveTarget('oak w', undefined, cat())).toEqual({ status: 'ok', kind: 'domicile', code: 'OAK-W' });
  });
  it('SCAC from fleet operator', () => {
    expect(resolveTarget('abeow', undefined, cat())).toEqual({ status: 'ok', kind: 'scac', code: 'ABEOW' });
  });
  it('SCAC only in QuickSight (DSP and AFP)', () => {
    expect(resolveTarget('dsponly', undefined, cat())).toEqual({ status: 'ok', kind: 'scac', code: 'DSPONLY' });
    expect(resolveTarget('QSAFP', undefined, cat())).toEqual({ status: 'ok', kind: 'scac', code: 'QSAFP' });
    expect(resolveTarget('MKE40', undefined, cat())).toEqual({ status: 'ok', kind: 'domicile', code: 'MKE40' });
  });
  it('domicile only in the Contact Book (no fleet rows)', () => {
    expect(resolveTarget('bookonly', undefined, cat())).toEqual({ status: 'ok', kind: 'domicile', code: 'BOOKONLY' });
    expect(resolveTarget('notasite', undefined, cat()).status).toBe('unknown');
  });
  it('contacts shaped as an object', () => {
    const c = buildCatalog({ rows: [], contacts: { contacts: CONTACTS } });
    expect(resolveTarget('BOOKONLY', undefined, c)).toEqual({ status: 'ok', kind: 'domicile', code: 'BOOKONLY' });
  });
  it('a code that is both domicile and SCAC is ambiguous; a kind hint resolves it', () => {
    const c = buildCatalog({ rows: [{ domicileSite: 'BOTH1', operator: 'X1' }, { domicileSite: 'Y1', operator: 'BOTH1' }] });
    expect(resolveTarget('BOTH1', undefined, c)).toEqual({ status: 'ambiguous', options: [{ kind: 'domicile', code: 'BOTH1' }, { kind: 'scac', code: 'BOTH1' }] });
    expect(resolveTarget('BOTH1', 'scac', c)).toEqual({ status: 'ok', kind: 'scac', code: 'BOTH1' });
    expect(resolveTarget('BOTH1', 'carrier', c)).toEqual({ status: 'ok', kind: 'scac', code: 'BOTH1' });
    expect(resolveTarget('BOTH1', 'site', c)).toEqual({ status: 'ok', kind: 'domicile', code: 'BOTH1' });
    expect(resolveTarget('BOTH1', 'domicile', c)).toEqual({ status: 'ok', kind: 'domicile', code: 'BOTH1' });
  });
  it('two codes with the same normKey (OAK-W / OAKW) are ambiguous', () => {
    const c = buildCatalog({ rows: [{ domicileSite: 'OAK-W' }, { domicileSite: 'OAKW' }] });
    expect(resolveTarget('oak w', undefined, c)).toEqual({ status: 'ambiguous', options: [{ kind: 'domicile', code: 'OAK-W' }, { kind: 'domicile', code: 'OAKW' }] });
  });
  it('AUVET is unknown with AUVTE suggested, never auto-resolved', () => {
    const r = resolveTarget('AUVET', undefined, cat());
    expect(r.status).toBe('unknown');
    expect(r.suggestions).toContain('AUVTE');
    expect(r.suggestions.length).toBeLessThanOrEqual(5);
    // a single close match is still not resolved
    const only = buildCatalog({ rows: [{ domicileSite: 'AUVTE' }] });
    expect(resolveTarget('AUVET', undefined, only)).toEqual({ status: 'unknown', suggestions: ['AUVTE'] });
  });
  it('prefix/contains suggestions', () => {
    expect(resolveTarget('AUV', undefined, cat()).suggestions).toEqual(expect.arrayContaining(['AUVTE', 'AUVT1']));
  });
  it('ZZZZZ is unknown with no suggestions', () => {
    expect(resolveTarget('ZZZZZ', undefined, cat())).toEqual({ status: 'unknown', suggestions: [] });
  });
  it('mine phrases', () => {
    for (const raw of ['mine', 'my sites', 'My Domiciles', 'all', 'my carriers']) {
      expect(resolveTarget(raw, undefined, cat())).toEqual({ status: 'mine' });
    }
    expect(resolveTarget('', 'mine', cat())).toEqual({ status: 'mine' });
  });
  it('garbage inputs never throw', () => {
    for (const raw of ['', null, undefined, 'x'.repeat(200), '<!channel>', 12345, {}]) {
      expect(resolveTarget(raw, undefined, cat())).toEqual({ status: 'unknown', suggestions: [] });
    }
    expect(resolveTarget('AUVTE', undefined, null).status).toBe('unknown');
    expect(() => buildCatalog({ rows: [null, 5, {}], contacts: 'x', qsAfp: { domicile: 'no' }, qsDsp: 7 })).not.toThrow();
  });
});
