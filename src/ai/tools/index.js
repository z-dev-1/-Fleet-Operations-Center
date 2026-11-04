'use strict';
/**
 * src/ai/tools/index.js — Normalized AI tool platform (spec §2, §3).
 *
 * A clean tool CATALOG the AI Core agent loop sees, INDEPENDENT of the
 * underlying implementation. It does NOT duplicate the Digital FAS read tools —
 * it ADAPTS them (orcha/fas/tool-registry.runTool), preserving the permission
 * scoping + arg validation already enforced there, and NORMALIZES every result
 * into a consistent provenance envelope (spec §3):
 *
 *   { ok, tool, entity, source, retrievedAt, freshness, confidence, data, error? }
 *
 * Each catalog entry declares:
 *   { name, description, inputSchema, outputSchema, risk, requiredPermission,
 *     freshnessPolicy, execute }
 *
 * SAFETY: this is a READ-ONLY platform. Actions remain with the Digital FAS
 * executor (spec invariant: AI proposes, FAS executes). `execute` here only
 * ever calls the FAS READ registry, which enforces sender scope/category in
 * code BEFORE any data is returned — the AI can never widen that here.
 */

let fasTools; try { fasTools = require('../../orcha/fas/tool-registry'); } catch (_) { fasTools = null; }
let logger; try { logger = require('../../utils/logger').createLogger('ai-tools'); } catch (_) { logger = { info() {}, warn() {} }; }

const now = () => new Date().toISOString();

// Freshness classification (spec §3/§15). A fact is LIVE/RECENT/STALE/UNKNOWN
// based on the FAS fact's own staleness signal when present.
function _freshnessOf(facts, fallback) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return fallback || 'UNKNOWN';
  const anyStale = list.some((f) => f && f.stale === true);
  if (anyStale) return 'STALE';
  const anySourceTime = list.some((f) => f && (f.sourceUpdatedAt || f.ageMs != null));
  // A source-timestamped, non-stale cache fact is RECENT; a plain fleetData
  // fact with only retrievedAt is treated as LIVE (reflects the last sync).
  return anySourceTime ? 'RECENT' : (fallback || 'LIVE');
}

// Build the normalized provenance envelope from a raw FAS tool result.
function _normalize(name, entity, raw) {
  if (!raw || raw.ok !== true) {
    return {
      ok: false,
      tool: name,
      entity: entity || null,
      source: null,
      retrievedAt: now(),
      freshness: 'UNKNOWN',
      confidence: 0,
      denied: !!(raw && raw.denied),
      error: (raw && raw.error) || 'tool failed',
    };
  }
  const facts = Array.isArray(raw.verifiedFacts) ? raw.verifiedFacts : [];
  // Primary source = the most common source tag among facts, else a summary tag.
  const srcCounts = {};
  facts.forEach((f) => { if (f && f.source) srcCounts[f.source] = (srcCounts[f.source] || 0) + 1; });
  const source = Object.keys(srcCounts).sort((a, b) => srcCounts[b] - srcCounts[a])[0] || (raw.summary ? 'aggregate' : null);
  const freshness = _freshnessOf(facts);
  // Confidence: live/recent verified facts => high; stale => reduced; summary-
  // only => moderate. This is a SOURCE-grounded confidence, not model opinion.
  let confidence = facts.length ? (freshness === 'STALE' ? 0.6 : 0.95) : (raw.summary ? 0.7 : 0.5);
  return {
    ok: true,
    tool: name,
    entity: entity || null,
    source,
    retrievedAt: raw.retrievedAt || now(),
    freshness,
    confidence,
    data: {
      facts: facts.map((f) => ({ field: f.field, value: f.value, source: f.source || null, retrievedAt: f.retrievedAt || null, stale: f.stale === true ? true : (f.stale === false ? false : null) })),
      summary: raw.summary || null,
      syncedAt: raw.syncedAt || null,
    },
  };
}

// Freshness policy per tool: how a consumer should treat this tool's data.
//   'live'       — reflects the last authoritative sync; treat as current.
//   'cache'      — source-cached (e.g. relay); may be stale, honor stale flag.
//   'historical' — intentionally historical (vendor history); old is expected.
//   'derived'    — computed/aggregated from other sources.
const FRESHNESS = { LIVE: 'live', CACHE: 'cache', HISTORICAL: 'historical', DERIVED: 'derived' };

// A minimal input-schema helper (field -> required?). Mirrors arg-schema's
// real validation, which still runs inside runTool — this is for the catalog
// surface the planner reads.
const UNIT = { unit: { type: 'string', required: true } };

/**
 * CATALOG — the normalized tool definitions. `fasTool` names the underlying
 * Digital FAS read tool the adapter wraps; `entityArg` names the arg used as
 * the provenance `entity`. requiredPermission maps to the FAS data category the
 * underlying tool already enforces (documented here for the planner; NOT a
 * second enforcement point — the FAS registry is authoritative).
 */
const CATALOG = {
  // ── FLEET ──────────────────────────────────────────────────────────────
  get_unit:              { fasTool: 'GET_UNIT',              entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'unit_status',   freshnessPolicy: FRESHNESS.LIVE,  description: 'Core fleet record for a unit: lifecycle state/reason, operator, domicile, vendor, days down.' },
  get_canonical_state:   { fasTool: 'GET_UNIT',              entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'unit_status',   freshnessPolicy: FRESHNESS.DERIVED, description: 'Reconciled canonical operational state for a unit.' },
  search_fleet:          { fasTool: 'GET_SITE_SUMMARY',      entityArg: 'domicile', inputSchema: { domicile: { type: 'string' } }, risk: 'read', requiredPermission: 'site_summary', freshnessPolicy: FRESHNESS.DERIVED, description: 'Aggregate fleet summary for a site (totals + exceptions, not every unit).' },
  get_availability:      { fasTool: 'GET_UNIT',              entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'unit_status',   freshnessPolicy: FRESHNESS.LIVE,  description: 'Availability (lifecycle) for a unit.' },
  get_pm_status:         { fasTool: 'GET_PM_STATUS',         entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'pm_status',     freshnessPolicy: FRESHNESS.LIVE,  description: 'PM-B / PM-X / DOT due dates for a unit.' },
  get_inspection_status: { fasTool: 'GET_INSPECTION_STATUS', entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'pm_status',     freshnessPolicy: FRESHNESS.LIVE,  description: 'DOT/annual inspection due date + status for a unit.' },
  // ── REPAIR ─────────────────────────────────────────────────────────────
  get_open_work_orders:  { fasTool: 'GET_OPEN_WORK_ORDERS',  entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'work_orders',   freshnessPolicy: FRESHNESS.LIVE,  description: 'Open planned/unplanned WR counts + WR id for a unit.' },
  get_work_order_details:{ fasTool: 'GET_RELAY_WORK_ORDER_DETAILS', entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'work_orders', freshnessPolicy: FRESHNESS.CACHE, description: 'Relay Garage work-order detail (reason, correction, case, cost if internal).' },
  get_repair_timeline:   { fasTool: 'GET_REPAIR_TIMELINE',   entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'repair_timeline', freshnessPolicy: FRESHNESS.CACHE, description: 'Repair status + recent timeline for a unit.' },
  get_relay_timeline:    { fasTool: 'GET_RELAY_REPAIR_TIMELINE', entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'repair_timeline', freshnessPolicy: FRESHNESS.CACHE, description: 'Relay conversation/need-by/urgency feed for a unit.' },
  get_vendor_notes:      { fasTool: 'GET_RELAY_REPAIR_TIMELINE', entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'repair_timeline', freshnessPolicy: FRESHNESS.CACHE, description: 'Vendor/dealer notes from the Relay conversation for a unit.' },
  get_offsite_event:     { fasTool: 'GET_OFFSITE_EVENT',     entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'work_orders',   freshnessPolicy: FRESHNESS.CACHE, description: 'Offsite dealer/Decisiv shop event for a unit.' },
  get_decisiv_case:      { fasTool: 'GET_OFFSITE_EVENT_TIMELINE', entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'repair_timeline', freshnessPolicy: FRESHNESS.CACHE, description: 'Offsite (Decisiv/DTNA) event timeline/notes for a unit.' },
  get_uptake_insights:   { fasTool: 'GET_UPTAKE_INSIGHTS',   entityArg: 'unit', inputSchema: UNIT, risk: 'read', requiredPermission: 'uptake',        freshnessPolicy: FRESHNESS.LIVE,  description: 'Uptake predictive risk score + active insights for a unit.' },
  // ── OPERATIONS ───────────────────────────────────────────────────────────
  get_site_state:        { fasTool: 'GET_SITE_SUMMARY',      entityArg: 'domicile', inputSchema: { domicile: { type: 'string', required: true } }, risk: 'read', requiredPermission: 'site_summary', freshnessPolicy: FRESHNESS.DERIVED, description: 'Operational state of a domicile (totals, unavailable units, aging, holds).' },
  get_operator_summary:  { fasTool: 'GET_OPERATOR_SUMMARY',  entityArg: 'operator', inputSchema: { operator: { type: 'string', required: true } }, risk: 'read', requiredPermission: 'operator_summary', freshnessPolicy: FRESHNESS.DERIVED, description: 'Operational summary for an operator/carrier (SCAC).' },
  // ── COMMUNICATION ──────────────────────────────────────────────────────
  search_relevant_slack_history: { fasTool: 'SEARCH_SLACK', entityArg: 'unit', inputSchema: { unit: { type: 'string' }, vendor: { type: 'string' }, keywords: { type: 'string' } }, risk: 'read', requiredPermission: 'slack_search', freshnessPolicy: FRESHNESS.HISTORICAL, description: 'Authorized Slack message-content search over monitored surfaces, re-scoped to the sender.' },
  get_vendor_contact:    { fasTool: 'GET_VENDOR_CONTACT',    entityArg: 'vendor', inputSchema: { vendor: { type: 'string', required: true } }, risk: 'read', requiredPermission: 'vendor_contact', freshnessPolicy: FRESHNESS.LIVE, description: 'Vendor contact info (phone/email/address/serves).' },
  get_contact_permissions: { fasTool: 'GET_SENDER_PROFILE', entityArg: 'slackId', inputSchema: {}, risk: 'read', requiredPermission: null, freshnessPolicy: FRESHNESS.LIVE, description: "The sender's own resolved identity/scope/authorization (never widened by the AI)." },
  // ── KNOWLEDGE ───────────────────────────────────────────────────────────
  get_coverage:          { fasTool: 'GET_COVERAGE',          entityArg: null, inputSchema: {}, risk: 'read', requiredPermission: null, freshnessPolicy: FRESHNESS.DERIVED, description: "Zila's coverage (operators/SCAC + domiciles). Internal-only. Routing context, not a permission grant." },
  search_fas_knowledge:  { fasTool: 'GET_COMPLIANCE_REQUIREMENT', entityArg: null, inputSchema: { topic: { type: 'string' }, condition: { type: 'string' } }, risk: 'read', requiredPermission: null, freshnessPolicy: FRESHNESS.HISTORICAL, description: 'Versioned DOT/FMCSA compliance knowledge (cited records). Internal-only.' },
};

/** list() -> the catalog as an array of planner-facing definitions (no execute). */
function list() {
  return Object.keys(CATALOG).map((name) => {
    const d = CATALOG[name];
    return {
      name,
      description: d.description,
      inputSchema: d.inputSchema,
      outputSchema: { ok: 'boolean', data: 'object', source: 'string', retrievedAt: 'string', freshness: 'string', confidence: 'number' },
      risk: d.risk,
      requiredPermission: d.requiredPermission,
      freshnessPolicy: d.freshnessPolicy,
    };
  });
}

/** names() -> normalized tool names the planner may request. */
function names() { return Object.keys(CATALOG); }

/** has(name) -> is this a known normalized tool? */
function has(name) { return Object.prototype.hasOwnProperty.call(CATALOG, name); }

/** get(name) -> catalog definition (with underlying fasTool), or null. */
function get(name) { return CATALOG[name] || null; }

/**
 * execute(name, args, ctx) -> normalized provenance envelope.
 * ctx MUST carry { profile } (the resolved sender profile) so the underlying
 * FAS registry enforces scope/category — identical to the existing FAS agent
 * path. The AI can never widen permissions here; an unauthorized read returns
 * ok:false + denied:true (same as FAS).
 */
async function execute(name, args, ctx) {
  const def = CATALOG[name];
  if (!def) return { ok: false, tool: name, error: 'unknown tool: ' + name, denied: false, freshness: 'UNKNOWN', confidence: 0, retrievedAt: now() };
  if (!fasTools || typeof fasTools.runTool !== 'function') {
    return { ok: false, tool: name, error: 'tool platform unavailable', freshness: 'UNKNOWN', confidence: 0, retrievedAt: now() };
  }
  if (!ctx || !ctx.profile) {
    return { ok: false, tool: name, error: 'sender profile required for scoping', freshness: 'UNKNOWN', confidence: 0, retrievedAt: now() };
  }
  const entity = def.entityArg ? (args && args[def.entityArg]) : null;
  let raw;
  try {
    raw = await fasTools.runTool(def.fasTool, args || {}, ctx);
  } catch (e) {
    logger.warn('[ai-tools] ' + name + ' (' + def.fasTool + ') threw: ' + e.message);
    return { ok: false, tool: name, entity: entity || null, error: e.message, freshness: 'UNKNOWN', confidence: 0, retrievedAt: now() };
  }
  const env = _normalize(name, entity, raw);
  // Apply the tool's declared freshness policy as a hint alongside the observed
  // freshness (observed STALE always wins — never upgrade a stale fact).
  if (env.ok && env.freshness !== 'STALE') {
    if (def.freshnessPolicy === FRESHNESS.HISTORICAL) env.freshness = 'RECENT';
    else if (def.freshnessPolicy === FRESHNESS.CACHE && env.freshness === 'LIVE') env.freshness = 'RECENT';
  }
  return env;
}

module.exports = { list, names, has, get, execute, CATALOG, FRESHNESS, _normalize };
