// tests/autopilot-dealer-relevance.test.js — a dealer case linked on the case
// (ap_case.dealer_cases_json) keeps that dealer source relevant in the source plan: decisiv /
// dtna are never skipped_not_relevant when a case of that kind is linked. The live-read policy
// is unchanged (cache at minimum; a live read still needs warmth and an origin URL).
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const evidence = require('../src/autopilot/evidence');
const { planSources, linkedDealerCases, rowWithLinkedDecisiv } = require('../src/autopilot/plan');

const NOW = Date.parse('2026-11-26T15:00:00Z');

// A row with no Decisiv id or URL and no DTNA URL (the 321838 shape at plan time).
function row(extra) {
  return Object.assign({
    equipmentId: '321838', domicileSite: 'ABE40', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair',
    _serviceId: 'svc-1', workRequestId: 'wr-1', vendor: "Bergey's Truck Centers - Pennsauken Volvo",
  }, extra || {});
}

const input = (r, over) => Object.assign({
  row: r, now: NOW, features: { evidenceCollection: true, liveReads: true },
  gate: { aap: true, decisiv: true }, aapWarm: true, decisivWarm: false,
  budget: { aap_live: true, decisiv: true }, dtnaCount: 0, hasEmail: false, hasFasCase: false,
  longDwellListed: false, aperiaCache: null,
}, over || {});

const DEC = [{ id: '21409444', kind: 'decisiv', firstSeenAt: NOW - 1e6, lastSeenAt: NOW }];
const DTNA = [{ id: '12345678', kind: 'dtna', firstSeenAt: NOW - 1e6, lastSeenAt: NOW }];

describe('linked dealer case keeps the dealer source relevant', () => {
  it('a linked decisiv case: decisiv is included, not skipped_not_relevant (array and JSON string)', () => {
    for (const dc of [DEC, JSON.stringify(DEC)]) {
      const d = planSources(input(row(), { dealerCases: dc })).bySource.decisiv;
      expect(d.status).not.toBe('skipped_not_relevant');
      expect(d.include).toBe(true);
      expect(d.live).toBe(false);   // no origin URL: no live read, cache only
      expect(d.status).toMatch(/^cache_only:/);
    }
  });

  it('a linked dtna case: dtna is included as cache_only:live_disabled_v1', () => {
    const d = planSources(input(row(), { dealerCases: DTNA })).bySource.dtna;
    expect(d).toMatchObject({ include: true, live: false, status: 'cache_only:live_disabled_v1' });
    // A dtna link does not make decisiv relevant, and vice versa.
    expect(planSources(input(row(), { dealerCases: DTNA })).bySource.decisiv.status).toBe('skipped_not_relevant');
    expect(planSources(input(row(), { dealerCases: DEC })).bySource.dtna.status).toBe('skipped_not_relevant');
  });

  it('no linked dealer case: the existing not-relevant classification is unchanged', () => {
    for (const dc of [undefined, null, [], '[]', 'not json', '{"id":"1"}', [null, 'x', { id: '', kind: 'decisiv' }, { id: '9', kind: 'other' }]]) {
      const p = planSources(input(row(), { dealerCases: dc }));
      expect(p.bySource.decisiv).toMatchObject({ include: false, status: 'skipped_not_relevant' });
      expect(p.bySource.dtna).toMatchObject({ include: false, status: 'skipped_not_relevant' });
    }
  });

  it('linkedDealerCases never throws on malformed input', () => {
    expect(linkedDealerCases(JSON.stringify(DEC.concat(DTNA, DEC)))).toEqual({ decisiv: ['21409444'], dtna: ['12345678'] });
    for (const v of [undefined, null, 5, '', '{', {}, [1, 'a', null]]) expect(linkedDealerCases(v)).toEqual({ decisiv: [], dtna: [] });
  });

  it('the live-read policy is unchanged: liveReads off and a closed gate still apply', () => {
    expect(planSources(input(row(), { dealerCases: DEC, features: { evidenceCollection: true, liveReads: false } })).bySource.decisiv.status).toBe('cache_only:live_reads_off');
    expect(planSources(input(row(), { dealerCases: DEC, gate: { aap: true, decisiv: false } })).bySource.decisiv.status).toBe('cache_only:gate_closed');
    expect(planSources(input(row(), { dealerCases: DEC, features: { evidenceCollection: false, liveReads: true } })).bySource.decisiv.status).toBe('skipped:evidence_collection_off');
  });

  it('rowWithLinkedDecisiv lets the existing Decisiv cache read find the linked case; no live call', async () => {
    const r0 = row();
    const r = rowWithLinkedDecisiv(r0, JSON.stringify(DEC));
    expect(r.decisivCaseId).toBe('21409444');
    expect(r0.decisivCaseId).toBeUndefined();   // the source row is not mutated
    // A row that already has its own estimate id is returned as is.
    const own = row({ decisivCaseId: '111' });
    expect(rowWithLinkedDecisiv(own, DEC)).toBe(own);
    expect(rowWithLinkedDecisiv(r0, null)).toBe(r0);

    const ports = {
      readStore: vi.fn(() => null),
      canonical: () => ({ status: 'in_repair', statusChangedAt: NOW, stale: false }),
      riEvents: () => [], riRepeat: () => [], dtnaCasesForUnit: () => [],
      slackSearch: () => ({ ok: true, results: [] }), vendorScorecards: () => [], aperiaCachedIssues: () => null,
      aapGetServiceIfWarm: vi.fn(async () => ({ ok: false, code: 'NOT_WARM' })),
      decisivCaseStatusIfWarm: vi.fn(async () => ({ ok: true, value: {} })),
      decisivActivityIfWarm: vi.fn(async () => ({ ok: true, value: { notes: [] } })),
      decisivFormatActivity: () => ({ text: '', count: 0 }),
    };
    const plan = planSources(input(r, { dealerCases: DEC, features: { evidenceCollection: true, liveReads: false } }));
    const docs = { decisivCaseCache: { 21409444: { estimateId: '21409444', stage: 'repair', stageStatus: 'In Repair', etr: '2026-11-28', scrapedAt: '2026-11-26T10:00:00Z' } } };
    const out = await evidence.collect(plan, ports, null, null, { row: r, now: NOW, syncedAt: '2026-11-26T14:00:00Z', buildAtMs: NOW, staleDays: 3, isDown: true, docs });
    expect(ports.decisivCaseStatusIfWarm).not.toHaveBeenCalled();
    expect(out.items.some((i) => i.source === 'decisiv' && i.field === 'stage')).toBe(true);
  });
});
