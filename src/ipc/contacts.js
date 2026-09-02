'use strict';
/**
 * contacts.js — Vendor Contact Book
 * 
 * Stores vendor contacts with:
 *   - name, company, role
 *   - address (street, city, state, zip)
 *   - phone, email
 *   - slackId (for @ mentions)
 *
 * Used by: WR modal, email composer, chat @ mentions
 */

const store  = require('../store');
const { handle } = require('./_safe');

const STORE_KEY      = 'contacts';
const ASSIGN_KEY     = 'vendorAssignments';

const VALID_IDENTITY = ['internal', 'manager', 'carrier', 'vendor', 'unknown'];
const DATA_CATS = ['unit_status', 'repair_timeline', 'work_orders', 'pm_status', 'uptake', 'vendor_contact', 'site_summary', 'operator_summary'];
const REQ_TYPES = ['unit_status', 'repair_update', 'follow_up', 'report', 'process_question', 'lifecycle_change', 'create_wr'];

// Validate/normalize FAS-relevant fields on a contact so a malformed record
// can't grant unintended access (Part 1). Non-FAS fields (address, phone, etc.)
// pass through untouched so vendor/dealer/tow features are preserved.
function _sanitizeContact(c) {
  const out = { ...c };
  if (out.identityType !== undefined && !VALID_IDENTITY.includes(out.identityType)) out.identityType = 'unknown';
  const toUpperArr = (v) => Array.isArray(v)
    ? v.map(x => String(x).trim().toUpperCase()).filter(Boolean)
    : (typeof v === 'string' && v.trim() ? v.split(/[\s,]+/).map(x => x.trim().toUpperCase()).filter(Boolean) : undefined);
  if (out.operators !== undefined) { const a = toUpperArr(out.operators); if (a) out.operators = Array.from(new Set(a)); }
  if (out.domiciles !== undefined) { const a = toUpperArr(out.domiciles); if (a) out.domiciles = Array.from(new Set(a)); }
  if (Array.isArray(out.allowedDataCategories)) out.allowedDataCategories = out.allowedDataCategories.filter(x => DATA_CATS.includes(x));
  if (Array.isArray(out.permittedRequestTypes)) out.permittedRequestTypes = out.permittedRequestTypes.filter(x => REQ_TYPES.includes(x));
  if (out.enabled !== undefined) out.enabled = !!out.enabled;
  out.updatedAt = new Date().toISOString();
  return out;
}

function registerContactsHandlers() {
  handle('contacts:get-all', async () => {
    return store.load(STORE_KEY, []);
  });

  handle('contacts:save', async (_e, contacts) => {
    // Bulk save: sanitize FAS fields on each record and drop duplicate active
    // slackIds (first wins) so a bulk write can't introduce a duplicate or a
    // malformed permission grant.
    const list = Array.isArray(contacts) ? contacts : [];
    const seenSlack = new Set();
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      if (c.slackId) { const k = String(c.slackId); if (seenSlack.has(k)) continue; seenSlack.add(k); }
      out.push(_sanitizeContact(c));
    }
    store.save(STORE_KEY, out);
    return { ok: true, count: out.length };
  });

  handle('contacts:add', async (_e, contact) => {
    if (!contact || typeof contact !== 'object') return { ok: false, error: 'contact object required' };
    const all = store.load(STORE_KEY, []);
    // Prevent duplicate ACTIVE contacts with the same Slack ID (Part 1). If a
    // contact with this slackId already exists, update it instead of adding a
    // second — return linked:true so callers know it was a link, not a create.
    if (contact.slackId) {
      const existing = all.find(c => c.slackId && String(c.slackId) === String(contact.slackId));
      if (existing) {
        Object.assign(existing, _sanitizeContact({ ...contact, id: existing.id }));
        store.save(STORE_KEY, all);
        return { ok: true, id: existing.id, linked: true };
      }
    }
    const clean = _sanitizeContact(contact);
    clean.id = contact.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    clean.createdAt = clean.createdAt || new Date().toISOString();
    all.push(clean);
    store.save(STORE_KEY, all);
    return { ok: true, id: clean.id };
  });

  handle('contacts:update', async (_e, contact) => {
    if (!contact || !contact.id) return { ok: false, error: 'contact.id required' };
    const all = store.load(STORE_KEY, []);
    const idx = all.findIndex(c => c.id === contact.id);
    if (idx > -1) {
      // Guard: if a slackId is being set, it must not collide with a DIFFERENT
      // active contact (prevents duplicate active contacts with the same id).
      if (contact.slackId) {
        const dup = all.find(c => c.id !== contact.id && c.slackId && String(c.slackId) === String(contact.slackId));
        if (dup) return { ok: false, error: 'another contact already has Slack ID ' + contact.slackId };
      }
      all[idx] = { ...all[idx], ..._sanitizeContact(contact) };
      store.save(STORE_KEY, all);
      return { ok: true };
    }
    return { ok: false, error: 'Contact not found' };
  });

  // Resolve a name/email to Slack directory candidates (never guesses). The
  // caller selects one, then links it to an existing contact via contacts:update
  // (setting slackId) or creates a new contact — no duplicate slackId allowed.
  handle('contacts:directory-search', async (_e, query) => {
    const q = String(query || '').trim();
    if (!q) return { ok: true, candidates: [] };
    try {
      const { searchDirectory } = require('../scrapers/slack_send');
      const results = await searchDirectory(q, 10);
      return { ok: true, candidates: Array.isArray(results) ? results : [] };
    } catch (e) { return { ok: false, error: e.message, candidates: [] }; }
  });

  // Link a Slack user ID to an EXISTING contact without creating a duplicate.
  handle('contacts:link-slack', async (_e, data) => {
    if (!data || !data.contactId || !data.slackId) return { ok: false, error: 'contactId and slackId required' };
    const all = store.load(STORE_KEY, []);
    const dup = all.find(c => c.id !== data.contactId && c.slackId && String(c.slackId) === String(data.slackId));
    if (dup) return { ok: false, error: 'Slack ID already linked to another contact' };
    const c = all.find(x => x.id === data.contactId);
    if (!c) return { ok: false, error: 'contact not found' };
    c.slackId = data.slackId; if (data.name && !c.name) c.name = data.name; c.updatedAt = new Date().toISOString();
    store.save(STORE_KEY, all);
    return { ok: true };
  });

  // The FAS "Sender Profiles" view is now just a filtered Contact Book view:
  // return each contact that has a slackId, with its RESOLVED FAS permissions
  // + a plain-language summary. Editing happens on the contact itself.
  handle('contacts:get-fas-view', async () => {
    const all = store.load(STORE_KEY, []);
    let profiles; try { profiles = require('../orcha/fas/sender-profiles'); } catch (_) { return []; }
    return all.filter(c => c.slackId).map(c => {
      const p = profiles.resolveSender(c.slackId, c.name);
      return { contactId: c.id, slackId: c.slackId, name: c.name || c.slackId,
        identityType: p.type, enabled: p.enabled !== false, operators: p.operators, domiciles: p.domiciles,
        allowedDataCategories: p.allowedDataCategories, permittedRequestTypes: p.permittedRequestTypes,
        permissionSource: c.permissionSource || p.source, summary: profiles.permissionSummary(p) };
    });
  });

  // Run the versioned, idempotent migration from slackSenderProfiles -> contacts.
  handle('contacts:migrate-sender-profiles', async () => {
    try { return require('../orcha/fas/sender-profiles').migrateSenderProfilesToContacts(); }
    catch (e) { return { error: e.message }; }
  });

  handle('contacts:delete', async (_e, id) => {
    let all = store.load(STORE_KEY, []);
    const gone = all.find(c => c.id === id);
    all = all.filter(c => c.id !== id);
    store.save(STORE_KEY, all);
    // Tombstone: record that this contact (and its FAS authorization) was
    // removed, so there's an audit trail. Deleting immediately revokes access
    // because resolveSender no longer finds the contact.
    if (gone && gone.slackId) {
      try {
        const tomb = store.load('contactsTombstones', []);
        const arr = Array.isArray(tomb) ? tomb : [];
        arr.unshift({ id: gone.id, slackId: gone.slackId, name: gone.name || '', deletedAt: new Date().toISOString() });
        store.save('contactsTombstones', arr.slice(0, 200));
      } catch (_) {}
    }
    return { ok: true };
  });

  handle('contacts:search', async (_e, query) => {
    const all = store.load(STORE_KEY, []);
    const q = (query || '').toLowerCase();
    if (!q) return all;
    return all.filter(c =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.company || '').toLowerCase().includes(q) ||
      (c.slackId || '').toLowerCase().includes(q) ||
      (c.role || '').toLowerCase().includes(q)
    );
  });

  // Vendor Assignments — tracks which specific Contact Book vendor a unit's
  // Dealer WO was routed to, so the Dealer WO modal can auto-route away from
  // an already-loaded preferred vendor (>= 3 units) to the next preference.
  // One active entry per unitId (upsert replaces any prior entry for that unit).
  handle('vendor-assignments:get-all', async () => {
    return store.load(ASSIGN_KEY, []);
  });

  handle('vendor-assignments:upsert', async (_e, entry) => {
    if (!entry || !entry.unitId || !entry.vendorId) return { ok: false, error: 'unitId and vendorId required' };
    const all = store.load(ASSIGN_KEY, []).filter(a => a.unitId !== entry.unitId);
    all.push({
      unitId:     entry.unitId,
      vendorId:   entry.vendorId,
      vendorName: entry.vendorName || '',
      make:       entry.make || '',
      site:       entry.site || '',
      ts:         Date.now(),
    });
    store.save(ASSIGN_KEY, all);
    return { ok: true };
  });

  handle('vendor-assignments:remove', async (_e, unitId) => {
    const all = store.load(ASSIGN_KEY, []).filter(a => a.unitId !== unitId);
    store.save(ASSIGN_KEY, all);
    return { ok: true };
  });
}

module.exports = { registerContactsHandlers };
