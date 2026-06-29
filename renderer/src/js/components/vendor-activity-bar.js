/**
 * vendor-activity-bar.js -- Active vendor workflow status bar [V-C]
 * S25-3 (2026-06-29)
 *
 * Renders a thin bar below the toolbar showing one pill per active
 * vendor workflow.  Hidden when no workflows are running.
 *
 * Each pill shows:
 *   [vendor badge]  [unit ID]  [step label]  [spinner|done]  [cancel]
 *
 * Reactive sources (in priority order):
 *   1. vendor:progress  bus event  -> update step label for workflowId
 *   2. vendor:complete  bus event  -> remove pill (briefly flash green)
 *   3. vendor:error     bus event  -> flash pill red, then remove
 *   4. vendor:review-ready         -> update step to awaiting-review
 *   5. 8-second poll via vendor.getStatus() -> reconcile on reconnect
 *
 * Layout anchor: #vnd-activity-bar-mount (injected into #main-area
 * between #toolbar-mount and #content-area by app.js).
 */

import bus        from '../bus.js';
import { vendor } from '../vendor-bridge.js';

const STEP_LABELS = {
  'relay-done':          'Relay WO ready',
  'opening':             'Opening portal...',
  'opening-portal':      'Opening portal...',
  'filling-form':        'Filling form...',
  'awaiting-review':     'Awaiting review',
  'review-ready':        'Awaiting review',
  'review-ready:stub':   'Awaiting review',
  'approved':            'Approved - submitting...',
  'submitting':          'Submitting...',
  'polling-sr-number':   'Waiting for SR #...',
  'polling-case-number': 'Waiting for case #...',
  'sr-created':          'SR created',
  'case-created':        'Case created',
  'complete':            'Complete',
  'cancelled':           'Cancelled',
  'running':             'Running...',
};

function _stepLabel(step) {
  return STEP_LABELS[step] || (step ? step.replace(/-/g, ' ') : 'Running...');
}

const _esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// workflowId -> { workflowId, vendor, unit, step }
const _pills = new Map();
let _el       = null;
let _list     = null;
let _pollTimer = null;

function _pillId(workflowId) {
  return 'vab-pill-' + workflowId.replace(/[^a-z0-9]/gi, '_');
}

function _vendorCls(v) {
  if (v === 'paccar') return 'dp-vnd-badge--paccar';
  if (v === 'volvo')  return 'dp-vnd-badge--volvo';
  return 'dp-vnd-badge--unknown';
}

function _vendorLabel(v) {
  if (v === 'paccar') return 'PACCAR';
  if (v === 'volvo')  return 'Volvo';
  return (v || '?').toUpperCase();
}

function _pillHtml(p) {
  const pid    = _pillId(p.workflowId);
  const vCls   = _vendorCls(p.vendor);
  const vLbl   = _vendorLabel(p.vendor);
  const step   = _stepLabel(p.step);
  const unitId = _esc(p.unit || '\u2014');
  const isReview = (p.step || '').includes('review') || (p.step || '').includes('awaiting');
  const spinner = isReview
    ? '<span class="vab__pill-review-dot" title="Awaiting operator review"></span>'
    : '<span class="vab__pill-spinner"></span>';
  return `<div class="vab__pill" id="${pid}" data-wfid="${_esc(p.workflowId)}">` +
    `<span class="vab__vendor dp-vnd-badge ${vCls}">${_esc(vLbl)}</span>` +
    `<span class="vab__unit">${unitId}</span>` +
    `<span class="vab__step">${_esc(step)}</span>` +
    spinner +
    `<button class="vab__cancel" title="Cancel workflow" data-wfid="${_esc(p.workflowId)}">\u2715</button>` +
    `</div>`;
}

function _render() {
  if (!_list) return;
  if (_pills.size === 0) {
    _el.style.display = 'none';
    _list.innerHTML = '';
    return;
  }
  _el.style.display = '';
  for (const [wfid, p] of _pills.entries()) {
    const pid = _pillId(wfid);
    let pillEl = document.getElementById(pid);
    if (!pillEl) {
      const tmp = document.createElement('div');
      tmp.innerHTML = _pillHtml(p);
      const node = tmp.firstElementChild;
      _list.appendChild(node);
    } else {
      const stepEl = pillEl.querySelector('.vab__step');
      if (stepEl) stepEl.textContent = _stepLabel(p.step);
      const isReview = (p.step || '').includes('review') || (p.step || '').includes('awaiting');
      const spinnerEl = pillEl.querySelector('.vab__pill-spinner, .vab__pill-review-dot');
      if (spinnerEl) {
        spinnerEl.className = isReview ? 'vab__pill-review-dot' : 'vab__pill-spinner';
        spinnerEl.title = isReview ? 'Awaiting operator review' : '';
      }
    }
  }
  const domPills = _list.querySelectorAll('.vab__pill');
  domPills.forEach(node => {
    const wfid = node.dataset.wfid;
    if (wfid && !_pills.has(wfid)) node.remove();
  });
}

function _flashRemove(workflowId, outcome) {
  const pid    = _pillId(workflowId);
  const pillEl = document.getElementById(pid);
  if (pillEl) {
    pillEl.classList.add(outcome === 'ok' ? 'vab__pill--complete' : 'vab__pill--error');
    setTimeout(() => { _pills.delete(workflowId); _render(); }, 1200);
  } else {
    _pills.delete(workflowId);
    _render();
  }
}

async function _reconcile() {
  try {
    const res = await vendor.getStatus();
    if (!res || !Array.isArray(res.active)) return;
    for (const entry of res.active) {
      if (!entry.workflowId) continue;
      if (!_pills.has(entry.workflowId)) {
        _pills.set(entry.workflowId, {
          workflowId: entry.workflowId,
          vendor:     entry.vendor || '',
          unit:       entry.unit   || '',
          step:       entry.step   || 'running',
        });
      }
    }
    const activeIds = new Set(res.active.map(e => e.workflowId));
    for (const wfid of _pills.keys()) {
      if (!activeIds.has(wfid)) _pills.delete(wfid);
    }
    _render();
  } catch (_) { /* IPC not ready -- skip */ }
}

function _wireCancel(container) {
  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('.vab__cancel');
    if (!btn) return;
    const wfid = btn.dataset.wfid;
    if (!wfid) return;
    btn.disabled = true;
    btn.textContent = '...';
    try { await vendor.cancel(wfid); } catch (_) {}
  });
}

export function init(container) {
  _el = document.createElement('div');
  _el.id = 'vnd-activity-bar';
  _el.style.display = 'none';
  _el.innerHTML =
    '<div class="vab__label">ACTIVE WORKFLOWS</div>' +
    '<div class="vab__list"></div>';
  container.appendChild(_el);
  _list = _el.querySelector('.vab__list');

  _wireCancel(_el);

  bus.on('vendor:progress', (p) => {
    if (!p || !p.workflowId) return;
    const ex = _pills.get(p.workflowId);
    _pills.set(p.workflowId, {
      workflowId: p.workflowId,
      vendor: p.vendor || (ex && ex.vendor) || '',
      unit:   p.unit   || (ex && ex.unit)   || '',
      step:   p.step   || (ex && ex.step)   || 'running',
    });
    _render();
  });

  bus.on('vendor:review-ready', (p) => {
    if (!p || !p.workflowId) return;
    const ex = _pills.get(p.workflowId) || {};
    _pills.set(p.workflowId, {
      workflowId: p.workflowId,
      vendor: p.vendor || ex.vendor || '',
      unit:   p.unit   || ex.unit   || '',
      step:   'awaiting-review',
    });
    _render();
  });

  bus.on('vendor:complete', (p) => {
    if (!p || !p.workflowId) return;
    const ex = _pills.get(p.workflowId) || {};
    _pills.set(p.workflowId, { ...ex, step: 'complete' });
    _render();
    _flashRemove(p.workflowId, 'ok');
  });

  bus.on('vendor:error', (p) => {
    if (!p || !p.workflowId) return;
    const ex = _pills.get(p.workflowId) || {};
    _pills.set(p.workflowId, { ...ex, step: 'error' });
    _render();
    _flashRemove(p.workflowId, 'err');
  });

  _pollTimer = setInterval(_reconcile, 8000);
  _reconcile();
}
