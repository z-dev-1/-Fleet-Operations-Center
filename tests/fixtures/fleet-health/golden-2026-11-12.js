// Golden Fleet Health fixture, 2026-11-12 (DBR_Z_Santiago_2026-11-12.xlsx, sheet "DBR").
// Same units as golden-2026-11-11.js one day later, with the 11-12 changes from the golden sheet:
// 322377 is back up (EOFE01 12 / 2 -> 83.3, SCAC EOFE 11 / 2 -> 81.8), B12271 is at
// Kenworth/PACCAR with an appointment scheduled, 39455's coolant issue came back after a TA repair
// (Common Repairs: repeat repair). Other uptimes as on 11-11: ROC5 29 / 10 -> 65.5, AVP40 42 / 7
// -> 83.3, SCAC AGNLI 8 / 4 -> 50, SCAC YTSC 17 / 1 -> 94.1. No ETC on any unit.
// `expected` is copied verbatim from the golden sheet (tests never read .agents/).
//
// Q4 grain deviations (design §9 / §11 Q4: the builder keeps the Domicile x SCAC grain):
//   - the golden AGNLI row counts 4 units SCAC-wide, including 39339 at domicile ABE40. Here 39339
//     sits at ABE40|AGNLI (not a roster pair), so AVP40|AGNLI has 3 down units: NO ETC is 3, not
//     the golden 4 (deviations.noEtc);
//   - 39339 is therefore absent from the AGNLI 1P, Parts and Common Details although the golden
//     names it (deviations.notInPair).
'use strict';
const { USER, GOLDEN_HEADERS, ROSTER_EXACT, down, up } = require('./golden-helpers');

const VOLVO = 'VOLVO_ASIST';
const rows = [
  // ROC5|AUVTE — 10 down
  down('B13014', 'ROC5', 'AUVTE', { vendor: 'DSP_ENTERED', lifecycleReason: 'Accident', status: 'Waiting for vendor', days: 60, issue: 'Accident damage with the hood detached.' }),
  down('B62064', 'ROC5', 'AUVTE', { vendor: 'FleetNet', lifecycleReason: 'Impounded', days: 16, issue: 'Unit impounded at a gas station; the impound fee must be paid before release and the tow to ROC5.' }),
  down('B12258', 'ROC5', 'AUVTE', { vendor: 'KWNE', status: 'Parts ordered', partsStatus: 'ordered', days: 16, issue: 'CEL on; engine diagnosis found the engine harness needs a repin.' }),
  down('B12275', 'ROC5', 'AUVTE', { vendor: 'KWNE', status: 'Parts ordered', partsStatus: 'ordered', days: 14, issue: 'Key snapped in the ignition during PM-B service; CNG filter housing and tumbler on order.' }),
  down('B12267', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 11, issue: 'Turbo seals leaking; charge air cooler and AC line need replacement.' }),
  down('B62059', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 9, issue: 'Hood shocks broken and air drain lines damaged.' }),
  down('B12271', 'ROC5', 'AUVTE', { vendor: 'PACCAR', status: 'Appointment scheduled', days: 8, issue: 'Compression loss with a cylinder 3 misfire.' }),
  down('B12263', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 7, issue: 'Engine oil leak at the crankcase seal.' }),
  down('B12195', 'ROC5', 'AUVTE', { vendor: 'COX', status: 'Parts ordered', partsStatus: 'ordered', days: 5, issue: 'Corroded battery terminals; batteries and cables need replacement.' }),
  down('B20038', 'ROC5', 'AUVTE', { status: 'Under diagnosis', days: 4, issue: 'Tach parasitic battery drain; cab climate controls intermittent.' }),
  ...up('ROC5', 'AUVTE', 19),
  // AVP40|AGNLI — 3 down (39339 is at ABE40, see the Q4 note above)
  down('39351', 'AVP40', 'AGNLI', { vendor: VOLVO, status: 'Repair in progress', days: 24, issue: 'Multiple defects: 5th-wheel play, tire, step, batteries, windshield and seatbelt.' }),
  down('39237', 'AVP40', 'AGNLI', { vendor: VOLVO, status: 'Repair in progress', days: 6, issue: 'System voltage and SCR NOx warnings; airbag fittings leaking.' }),
  down('59080', 'AVP40', 'AGNLI', { vendor: 'Amerit', status: 'Parts ordered', partsStatus: 'ordered', days: 3, issue: "5th-wheel won't release; rear airbag fittings leaking (3 of 4) and air-ride switch disconnected." }),
  ...up('AVP40', 'AGNLI', 4),
  down('39339', 'ABE40', 'AGNLI', { vendor: 'Amerit', status: 'Parts ordered', partsStatus: 'ordered', days: 3, issue: '5th-wheel slide inoperative; prior 3-in-1 unrepaired and broken step.' }),
  // AVP40|YTSC — 1 down
  down('39455', 'AVP40', 'YTSC', { vendor: VOLVO, status: 'Repair in progress', days: 6, issue: 'Coolant loss trend with the stop-engine light on; the prior TA repair did not resolve it.' }),
  ...up('AVP40', 'YTSC', 16),
  // AVP40|AZNG — not a roster pair; 3 down units pad the AVP40 domicile count
  down('Z40001', 'AVP40', 'AZNG', { days: 5, issue: 'Wiper motor inoperative.' }),
  down('Z40002', 'AVP40', 'AZNG', { days: 4, issue: 'Mirror glass cracked.' }),
  down('Z40003', 'AVP40', 'AZNG', { days: 2, issue: 'Seat adjuster broken.' }),
  ...up('AVP40', 'AZNG', 15),
  // EOFE01|EOFE — 2 down (322377 is back up)
  down('321963', 'EOFE01', 'EOFE', { vendor: VOLVO, status: 'Under diagnosis', days: 20, issue: 'Very high valve tap, oil normal; internal engine concern.' }),
  down('IND260261', 'EOFE01', 'EOFE', { vendor: 'TA', lifecycleReason: 'Accident', status: 'Parts ordered', partsStatus: 'ordered', days: 17, issue: 'Deer collision damage: hood, bumper, headlight, cab extender and fairing; towed back to EOFE01.' }),
  { equipmentId: '322377', domicileSite: 'EOFE01', operator: 'EOFE', lifecycleState: 'Available' },
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
    "1P Vendor Barrier — Details": "COX has 4 units awaiting parts: B12267 (turbo seals/AC line), B62059 (air drain lines/hood shock), B12263 (engine oil leak), B12195 (corroded battery terminals) — all parts-ordered, repair pace slow.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "KWNE offsite: B12258 (16d, CEL/engine diagnosis) and B12275 (14d, PM-B service) parts-ordered. Kenworth/PACCAR B12271 (compression loss, cyl 3 misfire) appointment scheduled.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "Yes",
    "Partner Barrier — Details": "B13014 (60d, accident, DSP_ENTERED, hood detached) waiting on vendor; B62064 (16d, impounded at gas station — impound fee must be paid before release/tow to ROC5).",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "Parts ordered: B12267, B62059, B12263, B12195 (COX), B12258, B12275 (KWNE).",
    "Common Repairs Y/N?": "Yes",
    "Common Repairs — Details": "Battery/electrical: B12195 (corroded terminals), B20038 (cab/climate). Engine: B12271 (compression/misfire), B12267 (turbo seals).",
    "Expected units with ETC for Today": 0,
    "NO ETC": 10,
    "Missed ETC": 0,
    "FAS Actions": "Following up COX on parts ETAs (B12267/B62059/B12263/B12195); pushing KWNE on B12258 and B12275; confirming Kenworth appointment for B12271; escalating B62064 impound-fee release and B13014 (60d) accident vendor assignment.",
    "Where Do You Need Support?": "Support on B62064 impound-fee payment/release and B13014 (60d accident) carrier-DSP vendor assignment."
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
    "1P Vendor Barrier — Details": "Amerit: 39339 (ABE40, 3d, 5th-wheel slide inop, prior 3-in-1 unrepaired, broken step) and 59080 (AVP40, 3d, 5th-wheel won’t release, rear airbag fittings leaking 3 of 4, air-ride switch disconnected) — both parts-ordered.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "Volvo/ASIST offsite: 39237 (6d, system voltage + SCR NOx warnings, airbag fittings leaking) and 39351 (24d, multiple defects — 5th-wheel play, tire, step, batteries, windshield, seatbelt) — both repair in progress.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "Amerit parts ordered on 39339 and 59080 (5th-wheel / air-system components).",
    "Common Repairs Y/N?": "Yes",
    "Common Repairs — Details": "Air system / 5th wheel recurring: 39237, 39339, 59080 all show airbag-fitting / 5th-wheel faults.",
    "Expected units with ETC for Today": 0,
    "NO ETC": 4,
    "Missed ETC": 0,
    "FAS Actions": "Pushing Volvo dealer on 39237 and 39351 repair progress/ETC; following up Amerit on 39339 and 59080 parts ETAs.",
    "Where Do You Need Support?": "Vendor performance — Amerit 5th-wheel/air-system turnaround and Volvo dealer ETCs."
  },
  {
    "FAS Name": "Z Santiago",
    "Domicile": "EOFE01",
    "Domicile Uptime": 83.3,
    "Domicile Units Down": 2,
    "SCAC": "EOFE",
    "SCAC Uptime": 81.8,
    "SCAC Units Down": 2,
    "1P Vendor Barrier Y/N?": "Yes",
    "1P Vendor Barrier — Details": "TA accident unit IND260261 (17d, deer collision, towed back to EOFE01) parts-ordered.",
    "OEM Barrier Y/N?": "Yes",
    "OEM Barrier — Details": "Volvo/ASIST 321963 (20d, very high valve tap, oil normal — internal engine concern) under diagnosis.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "Yes",
    "Parts Delay — Details": "IND260261 accident body parts on order (hood/bumper/headlight/cab extender/fairing).",
    "Common Repairs Y/N?": "No",
    "Common Repairs — Details": "",
    "Expected units with ETC for Today": 0,
    "NO ETC": 2,
    "Missed ETC": 0,
    "FAS Actions": "Pushing Volvo dealer for 321963 diagnosis result/ETC; following up TA on IND260261 accident parts and repair schedule.",
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
    "OEM Barrier — Details": "Volvo/ASIST 39455 (6d, coolant loss trend, stop-engine light; prior TA repair did not resolve) — repair in progress at dealer.",
    "Estimate Barrier Y/N?": "No",
    "Estimate Barrier — Details": "",
    "Partner Barrier Y/N?": "No",
    "Partner Barrier — Details": "",
    "Parts Delay Y/N?": "No",
    "Parts Delay — Details": "",
    "Common Repairs Y/N?": "Yes",
    "Common Repairs — Details": "Repeat repair: 39455 coolant issue reopened after TA did not resolve it.",
    "Expected units with ETC for Today": 0,
    "NO ETC": 1,
    "Missed ETC": 0,
    "FAS Actions": "Following up Volvo dealer on 39455 cooling-system repair completion and confirming the coolant fix holds.",
    "Where Do You Need Support?": "None."
  }
];

module.exports = {
  today: '2026-11-12',
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
