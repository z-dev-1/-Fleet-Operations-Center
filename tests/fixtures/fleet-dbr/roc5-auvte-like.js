// ROC5|AUVTE-shaped synthetic pair (design AC8): 14 down units with IDs B901xx (no real data),
// vendors Volvo (ASIST), KWNE, COX ("Cannot Complete — Parts Ordered"), TA, Amerit, DSP_ENTERED
// and CEI; timelines up to ~5k chars, conversations with RO numbers and FAS-authored lines,
// ASIST notes and enrich docs (canonical, manual entries incl. one [em:…], email evidence).
// ANSWER(...) builds a realistic mocked AI answer for any call kind, including planted
// fabrications that the gate must remove (PLANTED lists the tokens that must not reach a cell).
'use strict';

const { makeUnit } = require('./make-rows');

const TODAY = '2026-11-12';
const DOMICILE = 'ROC9';
const SCAC = 'AUVX';
const KEY = DOMICILE + '|' + SCAC;
const FAS_NAMES = ['Pat Example'];
const FAS_ALIAS = 'pexamp';
const FLEET_IDS = ['B97777'];

// [id, vendor, short, lifecycle, status, timeline chars, etc: [state, M/D] | null]
const SPEC = [
  ['B90101', 'Volvo', 'Volvo', 'Offsite Shop Repair', 'Under diagnosis', 5000, null],
  ['B90102', 'KWNE', 'KWNE', 'Offsite Shop Repair', 'Waiting for vendor', 4500, ['future', '11/14']],
  ['B90103', 'COX', 'COX', 'Offsite Shop Repair', 'Cannot Complete \u2014 Parts Ordered', 5000, ['missed', '11/08']],
  ['B90104', 'TA', 'TA', 'Onsite Repair', 'Waiting for tech', 1600, ['today', '11/12']],
  ['B90105', 'Amerit', 'Amerit', 'Onsite Repair', 'In progress', 1600, ['missed', '11/09']],
  ['B90106', 'DSP_ENTERED', 'DSP', 'Accident', 'Awaiting release', 1400, null],
  ['B90107', 'CEI', 'CEI', 'Accident', 'Claim open', 1400, null],
  ['B90108', 'Volvo', 'Volvo', 'Offsite Shop Repair', 'In progress', 1600, ['future', '11/15']],
  ['B90109', 'KWNE', 'KWNE', 'Offsite Shop Repair', 'Waiting for vendor', 1500, null],
  ['B90110', 'COX', 'COX', 'Offsite Shop Repair', 'In progress', 1500, ['future', '11/13']],
  ['B90111', 'TA', 'TA', 'Onsite Repair', 'Waiting for tech', 1500, null],
  ['B90112', 'Amerit', 'Amerit', 'Onsite Repair', 'In progress', 1500, ['missed', '11/10']],
  ['B90113', 'Volvo', 'Volvo', 'Offsite Shop Repair', 'Under diagnosis', 1500, null],
  ['B90114', 'CEI', 'CEI', 'Accident', 'Claim open', 1400, null],
];
const SHORT = Object.fromEntries(SPEC.map((s) => [s[0], s[2]]));

function _timeline(id, vendor, chars, etc, k) {
  const head = [];
  head.push('10/28 - ' + vendor + ': unit dropped at shop for repair');
  if (etc) head.push('11/05 - ' + vendor + ': ETC ' + etc[1]);
  head.push('11/11 - ' + vendor + ': ' + (etc && etc[0] === 'missed' ? 'still waiting on parts' : 'repair in progress, update ' + id));
  const fill = [];
  let len = head.join('\n').length;
  for (let i = 0; len < chars; i++) {
    const l = '10/' + (1 + ((i + k) % 26)) + ' - ' + vendor + ' status check ' + i + ': unit in bay, waiting on diagnosis update';
    fill.push(l);
    len += l.length + 1;
  }
  return fill.concat(head).join('\n');
}

function rows() {
  return SPEC.map(([id, vendor, short, lifecycle, status, chars, etc], k) => makeUnit({
    equipmentId: id, domicileSite: DOMICILE, operator: SCAC, lifecycleState: 'Unavailable',
    vendor, lifecycleReason: lifecycle, savedRepairStatus: status,
    repairTimeline: _timeline(id, vendor, chars, etc, k),
    fullConversation: 'Conversation\n10/30 - techdesk: unit checked in, RO ' + (448100 + k + 1) + ' opened\n11/11 - ' + FAS_ALIAS + ': called ' + short + ' for status ' + id + ', tech assigned',
    asistNotes: vendor === 'Volvo' ? 'ASIST case ' + (7712000 + k + 1) + ' open; RO ' + (448100 + k + 1) + ' under diagnosis' : '',
  }));
}
// Plus 10 up units so the pair has a total.
function upRows() {
  return Array.from({ length: 10 }, (_, i) => makeUnit({ equipmentId: 'B902' + String(10 + i), domicileSite: DOMICILE, operator: SCAC, lifecycleState: 'Active' }));
}

function enrich() {
  const out = {};
  for (const [id, vendor, short] of SPEC) {
    out[id] = {
      canonical: { situation: 'Unit at ' + vendor, nextStep: 'Follow up with vendor' },
      manualEntries: ['11/10 - called ' + short + ' re repair status'],
      email: [],
    };
  }
  out.B90102.manualEntries.push('11/09 - KWNE update: estimate in review [em:1a2b3c4d]');
  out.B90111.email.push({ observedAt: '2026-11-10T14:00:00Z', informationType: 'status', field: 'repair', value: 'dealer called re parts ETA', sender: 'Dealer Desk' });
  return out;
}

// Newest timeline line and newest conversation body per unit (AC8 prompt check).
const NEWEST = Object.fromEntries(SPEC.map(([id, vendor, short, , , , etc]) => [id, {
  timeline: '11/11 - ' + vendor + ': ' + (etc && etc[0] === 'missed' ? 'still waiting on parts' : 'repair in progress, update ' + id),
  conversation: 'called ' + short + ' for status ' + id + ', tech assigned',
}]));

const PLANTED = ['service manager', 'called dealer re parts', 'Volvo regional', 'Thursday', '4,800', '559911', 'B98888', 'B97777', 'slipped'];
const PLANTED_FAS_UNITS = ['B90109', 'B90111', 'B90113'];

const src = (id) => ({ fas: [{ date: '11/10', quote: 'called ' + SHORT[id] + ' re repair status' }] });
function fasEntry(id) {
  if (id === 'B90109') return { unit: id, text: 'Called KWNE and escalated to the service manager; next: confirm tech', src: {} };
  if (id === 'B90111') return { unit: id, text: 'FAS update 11/10: called dealer re parts, confirmed parts ETA 11/14' };
  if (id === 'B90113') return { unit: id, text: 'No FAS action logged; unit at Volvo dealer; next: escalated to Volvo regional 11/21' };
  return { unit: id, text: '11/10 called ' + SHORT[id] + ' re repair status; next: confirm repair plan with ' + SHORT[id], src: src(id) };
}
function etcEntry(id) {
  const s = SPEC.find((x) => x[0] === id)[6];
  if (!s) return { unit: id, state: 'none', date: '', why: '' };
  if (id === 'B90105') return { unit: id, state: 'missed', date: '11/09', why: 'Amerit update 11/11: ETC 11/20 slipped' };
  if (s[0] === 'missed') return { unit: id, state: 'missed', date: s[1], why: SPEC.find((x) => x[0] === id)[1] + ' update 11/11: still waiting on parts; ETC ' + s[1] + ' passed.' };
  return { unit: id, state: s[0], date: s[1], why: '' };
}
// barrier -> [{units, text, valid}]
const DETAILS = {
  vendor1p: [
    { units: ['B90104'], text: 'TA: no tech available until 11/12, unit waiting in bay', valid: true },
    { units: ['B90104'], text: 'TA opened RO 559911 for the tech callout' },
  ],
  oem: [
    { units: ['B90101'], text: 'Volvo dealer has given no status since drop-off 10/28; ASIST case 7712001 open, RO 448101 under diagnosis', valid: true },
    { units: ['B90101'], text: 'Volvo estimate of $4,800 pending at the dealer' },
  ],
  parts: [
    { units: ['B90103'], text: 'Turbo on order at COX; status shows parts ordered', valid: true },
    { units: ['B90103'], text: 'Turbo actuator back-ordered, parts arriving Thursday' },
  ],
  partner: [
    { units: ['B90106'], text: 'Accident unit: DSP has not released the unit for repair', valid: true },
    { units: ['B90107'], text: 'Accident unit: CEI claim open, carrier has not released the unit', valid: true },
    { units: ['B90107'], text: 'CEI claim also covers B98888' },
    { units: ['B90106'], text: 'Carrier shares the claim with B97777' },
  ],
};
const N = () => ({ yn: 'N', details: [] });
function barriers() {
  const out = { estimate: N(), common: N() };
  for (const [b, list] of Object.entries(DETAILS)) out[b] = { yn: 'Y', details: list.map(({ units, text }) => ({ units, text })) };
  return out;
}
const SUPPORT = [{ team: 'MCS', ask: 'MCS approval on the B90101 estimate', units: ['B90101'] }];

// One mocked answer per call kind. ids: the DOWN UNITS of that prompt.
function ANSWER(kind, ids) {
  if (kind === 'map') {
    return {
      units: ids.map((id) => {
        const bs = {};
        for (const [b, list] of Object.entries(DETAILS)) {
          const v = list.find((e) => e.valid && e.units.includes(id));
          if (v) bs[b] = { hit: true, fact: v.text };
        }
        const e = etcEntry(id);
        const f = fasEntry(id);
        return { unit: id, component: 'Repair', barriers: bs, etc: { state: e.state, date: e.date, why: e.why }, fasAction: { text: f.text, src: f.src }, support: [] };
      }),
    };
  }
  if (kind === 'reduce') return { barriers: barriers(), support: SUPPORT, domicileDown: '99' };
  if (kind === 'review-mr') return { barriers: barriers(), support: SUPPORT, fasActions: ids.filter((id) => PLANTED_FAS_UNITS.includes(id)).map(fasEntry) };
  return { barriers: barriers(), etc: ids.map(etcEntry), fasActions: ids.map(fasEntry), support: SUPPORT, domicileDown: '99', scacUptime: '1%' };
}

module.exports = { TODAY, KEY, FAS_NAMES, FAS_ALIAS, FLEET_IDS, SPEC, NEWEST, PLANTED, PLANTED_FAS_UNITS, rows, upRows, enrich, ANSWER };
