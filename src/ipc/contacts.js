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

const STORE_KEY = 'contacts';

function registerContactsHandlers() {
  handle('contacts:get-all', async () => {
    return store.load(STORE_KEY, []);
  });

  handle('contacts:save', async (_e, contacts) => {
    store.save(STORE_KEY, contacts || []);
    return { ok: true };
  });

  handle('contacts:add', async (_e, contact) => {
    const all = store.load(STORE_KEY, []);
    contact.id = contact.id || Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    all.push(contact);
    store.save(STORE_KEY, all);
    return { ok: true, id: contact.id };
  });

  handle('contacts:update', async (_e, contact) => {
    const all = store.load(STORE_KEY, []);
    const idx = all.findIndex(c => c.id === contact.id);
    if (idx > -1) {
      all[idx] = { ...all[idx], ...contact };
      store.save(STORE_KEY, all);
      return { ok: true };
    }
    return { ok: false, error: 'Contact not found' };
  });

  handle('contacts:delete', async (_e, id) => {
    let all = store.load(STORE_KEY, []);
    all = all.filter(c => c.id !== id);
    store.save(STORE_KEY, all);
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
}

module.exports = { registerContactsHandlers };
