// tests/fixtures/email-intel/canonical.js — canonical-state records in the REAL
// shapes produced by src/orcha/canonical_state.js (F-02).
//
// `lastMeaningfulUpdate` is { source, text, at } where, per _lastMeaningfulUpdate:
//   - source is only 'relay' | 'offsite' | 'timeline'
//   - at is whatever the parsed thread printed ("Nov 4, 2026 02:00 PM" minute precision,
//     "11/04/26" day precision), the row's asistScrapedAt (scrape time, NOT a source time),
//     '' for timeline lines, or free text such as "yesterday"
// Freshness logic must therefore treat unparseable, scrape-time and timeline values as unprovable.

export const LMU = Object.freeze({
  relayMinute: { source: 'relay', text: 'Unit is ready for pickup at the dealer', at: 'Nov 4, 2026 02:00 PM' },
  relayMorning: { source: 'relay', text: 'Waiting on turbo from dealer', at: 'Nov 4, 2026 09:00 AM' },
  offsiteDay: { source: 'offsite', text: 'Dealer says repair complete', at: '11/04/26' },
  timelineOnly: { source: 'timeline', text: '11/03 - parts ordered [em:deadbeef00]', at: '' },
  scrapeTime: { source: 'offsite', text: 'Awaiting parts', at: '2026-11-04T12:00:00.000Z' },
  freeText: { source: 'relay', text: 'Vendor will call back', at: 'yesterday' },
});

function rec(equipmentId, over) {
  return {
    equipmentId,
    status: 'down',
    repairPhase: 'unknown',
    situation: '',
    nextStep: '',
    source: 'relay',
    confidence: 0.8,
    stale: false,
    waitingOn: '',
    waitingOnFine: 'unknown',
    flags: [],
    dimensions: {},
    conflicts: [],
    evidence: [],
    aiReconciled: false,
    updatedAt: '2026-11-04T15:00:00.000Z',
    lastMeaningfulUpdate: null,
    ...over,
  };
}

/** Canonical state document ({ units }) used by reconcile tests. */
export function canonicalState() {
  return {
    units: {
      // ready_for_pickup, last updated from Relay with minute precision
      '40456': rec('40456', { status: 'ready_for_pickup', repairPhase: 'ready_for_pickup', situation: 'Ready for pickup', lastMeaningfulUpdate: { ...LMU.relayMinute } }),
      // awaiting_parts, Relay update earlier the same day
      '40123': rec('40123', { status: 'down', repairPhase: 'awaiting_parts', waitingOnFine: 'dealer', situation: 'Waiting on turbo', lastMeaningfulUpdate: { ...LMU.relayMorning } }),
      // only a previous email-derived timeline line (not authoritative)
      '40789': rec('40789', { status: 'down', repairPhase: 'in_repair', lastMeaningfulUpdate: { ...LMU.timelineOnly } }),
      // 40999 deliberately has no canonical record
    },
    updatedAt: '2026-11-04T15:00:00.000Z',
  };
}

/** Variants of one unit's lastMeaningfulUpdate for the F-02 parsing matrix. */
export function canonicalWith(equipmentId, lmuKey, over) {
  return { units: { [equipmentId]: rec(equipmentId, { lastMeaningfulUpdate: { ...LMU[lmuKey] }, ...(over || {}) }) } };
}
