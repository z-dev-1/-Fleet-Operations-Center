'use strict';
const logger = require('../utils/logger').createLogger('aap_create_wr');
/**
 * AAP Create Work Request / WR comment.
 *
 * Both writes go through the working AAP transport (aap_api: in-page XHR with
 * the captured a2z token) and the user-approval gate (src/writes/write-gate.js):
 *   createWorkRequest   -> aap_api.createWorkOrder({ ..., confirmVendor:true })
 *   addConversationNote -> write-gate requestWrite({ kind:'addComment' })
 * The old cookie-only session fetch (HTTP 403) is gone.
 */

// WR title hard cap — AAP's own field limit. Enforced regardless of caller.
const WR_TITLE_MAX = 90;
function capWrTitle(title) {
  return String(title == null || String(title).trim() === '' ? 'Work Request' : title).slice(0, WR_TITLE_MAX);
}
// Normalize a "copied from" WR reference (for a linked second WR / dealer
// tracking event). Accepts a raw UUID or a /v2/service/<uuid> URL; returns the
// bare UUID or null. Never fabricates — an unrecognized value yields null so
// the second WR is simply created unlinked rather than pointing at garbage.
function normalizeCopiedFromId(ref) {
  if (!ref) return null;
  const m = String(ref).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
  if (m) return m[1];
  return /^[a-f0-9-]{36}$/i.test(String(ref).trim()) ? String(ref).trim() : null;
}

// Known domicile coordinates
const DOMICILE_COORDS = {
  'ABE40': { latitude: 40.6593, longitude: -75.4902 },
  'PHL40': { latitude: 40.7895, longitude: -74.0565 },
  'EWR45': { latitude: 40.8468, longitude: -74.0590 },
  'AVP40': { latitude: 41.3252, longitude: -75.7580 },
  'AUVTE01': { latitude: 40.6593, longitude: -75.4902 }
};

// Vendor -> supplierId mapping.
// supplierIds are AAP API UUIDs -- must be captured from live createRepair responses.
// Keys MUST match the raw vendor cell text scraped by relay.js (see line ~383 of relay.js).
// To fill: run a real WR for each vendor and inspect the createRepair response body for supplierId.
const VENDOR_IDS = {
  // -- Confirmed -----------------------------------------------------------------
  'Cox':                    'ba5a6982-0897-4ddc-bebc-c5edf6b877e5', // confirmed live
  'COX':                    'ba5a6982-0897-4ddc-bebc-c5edf6b877e5', // relay may produce either case

  // -- Decisiv workflow keys (used by relay-step.js aapVendorName) ---------------
  'Kenworth (PACCAR)':      '', // automated PACCAR WRs -- TODO capture supplierId
  'Peterbilt (PACCAR)':     '', // automated PACCAR WRs -- TODO capture supplierId
  'Volvo (ASIST)':          '', // automated Volvo WRs  -- TODO capture supplierId

  // -- Raw relay.js scrape values (mixed/upper case as AAP renders them) ----------
  'Amerit':                 '', // TODO: capture supplierId from next Amerit WR
  'AMERIT':                 '', // alias (relay may produce either)
  'Volvo':                  '', // generic Volvo (non-Decisiv WR)
  'KENWORTH':               '', // raw scrape value
  'PETERBILT':              '', // raw scrape value
  'PACCAR':                 '', // rare -- relay usually produces brand-specific key
  'FREIGHTLINER':           '', // raw scrape value
  'Freightliner (DAIMLER)': '', // legacy key -- kept for backwards compat
  'DAIMLER':                '', // alias
  'CUMMINS':                '', // raw scrape value
  'Cummins':                '', // alias (legacy)
  'TA':                     '', // TravelCenters of America
  'VELOCITI':               '', // raw scrape value
  'Velociti':               '', // alias (legacy)
  'FleetNet':               '', // NOTE: relay.js skips FleetNet units entirely
  'Fleet Net':              '', // alias
  'FleetNet (FLEETNET)':    '', // legacy key
  'RENTAL':                 '', // Ryder/Penske rental pool
  'Ryder (RENTAL)':         '', // legacy key
  'Penske (RENTAL)':        '', // legacy key
  'GOODYEAR':               '', // tire program WRs
  'KOONER':                 '',
  'MACK':                   '', // relay scrapes but no automated portal flow
  'INTERNATIONAL':          '', // Navistar/International
  'NAVISTAR':               '', // alias
  'PCSR':                   '',
  'CEI':                    '',
  'RTS':                    '',
  'KWNE (Kenworth NE)':     '', // legacy key
};

// Vendor portal URLs -- informational; surfaced in vendor review modal for
// vendors that do NOT have an automated Decisiv workflow.
// PACCAR + Volvo portals live in src/vendors/index.js PORTAL_URLS.
const VENDOR_PORTAL_URLS = {
  'Amerit':        'https://ameritfs.com/',
  'AMERIT':        'https://ameritfs.com/',
  'CUMMINS':       'https://cumminscare.com/',
  'Cummins':       'https://cumminscare.com/',
  'TA':            'https://www.ta-petro.com/fleet/fleet-services/',
  'VELOCITI':      'https://www.velociti.com/',
  'Velociti':      'https://www.velociti.com/',
  'FleetNet':      'https://www.fleetnet.com/',
  'Fleet Net':     'https://www.fleetnet.com/',
  'GOODYEAR':      'https://commercialtire.goodyear.com/',
  'FREIGHTLINER':  'https://dtnaparts.com/',
  'KENWORTH':      'https://kenworth.com/owners/',
  'PETERBILT':     'https://peterbilt.com/owners/',
  'MACK':          'https://macktrucks.com/',
  'INTERNATIONAL': 'https://www.internationaltrucks.com/dealers',
  'NAVISTAR':      'https://www.internationaltrucks.com/dealers',
  'RENTAL':        '', // account-specific portal -- no public URL
  'KOONER':        '', // direct dispatch -- no portal
  'PCSR':          '',
  'CEI':           '',
  'RTS':           '',
};

/**
 * Resolve the unit argument to a row with assetUrl / aaid. Accepts a fleet row,
 * or an equipmentId string / an object without assetUrl+aaid, which is looked
 * up in the stored fleetData rows (read-only).
 */
function _resolveUnit(unit, payload) {
  const isObj = unit && typeof unit === 'object';
  if (isObj && (unit.assetUrl || unit.aaid)) return unit;
  const id = String((isObj ? (unit.equipmentId || unit.unit) : unit) || (payload && payload.unit) || '').trim();
  if (!id) return isObj ? unit : null;
  try {
    const fd = require('../store').load('fleetData', {}) || {};
    const row = (fd.rows || []).find((r) => String((r && r.equipmentId) || '').trim().toUpperCase() === id.toUpperCase());
    if (row) return isObj ? Object.assign({}, row, unit, { assetUrl: row.assetUrl, aaid: row.aaid }) : row;
  } catch (_) { /* fall through */ }
  return isObj ? unit : { equipmentId: id };
}

/**
 * createWorkRequest(payload, unit, log, gateOpts) — create a Relay WR from the
 * legacy payload shape. Routed through the working AAP transport
 * (aap_api.createWorkOrder, in-page XHR + a2z token) with confirmVendor:true,
 * so the write-approval gate (src/writes/write-gate.js) decides whether it is
 * sent. gateOpts: { origin, interactive (default true), userConfirmed }.
 *
 * Returns { ok:true, workRequestId, title, copiedFromWorkRequestId } or
 * { ok:false, outcome?, error } — outcome 'pending-approval' /
 * 'skipped-not-approved' means nothing was sent to Relay.
 */
async function createWorkRequest(payload, unit, log, gateOpts) {
  if (!log) log = (m) => logger.info(m);
  payload = payload || {};
  const g = gateOpts || {};
  const row = _resolveUnit(unit, payload);
  const opts = require('./aap_wr_opts').toCreateWorkOrderOpts(payload, row || {}, log);
  if (!opts.aaid && !(opts.assetUrl && opts.assetUrl.includes('/v2/asset/'))) {
    return { ok: false, error: 'No AAID found for unit ' + (payload.unit || (row && row.equipmentId) || '') + '. Run a scan first.' };
  }
  opts.confirmVendor = true;
  opts.origin = g.origin || payload.origin || 'createWorkRequest';
  opts.interactive = g.interactive !== false;
  if (g.userConfirmed === true) opts.userConfirmed = true;
  if (!opts.unit) opts.unit = (row && row.equipmentId) || payload.unit || '';

  const wrTitle = capWrTitle(payload.title);
  const copiedFrom = normalizeCopiedFromId(payload.copiedFromWorkRequestId);
  let r;
  try {
    r = await require('./aap_api').createWorkOrder(opts);
  } catch (e) {
    return { ok: false, error: 'createWorkOrder error: ' + e.message };
  }
  if (r && r.phase === 'gated') {
    log('[CreateWR] Not sent to Relay (' + r.outcome + ') for ' + (opts.unit || '?'));
    return { ok: false, outcome: r.outcome, id: r.id || null, error: r.error || r.outcome };
  }
  if (r && r.ok && r.workRequestId) {
    log('[CreateWR] SUCCESS — WR created: ' + r.workRequestId + (copiedFrom ? ' (copied from ' + copiedFrom + ')' : ''));
    return { ok: true, workRequestId: r.workRequestId, title: wrTitle, copiedFromWorkRequestId: copiedFrom || null };
  }
  return { ok: false, error: (r && r.error) || 'WR not created' };
}

/**
 * addConversationNote(wrIdOrUrl, text, gateOpts) — post an internal comment on
 * a Relay WR. The send (the addComment POST over the working AAP transport)
 * happens only inside the write-approval gate. gateOpts: { origin, unit,
 * interactive, approvedBy, aiDrafted }. Returns { ok, outcome, error }.
 */
async function addConversationNote(wrIdOrUrl, text, gateOpts) {
  if (!wrIdOrUrl || !text) return { ok: false, error: 'missing args' };
  let workRequestId = wrIdOrUrl;
  const m = String(wrIdOrUrl).match(/\/v2\/service\/([a-f0-9-]{36})/i);
  if (m) workRequestId = m[1];
  const g = gateOpts || {};
  try {
    const r = await require('../writes/write-gate').requestWrite({
      kind: 'addComment',
      workRequestId: String(workRequestId),
      payload: { workRequestId: String(workRequestId), text: String(text) },
      origin: g.origin || 'addConversationNote',
      unit: g.unit || '',
      interactive: g.interactive === true,
      approvedBy: g.approvedBy,
      aiDrafted: !!g.aiDrafted,
    });
    return { ok: !!(r && r.ok), outcome: r && r.outcome, id: r && r.id, error: r && r.ok ? undefined : (r && r.error) };
  } catch (e) { return { ok: false, outcome: 'send-failed', error: e.message }; }
}

// AAP stores the driver phone as "<countryCode>-<number>" and splits on the
// FIRST dash when displaying ("716-614-2167" → partial, "7166142167" → blank).
// Normalize any typed format to "1-7166142167". Same rule as aap_api.js.
function toAapPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 10) return '1-' + d;
  return d;
}

module.exports = { createWorkRequest, addConversationNote, VENDOR_IDS, VENDOR_PORTAL_URLS, DOMICILE_COORDS, capWrTitle, normalizeCopiedFromId, WR_TITLE_MAX, toAapPhone };
