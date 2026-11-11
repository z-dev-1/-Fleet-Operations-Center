// Fleet DBR barrier rules: one positive + one negative per clause, Details lines only for
// matching down units of the pair, vendor regex boundaries, snippets, Common Repairs threshold.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const F = require('../src/dbr/fleet-dbr');
const { makeUnit, makeFleetRows } = require('./fixtures/fleet-dbr/make-rows');

const TODAY = '2026-11-10';
const hit = (fields, id) => F.classifyBarriers(makeUnit(fields), { today: TODAY })[id];
const buildOne = (units) => F.buildFleetDbr(units, { today: TODAY }).rows[0];

describe('1P Vendor', () => {
  it('onsite vendor + rejection in recent text -> Y with snippet', () => {
    const h = hit({ vendor: 'Amerit', savedNotes: 'Amerit unable to repair, needs dealer' }, 'vendor1p');
    expect(h.why).toMatch(/^vendor can't complete: '.*unable to repair/);
  });
  it('onsite vendor + Waiting for vendor / Tech shortage -> Y', () => {
    expect(hit({ vendor: 'COX', savedRepairStatus: 'Waiting for vendor' }, 'vendor1p').why).toBe('status Waiting for vendor');
    expect(hit({ vendor: 'TA', delayReasonCodes: 'Tech _ shortage' }, 'vendor1p').why).toBe('delay code Tech shortage');
  });
  it('AC14: AAP status "Cannot Complete — Parts Ordered" on a COX unit is not a 1P rejection (any dash / spacing / case)', () => {
    for (const s of ['Cannot Complete \u2014 Parts Ordered', 'Cannot Complete - Parts Ordered', 'cannot complete\u2013parts ordered', 'CANNOT COMPLETE \u2014  PARTS ORDERED']) {
      const b = F.classifyBarriers(makeUnit({
        vendor: 'COX', savedRepairStatus: 'Cannot Complete \u2014 Parts Ordered', repairTimeline: '11/09 - Status: ' + s, savedNotes: s,
      }), { today: TODAY });
      expect(b.vendor1p, s).toBeNull();
      expect(b.parts.why).toMatch(/status Cannot Complete \u2014 Parts Ordered/);
    }
    const row = buildOne([makeUnit({ equipmentId: 'X1', vendor: 'COX', savedRepairStatus: 'Cannot Complete \u2014 Parts Ordered', repairTimeline: '11/09 - Cannot Complete \u2014 Parts Ordered' })]);
    expect(row.cells.vendor1pYN).toBe('N');
    expect(row.cells.partsYN).toBe('Y');
  });
  it('AC14: "unable to complete, sending to dealer" on a COX unit still hits', () => {
    const h = hit({ vendor: 'COX', repairTimeline: '11/09 - COX unable to complete, sending to dealer' }, 'vendor1p');
    expect(h.why).toMatch(/^vendor can't complete: '.*unable to complete, sending to dealer/);
  });
  it('onsite vendor with no signal -> N', () => {
    expect(hit({ vendor: 'Amerit', savedNotes: 'repair in progress' }, 'vendor1p')).toBeNull();
  });
  it('"Estimate rejected by MCS" is an Estimate barrier, not 1P (R5)', () => {
    const b = F.classifyBarriers(makeUnit({
      vendor: 'Amerit', serviceState: 'Estimate rejected', repairTimeline: '11/09 - Estimate rejected by MCS',
    }), { today: TODAY });
    expect(b.vendor1p).toBeNull();
    expect(b.estimate).toEqual({ why: 'estimate rejected' });
  });
  it('Volvo + "rejected" is not 1P', () => {
    expect(hit({ vendor: 'Volvo', savedNotes: 'job rejected' }, 'vendor1p')).toBeNull();
  });
  it('a rejection outside the 3 latest dated timeline lines -> N', () => {
    const tl = ['9/01 - Amerit declined, unable to repair', '10/01 - towed', '10/15 - at shop', '11/01 - repair in progress'].join('\n');
    expect(hit({ vendor: 'Amerit', repairTimeline: tl }, 'vendor1p')).toBeNull();
    const tl2 = ['10/01 - towed', '10/15 - at shop', '11/01 - Amerit declined the job'].join('\n');
    expect(hit({ vendor: 'Amerit', repairTimeline: tl2 }, 'vendor1p')).not.toBeNull();
  });
});

describe('OEM (R6: at OEM/dealer AND stalled)', () => {
  it('Volvo + Repair in progress + 5d -> N', () => {
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Repair in progress', workDuration: '5d 2h 0m' }, 'oem')).toBeNull();
  });
  it('Volvo + Waiting for vendor -> Y', () => {
    expect(hit({ vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor' }, 'oem').why).toBe('at OEM/dealer Volvo: status Waiting for vendor');
  });
  it('Offsite Shop Repair + 20d -> Y', () => {
    expect(hit({ lifecycleReason: 'Offsite Shop Repair', workDuration: '20d 1h 0m' }, 'oem').why).toBe('at OEM/dealer no vendor: 20d down');
  });
  it('dealer no-status / delay codes are stall signals', () => {
    expect(hit({ vendor: 'Freightliner (DAIMLER)', offsiteStageDetail: 'No status set by the dealer' }, 'oem')).not.toBeNull();
    expect(hit({ vendor: 'KWNE', delayReasonCodes: 'Waiting _ for diagnosis' }, 'oem').why).toMatch(/Waiting for diagnosis/);
  });
  it('CEI is Partner, not OEM', () => {
    const b = F.classifyBarriers(makeUnit({ vendor: 'CEI', savedRepairStatus: 'Waiting for vendor', workDuration: '30d' }), { today: TODAY });
    expect(b.oem).toBeNull();
    expect(b.partner).toEqual({ why: 'CEI (accident/claims managed)' });
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
  it('onsite vendors match, look-alikes do not', () => {
    for (const v of ['Amerit', 'COX', 'TA', 'GOODYEAR', 'FleetNet']) expect(F.ONSITE_VENDOR_RE.test(v)).toBe(true);
    for (const v of ['Tacoma Shop', 'Coxswain', 'Volvo', 'Automobile Club']) expect(F.ONSITE_VENDOR_RE.test(v)).toBe(false);
  });
});

describe('Estimate', () => {
  it('positive clauses', () => {
    expect(hit({ estimatePendingCost: '$1,250.50' }, 'estimate').why).toBe('estimate pending $1250.5');
    expect(hit({ savedRepairStatus: 'Awaiting approval' }, 'estimate').why).toBe('status Awaiting approval');
    expect(hit({ offsiteStage: 'Approval' }, 'estimate').why).toBe('offsite stage approval');
    expect(hit({ escalations: 'Estimate review' }, 'estimate').why).toBe('escalation Estimate review');
    expect(hit({ savedNotes: 'shop is waiting on an estimate' }, 'estimate').why).toMatch(/waiting on an estimate/);
  });
  it('negative', () => {
    expect(hit({ estimatePendingCost: '0', savedNotes: 'estimate approved, in repair' }, 'estimate')).toBeNull();
  });
});

describe('Partner', () => {
  it('positive clauses', () => {
    expect(hit({ vendor: 'DSP_ENTERED' }, 'partner').why).toBe('DSP-entered (carrier-managed)');
    expect(hit({ lifecycleReason: 'Accident' }, 'partner').why).toBe('Accident (carrier/insurance owned)');
    expect(hit({ savedNotes: 'adjuster waiting on accident report' }, 'partner').why).toMatch(/adjuster/);
  });
  it('negative', () => {
    expect(hit({ vendor: 'Amerit', savedNotes: 'battery replaced' }, 'partner')).toBeNull();
  });
});

describe('Parts Delay', () => {
  it('Sourcing _ parts is normalized; clauses are joined', () => {
    const h = hit({ delayReasonCodes: 'Sourcing _ parts', lifecycleReason: 'Parts Delay' }, 'parts');
    expect(h.why).toBe('delay code Sourcing parts; lifecycle Parts Delay');
  });
  it('status / offsite / text clauses', () => {
    expect(hit({ savedRepairStatus: 'Parts ordered' }, 'parts').why).toBe('status Parts ordered');
    expect(hit({ offsiteStageDetail: 'Waiting on parts from OEM' }, 'parts').why).toMatch(/^offsite: /);
    expect(hit({ savedNotes: 'turbo on backorder' }, 'parts').why).toMatch(/backorder/);
  });
  it('negative', () => {
    expect(hit({ delayReasonCodes: 'Tech _ shortage', savedNotes: 'in repair' }, 'parts')).toBeNull();
  });
});

describe('Details cells', () => {
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
    expect(row.cells.vendor1pDetails.split('\n')).toEqual([
      'D2 (Amerit, 30d): status Waiting for vendor',
      'D1 (Amerit, 9d): status Waiting for vendor',
      'D4 (COX): status Waiting for vendor', // R16: no "nulld"
    ]);
    expect(row.cells.vendor1pDetails).not.toMatch(/nulld|D3|D5/);
    for (const col of ['oem', 'estimate', 'partner', 'parts']) {
      expect(row.cells[col + 'YN']).toBe('N');
      expect(row.cells[col + 'Details']).toBe('');
    }
  });

  it('every Details line on the fixture starts with a down unit ID of that pair', () => {
    const rows = makeFleetRows({
      T0001: { vendor: 'Volvo', savedRepairStatus: 'Waiting for vendor' },
      T0002: { lifecycleReason: 'Accident', savedNotes: 'insurance claim filed' },
      T0045: { delayReasonCodes: 'Sourcing _ parts' },
      T0046: { estimatePendingCost: '500' },
    });
    const built = F.buildFleetDbr(rows, { today: TODAY });
    let lines = 0;
    for (const r of built.rows) {
      const ids = new Set(r.units.map((u) => u.id));
      for (const col of ['vendor1pDetails', 'oemDetails', 'estimateDetails', 'partnerDetails', 'partsDetails']) {
        for (const line of r.cells[col].split('\n').filter(Boolean)) {
          lines += 1;
          expect(ids.has(line.split(' ')[0])).toBe(true);
        }
      }
    }
    expect(lines).toBe(4);
    const tuzr = built.rows.find((r) => r.key === 'ABE40|TUZR');
    expect(tuzr.cells.oemYN).toBe('Y');
    expect(tuzr.cells.partnerYN).toBe('Y');
    expect(tuzr.units.find((u) => u.id === 'T0001').barriers).toEqual(['oem']);
  });

  it('snippets are <= 80 chars and redact emails / phones', () => {
    const notes = 'Called shop at 555-123-4567 and mailed someone@example.com — insurance adjuster still reviewing the claim for the front end damage today';
    const h = hit({ savedNotes: notes }, 'partner');
    const snip = h.why.slice(1, -1);
    expect(snip.length).toBeLessThanOrEqual(80);
    expect(h.why).not.toMatch(/555-123-4567|someone@example\.com/);
    const h2 = hit({ savedNotes: 'reach me at a.b@example.com — insurance adjuster engaged' }, 'partner');
    expect(h2.why).toMatch(/\[redacted\]/);
  });
});

describe('Common Repairs (R7, R17)', () => {
  it('2 units sharing a category -> N', () => {
    const row = buildOne([
      makeUnit({ equipmentId: 'K1', issueSummary: 'Turbo failure' }),
      makeUnit({ equipmentId: 'K2', issueDetails: 'turbo whistle' }),
    ]);
    expect(row.cells.commonYN).toBe('N');
    expect(row.cells.commonDetails).toBe('');
  });
  it('3 units sharing a category -> Y with "<Label> — 3 units: ids"', () => {
    const row = buildOne([
      makeUnit({ equipmentId: 'K1', issueSummary: 'Turbo failure' }),
      makeUnit({ equipmentId: 'K2', issueDetails: 'turbo whistle' }),
      makeUnit({ equipmentId: 'K3', issueSummary: 'TURBO actuator' }),
      makeUnit({ equipmentId: 'K4', issueSummary: 'Turbo', lifecycleState: 'Active' }),
    ]);
    expect(F.COMMON_REPAIR_MIN).toBe(3);
    expect(row.cells.commonYN).toBe('Y');
    expect(row.cells.commonDetails).toBe('Turbo \u2014 3 units: K1, K2, K3');
  });
  it('accident text + lifecycle Accident counts once per unit', () => {
    const r = F.commonRepairs([
      makeUnit({ equipmentId: 'A1', issueSummary: 'accident front end', lifecycleReason: 'Accident' }),
      makeUnit({ equipmentId: 'A2', issueSummary: 'accident', lifecycleReason: 'Accident' }),
    ]);
    expect(r.yn).toBe('N');
    const r3 = F.commonRepairs([
      makeUnit({ equipmentId: 'A1', issueSummary: 'accident front end', lifecycleReason: 'Accident' }),
      makeUnit({ equipmentId: 'A2', lifecycleReason: 'Accident' }),
      makeUnit({ equipmentId: 'A3', issueSummary: 'Accident' }),
    ]);
    expect(r3.details).toBe('Accident \u2014 3 units: A1, A2, A3');
  });
  it('ignores timeline / notes mentions', () => {
    const r = F.commonRepairs(['C1', 'C2', 'C3'].map((id) => makeUnit({ equipmentId: id, savedNotes: 'turbo checked', repairTimeline: '11/01 - turbo ok' })));
    expect(r.yn).toBe('N');
  });
});
