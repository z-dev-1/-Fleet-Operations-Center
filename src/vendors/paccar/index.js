'use strict';
/**
 * vendors/paccar/index.js -- PACCAR portal orchestrator [V-C]
 * S23-4 (2026-06-28): Kenworth/Peterbilt via paccarpg.decisiv.net (Decisiv SRM v8.40.2)
 * Session isolated to persist:vendor-paccar.
 *
 * Workflow:
 *   1. openPortal()     -- BrowserWindow + auto-login -> new SR form
 *   2. fillForm()       -- pre-fill unit/VIN/altId/mileage via React setter trick
 *   3. reviewGate()     -- emit vendor:review-ready, show window, await approveSignal
 *   4. submit()         -- click Submit button
 *   5. pollSrNumber()   -- poll DOM/URL for SR number (SR-XXXXXXX / PCSR-XXXXXXXX)
 *   6. writeToRelay()   -- best-effort note on Relay WR conversation
 *   7. vendor:complete
 *
 * approveSignal: Promise from S23-3 IPC router.
 *   Resolves { approved:true, altId? } on vendor:approve
 *   Rejects (CANCELLED) on vendor:cancel
 */

const { VendorWorkflow, sendToAll } = require('../base/vendor-workflow');
const logger   = require('../../utils/logger')('paccar');
const { ScraperError, TimeoutError } = require('../../utils/errors');
const { buildFillScript }  = require('./field-map');

const PORTAL_URL     =  'https://paccarpg.decisiv.net/service_requests';
const PORTAL_HOST    = 'paccarpg.decisiv.net';
const NEW_SR_PATH    = '/service_requests/new';
const SUBMIT_TIMEOUT = 90_000;
const POLL_INTERVAL  =  2_000;

// DOM fill script -- Decisiv SRM v8.40.2 React-controlled fields
// Uses HTMLInputElement.prototype.value setter so React state updates.
// SR number patterns: SR-XXXXXXX (Decisiv) or PCSR-XXXXXXXX (PACCAR portal variant)
const READ_SR_SCRIPT = (
  '(function(){'
  + 'var t=document.body?document.body.innerText:"";'
  + 'var m=t.match(/\\b(SR-\\d{5,10}|PCSR-\\d{6,12})\\b/i);'
  + 'if(m)return{found:true,srNumber:m[1]};'
  + 'var mu=location.href.match(/\\/service_requests\\/([^/?#]+)/i);'
  + 'if(mu&&mu[1]&&mu[1]!=="new")return{found:true,srNumber:mu[1]};'
  + 'return{found:false,srNumber:null};'
  + '})()'
);

const CLICK_SUBMIT = (
  '(function(){'
  + 'var SS=["button[type=submit]","[data-action=submit]","[data-action=save]","button.btn-primary","input[type=submit]"];'
  + 'for(var i=0;i<SS.length;i++){var b=document.querySelector(SS[i]);if(b&&!b.disabled){b.click();return{clicked:true,label:b.textContent.trim().slice(0,40)};}}'
  + 'return{clicked:false};'
  + '})()'
);


// S25-12: scrape servicing dealer name from Decisiv SR page (best-effort)
const READ_DEALER_SCRIPT = (
  '(function(){'+
  'var b=document.body?document.body.innerText:"";'+
  'function rf(lb){var i=b.indexOf(lb);if(i<0)return"";return b.slice(i+lb.length,i+lb.length+120).split("\n")[0].replace(/^\s*:\s/,"").trim().slice(0,80);}'+
  'var d=rf("Dealer")||rf("Location")||rf("Service Location")||rf("Shop");'+
  'return{dealer:d};' +
  '})()'
);


class PACCARWorkflow extends VendorWorkflow {
  constructor() { super('paccar', PORTAL_URL); }

  async run(unit, altId, { approveSignal, workflowId } = {}) {
    const eqId = unit.equipmentId || unit.id || 'unknown';
    logger.info('[paccar][' + (workflowId || '') + '] run() | unit:', eqId, '| altId:', altId);

    // 1. Open portal (auto-login handled by base class)
    this.progress('opening-portal');
    const { win } = await this.openPortal('https://' + PORTAL_HOST + NEW_SR_PATH);

    // 2. Fill new SR form
    this.progress('filling-form', { unit: eqId, altId });
    try {
      const fr = await win.webContents.executeJavaScript(buildFillScript(unit, altId));
      logger.info('[paccar] fill:', JSON.stringify(fr || {}));
    } catch (e) { logger.warn('[paccar] fill error (non-fatal):', e.message); }

    // 3. Review gate -- emit review-ready, show window, await operator signal
    sendToAll('vendor:review-ready', {
      workflowId, vendor: 'paccar', unit: eqId, altId: altId || '',
      portalUrl:    win.webContents.getURL(),
      instructions: 'Review pre-filled PACCAR SR. Click Approve in Orcha to submit.',
    });
    if (!win.isDestroyed()) win.show();
    this.progress('awaiting-review', { unit: eqId });

    let approveData;
    try {
      approveData = await approveSignal;
    } catch (cancelErr) {
      logger.info('[paccar] cancelled | unit:', eqId);
      this.progress('cancelled', { unit: eqId });
      this.close();
      throw cancelErr;
    }
    if (!approveData || !approveData.approved) {
      this.close();
      throw new Error('paccar: approved=false in approve signal');
    }

    const finalAltId = approveData.altId || altId;
    this.progress('submitting', { unit: eqId, altId: finalAltId });

    // 4. Submit
    if (win.isDestroyed()) throw new ScraperError('paccar: window closed before submit');
    try {
      const cr = await win.webContents.executeJavaScript(CLICK_SUBMIT);
      logger.info('[paccar] submit click:', JSON.stringify(cr || {}));
    } catch (e) { logger.warn('[paccar] submit click error:', e.message); }

    // 5. Poll for SR number
    this.progress('polling-sr-number', { unit: eqId });
    const srNumber = await this._pollForSrNumber(win);
    const caseUrl  = win.isDestroyed() ? '' : win.webContents.getURL();
    logger.info('[paccar] SR:', srNumber, '| url:', caseUrl.slice(0, 80));
    this.progress('sr-created', { unit: eqId, srNumber, caseUrl });

    // S25-12: best-effort dealer name scrape from SR page
    let dealerName = '';
    try {
      if (!win.isDestroyed()) {
        const dr = await win.webContents.executeJavaScript(READ_DEALER_SCRIPT);
        if (dr && dr.dealer) { dealerName = dr.dealer; logger.info('[paccar] dealer:', dealerName); }
      }
    } catch (e) { logger.warn('[paccar] dealer scrape (non-fatal):', e.message); }

    // 6. Best-effort relay note
    await this._writeToRelay(unit, finalAltId, srNumber, caseUrl)
      .catch(e => logger.warn('[paccar] relay write (non-fatal):', e.message));

    // 7. Complete
    sendToAll('vendor:complete', {
      workflowId, vendor: 'paccar', unit: eqId,
      altId: finalAltId, caseNumber: srNumber, caseUrl, dealerName,
    });
    this.progress('complete', { unit: eqId, srNumber, caseUrl });
    this.close();
    return { caseNumber: srNumber, caseUrl };
  }

  async _pollForSrNumber(win) {
    const deadline = Date.now() + SUBMIT_TIMEOUT;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) throw new ScraperError('paccar: window closed while polling');
      let r = { found: false };
      try { r = await win.webContents.executeJavaScript(READ_SR_SCRIPT); } catch (_) {}
      if (r && r.found && r.srNumber) return r.srNumber;
      await new Promise(res => setTimeout(res, POLL_INTERVAL));
    }
    throw new TimeoutError('paccar: SR number not found after ' + (SUBMIT_TIMEOUT / 1000) + 's');
  }

  async _writeToRelay(unit, altId, srNumber, caseUrl) {
    if (!unit.workRequestId && !unit.serviceUrl) return;
    const mod = require('../../scrapers/aap_create_wr');
    if (typeof mod.addConversationNote !== 'function') return;
    const note = 'PACCAR SR Created: ' + srNumber
      + (caseUrl ? ' | ' + caseUrl : '') + ' | Relay Ref: ' + (altId || '');
    await mod.addConversationNote(unit.workRequestId || unit.serviceUrl, note);
    logger.info('[paccar] Relay note written | SR:', srNumber);
  }
}

module.exports = PACCARWorkflow;
