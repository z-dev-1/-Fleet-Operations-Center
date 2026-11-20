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

// ── Upgrade: team merge, filters, Owner, mismatch ───────────────────────────
const VOLVO_URL = (id) => 'https://volvopg.asist.decisiv.net/fleet/estimates/' + id;
const PACCAR_URL = (id) => 'https://paccarpg.decisiv.net/fleet/estimates/' + id;
const off = (o) => Object.assign({ ok: true, fleetStatus: 'Approved', repairStatus: 'Waiting', stage: 'repair', stageStatus: 'Waiting',
  stageSince: '2026-11-17T15:00:00Z', total: 8735.97, updatedAt: iso(NOW - 5 * H), scrapedAt: iso(NOW - 10 * 60000) }, o);
const scanRow = (o) => Object.assign({ aaid: '', assetUrl: '', serviceUrl: '', vendor: 'Volvo (ASIST)', vendorKind: 'volvo', domicileSite: 'DXX1',
  operator: 'ABCD', fas: '', mine: false, rgOpen: true, rgPending: false, rgStatus: 'Work in progress', rgPendingCost: null,
  created: iso(NOW - 4 * 24 * H), vendorWorkOrderId: '', offsiteShopEventUrl: '', offsite: null, source: 'rg',
  offsiteDone: false, statusMismatch: false, notInRg: false }, o);
const DONE = { repairStatus: 'Complete (here)', stage: 'ready', stageStatus: 'Complete (here)' };
// S1 merges into v1 A100; S2..S7 are team-only.
const S1 = scanRow({ key: 'wr:' + wr(1), workRequestId: wr(1), equipmentId: 'A100', mine: true, fas: 'Jane Doe', source: 'decisiv',
  offsiteShopEventUrl: VOLVO_URL('21383146'), offsite: off({}) });
const S2 = scanRow({ key: 'wr:' + wr(50), workRequestId: wr(50), equipmentId: 'T500', aaid: 'AAID-T5', fas: 'Jane Doe', source: 'decisiv',
  offsiteShopEventUrl: VOLVO_URL('500'), offsite: off(DONE), offsiteDone: true, statusMismatch: true });
const S3 = scanRow({ key: 'wr:' + wr(51), workRequestId: wr(51), equipmentId: 'T510', aaid: 'AAID-T51', fas: 'Bob Roe', vendor: 'Rush',
  vendorKind: 'other', rgPending: true, rgPendingCost: 2500, vendorWorkOrderId: 'RO-51' });
const S4 = scanRow({ key: 'est:777', workRequestId: '', equipmentId: 'T520', vendorKind: 'paccar', vendor: 'Kenworth', mine: true,
  source: 'decisiv', offsiteShopEventUrl: PACCAR_URL('777'), offsite: off({ fleetStatus: null, repairStatus: 'Working', stage: 'repair', stageStatus: 'Working' }),
  rgOpen: false, notInRg: true });
const S5 = scanRow({ key: 'wr:' + wr(53), workRequestId: wr(53), equipmentId: 'T530', fas: 'Bob Roe', source: 'decisiv',
  offsiteShopEventUrl: VOLVO_URL('530'), offsite: off(DONE), offsiteDone: true, statusMismatch: true });
const S6 = scanRow({ key: 'wr:' + wr(54), workRequestId: wr(54), equipmentId: 'T540', fas: 'Jane Doe', source: 'decisiv', vendorKind: 'paccar',
  offsiteShopEventUrl: PACCAR_URL('540'), offsite: off(DONE), offsiteDone: true, statusMismatch: true });
const S7 = scanRow({ key: 'wr:' + wr(55), workRequestId: wr(55), equipmentId: 'T550', fas: 'Jane Doe', source: 'both', rgPending: true,
  offsiteShopEventUrl: VOLVO_URL('550'), offsite: off(DONE), offsiteDone: true, statusMismatch: true });
const SCAN = [S1, S2, S3, S4, S5, S6, S7];
const merged = () => L.mergeTeamRows(run(FLEET).items, SCAN, { now: NOW, asOf: iso(NOW - 15 * 60000) });
const ids = (list) => list.map((x) => x.unitId).sort();
const ALL = (f) => L.applyFilters(merged(), Object.assign({ owner: 'all' }, f));

describe('mergeTeamRows', () => {
  it('merges a v1 item with the scan row of the same WR id; v1-only items stay mine / RG; scan-only rows are appended', () => {
    const m = merged();
    expect(ids(m)).toEqual(['A100', 'B200', 'I900', 'J010', 'T500', 'T510', 'T520', 'T530', 'T540', 'T550']);
    const a = m.find((x) => x.unitId === 'A100');
    expect(a).toMatchObject({ key: 'wr:' + wr(1), mine: true, fas: 'Jane Doe', src: 'both', vendorKind: 'volvo', amount: 4200,
      fleetStatus: 'Approved', repairStatus: 'Waiting', total: 8735.97, statusMismatch: false, notInRg: false,
      updatedText: '5h ago', offsiteStageText: 'repair \u00B7 Waiting since 11/17' });
    expect(a.unit).toBe(A); // the fleet row stays the Escalate unit
    const b = m.find((x) => x.unitId === 'B200');
    expect(b).toMatchObject({ key: 'wr:' + wr(2), mine: true, src: 'rg', fas: '', vendorKind: 'other', fleetStatus: '', total: null,
      updatedText: '\u2014' });
  });

  it('scan-only rows get a fleet-row-like unit, canEscalate by the v1 rule and the Vendor WO', () => {
    const m = merged();
    const t5 = m.find((x) => x.unitId === 'T500');
    expect(t5.unit).toMatchObject({ equipmentId: 'T500', workRequestId: wr(50), aaid: 'AAID-T5', offsiteShopEventUrl: VOLVO_URL('500'),
      _offsiteWrId: wr(50), estimatePendingCost: null });
    expect(t5).toMatchObject({ wrId: wr(50), canEscalate: true, src: 'decisiv', mine: false, statusMismatch: true,
      ageText: 'submitted time unknown', vendorWo: { id: '500', url: VOLVO_URL('500') } });
    const t51 = m.find((x) => x.unitId === 'T510');
    expect(t51).toMatchObject({ canEscalate: true, amount: 2500, src: 'rg', vendorWo: { id: 'RO-51', url: '' } });
    expect(t51.unit.estimatePendingCost).toBe(2500);
    const t52 = m.find((x) => x.unitId === 'T520');
    expect(t52).toMatchObject({ canEscalate: false, notInRg: true, key: 'est:777' });
    expect(m.find((x) => x.unitId === 'A100').vendorWo).toMatchObject({ id: '21383146' });
  });

  it('without scan rows it returns the v1 items (all mine, RG)', () => {
    const m = L.mergeTeamRows(run(FLEET).items, null, { now: NOW });
    expect(ids(m)).toEqual(['A100', 'B200', 'I900', 'J010']);
    expect(m.every((x) => x.mine === true && x.src === 'rg')).toBe(true);
  });
});

describe('applyFilters', () => {
  it('Owner: mine (default) / everyone / all', () => {
    expect(L.defaultFilters()).toEqual({ owner: 'mine', source: '', fleetStatus: '', repairStatus: '', mismatch: false, vendor: '', fas: '' });
    expect(L.OWNER_VALUES).toEqual(['mine', 'everyone', 'all']);
    expect(ids(L.applyFilters(merged(), L.defaultFilters()))).toEqual(['A100', 'B200', 'I900', 'J010', 'T520']);
    expect(ids(L.applyFilters(merged(), { owner: 'everyone' }))).toEqual(['T500', 'T510', 'T530', 'T540', 'T550']);
    expect(L.applyFilters(merged(), { owner: 'all' })).toHaveLength(10);
  });

  it('each filter alone', () => {
    expect(ids(ALL({ source: 'decisiv' }))).toEqual(['T500', 'T520', 'T530', 'T540']);
    expect(ids(ALL({ source: 'both' }))).toEqual(['A100', 'T550']);
    expect(ids(ALL({ source: 'rg' }))).toEqual(['B200', 'I900', 'J010', 'T510']);
    expect(ids(ALL({ fleetStatus: 'Approved' }))).toEqual(['A100', 'T500', 'T530', 'T540', 'T550']);
    expect(ids(ALL({ repairStatus: 'Complete (here)' }))).toEqual(['T500', 'T530', 'T540', 'T550']);
    expect(ids(ALL({ repairStatus: 'Working' }))).toEqual(['T520']);
    expect(ids(ALL({ vendor: 'paccar' }))).toEqual(['T520', 'T540']);
    expect(ids(ALL({ vendor: 'volvo' }))).toEqual(['A100', 'T500', 'T530', 'T550']);
    expect(ids(ALL({ vendor: 'other' }))).toEqual(['B200', 'I900', 'J010', 'T510']);
    expect(ids(ALL({ fas: 'Bob Roe' }))).toEqual(['T510', 'T530']);
    expect(ids(ALL({ mismatch: true }))).toEqual(['T500', 'T530', 'T540', 'T550']);
  });

  it('stacks with AND: two filters and five filters', () => {
    expect(ids(ALL({ vendor: 'paccar', source: 'decisiv' }))).toEqual(['T520', 'T540']);
    expect(ids(ALL({ mismatch: true, fas: 'Jane Doe' }))).toEqual(['T500', 'T540', 'T550']);
    expect(ids(ALL({ source: 'decisiv', repairStatus: 'Complete (here)', mismatch: true, vendor: 'volvo', fas: 'Jane Doe' }))).toEqual(['T500']);
    expect(ids(L.applyFilters(merged(), { owner: 'mine', source: 'decisiv', vendor: 'paccar' }))).toEqual(['T520']);
    expect(ids(L.applyFilters(merged(), { owner: 'mine', mismatch: true }))).toEqual([]);
  });

  it('unknown values are kept while their filter is Any and dropped when set; UNKNOWN matches empty', () => {
    // T520 has no fleet status, B200 none at all: both stay under Any.
    expect(ids(ALL({}))).toContain('T520');
    expect(ids(ALL({ fleetStatus: 'Approved' }))).not.toContain('T520');
    expect(ids(ALL({ fleetStatus: L.UNKNOWN }))).toEqual(['B200', 'I900', 'J010', 'T510', 'T520']);
    expect(ids(ALL({ fas: L.UNKNOWN }))).toEqual(['B200', 'I900', 'J010', 'T520']);
    const o = L.filterOptions(merged());
    expect(o.fleetStatus).toEqual(['Approved', L.UNKNOWN]);
    expect(o.repairStatus).toEqual(['Complete (here)', 'Waiting', 'Working', L.UNKNOWN]);
    expect(o.fas).toEqual(['Bob Roe', 'Jane Doe', L.UNKNOWN]);
  });
});

describe('sortItems / mismatch badge / new columns', () => {
  it('mismatch sort puts flagged rows first, then the v1 order', () => {
    const s = L.sortItems(merged(), { key: 'mismatch', dir: 'asc' });
    expect(s.slice(0, 4).every((x) => x.statusMismatch)).toBe(true);
    expect(s.slice(4).some((x) => x.statusMismatch)).toBe(false);
    expect(s[4].unitId).toBe('A100'); // v1 order resumes (oldest submitted first)
  });

  it('total / updated / unit / fas sorts; unknowns last in either direction', () => {
    const t = L.sortItems(merged(), { key: 'total', dir: 'desc' });
    expect(t[0].total).toBe(8735.97);
    expect(t.at(-1).total).toBe(null);
    expect(L.sortItems(merged(), { key: 'unit', dir: 'desc' })[0].unitId).toBe('T550');
    expect(L.sortItems(merged(), { key: 'fas', dir: 'asc' })[0].fas).toBe('Bob Roe');
    expect(L.sortItems(merged(), { key: 'fas', dir: 'desc' }).at(-1).fas).toBe('');
    expect(L.sortItems(merged(), { key: 'updated' }).at(-1).updatedMs).toBe(null);
    expect(L.sortItems(merged(), {}).map((x) => x.unitId).slice(0, 2)).toEqual(['A100', 'J010']);
    expect(L.formatUpdated(NOW - 3 * 24 * H, NOW)).toBe('3d ago');
    expect(L.formatUpdated(null, NOW)).toBe('\u2014');
  });

  it('rowHtml renders the new columns, the Vendor WO chip and the mismatch / Not in RG badges', () => {
    const m = merged();
    const a = L.rowHtml(m.find((x) => x.unitId === 'A100'));
    expect(a).toContain('data-id-link="' + VOLVO_URL('21383146') + '"');
    expect(a).toContain('data-id-link-field="vendor-wo"');
    expect(a).toContain('<td>both</td>');
    expect(a).toContain('<td>Jane Doe</td>');
    expect(a).toContain('<td>Approved</td>');
    expect(a).toContain('Waiting<div class="pe-sub2">repair \u00B7 Waiting since 11/17</div>');
    expect(a).toContain('$8,735.97');
    expect(a).toContain('$4,200.00');
    expect(a).toContain('5h ago');
    expect(a).toContain('data-pe-escalate="wr:' + wr(1) + '"');
    expect(a).not.toContain('pe-badge--mismatch');
    const t5 = L.rowHtml(m.find((x) => x.unitId === 'T500'));
    expect(t5).toContain('<span class="pe-badge pe-badge--mismatch" title="Repair status is complete offsite while the RG work order is still open">'
      + L.MISMATCH_LABEL + '</span>');
    expect(L.MISMATCH_LABEL).toBe('\u2714 Done offsite \u00B7 RG WO still open');
    expect(L.rowHtml(m.find((x) => x.unitId === 'T520'))).toContain('<span class="pe-badge pe-badge--norg">Not in RG</span>');
    const h = L.listHtml(m, { sort: { key: 'total', dir: 'desc' } });
    for (const k of ['unit', 'fas', 'total', 'updated', 'mismatch']) expect(h).toContain('data-pe-sort="' + k + '"');
    expect(h.indexOf('>Vendor WO<')).toBeLessThan(h.indexOf('>Source<'));
    expect(h.indexOf('>Total')).toBeLessThan(h.indexOf('>Est amount<'));
    expect(h).toContain('aria-sort="descending"');
    expect(L.listHtml([], { filtered: true })).toContain('No rows match the current filters.');
    expect(L.listHtml([])).toContain('No pending estimates in your domiciles.');
  });

  it('filterBarHtml: Owner segmented control and every filter, current values marked', () => {
    const h = L.filterBarHtml({ owner: 'everyone', vendor: 'paccar', mismatch: true }, L.filterOptions(merged()), { mismatch: 4 });
    expect(h).toContain('<div class="pe-owner" role="group" aria-label="Owner">');
    expect(h).toContain('data-pe-owner="mine" aria-pressed="false">Mine</button>');
    expect(h).toContain('data-pe-owner="everyone" aria-pressed="true">Everyone</button>');
    expect(h).toContain('data-pe-owner="all" aria-pressed="false">All</button>');
    for (const k of ['source', 'fleetStatus', 'repairStatus', 'vendor', 'fas']) expect(h).toContain('<select data-pe-filter="' + k + '"');
    expect(h).toContain('<option value="paccar" selected>PACCAR</option>');
    expect(h).toContain('<option value="__unknown__">Unknown</option>');
    expect(h).toContain('<input type="checkbox" data-pe-filter="mismatch" checked> ' + L.MISMATCH_LABEL + ' (4)');
    expect(h).toContain('data-pe-clear');
  });

  it('metaHtml keeps the v1 text without team fields and adds the team line with them', () => {
    expect(L.metaHtml({ count: 2, excludedDtna: 1, asOf: null })).toContain('2 pending');
    const h = L.metaHtml({ excludedDtna: 1, asOf: null, shown: 3, total: 9, mismatch: 4, teamAsOf: '2026-11-19T17:45:00Z', teamCached: true, scanning: true });
    expect(h).toContain('3 shown of 9');
    expect(h).toContain('4 done offsite / RG open');
    expect(h).toContain('team as of 11/19 12:45 (cached)');
    expect(h).toContain('scanning\u2026');
  });
});
