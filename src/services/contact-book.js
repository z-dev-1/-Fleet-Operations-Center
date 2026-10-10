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

// FOUR identities only (2026-09: manager removed — internal covers it).
const VALID_IDENTITY = ['internal', 'carrier', 'vendor', 'unknown'];
const DATA_CATS = ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'];
const REQ_TYPES = ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'];
// The two sensitive capabilities are each a 3-state field (NOT booleans, NOT in
// the request-type list): lifecycle changes and work-request creation. Data
// categories + request types are effectively always "all" now — the meaningful
// per-contact controls are SCOPE (SCAC/domicile) + these two capabilities.
const LIFECYCLE_PERMS = ['not_allowed', 'may_request', 'trusted_autonomous'];
const CREATE_WR_PERMS = ['not_allowed', 'may_request', 'trusted_autonomous'];

// Wildcard scope token: '*' means ALL operators / ALL domiciles, including any
// that appear in the fleet later. Used as the default for `unknown` contacts.
const ALL_SCOPE = '*';

// "All" defaults applied to every contact for data/requests (these are no
// longer per-contact toggles in the UI).
const ALL_DATA_CATS = DATA_CATS.slice();
const ALL_REQ_TYPES = REQ_TYPES.slice();

function _now() { return new Date().toISOString(); }
function _genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function _load() { const c = store.load(STORE_KEY, []); return Array.isArray(c) ? c : []; }

// Case-insensitive Slack ID normalization key (Slack IDs are case-insensitive).
function _slackKey(slackId) { return slackId ? String(slackId).trim().toUpperCase() : ''; }

// Vendor dedupe key: vendors have no slackId, so a re-add (manual or imported)
// would otherwise create a duplicate card. Match on name (+ company when both
// have one) case-insensitively, collapsing punctuation/whitespace/diacritics so
// "Bergey's Truck Centers - Souderton" and "Bergeys Truck Centers  Souderton"
// resolve to the same vendor.
function _vendorNameKey(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ') // punctuation/apostrophes/dashes -> space
    .trim()
    .replace(/\s+/g, ' ');
}
function _vendorKey(c) {
  if (!c) return '';
  const name = _vendorNameKey(c.name);
  if (!name) return '';
  const company = _vendorNameKey(c.company);
  return company ? name + '|' + company : name;
}
// Find an existing type:'vendor' contact that matches `incoming` by name (+company).
// Matches name|company first; falls back to name-only so a later add that omits
// company still merges onto the same vendor.
function _findVendorMatch(all, incoming) {
  if (!incoming || incoming.type !== 'vendor') return -1;
  const name = _vendorNameKey(incoming.name);
  if (!name) return -1;
  const key = _vendorKey(incoming);
  let idx = all.findIndex(c => c && c.type === 'vendor' && _vendorKey(c) === key);
  if (idx > -1) return idx;
  return all.findIndex(c => c && c.type === 'vendor' && _vendorNameKey(c.name) === name);
}

// UNION-merge a vendor's accumulating fields onto `merged` (the base from
// _mergeNoBlank). `base` = existing stored vendor, `incoming` = new patch.
//  - domiciles / makes: case-insensitive union, order preserved (existing first)
//  - mileageByDomicile / preferenceByDomicile: shallow object merge, incoming
//    wins per key (newest distance/rank for that site)
//  - prefTags: union of foreign "SITE Pref #n" strings (reference only)
function _vendorUnionMerge(merged, base, incoming) {
  const unionArr = (a, b) => {
    const out = []; const seen = new Set();
    [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].forEach(v => {
      const s = String(v == null ? '' : v).trim(); if (!s) return;
      const k = s.toUpperCase(); if (seen.has(k)) return; seen.add(k); out.push(s);
    });
    return out;
  };
  if (Array.isArray(base.domiciles) || Array.isArray(incoming.domiciles)) {
    merged.domiciles = unionArr(base.domiciles, incoming.domiciles).map(s => s.toUpperCase());
  }
  if (Array.isArray(base.makes) || Array.isArray(incoming.makes)) {
    merged.makes = unionArr(base.makes, incoming.makes).map(s => s.toUpperCase());
    if (!merged.make && merged.makes.length) merged.make = merged.makes[0];
  }
  if (Array.isArray(base.prefTags) || Array.isArray(incoming.prefTags)) {
    merged.prefTags = unionArr(base.prefTags, incoming.prefTags);
  }
  const mergeMap = (a, b) => {
    const out = { ...(a && typeof a === 'object' ? a : {}) };
    if (b && typeof b === 'object') for (const k of Object.keys(b)) out[k] = b[k];
    return out;
  };
  if ((base.mileageByDomicile && typeof base.mileageByDomicile === 'object') ||
      (incoming.mileageByDomicile && typeof incoming.mileageByDomicile === 'object')) {
    merged.mileageByDomicile = mergeMap(base.mileageByDomicile, incoming.mileageByDomicile);
  }
  if ((base.preferenceByDomicile && typeof base.preferenceByDomicile === 'object') ||
      (incoming.preferenceByDomicile && typeof incoming.preferenceByDomicile === 'object')) {
    merged.preferenceByDomicile = mergeMap(base.preferenceByDomicile, incoming.preferenceByDomicile);
  }
}

function _upperArrayOrEmpty(v) {
  // Preserves the '*' wildcard (all-scope) token; everything else uppercased,
  // trimmed, de-duped. If '*' is present it collapses to just ['*'].
  const norm = (arr) => {
    const cleaned = Array.from(new Set(arr.map(x => String(x).trim()).filter(Boolean)
      .map(x => x === ALL_SCOPE ? ALL_SCOPE : x.toUpperCase())));
    return cleaned.includes(ALL_SCOPE) ? [ALL_SCOPE] : cleaned;
  };
  if (Array.isArray(v)) return norm(v);
  if (typeof v === 'string' && v.trim()) return norm(v.split(/[\s,]+/));
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
  if (out.createWrPermission !== undefined && !CREATE_WR_PERMS.includes(out.createWrPermission)) out.createWrPermission = 'not_allowed';
  // VENDOR LOCK: a vendor (mechanic) can never be trusted/autonomous for
  // lifecycle changes or WR creation — they ask, the operator acts. Force both
  // to not_allowed regardless of what was submitted.
  if (out.identityType === 'vendor') { out.lifecyclePermission = 'not_allowed'; out.createWrPermission = 'not_allowed'; }
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
  // Vendors have no id/slackId on a fresh add -> dedupe by name (+company) so a
  // re-add or import merges onto the existing vendor card instead of duplicating.
  if (idx < 0 && clean.type === 'vendor' && opts.vendorDedupe !== false) {
    idx = _findVendorMatch(all, clean);
  }

  if (idx > -1) {
    // If a slackId is being set, it must not collide with a DIFFERENT contact.
    if (clean.slackId) {
      const key = _slackKey(clean.slackId);
      const dup = all.findIndex((c, i) => i !== idx && _slackKey(c.slackId) === key);
      if (dup > -1) return { ok: false, error: 'another contact already has Slack ID ' + clean.slackId };
    }
    const merged = opts.mergeNoBlank === false ? { ...all[idx], ...clean } : _mergeNoBlank(all[idx], clean);
    // Vendor accumulation: when a vendor is re-upserted (e.g. the same dealer
    // seen under a second domicile), UNION the multi-value fields instead of
    // replacing, so domiciles/makes grow and per-domicile mileage/pref maps
    // accumulate across adds. Opt-out with opts.vendorUnion === false.
    if (clean.type === 'vendor' && opts.vendorUnion !== false) {
      _vendorUnionMerge(merged, all[idx], clean);
    }
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

/** update(contact) — edit by id; requires an existing contact. An explicit edit
 * REPLACES multi-value fields (domiciles/makes/mileage) rather than unioning, so
 * removing a domicile in the edit form actually removes it (vendorUnion:false). */
function update(contact) {
  if (!contact || !contact.id) return { ok: false, error: 'contact.id required' };
  const all = _load();
  if (!all.some(c => c.id === contact.id)) return { ok: false, error: 'Contact not found' };
  return upsert(contact, { vendorUnion: false });
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
  // A newly discovered sender defaults to UNKNOWN. Because most unknown senders
  // are internal contacts, unknown now gets ALL data + ALL request types and
  // ALL scope (every SCAC + every domicile, via '*'). It still may NOT change
  // lifecycle or create work requests automatically (both not_allowed) — those
  // require the operator to explicitly grant them (and to set a narrower
  // identity/scope if this turns out to be an external carrier/vendor).
  const created = {
    id: _genId(), type: 'slack', slackId: String(slackId).trim(),
    name: name || slackId, channelId: channelId || '',
    identityType: 'unknown',
    enabled: true,
    operators: [ALL_SCOPE], domiciles: [ALL_SCOPE],
    allowedDataCategories: ALL_DATA_CATS.slice(),
    permittedRequestTypes: ALL_REQ_TYPES.slice(),
    lifecyclePermission: 'not_allowed',
    createWrPermission: 'not_allowed',
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
  sanitize, _mergeNoBlank, _slackKey, _vendorNameKey, _vendorKey, _findVendorMatch, _vendorUnionMerge,
  VALID_IDENTITY, DATA_CATS, REQ_TYPES, LIFECYCLE_PERMS, CREATE_WR_PERMS,
  ALL_SCOPE, ALL_DATA_CATS, ALL_REQ_TYPES,
  STORE_KEY,
};
