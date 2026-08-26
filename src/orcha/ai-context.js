'use strict';
/**
 * ai-context.js â€” Fleet data context builder for AI prompts
 *
 * Provides rich, accurate fleet context to any AI call (Slack DM replies,
 * partner channel replies, Orcha chat, etc.) so the AI can give real,
 * data-driven answers instead of generic "I'll follow up" responses.
 *
 * Includes:
 *   - Fleet summary (total, unavail, offsite, available)
 *   - Full details for any unit mentioned in the message
 *   - Repair timeline, vendor, notes, PM dates, risk scores
 *   - Predictive maintenance data (Uptake risk scores, insights)
 *   - Recently active units (for context when no specific unit is mentioned)
 */

const store  = require('../store');
const logger = require('../utils/logger')('ai-context');

/**
 * buildFleetContext(messageText, opts)
 * @param {string} messageText - The incoming message to analyze for unit references
 * @param {object} opts - { maxUnits, includeTimeline, includePM, includeRisk }
 * @returns {string} Context block to inject into AI prompt
 */
function buildFleetContext(messageText, opts = {}) {
  const maxUnits       = opts.maxUnits || 10;
  const includeTimeline = opts.includeTimeline !== false;
  const includePM      = opts.includePM !== false;
  const includeRisk    = opts.includeRisk !== false;

  const fd         = store.load('fleetData', {});
  let rows         = fd.rows || [];
  const notesStore = store.load('notesStore', {});
  // Per-operator data scoping (channel/contact): when allowedOperators is set,
  // restrict ALL fleet context to those operators. Empty/undefined = full (unchanged).
  if (Array.isArray(opts.allowedOperators) && opts.allowedOperators.length) {
    var _allowOps = opts.allowedOperators.map(function(o){ return String(o||"").toUpperCase().trim(); }).filter(Boolean);
    if (_allowOps.length) rows = rows.filter(function(r){ return _allowOps.indexOf((r.operator||"").toUpperCase()) !== -1; });
  }

  if (!rows.length) return '\n\n[No fleet data available â€” sync may not have run yet]';

  // â”€â”€ Fleet Summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const unavail  = rows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
  const offsite  = unavail.filter(r => (r.lifecycleReason || '').toLowerCase().includes('offsite'));
  const highRisk = rows.filter(r => (r.riskScore || 0) >= 70);

  let context = '\n\n=== LIVE FLEET DATA ===\n';
  context += 'Total units: ' + rows.length + ' | Unavailable: ' + unavail.length +
    ' | Offsite at vendor: ' + offsite.length + ' | Available: ' + (rows.length - unavail.length) +
    ' | High risk (70+): ' + highRisk.length + '\n';

  // â”€â”€ Resolve what the message is ABOUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // One intelligent resolver understands units, domicile SITES, and OPERATORS
  // (and vendors) by matching against the REAL values in the data â€” whole-token,
  // case-insensitive â€” so short codes like "ABE40" (a site) resolve correctly
  // instead of falling through every brittle regex. See resolveEntities().
  const resolved = resolveEntities(messageText, rows);

  if (resolved.units.length) {
    context += '\n--- UNITS MENTIONED IN THIS MESSAGE ---\n';
    resolved.units.slice(0, maxUnits).forEach(id => {
      context += _buildUnitDetail(id, rows, notesStore, { includeTimeline, includePM, includeRisk });
    });
  }

  // Site / operator focus: if the message named a domicile site or operator,
  // build a focused group report so the AI can actually summarize it.
  resolved.groups.slice(0, 3).forEach(g => {
    context += _buildGroupSummary(g, rows, { includeRisk });
  });

  if (!resolved.units.length && !resolved.groups.length) {
    // Nothing specific referenced â€” include ALL unavailable units with full
    // breakdown details (same fields as a specific-unit query) plus a condensed
    // timeline (last 3 entries) so the AI can give a meaningful summary of each.
    // Even at 70 units this fits within Orcha's context window.
    context += '\n--- ALL UNAVAILABLE UNITS (' + unavail.length + ') ---\n';
    unavail.forEach(r => {
      context += _buildUnitDetail(r.equipmentId, rows, notesStore, {
        includeTimeline: true,
        includePM: true,
        includeRisk: true,
        timelineLines: 3,  // condensed: last 3 entries per unit for general summary
      });
    });
  }

  return context;
}

// â”€â”€ resolveEntities(text, rows) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The single "understand what the user means" resolver. Returns:
//   { units:   [equipmentId, ...],           // exact unit IDs found in the message
//     groups:  [{ kind:'site'|'operator'|'vendor', value, rows:[...] }, ...] }
// Matching is against the ACTUAL distinct values present in the fleet data,
// as whole tokens (word-boundary), case-insensitive, longest-match-first so
// "ABEOW01" wins over "ABEOW" and "ABE40" is matched as its own site. This
// replaces the scattered /\d{5,8}/ + substring+length>2 checks that couldn't
// recognize real short codes.
function resolveEntities(text, rows) {
  const out = { units: [], groups: [] };
  if (!text || !rows || !rows.length) return out;
  const upper = ' ' + text.toUpperCase().replace(/[^A-Z0-9]+/g, ' ') + ' ';
  const tokenRe = (v) => new RegExp('(^| )' + v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)');

  // Distinct real values from the data
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const unitIds = uniq(rows.map(r => (r.equipmentId || '').toUpperCase()));
  const sites   = uniq(rows.map(r => (r.domicileSite || '').toUpperCase()));
  const ops     = uniq(rows.map(r => (r.operator || '').toUpperCase()));
  const vendors = uniq(rows.map(r => (r.vendor || '').toUpperCase()));

  // Longest-first so more specific codes win (ABEOW01 before ABEOW before ABE)
  const byLenDesc = (a, b) => b.length - a.length;

  // Units â€” exact whole-token match
  unitIds.sort(byLenDesc).forEach(id => {
    if (id.length >= 3 && tokenRe(id).test(upper) && !out.units.includes(id)) out.units.push(id);
  });

  // Track which tokens are already claimed by a unit so a site/op inside a unit
  // ID doesn't double-match.
  const claimed = new Set(out.units);

  const addGroup = (kind, value) => {
    if (!value || value.length < 2) return;
    if (claimed.has(value)) return;
    if (tokenRe(value).test(upper)) {
      const groupRows = rows.filter(r =>
        (kind === 'site'     && (r.domicileSite || '').toUpperCase() === value) ||
        (kind === 'operator' && (r.operator     || '').toUpperCase() === value) ||
        (kind === 'vendor'   && (r.vendor       || '').toUpperCase() === value)
      );
      if (groupRows.length && !out.groups.some(g => g.value === value && g.kind === kind)) {
        out.groups.push({ kind, value, rows: groupRows });
        claimed.add(value);
      }
    }
  };

  // Sites first (most common ask), then operators, then vendors â€” longest-first.
  sites.sort(byLenDesc).forEach(s => addGroup('site', s));
  ops.sort(byLenDesc).forEach(o => addGroup('operator', o));
  vendors.sort(byLenDesc).forEach(v => addGroup('vendor', v));

  return out;
}

// Build a focused summary block for a site/operator/vendor group.
function _buildGroupSummary(group, allRows, opts) {
  const kindLabel = group.kind === 'site' ? 'DOMICILE SITE'
                  : group.kind === 'operator' ? 'OPERATOR'
                  : 'VENDOR';
  const gRows   = group.rows;
  const unavail = gRows.filter(r => (r.lifecycleState || '').toLowerCase().includes('unavail'));
  const avail   = gRows.length - unavail.length;
  const uptake  = gRows.length ? Math.round((avail / gRows.length) * 100) : 0;

  let s = '\n--- ' + kindLabel + ': ' + group.value + ' ---\n';
  s += 'Units: ' + gRows.length + ' | Available: ' + avail + ' | Unavailable: ' + unavail.length +
       ' | Uptake: ' + uptake + '%\n';
  if (unavail.length) {
    s += 'Unavailable units:\n';
    unavail.slice(0, 25).forEach(r => {
      const risk = (opts && opts.includeRisk && r.riskScore) ? ' | Risk:' + r.riskScore : '';
      const dur  = r.workDuration ? ' | Down:' + r.workDuration : '';
      s += 'â€¢ ' + r.equipmentId + ' | ' + (r.vendor || 'no vendor') + ' | ' +
        (r.lifecycleReason || r.lifecycleState || '') +
        (r.issueDetails ? ' | ' + r.issueDetails.slice(0, 80) : '') + dur + risk + '\n';
    });
  } else {
    s += '(All units at ' + group.value + ' are currently available.)\n';
  }
  return s;
}

/**
 * buildUnitContext(unitId) â€” Build full context for a single specific unit
 */
function buildUnitContext(unitId) {
  const fd         = store.load('fleetData', {});
  const rows       = fd.rows || [];
  const notesStore = store.load('notesStore', {});
  return _buildUnitDetail(unitId, rows, notesStore, { includeTimeline: true, includePM: true, includeRisk: true });
}

// â”€â”€ Internal helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _extractUnitIds(text, rows) {
  if (!text) return [];
  const upper = text.toUpperCase();
  const found = [];

  // Match known equipment IDs from the actual fleet data
  rows.forEach(r => {
    if (r.equipmentId && upper.includes(r.equipmentId.toUpperCase())) {
      found.push(r.equipmentId);
    }
  });

  // Also match common patterns: B62179, 321950, AMZ1997, etc.
  const patterns = text.match(/\b([A-Z]{0,3}\d{5,8})\b/gi) || [];
  patterns.forEach(p => {
    const id = p.toUpperCase();
    if (!found.includes(id) && rows.some(r => r.equipmentId === id)) {
      found.push(id);
    }
  });

  return [...new Set(found)];
}

function _buildUnitDetail(unitId, rows, notesStore, opts) {
  const row = rows.find(r => r.equipmentId === unitId);
  if (!row) return 'â€¢ ' + unitId + ': NOT FOUND in fleet data\n';

  const ns = notesStore[unitId] || {};
  let detail = '\n[' + unitId + ']\n';
  detail += '  Status: ' + (row.lifecycleState || '?') + ' | Reason: ' + (row.lifecycleReason || '?') + '\n';
  detail += '  Vendor: ' + (row.vendor || 'none') + ' | Make: ' + (row.manufacturer || row.make || '?') + ' | Body: ' + (row.bodyType || row.assetType || '?') + '\n';
  detail += '  Site: ' + (row.domicileSite || '?') + ' | Operator: ' + (row.operator || '?') + '\n';

  if (row.workDuration) detail += '  Days down: ' + row.workDuration + '\n';
  if (row.alternativeId) detail += '  Alt ID (dealer case): ' + row.alternativeId + '\n';
  if (row.offsiteShopEvent) detail += '  Offsite event: ' + row.offsiteShopEvent + '\n';
  if (row.salesforceCase) detail += '  Salesforce case: ' + row.salesforceCase + '\n';
  if (row.dealerName) detail += '  Dealer: ' + row.dealerName + '\n';

  // Predictive maintenance / risk
  if (opts.includeRisk && row.riskScore) {
    detail += '  Uptake Risk Score: ' + row.riskScore + '/100' +
      (row.riskScore >= 70 ? ' (HIGH RISK)' : row.riskScore >= 40 ? ' (MEDIUM)' : ' (LOW)') + '\n';
    if (row.insightsList && row.insightsList.length) {
      detail += '  Predictive insights: ' + row.insightsList.map(i => i.title || i.name || '').filter(Boolean).join(', ') + '\n';
    }
  }

  // PM dates
  if (opts.includePM) {
    const pms = [];
    if (row.pmB && row.pmB !== '--') pms.push('PM-B: ' + row.pmB);
    if (row.pmX && row.pmX !== '--') pms.push('PM-X: ' + row.pmX);
    if (row.dot && row.dot !== '--') pms.push('DOT: ' + row.dot);
    if (pms.length) detail += '  PM schedule: ' + pms.join(' | ') + '\n';
  }

  // Repair notes
  if (ns.notes) detail += '  Notes: ' + ns.notes.slice(0, 300) + '\n';
  if (ns.repairStatus) detail += '  Repair status: ' + ns.repairStatus + '\n';
  if (ns.primaryComponent) detail += '  Primary component: ' + ns.primaryComponent + '\n';

  // Timeline (most recent entries)
  if (opts.includeTimeline && (ns.timeline || row.repairTimeline)) {
    const tl = (ns.timeline || row.repairTimeline || '').trim();
    if (tl) {
      const lines = tl.split('\n').filter(Boolean);
      const count = opts.timelineLines || 8; // default 8, can be reduced for bulk summaries
      const recent = lines.slice(-count);
      detail += '  Recent timeline:\n    ' + recent.join('\n    ') + '\n';
    }
  }

  return detail;
}

/**
 * buildConversationContext(threadMessages)
 * Formats recent thread messages for AI context
 * @param {Array} messages - [{ sender, text, ts }] oldest first
 * @returns {string} Context block
 */
function buildConversationContext(messages) {
  if (!messages || !messages.length) return '';
  const recent = messages.slice(-10); // last 10 messages
  let ctx = '\n\n--- CONVERSATION HISTORY (recent, oldest first) ---\n';
  recent.forEach(m => {
    const time = m.ts ? new Date(parseFloat(m.ts) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
    ctx += (m.sender || 'Unknown') + (time ? ' (' + time + ')' : '') + ': ' + (m.text || '').slice(0, 500) + '\n';
  });
  ctx += '--- END CONVERSATION HISTORY ---\n';
  return ctx;
}

module.exports = { buildFleetContext, buildUnitContext, buildConversationContext, resolveEntities };
