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
let _notesVal = '';

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
function _renderUnit(unit) {
  _unit = unit;
  if (!_panel) return;

  const rows = FIELDS
    .filter(([, key]) => unit[key])
    .map(([label, key]) =>
      '<tr><th>' + label + '</th><td>' + _esc(unit[key]) + '</td></tr>'
    ).join('');

  _panel.innerHTML = `
    <div class="detail-panel__header">
      <h2 class="detail-panel__title">${_esc(unit.equipmentId)}</h2>
      <button id="dp-close" class="detail-panel__close" aria-label="Close">&times;</button>
    </div>
    <div class="detail-panel__body">

      <!-- Fields table -->
      <table class="detail-panel__table"><tbody>${rows}</tbody></table>

      <!-- S9: Relay Work Orders -->
      <div class="detail-panel__section">
        <h3>Relay Work Orders</h3>
        <div id="dp-relay-wos" class="dp-relay-list"></div>
      </div>

      <!-- S9: Uptake Insights -->
      <div class="detail-panel__section">
        <h3>Uptake Insights <span id="dp-risk-badge"></span></h3>
        <ul id="dp-insights-list" class="dp-insights-list"></ul>
      </div>

      <!-- Notes -->
      <div class="detail-panel__section">
        <h3>Notes</h3>
        <textarea id="dp-notes" class="detail-panel__notes" placeholder="Add notes for this unit..."></textarea>
        <button id="dp-save-notes" class="detail-panel__btn">Save Notes</button>
      </div>

      <!-- Quick Actions -->
      <div class="detail-panel__section">
        <h3>Quick Actions</h3>
        <div id="dp-quick-actions" class="detail-panel__actions">
          <button id="dp-aap-open"   class="detail-panel__btn">Open in AAP</button>
          <button id="dp-ai-suggest" class="detail-panel__btn">AI Suggest</button>
          <button id="dp-create-wr"  class="detail-panel__btn">Create WR</button>
          <button id="dp-lc-open"    class="detail-panel__btn">Change Lifecycle</button>
        </div>

        <!-- S9: Ask Orcha free-text -->
        <div class="dp-ai-ask-row">
          <input id="dp-ai-ask" class="detail-panel__input" type="text" placeholder="Ask Orcha about this unit..." />
          <button id="dp-ai-ask-btn" class="detail-panel__btn">Ask</button>
        </div>

        <!-- S9: Lifecycle change form (hidden by default) -->
        <div id="dp-lc-form" class="dp-lc-form" style="display:none">
          <select id="dp-lc-state" class="detail-panel__select">
            <option value="Available">Available</option>
            <option value="Unavailable">Unavailable</option>
          </select>
          <input id="dp-lc-reason" class="detail-panel__input" type="text" placeholder="Reason..." />
          <button id="dp-lc-confirm" class="detail-panel__btn">Confirm</button>
          <button id="dp-lc-cancel"  class="detail-panel__btn detail-panel__btn--secondary">Cancel</button>
        </div>
      </div>



      <!-- S25-10: Volvo ASIST Offsite Event panel -->
      <div class="detail-panel__section" id="dp-offsite-section">
        <h3>Offsite Event</h3>
        <div id="dp-asist-panel" class="dp-asist-panel">
          <p class="dp-empty dp-asist-empty">No offsite event on record.</p>
        </div>
        <div id="dp-asist-actions" class="dp-asist-actions" style="display:none">
          <button id="dp-asist-refresh" class="detail-panel__btn detail-panel__btn--secondary">Re-enrich</button>
        </div>
      </div>

      <!-- S23-9: Dealer WO Engine -->
      <div class="detail-panel__section">
        <h3>Dealer Work Order</h3>
        <div id="dp-vendor-section" class="dp-vendor-section">
          <p class="dp-empty">Loading eligibility check...</p>
        </div>
        <div id="dp-vnd-history-strip" class="dp-vnd-history-strip"></div>
      </div>

      <!-- AI result -->
      <div id="dp-ai-result" class="detail-panel__ai-result" style="display:none"></div>

    </div>
  `;

  document.getElementById('dp-close').addEventListener('click', close);

  // Load existing notes
  notes.getUnit(unit.equipmentId).then((n) => {
    const ta = document.getElementById('dp-notes');
    if (ta && n && n.content) { ta.value = n.content; _notesVal = n.content; }
  }).catch(() => {});

  // Save notes
  document.getElementById('dp-save-notes').addEventListener('click', async () => {
    const ta = document.getElementById('dp-notes');
    if (!ta) return;
    try {
      await notes.saveUnit({ unitId: unit.equipmentId, content: ta.value });
      toast.show('success', 'Notes saved');
    } catch (e) {
      toast.show('error', 'Failed to save notes: ' + e.message);
    }
  });

  // Open in AAP
  document.getElementById('dp-aap-open').addEventListener('click', () => {
    if (unit.assetUrl) {
      aap.openUrl(unit.assetUrl);
    } else {
      toast.show('warn', 'No AAP URL for this unit', 3000);
    }
  });

  // S9: wire new sections
  _loadRelayWOs(unit);
  _renderInsights(unit);
  _wireLifecycleForm(unit);
  _wireAISuggest(unit);
  _wireCreateWR(unit);
  _wireVendorPanel(unit);
  _wireAsistPanel(unit);
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
