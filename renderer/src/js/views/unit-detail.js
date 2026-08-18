/**
 * unit-detail.js -- Unit detail panel / drawer
 *
 * Slides in from the right when a unit is selected (ui:unit-select).
 * Slides out on close or ui:unit-deselect.
 *
 * Shows: unit fields | relay WOs | Uptake insights | notes | quick actions
 *
 * S9: relay WO cards, Uptake insights, lifecycle change form,
 *     AI Suggest wired (spinner + copy), Create WR → aap.autofill
 */

import bus           from '../bus.js';
import state         from '../state.js';
import { notes, ai, aap, relay, vendor, workflowIntel } from '../bridge.js';
import { open as openWRModal }    from './wr-modal.js';
import { open as openVendorReview } from './vendor-review-modal.js';
import { open as openDealerWOModal } from './dealer-wo-modal.js';
import toast         from '../components/toast.js';

let _panel    = null;
let _unit     = null;
let _notesVal     = '';
let _allConvoMsgs = [];

const FIELDS = [
  ['Equipment ID',       'equipmentId'],
  ['Asset Type',         'assetType'],
  ['Lifecycle State',    'lifecycleState'],
  ['Lifecycle Reason',   'lifecycleReason'],
  ['Domicile',           'domicileSite'],
  ['Operator',           'operator'],
  ['Manufacturer',       'manufacturer'],
  ['Body Type',          'bodyType'],
  ['Engine Manufacturer','engineManufacturer'],
  ['Fuel Type',          'fuelType'],
  ['Due Date',           'dueDate'],
  ['Open Unplanned WRs', 'openUnplanned'],
  ['Open Planned WRs',   'openPlanned'],
  ['Last Geofence',      'geofence'],
  ['Lat/Long',           'latLong'],
];

function _esc(s) {
  return String(s || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// S9: risk badge
function _riskBadge(score) {
  const n = parseInt(score, 10);
  if (isNaN(n)) return '';
  const cls = n >= 70 ? 'risk-high' : n >= 40 ? 'risk-medium' : 'risk-low';
  return '<span class="badge badge--' + cls + '">' + n + '</span>';
}

// S9: render relay WO section into #dp-relay-wos
function _loadRelayWOs(unit) {
  const el = document.getElementById('dp-relay-wos');
  if (!el) return;
  el.innerHTML = '<p class="dp-empty">Loading work orders...</p>';

  relay.getUnitCache(unit.equipmentId).then((data) => {
    if (!el) return;
    const wos = (data && data.workOrders) ? data.workOrders : [];
    if (wos.length === 0) {
      el.innerHTML = '<p class="dp-empty">No open work orders in Relay.</p>';
      return;
    }
    el.innerHTML = wos.map((wo) => {
      const statusCls = (wo.status || '').toLowerCase().includes('open') ? 'wo-open' : 'wo-closed';
      const ageDays   = wo.createdAt
        ? Math.floor((Date.now() - new Date(wo.createdAt).getTime()) / 86400000)
        : null;
      return `
        <div class="dp-relay-card">
          <span class="dp-relay-card__vendor">${_esc(wo.vendor || '--')}</span>
          <span class="badge badge--${statusCls}">${_esc(wo.status || 'Open')}</span>
          <span class="dp-relay-card__desc">${_esc(wo.description || '')}</span>
          ${ageDays !== null ? '<span class="dp-relay-card__age">' + ageDays + 'd</span>' : ''}
        </div>
      `;
    }).join('');
  }).catch(() => {
    if (el) el.innerHTML = '<p class="dp-empty">Could not load work orders.</p>';
  });
}

// S9: render Uptake insights into #dp-insights-list + risk badge into #dp-risk-badge
function _renderInsights(unit) {
  const badgeEl = document.getElementById('dp-risk-badge');
  if (badgeEl && unit.riskScore) {
    badgeEl.innerHTML = _riskBadge(unit.riskScore);
  }

  const listEl = document.getElementById('dp-insights-list');
  if (!listEl) return;
  const insights = Array.isArray(unit.insights) ? unit.insights : [];
  if (insights.length === 0) {
    listEl.outerHTML = '<p id="dp-insights-list" class="dp-empty">No active Uptake insights.</p>';
    return;
  }
  listEl.innerHTML = insights.map((ins) =>
    '<li class="dp-insight"><span class="dp-insight__type">[' + _esc(ins.type || 'insight') + ']</span> ' +
    _esc(ins.summary || String(ins)) + '</li>'
  ).join('');
}

// S9: lifecycle change form wiring
function _wireLifecycleForm(unit) {
  const btn      = document.getElementById('dp-lc-open');
  const form     = document.getElementById('dp-lc-form');
  const cancelEl = document.getElementById('dp-lc-cancel');
  const confirmEl= document.getElementById('dp-lc-confirm');
  const actionsEl= document.getElementById('dp-quick-actions');
  if (!btn || !form || !cancelEl || !confirmEl || !actionsEl) return;

  btn.addEventListener('click', () => {
    actionsEl.style.display = 'none';
    form.style.display = 'flex';
  });

  cancelEl.addEventListener('click', () => {
    form.style.display = 'none';
    actionsEl.style.display = 'flex';
  });

  confirmEl.addEventListener('click', async () => {
    if (!unit.assetUrl) {
      toast.show('warn', 'No AAP URL for this unit', 3000);
      return;
    }
    const lcState  = document.getElementById('dp-lc-state').value;
    const lcReason = (document.getElementById('dp-lc-reason').value || '').trim();
    confirmEl.disabled = true;
    confirmEl.textContent = 'Saving...';
    try {
      // BUG FIX (2026-07-16): setLifecycleState() (src/scrapers/setLifecycle.js)
      // NEVER rejects/throws, even when the real AAP automation fails -- it
      // always resolves, with { success: false, message: '...' } on failure
      // (e.g. "Could not find lifecycle edit button", "Modal did not open",
      // "Apply Change button is disabled"). The try/catch here only catches
      // actual thrown errors (IPC-level failures), so a false "Lifecycle
      // changed to X" success toast was showing UNCONDITIONALLY regardless
      // of whether the automation actually succeeded inside AAP. Now
      // explicitly checks result.success below before treating this as a
      // success.
      const lcResult = await aap.setLifecycle(unit.equipmentId, unit.assetUrl, lcState, lcReason);
      if (!lcResult || !lcResult.success) {
        toast.show('error', 'Lifecycle change failed: ' + ((lcResult && lcResult.message) || 'Unknown error — AAP automation did not confirm the change'));
        return;
      }
      toast.show('success', 'Lifecycle changed to ' + lcState);
      form.style.display = 'none';
      actionsEl.style.display = 'flex';
    } catch (e) {
      toast.show('error', 'Lifecycle change failed: ' + e.message);
    } finally {
      confirmEl.disabled = false;
      confirmEl.textContent = 'Confirm';
    }
  });
}

// S9: AI Suggest wiring (spinner + copy button)
function _wireAISuggest(unit) {
  const btn      = document.getElementById('dp-ai-suggest');
  const askInput = document.getElementById('dp-ai-ask');
  const askBtn   = document.getElementById('dp-ai-ask-btn');
  const resultEl = document.getElementById('dp-ai-result');
  if (!btn || !resultEl) return;

  async function _runSuggest(promptOverride) {
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<span class="dp-ai-spinner">⏳ Asking Orcha...</span>';
    try {
      let result;
      if (promptOverride) {
        const fullPrompt = '[Unit: ' + unit.equipmentId + '] ' + promptOverride;
        result = await ai.ask(fullPrompt);
      } else {
        result = await ai.suggest(unit);
      }
      const text = (result && result.text) ? result.text : JSON.stringify(result, null, 2);
      resultEl.innerHTML =
        '<div class="dp-ai-text">' + _esc(text) + '</div>' +
        '<button id="dp-ai-copy" class="detail-panel__btn dp-ai-copy-btn">Copy</button>';
      document.getElementById('dp-ai-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(text).catch(() => {});
        toast.show('info', 'Copied to clipboard', 2000);
      });
    } catch (e) {
      resultEl.innerHTML = '<span class="dp-ai-error">' + _esc(e.message) + '</span>';
    }
  }

  btn.addEventListener('click', () => _runSuggest(null));

  if (askBtn && askInput) {
    askBtn.addEventListener('click', () => {
      const q = askInput.value.trim();
      if (q) _runSuggest(q);
    });
    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const q = askInput.value.trim(); if (q) _runSuggest(q); }
    });
  }
}

// S11: Create WR -> openWRModal (full modal with vendor/urgency/areas/screenshot)
function _wireCreateWR(unit) {
  const btn = document.getElementById('dp-create-wr');
  if (!btn) return;
  btn.addEventListener('click', () => { openWRModal(unit); });
}


// S23-9: Dealer WO panel helpers ----------------------------------------

function _checkIcon(s) { return s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✗'; }
function _checkCls(s)  { return s === 'pass' ? 'pass' : s === 'warn' ? 'warn' : 'fail'; }

function _renderInvestigation(result) {
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) return;
  const { eligible, vendor: v, warnings = [], blocking = [], checks = {}, existingWO } = result;

  const ORDER = ['unit_data','vendor','lifecycle','offsite_match','relay_wo','mileage'];
  const checkRows = ORDER.filter(id => checks[id]).map(id => {
    const c = checks[id];
    const cls = _checkCls(c.status);
    return '<div class="dp-vnd-check dp-vnd-check--' + cls + '">' +
      '<span class="dp-vnd-check__icon">' + _checkIcon(c.status) + '</span>' +
      '<span class="dp-vnd-check__name">' + _esc(c.name || id) + '</span>' +
      '<span class="dp-vnd-check__detail">' + _esc(c.detail || '') + '</span>' +
      '</div>';
  }).join('');

  const blockHtml = blocking.length
    ? '<div class="dp-vnd-blocking">' +
        blocking.map(b => '<div class="dp-vnd-blocking__row">✗ ' + _esc(b) + '</div>').join('') +
      '</div>'
    : '';

  const warnHtml = warnings.length
    ? '<div class="dp-vnd-warnings">' +
        warnings.map(w => '<div class="dp-vnd-warn-row">⚠ ' + _esc(w) + '</div>').join('') +
      '</div>'
    : '';

  const existHtml = existingWO
    ? '<div class="dp-vnd-existing">' +
        '<span class="dp-vnd-existing__label">Existing case:</span> ' +
        (existingWO.url
          ? '<a class="dp-vnd-link" href="' + _esc(existingWO.url) + '" target="_blank" rel="noreferrer">' +
              _esc(existingWO.title || existingWO.caseNumber || 'Open') + '</a>'
          : '<span>' + _esc(existingWO.title || existingWO.caseNumber || '') + '</span>') +
      '</div>'
    : '';

  const vendorLabel = v === 'paccar' ? 'PACCAR / Kenworth / Peterbilt'
                    : v === 'volvo'  ? 'Volvo / ASIST'
                    : (v || 'Unknown');

  const startHtml = eligible
    ? '<button id="dp-vnd-start" class="detail-panel__btn detail-panel__btn--vendor" data-vendor="' + _esc(v) + '">Start ' + _esc(vendorLabel) + ' Portal</button>'
    : '<div class="dp-vnd-blocked">Cannot start Dealer WO. Resolve errors above.</div>';
  sec.innerHTML =
    '<div class="dp-vnd-header">' +
      '<span class="dp-vnd-badge dp-vnd-badge--' + _esc(v || 'unknown') + '">' + _esc(vendorLabel) + '</span>' +
      '<span class="dp-vnd-status dp-vnd-status--' + (eligible ? 'eligible' : 'blocked') + '">' +
        (eligible ? 'Eligible' : 'Blocked') + '</span>' +
    '</div>' +
    '<div class="dp-vnd-checks">' + checkRows + '</div>' +
    blockHtml + warnHtml + existHtml +
    '<div id="dp-vnd-actions" class="dp-vnd-actions">' + startHtml + '</div>' +
    '<div id="dp-vnd-progress" class="dp-vnd-progress" style="display:none"></div>';

  if (eligible) {
    document.getElementById('dp-vnd-start')
      .addEventListener('click', () => _startVendorWF(result.unit || _unit, v));
  }
}

function _renderProgress(p) {
  const el = document.getElementById('dp-vnd-progress');
  if (!el) return;
  el.style.display = 'block';
  const stepCls = (p.step || '').includes('error')    ? 'dp-vnd-step--error'
                : (p.step || '').includes('complete')  ? 'dp-vnd-step--done'
                : 'dp-vnd-step--active';
  el.innerHTML += '<div class="dp-vnd-step ' + stepCls + '">' +
    '<span class="dp-vnd-step__ts">' + new Date(p.ts || Date.now()).toLocaleTimeString() + '</span>' +
    '<span class="dp-vnd-step__label">' + _esc(p.step || '') + '</span>' +
    (p.detail ? '<span class="dp-vnd-step__detail">' + _esc(p.detail) + '</span>' : '') +
    '</div>';
  el.scrollTop = el.scrollHeight;
}

async function _showApproveCancel(workflowId, reviewPayload) {
  const payload = reviewPayload || { workflowId, unit: _unit && (_unit.id || _unit.equipmentId) || '' };
  await openVendorReview(payload, {
    onApprove: () => {
      const actEl = document.getElementById('dp-vnd-actions');
      if (actEl) actEl.innerHTML = '<span class="dp-vnd-step dp-vnd-step--active">Submitting...</span>';
    },
    onCancel: () => {
      const sec = document.getElementById('dp-vendor-section');
      if (sec) sec.dataset.workflowId = '';
      const actEl = document.getElementById('dp-vnd-actions');
      if (actEl) {
        actEl.innerHTML = '<button id="dp-vnd-reinvest" class="detail-panel__btn detail-panel__btn--secondary">Re-check eligibility</button>';
        const ri = document.getElementById('dp-vnd-reinvest');
        if (ri) ri.addEventListener('click', () => _wireVendorPanel(_unit));
      }
    },
  });
}
async function _startVendorWF(unit, vendorKey) {
  // Open the Dealer WO review modal first so the user can confirm city/state,
  // dealer, name, phone, and issue before portal automation fires. The resolved
  // formData is passed into the workflow so the orchestrator fills the real
  // request-service form from it instead of guessing from unit fields alone.
  openDealerWOModal(unit, vendorKey, async (formData) => {
    // S28: Record correction if Orcha suggested a different vendor (closes the learning loop)
    try {
      const aiResult = await ai.suggestVendor(unit).catch(() => null);
      if (aiResult && aiResult.vendor && aiResult.vendor.toLowerCase() !== vendorKey.toLowerCase()) {
        ai.recordCorrection({
          unitId:         unit.equipmentId || unit.id || '',
          field:          'vendor',
          orchaSuggested: aiResult.vendor,
          userChose:      vendorKey,
          context: {
            domicile:  unit.domicileSite || '',
            vendor:    vendorKey,
            component: unit.savedPrimaryComponent || '',
            make:      unit.manufacturer || unit.make || '',
            issue:     unit.issueSummary || '',
          },
        }).catch(() => {});
      }
    } catch (_) {}

    const startBtn = document.getElementById('dp-vnd-start');
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting...'; }
    const progressEl = document.getElementById('dp-vnd-progress');
    if (progressEl) { progressEl.style.display = 'block'; progressEl.innerHTML = ''; }
    try {
      const fn = vendorKey === 'paccar' ? vendor.startPaccar : vendor.startVolvo;
      const { workflowId } = await fn(unit, formData);
      const sec = document.getElementById('dp-vendor-section');
      if (sec) sec.dataset.workflowId = workflowId;
      // S25-6-A: do NOT call _showApproveCancel here — modal opens via vendor:review-ready bus event.
      toast.show('info', 'Dealer WO workflow started \u2014 waiting for portal...', 3000);
    } catch (e) {
      toast.show('error', 'Failed to start workflow: ' + e.message);
      if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Retry'; }
    }
  });
}

async function _approveWF(workflowId) {
  const btn = document.getElementById('dp-vnd-approve');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting...'; }
  try {
    await vendor.approve(workflowId);
    toast.show('success', 'Dealer WO approved and submitted');
  } catch (e) {
    toast.show('error', 'Approve failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Approve & Submit'; }
  }
}

async function _cancelWF(workflowId) {
  const btn = document.getElementById('dp-vnd-cancel');
  if (btn) { btn.disabled = true; btn.textContent = 'Cancelling...'; }
  try {
    await vendor.cancel(workflowId);
    toast.show('info', 'Dealer WO workflow cancelled');
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.dataset.workflowId = '';
    const actEl = document.getElementById('dp-vnd-actions');
    if (actEl) {
      actEl.innerHTML = '<button id="dp-vnd-reinvest" class="detail-panel__btn detail-panel__btn--secondary">Re-check eligibility</button>';
      const ri = document.getElementById('dp-vnd-reinvest');
      if (ri) ri.addEventListener('click', () => _wireVendorPanel(_unit));
    }
  } catch (e) {
    toast.show('error', 'Cancel failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
  }
}

// S23-13: off-fns for vendor bus listeners
let _vendorUnsubs = [];
function _teardownVendorBus() {
  _vendorUnsubs.forEach((fn) => fn());
  _vendorUnsubs = [];
}

// S24-2: complete banner -- caseUrl deep-link + SR copy
function _renderCompleteBanner(el, p) {
  const sr    = p.caseNumber || "";
  const url   = p.caseUrl   || "";
  const altId = p.altId     || "";
  let html = "<div class=\"dp-vnd-complete-banner\">";
  html += "<span class=\"dp-vnd-complete-icon\">✓</span>";
  html += "<div class=\"dp-vnd-complete-body\">";
  html += "<span class=\"dp-vnd-complete-label\">Dealer WO created</span>";
  if (sr) {
    html += "<span class=\"dp-vnd-complete-sr\">";
    html += "<span class=\"dp-vnd-complete-sr-num\">" + _esc(sr) + "</span>";
    html += "<button class=\"dp-vnd-copy-btn\" data-copy=\"" + _esc(sr) + "\" title=\"Copy SR\">⧉</button>";
    html += "</span>";
  }
  if (altId && altId !== sr) {
    html += "<span class=\"dp-vnd-complete-altid\">" + _esc(altId) + "<button class=\"dp-vnd-copy-btn\" data-copy=\"" + _esc(altId) + "\" title=\"Copy ID\">⧉</button></span>";
  }
  if (url) {
    html += "<a class=\"dp-vnd-complete-link\" data-ext-url=\"" + _esc(url) + "\" href=\"#\">Open in portal ↗</a>";
  }
  html += "</div></div>";
  el.innerHTML = html;
  el.querySelectorAll(".dp-vnd-copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
      toast.show("info", "Copied", 1800);
    });
  });
  if (url) {
    const lnk = el.querySelector(".dp-vnd-complete-link");
    if (lnk) lnk.addEventListener("click", (e) => {
      e.preventDefault();
      window.files.openExternal(url).catch(() => {});
    });
  }
}

// S24-3: error banner + retry button
function _renderErrorBanner(el, p) {
  const msg = p.error || "Unknown error";
  let html = "<div class=\"dp-vnd-error-banner\">";
  html += "<span class=\"dp-vnd-error-icon\">✗</span>";
  html += "<div class=\"dp-vnd-error-body\">";
  html += "<span class=\"dp-vnd-error-label\">Workflow error</span>";
  html += "<span class=\"dp-vnd-error-msg\">" + _esc(msg) + "</span>";
  html += "<button id=\"dp-vnd-retry\" class=\"detail-panel__btn detail-panel__btn--secondary dp-vnd-retry-btn\">Retry</button>";
  html += "</div></div>";
  el.innerHTML = html;
  const btn = el.querySelector("#dp-vnd-retry");
  if (btn) btn.addEventListener("click", () => _wireVendorPanel(_unit));
}

// S24-5: workflow history strip
function _relTs(ts) {
  const d = Date.now() - ts;
  if (d < 60000)  return "just now";
  if (d < 3600000) return Math.floor(d/60000) + "m ago";
  if (d < 86400000) return Math.floor(d/3600000) + "h ago";
  return Math.floor(d/86400000) + "d ago";
}

function _renderHistoryStrip(unitId) {
  const el = document.getElementById("dp-vnd-history-strip");
  if (!el) return;
  const hist = (state.slice("vendor").history || {})[unitId] || [];
  if (!hist.length) { el.innerHTML = ""; return; }
  const chips = hist.map(function(h, i) {
    const ok  = h.outcome === "complete";
    const lbl = ok ? (h.caseNumber || "WO") : (h.error ? h.error.slice(0,32) : "error");
    const rel = _relTs(h.ts || 0);
    const vCls = h.vendor === "paccar" ? "dp-vnd-badge--paccar" : h.vendor === "volvo" ? "dp-vnd-badge--volvo" : "dp-vnd-badge--unknown";
    const oCls = ok ? "dp-vnd-hist-chip--ok" : "dp-vnd-hist-chip--err";
    return "<button class=\"dp-vnd-hist-chip " + oCls + " \" data-idx=\"" + i + "\"><span class=\"dp-vnd-hist-chip__icon\">" + (ok ? "✓" : "✗") + "</span><span class=\"dp-vnd-hist-chip__vendor dp-vnd-badge " + vCls + "\"></span><span class=\"dp-vnd-hist-chip__label\">" + _esc(lbl) + "</span><span class=\"dp-vnd-hist-chip__rel\">" + _esc(rel) + "</span></button>";
  });
  el.innerHTML = "<div class=\"dp-vnd-hist-label\">History</div>" + chips.join("");
  el.querySelectorAll(".dp-vnd-hist-chip").forEach(function(btn) {
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      const h   = hist[idx];
      if (!h) return;
      const prev = el.querySelector(".dp-vnd-hist-tooltip");
      if (prev) prev.remove();
      const tt = document.createElement("div");
      tt.className = "dp-vnd-hist-tooltip";
      const isOk = h.outcome === "complete";
      let ttHtml = "";
      if (isOk) {
        ttHtml += "<span class=\"dp-vnd-hist-tt__sr\">" + _esc(h.caseNumber || "—") + "</span>";
        if (h.caseUrl) {
          ttHtml += "<a class=\"dp-vnd-hist-tt__link\" data-url=\"" + _esc(h.caseUrl) + "\" href=\"#\">Open ↗</a>";
        }
        if (h.dealerName) ttHtml += "<span class=\"dp-vnd-hist-tt__dealer\">" + _esc(h.dealerName) + "</span>"; // S25-12
      } else {
        ttHtml += "<span class=\"dp-vnd-hist-tt__err\">" + _esc(h.error || "unknown") + "</span>";
      }
      tt.innerHTML = ttHtml;
      btn.appendChild(tt);
      if (h.caseUrl) {
        const lnk = tt.querySelector(".dp-vnd-hist-tt__link");
        if (lnk) lnk.addEventListener("click", function(ev) {
          ev.preventDefault();
          window.files.openExternal(h.caseUrl).catch(function(){});
        });
      }
      document.addEventListener("click", function _dismiss(ev) {
        if (!tt.contains(ev.target) && ev.target !== btn) {
          tt.remove(); document.removeEventListener("click", _dismiss);
        }
      }, true);
    });
  });
}

// S28: Orcha Vendor AI Suggestion — renders recommendation card above eligibility
function _renderVendorAISuggest(unit) {
  const el = document.getElementById('dp-vnd-ai-suggest');
  if (!el) return;
  el.innerHTML =
    '<div class="dp-vnd-ai-card">' +
      '<div class="dp-vnd-ai-card__header">' +
        '<span class="dp-vnd-ai-card__icon">\uD83E\uDD16</span>' +
        '<span class="dp-vnd-ai-card__title">Orcha Vendor Intelligence</span>' +
        '<button id="dp-vnd-ai-run" class="dp-vnd-ai-card__btn">Analyze</button>' +
      '</div>' +
      '<div id="dp-vnd-ai-body" class="dp-vnd-ai-card__body">' +
        '<span class="dp-vnd-ai-card__hint">Click Analyze for AI-powered vendor recommendation</span>' +
      '</div>' +
    '</div>';
  const runBtn = document.getElementById('dp-vnd-ai-run');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      const body = document.getElementById('dp-vnd-ai-body');
      runBtn.disabled = true;
      runBtn.textContent = '\u2026';
      body.innerHTML = '<span class="dp-vnd-ai-card__loading">\u26A1 Orcha analyzing vendor options\u2026</span>';
      try {
        const result = await ai.suggestVendor(unit);
        const rec = result && (result.vendor || result.recommendation || result.text || '');
        const confidence = result && result.confidence ? result.confidence : null;
        const reasoning = result && (result.reason || result.reasoning || '');
        const alt = result && result.alternatives ? result.alternatives : [];

        let html = '';
        if (rec) {
          html += '<div class="dp-vnd-ai-rec">';
          html += '<span class="dp-vnd-ai-rec__label">Recommended:</span>';
          html += '<span class="dp-vnd-ai-rec__vendor">' + _esc(rec) + '</span>';
          if (confidence) html += '<span class="dp-vnd-ai-rec__conf">' + confidence + '% confidence</span>';
          html += '</div>';
        }
        if (reasoning) {
          html += '<div class="dp-vnd-ai-reasoning">' + _esc(reasoning) + '</div>';
        }
        if (alt.length) {
          html += '<div class="dp-vnd-ai-alts"><span class="dp-vnd-ai-alts__label">Alternatives:</span> ' +
            alt.map(a => '<span class="dp-vnd-ai-alt-pill">' + _esc(a) + '</span>').join(' ') + '</div>';
        }
        if (!html) html = '<span class="dp-vnd-ai-card__hint">No recommendation available for this unit.</span>';
        body.innerHTML = html;
      } catch (e) {
        body.innerHTML = '<span class="dp-vnd-ai-card__error">' + _esc(e.message || 'AI unavailable') + '</span>';
      } finally {
        runBtn.disabled = false;
        runBtn.textContent = 'Re-analyze';
      }
    });
  }
}

// Phase 8/3: Workflow Intelligence suggestion card -- mirrors
// _renderVendorAISuggest's card style above, but auto-checks (no manual
// "Analyze" click needed) since the underlying check is a local pattern
// lookup, not an AI/network call. Renders nothing if no confirmed pattern
// matches this unit's vendor/component/issue -- no clutter for the common
// case. "Run Workflow" is honestly labeled informational-only: Phase 4
// (actual execution via the orchestrator) does not exist yet, so this must
// never claim to have done something it did not do.
function _renderWorkflowSuggest(unit) {
  const el = document.getElementById('dp-wi-suggest');
  if (!el) return;
  el.innerHTML = '';

  workflowIntel.getSuggestionForUnit(unit).then((suggestion) => {
    if (!suggestion || !suggestion.payload) return;
    const steps = suggestion.payload.steps || [];

    const stepsHtml = steps.map(s =>
      '<div class="dp-wi-step">' +
        '<span class="dp-wi-step__label">' + _esc(s.label) + '</span>' +
        '<span class="dp-wi-step__conf" style="color:' + (s.confidence >= 80 ? '#3fb950' : '#f0a800') + '">' +
          s.confidence + '%' + (s.requiresApproval ? ' <em>(Requires Approval)</em>' : '') +
        '</span>' +
      '</div>'
    ).join('');

    el.innerHTML =
      '<div class="dp-vnd-ai-card">' +
        '<div class="dp-vnd-ai-card__header">' +
          '<span class="dp-vnd-ai-card__icon">\u{1F9E0}</span>' +
          '<span class="dp-vnd-ai-card__title">I\u2019ve seen this before</span>' +
        '</div>' +
        '<div class="dp-vnd-ai-card__body">' +
          '<div class="dp-vnd-ai-reasoning">' + _esc(suggestion.reason) + '</div>' +
          '<div class="dp-wi-steps">' + stepsHtml + '</div>' +
          '<div class="dp-wi-actions">' +
            '<button id="dp-wi-run" class="dp-action-btn dp-action-btn--primary" style="margin-top:8px">Run Workflow</button>' +
            '<button id="dp-wi-dismiss" class="dp-action-btn" style="margin-top:8px">Dismiss</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    const runBtn = document.getElementById('dp-wi-run');
    if (runBtn) runBtn.addEventListener('click', () => {
      toast.show('info', 'Workflow execution (Phase 4) is not built yet \u2014 this suggestion is informational only for now.', 4000);
    });
    const dismissBtn = document.getElementById('dp-wi-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', () => { el.innerHTML = ''; });
  }).catch(() => { /* best-effort card -- silent on failure, never blocks the panel */ });
}

function _wireVendorPanel(unit) {
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) return;
  _teardownVendorBus();
  _renderVendorAISuggest(unit);  // S28: show AI suggestion card
  _renderWorkflowSuggest(unit);  // Phase 8/3: show mined workflow suggestion, if any
  sec.innerHTML = '<p class="dp-empty">Checking eligibility...</p>';
  vendor.investigate(unit).then((result) => {
    _renderInvestigation(result);
    _renderHistoryStrip(unit.equipmentId || unit.id);
    // S25-6-B: reconnect if a workflow is already running for this unit
    const _eqId = unit.equipmentId || unit.id || '';
    vendor.getStatus().then((statusResult) => {
      const active = (statusResult && statusResult.active) || [];
      const running = active.find((w) => w.unit === _eqId);
      if (running && sec && !sec.dataset.workflowId) {
        sec.dataset.workflowId = running.workflowId;
        const progressEl = document.getElementById('dp-vnd-progress');
        if (progressEl) { progressEl.style.display = 'block'; }
        _renderProgress({ vendor: running.vendor, step: running.step, ts: running.startedAt,
          detail: 'Workflow reconnected (step: ' + running.step + ')' });
      }
    }).catch(() => {});
    _vendorUnsubs.push(
      bus.on('vendor:progress', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress(p);
      }),
      bus.on('vendor:review-ready', async (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'review-ready', detail: 'Portal ready. Review then approve.' });
        await _showApproveCancel(sec.dataset.workflowId, p);
      }),
      bus.on('vendor:complete', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'complete', detail: 'Case: ' + (p.caseNumber || '') });
        const actEl = document.getElementById('dp-vnd-actions');
        if (actEl) _renderCompleteBanner(actEl, p);
        _renderHistoryStrip(unit.equipmentId || unit.id);
        toast.show('success', 'Dealer WO submitted successfully');
        _teardownVendorBus();
      }),
      bus.on('vendor:error', (p) => {
        if (!sec.dataset.workflowId || p.workflowId !== sec.dataset.workflowId) return;
        _renderProgress({ ...p, step: 'error', detail: p.error || 'Unknown error' });
        const actEl = document.getElementById('dp-vnd-actions');
        toast.show('error', 'Dealer WO error: ' + (p.error || 'unknown'));
        if (actEl) _renderErrorBanner(actEl, p);
        _renderHistoryStrip(unit.equipmentId || unit.id);
        _teardownVendorBus();
      }),
    );
  }).catch((e) => {
    if (sec) sec.innerHTML = '<p class="dp-empty dp-empty--error">Investigation failed: ' + _esc(e.message) + '</p>';
  });
}


// S25-10: Volvo ASIST Offsite Event panel
function _renderAsistContent(unit) {
  const url   = unit.savedOffsiteUrl || unit.offsiteShopEventUrl || '';
  const label = unit.asistLabel || unit.savedOffsiteEvent || unit.offsiteShopEvent || '';
  const src   = unit.asistSource || '';
  const srUrl = unit.asistSrUrl  || '';
  const ts    = unit.asistScrapedAt || '';
  const srcBadge = src === 'estimate' ? 'Fleet Estimate' : src === 'case' ? 'ASIST Case' : src === 'service_request' ? 'Service Request' : '';
  if (!url && !label) return null;
  let html = '<div class="dp-asist-content">';
  if (srcBadge) html += '<span class="dp-asist-badge dp-asist-badge--' + _esc(src) + '">' + _esc(srcBadge) + '</span> ';
  if (url) {
    const aHref = url.replace(/[']/g, '');
    html += '<a class="dp-asist-url" href="'+ aHref +'" target="_blank" rel="noreferrer">'+_esc(label||url)+'</a>';
  } else if (label) {
    html += '<span class="dp-asist-label">'+_esc(label)+'</span>';
  }
  if (srUrl && srUrl !== url) {
    const srHref = srUrl.replace(/[']/g, '');
    html += ' <a class="dp-asist-sr-link" href="'+ srHref +'" target="_blank" rel="noreferrer">'+'(SR)'+'</a>';
  }
  if (ts) html += '<div class="dp-asist-ts">Last enriched: '+_esc(ts.slice(0,10))+'</div>';
  html += '</div>';
  return html;
}

function _wireAsistPanel(unit) {
  const panel  = document.getElementById('dp-asist-panel');
  const actEl  = document.getElementById('dp-asist-actions');
  const secEl  = document.getElementById('dp-offsite-section');
  if (!panel) return;
  const html = _renderAsistContent(unit);
  if (!html) {
    const isVolvo = (unit.make || '').toLowerCase().includes('volvo');
    if (!isVolvo && secEl) secEl.style.display = 'none';
    return;
  }
  panel.innerHTML = html;
  if (actEl && unit.asistSrUrl) actEl.style.removeProperty('display');
  const refreshBtn = document.getElementById('dp-asist-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.textContent = 'Enriching...';
      try {
        const srUrl = unit.asistSrUrl || unit.offsiteShopEventUrl;
        if (srUrl) {
          const res = await window.vendor.enrichAsist(srUrl);
          if (res && res.ok) {
            unit.asistLabel = res.bestLabel; unit.asistSource = res.source;
            unit.asistSrUrl = res.srUrl; unit.asistScrapedAt = res.scrapedAt;
            unit.savedOffsiteUrl = res.bestUrl; unit.savedOffsiteEvent = res.bestLabel;
            _wireAsistPanel(unit);
          }
        }
      } catch(e) { /* non-fatal */ }
      refreshBtn.disabled = false; refreshBtn.textContent = 'Re-enrich';
    });
  }

  // S25-12: staleness guard -- auto-trigger re-enrich if > 24h old
  if (unit.asistSrUrl && unit.asistScrapedAt) {
    const _age = Date.now() - new Date(unit.asistScrapedAt).getTime();
    if (_age > 86400000) {
      setTimeout(() => {
        const _rb = document.getElementById('dp-asist-refresh');
        if (_rb && !_rb.disabled) _rb.click();
      }, 1500);
    }
  }
}

// S23-9: Dealer WO quick-action button -- scroll to vendor section
function _wireDealerWOBtn(unit) {
  const btn = document.getElementById('dp-dealer-wo');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ── NEW: Command Center render helpers ──────────────────────────────────────
// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function riskColor(n){return n>=70?'red':n>=40?'org':'grn';}
function downDays(unit){const ts=unit.created;if(!ts)return null;return Math.floor((Date.now()-new Date(ts).getTime())/86400000);}
function relTime(ts){if(!ts)return'';const d=Date.now()-new Date(ts).getTime();if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return Math.floor(d/86400000)+'d ago';}
function fmtDate(ts){if(!ts)return'';try{return new Date(ts).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'});}catch(e){return ts;}}
function parseConvo(raw){
  if(!raw||typeof raw!=='string')return[];
  // Filter to non-empty lines only
  var lines=raw.split('\n').map(function(l){return l.trim();}).filter(function(l){return l.length>0;});
  
  // Find where conversation section starts
  var convoStart=-1;
  for(var i=0;i<lines.length;i++){
    if(lines[i]==='Conversation'||lines[i]==='Comments can not be edited.'){convoStart=i;break;}
  }
  
  // Fallback: try MM/DD - text format (user-saved notes)
  if(convoStart===-1){
    var DATE_LINE=/^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s*[-\u2013]\s*(.+)$/;
    return lines.reduce(function(acc,line){
      var m=line.match(DATE_LINE);
      if(m&&m[2]&&m[2].trim().length>3){
        var isVendor=/amerit|freightliner|volvo|peterbilt|kenworth|ta truck|ta |tct|dealer|shop|penske|ryder|daimler|paccar|asist|navistar|international/i.test(m[2]);
        acc.push({date:m[1],text:m[2].trim(),side:isVendor?'vendor':'carrier'});
      }
      return acc;
    },[]);
  }
  
  // Parse Relay Garage conversation format
  var TIMESTAMP=/^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4})\s+\d{1,2}:\d{2}(?:AM|PM)/i;
  var JUNK=/^(Work Request|Internal Only|Shared with|Enter Comments|DO NOT enter|Add Comment|Share Comment|Recipient|Comments can not|Conversation|Add Comment To|Share Comment With)$/i;
  var MONTH_MAP={Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
  
  var results=[];
  var i=convoStart+1;
  while(i<lines.length){
    var line=lines[i];
    // Skip junk lines
    if(JUNK.test(line)){i++;continue;}
    // Look for timestamp pattern
    var tsMatch=line.match(TIMESTAMP);
    if(tsMatch){
      var dateStr=tsMatch[1]; // "Jul 2, 2026"
      var parts=dateStr.replace(',','').split(/\s+/);
      var mm=MONTH_MAP[parts[0]]||'??';
      var dd=parts[1].length<2?'0'+parts[1]:parts[1];
      var shortDate=mm+'/'+dd;
      
      // Collect message lines until next timestamp or end
      var msgLines=[];
      i++;
      while(i<lines.length){
        var ml=lines[i];
        if(JUNK.test(ml)){i++;continue;}
        if(TIMESTAMP.test(ml))break;
        // If this line is short (username) and next non-junk is a timestamp, stop
        if(ml.length<25){
          var peek=i+1;
          while(peek<lines.length&&JUNK.test(lines[peek]))peek++;
          if(peek<lines.length&&TIMESTAMP.test(lines[peek]))break;
        }
        msgLines.push(ml);
        i++;
      }
      var text=(function(_raw){
        return _raw
          // Trailing form junk (everything after)
          .replace(/\s*Enter Comments\.?\s*DO NOT enter[\s\S]*/i,'')
          .replace(/\s*Share Comment With[\s\S]*/i,'')
          .replace(/\s*Add Comment[\s\S]*/i,'')
          // "Shared with ..." anywhere
          .replace(/\s*Shared with (?:Carrier and Vendor|Vendor and Carrier|Vendor|Carrier)\s*/gi,' ')
          // "Work Order #N" noise
          .replace(/\s*Work Order (?:#?\d+|#\w+)\s*/gi,' ')
          // Dollar amounts
          .replace(/\$[\d,]+\.\d{2}/g,'[est]')
          // Phone numbers
          .replace(/(?:\+1)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?:[,\d]*)?/g,'')
          .replace(/One-click Connect Number:\s*/gi,'')
          // GPS coordinates
          .replace(/\bpoc:\s*[\d.-]+,\s*[\d.-]+/gi,'')
          .replace(/\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/g,'')
          // Personal names in common patterns
          .replace(/\bs\/w\s+\w+/gi,'s/w [contact]')
          .replace(/\bspoken with\s+\w+/gi,'spoken with [contact]')
          .replace(/:\s*\w+\(\w+\)\s/g,': [contact] ')
          // Street addresses
          .replace(/\d+\s+[\w\s]+(?:St|Ave|Blvd|Rd|Dr|Ln|Way|Ct|Pl|Pkwy|Hwy),?\s*[\w\s]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,\s*United States)?/gi,'[address]')
          // AMZ internal IDs
          .replace(/amz-[a-z0-9]+/gi,'')
          // Dangling "and Vendor/Carrier"
          .replace(/\s+and (?:Vendor|Carrier)\b/gi,'')
          // RelayGarage trailing
          .replace(/\s*RelayG(?:arage)?\s*$/i,'')
          // Trailing artifacts: lone periods, dashes, colons
          .replace(/[\s.:-]+$/,'')
          // Collapse spaces
          .replace(/\s{2,}/g,' ')
          .trim();
      })(msgLines.join(' ').trim());
      if(text.length>8 && !/^https?:\/\//i.test(text) && !/^(w\/nra|w\/chassis|wPV|Yard Location Update|est$|Tire repairs|\[phone\]|\[address\]$|\.\s*$)/i.test(text)){
        var isVendor=/amerit|freightliner|volvo|peterbilt|kenworth|ta truck|ta |tct|dealer|shop|penske|ryder|daimler|paccar|asist|navistar|international|decisiv/i.test(text);
        results.push({date:shortDate,text:text,side:isVendor?'vendor':'carrier'});
      }
    } else {
      i++;
    }
  }
  return results;
}
function parseDuration(raw){if(!raw)return null;var m=String(raw).match(/(\d+(?:\.\d+)?)/);return m?parseFloat(m[1]):null;}
function workDurationBar(unit){
  var created=unit.created;
  if(!created)return'';
  var start=new Date(created).getTime();
  if(isNaN(start))return'';
  var now=Date.now();
  var daysElapsed=Math.floor((now-start)/86400000);
  var durDays=parseDuration(unit.workDuration);

  // No workDuration: show open-ended elapsed bar (created → today)
  if(!durDays){
    var openCls=daysElapsed>14?'overdue':daysElapsed>7?'warn':'ok';
    return '<div class="dp-etc-wrap">'+
      '<div class="dp-etc-title"><span>Work Duration</span><span class="dp-etc-remain">'+daysElapsed+'d elapsed (no ETC set)</span></div>'+
      '<div class="dp-etc-track">'+
        '<div class="dp-etc-fill dp-etc-fill--'+openCls+'" style="width:100%"></div>'+
        '<div class="dp-etc-marker" style="left:97%"></div>'+
      '</div>'+
      '<div class="dp-etc-labels">'+
        '<span>Started '+fmtDate(created)+'</span>'+
        '<span>Day '+daysElapsed+'</span>'+
        '<span>Today '+fmtDate(now)+'</span>'+
      '</div>'+
    '</div>';
  }

  // Has workDuration: show progress bar vs ETC
  var end=start+(durDays*86400000);
  var pct=Math.min(Math.round(((now-start)/(end-start))*100),100);
  var overdue=now>end;
  var daysRemain=overdue?0:Math.ceil((end-now)/86400000);
  var cls=overdue?'overdue':pct>75?'warn':'ok';
  var label=overdue?('<span style="color:var(--red);font-weight:600">\u26a0 Overdue by '+Math.ceil((now-end)/86400000)+'d</span>'):(daysRemain+'d left of '+durDays+'d');
  return '<div class="dp-etc-wrap">'+
    '<div class="dp-etc-title"><span>Work Duration</span><span class="dp-etc-remain">'+label+'</span></div>'+
    '<div class="dp-etc-track">'+
      '<div class="dp-etc-fill dp-etc-fill--'+cls+'" style="width:'+pct+'%"></div>'+
      '<div class="dp-etc-marker" style="left:'+Math.min(pct,97)+'%"></div>'+
    '</div>'+
    '<div class="dp-etc-labels">'+
      '<span>Started '+fmtDate(created)+'</span>'+
      '<span>Day '+daysElapsed+' / '+durDays+'</span>'+
      '<span>ETC '+fmtDate(end)+'</span>'+
    '</div>'+
  '</div>';
}

// ── header ────────────────────────────────────────────────────────────────────
function renderHeader(unit){
  var isUnavail=(unit.lifecycleState||'').toLowerCase().includes('unavail');
  var risk=parseInt(unit.riskScore,10)||0;
  var hdrCls=isUnavail?'unavailable':risk>=60?'risk':'active';
  var dd=downDays(unit);
  var timerCls=dd>14?'dp-vital--red':dd>7?'dp-vital--org':'dp-vital--grn';
  var aapUrl=esc(unit.assetUrl||'');
  var relayUrl=esc(unit.serviceUrl||unit.savedOffsiteUrl||'');
  // FIX: same stale-URL priority bug as the split-view resolver below --
  // asistSrUrl (original SR link) must not win over offsiteShopEventUrl
  // (enrichment's best-known link, upgraded to /fleet/estimates/ when found).
  var offsiteUrl=esc(unit.offsiteShopEventUrl||unit.savedOffsiteUrl||unit.asistSrUrl||'');

  // meta row: make/model/year · type · fuel · domicile · operator
  // _resolveAssetType: maps raw AAP assetType/bodyType to human-friendly label
  function _resolveAssetType(unit) {
    var at = (unit.assetType || '').trim().toLowerCase();
    var bt = (unit.bodyType  || '').trim().toLowerCase();
    if (at === 'tractor' || bt === 'tractor') {
      return bt.includes('sleeper') ? 'Sleeper' : 'Day Cab';
    }
    if (at === 'standard' || bt === 'standard') return 'Box Truck';
    return unit.assetType || unit.bodyType || '';
  }
  var make=[unit.manufacturer||unit.make,unit.model,unit.modelYear].filter(Boolean).join(' ');
  var metaParts=[make,_resolveAssetType(unit),unit.fuelType,unit.domicileSite||unit.domicile,unit.operator,unit.program].filter(Boolean).map(esc);
  var meta=metaParts.join(' \u00b7 ');

  var vitals=[
    dd!==null?'<span class="dp-vital '+timerCls+'"><span class="dp-vital__icon">\u23f1</span>'+dd+'d down</span>':'',
    risk?'<span class="dp-vital dp-vital--'+riskColor(risk)+'"><span class="dp-vital__icon">\u26a1</span>Risk '+risk+'</span>':'',
    unit.openUnplanned>0?'<span class="dp-vital dp-vital--org"><span class="dp-vital__icon">\u26a0</span>'+unit.openUnplanned+' WR</span>':'',
    unit.urgent==='Yes'||unit.urgent===true?'<span class="dp-vital dp-vital--red"><span class="dp-vital__icon">\ud83d\udd34</span>URGENT</span>':'',
    unit.vendor?'<span class="dp-vital dp-vital--acc"><span class="dp-vital__icon">\ud83c\udfe2</span>'+esc(unit.vendor)+'</span>':'',
    unit.workDuration?'<span class="dp-vital dp-vital--muted"><span class="dp-vital__icon">\u23f3</span>'+esc(unit.workDuration)+'</span>':'',
  ].filter(Boolean).join('');

  var launchers=[
    aapUrl?'<button class="dp-launcher" title="Open AAP" data-aap-url="'+aapUrl+'">\ud83d\udd17 AAP</button>':'',
    relayUrl?'<button class="dp-launcher" title="Open Relay WR" data-ext-url="'+relayUrl+'">\ud83d\udcc4 Relay</button>':'',
    offsiteUrl?'<button class="dp-launcher" title="Open Offsite Portal" data-ext-url="'+offsiteUrl+'">\ud83c\udfe6 Portal</button>':'',
  ].filter(Boolean).join('');

  return '<div class="dp-header dp-header--'+hdrCls+'">'+
    '<div class="dp-header__scan"></div>'+
    '<div class="dp-header__top">'+
      '<span class="dp-header__id">'+esc(unit.equipmentId)+'</span>'+
      (unit.vin?'<span class="dp-header__vin">'+esc(unit.vin)+'</span>':'')+
      '<span class="dp-header__state-badge dp-header__state-badge--'+(isUnavail?'unavailable':'active')+'">'+esc(unit.lifecycleState||'Active')+'</span>'+
      '<div class="dp-header__launchers">'+launchers+'</div>'+
      '<button id="dp-close" class="dp-header__close">\u00d7</button>'+
    '</div>'+
    (meta?'<div class="dp-header__meta">'+meta+'</div>':'')+
    (unit.lifecycleReason?'<div class="dp-header__reason">\u2192 '+esc(unit.lifecycleReason)+'</div>':'')+
    '<div class="dp-header__vitals">'+vitals+'</div>'+
  '</div>';
}

// ── tabs ──────────────────────────────────────────────────────────────────────
function renderTabs(unit){
  var woCount=(unit.openUnplanned||0)+(unit.openPlanned||0);
  var insCount=(unit.insightsList||[]).length;
  function badge(n,red){return n?'<span class="dp-tab__badge'+(red?' dp-tab__badge--red':'')+'">'+n+'</span>':'';}
  var tabs=[
    {id:'repair',label:'Repair',b:badge(woCount,true)},
    {id:'intel', label:'Intel', b:badge(insCount,false)},
    {id:'actions',label:'Actions',b:''},
    {id:'history',label:'History',b:''},
  ];
  var isUnavail=(unit.lifecycleState||'').toLowerCase().includes('unavail');
  var risk=parseInt(unit.riskScore,10)||0;
  var def=isUnavail||woCount>0?'repair':risk>=60?'intel':'repair';
  return '<div class="dp-tabs">'+tabs.map(function(t){return'<button class="dp-tab'+(t.id===def?' active':'')+'" data-tab="'+t.id+'">'+t.label+t.b+'</button>';}).join('')+'</div>';
}

// ── Split-view auto-draft helpers ──────────────────────────────────────────────
// Builds a draft comment for the Relay Garage comment box based on the unit's
// latest offsite update or escalation need. Returns null if nothing meaningful.
function _buildRelayDraft(unit) {
  if (!unit) return null;
  var tl = (unit.repairTimeline || '').trim();
  var lines = tl ? tl.split('\n').filter(Boolean) : [];
  var lastLine = lines.length ? lines[lines.length - 1] : '';

  // Calculate days since last timeline entry
  var daysSilent = 0;
  var dateMatch = lastLine.match(/^(\d{1,2})\/(\d{1,2})/);
  if (dateMatch) {
    var now = new Date();
    var entryDate = new Date(now.getFullYear(), parseInt(dateMatch[1],10) - 1, parseInt(dateMatch[2],10));
    if (entryDate > now) entryDate.setFullYear(now.getFullYear() - 1);
    daysSilent = Math.round((now - entryDate) / (24*60*60*1000));
  }

  var vendor = unit.vendor || 'vendor';
  var equipId = unit.equipmentId || '';

  // If 3+ days since last update — escalation draft
  if (daysSilent >= 3) {
    return 'Requesting repair status update on unit ' + equipId + '. No logged vendor activity in ' + daysSilent + ' days. Please provide current repair status, any parts pending, and estimated time to completion (ETC).';
  }

  // If there's a recent timeline entry with useful content — relay it
  var lastContent = lastLine.replace(/^\d{1,2}\/\d{1,2}\s*[-–]\s*/, '').trim();
  if (lastContent && lastContent.length > 10) {
    return 'Per latest update: ' + lastContent + ' — Tracking for next steps/ETC.';
  }

  return null;
}

// Builds a draft note for the offsite (Decisiv/ASIST) notes field.
// Requests status update / escalation from the dealer.
function _buildOffsiteDraft(unit) {
  if (!unit) return null;
  var tl = (unit.repairTimeline || '').trim();
  var lines = tl ? tl.split('\n').filter(Boolean) : [];
  var lastLine = lines.length ? lines[lines.length - 1] : '';

  var daysSilent = 0;
  var dateMatch = lastLine.match(/^(\d{1,2})\/(\d{1,2})/);
  if (dateMatch) {
    var now = new Date();
    var entryDate = new Date(now.getFullYear(), parseInt(dateMatch[1],10) - 1, parseInt(dateMatch[2],10));
    if (entryDate > now) entryDate.setFullYear(now.getFullYear() - 1);
    daysSilent = Math.round((now - entryDate) / (24*60*60*1000));
  }

  var equipId = unit.equipmentId || '';

  if (daysSilent >= 3) {
    return 'Requesting repair status update for unit ' + equipId + '. No activity logged in ' + daysSilent + ' days. Please provide: current repair status, parts status (if applicable), and estimated completion date. If repair is complete, please confirm so unit can be released back to service.';
  }

  // Default — general status request
  return 'Please provide a status update for unit ' + equipId + ': current repair progress, any parts pending, and estimated time to completion.';
}

// ── repair pane ───────────────────────────────────────────────────────────────
function _openInlineSplit(leftUrl, rightUrl, unitId) {
  var existing = document.getElementById('dp-split-container');
  if (existing) existing.remove();
  if (!leftUrl && !rightUrl) return;

  var container = document.createElement('div');
  container.id = 'dp-split-container';
  container.className = 'dp-split-container';

  var html = '<div class="dp-split-header">' +
    '<span class="dp-split-title">' + esc(unitId) + ' \u2014 Live View</span>' +
    '<button class="dp-split-close" id="dp-split-close">\u2715 Close</button></div>';

  html += '<div class="dp-split-views">';
  if (leftUrl) {
    html += '<div class="dp-split-pane dp-split-pane--relay">' +
      '<div class="dp-split-pane-label">RELAY GARAGE</div>' +
      '<webview id="dp-wv-relay" src="' + leftUrl + '" class="dp-split-webview" allowpopups></webview></div>';
  }
  if (rightUrl) {
    // Determine correct vendor partition for the offsite URL
    var vendorPartition = 'persist:vendor-paccar'; // default
    if (rightUrl.indexOf('volvopg') > -1 || rightUrl.indexOf('asist.decisiv') > -1) vendorPartition = 'persist:vendor-volvo';
    else if (rightUrl.indexOf('dtna') > -1 || rightUrl.indexOf('daimlertruck') > -1) vendorPartition = 'persist:vendor-dtna';
    else if (rightUrl.indexOf('pssmfleet') > -1) vendorPartition = 'persist:vendor-paccar-pssmfleet';

    html += '<div class="dp-split-pane dp-split-pane--offsite">' +
      '<div class="dp-split-pane-label">OFFSITE</div>' +
      '<webview id="dp-wv-offsite" src="' + rightUrl + '" class="dp-split-webview" partition="' + vendorPartition + '" allowpopups></webview></div>';
  }
  html += '</div>';

  container.innerHTML = html;
  document.getElementById('app').appendChild(container);
  document.getElementById('dp-split-close').addEventListener('click', function() { container.remove(); });

  var relayWv = document.getElementById('dp-wv-relay');
  if (relayWv) {
    relayWv.addEventListener('dom-ready', function() {
      relayWv.executeJavaScript('setTimeout(function(){ var btns=document.querySelectorAll("button,a,[role=button]"); for(var i=0;i<btns.length;i++){if((btns[i].textContent||"").indexOf("Toggle Comments")>-1){btns[i].click();break;}} setTimeout(function(){ var h1s=document.querySelectorAll("h1"); var conv=null; for(var i=0;i<h1s.length;i++){if(h1s[i].textContent==="Conversation"){conv=h1s[i].closest("[aria-hidden]")||h1s[i].parentElement.parentElement.parentElement.parentElement;break;}} if(conv){conv.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;overflow-y:auto;background:#fff;z-index:99999";var all=document.body.children;for(var j=0;j<all.length;j++){if(all[j]!==conv&&!conv.contains(all[j])&&!all[j].contains(conv)){all[j].style.display="none";}}} },2500); },1500)').catch(function(){});

      // Pre-fill Relay comment box with a draft based on latest offsite/timeline
      var _u = window.__splitUnit;
      var _relayDraft = _buildRelayDraft(_u);
      if (_relayDraft) {
        setTimeout(function() {
          relayWv.executeJavaScript(
            'setTimeout(function(){' +
            'var ta=document.querySelector("textarea");' +
            'if(!ta){var all=document.querySelectorAll("input[type=text],textarea");ta=all[all.length-1];}' +
            'if(ta){ta.value=' + JSON.stringify(_relayDraft) + ';ta.dispatchEvent(new Event("input",{bubbles:true}));ta.style.background="#fffbe6";}' +
            '},1000)'
          ).catch(function(){});
        }, 5000); // wait for page to fully render + comments to toggle
      }
    });
  }

  var offsiteWv = document.getElementById('dp-wv-offsite');
  if (offsiteWv) {
    // Auto-login: if the offsite webview lands on a login page, close it
    // and reopen as a BrowserWindow (which has full auto-login wired).
    offsiteWv.addEventListener('did-finish-load', function() {
      offsiteWv.executeJavaScript(
        '(function(){' +
        'var pw=document.querySelectorAll("input[type=password]").length;' +
        'var uid=document.querySelectorAll("input[placeholder*=User],input[type=email],input[type=text]").length;' +
        'return (pw>0&&uid>0)?"login":"ok";' +
        '})()'
      ).then(function(result) {
        if (result !== 'login') return;
        // Login page detected in webview — reopen as BrowserWindow with auto-login
        var targetUrl = rightUrl;
        try { targetUrl = offsiteWv.getURL() || rightUrl; } catch(_) {}
        // Close the split view
        if (container && container.parentNode) container.remove();
        // Open via relay:open-url which has auto-login + correct partition
        if (window.files && window.files.openRelayUrl) {
          window.files.openRelayUrl(rightUrl);
        }
      }).catch(function(){});
    });

    offsiteWv.addEventListener('dom-ready', function() {
      offsiteWv.executeJavaScript('function waitForNotes(){var nb=document.querySelector("[data-testid=note-body]");var ta=document.querySelector("textarea[name=user-reply]");if(!nb){setTimeout(waitForNotes,1000);return;}var el=nb;while(el.parentElement&&el.parentElement!==document.body){el=el.parentElement;if(el.querySelector("[data-testid=note-body]")&&el.querySelector("textarea[name=user-reply]"))break;}el.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;overflow-y:auto;background:#fff;z-index:99999;padding:0";var sib=el.parentElement?el.parentElement.children:[];for(var i=0;i<sib.length;i++){if(sib[i]!==el)sib[i].style.display="none";}} setTimeout(waitForNotes,2000)').catch(function(){});

      // Pre-fill offsite notes textarea with escalation/update request
      var _u2 = window.__splitUnit;
      var _offsiteDraft = _buildOffsiteDraft(_u2);
      if (_offsiteDraft) {
        setTimeout(function() {
          offsiteWv.executeJavaScript(
            'setTimeout(function(){' +
            'var ta=document.querySelector("textarea[name=user-reply]");' +
            'if(!ta) ta=document.querySelector("textarea");' +
            'if(ta){ta.value=' + JSON.stringify(_offsiteDraft) + ';ta.dispatchEvent(new Event("input",{bubbles:true}));ta.style.background="#fffbe6";}' +
            '},2000)'
          ).catch(function(){});
        }, 5000);
      }
    });
  }
}


function _parseComments(text) {
  if (!text) return [];
  var lines = text.split('\n');
  var comments = [];

  // Find "Enter Comments" marker at the end — comments are before it
  var endMarker = -1;
  for (var i = lines.length - 1; i >= 0; i--) {
    if (lines[i].indexOf('Enter Comments') > -1 || lines[i].indexOf('Add Comment') > -1) {
      endMarker = i;
      break;
    }
  }
  if (endMarker === -1) endMarker = lines.length;

  // Pattern: user, blank, date, blank, text, blank, "Work Request"/"Service Event", blank, "Internal Only"/"Vendor"
  // Scan for date pattern to identify comment blocks
  var dateRx = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)s+d+,s+d{4}s+d+:d+[AP]M/;
  
  var i = 0;
  while (i < endMarker) {
    var line = (lines[i] || '').trim();
    // Skip empty lines
    if (!line) { i++; continue; }

    // Check if next non-empty line is a date
    var nextNonEmpty = '';
    var nextIdx = i + 1;
    while (nextIdx < endMarker && !(lines[nextIdx] || '').trim()) nextIdx++;
    nextNonEmpty = (lines[nextIdx] || '').trim();

    if (dateRx.test(nextNonEmpty) && line.length < 30 && /^[a-z]/i.test(line)) {
      // This is a username
      var user = line;
      var date = nextNonEmpty.replace(/\s*\(.*?\)\s*$/, ''); // strip "(X days ago)"

      // Skip past date to find message text
      var j = nextIdx + 1;
      while (j < endMarker && !(lines[j] || '').trim()) j++;
      var msgText = (lines[j] || '').trim();

      // Skip to find share type (Internal Only / Vendor)
      var share = 'Internal Only';
      var k = j + 1;
      while (k < endMarker && k < j + 6) {
        var sl = (lines[k] || '').trim();
        if (sl === 'Internal Only' || sl === 'Vendor') { share = sl; break; }
        k++;
      }

      if (msgText && msgText !== 'Work Request' && msgText !== 'Service Event' && msgText !== 'Internal Only') {
        comments.push({ user: user, date: date, text: msgText, share: share });
      }
      i = k + 1;
    } else {
      i++;
    }
  }
  return comments;
}

function _linkify(text) {
  return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:#58a6ff">$1</a>');
}


function _parseRelayConvo(raw) {
  if (!raw) return [];
  var msgs = [];
  // Comments are at the end, after "Toggle Comments" or near username patterns
  // Pattern: username\ndate\ntext\nWork Request|Service Event
  var lines = raw.split('\n');
  var i = 0;
  // Find start of comments section
  var commentStart = -1;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].match(/^\w+$/)) {
      // Potential username - check if next line is a date
      var nextLine = lines[i + 1] || '';
      if (nextLine.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4}/)) {
        commentStart = i;
        break;
      }
    }
  }
  if (commentStart === -1) {
    // Try finding from the end - look for "Add Comment" and work backwards
    for (i = lines.length - 1; i > 0; i--) {
      if (lines[i].includes('Add Comment') || lines[i].includes('Enter Comments')) {
        break;
      }
    }
    // Now scan upward to find first username+date pair
    for (var j = Math.max(0, i - 100); j < i; j++) {
      if (lines[j].match(/^\w+$/) && (lines[j+1] || '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4}/)) {
        commentStart = j;
        break;
      }
    }
  }

  if (commentStart === -1) return msgs;

  // Parse messages from commentStart
  i = commentStart;
  while (i < lines.length) {
    var user = (lines[i] || '').trim();
    var date = (lines[i + 1] || '').trim();
    if (!user || !date.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4}/)) {
      i++;
      continue;
    }
    // Collect message text (skip "Work Request", "Internal Only", "Service Event" lines)
    var text = '';
    var j = i + 2;
    while (j < lines.length) {
      var line = (lines[j] || '').trim();
      if (line === 'Work Request' || line === 'Internal Only' || line === 'Service Event' || line === 'Vendor') {
        j++;
        continue;
      }
      // If next line looks like a new username+date, stop
      if (line.match(/^\w+$/) && (lines[j + 1] || '').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d+,\s+\d{4}/)) {
        break;
      }
      if (line === 'Enter Comments. DO NOT enter any personal information.' || line === 'Add Comment') break;
      if (line) text += (text ? ' ' : '') + line;
      j++;
    }
    if (text) {
      msgs.push({ user: user, date: date.replace(/\s*\(.*?\)\s*$/, ''), text: text });
    }
    i = j;
  }
  return msgs;
}


function renderRepairPane(unit){
  // ── WR summary card ────────────────────────────────────────────────────────
  var hasRelay=unit.relaySynced&&(unit.vendor||unit.issueDetails||unit.workRequestId);
  var woCard='';
  if(hasRelay){
    var statusRaw=unit.serviceState||unit.status||(unit.completed?'Completed':'')||'';
    // Check unit.completed too (not just the raw state text) -- Relay's "State"
    // label doesn't always literally say "Closed"; it may say "Completed", which
    // didn't match the old 'clos'-only substring check and always fell through
    // to 'open' even for finished work orders.
    var statusKey=(unit.completed||/clos|complet/i.test(statusRaw))?'closed':/sour/i.test(statusRaw)?'sourcing':'open';
    var wrAge=unit.created?Math.floor((Date.now()-new Date(unit.created).getTime())/86400000):null;
    var stale=wrAge>3?'<span class="dp-wo-stale">\u26a0 '+wrAge+'d</span>':'';

    var fields=[
      unit.workRequestId?['WR ID',unit.workRequestId]:null,
      unit.vendorWorkOrderId?['Vendor WO',unit.vendorWorkOrderId]:null,
      unit.salesforceCase?['SF Case',unit.salesforceCase]:null,
      unit.createdBy?['Created By',unit.createdBy]:null,
      unit.needBy?['Need By',unit.needBy]:null,
      unit.serviceCategory?['Category',unit.serviceCategory]:null,
      unit.integratedMethod?['Method',unit.integratedMethod]:null,
      unit.program?['Program',unit.program]:null,
      unit.totalCost?['Total Cost',unit.totalCost]:null,
    ].filter(Boolean);

    var cause=unit.cause?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Reason:</span> '+esc(unit.cause)+'</div>':'';
    var correction=unit.correction?'<div class="dp-wo-cause"><span class="dp-wo-cause__label">Work Done:</span> '+esc(unit.correction)+'</div>':'';

    woCard='<div class="dp-wo-card">'+
      '<div class="dp-wo-card__header">'+
        '<span class="dp-wo-card__vendor">'+esc(unit.vendor||'Unknown Vendor')+'</span>'+
        (unit.subVendor&&unit.subVendor!==unit.vendor?'<span class="dp-wo-card__subvendor">'+esc(unit.subVendor)+'</span>':'')+
        '<span class="dp-wo-card__status-pill dp-wo-card__status-pill--'+statusKey+'">'+esc(statusRaw||'Open')+'</span>'+
        stale+
      '</div>'+
      ((unit.savedRepairStatus||unit.savedPrimaryComponent)?'<div class="dp-wo-card__ai-tags">'+
        (unit.savedRepairStatus?'<span class="dp-ai-tag dp-ai-tag--status">\uD83D\uDD27 '+esc(unit.savedRepairStatus)+'</span>':'')+
        (unit.savedPrimaryComponent?'<span class="dp-ai-tag dp-ai-tag--component">\u2699\uFE0F '+esc(unit.savedPrimaryComponent)+'</span>':'')+
      '</div>':'')+
      ((unit.issueSummary||unit.issueDetails)?'<div class="dp-wo-card__desc">'+(unit.issueSummary?'<span class="dp-orcha-badge">\uD83E\uDDE0</span> '+esc((unit.issueSummary||'').split('TIMELINE:')[0].split('\\n')[0].substring(0,200)):esc(unit.issueDetails))+'</div>':'')+
      cause+correction+
      (fields.length?'<div class="dp-wo-card__fields">'+fields.map(function(f){return'<span class="dp-wo-field"><span class="dp-wo-field__k">'+esc(f[0])+'</span><span class="dp-wo-field__v">'+esc(f[1])+'</span></span>';}).join('')+'</div>':'')+
      (unit.created||unit.completed?'<div class="dp-wo-card__dates">'+
        (unit.created?'<span>Opened '+fmtDate(unit.created)+'</span>':'')+
        (unit.completed?'<span>Closed '+fmtDate(unit.completed)+'</span>':'')+
      '</div>':'')+
    '</div>';
  } else {
    woCard='<div class="dp-empty-state"><span class="dp-empty-state__icon">\ud83d\udcc2</span>No Relay WR data</div>';
  }

  // ── work duration bar ──────────────────────────────────────────────────────
  // Planned WR card: shown for PM Failed / Expired Inspection Unavailable units
  // that also have an open Unplanned WR (primary scraped) AND an open Planned WR.
  // unit._plannedWRData is populated by the relay.js second-pass scrape.
  var plannedWRCard='';
  var _pmReasonsRe=/^(PM\s*Failed|Expired\s*Inspection)$/i;
  if(unit._plannedWRData && _pmReasonsRe.test(unit.lifecycleReason||'')){
    var p=unit._plannedWRData;
    var pStateRaw=p.serviceState||'';
    var pStateKey=(p.completed||/clos|complet/i.test(pStateRaw))?'closed':/sour/i.test(pStateRaw)?'sourcing':'open';
    var pFields=[
      p.workRequestId?['WR ID',p.workRequestId]:null,
      p.salesforceCase?['SF Case',p.salesforceCase]:null,
      p.serviceCategory?['Category',p.serviceCategory]:null,
      p.totalCost?['Total Cost',p.totalCost]:null,
    ].filter(Boolean);
    plannedWRCard=
      '<div class="dp-section-title dp-section-title--planned">Planned Work Order</div>'+
      '<div class="dp-wo-card dp-wo-card--planned">'+
        '<div class="dp-wo-card__header">'+
          '<span class="dp-wo-card__vendor">'+esc(p.vendor||'Unknown Vendor')+'</span>'+
          '<span class="dp-wo-card__status-pill dp-wo-card__status-pill--'+pStateKey+'">'+esc(pStateRaw||'Open')+'</span>'+
        '</div>'+
        (p.issueDetails?'<div class="dp-wo-card__desc">'+esc(p.issueDetails)+'</div>':'')+
        (pFields.length?'<div class="dp-wo-card__fields">'+pFields.map(function(f){
          return '<span class="dp-wo-field"><span class="dp-wo-field__k">'+esc(f[0])+'</span><span class="dp-wo-field__v">'+esc(f[1])+'</span></span>';
        }).join('')+'</div>':'')+
        (p.created||p.completed?'<div class="dp-wo-card__dates">'+
          (p.created?'<span>Opened '+fmtDate(p.created)+'</span>':'')+
          (p.completed?'<span>Closed '+fmtDate(p.completed)+'</span>':'')+
        '</div>':'')+
        // FIX (2026-08-17): give the Planned WR its own Split View button too.
        // Its Relay URL is built from _serviceUUID (scrapeServiceByUUID doesn't
        // attach _relayUrl to _plannedWRData the way it does for _secondaryWRs).
        (function(){
          var _plUuid = p._serviceUUID || '';
          if (!_plUuid) return '';
          var _plRelay = 'https://aap-na.corp.amazon.com/v2/service/' + _plUuid;
          var _plOffsite = p.offsiteShopEventUrl || p.asistSrUrl || '';
          return '<div class="dp-wo-card__dates" style="gap:10px;flex-wrap:wrap">' +
            '<button class="dp-split-view-btn" style="font-size:9px;padding:3px 10px"' +
              ' data-secondary-split="1"' +
              ' data-split-left="' + esc(_plRelay) + '"' +
              ' data-split-right="' + esc(_plOffsite) + '">' +
              '🔍 Open in Relay (Split View)</button>' +
          '</div>';
        })()+
      '</div>';
  }


  // ── secondary WR cards (multi-WR pass) ──────────────────────────────────
  // One card per entry in unit._secondaryWRs, styled same as plannedWRCard.
  var secondaryWRCards = '';
  var _secondaryRelayUrl = ''; // captured for split-view below
  if (Array.isArray(unit._secondaryWRs) && unit._secondaryWRs.length) {
    unit._secondaryWRs.forEach(function(p, idx) {
      if (idx === 0) _secondaryRelayUrl = p._relayUrl || '';
      var pStateRaw  = p.serviceState || '';
      var pStateKey  = (p.completed || /clos|complet/i.test(pStateRaw)) ? 'closed'
                     : /sour/i.test(pStateRaw) ? 'sourcing' : 'open';
      var pTypeLabel = p._wrType === 'planned' ? 'Planned' : 'Unplanned';
      var pFields = [
        p.workRequestId   ? ['WR ID',      p.workRequestId]   : null,
        p.salesforceCase  ? ['SF Case',    p.salesforceCase]  : null,
        p.serviceCategory ? ['Category',   p.serviceCategory] : null,
        p.totalCost       ? ['Total Cost', p.totalCost]       : null,
      ].filter(Boolean);
      secondaryWRCards +=
        '<div class="dp-section-title dp-section-title--planned">' + pTypeLabel + ' Work Order</div>' +
        '<div class="dp-wo-card dp-wo-card--planned">' +
          '<div class="dp-wo-card__header">' +
            '<span class="dp-wo-card__vendor">' + esc(p.vendor || 'Unknown Vendor') + '</span>' +
            '<span class="dp-wo-card__status-pill dp-wo-card__status-pill--' + pStateKey + '">' + esc(pStateRaw || 'Open') + '</span>' +
          '</div>' +
          (p.issueDetails ? '<div class="dp-wo-card__desc">' + esc(p.issueDetails) + '</div>' : '') +
          (pFields.length ? '<div class="dp-wo-card__fields">' + pFields.map(function(f) {
            return '<span class="dp-wo-field"><span class="dp-wo-field__k">' + esc(f[0]) + '</span>' +
                   '<span class="dp-wo-field__v">' + esc(f[1]) + '</span></span>';
          }).join('') + '</div>' : '') +
          ((p.created || p.completed) ? '<div class="dp-wo-card__dates">' +
            (p.created   ? '<span>Opened ' + fmtDate(p.created)   + '</span>' : '') +
            (p.completed ? '<span>Closed ' + fmtDate(p.completed) + '</span>' : '') +
          '</div>' : '') +
          (function() {
            // FIX (2026-08-17): two bugs on secondary/multi-WR cards —
            //  (1) "Open in Relay ↗" used data-ext-url (opened an EXTERNAL
            //      window), never the split view.
            //  (2) The Split View button only rendered when an OFFSITE url
            //      existed, so a secondary WR with a Relay link but no offsite
            //      (e.g. 921126's planned APU WR) got NO Split View option.
            // Now: Split View is available whenever _relayUrl exists (offsite
            // optional — _openInlineSplit handles a missing right pane), and
            // "Open in Relay ↗" opens the split view too. The offsite link (if
            // any) stays as its own external link.
            if (!p._relayUrl) return '';
            var _pOffsite = p.offsiteShopEventUrl || p.asistSrUrl || '';
            var _pLabel   = p.asistLabel || p.offsiteShopEvent || 'ASIST';
            return '<div class="dp-wo-card__dates" style="gap:10px;flex-wrap:wrap">' +
              '<button class="dp-split-view-btn" style="font-size:9px;padding:3px 10px"' +
                ' data-secondary-split="1"' +
                ' data-split-left="' + esc(p._relayUrl) + '"' +
                ' data-split-right="' + esc(_pOffsite) + '">' +
                '🔍 Open in Relay (Split View)</button>' +
              (_pOffsite ? ' <a class="dp-wo-card__relay-link" href="#" data-ext-url="' + esc(_pOffsite) + '">' + esc(_pLabel) + ' ↗</a>' : '') +
            '</div>';
          })() +
        '</div>';
    });
  }

  var durBar=workDurationBar(unit);

  // ── Conversation → vertical timeline ──────────────────────────────────────
  // parseConvo removed — AI timeline is the only source of truth
  _allConvoMsgs = [];
  // === ORCHA REPAIR TIMELINE (Source of Truth) ===
  var aiTimeline = unit.repairTimeline || '';
  var orchaNote = unit.savedNotes || '';
  var timelineHtml = '';

  // The add button + input row + timeline container must ALWAYS render, even when
  // no AI timeline exists yet (e.g. Orcha deep-scan hasn't run, or an AI call failed
  // due to a token/quota limit). Manual entries are immutable truth and must be
  // addable at any time -- they should never be gated behind AI availability.
  var tlEntries = aiTimeline ? aiTimeline.split('\n').filter(function(l){ var t=l.trim(); return t.length > 5 && !t.toLowerCase().includes('[no update logged]') && !(t.toLowerCase().includes('requested') && t.toLowerCase().includes('update') && t.toLowerCase().includes('vendor')); }) : [];
  var tlEntriesHtml = tlEntries.length
    ? tlEntries.map(function(entry) {
        var m = entry.trim().match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*(.+)$/);
        if (m) {
          return '<div class="dp-tl3-item dp-tl3-dot--ai" data-entry="' + encodeURIComponent(entry.trim()) + '">' +
            '<span class="dp-tl3-date">' + esc(m[1]) + '</span>' +
            '<span class="dp-tl3-dash"> \u2014 </span>' +
            '<span class="dp-tl3-text">' + esc(m[2]) + '</span>' + '<span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span></div>';
        }
        return '<div class="dp-tl3-item dp-tl3-dot--ai" data-entry="' + encodeURIComponent(entry.trim()) + '"><span class="dp-tl3-text">' + esc(entry.trim()) + '</span>' + '<span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span></div>';
      }).join('')
    : '<div class="dp-empty-state dp-empty-state--tl"><span class="dp-empty-state__icon">\uD83E\uDDE0</span>No AI timeline yet \u2014 generates on next Orcha scan. Add a manual update below any time.</div>';

  timelineHtml =
    '<div class="dp-section-title">\uD83E\uDDE0 Repair Timeline <span class="dp-section-count">' + tlEntries.length + ' events</span><button class="dp-tl-add-btn" id="dp-tl-add" title="Add entry">+</button></div>' +
    '<div id="dp-tl-input-row" class="dp-tl-input-row" style="display:none"><input id="dp-tl-input" class="dp-tl-input" type="text" placeholder="Type update... (saved immediately)"/><button id="dp-tl-submit" class="dp-tl-submit-btn">Add</button></div>' +
    '<div class="dp-orcha-timeline">' + tlEntriesHtml + '</div>';

  // FIX: was `unit.asistSrUrl||unit.savedOffsiteUrl||unit.offsiteShopEventUrl` --
  // asistSrUrl is the ORIGINAL Volvo ASIST service_request URL (e.g.
  // .../service_requests/975426), always populated once enrichment has ever
  // run once, and it was checked FIRST -- so Split View kept opening the
  // stale SR page forever, no matter how well asist_enrich.js's upgrade
  // chase worked. savedOffsiteUrl/offsiteShopEventUrl hold the enrichment's
  // best-known link (Fleet Estimate when found) and must win. asistSrUrl is
  // now only a last-resort fallback if nothing better was ever scraped.
  var offsiteUrl=unit.savedOffsiteUrl||unit.offsiteShopEventUrl||unit.asistSrUrl||'';

  // Split-view button (Relay + Offsite side by side)
  var splitViewBtn = '';
  var relayUrl = unit.serviceUrl || '';
  if (relayUrl || offsiteUrl) {
    splitViewBtn = '<div class="dp-split-view-row"><button class="dp-split-view-btn" id="dp-split-open" title="Open Relay Garage and Offsite side by side">\u{1F50D} Open Split View</button></div>';
  }
  var offsiteLabel=unit.asistLabel||unit.savedOffsiteEvent||unit.offsiteShopEvent||offsiteUrl;
  var src=unit.asistSource||'';
  var scrapedAt=unit.asistScrapedAt||'';
  var staleOffsite=scrapedAt&&(Date.now()-new Date(scrapedAt).getTime())>86400000;
  var offsiteHtml=offsiteUrl?
    '<div class="dp-section-title">Offsite Event</div>'+
    '<div class="dp-offsite-card">'+
      '<div class="dp-offsite-card__header">'+
        (src?'<span class="dp-offsite-card__src-badge dp-offsite-card__src-badge--'+esc(src)+'">'+esc(src)+'</span>':'')+
        '<a class="dp-offsite-card__link" href="#" data-ext-url="'+esc(offsiteUrl)+'">'+esc(offsiteLabel||offsiteUrl)+' \u2197</a>'+
        (staleOffsite?'<span class="dp-offsite-card__stale">\u26a0 stale</span>':'')+
      '</div>'+
      (unit.dealerName?'<div class="dp-offsite-card__dealer">'+esc(unit.dealerName)+'</div>':'')+
      (scrapedAt?'<div class="dp-offsite-card__ts">Enriched '+fmtDate(scrapedAt)+'</div>':'')+
    '</div>':'';

  
  // Live timeline update: when AI or user adds to timeline, refresh instantly
  if (window.fleet && window.fleet.onNotesUpdated) {
    window.fleet.onNotesUpdated(function(data) {
      if (data && data.unitId === unit.equipmentId && data.timeline) {
        var tlEl = document.querySelector('.dp-orcha-timeline');
        if (tlEl) {
          var entries = data.timeline.split('\n').filter(function(l){ var t=l.trim(); return t.length > 5 && !t.toLowerCase().includes('[no update logged]') && !(t.toLowerCase().includes('requested') && t.toLowerCase().includes('update') && t.toLowerCase().includes('vendor')); });
          tlEl.innerHTML = entries.map(function(entry) {
            var m = entry.trim().match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*(.+)$/);
            if (m) return '<div class="dp-tl3-item dp-tl3-dot--ai" data-entry="' + encodeURIComponent(entry.trim()) + '"><span class="dp-tl3-date">' + esc(m[1]) + '</span><span class="dp-tl3-dash"> \u2014 </span><span class="dp-tl3-text">' + esc(m[2]) + '</span><span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span></div>';
            return '<div class="dp-tl3-item dp-tl3-dot--ai" data-entry="' + encodeURIComponent(entry.trim()) + '"><span class="dp-tl3-text">' + esc(entry.trim()) + '</span><span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span></div>';
          }).join('');
          // Update count
          var countEl = document.querySelector('.dp-section-count');
          if (countEl) countEl.textContent = entries.length + ' events';
        }
      }
    });
  }

  // Wire the + button and quick-add input
  setTimeout(function() {
    var addBtn = document.getElementById('dp-tl-add');
    var inputRow = document.getElementById('dp-tl-input-row');
    var input = document.getElementById('dp-tl-input');
    var submitBtn = document.getElementById('dp-tl-submit');
    
    if (addBtn && inputRow) {
      addBtn.addEventListener('click', function() {
        inputRow.style.display = inputRow.style.display === 'none' ? 'flex' : 'none';
        if (input) input.focus();
      });
    }
    
    function doAdd() {
      if (!input || !input.value.trim()) return;
      var raw = input.value.trim();
      var now = new Date();
      var dateStr = (now.getMonth()+1).toString().padStart(2,'0') + '/' + now.getDate().toString().padStart(2,'0');
      var entry = dateStr + ' - ' + raw;
      
      // Save immediately (truth - user typed it). No AI call in this path, so it
      // works even when Orcha token quota is exhausted.
      // BUG FIX: this called window.notes.addTimeline, but addTimeline has only
      // ever been exposed on the window.fleet bridge (see preload.js) -- the
      // guard below silently no-op'd every time, so a manually-added timeline
      // entry was NEVER actually persisted to notesStore/fleetData. It only
      // *looked* like it worked because the DOM is updated directly a few
      // lines down regardless of whether the save call fired. On the next
      // fleetData reload (sync, app restart) the "saved" entry would silently
      // vanish, defeating the entire "manual entries are immutable truth"
      // guarantee this feature exists to provide.
      if (window.fleet && window.fleet.addTimeline) {
        window.fleet.addTimeline(unit.equipmentId, entry);
      }
      
      // Show immediately in UI
      var tlEl = document.querySelector('.dp-orcha-timeline');
      if (tlEl) {
        var emptyState = tlEl.querySelector('.dp-empty-state--tl');
        if (emptyState) emptyState.remove();
        tlEl.innerHTML += '<div class="dp-tl3-item dp-tl3-dot--ai" style="border-left-color:#f0a800" data-entry="' + encodeURIComponent(entry) + '"><span class="dp-tl3-date">' + dateStr + '</span><span class="dp-tl3-dash"> \u2014 </span><span class="dp-tl3-text">' + esc(raw) + '</span><span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span></div>';
      }
      var countEl = document.querySelector('.dp-section-count');
      if (countEl) countEl.textContent = ((parseInt(countEl.textContent, 10) || 0) + 1) + ' events';
      
      input.value = '';
      inputRow.style.display = 'none';
    }
    
    if (submitBtn) submitBtn.addEventListener('click', doAdd);
    if (input) input.addEventListener('keydown', function(e) { if (e.key === 'Enter') doAdd(); });

    // ── Hide / edit a timeline entry ──────────────────────────────────────
    // Delegated on the container (not per-item) so it keeps working after
    // live rebuilds (onNotesUpdated) replace tlEl.innerHTML wholesale -- a
    // per-item listener would be silently lost on every such rebuild.
    var tlContainerEl = document.querySelector('.dp-orcha-timeline');
    if (tlContainerEl && !tlContainerEl._hideEditWired) {
      tlContainerEl._hideEditWired = true;
      tlContainerEl.addEventListener('click', function(e) {
        var item = e.target.closest('.dp-tl3-item');
        if (!item) return;
        var rawEntry = decodeURIComponent(item.dataset.entry || '');

        if (e.target.closest('.dp-tl3-hide-btn')) {
          if (!window.confirm('Hide this timeline entry? This cannot be undone from the UI.')) return;
          if (window.fleet && window.fleet.hideTimeline) {
            window.fleet.hideTimeline(unit.equipmentId, rawEntry).catch(function(){});
          }
          item.remove();
          var cEl = document.querySelector('.dp-section-count');
          if (cEl) cEl.textContent = Math.max(0, (parseInt(cEl.textContent, 10) || 1) - 1) + ' events';
          return;
        }

        if (e.target.closest('.dp-tl3-edit-btn')) {
          var textEl = item.querySelector('.dp-tl3-text');
          var currentText = textEl ? textEl.textContent : rawEntry.replace(/^\d{2}\/\d{2}\s*[-\u2013]\s*/, '');
          item.innerHTML =
            '<input class="dp-tl-input dp-tl3-edit-input" type="text" value="' + esc(currentText) + '"/>' +
            '<button class="dp-tl-submit-btn dp-tl3-edit-save">Save</button>' +
            '<button class="dp-tl-submit-btn dp-tl3-edit-cancel" style="background:transparent;color:var(--mut);margin-left:4px">Cancel</button>';
          var inputEl = item.querySelector('.dp-tl3-edit-input');
          if (inputEl) { inputEl.focus(); inputEl.select(); inputEl.addEventListener('keydown', function(ke){ if (ke.key === 'Enter') item.querySelector('.dp-tl3-edit-save').click(); if (ke.key === 'Escape') item.querySelector('.dp-tl3-edit-cancel').click(); }); }
          return;
        }

        if (e.target.closest('.dp-tl3-edit-save')) {
          var inputEl2 = item.querySelector('.dp-tl3-edit-input');
          var newVal = inputEl2 ? inputEl2.value.trim() : '';
          if (!newVal) return;
          if (window.fleet && window.fleet.editTimeline) {
            window.fleet.editTimeline(unit.equipmentId, rawEntry, newVal).catch(function(){});
          }
          var dm = rawEntry.match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*/);
          var nowD = new Date();
          var todayStr = dm ? dm[1] : ((nowD.getMonth()+1).toString().padStart(2,'0') + '/' + nowD.getDate().toString().padStart(2,'0'));
          var newFullLine = todayStr + ' - ' + newVal;
          item.dataset.entry = encodeURIComponent(newFullLine);
          item.innerHTML = '<span class="dp-tl3-date">' + esc(todayStr) + '</span><span class="dp-tl3-dash"> \u2014 </span><span class="dp-tl3-text">' + esc(newVal) + '</span>' +
            '<span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span>';
          return;
        }

        if (e.target.closest('.dp-tl3-edit-cancel')) {
          var m3 = rawEntry.trim().match(/^(\d{2}\/\d{2})\s*[-\u2013]\s*(.+)$/);
          if (m3) {
            item.innerHTML = '<span class="dp-tl3-date">' + esc(m3[1]) + '</span><span class="dp-tl3-dash"> \u2014 </span><span class="dp-tl3-text">' + esc(m3[2]) + '</span>' +
              '<span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span>';
          } else {
            item.innerHTML = '<span class="dp-tl3-text">' + esc(rawEntry) + '</span>' +
              '<span class="dp-tl3-actions"><button class="dp-tl3-edit-btn" title="Edit">\u270f</button><button class="dp-tl3-hide-btn" title="Hide">\u2715</button></span>';
          }
          return;
        }
      });
    }
  }, 200);


  // Wire split-view button — opens inline webviews in main content area
  setTimeout(function() {
    var btn = document.getElementById('dp-split-open');
    if (btn) btn.addEventListener('click', function() {
      var rUrl = unit.serviceUrl || '';
      var oUrl = offsiteUrl || '';
      window.__splitUnit = unit; _openInlineSplit(rUrl, oUrl, unit.equipmentId);
    });
  }, 100);

  return '<div class="dp-pane active" id="dp-pane-repair">'+
    '<div class="dp-section-title">Work Request</div>'+woCard+plannedWRCard+secondaryWRCards+splitViewBtn+durBar+timelineHtml+offsiteHtml+
  '</div>';
}

// ── intel pane ────────────────────────────────────────────────────────────────
function renderIntelPane(unit){
  var risk=parseInt(unit.riskScore,10)||0;
  var rCls=risk>=70?'high':risk>=40?'medium':'low';

  // risk dial SVG
  var dialHtml='';
  if(risk){
    var C=(2*Math.PI*28).toFixed(1);
    var offset=(C-(risk/100)*parseFloat(C)).toFixed(1);
    var sc=risk>=70?'var(--red)':risk>=40?'var(--ylw)':'var(--grn)';
    dialHtml='<div class="dp-risk-wrap">'+
      '<div class="dp-risk-dial">'+
        '<svg viewBox="0 0 72 72">'+
          '<circle cx="36" cy="36" r="28" fill="none" stroke="var(--el)" stroke-width="6"/>'+
          '<circle cx="36" cy="36" r="28" fill="none" stroke="'+sc+'" stroke-width="6" stroke-dasharray="'+C+'" stroke-dashoffset="'+offset+'" stroke-linecap="round" transform="rotate(-90 36 36)"/>'+
        '</svg>'+
        '<div class="dp-risk-dial__num dp-risk-dial__num--'+rCls+'">'+risk+'</div>'+
      '</div>'+
      '<div class="dp-risk-info">'+
        '<div class="dp-risk-label">Uptake Risk Score</div>'+
        '<div class="dp-risk-sub">'+(risk>=70?'High — maintenance recommended':risk>=40?'Moderate — monitor closely':'Low risk')+'</div>'+
        (unit.riskLabel?'<div class="dp-risk-sub" style="margin-top:2px">'+esc(unit.riskLabel)+'</div>':'')+
        (unit.lastDataDate?'<div class="dp-risk-sub" style="color:var(--mut);margin-top:4px">Data: '+fmtDate(unit.lastDataDate)+'</div>':'')+
      '</div>'+
    '</div>';
  }

  // subsystems
  var subs=unit.subsystems||[];
  var subsHtml=subs.length?
    '<div class="dp-section-title">Subsystems</div>'+
    subs.map(function(s){
      var v=parseInt(s.score||s.value||s.riskScore,10)||0;
      var c=v>=70?'var(--red)':v>=40?'var(--ylw)':'var(--grn)';
      return '<div class="dp-subsystem-row">'+
        '<span class="dp-subsystem-name">'+esc(s.name||s.system||s.subsystem||'')+'</span>'+
        '<div class="dp-subsystem-bar"><div class="dp-subsystem-fill" style="width:'+v+'%;background:'+c+'"></div></div>'+
        '<span class="dp-subsystem-val" style="color:'+c+'">'+v+'</span>'+
      '</div>';
    }).join(''):'' ;

  // insights
  var insights=unit.insightsList||[];
  var insHtml=insights.length?
    '<div class="dp-section-title">Insights <span class="dp-section-count">'+insights.length+'</span></div>'+
    insights.map(function(ins){
      var subsystem=ins.subsystem||'';
      var type=ins.type||ins.insightType||'';
      var status=ins.status||'';
      var since=ins.firstSeen||ins.firstDetected||'';
      var last=ins.lastSeen||ins.lastDetected||'';
      var mf=ins.maintenanceFactor||'';
      return '<div class="dp-insight-card">'+
        '<div class="dp-insight-card__header">'+
          (subsystem?'<span class="dp-insight-card__type">'+esc(subsystem)+'</span>':'')+
          (type?'<span class="dp-insight-card__sub">'+esc(type)+'</span>':'')+
          (status?'<span class="dp-insight-card__status dp-insight-card__status--'+esc(status.toLowerCase())+'">'+esc(status)+'</span>':'')+
          (ins.url?'<a class="dp-offsite-card__link" href="#" data-ext-url="'+esc(ins.url)+'" style="margin-left:auto">\u2197</a>':'')+
        '</div>'+
        (ins.title?'<div class="dp-insight-card__title">'+esc(ins.title)+'</div>':'')+
        (ins.summary?'<div class="dp-insight-card__summary">'+esc(ins.summary)+'</div>':'')+
        (ins.guidance?'<div class="dp-insight-card__action">\u27a1 '+esc(ins.guidance)+'</div>':'')+
        (ins.recommended?'<div class="dp-insight-card__action">\ud83d\udd27 '+esc(ins.recommended)+'</div>':'')+
        ((since||last||mf)?'<div class="dp-insight-card__meta">'+
          (since?'<span>First: '+esc(since)+'</span>':'')+
          (last?'<span>Last: '+esc(last)+'</span>':'')+
          (mf?'<span>Factor: '+esc(mf)+'</span>':'')+
        '</div>':'')+
      '</div>';
    }).join(''):
    '<div class="dp-empty-state"><span class="dp-empty-state__icon">\u26a1</span>No Uptake insights</div>';

  // screenshot
  var shot=(unit.screenshots||[])[0]; var shotHtml='';
  if(shot){
    shotHtml='<div class="dp-section-title">Uptake Screenshot</div>' +
      '<div id="dp-screenshot-card" style="position:relative;width:100%;margin:8px 0;min-height:100px;background:#1c2128;border-radius:6px;border:1px solid rgba(255,255,255,0.08);overflow:hidden;">' +
        '<img id="dp-screenshot-img" data-shot="'+esc(shot)+'" style="width:100%;height:auto;min-height:50px;display:block;border-radius:6px;" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="Uptake screenshot loading..." />' +
        '<div style="font-size:9px;color:rgba(255,255,255,0.35);margin-top:5px;text-align:right;padding:0 8px 4px;" id="dp-screenshot-meta">Loading...</div>' +
      '</div>';
  }

  // ask Orcha
  var askHtml='<div class="dp-section-title">Ask Orcha</div>'+
    '<div class="dp-ask-chips">'+
      '<button class="dp-ask-chip" data-q="Is the ETC realistic for this unit?">ETC realistic?</button>'+
      '<button class="dp-ask-chip" data-q="Draft a vendor follow-up message">Draft follow-up</button>'+
      '<button class="dp-ask-chip" data-q="Should I escalate this unit?">Escalate?</button>'+
      '<button class="dp-ask-chip" data-q="Summarize current repair status">Summarize</button>'+
      '<button class="dp-ask-chip" data-q="What parts are likely needed?">Parts needed?</button>'+
    '</div>'+
    '<div class="dp-ask-row"><input id="dp-ask-input" class="dp-ask-input" type="text" placeholder="Ask about this unit..."/><button id="dp-ask-btn" class="detail-panel__btn">Ask</button></div>'+
    '<div id="dp-ai-result" style="display:none" class="dp-ai-result-box"></div>';

  return '<div class="dp-pane" id="dp-pane-intel">'+dialHtml+subsHtml+insHtml+shotHtml+askHtml+'</div>';
}

// ── actions pane ──────────────────────────────────────────────────────────────
function renderActionsPane(unit){
  var isUnavail=(unit.lifecycleState||'').toLowerCase().includes('unavail');
  return '<div class="dp-pane" id="dp-pane-actions">'+
    '<div class="dp-section-title">Quick Actions</div>'+
    '<div class="dp-action-grid">'+
      '<button class="dp-action-btn dp-action-btn--primary" id="dp-act-create-wr"><span class="dp-action-btn__icon">\u2795</span>Create WR<span class="dp-action-btn__sub">AAP work request</span></button>'+
      '<button class="dp-action-btn" id="dp-act-dealer-wo"><span class="dp-action-btn__icon">\ud83c\udfe6</span>Dealer WO<span class="dp-action-btn__sub">PACCAR / Volvo / DTNA</span></button>'+
      '<button class="dp-action-btn" id="dp-act-aap"><span class="dp-action-btn__icon">\ud83d\udd17</span>Open AAP<span class="dp-action-btn__sub">Asset page</span></button>'+
      '<button class="dp-action-btn" id="dp-act-lc"><span class="dp-action-btn__icon">\ud83d\udd04</span>Lifecycle<span class="dp-action-btn__sub">'+esc(unit.lifecycleState||'')+'</span></button>'+
      '<button class="dp-action-btn dp-action-btn--notes" id="dp-act-daily-notes"><span class="dp-action-btn__icon">\ud83d\udccb</span>Daily Notes<span class="dp-action-btn__sub">AI note + split view</span></button>'+
      '<button class="dp-action-btn dp-action-btn--orcha" id="dp-act-orcha-deep"><span class="dp-action-btn__icon">\u26a1</span>Orcha Scan<span class="dp-action-btn__sub">AI deep analysis</span></button>'+
    '</div>'+
    // BUG FIX (2026-07-16): the state dropdown below previously offered
// "Available"/"Unavailable" as the two options. "Available" is not a real
// AAP lifecycle state -- the actual AAP asset modal (automated by
// setLifecycle.js) only recognizes 'Active' | 'Unavailable' | 'End of
// Life' | 'Ordered' (confirmed via setLifecycle.js's own docstring +
// working example call). Selecting "Available" would silently fail
// inside the real AAP automation (no matching dropdown option to click),
// and -- compounding with the toast bug fixed a few lines below in
// _wireLifecycleForm -- that failure was being reported to the user as a
// SUCCESS. Fixed to the 4 real AAP states.
'<div id="dp-lc-form" class="dp-lc-form" style="display:none">'+
      '<div class="dp-lc-row"><select id="dp-lc-state" class="detail-panel__select"><option value="Active">Active</option><option value="Unavailable">Unavailable</option><option value="Ordered">Ordered</option><option value="End of Life">End of Life</option></select>'+
      '<input id="dp-lc-reason" class="detail-panel__input" type="text" placeholder="Reason..."/></div>'+
      '<div class="dp-lc-row"><button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button><button id="dp-lc-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button></div>'+
    '<div class="dp-section-title" style="margin-top:10px">Dealer Work Order</div>'+
    '<div id="dp-vnd-ai-suggest" class="dp-vnd-ai-suggest"></div>'+
    '<div id="dp-wi-suggest" class="dp-vnd-ai-suggest"></div>'+
    '<div id="dp-vendor-section" class="dp-vendor-section"><p class="dp-empty">Loading eligibility\u2026</p></div>'+
    '<div id="dp-vnd-history-strip" class="dp-vnd-history-strip"></div>'+
  '</div>';
}

// ── history pane ──────────────────────────────────────────────────────────────
function renderHistoryPane(unit){
  var sources=[
    {label:'AAP',      ts:unit.lastDataDate,   icon:'\ud83d\udd17'},
    {label:'Relay',    ts:unit.relaySynced?new Date().toISOString():null, icon:'\ud83d\udcc4'},
    {label:'Uptake',   ts:unit.uptakeSynced?unit.lastDataDate:null,       icon:'\u26a1'},
    {label:'ASIST',    ts:unit.asistScrapedAt,  icon:'\ud83c\udfe6'},
    {label:'Notes',    ts:unit.notesUpdatedAt,  icon:'\ud83d\udcdd'},
  ];
  var syncRows=sources.map(function(s){
    var age=s.ts?Date.now()-new Date(s.ts).getTime():null;
    var cls=age===null?'none':age>86400000?'old':'ok';
    return '<div class="dp-sync-row">'+
      '<div class="dp-sync-dot dp-sync-dot--'+cls+'"></div>'+
      '<span class="dp-sync-icon">'+s.icon+'</span>'+
      '<span class="dp-sync-source">'+s.label+'</span>'+
      '<span class="dp-sync-time">'+(s.ts?relTime(s.ts):'Never')+'</span>'+
    '</div>';
  }).join('');

  // unit timeline summary
  var timeline=[
    unit.created?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--open"></span><span class="dp-tl-label">WR Opened</span><span class="dp-tl-date">'+fmtDate(unit.created)+'</span></div>':'',
    unit.workDuration?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--etc"></span><span class="dp-tl-label">Work Duration</span><span class="dp-tl-date">'+esc(unit.workDuration)+'</span></div>':'',
    unit.needBy?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--needby"></span><span class="dp-tl-label">Need By</span><span class="dp-tl-date">'+esc(unit.needBy)+'</span></div>':'',
    unit.completed?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--closed"></span><span class="dp-tl-label">Completed</span><span class="dp-tl-date">'+fmtDate(unit.completed)+'</span></div>':'',
    unit.notesUpdatedAt?'<div class="dp-tl-row"><span class="dp-tl-dot dp-tl-dot--note"></span><span class="dp-tl-label">Notes Updated</span><span class="dp-tl-date">'+relTime(unit.notesUpdatedAt)+'</span></div>':'',
  ].filter(Boolean).join('');

  return '<div class="dp-pane" id="dp-pane-history">'+
    '<div class="dp-section-title">Data Sync</div>'+
    '<div class="dp-sync-panel">'+syncRows+'</div>'+
    (timeline?'<div class="dp-section-title">Timeline</div><div class="dp-timeline">'+timeline+'</div>':'')+
    '<div class="dp-section-title">Notes</div>'+
    '<textarea id="dp-notes" class="dp-notes-area" placeholder="Add notes...">'+esc(unit.savedNotes||'')+'</textarea>'+
    '<div class="dp-notes-footer"><button id="dp-save-notes" class="detail-panel__btn">Save</button><span id="dp-notes-saved" class="dp-notes-saved">Saved \u2713</span></div>'+
  '</div>';
}


// ── _runDailyNotesForUnit ──────────────────────────────────────────────────────
// Per-unit Daily Notes: opens split windows (Relay + Offsite) for visual review.
// AI note generation runs automatically during sync — no manual trigger needed.
async function _runDailyNotesForUnit(unit) {
  if (!unit) return;

  const unitId = unit.equipmentId || unit.id || '';
  if (!unitId) { toast.show('warn', 'No unit selected', 2500); return; }

  const altId = unit.alternativeId || unit.altId || '';
  if (!altId) { toast.show('warn', unitId + ' has no Alt ID', 3000); return; }

  // Collect URLs
  const relayUrl    = unit.serviceUrl || unit.pageUrl || '';
  let   offsiteUrl  = unit.offsiteShopEventUrl || unit.savedOffsiteUrl || '';
  if (!offsiteUrl && unit.offsiteShopEvent && /^\d+$/.test(String(unit.offsiteShopEvent).trim())) {
    offsiteUrl = 'https://aap-na.corp.amazon.com/v2/offsite-events/' + unit.offsiteShopEvent.trim();
  }

  const hasRelay   = relayUrl   && relayUrl.startsWith('http');
  const hasOffsite = offsiteUrl && offsiteUrl.startsWith('http');

  if (!hasRelay && !hasOffsite) {
    toast.show('warn', unitId + ' — no Relay or Offsite URLs available', 3000);
    return;
  }

  // Open split windows
  if (window.ai && typeof window.ai.openDailyWindows === 'function') {
    try {
      await window.ai.openDailyWindows({ unitId, relayUrl: hasRelay ? relayUrl : '', offsiteUrl: hasOffsite ? offsiteUrl : '' });
      toast.show('info', 'Opened ' + (hasRelay && hasOffsite ? 'Relay + Offsite' : hasRelay ? 'Relay' : 'Offsite') + ' for ' + unitId, 2500);
    } catch (e) {
      toast.show('error', 'Failed to open windows: ' + e.message, 3000);
    }
  } else {
    toast.show('warn', 'Split view not available', 2500);
  }
}


// ── _renderUnit ──────────────────────────────────────────────────────────────
function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;
  // Make the current unit available to every split-view button (primary,
  // planned, and secondary) so the split header always shows the right unit ID
  // even if the user clicks a secondary/planned split button first.
  window.__splitUnit = unit;
  _teardownVendorBus();

  const isUnavail = (unit.lifecycleState||'').toLowerCase().includes('unavail');
  const risk      = parseInt(unit.riskScore, 10) || 0;

  _panel.innerHTML =
    renderHeader(unit) +
    '<div class="dp-status-band dp-status-band--loading" id="dp-status-band">' +
      '<span class="dp-status-band__icon">&#129504;</span>' +
      '<span class="dp-status-band__text">Analyzing unit status...</span>' +
    '</div>' +
    renderTabs(unit) +
    '<div class="dp-body">' +
      renderRepairPane(unit) +
      renderIntelPane(unit) +
      renderActionsPane(unit) +
      renderHistoryPane(unit) +
    '</div>';

  // ── tab switching ──────────────────────────────────────────────────────────
  _panel.querySelectorAll('.dp-tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      _panel.querySelectorAll('.dp-tab').forEach(function(t){ t.classList.remove('active'); });
      _panel.querySelectorAll('.dp-pane').forEach(function(p){ p.classList.remove('active'); });
      btn.classList.add('active');
      var pane = document.getElementById('dp-pane-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
    });
  });

  // Load uptake screenshot into Intel tab
  var _ssImg = document.getElementById('dp-screenshot-img');
  if (_ssImg && _ssImg.dataset.shot) {
    window.files.readAsDataUrl(_ssImg.dataset.shot).then(function(d) {
      if (d) {
        _ssImg.src = d;
        _ssImg.alt = 'Uptake Insight';
        var m = document.getElementById('dp-screenshot-meta');
        var ts = _ssImg.dataset.shot.match(/_(\d{13,})\.png$/);
        if (ts && m) m.textContent = 'Captured: ' + new Date(parseInt(ts[1])).toLocaleString();
        else if (m) m.textContent = '';
        _ssImg.onclick = function() { window.files.openUptakeScreenshot(_ssImg.dataset.shot); };
      } else {
        _ssImg.alt = 'Screenshot file not found';
        var m2 = document.getElementById('dp-screenshot-meta');
        if (m2) m2.textContent = 'File not accessible';
      }
    }).catch(function(e) {
      _ssImg.alt = 'Error: ' + (e.message || e);
    });
  }


  // ── close ──────────────────────────────────────────────────────────────────
  var closeBtn = document.getElementById('dp-close');
  if (closeBtn) closeBtn.addEventListener('click', close);

  // ── external launchers ─────────────────────────────────────────────────────
  _panel.querySelectorAll('[data-aap-url]').forEach(function(b) {
    b.addEventListener('click', function(){ var u=b.dataset.aapUrl; if(u) window.aap && window.aap.openUrl(u); });
  });
  _panel.querySelectorAll('[data-ext-url]').forEach(function(b) {
    b.addEventListener('click', function(e){ e.preventDefault(); var u=b.dataset.extUrl||b.getAttribute('data-ext-url'); if(u&&window.files) window.files.openExternal(u).catch(function(){}); });
  });

  // Split view for secondary ASIST/offsite WR cards
  _panel.querySelectorAll('[data-secondary-split]').forEach(function(b) {
    b.addEventListener('click', function(e) {
      e.preventDefault();
      var leftUrl  = b.dataset.splitLeft  || b.getAttribute('data-split-left')  || '';
      var rightUrl = b.dataset.splitRight || b.getAttribute('data-split-right') || '';
      var unitId   = (window.__splitUnit && window.__splitUnit.equipmentId) || '';
      _openInlineSplit(leftUrl, rightUrl, unitId);
    });
  });

  // ── show all timeline entries ────────────────────────────────────────────
  var moreBtn = document.getElementById('dp-convo-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function() {
      var el = document.getElementById('dp-convo');
      if (!el) return;
      el.innerHTML = _allConvoMsgs.map(function(m) {
        var isVendor = m.side === 'vendor';
        var dotCls   = isVendor ? 'dp-tl3-dot--vendor' : 'dp-tl3-dot--carrier';
        return '<div class="dp-tl3-item ' + dotCls + '">' +
          (m.date ? '<span class="dp-tl3-date">' + esc(m.date) + '</span>' : '') +
          '<span class="dp-tl3-dash"> - </span>' +
          '<span class="dp-tl3-text">' + esc(m.text) + '</span>' +
        '</div>';
      }).join('');
    });
  }


  // ── notes ──────────────────────────────────────────────────────────────────
  _wireNotes(unit);

  // ── action buttons (new layout IDs) ───────────────────────────────────────
  var actCreateWR = document.getElementById('dp-act-create-wr');
  if (actCreateWR) actCreateWR.addEventListener('click', function(){ openWRModal(unit); });

  var actAAP = document.getElementById('dp-act-aap');
  if (actAAP) actAAP.addEventListener('click', function(){ if(unit.assetUrl) aap.openUrl(unit.assetUrl); else toast.show('warn','No AAP URL',3000); });

  var actDealerWO = document.getElementById('dp-act-dealer-wo');
  if (actDealerWO) {
    actDealerWO.addEventListener('click', function() {
      _panel.querySelectorAll('.dp-tab').forEach(function(t){ t.classList.remove('active'); });
      _panel.querySelectorAll('.dp-pane').forEach(function(p){ p.classList.remove('active'); });
      var at = _panel.querySelector('[data-tab="actions"]');
      var ap = document.getElementById('dp-pane-actions');
      if (at) at.classList.add('active');
      if (ap) ap.classList.add('active');
      setTimeout(function(){ var s=document.getElementById('dp-vendor-section'); if(s)s.scrollIntoView({behavior:'smooth',block:'start'}); }, 100);
    });
  }

  var actLC  = document.getElementById('dp-act-lc');
  var lcForm = document.getElementById('dp-lc-form');
  if (actLC && lcForm) actLC.addEventListener('click', function(){ lcForm.style.display = lcForm.style.display==='none'?'flex':'none'; });
  var lcCancel = document.getElementById('dp-lc-cancel');
  if (lcCancel && lcForm) lcCancel.addEventListener('click', function(){ lcForm.style.display='none'; });
  var lcConfirm = document.getElementById('dp-lc-confirm');
  if (lcConfirm) {
    lcConfirm.addEventListener('click', async function() {
      if (!unit.assetUrl) { toast.show('warn','No AAP URL',3000); return; }
      var lcState  = (document.getElementById('dp-lc-state')||{}).value;
      var lcReason = ((document.getElementById('dp-lc-reason')||{}).value||'').trim();
      lcConfirm.disabled=true; lcConfirm.textContent='Saving...';
      try { await aap.setLifecycle(unit.equipmentId,unit.assetUrl,lcState,lcReason); toast.show('success','Lifecycle changed to '+lcState); if(lcForm)lcForm.style.display='none'; }
      catch(e) { toast.show('error','Lifecycle change failed: '+e.message); }
      finally { lcConfirm.disabled=false; lcConfirm.textContent='Confirm'; }
    });
  }

  // ── Daily Notes for this unit ────────────────────────────────────────────
  var actDailyNotes = document.getElementById('dp-act-daily-notes');
  if (actDailyNotes) {
    actDailyNotes.addEventListener('click', function () { _runDailyNotesForUnit(unit); });
  }

  // S28: Orcha Deep Scan button — on-demand AI analysis for this unit
  var actOrchaDeep = document.getElementById('dp-act-orcha-deep');
  if (actOrchaDeep) {
    actOrchaDeep.addEventListener('click', async function () {
      actOrchaDeep.disabled = true;
      actOrchaDeep.querySelector('.dp-action-btn__sub').textContent = 'Analyzing...';
      try {
        var result = await ai.deepProcess([unit.equipmentId]);
        if (result && result.units && result.units.length > 0) {
          var processed = result.units[0];
          toast.show('success', 'Orcha analyzed ' + unit.equipmentId, 3000);
          // Update the AI result box if present
          var aiResult = document.getElementById('dp-ai-result');
          if (aiResult && processed.issueSummary) {
            aiResult.style.display = 'block';
            aiResult.innerHTML = '<div class="dp-ai-text"><strong>Orcha Deep Scan:</strong><br/>' + _esc(processed.issueSummary) + '</div>';
          }
        } else {
          toast.show('info', 'Orcha scan complete — no new insights', 2500);
        }
      } catch (e) {
        toast.show('error', 'Orcha scan failed: ' + (e.message || 'unknown'), 3000);
      } finally {
        actOrchaDeep.disabled = false;
        actOrchaDeep.querySelector('.dp-action-btn__sub').textContent = 'AI deep analysis';
      }
    });
  }

  // ── ask Orcha (new layout IDs: dp-ask-input, dp-ask-btn, dp-ask-chip) ──────
  var askInput = document.getElementById('dp-ask-input');
  var askBtn   = document.getElementById('dp-ask-btn');
  var aiResult = document.getElementById('dp-ai-result');
  async function _runAsk(q) {
    if (!aiResult) return;
    aiResult.style.display='block';
    aiResult.innerHTML='<span style="color:var(--mut);font-style:italic">⏳ Asking Orcha...</span>';
    try {
      var result = await ai.ask('[Unit: '+unit.equipmentId+'] '+q);
      var text = (result&&result.text)?result.text:JSON.stringify(result,null,2);
      aiResult.innerHTML='<div class="dp-ai-text">'+_esc(text)+'</div><div class="dp-ai-result-footer"><button id="dp-ai-copy" class="detail-panel__btn dp-ai-copy-btn">Copy</button></div>';
      document.getElementById('dp-ai-copy').addEventListener('click',function(){navigator.clipboard.writeText(text).catch(function(){});toast.show('info','Copied',2000);});
    } catch(e) { aiResult.innerHTML='<span style="color:var(--red)">'+_esc(e.message)+'</span>'; }
  }
  if (askBtn&&askInput) {
    askBtn.addEventListener('click',function(){var q=askInput.value.trim();if(q)_runAsk(q);});
    askInput.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();var q=askInput.value.trim();if(q)_runAsk(q);}});
  }
  _panel.querySelectorAll('.dp-ask-chip').forEach(function(chip){
    chip.addEventListener('click',function(){if(askInput)askInput.value=chip.dataset.q||'';_runAsk(chip.dataset.q||'');});
  });

  // ── vendor panel ──────────────────────────────────────────────────────────
  _wireVendorPanel(unit);

  // ── status band AI brief ───────────────────────────────────────────────────
  if (window.ai && window.ai.suggest) {
    window.ai.suggest(unit).then(function(result){
      var bandEl = document.getElementById('dp-status-band');
      if (!bandEl) return;
      // BUG FIX: suggestDropdowns() (src/scrapers/orcha_ws.js) NEVER returns a
      // '.text' field in any code path -- success (AI JSON parsed), local
      // fallback (localClassify when AI is unreachable), or failure. It returns
      // primaryComponent/repairStatus/confidence/reason/noteSuggestion instead.
      // Reading result.text here always evaluated to '', so this status band
      // NEVER updated -- it stayed stuck on 'Analyzing unit status...' forever,
      // 100% of the time, regardless of whether AI was available or not. This
      // silently hid the fact that a working local/offline classifier
      // (localClassify + generateNoteSuggestion, fully deterministic, no AI
      // required) was already running successfully in the background.
      var text = (result && (result.noteSuggestion || result.reason)) || '';
      bandEl.classList.remove('dp-status-band--loading');
      if (text) {
        bandEl.innerHTML = '<span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">'+esc(text)+'</span>';
      } else {
        bandEl.innerHTML = '<span class="dp-status-band__icon">&#9888;</span><span class="dp-status-band__text">AI brief unavailable.</span>';
      }
    }).catch(function(){
      // AI + local fallback both failed to even return -- surface this instead
      // of leaving the band stuck on the loading spinner indefinitely.
      var bandEl = document.getElementById('dp-status-band');
      if (!bandEl) return;
      bandEl.classList.remove('dp-status-band--loading');
      bandEl.innerHTML = '<span class="dp-status-band__icon">&#9888;</span><span class="dp-status-band__text">AI brief unavailable -- Orcha unreachable.</span>';
    });
  }
}

// ── _wireNotes ────────────────────────────────────────────────────────────────
function _wireNotes(unit) {
  var notesEl = document.getElementById('dp-notes');
  var savedEl = document.getElementById('dp-notes-saved');
  if (!notesEl) return;
  if (window.notes) {
    window.notes.getUnit(unit.equipmentId).then(function(n){ if(n&&n.content) notesEl.value=n.content; }).catch(function(){});
  }
  async function _save() {
    if (!window.notes) return;
    try {
      await window.notes.saveUnit({ unitId: unit.equipmentId, content: notesEl.value });
      if (savedEl) { savedEl.classList.add('visible'); setTimeout(function(){ savedEl.classList.remove('visible'); }, 2000); }
    } catch(e) { console.warn('Notes save failed', e); }
  }
  notesEl.addEventListener('blur', _save);
  var saveBtn = document.getElementById('dp-save-notes');
  if (saveBtn) saveBtn.addEventListener('click', _save);
}


function close() {
  if (_panel) {
    _panel.classList.remove('detail-panel--open');
    setTimeout(() => {
      if (_panel) _panel.innerHTML = '';
      _unit = null;
      _teardownVendorBus();
    }, 300);
  }
  bus.emit('ui:unit-deselect');
}


// Offline quick-add timeline entry
function _injectOfflineQuickAdd(container, equipmentId) {
  if (!container || container.querySelector('.offline-quick-add')) return;
  const div = document.createElement('div');
  div.className = 'offline-quick-add';
  div.style.cssText = 'padding:8px;border-top:1px solid var(--bdr,#30363d);display:flex;gap:6px;align-items:center;';
  const today = new Date();
  const dateStr = String(today.getMonth()+1).padStart(2,'0') + '/' + String(today.getDate()).padStart(2,'0');
  div.innerHTML = '<span style="font-size:10px;color:var(--mut,#484f58);font-family:monospace;">' + dateStr + ' -</span>' +
    '<input class="offline-quick-input" placeholder="Quick note..." style="flex:1;background:var(--el,#21262d);border:1px solid var(--bdr,#30363d);border-radius:4px;padding:4px 8px;color:var(--txt,#e6edf3);font-size:11px;" />' +
    '<button class="offline-quick-btn" style="background:var(--acc,#58a6ff);border:none;border-radius:4px;color:#fff;padding:4px 10px;font-size:11px;cursor:pointer;font-weight:600;">+</button>';
  container.appendChild(div);
  
  const input = div.querySelector('.offline-quick-input');
  const btn = div.querySelector('.offline-quick-btn');
  
  function submit() {
    const text = input.value.trim();
    if (!text) return;
    // Always queue through AI for rewrite (works offline AND online)
    if (window.fleet && window.fleet.queueOffline) {
      window.fleet.queueOffline(equipmentId, text);
    }
    // Also add raw to local display immediately
    const store = window._notesCache || {};
    const u = store[equipmentId] || {};
    u.timeline = u.timeline ? u.timeline + '\n' + dateStr + ' - ' + text : dateStr + ' - ' + text;
    store[equipmentId] = u;
    window._notesCache = store;
    input.value = '';
    // Refresh the timeline display
    const tlEl = container.querySelector('.dp-timeline-entries');
    if (tlEl) {
      const entry = document.createElement('div');
      entry.className = 'dp-tl-entry';
      entry.style.cssText = 'font-size:11px;color:var(--txt2,#8b949e);padding:3px 0;border-left:2px solid var(--acc,#58a6ff);padding-left:8px;margin:2px 0;opacity:0.7;';
      entry.textContent = dateStr + ' - ' + text + ' (pending AI rewrite)';
      tlEl.appendChild(entry);
    }
  }
  
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

export function init(container) {
  _panel = document.createElement('div');
  _panel.id = 'detail-panel';
  _panel.className = 'detail-panel';
  document.body.appendChild(_panel);

  bus.on('ui:unit-select', ({ unit }) => {
    _renderUnit(unit);
    requestAnimationFrame(() => _panel.classList.add('detail-panel--open'));
  });

  bus.on('ui:unit-deselect', () => {
    if (_panel) _panel.classList.remove('detail-panel--open');
  });
}


// S23-12: Race-guarded handler for context-menu Dealer WO shortcut
let _pendingDealerWO = null; // { unit, attempts } | null

function _tryDealerWO(unit, attempts) {
  // Guard 1: stale request — user has switched to a different unit
  if (!_unit || (_unit.equipmentId !== unit.equipmentId && _unit.id !== unit.equipmentId)) {
    _pendingDealerWO = null;
    return;
  }
  // Guard 2: panel DOM not yet painted (sec created by _renderUnit sync, so this is very rare)
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) {
    if (attempts >= 12) { _pendingDealerWO = null; return; } // give up after ~200ms
    _pendingDealerWO = { unit, attempts: attempts + 1 };
    requestAnimationFrame(() => {
      if (_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts);
    });
    return;
  }
  // Guard 3: already investigating this unit — don't re-trigger
  if (sec.dataset.investigating === unit.equipmentId) {
    _pendingDealerWO = null;
    sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  _pendingDealerWO = null;
  sec.dataset.investigating = unit.equipmentId;
  _wireVendorPanel(unit);
  sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

bus.on('ui:dealer-wo-request', ({ unit }) => {
  _pendingDealerWO = { unit, attempts: 0 };
  // Use rAF so ui:unit-select's _renderUnit (synchronous) always runs first
  requestAnimationFrame(() => {
    if (_pendingDealerWO) _tryDealerWO(_pendingDealerWO.unit, _pendingDealerWO.attempts);
  });
});
