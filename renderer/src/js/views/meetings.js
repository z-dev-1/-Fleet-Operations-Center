/**
 * meetings.js — Meetings tab (zoom.enabled, default OFF).
 *
 * The meeting itself is a main-process WebContentsView (src/zoom-meet/view.js) that
 * sits ON TOP of this page. This view only reports where it should be:
 *   - Meetings tab active      → the #zm-stage rect (docked, or the whole window in full screen)
 *   - another tab, in meeting  → a corner mini player rect, or a floating always-on-top window
 *   - otherwise                → hidden (null)
 * Detached / floating windows are positioned by main; this page just shows controls.
 *
 * Nothing about meetings is hardcoded: join by any Zoom link or meeting ID, or open
 * the Zoom web app home. Hosts come from settings on the main side.
 */

import bus from '../bus.js';
import { zoomMeet } from '../bridge.js';

const MINI = { width: 360, height: 203, margin: 16 };

let _el = null;
let _stage = null;
let _mini = null;
let _enabled = false;
let _miniPref = 'corner';
let _active = false;
let _fullscreen = false;
let _autoFloated = false;
let _st = { open: false, mode: 'main', floating: false, inMeeting: false, canOpenInZoomApp: false };
let _raf = 0;

function _injectStyles() {
  if (document.getElementById('zm-styles')) return;
  const s = document.createElement('style');
  s.id = 'zm-styles';
  s.textContent = `
    .view--meetings .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .view--meetings { flex-direction: column; flex: 1; min-height: 0; gap: 8px; padding: 10px; }
    .view--meetings.zm-full { position: fixed; inset: 0; z-index: 9000; padding: 6px; background: var(--bg, #0d1117); }
    .zm-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .zm-bar input { background: var(--bg-2, #161b22); color: inherit; border: 1px solid var(--border, #333); border-radius: 6px; padding: 5px 8px; font-size: 12px; }
    .zm-bar input.zm-link { flex: 1 1 280px; min-width: 200px; }
    .zm-bar input.zm-pass { width: 120px; }
    .zm-btn { background: var(--bg-2, #161b22); color: inherit; border: 1px solid var(--border, #333); border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
    .zm-btn:hover:not(:disabled) { border-color: var(--accent, #58a6ff); }
    .zm-btn:disabled { opacity: .45; cursor: default; }
    .zm-btn--danger { border-color: #da3633; color: #ff7b72; }
    .zm-title { font-weight: 600; margin-right: 6px; }
    .zm-status { font-size: 11px; opacity: .75; margin-left: auto; }
    .zm-stage { flex: 1; min-height: 240px; border: 1px solid var(--border, #333); border-radius: 8px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 13px; opacity: .8; }
    .view--meetings.zm-full .zm-stage { border-radius: 0; }
    #zm-mini-bar { position: fixed; z-index: 9001; display: none; gap: 4px; padding: 3px; background: var(--bg-2, #161b22); border: 1px solid var(--border, #333); border-radius: 6px 6px 0 0; font-size: 11px; }
    #zm-mini-bar .zm-btn { padding: 2px 8px; font-size: 11px; }
  `;
  document.head.appendChild(s);
}

function _html() {
  return `
    <div class="zm-bar" role="toolbar" aria-label="Join a meeting">
      <span class="zm-title">🎥 Meetings</span>
      <label class="sr-only" for="zm-link">Zoom link or meeting ID</label>
      <input id="zm-link" class="zm-link" type="text" placeholder="Paste a Zoom link or meeting ID" autocomplete="off" spellcheck="false" />
      <label class="sr-only" for="zm-pass">Passcode</label>
      <input id="zm-pass" class="zm-pass" type="password" placeholder="Passcode (optional)" autocomplete="off" />
      <button class="zm-btn" id="zm-join" type="button">Join</button>
      <button class="zm-btn" id="zm-home" type="button" title="Open the Zoom web app (meetings, team chat)">Zoom home</button>
    </div>
    <div class="zm-bar" role="toolbar" aria-label="Meeting window">
      <button class="zm-btn" id="zm-full" type="button" aria-pressed="false">⛶ Full screen</button>
      <button class="zm-btn" id="zm-detach" type="button">⧉ Detach</button>
      <button class="zm-btn" id="zm-float" type="button">▣ Floating mini</button>
      <button class="zm-btn" id="zm-dock" type="button">↩ Dock</button>
      <button class="zm-btn" id="zm-zoomapp" type="button" title="Open this meeting in the Zoom desktop app">Open in Zoom app</button>
      <button class="zm-btn zm-btn--danger" id="zm-leave" type="button">✕ Leave</button>
      <span class="zm-status" id="zm-status" role="status" aria-live="polite"></span>
    </div>
    <div class="zm-stage" id="zm-stage">
      <div id="zm-placeholder">Paste a Zoom link or meeting ID and press Join,<br/>or open Zoom home to see your meetings.</div>
    </div>
  `;
}

function _setStatus(msg) { const s = _el && _el.querySelector('#zm-status'); if (s) s.textContent = msg || ''; }

function _describe() {
  if (!_st.open) return 'No meeting open';
  const where = _st.mode === 'detached' ? (_st.floating ? 'floating window' : 'its own window') : (_fullscreen ? 'full screen' : 'docked');
  return (_st.inMeeting ? 'In meeting' : 'Zoom open') + ' · ' + where;
}

function _syncControls() {
  if (!_el) return;
  const q = (id) => _el.querySelector(id);
  const open = !!_st.open;
  const detached = _st.mode === 'detached';
  q('#zm-full').disabled = !open || detached;
  q('#zm-full').setAttribute('aria-pressed', String(_fullscreen));
  q('#zm-full').textContent = _fullscreen ? '🗗 Exit full screen' : '⛶ Full screen';
  q('#zm-detach').disabled = !open || (detached && !_st.floating);
  q('#zm-float').disabled = !open || (detached && _st.floating);
  q('#zm-dock').disabled = !open || !detached;
  q('#zm-zoomapp').disabled = !_st.canOpenInZoomApp;
  q('#zm-leave').disabled = !open;
  const ph = q('#zm-placeholder');
  if (ph) ph.style.display = open && !detached ? 'none' : '';
  if (ph && detached) ph.innerHTML = 'The meeting is in its own window.<br/>Use ↩ Dock to bring it back here.';
  _setStatus(_describe());
}

function _cornerRect() {
  const sb = document.getElementById('status-bar-mount');
  const bottom = sb && sb.getBoundingClientRect().height ? sb.getBoundingClientRect().top : window.innerHeight;
  return {
    x: Math.max(0, window.innerWidth - MINI.width - MINI.margin),
    y: Math.max(0, bottom - MINI.height - MINI.margin),
    width: MINI.width, height: MINI.height,
  };
}

function _showMiniBar(rect) {
  if (!_mini) return;
  if (!rect) { _mini.style.display = 'none'; return; }
  _mini.style.display = 'flex';
  _mini.style.left = rect.x + 'px';
  _mini.style.width = rect.width + 'px';
  _mini.style.top = Math.max(0, rect.y - 26) + 'px';
}

async function _report() {
  _raf = 0;
  if (!_enabled || !_st.open || _st.mode === 'detached') { _showMiniBar(null); return; }
  if (_active) {
    _showMiniBar(null);
    const r = _stage.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    await zoomMeet.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
    return;
  }
  if (_st.inMeeting && _miniPref === 'floating') {
    _showMiniBar(null);
    _autoFloated = true;
    await zoomMeet.detach({ floating: true });
    return;
  }
  if (_st.inMeeting) {
    const rect = _cornerRect();
    _showMiniBar(rect);
    await zoomMeet.setBounds(rect);
    return;
  }
  _showMiniBar(null);
  await zoomMeet.setBounds(null);
}

function _schedule() { if (!_raf) _raf = requestAnimationFrame(() => { _report(); }); }

function _setFullscreen(on) {
  _fullscreen = !!on && !!_st.open && _st.mode !== 'detached';
  _el.classList.toggle('zm-full', _fullscreen);
  _syncControls();
  _schedule();
}

function _onState(st) {
  _st = Object.assign({}, _st, st || {});
  if (!_st.open && _fullscreen) _setFullscreen(false);
  if (_st.mode !== 'detached') _autoFloated = false;
  _syncControls();
  _schedule();
}

async function _run(fn, busyMsg) {
  if (busyMsg) _setStatus(busyMsg);
  try {
    const r = await fn();
    if (r && r.ok === false) { _setStatus(r.error || 'Failed'); bus.emit('ui:toast', { type: 'warning', message: r.error || 'Zoom action failed', duration: 3000 }); return r; }
    if (r && typeof r === 'object' && 'open' in r) _onState(r);
    return r;
  } catch (e) {
    _setStatus('Error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function _wire() {
  const q = (id) => _el.querySelector(id);
  const join = () => {
    const input = q('#zm-link').value.trim();
    if (!input) { _setStatus('Enter a Zoom link or meeting ID'); return; }
    _run(() => zoomMeet.join({ input, passcode: q('#zm-pass').value }), 'Opening meeting…').then((r) => {
      if (r && r.ok !== false) { q('#zm-pass').value = ''; }
    });
  };
  q('#zm-join').addEventListener('click', join);
  q('#zm-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
  q('#zm-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); join(); } });
  q('#zm-home').addEventListener('click', () => _run(() => zoomMeet.openHome(), 'Opening Zoom…'));
  q('#zm-full').addEventListener('click', () => _setFullscreen(!_fullscreen));
  q('#zm-detach').addEventListener('click', () => { _setFullscreen(false); _autoFloated = false; _run(() => zoomMeet.detach({ floating: false })); });
  q('#zm-float').addEventListener('click', () => { _setFullscreen(false); _autoFloated = false; _run(() => zoomMeet.detach({ floating: true })); });
  q('#zm-dock').addEventListener('click', () => _run(() => zoomMeet.dock()));
  q('#zm-zoomapp').addEventListener('click', () => _run(() => zoomMeet.openInZoomApp()));
  q('#zm-leave').addEventListener('click', () => {
    if (!window.confirm('Leave the meeting?')) return;
    _setFullscreen(false);
    _run(() => zoomMeet.leave());
  });
  document.addEventListener('keydown', (e) => { if (_fullscreen && e.key === 'Escape') _setFullscreen(false); });

  // Corner mini player controls (shown only while the mini player is up).
  _mini = document.createElement('div');
  _mini.id = 'zm-mini-bar';
  _mini.setAttribute('role', 'toolbar');
  _mini.setAttribute('aria-label', 'Meeting mini player');
  _mini.innerHTML = `
    <button class="zm-btn" type="button" data-zm="return">↩ Return</button>
    <button class="zm-btn" type="button" data-zm="float">▣ Float</button>
    <button class="zm-btn zm-btn--danger" type="button" data-zm="leave">✕ Leave</button>`;
  document.body.appendChild(_mini);
  _mini.addEventListener('click', (e) => {
    const b = e.target.closest('[data-zm]');
    if (!b) return;
    if (b.dataset.zm === 'return') { const t = document.getElementById('tb-tab-meetings'); if (t) t.click(); }
    if (b.dataset.zm === 'float') { _autoFloated = false; _run(() => zoomMeet.detach({ floating: true })); }
    if (b.dataset.zm === 'leave' && window.confirm('Leave the meeting?')) _run(() => zoomMeet.leave());
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(_schedule).observe(_stage);
  window.addEventListener('resize', _schedule);

  bus.on('ui:view-change', ({ to }) => {
    if (to === 'settings') return;
    _active = to === 'meetings';
    _el.style.display = _active ? 'flex' : 'none';
    if (!_active && _fullscreen) _setFullscreen(false);
    if (_active && _autoFloated && _st.mode === 'detached') { _autoFloated = false; _run(() => zoomMeet.dock()); return; }
    _schedule();
  });
}

export async function init(container) {
  _injectStyles();
  _el = document.createElement('div');
  _el.id = 'view-meetings';
  _el.className = 'view view--meetings';
  _el.style.display = 'none';
  _el.innerHTML = _html();
  container.appendChild(_el);
  _stage = _el.querySelector('#zm-stage');
  _syncControls();

  let st;
  try { st = await zoomMeet.status(); } catch (_) { st = null; }
  _enabled = !!(st && st.ok !== false && st.enabled);
  if (!_enabled) return;   // flag off: tab stays hidden, nothing wired
  _miniPref = st.miniPlayer === 'floating' ? 'floating' : 'corner';
  const tab = document.getElementById('tb-tab-meetings');
  if (tab) tab.style.display = '';
  _wire();
  zoomMeet.onState(_onState);
  _onState(st);
}

export const __test__ = { _cornerRect, _describe };
