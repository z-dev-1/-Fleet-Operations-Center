'use strict';
// Synthetic SCAC 'SYNX' for the carrier-intel budget / tiering tests (design AC-18): `down`
// down units with distinct days down and long notes (so the evidence must be allocated), plus
// `active` Active units. Deterministic; no clock.

const VENDORS = ['COX', 'TA', 'KWNE'];
const pad = (n) => String(n).padStart(2, '0');

function conversation(id, vendor, i) {
  const L = ['Conversation'];
  for (let d = 1; d <= 12; d++) {
    L.push('11/' + pad(d) + ' - ' + vendor + ': Technician Notes: unit ' + id + ' inspected on visit ' + d
      + '. Replaced filter housing and checked the harness, waiting on the next shipment of brake components. Road test pending once parts land at the shop.');
  }
  if (i % 4 === 0) L.push('11/13 - ' + vendor + ': parts ordered. no eta');
  return L.join('\n');
}

function timeline(id, i) {
  const L = [];
  for (let d = 1; d <= 10; d++) L.push('11/' + pad(d) + ' - ' + id + ' repair in progress at the vendor; brake components on order, road test after install (summary ' + (d + i) + ').');
  return L.join('\n');
}

// Every 4th down unit is a copy of the AUVTE B12195 row (COX parts hold with Relay facts: ETC
// history, tech arrival, parts no ETA) under its own id, so the roll-up has id lists with
// '+K more' and the mechanical lines carry per-unit values.
function _cox(id, days, scac, domicile) {
  const src = require('./auvte-scac-rows.json').rows.find((r) => r.equipmentId === 'B12195');
  const row = JSON.parse(JSON.stringify(src).replace(/B12195/g, id).replace(/b12195/g, id.toLowerCase()));
  return Object.assign(row, { operator: scac, domicileSite: domicile, workDuration: days + 'd 0h 0m' });
}

function build({ down = 40, active = 10, scac = 'SYNX', domicile = 'XYZ1' } = {}) {
  const rows = [];
  for (let i = 0; i < down; i++) {
    const id = 'B7' + String(1000 + i);
    const vendor = VENDORS[i % VENDORS.length];
    const days = 5 + i;
    if (i % 4 === 0) { rows.push(_cox(id, days, scac, domicile)); continue; }
    rows.push({
      equipmentId: id, assetType: 'boxTruck', bodyType: 'Box Truck', domicileSite: domicile, operator: scac,
      lifecycleState: 'Unavailable', lifecycleReason: 'Damaged-Moderate', serviceState: 'Work in progress', vendor,
      workDuration: days + 'd ' + (i % 24) + 'h 0m', workRequestId: 'wr-' + id.toLowerCase(), savedRepairStatus: 'Parts ordered',
      issueSummary: 'Brake system repair; components on order.',
      repairTimeline: timeline(id, i), fullConversation: conversation(id, vendor, i),
    });
  }
  for (let i = 0; i < active; i++) {
    rows.push({
      equipmentId: 'B8' + String(1000 + i), assetType: 'boxTruck', bodyType: 'Box Truck', domicileSite: domicile, operator: scac,
      lifecycleState: 'Active', lifecycleReason: '', vendor: '', workDuration: '',
    });
  }
  return { scac, domicile, today: '2026-11-17', syncedAt: '2026-11-17T17:38:17Z', rows };
}

module.exports = { build };
