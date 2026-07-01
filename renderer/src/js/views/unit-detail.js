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
import { notes, ai, aap, relay, vendor } from '../bridge.js';
import { open as openWRModal }    from './wr-modal.js';
import { open as openVendorReview } from './vendor-review-modal.js';
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
          <span class="dp-relay-card__vendor">${_esc(wo.vendor || '—')}</span>
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
      await aap.setLifecycle(unit.equipmentId, unit.assetUrl, lcState, lcReason);
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
    resultEl.innerHTML = '<span class="dp-ai-spinner">⟳ Asking Orcha...</span>';
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
  const startBtn = document.getElementById('dp-vnd-start');
  if (startBtn) { startBtn.disabled = true; startBtn.textContent = 'Starting...'; }
  const progressEl = document.getElementById('dp-vnd-progress');
  if (progressEl) { progressEl.style.display = 'block'; progressEl.innerHTML = ''; }
  try {
    const fn = vendorKey === 'paccar' ? vendor.startPaccar : vendor.startVolvo;
    const { workflowId } = await fn(unit);
    const sec = document.getElementById('dp-vendor-section');
    if (sec) sec.dataset.workflowId = workflowId;
    // S25-6-A: do NOT call _showApproveCancel here — modal opens via vendor:review-ready bus event.
    toast.show('info', 'Dealer WO workflow started — waiting for portal...', 3000);
  } catch (e) {
    toast.show('error', 'Failed to start workflow: ' + e.message);
    if (startBtn) { startBtn.disabled = false; startBtn.textContent = 'Retry'; }
  }
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

function _wireVendorPanel(unit) {
  const sec = document.getElementById('dp-vendor-section');
  if (!sec) return;
  _teardownVendorBus();
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
function parseConvo(raw){if(!raw||typeof raw!=='string')return[];return raw.split('\n').filter(function(l){return l.trim();}).reduce(function(acc,line){var m=line.match(/^(\d{2}\/\d{2}(?:\/\d{2,4})?)?\s*[-\u2013]?\s*(.+)$/);if(m&&m[2]&&m[2].trim().length>2){var isVendor=/amerit|freightliner|volvo|peterbilt|kenworth|ta truck|ta |tct|dealer|shop|penske|ryder/i.test(m[2]);acc.push({date:m[1]||'',text:m[2].trim(),side:isVendor?'vendor':'carrier'});}return acc;},[]);}
function parseDuration(raw){if(!raw)return null;var m=String(raw).match(/(\d+(?:\.\d+)?)/);return m?parseFloat(m[1]):null;}
function workDurationBar(unit){
  var created=unit.created;
  var durDays=parseDuration(unit.workDuration);
  if(!created||!durDays)return'';
  var start=new Date(created).getTime();
  var end=start+(durDays*86400000);
  var now=Date.now();
  var pct=Math.min(Math.round(((now-start)/(end-start))*100),100);
  var overdue=now>end;
  var daysElapsed=Math.floor((now-start)/86400000);
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
  var offsiteUrl=esc(unit.asistSrUrl||unit.offsiteShopEventUrl||'');

  // meta row: make/model/year · type · fuel · domicile · operator
  var make=[unit.manufacturer||unit.make,unit.model,unit.modelYear].filter(Boolean).join(' ');
  var metaParts=[make,unit.assetType||unit.bodyType,unit.fuelType,unit.domicileSite||unit.domicile,unit.operator,unit.program].filter(Boolean).map(esc);
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

// ── repair pane ───────────────────────────────────────────────────────────────
function renderRepairPane(unit){
  // ── WR summary card ────────────────────────────────────────────────────────
  var hasRelay=unit.relaySynced&&(unit.vendor||unit.issueDetails||unit.workRequestId);
  var woCard='';
  if(hasRelay){
    var statusRaw=unit.serviceState||unit.status||'';
    var statusKey=statusRaw.toLowerCase().includes('clos')?'closed':statusRaw.toLowerCase().includes('sour')?'sourcing':'open';
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
      (unit.issueDetails?'<div class="dp-wo-card__desc">'+esc(unit.issueDetails)+'</div>':'')+
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
  var durBar=workDurationBar(unit);

  // ── conversation timeline ──────────────────────────────────────────────────
  var msgs=parseConvo(unit.fullConversation||'');
  _allConvoMsgs=msgs;
  var convoHtml='';
  if(msgs.length){
    var visible=msgs.slice(-8);
    var hidden=msgs.length-visible.length;
    convoHtml='<div class="dp-section-title">Conversation <span class="dp-section-count">'+msgs.length+'</span></div>'+
      '<div class="dp-convo" id="dp-convo">'+
        (hidden>0?'<button class="dp-convo-show-more" id="dp-convo-more">\u25b2 Show '+hidden+' earlier messages</button>':'')+
        visible.map(function(m){
          return '<div class="dp-convo-msg dp-convo-msg--'+m.side+'">'+
            '<div class="dp-convo-av dp-convo-av--'+m.side+'">'+(m.side==='vendor'?'V':'C')+'</div>'+
            '<div>'+
              '<div class="dp-convo-bubble">'+esc(m.text)+'</div>'+
              (m.date?'<div class="dp-convo-meta">'+esc(m.date)+'</div>':'')+
            '</div>'+
          '</div>';
        }).join('')+
      '</div>';
  }

  // ── offsite event card ─────────────────────────────────────────────────────
  var offsiteUrl=unit.asistSrUrl||unit.savedOffsiteUrl||unit.offsiteShopEventUrl||'';
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

  return '<div class="dp-pane active" id="dp-pane-repair">'+
    '<div class="dp-section-title">Work Request</div>'+woCard+durBar+convoHtml+offsiteHtml+
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
  var shot=(unit.screenshots||[])[0];
  var shotHtml=shot?
    '<div class="dp-section-title">Uptake Screenshot</div>'+
    '<div class="dp-screenshot-wrap"><img src="'+esc(shot)+'" alt="Uptake screenshot"><div class="dp-screenshot-overlay"><span class="dp-screenshot-label">Uptake Insights</span></div></div>':'';

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
    '</div>'+
    '<div id="dp-lc-form" class="dp-lc-form" style="display:none">'+
      '<div class="dp-lc-row"><select id="dp-lc-state" class="detail-panel__select"><option value="Available">Available</option><option value="Unavailable">Unavailable</option></select>'+
      '<input id="dp-lc-reason" class="detail-panel__input" type="text" placeholder="Reason..."/></div>'+
      '<div class="dp-lc-row"><button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button><button id="dp-lc-cancel" class="detail-panel__btn detail-panel__btn--secondary">Cancel</button></div>'+
    '</div>'+
    '<div class="dp-section-title" style="margin-top:10px">Dealer Work Order</div>'+
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


// ── _renderUnit ──────────────────────────────────────────────────────────────
function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;
  _teardownVendorBus();

  const isUnavail = (unit.lifecycleState||'').toLowerCase().includes('unavail');
  const risk      = parseInt(unit.riskScore, 10) || 0;

  _panel.innerHTML =
    renderHeader(unit) +
    '<div class="dp-status-band dp-status-band--loading" id="dp-status-band">' +
      '<span class="dp-status-band__icon">&#129504;</span>' +
      '<span class="dp-status-band__text">Analyzing unit status…</span>' +
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

  // ── show all convo messages ────────────────────────────────────────────────
  var moreBtn = document.getElementById('dp-convo-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', function() {
      var el = document.getElementById('dp-convo');
      if (!el) return;
      el.innerHTML = _allConvoMsgs.map(function(m){
        return '<div class="dp-convo-msg dp-convo-msg--'+m.side+'">' +
          '<div class="dp-convo-av dp-convo-av--'+m.side+'">'+(m.side==='vendor'?'V':'C')+'</div>' +
          '<div><div class="dp-convo-bubble">'+esc(m.text)+'</div>' +
          '<div class="dp-convo-meta">'+esc(m.date)+'</div></div></div>';
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

  // ── ask Orcha (new layout IDs: dp-ask-input, dp-ask-btn, dp-ask-chip) ──────
  var askInput = document.getElementById('dp-ask-input');
  var askBtn   = document.getElementById('dp-ask-btn');
  var aiResult = document.getElementById('dp-ai-result');
  async function _runAsk(q) {
    if (!aiResult) return;
    aiResult.style.display='block';
    aiResult.innerHTML='<span style="color:var(--mut);font-style:italic">⟳ Asking Orcha...</span>';
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
      var text = (result && result.text) ? result.text : '';
      if (text) {
        bandEl.classList.remove('dp-status-band--loading');
        bandEl.innerHTML = '<span class="dp-status-band__icon">&#129504;</span><span class="dp-status-band__text">'+esc(text)+'</span>';
      }
    }).catch(function(){});
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

export function init(container) {
  _panel = document.createElement('div');
  _panel.id = 'detail-panel';
  _panel.className = 'detail-panel';
  container.appendChild(_panel);

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
