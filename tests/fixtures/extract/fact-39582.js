// 39582 fact set + sheet + prompt source text for the gate / review / DBR tests (today 2026-11-11).
// Built from the FEAT-001 fixtures through the real extractor (no hand-written facts).
import { createRequire } from 'module';
import * as R from './relay-39582-volvo.js';
import * as N from './decisiv-39582-notes.js';
import { estimateDetail } from './estimate-detail-39582.js';
const require = createRequire(import.meta.url);
const X = require('../../../src/repair-intel/wo-extract');
const W = require('../../../src/repair-intel/wo-facts');

export const TODAY = '2026-11-11';
export const NOW = Date.parse('2026-11-11T15:00:00Z');
export function blocks() {
  const relayFacts = X.extractRelay(R.serviceDetail, { now: NOW });
  const offsiteFacts = X.extractDecisivNotes(N.allNotes, { estimateId: '20945735', estimateDetail, wrCreatedAt: N.WR_CREATED_AT, now: NOW, pages: 3 });
  return { relayFacts, offsiteFacts };
}
// A fleet row as refreshRowFacts leaves it (flags on), so _factsOn / _factEtc / mirrors are set.
export function row39582(extra = {}) {
  const r = Object.assign({ equipmentId: '39582', domicileSite: 'TST1', operator: 'TSCA', lifecycleState: 'Unavailable',
    vendor: 'Volvo (ASIST)', lifecycleReason: 'Offsite Shop Repair', savedRepairStatus: 'Waiting for vendor',
    repairTimeline: '11/09 - Dealer started repairs, waiting on ETR from Uptime' }, blocks(), extra);
  W.refreshRowFacts(r, { enabled: true, aiOutput: true }, TODAY);
  return r;
}
// The Relay comments as one prompt text (what a consumer's SOURCE DATA would carry).
export const sourceText = R.comments.map((c) => c.timestamp.slice(5, 10).replace('-', '/') + ' - ' + c.createdBy + ': ' + c.text).join('\n');
