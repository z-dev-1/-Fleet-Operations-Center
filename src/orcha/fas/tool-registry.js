'use strict';
/**
 * orcha/fas/tool-registry.js — Digital FAS Stage 2: deterministic read tools.
 *
 * Retrieves ONLY the relevant records through application code, returning
 * verified-fact objects tagged with source + retrievedAt (freshness). The agent
 * loop requests tools by structured name + args; it never receives the whole
 * fleet database. Fleet-wide/site/operator questions are aggregated in code
 * (totals + exceptions), not by dumping every healthy unit.
 *
 * Every tool enforces sender scoping via sender-profiles: an external sender
 * only gets records for their own operators/domiciles. Scoping is applied HERE,
 * before data would ever reach the model — not after.
 *
 * This is a READ-ONLY registry. Action/mutating tools (Stage 6) live elsewhere
 * and require their own authorization + verification.
 */

const store = require('../../store');
const profiles = require('./sender-profiles');
let logger; try { logger = require('../../utils/logger').createLogger('fas-tools'); } catch (_) { logger = { info(){}, warn(){} }; }

const now = () => new Date().toISOString();
function _fact(field, value, source) { return { field, value, source, retrievedAt: now() }; }

function _loadFleet() {
  const fd = store.load('fleetData', {});
  return { rows: (fd && fd.rows) || [], syncedAt: (fd && (fd.syncedAt || fd.updatedAt)) || null };
}
function _loadNotes() { return store.load('notesStore', {}) || {}; }

function _findRow(rows, unitToken) {
  if (!unitToken) return null;
  const q = String(unitToken).trim().toUpperCase();
  return rows.find(r => (r.equipmentId || '').trim().toUpperCase() === q) || null;
}

// Enforce BOTH: (1) the sender is allowed the data CATEGORY, and (2) the unit
// is within the sender's operator/domicile scope. Returns null if OK, or a
// denied result to return directly. Applied by every unit read tool so
// authorization is code-enforced, not prompt-enforced.
function _scopeCheck(ctx, row, category) {
  if (!ctx || !ctx.profile) return { ok: false, error: 'sender profile required' };
  if (category && !profiles.canViewCategory(ctx.profile, category)) {
    return { ok: false, denied: true, error: 'sender not authorized for data category: ' + category };
  }
  if (!profiles.scopeUnitForSender(ctx.profile, row)) {
    return { ok: false, denied: true, error: 'sender not authorized for unit ' + row.equipmentId + ' (operator/domicile scope)' };
  }
  return null;
}

// ── READ TOOLS ─────────────────────────────────────────────────────────────
// Each: (args, ctx) -> { ok, verifiedFacts?, data?, error?, denied? }
// ctx = { profile }  (sender profile for scoping)

function GET_UNIT(args, ctx) {
  const { rows, syncedAt } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found: ' + (args && args.unit) };
  const denied = _scopeCheck(ctx, row, 'unit_status'); if (denied) return denied;
  const facts = [
    _fact('unit', row.equipmentId, 'fleetData'),
    _fact('lifecycleState', row.lifecycleState || 'unknown', 'AAP/fleetData'),
    _fact('lifecycleReason', row.lifecycleReason || '', 'AAP/fleetData'),
    _fact('operator', row.operator || '', 'fleetData'),
    _fact('domicile', row.domicileSite || row.site || '', 'fleetData'),
    _fact('vendor', row.vendor || 'none', 'fleetData'),
    _fact('daysDown', row.workDuration || '', 'fleetData'),
  ];
  return { ok: true, verifiedFacts: facts, syncedAt };
}

function GET_REPAIR_TIMELINE(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'repair_timeline'); if (denied) return denied;
  const ns = _loadNotes()[row.equipmentId] || {};
  const tl = (ns.timeline || row.repairTimeline || '').trim();
  const lines = tl ? tl.split('\n').filter(Boolean).slice(-8) : [];
  return { ok: true, verifiedFacts: [
    _fact('repairStatus', ns.repairStatus || row.savedRepairStatus || '', 'notes/Relay'),
    _fact('primaryComponent', ns.primaryComponent || row.savedPrimaryComponent || '', 'notes'),
    _fact('recentTimeline', lines, 'notes/Relay'),
    _fact('notesUpdatedAt', ns.notesUpdatedAt || row.notesUpdatedAt || null, 'notes'),
  ] };
}

function GET_OPEN_WORK_ORDERS(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'work_orders'); if (denied) return denied;
  const openU = parseInt(row.openUnplanned, 10) || 0;
  const openP = parseInt(row.openPlanned, 10) || 0;
  return { ok: true, verifiedFacts: [
    _fact('openUnplanned', openU, 'AAP/fleetData'),
    _fact('openPlanned', openP, 'AAP/fleetData'),
    _fact('workRequestId', row.workRequestId || null, 'AAP/fleetData'),
    _fact('hasOpenWR', (openU + openP) > 0 || (row.workRequestId && row.workRequestId !== '--'), 'AAP/fleetData'),
  ] };
}

function GET_PM_STATUS(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'pm_status'); if (denied) return denied;
  return { ok: true, verifiedFacts: [
    _fact('pmB', row.pmB || row.pmBDue || null, 'fleetData'),
    _fact('pmX', row.pmX || row.pmXDue || null, 'fleetData'),
    _fact('dot', row.dot || row.dotDue || null, 'fleetData'),
    _fact('lifecycleReason', row.lifecycleReason || '', 'AAP/fleetData'),
  ] };
}

function GET_UPTAKE_INSIGHTS(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'uptake'); if (denied) return denied;
  const insights = Array.isArray(row.insightsList) ? row.insightsList.map(i => ({ title: i.title || i.name, active: i.stillActive !== false })) : [];
  return { ok: true, verifiedFacts: [
    _fact('riskScore', row.riskScore != null ? row.riskScore : null, 'Uptake'),
    _fact('insights', insights, 'Uptake'),
    _fact('uptakeSynced', !!row.uptakeSynced, 'Uptake'),
  ] };
}

// ── RELAY GARAGE + OFFSITE EVENT read tools ─────────────────────────────────
// Reuse the app's existing Relay Garage / Offsite data cached in `relayCache`
// (populated by src/scrapers/relay.js). READ-ONLY: never opens a browser or
// triggers a live scrape here — reads the cache and reports the cache's own
// _cachedAt as the SOURCE timestamp (not the time we read it), so the AI can
// judge freshness. Offsite Event data is Relay-derived (Decisiv/DTNA links on
// the unit's WR page), so it lives in the same cache entry.
function _loadRelayCache() { return store.load('relayCache', {}) || {}; }
// Configured freshness window (default 6h) for judging cache staleness.
function _freshnessMs() {
  try { return require('./config').get().dataFreshnessMs || (6 * 3600 * 1000); } catch (_) { return 6 * 3600 * 1000; }
}
// Fact whose freshness reflects the SOURCE system's own update time. Also
// exposes cache AGE and a STALE flag (Part 13) so the AI/approval evidence can
// see how old cached data is and never treat old cache as live. `stale` facts
// must not support an autonomous reply (enforced in the runner).
function _srcFact(field, value, source, sourceAt) {
  let ageMs = null, stale = false;
  if (sourceAt) {
    const t = Date.parse(sourceAt);
    if (!isNaN(t)) { ageMs = Date.now() - t; stale = ageMs > _freshnessMs(); }
  }
  // No source time -> we cannot assert age; leave stale=false (a negative/absent
  // fact like "no work order cached" must not block an autonomous reply).
  return { field, value, source, retrievedAt: now(), sourceUpdatedAt: sourceAt || null, ageMs, stale };
}
function _relayEntry(unit) {
  const cache = _loadRelayCache();
  const key = String(unit || '').trim().toUpperCase();
  // relayCache is keyed by equipmentId (already upper in practice); match loosely.
  if (cache[key]) return { key, entry: cache[key] };
  const found = Object.keys(cache).find(k => k.toUpperCase() === key);
  return found ? { key: found, entry: cache[found] } : { key, entry: null };
}

function GET_RELAY_GARAGE_UNIT(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'work_orders'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  if (!entry || entry._noWR) {
    return { ok: true, summary: 'No open Relay Garage work order cached for ' + row.equipmentId + (entry && entry._noWR ? ' (confirmed no findable WR)' : ''), verifiedFacts: [
      _srcFact('relayHasWorkOrder', false, 'RelayGarage', entry ? new Date(entry._cachedAt || Date.now()).toISOString() : null),
    ] };
  }
  const at = entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null;
  return { ok: true, verifiedFacts: [
    _srcFact('workRequestId', entry.workRequestId || null, 'RelayGarage', at),
    _srcFact('serviceState', entry.serviceState || '', 'RelayGarage', at),
    _srcFact('vendor', entry.vendor || '', 'RelayGarage', at),
    _srcFact('issueDetails', entry.issueDetails || '', 'RelayGarage', at),
    _srcFact('lifecycleReason', entry.lifecycleReason || '', 'RelayGarage', at),
    _srcFact('workDuration', entry.workDuration || '', 'RelayGarage', at),
    _srcFact('completed', entry.completed || '', 'RelayGarage', at),
    _srcFact('sourceUrl', entry.pageUrl || '', 'RelayGarage', at),
  ] };
}

function GET_RELAY_WORK_ORDERS(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'work_orders'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  if (!entry || entry._noWR) return { ok: true, summary: 'No open work orders cached', verifiedFacts: [] };
  const at = entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null;
  // Primary + any planned/secondary WRs so a single result isn't relied on.
  const list = [];
  const push = (e, kind, url) => list.push({
    kind, workRequestId: e.workRequestId || null, vendorWorkOrderId: e.vendorWorkOrderId || null,
    state: e.serviceState || '', vendor: e.vendor || '', url: url || e.pageUrl || '',
  });
  push(entry, 'primary');
  if (entry._plannedWRData) push(entry._plannedWRData, 'planned', entry._plannedWRData._relayUrl);
  (entry._secondaryWRs || []).forEach(w => push(w, w._wrType || 'secondary', w._relayUrl));
  return { ok: true, verifiedFacts: [ _srcFact('workOrders', list, 'RelayGarage', at) ] };
}

function GET_RELAY_WORK_ORDER_DETAILS(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'work_orders'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  if (!entry || entry._noWR) return { ok: true, summary: 'No work order detail cached', verifiedFacts: [] };
  const at = entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null;
  const facts = [
    _srcFact('vendorWorkOrderId', entry.vendorWorkOrderId || null, 'RelayGarage/WO', at),
    _srcFact('reasonForRepair', entry.cause || '', 'RelayGarage/WO', at),
    _srcFact('workAccomplished', entry.correction || '', 'RelayGarage/WO', at),
    _srcFact('salesforceCase', entry.salesforceCase || '', 'RelayGarage/WO', at),
  ];
  // FINANCIAL DATA (Part 13): total work-order cost is INTERNAL-ONLY by default
  // — never exposed to carriers/vendors.
  const isInternal = !!(ctx && ctx.profile && (ctx.profile.type === 'internal' || ctx.profile.type === 'manager'));
  if (isInternal) facts.push(_srcFact('totalCost', entry.totalCost || '', 'RelayGarage/WO', at));
  return { ok: true, verifiedFacts: facts };
}

function GET_RELAY_REPAIR_TIMELINE(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'repair_timeline'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  if (!entry || entry._noWR) return { ok: true, summary: 'No Relay conversation/timeline cached', verifiedFacts: [] };
  const at = entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null;
  // Compact the conversation feed — never dump the whole thing.
  let conv = String(entry.fullConversation || '').trim();
  const cap = 2000;
  if (conv.length > cap) conv = conv.slice(-cap) + ' …[older comments trimmed]';
  return { ok: true, verifiedFacts: [
    _srcFact('relayConversation', conv || '(no comments)', 'RelayGarage/conversation', at),
    _srcFact('needBy', entry.needBy || '', 'RelayGarage', at),
    _srcFact('urgent', entry.urgent || '', 'RelayGarage', at),
  ] };
}

function GET_OFFSITE_EVENT(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'work_orders'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  const hasOffsite = entry && (entry.offsiteShopEventUrl || entry.offsiteShopEvent || entry.asistLabel);
  if (!hasOffsite) return { ok: true, summary: 'No offsite shop event linked for ' + row.equipmentId, verifiedFacts: [
    _srcFact('hasOffsiteEvent', false, 'RelayGarage/offsite', entry && entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null),
  ] };
  const at = entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null;
  return { ok: true, verifiedFacts: [
    _srcFact('hasOffsiteEvent', true, 'RelayGarage/offsite', at),
    _srcFact('offsiteEvent', entry.offsiteShopEvent || entry.asistLabel || '', 'OffsiteEvent', entry.asistScrapedAt || at),
    _srcFact('offsiteEventUrl', entry.offsiteShopEventUrl || entry.asistSrUrl || '', 'OffsiteEvent', entry.asistScrapedAt || at),
    _srcFact('offsiteVendor', entry.dealerName || entry.vendor || '', 'OffsiteEvent', entry.asistScrapedAt || at),
    _srcFact('offsiteSource', entry.asistSource || '', 'OffsiteEvent', entry.asistScrapedAt || at),
  ] };
}

function GET_OFFSITE_EVENT_TIMELINE(args, ctx) {
  const { rows } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found' };
  const denied = _scopeCheck(ctx, row, 'repair_timeline'); if (denied) return denied;
  const { entry } = _relayEntry(row.equipmentId);
  const notes = entry && String(entry.asistNotes || '').trim();
  if (!notes) return { ok: true, summary: 'No offsite event timeline/notes cached', verifiedFacts: [] };
  const at = entry.asistScrapedAt || (entry._cachedAt ? new Date(entry._cachedAt).toISOString() : null);
  let text = notes; const cap = 2500;
  if (text.length > cap) text = text.slice(0, cap) + ' …[truncated]';
  return { ok: true, verifiedFacts: [
    _srcFact('offsiteTimeline', text, 'OffsiteEvent/Decisiv', at),
    _srcFact('offsiteDealer', entry.dealerName || '', 'OffsiteEvent', at),
  ] };
}

// ── SEARCH_SLACK ────────────────────────────────────────────────────────────
// Authorized Slack message-content search over the local index of monitored
// surfaces. Results are re-filtered by the requesting sender's scope inside the
// adapter. Unknown/unauthorized senders (no data categories) get nothing.
function SEARCH_SLACK(args, ctx) {
  if (!ctx || !ctx.profile) return { ok: false, error: 'sender profile required' };
  if (!(ctx.profile.allowedDataCategories || []).length) {
    return { ok: false, denied: true, error: 'sender not authorized to search Slack' };
  }
  let searcher;
  try { searcher = require('./slack-search'); } catch (e) { return { ok: false, error: 'slack search unavailable' }; }
  const q = {
    unit: (args && args.unit) || '', vendor: (args && args.vendor) || '',
    operator: (args && args.operator) || '', domicile: (args && args.domicile) || '',
    keywords: (args && args.keywords) || '', sender: (args && args.sender) || '',
    channel: (args && args.channel) || '',
    fromMs: (args && args.fromMs) || 0, toMs: (args && args.toMs) || undefined,
  };
  const res = searcher.searchSlack(q, ctx.profile, {});
  if (!res.ok) return { ok: false, error: res.error || 'search failed' };
  return { ok: true, summary: res.results.length + ' Slack match(es)' + (res.truncated ? ' (capped)' : ''),
    verifiedFacts: [ _fact('slackMatches', res.results, 'SlackSearch') ] };
}

function GET_SITE_SUMMARY(args, ctx) {
  const { rows } = _loadFleet();
  const site = String((args && args.domicile) || '').trim().toUpperCase();
  if (!site) return { ok: false, error: 'domicile required' };
  // Scope: external sender must own this domicile.
  if (!(ctx.profile.type === 'internal' || ctx.profile.type === 'manager') &&
      !(ctx.profile.domiciles || []).map(d => d.toUpperCase()).includes(site)) {
    return { ok: false, denied: true, error: 'sender not authorized for site ' + site };
  }
  const at = rows.filter(r => (r.domicileSite || r.site || '').trim().toUpperCase() === site);
  return { ok: true, ...(_aggregate(at, 'site', site)) };
}

function GET_OPERATOR_SUMMARY(args, ctx) {
  const { rows } = _loadFleet();
  const op = String((args && args.operator) || '').trim().toUpperCase();
  if (!op) return { ok: false, error: 'operator required' };
  if (!(ctx.profile.type === 'internal' || ctx.profile.type === 'manager') &&
      !(ctx.profile.operators || []).map(o => o.toUpperCase()).includes(op)) {
    return { ok: false, denied: true, error: 'sender not authorized for operator ' + op };
  }
  const at = rows.filter(r => (r.operator || '').trim().toUpperCase() === op);
  return { ok: true, ...(_aggregate(at, 'operator', op)) };
}

// Deterministic aggregation: totals + exceptions only, NOT every healthy unit.
function _aggregate(units, kind, key) {
  const isUnavail = (r) => /unavail/i.test((r.lifecycleState || r.atsState) || '');
  const unavailable = units.filter(isUnavail);
  const parseDays = (w) => { const m = String(w || '').match(/(\d+)\s*d/i); return m ? parseInt(m[1], 10) : 0; };
  const aging = unavailable.filter(r => parseDays(r.workDuration) >= 14)
    .map(r => ({ unit: r.equipmentId, daysDown: r.workDuration, vendor: r.vendor || '', reason: r.lifecycleReason || '' }));
  const highRisk = units.filter(r => r.riskScore != null && r.riskScore >= 70)
    .map(r => ({ unit: r.equipmentId, risk: r.riskScore }));
  const holds = unavailable.filter(r => /pm failed|expired inspection|damaged/i.test(r.lifecycleReason || ''))
    .map(r => ({ unit: r.equipmentId, reason: r.lifecycleReason }));
  return {
    summary: {
      scope: kind + ':' + key,
      total: units.length,
      available: units.length - unavailable.length,
      unavailable: unavailable.length,
      unavailableUnits: unavailable.map(r => ({ unit: r.equipmentId, reason: r.lifecycleReason || '', vendor: r.vendor || '', daysDown: r.workDuration || '' })),
      agingRepairs: aging,
      highRisk,
      safetyHolds: holds,
    },
    source: 'fleetData(aggregated)',
    retrievedAt: now(),
  };
}

function GET_VENDOR_CONTACT(args, ctx) {
  // Authorization: sender must be allowed the vendor_contact data category.
  if (!profiles.canViewCategory(ctx.profile, 'vendor_contact')) {
    return { ok: false, denied: true, error: 'sender not authorized for vendor contact info' };
  }
  const name = String((args && args.vendor) || '').trim().toLowerCase();
  if (!name) return { ok: false, error: 'vendor required' };
  const contacts = store.load('contacts', []) || [];
  const v = contacts.find(c => c.type === 'vendor' && ((c.name || c.company || '').toLowerCase().includes(name)));
  if (!v) return { ok: false, error: 'vendor not found: ' + name };
  return { ok: true, verifiedFacts: [
    _fact('vendorName', v.name || v.company, 'contacts'),
    _fact('phone', v.phone || '', 'contacts'),
    _fact('email', v.email || '', 'contacts'),
    _fact('address', [v.street, v.city, v.state, v.zip].filter(Boolean).join(', '), 'contacts'),
    _fact('serves', v.domiciles || '', 'contacts'),
  ] };
}

function GET_SENDER_PROFILE(args, ctx) {
  return { ok: true, verifiedFacts: [
    _fact('name', ctx.profile.name, 'senderProfile'),
    _fact('type', ctx.profile.type, 'senderProfile'),
    _fact('operators', ctx.profile.operators, 'senderProfile'),
    _fact('domiciles', ctx.profile.domiciles, 'senderProfile'),
    _fact('authorization', profiles.authorizationSummary(ctx.profile), 'senderProfile'),
  ] };
}

async function ASK_INTERNAL(args, ctx) {
  // Authorization: ASK_INTERNAL consults the internal Amazon agent (AITeammate).
  // Only internal/manager senders may trigger it — never external carriers/vendors.
  const auth = profiles.authorizationSummary(ctx.profile);
  if (!auth.isInternal) {
    return { ok: false, denied: true, error: 'ASK_INTERNAL restricted to internal users' };
  }
  // SIDE-EFFECT GATE (Part 9): asking AITeammate SENDS a real Slack message,
  // so it is OUTBOUND activity. In Shadow mode we must not contact AITeammate;
  // we only record the proposed consult for evaluation. In Approval mode it
  // requires explicit approval unless the operator enabled ASK_INTERNAL as an
  // approved automatic action. Autonomous may consult (internal, low-risk read).
  const mode = (ctx && ctx.mode) || 'disabled';
  const q0 = (args && args.question) || '';
  if (mode === 'shadow' || mode === 'disabled') {
    return { ok: true, proposedOnly: true, summary: 'Proposed internal consult (not sent in ' + mode + ' mode)',
      verifiedFacts: [], proposedResearch: { tool: 'ASK_INTERNAL', question: String(q0).slice(0, 300) } };
  }
  if (mode === 'approval') {
    const approved = (ctx.approvedAutomaticActions || []).includes('ASK_INTERNAL');
    if (!approved) {
      return { ok: true, proposedOnly: true, requiresApproval: true,
        summary: 'Internal consult requires approval (enable ASK_INTERNAL in automatic actions to allow)',
        verifiedFacts: [], proposedResearch: { tool: 'ASK_INTERNAL', question: String(q0).slice(0, 300) } };
    }
  }
  try {
    const { askInternal } = require('../ask-internal');
    const q = (args && args.question) || '';
    const res = await askInternal(q);
    if (res && res.ok) {
      // Save verified internal guidance as a REVIEWABLE knowledge draft — not
      // auto-promoted to permanent policy (Stage 9). You approve it into the
      // playbook via the knowledge-draft queue.
      try { require('./playbook').addDraft({ topic: q.slice(0, 80), guidance: res.answer, source: 'ASK_INTERNAL' }); } catch (_) {}
      return { ok: true, verifiedFacts: [_fact('internalGuidance', res.answer, 'AITeammate')] };
    }
    return { ok: false, error: (res && res.error) || 'AITeammate unavailable' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Registry of read tools by structured name.
const READ_TOOLS = {
  GET_UNIT,
  GET_REPAIR_TIMELINE,
  GET_OPEN_WORK_ORDERS,
  GET_PM_STATUS,
  GET_UPTAKE_INSIGHTS,
  GET_RELAY_GARAGE_UNIT,
  GET_RELAY_WORK_ORDERS,
  GET_RELAY_WORK_ORDER_DETAILS,
  GET_RELAY_REPAIR_TIMELINE,
  GET_OFFSITE_EVENT,
  GET_OFFSITE_EVENT_TIMELINE,
  SEARCH_SLACK,
  GET_SITE_SUMMARY,
  GET_OPERATOR_SUMMARY,
  GET_VENDOR_CONTACT,
  GET_SENDER_PROFILE,
  ASK_INTERNAL,
};

/**
 * runTool(name, args, ctx) -> Promise<result>
 * Central dispatch with unknown-tool guard. ctx.profile is required for scoping.
 */
async function runTool(name, args, ctx) {
  const fn = READ_TOOLS[name];
  if (!fn) return { ok: false, error: 'unknown read tool: ' + name };
  if (!ctx || !ctx.profile) return { ok: false, error: 'sender profile required for scoping' };
  // CENTRAL ARG VALIDATION (Part 15): validate name/args against the schema
  // before dispatch. Never trust the AI to produce correct JSON.
  let cleaned = args || {};
  try {
    const schema = require('./arg-schema');
    const v = schema.validateArgs(name, args || {});
    if (!v.ok) return { ok: false, error: 'invalid arguments for ' + name + ': ' + v.error };
    cleaned = v.cleaned;
  } catch (_) { /* validator unavailable -> proceed with raw args */ }
  try {
    const res = await fn(cleaned, ctx);
    try { return require('./arg-schema').capResult(res); } catch (_) { return res; }
  } catch (e) {
    logger.warn('[fas-tools] ' + name + ' threw: ' + e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { READ_TOOLS, runTool, TOOL_NAMES: Object.keys(READ_TOOLS) };
