// Inputs for the flag-off DBR golden prompts (tests/fixtures/extract/dbr-golden-prompts.js,
// captured from 1eabe04). Two down units, vendor timeline lines and [logged] manual entries only:
// no asistNotes, no FAS-authored line, no fact blocks, so D1/D2/D3/D6 do not apply.
'use strict';

const TODAY = '2026-11-11';

function goldenInput(F, makeUnit) {
  const rows = [
    makeUnit({ equipmentId: 'G10001', vendor: 'TA Rochester', savedRepairStatus: 'Waiting for vendor',
      repairTimeline: '11/08 - TA Rochester: unit in bay, waiting on diagnosis\n11/10 - TA Rochester: no diesel tech available, ETC 11/14' }),
    makeUnit({ equipmentId: 'G10002', vendor: 'Volvo (ASIST)', lifecycleReason: 'Offsite Shop Repair', savedRepairStatus: 'Under diagnosis',
      repairTimeline: '11/09 - Dealer: harness on backorder, parts ETA 11/16' }),
  ];
  const built = F.buildFleetDbr(rows, { today: TODAY });
  const row = built.rows.find((r) => r.key === 'TST1|TSCA');
  const enrich = {
    G10001: { manualEntries: ['11/09 - Unit still at TA, tech shortage reported'] },
    G10002: { manualEntries: ['11/10 - Dealer status unchanged'] },
  };
  const args = { row, unitRows: rows, built, enrich, fasNames: [], fasAlias: '', fleetIds: [], today: TODAY };
  return { args, ids: ['G10001', 'G10002'], rows, row };
}

function goldenAnswer(ids) {
  const N = { yn: 'N', details: [] };
  return {
    barriers: {
      vendor1p: { yn: 'Y', details: [{ units: [ids[0]], text: 'TA Rochester: no diesel tech available, ETC 11/14.' }] },
      oem: N, estimate: N, partner: N,
      parts: { yn: 'Y', details: [{ units: [ids[1]], text: 'Harness on backorder at the dealer, parts ETA 11/16.' }] },
      common: N,
    },
    etc: [{ unit: ids[0], state: 'future', date: '11/14', why: '' }, { unit: ids[1], state: 'none', date: '', why: '' }],
    fasActions: [
      { unit: ids[0], text: 'No FAS action logged; TA update 11/10: no diesel tech available; next: call TA for a tech.' },
      { unit: ids[1], text: 'No FAS action logged; Dealer update 11/09: harness on backorder; next: ask dealer for a ship date.' },
    ],
    support: 'None',
  };
}

// The two 1eabe04 strings D7 replaces unconditionally (design §14.6 D7 / §14.7: flag off = today
// + bug fixes + D1, D6, D7). The golden comparison substitutes exactly these, nothing else.
const D7_OLD = Object.freeze({
  fasRule: '- FAS Actions entry: ";"-separated clauses. First the dated FAS actions with outcome, "M/D <action>", each in src.fas; with no [FAS] line start "No FAS action logged;" and the status. Then "<party> update M/D: <event>" facts. Last "next: <next step>". Name parts, ETAs, dealer/vendor and ASIST/RO/WR/case refs when present.',
  b61004: 'No FAS action logged; Dealer update 11/11: waiting on EGR cooler, ETC 11/08 missed; next: call dealer for a new ETC.',
});

module.exports = { TODAY, goldenInput, goldenAnswer, D7_OLD };
