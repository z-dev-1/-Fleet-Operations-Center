// Shared builders for the hand-authored golden Fleet Health fixtures (golden-2026-11-11.js,
// golden-2026-11-12.js). Synthetic rows only: unit ids, vendors, days, status and issue text
// paraphrased from the golden sheets (DBR_Z_Santiago_fill.xlsx / DBR_Z_Santiago_2026-11-12.xlsx).
'use strict';

const USER = 'Z Santiago';

// The 24 golden sheet headers, byte for byte.
const GOLDEN_HEADERS = Object.freeze([
  'FAS Name', 'Domicile', 'Domicile Uptime', 'Domicile Units Down', 'SCAC', 'SCAC Uptime', 'SCAC Units Down',
  '1P Vendor Barrier Y/N?', '1P Vendor Barrier \u2014 Details', 'OEM Barrier Y/N?', 'OEM Barrier \u2014 Details',
  'Estimate Barrier Y/N?', 'Estimate Barrier \u2014 Details', 'Partner Barrier Y/N?', 'Partner Barrier \u2014 Details',
  'Parts Delay Y/N?', 'Parts Delay \u2014 Details', 'Common Repairs Y/N?', 'Common Repairs \u2014 Details',
  'Expected units with ETC for Today', 'NO ETC', 'Missed ETC', 'FAS Actions', 'Where Do You Need Support?',
]);

// The 4 golden pairs, all owned by the user (exact roster pairs).
const ROSTER_EXACT = Object.freeze({
  'ROC5|AUVTE': USER, 'AVP40|AGNLI': USER, 'EOFE01|EOFE': USER, 'AVP40|YTSC': USER,
});

// A down unit: no ETC anywhere (no notes / timeline / extracted facts).
function down(id, domicile, scac, o) {
  return {
    equipmentId: id, domicileSite: domicile, operator: scac, lifecycleState: 'Unavailable',
    lifecycleReason: o.lifecycleReason || '', vendor: o.vendor || '', savedRepairStatus: o.status || '',
    workDuration: o.days + 'd 4h 0m', issueSummary: o.issue, partsStatus: o.partsStatus || '',
    savedNotes: '', repairTimeline: '', asistNotes: '',
  };
}
// n up rows of one pair (pad for the golden uptimes).
function up(domicile, scac, n, from = 1) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ equipmentId: 'U-' + domicile + '-' + scac + '-' + String(from + i).padStart(2, '0'), domicileSite: domicile, operator: scac, lifecycleState: 'Available' });
  }
  return out;
}

module.exports = { USER, GOLDEN_HEADERS, ROSTER_EXACT, down, up };
