'use strict';
// extractors/image.js — worker only. Images are never parsed here; the result
// tells main to run the vision step. HEIC is pixel-capped BEFORE decode (a 48 MP
// photo decodes to ~195 MB of RGBA), then converted to JPEG in memory.

const { LIMITS } = require('../constants');
const { errTag } = require('../log-safe');

const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function _base(name) { return String(name || 'image').replace(/\.[A-Za-z0-9]+$/, '') || 'image'; }

async function prepareImage(buf, kind, job, ctx, deps) {
  const { heicDimensions } = require('../extract');
  if (kind !== 'heic') {
    if (buf.length > LIMITS.MAX_BYTES.image) return { ok: false, kind, reason: 'TOO_LARGE' };
    return { ok: true, kind, text: '', truncated: false, needsVision: true, image: { name: String(job.name || 'image.' + kind), mimetype: MIME[kind], buffer: buf } };
  }
  const px = heicDimensions(buf);
  if (!px) return { ok: false, kind, reason: 'HEIC_FAILED' };
  if (px > LIMITS.HEIC_MAX_PIXELS) return { ok: false, kind, reason: 'HEIC_TOO_LARGE' };
  try {
    const heicConvert = (deps && deps.heicConvert) || require('heic-convert');
    const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.85 });
    const jpeg = Buffer.from(out);
    if (!jpeg.length || jpeg.length > LIMITS.IMAGE_REPLY_MAX_BYTES) return { ok: false, kind, reason: 'HEIC_FAILED' };
    return { ok: true, kind, text: '', truncated: false, needsVision: true, image: { name: _base(job.name) + '.jpg', mimetype: 'image/jpeg', buffer: jpeg } };
  } catch (e) {
    return { ok: false, kind, reason: 'HEIC_FAILED', errCode: errTag(e) };
  }
}

module.exports = { prepareImage };
