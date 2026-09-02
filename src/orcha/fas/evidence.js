'use strict';
/**
 * orcha/fas/evidence.js — Digital FAS Stage 4: compact evidence package.
 *
 * Given a resolved sender profile and the entities in a message, run the
 * relevant READ tools (scoped) and assemble a compact evidence object the
 * decision engine can reason over — WITHOUT dumping the whole fleet. Every
 * fact carries source + retrievedAt so the model knows freshness; missing /
 * stale / conflicting data is surfaced explicitly.
 *
 * This is deterministic (no AI) — it just gathers and packages evidence.
 */

const tools = require('./tool-registry');
const profiles = require('./sender-profiles');
const caseStore = require('./case-store');
const store = require('../../store');

let _resolveEntities;
try { _resolveEntities = require('../ai-context').resolveEntities; } catch (_) { _resolveEntities = null; }

const STALE_MS = 6 * 60 * 60 * 1000; // fleet data older than 6h is flagged stale

/**
 * resolveMessageEntities(text) -> { units, operators, domiciles, vendors }
 * Reuses ai-context.resolveEntities against live fleet rows when available.
 */
function resolveMessageEntities(text) {
  const fd = store.load('fleetData', {});
  const rows = (fd && fd.rows) || [];
  if (_resolveEntities) {
    try {
      const r = _resolveEntities(text || '', rows);
      return {
        units: (r.units || []).slice(0, 10),
        groups: r.groups || [],
      };
    } catch (_) { /* fall through */ }
  }
  // Fallback: simple unit-token scan.
  const units = [];
  const re = /\b([A-Za-z]?\d{4,8})\b/g; let m;
  while ((m = re.exec(text || '')) !== null) {
    const q = m[1].toUpperCase();
    if (rows.some(x => (x.equipmentId || '').toUpperCase() === q)) units.push(m[1]);
  }
  return { units: [...new Set(units)].slice(0, 10), groups: [] };
}

/**
 * buildEvidence({ profile, text, factsNeeded }) -> Promise<evidencePackage>
 *
 * factsNeeded (optional) is a hint list of tool names to run; if omitted we
 * infer sensible defaults from the resolved entities.
 */
async function buildEvidence({ profile, text, question, factsNeeded }) {
  const entities = resolveMessageEntities(text || question || '');
  const fd = store.load('fleetData', {});
  const syncedAt = (fd && (fd.syncedAt || fd.updatedAt)) || null;
  const stale = syncedAt ? (Date.now() - Date.parse(syncedAt) > STALE_MS) : true;

  const verifiedFacts = [];
  const openWorkOrders = [];
  const conflicts = [];
  const missingFacts = [];
  const sources = new Set();
  const denied = [];

  const ctx = { profile };
  const primaryUnit = entities.units[0] || null;

  // Per-unit evidence (only for the units actually referenced).
  for (const unit of entities.units) {
    const u = await tools.runTool('GET_UNIT', { unit }, ctx);
    if (u.denied) { denied.push(unit); continue; }
    if (!u.ok) { missingFacts.push('unit record for ' + unit); continue; }
    u.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
    const wo = await tools.runTool('GET_OPEN_WORK_ORDERS', { unit }, ctx);
    if (wo.ok) { wo.verifiedFacts.forEach(f => { if (f.field === 'hasOpenWR' || f.field === 'workRequestId') { verifiedFacts.push(f); } }); openWorkOrders.push({ unit, facts: wo.verifiedFacts }); }
    const tl = await tools.runTool('GET_REPAIR_TIMELINE', { unit }, ctx);
    if (tl.ok) tl.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
    const pm = await tools.runTool('GET_PM_STATUS', { unit }, ctx);
    if (pm.ok) pm.verifiedFacts.forEach(f => verifiedFacts.push(f));
    const up = await tools.runTool('GET_UPTAKE_INSIGHTS', { unit }, ctx);
    if (up.ok) up.verifiedFacts.forEach(f => verifiedFacts.push(f));

    // Common missing fact: no confirmed ETC anywhere in the data.
    const hasEtc = verifiedFacts.some(f => /etc|estimated completion/i.test(f.field));
    if (!hasEtc) missingFacts.push('confirmed ETC for ' + unit);
  }

  // Group (site/operator) evidence — aggregated, not per-unit dumps.
  for (const g of entities.groups.slice(0, 2)) {
    if (g.kind === 'site') {
      const s = await tools.runTool('GET_SITE_SUMMARY', { domicile: g.key }, ctx);
      if (s.denied) denied.push('site:' + g.key);
      else if (s.ok) { verifiedFacts.push({ field: 'siteSummary', value: s.summary, source: s.source, retrievedAt: s.retrievedAt }); sources.add(s.source); }
    } else if (g.kind === 'operator') {
      const o = await tools.runTool('GET_OPERATOR_SUMMARY', { operator: g.key }, ctx);
      if (o.denied) denied.push('operator:' + g.key);
      else if (o.ok) { verifiedFacts.push({ field: 'operatorSummary', value: o.summary, source: o.source, retrievedAt: o.retrievedAt }); sources.add(o.source); }
    }
  }

  if (stale) missingFacts.push('fleet data is stale (last sync ' + (syncedAt || 'unknown') + ') — may need SYNC_FLEET before acting');

  // Prior promises / open questions from case memory (compact).
  const related = caseStore.findRelated({ units: entities.units, slackId: profile.slackId });
  const previousPromises = [];
  related.forEach(c => { (c.promises || []).forEach(p => previousPromises.push(p)); });

  return {
    caseId: primaryUnit ? caseStore.caseIdForUnit(primaryUnit) : caseStore.caseIdForSender(profile.slackId),
    question: question || text || '',
    entities,
    verifiedFacts,
    openWorkOrders,
    conflicts,
    missingFacts,
    deniedScope: denied,           // entities the sender wasn't authorized to see
    dataFreshness: { fleetSyncedAt: syncedAt, stale },
    senderAuthorization: profiles.authorizationSummary(profile),
    previousPromises,
    relatedCases: related.map(c => ({ caseId: c.caseId, status: c.status, summary: c.currentSummary, responsibleParty: c.responsibleParty, nextFollowUpAt: c.nextFollowUpAt })),
    sources: [...sources],
    builtAt: new Date().toISOString(),
  };
}

module.exports = { buildEvidence, resolveMessageEntities };
