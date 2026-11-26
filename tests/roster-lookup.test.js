// tests/roster-lookup.test.js — src/orcha/fas/roster-lookup.js fasForExact (Fleet Health FAS Name
// cell, design §3.12): exact SCAC+Site pair only, order-agnostic, '' otherwise, '' when the store
// throws. fasFor's fallbacks are unchanged. The store is stubbed through the module's require.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
function inject(rel, exp) { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; }

let roster = null;
let fail = false;
let stamp = 0;
inject('../src/store/index.js', {
  load(name, def) {
    if (fail) throw new Error('disk');
    return name === 'fasRoster' && roster ? roster : def;
  },
});
const R = require('../src/orcha/fas/roster-lookup');

function setRoster(rows) {
  stamp += 1; // a new fetchedAt invalidates the module's index cache
  roster = { fetchedAt: '2026-11-20T00:00:0' + stamp + 'Z', rows };
}

beforeEach(() => {
  fail = false;
  setRoster([
    { 'FAS Name': 'Z Person', SCAC: 'AUVTE', 'Site Code': 'ROC5' },
    { 'FAS Name': 'Z Person', SCAC: 'TUZR', 'Site Code': 'ABE40' },
    { 'FAS Name': 'Solo Site', SCAC: 'YTSC', 'Site Code': 'AVP40' },
  ]);
});

describe('fasForExact', () => {
  it('exact pair in either order -> the roster name (normalized match)', () => {
    expect(R.fasForExact('AUVTE', 'ROC5')).toBe('Z Person');
    expect(R.fasForExact('ROC5', 'AUVTE')).toBe('Z Person');
    expect(R.fasForExact(' tuzr ', 'abe40')).toBe('Z Person');
  });

  it("site-only / SCAC-only / unknown pair -> '' (fasFor still falls back)", () => {
    expect(R.fasForExact('AGNLI', 'AVP40')).toBe('');
    expect(R.fasFor('AGNLI', 'AVP40')).toBe('Solo Site');
    expect(R.fasForExact('', 'AVP40')).toBe('');
    expect(R.fasForExact('YTSC', '')).toBe('');
    expect(R.fasForExact(null, undefined)).toBe('');
  });

  it("a throwing store -> '' (and rosterSize 0)", () => {
    setRoster([]); // drop the cached index
    fail = true;
    expect(R.fasForExact('AUVTE', 'ROC5')).toBe('');
    expect(R.rosterSize()).toBe(0);
  });
});
