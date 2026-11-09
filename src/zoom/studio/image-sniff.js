'use strict';
/**
 * src/zoom/studio/image-sniff.js — magic-byte sniffing and WebP dimensions (design §15.3, FEAT-B2). Pure.
 *
 *   sniff(buf)    -> 'png' | 'jpeg' | 'webp' | null
 *                    PNG 89 50 4E 47 0D 0A 1A 0A; JPEG FF D8 FF; WebP 'RIFF' at 0 and 'WEBP' at 8.
 *   webpSize(buf) -> {w, h} | null, parsed from the first chunk (Electron's nativeImage can't decode WebP):
 *                    'VP8 '  start code 9D 01 2A at 23; w = uint16le@26 & 0x3FFF, h = uint16le@28 & 0x3FFF
 *                    'VP8L'  signature 0x2F at 20; 14-bit (w-1), (h-1) from the 4 bytes at 21
 *                    'VP8X'  w-1 = uint24le@24, h-1 = uint24le@27
 *                    any other chunk, a short buffer or a zero dimension -> null
 *   typeForExt(ext) -> the sniff type a file extension must agree with ('png' | 'jpeg' | 'webp' | null)
 */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function _isBuf(b) { return !!b && typeof b.length === 'number' && typeof b[0] !== 'undefined'; }

function _ascii(b, at, s) {
  if (b.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function _u16(b, at) { return b[at] | (b[at + 1] << 8); }
function _u24(b, at) { return b[at] | (b[at + 1] << 8) | (b[at + 2] << 16); }

function sniff(buf) {
  if (!_isBuf(buf)) return null;
  if (buf.length >= 8 && PNG_SIG.every((v, i) => buf[i] === v)) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (_ascii(buf, 0, 'RIFF') && _ascii(buf, 8, 'WEBP')) return 'webp';
  return null;
}

function webpSize(buf) {
  if (!_isBuf(buf) || buf.length < 30 || sniff(buf) !== 'webp') return null;
  let w = 0;
  let h = 0;
  if (_ascii(buf, 12, 'VP8 ')) {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    w = _u16(buf, 26) & 0x3fff;
    h = _u16(buf, 28) & 0x3fff;
  } else if (_ascii(buf, 12, 'VP8L')) {
    if (buf[20] !== 0x2f) return null;
    const bits = (buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24)) >>> 0;
    w = (bits & 0x3fff) + 1;
    h = ((bits >>> 14) & 0x3fff) + 1;
  } else if (_ascii(buf, 12, 'VP8X')) {
    w = _u24(buf, 24) + 1;
    h = _u24(buf, 27) + 1;
  } else {
    return null;
  }
  if (!(w > 0) || !(h > 0)) return null;
  return { w, h };
}

function typeForExt(ext) {
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  if (e === 'png') return 'png';
  if (e === 'jpg' || e === 'jpeg') return 'jpeg';
  if (e === 'webp') return 'webp';
  return null;
}

const MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });

module.exports = { sniff, webpSize, typeForExt, MIME };
