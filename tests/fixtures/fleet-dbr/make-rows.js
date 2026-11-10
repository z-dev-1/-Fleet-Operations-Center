// Synthetic fleet fixture for the Fleet DBR builder tests (no real fleet data).
// 21 (domicile|SCAC) pairs, 252 units, 53 down — the shape measured in findings §3,
// with IDs T0001… and empty barrier/ETC fields. Down units come first in each pair.
'use strict';

// [domicile, scac, down, total]
const PAIRS = Object.freeze([
  ['ABE40', 'TUZR', 5, 44], ['ABE40', 'SAPB', 9, 32], ['ABE40', 'AZNG', 0, 1], ['ABE40', 'AGNLI', 1, 1],
  ['EOFE01', 'EOFE', 2, 11], ['EOFE01', 'AZNG', 0, 1],
  ['MIMY01', 'MIMY', 3, 12], ['MIMY01', 'YTSC', 0, 2],
  ['AVP40', 'YTSC', 3, 15], ['AVP40', 'AGNLI', 3, 7], ['AVP40', 'AZNG', 2, 20],
  ['HBD1', 'AKJJI', 3, 10],
  ['SHIL01', 'SHIL', 1, 12], ['SHIL01', 'AZNG', 1, 2], ['SHIL01', 'UNNE', 0, 2],
  ['UNNE01', 'UNNE', 0, 11],
  ['BUF', 'AZNG', 0, 4],
  ['EWR45', 'SAPB', 3, 9],
  ['PHL40', 'TUZR', 2, 26], ['EWR40', 'TUZR', 0, 1],
  ['ROC5', 'AUVTE', 15, 29],
].map(Object.freeze));

const EMPTY_FIELDS = Object.freeze({
  lifecycleReason: '', vendor: '', savedRepairStatus: '', serviceState: '', subState: '',
  canonicalAvailability: '', canonicalSituation: '', canonicalNextStep: '', canonicalWaitingOn: '',
  delayReasonCodes: '', offsiteStage: '', offsiteStageDetail: '', escalations: '',
  estimatePendingCost: '', savedNotes: '', repairTimeline: '', asistNotes: '',
  issueSummary: '', issueDetails: '', workDuration: '',
});

function makeUnit(fields = {}) {
  return Object.assign({
    equipmentId: 'X0001', domicileSite: 'TST1', operator: 'TSCA', lifecycleState: 'Unavailable',
  }, EMPTY_FIELDS, fields);
}

// overrides: { [equipmentId]: fields } merged into that generated unit.
function makeFleetRows(overrides = {}) {
  const rows = [];
  let n = 0;
  for (const [domicile, scac, down, total] of PAIRS) {
    for (let i = 0; i < total; i++) {
      n += 1;
      const id = 'T' + String(n).padStart(4, '0');
      const lifecycleState = i < down ? 'Unavailable' : ((i - down) % 2 === 0 ? 'Active' : 'Ordered');
      rows.push(Object.assign(
        { equipmentId: id, domicileSite: domicile, operator: scac, lifecycleState },
        EMPTY_FIELDS,
        overrides[id] || {},
      ));
    }
  }
  return rows;
}

// IDs of the down units of one pair, in generation order.
function downIdsOf(rows, domicile, scac) {
  return rows
    .filter((r) => r.domicileSite === domicile && r.operator === scac && r.lifecycleState === 'Unavailable')
    .map((r) => r.equipmentId);
}

module.exports = { PAIRS, EMPTY_FIELDS, makeUnit, makeFleetRows, downIdsOf };
