/**
 * zoom/recordings-panel.js -- Recordings sub-tab (design §13, A2). Same mount/show/hide/stopAll/destroy
 * interface as the A1 stub; views/zoom-hub.js drives it.
 *
 * List with a transcript badge (Available / None / Unknown); the detail pane has Get transcript (when
 * hasTranscript !== false), Import transcript file…, the transcript viewer, Summarize (CONSENT_REQUIRED
 * -> zoomHub.aiConsent() -> retry; the button is disabled while it runs and a role=status line shows
 * 'Summarizing… (chunk n of m)' from onSummaryProgress events matching this recording's idHash),
 * Regenerate (summarize with force), the link control, and 'Delete in Zoom portal…' only when flags.write.
 */
import {
  renderRecordingRows, renderItemDetail, renderRecordingActions, renderTranscript, renderSummary, resultMessage,
} from './data-logic.js';
import { createLinkControl } from './link-control.js';

const SHAPE_MSG = "Zoom changed its page format; Fleet couldn't read recordings safely.";

let S = null;

function _actionTarget(e) {
  const t = e && e.target;
  if (!t) return null;
  const btn = typeof t.closest === 'function' ? t.closest('[data-action]') : t;
  return btn && btn.dataset && btn.dataset.action ? btn : null;
}

export function mount(el, opts = {}) {
  if (S) destroy();
  const doc = opts.document || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub;
  const flags = opts.flags || {};
  el.textContent = '';

  const mk = (tag, cls) => { const n = doc.createElement(tag); n.className = cls; return n; };
  const head = mk('div', 'zh-panel-head');
  head.innerHTML = '<button type="button" class="zh-btn" data-action="refresh" aria-label="Refresh recordings">Refresh</button>';
  const status = mk('div', 'zh-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = mk('ul', 'zh-list');
  list.setAttribute('aria-label', 'Recordings');
  const detail = mk('div', 'zh-detail');
  detail.style.display = 'none';
  const info = mk('div', 'zh-detail-info');
  const actions = mk('div', 'zh-actions');
  const progress = mk('div', 'zh-progress');
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const message = mk('div', 'zh-message');
  message.setAttribute('role', 'status');
  message.setAttribute('aria-live', 'polite');
  const summary = mk('div', 'zh-summary-host');
  const viewer = mk('div', 'zh-viewer');
  viewer.setAttribute('aria-label', 'Transcript');
  const linkHost = mk('div', 'zh-link-host');
  for (const n of [info, actions, progress, message, summary, linkHost, viewer]) detail.appendChild(n);
  for (const n of [head, status, list, detail]) el.appendChild(n);

  S = {
    el, zoomHub, flags, head, status, list, detail, info, actions, progress, message, summary, viewer, linkHost,
    items: [], links: {}, selectedKey: null, loaded: false, seq: 0, visible: false,
    transcripts: {}, summaries: {}, busy: false, unsubProgress: null, focus: null, linkCtl: null,
  };
  S.linkCtl = createLinkControl(linkHost, {
    zoomHub, document: doc,
    onChange: (key, link) => { if (link) S.links[key] = link; else delete S.links[key]; renderList(); },
  });
  head.addEventListener('click', onHead);
  list.addEventListener('click', onList);
  actions.addEventListener('click', onActions);
  summary.addEventListener('click', onRefs);
  viewer.addEventListener('click', onRefs);
  return S;
}

function _selected() { return S && S.selectedKey ? S.items.find((it) => it.key === S.selectedKey) || null : null; }

function renderList() {
  if (!S) return;
  S.list.innerHTML = renderRecordingRows(S.items, { links: S.links, selectedKey: S.selectedKey });
}

function renderActions() {
  const item = _selected();
  S.actions.innerHTML = renderRecordingActions(item, { write: !!S.flags.write, busy: S.busy, hasSummary: !!(item && S.summaries[item.key]) });
}

function renderViewer() {
  const item = _selected();
  const t = item ? S.transcripts[item.key] : null;
  S.viewer.innerHTML = t ? renderTranscript(t, { focus: S.focus }) : '';
}

function renderSum() {
  const item = _selected();
  const r = item ? S.summaries[item.key] : null;
  S.summary.innerHTML = r ? renderSummary(r) : '';
}

async function loadLinks() {
  if (!S) return;
  let r;
  try { r = await S.zoomHub.links(); } catch (_) { r = null; }
  if (S && r && r.ok && r.links && typeof r.links === 'object') { S.links = r.links; renderList(); }
}

async function load(refresh) {
  if (!S) return;
  const my = ++S.seq;
  S.status.textContent = 'Loading recordings…';
  let r;
  try { r = await S.zoomHub.listRecordings(refresh ? { refresh: true } : {}); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S || my !== S.seq) return;
  S.loaded = true;
  if (r && r.ok) {
    S.items = Array.isArray(r.items) ? r.items : [];
    S.status.textContent = r.stale ? 'Showing the last list Fleet read from Zoom.' : '';
  } else {
    S.items = [];
    S.status.textContent = r && r.code === 'SHAPE_UNRECOGNIZED' ? SHAPE_MSG : resultMessage(r);
  }
  if (S.selectedKey && !_selected()) select(null);
  renderList();
}

async function select(key) {
  if (!S) return;
  S.selectedKey = key || null;
  S.focus = null;
  S.message.textContent = '';
  S.progress.textContent = '';
  const item = _selected();
  if (!item) {
    S.detail.style.display = 'none';
    S.info.innerHTML = '';
    S.actions.innerHTML = '';
    S.summary.innerHTML = '';
    S.viewer.innerHTML = '';
    S.linkCtl.clear();
    renderList();
    return;
  }
  S.detail.style.display = '';
  S.info.innerHTML = renderItemDetail(item);
  renderActions();
  renderSum();
  renderViewer();
  S.linkCtl.setItem(item.key, S.links[item.key] || null);
  renderList();
  if (!S.summaries[item.key]) {
    let r;
    try { r = await S.zoomHub.getSummary({ key: item.key }); } catch (_) { r = null; }
    if (S && S.selectedKey === item.key && r && r.ok && r.summary) {
      S.summaries[item.key] = r;
      renderSum();
      renderActions();
    }
  }
}

async function loadTranscript(kind) {
  const item = _selected();
  if (!item) return;
  const key = item.key;
  S.message.textContent = kind === 'import' ? 'Choose a transcript file…' : 'Getting the transcript…';
  let r;
  try { r = kind === 'import' ? await S.zoomHub.importTranscript({ key }) : await S.zoomHub.getTranscript({ key }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S || S.selectedKey !== key) return;
  if (r && r.ok && r.transcript) {
    S.transcripts[key] = r.transcript;
    S.message.textContent = '';
    renderViewer();
  } else if (r && r.code === 'CANCELLED') {
    S.message.textContent = '';
  } else {
    S.message.textContent = resultMessage(r);
  }
}

async function summarize(force) {
  const item = _selected();
  if (!item || S.busy) return;
  const key = item.key;
  S.busy = true;
  S.message.textContent = '';
  S.progress.textContent = 'Summarizing…';
  renderActions();
  const payload = force ? { key, force: true } : { key };
  let r;
  try {
    r = await S.zoomHub.summarize(payload);
    if (r && r.code === 'CONSENT_REQUIRED') {
      const c = await S.zoomHub.aiConsent();
      r = c && c.ok ? await S.zoomHub.summarize(payload) : c;
    }
  } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  S.busy = false;
  S.progress.textContent = '';
  if (r && r.ok) {
    S.summaries[key] = r;
  } else if (S.selectedKey === key && !(r && r.code === 'CANCELLED')) {
    S.message.textContent = resultMessage(r);
  }
  if (S.selectedKey === key) { renderSum(); }
  renderActions();
}

async function deleteInPortal() {
  const item = _selected();
  if (!item || !S.flags.write) return;
  let r;
  try { r = await S.zoomHub.writeOpen({ action: 'delete-recording', key: item.key }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  if (r && r.ok) S.message.textContent = 'The Zoom portal is open. Find the recording and delete it there.';
  else if (!(r && r.code === 'CANCELLED')) S.message.textContent = resultMessage(r);
}

function scrollToSegment(n) {
  if (!S || !Number.isInteger(n)) return;
  const item = _selected();
  if (!item || !S.transcripts[item.key]) { S.message.textContent = 'Load or import the transcript to see segment ' + n + '.'; return; }
  S.focus = n;
  renderViewer();
  try {
    const node = typeof S.viewer.querySelector === 'function' ? S.viewer.querySelector('#zh-seg-' + n) : null;
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'center' });
  } catch (_) {}
}

function onHead(e) { const b = _actionTarget(e); if (b && b.dataset.action === 'refresh') load(true); }

function onList(e) { const b = _actionTarget(e); if (b && b.dataset.action === 'select') select(b.dataset.key); }

function onActions(e) {
  const b = _actionTarget(e);
  if (!b || b.disabled) return;
  const a = b.dataset.action;
  if (a === 'get-transcript') loadTranscript('portal');
  else if (a === 'import-transcript') loadTranscript('import');
  else if (a === 'summarize') summarize(false);
  else if (a === 'regenerate') summarize(true);
  else if (a === 'delete-portal') deleteInPortal();
}

function onRefs(e) {
  const b = _actionTarget(e);
  if (!b) return;
  const n = parseInt(b.dataset.seg, 10);
  if (b.dataset.action === 'ref' || b.dataset.action === 'seg-page') scrollToSegment(n);
}

function onProgress(p) {
  try {
    if (!S || !S.busy) return;
    const item = _selected();
    if (!item || !p || p.idHash !== item.idHash) return;
    const chunk = Number(p.chunk); const of = Number(p.of);
    if (!Number.isInteger(chunk) || !Number.isInteger(of)) return;
    S.progress.textContent = 'Summarizing… (chunk ' + chunk + ' of ' + of + ')';
  } catch (_) {}
}

export function show() {
  if (!S) return;
  if (!S.visible) {
    S.visible = true;
    try { S.unsubProgress = S.zoomHub.onSummaryProgress(onProgress); } catch (_) { S.unsubProgress = null; }
  }
  loadLinks();
  if (!S.loaded) load(false);
}

export function hide() {
  if (!S) return;
  S.visible = false;
  if (typeof S.unsubProgress === 'function') { try { S.unsubProgress(); } catch (_) {} }
  S.unsubProgress = null;
}

export function stopAll() {}

export function destroy() {
  if (!S) return;
  hide();
  try { S.head.removeEventListener('click', onHead); } catch (_) {}
  try { S.list.removeEventListener('click', onList); } catch (_) {}
  try { S.actions.removeEventListener('click', onActions); } catch (_) {}
  try { S.summary.removeEventListener('click', onRefs); } catch (_) {}
  try { S.viewer.removeEventListener('click', onRefs); } catch (_) {}
  try { S.linkCtl.destroy(); } catch (_) {}
  S = null;
}

/** _state() -- test seam. */
export function _state() { return S; }
