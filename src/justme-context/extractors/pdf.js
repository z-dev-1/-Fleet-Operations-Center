'use strict';
// extractors/pdf.js — worker only. pdfjs-dist text layer (design §8 "PDF", "PDF loading").
// pdfjs is ESM-only, so it is loaded with import() from CJS and cached for the
// worker's life. A failed import is cached too and routes the PDF to the vision
// reader with PDFJS_UNAVAILABLE (round-3 fix 13); the worker itself never logs.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { LIMITS } = require('../constants');
const { errTag } = require('../log-safe');

let _pdfjsPromise = null;

function _defaultImport() {
  return import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
    try {
      const workerUrl = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
      if (mod.GlobalWorkerOptions && !mod.GlobalWorkerOptions.workerSrc) mod.GlobalWorkerOptions.workerSrc = workerUrl;
    } catch (_) { /* pdfjs falls back to its own default */ }
    return mod;
  });
}

function loadPdfjs(deps) {
  if (deps && deps.importPdfjs) return deps.importPdfjs();   // injected (tests): never cached
  if (!_pdfjsPromise) _pdfjsPromise = _defaultImport();
  return _pdfjsPromise;
}

function _pdfjsRoot() { return path.dirname(require.resolve('pdfjs-dist/package.json')); }
function _dirUrl(root, sub) { return path.join(root, sub).replace(/\\/g, '/') + '/'; }

// pdfjs decides "am I in Node?" with a check that is FALSE inside an Electron
// utilityProcess (process.type === 'utility'), and would then fetch() CMaps and
// fonts by URL, which fails for filesystem paths. This duck-typed factory (same
// interface as pdfjs' BinaryDataFactory) reads them from disk in both runtimes.
// File names come from the PDF (CMap names), so anything that is not a plain
// file name is refused.
class FsBinaryDataFactory {
  constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null }) {
    this.cMapUrl = cMapUrl;
    this.standardFontDataUrl = standardFontDataUrl;
    this.wasmUrl = wasmUrl;
  }
  async fetch({ kind, filename }) {
    if (kind !== 'cMapUrl' && kind !== 'standardFontDataUrl' && kind !== 'wasmUrl') throw new Error('unsupported data kind');
    const base = this[kind];
    if (!base) throw new Error('missing data path');
    if (typeof filename !== 'string' || !/^[A-Za-z0-9._+-]{1,128}$/.test(filename) || filename.includes('..')) throw new Error('bad data file name');
    return new Uint8Array(await fs.promises.readFile(base + filename));
  }
}

async function extractPdf(buf, job, ctx, deps) {
  const maxChars = (ctx && ctx.maxChars) || LIMITS.RAW_TEXT_MAX_CHARS;
  const image = () => ({ name: _pdfName(job), mimetype: 'application/pdf', buffer: buf });
  let pdfjs;
  try { pdfjs = await loadPdfjs(deps); }
  catch (e) {
    return { ok: true, kind: 'pdf', text: '', truncated: false, needsVision: true, reason: 'PDFJS_UNAVAILABLE', errCode: errTag(e), image: image() };
  }
  const root = _pdfjsRoot();
  let doc;
  try {
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),                // copy: pdfjs detaches the array it is given
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
      // pdfjs 6.4.299 insists on a trailing "/" (a Windows "\" separator is rejected with
      // "Invalid factory url … must include trailing slash"), so use forward slashes.
      cMapUrl: _dirUrl(root, 'cmaps'),
      cMapPacked: true,
      standardFontDataUrl: _dirUrl(root, 'standard_fonts'),
      wasmUrl: _dirUrl(root, 'wasm'),
      BinaryDataFactory: FsBinaryDataFactory,
      useWorkerFetch: false,
    });
    doc = await task.promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') return { ok: false, kind: 'pdf', reason: 'PDF_PASSWORD', errCode: 'PasswordException' };
    return { ok: false, kind: 'pdf', reason: 'PDF_FAILED', errCode: errTag(e) };
  }
  try {
    const total = doc.numPages;
    const pages = Math.min(total, LIMITS.PDF_MAX_PAGES);
    const parts = [];
    let len = 0;
    let truncated = total > pages;
    for (let p = 1; p <= pages; p++) {
      if (ctx && ctx.cancelled) break;
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '';
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        line += it.str;
        line += it.hasEOL ? '\n' : ' ';
      }
      if (typeof page.cleanup === 'function') page.cleanup();
      line = line.replace(/[ \t]+\n/g, '\n').trim();
      if (line) { parts.push(line); len += line.length + 2; }
      if (len > maxChars) { truncated = true; break; }
    }
    let text = parts.join('\n\n');
    if (text.length > maxChars) { text = text.slice(0, maxChars); truncated = true; }
    const meta = { pages: total };
    if (text.replace(/\s+/g, '').length < LIMITS.PDF_SCANNED_MIN_CHARS) {
      return { ok: true, kind: 'pdf', text, truncated: false, meta, needsVision: true, reason: 'SCANNED_PDF_UNAVAILABLE', image: image() };
    }
    return { ok: true, kind: 'pdf', text, truncated, meta };
  } catch (e) {
    return { ok: false, kind: 'pdf', reason: 'PDF_FAILED', errCode: errTag(e) };
  } finally {
    try { await doc.destroy(); } catch (_) { /* ignore */ }
  }
}

function _pdfName(job) {
  const n = String((job && job.name) || 'document.pdf');
  return /\.pdf$/i.test(n) ? n : n + '.pdf';
}

module.exports = { extractPdf };
