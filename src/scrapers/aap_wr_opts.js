'use strict';
/**
 * scrapers/aap_wr_opts.js — pure mapping from a WR modal / tow payload (the
 * legacy createWorkRequest payload shape) to aap_api.createWorkOrder opts.
 *
 * Moved verbatim from ipc/scrapers.js aap:create-wr so the legacy
 * aap_create_wr.createWorkRequest callers use the same mapping. Also forwards
 * the write-gate fields origin / interactive (never userConfirmed). No I/O.
 *
 * Returns the opts object. The optional log(msg) receives the tow diagnostics.
 */

function toCreateWorkOrderOpts(payload, unit, log) {
  payload = payload || {};
  const towLog = { push: (m) => { if (typeof log === 'function') log(m); } };
  const opts = {
    assetUrl: (unit && unit.assetUrl) || '',
    aaid: (unit && unit.aaid) || undefined,
    title: payload.title,
    issue: payload.issue,
    comments: payload.comments,
    shareWith: payload.shareWith,
    areaPairs: payload.areaPairs || [],
    urgent: payload.urgent,
    urgencyReason: payload.urgencyReason,
    arcClaim: payload.arcClaim,
    simNumber: payload.simNumber,
    vendor: payload.vendor,
    contactName: payload.contactName,
    contactPhone: payload.contactPhone,
    attachments: (payload.attachments || []).map((d, i) => (typeof d === 'string' ? { name: 'attachment-' + (i + 1), dataUrl: d } : d)),
    domicile: (unit && (unit.site || unit.domicileSite)) || payload.domicile || '',
    copiedFromWorkRequestId: payload.copiedFromWorkRequestId || null,
    // TOW: pass the DESTINATION (where the unit is going) + direction so the
    // create body can set AAP's separate `destination` field + transloading
    // flag (AAP stores tow pickup in reportedLocation and the target in a
    // distinct `destination` object — confirmed from a hand-made ref WR).
    towDirection: payload.towDirection || '',
    towToStreet: payload.towStreet || '', towToCity: payload.towCity || '',
    towToState: payload.towState || '', towToZip: payload.towZip || '',
    confirmVendor: true, // modal auto-submits → commit directly
  };
  // Write-gate fields (src/writes/write-gate.js). payload.userConfirmed is NOT
  // forwarded: it is a caller-level statement ("the WR modal showed this and the
  // user clicked"), set only by the aap:create-wr IPC handler, never by payload data.
  if (payload.origin) opts.origin = payload.origin;
  if (payload.interactive === false) opts.interactive = false;
  if (unit && unit.equipmentId) opts.unit = unit.equipmentId;

  // TOW LOCATION: for a return-to-yard / yard-to-yard tow the unit is NOT at
  // its home yard — it's at the tow PICKUP (the dealer). Tell createWorkOrder
  // via its off-site address fields so currentLocation reflects where the
  // unit actually is. For a to-dealer tow the unit is still at the home yard,
  // so leave the GPS/domicile location as-is.
  const dir = String(payload.towDirection || '').toLowerCase();
  // DIAGNOSTIC: log exactly what pickup/destination/offSite arrived, so a
  // swapped pickup/destination is unambiguous in the log.
  towLog.push('[create-wr] tow fields: dir=' + (dir || 'none') +
    ' | pickup(towFrom)=' + [payload.towFromStreet, payload.towFromCity, payload.towFromState, payload.towFromZip].filter(Boolean).join(', ') +
    ' | destination(tow)=' + [payload.towStreet, payload.towCity, payload.towState, payload.towZip].filter(Boolean).join(', ') +
    ' | offSite=' + payload.offSite + ' loc=' + [payload.locStreet, payload.locCity, payload.locState, payload.locZip].filter(Boolean).join(', '));
  if (dir === 'return-to-yard' || dir === 'yard-to-yard') {
    const pickup = [payload.towFromStreet, payload.towFromCity, payload.towFromState, payload.towFromZip].map(s => String(s || '').trim());
    if (pickup.some(Boolean)) {
      opts.offSite = true;
      opts.locStreet = payload.towFromStreet || '';
      opts.locCity   = payload.towFromCity   || '';
      opts.locState  = payload.towFromState  || '';
      opts.locZip    = payload.towFromZip    || '';
      towLog.push('[create-wr] tow direction "' + dir + '" — unit is at pickup, using off-site location: ' + pickup.filter(Boolean).join(', '));
    }
  }
  return opts;
}

module.exports = { toCreateWorkOrderOpts };
