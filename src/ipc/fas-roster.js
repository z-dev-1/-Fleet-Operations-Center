'use strict';
/**
 * ipc/fas-roster.js — FAS roster snapshot (scraped from the FAS roster page).
 *
 * Backs the "FAS Roster" view. The roster page
 * (https://fas.fieldmaintenance.roc.amazon.dev/roster) renders a table of FAS
 * personnel (FAS Name, Site Code, Email, Phone, Uptime Manager, Program,
 * SCAC). This fetches the FULL roster in-app (no manual export) and stores a
 * snapshot the renderer can display, filter, and export.
 *
 * Storage model (fasRoster store):
 *   {
 *     fetchedAt: ISO | null,
 *     columns:   [ ...header strings as scraped... ],
 *     rows:      [ { <header>: <value>, ... }, ... ]
 *   }
 */

const store  = require('../store');
const logger = require('../utils/logger')('ipc:fas-roster');
const { handle } = require('./_safe');

const MAX_ROWS   = 20000;
const MAX_FIELD  = 2000;
const MAX_COLS   = 60;

function _clip(v, max) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

const EMPTY = { fetchedAt: null, columns: [], rows: [] };

function registerFasRosterIPC() {
  // Return the current roster snapshot.
  handle('fas-roster:get', () => store.load('fasRoster', EMPTY));

  // Scrape BOTH roster sources (FAS web page + AFP-FAS SharePoint workbook),
  // merge them by (Site + SCAC), and store the combined snapshot.
  handle('fas-roster:fetch', async () => {
    const { fetchCombinedRoster } = require('../scrapers/fas_roster');
    const res = await fetchCombinedRoster({});
    if (!res || !res.ok) {
      logger.warn('FAS roster fetch failed: ' + (res && (res.error || res.detail)));
      return { ok: false, error: (res && (res.detail || res.error)) || 'FAS roster fetch failed' };
    }

    const columns = Array.isArray(res.columns)
      ? res.columns.slice(0, MAX_COLS).map((c) => _clip(c, 256))
      : [];
    const incoming = Array.isArray(res.rows) ? res.rows.slice(0, MAX_ROWS) : [];
    const rows = incoming.map((r) => {
      const obj = {};
      for (const col of columns) obj[col] = _clip(r && r[col], MAX_FIELD);
      return obj;
    });

    const data = { fetchedAt: new Date().toISOString(), columns, rows, sources: res.sources };
    store.save('fasRoster', data);
    logger.info('FAS roster stored: ' + rows.length + ' rows (web=' + (res.sources && res.sources.web) + ' sharepoint=' + (res.sources && res.sources.sharepoint) + ')');
    return { ok: true, count: rows.length, columns: columns.length, sources: res.sources };
  });

  // Resolve FAS names (and uptime managers) for a batch of (scac, site) pairs.
  // Used by the DBR renderer to fill its FAS column. Returns an array aligned
  // with the input: [{ fas, um }, ...].
  handle('fas-roster:resolve', (_e, pairs) => {
    const roster = require('../orcha/fas/roster-lookup');
    const list = Array.isArray(pairs) ? pairs : [];
    return list.map((p) => ({
      fas: roster.fasFor(p && p.scac, p && p.site),
      um:  roster.umFor(p && p.scac, p && p.site),
    }));
  });

  // Clear the stored snapshot.
  handle('fas-roster:clear', () => {
    store.save('fasRoster', { fetchedAt: null, columns: [], rows: [] });
    logger.info('FAS roster cleared');
    return { ok: true };
  });

  // Import the stored roster into the Contact Book. Each roster person becomes
  // an INTERNAL contact (identityType:'internal'), deduped by email so a
  // re-import updates the existing contact instead of creating duplicates.
  // Maps roster columns onto real contact fields:
  //   FAS Name       -> name
  //   Email          -> email  (also the dedupe key)
  //   Phone          -> phone
  //   Site Code      -> domiciles[] (FAS scope) + site
  //   SCAC           -> operators[]  (FAS scope)
  //   Program        -> program
  //   Uptime Manager -> uptimeManager
  // All original roster fields are also preserved under roster:{...} so no data
  // is lost.
  handle('fas-roster:import-contacts', (_e, payload) => {
    const data = store.load('fasRoster', EMPTY);
    const rows = (data && Array.isArray(data.rows)) ? data.rows : [];
    if (!rows.length) return { ok: false, error: 'No roster to import — fetch the roster first.' };

    const contactBook = require('../services/contact-book');
    const existing = store.load('contacts', []);
    const byEmail = new Map();
    for (const c of (Array.isArray(existing) ? existing : [])) {
      const em = String((c && c.email) || '').trim().toLowerCase();
      if (em) byEmail.set(em, c);
    }

    // Case-insensitive column getter (headers vary slightly).
    const get = (row, names) => {
      const keys = Object.keys(row || {});
      for (const n of names) {
        const k = keys.find((kk) => kk.toLowerCase() === n.toLowerCase());
        if (k && String(row[k]).trim() !== '') return String(row[k]).trim();
      }
      return '';
    };

    let created = 0, updated = 0, skipped = 0;
    for (const r of rows) {
      const email = get(r, ['Email', 'email']).toLowerCase();
      const name  = get(r, ['FAS Name', 'Name']);
      if (!email && !name) { skipped++; continue; }

      const site = get(r, ['Site Code', 'Site', 'Domicile']);
      const scac = get(r, ['SCAC']);
      const contact = {
        type: 'person',
        identityType: 'internal',
        name: name || email,
        email: email || '',
        phone: get(r, ['Phone']),
        site,
        program: get(r, ['Program']),
        uptimeManager: get(r, ['Uptime Manager', 'Uptime Mgr', 'Manager']),
        domiciles: site ? [site] : [],
        operators: scac ? [scac] : [],
        source: 'fas-roster',
        roster: { ...r },
      };
      // Dedupe by email → pass the existing id so upsert MERGES (no duplicate).
      const match = email ? byEmail.get(email) : null;
      if (match && match.id) contact.id = match.id;

      const res = contactBook.upsert(contact);
      if (res && res.ok) { if (match) updated++; else created++; }
      else skipped++;
    }

    logger.info('FAS roster → contacts: created=' + created + ' updated=' + updated + ' skipped=' + skipped);
    return { ok: true, created, updated, skipped, total: rows.length };
  });

  logger.info('FAS roster IPC handlers registered');
}

module.exports = { registerFasRosterIPC };
