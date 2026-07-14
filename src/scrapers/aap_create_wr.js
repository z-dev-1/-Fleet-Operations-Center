'use strict';
const logger = require('../utils/logger').createLogger('aap_create_wr');
/**
 * AAP Create Work Request — Direct API
 * 3-step flow: createRepair → createDriverConnection → updateWorkRequest
 */

const AAP_BASE = 'https://aap-na.corp.amazon.com/api/v1';

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
 * Create a Work Request via AAP API
 * @param {Object} payload - from collectPayload() in the renderer
 * @param {Object} unit - the UNITS entry for this equipment
 * @param {Function} log - logging callback
 * @returns {Object} { ok, workRequestId, error }
 */
async function createWorkRequest(payload, unit, log) {
  if (!log) log = console.log;

  // Extract aaid from unit's assetUrl
  const assetUrl = unit.assetUrl || '';
  const aaid = assetUrl.includes('/v2/asset/') ? assetUrl.split('/v2/asset/')[1].split('?')[0] : '';
  if (!aaid) {
    return { ok: false, error: 'No AAID found for unit ' + payload.unit + '. Run a scan first.' };
  }
  log('[CreateWR] AAID: ' + aaid);

  // Resolve location
  const domicile = (unit.site || payload.domicile || 'ABE40').toUpperCase();
  let currentLocation = DOMICILE_COORDS[domicile] || DOMICILE_COORDS['ABE40'];

  // Current location = where unit is now
  currentLocation = {
    latitude: currentLocation.latitude,
    longitude: currentLocation.longitude,
    yardLocation: null,
    geofenceCode: domicile
  };

  // TOW handling: if area is TOW, always urgent + FleetNet vendor
  const isTow = (payload.areaPairs || []).some(p => p.area === 'TOW');
  if (isTow) {
    // Ensure urgency for tow events
    if (!payload.urgent || payload.urgent !== 'Yes') {
      payload.urgent = 'Yes';
      payload.urgencyReason = payload.urgencyReason || 'DEA - Asset Shortage';
    }
  }

  // Resolve vendor
  const vendorName = payload.vendor || '';
  const supplierId = VENDOR_IDS[vendorName] || '';
  if (!supplierId) {
    log('[CreateWR] WARNING: No supplierId for vendor "' + vendorName + '". WR may fail or use default.');
  }

  // Build suggestedItems from areaPairs
  const suggestedItems = (payload.areaPairs || []).map(pair => ({
    level1: pair.area || '',
    level2: pair.subcategory || '',
    level3: ''
  }));

  // Build comments array
  const comments = [];
  if (payload.comments) {
    comments.push({
      text: payload.comments,
      internalOnly: (payload.shareWith || '').toLowerCase().includes('internal'),
      externalConsumers: []
    });
  }

  // Timestamps
  const now = new Date();
  const needBy = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now

  // STEP 1: createRepair
  const repairBody = {
    aaid: aaid,
    title: payload.title || 'Work Request',
    damageDescription: payload.issue || payload.title || '',
    vendor: vendorName.split(' (')[0].toUpperCase(), // "Volvo (ASIST)" → "VOLVO"
    supplierId: supplierId || null,
    calltype: 'OFFSITE',
    urgent: payload.urgent === 'Yes',
    urgencyReason: (payload.urgent === 'Yes') ? (payload.urgencyReason || 'DEA - Asset Shortage') : null,
    severity: (payload.urgent === 'Yes') ? 'HIGH' : 'LOW',
    suggestedItems: suggestedItems,
    comments: comments,
    currentLocation: currentLocation,
    assetAvailableDateTime: now.toISOString(),
    needByDateTime: needBy.toISOString(),
    assetLoaded: false,
    assetRefrigerated: false,
    tireIssue: false,
    arcClaimNumber: payload.arcClaim || null,
    simNumber: payload.simNumber || null,
    recommendationInfo: {
      vendor: vendorName.split(' (')[0],
      vendorOpenWRCount: null,
      vendorDistanceToAsset: null
    },
    campaign: null,
    source: null,
    dvirId: null,
    copiedFromWorkRequestId: null,
    relatedAsset: null,
    sourceNotificationIds: null,
    vendorIntegrationType: null
  };

  log('[CreateWR] Step 1: createRepair for ' + payload.unit);

  let workRequestId;
  try {
    const resp1 = await aapFetch('/createRepair', repairBody);
    if (!resp1.ok) {
      return { ok: false, error: 'createRepair failed: ' + (resp1.statusText || resp1.status) };
    }
    const data1 = await resp1.json();
    workRequestId = data1.workRequestId || data1.id;
    if (!workRequestId) {
      return { ok: false, error: 'createRepair returned no workRequestId' };
    }
    log('[CreateWR] Step 1 OK: workRequestId = ' + workRequestId);
  } catch(e) {
    return { ok: false, error: 'createRepair error: ' + e.message };
  }

  // STEP 2: createDriverConnection (contact info)
  const contactBody = {
    workRequestId: workRequestId,
    aaid: aaid,
    driverName: payload.contactName || 'Z',
    driverPhoneNumber: (payload.contactPhone || '').replace(/[^\d-]/g, '') || '1-7166142167'
  };

  log('[CreateWR] Step 2: createDriverConnection');
  try {
    const resp2 = await aapFetch('/createDriverConnection', contactBody);
    if (!resp2.ok) {
      log('[CreateWR] Step 2 WARNING: ' + resp2.status);
    } else {
      log('[CreateWR] Step 2 OK');
    }
  } catch(e) {
    log('[CreateWR] Step 2 error (non-fatal): ' + e.message);
  }

  // STEP 3: updateWorkRequest (images/attachments)
  const images = [];
  // If we have a screenshot data URL, include it
  if (payload.screenshotDataUrl && payload.screenshotDataUrl.startsWith('data:')) {
    images.push(payload.screenshotDataUrl);
  }

  const updateBody = {
    workRequestId: workRequestId,
    images: images
  };

  log('[CreateWR] Step 3: updateWorkRequest (images: ' + images.length + ')');
  try {
    const resp3 = await aapFetch('/updateWorkRequest', updateBody);
    if (!resp3.ok) {
      log('[CreateWR] Step 3 WARNING: ' + resp3.status);
    } else {
      log('[CreateWR] Step 3 OK');
    }
  } catch(e) {
    log('[CreateWR] Step 3 error (non-fatal): ' + e.message);
  }

  log('[CreateWR] SUCCESS — WR created: ' + workRequestId);
  return { ok: true, workRequestId: workRequestId };
}

/**
 * Make authenticated fetch to AAP API
 * Uses the Electron session cookies (same auth as AAP scraper)
 */
async function aapFetch(endpoint, body) {
  const { session } = require('electron');
  const ses = session.defaultSession;

  // Get cookies for aap-na.corp.amazon.com
  const cookies = await ses.cookies.get({ url: 'https://aap-na.corp.amazon.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

  const url = AAP_BASE + endpoint;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cookie': cookieStr,
      'Accept': 'application/json',
      'Origin': 'https://aap-na.corp.amazon.com',
      'Referer': 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24'
    },
    body: JSON.stringify(body)
  });

  return response;
}


/** addConversationNote -- S25-8: post internal comment on AAP WR */
async function addConversationNote(wrIdOrUrl,text){
  if(!wrIdOrUrl||!text)return{ok:false,error:"missing args"};
  var workRequestId=wrIdOrUrl;
  var m=String(wrIdOrUrl).match(/\/v2\/service\/([a-f0-9-]{36})/i);
  if(m)workRequestId=m[1];
  var body={workRequestId:workRequestId,text:String(text).slice(0,2000),internalOnly:true,externalConsumers:[]};
  try{
    var resp=await aapFetch("/addComment",body);
    if(!resp.ok){var e=await resp.text().catch(function(){return String(resp.status);});return{ok:false,error:"addComment HTTP "+resp.status+": "+String(e).slice(0,120)};}
    return{ok:true};
  }catch(e){return{ok:false,error:e.message};}
}

module.exports = { createWorkRequest, addConversationNote, VENDOR_IDS, VENDOR_PORTAL_URLS, DOMICILE_COORDS };
