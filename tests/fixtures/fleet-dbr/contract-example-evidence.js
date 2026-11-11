// The design §3 example evidence (B61001, B61002, B61003, B61004, B61009) as raw fleet rows +
// enrich records. The §3 contract examples (row, map and reduce JSON) must pass the gate against
// it with 0 drops, 0 name flags, 0 unbound dates and 0 envOver (AC46). Synthetic data only.
'use strict';

const TODAY = '2026-11-11';
const FAS_NAMES = ['Z Santiago'];

const UNITS = {
  B61001: {
    vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor',
    repairTimeline: '11/09 - TA Rochester: no diesel tech available until 11/12, ETC 11/12',
  },
  B61002: {
    vendor: 'Volvo', subVendor: 'MHC Kenworth', lifecycleReason: 'Offsite Shop Repair', savedRepairStatus: 'Under diagnosis',
    repairTimeline: '11/03 - dropped at MHC Kenworth',
    asistNotes: 'ASIST: case 7712345 open; RO 448812 under diagnosis',
  },
  B61003: {
    vendor: 'Bruckners', savedRepairStatus: 'Parts ordered',
  },
  B61004: {
    vendor: 'dealer', savedRepairStatus: 'In progress',
    repairTimeline: '11/05 - dealer ETC 11/08',
  },
  B61009: {
    vendor: 'CEI', lifecycleReason: 'Accident',
    repairTimeline: '11/07 - CEI claim opened; carrier has not released unit for repair',
  },
};

const ENRICH = {
  B61001: { manualEntries: ['11/10 - called TA re tech callout', '11/10 - TA update: bay confirmed for 11/12'] },
  B61002: { manualEntries: ['11/09 - escalated ASIST case 7712345, no dealer status since 11/03'] },
  B61003: {
    manualEntries: [
      '11/08 - Bruckners: turbo actuator back-ordered, parts ETA 11/14 (RO 448901) [em:1a2b3c4d]',
      '11/10 - checked alternate source with Bruckners Syracuse, none in stock',
    ],
  },
  B61004: { manualEntries: ['11/11 - dealer: waiting on EGR cooler'] },
};

module.exports = { TODAY, FAS_NAMES, UNITS, ENRICH };
