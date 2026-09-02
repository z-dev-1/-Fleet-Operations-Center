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
const guard = require('./injection-guard');
let linkResearch; try { linkResearch = require('./link-research'); } catch (_) { linkResearch = null; }

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
async function buildEvidence({ profile, text, question, factsNeeded, mode }) {
  const entities = resolveMessageEntities(text || question || '');
  const fd = store.load('fleetData', {});
  const syncedAt = (fd && (fd.syncedAt || fd.updatedAt)) || null;
  // FIX: use the CONFIGURED freshness window, not a hard-coded constant.
  let freshnessMs = STALE_MS;
  try { freshnessMs = require('./config').get().dataFreshnessMs || STALE_MS; } catch (_) {}
  const stale = syncedAt ? (Date.now() - Date.parse(syncedAt) > freshnessMs) : true;
  const q = (text || question || '');
  // FIX: only treat a missing ETC as a gap when the request actually asks about
  // timing/completion — don't label every unit as "missing ETC".
  const _asksEtc = /\b(etc|eta|when|ready|complete|completion|done|back|timeline|estimate|how long)\b/i.test(q);
  // factsNeeded (optional AI hint) can force specific tool families to run.
  const _need = Array.isArray(factsNeeded) ? factsNeeded.map(s => String(s).toLowerCase()) : [];
  const _wants = (kind) => !_need.length || _need.some(n => n.includes(kind));

  const verifiedFacts = [];
  const openWorkOrders = [];
  const conflicts = [];
  const missingFacts = [];
  const sources = new Set();
  const denied = [];

  const ctx = { profile, mode: mode || 'disabled' };
  const primaryUnit = entities.units[0] || null;

  // Per-unit evidence (only for the units actually referenced).
  for (const unit of entities.units) {
    const u = await tools.runTool('GET_UNIT', { unit }, ctx);
    if (u.denied) { denied.push(unit); continue; }
    if (!u.ok) { missingFacts.push('unit record for ' + unit); continue; }
    u.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
    if (_wants('work') || _wants('wr') || _wants('repair')) {
      const wo = await tools.runTool('GET_OPEN_WORK_ORDERS', { unit }, ctx);
      if (wo.ok) { wo.verifiedFacts.forEach(f => { if (f.field === 'hasOpenWR' || f.field === 'workRequestId') { verifiedFacts.push(f); } }); openWorkOrders.push({ unit, facts: wo.verifiedFacts }); }
    }
    if (_wants('repair') || _wants('timeline') || _wants('status') || !_need.length) {
      const tl = await tools.runTool('GET_REPAIR_TIMELINE', { unit }, ctx);
      if (tl.ok) tl.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
    }
    if (_wants('pm') || _wants('inspection') || !_need.length) {
      const pm = await tools.runTool('GET_PM_STATUS', { unit }, ctx);
      if (pm.ok) pm.verifiedFacts.forEach(f => verifiedFacts.push(f));
    }
    if (_wants('uptake') || _wants('risk') || !_need.length) {
      const up = await tools.runTool('GET_UPTAKE_INSIGHTS', { unit }, ctx);
      if (up.ok) up.verifiedFacts.forEach(f => verifiedFacts.push(f));
    }

    // Relay Garage + Offsite Event are PRIMARY work-order evidence sources.
    // Pull them into the same timeline when the unit is down/at-shop or the
    // request concerns repair/work-order/vendor/location/completion.
    const _lc = String(u.verifiedFacts.find(f => f.field === 'lifecycleState')?.value || '').toLowerCase();
    const _repairAsk = /\b(repair|work ?order|wr|vendor|shop|offsite|status|down|diagnos|part|complete|fix|eta|etc|when|location|where)\b/i.test(q);
    if (_wants('work') || _wants('repair') || _wants('relay') || _wants('offsite') || _lc.includes('unavail') || _repairAsk) {
      const rg = await tools.runTool('GET_RELAY_GARAGE_UNIT', { unit }, ctx);
      if (rg.ok) rg.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
      const roff = await tools.runTool('GET_OFFSITE_EVENT', { unit }, ctx);
      if (roff.ok) {
        const hasOff = roff.verifiedFacts.find(f => f.field === 'hasOffsiteEvent');
        roff.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
        // If there IS an offsite event, pull its timeline too (dealer notes).
        if (hasOff && hasOff.value === true) {
          const rtl = await tools.runTool('GET_OFFSITE_EVENT_TIMELINE', { unit }, ctx);
          if (rtl.ok) rtl.verifiedFacts.forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
        }
      }
    }

    // Only flag a missing ETC when the request is actually about timing/completion.
    if (_asksEtc) {
      const hasEtc = verifiedFacts.some(f => /\betc\b|estimated completion|completion date/i.test(f.field) && f.value);
      if (!hasEtc) missingFacts.push('confirmed ETC for ' + unit + ' (no source confirms a completion date)');
    }
  }

  // Group (site/operator) evidence — aggregated, not per-unit dumps.
  // FIX: resolveEntities groups carry `.value` (not `.key`).
  for (const g of entities.groups.slice(0, 2)) {
    if (g.kind === 'site') {
      const s = await tools.runTool('GET_SITE_SUMMARY', { domicile: g.value }, ctx);
      if (s.denied) denied.push('site:' + g.value);
      else if (s.ok) { verifiedFacts.push({ field: 'siteSummary', value: s.summary, source: s.source, retrievedAt: s.retrievedAt }); sources.add(s.source); }
    } else if (g.kind === 'operator') {
      const o = await tools.runTool('GET_OPERATOR_SUMMARY', { operator: g.value }, ctx);
      if (o.denied) denied.push('operator:' + g.value);
      else if (o.ok) { verifiedFacts.push({ field: 'operatorSummary', value: o.summary, source: o.source, retrievedAt: o.retrievedAt }); sources.add(o.source); }
    }
  }

  if (stale) missingFacts.push('fleet data is stale (last sync ' + (syncedAt || 'unknown') + ') — may need SYNC_FLEET before acting');

  // Prompt-injection scan on the incoming message (untrusted).
  const injection = guard.detectInjection(text || question || '');

  // Approved-link research: fetch ONLY allowlisted domains, treat as untrusted.
  const linkRefusals = [];
  if (linkResearch) {
    try {
      const lr = await linkResearch.researchLinks(text || question || '');
      (lr.evidence || []).forEach(f => { verifiedFacts.push(f); sources.add(f.source); });
      (lr.refused || []).forEach(r => linkRefusals.push(r));
    } catch (e) { /* link research is best-effort */ }
  }

  // ── CONFLICT DETECTION across the collected sources ──────────────────────
  // Surface contradictions so the AI reasons about them instead of picking one
  // silently. Real checks against the facts we actually gathered:
  const _factVal = (field) => { const f = verifiedFacts.find(x => x.field === field); return f ? f.value : undefined; };
  const _lifecycle = String(_factVal('lifecycleState') || '');
  const _repairStatus = String(_factVal('repairStatus') || '') + ' ' + String(_factVal('serviceState') || '');
  const _hasOpenWR = _factVal('hasOpenWR');
  const _timeline = _factVal('recentTimeline');
  const _timelineStr = Array.isArray(_timeline) ? _timeline.join(' ') : String(_timeline || '');
  if (/active/i.test(_lifecycle) && _hasOpenWR === true) {
    conflicts.push({ type: 'lifecycle_vs_wr', detail: 'Unit shows ACTIVE but still has an open work order — confirm whether the repair is actually closed.' });
  }
  if (/unavail/i.test(_lifecycle) && /(repair complete|ready|completed|good to go|back in service)/i.test(_repairStatus + ' ' + _timelineStr)) {
    conflicts.push({ type: 'repair_complete_vs_unavailable', detail: 'Repair notes indicate complete/ready but lifecycle is still Unavailable — the flip may not have been done, or the notes are ahead of the source system.' });
  }
  // Freshness conflict: repair notes newer/older than the fleet sync.
  const _notesAt = _factVal('notesUpdatedAt');
  if (_notesAt && syncedAt && Date.parse(_notesAt) > Date.parse(syncedAt) + 3600 * 1000) {
    conflicts.push({ type: 'notes_newer_than_sync', detail: 'Repair notes were updated after the last fleet sync — the live source system may show a newer state than fleetData.' });
  }

  // Prior promises / open questions from case memory (compact).
  // SCOPE FILTER (Part 4): case memory can reference any unit; an external
  // (carrier/vendor/unknown) sender must only see cases for units within THEIR
  // operator/domicile scope, or cases keyed to their own sender id. Never leak
  // another carrier's/domicile's case history into the AI context.
  const _fleetRows = (fd && fd.rows) || [];
  const _rowFor = (unit) => _fleetRows.find(r => String(r.equipmentId || '').trim().toUpperCase() === String(unit || '').trim().toUpperCase()) || null;
  const _senderCaseId = caseStore.caseIdForSender(profile.slackId);
  function _caseInScope(c) {
    if (profile.type === 'internal' || profile.type === 'manager') return true;
    if (c.caseId && c.caseId === _senderCaseId) return true; // the sender's own case
    if (!c.unit) return false; // sender-less/unit-less case -> external can't see
    const row = _rowFor(c.unit);
    if (!row) return false;    // can't confirm scope -> deny for external
    return profiles.scopeUnitForSender(profile, row);
  }
  const related = caseStore.findRelated({ units: entities.units, slackId: profile.slackId })
    .filter(_caseInScope);
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
    injection,                     // { suspicious, matches } — untrusted-message scan
    linkRefusals,                  // links refused by the allowlist (audit)
    dataFreshness: { fleetSyncedAt: syncedAt, stale },
    senderAuthorization: profiles.authorizationSummary(profile),
    previousPromises,
    relatedCases: related.map(c => ({ caseId: c.caseId, status: c.status, summary: c.currentSummary, responsibleParty: c.responsibleParty, nextFollowUpAt: c.nextFollowUpAt })),
    sources: [...sources],
    builtAt: new Date().toISOString(),
  };
}

module.exports = { buildEvidence, resolveMessageEntities };
