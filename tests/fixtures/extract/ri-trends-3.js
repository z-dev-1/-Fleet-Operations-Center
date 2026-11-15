// tests/fixtures/extract/ri-trends-3.js — relay-extract AC31: three repair-intel events (39582
// Volvo ASIST dealer WO, IND260261 TA estimate chain, B62281 PACCAR dealer WO) whose
// extracted_facts are the real wo-facts.digestForRi of the FEAT-001 fixtures, with parts and
// offsite_dwell written through the real store setters. Plus one synthetic TA WO whose thread
// explicitly revises a past repair ETC (the only kind of miss the counted cells count, Path B).
import { createRequire } from 'module';
import * as V from './relay-vendors.js';
import * as P from './b62281-paccar.js';
import { blocks } from './fact-39582.js';
import { stageHistory } from './deep-scan-output-shape.js';
const require = createRequire(import.meta.url);
const X = require('../../../src/repair-intel/wo-extract');
const W = require('../../../src/repair-intel/wo-facts');

export const TODAY = '2026-11-11';
export const NOW = Date.parse('2026-11-11T15:00:00Z');
const DAY = 864e5;

// B62281 dealer stage history: checked in 11/04, approval 11/05, repair 11/06.
export const HIST_B62281 = [
  { stage: 'arrival', status: 'Checked-in', at: '2026-11-04T14:00:00.000Z' },
  { stage: 'approval', status: 'Waiting', at: '2026-11-05T14:00:00.000Z' },
  { stage: 'repair', status: 'Working', at: '2026-11-06T14:00:00.000Z' },
];

const c = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });
export const relayTaRevised = {
  id: 'svc-T9', workOrders: [], workOrderLineItems: [],
  workRequest: { id: 'wr-T9', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-11-01T12:00:00Z'), comments: [
    c('2026-11-05T15:00:00Z', 'fasuser1', 'ETC 11/07'),
    c('2026-11-09T15:00:00Z', 'fasuser1', 'ETC revised from 11/07 to 11/14'),
  ] },
};

const agg = (sid, unit, vendor, createdIso, extra) => Object.assign({
  workRequestId: sid, assetDisplayName: unit, vendor, category: 'Unplanned Repair',
  status: { description: { value: 'OPEN' } }, suggestedItems: [{ level1: 'Electrical', level2: 'Harness' }],
  damageDescription: 'issue ' + unit, reportedDateTime: createdIso, createdDateTime: createdIso, lastModifiedDateTime: '2026-11-10T00:00:00Z',
}, extra || {});

export function specs() {
  const b39582 = blocks();
  return [
    { sid: 'S39582', unit: '39582', wo: agg('S39582', '39582', 'Volvo (ASIST)', '2026-09-23T18:04:00Z'),
      row: { relayFacts: b39582.relayFacts, offsiteFacts: b39582.offsiteFacts, created: '2026-09-23T18:04:00Z' }, history: stageHistory() },
    { sid: 'SIND', unit: 'IND260261', wo: agg('SIND', 'IND260261', 'TA', '2026-10-28T12:00:00Z'),
      row: { relayFacts: X.extractRelay(V.relayIND260261, { now: NOW, vendor: 'TA' }), created: '2026-10-28T12:00:00Z' }, history: null },
    { sid: 'SB62281', unit: 'B62281', wo: agg('SB62281', 'B62281', 'PACCAR', '2026-11-03T13:00:00Z'),
      row: { relayFacts: X.extractRelay(P.relayB62281, { now: NOW }),
        offsiteFacts: X.extractDecisivNotes(P.notesB62281, { estimateId: '21520684', estimateDetail: P.estimateDetailB62281, now: NOW }),
        created: '2026-11-03T13:00:00Z' }, history: HIST_B62281 },
  ];
}
export function revisedSpec() {
  return { sid: 'ST9', unit: 'T9', wo: agg('ST9', 'T9', 'TA', '2026-11-01T12:00:00Z'),
    row: { relayFacts: X.extractRelay(relayTaRevised, { now: NOW }), created: '2026-11-01T12:00:00Z' }, history: null };
}

// Insert each spec through the real store: event row, digest, parts, dealer dwell.
export function seed(store, list) {
  const out = {};
  for (const s of list) {
    store.upsertEvent(store.normalizeWorkOrder(s.wo));
    const fs = W.buildFactSet(s.row, { today: TODAY });
    store.setExtractedFacts(s.sid, W.digestForRi(fs));
    store.setPartsForSource(s.sid, s.unit, fs.parts);
    let dwell = null;
    if (s.history) {
      dwell = W.stageDwell(s.history, { now: NOW, since: Date.parse(s.wo.createdDateTime) - 3 * DAY });
      store.setOffsiteDwell(s.sid, dwell, null);
    }
    out[s.sid] = { fs, dwell };
  }
  return out;
}
