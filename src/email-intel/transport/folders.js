'use strict';
/**
 * email-intel/transport/folders.js — configured folder label -> REST folder id (design 5.2).
 *
 *   createFolderResolver({ http, owaRe }) -> { resolve(label), labelOf(folderId), invalidate(label), wellKnownName(label) }
 *
 * Well-known labels (Inbox, Sent Items, Drafts, Deleted Items, Junk Email, Archive) resolve through the well-known
 * folder name. Any other label is split on '/' and matched segment by segment (DisplayName, case-insensitive,
 * trimmed) from the top-level list down through child folders, at most FOLDER_DEPTH_MAX levels and FOLDER_LIST_MAX
 * folders visited; a single-segment label also matches the first breadth-first hit. Results are cached per process.
 * A 404 during resolution invalidates the label and resolves once more. Unresolved -> 'not-found'.
 */
const { TC } = require('./constants');
const endpoints = require('./endpoints');
const { ApiHttpError } = require('./errors');

const WELL_KNOWN = Object.freeze({
  inbox: 'inbox', 'sent items': 'sentitems', sent: 'sentitems', drafts: 'drafts', 'deleted items': 'deleteditems',
  'junk email': 'junkemail', junk: 'junkemail', archive: 'archive',
});
const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();

function createFolderResolver(deps) {
  const d = deps || {};
  const http = d.http;
  const owaRe = d.owaRe || null;
  const cache = new Map();          // normalized label -> id | 'not-found'
  const labels = new Map();         // id -> label

  const wellKnownName = (label) => WELL_KNOWN[norm(label)] || null;

  async function _list(path, budget, spec) {
    const out = [];
    let p = path; let pages = 0;
    while (p && pages < 5 && budget.left > 0) {
      const r = await http.get(p, Object.assign({ op: 'folders' }, spec));
      pages++;
      const v = r && r.json && Array.isArray(r.json.value) ? r.json.value : [];
      for (const f of v) {
        if (budget.left <= 0) break;
        if (!f || typeof f.Id !== 'string' || !f.Id) continue;
        budget.left--;
        out.push({ id: f.Id, name: typeof f.DisplayName === 'string' ? f.DisplayName : '', children: Number.isFinite(f.ChildFolderCount) ? f.ChildFolderCount : 1 });
      }
      const next = r && r.json && r.json['@odata.nextLink'];
      p = next ? endpoints.rebaseNextLink(next, owaRe && owaRe.OUTLOOK_HOST_RE) : null;
    }
    return out;
  }

  async function _resolveOnce(label, spec) {
    const wk = wellKnownName(label);
    if (wk) {
      try {
        const r = await http.get(endpoints.wellKnown(wk), Object.assign({ op: 'folders' }, spec));
        const id = r && r.json && typeof r.json.Id === 'string' ? r.json.Id : null;
        return id || 'not-found';
      } catch (e) {
        if (e instanceof ApiHttpError && e.status === 404) return 'not-found';
        throw e;
      }
    }
    const segs = String(label || '').split('/').map((s) => norm(s)).filter(Boolean);
    if (!segs.length) return 'not-found';
    const budget = { left: TC.FOLDER_LIST_MAX };
    if (segs.length === 1) {
      // breadth-first over the tree
      let level = await _list(endpoints.folders(), budget, spec);
      for (let depth = 0; depth < TC.FOLDER_DEPTH_MAX && level.length; depth++) {
        const hit = level.find((f) => norm(f.name) === segs[0]);
        if (hit) return hit.id;
        if (depth === TC.FOLDER_DEPTH_MAX - 1) break;
        const next = [];
        for (const f of level) {
          if (budget.left <= 0) break;
          if (!f.children) continue;
          next.push(...(await _list(endpoints.childFolders(f.id), budget, spec)));
        }
        level = next;
      }
      return 'not-found';
    }
    if (segs.length > TC.FOLDER_DEPTH_MAX) return 'not-found';
    let list = await _list(endpoints.folders(), budget, spec);
    let id = null;
    for (let i = 0; i < segs.length; i++) {
      const hit = list.find((f) => norm(f.name) === segs[i]);
      if (!hit) return 'not-found';
      id = hit.id;
      if (i < segs.length - 1) list = await _list(endpoints.childFolders(hit.id), budget, spec);
    }
    return id || 'not-found';
  }

  async function resolve(label, spec) {
    const k = norm(label);
    if (cache.has(k)) return cache.get(k);
    let id;
    try {
      id = await _resolveOnce(label, spec);
    } catch (e) {
      if (!(e instanceof ApiHttpError && e.status === 404)) throw e;
      id = await _resolveOnce(label, spec);
    }
    if (id !== 'not-found') { cache.set(k, id); if (!labels.has(id)) labels.set(id, String(label)); }
    return id;
  }

  function labelOf(folderId) { return (typeof folderId === 'string' && labels.get(folderId)) || null; }
  function invalidate(label) {
    const k = norm(label);
    const id = cache.get(k);
    cache.delete(k);
    if (id && id !== 'not-found' && labels.get(id) === String(label)) labels.delete(id);
  }

  return { resolve, labelOf, invalidate, wellKnownName };
}

module.exports = { createFolderResolver, WELL_KNOWN };
