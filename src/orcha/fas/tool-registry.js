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

// ── READ TOOLS ─────────────────────────────────────────────────────────────
// Each: (args, ctx) -> { ok, verifiedFacts?, data?, error?, denied? }
// ctx = { profile }  (sender profile for scoping)

function GET_UNIT(args, ctx) {
  const { rows, syncedAt } = _loadFleet();
  const row = _findRow(rows, args && args.unit);
  if (!row) return { ok: false, error: 'unit not found: ' + (args && args.unit) };
  if (!profiles.scopeUnitForSender(ctx.profile, row)) {
    return { ok: false, denied: true, error: 'sender not authorized for unit ' + row.equipmentId + ' (operator/domicile scope)' };
  }
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
  if (!profiles.scopeUnitForSender(ctx.profile, row)) return { ok: false, denied: true, error: 'not authorized' };
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
  if (!profiles.scopeUnitForSender(ctx.profile, row)) return { ok: false, denied: true, error: 'not authorized' };
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
  if (!profiles.scopeUnitForSender(ctx.profile, row)) return { ok: false, denied: true, error: 'not authorized' };
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
  if (!profiles.scopeUnitForSender(ctx.profile, row)) return { ok: false, denied: true, error: 'not authorized' };
  const insights = Array.isArray(row.insightsList) ? row.insightsList.map(i => ({ title: i.title || i.name, active: i.stillActive !== false })) : [];
  return { ok: true, verifiedFacts: [
    _fact('riskScore', row.riskScore != null ? row.riskScore : null, 'Uptake'),
    _fact('insights', insights, 'Uptake'),
    _fact('uptakeSynced', !!row.uptakeSynced, 'Uptake'),
  ] };
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
  try {
    return await fn(args || {}, ctx);
  } catch (e) {
    logger.warn('[fas-tools] ' + name + ' threw: ' + e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { READ_TOOLS, runTool, TOOL_NAMES: Object.keys(READ_TOOLS) };
