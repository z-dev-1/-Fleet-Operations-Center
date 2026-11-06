'use strict';
/**
 * email-intel/config.js — validation and defaults for the user-editable
 * `emailIntelConfig` document (design 2.10, F-19).
 *
 *   defaults()                       -> a complete default document
 *   normalize(doc)                   -> a stored document filled out with defaults (never throws)
 *   validate(patch, prev)            -> { ok:true, config, warnings:[code] } | { ok:false, code:'BAD_ARG', field, error }
 *   effectiveMinConfidence(cfg)      -> number in [0.75, 1], never NaN
 *   isIdentitySet(cfg) / isFasNameSet(cfg)
 *
 * Rules: 32 KB payload cap; unknown keys dropped; strings trimmed, 1-120 chars, no control
 * characters; arrays truncated to their caps; integers clamped to [min, hard max]; a non-number
 * for an integer field keeps the previous value (warning). minConfidence can only be raised
 * (anything invalid or below 0.75 resets to 0.75). mailboxTzVerified and visionNoticeAcknowledged
 * are never settable here (only their own probe / notice handlers write them).
 */
const C = require('./constants');

const ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CTRL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;
const DEFAULT_EXT = Object.freeze(['pdf', 'docx', 'xlsx', 'xls', 'png', 'jpg', 'jpeg']);

const ME_CAPS = Object.freeze({ names: 10, addresses: 10, distributionLists: 20 });
const INT_FIELDS = Object.freeze({
  // key: [min, default, hard max]
  maxEmails: [1, C.MAX_EMAILS_DEFAULT, C.MAX_EMAILS_HARD],
  maxOpen: [1, C.MAX_OPEN_DEFAULT, C.MAX_OPEN_HARD],
  aiCalls: [1, C.AI_CALLS_DEFAULT, C.AI_CALLS_HARD],
  lookbackDays: [1, C.LOOKBACK_DAYS_DEFAULT, 90],
});
const ATT_INT = Object.freeze({
  maxBytes: [100_000, 6_000_000, 10_000_000],
  maxPerMessage: [1, 3, 5],
  maxPerScan: [1, 8, 12],
  timeBudgetMs: [10_000, 120_000, 240_000],
  maxVision: [0, 2, 4],
});

function defaults() {
  return {
    version: C.STORE_VERSION,
    me: { names: [], addresses: [], distributionLists: [], fasName: '' },
    folders: null,
    caps: { maxEmails: C.MAX_EMAILS_DEFAULT, maxOpen: C.MAX_OPEN_DEFAULT, aiCalls: C.AI_CALLS_DEFAULT, lookbackDays: C.LOOKBACK_DAYS_DEFAULT },
    minConfidence: C.AUTO_APPLY_MIN_CONFIDENCE,
    banners: [],
    attachments: { allowedExt: DEFAULT_EXT.slice(), maxBytes: 6_000_000, maxPerMessage: 3, maxPerScan: 8, timeBudgetMs: 120_000, maxVision: 2, visionNoticeAcknowledged: false },
    aiConcurrency: C.AI_CONCURRENCY,
    mailboxTzVerified: false,
    sentFolder: null,
  };
}

function _isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
function _clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/** effectiveMinConfidence(cfg): max(0.75, cfg.minConfidence) when finite, else 0.75. Never NaN, never below 0.75. */
function effectiveMinConfidence(cfg) {
  const v = cfg && cfg.minConfidence;
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(1, Math.max(C.AUTO_APPLY_MIN_CONFIDENCE, v)) : C.AUTO_APPLY_MIN_CONFIDENCE;
}

function _bad(field, error) { return { ok: false, code: 'BAD_ARG', field, error }; }

/** A trimmed 1..max char string without control characters, or an error marker. */
function _str(v, max) {
  if (typeof v !== 'string') return { err: 'must be a string' };
  const t = v.trim();
  if (!t) return { err: 'must not be empty' };
  if (t.length > (max || 120)) return { err: 'too long' };
  if (CTRL_RE.test(t)) return { err: 'contains control characters' };
  return { value: t };
}

function _list(field, v, cap, check) {
  if (!Array.isArray(v)) return { err: _bad(field, 'must be an array') };
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (const item of v) {
    const s = _str(item, 120);
    if (s.err) return { err: _bad(field, s.err) };
    const msg = check ? check(s.value) : null;
    if (msg) return { err: _bad(field, msg) };
    const k = s.value.toLowerCase();
    if (seen.has(k)) continue;
    if (out.length >= cap) { truncated = true; break; }
    seen.add(k);
    out.push(s.value);
  }
  return { value: out, truncated };
}

function _int(field, v, spec, prev, warnings) {
  const [lo, def, hi] = spec;
  if (typeof v !== 'number' || !Number.isFinite(v)) { warnings.push('ignored-' + field); return prev != null ? prev : def; }
  const n = Math.trunc(v);
  const c = _clamp(n, lo, hi);
  if (c !== n) warnings.push('clamped-' + field);
  return c;
}

/** normalize(doc): a stored document completed with defaults. Invalid parts fall back; never throws. */
function normalize(doc) {
  const base = defaults();
  if (!_isPlain(doc)) return base;
  const out = defaults();
  out.version = Number.isFinite(doc.version) ? doc.version : base.version;
  if (_isPlain(doc.me)) {
    for (const k of ['names', 'addresses', 'distributionLists']) {
      if (Array.isArray(doc.me[k])) out.me[k] = doc.me[k].filter((x) => typeof x === 'string' && x.trim()).slice(0, ME_CAPS[k]);
    }
    if (typeof doc.me.fasName === 'string') out.me.fasName = doc.me.fasName.trim().slice(0, 120);
  }
  if (Array.isArray(doc.folders)) out.folders = doc.folders.filter((x) => typeof x === 'string' && x.trim()).slice(0, C.MAILBOX_FOLDERS_MAX);
  if (_isPlain(doc.caps)) {
    for (const k of Object.keys(INT_FIELDS)) {
      const v = doc.caps[k];
      if (typeof v === 'number' && Number.isFinite(v)) out.caps[k] = _clamp(Math.trunc(v), INT_FIELDS[k][0], INT_FIELDS[k][2]);
    }
  }
  out.minConfidence = effectiveMinConfidence(doc);
  if (Array.isArray(doc.banners)) out.banners = doc.banners.filter((x) => typeof x === 'string' && x.trim()).slice(0, 20);
  if (_isPlain(doc.attachments)) {
    if (Array.isArray(doc.attachments.allowedExt)) out.attachments.allowedExt = doc.attachments.allowedExt.filter((x) => typeof x === 'string').map((x) => x.toLowerCase().replace(/^\./, '')).slice(0, 20);
    for (const k of Object.keys(ATT_INT)) {
      const v = doc.attachments[k];
      if (typeof v === 'number' && Number.isFinite(v)) out.attachments[k] = _clamp(Math.trunc(v), ATT_INT[k][0], ATT_INT[k][2]);
    }
    out.attachments.visionNoticeAcknowledged = doc.attachments.visionNoticeAcknowledged === true;
  }
  if (typeof doc.aiConcurrency === 'number' && Number.isFinite(doc.aiConcurrency)) out.aiConcurrency = _clamp(Math.trunc(doc.aiConcurrency), 1, C.AI_CONCURRENCY_HARD);
  out.mailboxTzVerified = doc.mailboxTzVerified === true;
  out.sentFolder = typeof doc.sentFolder === 'string' && doc.sentFolder.trim() ? doc.sentFolder.trim().slice(0, 120) : null;
  return out;
}

/**
 * validate(patch, prev) -> { ok, config, warnings } | { ok:false, code:'BAD_ARG', field, error }
 * `prev` is the currently stored document (already normalized or raw). Only keys present in the
 * patch change; nested objects (me, caps, attachments) merge key by key.
 */
function validate(patch, prev) {
  if (!_isPlain(patch)) return _bad('config', 'must be an object');
  let size = 0;
  try { size = JSON.stringify(patch).length; } catch (_) { return _bad('config', 'not serializable'); }
  if (size > C.CONFIG_MAX_BYTES) return _bad('config', 'too large');

  const cur = normalize(prev);
  const next = JSON.parse(JSON.stringify(cur));
  const warnings = [];
  const note = (w) => { if (!warnings.includes(w)) warnings.push(w); };

  if (patch.me !== undefined) {
    if (!_isPlain(patch.me)) return _bad('me', 'must be an object');
    const me = patch.me;
    if (me.names !== undefined) {
      const r = _list('me.names', me.names, ME_CAPS.names, (s) => (s.length < 2 || s.length > 60 ? 'names must be 2-60 characters' : null));
      if (r.err) return r.err; next.me.names = r.value; if (r.truncated) note('truncated-me.names');
    }
    if (me.addresses !== undefined) {
      const r = _list('me.addresses', me.addresses, ME_CAPS.addresses, (s) => (ADDRESS_RE.test(s) ? null : 'invalid email address'));
      if (r.err) return r.err; next.me.addresses = r.value.map((s) => s.toLowerCase()); if (r.truncated) note('truncated-me.addresses');
    }
    if (me.distributionLists !== undefined) {
      const r = _list('me.distributionLists', me.distributionLists, ME_CAPS.distributionLists, null);
      if (r.err) return r.err; next.me.distributionLists = r.value; if (r.truncated) note('truncated-me.distributionLists');
    }
    if (me.fasName !== undefined) {
      if (me.fasName === '' || me.fasName === null) next.me.fasName = '';
      else { const s = _str(me.fasName, 120); if (s.err) return _bad('me.fasName', s.err); next.me.fasName = s.value; }
    }
  }

  if (patch.folders !== undefined) {
    if (patch.folders === null) next.folders = null;
    else {
      const r = _list('folders', patch.folders, C.MAILBOX_FOLDERS_MAX, null);
      if (r.err) return r.err; next.folders = r.value.length ? r.value : null; if (r.truncated) note('truncated-folders');
    }
  }

  if (patch.caps !== undefined) {
    if (!_isPlain(patch.caps)) return _bad('caps', 'must be an object');
    for (const k of Object.keys(INT_FIELDS)) {
      if (patch.caps[k] !== undefined) next.caps[k] = _int('caps.' + k, patch.caps[k], INT_FIELDS[k], cur.caps[k], warnings);
    }
  }

  if (patch.minConfidence !== undefined) {
    const v = patch.minConfidence;
    if (typeof v === 'number' && Number.isFinite(v) && v >= C.AUTO_APPLY_MIN_CONFIDENCE && v <= 1) next.minConfidence = v;
    else { next.minConfidence = C.AUTO_APPLY_MIN_CONFIDENCE; note('minConfidence-reset'); }
  }

  if (patch.banners !== undefined) {
    const r = _list('banners', patch.banners, 20, null);
    if (r.err) return r.err; next.banners = r.value; if (r.truncated) note('truncated-banners');
  }

  if (patch.attachments !== undefined) {
    if (!_isPlain(patch.attachments)) return _bad('attachments', 'must be an object');
    const a = patch.attachments;
    if (a.allowedExt !== undefined) {
      const r = _list('attachments.allowedExt', a.allowedExt, 20, (s) => (/^\.?[a-z0-9]{1,6}$/i.test(s) ? null : 'invalid extension'));
      if (r.err) return r.err; next.attachments.allowedExt = r.value.map((s) => s.toLowerCase().replace(/^\./, ''));
    }
    for (const k of Object.keys(ATT_INT)) {
      if (a[k] !== undefined) next.attachments[k] = _int('attachments.' + k, a[k], ATT_INT[k], cur.attachments[k], warnings);
    }
    // visionNoticeAcknowledged: never settable here.
    next.attachments.visionNoticeAcknowledged = cur.attachments.visionNoticeAcknowledged === true;
  }

  if (patch.aiConcurrency !== undefined) next.aiConcurrency = _int('aiConcurrency', patch.aiConcurrency, [1, C.AI_CONCURRENCY, C.AI_CONCURRENCY_HARD], cur.aiConcurrency, warnings);

  if (patch.sentFolder !== undefined) {
    if (patch.sentFolder === null || patch.sentFolder === '') next.sentFolder = null;
    else { const s = _str(patch.sentFolder, 120); if (s.err) return _bad('sentFolder', s.err); next.sentFolder = s.value; }
  }

  // Never settable through set-config.
  next.mailboxTzVerified = cur.mailboxTzVerified === true;
  next.version = C.STORE_VERSION;
  return { ok: true, config: next, warnings };
}

function isIdentitySet(cfg) {
  const me = (cfg && cfg.me) || {};
  return (Array.isArray(me.names) && me.names.length > 0) || (Array.isArray(me.addresses) && me.addresses.length > 0);
}
function isFasNameSet(cfg) {
  const me = (cfg && cfg.me) || {};
  return typeof me.fasName === 'string' && me.fasName.trim().length > 0;
}

module.exports = { ADDRESS_RE, DEFAULT_EXT, defaults, normalize, validate, effectiveMinConfidence, isIdentitySet, isFasNameSet };
