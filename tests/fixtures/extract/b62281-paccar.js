// tests/fixtures/extract/b62281-paccar.js — B62281 Peterbilt / PACCAR dealer WO (no Relay
// workOrders) plus its Decisiv notes (9 notes, 1 page) and estimate detail. Shapes from
// shape-probe/B62281.*.json; dealer id PCUS00307 from the probe; names/phones masked.
const c = (timestamp, createdBy, text) => ({ timestamp, createdBy, text, internalOnly: false, externalConsumers: [] });

export const relayB62281 = {
  id: 'svc-B62281',
  workOrders: [],
  workRequest: {
    id: 'wr-B62281', createdBy: 'Fleet Ops Center', createdDateTime: Date.parse('2026-11-03T13:00:00Z'),
    needByDateTime: Date.parse('2026-11-10T13:00:00Z'), alternateUniqueId: 'amz-b62281altid00001', salesforceCaseId: null,
    comments: [
      c('2026-11-03T13:01:00Z', 'Fleet Ops Center', 'Misfire, CEL on. tow unit to dealer service shop The Peterbilt Store - Hartford 206 Meadow Ln, Berlin CT 06037 || HBD1 Gate Code: None'),
      c('2026-11-03T15:00:00Z', 'fasuser8', 'Created new FN tow to dealer The Peterbilt Store - Hartford. Ref to: amz-htkt2ed6g9ay7b'),
      c('2026-11-04T15:00:00Z', 'fasuser8', 'Offsite: https://pssmfleet.decisiv.net/service_requests/267806?dealer_id=PCF0013'),
      c('2026-11-05T15:00:00Z', 'fasuser8', 'Approved V1 $5,292.31. Spark plugs loose all 6 cyls, coil boots damaged + PM B. Warranty active (3 yr 6 mo)'),
    ],
  },
};

const DEALER_LOC = 'The Peterbilt Store - Hartford';
const from = {
  dealer: { groupId: -1, name: 'Dealer Writer', location: DEALER_LOC, job_role: 'service_writer' },
  amazon: { groupId: -2, name: 'Amazon Fas', location: 'Amazon Hbd1', job_role: 'fleet_support' },
};
let _id = 175000000;
const note = (created_at, who, subject, message, extra = {}) => Object.assign({
  id: ++_id, from: from[who], recipients: [], system_generated: false, platform_generated: false, internal: false,
  estimate_id: 21520684, subject, message, version: null, context: null, created_at,
}, extra);
// Newest-first.
export const notesB62281 = [
  note('11/07/26 09:00 am EST', 'dealer', 'Status', 'Repairs in progress, ETR is 11/08/2026'),
  note('11/06/26 03:10 pm EST', 'dealer', 'PM', 'Yes, I have added a PM - B service to the work order'),
  note('11/06/26 11:00 am EST', 'amazon', 'PM', 'so can we add PM-B to this RO?'),
  note('11/05/26 04:00 pm EST', 'dealer', 'Approval', 'Est Approved $5,292.31', { system_generated: true, context: 'estimate_approved', version: 1 }),
  note('11/05/26 03:30 pm EST', 'dealer', 'Authorization', 'Total authorized: $5,292.31'),
  note('11/05/26 10:00 am EST', 'dealer', 'Warranty', 'Checked warranty on the coils and plugs, both are expired'),
  note('11/04/26 04:00 pm EST', 'dealer', 'Diag', 'Spark plugs loose on all 6 cylinders, coil boots damaged'),
  note('11/04/26 09:00 am EST', 'dealer', 'Checked in', 'Unit checked in, diag started'),
  note('11/03/26 05:00 pm EST', 'amazon', 'Request', 'Please diagnose misfire and CEL'),
];
export const estimateDetailB62281 = { estimate: { id: 21520684, dealer: { id: 'PCUS00307', name: 'The Peterbilt Store - Hartford' } }, notes: [] };
