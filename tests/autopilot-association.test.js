// tests/autopilot-association.test.js — fleet-autopilot §B7.3 unit <-> WO association.
// Fake ports and a real limiter; DTNA entries, Decisiv data and live getService results that
// do not belong to the unit are excluded and recorded as wo_association_mismatch.
process.env.TZ = 'America/New_York';
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const evidence = require('../src/autopilot/evidence');
const { planSources } = require('../src/autopilot/plan');
const { createLimiter } = require('../src/autopilot/limiter');

const NOW = Date.parse('2026-11-20T15:00:00Z');
const SR = 'https://volvopg.asist.decisiv.net/fleet/estimates/21350186';

function mkPorts(over) {
  return Object.assign({
    readStore: () => null,
    canonical: () => null,
    riEvents: () => [],
    riRepeat: () => [],
    dtnaCasesForUnit: () => [],
    slackSearch: () => ({ ok: true, results: [] }),
    vendorScorecards: () => [],
    aperiaCachedIssues: () => null,
    aapGetServiceIfWarm: vi.fn(async () => ({ ok: false, code: 'AAP_NOT_WARM' })),
    decisivCaseStatusIfWarm: vi.fn(async () => ({ ok: false, code: 'DECISIV_NOT_WARM' })),
    decisivActivityIfWarm: vi.fn(async () => ({ ok: false, code: 'DECISIV_NOT_WARM' })),
    decisivFormatActivity: () => ({ text: '', count: 0 }),
  }, over || {});
}

function baseRow(extra) {
  return Object.assign({
    equipmentId: '322283', domicileSite: 'ABE40', lifecycleState: 'Unavailable', vin: '4V4NC9EH5LN123456',
    _serviceId: 'svc-1', workRequestId: 'wr-1', _offsiteWrId: 'wr-off',
    _secondaryWRs: [{ _serviceId: 'svc-2', workRequestId: 'wr-2' }, { _serviceId: '', workRequestId: null }],
    decisivCaseId: '21350186', asistSrUrl: SR,
  }, extra || {});
}

function plan(row, over) {
  return planSources(Object.assign({
    row, now: NOW, features: { evidenceCollection: true, liveReads: true },
    gate: { aap: true, decisiv: true }, aapWarm: true, decisivWarm: true,
    budget: { aap_live: true, decisiv: true }, dtnaCount: 1,
  }, over || {}));
}

const ctx = (row, docs) => ({ row, now: NOW, syncedAt: '2026-11-20T14:00:00Z', buildAtMs: NOW - 3600e3, staleDays: 3, isDown: true, docs: docs || {} });

describe('unit <-> WO set', () => {
  it('collects primary, offsite and secondary WR ids (empty dropped) plus repair-intel open events', () => {
    const set = evidence.woSetOf(baseRow(), [
      { status: 'open', work_order_id: 'ri-wo-1', service_id: 'ri-svc-1' },
      { status: 'completed', work_order_id: 'ri-wo-closed' },
      { status: 'reopened', work_order_id: 'ri-wo-2' },
    ]);
    expect([...set].sort()).toEqual(['ri-svc-1', 'ri-wo-1', 'ri-wo-2', 'svc-1', 'svc-2', 'wr-1', 'wr-2', 'wr-off'].sort());
  });
});

describe('association rules', () => {
  it('a DTNA entry for a different unitId is excluded; a VIN-tail match counts', async () => {
    const row = baseRow();
    const ports = mkPorts({
      dtnaCasesForUnit: () => [
        { caseId: 'c-own', unitId: ' 322283 ', offsiteStage: 'repair', dealerName: 'Penske Truck Leasing' },
        { caseId: 'c-vin', unitId: 'OTHER1', vinTail: '123456', offsiteStage: 'repair' },
        { caseId: 'c-bad', unitId: '999999', vinTail: '000000', offsiteStage: 'ready' },
      ],
    });
    const out = await evidence.collect(plan(row), ports, null, null, ctx(row));
    const dtna = out.items.filter((i) => i.source === 'dtna' && i.field === 'offsiteStage');
    expect(dtna.map((i) => i.sourceRef).sort()).toEqual(['dtna/c-own', 'dtna/c-vin']);
    expect(out.items.some((i) => i.sourceRef === 'dtna/c-bad' && i.field !== 'wo_association')).toBe(false);
    const mm = out.items.filter((i) => i.field === 'wo_association');
    expect(mm).toEqual([expect.objectContaining({ source: 'dtna', sourceRef: 'dtna/c-bad', flags: ['wo_association_mismatch'] })]);
    expect(out.flags).toContain('wo_association_mismatch');
    expect(out.events).toContainEqual({ kind: 'wo_association_mismatch', detail: { source: 'dtna', ref: 'dtna/c-bad' } });
  });

  it('a Decisiv cache record whose estimate id does not match the row is excluded', async () => {
    const row = baseRow();
    const docs = { decisivCaseCache: { 21350186: { estimateId: '99999999', stage: 'ready', scrapedAt: '2026-11-20T10:00:00Z' } } };
    const out = await evidence.collect(plan(row, { features: { evidenceCollection: true, liveReads: false } }), mkPorts(), null, null, ctx(row, docs));
    expect(out.items.filter((i) => i.source === 'decisiv' && i.field === 'stage')).toEqual([]);
    expect(out.items).toContainEqual(expect.objectContaining({ source: 'decisiv', field: 'wo_association', flags: ['wo_association_mismatch'] }));
  });

  it('a Decisiv cache record matching row.decisivCaseId or the URL id counts', async () => {
    expect(evidence.decisivBelongs('21350186', baseRow())).toBe(true);
    expect(evidence.decisivBelongs('21350186', baseRow({ decisivCaseId: '' }))).toBe(true);
    expect(evidence.decisivBelongs('1', baseRow())).toBe(false);
    const row = baseRow();
    const docs = { decisivCaseCache: { 21350186: { estimateId: '21350186', stage: 'Repair', stageSince: '2026-11-19T10:00:00Z', scrapedAt: '2026-11-20T10:00:00Z' } } };
    const out = await evidence.collect(plan(row, { features: { evidenceCollection: true, liveReads: false } }), mkPorts(), null, null, ctx(row, docs));
    expect(out.items).toContainEqual(expect.objectContaining({ source: 'decisiv', field: 'stage', value: 'repair', trust: 'structured', authorityTag: 'decisiv' }));
  });

  it('a live getService result for another WR or another asset is excluded', async () => {
    for (const detail of [
      { workRequest: { id: 'svc-other', assetDisplayName: '322283', lifecycleState: 'ACTIVE' } },
      { workRequest: { id: 'svc-1', assetDisplayName: '999999', lifecycleState: 'ACTIVE' } },
    ]) {
      const row = baseRow();
      const ports = mkPorts({ aapGetServiceIfWarm: vi.fn(async () => ({ ok: true, value: detail })) });
      const out = await evidence.collect(plan(row), ports, createLimiter(), null, ctx(row));
      expect(ports.aapGetServiceIfWarm).toHaveBeenCalledWith('svc-1');
      expect(out.items.filter((i) => i.source === 'aap_live' && i.field === 'lifecycleState')).toEqual([]);
      expect(out.items).toContainEqual(expect.objectContaining({ source: 'aap_live', field: 'wo_association', flags: ['wo_association_mismatch'] }));
    }
  });

  it('a live getService result for the unit and a WR in the set counts (live, tag aap)', async () => {
    const row = baseRow();
    const detail = { workRequest: { id: 'svc-1', assetDisplayName: ' 322283', lifecycleState: 'UNAVAILABLE', comments: [{ timestamp: '2026-11-20T12:00:00Z', text: 'Waiting on parts' }] } };
    const ports = mkPorts({ aapGetServiceIfWarm: vi.fn(async () => ({ ok: true, value: detail })) });
    const out = await evidence.collect(plan(row), ports, createLimiter(), null, ctx(row));
    expect(out.items).toContainEqual(expect.objectContaining({ source: 'aap_live', field: 'lifecycleState', value: 'Unavailable', live: true, freshness: 'LIVE', authorityTag: 'aap' }));
    expect(out.items).toContainEqual(expect.objectContaining({ source: 'aap_live', field: 'comments', trust: 'untrusted_text', authorityTag: 'relaygarage' }));
    expect(out.sourceStatus.aap_live).toBe('ok');
    expect(out.flags).not.toContain('wo_association_mismatch');
  });

  it('Aperia cached issues for another unit are excluded', async () => {
    const row = baseRow({ lifecycleReason: 'Tire damage' });
    const ports = mkPorts({
      aperiaCachedIssues: () => ({ pulledAt: '2026-11-20T09:00:00Z', issues: [
        { id: 'i1', fleetVehicleId: '322283', severity: 'high', dateDetected: '2026-11-19T09:00:00Z' },
        { id: 'i2', fleetVehicleId: '555555', severity: 'critical', dateDetected: '2026-11-19T09:00:00Z' },
      ] }),
    });
    const out = await evidence.collect(plan(row, { aperiaCache: ports.aperiaCachedIssues() }), ports, null, null, ctx(row));
    const sev = out.items.filter((i) => i.source === 'aperia_cache' && i.field === 'severity');
    expect(sev.map((i) => i.value)).toEqual(['high']);
    expect(out.sourceStatus.aperia_cache).toBe('cache_only:live_disabled_v1');
  });
});
