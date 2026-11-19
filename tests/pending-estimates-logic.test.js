// tests/pending-estimates-logic.test.js — Fleet tab Pending Estimates overlay, pure logic
// (renderer/src/js/views/pending-estimates-logic.js). Synthetic fixture fleet only.
process.env.TZ = 'America/New_York';
import { describe, it, expect } from 'vitest';

const L = await import('../renderer/src/js/views/pending-estimates-logic.js');

const NOW = Date.parse('2026-11-19T18:00:00Z');
const H = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const ASSET = (id) => 'https://aap-na.corp.amazon.com/v2/asset/AAID-' + id;
const wr = (n) => '0a1b2c3d-1111-2222-3333-' + String(n).padStart(12, '0');

// A..J per the plan: only A, B, I, J are pending + non-DTNA.
const A = { equipmentId: 'A100', workRequestId: wr(1), assetUrl: ASSET('A'), vendor: 'TA', dealerName: 'TA Petro Gary',
  serviceState: 'Work in progress', estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 30 * H),
  estimateSubmittedAmount: 4200, extractedAt: iso(NOW - 30 * H), created: iso(NOW - 5 * 24 * H) };
const B = { equipmentId: 'B200', workRequestId: wr(2), assetUrl: ASSET('B'), vendor: 'Rush',
  serviceState: 'Estimate pending approval', estimatePendingCost: 1234.5, created: iso(NOW - 10 * 24 * H) };
const C = { equipmentId: 'C300', workRequestId: wr(3), assetUrl: ASSET('C'), vendor: 'Rush', serviceState: 'Estimate approved',
  estimateStatus: 'approved', estimateApprovedAmount: 500, estimateSubmittedAt: '', estimateSubmittedAmount: '' };
const D = { equipmentId: 'D400', workRequestId: wr(4), assetUrl: ASSET('D'), vendor: 'Rush', serviceState: 'Estimate rejected',
  estimateStatus: 'rejected', estimateRejectReason: 'Labor high' };
const E = { equipmentId: 'E500', workRequestId: wr(5), assetUrl: ASSET('E'), vendor: 'Rush', serviceState: 'Work in progress' };
const F = { equipmentId: 'F600', workRequestId: wr(6), assetUrl: ASSET('F'), vendor: 'Other', asistSource: 'dtna',
  estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 50 * H), estimateSubmittedAmount: 9000 };
const G = { equipmentId: 'G700', workRequestId: wr(7), assetUrl: ASSET('G'), vendor: 'Freightliner (DAIMLER)',
  estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - 60 * H), estimateSubmittedAmount: 800 };
const Hrow = { equipmentId: 'H800', workRequestId: wr(8), assetUrl: ASSET('H'), vendor: 'Other',
  serviceState: 'Estimate pending approval', estimatePendingCost: 300,
  offsiteShopEventUrl: 'https://dtna.my.site.com/Servicetracker/s/case/500Ux00000AbCdE/view' };
const I = { equipmentId: 'I900', workRequestId: wr(9), assetUrl: ASSET('I'), vendor: 'Rush', serviceState: 'Work in progress',
  _secondaryWRs: [
    { workRequestId: wr(19), vendor: 'Amerit', serviceState: 'Estimate pending approval', totalCost: 900, created: iso(NOW - 3 * 24 * H) },
    { workRequestId: wr(29), vendor: 'Amerit', serviceState: 'Completed', totalCost: 700, completed: iso(NOW - H) },
  ] };
const J = { equipmentId: 'J010', workRequestId: wr(10), assetUrl: ASSET('J'), vendor: 'TA',
  estimateStatus: 'submitted', estimateSubmittedAt: iso(NOW - (2 * H + 5 * 60000)), estimateSubmittedAmount: 87.18,
  scrapedAt: iso(NOW - 10 * 60000), extractedAt: iso(NOW - 20 * 60000), created: iso(NOW - 24 * H) };
const FLEET = [A, B, C, D, E, F, G, Hrow, I, J];
const SYNCED = iso(NOW - 5 * 60000);
const run = (rows, synced = SYNCED) => L.collectPendingEstimates(rows, { now: NOW, fleetSyncedAt: synced });

describe('collectPendingEstimates', () => {
  const res = run(FLEET);
  const by = (u) => res.items.find((x) => x.unitId === u);

  it('lists only submitted-not-approved, non-DTNA WRs; approved/rejected/no-estimate/closed are out', () => {
    expect(res.items.map((x) => x.unitId).sort()).toEqual(['A100', 'B200', 'I900', 'J010']);
    expect(res.items.find((x) => x.wrId === wr(29))).toBeUndefined();
  });

  it('DTNA pending ests are excluded (case source, Freightliner vendor, dtna URL) and counted', () => {
    expect(res.excludedDtna).toBe(3);
    for (const u of ['F600', 'G700', 'H800']) expect(by(u)).toBeUndefined();
    expect(L.isDtna({ vendor: 'Freightliner (DAIMLER)' })).toBe(true);
    expect(L.isDtna({ savedOffsiteUrl: 'https://dtna.my.site.com/Servicetracker/s/case/x' })).toBe(true);
    expect(L.isDtna({ vendor: 'TA' }, { vendor: 'Rush' })).toBe(false);
  });

  it('age comes from estimateSubmittedAt, not sync / scrape / extract times', () => {
    expect(by('J010').ageText).toBe('submitted 2h 5m ago');
    expect(by('J010').submittedAt).toBe(J.estimateSubmittedAt);
    expect(by('A100').ageText).toBe('submitted 1d ago');
    expect(by('B200').ageText).toBe('submitted time unknown');
    expect(by('B200').submittedMs).toBe(null);
  });

  it('sorts oldest-submitted first, then unknown-time rows by longest down', () => {
    expect(res.items.map((x) => x.unitId)).toEqual(['A100', 'J010', 'B200', 'I900']);
  });

  it('amount: fact-set submitted amount, else AAP pending cost; secondary WR uses its totalCost', () => {
    expect(by('A100').amount).toBe(4200);
    expect(by('B200').amount).toBe(1234.5);
    expect(by('I900')).toMatchObject({ wrId: wr(19), amount: 900, vendor: 'Amerit', source: 'aap' });
    expect(L.rowHtml(by('A100'))).toContain('$4,200.00');
    expect(L.rowHtml(by('B200'))).toContain('$1,234.50');
    expect(L.formatMoney('')).toBe('\u2014');
  });

  it('down duration from created', () => {
    expect(by('A100').downText).toBe('5d 0h');
    expect(by('B200').downText).toBe('10d 0h');
  });

  it('freshness: fact rows use extractedAt (24 h stale rule); AAP-only rows use fleet syncedAt', () => {
    expect(by('A100')).toMatchObject({ stale: true, freshnessUnknown: false });
    expect(by('J010')).toMatchObject({ stale: false, evidenceAt: J.extractedAt });
    expect(by('B200')).toMatchObject({ stale: false, freshnessUnknown: false });
    const noSync = run([B], null).items[0];
    expect(noSync.freshnessUnknown).toBe(true);
    expect(L.rowHtml(noSync)).toContain('freshness unknown');
    expect(L.rowHtml(by('A100'))).toContain('\u26A0 stale');
  });

  it('Escalate is enabled only with a UUID WR id and an AAP asset id', () => {
    expect(by('A100').canEscalate).toBe(true);
    const bad = run([Object.assign({}, A, { workRequestId: 'svc-123' })]).items[0];
    expect(bad.canEscalate).toBe(false);
    expect(L.rowHtml(bad)).toMatch(/data-pe-escalate="svc-123" disabled title="No Relay WR id/);
    const noAsset = run([Object.assign({}, A, { assetUrl: '' })]).items[0];
    expect(noAsset.canEscalate).toBe(false);
  });

  it('escapes HTML in row values', () => {
    const x = run([Object.assign({}, A, { dealerName: '<script>alert(1)</script>' })]).items[0];
    const h = L.rowHtml(x);
    expect(h).not.toContain('<script>');
    expect(h).toContain('&lt;script&gt;');
  });
});

describe('overlay HTML', () => {
  it('header: as-of fleet sync time (local), cached flag, counts; empty state', () => {
    const res = run(FLEET);
    const h = L.overlayHtml({ items: res.items, excludedDtna: res.excludedDtna, asOf: '2026-11-19T18:09:21Z', cached: true });
    expect(h).toContain('as of 11/19 13:09 (cached)');
    expect(h).toContain('4 pending');
    expect(h).toContain('3 DTNA excluded');
    expect(L.overlayHtml({ items: [], excludedDtna: 0, asOf: null })).toContain('No pending estimates in your domiciles.');
    expect(L.overlayHtml({ items: [], asOf: null })).toContain('as of unknown');
  });

  it('pendingSignal: fact clause only on the primary WR; AAP status or cost on any', () => {
    expect(L.pendingSignal({ estimateStatus: 'submitted' }, { primary: true })).toEqual({ pending: true, source: 'relay' });
    expect(L.pendingSignal({ estimateStatus: 'submitted' }, { primary: false }).pending).toBe(false);
    expect(L.pendingSignal({ serviceState: 'ESTIMATE_PENDING_APPROVAL' }, { primary: true })).toEqual({ pending: true, source: 'aap' });
    expect(L.pendingSignal({ estimateStatus: 'submitted', estimatePendingCost: '$10' }, { primary: true }).source).toBe('both');
    expect(L.pendingSignal({ estimateStatus: 'approved', serviceState: 'Estimate approved' }, { primary: true }).pending).toBe(false);
  });
});
