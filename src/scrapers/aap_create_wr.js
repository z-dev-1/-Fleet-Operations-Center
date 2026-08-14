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

// Known WR UUIDs for supplier ID resolution.
// When VENDOR_IDS has no supplierId for a vendor, resolveSupplierIdForVendor()
// fetches one of these WRs from AAP and extracts the supplierId from the response,
// then caches it in VENDOR_IDS for the rest of the session.
// Seeded from scraper logs 2026-07-26.
const VENDOR_SAMPLE_WR = {
  'Volvo (ASIST)':          '88ce1ce2-942d-4e39-a1c0-c91e60398680',
  'Volvo':                  '88ce1ce2-942d-4e39-a1c0-c91e60398680',
  'VOLVO':                  '88ce1ce2-942d-4e39-a1c0-c91e60398680',
  'FREIGHTLINER':           '375a6bc3-961b-400a-944b-ad85913ed672',
  'Freightliner (DAIMLER)': '375a6bc3-961b-400a-944b-ad85913ed672',
  'DAIMLER':                '375a6bc3-961b-400a-944b-ad85913ed672',
  'Peterbilt (PACCAR)':     'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af',
  'PETERBILT':              'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af',
  'Kenworth (PACCAR)':      'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af', // PACCAR family -- use Peterbilt WR until Kenworth WR captured
  'KENWORTH':               'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af',
  'PACCAR':                 'ffb8271d-b8ad-4c12-9fa4-27fcbe75a3af',
  'Amerit':                 '58791f1a-2d69-408c-82f5-d3a0ad47a93b',
  'AMERIT':                 '58791f1a-2d69-408c-82f5-d3a0ad47a93b',
  'CEI':                    '4ca84908-a4ef-40bc-bfab-f4ae300e2082',
  'CUMMINS':                'fef19166-69c4-4001-968c-dd3f3b438c75',
  'Cummins':                'fef19166-69c4-4001-968c-dd3f3b438c75',
  'TA':                     '0593c832-2d33-49ad-a637-9405c2588e1c',
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
 * Resolve supplierId for a vendor name.
 * 1. Check VENDOR_IDS cache (pre-populated or cached from a prior call this session).
 * 2. If empty, find a known sample WR UUID in VENDOR_SAMPLE_WR, fetch it from AAP,
 *    extract supplierId, cache it in VENDOR_IDS, and return it.
 * 3. If no sample WR known either, return null.
 */
async function resolveSupplierIdForVendor(vendorName, log) {
  if (!log) log = console.log;
  if (!vendorName) return null;

  // Cache hit
  if (VENDOR_IDS[vendorName]) return VENDOR_IDS[vendorName];

  const sampleWrId = VENDOR_SAMPLE_WR[vendorName];
  if (!sampleWrId) {
    log('[ResolveSupplier] No sample WR known for vendor "' + vendorName + '" -- cannot auto-resolve supplierId.');
    return null;
  }

  log('[ResolveSupplier] Looking up supplierId for "' + vendorName + '" via WR ' + sampleWrId + '...');
  try {
    // Run the fetch from within an existing AAP browser window so it is same-origin
    // and uses the page's full auth context (cookies + any session tokens).
    // ses.fetch() from the main process triggers a CORS preflight that AAP rejects
    // with net::ERR_FAILED for GET requests -- executeJavaScript bypasses that.
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed());
    // Prefer a window already on aap-na.corp.amazon.com
    const win = wins.find(w => {
      try { return w.webContents.getURL().includes('aap-na.corp.amazon.com'); } catch(_) { return false; }
    }) || wins[0];

    if (!win) {
      log('[ResolveSupplier] No browser window available for lookup.');
      return null;
    }

    const resultStr = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch('/api/v1/workRequests/' + ${JSON.stringify(sampleWrId)} + '', {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
          });
          if (!r.ok) return JSON.stringify({ _error: r.status, _body: await r.text().catch(() => '') });
          return JSON.stringify(await r.json());
        } catch(e) {
          return JSON.stringify({ _error: e.message });
        }
      })()
    `);

    const wr = JSON.parse(resultStr);
    if (wr._error !== undefined) {
      log('[ResolveSupplier] WR fetch error: ' + wr._error + (wr._body ? ' -- ' + String(wr._body).slice(0, 200) : ''));
      return null;
    }
    const resolved = wr.supplierId || (wr.supplier && wr.supplier.id) || null;
    if (!resolved) {
      log('[ResolveSupplier] WR response had no supplierId. Keys: ' + Object.keys(wr).slice(0, 20).join(', '));
      return null;
    }
    log('[ResolveSupplier] Resolved supplierId=' + resolved + ' for "' + vendorName + '" -- caching.');
    VENDOR_IDS[vendorName] = resolved;
    return resolved;
  } catch (e) {
    log('[ResolveSupplier] Error: ' + e.message);
    return null;
  }
}


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

  // Resolve vendor + supplierId
  const vendorName = payload.vendor || '';
  const supplierId = await resolveSupplierIdForVendor(vendorName, log);
  if (!vendorName) {
    log('[CreateWR] No vendor specified -- proceeding with supplierId=null.');
  } else if (!supplierId) {
    log('[CreateWR] No supplierId resolved for vendor "' + vendorName + '" -- attempting API with null.');
  } else {
    log('[CreateWR] Resolved supplierId for "' + vendorName + '": ' + supplierId);
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
    log('[CreateWR] Step 1 response: HTTP ' + resp1.status + ' ' + resp1.statusText);
    if (!resp1.ok) {
      let errBody = '';
      try { errBody = await resp1.text(); } catch(_) {}
      log('[CreateWR] Step 1 error body: ' + errBody.slice(0, 400));
      return { ok: false, error: 'createRepair HTTP ' + resp1.status + (errBody ? ': ' + errBody.slice(0, 200) : '') };
    }
    const data1 = await resp1.json();
    workRequestId = data1.workRequestId || data1.id;
    if (!workRequestId) {
      log('[CreateWR] Step 1 no workRequestId in response: ' + JSON.stringify(data1).slice(0, 300));
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
  // FEATURE (2026-07-23): payload.attachments now carries every file the
  // user attached (auto Uptake screenshot + manual/drag-and-drop files) --
  // previously only the single legacy screenshotDataUrl field was sent.
  if (Array.isArray(payload.attachments)) {
    for (const dataUrl of payload.attachments) {
      if (dataUrl && dataUrl.startsWith('data:') && images.indexOf(dataUrl) === -1) images.push(dataUrl);
    }
  }
  // Legacy single-field fallback, kept for backward compat with any caller
  // still only setting screenshotDataUrl.
  if (payload.screenshotDataUrl && payload.screenshotDataUrl.startsWith('data:') && images.indexOf(payload.screenshotDataUrl) === -1) {
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
  // Use session.fetch() so requests go through Electron's Chromium network
  // stack, which handles the corporate proxy, SSL certs, and AAP auth
  // cookies automatically -- global fetch() bypasses all of that and
  // produces "fetch failed" (network-level error) on internal URLs.
  const { session } = require('electron');
  const ses = session.defaultSession;

  const cookies = await ses.cookies.get({ url: 'https://aap-na.corp.amazon.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');

  const url = AAP_BASE + endpoint;
  const response = await ses.fetch(url, {
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


/**
 * Make authenticated GET fetch to AAP API
 */
async function aapGetFetch(endpoint) {
  const { session } = require('electron');
  const ses = session.defaultSession;
  const cookies = await ses.cookies.get({ url: 'https://aap-na.corp.amazon.com' });
  const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
  const url = AAP_BASE + endpoint;
  return ses.fetch(url, {
    method: 'GET',
    headers: {
      'Cookie': cookieStr,
      'Accept': 'application/json',
      'Origin': 'https://aap-na.corp.amazon.com',
      'Referer': 'https://aap-na.corp.amazon.com/v2/page/891a81dc-538d-4f10-be93-441545840a24'
    }
  });
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
