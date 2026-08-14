'use strict';
/**
 * vendors/volvo/index.js -- Volvo/ASIST portal orchestrator [V-C]
 * Updated 2026-07-27: full confirmed workflow against volvopg.asist.decisiv.net
 *
 * Confirmed flow (mapped live 2026-07-23 to 2026-07-27):
 *   1. Search by unit number -> resolve vehicle_id
 *   2. Check for existing open/accepted SR (ASIST silently rejects duplicates)
 *   3. Dealer search -> resolve dealer_code
 *   4. Navigate to /fleet/vehicles/{vehicle_id}/request_service/{dealer_code}
 *   5. Fill form via React fiber triggers + DOM events
 *   6. Review gate -> operator approves
 *   7. Submit -> poll for SR number
 *   8. Write relay note + emit vendor:complete
 */

const { VendorWorkflow, sendToAll } = require('../base/vendor-workflow');
const logger = require('../../utils/logger')('volvo');
const { ScraperError, TimeoutError } = require('../../utils/errors');
const { buildFillScript, buildSubmitScript } = require('./field-map');

const PORTAL_HOST    = 'volvopg.asist.decisiv.net';
const PORTAL_URL     = 'https://' + PORTAL_HOST + '/service_requests';
const SUBMIT_TIMEOUT = 90_000;
const POLL_INTERVAL  =  2_000;
const LOAD_TIMEOUT   = 30_000;
const NAV_DELAY      =  1_500;

// ─── URL builders ─────────────────────────────────────────────────────────────

function _searchQS(unitNumber) {
  return 'search_query%5Bfield%5D=unit_number'
    + '&search_query%5Bmodel%5D=vehicle'
    + '&search_query%5Boptions%5D%5Binclude_external%5D=true'
    + '&search_query%5Bquery%5D=' + encodeURIComponent(unitNumber);
}

function buildSearchUrl(unitNumber) {
  return 'https://' + PORTAL_HOST + '/fleet/search?' + _searchQS(unitNumber);
}

function buildDealerSearchUrl(vehicleId, dealerName, dealerCity, dealerState, unitNumber) {
  return 'https://' + PORTAL_HOST + '/fleet/vehicles/' + vehicleId + '/request_service'
    + '?' + _searchQS(unitNumber)
    + '&dealer_query=' + encodeURIComponent(dealerName || '')
    + '&dealer_origin=' + encodeURIComponent((dealerCity || '') + ', ' + (dealerState || 'NJ'))
    + '&dealer_distance=100'
    + '&searching=true'
    + '&dealer_pvn_only=false';
}

function buildSRListUrl(vehicleId) {
  return 'https://' + PORTAL_HOST + '/fleet/vehicles/' + vehicleId + '/service_requests';
}

// ─── Inline JS scripts ────────────────────────────────────────────────────────

const EXTRACT_VEHICLE_SCRIPT = (unitNumber) => (
  '(function(){'
  + 'var u=' + JSON.stringify(String(unitNumber)) + ';'
  + 'var aa=Array.prototype.slice.call(document.querySelectorAll(\'a[href*="/fleet/vehicles/"]\')); '
  + 'var seen={};var matches=[];'
  + 'for(var i=0;i<aa.length;i++){'
  +   'var a=aa[i];'
  +   'var m=(a.getAttribute("href")||"").match(/\/fleet\/vehicles\/(\\d+)/);'
  +   'if(!m||seen[m[1]])continue;'
  +   'seen[m[1]]=true;'
  +   'var row=a.closest("tr")||a.closest("li")||a.parentElement||a;'
  +   'matches.push({vehicleId:m[1],text:(row.textContent||"").trim().replace(/\\s+/g," ").slice(0,200)});'
  + '}'
  + 'var exact=matches.filter(function(x){return x.text.indexOf(u)!==-1;});'
  + 'return{count:matches.length,exactCount:exact.length,exact:exact.slice(0,3),matches:matches.slice(0,5)};'
  + '})()'
);

const CHECK_OPEN_SR_SCRIPT = (
  '(function(){'
  + 'var rows=Array.prototype.slice.call(document.querySelectorAll("table tr"));'
  + 'var open=[];'
  + 'for(var i=0;i<rows.length;i++){'
  +   'var t=(rows[i].textContent||"");'
  +   'if(/(Accepted|Pending|Open|In\\s*Progress)/i.test(t)){'
  +     'var a=rows[i].querySelector("a");'
  +     'open.push({text:t.trim().replace(/\\s+/g," ").slice(0,150),href:a?a.href:""});'
  +   '}'
  + '}'
  + 'return{hasOpen:open.length>0,cases:open.slice(0,5)};'
  + '})()'
);

const EXTRACT_DEALER_SCRIPT = (dealerName, dealerCity) => (
  '(function(){'
  + 'var name=' + JSON.stringify(String(dealerName || '').toLowerCase()) + ';'
  + 'var city=' + JSON.stringify(String(dealerCity || '').toLowerCase()) + ';'
  + 'var links=Array.prototype.slice.call(document.querySelectorAll(\'a[href*="/request_service/"]\')); '
  + 'var matches=[];'
  + 'for(var i=0;i<links.length;i++){'
  +   'var a=links[i];'
  +   'var href=a.getAttribute("href")||"";'
  +   'var m=href.match(/\/request_service\/([A-Z0-9]+)$/i);'
  +   'if(!m)continue;'
  +   'var row=a.closest("tr")||a.parentElement||a;'
  +   'var rowText=(row.textContent||"").toLowerCase();'
  +   'var score=(name&&rowText.indexOf(name)!==-1?2:0)+(city&&rowText.indexOf(city)!==-1?1:0);'
  +   'matches.push({dealerCode:m[1],rowText:rowText.slice(0,150),score:score});'
  + '}'
  + 'matches.sort(function(a,b){return b.score-a.score;});'
  + 'return{count:matches.length,best:matches[0]||null,all:matches.slice(0,5)};'
  + '})()'
);

const READ_SR_SCRIPT = (
  '(function(){'
  + 'var mu=location.href.match(/\/service_requests\/(\\d+)/i);'
  + 'if(mu&&mu[1])return{found:true,srNumber:mu[1]};'
  + 'var t=document.body?document.body.innerText:"";'
  + 'var m=t.match(/Case\\s*#?[:\\s]*(\\d{7,10})/i)||t.match(/\\b(\\d{6,10})\\b/);'
  + 'if(m)return{found:true,srNumber:m[1]};'
  + 'return{found:false,srNumber:null};'
  + '})()'
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _waitForLoad(win, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      win.webContents.removeListener('did-finish-load', onLoad);
      reject(new TimeoutError('volvo: page load timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    function onLoad() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    }
    win.webContents.once('did-finish-load', onLoad);
  });
}

function _sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function _navAndWait(win, url, timeoutMs) {
  win.loadURL(url);
  try { await _waitForLoad(win, timeoutMs); } catch (e) { logger.warn('[volvo] nav non-fatal:', e.message); }
  await _sleep(NAV_DELAY);
}

// ─── Workflow class ───────────────────────────────────────────────────────────

class VolvoWorkflow extends VendorWorkflow {
  constructor() { super('volvo', PORTAL_URL); }

  /**
   * run(unit, altId, options)
   * @param {object}  unit
   * @param {string}  altId              Relay WO reference
   * @param {object}  options
   * @param {Promise} options.approveSignal
   * @param {string}  options.workflowId
   * @param {string}  options.dealerName     e.g. 'Gabrielli'
   * @param {string}  options.dealerCity     e.g. 'Bloomsbury'
   * @param {string}  options.dealerState    e.g. 'NJ'
   * @param {object}  options.fillOpts       { complaint, notes, contact:{firstName,lastName,email,phone}, breakdownCity, breakdownState }
   */
  async run(unit, altId, { approveSignal, workflowId, dealerName, dealerCity, dealerState, fillOpts } = {}) {
    const eqId       = unit.unitNumber || unit.equipmentId || unit.id || 'unknown';
    const unitNumber = eqId;
    logger.info('[volvo][' + (workflowId || '') + '] run() unit:', eqId, 'dealer:', dealerName || 'unspecified');

    // 1. Open portal
    this.progress('opening-portal');
    const { win } = await this.openPortal(buildSearchUrl(unitNumber));

    // 2. Resolve vehicle_id
    this.progress('resolving-vehicle', { unit: eqId });
    let vehicleId = null;
    try {
      const vr = await win.webContents.executeJavaScript(EXTRACT_VEHICLE_SCRIPT(unitNumber));
      logger.info('[volvo] vehicle search:', JSON.stringify(vr || {}));
      if (vr) vehicleId = vr.exactCount > 0 ? vr.exact[0].vehicleId : vr.count > 0 ? vr.matches[0].vehicleId : null;
    } catch (e) { logger.warn('[volvo] vehicle extract:', e.message); }

    if (!vehicleId) {
      this.progress('vehicle-not-found', { unit: eqId });
      this.close();
      throw new ScraperError('volvo: no vehicle found in ASIST for unit ' + unitNumber);
    }
    logger.info('[volvo] vehicleId:', vehicleId);

    // 3. Check for existing open SR (ASIST silently blocks duplicates)
    this.progress('checking-existing-sr', { unit: eqId, vehicleId });
    try {
      await _navAndWait(win, buildSRListUrl(vehicleId), LOAD_TIMEOUT);
      const srCheck = await win.webContents.executeJavaScript(CHECK_OPEN_SR_SCRIPT);
      logger.info('[volvo] SR check:', JSON.stringify(srCheck || {}));
      if (srCheck && srCheck.hasOpen) {
        sendToAll('vendor:duplicate-sr-warning', {
          workflowId, vendor: 'volvo', unit: eqId,
          message: 'Unit ' + eqId + ' has existing open/accepted SR(s). New SR may be rejected by ASIST.',
          cases: srCheck.cases,
        });
        logger.warn('[volvo] open SR exists -- operator warned, proceeding');
      }
    } catch (e) { logger.warn('[volvo] SR check (non-fatal):', e.message); }

    // 4. Dealer search -> resolve dealer_code
    this.progress('resolving-dealer', { unit: eqId, dealerName: dealerName || '' });
    let dealerCode = null;
    if (dealerName) {
      await _navAndWait(win, buildDealerSearchUrl(vehicleId, dealerName, dealerCity || '', dealerState || 'NJ', unitNumber), LOAD_TIMEOUT);
      try {
        const dr = await win.webContents.executeJavaScript(EXTRACT_DEALER_SCRIPT(dealerName, dealerCity || ''));
        logger.info('[volvo] dealer search:', JSON.stringify(dr || {}));
        if (dr && dr.best) dealerCode = dr.best.dealerCode || null;
      } catch (e) { logger.warn('[volvo] dealer extract:', e.message); }
      logger.info('[volvo] dealerCode:', dealerCode || 'not found');
    }

    // 5. Navigate to SR form
    this.progress('loading-sr-form', { unit: eqId, vehicleId, dealerCode: dealerCode || 'none' });
    const srFormUrl = dealerCode
      ? 'https://' + PORTAL_HOST + '/fleet/vehicles/' + vehicleId + '/request_service/' + dealerCode
      : 'https://' + PORTAL_HOST + '/fleet/vehicles/' + vehicleId + '/request_service';
    await _navAndWait(win, srFormUrl, LOAD_TIMEOUT);

    // 6. Fill form
    this.progress('filling-form', { unit: eqId, altId });
    try {
      const fr = await win.webContents.executeJavaScript(buildFillScript(unit, altId, fillOpts || {}));
      logger.info('[volvo] fill:', JSON.stringify(fr || {}));
      // If React contact fields not rendered yet, wait 300ms and retry
      if (fr && !fr.contactFilled) {
        await _sleep(300);
        const fr2 = await win.webContents.executeJavaScript(buildFillScript(unit, altId, fillOpts || {}));
        logger.info('[volvo] fill retry:', JSON.stringify(fr2 || {}));
      }
    } catch (e) { logger.warn('[volvo] fill (non-fatal):', e.message); }

    // 7. Review gate
    sendToAll('vendor:review-ready', {
      workflowId, vendor: 'volvo', unit: eqId, altId: altId || '',
      portalUrl:    win.webContents.getURL(),
      instructions: 'Review pre-filled Volvo/ASIST SR. Click Approve to submit.',
    });
    if (!win.isDestroyed()) win.show();
    this.progress('awaiting-review', { unit: eqId });

    let approveData;
    try {
      approveData = await approveSignal;
    } catch (cancelErr) {
      logger.info('[volvo] cancelled | unit:', eqId);
      this.progress('cancelled', { unit: eqId });
      this.close();
      throw cancelErr;
    }
    if (!approveData || !approveData.approved) { this.close(); throw new Error('volvo: approved=false'); }
    const finalAltId = approveData.altId || altId;

    // 8. Submit
    this.progress('submitting', { unit: eqId, altId: finalAltId });
    if (win.isDestroyed()) throw new ScraperError('volvo: window closed before submit');
    try {
      const cr = await win.webContents.executeJavaScript(buildSubmitScript());
      logger.info('[volvo] submit:', JSON.stringify(cr || {}));
      if (cr && !cr.clicked) logger.warn('[volvo] submit not clicked:', JSON.stringify(cr));
    } catch (e) { logger.warn('[volvo] submit (non-fatal):', e.message); }

    // 9. Poll for SR number
    this.progress('polling-sr-number', { unit: eqId });
    const srNumber = await this._pollForSrNumber(win);
    const srUrl    = win.isDestroyed() ? '' : win.webContents.getURL();
    logger.info('[volvo] SR:', srNumber, '| url:', srUrl.slice(0, 80));
    this.progress('sr-created', { unit: eqId, srNumber, srUrl });

    // 10. Relay note
    await this._writeToRelay(unit, finalAltId, srNumber, srUrl)
      .catch(e => logger.warn('[volvo] relay note (non-fatal):', e.message));

    // 11. Complete
    sendToAll('vendor:complete', {
      workflowId, vendor: 'volvo', unit: eqId,
      altId: finalAltId, srNumber, srUrl,
      dealerCode: dealerCode || '', dealerName: dealerName || '',
    });
    this.progress('complete', { unit: eqId, srNumber, srUrl });
    this.close();
    return { srNumber, srUrl };
  }

  async _pollForSrNumber(win) {
    const deadline = Date.now() + SUBMIT_TIMEOUT;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) throw new ScraperError('volvo: window closed while polling');
      let r = { found: false };
      try { r = await win.webContents.executeJavaScript(READ_SR_SCRIPT); } catch (_) {}
      if (r && r.found && r.srNumber) return r.srNumber;
      await _sleep(POLL_INTERVAL);
    }
    throw new TimeoutError('volvo: SR number not found after ' + (SUBMIT_TIMEOUT / 1000) + 's');
  }

  async _writeToRelay(unit, altId, srNumber, srUrl) {
    if (!unit.workRequestId && !unit.serviceUrl) return;
    try {
      const mod = require('../../scrapers/aap_create_wr');
      if (typeof mod.addConversationNote !== 'function') return;
      const note = 'Volvo/ASIST SR Created: ' + srNumber
        + (srUrl ? ' | ' + srUrl : '')
        + ' | Relay Ref: ' + (altId || '');
      await mod.addConversationNote(unit.workRequestId || unit.serviceUrl, note);
      logger.info('[volvo] relay note | SR:', srNumber);
    } catch (e) { logger.warn('[volvo] relay note (non-fatal):', e.message); }
  }
}

module.exports = VolvoWorkflow;