// tests/fixtures/timeline-summary-fixture.js — a long-running offsite repair (TS9001, Volvo at
// M&K Dunmore, down 56 days) for the timeline content fixes (FEAT-001) and the timeline digest
// (FEAT-002). LONG_TIMELINE carries every important-data class plus the meta lines the cleaner
// must remove (plain gap, "Next:", CONFLICT, PM-overdue) and the $ / name / email attribution
// the sharing redaction must remove.
export const NOW = Date.parse('2026-11-18T15:00:00Z');
export const UNIT_ID = 'TS9001';
export const CREATED = '2026-09-23T13:00:00Z';

export const CONV = [
  'Conversation',
  '09/23/2026 - Volvo: work order created for air leak',
  '09/29/2026 - M&K Dunmore: diagnosis complete, failed air dryer',
  '10/16/2026 - M&K Dunmore: parts arrived, air dryer on hand',
  '10/19/2026 - M&K Dunmore: install started, ETC 10/21',
].join('\n');

// 2026-10-20 00:36 UTC is 10/19 evening in America/New_York.
export const ASIST_NOTES = '2026-10-20 00:36 - Dealer: tech assigned to air dryer install\n2026-10-04 13:10 - Dealer: parts ordered, ETA 10/12';

export function stageHistory() {
  const out = [];
  for (let i = 0; i < 4; i++) out.push({ stage: i % 2 ? 'diagnosis' : 'arrival', status: 'Working', at: new Date(Date.UTC(2026, 5, 14 + i, 14)).toISOString() });
  out.push({ stage: 'arrival', status: 'Working', at: '2026-09-23T14:00:00.000Z' });
  out.push({ stage: 'diagnosis', status: 'Working', at: '2026-09-29T14:00:00.000Z' });
  out.push({ stage: 'approval', status: 'Working', at: '2026-10-03T14:00:00.000Z' });
  out.push({ stage: 'repair', status: 'Working', at: '2026-10-16T14:00:00.000Z' });
  out.push({ stage: 'ready', status: 'Ready', at: '2026-11-17T14:00:00.000Z' });
  return out;
}

export const ROW = Object.freeze({
  equipmentId: UNIT_ID, vendor: 'Volvo', dealerName: 'M&K Dunmore', salesforceCase: '08812345',
  workRequestId: 'svc-ts9001', created: CREATED, workDuration: '56 days',
  lifecycleState: 'Unavailable', lifecycleReason: 'Offsite Shop Repair', domicileSite: 'TST1', serviceState: 'Open',
  fullConversation: CONV, asistNotes: ASIST_NOTES, offsiteStageHistory: stageHistory(),
});
export function row(extra = {}) {
  return Object.assign(JSON.parse(JSON.stringify(ROW)), extra);
}

// The previous WR's timeline (still stored when the new WR's first build runs).
export const PREV_TIMELINE = [
  '06/15 - Unit checked in at M&K Dunmore (ASIST case 975426).',
  '08/31 - Dealer: parts ordered for air dryer; awaiting arrival.',
].join('\n');

export const LONG_TIMELINE_LINES = [
  '09/23 - Work order created with Volvo (ASIST case 975426) for air leak; status Waiting for vendor.',
  '09/25 - Unit towed to M&K Dunmore.',
  '09/29 - Diagnosis: failed air dryer; status changed to Under diagnosis.',
  '10/02 - Christy Adriaansen - M&K Dunmore (Service Advisor) submitted estimate V1 $4,210.30; internal approval pending.',
  '10/03 - Estimate V1 approved.',
  '10/04 - Parts ordered: air dryer; parts ETA 10/12.',
  '10/10-10/14 - No update logged.',
  '10/15 - Escalated to Uptime team for parts delay.',
  '10/16 - Parts arrived at M&K Dunmore.',
  '10/18 - Dealer set ETC 10/21.',
  '10/22 - ETC missed; dealer revised ETC 10/24 (per Santiago, Z email 10/22).',
  '10/23 - Next: chase dealer for revised ETC.',
  '10/24 - CONFLICT: ETR 10/24 vs 10/26 per internal log.',
  '10/25 - PM A is 311 days overdue; recommend scheduling.',
  '11/17 - Repair completed; unit ready for pickup; down 56 days.',
];
export const LONG_TIMELINE = LONG_TIMELINE_LINES.join('\n');

// Stored manual entries: one real coordinator line, one status-check meta paragraph.
export const MANUAL_ENTRIES = Object.freeze([
  '10/19 - Called M&K Dunmore; air dryer install in progress.',
  '11/05 - (AI unavailable) Scheduled Next: follow up with dealer on ETC.',
]);

// Substrings the digest (FEAT-002) must keep: every important-data class in LONG_TIMELINE.
export const IMPORTANT = Object.freeze([
  'ASIST case 975426', 'M&K Dunmore', 'air dryer', 'Estimate V1 approved', 'ETA 10/12',
  'Escalated to Uptime', 'ETC 10/24', 'ready for pickup', '56 days',
]);

export function draftText(lines, issue = 'Air leak from failed air dryer') {
  return 'REPAIR_STATUS: Ready for pickup\nPRIMARY_COMPONENT: CHASSIS\nISSUE: ' + issue + '\nTIMELINE:\n' + lines.join('\n');
}
