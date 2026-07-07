/**
 * vendor-review-modal.js -- S23-10: Dealer WO review-gate modal
 *
 * Usage (called by unit-detail.js on vendor:review-ready):
 *   import { open as openVendorReview, close as closeVendorReview }
 *     from './vendor-review-modal.js';
 *   openVendorReview(reviewPayload, { onApprove, onCancel });
 *
 * reviewPayload shape (from vendor:review-ready bus event):
 *   { workflowId, vendor, unit, altId, portalUrl, instructions,
 *     isDuplicate?, caseNumber?, caseUrl?, _stubbed? }
 *
 * Flow:
 *   1. Modal opens over the app with vendor badge, unit ID, instructions.
 *   2. portalUrl (Decisiv): "Open portal window" re-opens BrowserWindow.
 *      portalFallbackUrl (non-Decisiv): "Open [Vendor] portal" opens in system browser.
 *      Neither: portal section hidden.
 *   3. altId field pre-filled; operator can correct before approving.
 *   4. isDuplicate notice shown if payload.isDuplicate === true.
 *   5. Approve --> vendor.approve({ workflowId, altId }) --> onApprove().
 *   6. Cancel  --> vendor.cancel(workflowId)             --> onCancel().
 *   7. Escape / backdrop click --> same as Cancel.
 *
 * S26: getPortalUrl(vendorName) fallback -- for vendors without a Decisiv
 *      automated workflow, a portal deep-link is resolved from VENDOR_PORTAL_URLS
 *      and shown as an external-browser link (opens in system browser, not BrowserWindow).
 *
 * CSS classes: .vr-modal-overlay  .vr-modal  .vr-*
 */

import { vendor, getPortalUrl } from '../vendor-bridge.js';
import toast                     from '../components/toast.js';

// -- Module state
let _overlay  = null;
let _payload  = null;
let _cbs      = {};

const _el   = (id) => document.getElementById(id);
const _safe = (s)  => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const _attr = (s)  => String(s || '').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

const _VENDOR_META = {
  // S23 originals (Decisiv window-reopen)
  paccar:      { label: 'PACCAR',        portal: 'PACCAR Service Portal',    cls: 'paccar'   },
  volvo:       { label: 'Volvo/ASIST',   portal: 'Volvo ASIST Portal',       cls: 'volvo'    },
  // S27-1: non-Decisiv vendors with portal fallback URLs
  amerit:      { label: 'Amerit',        portal: 'Amerit Fleet Solutions',   cls: 'amerit'   },
  cummins:     { label: 'Cummins',       portal: 'Cummins Care Portal',      cls: 'cummins'  },
  ta:          { label: 'TA Fleet',      portal: 'TA Fleet Services',        cls: 'ta'       },
  velociti:    { label: 'Velociti',      portal: 'Velociti Services Portal', cls: 'velociti' },
  fleetnet:    { label: 'FleetNet',      portal: 'FleetNet America Portal',  cls: 'fleetnet' },
  'fleet net': { label: 'FleetNet',      portal: 'FleetNet America Portal',  cls: 'fleetnet' },
  goodyear:    { label: 'Goodyear',      portal: 'Goodyear Commercial Tire', cls: 'goodyear' },
  freightliner:{ label: 'Freightliner',  portal: 'DTNA Parts Portal',        cls: 'unknown'  },
  kenworth:    { label: 'Kenworth',      portal: 'Kenworth Owners Portal',   cls: 'unknown'  },
  peterbilt:   { label: 'Peterbilt',     portal: 'Peterbilt Owners Portal',  cls: 'unknown'  },
  mack:        { label: 'Mack Trucks',   portal: 'Mack Trucks Portal',       cls: 'unknown'  },
  international:{ label: 'International',portal: 'International Truck Dealers',cls: 'unknown'},
  navistar:    { label: 'Navistar',      portal: 'International Truck Dealers',cls: 'unknown'},
};
function _vendorMeta(v) {
  return _VENDOR_META[(v || '').toLowerCase()] ||
    { label: v || 'Unknown', portal: (v ? v + ' Portal' : 'Vendor Portal'), cls: 'unknown' };
}

// -- Build HTML
// portalFallbackUrl: resolved by open() from getPortalUrl() before building HTML.
// portalUrl:         from Decisiv workflow payload (BrowserWindow reopen).
function _buildHTML(p, portalFallbackUrl) {
  const vm    = _vendorMeta(p.vendor);
  const hasPU = !!p.portalUrl;          // Decisiv window reopen
  const hasFB = !hasPU && !!portalFallbackUrl; // non-Decisiv external link fallback

  const dupBanner = p.isDuplicate ? (
    '<div class="vr-dup-banner">' +
    '<span class="vr-dup-banner__icon">&#9888;</span>' +
    '<span>Possible duplicate &mdash; case <strong>' + _safe(p.caseNumber || '') +
    '</strong> may already exist.' +
    (p.caseUrl ? ' <a class="vr-link" id="vr-dup-case-link" href="#">View case</a>' : '') +
    '</span></div>'
  ) : '';

  const stubBadge = p._stubbed ? '<span class="vr-stub-badge">STUB</span>' : '';

  // Portal section -- three variants:
  //   A) portalUrl present    -> reopen Decisiv BrowserWindow
  //   B) fallbackUrl present  -> open in system browser (external)
  //   C) neither              -> section omitted
  let portalSection = '';
  if (hasPU) {
    portalSection = (
      '<div class="vr-section">' +
      '<div class="vr-section__title">Portal</div>' +
      '<div class="vr-portal-row">' +
      '<span class="vr-portal-row__label">' + _safe(vm.portal) + '</span>' +
      '<a id="vr-portal-link" href="#" class="vr-link vr-link--portal">Open portal window &#8599;</a>' +
      '</div>' +
      '<p class="vr-portal-hint">The vendor portal window is already open. ' +
      'Use this link if it was closed.</p>' +
      '</div>'
    );
  } else if (hasFB) {
    portalSection = (
      '<div class="vr-section">' +
      '<div class="vr-section__title">Portal</div>' +
      '<div class="vr-portal-row">' +
      '<span class="vr-portal-row__label">' + _safe(vm.portal) + '</span>' +
      '<a id="vr-portal-link-ext" href="' + _attr(portalFallbackUrl) + '"' +
      ' target="_blank" rel="noopener noreferrer"' +
      ' class="vr-link vr-link--portal vr-link--external">Open ' +
      _safe(vm.label) + ' portal &#8599;</a>' +
      '</div>' +
      '<p class="vr-portal-hint">Opens in your system browser. ' +
      'This is an informational link &mdash; form submission is manual.</p>' +
      '</div>'
    );
  }

  return (
    '<div class="vr-modal" id="vr-modal-box" role="dialog"' +
    ' aria-modal="true" aria-labelledby="vr-modal-title">' +
    '<div class="vr-modal__header">' +
    '<div class="vr-modal__title-row">' +
    '<span class="vr-badge vr-badge--' + _attr(vm.cls) + '">' + _safe(vm.label) + '</span>' +
    '<span id="vr-modal-title" class="vr-modal__title">Review &amp; Approve Dealer WO</span>' +
    stubBadge +
    '</div>' +
    '<button id="vr-close" class="vr-modal__close" aria-label="Close">&times;</button>' +
    '</div>' +
    '<div class="vr-modal__body">' +
    '<div class="vr-unit-row">' +
    '<span class="vr-unit-row__label">Unit</span>' +
    '<span class="vr-unit-row__value">' + _safe(p.unit) + '</span>' +
    '<span class="vr-unit-row__wfid">' + _safe(p.workflowId) + '</span>' +
    '</div>' +
    dupBanner +
    '<div class="vr-section">' +
    '<div class="vr-section__title">Instructions</div>' +
    '<p class="vr-instructions">' +
    _safe(p.instructions || 'Review the pre-filled vendor portal. When satisfied, click Approve & Submit.') +
    '</p></div>' +
    portalSection +
    '<div class="vr-section">' +
    '<div class="vr-section__title">Alt ID ' +
    '<span class="vr-section__hint">relay reference &mdash; correct if needed</span>' +
    '</div>' +
    '<input id="vr-alt-id" class="vr-input" type="text"' +
    ' value="' + _attr(p.altId || '') + '"' +
    ' placeholder="Relay WO / reference ID" /></div>' +
    '<div id="vr-progress-wrap" class="vr-progress-wrap" style="display:none">' +
    '<div class="vr-section__title">Progress</div>' +
    '<div id="vr-progress-log" class="vr-progress-log"></div></div>' +
    '<div id="vr-result" class="vr-result" style="display:none"></div>' +
    '</div>' +
    '<div class="vr-modal__footer">' +
    '<div class="vr-footer-left"><span class="vr-footer-hint">Approve sends the pre-filled form to ' +
    _safe(vm.portal) + '.</span></div>' +
    '<div class="vr-footer-right">' +
    '<button id="vr-cancel-btn" class="detail-panel__btn detail-panel__btn--secondary">' +
    'Cancel Workflow</button>' +
    '<button id="vr-approve-btn" class="detail-panel__btn vr-approve-btn">' +
    'Approve &amp; Submit</button>' +
    '</div></div></div>'
  );
}

function _logProgress(msg, cls) {
  const wrap = _el('vr-progress-wrap');
  const log  = _el('vr-progress-log');
  if (!log) return;
  if (wrap) wrap.style.display = '';
  const line = document.createElement('div');
  line.className = 'vr-progress-line' + (cls ? ' vr-progress-line--' + cls : '');
  line.textContent = msg;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// Wire portal links.
// Decisiv (vr-portal-link): call vendor.openPortalUrl() -- reopens BrowserWindow.
// Fallback ext (vr-portal-link-ext): plain <a target="_blank"> -- no JS needed.
function _wirePortalLink(p) {
  const link = _el('vr-portal-link');
  if (link && p.portalUrl) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (vendor.openPortalUrl) vendor.openPortalUrl(p.portalUrl).catch(() => {});
    });
  }
  // vr-portal-link-ext is a real href <a target="_blank"> -- no JS handler needed.
  // Left as native anchor for simplicity and accessibility.

  const dupLink = _el('vr-dup-case-link');
  if (dupLink && p.caseUrl) {
    dupLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (vendor.openPortalUrl) vendor.openPortalUrl(p.caseUrl).catch(() => {});
    });
  }
}

function _wireApprove(p) {
  const approveBtn = _el('vr-approve-btn');
  const cancelBtn  = _el('vr-cancel-btn');
  if (!approveBtn) return;
  approveBtn.addEventListener('click', async () => {
    const altIdEl = _el('vr-alt-id');
    const altId   = (altIdEl && altIdEl.value.trim()) || (p.altId || '');
    approveBtn.disabled = true; approveBtn.textContent = 'Submitting...';
    if (cancelBtn) cancelBtn.disabled = true;
    _logProgress('Approving -- sending to vendor portal...');
    try {
      const res = await vendor.approve(p.workflowId, altId);
      if (res && res.ok === false) throw new Error(res.error || 'approve returned ok:false');
      _logProgress('Approved -- workflow continuing...', 'ok');
      const rEl = _el('vr-result');
      if (rEl) {
        rEl.innerHTML = '<div class="vr-result--success">' +
          '<span class="vr-result__icon">&#10003;</span>' +
          '<span>Approved &mdash; vendor portal is submitting...</span>' +
          '</div>';
        rEl.style.display = '';
      }
      approveBtn.textContent = 'Approved';
      setTimeout(() => {
        _closeModal();
        if (_cbs.onApprove) _cbs.onApprove({ workflowId: p.workflowId, altId });
      }, 1400);
    } catch (e) {
      _logProgress('Approve failed: ' + e.message, 'err');
      const rEl = _el('vr-result');
      if (rEl) {
        rEl.innerHTML = '<div class="vr-result--error">' +
          '<span class="vr-result__icon">&#10007;</span>' +
          '<span>Approve failed: ' + _safe(e.message) + '</span>' +
          '</div>';
        rEl.style.display = '';
      }
      approveBtn.disabled = false; approveBtn.textContent = 'Retry Approve';
      if (cancelBtn) cancelBtn.disabled = false;
      toast.show('error', 'Approve failed: ' + e.message);
    }
  });
}

function _wireCancel(p) {
  const cancelBtn = _el('vr-cancel-btn');
  if (!cancelBtn) return;
  cancelBtn.addEventListener('click', () => _doCancel(p));
}

async function _doCancel(p) {
  const cancelBtn  = _el('vr-cancel-btn');
  const approveBtn = _el('vr-approve-btn');
  if (cancelBtn)  { cancelBtn.disabled  = true; cancelBtn.textContent  = 'Cancelling...'; }
  if (approveBtn) { approveBtn.disabled = true; }
  try {
    await vendor.cancel(p.workflowId);
    toast.show('info', 'Dealer WO workflow cancelled');
  } catch (e) {
    toast.show('error', 'Cancel error: ' + e.message);
  } finally {
    _closeModal();
    if (_cbs.onCancel) _cbs.onCancel({ workflowId: p.workflowId });
  }
}

function _closeModal() {
  if (_overlay) {
    if (_overlay._keyHandler) document.removeEventListener('keydown', _overlay._keyHandler);
    if (_overlay.parentNode)  _overlay.parentNode.removeChild(_overlay);
  }
  _overlay = null;
  _payload = null;
  _cbs     = {};
}

/**
 * Open the review-gate modal.
 *
 * S26: Now async -- resolves VENDOR_PORTAL_URLS fallback before building HTML
 * so non-Decisiv vendors (Amerit, TA, Cummins, etc.) get a portal section
 * pointing to their public site.  Decisiv (PACCAR/Volvo) path unchanged.
 *
 * @param {object} payload  - vendor:review-ready payload
 * @param {object} [cbs]    - { onApprove(data), onCancel(data) }
 * @returns {Promise<void>}
 */
export async function open(payload, cbs = {}) {
  if (_overlay) _closeModal();
  _payload = payload;
  _cbs     = cbs;

  // Resolve fallback portal URL for non-Decisiv vendors.
  // getPortalUrl() is cached after first call -- no perceptible latency.
  let portalFallbackUrl = '';
  if (!payload.portalUrl) {
    try {
      portalFallbackUrl = await getPortalUrl(payload.vendor || '');
    } catch (_) {
      // non-fatal -- portal section will be omitted
    }
  }

  _overlay           = document.createElement('div');
  _overlay.id        = 'vr-modal-overlay';
  _overlay.className = 'vr-modal-overlay';
  _overlay.innerHTML = _buildHTML(payload, portalFallbackUrl);
  document.body.appendChild(_overlay);
  _overlay.addEventListener('click', (e) => { if (e.target === _overlay) _doCancel(payload); });
  const closeBtn = _el('vr-close');
  if (closeBtn) closeBtn.addEventListener('click', () => _doCancel(payload));
  _overlay._keyHandler = (e) => { if (e.key === 'Escape') _doCancel(payload); };
  document.addEventListener('keydown', _overlay._keyHandler);
  _wirePortalLink(payload);
  _wireApprove(payload);
  _wireCancel(payload);
  setTimeout(() => { const f = _el('vr-alt-id'); if (f) f.focus(); }, 60);
}

export { _closeModal as close };
