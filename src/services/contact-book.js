'use strict';
/**
 * services/contact-book.js — the ONE hardened Contact Book write service.
 *
 * EVERY contact create/modify path goes through here: manual add, manual edit,
 * bulk save, Slack directory link, automatic DM discovery, migration, and any
 * future import/integration. Centralizing these guarantees one consistent set
 * of rules:
 *
 *   - Slack IDs are normalized case-insensitively and duplicates are prevented
 *     (a create for an existing slackId LINKS/updates instead of duplicating).
 *   - Permission arrays are sanitized: malformed / non-array / unknown values
 *     become SAFE EMPTY arrays, never raw strings, never wildcards.
 *   - Useful existing info is NEVER overwritten with blank incoming values.
 *   - A `contacts:updated` event fires after every successful mutation so every
 *     screen refreshes.
 *   - Automatically discovered contacts default to the safe unknown policy:
 *     identity=unknown, NO carrier/domicile scope, NO lifecycle permission,
 *     conservative data/request permissions.
 *
 * Contact Book is the single source of truth for FAS identity + permissions.
 * Non-FAS fields (name, company, email, phone, address, vendor/dealer/tow,
 * vendor preferences, assignments) pass through untouched so those features
 * keep working.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('contact-book'); } catch (_) { logger = { info(){}, warn(){} }; }

const STORE_KEY = 'contacts';

const VALID_IDENTITY = ['internal', 'manager', 'carrier', 'vendor', 'unknown'];
const DATA_CATS = ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'];
const REQ_TYPES = ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'];
// Lifecycle permission is a 3-state field (NOT a boolean and NOT part of the
// request-type list): what a contact may do with lifecycle changes.
const LIFECYCLE_PERMS = ['not_allowed', 'may_request', 'trusted_autonomous'];

// Safe defaults for an automatically discovered (unknown) contact.
const UNKNOWN_DATA_CATS = ['unit_status'];
const UNKNOWN_REQ_TYPES = ['unit_status', 'repair_update', 'follow_up', 'process_question'];

function _now() { return new Date().toISOString(); }
function _genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function _load() { const c = store.load(STORE_KEY, []); return Array.isArray(c) ? c : []; }

// Case-insensitive Slack ID normalization key (Slack IDs are case-insensitive).
function _slackKey(slackId) { return slackId ? String(slackId).trim().toUpperCase() : ''; }

function _upperArrayOrEmpty(v) {
  if (Array.isArray(v)) return Array.from(new Set(v.map(x => String(x).trim().toUpperCase()).filter(Boolean)));
  if (typeof v === 'string' && v.trim()) return Array.from(new Set(v.split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean)));
  return []; // malformed / non-array -> SAFE EMPTY array
}
function _enumArrayOrEmpty(v, allowed) {
  if (Array.isArray(v)) return v.filter(x => allowed.includes(x));
  return []; // malformed / non-array -> SAFE EMPTY array
}

/**
 * sanitize(incoming) -> a cleaned partial with ONLY the FAS-relevant fields
 * normalized. Non-FAS fields are copied through verbatim. Permission arrays are
 * only touched when present on `incoming` (so a partial update doesn't wipe
 * fields the caller didn't send).
 */
function sanitize(incoming) {
  const out = { ...(incoming || {}) };
  if (out.identityType !== undefined && !VALID_IDENTITY.includes(out.identityType)) out.identityType = 'unknown';
  if (out.lifecyclePermission !== undefined && !LIFECYCLE_PERMS.includes(out.lifecyclePermission)) out.lifecyclePermission = 'not_allowed';
  if (out.operators !== undefined) out.operators = _upperArrayOrEmpty(out.operators);
  if (out.domiciles !== undefined) out.domiciles = _upperArrayOrEmpty(out.domiciles);
  if (out.allowedDataCategories !== undefined) out.allowedDataCategories = _enumArrayOrEmpty(out.allowedDataCategories, DATA_CATS);
  if (out.permittedRequestTypes !== undefined) out.permittedRequestTypes = _enumArrayOrEmpty(out.permittedRequestTypes, REQ_TYPES);
  if (out.communicationPreferences !== undefined && (typeof out.communicationPreferences !== 'object' || Array.isArray(out.communicationPreferences))) out.communicationPreferences = {};
  if (out.enabled !== undefined) out.enabled = !!out.enabled;
  if (out.slackId !== undefined && out.slackId !== null) out.slackId = String(out.slackId).trim();
  return out;
}

// Merge `patch` onto `base` WITHOUT overwriting useful existing values with
// blanks. A blank incoming value (undefined, null, '', or an empty array for a
// field that already has entries) does not clobber a populated existing value.
function _mergeNoBlank(base, patch) {
  const merged = { ...base };
  for (const k of Object.keys(patch)) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '' && base[k]) continue; // don't blank a populated string
    if (Array.isArray(v) && v.length === 0 && Array.isArray(base[k]) && base[k].length) {
      // An explicitly-empty array is a legitimate "clear scope/permissions"
      // action ONLY for FAS permission fields the editor controls; for other
      // arrays, keep the existing populated value.
      const clearable = ['operators', 'domiciles', 'allowedDataCategories', 'permittedRequestTypes'];
      if (!clearable.includes(k)) continue;
    }
    merged[k] = v;
  }
  return merged;
}

function _emitUpdated(payload) {
  try {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows ? BrowserWindow.getAllWindows() : [];
    wins.forEach(w => { try { w.webContents.send('contacts:updated', payload || {}); } catch (_) {} });
  } catch (_) { /* not in an Electron window context (e.g. tests) — fine */ }
}

function _persist(all, eventPayload) {
  store.save(STORE_KEY, all);
  _emitUpdated(eventPayload);
}

/**
 * upsert(incoming, opts) — the core write. If incoming has a slackId that
 * matches an existing contact (case-insensitive), it MERGES onto that contact
 * (no duplicate). Otherwise it creates a new contact. Returns
 * { ok, id, linked, contact }.
 *
 * opts.mergeNoBlank (default true) — protect populated fields from blank writes.
 */
function upsert(incoming, opts) {
  opts = opts || {};
  if (!incoming || typeof incoming !== 'object') return { ok: false, error: 'contact object required' };
  const clean = sanitize(incoming);
  const all = _load();

  // Match by id first, then by case-insensitive slackId.
  let idx = -1;
  if (clean.id) idx = all.findIndex(c => c.id === clean.id);
  if (idx < 0 && clean.slackId) {
    const key = _slackKey(clean.slackId);
    idx = all.findIndex(c => _slackKey(c.slackId) === key);
  }

  if (idx > -1) {
    // If a slackId is being set, it must not collide with a DIFFERENT contact.
    if (clean.slackId) {
      const key = _slackKey(clean.slackId);
      const dup = all.findIndex((c, i) => i !== idx && _slackKey(c.slackId) === key);
      if (dup > -1) return { ok: false, error: 'another contact already has Slack ID ' + clean.slackId };
    }
    const merged = opts.mergeNoBlank === false ? { ...all[idx], ...clean } : _mergeNoBlank(all[idx], clean);
    merged.updatedAt = _now();
    all[idx] = merged;
    _persist(all, merged);
    return { ok: true, id: merged.id, linked: !!clean.slackId, contact: merged };
  }

  // Create.
  const created = { ...clean };
  created.id = clean.id || _genId();
  created.createdAt = created.createdAt || _now();
  created.updatedAt = _now();
  all.push(created);
  _persist(all, created);
  return { ok: true, id: created.id, linked: false, contact: created };
}

/** update(contact) — edit by id; requires an existing contact. */
function update(contact) {
  if (!contact || !contact.id) return { ok: false, error: 'contact.id required' };
  const all = _load();
  if (!all.some(c => c.id === contact.id)) return { ok: false, error: 'Contact not found' };
  return upsert(contact);
}

/** linkSlack({ contactId, slackId, name }) — attach a Slack ID to an existing
 * contact without creating a duplicate (case-insensitive collision check). */
function linkSlack({ contactId, slackId, name } = {}) {
  if (!contactId || !slackId) return { ok: false, error: 'contactId and slackId required' };
  const all = _load();
  const key = _slackKey(slackId);
  const dup = all.find(c => c.id !== contactId && _slackKey(c.slackId) === key);
  if (dup) return { ok: false, error: 'Slack ID already linked to another contact' };
  const c = all.find(x => x.id === contactId);
  if (!c) return { ok: false, error: 'contact not found' };
  c.slackId = String(slackId).trim();
  if (name && !c.name) c.name = name;
  c.updatedAt = _now();
  _persist(all, c);
  return { ok: true, id: c.id, contact: c };
}

/**
 * bulkSave(list) — replace the whole book. Sanitizes each record and drops
 * duplicate active slackIds (case-insensitive, first wins). Preserves records
 * without a slackId (vendors/dealers). Emits one update event.
 */
function bulkSave(list) {
  const arr = Array.isArray(list) ? list : [];
  const seen = new Set();
  const out = [];
  for (const c of arr) {
    if (!c || typeof c !== 'object') continue;
    if (c.slackId) { const k = _slackKey(c.slackId); if (seen.has(k)) continue; seen.add(k); }
    const clean = sanitize(c);
    if (!clean.id) clean.id = _genId();
    out.push(clean);
  }
  _persist(out, { bulk: true, count: out.length });
  return { ok: true, count: out.length };
}

/**
 * discoverFromDM({ slackId, name, channelId }) — automatic DM discovery.
 * Deduplicates case-insensitively. A NEW discovered contact defaults to the
 * SAFE UNKNOWN policy (identity=unknown, no scope, no lifecycle permission,
 * conservative data/request permissions). An existing contact is NOT
 * downgraded — we only fill in a missing name/channelId.
 */
function discoverFromDM({ slackId, name, channelId } = {}) {
  if (!slackId) return { ok: false, error: 'slackId required' };
  const all = _load();
  const key = _slackKey(slackId);
  const existing = all.find(c => _slackKey(c.slackId) === key);
  if (existing) {
    let changed = false;
    if (name && !existing.name) { existing.name = name; changed = true; }
    if (channelId && !existing.channelId) { existing.channelId = channelId; changed = true; }
    if (changed) { existing.updatedAt = _now(); _persist(all, existing); }
    return { ok: true, id: existing.id, existed: true, contact: existing };
  }
  const created = {
    id: _genId(), type: 'slack', slackId: String(slackId).trim(),
    name: name || slackId, channelId: channelId || '',
    identityType: 'unknown',
    enabled: true,
    operators: [], domiciles: [],
    allowedDataCategories: UNKNOWN_DATA_CATS.slice(),
    permittedRequestTypes: UNKNOWN_REQ_TYPES.slice(),
    lifecyclePermission: 'not_allowed',
    communicationPreferences: {},
    permissionSource: 'dm-discovery',
    source: 'dm-autoreply',
    addedAt: _now(), createdAt: _now(), updatedAt: _now(),
  };
  all.push(created);
  _persist(all, created);
  return { ok: true, id: created.id, existed: false, contact: created };
}

/**
 * remove(id) — delete a contact and write a tombstone (audit trail). Deleting
 * immediately revokes FAS authorization because resolveSender no longer finds
 * the contact.
 */
function remove(id) {
  const all = _load();
  const gone = all.find(c => c.id === id);
  const next = all.filter(c => c.id !== id);
  _persist(next, { deleted: id });
  if (gone && gone.slackId) {
    try {
      const tomb = store.load('contactsTombstones', []);
      const t = Array.isArray(tomb) ? tomb : [];
      t.unshift({ id: gone.id, slackId: gone.slackId, name: gone.name || '', identityType: gone.identityType || '', deletedAt: _now() });
      store.save('contactsTombstones', t.slice(0, 200));
    } catch (_) {}
  }
  return { ok: true };
}

// Find by case-insensitive slackId (used by resolver + tests).
function findBySlackId(slackId) {
  if (!slackId) return null;
  const key = _slackKey(slackId);
  return _load().find(c => _slackKey(c.slackId) === key) || null;
}

module.exports = {
  upsert, update, linkSlack, bulkSave, discoverFromDM, remove, findBySlackId,
  sanitize, _mergeNoBlank, _slackKey,
  VALID_IDENTITY, DATA_CATS, REQ_TYPES, LIFECYCLE_PERMS,
  UNKNOWN_DATA_CATS, UNKNOWN_REQ_TYPES,
  STORE_KEY,
};
