'use strict';
// src/justme-context/extract-host.js — main-process side of extraction (design §8.1).
// Spawns, reuses and kills the extraction worker, enforces the parse timer, the
// working-set cap and abort, validates every worker reply, and maps replies to
// items. It NEVER loads a parser library (those live in extract-worker.js only),
// and it never logs or returns e.message.
//
// Worker partition (round-3 fix 4): ONE fixed, non-persistent partition name.
// A random per-message name would leak an Electron Session per message.
// Worker env (fix 11): only what Windows child processes need; no tokens, no FLEET_*.

const os = require('os');
const path = require('path');
const { LIMITS, REASONS } = require('./constants');
const { errTag } = require('./log-safe');
const { detectType } = require('./extract');
const { visionRead } = require('./vision');

const WORKER_PARTITION = 'jmctx-extract';
const WORKER_FILE = path.join(__dirname, 'extract-worker.js');
const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
const META_KEYS = ['pages', 'sheets', 'slides'];

let _pdfjsLogged = false;

function _logger(deps) {
  if (deps && deps.logger) return deps.logger;
  return require('../utils/logger').createLogger('justme-context');
}

/** Minimal environment for the worker (fix 11). undefined values are dropped. */
function workerEnv(env) {
  const e = env || process.env;
  const raw = {
    NODE_ENV: e.NODE_ENV || 'production',
    SystemRoot: e.SystemRoot || e.SYSTEMROOT,
    windir: e.windir || e.WINDIR,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  const out = {};
  for (const k of Object.keys(raw)) if (raw[k] !== undefined) out[k] = raw[k];
  return out;
}

function _defaultSpawn(deps) {
  const electron = deps.electron || require('electron');
  return electron.utilityProcess.fork(WORKER_FILE, [], {
    serviceName: 'fleet-jmctx-extract',
    execArgv: ['--max-old-space-size=' + LIMITS.WORKER_MAX_HEAP_MB],
    stdio: 'ignore',
    partition: WORKER_PARTITION,
    env: workerEnv(),
  });
}

function _defaultGetChildRss(deps) {
  return (pid) => {
    try {
      const electron = deps.electron || require('electron');
      const m = electron.app.getAppMetrics().find((x) => x.pid === pid);
      return m && m.memory ? m.memory.workingSetSize * 1024 : undefined;   // KB -> bytes
    } catch (_) { return undefined; }
  };
}

const _failRes = (reason, extra) => Object.assign({ ok: false, text: '', truncated: false, reason }, extra || {});

// Validate one worker reply against the job id (design §16). Returns a clean
// object, or null when malformed.
function _validateReply(msg, id) {
  if (!msg || typeof msg !== 'object' || msg.id !== id || typeof msg.ok !== 'boolean' || typeof msg.text !== 'string') return null;
  const out = { ok: msg.ok, text: msg.text.length > LIMITS.RAW_TEXT_MAX_CHARS ? msg.text.slice(0, LIMITS.RAW_TEXT_MAX_CHARS) : msg.text, truncated: !!msg.truncated };
  out.kind = typeof msg.kind === 'string' && /^[a-z0-9]{1,20}$/.test(msg.kind) ? msg.kind : 'file';
  if (msg.reason !== undefined) out.reason = Object.prototype.hasOwnProperty.call(REASONS, msg.reason) ? msg.reason : 'PARSE_FAILED';
  else if (!msg.ok) out.reason = 'PARSE_FAILED';
  if (typeof msg.errCode === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(msg.errCode)) out.errCode = msg.errCode;
  if (msg.text.length > LIMITS.RAW_TEXT_MAX_CHARS) out.truncated = true;
  if (msg.meta && typeof msg.meta === 'object') {
    const meta = {};
    for (const k of META_KEYS) if (Number.isFinite(msg.meta[k])) meta[k] = msg.meta[k];
    if (typeof msg.meta.note === 'string' && Object.prototype.hasOwnProperty.call(REASONS, msg.meta.note)) meta.note = msg.meta.note;
    out.meta = meta;
  }
  if (msg.needsVision === true) out.needsVision = true;
  if (msg.image !== undefined) {
    const im = msg.image;
    if (!im || typeof im !== 'object' || !(im.buffer instanceof Uint8Array) || im.buffer.byteLength > LIMITS.IMAGE_REPLY_MAX_BYTES || !IMAGE_MIMES.has(im.mimetype) ||
      typeof im.name !== 'string' || im.name.length > 255) return null;
    out.image = { name: im.name, mimetype: im.mimetype, buffer: Buffer.from(im.buffer.buffer, im.buffer.byteOffset, im.buffer.byteLength) };
  }
  return out;
}

/**
 * createWorkerSession(deps) -> { extract(job, opts), close() }
 * deps: spawnWorker(file) (tests), electron, getChildRss(pid), logger, now, limits.
 * extract resolves (never rejects) with { ok, kind, text, truncated, reason?, errCode?, meta?, needsVision?, image? }.
 */
function createWorkerSession(deps) {
  deps = deps || {};
  const limits = Object.assign({}, LIMITS, deps.limits || {});
  const now = deps.now || Date.now;
  const getChildRss = deps.getChildRss || _defaultGetChildRss(deps);
  let child = null;
  let closed = false;
  let seq = 0;
  let spawnLogged = false;

  function ensureChild() {
    if (child) return child;
    const c = deps.spawnWorker ? deps.spawnWorker(WORKER_FILE) : _defaultSpawn(deps);
    if (!c) throw new Error('no worker');
    child = c;
    c.on('exit', () => { if (child === c) child = null; });
    if (typeof c.on === 'function') c.on('error', () => { if (child === c) child = null; });
    return c;
  }
  const post = (c, m) => (typeof c.postMessage === 'function' ? c.postMessage(m) : c.send(m));
  function killChild(c) { if (child === c) child = null; try { c.kill(); } catch (_) { /* already gone */ } }

  function extract(job, opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      if (closed) return resolve(_failRes('READER_UNAVAILABLE'));
      if (opts.signal && opts.signal.aborted) return resolve(_failRes('BUDGET'));
      let c;
      try { c = ensureChild(); }
      catch (e) {
        if (!spawnLogged) { spawnLogged = true; _logger(deps).error('[jmctx] extract worker spawn failed: ' + errTag(e)); }
        return resolve(_failRes('READER_UNAVAILABLE'));
      }
      const id = ++seq;
      const t0 = now();
      const kindTag = String(opts.kind || 'file').replace(/[^a-z0-9]/gi, '').slice(0, 20) || 'file';
      let done = false;
      let lastRss = 0;
      let timer = null, poll = null;
      const onAbort = () => finish(_failRes('BUDGET'), true, 'abort');
      const finish = (res, kill, why) => {
        if (done) return;
        done = true;
        clearTimeout(timer); clearInterval(poll);
        try { c.removeListener('message', onMessage); c.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        if (kill) killChild(c);
        if (why) _logger(deps).warn('[jmctx] worker killed ' + kindTag + ' ' + why + ' rss=' + Math.round(lastRss / 1048576) + 'MB ' + (now() - t0) + 'ms');
        resolve(res);
      };
      const onMessage = (msg) => {
        const v = _validateReply(msg, id);
        if (!v) { _logger(deps).warn('[jmctx] worker reply malformed'); return finish(_failRes('PARSE_FAILED'), true, null); }
        finish(v, false, null);
      };
      const onExit = () => { if (child === c) child = null; finish(_failRes('TOO_COMPLEX'), false, 'exit'); };
      c.on('message', onMessage);
      c.once('exit', onExit);
      timer = setTimeout(() => finish(_failRes('TOO_COMPLEX'), true, 'timeout'), limits.PARSE_TIMEOUT_MS);
      poll = setInterval(() => {
        let rss;
        try { rss = getChildRss(c.pid); } catch (_) { rss = undefined; }
        if (Number.isFinite(rss)) {
          lastRss = rss;
          if (rss > limits.WORKER_MAX_RSS_BYTES) finish(_failRes('TOO_COMPLEX'), true, 'rss');
        }
      }, limits.WORKER_RSS_POLL_MS);
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      try {
        post(c, { id, name: String(job.name || ''), mimetype: String(job.mimetype || ''), buffer: new Uint8Array(job.buffer), limits: { maxChars: LIMITS.RAW_TEXT_MAX_CHARS } });
      } catch (_) { finish(_failRes('PARSE_FAILED'), true, null); }
    });
  }

  function close() {
    closed = true;
    if (child) killChild(child);
  }

  return { extract, close };
}

// ───────────────────────── extractItem ─────────────────────────

const GROUP = { pdf: 'pdf', docx: 'docx', pptx: 'pptx', xlsx: 'xlsx', xls: 'xls', ods: 'ods', eml: 'eml', msg: 'msg',
  text: 'text', csv: 'csv', html: 'html', png: 'image', jpg: 'image', gif: 'image', webp: 'image', heic: 'heic' };
const MAIN_IMAGES = new Set(['png', 'jpg', 'gif', 'webp']);
const MIME_BY_KIND = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function _item(kind, status, extra) {
  const text = (extra && extra.text) || '';
  return Object.assign({ kind, status, text, chars: text.length, truncated: false, reason: '', meta: {} }, extra || {}, { chars: text.length });
}

function _visionStatus(reason) { return reason === REASONS.BUDGET || reason === REASONS.VISION_CAP ? 'skipped' : 'failed'; }

/**
 * extractItem({ buffer, name, mimetype, source }, ctx, deps) -> item
 * item = { kind, status, text, chars, truncated, reason, meta } — id and label are
 * assigned by the caller. ctx is the gather context { deadline, signal, visionLeft,
 * session? }. When ctx.session is absent a worker session is created lazily and
 * stored on ctx.session; THE CALLER (gatherContext) MUST close it in a finally.
 */
async function extractItem(file, ctx, deps) {
  deps = deps || {};
  ctx = ctx || {};
  const log = _logger(deps);
  const buf = Buffer.isBuffer(file.buffer) ? file.buffer : Buffer.from(file.buffer || []);
  const det = detectType(buf, file.name, file.mimetype);
  const kind = det.kind;
  const group = GROUP[kind];
  if (group && buf.length > LIMITS.MAX_BYTES[group]) return _item(kind, 'failed', { reason: REASONS.TOO_LARGE });
  if (kind === 'avif') return _item(kind, 'unsupported', { reason: REASONS.AVIF_UNSUPPORTED });
  if (!group) return _item(kind, 'unsupported', { reason: det.ext ? "I can't read ." + det.ext + ' files' : REASONS.UNSUPPORTED });

  const fromVision = async (image, source, fallbackText, failMap) => {
    const v = await visionRead(image, source, ctx, deps);
    if (v.ok) {
      let t = v.text;
      let truncated = false;
      if (t.length > LIMITS.RAW_TEXT_MAX_CHARS) { t = t.slice(0, LIMITS.RAW_TEXT_MAX_CHARS); truncated = true; }
      return { ok: true, text: t, truncated };
    }
    const reason = (failMap && failMap[v.reason]) || v.reason;
    if (fallbackText && fallbackText.trim()) return { ok: true, text: fallbackText, truncated: false, fallback: true };
    return { ok: false, reason };
  };

  if (MAIN_IMAGES.has(kind)) {
    const image = { name: file.name || 'image.' + kind, mimetype: MIME_BY_KIND[kind], buffer: buf };
    const r = await fromVision(image, 'vision_image', '', null);
    if (!r.ok) return _item(kind, _visionStatus(r.reason), { reason: r.reason });
    return _item(kind, r.truncated ? 'truncated' : 'read', { text: r.text, truncated: r.truncated, meta: { via: 'vision' } });
  }

  const session = deps.session || ctx.session || (ctx.session = createWorkerSession(deps));
  const reply = await session.extract({ name: file.name || '', mimetype: file.mimetype || '', buffer: buf }, { signal: ctx.signal, kind });
  const rk = reply.kind && reply.kind !== 'file' ? reply.kind : kind;

  if (reply.errCode && typeof reply.errCode === 'string') {
    if (reply.errCode.startsWith('zip_')) log.warn('[jmctx] zip rejected ' + reply.errCode.slice(4));
    else if (!reply.ok || reply.needsVision) log.warn('[jmctx] ' + rk + ' parse failed: ' + reply.errCode);
  }
  if (reply.reason === 'PDFJS_UNAVAILABLE' && !_pdfjsLogged) {
    _pdfjsLogged = true;
    log.error('[jmctx] pdfjs unavailable: ' + (reply.errCode || 'Error'));
  }

  if (reply.ok && reply.needsVision && reply.image) {
    const isPdf = reply.image.mimetype === 'application/pdf';
    const failMap = reply.reason === 'SCANNED_PDF_UNAVAILABLE'
      ? { [REASONS.VISION_UNAVAILABLE]: REASONS.SCANNED_PDF_UNAVAILABLE, [REASONS.VISION_FAILED]: REASONS.SCANNED_PDF_FAILED } : null;
    const r = await fromVision(reply.image, isPdf ? 'vision_document' : 'vision_image', reply.text, failMap);
    if (!r.ok) return _item(rk, _visionStatus(r.reason), { reason: r.reason, meta: Object.assign({}, reply.meta || {}) });
    const meta = Object.assign({}, reply.meta || {});
    if (!r.fallback) meta.via = 'vision';
    const note = reply.reason === 'PDFJS_UNAVAILABLE' && !r.fallback ? REASONS.PDFJS_UNAVAILABLE : '';
    return _item(rk, r.truncated ? 'truncated' : 'read', { text: r.text, truncated: r.truncated, reason: note, meta });
  }
  if (reply.ok && reply.needsVision) return _item(rk, 'failed', { reason: REASONS.PARSE_FAILED });

  if (!reply.ok) {
    const reason = REASONS[reply.reason] || REASONS.PARSE_FAILED;
    return _item(rk, reply.reason === 'BUDGET' ? 'skipped' : 'failed', { reason });
  }
  if (!reply.text.trim()) return _item(rk, 'failed', { reason: REASONS.EMPTY });
  const note = reply.meta && reply.meta.note ? REASONS[reply.meta.note] : '';
  return _item(rk, reply.truncated ? 'truncated' : 'read', { text: reply.text, truncated: reply.truncated, reason: note || '', meta: reply.meta || {} });
}

module.exports = {
  WORKER_PARTITION, workerEnv, createWorkerSession, extractItem,
  __test__: { resetOnce() { _pdfjsLogged = false; }, validateReply: _validateReply },
};
