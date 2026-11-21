// DTNA Phase A step 2: dtnaCaseCache store key + src/dtna/store.js whitelist and prune rules.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

let tmp;
let store;
let S;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtna-store-'));
  require('../src/config/paths').setDataDir(tmp);
  store = require('../src/store');
  S = require('../src/dtna/store.js');
});
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} });
beforeEach(() => { store.save('dtnaCaseCache', { version: 1, cases: {} }); });

const A = '500gx000002E4U5AAK';
const id = (n) => '500gx' + String(n).padStart(13, '0');

describe('dtnaCaseCache registry key', () => {
  it('resolves to dtna_case_cache.json under the data dir and is JSON-backed', () => {
    expect(store.REGISTRY.dtnaCaseCache()).toBe(path.join(tmp, 'dtna_case_cache.json'));
    expect(store.SQLITE_KEYS.has('dtnaCaseCache')).toBe(false);
    const src = fs.readFileSync(require.resolve('../src/store/index.js'), 'utf8');
    const m = /const SQLITE_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(src);
    expect(m[1].includes("'dtnaCaseCache'")).toBe(false);
    // Registered on the line after decisivCaseCache.
    const lines = src.split(/\r?\n/);
    const i = lines.findIndex((l) => /^\s*decisivCaseCache:/.test(l));
    expect(/^\s*dtnaCaseCache:/.test(lines[i + 1])).toBe(true);
    // vendorWarm key is kept (legacy).
    expect(typeof store.REGISTRY.vendorWarm).toBe('function');
  });
});

describe('put / get / all / findByUnit', () => {
  it('put keeps whitelisted fields only (auth values dropped, nested items whitelisted)', () => {
    const now = Date.now();
    const saved = S.put({
      caseId: A, unitId: '122269', caseStatus: 'Open', pulledAt: new Date(now).toISOString(),
      token: 'SECRET_TOKEN', context: 'SECRET_CONTEXT', pageURI: '/x?y', cookies: 'c=1', source: 'other',
      steps: [{ name: 'Arrived', status: 'Complete', at: '2026-09-22T13:00:00Z', secret: 'S' }],
      comments: [{ id: 'c1', type: 'General', at: '2026-09-22T13:00:00Z', from: 'AFP FAS', text: 'hello', raw: { token: 'T' } }],
      commentCount: 1,
    });
    expect(saved.source).toBe('aura');
    expect(saved.token).toBeUndefined();
    expect(saved.context).toBeUndefined();
    expect(Object.keys(saved).sort()).toEqual(S.ENTRY_FIELDS.slice().sort());
    expect(saved.steps[0]).toEqual({ name: 'Arrived', status: 'Complete', at: '2026-09-22T13:00:00Z' });
    expect(saved.comments[0]).toEqual({ id: 'c1', type: 'General', at: '2026-09-22T13:00:00Z', from: 'AFP FAS', text: 'hello' });
    const file = fs.readFileSync(path.join(tmp, 'dtna_case_cache.json'), 'utf8');
    expect(file).not.toMatch(/SECRET_TOKEN|SECRET_CONTEXT|c=1/);
    expect(S.get(A)).toEqual(saved);
    expect(S.all()).toHaveLength(1);
    expect(S.findByUnit(' #122269')).toHaveLength(1);
    expect(S.findByUnit('nope')).toHaveLength(0);
  });

  it('refuses an invalid case id', () => {
    expect(S.put({ caseId: 'bad' })).toBeNull();
    expect(S.get('bad')).toBeNull();
    expect(S.all()).toHaveLength(0);
  });
});

describe('prune', () => {
  it('drops entries older than 30 days', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    const cases = {
      [id(1)]: { caseId: id(1), pulledAt: '2026-10-30T00:00:00Z' },
      [id(2)]: { caseId: id(2), pulledAt: '2026-09-01T00:00:00Z' },
      [id(3)]: { caseId: id(3) },
    };
    expect(Object.keys(S.prune(cases, now))).toEqual([id(1)]);
  });

  it('keeps the newest 500 by pulledAt', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    const cases = {};
    for (let i = 0; i < 510; i++) cases[id(i)] = { caseId: id(i), pulledAt: new Date(now - i * 60e3).toISOString() };
    const out = S.prune(cases, now);
    expect(Object.keys(out)).toHaveLength(500);
    expect(out[id(0)]).toBeTruthy();
    expect(out[id(499)]).toBeTruthy();
    expect(out[id(500)]).toBeUndefined();
  });

  it('put prunes on write', () => {
    const now = Date.now();
    store.save('dtnaCaseCache', { version: 1, cases: { [id(7)]: { caseId: id(7), pulledAt: new Date(now - 40 * 864e5).toISOString() } } });
    S.put({ caseId: A, pulledAt: new Date(now).toISOString() }, { now });
    expect(S.get(id(7))).toBeNull();
    expect(S.get(A)).toBeTruthy();
  });
});
