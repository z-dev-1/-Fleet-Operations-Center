// DTNA Phase A step 1: RG <-> DTNA join rules (findings §2.2).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const J = require('../src/dtna/join.js');

const A = '500gx000002E4U5AAK';
const B = '500gx000003ZOQoAAO';
const D = '500gx000009AAAAAAA';
const url = (id) => 'https://dtna.my.site.com/Servicetracker/s/case/' + id + '/detail';
const DECISIV = 'https://fleet.decisiv.net/estimates/12345';

describe('normalization', () => {
  it('normUnit trims, uppercases, strips spaces and a leading #', () => {
    expect(J.normUnit(' #122269 ')).toBe('122269');
    expect(J.normUnit('122269')).toBe('122269');
    expect(J.normUnit('b 12260')).toBe('B12260');
    expect(J.normUnit('007')).toBe('007');
    expect(J.normUnit(null)).toBe('');
  });
  it('vinTail -> last 6 upper case', () => {
    expect(J.vinTail('3akjhhdr1nsnp6923')).toBe('NP6923');
    expect(J.vinTail('')).toBe('');
  });
  it('caseIdFromUrl / isDtnaCaseUrl', () => {
    expect(J.caseIdFromUrl(url(A))).toBe(A);
    expect(J.caseIdFromUrl('https://dtna.my.site.com/Servicetracker/s/case/Case/Default')).toBe('');
    expect(J.caseIdFromUrl(DECISIV)).toBe('');
    expect(J.isDtnaCaseUrl(url(B))).toBe(true);
    expect(J.isDtnaCaseUrl('')).toBe(false);
  });
});

describe('findCaseForRow', () => {
  const eA = { caseId: A, unitId: '122269', serial: 'NP6923', caseStatus: 'In Repair', pulledAt: '2026-09-24T00:00:00Z' };
  const eB = { caseId: B, unitId: '133001', serial: 'PK1111', caseStatus: 'Closed', pulledAt: '2026-09-24T00:00:00Z' };

  it('matches by normalized unit', () => {
    expect(J.findCaseForRow({ equipmentId: ' #122269 ' }, [eB, eA])).toBe(eA);
  });
  it('falls back to VIN tail vs serial', () => {
    expect(J.findCaseForRow({ equipmentId: 'ZZZ', vin: '1XKYD49X0PK1111' }, [eA, eB])).toBe(eB);
  });
  it('no match -> null', () => {
    expect(J.findCaseForRow({ equipmentId: 'ZZZ' }, [eA, eB])).toBeNull();
    expect(J.findCaseForRow(null, [eA])).toBeNull();
  });
  it('tie-break: the row offsite case id, then non-closed, then newest', () => {
    const closedNew = { caseId: D, unitId: '122269', caseStatus: 'Closed', lastCommentAt: '2026-09-30T00:00:00Z' };
    const openOld = { caseId: A, unitId: '122269', caseStatus: 'Open', lastCommentAt: '2026-09-01T00:00:00Z' };
    const openNew = { caseId: B, unitId: '122269', caseStatus: 'Open', lastCommentAt: '2026-09-20T00:00:00Z' };
    expect(J.findCaseForRow({ equipmentId: '122269', offsiteShopEventUrl: url(D) }, [openOld, closedNew, openNew])).toBe(closedNew);
    expect(J.findCaseForRow({ equipmentId: '122269' }, [openOld, closedNew, openNew])).toBe(openNew);
    expect(J.findCaseForRow({ equipmentId: '122269' }, [closedNew, { ...closedNew, caseId: A, lastCommentAt: '2026-01-01T00:00:00Z' }]).caseId).toBe(D);
  });
});

describe('pickWrForCase', () => {
  const entry = { caseId: A, unitId: '122269', serial: 'NP6923' };

  it('rule 1: the unit row primary WR', () => {
    const rows = [{ equipmentId: '999', workRequestId: 'w0' }, { equipmentId: '122269', workRequestId: 'w1' }];
    expect(J.pickWrForCase(entry, rows)).toEqual({ row: rows[1], wrId: 'w1' });
  });
  it('rule 2: VIN tail when no unit matches', () => {
    const rows = [{ equipmentId: 'X1', vin: '3AKJHHDR1NSNP6923', workRequestId: 'w2' }];
    expect(J.pickWrForCase({ caseId: A, unitId: 'NOPE', serial: 'NP6923' }, rows).wrId).toBe('w2');
  });
  it('rule 3a: the WR whose comments carry the case id wins', () => {
    const row = {
      equipmentId: '122269', workRequestId: 'w1', vendor: 'FREIGHTLINER', created: '2026-09-25T00:00:00Z',
      _secondaryWRs: [{ workRequestId: 'w9', _wrType: 'unplanned', vendor: 'OTHER', created: '2026-09-01T00:00:00Z', fullConversation: 'see ' + url(A) }],
    };
    expect(J.pickWrForCase(entry, [row]).wrId).toBe('w9');
  });
  it('rule 3b: FREIGHTLINER / DAIMLER vendor, 3c: newest; planned and completed secondaries skipped', () => {
    const row = {
      equipmentId: '122269', workRequestId: 'w1', vendor: 'CBRE', created: '2026-09-25T00:00:00Z',
      _secondaryWRs: [
        { workRequestId: 'w2', _wrType: 'unplanned', vendor: 'Daimler Truck', created: '2026-09-01T00:00:00Z' },
        { workRequestId: 'w3', _wrType: 'planned', vendor: 'FREIGHTLINER', created: '2026-09-26T00:00:00Z' },
        { workRequestId: 'w4', _wrType: 'unplanned', vendor: 'FREIGHTLINER', completed: '2026-09-02T00:00:00Z' },
      ],
    };
    expect(J.pickWrForCase(entry, [row]).wrId).toBe('w2');
    const row2 = { equipmentId: '122269', workRequestId: 'w1', vendor: 'CBRE', created: '2026-09-25T00:00:00Z', _secondaryWRs: [{ workRequestId: 'w5', vendor: 'TA', created: '2026-09-01T00:00:00Z' }] };
    expect(J.pickWrForCase(entry, [row2]).wrId).toBe('w1');
  });
  it('no match -> null', () => {
    expect(J.pickWrForCase(entry, [{ equipmentId: '1', workRequestId: 'w' }])).toBeNull();
  });
});

describe('canWriteDtnaOffsite', () => {
  it('allows empty or DTNA offsite, refuses a Decisiv URL', () => {
    expect(J.canWriteDtnaOffsite({})).toBe(true);
    expect(J.canWriteDtnaOffsite({ offsiteShopEventUrl: url(A) })).toBe(true);
    expect(J.canWriteDtnaOffsite({ savedOffsiteUrl: url(B) })).toBe(true);
    expect(J.canWriteDtnaOffsite({ offsiteShopEventUrl: DECISIV })).toBe(false);
    expect(J.canWriteDtnaOffsite({ asistSrUrl: 'https://asist.volvo.com/sr/1' })).toBe(false);
    expect(J.canWriteDtnaOffsite(null)).toBe(false);
  });
});
