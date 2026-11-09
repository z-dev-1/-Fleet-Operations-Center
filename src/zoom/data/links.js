'use strict';
/**
 * src/zoom/data/links.js — link meetings / recordings to fleet units and carriers (design §11 + review F-2, A2).
 *
 *   linkTargets({kind, q})    distinct ids from store 'fleetData' rows (units: String(equipmentId);
 *                             carriers: String(operator).trim().toUpperCase()); ids failing the targetId
 *                             rule are EXCLUDED so they are never offered and then rejected; max 50
 *   link({key, kind, id})     id must be in the current target set; key must be a listed item or already linked
 *   unlink({key, kind, id})   removes the target; drops the entry when no targets remain
 *   links()                   every stored link
 *
 * Store 'zoomLinks': { version:1, links: { [key]: { topic, startIso, kind:'meeting'|'recording',
 * targets:[{kind, id, linkedAt}] } } }. At most 500 entries (oldest linkedAt evicted), 10 targets each.
 * Logs {op, kind, idHash} only (topics never logged).
 */
const { ZoomError, fail } = require('../errors');
const { safeErr, keyHash } = require('../redact');
const log = require('../../utils/logger')('zoom:data');

const MAX_TARGETS_RESULT = 50;
const MAX_LINKED_ITEMS = 500;
const MAX_TARGETS_PER_ITEM = 10;
const TOPIC_MAX = 200;

function _store() { return require('../../store'); }

const DEFAULT_DOC = () => ({ version: 1, links: {} });

function _normDoc(cur) {
  const d = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  const links = d.links && typeof d.links === 'object' && !Array.isArray(d.links) ? Object.assign({}, d.links) : {};
  return { version: 1, links };
}

/** _targetSet(kind) -> Set of valid ids | null when fleet data has no rows. */
function _targetSet(kind) {
  const fd = _store().load('fleetData', { rows: [] });
  const rows = fd && Array.isArray(fd.rows) ? fd.rows : [];
  if (!rows.length) return null;
  const { targetId } = require('../validate');
  const out = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const raw = kind === 'unit' ? r.equipmentId : r.operator;
    if (raw === null || raw === undefined) continue;
    const s = kind === 'unit' ? String(raw) : String(raw).trim().toUpperCase();
    if (!s) continue;
    try { out.add(targetId(s, kind)); } catch (_) { /* excluded: fails the targetId rule (review F-2) */ }
  }
  return out;
}

/** linkTargets({kind, q}) -> {ok:true, items:[{id, label}]} | FLEET_DATA_UNAVAILABLE */
async function linkTargets(input) {
  const kind = input.kind;
  const set = _targetSet(kind);
  if (!set) return fail('FLEET_DATA_UNAVAILABLE');
  const q = String(input.q || '').trim().toLowerCase();
  const ids = Array.from(set).filter((id) => !q || id.toLowerCase().includes(q));
  ids.sort((a, b) => {
    // Prefix matches first, then plain sort.
    if (q) { const pa = a.toLowerCase().startsWith(q); const pb = b.toLowerCase().startsWith(q); if (pa !== pb) return pa ? -1 : 1; }
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const items = ids.slice(0, MAX_TARGETS_RESULT).map((id) => ({ id, label: (kind === 'unit' ? 'Unit ' : 'Carrier ') + id }));
  return { ok: true, items };
}

function _logLink(op, kind, key) {
  try { log.info('[zoom] link', { op, kind, idHash: keyHash(key) }); } catch (_) {}
}

function _newest(entry) {
  let m = '';
  for (const t of (entry && Array.isArray(entry.targets) ? entry.targets : [])) if (t && typeof t.linkedAt === 'string' && t.linkedAt > m) m = t.linkedAt;
  return m;
}

/** link({key, kind, id}) -> {ok:true, link} | UNKNOWN_TARGET | NOT_FOUND | LIMIT_REACHED | FLEET_DATA_UNAVAILABLE */
async function link(input) {
  const { key, kind, id } = input;
  const set = _targetSet(kind);
  if (!set) return fail('FLEET_DATA_UNAVAILABLE');
  if (!set.has(id)) return fail('UNKNOWN_TARGET');
  const client = require('./client');
  const item = client.getItem(key);
  const itemKind = client.recordingByKey.has(key) ? 'recording' : 'meeting';
  let result = null;
  try {
    _store().update('zoomLinks', (cur) => {
      const d = _normDoc(cur);
      const prev = d.links[key];
      if (!item && !prev) throw new ZoomError('NOT_FOUND');
      const entry = prev && typeof prev === 'object'
        ? Object.assign({}, prev, { targets: Array.isArray(prev.targets) ? prev.targets.slice() : [] })
        : { topic: null, startIso: null, kind: itemKind, targets: [] };
      if (item) {
        entry.topic = typeof item.topic === 'string' ? item.topic.slice(0, TOPIC_MAX) : null;
        entry.startIso = typeof item.startIso === 'string' ? item.startIso : null;
        entry.kind = itemKind;
      }
      if (!entry.targets.some((t) => t && t.kind === kind && t.id === id)) {
        if (entry.targets.length >= MAX_TARGETS_PER_ITEM) throw new ZoomError('LIMIT_REACHED');
        entry.targets.push({ kind, id, linkedAt: new Date().toISOString() });
      }
      d.links[key] = entry;
      // Evict the entry with the oldest linkedAt past the item limit (never the one just written).
      while (Object.keys(d.links).length > MAX_LINKED_ITEMS) {
        let oldest = null; let oldestAt = null;
        for (const k of Object.keys(d.links)) {
          if (k === key) continue;
          const at = _newest(d.links[k]);
          if (oldest === null || at < oldestAt) { oldest = k; oldestAt = at; }
        }
        if (oldest === null) break;
        delete d.links[oldest];
      }
      result = entry;
      return d;
    }, DEFAULT_DOC());
  } catch (e) {
    if (e instanceof ZoomError) throw e;
    log.warn('[zoom] link store', safeErr(e));
    return fail('IO_ERROR');
  }
  _logLink('link', kind, key);
  return { ok: true, link: result };
}

/** unlink({key, kind, id}) -> {ok:true, link|null} */
async function unlink(input) {
  const { key, kind, id } = input;
  let result = null;
  try {
    _store().update('zoomLinks', (cur) => {
      const d = _normDoc(cur);
      const prev = d.links[key];
      if (!prev || typeof prev !== 'object') { result = null; return d; }
      const targets = (Array.isArray(prev.targets) ? prev.targets : []).filter((t) => !(t && t.kind === kind && t.id === id));
      if (!targets.length) { delete d.links[key]; result = null; } else { result = Object.assign({}, prev, { targets }); d.links[key] = result; }
      return d;
    }, DEFAULT_DOC());
  } catch (e) {
    log.warn('[zoom] unlink store', safeErr(e));
    return fail('IO_ERROR');
  }
  _logLink('unlink', kind, key);
  return { ok: true, link: result };
}

/** links() -> {ok:true, links} */
async function links() {
  const d = _normDoc(_store().load('zoomLinks', DEFAULT_DOC()));
  return { ok: true, links: d.links };
}

module.exports = { linkTargets, link, unlink, links, MAX_LINKED_ITEMS, MAX_TARGETS_PER_ITEM };
