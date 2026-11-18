// tests/carrier-intel-taxonomy.test.js — carrier-intel design B3: downCause rule order,
// owner / offsite, every secondary flag. AC-11 (golden g1/g2/g3), AC-11b, AC-17h OFFSITE.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.stubEnv('TZ', 'America/New_York');
const require = createRequire(import.meta.url);
const W = require('../src/repair-intel/wo-facts');
const Tx = require('../src/carrier-intel/taxonomy');

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'carrier-intel');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
const TODAY = '2026-11-17';
const fsOf = (row) => W.buildFactSet(row, { today: TODAY });
const base = (o = {}) => Object.assign({ equipmentId: 'T1', vendor: 'COX', lifecycleReason: 'Damaged-Moderate', workRequestId: 'wr-t1',
  fullConversation: '', repairTimeline: '', issueSummary: '', issueDetails: '' }, o);

describe('AC-11 golden rows', () => {
  it('g1 B12195 -> parts-hold, owner vendor, in yard', () => {
    const row = load('g1-b12195-cox-parts-hold.json').row;
    expect(Tx.downCause(row, fsOf(row), TODAY)).toMatchObject({ cause: 'parts-hold', owner: 'vendor', offsite: false });
  });
  it('g2 B13014 -> accident, owner DSP (tow refs -> offsite)', () => {
    const row = load('g2-b13014-accident-dsp-hold.json').row;
    expect(Tx.downCause(row, fsOf(row), TODAY)).toMatchObject({ cause: 'accident', owner: 'DSP', offsite: true });
  });
  it('g3 B62064 -> impound, owner DSP, not offsite, no-open-wr', () => {
    const row = load('g3-b62064-impound-dsp-hold.json').row;
    const dc = Tx.downCause(row, fsOf(row), TODAY);
    expect(dc).toMatchObject({ cause: 'impound', owner: 'DSP', offsite: false });
    expect(dc.flags).toContain('no-open-wr');
  });
});

describe('AC-11b', () => {
  it('impound wording only in fullConversation (a string) -> impound, owner DSP', () => {
    const row = base({ lifecycleReason: 'Offsite Shop Repair', vendor: 'DSP_ENTERED',
      fullConversation: 'Conversation\n11/10 - fasuser1: Unit was impounded at the lot. Impound fee must be paid before release.' });
    expect(Tx.downCause(row, null, TODAY)).toMatchObject({ cause: 'impound', owner: 'DSP' });
    expect(Tx.downCause(row, fsOf(row), TODAY)).toMatchObject({ cause: 'impound', owner: 'DSP' });
  });
  for (const v of ['TBD', 'N/A', 'NONE', 'UNASSIGNED', '--', '']) {
    it('vendor ' + JSON.stringify(v) + ' and nothing else -> repair, owner Amazon, flag no-vendor', () => {
      const dc = Tx.downCause(base({ vendor: v }), null, TODAY);
      expect(dc).toMatchObject({ cause: 'repair', owner: 'Amazon', offsite: false });
      expect(dc.flags).toContain('no-vendor');
      expect(Tx.causeLabel(dc.cause, dc.flags)).toBe('repair (awaiting vendor assignment)');
    });
  }
  it('parts-hold offsite: KWNE true, COX without offsite URLs false', () => {
    const kw = Tx.downCause(base({ vendor: 'KWNE', vendorDelayReason: 'PARTS_ON_BACK_ORDER' }), null, TODAY);
    expect(kw).toMatchObject({ cause: 'parts-hold', owner: 'vendor', offsite: true });
    const cx = Tx.downCause(base({ vendor: 'COX', vendorDelayReason: 'PARTS_ON_BACK_ORDER' }), null, TODAY);
    expect(cx).toMatchObject({ cause: 'parts-hold', offsite: false });
  });
});

describe('rule order', () => {
  it('impound beats accident', () => {
    const row = base({ lifecycleReason: 'Accident', issueSummary: 'collision damage; unit was impounded' });
    expect(Tx.downCause(row, null, TODAY).cause).toBe('impound');
  });
  it('an accident with a real vendor has owner vendor; Damaged-Moderate alone is not an accident', () => {
    expect(Tx.downCause(base({ issueSummary: 'Unit struck a pole' }), null, TODAY)).toMatchObject({ cause: 'accident', owner: 'vendor' });
    expect(Tx.downCause(base({ vendor: 'DSP_ENTERED', lifecycleReason: 'Accident' }), null, TODAY)).toMatchObject({ cause: 'accident', owner: 'DSP' });
    expect(Tx.downCause(base({ lifecycleReason: 'Damaged-Moderate' }), null, TODAY).cause).toBe('repair');
  });
  it('DSP_ENTERED (not impound / accident) -> DSP-hold, never rule 6', () => {
    const dc = Tx.downCause(base({ vendor: 'dsp_entered', vendorDelayReason: 'PARTS_ON_BACK_ORDER' }), null, TODAY);
    expect(dc).toMatchObject({ cause: 'DSP-hold', owner: 'DSP', offsite: false });
    expect(dc.flags).not.toContain('no-vendor');
  });
  it('parts arrived at a dealer offsite -> dealer-offsite, not parts-hold', () => {
    const row = base({ vendor: 'KWNE', lifecycleReason: 'Offsite Shop Repair', partsStatus: 'arrived', vendorDelayReason: 'PARTS_ON_BACK_ORDER' });
    expect(Tx.downCause(row, null, TODAY)).toMatchObject({ cause: 'dealer-offsite', owner: 'dealer', offsite: true });
  });
  it('a CEI vendor with an offsite URL is a dealer', () => {
    const row = base({ vendor: 'CEI Collision', offsiteShopEventUrl: 'https://x' });
    expect(Tx.downCause(row, null, TODAY)).toMatchObject({ cause: 'dealer-offsite', owner: 'dealer' });
  });
  it('parts-hold triggers: delay code, "parts ordered" reason, status, open parts ETA', () => {
    expect(Tx.downCause(base({ vendorDelayReason: 'SOURCING_PARTS' }), null, TODAY).cause).toBe('parts-hold');
    expect(Tx.downCause(base({ vendorDelayReason: 'CC - Parts Ordered' }), null, TODAY).cause).toBe('parts-hold');
    for (const s of ['ordered', 'backorder', 'shipped']) expect(Tx.downCause(base({ partsStatus: s }), null, TODAY).cause).toBe('parts-hold');
    expect(Tx.downCause(base({ partsEta: '2026-11-20' }), null, TODAY).cause).toBe('parts-hold');
    expect(Tx.downCause(base(), null, TODAY).cause).toBe('repair');
  });
});

describe('OFFSITE helper (AC-17h)', () => {
  it('fs.caseIds.tow, towRefs when fs is null, false on g3', () => {
    expect(Tx.OFFSITE({}, { caseIds: { tow: ['amz-x'] } })).toBe(true);
    expect(Tx.OFFSITE({ towRefs: 'amz-x' }, null)).toBe(true);
    expect(Tx.OFFSITE({ towRefs: 'amz-x' }, { caseIds: { tow: [] } })).toBe(false);
    const g3 = load('g3-b62064-impound-dsp-hold.json').row;
    expect(Tx.OFFSITE(g3, fsOf(g3))).toBe(false);
  });
});

describe('secondary flags', () => {
  it('parts-no-eta and etc-rolling on g1', () => {
    const row = load('g1-b12195-cox-parts-hold.json').row;
    const dc = Tx.downCause(row, fsOf(row), TODAY);
    expect(dc.flags).toEqual(expect.arrayContaining(['parts-no-eta', 'etc-rolling']));
    expect(dc.flags).not.toContain('parts-eta-passed');
  });
  it('parts-eta-passed: open parts ETA before today and no newer negation', () => {
    const dc = Tx.downCause(base({ partsStatus: 'ordered', partsEta: '2026-11-16' }), null, TODAY);
    expect(dc.flags).toContain('parts-eta-passed');
    expect(Tx.downCause(base({ partsStatus: 'ordered', partsEta: '2026-11-18' }), null, TODAY).flags).not.toContain('parts-eta-passed');
  });
  it('etc-rolling needs >= 3 vendor revisions on distinct ET days in the last 7 days', () => {
    const rev = (at, side = 'vendor') => ({ kind: 'repairCompletion', side, at, from: '2026-11-01', to: '2026-11-02' });
    const mk = (revs) => base({ relayFacts: { historyTrend: { etc: { revisions: revs }, estimate: {}, vendor: { changes: [] } } } });
    const three = [rev('2026-11-12T15:00:00Z'), rev('2026-11-14T15:00:00Z'), rev('2026-11-16T15:00:00Z')];
    expect(Tx.downCause(mk(three), null, TODAY).flags).toContain('etc-rolling');
    const sameDay = [rev('2026-11-16T13:00:00Z'), rev('2026-11-16T15:00:00Z'), rev('2026-11-16T18:00:00Z')];
    expect(Tx.downCause(mk(sameDay), null, TODAY).flags).not.toContain('etc-rolling');
    const old = [rev('2026-11-01T15:00:00Z'), rev('2026-11-14T15:00:00Z'), rev('2026-11-16T15:00:00Z')];
    expect(Tx.downCause(mk(old), null, TODAY).flags).not.toContain('etc-rolling');
    const fasSide = [rev('2026-11-12T15:00:00Z', 'amazon'), rev('2026-11-14T15:00:00Z'), rev('2026-11-16T15:00:00Z')];
    expect(Tx.downCause(mk(fasSide), null, TODAY).flags).not.toContain('etc-rolling');
  });
  it('vendor-response-lag: first vendor comment > 72 h after the assignment, or none after 72 h', () => {
    const trend = { etc: { revisions: [] }, estimate: {}, vendor: { changes: [{ field: 'Vendor', op: 'ASSIGN_VENDOR', from: 'UNASSIGNED', to: 'COX', at: '2026-11-10T12:00:00Z' }] } };
    const mk = (events) => base({ relayFacts: { wrCreatedAt: '2026-11-01T12:00:00Z', historyTrend: trend, events } });
    expect(Tx.downCause(mk([{ at: '2026-11-14T13:00:00Z', side: 'vendor', via: 'comment' }]), null, TODAY).flags).toContain('vendor-response-lag');
    expect(Tx.downCause(mk([{ at: '2026-11-10T13:00:00Z', side: 'vendor', via: 'comment' }]), null, TODAY).flags).not.toContain('vendor-response-lag');
    expect(Tx.downCause(mk([]), null, TODAY).flags).toContain('vendor-response-lag');
    const fresh = base({ relayFacts: { wrCreatedAt: '2026-11-17T08:00:00Z', events: [] } });
    expect(Tx.downCause(fresh, null, TODAY).flags).not.toContain('vendor-response-lag');
  });
  it('vendor-access-block: access wording in a vendor comment of the last 14 days', () => {
    const conv = (d) => 'Conversation\n' + d + ' - COX: tech on site but no access to the unit, record 360 credential issue';
    expect(Tx.downCause(base({ fullConversation: conv('11/15') }), null, TODAY).flags).toContain('vendor-access-block');
    expect(Tx.downCause(base({ fullConversation: conv('10/15') }), null, TODAY).flags).not.toContain('vendor-access-block');
    const fas = 'Conversation\n11/15 - fasuser1: no access to the unit?';
    expect(Tx.downCause(base({ fullConversation: fas }), null, TODAY).flags).not.toContain('vendor-access-block');
  });
  it('no-open-wr when workRequestId is empty', () => {
    expect(Tx.downCause(base({ workRequestId: '' }), null, TODAY).flags).toContain('no-open-wr');
    expect(Tx.downCause(base(), null, TODAY).flags).not.toContain('no-open-wr');
  });
});
