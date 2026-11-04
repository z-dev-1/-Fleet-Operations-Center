'use strict';
/**
 * src/ai/entity-context.js — entity-centric retrieval (spec §5).
 *
 * For structured fleet data we retrieve ENTITY-FIRST, not via generic RAG.
 * When a unit is referenced, build a compact entity context from authoritative
 * structured sources (via the normalized tool platform), reconcile cross-source
 * conflicts with field-specific authority (src/ai/authority), and attach
 * relevant durable memories. Documents/notes semantic search is a SECONDARY
 * method (not built here; memory + notes tools cover the current needs).
 *
 * Preferred retrieval order (spec §5):
 *   structured lookup -> entity relationship lookup -> memory -> (semantic docs)
 *
 * Respects sender scope: every tool call passes ctx.profile, so an out-of-scope
 * unit simply yields denied/empty facts — never widened here.
 */

const tools = require('./tools');
const authority = require('./authority');
let memory; try { memory = require('./memory'); } catch (_) { memory = null; }
let logger; try { logger = require('../utils/logger').createLogger('ai-entity-context'); } catch (_) { logger = { info() {}, warn() {} }; }

// The structured read tools that compose a unit's entity context. These are the
// independent-per-unit reads the loop would otherwise request across turns —
// here we gather them in one bounded parallel batch (spec §14).
const UNIT_TOOLS = [
  'get_unit',
  'get_open_work_orders',
  'get_pm_status',
  'get_repair_timeline',
  'get_uptake_insights',
  'get_offsite_event',
];

/**
 * buildUnitContext(unit, ctx, opts) -> {
 *   equipmentId, resolved (field->resolved), conflicts, evidence (envelopes),
 *   relevantMemories, freshness (summary), sources, denied
 * }
 * ctx: { profile }  (resolved sender). opts.tools overrides the tool set;
 * opts.concurrency bounds parallelism; opts.signal aborts.
 */
async function buildUnitContext(unit, ctx, opts) {
  opts = opts || {};
  const equipmentId = String(unit || '').trim();
  const out = {
    equipmentId,
    resolved: {},
    conflicts: [],
    evidence: [],
    relevantMemories: [],
    freshness: {},
    sources: [],
    denied: false,
  };
  if (!equipmentId) return out;
  if (!ctx || !ctx.profile) { out.error = 'sender profile required'; return out; }

  const toolNames = Array.isArray(opts.tools) && opts.tools.length ? opts.tools : UNIT_TOOLS;
  const concurrency = Math.max(1, opts.concurrency || 4);
  const signal = opts.signal || null;

  // Parallel structured lookups (bounded).
  const envelopes = await _parallel(toolNames.map((name) => () => _safeExec(name, { unit: equipmentId }, ctx)), concurrency, signal);
  out.evidence = envelopes.filter(Boolean);

  // A unit entirely out of scope => every unit tool denied. Surface that.
  out.denied = out.evidence.length > 0 && out.evidence.every((e) => e && e.denied);

  // Reconcile cross-source fields with field-specific authority.
  const rec = authority.reconcile(out.evidence);
  out.resolved = rec.fields;
  out.conflicts = rec.conflicts;

  // Freshness + source roll-up.
  for (const e of out.evidence) {
    if (!e || !e.ok) continue;
    if (e.source && !out.sources.includes(e.source)) out.sources.push(e.source);
    out.freshness[e.tool] = e.freshness;
  }

  // Relevant durable memories for this unit (entity-centric; spec §5 step 3).
  if (memory && typeof memory.retrieve === 'function') {
    try { out.relevantMemories = memory.retrieve({ units: [equipmentId], includeGlobal: false }, { limit: 6 }); }
    catch (_) { out.relevantMemories = []; }
  }

  return out;
}

/**
 * compact(context) -> a small, grounding-friendly object for prompt assembly.
 * Only resolved authoritative values + explicit conflicts + memory headlines.
 */
function compact(context) {
  if (!context) return null;
  const fields = {};
  for (const [field, r] of Object.entries(context.resolved || {})) {
    fields[field] = { value: r.value, source: r.source, freshness: r.freshness, conflict: !!r.conflict };
  }
  return {
    equipmentId: context.equipmentId,
    fields,
    conflicts: (context.conflicts || []).map((c) => ({ field: c.field, candidates: c.candidates })),
    memories: (context.relevantMemories || []).map((m) => ({ origin: m.origin, type: m.type, fact: m.fact })),
    sources: context.sources || [],
    denied: !!context.denied,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function _safeExec(name, args, ctx) {
  try { return await tools.execute(name, args, ctx); }
  catch (e) { logger.warn('[ai-entity-context] ' + name + ' threw: ' + e.message); return { ok: false, tool: name, error: e.message, freshness: 'UNKNOWN', confidence: 0 }; }
}

// Bounded-concurrency runner over an array of thunks, abort-aware.
async function _parallel(thunks, concurrency, signal) {
  const results = new Array(thunks.length);
  let i = 0;
  async function worker() {
    while (i < thunks.length) {
      if (signal && signal.aborted) return;
      const idx = i++;
      results[idx] = await thunks[idx]();
    }
  }
  const n = Math.min(concurrency, thunks.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

module.exports = { buildUnitContext, compact, UNIT_TOOLS };
