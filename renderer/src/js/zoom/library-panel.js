/**
 * zoom/library-panel.js -- Studio image library (design §15.3, FEAT-B2). Mounted by studio-panel.js
 * into div.zs-presets-host, after the presets panel.
 *
 * createLibraryPanel(host, {zoomHub, document, studio, confirm, onChange}) -> {show, refresh, render, destroy, _state}
 *   studio = {currentPreset(), assignImage(slot, id) -> {ok, message?}, clearImage(slot, index),
 *             updateOverlay(index, patch), forgetImage(id)}
 *
 * Thumbnail grid with a kind filter, Import (main opens the dialog), rename in place, delete with
 * confirm (IN_USE -> "Used by N presets — delete anyway?" -> force). Images go onto the Background /
 * Overlay / Avatar slots by drag and drop, or through the equivalent "Use as…" select for keyboard
 * users. WebP items have no main-side thumbnail (nativeImage can't decode WebP): the panel draws the
 * image from libraryRead into a 160-px canvas and keeps the data URL in an in-memory Map, cleared on
 * destroy. An image that can't be decoded shows a broken-thumbnail placeholder with Delete.
 */
import { esc, codeMessage } from './data-logic.js';
import { RANGES, MAX_OVERLAYS } from './studio-logic.js';

export const SLOTS = Object.freeze(['background', 'overlay', 'avatar']);
export const SLOT_LABELS = Object.freeze({ background: 'Background', overlay: 'Overlay', avatar: 'Avatar' });
export const KIND_LABELS = Object.freeze({ all: 'All images', background: 'Backgrounds', overlay: 'Overlays', avatar: 'Avatars' });
export const BROKEN_THUMB = "Can't show this image";
export const THUMB_W = 160;

const LIB_ID_RE = /^l_[0-9a-f]{12}$/;

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

/** inUseMessage(n) -> the force-delete confirm text. */
export function inUseMessage(n) {
  const k = Number.isInteger(n) && n > 0 ? n : 1;
  return `Used by ${k} presets — delete anyway?`;
}

/** importMessage(r) -> the status line after an import (rejected names are display-only). */
export function importMessage(r) {
  const added = r && Array.isArray(r.items) ? r.items.length : 0;
  const rej = r && Array.isArray(r.rejected) ? r.rejected : [];
  let s = added === 1 ? 'Imported 1 image.' : `Imported ${added} images.`;
  if (rej.length) s += ' Not imported: ' + rej.map((x) => `${String(x.name || 'file')} (${codeMessage(x.code)})`).join('; ');
  return s;
}

function _thumbHtml(item, cache, broken) {
  const name = esc(item.name);
  const cached = cache.get(item.id);
  const src = item.thumb || (typeof cached === 'string' && cached !== 'broken' ? cached : null);
  if (broken.has(item.id) || cached === 'broken') {
    return `<div class="zs-lib-broken" role="img" aria-label="${esc(BROKEN_THUMB)}: ${name}">${esc(BROKEN_THUMB)}</div>`;
  }
  if (!src) return `<div class="zs-lib-loading" role="img" aria-label="Loading ${name}">…</div>`;
  return `<img class="zs-lib-thumb" data-thumb-id="${esc(item.id)}" src="${esc(src)}" alt="${name}" width="${THUMB_W}">`;
}

function _slider(i, key, label, value) {
  const r = RANGES[key];
  return `<label class="zs-slider">${esc(label)} <input type="range" data-role="lib-overlay" data-index="${i}" data-key="${key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${esc(value)}" aria-label="Overlay ${i + 1} ${esc(label)}"></label>`;
}

/** renderSlots(current, byId) -> the Background / Overlay / Avatar drop targets (pure). */
export function renderSlots(cur, byId) {
  const c = cur || {};
  const e = c.effect || {};
  const nameOf = (id) => {
    const it = id && byId ? byId.get(id) : null;
    return it ? esc(it.name) : (id ? 'Missing image' : 'None');
  };
  const bg = e.chromaKey && e.chromaKey.backgroundId;
  const av = e.imageId;
  const ov = Array.isArray(c.overlays) ? c.overlays : [];
  const clear = (slot, has, i) => (has ? ` <button type="button" class="zh-btn" data-action="lib-clear" data-slot="${slot}"${i === undefined ? '' : ` data-index="${i}"`} aria-label="Clear ${SLOT_LABELS[slot]}${i === undefined ? '' : ' ' + (i + 1)}">Clear</button>` : '');
  let overlays = '';
  ov.forEach((o, i) => {
    overlays += `<li class="zs-ov">${nameOf(o.imageId)}${clear('overlay', true, i)}<div class="zs-row">` +
      _slider(i, 'x', 'Left–right', o.x) + _slider(i, 'y', 'Up–down', o.y) +
      _slider(i, 'scale', 'Size', o.scale) + _slider(i, 'opacity', 'Opacity', o.opacity) + '</div></li>';
  });
  return '<div class="zs-slots">' +
    `<div class="zs-slot" data-slot="background" aria-label="Background slot: drop an image here">${SLOT_LABELS.background}: ${nameOf(bg)}${clear('background', !!bg)}` +
      '<p class="zs-note">Used by Green-screen replace.</p></div>' +
    `<div class="zs-slot" data-slot="overlay" aria-label="Overlay slot: drop an image here">${SLOT_LABELS.overlay}s (${ov.length} of ${MAX_OVERLAYS})` +
      (ov.length ? `<ul class="zs-ov-list">${overlays}</ul>` : ': None') + '</div>' +
    `<div class="zs-slot" data-slot="avatar" aria-label="Avatar slot: drop an image here">${SLOT_LABELS.avatar}: ${nameOf(av)}${clear('avatar', !!av)}` +
      '<p class="zs-note">Used by Full-frame image (camera stays off).</p></div>' +
  '</div>';
}

/** renderLibrary(state, cache, broken, current) -> panel HTML (pure). */
export function renderLibrary(st, cache, broken, cur) {
  const s = st || {};
  const items = Array.isArray(s.items) ? s.items : [];
  const filter = s.filter || 'all';
  const shown = filter === 'all' ? items : items.filter((it) => it.kind === filter);
  const byId = new Map(items.map((it) => [it.id, it]));
  const dis = s.busy ? ' disabled' : '';
  const filterOpts = Object.keys(KIND_LABELS).map((k) => `<option value="${k}"${k === filter ? ' selected' : ''}>${esc(KIND_LABELS[k])}</option>`).join('');
  const kindOpts = SLOTS.map((k) => `<option value="${k}"${k === s.importKind ? ' selected' : ''}>${esc(SLOT_LABELS[k])}</option>`).join('');
  let grid = '';
  for (const it of shown) {
    const id = esc(it.id);
    const name = esc(it.name);
    const nameHtml = s.editingId === it.id
      ? `<input type="text" class="zs-input" data-role="lib-rename" data-id="${id}" maxlength="60" value="${esc(s.renameDraft)}" aria-label="New image name"> ` +
        `<button type="button" class="zh-btn" data-action="lib-rename-save" data-id="${id}" aria-label="Save image name">Save name</button> ` +
        `<button type="button" class="zh-btn" data-action="lib-rename-cancel" data-id="${id}" aria-label="Cancel rename">Cancel</button>`
      : `<span class="zs-lib-name">${name}</span> <button type="button" class="zh-btn" data-action="lib-rename" data-id="${id}" aria-label="Rename image ${name}">Rename</button>`;
    const useOpts = '<option value="">Use as…</option>' + SLOTS.map((k) => `<option value="${k}">${esc(SLOT_LABELS[k])}</option>`).join('');
    grid += `<li class="zs-lib-item" draggable="true" data-id="${id}" data-kind="${esc(it.kind)}">` +
      _thumbHtml(it, cache || new Map(), broken || new Set()) +
      `<div class="zs-lib-meta">${nameHtml}</div>` +
      `<div class="zs-row"><select class="zs-select" data-role="lib-assign" data-id="${id}" aria-label="Use image ${name} as">${useOpts}</select> ` +
      `<button type="button" class="zh-btn" data-action="lib-delete" data-id="${id}" aria-label="Delete image ${name}">Delete</button></div></li>`;
  }
  return '<section class="zs-library" aria-label="Image library">' +
    '<h4 class="zs-sub">Library</h4>' +
    '<div class="zs-row">' +
      `<label class="zs-field" for="zs-lib-filter">Show</label> <select id="zs-lib-filter" class="zs-select" data-role="lib-filter" aria-label="Filter images by kind">${filterOpts}</select> ` +
      `<label class="zs-field" for="zs-lib-kind">Import as</label> <select id="zs-lib-kind" class="zs-select" data-role="lib-import-kind" aria-label="Kind for imported images">${kindOpts}</select> ` +
      `<button type="button" class="zh-btn" data-action="lib-import" aria-label="Import images"${dis}>Import images…</button>` +
    '</div>' +
    `<div class="zs-lib-msg" role="status" aria-live="polite">${s.message ? `<span>${esc(s.message)}</span>` : ''}</div>` +
    renderSlots(cur, byId) +
    (shown.length ? `<ul class="zs-lib-grid">${grid}</ul>` : '<p class="zs-note">No images yet. Import PNG, JPEG or WebP files (up to 10 at a time).</p>') +
  '</section>';
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

export function createLibraryPanel(host, opts = {}) {
  const doc = opts.document || host.ownerDocument || (typeof document !== 'undefined' ? document : null);
  const zoomHub = opts.zoomHub || {};
  const studio = opts.studio || {};
  const confirmFn = typeof opts.confirm === 'function' ? opts.confirm : () => false;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const root = doc.createElement('div');
  root.className = 'zs-library-panel';
  host.appendChild(root);

  const cache = new Map();     // id -> data URL drawn in a 160-px canvas | 'broken' (in memory only)
  const pending = new Set();
  const broken = new Set();
  let st = { items: [], filter: 'all', importKind: 'background', editingId: null, renameDraft: '', message: '', busy: false, destroyed: false };

  function _cur() {
    try { return typeof studio.currentPreset === 'function' ? studio.currentPreset() : null; } catch (_) { return null; }
  }

  function render() {
    if (st.destroyed) return;
    root.innerHTML = renderLibrary(st, cache, broken, _cur());
  }

  /** _drawThumb(item) -- libraryRead -> decode -> 160-px canvas -> data URL kept in memory. */
  async function _drawThumb(item) {
    if (cache.has(item.id) || pending.has(item.id)) return;
    pending.add(item.id);
    let out = 'broken';
    try {
      const r = await _call(zoomHub, 'libraryRead', { id: item.id });
      const url = r.ok && typeof r.dataUrl === 'string' && r.dataUrl.startsWith('data:image/') ? r.dataUrl : null;
      const img = url ? await _decode(doc, url) : null;
      const w0 = img ? (img.naturalWidth || img.width || 0) : 0;
      const h0 = img ? (img.naturalHeight || img.height || 0) : 0;
      if (img && w0 > 0 && h0 > 0) {
        const c = doc.createElement('canvas');
        c.width = THUMB_W;
        c.height = Math.max(1, Math.round(THUMB_W * (h0 / w0)));
        const ctx = typeof c.getContext === 'function' ? c.getContext('2d') : null;
        if (ctx) {
          ctx.drawImage(img, 0, 0, c.width, c.height);
          const d = typeof c.toDataURL === 'function' ? c.toDataURL('image/png') : null;
          if (typeof d === 'string' && d.startsWith('data:image/')) out = d;
        }
      }
    } catch (_) {
      out = 'broken';
    }
    pending.delete(item.id);
    if (st.destroyed) return;
    cache.set(item.id, out);
    render();
  }

  async function refresh() {
    const r = await _call(zoomHub, 'libraryList');
    if (st.destroyed) return r;
    if (r.ok) {
      st.items = Array.isArray(r.items) ? r.items : [];
      for (const it of st.items) if (!it.thumb && !broken.has(it.id)) _drawThumb(it);
    } else if (r.code !== 'UNAVAILABLE') {
      st.message = codeMessage(r.code);
    }
    render();
    return r;
  }

  async function _import() {
    st.busy = true; render();
    const r = await _call(zoomHub, 'libraryImport', { kind: st.importKind });
    st.busy = false;
    if (st.destroyed) return;
    if (!r.ok) { st.message = r.code === 'CANCELLED' ? '' : codeMessage(r.code); render(); return; }
    st.message = importMessage(r);
    await refresh();
  }

  async function _renameSave(id) {
    const name = String(st.renameDraft || '').trim();
    const r = await _call(zoomHub, 'libraryRename', { id, name });
    if (st.destroyed) return;
    if (!r.ok) { st.message = r.code === 'INVALID_INPUT' ? 'Image names are 1 to 60 characters.' : codeMessage(r.code); render(); return; }
    st.editingId = null;
    st.renameDraft = '';
    st.message = 'Image renamed.';
    await refresh();
  }

  async function _delete(id) {
    const it = st.items.find((x) => x.id === id);
    if (!it) return;
    if (!confirmFn('Delete image "' + it.name + '"?')) return;
    let r = await _call(zoomHub, 'libraryDelete', { id });
    if (st.destroyed) return;
    if (!r.ok && r.code === 'IN_USE') {
      if (!confirmFn(inUseMessage(r.usedBy))) return;
      r = await _call(zoomHub, 'libraryDelete', { id, force: true });
      if (st.destroyed) return;
    }
    if (!r.ok) { st.message = codeMessage(r.code); render(); return; }
    cache.delete(id);
    broken.delete(id);
    try { if (typeof studio.forgetImage === 'function') studio.forgetImage(id); } catch (_) {}
    st.message = 'Image deleted.';
    try { onChange({ op: 'delete', id }); } catch (_) {}
    await refresh();
  }

  function _assign(slot, id) {
    if (!SLOTS.includes(slot) || !LIB_ID_RE.test(String(id || '')) || !st.items.some((x) => x.id === id)) return;
    const r = typeof studio.assignImage === 'function' ? studio.assignImage(slot, id) : { ok: false };
    st.message = r && r.message ? r.message : (r && r.ok ? SLOT_LABELS[slot] + ' set.' : '');
    render();
  }

  function onClick(e) {
    const b = _actionTarget(e);
    if (!b || b.disabled) return;
    const a = b.dataset.action;
    const id = b.dataset.id;
    if (a === 'lib-import') _import();
    else if (a === 'lib-rename') {
      const it = st.items.find((x) => x.id === id);
      st.editingId = it ? id : null;
      st.renameDraft = it ? it.name : '';
      render();
    } else if (a === 'lib-rename-save') _renameSave(id);
    else if (a === 'lib-rename-cancel') { st.editingId = null; st.renameDraft = ''; render(); }
    else if (a === 'lib-delete') _delete(id);
    else if (a === 'lib-clear') {
      const i = b.dataset.index === undefined ? undefined : Number(b.dataset.index);
      try { if (typeof studio.clearImage === 'function') studio.clearImage(b.dataset.slot, i); } catch (_) {}
      render();
    }
  }

  function onChangeEvt(e) {
    const t = e && e.target;
    const role = t && t.dataset ? t.dataset.role : null;
    if (!role) return;
    const type = e.type;
    if (role === 'lib-rename') { st.renameDraft = String(t.value || ''); return; }
    if (role === 'lib-overlay') {
      const i = Number(t.dataset.index);
      const key = t.dataset.key;
      if (!Number.isInteger(i) || !['x', 'y', 'scale', 'opacity'].includes(key)) return;
      try { if (typeof studio.updateOverlay === 'function') studio.updateOverlay(i, { [key]: Number(t.value) }); } catch (_) {}
      return;   // no re-render while dragging a slider
    }
    if (type !== 'change') return;
    if (role === 'lib-filter') { st.filter = Object.prototype.hasOwnProperty.call(KIND_LABELS, t.value) ? t.value : 'all'; render(); }
    else if (role === 'lib-import-kind') { st.importKind = SLOTS.includes(t.value) ? t.value : 'background'; }
    else if (role === 'lib-assign') { const slot = t.value; t.value = ''; _assign(slot, t.dataset.id); }
  }

  function onKey(e) {
    const t = e && e.target;
    const role = t && t.dataset ? t.dataset.role : null;
    if (role !== 'lib-rename' || !e) return;
    if (e.key === 'Enter') { st.renameDraft = String(t.value || ''); _renameSave(t.dataset.id); }
    else if (e.key === 'Escape') { st.editingId = null; st.renameDraft = ''; render(); }
  }

  function _closest(e, sel) {
    const t = e && e.target;
    return t && typeof t.closest === 'function' ? t.closest(sel) : (t && t.dataset ? t : null);
  }

  function onDragStart(e) {
    const item = _closest(e, '[data-id]');
    const id = item && item.dataset ? item.dataset.id : null;
    if (!id || !e.dataTransfer) return;
    try { e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'copy'; } catch (_) {}
  }

  function onDragOver(e) {
    const slot = _closest(e, '[data-slot]');
    if (slot && typeof e.preventDefault === 'function') e.preventDefault();
  }

  function onDrop(e) {
    const slot = _closest(e, '[data-slot]');
    if (!slot || !slot.dataset) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    let id = '';
    try { id = e.dataTransfer ? String(e.dataTransfer.getData('text/plain') || '') : ''; } catch (_) { id = ''; }
    _assign(slot.dataset.slot, id);
  }

  // A thumbnail that fails to decode in the real DOM (error does not bubble: capture it).
  function onImgError(e) {
    const t = e && e.target;
    const id = t && t.dataset ? t.dataset.thumbId : null;
    if (!id || broken.has(id)) return;
    broken.add(id);
    render();
  }

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChangeEvt);
  root.addEventListener('input', onChangeEvt);
  root.addEventListener('keydown', onKey);
  root.addEventListener('dragstart', onDragStart);
  root.addEventListener('dragover', onDragOver);
  root.addEventListener('drop', onDrop);
  root.addEventListener('error', onImgError, true);
  render();

  function destroy() {
    if (st.destroyed) return;
    st.destroyed = true;
    for (const [t, fn] of [['click', onClick], ['change', onChangeEvt], ['input', onChangeEvt], ['keydown', onKey], ['dragstart', onDragStart], ['dragover', onDragOver], ['drop', onDrop]]) {
      try { root.removeEventListener(t, fn); } catch (_) {}
    }
    try { root.removeEventListener('error', onImgError, true); } catch (_) {}
    cache.clear();
    pending.clear();
    broken.clear();
    try { if (typeof root.remove === 'function') root.remove(); } catch (_) {}
  }

  return { root, show: refresh, refresh, render, destroy, cache, _state: () => st };
}
