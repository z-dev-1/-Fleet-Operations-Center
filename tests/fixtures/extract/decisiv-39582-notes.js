// tests/fixtures/extract/decisiv-39582-notes.js — Decisiv activity_logs for estimate
// 20945735 (WO 39582), 3 pages (50 / 50 / 8) newest-first as served. Shapes from
// shape-probe/39582.activity_logs_p*.json (created_at 'MM/DD/YY hh:mm am EST',
// from.groupId -1 dealer / -2 amazon / -3 oem, job_role, recipients). Names, emails and
// phones are masked. Long Uptime status notes pad the 09/28 dealer note past the
// 6000-char formatted cap; 8 June notes are a prior episode.
const DEALER_LOC = 'M & K Truck Centers - Dunmore, PA (Volvo)';
const from = {
  dealer: { groupId: -1, name: 'Dealer Advisor', location: DEALER_LOC, job_role: 'service_advisor' },
  amazon: { groupId: -2, name: 'Amazon Fas', location: 'Amazon Bos3', job_role: 'fleet_support' },
  uptime: { groupId: -3, name: 'Uptime Agent', location: 'Originator: Uptime', job_role: 'customer_service_representative' },
};
const rcpt = [
  { groupId: -1, name: 'Dealer Advisor', location: DEALER_LOC, job_role: 'service_advisor' },
  { groupId: -2, name: 'Amazon Fas', location: 'Amazon Bos3', job_role: '' },
];
let _id = 164100000;
const note = (created_at, who, subject, message, extra = {}) => Object.assign({
  id: ++_id, from: from[who], recipients: rcpt, system_generated: false, platform_generated: false,
  internal: false, public: true, estimate_id: 20945735, subject, message, version: null, context: null, created_at,
}, extra);

const pad2 = (n) => String(n).padStart(2, '0');
// Long Uptime status notes (real-shaped boilerplate) between 09/29 and 11/09.
function filler(count) {
  const out = [];
  const start = Date.UTC(2026, 8, 29, 15, 0);
  for (let i = 0; i < count; i++) {
    const d = new Date(start + i * Math.floor((41 * 86400000) / count));
    const ds = pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + '/26 10:' + pad2(i % 60) + ' am EDT';
    out.push(note(ds, 'uptime', 'Case Update',
      '<p>Uptime case status review completed. Unit remains at the dealer waiting on parts. The case will continue to be monitored by the Uptime team and updates will be posted here as soon as they are received from the dealer or the supplier. Please reach out to Uptime with any questions regarding this case.</p>'));
  }
  return out;
}

const real = [
  note('11/10/26 10:28 am EST', 'uptime', 'Current Case', 'ETR is 11/11/2026'),
  note('11/09/26 01:38 pm EST', 'dealer', 'Status', 'Waiting on parts'),
  note('10/01/26 09:12 am EDT', 'uptime', 'Parts', 'Part No:  85152780 Qty:  1 Order No:  3010287243 The estimated ship date is 10/11/2026.'),
  note('09/30/26 11:40 am EDT', 'uptime', 'Parts', 'No ESD at this time for part#3010287243'),
  note('09/28/26 02:05 pm EDT', 'dealer', 'Parts info', 'PART # 85152780<br>ORDER # 3010287243<br>RO # 30319SP<br>DEALER CODE 5948D<br>IT WAS ORDERED VOR<br>DUE IN ON OCT 11TH<br>CASE # 264113145'),
  note('09/27/26 08:30 am EDT', 'amazon', 'Parts request', '• Part #: • Order#: • PO#: • Dealer Code: • Verify if ordered VOR (Y/N):'),
];
const prior = [];
for (let i = 0; i < 8; i++) {
  prior.push(note('06/' + pad2(10 + i) + '/26 09:00 am EDT', i % 2 ? 'dealer' : 'uptime', 'Prior case', 'Unit repaired and released, ETR is 06/' + pad2(12 + i) + '/2026'));
}
// Newest-first: 11/10, 11/09, fillers (newest first), 10/01, 09/30, 09/28, 09/27, June.
const fill = filler(94).reverse();
export const allNotes = [real[0], real[1]].concat(fill, real.slice(2), prior);
export const pages = [allNotes.slice(0, 50), allNotes.slice(50, 100), allNotes.slice(100)];
export const WR_CREATED_AT = '2026-09-23T18:04:00.000Z';
export const DEALER_NOTE_DATE = '09/28/26 02:05 pm EDT';
export default allNotes;
