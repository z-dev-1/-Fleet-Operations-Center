/**
 * zoom/studio-pipeline.js -- the Studio canvas preview loop (design §14.2, FEAT-B1).
 *
 * createPipeline({video, canvas, getImage, document, raf, caf, now}) ->
 *   {setPreset, setEffect, setAdjust, setOverlays, getState, start, stop, running, drawFrame,
 *    applyNativeBlur, warnings, fps, getOutputStream}
 *
 * Per frame: base (filter + mirror) -> edgeBlur | nativeBlur (camera-side, no canvas work) |
 * chromaKey | image (static library image, camera closed) -> overlays (<= 3) -> fps readout.
 * Images come from getImage(id) -> Promise<HTMLImageElement|null> (the panel decodes
 * zoomHub.libraryRead({id}) data URLs); each id is requested once and cached here. A missing image is
 * skipped and reported through warnings() / opts.onWarning.
 *
 * Preview only. Nothing leaves this canvas in v1.
 */
import {
  buildFilter, chromaKeyMask, vignetteStops, overlayRect, coverFit, outputSize, createFrameBudget,
  clampAdjust, normalizeEffect, normalizeOverlays, imageIdsOf, supportsNativeBlur, MISSING_IMAGE,
  NATIVE_BLUR_UNSUPPORTED,
} from './studio-logic.js';

export function createPipeline(opts = {}) {
  const video = opts.video || null;
  const canvas = opts.canvas || null;
  const getImage = typeof opts.getImage === 'function' ? opts.getImage : async () => null;
  const doc = opts.document || (canvas && canvas.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  const raf = opts.raf || (typeof requestAnimationFrame === 'function' ? (fn) => requestAnimationFrame(fn) : null);
  const caf = opts.caf || (typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : () => {});
  const now = opts.now || (() => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()));
  const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : () => {};
  const onFps = typeof opts.onFps === 'function' ? opts.onFps : () => {};

  let effect = normalizeEffect(null);
  let adjust = clampAdjust(null);
  let overlays = [];
  let running = false;
  let rafId = null;
  let fps = 0;
  let lastTs = null;
  let outStream = null;
  const budget = createFrameBudget();
  const images = new Map();          // id -> HTMLImageElement | null (missing) | 'pending'
  const missing = new Set();
  let sharp = null;                  // offscreen canvas for edgeBlur
  let work = null;                   // offscreen canvas for chromaKey

  function _offscreen() {
    return doc && typeof doc.createElement === 'function' ? doc.createElement('canvas') : null;
  }

  function _want() {
    for (const id of imageIdsOf(effect, overlays)) {
      if (images.has(id)) continue;
      images.set(id, 'pending');
      Promise.resolve().then(() => getImage(id)).then((img) => {
        images.set(id, img || null);
        if (!img) { missing.add(id); try { onWarning({ id, warning: MISSING_IMAGE }); } catch (_) {} }
        else missing.delete(id);
      }, () => {
        images.set(id, null);
        missing.add(id);
        try { onWarning({ id, warning: MISSING_IMAGE }); } catch (_) {}
      });
    }
  }

  function _img(id) {
    const v = id ? images.get(id) : null;
    return v && v !== 'pending' ? v : null;
  }

  function _dims(img) {
    return { w: img.naturalWidth || img.width || 0, h: img.naturalHeight || img.height || 0 };
  }

  /** setPreset(p) -- apply {effect, adjust, overlays} of a §15.1 preset (camera/mic are the panel's). */
  function setPreset(p) {
    const o = p && typeof p === 'object' ? p : {};
    effect = normalizeEffect(o.effect);
    adjust = clampAdjust(o.adjust);
    overlays = normalizeOverlays(o.overlays);
    _want();
  }

  function setEffect(patch) {
    const p = patch && typeof patch === 'object' ? patch : {};
    effect = normalizeEffect({
      mode: p.mode !== undefined ? p.mode : effect.mode,
      edgeBlur: Object.assign({}, effect.edgeBlur, p.edgeBlur || {}),
      chromaKey: Object.assign({}, effect.chromaKey, p.chromaKey || {}),
      imageId: p.imageId !== undefined ? p.imageId : effect.imageId,
    });
    _want();
  }

  function setAdjust(patch) { adjust = clampAdjust(Object.assign({}, adjust, patch || {})); }

  function setOverlays(list) { overlays = normalizeOverlays(list); _want(); }

  function getState() {
    const e = { mode: effect.mode, edgeBlur: Object.assign({}, effect.edgeBlur), chromaKey: Object.assign({}, effect.chromaKey), imageId: effect.imageId };
    return { effect: e, adjust: Object.assign({}, adjust), overlays: overlays.map((o) => Object.assign({}, o)) };
  }

  function _ctx(c) {
    try { return c && typeof c.getContext === 'function' ? c.getContext('2d') : null; } catch (_) { return null; }
  }

  function _size(c, w, h) {
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
  }

  function _drawBase(ctx, filter, w, h) {
    ctx.save();
    ctx.filter = filter;
    if (adjust.mirror) ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();
  }

  function _drawCover(ctx, img, w, h) {
    const d = _dims(img);
    const r = coverFit(d.w, d.h, w, h);
    if (r) ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, w, h);
  }

  function _black(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  function _edgeBlur(ctx, w, h) {
    _drawBase(ctx, buildFilter(adjust, effect.edgeBlur.radiusPx), w, h);
    if (!sharp) sharp = _offscreen();
    const sctx = _ctx(sharp);
    if (!sctx) return;
    _size(sharp, w, h);
    sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, w, h);
    _drawBase(sctx, buildFilter(adjust), w, h);
    const r = Math.min(w, h) / 2;
    const g = sctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, r);
    for (const s of vignetteStops(effect.edgeBlur.focus)) g.addColorStop(s.offset, `rgba(0,0,0,${s.alpha})`);
    sctx.globalCompositeOperation = 'destination-in';
    sctx.fillStyle = g;
    sctx.fillRect(0, 0, w, h);
    sctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(sharp, 0, 0);
  }

  function _chroma(ctx, w, h) {
    if (!work) work = _offscreen();
    const wctx = _ctx(work);
    if (!wctx) { _drawBase(ctx, buildFilter(adjust), w, h); return; }
    const ww = Math.min(budget.workWidth, w);
    const wh = Math.max(1, Math.round(h * (ww / w)));
    _size(work, ww, wh);
    wctx.clearRect(0, 0, ww, wh);
    _drawBase(wctx, buildFilter(adjust), ww, wh);
    const data = wctx.getImageData(0, 0, ww, wh);
    chromaKeyMask(data.data, effect.chromaKey.color, effect.chromaKey.tolerance);
    wctx.putImageData(data, 0, 0);
    const bg = _img(effect.chromaKey.backgroundId);
    if (bg) _drawCover(ctx, bg, w, h); else _black(ctx, w, h);
    ctx.drawImage(work, 0, 0, ww, wh, 0, 0, w, h);
  }

  function _overlays(ctx, w, h) {
    for (const o of overlays.slice(0, 3)) {
      const img = _img(o.imageId);
      if (!img) continue;
      const d = _dims(img);
      const r = overlayRect(o, d.w, d.h, w, h);
      if (!r) continue;
      ctx.save();
      ctx.globalAlpha = o.opacity;
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  }

  function _fpsReadout(ctx, w) {
    const label = `${Math.round(fps)} fps`;
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(w - 58, 4, 54, 18);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, w - 52, 17);
    ctx.restore();
  }

  /** drawFrame() -- draw one frame (exported for tests; the rAF loop calls it). */
  function drawFrame() {
    const ctx = _ctx(canvas);
    if (!ctx) return false;
    const t0 = now();
    if (lastTs !== null) {
      const dt = t0 - lastTs;
      if (dt > 0) fps = fps ? fps + 0.1 * (1000 / dt - fps) : 1000 / dt;
    }
    lastTs = t0;
    let w; let h;
    if (effect.mode === 'image') {
      ({ w, h } = outputSize(0, 0));
      _size(canvas, w, h);
      const img = _img(effect.imageId);
      if (img) _drawCover(ctx, img, w, h); else _black(ctx, w, h);
    } else {
      if (!video || !(video.readyState >= 2) || !(video.videoWidth > 0)) return false;
      ({ w, h } = outputSize(video.videoWidth, video.videoHeight));
      _size(canvas, w, h);
      ctx.clearRect(0, 0, w, h);
      if (effect.mode === 'edgeBlur') _edgeBlur(ctx, w, h);
      else if (effect.mode === 'chromaKey') _chroma(ctx, w, h);
      else _drawBase(ctx, buildFilter(adjust), w, h);   // none, nativeBlur (blur happens in the camera)
    }
    _overlays(ctx, w, h);
    _fpsReadout(ctx, w);
    if (effect.mode === 'chromaKey') budget.record(now() - t0);
    try { onFps(Math.round(fps)); } catch (_) {}
    return true;
  }

  function _tick() {
    rafId = null;
    if (!running) return;
    const hidden = !!(doc && doc.hidden);
    if (!hidden) {
      try { drawFrame(); } catch (e) { try { console.warn('[zoom-studio]', e && e.name); } catch (_) {} }
    } else {
      lastTs = null;   // paused while the document is hidden
    }
    if (running && raf) rafId = raf(_tick);
  }

  function start() {
    if (running) return;
    running = true;
    lastTs = null;
    fps = 0;
    _want();
    if (raf) rafId = raf(_tick);
  }

  function stop() {
    running = false;
    if (rafId !== null) { try { caf(rafId); } catch (_) {} }
    rafId = null;
    lastTs = null;
  }

  /**
   * applyNativeBlur(on) -- camera-native background blur through track constraints (no canvas work).
   * Unsupported or rejected -> {ok:false, message} and the effect reverts to 'none'.
   */
  async function applyNativeBlur(on) {
    const track = video && video.srcObject && typeof video.srcObject.getVideoTracks === 'function' ? video.srcObject.getVideoTracks()[0] : null;
    let caps = null;
    try { caps = track && typeof track.getCapabilities === 'function' ? track.getCapabilities() : null; } catch (_) { caps = null; }
    if (!on) {
      if (track && supportsNativeBlur(caps)) { try { await track.applyConstraints({ backgroundBlur: false }); } catch (_) {} }
      return { ok: true };
    }
    if (!track || !supportsNativeBlur(caps)) { setEffect({ mode: 'none' }); return { ok: false, message: NATIVE_BLUR_UNSUPPORTED }; }
    try {
      await track.applyConstraints({ backgroundBlur: true });
      return { ok: true };
    } catch (e) {
      try { console.warn('[zoom-studio]', e && e.name); } catch (_) {}
      setEffect({ mode: 'none' });
      return { ok: false, message: NATIVE_BLUR_UNSUPPORTED };
    }
  }

  /**
   * getOutputStream() -- lazily returns canvas.captureStream(30).
   * NOT called anywhere in v1. It is the documented integration hook for follow-ups F-3 (OBS window
   * capture of a Fleet output window) and F-4 (an IT-installed virtual camera), design §16.
   */
  function getOutputStream() {
    if (!outStream && canvas && typeof canvas.captureStream === 'function') outStream = canvas.captureStream(30);
    return outStream;
  }

  return {
    setPreset, setEffect, setAdjust, setOverlays, getState, start, stop, drawFrame, applyNativeBlur,
    getOutputStream,
    get running() { return running; },
    get fps() { return Math.round(fps); },
    warnings: () => [...missing],
    budget,
  };
}
