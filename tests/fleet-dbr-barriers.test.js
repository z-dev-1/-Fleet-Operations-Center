// Fleet DBR barrier rules (golden judgment rules, design §3.6 / §3.7): one positive + one
// negative per clause, Details lines only for matching down units of the pair, vendor regex
// boundaries, snippets, partsWait, Common Repairs groups / threshold / repeat rule.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeUnit, makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-10';
const hit = (fields, id) => F.classifyBarriers(makeUnit(fields), { today: TODAY })[id];
const buildOne = (units) => F.buildFleetDbr(units, { today: TODAY }).rows[0];

describe('1P Vendor (any COX / Amerit / TA / … unit, no stall signal needed)', () => {
  it('COX / Amerit / TA / Travel Centers / Allegiance / Ascendance with no signal -> Y', () => {
    for (const v of ['COX', 'Amerit', 'TA', 'Travel Centers', 'Allegiance', 'Ascendance']) {
      expect(hit({ vendor: v, savedNotes: 'repair in progress' }, 'vendor1p'), v).toEqual({ why: '1P vendor ' + v, kind: 'onsite' });
    }
  });
  it('a stall signal enriches the why (rejection, Waiting for vendor, Tech shortage)', () => {
    const h = hit({ vendor: 'Amerit', savedNotes: 'Amerit unable to repair, needs dealer' }, 'vendor1p');
    expect(h.why).toMatch(/^1P vendor Amerit: vendor can't complete: '.*unable to repair/);
    expect(h.kind).toBe('stalled');
    expect(hit({ vendor: 'COX', savedRepairStatus: 'Waiting for vendor' }, 'vendor1p').why).toBe('1P vendor COX: status Waiting for vendor');
    expect(hit({ vendor: 'TA', delayReasonCodes: 'Tech _ shortage' }, 'vendor1p').why).toBe('1P vendor TA: delay code Tech shortage');
  });
  it('AC14: AAP status "Cannot Complete — Parts Ordered" on a COX unit is not read as a rejection (any dash / spacing / case)', () => {
    for (const s of ['Cannot Complete \u2014 Parts Ordered', 'Cannot Complete - Parts Ordered', 'cannot complete\u2013parts ordered', 'CANNOT COMPLETE \u2014  PARTS ORDERED']) {
      const b = F.classifyBarriers(makeUnit({
        vendor: 'COX', savedRepairStatus: 'Cannot Complete \u2014 Parts Ordered', repairTimeline: '11/09 - Status: ' + s, savedNotes: s,
      }), { today: TODAY });
      expect(b.vendor1p, s).toEqual({ why: '1P vendor COX', kind: 'onsite' });
      expect(b.parts.why).toMatch(/status Cannot Complete \u2014 Parts Ordered/);
    }
    const row = buildOne([makeUnit({ equipmentId: 'X1', vendor: 'COX', savedRepairStatus: 'Cannot Complete \u2014 Parts Ordered', repairTimeline: '11/09 - Cannot Complete \u2014 Parts Ordered' })]);
    expect(row.cells.vendor1pYN).toBe('Y');
    expect(row.cells.partsYN).toBe('Y');
  });
  it('a TA accident unit with parts on order is 1P and Parts, not Partner (golden)', () => {
    const b = F.classifyBarriers(makeUnit({ vendor: 'Travel Centers', lifecycleReason: 'Accident', savedRepairStatus: 'Parts ordered' }), { today: TODAY });
    expect(b.vendor1p).not.toBeNull();
    expect(b.parts).not.toBeNull();
    expect(b.partner).toBeNull();
  });
  it('FleetNet impound -> Partner (impound), not 1P; a COX impound is not 1P either', () => {
    const b = F.classifyBarriers(makeUnit({ vendor: 'FleetNet', lifecycleReason: 'Impound' }), { today: TODAY });
    expect(b.vendor1p).toBeNull();
    expect(b.partner).toEqual({ why: 'lifecycle Impound', kind: 'impound' });
    const c = F.classifyBarriers(makeUnit({ vendor: 'COX', savedNotes: 'unit impounded at the tow yard' }), { today: TODAY });
    expect(c.vendor1p).toBeNull();
    expect(c.partner.kind).toBe('impound');
  });
  it('a DSP_ENTERED unit is never 1P; non-1P vendors -> N', () => {
    expect(hit({ vendor: 'DSP_ENTERED' }, 'vendor1p')).toBeNull();
    expect(hit({ vendor: 'Volvo', savedNotes: 'job rejected' }, 'vendor1p')).toBeNull();
    expect(hit({ vendor: 'FleetNet', savedRepairStatus: 'Waiting for vendor' }, 'vendor1p')).toBeNull();
  });
  it('"Estimate rejected by MCS" is an Estimate barrier, not a 1P rejection (R5)', () => {
    const b = F.classifyBarriers(makeUnit({
      vendor: 'Amerit', serviceState: 'Estimate rejected', repairTimeline: '11/09 - Estimate rejected by MCS',
    }), { today: TODAY });
    expect(b.vendor1p).toEqual({ why: '1P vendor Amerit', kind: 'onsite' });
    expect(b.estimate).toEqual({ why: 'estimate rejected', kind: 'rejected' });
  });
  it('a rejection outside the 3 latest dated timeline lines does not enrich the why', () => {
    const tl = ['9/01 - Amerit declined, unable to repair', '10/01 - towed', '10/15 - at shop', '11/01 - repair in progress'].join('\n');
    expect(hit({ vendor: 'Amerit', repairTimeline: tl }, 'vendor1p').why).toBe('1P vendor Amerit');
    const tl2 = ['10/01 - towed', '10/15 - at shop', '11/01 - Amerit declined the job'].join('\n');
    expect(hit({ vendor: 'Amerit', repairTimeline: tl2 }, 'vendor1p').why).toMatch(/can't complete/);
  });
});

describe('OEM (at OEM/dealer, no stall or day threshold)', () => {
  it('Volvo + Repair in progress + 5d -> Y', () => {
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Repair in progress', workDuration: '5d 2h 0m' }, 'oem')).toEqual({ why: 'at OEM/dealer Volvo', kind: 'dealer' });
  });
  it('a stall signal enriches the why', () => {
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor' }, 'oem').why).toBe('at OEM/dealer Volvo: status Waiting for vendor');
    expect(hit({ vendor: 'KWNE', delayReasonCodes: 'Waiting _ for diagnosis' }, 'oem').why).toMatch(/Waiting for diagnosis/);
  });
  it('Offsite Shop Repair with no vendor -> Y (kind offsite)', () => {
    expect(hit({ lifecycleReason: 'Offsite Shop Repair', workDuration: '20d 1h 0m' }, 'oem')).toEqual({ why: 'at OEM/dealer no vendor: 20d down', kind: 'offsite' });
  });
  it('324123-shaped: Repair completed + newest lines "Asset released" -> N', () => {
    const tl = '11/07 - under diag at dealer\n11/08 - repair completed\n11/09 - Asset released to driver';
    expect(hit({ vendor: 'Freightliner (DAIMLER)', savedRepairStatus: 'Repair completed', repairTimeline: tl }, 'oem')).toBeNull();
    expect(hit({ vendor: 'Freightliner (DAIMLER)', savedRepairStatus: 'Repair completed', repairTimeline: '11/09 - unit towed out' }, 'oem')).toBeNull();
  });
  it('the release exclusion needs both the status and a released line in the 3 newest lines', () => {
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Repair completed', repairTimeline: '11/09 - waiting on pickup' }, 'oem')).not.toBeNull();
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Repair in progress', repairTimeline: '11/09 - Asset released to driver' }, 'oem')).not.toBeNull();
    const old = ['10/01 - Asset released to driver', '10/20 - back at dealer', '11/01 - repair completed', '11/09 - awaiting road test'].join('\n');
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Repair completed', repairTimeline: old }, 'oem')).not.toBeNull();
  });
  it('CEI is neither OEM nor Partner', () => {
    const b = F.classifyBarriers(makeUnit({ vendor: 'CEI', savedRepairStatus: 'Waiting for vendor', workDuration: '30d' }), { today: TODAY });
    expect(b.oem).toBeNull();
    expect(b.partner).toBeNull();
  });
});

describe('vendor regexes (R19)', () => {
  it('OEM vendors match, look-alikes do not', () => {
    for (const v of ['Volvo (ASIST)', 'Freightliner (DAIMLER)', 'KWNE', 'Peterbilt (PACCAR)', 'PETE_STORE', 'International', 'Mack Trucks']) {
      expect(F.OEM_VENDOR_RE.test(v)).toBe(true);
    }
    for (const v of ['Mackenzie Repair', 'Internationally Sourced', 'CEI', 'Amerit']) {
      expect(F.OEM_VENDOR_RE.test(v)).toBe(false);
    }
  });
  it('ONSITE_VENDOR_RE stays exported unchanged', () => {
    for (const v of ['Amerit', 'COX', 'TA', 'GOODYEAR', 'FleetNet']) expect(F.ONSITE_VENDOR_RE.test(v)).toBe(true);
    for (const v of ['Tacoma Shop', 'Coxswain', 'Volvo', 'Automobile Club']) expect(F.ONSITE_VENDOR_RE.test(v)).toBe(false);
  });
  it('VENDOR_1P_RE: FleetNet out, Allegiance / Ascendance in', () => {
    for (const v of ['Amerit', 'COX', 'TA', 'Travel Centers', 'GOODYEAR', 'Velociti', 'Road Ready', 'Allegiance', 'Ascendance']) expect(F.VENDOR_1P_RE.test(v), v).toBe(true);
    for (const v of ['FleetNet', 'Tacoma Shop', 'Coxswain', 'Volvo', 'Automobile Club']) expect(F.VENDOR_1P_RE.test(v), v).toBe(false);
  });
});

describe('Estimate', () => {
  it('positive clauses', () => {
    expect(hit({ estimatePendingCost: '$1,250.50' }, 'estimate')).toEqual({ why: 'estimate pending $1250.5', kind: 'pending' });
    expect(hit({ savedRepairStatus: 'Awaiting approval' }, 'estimate').why).toBe('status Awaiting approval');
    expect(hit({ offsiteStage: 'Approval' }, 'estimate').why).toBe('offsite stage approval');
    expect(hit({ escalations: 'Estimate review' }, 'estimate').why).toBe('escalation Estimate review');
    expect(hit({ savedNotes: 'shop is waiting on an estimate' }, 'estimate').why).toMatch(/waiting on an estimate/);
  });
  it('negative', () => {
    expect(hit({ estimatePendingCost: '0', savedNotes: 'estimate approved, in repair' }, 'estimate')).toBeNull();
  });
  it('approved (estimateStatus or newest dated timeline line) suppresses the status / stage / cost triggers', () => {
    expect(hit({ savedRepairStatus: 'Awaiting approval', estimateStatus: 'approved' }, 'estimate')).toBeNull();
    expect(hit({ offsiteStage: 'approval', estimateStatus: 'Approved' }, 'estimate')).toBeNull();
    expect(hit({ estimatePendingCost: '500', repairTimeline: '11/08 - estimate sent\n11/09 - Estimate approved by MCS' }, 'estimate')).toBeNull();
    expect(hit({ savedRepairStatus: 'Awaiting approval', repairTimeline: '11/09 - MCS approved the estimate, parts ordered' }, 'estimate')).toBeNull();
    // An approval on an older line does not suppress a newer pending estimate.
    expect(hit({ estimatePendingCost: '500', repairTimeline: '11/08 - estimate approved\n11/09 - supplemental estimate sent' }, 'estimate')).not.toBeNull();
  });
  it('39110-shaped: Estimate rejected hits even when approved text exists', () => {
    expect(hit({ serviceState: 'Estimate rejected' }, 'estimate')).toEqual({ why: 'estimate rejected', kind: 'rejected' });
    expect(hit({ estimateStatus: 'rejected', repairTimeline: '11/09 - estimate approved' }, 'estimate')).toEqual({ why: 'estimate rejected', kind: 'rejected' });
  });
  it('a DSP_ENTERED unit is never an Estimate hit (its estimate is a Partner barrier)', () => {
    const b = F.classifyBarriers(makeUnit({ vendor: 'DSP_ENTERED', savedRepairStatus: 'Awaiting approval', serviceState: 'Estimate rejected', estimatePendingCost: '900' }), { today: TODAY });
    expect(b.estimate).toBeNull();
    expect(b.partner.kind).toBe('dsp');
  });
});

describe('Partner (DSP, impound, narrowed carrier text only)', () => {
  it('positive clauses with kinds', () => {
    expect(hit({ vendor: 'DSP_ENTERED' }, 'partner')).toEqual({ why: 'DSP-entered (carrier-managed)', kind: 'dsp' });
    expect(hit({ vendor: 'dsp entered' }, 'partner').kind).toBe('dsp');
    expect(hit({ lifecycleReason: 'Impound' }, 'partner')).toEqual({ why: 'lifecycle Impound', kind: 'impound' });
    expect(hit({ savedNotes: 'unit is impounded, release paperwork pending' }, 'partner').kind).toBe('impound');
    expect(hit({ savedNotes: 'carrier-managed repair at their shop' }, 'partner').kind).toBe('text');
    expect(hit({ savedNotes: 'waiting on the carrier to send it in' }, 'partner').kind).toBe('text');
    expect(hit({ savedNotes: "carrier's estimate under review" }, 'partner').kind).toBe('text');
  });
  it('Accident lifecycle, CEI, insurance / adjuster / claim and SF case no longer hit', () => {
    expect(hit({ lifecycleReason: 'Accident' }, 'partner')).toBeNull();
    expect(hit({ vendor: 'CEI' }, 'partner')).toBeNull();
    expect(hit({ savedNotes: 'adjuster waiting on accident report' }, 'partner')).toBeNull();
    expect(hit({ savedNotes: 'insurance claim filed' }, 'partner')).toBeNull();
    expect(hit({ lifecycleReason: 'Accident', salesforceCase: '00034983', _factsOn: true }, 'partner')).toBeNull();
    expect(hit({ vendor: 'Amerit', savedNotes: 'battery replaced' }, 'partner')).toBeNull();
  });
});

describe('Parts Delay = partsWait', () => {
  it('Sourcing _ parts is normalized; clauses are joined', () => {
    const h = hit({ delayReasonCodes: 'Sourcing _ parts', lifecycleReason: 'Parts Delay' }, 'parts');
    expect(h).toEqual({ why: 'delay code Sourcing parts; lifecycle Parts Delay', kind: 'wait' });
  });
  it('status / text clauses; offsite stage detail alone is not a parts wait', () => {
    expect(hit({ savedRepairStatus: 'Parts ordered' }, 'parts').why).toBe('status Parts ordered');
    expect(hit({ savedNotes: 'turbo on backorder' }, 'parts').why).toMatch(/backorder/);
    expect(hit({ offsiteStageDetail: 'Waiting on parts from OEM' }, 'parts')).toBeNull();
  });
  it('negative', () => {
    expect(hit({ delayReasonCodes: 'Tech _ shortage', savedNotes: 'in repair' }, 'parts')).toBeNull();
  });
  it('B62280-shaped: status Parts ordered + partsStatus arrived -> wait', () => {
    const r = makeUnit({ savedRepairStatus: 'Parts ordered', partsStatus: 'arrived' });
    expect(F.partsWait(r, TODAY)).toBe(true);
    expect(F.partsWhy(r, TODAY)).toBe('status Parts ordered');
  });
  it('IND260261-shaped: partsStatus ordered -> wait (any listed status, case / space-insensitive)', () => {
    for (const ps of ['ordered', ' Backorder ', 'BACKORDERED', 'sourcing', 'On Order']) {
      expect(F.partsWait(makeUnit({ partsStatus: ps }), TODAY), ps).toBe(true);
    }
    expect(F.partsWait(makeUnit({ partsStatus: 'arrived' }), TODAY)).toBe(false);
  });
  it('39110-shaped: _factPartsWhy without a status word -> no wait; with one and parts not arrived -> wait', () => {
    expect(F.partsWait(makeUnit({ _factPartsWhy: 'DO NOT PAY OUT until invoice matches' }), TODAY)).toBe(false);
    expect(F.partsWait(makeUnit({ _factPartsWhy: 'Turbo shipped 11/08' }), TODAY)).toBe(true);
    expect(F.partsWait(makeUnit({ _factPartsWhy: 'Turbo shipped 11/08', partsStatus: 'arrived' }), TODAY)).toBe(false);
  });
  it('Parts received status -> no wait; Parts Delay with parts arrived -> no wait', () => {
    expect(F.partsWait(makeUnit({ savedRepairStatus: 'Parts received', partsStatus: 'ordered', savedNotes: 'on backorder' }), TODAY)).toBe(false);
    expect(F.partsWait(makeUnit({ lifecycleReason: 'Parts Delay', partsStatus: 'delivered' }), TODAY)).toBe(false);
    expect(F.partsWait(makeUnit({ lifecycleReason: 'Parts Delay' }), TODAY)).toBe(true);
    expect(F.partsWhy(makeUnit({}), TODAY)).toBe('');
  });
});

describe('Details cells and units[].why', () => {
  const units = [
    makeUnit({ equipmentId: 'D1', vendor: 'Amerit', savedRepairStatus: 'Waiting for vendor', workDuration: '9d 1h' }),
    makeUnit({ equipmentId: 'D2', vendor: 'Amerit', savedRepairStatus: 'Waiting for vendor', workDuration: '30d' }),
    makeUnit({ equipmentId: 'D3', vendor: 'Amerit', savedRepairStatus: 'Repair in progress', workDuration: '40d' }),
    makeUnit({ equipmentId: 'D4', vendor: 'COX', savedRepairStatus: 'Waiting for vendor' }), // days unknown
    makeUnit({ equipmentId: 'D5', vendor: 'Amerit', savedRepairStatus: 'Waiting for vendor', lifecycleState: 'Active' }),
  ];
  const row = buildOne(units);

  it('Y/N from real fields; Details names exactly the matching down units, days desc, unknown last', () => {
    expect(row.cells.vendor1pYN).toBe('Y');
    // FEAT-003 composer text (golden style); the why strings moved to units[].why.
    expect(row.cells.vendor1pDetails).toBe(
      'Amerit has 3 units: D3 (40d), D2 (30d) and D1 (9d) \u2014 waiting for vendor (2), repair in progress (1); COX: D4 \u2014 waiting for vendor.');
    expect(row.cells.vendor1pDetails).not.toMatch(/nulld|D5/);
    for (const col of ['oem', 'estimate', 'partner', 'parts']) {
      expect(row.cells[col + 'YN']).toBe('N');
      expect(row.cells[col + 'Details']).toBe('');
    }
  });

  it('units carry why / barrierKinds per hit rule', () => {
    const d2 = row.units.find((u) => u.id === 'D2');
    expect(d2.why).toEqual({ vendor1p: '1P vendor Amerit: status Waiting for vendor' });
    expect(d2.barrierKinds).toEqual({ vendor1p: 'stalled' });
    expect(row.units.find((u) => u.id === 'D3').barrierKinds).toEqual({ vendor1p: 'onsite' });
  });

  it('units[].why is <= 120 chars and redacted', () => {
    const long = 'waiting on the carrier ' + 'x'.repeat(30) + ' call 555-123-4567 or someone@example.com ' + 'y'.repeat(200);
    const r = buildOne([makeUnit({ equipmentId: 'W1', savedNotes: long, delayReasonCodes: 'Sourcing _ parts', _factPartsWhy: 'P/N 12 on order; reach a.b@example.com ' + 'z'.repeat(150) })]);
    const u = r.units[0];
    for (const id of ['partner', 'parts']) {
      expect(u.why[id].length).toBeLessThanOrEqual(120);
      expect(u.why[id]).not.toMatch(/555-123-4567|@example\.com/);
    }
  });

  it('every Details cell on the fixture is one line naming only down unit IDs of that pair', () => {
    const rows = makeFleetRows({
      T0001: { vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor' },
      T0002: { vendor: 'DSP_ENTERED', savedNotes: 'insurance claim filed' },
      T0045: { delayReasonCodes: 'Sourcing _ parts' },
      T0046: { estimatePendingCost: '500' },
    });
    const built = F.buildFleetDbr(rows, { today: TODAY });
    let cellsFilled = 0;
    for (const r of built.rows) {
      const ids = new Set(r.units.map((u) => u.id));
      for (const col of ['vendor1pDetails', 'oemDetails', 'estimateDetails', 'partnerDetails', 'partsDetails']) {
        const v = r.cells[col];
        if (!v) continue;
        cellsFilled += 1;
        expect(v).not.toMatch(/\n/);
        const named = v.match(/\bT\d{4}\b/g) || [];
        expect(named.length).toBeGreaterThan(0);
        for (const id of named) expect(ids.has(id)).toBe(true);
      }
    }
    expect(cellsFilled).toBe(4);
    const tuzr = built.rows.find((r) => r.key === 'ABE40|TUZR');
    expect(tuzr.cells.oemYN).toBe('Y');
    expect(tuzr.cells.partnerYN).toBe('Y');
    expect(tuzr.units.find((u) => u.id === 'T0001').barriers).toEqual(['oem']);
  });

  it('snippets are <= 80 chars and redact emails / phones', () => {
    const notes = 'Called shop at 555-123-4567 and mailed someone@example.com — waiting on the carrier to approve the front end damage repair today';
    const h = hit({ savedNotes: notes }, 'partner');
    const snip = h.why.slice(1, -1);
    expect(snip.length).toBeLessThanOrEqual(80);
    expect(h.why).not.toMatch(/555-123-4567|someone@example\.com/);
    const h2 = hit({ savedNotes: 'reach me at a.b@example.com — waiting on carrier approval' }, 'partner');
    expect(h2.why).toMatch(/\[redacted\]/);
  });
});

describe('Common Repairs (SYSTEM_GROUPS, >= 2 units, repeat rule)', () => {
  it('COMMON_REPAIR_MIN is 2 (Fleet Health only)', () => {
    expect(F.COMMON_REPAIR_MIN).toBe(2);
    expect(F.SYSTEM_GROUPS).toHaveLength(13);
  });
  it('1 unit in a system -> N', () => {
    const row = buildOne([makeUnit({ equipmentId: 'K1', issueSummary: 'Turbo failure' })]);
    expect(row.cells.commonYN).toBe('N');
    expect(row.cells.commonDetails).toBe('');
    expect(row.common).toEqual({ groups: [], repeat: [] });
  });
  it('2 units sharing a system -> Y with the group on row.common', () => {
    const row = buildOne([
      makeUnit({ equipmentId: 'K2', issueDetails: 'turbo whistle' }),
      makeUnit({ equipmentId: 'K1', issueSummary: 'Turbo failure' }),
      makeUnit({ equipmentId: 'K4', issueSummary: 'Turbo', lifecycleState: 'Active' }),
    ]);
    expect(row.cells.commonYN).toBe('Y');
    expect(row.cells.commonDetails).toBe('Engine: K1 (turbo failure) and K2.');   // composer (FEAT-003)
    expect(row.common).toEqual({ groups: [{ label: 'Engine', ids: ['K1', 'K2'] }], repeat: [] });
  });
  it("two units with 'air leak' / 'air brake' -> Y, group 'Air system / 5th wheel'", () => {
    const r = F.commonRepairs([
      makeUnit({ equipmentId: '321549', issueSummary: 'Air brake chamber replace' }),
      makeUnit({ equipmentId: '322468', issueDetails: 'driver reports air leak at the tank' }),
    ], TODAY);
    expect(r.yn).toBe('Y');
    expect(r.common).toEqual([{ label: 'Air system / 5th wheel', ids: ['321549', '322468'] }]);
  });
  it('one unit with repeat text -> Y via repeat (issue text or the 3 newest timeline lines)', () => {
    const r = F.commonRepairs([makeUnit({ equipmentId: 'R1', issueSummary: 'Repeat repair: previous fix did not resolve the leak' })], TODAY);
    expect(r).toMatchObject({ yn: 'Y', common: [], repeat: ['R1'] });
    expect(r.details).toBe('Repeat repair: R1');
    const t = F.commonRepairs([makeUnit({ equipmentId: 'R2', repairTimeline: '11/08 - in shop\n11/09 - same code came back after the repair' })], TODAY);
    expect(t.repeat).toEqual(['R2']);
    const old = ['10/01 - issue came back', '10/20 - at shop', '11/01 - diag', '11/09 - in repair'].join('\n');
    expect(F.commonRepairs([makeUnit({ equipmentId: 'R3', repairTimeline: old })], TODAY).yn).toBe('N');
  });
  it('lifecycle labels (Damaged, Accident, Expired inspection) never form a group', () => {
    for (const lr of ['Damaged', 'Accident', 'Expired Inspection']) {
      const r = F.commonRepairs(['L1', 'L2', 'L3'].map((id) => makeUnit({ equipmentId: id, lifecycleReason: lr })), TODAY);
      expect(r, lr).toMatchObject({ yn: 'N', common: [], repeat: [] });
    }
    const acc = F.commonRepairs([
      makeUnit({ equipmentId: 'A1', issueSummary: 'accident front end', lifecycleReason: 'Accident' }),
      makeUnit({ equipmentId: 'A2', issueSummary: 'accident', lifecycleReason: 'Accident' }),
    ], TODAY);
    expect(acc.yn).toBe('N');
  });
  it('ignores notes / timeline system mentions', () => {
    const r = F.commonRepairs(['C1', 'C2', 'C3'].map((id) => makeUnit({ equipmentId: id, savedNotes: 'turbo checked', repairTimeline: '11/01 - turbo ok' })), TODAY);
    expect(r.yn).toBe('N');
  });
  it('units[].systems holds every group label of the unit; categories are unchanged', () => {
    const row = buildOne([makeUnit({ equipmentId: 'S1', issueSummary: 'Turbo failure and coolant leak', lifecycleReason: 'Damaged' })]);
    const u = row.units[0];
    expect(u.systems).toEqual(['Engine', 'Cooling']);
    expect(u.categories).toContain('Damage repair');
  });
});
