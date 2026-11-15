// AVP40|AGNLI-shaped DBR pair (live snapshot review, output fix A): two down units whose newest
// timeline lines are long mid-sentence vendor text, plus a unit with no status / vendor.
// Names, phones and emails masked.
'use strict';

const TODAY = '2026-11-11';
const base = { domicileSite: 'AVP40', operator: 'AGNLI', lifecycleState: 'Unavailable' };
const rows = [
  Object.assign({}, base, {
    equipmentId: '39351', vendor: 'Volvo (ASIST)', savedRepairStatus: 'Waiting for vendor', lifecycleReason: 'Offsite Shop Repair',
    created: '2026-10-30T12:00:00Z',
    repairTimeline: '11/05 - Unit checked in at dealer\n11/10 - Approval notification sent to fleet: estimate V2 awaiting review, call 555-010-2000 or ops@example.com for questions about the line items',
  }),
  Object.assign({}, base, {
    equipmentId: '59080', vendor: 'Amerit', savedRepairStatus: 'Under diagnosis', lifecycleReason: 'Mechanical',
    created: '2026-11-02T12:00:00Z',
    repairTimeline: '11/10 - Diagnosis completed. Three findings confirmed: (1) cracked EGR cooler (2) leaking turbo oil line (3) worn belt tensioner, parts quote pending',
  }),
  Object.assign({}, base, { equipmentId: '61001', vendor: '', savedRepairStatus: '', lifecycleReason: '', repairTimeline: '11/09 - towed' }),
];

module.exports = { TODAY, rows };
