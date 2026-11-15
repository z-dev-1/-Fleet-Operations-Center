// tests/fixtures/extract/dtna-122269.js — DTNA Service Tracker feed (parseFeed output
// shape: "<Month D, YYYY> — <actor>: <text>", newest-first, actor suffixes stripped) plus
// the matching Relay thread. Serial / unit ids from findings §(b); names masked.
export const feed = [
  'October 27, 2026 — AFP FAS: made ro, printed docs 10/27/26 8:15am requested additional 3 hrs of diag approval',
  'October 26, 2026 — ROSync API: closed this case as Closed (Post-Repair to Closed)',
  'October 24, 2026 — CRM Admin: Case reviewed by dealer support',
  'October 23, 2026 — Horwith Advisor: Unit received, diag to start',
  'October 23, 2026 — E2E Geofence API User: Serial No: NP6923 (Unit Id: 122269) has entered HORWITH FREIGHTLINER in NORTHAMPTON, PA at 10/23/2026 03:37 AM PDT',
].join('\n');

const c = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });
export const relay122269 = {
  id: 'svc-122269',
  workOrders: [],
  workRequest: {
    id: 'wr-122269', createdBy: 'fasuser9', createdDateTime: Date.parse('2026-10-22T12:00:00Z'), alternateUniqueId: 'amz-122269altid00001',
    comments: [c('2026-10-23T15:00:00Z', 'fasuser9', 'Salesforce Case #00034630, created to track potential carrier pickup')],
  },
};

// Long feed: real-shaped ROSync / AFP FAS items newest-first, padded past 9000 chars;
// the enter item stays last (oldest).
export function longFeed() {
  const lines = feed.split('\n');
  const enter = lines.pop();
  const pad = [];
  for (let i = 0; pad.join('\n').length < 9200; i++) {
    pad.push('October 25, 2026 — ' + (i % 2 ? 'ROSync API' : 'AFP FAS') + ': Status sync ' + i + ' — repair order updated, awaiting technician assignment and parts confirmation from the dealer parts counter');
  }
  return [lines[0], lines[1]].concat(pad, lines.slice(2), [enter]).join('\n');
}
