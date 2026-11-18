// tests/aap-search-filters.test.js - optional server-side search filters
// (src/scrapers/aap_search_filters.js + aap_api._searchBody / searchServices / searchAllPages):
// each key only when provided, cleaning rules, category / statuses / date keys never settable,
// and a byte-identical body when no filters are given.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const SF = require('../src/scrapers/aap_search_filters');
const aap = require('../src/scrapers/aap_api');
const { DEFAULT_SEARCH_REQUEST } = require('../src/scrapers/aap_longdwell');

const ARRAY_KEYS = ['vendors', 'assetDomicileSites', 'workOrderDelayReasons', 'escalations', 'suggestedItemsL1', 'suggestedItemsL2'];
const START = 'totalEstimatePendingApprovalStartCost';
const END = 'totalEstimatePendingApprovalEndCost';

// Representative requests from the real callers.
const REQS = {
  historyBody: { equipmentIds: ['B62020'], statuses: [], lifecycleStates: null, assetPrograms: null, page: 1 },
  fleetWoReq: { fleetIds: aap.SCOPE_FLEET_IDS.slice(), assetDomicileSites: ['ABE40', 'TUZR'] },
  findOpenWO: { equipmentIds: ['B62020'], statuses: [], fleetIds: aap.SCOPE_FLEET_IDS.slice(), page: 1 },
  empty: {},
};

beforeEach(() => SF._resetWarningsForTest());

describe('cleanSearchFilters', () => {
  it('exports the 8 filter keys and every date key of DEFAULT_SEARCH_REQUEST', () => {
    expect(SF.SEARCH_FILTER_KEYS).toEqual([...ARRAY_KEYS, START, END]);
    const dateKeys = Object.keys(DEFAULT_SEARCH_REQUEST).filter((k) => /EpochMs(Relative)?$/.test(k));
    expect([...SF.DEFERRED_DATE_FILTER_KEYS].sort()).toEqual(dateKeys.sort());
  });

  it('each key appears only when provided', () => {
    for (const k of ARRAY_KEYS) expect(SF.cleanSearchFilters({ [k]: ['A1'] })).toEqual({ [k]: ['A1'] });
    expect(SF.cleanSearchFilters({ [START]: 100 })).toEqual({ [START]: 100 });
    expect(SF.cleanSearchFilters({ [END]: 0 })).toEqual({ [END]: 0 });
    expect(SF.cleanSearchFilters({})).toEqual({});
    expect(SF.cleanSearchFilters(null)).toEqual({});
    expect(SF.cleanSearchFilters('vendors')).toEqual({});
    expect(SF.cleanSearchFilters([['vendors', ['X']]])).toEqual({});
  });

  it('omits empty values and drops non-strings, control chars and over-long values', () => {
    expect(SF.cleanSearchFilters({ vendors: [], escalations: [' ', ''], suggestedItemsL1: 'TIRES' })).toEqual({});
    expect(SF.cleanSearchFilters({ vendors: [' COX ', 7, null, 'a\u0007b', 'x'.repeat(101), 'x'.repeat(100)] }))
      .toEqual({ vendors: ['COX', 'x'.repeat(100)] });
  });

  it('uppercases and de-duplicates assetDomicileSites; caps at 200 entries', () => {
    expect(SF.cleanSearchFilters({ assetDomicileSites: ['abe40', 'ABE40', ' phl40 '] })).toEqual({ assetDomicileSites: ['ABE40', 'PHL40'] });
    expect(SF.cleanSearchFilters({ vendors: ['cox', 'COX', 'cox'] })).toEqual({ vendors: ['cox', 'COX'] });
    const many = Array.from({ length: 250 }, (_, i) => 'S' + i);
    expect(SF.cleanSearchFilters({ assetDomicileSites: many }).assetDomicileSites).toHaveLength(200);
  });

  it('validates costs: non-number / negative / non-finite dropped; start > end drops both', () => {
    expect(SF.cleanSearchFilters({ [START]: '100', [END]: -1 })).toEqual({});
    expect(SF.cleanSearchFilters({ [START]: NaN, [END]: Infinity })).toEqual({});
    expect(SF.cleanSearchFilters({ [START]: 500, [END]: 100 })).toEqual({});
    expect(SF.cleanSearchFilters({ [START]: 100, [END]: 500 })).toEqual({ [START]: 100, [END]: 500 });
    expect(SF.cleanSearchFilters({ [START]: 500, [END]: 100, vendors: ['COX'] })).toEqual({ vendors: ['COX'] });
  });

  it('ignores category, statuses, fleetIds and every date-window key', () => {
    const f = { category: null, statuses: [], fleetIds: null };
    for (const k of SF.DEFERRED_DATE_FILTER_KEYS) f[k] = 1700000000000;
    expect(SF.cleanSearchFilters(f)).toEqual({});
  });
});

describe('_searchBody', () => {
  it('category / statuses / date keys in filters never reach the body', () => {
    const f = { category: null, statuses: [] };
    for (const k of SF.DEFERRED_DATE_FILTER_KEYS) f[k] = 1700000000000;
    const body = aap._searchBody({}, f);
    expect(body.category).toBe('UNPLANNED');
    expect(body.statuses).toEqual(DEFAULT_SEARCH_REQUEST.statuses);
    for (const k of SF.DEFERRED_DATE_FILTER_KEYS) expect(body[k]).toBeNull();
    expect(aap._searchBody({ category: 'PLANNED' }, { category: 'UNPLANNED' }).category).toBe('PLANNED');
  });

  it('no filters -> byte-identical body for the real callers', () => {
    for (const req of Object.values(REQS)) {
      const want = JSON.stringify(Object.assign({}, DEFAULT_SEARCH_REQUEST, req));
      expect(JSON.stringify(aap._searchBody(req))).toBe(want);
      expect(JSON.stringify(aap._searchBody(req, {}))).toBe(want);
      expect(JSON.stringify(aap._searchBody(req, { vendors: [] }))).toBe(want);
    }
    expect(JSON.stringify(aap._searchBody(undefined))).toBe(JSON.stringify(DEFAULT_SEARCH_REQUEST));
  });

  it('a provided filter overrides only its own key', () => {
    const body = aap._searchBody(REQS.findOpenWO, { vendors: ['COX'], [START]: 1000 });
    const want = Object.assign({}, DEFAULT_SEARCH_REQUEST, REQS.findOpenWO, { vendors: ['COX'], [START]: 1000 });
    expect(body).toEqual(want);
    expect(Object.keys(body)).toEqual(Object.keys(want));
  });
});

describe('searchServices / searchAllPages forward filters', () => {
  // Fake browser page via the existing provider seam; captures the posted XHR body.
  function mkPage() {
    return {
      evaluate: vi.fn(async (script) => {
        if (script.includes('xhr.open(')) return { ok: true, status: 200, json: { serviceAggregates: [] } };
        if (script.includes('__aapHookInstalled')) return null;
        return 'csrf-token';
      }),
      close: vi.fn(),
    };
  }
  it('every page carries the cleaned filters (no extra keys without filters)', async () => {
    const page = mkPage();
    aap._setProviderForTest({ openPage: async () => page, kind: () => 'electron', shutdown: () => {} });
    aap._setAuthReporterForTest({ isEnabled: () => false, report: () => {} });
    try {
      await aap.searchAllPages({}, { maxPages: 2, filters: { assetDomicileSites: ['abe40'] } });
      await aap.searchServices({ page: 1 });
    } finally { aap.dispose(); }
    const posted = page.evaluate.mock.calls.map((c) => c[0]).filter((s) => s.includes('serviceaggregates/search'));
    expect(posted.length).toBe(2);
    expect(posted[0]).toContain('ABE40');
    expect(posted[1]).not.toContain('ABE40');
  });
});
