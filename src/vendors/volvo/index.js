'use strict';
/**
 * vendors/volvo/index.js -- Volvo/ASIST portal orchestrator [V-C]
 * S23-5 (2026-06-28): Volvo trucks via volvopg.asist.decisiv.net (Decisiv SRM v8.40.2)
 * Session isolated to persist:vendor-volvo.
 *
 * Mirrors PACCAR (S23-4) with Volvo-specific:
 *   - Portal subdomain + persist:vendor-volvo partition
 *   - ASIST case number pattern (C-XXXXXXXX or SR-XXXXXXX)
 *   - chassis_number / fleet_number field name fallbacks (ASIST profile)
 *   - Volvo dealer reference in conversation note
 *
 * approveSignal: Promise from S23-3 IPC router.
 *   Resolves { approved:true, altId? } on vendor:approve
 *   Rejects (CANCELLED) on vendor:cancel
 */

const { VendorWorkflow, sendToAll } = require('../base/vendor-workflow');
const logger   = require('../../utils/logger')('volvo');
const { ScraperError, TimeoutError } = require('../../utils/errors');
const { buildFillScript }  = require('./field-map');
const { enrichVolvoAsist } = require('../../scrapers/asist_enrich'); // S25-12: dealer name

const PORTAL_URL     =  'https://volvopg.asist.decisiv.net/service_requests';
const PORTAL_HOST    = 'volvopg.asist.decisiv.net';
const NEW_SR_PATH    = '/service_requests/new';
const SUBMIT_TIMEOUT = 90_000;
const POLL_INTERVAL  =  2_000;

// DOM fill script -- Decisiv SRM v8.40.2 Volvo/ASIST profile field names
// Uses HTMLInputElement.prototype.value setter so React state updates.
// ASIST case numbers: C-XXXXXXXX (primary), SR-XXXXXXX (Decisiv fallback), ASIST-XXXXXXXX (portal header)
const READ_CASE_SCRIPT = (
  '(function(){'
  + 'var t=document.body?document.body.innerText:"";'
  + 'var m=t.match(/\\b(C-\\d{6,10}|SR-\\d{5,10}|ASIST-\\d{6,12})\\b/i);'
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

class VolvoWorkflow extends VendorWorkflow {
  constructor() { super('volvo', PORTAL_URL); }

  async run(unit, altId, { approveSignal, workflowId } = {}) {
    const eqId = unit.equipmentId || unit.id || 'unknown';
    logger.info('[volvo][' + (workflowId || '') + '] run() | unit:', eqId, '| altId:', altId);

    // 1. Open portal (auto-login handled by base class)
    this.progress('opening-portal');
    const { win } = await this.openPortal('https://' + PORTAL_HOST + NEW_SR_PATH);

    // 2. Fill new SR form
    this.progress('filling-form', { unit: eqId, altId });
    try {
      const fr = await win.webContents.executeJavaScript(buildFillScript(unit, altId));
      logger.info('[volvo] fill:', JSON.stringify(fr || {}));
    } catch (e) { logger.warn('[volvo] fill error (non-fatal):', e.message); }

    // 3. Review gate -- emit review-ready, show window, await operator signal
    sendToAll('vendor:review-ready', {
      workflowId, vendor: 'volvo', unit: eqId, altId: altId || '',
      portalUrl:    win.webContents.getURL(),
      instructions: 'Review pre-filled Volvo/ASIST SR. Click Approve in Orcha to submit.',
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
    if (!approveData || !approveData.approved) {
      this.close();
      throw new Error('volvo: approved=false in approve signal');
    }

    const finalAltId = approveData.altId || altId;
    this.progress('submitting', { unit: eqId, altId: finalAltId });

    // 4. Submit
    if (win.isDestroyed()) throw new ScraperError('volvo: window closed before submit');
    try {
      const cr = await win.webContents.executeJavaScript(CLICK_SUBMIT);
      logger.info('[volvo] submit click:', JSON.stringify(cr || {}));
    } catch (e) { logger.warn('[volvo] submit click error:', e.message); }

    // 5. Poll for case number
    this.progress('polling-case-number', { unit: eqId });
    const caseNumber = await this._pollForCaseNumber(win);
    const caseUrl    = win.isDestroyed() ? '' : win.webContents.getURL();
    logger.info('[volvo] case:', caseNumber, '| url:', caseUrl.slice(0, 80));
    this.progress('case-created', { unit: eqId, caseNumber, caseUrl });

    // S25-12: best-effort dealer name from ASIST SR/case page
    let dealerName = '';
    try {
      const _srUrl = unit.asistSrUrl || unit.offsiteShopEventUrl || '';
      if (_srUrl) {
        const _ae = await enrichVolvoAsist(_srUrl);
        if (_ae && _ae.dealer) { dealerName = _ae.dealer; logger.info('[volvo] dealer:', dealerName); }
      }
    } catch (e) { logger.warn('[volvo] dealer scrape (non-fatal):', e.message); }

    // 6. Best-effort relay note
    await this._writeToRelay(unit, finalAltId, caseNumber, caseUrl)
      .catch(e => logger.warn('[volvo] relay write (non-fatal):', e.message));

    // 7. Complete
    sendToAll('vendor:complete', {
      workflowId, vendor: 'volvo', unit: eqId,
      altId: finalAltId, caseNumber, caseUrl, dealerName,
    });
    this.progress('complete', { unit: eqId, caseNumber, caseUrl });
    this.close();
    return { caseNumber, caseUrl };
  }

  async _pollForCaseNumber(win) {
    const deadline = Date.now() + SUBMIT_TIMEOUT;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) throw new ScraperError('volvo: window closed while polling');
      let r = { found: false };
      try { r = await win.webContents.executeJavaScript(READ_CASE_SCRIPT); } catch (_) {}
      if (r && r.found && r.srNumber) return r.srNumber;
      await new Promise(res => setTimeout(res, POLL_INTERVAL));
    }
    throw new TimeoutError('volvo: case number not found after ' + (SUBMIT_TIMEOUT / 1000) + 's');
  }

  async _writeToRelay(unit, altId, caseNumber, caseUrl) {
    if (!unit.workRequestId && !unit.serviceUrl) return;
    const mod = require('../../scrapers/aap_create_wr');
    if (typeof mod.addConversationNote !== 'function') return;
    const note = 'Volvo/ASIST Case Created: ' + caseNumber
      + (caseUrl ? ' | ' + caseUrl : '') + ' | Relay Ref: ' + (altId || '');
    await mod.addConversationNote(unit.workRequestId || unit.serviceUrl, note);
    logger.info('[volvo] Relay note written | case:', caseNumber);
  }
}

module.exports = VolvoWorkflow;
