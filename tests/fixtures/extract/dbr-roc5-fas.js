// ROC5|AUVTE-shaped 10-unit DBR pair (live snapshot review, output fix B). Names masked.
// R0001: the FAS logged an action in fleet_notes (notesStore.manualEntries), classified [FAS].
// R0002: a FAS-authored Relay conversation line (identity match on the FAS name).
// R0003: only an [em:]-marked email-intel write (-> [email], never [FAS]).
// R0004: vendor / dealer evidence only (EGR cooler, ETC 11/08 missed).
// R0005..R0010: vendor-only filler units. opts.filler adds long vendor text so allocate trims.
'use strict';

const TODAY = '2026-11-11';
const FAS_NAMES = ['Z Santiago'];
const IDS = ['R0001', 'R0002', 'R0003', 'R0004', 'R0005', 'R0006', 'R0007', 'R0008', 'R0009', 'R0010'];

function _vendorText(n) {
  const out = [];
  for (let k = 0, len = 0; len < n; k++) {
    const l = '10/' + (1 + (k % 28)) + ' - TA Rochester: status check ' + k + ', unit in bay, waiting on diagnosis update from the shop';
    out.push(l);
    len += l.length + 1;
  }
  return out.join('\n');
}

function build(opts = {}) {
  const pad = opts.filler ? _vendorText(opts.filler) + '\n' : '';
  const base = { domicileSite: 'ROC5', operator: 'AUVTE', lifecycleState: 'Unavailable', vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor' };
  const rows = IDS.map((id) => Object.assign({}, base, { equipmentId: id, repairTimeline: pad + '11/09 - TA Rochester: waiting on parts' }));
  rows[1].fullConversation = 'Conversation\n11/09 - Z Santiago: emailed TA service desk for a status update\n11/08 - TA Desk: tech assigned';
  rows[3] = Object.assign(rows[3], { vendor: 'Volvo (ASIST)', lifecycleReason: 'Offsite Shop Repair',
    repairTimeline: pad + '11/05 - Dealer: EGR cooler on order, ETC 11/08\n11/11 - Dealer: still waiting on EGR cooler, ETC 11/08 passed' });
  const enrich = {
    R0001: { manualEntries: ['11/10 - Called TA, tech ETA 11/12'] },
    R0003: { manualEntries: ['11/10 - TA confirmed bay for 11/13 [em:1a2b3c4d]'] },
  };
  return { rows, enrich, TODAY, FAS_NAMES, IDS };
}

module.exports = { TODAY, FAS_NAMES, IDS, build };
