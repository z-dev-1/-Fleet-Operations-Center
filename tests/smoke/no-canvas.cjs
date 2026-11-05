'use strict';
// tests/smoke/no-canvas.cjs — SMOKE ONLY (preloaded with --require by justme-libs-main.cjs).
// Makes require('@napi-rs/canvas') throw, to prove PDF text extraction works without the
// optional native canvas (round-3 fix 13). The production worker has no such hook.
// JMCTX_NO_CANVAS_MARKER (a file path) records that the hook loaded and whether canvas
// was ever requested.
const Module = require('module');
const fs = require('fs');

const marker = process.env.JMCTX_NO_CANVAS_MARKER;
const mark = (s) => { if (marker) { try { fs.appendFileSync(marker, s + '\n'); } catch (_) { /* ignore */ } } };
mark('loaded');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (typeof request === 'string' && request.startsWith('@napi-rs/canvas')) {
    mark('blocked');
    throw Object.assign(new Error('blocked by no-canvas smoke'), { code: 'MODULE_NOT_FOUND' });
  }
  return origLoad.call(this, request, ...rest);
};
