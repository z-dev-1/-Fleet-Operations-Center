/**
 * zoom/studio-panel.js -- Studio sub-tab: camera preview with canvas effects (design §14, FEAT-B1).
 * Same mount/show/hide/stopAll/destroy interface as the A1 stub; views/zoom-hub.js drives it and calls
 * stopAll() on sub-tab change, view change and when the Settings drawer opens.
 *
 * PREVIEW ONLY. Zoom can't see this video: Fleet ships no virtual camera and no driver. The honesty
 * banner at the top is permanent and cannot be dismissed.
 *
 * Show reads zoomHub.mediaStatus() and enumerates devices only. getUserMedia runs only from the user's
 * Start preview / mic test clicks (studio-devices.js). While any track is live a red '● Camera on'
 * badge shows in the Studio header and on the toolbar Zoom tab.
 *
 * FEAT-B2 mount points: div.zs-presets-host and div.zs-launcher-host (see getHosts()), plus
 * applyPreset(preset) / currentPreset() / getObsState() below.
 */
import { esc } from './data-logic.js';
import {
  HONESTY_BANNER, HONESTY_BANNER_LEAD, EFFECT_LABELS, EFFECT_MODES, RANGES, CAMERA_ON_BADGE,
  PRIVACY_BANNER_CAMERA, PRIVACY_BANNER_MIC, PRIVACY_BUTTON_CAMERA, PRIVACY_BUTTON_MIC,
  NATIVE_BLUR_NOTE, NATIVE_BLUR_UNSUPPORTED, MISSING_IMAGE,
  pickDefaultCamera, deviceLabel, obsState, obsNote, stateMessage, supportsNativeBlur,
} from './studio-logic.js';
import { createDevices } from './studio-devices.js';
import { createPipeline } from './studio-pipeline.js';
// FEAT-B2: presets + library (div.zs-presets-host) and the launcher section (div.zs-launcher-host).
import { createPresetsPanel } from './presets-panel.js';
import { createLibraryPanel } from './library-panel.js';
import { codeMessage } from './data-logic.js';
import { MAX_OVERLAYS } from './studio-logic.js';

let S = null;

// ── FEAT-B2 launcher section (design §15.4; review F-8) ─────────────────────
// The launcher only starts the user's own Grim Reaper / OBS setup outside Fleet. Fleet's preview is
// stopped first so the Grim Reaper page can use the camera.
export const LAUNCHER_TITLE = 'Virtual-camera setup (outside Fleet)';
export const LAUNCHER_BUTTON = 'Launch virtual-camera setup';
export const LAUNCHER_NOTE = "Starts your Grim Reaper page. OBS must capture that window and Start Virtual Camera; then pick 'OBS Virtual Camera' in Zoom. Fleet's preview is stopped so the Grim Reaper page can use the camera.";
export const LAUNCHER_OBS_FOUND = ' OBS Virtual Camera is installed on this PC.';
export const LAUNCHER_STARTED = 'Launcher started outside Fleet.';

/** launcherNote(obsState) -> the note under the launcher buttons. */
export function launcherNote(obs) {
  return LAUNCHER_NOTE + (obs === 'found' ? LAUNCHER_OBS_FOUND : '');
}

/** launcherMessage(r) -> status line for a launcher-run / launcher-pick result ('' for CANCELLED). */
export function launcherMessage(r) {
  if (r && r.ok) return LAUNCHER_STARTED;
  const code = r && r.code ? r.code : 'INTERNAL';
  if (code === 'CANCELLED') return '';
  if (code === 'NOT_FOUND') return 'Launcher file not found. Use Change… to pick it.';
  return codeMessage(code);
}

/** renderLauncher({path, exists, isDefault, obsState, busy, message}) -> launcher section HTML (pure). */
export function renderLauncher(st) {
  const s = st || {};
  const p = typeof s.path === 'string' && s.path ? s.path : null;
  const where = p
    ? `<code class="zs-launcher-file">${esc(p)}</code>${s.isDefault ? ' (default)' : ''}${s.exists === false ? ' (file not found)' : ''}`
    : 'Not set';
  const runDis = !p || s.busy ? ' disabled' : '';
  return `<section class="zs-launcher" aria-label="${esc(LAUNCHER_TITLE)}">` +
    `<h4 class="zs-sub">${esc(LAUNCHER_TITLE)}</h4>` +
    `<p class="zs-launcher-path">Launcher: ${where}</p>` +
    '<div class="zs-row">' +
      `<button type="button" class="zh-btn" data-action="launcher-run" aria-label="${esc(LAUNCHER_BUTTON)}"${runDis}>${esc(LAUNCHER_BUTTON)}</button> ` +
      `<button type="button" class="zh-btn" data-action="launcher-pick" aria-label="Change launcher file"${s.busy ? ' disabled' : ''}>Change…</button>` +
    '</div>' +
    `<p class="zs-note">${esc(launcherNote(s.obsState))}</p>` +
    `<div class="zs-launcher-msg" role="status" aria-live="polite">${s.message ? `<span>${esc(s.message)}</span>` : ''}</div>` +
  '</section>';
}

const BLOCKED = new Set(['denied', 'restricted']);

// ── Pure render helpers (exported for tests) ────────────────────────────────

/** renderPrivacy({camera, microphone}) -> banner HTML when Windows blocks camera or mic access, else ''. */
export function renderPrivacy(media) {
  const m = media || {};
  let html = '';
  if (BLOCKED.has(m.camera)) {
    html += `<div class="zs-privacy-row" role="alert"><span>${esc(PRIVACY_BANNER_CAMERA)}</span> ` +
      `<button type="button" class="zh-btn" data-action="open-privacy" data-which="camera" aria-label="${esc(PRIVACY_BUTTON_CAMERA)}">${esc(PRIVACY_BUTTON_CAMERA)}</button></div>`;
  }
  if (BLOCKED.has(m.microphone)) {
    html += `<div class="zs-privacy-row" role="alert"><span>${esc(PRIVACY_BANNER_MIC)}</span> ` +
      `<button type="button" class="zh-btn" data-action="open-privacy" data-which="microphone" aria-label="${esc(PRIVACY_BUTTON_MIC)}">${esc(PRIVACY_BUTTON_MIC)}</button></div>`;
  }
  return html;
}

function _options(list, selected) {
  if (!list.length) return '<option value="">No device found</option>';
  return list.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === selected ? ' selected' : ''}>${esc(deviceLabel(d, i))}</option>`).join('');
}

function _slider(role, group, key, label, value) {
  const r = RANGES[key];
  const g = group ? ` data-group="${group}"` : '';
  return `<label class="zs-slider">${esc(label)} <input type="range" data-role="${role}"${g} data-key="${key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${esc(value)}" aria-label="${esc(label)}"></label>`;
}

/** renderControls(state) -> the device / preview / effect / adjust controls HTML. */
export function renderControls(st) {
  const s = st || {};
  const cams = Array.isArray(s.cameras) ? s.cameras : [];
  const mics = Array.isArray(s.mics) ? s.mics : [];
  const e = s.effect || {};
  const a = s.adjust || {};
  const modes = EFFECT_MODES.filter((m) => m !== 'nativeBlur' || s.nativeBlurOk || e.mode === 'nativeBlur');
  const modeOpts = modes.map((m) => `<option value="${m}"${m === e.mode ? ' selected' : ''}>${esc(EFFECT_LABELS[m])}</option>`).join('');
  let effectExtra = '';
  if (e.mode === 'edgeBlur') {
    effectExtra = _slider('effect', 'edgeBlur', 'radiusPx', 'Blur strength', e.edgeBlur ? e.edgeBlur.radiusPx : RANGES.radiusPx.def) +
      _slider('effect', 'edgeBlur', 'focus', 'Sharp centre size', e.edgeBlur ? e.edgeBlur.focus : RANGES.focus.def);
  } else if (e.mode === 'chromaKey') {
    const c = (e.chromaKey && e.chromaKey.color) || 'green';
    effectExtra = `<label class="zs-field">Backdrop colour <select data-role="effect" data-group="chromaKey" data-key="color" aria-label="Backdrop colour">` +
      `<option value="green"${c === 'green' ? ' selected' : ''}>Green</option><option value="blue"${c === 'blue' ? ' selected' : ''}>Blue</option></select></label>` +
      _slider('effect', 'chromaKey', 'tolerance', 'Tolerance', e.chromaKey ? e.chromaKey.tolerance : RANGES.tolerance.def);
  } else if (e.mode === 'nativeBlur') {
    effectExtra = `<p class="zs-note">${esc(NATIVE_BLUR_NOTE)}</p>`;
  } else if (e.mode === 'image') {
    effectExtra = '<p class="zs-note">The camera stays off in this mode.</p>';
  }
  const live = !!s.previewing;
  const micOn = !!s.micOn;
  return '<div class="zs-row">' +
      `<label class="zs-field" for="zs-camera">Camera</label> <select id="zs-camera" class="zs-select" data-role="camera" aria-label="Camera">${_options(cams, s.cameraId)}</select> ` +
      `<button type="button" class="zh-btn zs-start" data-action="start" aria-label="Start camera preview"${live ? ' disabled' : ''}>Start preview</button> ` +
      `<button type="button" class="zh-btn" data-action="stop" aria-label="Stop camera preview"${live ? '' : ' disabled'}>Stop</button> ` +
      '<button type="button" class="zh-btn" data-action="rescan" aria-label="Re-scan cameras and microphones">Re-scan</button>' +
    '</div>' +
    '<div class="zs-row">' +
      `<label class="zs-field" for="zs-mic">Microphone</label> <select id="zs-mic" class="zs-select" data-role="mic" aria-label="Microphone">${_options(mics, s.micId)}</select> ` +
      `<button type="button" class="zh-btn zh-toggle${micOn ? ' active' : ''}" data-action="mic-test" aria-pressed="${micOn ? 'true' : 'false'}" aria-label="Microphone test">${micOn ? 'Stop mic test' : 'Mic test'}</button>` +
    '</div>' +
    '<fieldset class="zs-effects"><legend>Effect</legend>' +
      `<select class="zs-select" data-role="mode" aria-label="Effect">${modeOpts}</select>` +
      effectExtra +
    '</fieldset>' +
    '<fieldset class="zs-adjust"><legend>Adjust</legend>' +
      _slider('adjust', '', 'brightness', 'Brightness', a.brightness == null ? RANGES.brightness.def : a.brightness) +
      _slider('adjust', '', 'contrast', 'Contrast', a.contrast == null ? RANGES.contrast.def : a.contrast) +
      _slider('adjust', '', 'saturation', 'Saturation', a.saturation == null ? RANGES.saturation.def : a.saturation) +
      `<label class="zs-field"><input type="checkbox" data-role="adjust" data-key="mirror"${a.mirror ? ' checked' : ''} aria-label="Mirror"> Mirror</label>` +
    '</fieldset>';
}

/** renderState(mediaState) -> status HTML for a media error state (with the privacy / re-scan button). */
export function renderState(ms) {
  if (!ms) return '';
  let html = `<span>${esc(ms.message || stateMessage(ms))}</span>`;
  if (ms.state === 'blocked') html += ` <button type="button" class="zh-btn" data-action="open-privacy" data-which="camera" aria-label="${esc(PRIVACY_BUTTON_CAMERA)}">${esc(PRIVACY_BUTTON_CAMERA)}</button>`;
  else if (ms.state === 'not-found') html += ' <button type="button" class="zh-btn" data-action="rescan" aria-label="Re-scan cameras and microphones">Re-scan</button>';
  return html;
}

// ── Panel ───────────────────────────────────────────────────────────────────

function _actionTarget(e) {
  const t = e && e.target;
  if (!t) return null;
  const btn = typeof t.closest === 'function' ? t.closest('[data-action]') : t;
  return btn && btn.dataset && btn.dataset.action ? btn : null;
}

function _toolbarTabs(doc) {
  try {
    const all = doc && typeof doc.querySelectorAll === 'function' ? doc.querySelectorAll('[data-view="zoom"]') : [];
    return Array.from(all || []).filter((b) => b && ((b.classList && b.classList.contains('tb-tab')) || /(^|\s)tb-tab(\s|$)/.test(String(b.className || ''))));
  } catch (_) {
    return [];
  }
}

function _decode(doc, dataUrl) {
  return new Promise((resolve) => {
    try {
      const img = doc.createElement('img');
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    } catch (_) {
      resolve(null);
    }
  });
}

export function mount(el, opts = {}) {
  if (S) destroy();
  const doc = opts.document || el.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub || {};
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const raf = opts.raf || (typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : null);
  const caf = opts.caf || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : () => {});
  el.textContent = '';

  const mk = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
  const wrap = mk('div', 'zs-studio');

  // Permanent honesty banner (never re-rendered, no close button).
  const banner = mk('p', 'zs-honesty');
  banner.setAttribute('role', 'note');
  const lead = mk('strong', '');
  lead.textContent = HONESTY_BANNER_LEAD;
  const rest = mk('span', '');
  rest.textContent = HONESTY_BANNER.slice(HONESTY_BANNER_LEAD.length);
  banner.appendChild(lead);
  banner.appendChild(rest);

  const head = mk('div', 'zs-head');
  const title = mk('h3', 'zs-title');
  title.textContent = 'Studio';
  const badge = mk('span', 'zs-badge');
  badge.textContent = CAMERA_ON_BADGE;
  badge.setAttribute('role', 'status');
  badge.style.display = 'none';
  head.appendChild(title);
  head.appendChild(badge);

  const privacy = mk('div', 'zs-privacy');
  const status = mk('div', 'zs-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const obs = mk('p', 'zs-obs');
  obs.style.display = 'none';
  const controls = mk('div', 'zs-controls');

  const meter = mk('div', 'zs-level');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Microphone level');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', '0');
  const fill = mk('div', 'zs-level-fill');
  fill.style.width = '0%';
  meter.appendChild(fill);
  meter.style.display = 'none';

  const stage = mk('div', 'zs-stage');
  const video = mk('video', 'zs-video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.style.display = 'none';
  const canvas = mk('canvas', 'zs-canvas');
  canvas.setAttribute('aria-label', 'Camera preview (only visible in Fleet)');
  stage.appendChild(video);
  stage.appendChild(canvas);

  const presetsHost = mk('div', 'zs-presets-host');     // FEAT-B2 fills this (presets + library)
  const launcherHost = mk('div', 'zs-launcher-host');   // FEAT-B2 fills this (virtual-camera setup outside Fleet)

  for (const n of [banner, head, privacy, status, obs, controls, meter, stage, presetsHost, launcherHost]) wrap.appendChild(n);
  el.appendChild(wrap);

  S = {
    el, doc, win, raf, caf, zoomHub, flags: opts.flags || {}, bus: opts.bus || null,
    wrap, banner, badge, privacy, status, obs, controls, meter, fill, video, canvas, presetsHost, launcherHost,
    cameras: [], mics: [], all: [], cameraId: null, cameraAuto: true, micId: null,
    media: { camera: 'unknown', microphone: 'unknown' },
    obsState: 'unknown', previewing: false, micOn: false, live: false, nativeBlurOk: false,
    mediaState: null, message: '', seq: 0, meterId: null, visible: false, unsubDevice: null,
    images: new Map(),
  };

  S.devices = createDevices({
    mediaDevices: opts.mediaDevices,
    AudioContext: opts.AudioContext,
    onLiveChange: (live) => _onLive(live),
  });
  S.pipeline = createPipeline({
    video, canvas, document: doc, raf, caf,
    getImage: (id) => _getImage(id),
    onWarning: () => { if (S) { S.message = 'Preset image missing: ' + MISSING_IMAGE; _renderStatus(); } },
  });

  S.onClick = (e) => _onClick(e);
  S.onChange = (e) => _onChange(e);
  S.onUnload = () => stopAll();
  wrap.addEventListener('click', S.onClick);
  wrap.addEventListener('change', S.onChange);
  wrap.addEventListener('input', S.onChange);
  if (win && typeof win.addEventListener === 'function') { try { win.addEventListener('beforeunload', S.onUnload); } catch (_) {} }

  // FEAT-B2 mount points.
  const confirmFn = typeof opts.confirm === 'function'
    ? opts.confirm
    : (win && typeof win.confirm === 'function' ? (m) => win.confirm(m) : () => false);
  const studioApi = { applyPreset, currentPreset, assignImage, clearImage, updateOverlay, forgetImage };
  S.launcher = { path: null, exists: false, isDefault: false, busy: false, message: '' };
  S.launcherEl = mk('div', 'zs-launcher-panel');
  launcherHost.appendChild(S.launcherEl);
  S.presetsPanel = createPresetsPanel(presetsHost, {
    zoomHub, document: doc, studio: studioApi, confirm: confirmFn,
    onApplied: () => { if (S && S.libraryPanel) S.libraryPanel.render(); },
  });
  S.libraryPanel = createLibraryPanel(presetsHost, {
    zoomHub, document: doc, studio: studioApi, confirm: confirmFn,
    onChange: () => { if (S && S.presetsPanel) S.presetsPanel.refresh(); },
  });

  _render();
  return S;
}

async function _getImage(id) {
  if (!S) return null;
  if (S.images.has(id)) return S.images.get(id);
  const doc = S.doc;
  const p = (async () => {
    let r = null;
    try { r = await S.zoomHub.libraryRead({ id }); } catch (_) { r = null; }
    const url = r && r.ok ? (r.dataUrl || r.url) : null;
    if (typeof url !== 'string' || !url.startsWith('data:image/')) return null;
    return _decode(doc, url);
  })();
  S.images.set(id, p);
  return p;
}

function _render() {
  if (!S) return;
  const st = S.pipeline.getState();
  S.controls.innerHTML = renderControls({
    cameras: S.cameras, mics: S.mics, cameraId: S.cameraId, micId: S.micId, previewing: S.previewing,
    micOn: S.micOn, nativeBlurOk: S.nativeBlurOk, effect: st.effect, adjust: st.adjust,
  });
  S.privacy.innerHTML = renderPrivacy(S.media);
  _renderStatus();
  _renderObs();
  _renderBadge();
  _renderLauncher();
}

function _renderLauncher() {
  if (!S || !S.launcherEl) return;
  S.launcherEl.innerHTML = renderLauncher(Object.assign({}, S.launcher, { obsState: S.obsState }));
}

async function _refreshLauncher() {
  if (!S) return;
  let r = null;
  try { r = typeof S.zoomHub.launcherGet === 'function' ? await S.zoomHub.launcherGet() : null; } catch (_) { r = null; }
  if (!S) return;
  if (r && r.ok) Object.assign(S.launcher, { path: typeof r.path === 'string' ? r.path : null, exists: !!r.exists, isDefault: !!r.isDefault });
  _renderLauncher();
}

/** _launch() -- review F-8: stop Fleet's preview (every track) BEFORE launcherRun, so the Grim Reaper page can use the camera. */
async function _launch() {
  if (!S || S.launcher.busy) return;
  stopAll();
  S.launcher.busy = true;
  S.launcher.message = '';
  _renderLauncher();
  let r = null;
  try { r = typeof S.zoomHub.launcherRun === 'function' ? await S.zoomHub.launcherRun() : { ok: false, code: 'UNAVAILABLE' }; } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  S.launcher.busy = false;
  S.launcher.message = launcherMessage(r);
  _renderLauncher();
}

async function _pickLauncher() {
  if (!S || S.launcher.busy) return;
  let r = null;
  try { r = typeof S.zoomHub.launcherPick === 'function' ? await S.zoomHub.launcherPick() : { ok: false, code: 'UNAVAILABLE' }; } catch (_) { r = { ok: false, code: 'INTERNAL' }; }
  if (!S) return;
  if (r && r.ok) {
    S.launcher.message = 'Launcher file updated.';
    await _refreshLauncher();
    return;
  }
  S.launcher.message = launcherMessage(r);
  _renderLauncher();
}

function _renderStatus() {
  if (!S) return;
  if (S.mediaState) S.status.innerHTML = renderState(S.mediaState);
  else S.status.innerHTML = S.message ? `<span>${esc(S.message)}</span>` : '';
}

function _renderObs() {
  if (!S) return;
  const t = obsNote(S.obsState);
  S.obs.textContent = t;
  S.obs.style.display = t ? '' : 'none';
}

function _renderBadge() {
  if (!S) return;
  const live = !!S.live;
  S.badge.style.display = live ? '' : 'none';
  for (const b of _toolbarTabs(S.doc)) {
    try {
      b.classList.toggle('zs-camera-on', live);
      if (live) b.setAttribute('title', 'Camera on'); else if (typeof b.removeAttribute === 'function') b.removeAttribute('title'); else b.setAttribute('title', '');
    } catch (_) {}
  }
}

function _onLive(live) {
  if (!S) return;
  S.live = !!live;
  if (!live) {
    // A track ended (camera unplugged, another app took it) or everything was stopped.
    if (S.previewing && S.pipeline.getState().effect.mode !== 'image') {
      S.previewing = false;
      try { S.pipeline.stop(); } catch (_) {}
      S.video.srcObject = null;
    }
    if (S.micOn) { S.micOn = false; _stopMeter(); }
    _render();
    return;
  }
  _renderBadge();
}

function _applyList(l) {
  if (!S || !l || !l.ok) return;
  S.all = l.all;
  S.cameras = l.cameras;
  S.mics = l.mics;
  // An automatic choice is re-made when labels arrive (before the first grant every label is empty, so
  // the IR / OBS rule can't apply yet). A user's or preset's choice is kept while the device exists.
  const exists = !!S.cameraId && S.cameras.some((d) => d.deviceId === S.cameraId);
  if (!exists || (S.cameraAuto && !S.previewing)) {
    S.cameraId = pickDefaultCamera(S.cameras);
    S.cameraAuto = true;
  }
  if (!S.micId || !S.mics.some((d) => d.deviceId === S.micId)) S.micId = S.mics.length ? S.mics[0].deviceId : null;
  S.obsState = obsState(S.all);
}

async function refreshDevices() {
  if (!S) return;
  const l = await S.devices.list();
  if (!S) return;
  if (l.ok) _applyList(l);
  else S.mediaState = { state: l.state, name: l.name };
  _render();
}

async function refreshMedia() {
  if (!S) return;
  let r = null;
  try { r = await S.zoomHub.mediaStatus(); } catch (_) { r = null; }
  if (!S) return;
  S.media = r && r.ok ? { camera: r.camera, microphone: r.microphone } : { camera: 'unknown', microphone: 'unknown' };
  S.privacy.innerHTML = renderPrivacy(S.media);
}

async function startPreview(retry) {
  if (!S) return;
  const my = ++S.seq;
  S.mediaState = null;
  S.message = '';
  const mode = S.pipeline.getState().effect.mode;
  if (mode === 'image') {
    // Full-frame image: the camera is NOT opened.
    S.devices.stopVideo();
    S.video.srcObject = null;
    S.previewing = true;
    S.pipeline.start();
    _render();
    return;
  }
  S.message = 'Starting camera…';
  _renderStatus();
  const r = await S.devices.start(S.cameraId);
  if (!S) return;
  if (my !== S.seq) { S.devices.stopVideo(); return; }   // stopped while starting
  S.message = '';
  if (!r.ok) {
    S.previewing = false;
    S.pipeline.stop();
    S.mediaState = { state: r.state, name: r.name };
    _render();
    return;
  }
  S.video.srcObject = r.stream;
  try { const p = typeof S.video.play === 'function' ? S.video.play() : null; if (p && typeof p.catch === 'function') p.catch(() => {}); } catch (_) {}
  if (r.list) _applyList(r.list);
  // The first grant filled in labels and the automatic pick turned out to be the IR or OBS camera:
  // switch once to the proper default.
  if (!retry && S.cameraAuto && S.cameraId && r.deviceId && S.cameraId !== r.deviceId) return startPreview(true);
  let caps = null;
  try { caps = r.track && typeof r.track.getCapabilities === 'function' ? r.track.getCapabilities() : null; } catch (_) { caps = null; }
  S.nativeBlurOk = supportsNativeBlur(caps);
  S.previewing = true;
  S.pipeline.start();
  if (mode === 'nativeBlur') await _nativeBlur(true);
  _render();
}

async function _nativeBlur(on) {
  if (!S) return;
  const r = await S.pipeline.applyNativeBlur(on);
  if (!S) return;
  if (!r.ok) S.message = r.message || NATIVE_BLUR_UNSUPPORTED;
}

async function _toggleMic() {
  if (!S) return;
  if (S.micOn) {
    S.devices.stopMic();
    S.micOn = false;
    _stopMeter();
    _render();
    return;
  }
  const r = await S.devices.startMic(S.micId);
  if (!S) return;
  if (!r.ok) {
    S.message = 'Microphone unavailable (' + String(r.name || r.state).replace(/[^A-Za-z0-9_-]/g, '') + ')';
    _render();
    return;
  }
  S.micOn = true;
  _startMeter();
  _render();
}

function _startMeter() {
  if (!S) return;
  S.meter.style.display = '';
  const tick = () => {
    if (!S || !S.micOn) return;
    const pct = Math.min(100, Math.round(S.devices.micLevel() * 300));
    S.fill.style.width = pct + '%';
    S.meter.setAttribute('aria-valuenow', String(pct));
    S.meterId = S.raf ? S.raf(tick) : null;
  };
  tick();
}

function _stopMeter() {
  if (!S) return;
  if (S.meterId !== null && S.meterId !== undefined) { try { S.caf(S.meterId); } catch (_) {} }
  S.meterId = null;
  S.fill.style.width = '0%';
  S.meter.setAttribute('aria-valuenow', '0');
  S.meter.style.display = 'none';
}

async function _openPrivacy(which) {
  if (!S) return;
  const w = which === 'microphone' ? 'microphone' : 'camera';
  try { await S.zoomHub.openPrivacy({ which: w }); } catch (_) {}
}

async function _setMode(mode) {
  if (!S) return;
  const m = EFFECT_MODES.includes(mode) ? mode : 'none';
  const prev = S.pipeline.getState().effect.mode;
  if (prev === 'nativeBlur' && m !== 'nativeBlur') await S.pipeline.applyNativeBlur(false);
  if (!S) return;
  S.pipeline.setEffect({ mode: m });
  S.message = '';
  await _afterModeChange(prev, m);
  if (!S) return;
  _render();
}

/**
 * _afterModeChange(prev, m) -- keep a live preview consistent after the effect mode changed (from the
 * Effect picker or a loaded preset): image mode closes the camera, leaving image mode stops the preview
 * and asks for Start preview, nativeBlur applies the camera constraint. Never opens a camera.
 */
async function _afterModeChange(prev, m) {
  if (!S || !S.previewing || prev === m) return;
  if (m === 'image' && prev !== 'image') {
    // Image mode keeps the camera closed.
    S.devices.stopVideo();
    S.video.srcObject = null;
    S.previewing = true;
  } else if (prev === 'image' && m !== 'image') {
    S.pipeline.stop();
    S.previewing = false;
    S.message = 'Press Start preview to open the camera.';
  } else if (m === 'nativeBlur') {
    await _nativeBlur(true);
  }
}

function _onClick(e) {
  const b = _actionTarget(e);
  if (!b || b.disabled) return;
  const a = b.dataset.action;
  if (a === 'start') startPreview();
  else if (a === 'stop') stopAll();
  else if (a === 'rescan') { if (S) S.mediaState = null; refreshDevices(); }
  else if (a === 'mic-test') _toggleMic();
  else if (a === 'open-privacy') _openPrivacy(b.dataset.which);
  else if (a === 'launcher-run') _launch();
  else if (a === 'launcher-pick') _pickLauncher();
}

function _onChange(e) {
  if (!S) return;
  const t = e && e.target;
  const role = t && t.dataset ? t.dataset.role : null;
  if (!role) return;
  const type = e && e.type;
  if (role === 'camera') {
    if (type !== 'change') return;
    S.cameraId = t.value || null;
    S.cameraAuto = false;
    if (S.previewing && S.pipeline.getState().effect.mode !== 'image') startPreview();
  } else if (role === 'mic') {
    if (type !== 'change') return;
    S.micId = t.value || null;
    if (S.micOn) { S.devices.stopMic(); S.micOn = false; _toggleMic(); }
  } else if (role === 'mode') {
    if (type !== 'change') return;
    _setMode(t.value);
  } else if (role === 'effect') {
    const group = t.dataset.group;
    const key = t.dataset.key;
    if (group !== 'edgeBlur' && group !== 'chromaKey') return;
    const v = key === 'color' ? t.value : Number(t.value);
    S.pipeline.setEffect({ [group]: { [key]: v } });
  } else if (role === 'adjust') {
    const key = t.dataset.key;
    if (key === 'mirror') S.pipeline.setAdjust({ mirror: !!t.checked });
    else if (key === 'brightness' || key === 'contrast' || key === 'saturation') S.pipeline.setAdjust({ [key]: Number(t.value) });
  }
}

function _subscribeDevices() {
  if (!S || S.unsubDevice) return;
  S.unsubDevice = S.devices.onDeviceChange(({ list, lost }) => {
    if (!S) return;
    if (list && list.ok) _applyList(list);
    if (lost) S.mediaState = { state: 'not-found', name: 'NotFoundError' };
    _render();
  });
}

export function show() {
  if (!S) return;
  S.visible = true;
  _subscribeDevices();
  // mediaStatus + enumerateDevices only. Never getUserMedia on show.
  // FEAT-B2: after the devices are known, list presets (the first show restores lastPresetId onto the
  // controls without opening the camera), the library and the launcher path.
  return Promise.all([refreshMedia(), refreshDevices()]).then(() => {
    if (!S) return null;
    _render();
    return Promise.all([S.presetsPanel.show(), S.libraryPanel.show(), _refreshLauncher()]);
  }).then(() => { if (S) { S.libraryPanel.render(); _render(); } });
}

export function hide() {
  if (!S) return;
  S.visible = false;
  stopAll();
  if (typeof S.unsubDevice === 'function') { try { S.unsubDevice(); } catch (_) {} }
  S.unsubDevice = null;
}

/** stopAll() -- stop every track, the rAF loops and the mic test; clears the Camera on badge. */
export function stopAll() {
  if (!S) return;
  S.seq++;
  try { S.devices.stopAll(); } catch (_) {}
  try { S.pipeline.stop(); } catch (_) {}
  S.video.srcObject = null;
  _stopMeter();
  S.previewing = false;
  S.micOn = false;
  S.live = false;
  _render();
}

export function destroy() {
  if (!S) return;
  stopAll();
  if (typeof S.unsubDevice === 'function') { try { S.unsubDevice(); } catch (_) {} }
  try { S.wrap.removeEventListener('click', S.onClick); } catch (_) {}
  try { S.wrap.removeEventListener('change', S.onChange); } catch (_) {}
  try { S.wrap.removeEventListener('input', S.onChange); } catch (_) {}
  if (S.win && typeof S.win.removeEventListener === 'function') { try { S.win.removeEventListener('beforeunload', S.onUnload); } catch (_) {} }
  try { S.presetsPanel.destroy(); } catch (_) {}
  try { S.libraryPanel.destroy(); } catch (_) {}   // clears the in-memory WebP thumbnail Map
  S.images.clear();
  S = null;
}

// ── FEAT-B2 hooks ───────────────────────────────────────────────────────────

/** getHosts() -> {presets: div.zs-presets-host, launcher: div.zs-launcher-host} | null. */
export function getHosts() {
  return S ? { presets: S.presetsHost, launcher: S.launcherHost } : null;
}

/** getObsState() -> 'unknown' | 'found' | 'absent' (re-evaluated on show, getUserMedia, devicechange). */
export function getObsState() { return S ? S.obsState : 'unknown'; }

/**
 * applyPreset(preset) -- apply a §15.1 preset to the controls WITHOUT starting the camera. Camera and
 * mic are restored by id, then by label. Returns {cameraFound, micFound}.
 */
export function applyPreset(preset) {
  if (!S) return { cameraFound: false, micFound: false };
  const p = preset && typeof preset === 'object' ? preset : {};
  const match = (list, ref) => {
    if (!ref || typeof ref !== 'object') return null;
    const byId = ref.id ? list.find((d) => d.deviceId === ref.id) : null;
    if (byId) return byId;
    return ref.label ? list.find((d) => d.label && d.label === ref.label) || null : null;
  };
  const cam = match(S.cameras, p.camera);
  const mic = match(S.mics, p.mic);
  const prevCamera = S.cameraId;
  if (cam) { S.cameraId = cam.deviceId; S.cameraAuto = false; }
  if (mic) S.micId = mic.deviceId;
  const prevMode = S.pipeline.getState().effect.mode;
  S.pipeline.setPreset(p);
  const mode = S.pipeline.getState().effect.mode;
  _render();
  // A preset loaded while the preview is live goes through the same rules as the Effect / Camera
  // pickers (camera-native blur switched off, image mode closes the camera, a live camera follows the
  // preset's camera). With the preview stopped nothing here touches a camera.
  if (S.previewing) {
    const s = S;
    (async () => {
      if (prevMode === 'nativeBlur' && mode !== 'nativeBlur') await s.pipeline.applyNativeBlur(false);
      if (S !== s) return;
      await _afterModeChange(prevMode, mode);
      if (S !== s) return;
      if (S.previewing && mode !== 'image' && S.cameraId !== prevCamera) { startPreview(); return; }
      _render();
    })().catch(() => {});
  }
  return { cameraFound: !!cam || !(p.camera && (p.camera.id || p.camera.label)), micFound: !!mic || !(p.mic && (p.mic.id || p.mic.label)) };
}

/** currentPreset() -> {camera, mic, effect, adjust, overlays} from the current controls (for saving). */
export function currentPreset() {
  if (!S) return null;
  const dev = (list, id) => { const d = list.find((x) => x.deviceId === id); return { id: id || null, label: d && d.label ? d.label : null }; };
  const st = S.pipeline.getState();
  return { camera: dev(S.cameras, S.cameraId), mic: dev(S.mics, S.micId), effect: st.effect, adjust: st.adjust, overlays: st.overlays };
}

/**
 * assignImage(slot, id) -- put a library image on the Background (chroma-key backdrop), Avatar
 * (full-frame image mode) or Overlay slot. Never starts the camera. Returns {ok, message?}.
 */
export function assignImage(slot, id) {
  if (!S) return { ok: false };
  if (slot === 'background') S.pipeline.setEffect({ chromaKey: { backgroundId: id } });
  else if (slot === 'avatar') S.pipeline.setEffect({ imageId: id });
  else if (slot === 'overlay') {
    const ov = S.pipeline.getState().overlays;
    if (ov.length >= MAX_OVERLAYS) return { ok: false, message: 'At most ' + MAX_OVERLAYS + ' overlays. Clear one first.' };
    S.pipeline.setOverlays(ov.concat([{ imageId: id, x: RANGES.x.def, y: RANGES.y.def, scale: RANGES.scale.def, opacity: RANGES.opacity.def }]));
  } else {
    return { ok: false };
  }
  _render();
  const mode = S.pipeline.getState().effect.mode;
  if (slot === 'background' && mode !== 'chromaKey') return { ok: true, message: "Background set. Pick 'Green-screen replace' under Effect to use it." };
  if (slot === 'avatar' && mode !== 'image') return { ok: true, message: "Avatar set. Pick 'Full-frame image' under Effect to show it." };
  return { ok: true };
}

/** clearImage(slot, index) -- empty a slot (overlay: the one at index). */
export function clearImage(slot, index) {
  if (!S) return;
  if (slot === 'background') S.pipeline.setEffect({ chromaKey: { backgroundId: null } });
  else if (slot === 'avatar') S.pipeline.setEffect({ imageId: null });
  else if (slot === 'overlay') S.pipeline.setOverlays(S.pipeline.getState().overlays.filter((_o, i) => i !== index));
  _render();
}

/** updateOverlay(index, patch) -- move / scale / fade one overlay (values clamped by the pipeline). */
export function updateOverlay(index, patch) {
  if (!S) return;
  const ov = S.pipeline.getState().overlays;
  if (!ov[index]) return;
  ov[index] = Object.assign({}, ov[index], patch || {});
  S.pipeline.setOverlays(ov);
}

/** forgetImage(id) -- a library image was deleted: drop it from the current controls and caches. */
export function forgetImage(id) {
  if (!S) return;
  const st = S.pipeline.getState();
  if (st.effect.chromaKey.backgroundId === id) S.pipeline.setEffect({ chromaKey: { backgroundId: null } });
  if (st.effect.imageId === id) S.pipeline.setEffect({ imageId: null });
  if (st.overlays.some((o) => o.imageId === id)) S.pipeline.setOverlays(st.overlays.filter((o) => o.imageId !== id));
  S.images.delete(id);
  _render();
}

/** _state() -- test seam. */
export function _state() { return S; }
