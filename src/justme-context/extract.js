'use strict';
// src/justme-context/extract.js — format router and the pure extraction helpers
// (design §8, §8.2, zip containers, HEIC pixel cap). Everything here except the
// pure detectType runs only inside the extraction worker (extract-worker.js);
// the main process never loads a parser library.
//
// extractBuffer never throws and never returns e.message: failures come back as
// { ok:false, reason:<REASONS key>, errCode } so nothing content-derived can be
// logged or shown.

const zlib = require('zlib');
const { LIMITS } = require('./constants');
const { errTag } = require('./log-safe');

// ───────────────────────── type detection ─────────────────────────

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'json', 'log', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cs', 'go', 'rb',
  'rs', 'kt', 'swift', 'php', 'c', 'cpp', 'h', 'sh', 'ps1', 'bat', 'sql', 'yaml', 'yml', 'xml', 'ini', 'cfg', 'toml',
  'conf', 'env', 'example']);
const HEIC_MAJOR = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);

function _ext(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function _u32(buf, o) { return buf.readUInt32LE(o); }

// Central-directory entry names of a ZIP (best effort, bounded). Returns null on anything odd.
function _zipEntries(buf) {
  const eocd = _findEocd(buf);
  if (eocd < 0 || eocd + 22 > buf.length) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count && i < LIMITS.ZIP_MAX_ENTRIES; i++) {
    if (p + 46 > buf.length || _u32(buf, p) !== 0x02014b50) return null;
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) return null;
    out.push({ name: buf.toString('latin1', p + 46, p + 46 + nameLen), localOffset: buf.readUInt32LE(p + 42), method: buf.readUInt16LE(p + 10), compSize: buf.readUInt32LE(p + 20) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function _findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

function _isobmffKind(buf) {
  if (buf.length < 16 || buf.toString('latin1', 4, 8) !== 'ftyp') return null;
  const major = buf.toString('latin1', 8, 12);
  const boxEnd = Math.min(buf.length, Math.max(16, buf.readUInt32BE(0)));
  const compat = [];
  for (let o = 16; o + 4 <= boxEnd; o += 4) compat.push(buf.toString('latin1', o, o + 4));
  if (major === 'avif' || major === 'avis') return 'avif';
  if (HEIC_MAJOR.has(major)) return 'heic';
  if (major === 'mif1' || major === 'msf1') {
    if (compat.includes('avif')) return 'avif';
    if (compat.includes('heic') || compat.includes('heix')) return 'heic';
  }
  return null;
}

/**
 * detectType(buf, name, mime) -> { kind, ext }
 * Magic bytes first, then the extension, then the Slack mimetype. Pure and cheap
 * (no parsing beyond ZIP entry names), so main may call it. kinds:
 * pdf docx pptx xlsx xls ods msg eml csv html text png jpg gif webp heic avif
 * and the unsupported ones: doc ppt zip cfb unknown.
 */
function detectType(buf, name, mime) {
  const ext = _ext(name);
  const m = String(mime || '').toLowerCase();
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const r = (kind) => ({ kind, ext });
  if (b.length >= 5 && b.indexOf('%PDF-') >= 0 && b.indexOf('%PDF-') < 1024) return r('pdf');
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return r('png');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return r('jpg');
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return r('gif');
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return r('webp');
  const iso = _isobmffKind(b);
  if (iso) return r(iso);
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) {
    const ents = _zipEntries(b);
    // Unreadable directory (ZIP64, truncated…): an Office extension still routes to
    // verifyZip, which rejects it with a fixed reason instead of "unsupported".
    if (!ents) return r({ docx: 'docx', xlsx: 'xlsx', xlsm: 'xlsx', pptx: 'pptx', ods: 'ods' }[ext] || 'zip');
    const names = new Set(ents.map((e) => e.name));
    if (names.has('word/document.xml')) return r('docx');
    if (names.has('xl/workbook.xml')) return r('xlsx');
    if (names.has('ppt/presentation.xml')) return r('pptx');
    if (names.has('mimetype') && names.has('content.xml')) {
      const e = ents.find((x) => x.name === 'mimetype');
      let mt = '';
      if (e && e.method === 0 && e.localOffset + 30 <= b.length) {
        const ds = e.localOffset + 30 + b.readUInt16LE(e.localOffset + 26) + b.readUInt16LE(e.localOffset + 28);
        mt = b.toString('latin1', ds, Math.min(b.length, ds + Math.min(e.compSize, 100)));
      }
      if (mt === 'application/vnd.oasis.opendocument.spreadsheet') return r('ods');
    }
    return r('zip');
  }
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    if (ext === 'xls' || m === 'application/vnd.ms-excel') return r('xls');
    if (ext === 'msg' || m === 'application/vnd.ms-outlook') return r('msg');
    if (ext === 'doc') return r('doc');
    if (ext === 'ppt') return r('ppt');
    return r('cfb');
  }
  // No recognised magic: text-like kinds by extension, then by mimetype.
  if (ext === 'html' || ext === 'htm' || m === 'text/html') return r('html');
  if (ext === 'csv' || ext === 'tsv' || m === 'text/csv' || m === 'text/tab-separated-values') return r('csv');
  if (ext === 'eml' || m === 'message/rfc822') return r('eml');
  if (TEXT_EXTS.has(ext) || m.startsWith('text/') || m === 'application/json') return r('text');
  return r('unknown');
}

// ───────────────────────── ZIP verification ─────────────────────────

class ZipRejected extends Error {
  constructor(rule) { super('zip rejected'); this.name = 'ZipRejected'; this.rule = rule; }
}

function _entryCap(name) {
  return /\.(xml|rels)$/i.test(name) ? LIMITS.ZIP_MAX_XML_ENTRY : LIMITS.ZIP_MAX_ENTRY;
}

/**
 * verifyZip(buf, kind) — the central directory sizes are attacker controlled, so
 * every entry is really inflated (and discarded) with a maxOutputLength before
 * any Office library sees the buffer. Returns { ok:true } or { ok:false, rule }
 * where rule is from a fixed enum (logged as `[jmctx] zip rejected <rule>`).
 */
function verifyZip(buf, kind, deps) {
  const z = (deps && deps.zlib) || zlib;
  try {
    _verifyZip(buf, z);
    return { ok: true };
  } catch (e) {
    return { ok: false, rule: e instanceof ZipRejected ? e.rule : 'corrupt' };
  }
}

function _verifyZip(buf, z) {
  const rej = (rule) => { throw new ZipRejected(rule); };
  const eocd = _findEocd(buf);
  if (eocd < 0) rej('eocd');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) rej('zip64');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) rej('zip64');
  if (count > LIMITS.ZIP_MAX_ENTRIES) rej('entries');
  let p = cdOffset;
  const seen = new Set();
  const entries = [];
  let declaredTotal = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) rej('directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) rej('zip64');
    if (p + 46 + nameLen > buf.length) rej('directory');
    const name = buf.toString('latin1', p + 46, p + 46 + nameLen);
    if (seen.has(name)) rej('duplicate');
    seen.add(name);
    if (flags & 1) rej('encrypted');
    if (method !== 0 && method !== 8) rej('method');
    if (size > _entryCap(name)) rej('entry-size');
    declaredTotal += size;
    if (declaredTotal > LIMITS.ZIP_MAX_TOTAL) rej('total-size');
    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  let total = 0;
  for (const e of entries) {
    const lo = e.localOffset;
    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) rej('local-header');
    const lnLen = buf.readUInt16LE(lo + 26), leLen = buf.readUInt16LE(lo + 28);
    if (buf.readUInt16LE(lo + 8) !== e.method) rej('local-header');
    if (lo + 30 + lnLen > buf.length || buf.toString('latin1', lo + 30, lo + 30 + lnLen) !== e.name) rej('local-header');
    const ds = lo + 30 + lnLen + leLen;
    if (ds + e.compSize > buf.length) rej('local-header');
    const comp = buf.subarray(ds, ds + e.compSize);
    let out;
    if (e.method === 8) {
      try { out = z.inflateRawSync(comp, { maxOutputLength: Math.min(e.size, _entryCap(e.name)) + 1 }); }
      catch (_) { rej('inflate'); }
    } else out = comp;
    if (out.length !== e.size) rej('liar-header');
    total += out.length;
    if (total > LIMITS.ZIP_MAX_TOTAL) rej('total-size');
  }
}

// ───────────────────────── HEIC pixel cap ─────────────────────────

/**
 * heicDimensions(buf) -> largest width*height of any `ispe` box under
 * meta > iprp > ipco, or 0 when absent/malformed. Bounds-checked, at most
 * 10,000 boxes, no allocation proportional to attacker numbers.
 */
function heicDimensions(buf) {
  let boxes = 0;
  const readBox = (o, end) => {
    if (++boxes > 10000 || o + 8 > end) return null;
    let size = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) return null;
      const big = buf.readBigUInt64BE(o + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(big); hdr = 16;
    } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return null;
    return { type, start: o, hdr, size, end: o + size };
  };
  const children = (from, to, visit) => {
    let o = from;
    while (o < to) {
      const bx = readBox(o, to);
      if (!bx) return false;
      if (visit(bx) === false) return false;
      o = bx.end;
    }
    return true;
  };
  let best = 0;
  let bad = false;
  const top = children(0, buf.length, (bx) => {
    if (bx.type !== 'meta') return true;
    const ok = children(bx.start + bx.hdr + 4, bx.end, (m) => {
      if (m.type !== 'iprp') return true;
      return children(m.start + m.hdr, m.end, (ip) => {
        if (ip.type !== 'ipco') return true;
        return children(ip.start + ip.hdr, ip.end, (sp) => {
          if (sp.type === 'ispe' && sp.start + sp.hdr + 12 <= sp.end) {
            const w = buf.readUInt32BE(sp.start + sp.hdr + 4), h = buf.readUInt32BE(sp.start + sp.hdr + 8);
            const px = w * h;
            if (px > best) best = px;
          }
          return true;
        });
      });
    });
    if (!ok) bad = true;
    return ok;
  });
  if (!top || bad) return 0;
  return best;
}

// ───────────────────────── text ─────────────────────────

/** Decode text bytes; null when the first 8 KB contains NUL (binary). */
function decodeText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.indexOf(0) >= 0 && !(head[0] === 0xff && head[1] === 0xfe) && !(head[0] === 0xfe && head[1] === 0xff)) return { binary: true };
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)) };
  else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)) };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b) }; } catch (_) { /* fall through */ }
  try { return { text: new TextDecoder('windows-1252').decode(b) }; } catch (_) { return { failed: true }; }
}

// ───────────────────────── htmlToText (linear scanner, §8.2) ─────────────────────────

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object']);
const BLOCK_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
  'header', 'footer', 'table', 'ul', 'ol', 'pre', 'blockquote']);
const ENTITY_RE = /&(#\d{1,7}|#x[0-9a-f]{1,6}|amp|lt|gt|quot|apos|nbsp);/gi;
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(ENTITY_RE, (_, e) => {
    const k = e.toLowerCase();
    if (NAMED[k] !== undefined) return NAMED[k];
    const cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    if (!(cp > 0 && cp <= 0x10ffff) || (cp >= 0xd800 && cp <= 0xdfff)) return ' ';
    return String.fromCodePoint(cp);
  });
}

// ASCII-only lowercase: always the same length as the input, so indexes stay aligned.
function _asciiLower(s) { return s.replace(/[A-Z]+/g, (m) => m.toLowerCase()); }

function htmlToText(html, maxChars) {
  const s = String(html || '');
  const cap = maxChars > 0 ? maxChars : LIMITS.RAW_TEXT_MAX_CHARS;
  const lower = _asciiLower(s);
  const out = [];
  let outLen = 0;
  let title = '';
  let desc = '';
  const push = (t) => { if (t) { out.push(t); outLen += t.length; } };
  let i = 0;
  const n = s.length;
  while (i < n && outLen <= cap * 4) {
    const lt = s.indexOf('<', i);
    if (lt === -1) { push(s.slice(i)); break; }
    push(s.slice(i, lt));
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    if (s[lt + 1] === '!' || s[lt + 1] === '?') {
      const g = s.indexOf('>', lt);
      if (g === -1) break;
      i = g + 1;
      continue;
    }
    let j = lt + 1;
    const closing = lower[j] === '/';
    if (closing) j++;
    const nameStart = j;
    while (j < n && j - nameStart < 32) {
      const c = lower.charCodeAt(j);
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++; else break;
    }
    const name = lower.slice(nameStart, j);
    if (!name) { push('<'); i = lt + 1; continue; }
    const gt = s.indexOf('>', lt);
    if (gt === -1) break;
    if (!closing && SKIP_TAGS.has(name)) {
      const close = lower.indexOf('</' + name, gt);
      if (close === -1) break;
      const cgt = s.indexOf('>', close);
      if (cgt === -1) break;
      i = cgt + 1;
      continue;
    }
    if (!closing && name === 'title' && !title) {
      const close = lower.indexOf('</title', gt);
      if (close !== -1) {
        title = s.slice(gt + 1, Math.min(close, gt + 1 + 500));
        const cgt = s.indexOf('>', close);
        if (cgt !== -1) { i = cgt + 1; continue; }     // the title is a prefix, not body text
      }
    } else if (!closing && name === 'meta' && !desc && gt - lt <= 2000) {
      const tag = lower.slice(lt, gt);
      if (/name\s*=\s*["']?description/.test(tag)) {
        const m = s.slice(lt, gt).match(/content\s*=\s*"([^"]{0,1000})"|content\s*=\s*'([^']{0,1000})'/i);
        if (m) desc = m[1] || m[2] || '';
      }
    }
    if (BLOCK_TAGS.has(name)) push('\n');
    i = gt + 1;
  }
  let text = decodeEntities(out.join(''));
  text = text.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const head = [title && decodeEntities(title).replace(/\s+/g, ' ').trim(), desc && decodeEntities(desc).replace(/\s+/g, ' ').trim()].filter(Boolean);
  if (head.length) text = head.join('\n') + (text ? '\n\n' + text : '');
  return text.length > cap ? text.slice(0, cap) : text;
}

// ───────────────────────── router ─────────────────────────

const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra || {});

function _result(kind, text, extra) {
  const cap = LIMITS.RAW_TEXT_MAX_CHARS;
  let t = String(text || '');
  let truncated = !!(extra && extra.truncated);
  if (t.length > cap) { t = t.slice(0, cap); truncated = true; }
  return Object.assign({ ok: true, kind, text: t, truncated }, extra || {}, { truncated });
}

/**
 * extractBuffer({ buffer, name, mimetype }, ctx, deps) -> worker-reply fields:
 * { ok, kind, text, truncated, reason?, errCode?, meta?, needsVision?, image? }
 * `reason` is a key of REASONS. ctx = { maxChars, cancelled? }.
 */
async function extractBuffer(job, ctx, deps) {
  deps = deps || {};
  ctx = ctx || {};
  const buf = Buffer.isBuffer(job.buffer) ? job.buffer : Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength);
  const det = detectType(buf, job.name, job.mimetype);
  const kind = det.kind;
  try {
    switch (kind) {
      case 'pdf': return await require('./extractors/pdf').extractPdf(buf, job, ctx, deps);
      case 'docx': case 'pptx': case 'xlsx': case 'ods': {
        const z = verifyZip(buf, kind, deps);
        if (!z.ok) return fail('ZIP_UNSAFE', { kind, errCode: 'zip_' + z.rule.replace(/[^a-z0-9]/g, '_') });
        const office = require('./extractors/office');
        if (kind === 'docx') return await office.extractDocx(buf, ctx, deps);
        if (kind === 'pptx') return await office.extractPptx(buf, ctx, deps);
        return await office.extractSheet(buf, kind, ctx, deps);
      }
      case 'xls': return await require('./extractors/office').extractSheet(buf, kind, ctx, deps);
      case 'eml': return await require('./extractors/mail').extractEml(buf, ctx, deps);
      case 'msg': return await require('./extractors/mail').extractMsg(buf, ctx, deps);
      case 'heic': return await require('./extractors/image').prepareImage(buf, kind, job, ctx, deps);
      case 'png': case 'jpg': case 'gif': case 'webp':
        return await require('./extractors/image').prepareImage(buf, kind, job, ctx, deps);
      case 'avif': return fail('AVIF_UNSUPPORTED', { kind });
      case 'html': {
        const d = decodeText(buf);
        if (d.binary) return fail('TEXT_BINARY', { kind });
        if (d.failed) return fail('TEXT_DECODE', { kind });
        const t = htmlToText(d.text, ctx.maxChars);
        return t ? _result(kind, t) : fail('HTML_EMPTY', { kind });
      }
      case 'csv': case 'text': {
        const d = decodeText(buf);
        if (d.binary) return fail('TEXT_BINARY', { kind });
        if (d.failed) return fail('TEXT_DECODE', { kind });
        return d.text.trim() ? _result(kind, d.text) : fail('EMPTY', { kind });
      }
      default:
        return fail('UNSUPPORTED', { kind });
    }
  } catch (e) {
    return fail('PARSE_FAILED', { kind, errCode: errTag(e) });
  }
}

module.exports = {
  detectType, verifyZip, htmlToText, heicDimensions, decodeText, decodeEntities, extractBuffer, _result, fail,
};
