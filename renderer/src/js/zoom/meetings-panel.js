/**
 * zoom/meetings-panel.js -- Meetings sub-tab (design §13, A2). Same mount/show/hide/stopAll/destroy
 * interface as the A1 stub; views/zoom-hub.js drives it.
 *
 * Upcoming / Previous toggle, Refresh, rows (local start, duration, topic, Linked chip, Join only when
 * hasJoin -> zoomHub.join({key})), a detail pane with the link control, empty and SHAPE_UNRECOGNIZED
 * states, and 'Schedule in Zoom portal…' only when flags.write. Every portal string is escaped by the
 * data-logic.js render functions.
 */
import { renderMeetingRows, renderItemDetail, resultMessage } from './data-logic.js';
import { createLinkControl } from './link-control.js';

const SHAPE_MSG = "Zoom changed its page format; Fleet couldn't read meetings safely.";

let S = null;

function _actionTarget(e) {
  const t = e && e.target;
  if (!t) return null;
  const btn = typeof t.closest === 'function' ? t.closest('[data-action]') : t;
  return btn && btn.dataset && btn.dataset.action ? btn : null;
}

function _headHtml(kind, write) {
  const tab = (k, label) => `<button type="button" class="zh-btn zh-toggle${kind === k ? ' active' : ''}" data-action="kind" data-kind="${k}" aria-pressed="${kind === k ? 'true' : 'false'}" aria-label="Show ${label.toLowerCase()} meetings">${label}</button>`;
  return tab('upcoming', 'Upcoming') + ' ' + tab('previous', 'Previous') +
    ' <button type="button" class="zh-btn" data-action="refresh" aria-label="Refresh meetings">Refresh</button>' +
    (write ? ' <button type="button" class="zh-btn" data-action="schedule" aria-label="Schedule in Zoom portal">Schedule in Zoom portal…</button>' : '');
}

export function mount(el, opts = {}) {
  if (S) destroy();
  const doc = opts.document || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub;
  const flags = opts.flags || {};
  el.textContent = '';

  const mk = (tag, cls) => { const n = doc.createElement(tag); n.className = cls; return n; };
  const head = mk('div', 'zh-panel-head');
  const status = mk('div', 'zh-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = mk('ul', 'zh-list');
  list.setAttribute('aria-label', 'Meetings');
  const detail = mk('div', 'zh-detail');
  const info = mk('div', 'zh-detail-info');
  const linkHost = mk('div', 'zh-link-host');
  detail.appendChild(info);
  detail.appendChild(linkHost);
  detail.style.display = 'none';
  el.appendChild(head);
  el.appendChild(status);
  el.appendChild(list);
  el.appendChild(detail);

  S = {
    el, zoomHub, flags, head, status, list, detail, info, linkHost,
    kind: 'upcoming', items: [], links: {}, selectedKey: null, loaded: {}, seq: 0, visible: false,
    linkCtl: null,
  };
  S.linkCtl = createLinkControl(linkHost, {
    zoomHub, document: doc,
    onChange: (key, link) => { if (link) S.links[key] = link; else delete S.links[key]; renderList(); },
  });

  head.innerHTML = _headHtml(S.kind, !!flags.write);
  head.addEventListener('click', onHead);
  list.addEventListener('click', onList);
  return S;
}

function renderList() {
  if (!S) return;
  S.list.innerHTML = renderMeetingRows(S.items, { links: S.links, selectedKey: S.selectedKey });
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
  const kind = S.kind;
  S.status.textContent = 'Loading meetings…';
  let r;
  try { r = await S.zoomHub.listMeetings(refresh ? { kind, refresh: true } : { kind }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S || my !== S.seq) return;
  S.loaded[kind] = true;
  if (r && r.ok) {
    S.items = Array.isArray(r.items) ? r.items : [];
    S.status.textContent = r.stale ? 'Showing the last list Fleet read from Zoom.' : '';
  } else {
    S.items = [];
    S.status.textContent = r && r.code === 'SHAPE_UNRECOGNIZED' ? SHAPE_MSG : resultMessage(r);
  }
  if (S.selectedKey && !S.items.some((it) => it.key === S.selectedKey)) select(null);
  renderList();
}

function select(key) {
  if (!S) return;
  S.selectedKey = key || null;
  const item = key ? S.items.find((it) => it.key === key) : null;
  if (!item) {
    S.detail.style.display = 'none';
    S.info.innerHTML = '';
    S.linkCtl.clear();
  } else {
    S.detail.style.display = '';
    S.info.innerHTML = renderItemDetail(item);
    S.linkCtl.setItem(item.key, S.links[item.key] || null);
  }
  renderList();
}

async function join(key) {
  if (!S || !key) return;
  let r;
  try { r = await S.zoomHub.join({ key }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  S.status.textContent = r && r.ok ? 'Opening Zoom…' : resultMessage(r);
}

async function schedule() {
  if (!S || !S.flags.write) return;
  let r;
  try { r = await S.zoomHub.writeOpen({ action: 'schedule' }); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  if (r && r.ok) S.status.textContent = 'The Zoom portal is open. Schedule the meeting there.';
  else if (!(r && r.code === 'CANCELLED')) S.status.textContent = resultMessage(r);
}

function onHead(e) {
  const b = _actionTarget(e);
  if (!b || b.disabled) return;
  const a = b.dataset.action;
  if (a === 'kind') {
    const k = b.dataset.kind === 'previous' ? 'previous' : 'upcoming';
    if (k !== S.kind) {
      S.kind = k;
      S.items = [];
      S.head.innerHTML = _headHtml(S.kind, !!S.flags.write);
      select(null);
      load(false);
    }
  } else if (a === 'refresh') load(true);
  else if (a === 'schedule') schedule();
}

function onList(e) {
  const b = _actionTarget(e);
  if (!b) return;
  const a = b.dataset.action;
  if (a === 'join') { if (e && typeof e.stopPropagation === 'function') e.stopPropagation(); join(b.dataset.key); }
  else if (a === 'select') select(b.dataset.key);
}

export function show() {
  if (!S) return;
  S.visible = true;
  loadLinks();
  if (!S.loaded[S.kind]) load(false);
}

export function hide() { if (S) S.visible = false; }

export function stopAll() {}

export function destroy() {
  if (!S) return;
  try { S.head.removeEventListener('click', onHead); } catch (_) {}
  try { S.list.removeEventListener('click', onList); } catch (_) {}
  try { S.linkCtl.destroy(); } catch (_) {}
  S = null;
}

/** _state() -- test seam. */
export function _state() { return S; }
