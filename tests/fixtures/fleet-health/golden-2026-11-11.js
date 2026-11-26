// Golden Fleet Health fixture, 2026-11-11 (DBR_Z_Santiago_fill.xlsx, sheet "DBR (full)").
// Synthetic fleet rows derived from the golden sheet (design §9): every golden down unit with its
// vendor, days (workDuration), status, an issueSummary paraphrasing the golden Details wording,
// partsStatus and no ETC; up rows padded so the uptimes reproduce the golden values:
//   ROC5 29 total / 10 down -> 65.5 (all AUVTE, so SCAC AUVTE 65.5 too)
//   AVP40 42 / 7 -> 83.3 (AGNLI 7 incl. 3 down, YTSC 17 incl. 1 down, AZNG 18 incl. 3 down)
//   SCAC AGNLI 8 / 4 -> 50 (AVP40 7 + 39339 at ABE40)
//   EOFE01 12 / 3 -> 75 (EOFE 11 + one AZNG up row); SCAC EOFE 11 / 3 -> 72.7
//   SCAC YTSC 17 / 1 -> 94.1
// `expected` is copied verbatim from the golden sheet (tests never read .agents/).
//
// Q4 grain deviations (design §9 / §11 Q4: the builder keeps the Domicile x SCAC grain):
//   - the golden AGNLI row counts 4 units SCAC-wide, including 39339, which the golden places at
//     domicile ABE40. Here 39339 sits at ABE40|AGNLI (not a roster pair), so AVP40|AGNLI has 3
//     down units: NO ETC is 3, not the golden 4 (deviations.noEtc);
//   - 39339 is therefore absent from the AGNLI 1P, Parts and Common Details although the golden
//     names it (deviations.notInPair).
'use strict';
const { USER, GOLDEN_HEADERS, ROSTER_EXACT, down, up } = require('./golden-helpers');

const VOLVO = 'VOLVO_ASIST';
const rows = [
  // ROC5|AUVTE — 10 down
  down('B13014', 'ROC5', 'AUVTE', { vendor: 'DSP_ENTERED', lifecycleReason: 'Accident', status: 'Waiting for vendor', days: 59, issue: 'Accident damage with the hood detached.' }),
  down('B62064', 'ROC5', 'AUVTE', { vendor: 'FleetNet', lifecycleReason: 'Impounded', days: 15, issue: 'Unit impounded at a gas station; the impound fee must be paid before the tow to ROC5.' }),
  down('B12258', 'ROC5', 'AUVTE', { vendor: 'KWNE', status: 'Parts ordered', partsStatus: 'ordered', days: 15, issue: 'CEL on; the engine harness needs a repin.' }),
  down('B12275', 'ROC5', 'AUVTE', { vendor: 'KWNE', status: 'Parts ordered', partsStatus: 'ordered', days: 13, issue: 'Key snapped in the ignition during PM-B; CNG filter housing and tumbler on order.' }),
  down('B12267', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 10, issue: 'Turbo seals leaking; charge air cooler and AC line need replacement.' }),
  down('B62059', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 8, issue: 'Hood shocks broken and air drain lines damaged.' }),
  down('B12271', 'ROC5', 'AUVTE', { vendor: 'Freightliner', status: 'Under diagnosis', days: 7, issue: 'Compression loss with a cylinder 3 misfire.' }),
  down('B12263', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 6, issue: 'Engine oil leak at the crankcase seal.' }),
  down('B12195', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 4, issue: 'Corroded battery terminals; batteries and cables need replacement.' }),
  down('B20038', 'ROC5', 'AUVTE', { status: 'Under diagnosis', days: 3, issue: 'Tach parasitic battery drain; cab climate controls intermittent.' }),
  ...up('ROC5', 'AUVTE', 19),
  // AVP40|AGNLI — 3 down (39339 is at ABE40, see the Q4 note above)
  down('39351', 'AVP40', 'AGNLI', { vendor: VOLVO, status: 'Repair in progress', days: 23, issue: 'Multiple defects: 5th-wheel play, tire, step, batteries, windshield and seatbelt.' }),
  down('39237', 'AVP40', 'AGNLI', { vendor: VOLVO, status: 'Repair in progress', days: 5, issue: 'System voltage and SCR NOx warnings; airbag fittings leaking.' }),
  down('59080', 'AVP40', 'AGNLI', { vendor: 'Amerit', status: 'Parts ordered', partsStatus: 'ordered', days: 2, issue: "5th-wheel won't release; rear airbag fittings leaking (3 of 4) and air-ride switch disconnected." }),
  ...up('AVP40', 'AGNLI', 4),
  down('39339', 'ABE40', 'AGNLI', { vendor: 'Amerit', status: 'Parts ordered', partsStatus: 'ordered', days: 2, issue: '5th-wheel slide inoperative; prior 3-in-1 unrepaired and broken step.' }),
  // AVP40|YTSC — 1 down
  down('39455', 'AVP40', 'YTSC', { vendor: VOLVO, status: 'Repair in progress', days: 5, issue: 'Coolant loss trend with no fault code; full cooling inspection.' }),
  ...up('AVP40', 'YTSC', 16),
  // AVP40|AZNG — not a roster pair; 3 down units pad the AVP40 domicile count
  down('Z40001', 'AVP40', 'AZNG', { days: 4, issue: 'Wiper motor inoperative.' }),
  down('Z40002', 'AVP40', 'AZNG', { days: 3, issue: 'Mirror glass cracked.' }),
  down('Z40003', 'AVP40', 'AZNG', { days: 1, issue: 'Seat adjuster broken.' }),
  ...up('AVP40', 'AZNG', 15),
  // EOFE01|EOFE — 3 down
  down('321963', 'EOFE01', 'EOFE', { vendor: VOLVO, status: 'Under diagnosis', days: 19, issue: 'High valve tap, oil normal; internal engine concern.' }),
  down('IND260261', 'EOFE01', 'EOFE', { vendor: 'TA', lifecycleReason: 'Accident', status: 'Parts ordered', partsStatus: 'ordered', days: 16, issue: 'Deer collision damage: hood, bumper, headlight, cab extender and fairing.' }),
  down('322377', 'EOFE01', 'EOFE', { vendor: 'TA', status: 'Appointment scheduled', days: 2, issue: 'Dead batteries; TA appointment scheduled.' }),
  ...up('EOFE01', 'EOFE', 8),
  ...up('EOFE01', 'AZNG', 1),
];

const expected = [
  {
    "FAS Name": "Z Santiago",
    "Domicile": "ROC5",
    "Domicile Uptime": 65.5,
    "Domicile Units Down": 10,
    "SCAC": "AUVTE",
    "SCAC Uptime": 65.5,
    "SCAC Units Down": 10,
    "1P Vendor Barrier Y/N?": "Yes",
    "1P Vendor Barrier — Details": "COX has 4 units (B12267, B62059, B12263, B12195) awaiting parts; diag/repair pace slow.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "KWNE offsite: B12275 (13d, key snapped in ignition during PM-B, CNG filter housing + tumbler) and B12258 (15d, CEL harness repin), both parts-ordered. Freightliner B12271 under diag (compression loss, cyl 3 misfire).",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "Yes",
    "Partner Barrier — Details": "B13014 (59d, accident, DSP_ENTERED, hood detached) waiting on vendor; B62064 (15d, impounded — fee payment required before tow to ROC5).",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "Parts ordered: B12267 (turbo + CAC), B62059 (hood shocks/air drain lines), B12263 (crankcase seal), B12195 (batteries/cables), B12275 (CNG filter housing/tumbler), B12258 (harness).",
    "Common Repairs Y/N?": "Yes",
    "Common Repairs — Details": "Battery/electrical: B12195 (corroded terminals), B20038 (tach parasitic drain). Engine: B12271 (compression/misfire), B12267 (turbo seals).",
    "Expected units with ETC for Today": 0,
    "NO ETC": 10,
    "Missed ETC": 0,
    "FAS Actions": "Following up with COX on parts ETAs (B12267/B62059/B12263/B12195); pushing KWNE on B12275 & B12258; chasing Freightliner diag on B12271; escalating B62064 impound-fee release and B13014 accident vendor assignment.",
    "Where Do You Need Support?": "Support on B62064 impound-fee payment/release and B13014 (59d accident) carrier-DSP vendor assignment."
  },
  {
    "FAS Name": "Z Santiago",
    "Domicile": "AVP40",
    "Domicile Uptime": 83.3,
    "Domicile Units Down": 7,
    "SCAC": "AGNLI",
    "SCAC Uptime": 50,
    "SCAC Units Down": 4,
    "1P Vendor Barrier Y/N?": "Yes",
    "1P Vendor Barrier — Details": "Amerit: 39339 (ABE40, 2d, 5th-wheel slide inop, prior 3-in-1 unrepaired, broken step) and 59080 (AVP40, 2d, 5th-wheel won’t release, rear airbag fittings leaking 3 of 4, air-ride switch disconnected), both parts-ordered.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "Volvo/ASIST offsite: 39237 (5d, system voltage + SCR NOx warnings, airbag fittings leaking) and 39351 (23d, multiple defects — 5th-wheel play, tire, step, batteries, windshield, seatbelt), both repair in progress.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "Amerit parts ordered on 39339 and 59080 (5th-wheel / air-system components).",
    "Common Repairs Y/N?": "Yes",
    "Common Repairs — Details": "Air system / 5th wheel: 39237, 39339, 59080 all show airbag-fitting / 5th-wheel faults.",
    "Expected units with ETC for Today": 0,
    "NO ETC": 4,
    "Missed ETC": 0,
    "FAS Actions": "Pushing Volvo dealer on 39237 and 39351 repair progress/ETC; following up Amerit on 39339 and 59080 parts ETAs.",
    "Where Do You Need Support?": "Vendor performance — Amerit 5th-wheel/air-system turnaround and Volvo dealer ETCs."
  },
  {
    "FAS Name": "Z Santiago",
    "Domicile": "EOFE01",
    "Domicile Uptime": 75,
    "Domicile Units Down": 3,
    "SCAC": "EOFE",
    "SCAC Uptime": 72.7,
    "SCAC Units Down": 3,
    "1P Vendor Barrier Y/N?": "Yes",
    "1P Vendor Barrier — Details": "TA: 322377 (dead batteries, appointment scheduled) and accident unit IND260261 (16d), parts-ordered.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "Volvo/ASIST 321963 (19d, high valve tap, oil normal — internal engine concern) under diagnosis.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "IND260261 accident parts (hood/bumper/headlight/cab extender/fairing) on order.",
    "Common Repairs Y/N?": "No",
    "Common Repairs — Details": "",
    "Expected units with ETC for Today": 0,
    "NO ETC": 3,
    "Missed ETC": 0,
    "FAS Actions": "Pushing Volvo dealer for 321963 diagnosis result/ETC; following up TA on IND260261 accident parts and 322377 battery appointment.",
    "Where Do You Need Support?": "Vendor performance — dealer diagnosis turnaround on 321963."
  },
  {
    "FAS Name": "Z Santiago",
    "Domicile": "AVP40",
    "Domicile Uptime": 83.3,
    "Domicile Units Down": 7,
    "SCAC": "YTSC",
    "SCAC Uptime": 94.1,
    "SCAC Units Down": 1,
    "1P Vendor Barrier Y/N?": "No",
    "1P Vendor Barrier — Details": "",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "Volvo/ASIST 39455 (5d, coolant loss trend, no fault code) — full cooling inspection, repair in progress.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "No",
    "Parts Delay — Details": "",
    "Common Repairs Y/N?": "No",
    "Common Repairs — Details": "",
    "Expected units with ETC for Today": 0,
    "NO ETC": 1,
    "Missed ETC": 0,
    "FAS Actions": "Following up with Volvo dealer on 39455 cooling-system diagnosis and ETC.",
    "Where Do You Need Support?": "None."
  }
];

module.exports = {
  today: '2026-11-11',
  userName: USER,
  headers: GOLDEN_HEADERS,
  rosterExact: ROSTER_EXACT,
  rows,
  expected,
  // Golden vendor label of the largest vendor/dealer group of each 1P / OEM cell.
  leads: {
    'ROC5|AUVTE': { vendor1pDetails: 'COX', oemDetails: 'KWNE' },
    'AVP40|AGNLI': { vendor1pDetails: 'Amerit', oemDetails: 'Volvo/ASIST' },
    'EOFE01|EOFE': { vendor1pDetails: 'TA', oemDetails: 'Volvo/ASIST' },
    'AVP40|YTSC': { oemDetails: 'Volvo/ASIST' },
  },
  // Q4 grain deviations (see the header comment).
  deviations: { 'AVP40|AGNLI': { noEtc: '3', notInPair: ['39339'] } },
};
