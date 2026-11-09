/**
 * views/zoom-hub.js -- the Zoom hub view shell: toolbar tab, sub-tabs, connection card, stylesheet.
 *
 * Loaded only by zoom-hub-boot.js when an area flag is effective. The three panel modules are imported
 * statically and driven through mount/show/hide/stopAll/destroy, so later phases replace the panel
 * bodies without editing this file.
 *
 * View changes: to 'zoom' shows; to 'settings' keeps the view visible (Settings is a drawer) but stops
 * the camera; anything else hides and stops the camera.
 */
import defaultBus from '../bus.js';
import { addTab as defaultAddTab } from '../components/toolbar.js';
import { zoomHub as bridgeZoomHub } from '../bridge.js';
import * as meetingsPanel from '../zoom/meetings-panel.js';
import * as recordingsPanel from '../zoom/recordings-panel.js';
import * as studioPanel from '../zoom/studio-panel.js';
import { renderConnection, connectionFromStatus, codeMessage } from '../zoom/data-logic.js';

/** cssHref(moduleUrl) -- the stylesheet URL relative to THIS module (renderer/src/js/views -> renderer/src/css). */
export function cssHref(moduleUrl) {
  return new URL('../../css/zoom-hub.css', moduleUrl).href;
}

const CSS_LINK_ID = 'zoom-hub-css';

function _injectCss(doc) {
  if (!doc || !doc.head) return;
  if (typeof doc.getElementById === 'function' && doc.getElementById(CSS_LINK_ID)) return;
  const link = doc.createElement('link');
  link.id = CSS_LINK_ID;
  link.rel = 'stylesheet';
  // An injected <link> resolves against the document URL, so compute the href module-relative.
  link.href = new URL('../../css/zoom-hub.css', import.meta.url).href;
  doc.head.appendChild(link);
}

let _state = null;

/**
 * init(mount, flags, deps) -- deps (tests): {bus, addTab, zoomHub, document}.
 * Returns a small handle {root, show, hide, selectTab} for tests.
 */
export function init(mount, flags, deps = {}) {
  if (_state) return _state.handle;
  const bus = deps.bus || defaultBus;
  const addTab = deps.addTab || defaultAddTab;
  const zoomHub = deps.zoomHub || bridgeZoomHub;
  const doc = deps.document || (typeof document !== 'undefined' ? document : null);
  const f = flags || {};

  const root = doc.createElement('div');
  root.id = 'view-zoom';
  root.className = 'view';
  root.style.display = 'none';

  const header = doc.createElement('div');
  header.className = 'zh-header';
  root.appendChild(header);

  // Connection card (data area only).
  let card = null;
  if (f.data) {
    card = doc.createElement('div');
    card.className = 'zh-conn';
    card.setAttribute('aria-label', 'Zoom connection');
    header.appendChild(card);
  }

  const tablist = doc.createElement('div');
  tablist.className = 'zh-tabs';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Zoom sections');
  header.appendChild(tablist);

  const body = doc.createElement('div');
  body.className = 'zh-body';
  root.appendChild(body);

  const defs = [];
  if (f.data) {
    defs.push({ key: 'meetings', label: 'Meetings', panel: meetingsPanel });
    defs.push({ key: 'recordings', label: 'Recordings', panel: recordingsPanel });
  }
  if (f.studio) defs.push({ key: 'studio', label: 'Studio', panel: studioPanel });

  const tabs = [];
  for (const d of defs) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'zh-tab';
    btn.id = 'zh-tab-' + d.key;
    btn.dataset.tab = d.key;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.setAttribute('aria-controls', 'zh-panel-' + d.key);
    btn.textContent = d.label;
    tablist.appendChild(btn);
    const el = doc.createElement('div');
    el.id = 'zh-panel-' + d.key;
    el.className = 'zh-panel';
    el.setAttribute('role', 'tabpanel');
    el.setAttribute('aria-labelledby', btn.id);
    el.style.display = 'none';
    body.appendChild(el);
    try { d.panel.mount(el, { zoomHub, flags: f, bus }); } catch (e) { console.warn('[zoom-hub] panel mount', e && e.name); }
    const t = { def: d, btn, el };
    btn.addEventListener('click', () => selectTab(d.key));
    tabs.push(t);
  }

  let active = null;
  let visible = false;
  let unsubAuth = null;
  let conn = { phase: 'checking' };

  function renderCard() {
    if (card) card.innerHTML = renderConnection(conn);
  }

  function setConn(next) {
    conn = next;
    renderCard();
  }

  async function refreshStatus(force) {
    if (!card) return;
    setConn({ phase: 'checking' });
    let r = null;
    try { r = await zoomHub.status(force ? { force: true } : {}); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    setConn(connectionFromStatus(r));
  }

  async function doConnect() {
    setConn({ phase: 'connecting' });
    let r = null;
    try { r = await zoomHub.connect(); } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
    if (r && r.ok) setConn({ phase: 'signed-in' });
    else if (r && (r.code === 'CANCELLED' || r.code === 'SIGN_IN_TIMEOUT')) setConn({ phase: 'signed-out', note: codeMessage(r.code) });
    else setConn({ phase: 'error', code: (r && r.code) || 'INTERNAL' });
  }

  if (card) {
    card.addEventListener('click', (e) => {
      const t = e && e.target;
      const btn = t && typeof t.closest === 'function' ? t.closest('[data-action]') : t;
      const action = btn && btn.dataset ? btn.dataset.action : null;
      if (!action || (btn && btn.disabled)) return;
      if (action === 'connect') doConnect();
      else if (action === 'refresh' || action === 'retry') refreshStatus(true);
    });
  }

  function selectTab(key) {
    for (const t of tabs) {
      const on = t.def.key === key;
      t.btn.setAttribute('aria-selected', on ? 'true' : 'false');
      t.btn.classList.toggle('active', on);
      t.el.style.display = on ? '' : 'none';
      if (!on && active === t) { try { t.def.panel.hide(); } catch (_) {} }
    }
    const next = tabs.find((t) => t.def.key === key) || null;
    active = next;
    if (visible && next) { try { next.def.panel.show(); } catch (_) {} }
  }

  function stopCamera() {
    try { studioPanel.stopAll(); } catch (_) {}
  }

  function show() {
    root.style.display = 'flex';
    if (!visible) {
      visible = true;
      if (card) {
        try { unsubAuth = zoomHub.onAuthChanged((p) => { setConn(connectionFromStatus({ ok: true, signedIn: p && p.signedIn, code: p && p.code })); }); } catch (_) { unsubAuth = null; }
        refreshStatus(false);
      }
      if (active) { try { active.def.panel.show(); } catch (_) {} }
    }
  }

  function hide() {
    root.style.display = 'none';
    stopCamera();
    if (!visible) return;
    visible = false;
    if (typeof unsubAuth === 'function') { try { unsubAuth(); } catch (_) {} }
    unsubAuth = null;
    for (const t of tabs) { try { t.def.panel.hide(); } catch (_) {} }
  }

  bus.on('ui:view-change', ({ to } = {}) => {
    if (to === 'zoom') show();
    else if (to === 'settings') stopCamera();   // drawer over the current view: no display change
    else hide();
  });

  mount.appendChild(root);
  _injectCss(doc);
  addTab({ key: 'zoom', view: 'zoom', label: 'Zoom', icon: '🎥' });
  renderCard();
  if (tabs.length) selectTab(tabs[0].def.key);

  const handle = { root, show, hide, selectTab, get visible() { return visible; } };
  _state = { handle };
  return handle;
}

/** _resetForTests() -- allow init() again in a fresh fake DOM. */
export function _resetForTests() { _state = null; }
