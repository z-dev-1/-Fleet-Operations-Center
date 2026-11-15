// tests/fixtures/extract/relay-39582-volvo.js — Relay serviceaggregate for WO 39582
// (Volvo / ASIST dealer, no Relay workOrders). Hand-built from the masked live probe
// (shape-probe/39582.serviceaggregate.json) and findings §(a): real wording, names,
// aliases and phones replaced. Comment timestamps are ISO as in the probe (one with
// nanosecond precision).
const c = (timestamp, createdBy, text, internalOnly = false) => ({ timestamp, createdBy, text, internalOnly, externalConsumers: [] });

export const SERVICE_ID = 'svc-39582';
export const comments = [
  c('2026-09-23T18:04:30.934Z', 'Fleet Ops Center', 'Check engine light, unit derated. Tow unit to dealer service shop M&K Truck Centers - Dunmore 1000 Main St, Dunmore PA 18512 || Gate Code: None'),
  c('2026-09-24T14:10:00.000Z', 'fasuser1', 'Called M&K Truck Centers – Dunmore, PA (Volvo) at (555) 010-1245 and spoke with Pat. Unit checked in, diag pending.'),
  c('2026-09-26T15:00:00.204881915Z', 'fasuser1', 'Per ASIST case #20944704 dealer diagnosed failed harness.'),
  c('2026-09-28T15:30:00.000Z', 'fasuser1', 'The required harness Part #85152780 was ordered VOR under Order #3010287243. Current expected arrival date is 10/11/26. Qty. 1'),
  c('2026-10-02T15:00:00.000Z', 'fasuser2', 'Parts ETC -10/11/2026'),
  c('2026-10-05T15:00:00.000Z', 'fasuser2', 'Dealer confirms estimated ship date is 10/11/26 for the harness.'),
  c('2026-10-09T15:00:00.000Z', 'fasuser2', 'Uptime states estimated shipping date remains 10/11/26.'),
  c('2026-10-12T15:00:00.000Z', 'fasuser1', 'The part was expected on 10/11 but has not arrived. Following up with Uptime.'),
  c('2026-10-14T15:00:00.000Z', 'fasuser1', 'Uptime advised the harness was originally scheduled to ship on 10/11; however, the part is now on backorder, with a revised estimated ship date of 10/26.'),
  c('2026-10-16T15:00:00.000Z', 'fasuser2', 'Harness still expected to ship on 10/26 per Uptime.'),
  c('2026-10-20T15:00:00.000Z', 'fasuser1', 'PM-B service has been added to the repair order while unit waits on parts.'),
  c('2026-10-22T15:00:00.000Z', 'fasuser2', 'We are two weeks into a 6-8 week lead time on this harness per dealer.'),
  c('2026-10-26T15:00:00.000Z', 'fasuser1', 'Part was scheduled to ship on 10/26, with no tracking information yet. part not arrived yet'),
  c('2026-10-27T15:00:00.000Z', 'fasuser1', 'Called M&K Truck Centers – Dunmore, PA (Volvo) at (555) 010-1245, on hold for 6 minutes, no answer. Uptime says there is no information on parts ETC yet.'),
  c('2026-10-28T15:00:00.000Z', 'fasuser1', 'Uptime was expecting the replacement harness to ship on 10/26. However as of today no shipping information or tracking number had been received.'),
  c('2026-10-30T15:00:00.000Z', 'fasuser2', 'left a voicemail for Service Manager regarding harness status.'),
  c('2026-11-02T15:00:00.000Z', 'fasuser2', 'No updated parts ETA from Uptime. Service Manager Pat Doe will call back.'),
  c('2026-11-04T15:00:00.000Z', 'fasuser1', '11/04 update: all required parts have arrived at the dealership, repairs are scheduled to begin next week (week of 11/09).'),
  c('2026-11-06T15:00:00.000Z', 'fasuser1', 'Bridge for dealer call: One-click Connect Number: +18005550199,,,0402,,,8263'),
  c('2026-11-09T15:00:00.000Z', 'fasuser2', 'Dealer started repairs, waiting on ETR from Uptime.'),
];

export const serviceDetail = {
  id: SERVICE_ID,
  workOrders: [],
  workOrderLineItems: [],
  vendorModifiedTimestamp: null,
  workRequest: {
    id: 'wr-39582',
    createdBy: 'Fleet Ops Center',
    createdDateTime: Date.parse('2026-09-23T18:04:00.000Z'),
    needByDateTime: Date.parse('2026-09-30T18:00:00.000Z'),
    alternateUniqueId: 'amz-9g7bq2kd4m1xz8',
    salesforceCaseId: null,
    caseNumber: null,
    comments,
  },
};

export default serviceDetail;
