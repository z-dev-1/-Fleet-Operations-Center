'use strict';
/**
 * vendors/paccar/index.js -- PACCAR portal orchestrator [V-C]
 * S23-4 (2026-06-28): Kenworth/Peterbilt via pssmfleet.decisiv.net (Decisiv SRM, tenant AMZN)
 * Session isolated to persist:vendor-paccar.
 *
 * BUGFIX (2026-07-26): real portal host is pssmfleet.decisiv.net, not
 * paccarpg.decisiv.net, and is search-first like Volvo. The request-service
 * URL pattern is unconfirmed for this portal, so step 2 navigates to the
 * real href found on the search-results row instead of a reconstructed URL.
 *
 * Workflow:
 *   1. openPortal()       -- BrowserWindow + auto-login -> search results
 *   2. resolveTarget()    -- extract + navigate to real vehicle/SR link from results
 *   3. fillForm()         -- drives the real request-service form sequence:
 *        city/state -> dealer -> advance -> appointment date -> ack checkbox
 *        -> ad-hoc contact popup (name/phone/email) -> issue details.
 *        Values come from formData (Contact Book + User Profile, resolved
 *        by the Dealer WO review modal) when provided, else best-effort
 *        fallback to unit-derived values.
 *   4. reviewGate()       -- emit vendor:review-ready, show window, await operator signal
 *   5. submit()           -- click Submit button
 *   6. pollSrNumber()     -- poll DOM/URL for SR number (SR-XXXXXXX / PCSR-XXXXXXXX)
 *   7. writeToRelay()     -- best-effort note on Relay WR conversation
 *   8. vendor:complete
 *
 * approveSignal: Promise from S23-3 IPC router.
 *   Resolves { approved:true, altId? } on vendor:approve
 *   Rejects (CANCELLED) on vendor:cancel
 */

const { VendorWorkflow, sendToAll } = require('../base/vendor-workflow');
const logger   = require('../../utils/logger')('paccar');
const { ScraperError, TimeoutError } = require('../../utils/errors');

// BUGFIX (2026-07-26): the real PACCAR portal is pssmfleet.decisiv.net, NOT
// paccarpg.decisiv.net -- and (like Volvo) it's search-first: you search by
// unit number, then click into the specific vehicle's service-request page.
// Unlike Volvo, the confirmed request_service URL pattern for this portal
// is NOT known yet, so instead of reconstructing a URL we extract the real
// href(s) from the search-results row and navigate to whatever the portal
// itself gives us. Every candidate is logged so a wrong pick is diagnosable
// from the logs alone, same pattern used to fix the Volvo flow.
const PORTAL_URL     =  'https://pssmfleet.decisiv.net/t/AMZN/search';
const PORTAL_HOST    = 'pssmfleet.decisiv.net';
const TENANT         = 'AMZN';
const SUBMIT_TIMEOUT = 90_000;
const POLL_INTERVAL  =  2_000;
const LOAD_TIMEOUT   = 30_000;

function buildSearchUrl(unitNumber) {
  return 'https://' + PORTAL_HOST + '/t/' + TENANT + '/search?query=' + encodeURIComponent(unitNumber);
}

// The row-level "open this unit" control is an icon button (SVG inside a
// button), not a plain <a href> -- confirmed live selector:
//   .eHLOTE > div:nth-child(1) > button:nth-child(1) > span:nth-child(1) > svg:nth-child(1)
// .eHLOTE is a per-row wrapper class; since we search by exact unit number
// there's normally exactly one result row, so this resolves unambiguously.
// Click the <button> ancestor (SVG itself isn't a click target).
const ACTION_BUTTON_SELECTOR = '.eHLOTE > div:nth-child(1) > button:nth-child(1)';

const CLICK_ACTION_SCRIPT = (
  '(function(){'
  + 'var sel=' + JSON.stringify(ACTION_BUTTON_SELECTOR) + ';'
  + 'var btn=document.querySelector(sel);'
  + 'if(btn){btn.click();return{clicked:true,selector:sel};}'
  + 'return{clicked:false,selector:sel};'
  + '})()'
);

// Fallback diagnostic only -- used if the confirmed selector above doesn't
// match (portal DOM changed), so a fix is derivable from logs alone. Finds
// the row(s) whose text contains the unit number and dumps every anchor AND
// button (with label) inside that row.
const EXTRACT_ROW_SCRIPT = (unitNumber) => (
  '(function(){'
  + 'var unitNum=' + JSON.stringify(String(unitNumber)) + ';'
  + 'var all=Array.prototype.slice.call(document.querySelectorAll("tr,li"));'
  + 'var rows=[];'
  + 'for(var i=0;i<all.length;i++){'
  +   'var el=all[i];'
  +   'var txt=(el.textContent||"").trim().replace(/\s+/g," ");'
  +   'if(txt.indexOf(unitNum)===-1)continue;'
  +   'var anchors=Array.prototype.slice.call(el.querySelectorAll("a[href]"));'
  +   'var buttons=Array.prototype.slice.call(el.querySelectorAll("button"));'
  +   'rows.push({text:txt.slice(0,200),'
  +     'links:anchors.map(function(a){return{href:a.getAttribute("href"),label:(a.textContent||"").trim().slice(0,60)};}),'
  +     'buttons:buttons.map(function(b,bi){return{index:bi,label:(b.textContent||"").trim().slice(0,60),cls:b.className};})'
  +   '});'
  + '}'
  + 'return {rowCount:rows.length,rows:rows.slice(0,5)};'
  + '})()'
);


// ── Request-service form fill sequence (confirmed live by the user, exact
// selectors from the real pssmfleet.decisiv.net DOM) ───────────────────────
//   #input-field-target-111                        city/state (Contact Book: Domiciles)
//   #input-field-target-112                        dealer     (Contact Book: Vendors)
//   .jUvqIE > div:nth-child(4) > div:nth-child(1) > button:nth-child(1)   advance
//   #select-date-113                                appointment date (mechanics unconfirmed --
//                                                    best-effort, see _selectAppointmentDate)
//   .jkBRFb > label:nth-child(2) > div:nth-child(1) ack checkbox (meaning unconfirmed)
//   .EditAppointmentContact__AddAdhocContactButton-sc-1ns93os-0   opens ad-hoc-contact popup
//     #input-field-target-241        first name (User Profile, left-padded to 3 chars min)
//     #input-field-target-243-label  last name  (User Profile)
//     #input-field-target-245-label  phone      (User Profile)
//     #input-field-target-247        email      (User Profile)
//   .gcHUHI                          save contact -> popup closes
//   #input-field-target-125          issue details (unit data)
// Final submit (.euVa-DA > div:nth-child(1) > button:nth-child(1)) fires
// AFTER the review gate/approveSignal -- see CLICK_FINAL_SUBMIT below.
const SEL_CITY_STATE     = '#input-field-target-111';
const SEL_DEALER         = '#input-field-target-112';
const SEL_ADVANCE_BTN    = '.jUvqIE > div:nth-child(4) > div:nth-child(1) > button:nth-child(1)';
const SEL_DATE_TRIGGER   = '#select-date-113';
const SEL_ACK_CHECKBOX   = '.jkBRFb > label:nth-child(2) > div:nth-child(1)';
const SEL_ADD_CONTACT    = '.EditAppointmentContact__AddAdhocContactButton-sc-1ns93os-0';
const SEL_CONTACT_FIRST  = '#input-field-target-241';
const SEL_CONTACT_LAST   = '#input-field-target-243-label';
const SEL_CONTACT_PHONE  = '#input-field-target-245-label';
const SEL_CONTACT_EMAIL  = '#input-field-target-247';
const SEL_SAVE_CONTACT   = '.gcHUHI';
const SEL_ISSUE_DETAILS  = '#input-field-target-125';
const SEL_FINAL_SUBMIT   = '.euVa-DA > div:nth-child(1) > button:nth-child(1)';

// React-controlled-input setter -- same trick used elsewhere in this codebase
// (src/orcha/auto-login.js _fillScript): use the native value setter so
// React's onChange actually fires, then dispatch input/change for good
// measure.
function _setValueScript(selector, value) {
  return (
    '(function(){'
    + 'var sel=' + JSON.stringify(selector) + ';'
    + 'var val=' + JSON.stringify(String(value == null ? '' : value)) + ';'
    + 'var el=document.querySelector(sel);'
    + 'if(!el)return{ok:false,selector:sel,reason:"not-found"};'
    + 'el.focus();'
    + 'var proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;'
    + 'var setter=Object.getOwnPropertyDescriptor(proto,"value");'
    + 'if(setter&&setter.set){setter.set.call(el,val);}else{el.value=val;}'
    + 'el.dispatchEvent(new Event("input",{bubbles:true}));'
    + 'el.dispatchEvent(new Event("change",{bubbles:true}));'
    + 'return{ok:true,selector:sel};'
    + '})()'
  );
}

function _clickScript(selector) {
  return (
    '(function(){'
    + 'var sel=' + JSON.stringify(selector) + ';'
    + 'var el=document.querySelector(sel);'
    + 'if(!el)return{ok:false,selector:sel,reason:"not-found"};'
    + 'el.click();'
    + 'return{ok:true,selector:sel};'
    + '})()'
  );
}

function _existsScript(selector) {
  return '(function(){return !!document.querySelector(' + JSON.stringify(selector) + ');})()';
}

// BUGFIX-PENDING (2026-07-26): #select-date-113's exact interaction
// mechanics (native date input vs. click-to-open custom calendar widget)
// were not confirmed by the user -- only the trigger selector was given.
// Best-effort strategy, fully logged so a wrong guess is fixable from logs
// alone: try setting the value directly first (covers the native-input
// case); if that reports "not-found"/no visible change, click the trigger
// to open whatever picker appears, then look for a day-of-month cell
// matching the target date and click it. The live review gate (portal
// window shown before Approve) is the safety net if this guesses wrong --
// the operator can fix the date by hand before approving.
function _dayOfMonthClickScript(dateStr) {
  const day = String(new Date(dateStr + 'T00:00:00').getDate());
  return (
    '(function(){'
    + 'var day=' + JSON.stringify(day) + ';'
    + 'var cands=Array.prototype.slice.call(document.querySelectorAll('
    +   '"[role=gridcell],[class*=Day],[class*=day],td,button"));'
    + 'var matches=[];'
    + 'for(var i=0;i<cands.length;i++){'
    +   'var el=cands[i];'
    +   'var txt=(el.textContent||"").trim();'
    +   'if(txt!==day)continue;'
    +   'var cls=el.className||"";'
    +   'var disabled=/disabled|outside|blocked/i.test(cls)||el.disabled;'
    +   'matches.push({text:txt,cls:String(cls).slice(0,80),disabled:!!disabled,tag:el.tagName});'
    + '}'
    + 'var pick=null;'
    + 'for(var j=0;j<matches.length;j++){if(!matches[j].disabled){pick=cands.filter(function(c){'
    +   'return (c.textContent||"").trim()===day;'
    + '})[j];break;}}'
    + 'if(pick){pick.click();return{clicked:true,day:day,candidateCount:matches.length,candidates:matches.slice(0,8)};}'
    + 'return{clicked:false,day:day,candidateCount:matches.length,candidates:matches.slice(0,8)};'
    + '})()'
  );
}

const CLICK_FINAL_SUBMIT = _clickScript(SEL_FINAL_SUBMIT);

// Defense-in-depth: dealer-wo-modal.js already left-pads first names below
// 3 chars before sending formData (Decisiv's ad-hoc-contact form silently
// rejects/mangles shorter values -- confirmed live by the user), but pad
// again here in case formData ever arrives from a caller that didn't.
function _padName3(name) {
  const s = String(name || '').trim();
  if (s.length >= 3) return s;
  return ' '.repeat(3 - s.length) + s;
}

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

  async run(unit, altId, { approveSignal, workflowId, formData } = {}) {
    const eqId = unit.equipmentId || unit.id || 'unknown';
    logger.info('[paccar][' + (workflowId || '') + '] run() | unit:', eqId, '| altId:', altId);

    const unitNumber = unit.unitNumber || unit.unit_number || eqId;

    // 1. Open the search-results page (auto-login handled by base class)
    this.progress('opening-portal');
    const { win } = await this.openPortal(buildSearchUrl(unitNumber));

    // 2. Click the row's action button (confirmed selector -- see
    // ACTION_BUTTON_SELECTOR). This may be a full navigation or an in-page
    // SPA route change, so we don't assume did-finish-load will fire --
    // instead poll for either a URL change or the click failing outright.
    this.progress('resolving-vehicle', { unit: eqId });
    const searchUrl = win.webContents.getURL();
    let clickResult = { clicked: false };
    try {
      clickResult = await win.webContents.executeJavaScript(CLICK_ACTION_SCRIPT);
      logger.info('[paccar] action click:', JSON.stringify(clickResult || {}));
    } catch (e) { logger.warn('[paccar] action click error:', e.message); }

    if (!clickResult || !clickResult.clicked) {
      // Selector didn't match -- dump row diagnostics so a fix is derivable
      // from the logs without needing another live round trip for basics.
      try {
        const vr = await win.webContents.executeJavaScript(EXTRACT_ROW_SCRIPT(unitNumber));
        logger.warn('[paccar] action button not found -- row diagnostics:', JSON.stringify(vr || {}));
      } catch (_) { /* non-fatal */ }
      this.progress('vehicle-not-found', { unit: eqId, unitNumber });
      this.close();
      throw new ScraperError('paccar: could not find/click the service-request action button for unit ' + unitNumber);
    }

    const navResult = await this._waitForNavOrChange(win, searchUrl, LOAD_TIMEOUT);
    logger.info('[paccar] post-click nav:', JSON.stringify(navResult), '| unit:', unitNumber);

    // 3. Fill request-service form -- exact selector sequence (see block
    // above); non-fatal per-step so one bad guess (date widget, checkbox)
    // doesn't block the rest -- the review gate below is the safety net.
    this.progress('filling-form', { unit: eqId, altId });
    try {
      await this._fillRequestServiceForm(win, unit, formData || {});
    } catch (e) { logger.warn('[paccar] fill sequence error (non-fatal):', e.message); }

    // 4. Review gate -- emit review-ready, show window, await operator signal
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

    // 5. Submit -- confirmed selector first (SEL_FINAL_SUBMIT), generic
    // fallback selector list second (covers a portal DOM change/different
    // page state) so a submit attempt is always made either way.
    if (win.isDestroyed()) throw new ScraperError('paccar: window closed before submit');
    try {
      let cr = await win.webContents.executeJavaScript(CLICK_FINAL_SUBMIT);
      logger.info('[paccar] submit click (confirmed selector):', JSON.stringify(cr || {}));
      if (!cr || !cr.ok) {
        cr = await win.webContents.executeJavaScript(CLICK_SUBMIT);
        logger.info('[paccar] submit click (fallback selector):', JSON.stringify(cr || {}));
      }
    } catch (e) { logger.warn('[paccar] submit click error:', e.message); }

    // 6. Poll for SR number
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

    // 7. Best-effort relay note
    await this._writeToRelay(unit, finalAltId, srNumber, caseUrl)
      .catch(e => logger.warn('[paccar] relay write (non-fatal):', e.message));

    // 8. Complete
    sendToAll('vendor:complete', {
      workflowId, vendor: 'paccar', unit: eqId,
      altId: finalAltId, caseNumber: srNumber, caseUrl, dealerName,
    });
    this.progress('complete', { unit: eqId, srNumber, caseUrl });
    this.close();
    return { caseNumber: srNumber, caseUrl };
  }

  // Waits until the window's URL changes from fromUrl (full navigation), OR
  // gives up after timeoutMs (still fine -- an SPA route change with no URL
  // change is possible; the fill step that follows is best-effort anyway and
  // the review gate lets the operator confirm/fix before submit).
  async _waitForNavOrChange(win, fromUrl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) throw new ScraperError('paccar: window closed while waiting for navigation');
      let cur = '';
      try { cur = win.webContents.getURL(); } catch (_) { /* ignore */ }
      if (cur && cur !== fromUrl) return { changed: true, url: cur };
      await new Promise(res => setTimeout(res, 500));
    }
    return { changed: false, url: fromUrl };
  }

  // Waits up to timeoutMs for a selector to appear (positive=true) or
  // disappear (positive=false). Used around the ad-hoc-contact popup, which
  // is an in-page React modal, not a new BrowserWindow.
  async _waitForSelectorState(win, selector, positive, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) return false;
      let exists = false;
      try { exists = !!(await win.webContents.executeJavaScript(_existsScript(selector))); } catch (_) {}
      if (exists === positive) return true;
      await new Promise(res => setTimeout(res, 300));
    }
    return false;
  }

  async _step(win, label, script) {
    try {
      const r = await win.webContents.executeJavaScript(script);
      logger.info('[paccar] fill-step ' + label + ':', JSON.stringify(r || {}));
      return r;
    } catch (e) {
      logger.warn('[paccar] fill-step ' + label + ' error (non-fatal):', e.message);
      return { ok: false, error: e.message };
    }
  }

  // Best-effort appointment-date selection -- see BUGFIX-PENDING note above
  // _dayOfMonthClickScript. Tries direct value-set first (native input
  // case), then click-to-open + day-cell click (custom widget case).
  async _selectAppointmentDate(win, dateStr) {
    if (!dateStr) return;
    const direct = await this._step(win, 'date-direct-set', _setValueScript(SEL_DATE_TRIGGER, dateStr));
    if (direct && direct.ok) return;
    await this._step(win, 'date-open-trigger', _clickScript(SEL_DATE_TRIGGER));
    await new Promise(res => setTimeout(res, 400));
    await this._step(win, 'date-day-click', _dayOfMonthClickScript(dateStr));
  }

  async _fillRequestServiceForm(win, unit, formData) {
    const fd = formData || {};
    const cityState = fd.cityState || [unit.domicileCity, unit.domicileState].filter(Boolean).join(', ');
    const dealer     = fd.dealer    || unit.relayVendor || unit.vendor || '';
    const issue       = fd.issue     || unit.issueDetails || unit.pmStatus || unit.issueSummary || '';
    const date        = fd.date      || new Date().toISOString().slice(0, 10);
    const ackCheck    = fd.ackCheck !== false; // default true unless explicitly unchecked
    const firstName   = fd.firstName || '';
    const lastName    = fd.lastName  || '';
    const phone        = fd.phone     || '';
    const email        = fd.email     || '';

    await this._step(win, 'city-state', _setValueScript(SEL_CITY_STATE, cityState));
    await this._step(win, 'dealer', _setValueScript(SEL_DEALER, dealer));
    await this._step(win, 'advance', _clickScript(SEL_ADVANCE_BTN));
    await new Promise(res => setTimeout(res, 500));

    await this._selectAppointmentDate(win, date);

    if (ackCheck) {
      await this._step(win, 'ack-checkbox', _clickScript(SEL_ACK_CHECKBOX));
    } else {
      logger.info('[paccar] fill-step ack-checkbox: skipped (formData.ackCheck=false)');
    }

    // Ad-hoc contact popup (in-page React modal, not a new BrowserWindow)
    await this._step(win, 'open-contact-popup', _clickScript(SEL_ADD_CONTACT));
    const popupOpened = await this._waitForSelectorState(win, SEL_CONTACT_FIRST, true, 8000);
    if (!popupOpened) {
      logger.warn('[paccar] fill-step contact-popup: did not appear within timeout -- skipping contact fields');
    } else {
      await this._step(win, 'contact-first-name', _setValueScript(SEL_CONTACT_FIRST, _padName3(firstName)));
      await this._step(win, 'contact-last-name', _setValueScript(SEL_CONTACT_LAST, lastName));
      await this._step(win, 'contact-phone', _setValueScript(SEL_CONTACT_PHONE, phone));
      await this._step(win, 'contact-email', _setValueScript(SEL_CONTACT_EMAIL, email));
      await this._step(win, 'save-contact', _clickScript(SEL_SAVE_CONTACT));
      await this._waitForSelectorState(win, SEL_CONTACT_FIRST, false, 5000);
    }

    await this._step(win, 'issue-details', _setValueScript(SEL_ISSUE_DETAILS, issue));
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
