'use strict';
/**
 * src/ai/memory.js — Unified AI Core durable memory (spec #4).
 *
 * A retrieval-oriented memory service that UNIFIES the useful long-term AI
 * memory currently spread across several stores, and adds a place to persist
 * NET-NEW concise structured memories — without disturbing the existing
 * writers.
 *
 * Categories (spec #4):
 *   unit, vendor, site, workflow, correction, operator_preference, contact_comm
 *
 * SOURCES (read-only unless this service owns them):
 *   - correction / vendor memory   <- orcha/learn (orchaCorrections, orchaVendorRules)
 *   - unit memory                  <- orcha/fas/case-store (fasCases) [best-effort]
 *   - vendor history               <- vendorHistory store [best-effort]
 *   - net-new ai_inferred / operator_confirmed memories <- aiMemory store (owned here)
 *
 * INVARIANTS (spec #4):
 *   - Do NOT blindly save whole conversations — only concise, structured,
 *     operationally-valuable memories.
 *   - AI-generated memory is DISTINGUISHABLE from operator-confirmed memory
 *     (origin field), and operator corrections OUTRANK AI-inferred memory.
 *   - Memory is retrieved only when RELEVANT to the current task/entities.
 *
 * Everything is best-effort and guarded; memory must never break a request.
 */

const store = require('../store');
let logger; try { logger = require('../utils/logger').createLogger('ai-memory'); } catch (_) { logger = { info() {}, warn() {} }; }

const STORE_KEY = 'aiMemory';
const CAP = 2000;

const CATEGORIES = ['unit', 'vendor', 'site', 'workflow', 'correction', 'operator_preference', 'contact_comm'];
const ORIGINS = ['operator_confirmed', 'ai_inferred'];

function _now() { return new Date().toISOString(); }
function _id() { return 'mem_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function _load() { const r = store.load(STORE_KEY, []); return Array.isArray(r) ? r : []; }
function _save(arr) { try { store.save(STORE_KEY, arr.slice(0, CAP)); } catch (e) { logger.warn('[ai-memory] save failed: ' + e.message); } }

/**
 * remember(mem) -> { ok, id?, error? }
 * Persist a CONCISE structured memory in the owned store. Rejects bloated/
 * conversation-dump content (spec: never store whole conversations). Required:
 * { type (category), entity, fact }. Optional: source, confidence, origin.
 *
 * origin defaults to 'ai_inferred'. Only an explicit operator action should set
 * origin 'operator_confirmed' (callers pass it when the operator confirms).
 */
function remember(mem) {
  mem = mem || {};
  const type = CATEGORIES.includes(mem.type) ? mem.type : null;
  if (!type) return { ok: false, error: 'invalid memory category: ' + mem.type };
  const entity = (mem.entity != null && String(mem.entity).trim()) ? String(mem.entity).trim() : null;
  if (!entity) return { ok: false, error: 'entity required' };
  const fact = (typeof mem.fact === 'string') ? mem.fact.trim() : '';
  if (!fact) return { ok: false, error: 'fact required' };
  // Guard against whole-conversation dumps — memories must be concise.
  if (fact.length > 400) return { ok: false, error: 'fact too long (max 400 chars) — store a concise memory, not a transcript' };

  const origin = ORIGINS.includes(mem.origin) ? mem.origin : 'ai_inferred';
  const confidence = typeof mem.confidence === 'number' ? Math.max(0, Math.min(1, mem.confidence)) : (origin === 'operator_confirmed' ? 1 : 0.6);

  const arr = _load();
  // Dedupe: same type+entity+fact -> update (confirm/refresh) instead of adding.
  const key = type + '|' + entity.toLowerCase() + '|' + fact.toLowerCase();
  const existing = arr.find((m) => (m.type + '|' + String(m.entity).toLowerCase() + '|' + String(m.fact).toLowerCase()) === key);
  if (existing) {
    // An operator confirmation UPGRADES an ai_inferred memory; never downgrade.
    if (origin === 'operator_confirmed') { existing.origin = 'operator_confirmed'; existing.confidence = Math.max(existing.confidence || 0, confidence); }
    existing.lastConfirmedAt = _now();
    if (mem.source) existing.source = String(mem.source).slice(0, 80);
    _save(arr);
    return { ok: true, id: existing.id, updated: true };
  }

  const rec = {
    id: _id(),
    type, entity, fact,
    source: mem.source ? String(mem.source).slice(0, 80) : (origin === 'operator_confirmed' ? 'operator' : 'ai'),
    origin,
    confidence,
    createdAt: _now(),
    lastConfirmedAt: origin === 'operator_confirmed' ? _now() : null,
  };
  arr.unshift(rec);
  _save(arr);
  return { ok: true, id: rec.id };
}

/**
 * confirm(id) -> boolean — operator confirms an ai_inferred memory, upgrading
 * its origin to operator_confirmed (so it outranks other AI memory thereafter).
 */
function confirm(id) {
  const arr = _load();
  const m = arr.find((x) => x.id === id);
  if (!m) return false;
  m.origin = 'operator_confirmed';
  m.confidence = Math.max(m.confidence || 0, 1);
  m.lastConfirmedAt = _now();
  _save(arr);
  return true;
}

/** forget(id) -> boolean */
function forget(id) {
  const arr = _load();
  const next = arr.filter((x) => x.id !== id);
  if (next.length === arr.length) return false;
  _save(next);
  return true;
}

// ── RETRIEVAL ────────────────────────────────────────────────────────────────
// Pull memories relevant to the current task/entities from BOTH the owned store
// and the existing sources, normalize to one shape, and rank with
// operator_confirmed ABOVE ai_inferred (spec #4 precedence).

function _norm(type, entity, fact, origin, source, confidence, extra) {
  return {
    type, entity: String(entity || ''), fact: String(fact || ''),
    origin: ORIGINS.includes(origin) ? origin : 'ai_inferred',
    source: source || null,
    confidence: typeof confidence === 'number' ? confidence : null,
    ...(extra || {}),
  };
}

// Owned store memories matching the query.
function _fromOwned(q) {
  const arr = _load();
  const units = (q.units || []).map((u) => String(u).toLowerCase());
  const vendors = (q.vendors || []).map((v) => String(v).toLowerCase());
  const sites = (q.sites || []).map((s) => String(s).toLowerCase());
  return arr.filter((m) => {
    const e = String(m.entity || '').toLowerCase();
    if (m.type === 'unit') return units.includes(e);
    if (m.type === 'vendor') return vendors.some((v) => v && (e.includes(v) || v.includes(e)));
    if (m.type === 'site') return sites.includes(e);
    // workflow / operator_preference / contact_comm are generally relevant.
    return (q.includeGlobal !== false);
  }).map((m) => _norm(m.type, m.entity, m.fact, m.origin, m.source, m.confidence, { id: m.id, createdAt: m.createdAt, lastConfirmedAt: m.lastConfirmedAt }));
}

// Correction memory from orcha/learn (operator corrections => operator_confirmed).
function _fromCorrections(q) {
  let learn; try { learn = require('../orcha/learn'); } catch (_) { return []; }
  let data; try { data = learn.loadCorrections(); } catch (_) { return []; }
  const units = (q.units || []).map((u) => String(u).toLowerCase());
  const out = [];
  (data && data.corrections ? data.corrections : []).slice(-50).forEach((c) => {
    const relevant = !units.length || units.includes(String(c.unitId || '').toLowerCase());
    if (!relevant) return;
    out.push(_norm('correction', c.unitId || c.field,
      `${c.field}: chose "${c.userChose}" over "${c.orchaSuggested}"` + (c.context && c.context.domicile ? ` (${c.context.domicile})` : ''),
      'operator_confirmed', 'operator_correction', 0.95, { at: c.timestamp }));
  });
  return out;
}

// Vendor-rule memory from orcha/learn (learned preferences => operator-derived).
function _fromVendorRules(q) {
  let learn; try { learn = require('../orcha/learn'); } catch (_) { return []; }
  let rules; try { rules = learn.loadVendorRules(); } catch (_) { return []; }
  const out = [];
  const sites = (q.sites || []).map((s) => String(s).toUpperCase());
  const dv = (rules && rules.domicileVendors) || {};
  Object.keys(dv).forEach((dom) => {
    if (sites.length && !sites.includes(String(dom).toUpperCase())) return;
    const top = Object.entries(dv[dom]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1])[0];
    if (top) out.push(_norm('vendor', top[0], `preferred vendor at ${dom}`, 'operator_confirmed', 'learned_preference', 0.8, { site: dom }));
  });
  return out;
}

// Unit case memory from FAS case-store (operational case summary/promises).
function _fromCases(q) {
  let caseStore; try { caseStore = require('../orcha/fas/case-store'); } catch (_) { return []; }
  const out = [];
  (q.units || []).forEach((u) => {
    let c; try { c = caseStore.getCase(caseStore.caseIdForUnit(u)); } catch (_) { c = null; }
    if (!c) return;
    if (c.currentSummary) out.push(_norm('unit', u, String(c.currentSummary).slice(0, 300), 'operator_confirmed', 'fas_case', 0.85, { caseId: c.caseId, status: c.status }));
    (c.promises || []).slice(-3).forEach((p) => out.push(_norm('unit', u, 'promise: ' + String(p.text).slice(0, 160), 'operator_confirmed', 'fas_case', 0.85)));
  });
  return out;
}

/**
 * retrieve(query, opts) -> ranked, deduped memories relevant to the query.
 * query: { units?, vendors?, sites?, includeGlobal? }
 * opts:  { limit?, categories?, minConfidence? }
 *
 * Ranking: operator_confirmed before ai_inferred, then by confidence desc, then
 * recency. Only RELEVANT memories (matching the entities) are returned; global
 * categories (workflow/operator_preference/contact_comm) included unless
 * includeGlobal is false.
 */
function retrieve(query, opts) {
  query = query || {};
  opts = opts || {};
  let all = [];
  try { all = all.concat(_fromOwned(query)); } catch (_) {}
  try { all = all.concat(_fromCorrections(query)); } catch (_) {}
  try { all = all.concat(_fromVendorRules(query)); } catch (_) {}
  try { all = all.concat(_fromCases(query)); } catch (_) {}

  // Category filter.
  if (Array.isArray(opts.categories) && opts.categories.length) {
    all = all.filter((m) => opts.categories.includes(m.type));
  }
  if (typeof opts.minConfidence === 'number') {
    all = all.filter((m) => (m.confidence == null) || m.confidence >= opts.minConfidence);
  }

  // Dedupe by type+entity+fact; when duplicates exist, keep the higher-ranked
  // origin (operator_confirmed wins).
  const seen = new Map();
  for (const m of all) {
    const k = m.type + '|' + m.entity.toLowerCase() + '|' + m.fact.toLowerCase();
    const prior = seen.get(k);
    if (!prior || _rank(m) > _rank(prior)) seen.set(k, m);
  }
  const deduped = Array.from(seen.values());

  deduped.sort((a, b) => {
    const r = _rank(b) - _rank(a);
    if (r !== 0) return r;
    const at = (x) => Date.parse(x.lastConfirmedAt || x.createdAt || x.at || 0) || 0;
    return at(b) - at(a);
  });

  return deduped.slice(0, Math.max(1, opts.limit || 20));
}

// Rank score: operator_confirmed memories always outrank ai_inferred (spec #4),
// then higher confidence wins.
function _rank(m) {
  const originScore = m.origin === 'operator_confirmed' ? 1000 : 0;
  const conf = typeof m.confidence === 'number' ? m.confidence : 0.5;
  return originScore + conf * 100;
}

/**
 * retrieveContext(query, opts) -> a compact text block for prompt injection.
 * Operator-confirmed memories are clearly marked so the model weights them over
 * AI-inferred ones. Returns '' when nothing relevant.
 */
function retrieveContext(query, opts) {
  const mems = retrieve(query, opts);
  if (!mems.length) return '';
  return mems.map((m) => {
    const tag = m.origin === 'operator_confirmed' ? '[operator-confirmed]' : '[ai-inferred]';
    return `- ${tag} (${m.type}/${m.entity}) ${m.fact}`;
  }).join('\n');
}

module.exports = { remember, confirm, forget, retrieve, retrieveContext, CATEGORIES, ORIGINS, STORE_KEY };
