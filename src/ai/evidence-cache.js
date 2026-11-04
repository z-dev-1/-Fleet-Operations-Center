'use strict';
/**
 * src/ai/evidence-cache.js — Digital FAS Phase 6: dedup cache for processed
 * attachments / URLs (spec #56/#62).
 *
 * Reading a shared PDF/image through vision, or fetching + parsing a URL, is
 * expensive (latency + model cost). The SAME evidence often re-appears: a
 * follow-up message in the same thread, a re-posted screenshot, a link shared
 * twice. This cache stores the EXTRACTED RESULT keyed by a stable signature so
 * identical evidence is not re-processed (spec #62). It stores only the compact
 * extraction (summary/entities/structured fields + provenance) — never the raw
 * bytes.
 *
 * Keys:
 *   - Slack file:  'file:' + fileId (+ ':' + size when available)
 *   - URL:         'url:'  + normalized url
 *   - content:     'hash:' + sha256(bytes/text)  (when no stable id exists)
 *
 * Freshness: entries carry retrievedAt + a TTL. A stale URL entry is re-fetched
 * (web content changes); a file keyed by immutable fileId+size effectively
 * never goes stale (its bytes can't change), but still respects a long TTL.
 */

const crypto = require('crypto');
let store; try { store = require('../store'); } catch (_) { store = null; }
let logger; try { logger = require('../utils/logger').createLogger('evidence-cache'); } catch (_) { logger = { info() {}, warn() {} }; }

const STORE_KEY = 'aiEvidenceCache';
const CAP = 500;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;      // files: long (bytes immutable)
const URL_TTL_MS = 6 * 60 * 60 * 1000;               // URLs: shorter (content changes)

function _now() { return Date.now(); }
function _load() { if (!store) return []; const r = store.load(STORE_KEY, []); return Array.isArray(r) ? r : []; }
function _save(arr) { if (!store) return; try { store.save(STORE_KEY, arr.slice(0, CAP)); } catch (e) { logger.warn('[evidence-cache] save failed: ' + e.message); } }

/** sha256 of a Buffer or string — the content-signature fallback key. */
function hashContent(data) {
  try {
    const h = crypto.createHash('sha256');
    h.update(Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8'));
    return 'hash:' + h.digest('hex').slice(0, 32);
  } catch (_) { return null; }
}

function fileKey(file) {
  if (!file) return null;
  const id = file.id || file.fileId;
  if (id) return 'file:' + id + (file.size ? (':' + file.size) : '');
  return null; // caller should fall back to hashContent(bytes)
}

function urlKey(url) {
  if (!url) return null;
  // Normalize: strip trailing slash + fragment for a stable key.
  const u = String(url).trim().replace(/#.*$/, '').replace(/\/$/, '');
  return 'url:' + u;
}

/**
 * get(key, opts) -> cached entry | null
 * Returns the cached extraction if present AND fresh. opts.ttlMs overrides the
 * default; URL keys use the shorter URL TTL unless overridden.
 */
function get(key, opts) {
  if (!key) return null;
  opts = opts || {};
  const arr = _load();
  const e = arr.find(x => x.key === key);
  if (!e) return null;
  const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : (key.startsWith('url:') ? URL_TTL_MS : DEFAULT_TTL_MS);
  const age = _now() - (Date.parse(e.cachedAt) || 0);
  if (age > ttl) return null; // stale -> treat as miss (caller re-processes)
  return e;
}

/**
 * put(key, extraction) -> entry
 * Store a COMPACT extraction result. `extraction` should be the normalized
 * output ({ summary, entities, fields, confidence, source, kind, ... }) — NOT
 * raw bytes. Idempotent: re-putting the same key refreshes cachedAt.
 */
function put(key, extraction) {
  if (!key || !store) return null;
  const arr = _load();
  const rec = {
    key,
    kind: (extraction && extraction.kind) || 'unknown',
    extraction: _compact(extraction),
    cachedAt: new Date().toISOString(),
  };
  const idx = arr.findIndex(x => x.key === key);
  if (idx > -1) arr[idx] = rec; else arr.unshift(rec);
  _save(arr);
  return rec;
}

// Keep only the compact extraction fields; never persist raw bytes/base64.
function _compact(extraction) {
  if (!extraction || typeof extraction !== 'object') return {};
  const out = {};
  for (const k of ['summary', 'entities', 'fields', 'documentType', 'imageType', 'observations', 'confidence', 'source', 'kind', 'units', 'excerpt']) {
    if (extraction[k] !== undefined) out[k] = extraction[k];
  }
  // Cap any excerpt so the cache never bloats with a transcript.
  if (typeof out.excerpt === 'string' && out.excerpt.length > 2000) out.excerpt = out.excerpt.slice(0, 2000);
  return out;
}

/** Clear the whole cache (test/maintenance). */
function clear() { if (store) _save([]); }

module.exports = { get, put, hashContent, fileKey, urlKey, clear, STORE_KEY, DEFAULT_TTL_MS, URL_TTL_MS };
