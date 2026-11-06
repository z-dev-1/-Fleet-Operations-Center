// renderer/src/js/views/longdwell-sp.js - thin DOM binder for the Long Dwell
// weekly SharePoint sheet panel ("Preview, then write").
//
// mount() is SYNCHRONOUS and returns { refresh() {} } at once. Only when
// status() reports enabled === true does _activate() add any element,
// listener or timer. With the feature off (or the bridge missing / failing)
// the computed view is left exactly as it was. No logging in this module.
import { longDwellSp as spBridge, aap as aapBridge } from '../bridge.js';
import * as L from '../longdwell-sp-logic.js';

export function mount(computedWrap, opts = {}) {
  const api = { refresh() {} };
  Promise.resolve()
    .then(() => spBridge.status())
    .then((s) => { if (s && s.enabled === true) _activate(api, computedWrap, opts, s); })
    .catch(() => {});
  return api;
}

export function safeRefresh(api) {
  try { if (api && typeof api.refresh === 'function') api.refresh(); } catch { /* never breaks Refresh */ }
}

function _call(fn) {
  try { return Promise.resolve(fn()); } catch { return Promise.resolve({ ok: false, code: 'internal' }); }
}

function _openExternal(url) {
  try { if (L.isAllowedSheetUrl(url) && aapBridge && typeof aapBridge.openUrl === 'function') aapBridge.openUrl(url); } catch { /* ignore */ }
}

function _activate(api, wrap, opts, status) {
  if (!wrap || typeof wrap.insertBefore !== 'function') return;
  const doc = wrap.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  const ctx = { st: L.initialState(status), webview: null, paneTimer: null, confirmTimer: null, fellBack: false };

  const host = doc.createElement('div');
  host.id = 'an-ld-sp-host';
  host.className = 'ldsp';
  wrap.insertBefore(host, wrap.firstChild || null);

  const pane = doc.createElement('div');
  pane.id = 'an-ld-sp-pane';
  pane.className = 'ldsp-pane';
  pane.hidden = true;
  const tableWrap = wrap.querySelector('#an-ld-table-wrap');
  if (tableWrap && tableWrap.parentNode === wrap) wrap.insertBefore(pane, tableWrap.nextSibling || null);
  else wrap.appendChild(pane);

  const set = (action) => { ctx.st = L.reduce(ctx.st, action); };
  const render = () => { host.innerHTML = L.renderControlHtml(ctx.st) + L.renderBodyHtml(ctx.st); };
  const renderFooter = () => {
    const f = host.querySelector('[data-ldsp-footer]');
    if (f) f.innerHTML = L.renderFooterHtml(ctx.st); else render();
  };
  const link = () => (ctx.st.status && ctx.st.status.link) || null;

  function refreshStatus() {
    return _call(() => spBridge.status()).then((s) => {
      if (s && s.enabled === true) { set({ type: 'status', status: s }); render(); }
    }).catch(() => {});
  }

  // ── Side panel ─────────────────────────────────────────────────────────
  function closePane() {
    if (ctx.paneTimer) { clearTimeout(ctx.paneTimer); ctx.paneTimer = null; }
    if (ctx.webview && typeof ctx.webview.remove === 'function') ctx.webview.remove();
    ctx.webview = null;
    pane.innerHTML = '';
    pane.hidden = true;
    if (wrap.classList) wrap.classList.remove('ldsp-split');
    if (ctx.st.paneOpen) { set({ type: 'pane', open: false }); render(); }
  }

  // The pane sits below the table; bring it into view.
  function gotoPane() {
    try { if (typeof pane.scrollIntoView === 'function') pane.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* ignore */ }
  }

  function fallback(url) {
    if (ctx.fellBack) return;
    ctx.fellBack = true;
    if (ctx.paneTimer) { clearTimeout(ctx.paneTimer); ctx.paneTimer = null; }
    if (ctx.webview && typeof ctx.webview.remove === 'function') ctx.webview.remove();
    ctx.webview = null;
    pane.innerHTML = L.renderPaneNoticeHtml();
    _openExternal(url);
  }

  function openPane() {
    const l = link();
    if (!l) return;
    if (!L.isAllowedSheetUrl(l.url)) { set({ type: 'error', code: 'bad-pane-url' }); render(); return; }
    if (ctx.webview) { if (typeof ctx.webview.focus === 'function') ctx.webview.focus(); return; }
    ctx.fellBack = false;
    pane.innerHTML = L.renderPaneHtml(l);
    pane.hidden = false;
    if (wrap.classList) wrap.classList.add('ldsp-split');
    // No partition, preload or allowpopups: default session, no app bridges.
    const wv = doc.createElement('webview');
    wv.id = 'ldsp-wv';
    wv.className = 'ldsp-webview';
    wv.setAttribute('src', l.url);
    const url = l.url;
    wv.addEventListener('did-fail-load', (e) => {
      if (e && e.isMainFrame === false) return;
      if (e && e.errorCode === -3) return; // aborted navigation, not a failure
      fallback(url);
    });
    wv.addEventListener('dom-ready', () => { if (ctx.paneTimer) { clearTimeout(ctx.paneTimer); ctx.paneTimer = null; } });
    const body = pane.querySelector('.ldsp-pane__body');
    (body || pane).appendChild(wv);
    ctx.webview = wv;
    ctx.paneTimer = setTimeout(() => fallback(url), L.PANE_TIMEOUT_MS);
    set({ type: 'pane', open: true }); render();
    gotoPane();
  }

  // ── Link ───────────────────────────────────────────────────────────────
  async function saveLink() {
    const input = host.querySelector('[data-ldsp-input="link"]');
    const url = input && typeof input.value === 'string' ? input.value.trim() : '';
    if (!url) { set({ type: 'error', code: 'bad-link' }); render(); return; }
    set({ type: 'busy', busy: true }); render();
    if (link()) await _call(() => spBridge.clearLink());
    const r = await _call(() => spBridge.setLink({ url }));
    set({ type: 'busy', busy: false });
    if (!r || r.ok !== true) { set({ type: 'error', code: (r && r.code) || 'internal' }); render(); return; }
    set({ type: 'error', code: null });
    set({ type: 'link-edit', on: false });
    closePane();
    await refreshStatus();
    render();
  }

  // ── Preview ────────────────────────────────────────────────────────────
  async function runPreview(tab) {
    if (ctx.st.busy) return;
    const old = ctx.st.preview && ctx.st.preview.previewId;
    if (old) _call(() => spBridge.discard({ previewId: old }));
    set({ type: 'discard' });
    set({ type: 'busy', busy: true }); render();
    let units = [];
    try { units = typeof opts.getUnits === 'function' ? (opts.getUnits() || []) : []; } catch { units = []; }
    const payload = { units };
    if (typeof tab === 'string' && tab) payload.tab = tab;
    const r = await _call(() => spBridge.preview(payload));
    if (r && r.ok === true) set({ type: 'preview-loaded', preview: r });
    else if (r && (r.code === 'needs-tab-choice' || r.code === 'header-mismatch') && Array.isArray(r.tabs) && r.tabs.length) set({ type: 'tab-choice', code: r.code, tabs: r.tabs, missing: r.missing });
    else set({ type: 'error', code: (r && r.code) || 'internal' });
    render();
  }

  // ── Write ──────────────────────────────────────────────────────────────
  async function sendWrite() {
    if (ctx.confirmTimer) { clearTimeout(ctx.confirmTimer); ctx.confirmTimer = null; }
    const payload = L.buildWritePayload(ctx.st);
    set({ type: 'busy', busy: true }); render();
    const r = await _call(() => spBridge.write(payload));
    if (r && Array.isArray(r.cells) && typeof r.status === 'string') {
      set({ type: 'report', report: r });
      if (ctx.webview && typeof ctx.webview.reload === 'function') { try { ctx.webview.reload(); } catch { /* ignore */ } }
    } else {
      set({ type: 'error', code: (r && r.code) || 'internal' });
    }
    render();
  }

  function proceedWrite() {
    const w = L.writeInfo(ctx.st);
    if (w.disabled) return;
    if (w.overwrites > 0 && !ctx.st.confirmArmed) {
      set({ type: 'arm-confirm' });
      ctx.confirmTimer = setTimeout(() => { ctx.confirmTimer = null; set({ type: 'disarm-confirm' }); renderFooter(); }, L.CONFIRM_REVERT_MS);
      renderFooter();
      return;
    }
    sendWrite();
  }

  function onWriteClick() {
    const w = L.writeInfo(ctx.st);
    if (w.disabled) return;
    if (ctx.webview && !ctx.st.promptShown) { set({ type: 'prompt-show' }); renderFooter(); return; }
    proceedWrite();
  }

  // ── Delegated events ───────────────────────────────────────────────────
  function onHostClick(e) {
    const t = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-ldsp-action]') : null;
    if (!t || !t.dataset) return;
    const action = t.dataset.ldspAction;
    const cellId = t.dataset.cellId;
    switch (action) {
      case 'save-link': saveLink(); break;
      case 'change-link': set({ type: 'link-edit', on: true }); render(); break;
      case 'cancel-link': set({ type: 'link-edit', on: false }); render(); break;
      case 'open-pane': openPane(); break;
      case 'goto-pane': gotoPane(); break;
      case 'pop-out': { const l = link(); if (l) _openExternal(l.url); break; }
      case 'preview': runPreview(); break;
      case 'use-tab': {
        const sel = host.querySelector('[data-ldsp-field="tab"]:checked');
        runPreview(sel && sel.value ? sel.value : undefined);
        break;
      }
      case 'select-all': set({ type: 'select-all' }); render(); break;
      case 'clear-ticks': set({ type: 'clear' }); render(); break;
      case 'reset-cell': set({ type: 'reset', cellId }); render(); break;
      case 'write': onWriteClick(); break;
      case 'prompt-close-write': closePane(); set({ type: 'prompt-hide' }); proceedWrite(); break;
      case 'prompt-write-anyway': set({ type: 'prompt-hide' }); proceedWrite(); break;
      case 'prompt-cancel': set({ type: 'prompt-hide' }); renderFooter(); break;
      case 'back-to-preview': set({ type: 'back-to-preview' }); render(); break;
      case 'close-report': {
        const r = ctx.st.report;
        const id = r && r.previewKept && ctx.st.preview ? ctx.st.preview.previewId : null;
        if (id) _call(() => spBridge.discard({ previewId: id }));
        set({ type: 'close-report' }); render();
        break;
      }
      default: break;
    }
  }

  function onHostChange(e) {
    const t = e && e.target;
    if (!t || !t.dataset) return;
    const f = t.dataset.ldspField;
    if (f === 'tick') { set({ type: 'tick', cellId: t.dataset.cellId, checked: t.checked === true }); render(); }
    else if (f === 'edit') { set({ type: 'edit', cellId: t.dataset.cellId, text: t.value }); render(); }
  }

  function onHostInput(e) {
    const t = e && e.target;
    if (!t || !t.dataset || t.dataset.ldspField !== 'edit') return;
    set({ type: 'edit', cellId: t.dataset.cellId, text: t.value });
    renderFooter(); // keep focus in the textarea; full render happens on change
  }

  function onPaneClick(e) {
    const t = e && e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-ldsp-action]') : null;
    if (!t || !t.dataset) return;
    const l = link();
    if (t.dataset.ldspAction === 'pane-close') closePane();
    else if (t.dataset.ldspAction === 'pane-popout' && l) _openExternal(l.url);
    else if (t.dataset.ldspAction === 'pane-reload' && ctx.webview && typeof ctx.webview.reload === 'function') ctx.webview.reload();
  }

  host.addEventListener('click', onHostClick);
  host.addEventListener('change', onHostChange);
  host.addEventListener('input', onHostInput);
  pane.addEventListener('click', onPaneClick);
  const win = doc.defaultView || null;
  if (win && typeof win.addEventListener === 'function') win.addEventListener('focus', () => { refreshStatus(); });

  api.refresh = () => { refreshStatus(); };
  render();
}
