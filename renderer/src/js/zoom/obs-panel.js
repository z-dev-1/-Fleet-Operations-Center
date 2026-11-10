/**
 * zoom/obs-panel.js -- the Studio "OBS output" section (design §5.3, flag zoom.studio.obs). Mounted
 * by studio-panel.js into div.zs-obs-host.
 *
 * createObsPanel(host, {zoomHub, feed, studio, document}) -> {render, refresh, show, stopOutput, destroy, root, _state}
 *   studio = {stopPreview(), startArgs() -> {cameraId, preset, getImage}}
 *
 * OBS is driven only through zoomHub.obs* (main process). Start OBS output: stop the panel preview ->
 * feed.prepare -> obsStart() (main connects first when needed) -> feed.connect(feedUrl). A prepare
 * failure makes no OBS call; an obsStart failure stops the feed. Stop: feed.stop() then obsStop().
 * Review F1: when the panel mounts and obsStatus() reports recoveryPending with state idle, it calls
 * obsConnect() once so main can switch OBS back to the user's scene.
 *
 * The password field is type=password / autocomplete=off, sent once through obsConfigSet and then
 * cleared; the panel only says "Password saved" or "Password kept for this session only."
 */
import { codeMessage } from './data-logic.js';
import { stateMessage } from './studio-logic.js';
import {
  renderObsSection, renderObsForm, FEED_STATES, PASSWORD_SAVED, PASSWORD_SESSION,
} from './obs-logic.js';

async function _call(hub, name, payload) {
  try {
    const f = hub && hub[name];
    if (typeof f !== 'function') return { ok: false, code: 'UNAVAILABLE' };
    const r = await f(payload === undefined ? {} : payload);
    return r && typeof r === 'object' ? r : { ok: false, code: 'INTERNAL' };
  } catch (_) {
    return { ok: false, code: 'INTERNAL' };
  }
}

function _actionTarget(e) {
  const t = e && e.target;
  if (!t) return null;
  const btn = typeof t.closest === 'function' ? t.closest('[data-action]') : t;
  return btn && btn.dataset && btn.dataset.action ? btn : null;
}

/** fieldMessage(r) -> the sentence for an obsConfigSet failure (field-aware for INVALID_INPUT). */
export function fieldMessage(r) {
  const code = r && r.code ? r.code : 'INTERNAL';
  if (code === 'INVALID_INPUT') {
    const f = r && r.field;
    if (f === 'host') return 'OBS host must be 127.0.0.1 or localhost.';
    if (f === 'port') return 'OBS port must be a whole number from 1024 to 65535.';
    if (f === 'exePath') return 'OBS program must be the full path to obs64.exe.';
    if (f === 'password') return 'OBS password must be at most 256 characters.';
  }
  return codeMessage(code);
}

function _pwNote(v) {
  if (v === true) return PASSWORD_SAVED;
  if (v === false) return PASSWORD_SESSION;
  return '';
}

export function createObsPanel(host, opts = {}) {
  const doc = opts.document || host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub || {};
  const feed = opts.feed || null;
  const studio = opts.studio || {};
  const root = doc.createElement('div');
  root.className = 'zs-obs-panel';
  const formEl = doc.createElement('div');
  formEl.className = 'zs-obs-form-host';
  const mainEl = doc.createElement('div');
  mainEl.className = 'zs-obs-main';
  root.appendChild(mainEl);
  root.appendChild(formEl);
  host.appendChild(root);

  const st = {
    status: null, feedState: null, message: '', inFlight: false, showHint: false,
    host: '127.0.0.1', port: 4455, exePath: '', pwDraft: '', dirty: false, exeDirty: false, passwordNote: '',
    autoTried: false, destroyed: false,
  };

  function render() {
    if (st.destroyed) return;
    // Renderer feed states go first (obs-loop / in-use / camera-lost); a feed-side 'feed-lost' is shown
    // as the reason, because main's own stop result carries no reason for it.
    const fs = st.feedState;
    const own = FEED_STATES.includes(fs);
    const status = fs && !own ? Object.assign({}, st.status || { state: 'idle' }, { reason: fs }) : st.status;
    mainEl.innerHTML = renderObsSection({ status, feedState: own ? fs : null, message: st.message, inFlight: st.inFlight, showHint: st.showHint });
  }

  function renderForm() {
    if (st.destroyed) return;
    formEl.innerHTML = renderObsForm({ host: st.host, port: st.port, exePath: st.exePath, passwordNote: st.passwordNote, inFlight: false });
  }

  /** _apply(r) -- take a status-shaped result (or a plain failure) into the panel state. */
  function _apply(r) {
    if (r && typeof r.state === 'string') {
      const s = Object.assign({}, r);
      delete s.feedUrl;   // the feed URL is handed to the feed only, never kept or rendered
      st.status = s;
      st.message = '';
      if (s.passwordSaved !== undefined) st.passwordNote = _pwNote(s.passwordSaved);
    } else if (r && r.ok === false) {
      st.message = codeMessage(r.code || 'INTERNAL');
    }
  }

  function _fillFields(r) {
    if (!r || st.dirty) return;
    if (typeof r.host === 'string') st.host = r.host;
    if (typeof r.port === 'number') st.port = r.port;
    st.exePath = typeof r.exePath === 'string' ? r.exePath : '';
  }

  async function refresh(o = {}) {
    if (st.destroyed) return null;
    const r = await _call(zoomHub, 'obsStatus');
    if (st.destroyed) return null;
    _apply(r);
    _fillFields(r);
    render();
    renderForm();
    // Review F1: a pending recovery with OBS idle -> connect once, automatically, on mount.
    if (o.auto && !st.autoTried && r && r.recoveryPending === true && r.state === 'idle') {
      st.autoTried = true;
      await _op('obsConnect');
    }
    return r;
  }

  /** _saveConfig() -> true when saved. The password is sent once and then dropped from the panel. */
  async function _saveConfig() {
    const payload = { host: st.host, port: st.port };
    if (st.exeDirty) payload.exePath = st.exePath ? st.exePath : null;
    if (st.pwDraft) payload.password = st.pwDraft;
    st.pwDraft = '';
    const r = await _call(zoomHub, 'obsConfigSet', payload);
    if (st.destroyed) return false;
    if (!r.ok) {
      st.message = fieldMessage(r);
      renderForm();
      render();
      return false;
    }
    st.dirty = false;
    st.exeDirty = false;
    _apply(r);
    _fillFields(r);
    renderForm();
    render();
    return true;
  }

  async function _op(name) {
    if (st.inFlight || st.destroyed) return null;
    st.inFlight = true;
    st.feedState = null;
    st.message = '';
    render();
    let r = null;
    try {
      if (st.dirty && !(await _saveConfig())) return null;
      r = await _call(zoomHub, name);
      if (st.destroyed) return r;
      _apply(r);
      if (name === 'obsLaunch' && r && r.ok) {
        // Main opens its 20 s start window; connecting now shows "Starting OBS…" until OBS answers.
        r = await _call(zoomHub, 'obsConnect');
        if (st.destroyed) return r;
        _apply(r);
      }
    } finally {
      st.inFlight = false;
      render();
    }
    return r;
  }

  async function _start() {
    if (st.inFlight || st.destroyed || !feed) return;
    st.inFlight = true;
    st.feedState = null;
    st.message = '';
    render();
    try {
      if (st.dirty && !(await _saveConfig())) return;
      try { if (typeof studio.stopPreview === 'function') studio.stopPreview(); } catch (_) {}
      const args = typeof studio.startArgs === 'function' ? studio.startArgs() : {};
      const p = await feed.prepare(Object.assign({ zoomHub }, args));
      if (st.destroyed) return;
      if (!p || !p.ok) {
        const state = p && p.state;
        if (FEED_STATES.includes(state)) st.feedState = state;
        else st.message = stateMessage({ state: state || 'error', name: p && p.name });
        return;
      }
      const r = await _call(zoomHub, 'obsStart');
      if (st.destroyed) return;
      if (!r.ok) { feed.stop(); _apply(r); return; }
      const c = feed.connect(r.feedUrl);
      _apply(r);
      if (c && c.ok === false) {
        feed.stop();
        _apply(await _call(zoomHub, 'obsStop'));
        st.message = codeMessage('OBS_FEED_FAILED');
      }
    } finally {
      st.inFlight = false;
      render();
    }
  }

  /** stopOutput() -- Stop OBS output: the feed first, then main restores the scene / vcam. */
  async function stopOutput() {
    if (st.destroyed) return;
    st.inFlight = true;
    st.feedState = null;
    st.message = '';
    render();
    try {
      if (feed) feed.stop();
      const r = await _call(zoomHub, 'obsStop');
      if (!st.destroyed) _apply(r);
    } finally {
      st.inFlight = false;
      render();
    }
  }

  function onClick(e) {
    const b = _actionTarget(e);
    if (!b || b.disabled) return;
    const a = b.dataset.action;
    if (a === 'obs-connect') _op('obsConnect');
    else if (a === 'obs-disconnect') { if (feed && feed.live) feed.stop(); _op('obsDisconnect'); }
    else if (a === 'obs-start') _start();
    else if (a === 'obs-stop') stopOutput();
    else if (a === 'obs-launch') _op('obsLaunch');
    else if (a === 'obs-save') { if (!st.inFlight) _saveConfig(); }
    else if (a === 'obs-hint') { st.showHint = !st.showHint; render(); }
  }

  function onInput(e) {
    const t = e && e.target;
    const role = t && t.dataset ? t.dataset.role : null;
    if (role === 'obs-host') { st.host = String(t.value || '').trim(); st.dirty = true; }
    else if (role === 'obs-port') { st.port = Number(t.value); st.dirty = true; }
    else if (role === 'obs-password') { st.pwDraft = String(t.value || ''); st.dirty = true; }
    else if (role === 'obs-exe') { st.exePath = String(t.value || '').trim(); st.exeDirty = true; st.dirty = true; }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onInput);

  const unsubState = typeof zoomHub.onObsState === 'function'
    ? zoomHub.onObsState((s) => {
      if (st.destroyed || !s || typeof s !== 'object') return;
      _apply(s);
      if ((s.state === 'obs-closed' || s.reason === 'feed-lost') && feed && feed.live) feed.stop();
      render();
    })
    : null;
  const unsubFeed = feed && typeof feed.onLiveChange === 'function'
    ? feed.onLiveChange((live, reason) => {
      if (st.destroyed) return;
      if (!live && reason) st.feedState = reason;
      render();
    })
    : null;

  render();
  renderForm();
  refresh({ auto: true }).catch(() => {});

  function show() { return refresh(); }

  function destroy() {
    if (st.destroyed) return;
    st.destroyed = true;
    try { if (typeof unsubState === 'function') unsubState(); } catch (_) {}
    try { if (typeof unsubFeed === 'function') unsubFeed(); } catch (_) {}
    try { root.removeEventListener('click', onClick); } catch (_) {}
    try { root.removeEventListener('input', onInput); } catch (_) {}
    try { root.removeEventListener('change', onInput); } catch (_) {}
    try { root.remove(); } catch (_) {}
  }

  return { render, refresh, show, stopOutput, destroy, root, _state: () => st };
}
