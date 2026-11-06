'use strict';
/**
 * email-intel/stores.js — accessors for the seven Email Triage Intelligence
 * store documents (design 1.2).
 *
 * Every accessor first checks flags.engaged(). With the flags OFF the accessors
 * return an in-memory default and NEVER touch disk, so no email_intel_*.json
 * file can appear in the data dir. Writes use store.update (synchronous RMW,
 * atomic per tick). A document whose `version` is newer than STORE_VERSION is
 * read-only for this build (rollback safety): reads work, writes are refused.
 */
const store = require('../store');
const flags = require('./flags');
const { STORE_VERSION } = require('./constants');

const KEYS = Object.freeze({
  config: 'emailIntelConfig',
  checkpoints: 'emailIntelCheckpoints',
  messages: 'emailIntelMessages',
  actions: 'emailIntelActions',
  ledger: 'emailIntelTimelineLedger',
  staged: 'emailIntelStaged',
  sends: 'emailIntelSends',
});

const DEFAULTS = {
  config: () => ({
    version: STORE_VERSION,
    me: { names: [], addresses: [], distributionLists: [] },
    folders: null,
    caps: {},
    minConfidence: 0.75,
    banners: [],
    attachments: {},
    aiConcurrency: 1,
    mailboxTzVerified: false,
    sentFolder: null,
  }),
  checkpoints: () => ({ version: STORE_VERSION, folders: {}, rotation: 0, scan: { current: null, last: null }, owaAuth: null }),
  messages: () => ({ version: STORE_VERSION, messages: {}, byConv: {} }),
  actions: () => ({ version: STORE_VERSION, items: {}, questions: {} }),
  ledger: () => ({ version: STORE_VERSION, entries: {} }),
  staged: () => ({ version: STORE_VERSION, items: {} }),
  sends: () => ({ version: STORE_VERSION, attempts: {} }),
};

function _engaged() {
  try { return flags.engaged(); } catch (_) { return false; }
}

function _name(name) {
  if (!Object.prototype.hasOwnProperty.call(KEYS, name)) throw new Error('unknown email-intel store: ' + name);
  return name;
}

function defaults(name) { return DEFAULTS[_name(name)](); }
function keyOf(name) { return KEYS[_name(name)]; }

/** load(name) -> document (a fresh default when flags are OFF, the file is missing or unreadable). */
function load(name) {
  _name(name);
  if (!_engaged()) return DEFAULTS[name]();
  let doc;
  try { doc = store.load(KEYS[name], null); } catch (_) { doc = null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return DEFAULTS[name]();
  return doc;
}

/** True when the stored document is from a newer build (read-only here). */
function isReadOnly(name) {
  _name(name);
  if (!_engaged()) return false;
  let doc;
  try { doc = store.load(KEYS[name], null); } catch (_) { return false; }
  return !!(doc && typeof doc === 'object' && Number(doc.version) > STORE_VERSION);
}

/**
 * update(name, fn) -> { ok:true, doc } | { ok:false, code }
 * fn receives the current document and must return the new one.
 */
function update(name, fn) {
  _name(name);
  if (!_engaged()) return { ok: false, code: 'FLAGS_OFF' };
  if (isReadOnly(name)) return { ok: false, code: 'STORE_NEWER_VERSION' };
  const doc = store.update(KEYS[name], (cur) => {
    const base = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : DEFAULTS[name]();
    const next = fn(base);
    return next === undefined ? base : next;
  }, DEFAULTS[name]());
  return { ok: true, doc };
}

/** save(name, doc) -> { ok } (same guards as update). */
function save(name, doc) {
  _name(name);
  if (!_engaged()) return { ok: false, code: 'FLAGS_OFF' };
  if (isReadOnly(name)) return { ok: false, code: 'STORE_NEWER_VERSION' };
  store.save(KEYS[name], doc);
  return { ok: true };
}

module.exports = { KEYS, defaults, keyOf, load, update, save, isReadOnly };
