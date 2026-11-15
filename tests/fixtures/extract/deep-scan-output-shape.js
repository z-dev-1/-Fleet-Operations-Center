// tests/fixtures/extract/deep-scan-output-shape.js — relay-extract AC17: a 39582 unit row as the
// deep-scan timeline builder reads it (Relay + Decisiv fact blocks from the FEAT-001 fixtures, a
// primary / planned / secondary conversation, a 27-entry dealer stage history with a June prior
// episode) and a real deep-scan output shape (gap ranges, [Planned]/[Unplanned] prefixes, a 7b
// baseline line dated from WO Created, an evening comment dated by its local day, the trim marker).
import { blocks, sourceText } from './fact-39582.js';

export const NOW = Date.parse('2026-11-11T15:00:00Z');   // 11/11 10:00 America/New_York

export const KWNE_LINE = '11/02 - KWNE: still waiting on correct pins for harness- hoping for them to be here by thurs';
// 2026-11-04T01:30Z is 11/03 9:30 PM in New York: the scraped thread shows the local day.
export const EVENING_LINE = '11/03/2026 9:30 PM EST - TA Tech: unit in bay, diagnosis started';

export const CONV = 'Conversation\n' + sourceText + '\n' + KWNE_LINE + '\n' + EVENING_LINE;
export const PLANNED = 'Conversation\n10/29/2026 - Amerit: PM B service scheduled for the unit';
export const SECONDARY = 'Conversation\n11/04/2026 - TA: replaced hood latch on the secondary work order';

// 27 dealer case-status entries: 6 in June (prior episode), then 21 from 09/23 to 11/02 with the
// stage changes 09/23 arrival -> 10/01 diagnosis -> 10/11 approval -> 11/02 repair (Waiting).
export function stageHistory() {
  const out = [];
  for (let i = 0; i < 6; i++) out.push({ stage: i % 2 ? 'diagnosis' : 'arrival', status: 'Working', at: new Date(Date.UTC(2026, 5, 20 + i, 14)).toISOString() });
  for (let i = 0; i <= 20; i++) {
    const stage = i <= 3 ? 'arrival' : i <= 8 ? 'diagnosis' : i <= 19 ? 'approval' : 'repair';
    out.push({ stage, status: i === 20 ? 'Waiting' : 'Working', at: new Date(Date.UTC(2026, 8, 23 + 2 * i, 14)).toISOString() });
  }
  return out;
}

export function unitRow(extra = {}) {
  return Object.assign({
    equipmentId: '39582', lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', vendor: 'Volvo (ASIST)',
    domicileSite: 'TST1', created: '09/23/2026', serviceState: 'Open', workRequestId: 'wr-39582',
    fullConversation: CONV,
    _plannedWRData: { vendor: 'Amerit', fullConversation: PLANNED },
    _secondaryWRs: [{ vendor: 'TA', fullConversation: SECONDARY }],
    offsiteStageHistory: stageHistory(),
  }, blocks(), extra);
}

// A real deep-scan output shape: every line is grounded in the row above.
export const SHAPE_LINES = [
  '(earlier history trimmed)',
  '06/13-06/17 - [no update logged]',
  '09/23 - Work order created with Volvo for harness repair. Unit waiting for vendor.',
  '10/29 - [Planned] PM B service scheduled.',
  '10/30-11/03 - Awaiting vendor update.',
  '11/02 - Vendor hoping for the pins by thurs.',
  '11/03 - [Unplanned] Unit in bay; diagnosis started.',
  '11/04 - [Unplanned #2] Secondary vendor replaced the hood latch.',
];

export function draftText(lines, issue = 'Wiring harness failure') {
  return 'REPAIR_STATUS: Parts received\nPRIMARY_COMPONENT: ELECTRICAL\nISSUE: ' + issue + '\nTIMELINE:\n' + lines.join('\n');
}

export function reviewText(lines, issue = 'Wiring harness failure') {
  return [
    'QA:',
    'Q-GEN-1 | candidates: nothing invented / a date is invented | best: nothing invented [F1]',
    'Q-SELF-1: Is the newest dealer stage visible? | candidates: yes / no | best: yes, repair waiting since 11/02',
    'FINAL:',
    'ISSUE: ' + issue,
    'TIMELINE:',
  ].concat(lines).join('\n');
}
