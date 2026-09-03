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
// ALL contact writes go through the ONE hardened service (dedupe, sanitize,
// no-blank-overwrite, contacts:updated event) — Part: hardened write paths.
const contactBook = require('../services/contact-book');

const STORE_KEY      = 'contacts';
const ASSIGN_KEY     = 'vendorAssignments';

function registerContactsHandlers() {
  handle('contacts:get-all', async () => {
    return store.load(STORE_KEY, []);
  });

  handle('contacts:save', async (_e, contacts) => contactBook.bulkSave(contacts));

  handle('contacts:add', async (_e, contact) => {
    if (!contact || typeof contact !== 'object') return { ok: false, error: 'contact object required' };
    return contactBook.upsert(contact);
  });

  handle('contacts:update', async (_e, contact) => contactBook.update(contact));

  // Resolve a name/email to Slack directory candidates (never guesses). The
  // caller selects one, then links it to an existing contact via contacts:link-slack
  // or creates a new contact — no duplicate slackId allowed (case-insensitive).
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
  handle('contacts:link-slack', async (_e, data) => contactBook.linkSlack(data || {}));

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
        lifecyclePermission: p.lifecyclePermission || 'not_allowed',
        createWrPermission: p.createWrPermission || 'not_allowed',
        permissionSource: c.permissionSource || p.source, summary: profiles.permissionSummary(p) };
    });
  });

  // Run the versioned, idempotent migration from slackSenderProfiles -> contacts.
  handle('contacts:migrate-sender-profiles', async () => {
    try { return require('../orcha/fas/sender-profiles').migrateSenderProfilesToContacts(); }
    catch (e) { return { error: e.message }; }
  });

  handle('contacts:delete', async (_e, id) => contactBook.remove(id));

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
