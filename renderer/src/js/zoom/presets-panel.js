/**
 * zoom/presets-panel.js -- Studio presets (design §15.1-§15.2, FEAT-B2). Mounted by studio-panel.js
 * into div.zs-presets-host.
 *
 * createPresetsPanel(host, {zoomHub, document, studio, confirm, onApplied}) -> {show, refresh, render, destroy, _state}
 *   studio = {applyPreset(p) -> {cameraFound, micFound}, currentPreset() -> {camera, mic, effect, adjust, overlays}}
 *
 * Load applies a preset to the controls WITHOUT starting the camera (studio.applyPreset never calls
 * getUserMedia). On the first show the last-used preset (lastPresetId) is restored the same way.
 * Devices are restored by id, then by label; when neither matches the default stays and the panel
 * says "Saved camera not found". Main validates every save (preset-schema.js); errors use codeMessage.
 */
import { esc, codeMessage } from './data-logic.js';

export const MSG_CAMERA_NOT_FOUND = 'Saved camera not found';
export const MSG_MIC_NOT_FOUND = 'Saved microphone not found';
export const MSG_LOADED = 'Preset loaded. Press Start preview to see it.';

const NAME_MAX = 60;
const ID_MAX = 256;
const LABEL_MAX = 120;

async function _call(hub, name, payload) {
  try {
    const f = hub && hub[name];
    if (typeof f !== 'function') return { ok: false, code: 'UNAVAILABLE' };
    const r = await f(payload);
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

/** errorMessage(r) -> the sentence for a failed preset call (field-aware for INVALID_INPUT). */
export function errorMessage(r) {
  const code = r && r.code ? r.code : 'INTERNAL';
  if (code === 'INVALID_INPUT') {
    const f = String((r && r.field) || '');
    if (f === 'effect.chromaKey.backgroundId') return 'Pick a background image in the Library before saving green-screen replace.';
    if (f === 'effect.imageId') return 'Pick an avatar image in the Library before saving full-frame image mode.';
    if (f === 'name') return 'Preset names are 1 to 60 characters.';
    if (f) return 'A preset setting is out of range (' + f.replace(/[^A-Za-z0-9_.]/g, '') + ').';
  }
  return codeMessage(code);
}

/** loadMessage({cameraFound, micFound}) -> the status line after a preset is applied. */
export function loadMessage(r) {
  const parts = [];
  if (r && r.cameraFound === false) parts.push(MSG_CAMERA_NOT_FOUND);
  if (r && r.micFound === false) parts.push(MSG_MIC_NOT_FOUND);
  return parts.length ? parts.join('. ') + '. ' + MSG_LOADED : MSG_LOADED;
}

/** renderPresets(state) -> panel HTML (pure). */
export function renderPresets(st) {
  const s = st || {};
  const list = Array.isArray(s.presets) ? s.presets : [];
  const sel = list.find((p) => p.id === s.selectedId) || null;
  const busy = !!s.busy;
  const dis = busy ? ' disabled' : '';
  let rows = '';
  for (const p of list) {
    const selected = p.id === s.selectedId;
    const id = esc(p.id);
    if (s.editingId === p.id) {
      rows += `<li class="zs-preset-row${selected ? ' zs-selected' : ''}" data-id="${id}">` +
        `<input type="text" class="zs-input" data-role="preset-rename" data-id="${id}" maxlength="${NAME_MAX}" value="${esc(s.renameDraft)}" aria-label="New preset name"> ` +
        `<button type="button" class="zh-btn" data-action="preset-rename-save" data-id="${id}" aria-label="Save preset name"${dis}>Save name</button> ` +
        `<button type="button" class="zh-btn" data-action="preset-rename-cancel" data-id="${id}" aria-label="Cancel rename">Cancel</button></li>`;
      continue;
    }
    rows += `<li class="zs-preset-row${selected ? ' zs-selected' : ''}" data-id="${id}"${selected ? ' aria-current="true"' : ''}>` +
      `<span class="zs-preset-name">${esc(p.name)}</span> ` +
      `<button type="button" class="zh-btn" data-action="preset-load" data-id="${id}" aria-label="Load preset ${esc(p.name)}"${dis}>Load</button> ` +
      `<button type="button" class="zh-btn" data-action="preset-rename" data-id="${id}" aria-label="Rename preset ${esc(p.name)}"${dis}>Rename</button> ` +
      `<button type="button" class="zh-btn" data-action="preset-delete" data-id="${id}" aria-label="Delete preset ${esc(p.name)}"${dis}>Delete</button></li>`;
  }
  return '<section class="zs-presets" aria-label="Presets">' +
    '<h4 class="zs-sub">Presets</h4>' +
    '<div class="zs-row">' +
      `<label class="zs-field" for="zs-preset-name">Preset name</label> <input type="text" id="zs-preset-name" class="zs-input" data-role="preset-name" maxlength="${NAME_MAX}" value="${esc(s.nameDraft)}" aria-label="Preset name"> ` +
      `<button type="button" class="zh-btn" data-action="preset-save-new" aria-label="Save as new preset"${dis}>Save as new</button> ` +
      `<button type="button" class="zh-btn" data-action="preset-save" aria-label="Save changes to the selected preset"${sel && !busy ? '' : ' disabled'}>Save</button>` +
    '</div>' +
    `<div class="zs-preset-msg" role="status" aria-live="polite">${s.message ? `<span>${esc(s.message)}</span>` : ''}</div>` +
    (list.length ? `<ul class="zs-preset-list">${rows}</ul>` : '<p class="zs-note">No presets yet. Set up the controls, name it and press Save as new.</p>') +
  '</section>';
}

function _cut(v, max) { return typeof v === 'string' && v ? v.slice(0, max) : null; }

function _device(d) {
  const o = d && typeof d === 'object' ? d : {};
  return { id: _cut(o.id, ID_MAX), label: _cut(o.label, LABEL_MAX) };
}

export function createPresetsPanel(host, opts = {}) {
  const doc = opts.document || host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub || {};
  const studio = opts.studio || {};
  const confirmFn = typeof opts.confirm === 'function' ? opts.confirm : () => false;
  const onApplied = typeof opts.onApplied === 'function' ? opts.onApplied : () => {};
  const root = doc.createElement('div');
  root.className = 'zs-presets-panel';
  host.appendChild(root);

  let st = { presets: [], selectedId: null, editingId: null, nameDraft: '', renameDraft: '', message: '', busy: false, restored: false, destroyed: false };

  function render() {
    if (st.destroyed) return;
    root.innerHTML = renderPresets(st);
  }

  function _payload(name) {
    const cur = (typeof studio.currentPreset === 'function' ? studio.currentPreset() : null) || {};
    return {
      name,
      camera: _device(cur.camera),
      mic: _device(cur.mic),
      effect: cur.effect,
      adjust: cur.adjust,
      overlays: Array.isArray(cur.overlays) ? cur.overlays : [],
    };
  }

  async function refresh() {
    const r = await _call(zoomHub, 'presetsList');
    if (st.destroyed) return r;
    if (r.ok) {
      st.presets = Array.isArray(r.presets) ? r.presets : [];
      if (st.selectedId && !st.presets.some((p) => p.id === st.selectedId)) st.selectedId = null;
      if (!st.selectedId && r.lastPresetId) st.selectedId = r.lastPresetId;
    } else if (r.code !== 'UNAVAILABLE') {
      st.message = errorMessage(r);
    }
    render();
    return r;
  }

  function _apply(p) {
    const r = typeof studio.applyPreset === 'function' ? studio.applyPreset(p) : { cameraFound: true, micFound: true };
    st.selectedId = p.id;
    st.message = loadMessage(r);
    try { onApplied(p); } catch (_) {}
    return r;
  }

  /** show() -- list presets; on the first show restore lastPresetId (never opens the camera). */
  async function show() {
    const r = await refresh();
    if (st.destroyed || st.restored) return;
    st.restored = true;
    const last = r && r.ok && r.lastPresetId ? st.presets.find((p) => p.id === r.lastPresetId) : null;
    if (last) { _apply(last); render(); }
  }

  async function _saveNew() {
    const name = String(st.nameDraft || '').trim();
    if (!name) { st.message = 'Enter a preset name first.'; render(); return; }
    st.busy = true; render();
    const r = await _call(zoomHub, 'presetSave', { preset: _payload(name) });
    st.busy = false;
    if (st.destroyed) return;
    if (!r.ok) { st.message = errorMessage(r); render(); return; }
    st.selectedId = r.preset && r.preset.id;
    st.nameDraft = '';
    if (st.selectedId) await _call(zoomHub, 'presetSelect', { id: st.selectedId });
    st.message = 'Preset saved.';
    await refresh();
  }

  async function _saveSelected() {
    const p = st.presets.find((x) => x.id === st.selectedId);
    if (!p) return;
    st.busy = true; render();
    const r = await _call(zoomHub, 'presetSave', { preset: Object.assign(_payload(p.name), { id: p.id }) });
    st.busy = false;
    if (st.destroyed) return;
    st.message = r.ok ? 'Preset updated.' : errorMessage(r);
    await refresh();
  }

  async function _load(id) {
    const p = st.presets.find((x) => x.id === id);
    if (!p) return;
    _apply(p);
    render();
    const r = await _call(zoomHub, 'presetSelect', { id });
    if (!r.ok && r.code !== 'UNAVAILABLE' && !st.destroyed) { st.message = errorMessage(r); render(); }
  }

  async function _renameSave(id) {
    const name = String(st.renameDraft || '').trim();
    const r = await _call(zoomHub, 'presetRename', { id, name });
    if (st.destroyed) return;
    if (!r.ok) { st.message = errorMessage(r); render(); return; }
    st.editingId = null;
    st.renameDraft = '';
    st.message = 'Preset renamed.';
    await refresh();
  }

  async function _delete(id) {
    const p = st.presets.find((x) => x.id === id);
    if (!p) return;
    if (!confirmFn('Delete preset "' + p.name + '"?')) return;
    const r = await _call(zoomHub, 'presetDelete', { id });
    if (st.destroyed) return;
    if (!r.ok) { st.message = errorMessage(r); render(); return; }
    if (st.selectedId === id) st.selectedId = null;
    st.message = 'Preset deleted.';
    await refresh();
  }

  function onClick(e) {
    const b = _actionTarget(e);
    if (!b || b.disabled) return;
    const a = b.dataset.action;
    const id = b.dataset.id;
    if (a === 'preset-save-new') _saveNew();
    else if (a === 'preset-save') _saveSelected();
    else if (a === 'preset-load') _load(id);
    else if (a === 'preset-rename') {
      const p = st.presets.find((x) => x.id === id);
      st.editingId = p ? id : null;
      st.renameDraft = p ? p.name : '';
      render();
    } else if (a === 'preset-rename-save') _renameSave(id);
    else if (a === 'preset-rename-cancel') { st.editingId = null; st.renameDraft = ''; render(); }
    else if (a === 'preset-delete') _delete(id);
  }

  function onInput(e) {
    const t = e && e.target;
    const role = t && t.dataset ? t.dataset.role : null;
    if (role === 'preset-name') st.nameDraft = String(t.value || '');
    else if (role === 'preset-rename') st.renameDraft = String(t.value || '');
  }

  function onKey(e) {
    const t = e && e.target;
    const role = t && t.dataset ? t.dataset.role : null;
    if (!e) return;
    if (e.key === 'Escape' && role === 'preset-rename') { st.editingId = null; st.renameDraft = ''; render(); return; }
    if (e.key !== 'Enter') return;
    if (role === 'preset-name') { onInput(e); _saveNew(); }
    else if (role === 'preset-rename') { onInput(e); _renameSave(t.dataset.id); }
  }

  root.addEventListener('click', onClick);
  root.addEventListener('input', onInput);
  root.addEventListener('keydown', onKey);
  render();

  function destroy() {
    if (st.destroyed) return;
    st.destroyed = true;
    try { root.removeEventListener('click', onClick); } catch (_) {}
    try { root.removeEventListener('input', onInput); } catch (_) {}
    try { root.removeEventListener('keydown', onKey); } catch (_) {}
    try { if (typeof root.remove === 'function') root.remove(); } catch (_) {}
  }

  return { root, show, refresh, render, destroy, _state: () => st };
}
