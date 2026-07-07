'use strict';
/**
 * learn.js — Orcha Learning Engine [V-C]
 * V-C changes vs V-B:
 *   - DATA_DIR + hardcoded CORRECTIONS_FILE / VENDOR_RULES_FILE replaced with P.*
 *   - console.log replaced with namespaced logger
 *   - saveCorrections / saveVendorRules use atomic tmp->rename write
 */

const fs     = require('fs');
const path   = require('path');
const { P }  = require('../config/paths');
const logger = require('../utils/logger')('learn');

// ── CORRECTIONS STORE ─────────────────────────────────────────────────────────
function loadCorrections() {
  try { return JSON.parse(fs.readFileSync(P.orcaCorrections, 'utf8')); }
  catch (_) { return { corrections: [], stats: {} }; }
}

function saveCorrections(data) {
  try {
    fs.mkdirSync(path.dirname(P.orcaCorrections), { recursive: true });
    const tmp = P.orcaCorrections + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, P.orcaCorrections);
  } catch (e) { logger.warn('saveCorrections failed: ' + e.message); }
}

/**
 * recordCorrection — called whenever the user overrides an Orcha suggestion
 */
function recordCorrection(unitId, field, orchaSuggested, userChose, unitCtx) {
  const data = loadCorrections();

  const correction = {
    timestamp: new Date().toISOString(),
    unitId, field, orchaSuggested, userChose,
    context: {
      domicile:  unitCtx.domicile  || '',
      vendor:    unitCtx.vendor    || '',
      issue:     (unitCtx.issue    || '').substring(0, 200),
      component: unitCtx.component || '',
      make:      unitCtx.make      || '',
    },
  };

  data.corrections.push(correction);
  if (data.corrections.length > 500) data.corrections = data.corrections.slice(-500);

  if (!data.stats[field]) data.stats[field] = { total: 0, patterns: {} };
  data.stats[field].total++;
  const patternKey = `${orchaSuggested} → ${userChose}`;
  data.stats[field].patterns[patternKey] = (data.stats[field].patterns[patternKey] || 0) + 1;

  saveCorrections(data);
  logger.info(`Recorded: ${field} "${orchaSuggested}" → "${userChose}" (unit: ${unitId})`);

  if (field === 'vendor') learnVendorPreference(orchaSuggested, userChose, unitCtx);
}

// ── VENDOR INTELLIGENCE ───────────────────────────────────────────────────────
function loadVendorRules() {
  try { return JSON.parse(fs.readFileSync(P.orchaVendorRules, 'utf8')); }
  catch (_) { return { preferences: {}, domicileVendors: {}, componentVendors: {}, performance: {} }; }
}

function saveVendorRules(data) {
  try {
    fs.mkdirSync(path.dirname(P.orchaVendorRules), { recursive: true });
    const tmp = P.orchaVendorRules + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, P.orchaVendorRules);
  } catch (e) { logger.warn('saveVendorRules failed: ' + e.message); }
}

function learnVendorPreference(rejected, chosen, unitCtx) {
  const rules = loadVendorRules();

  if (unitCtx.domicile) {
    if (!rules.domicileVendors[unitCtx.domicile]) rules.domicileVendors[unitCtx.domicile] = {};
    const dv = rules.domicileVendors[unitCtx.domicile];
    dv[chosen]   = (dv[chosen]   || 0) + 2;
    if (rejected) dv[rejected] = (dv[rejected] || 0) - 1;
  }

  if (unitCtx.component) {
    if (!rules.componentVendors[unitCtx.component]) rules.componentVendors[unitCtx.component] = {};
    const cv = rules.componentVendors[unitCtx.component];
    cv[chosen]   = (cv[chosen]   || 0) + 2;
    if (rejected) cv[rejected] = (cv[rejected] || 0) - 1;
  }

  if (unitCtx.make) {
    if (!rules.preferences[unitCtx.make]) rules.preferences[unitCtx.make] = {};
    rules.preferences[unitCtx.make][chosen] = (rules.preferences[unitCtx.make][chosen] || 0) + 1;
  }

  saveVendorRules(rules);
  logger.info(`Vendor rule: ${unitCtx.domicile || '?'}/${unitCtx.component || '?'} → prefers "${chosen}" over "${rejected}"`);
}

/**
 * suggestVendor — picks the best vendor based on learned rules
 */
function suggestVendor(unit) {
  const rules  = loadVendorRules();
  const scores = {};

  const domicile  = unit.domicileSite || unit.domicile || '';
  const component = unit.primaryComponent || unit.savedPrimaryComponent || '';
  const make      = unit.make || '';

  if (domicile && rules.domicileVendors[domicile]) {
    for (const [vendor, score] of Object.entries(rules.domicileVendors[domicile]))
      scores[vendor] = (scores[vendor] || 0) + score * 3;
  }
  if (component && rules.componentVendors[component]) {
    for (const [vendor, score] of Object.entries(rules.componentVendors[component]))
      scores[vendor] = (scores[vendor] || 0) + score * 2;
  }
  if (make && rules.preferences[make]) {
    for (const [vendor, score] of Object.entries(rules.preferences[make]))
      scores[vendor] = (scores[vendor] || 0) + score;
  }

  const sorted = Object.entries(scores).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return { vendor: null, confidence: 0, reason: 'No learned preference yet' };

  const [topVendor, topScore] = sorted[0];
  const maxPossible = (domicile ? 6 : 0) + (component ? 4 : 0) + (make ? 2 : 0) || 1;
  const confidence  = Math.min(1, topScore / (maxPossible * 2));
  const reasons     = [];
  if (domicile  && rules.domicileVendors[domicile]?.[topVendor]   > 0) reasons.push(`preferred at ${domicile}`);
  if (component && rules.componentVendors[component]?.[topVendor] > 0) reasons.push(`strong on ${component}`);
  if (make      && rules.preferences[make]?.[topVendor]           > 0) reasons.push(`good with ${make}`);

  return {
    vendor:       topVendor,
    confidence:   Math.round(confidence * 100),
    reason:       reasons.join(', ') || 'learned from past corrections',
    alternatives: sorted.slice(1, 3).map(([v]) => v),
  };
}

/**
 * getCorrectionsContext — recent corrections as context string for AI prompts
 */
function getCorrectionsContext(field, limit) {
  const data     = loadCorrections();
  const relevant = data.corrections
    .filter(c => !field || c.field === field)
    .slice(-(limit || 10));
  if (relevant.length === 0) return '';
  return relevant.map(c =>
    `${c.field}: suggested "${c.orchaSuggested}" → chose "${c.userChose}" (${c.context.domicile || ''} ${c.context.component || ''})`
  ).join('\n');
}

module.exports = { recordCorrection, suggestVendor, getCorrectionsContext, loadCorrections, loadVendorRules };
