'use strict';
/**
 * orcha_learn.js — Orcha Learning Engine
 * 
 * Tracks every correction/override Z makes. Orcha uses this history to:
 * 1. Improve future suggestions (vendor, component, status)
 * 2. Auto-assign vendors based on learned preferences
 * 3. Never repeat the same mistake twice
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { P } = require('../config/paths');
const logger = require('../utils/logger').createLogger('orcha_learn');

const DATA_DIR = P.dataDir;
const CORRECTIONS_FILE = P.orcaCorrections;
const VENDOR_RULES_FILE = P.orchaVendorRules;

// ── CORRECTIONS STORE ─────────────────────────────────────────────────────
function loadCorrections() {
  try { return JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8')); }
  catch (_) { return { corrections: [], stats: {} }; }
}

function saveCorrections(data) {
  fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(data, null, 2));
}

/**
 * recordCorrection — called whenever Z overrides an Orcha suggestion
 * @param {string} unitId
 * @param {string} field - 'vendor', 'repairStatus', 'primaryComponent', 'notes', etc.
 * @param {string} orchaSuggested - what Orcha recommended
 * @param {string} userChose - what Z picked instead
 * @param {object} context - unit data at time of correction (domicile, issue, etc.)
 */
function recordCorrection(unitId, field, orchaSuggested, userChose, context) {
  const data = loadCorrections();

  const correction = {
    timestamp: new Date().toISOString(),
    unitId,
    field,
    orchaSuggested,
    userChose,
    context: {
      domicile: context.domicile || '',
      vendor: context.vendor || '',
      issue: (context.issue || '').substring(0, 200),
      component: context.component || '',
      make: context.make || '',
    }
  };

  data.corrections.push(correction);

  // Keep last 500 corrections max
  if (data.corrections.length > 500) {
    data.corrections = data.corrections.slice(-500);
  }

  // Update stats: how often each field gets corrected and patterns
  if (!data.stats[field]) data.stats[field] = { total: 0, patterns: {} };
  data.stats[field].total++;

  // Track pattern: "suggested X → user chose Y"
  const patternKey = `${orchaSuggested} → ${userChose}`;
  data.stats[field].patterns[patternKey] = (data.stats[field].patterns[patternKey] || 0) + 1;

  saveCorrections(data);
  logger.info(`[Orcha Learn] Recorded: ${field} "${orchaSuggested}" → "${userChose}" (unit: ${unitId})`);

  // If vendor correction, also update vendor rules
  if (field === 'vendor') {
    learnVendorPreference(orchaSuggested, userChose, context);
  }
}

// ── VENDOR INTELLIGENCE ───────────────────────────────────────────────────
function loadVendorRules() {
  try { return JSON.parse(fs.readFileSync(VENDOR_RULES_FILE, 'utf8')); }
  catch (_) { return { preferences: {}, domicileVendors: {}, componentVendors: {}, performance: {} }; }
}

function saveVendorRules(data) {
  fs.writeFileSync(VENDOR_RULES_FILE, JSON.stringify(data, null, 2));
}

/**
 * learnVendorPreference — updates vendor rules when Z overrides vendor assignment
 */
function learnVendorPreference(rejected, chosen, context) {
  const rules = loadVendorRules();

  // Track by domicile: "at ABE40, Z prefers vendor X"
  if (context.domicile) {
    if (!rules.domicileVendors[context.domicile]) rules.domicileVendors[context.domicile] = {};
    const dv = rules.domicileVendors[context.domicile];
    dv[chosen] = (dv[chosen] || 0) + 2; // +2 for chosen
    if (rejected) dv[rejected] = (dv[rejected] || 0) - 1; // -1 for rejected
  }

  // Track by component: "for EGR issues, Z prefers vendor X"
  if (context.component) {
    if (!rules.componentVendors[context.component]) rules.componentVendors[context.component] = {};
    const cv = rules.componentVendors[context.component];
    cv[chosen] = (cv[chosen] || 0) + 2;
    if (rejected) cv[rejected] = (cv[rejected] || 0) - 1;
  }

  // Track by make: "for Freightliner, Z prefers vendor X"
  if (context.make) {
    if (!rules.preferences[context.make]) rules.preferences[context.make] = {};
    rules.preferences[context.make][chosen] = (rules.preferences[context.make][chosen] || 0) + 1;
  }

  saveVendorRules(rules);
  logger.info(`[Orcha Learn] Vendor rule: ${context.domicile || '?'}/${context.component || '?'} → prefers "${chosen}" over "${rejected}"`);
}

/**
 * suggestVendor — Orcha picks the best vendor based on learned rules
 * @param {object} unit - the unit data
 * @returns {object} { vendor, confidence, reason }
 */
function suggestVendor(unit) {
  const rules = loadVendorRules();
  const scores = {};

  const domicile = unit.domicileSite || unit.domicile || '';
  const component = unit.primaryComponent || unit.savedPrimaryComponent || '';
  const make = unit.make || '';

  // Score by domicile preference
  if (domicile && rules.domicileVendors[domicile]) {
    const dv = rules.domicileVendors[domicile];
    for (const [vendor, score] of Object.entries(dv)) {
      scores[vendor] = (scores[vendor] || 0) + score * 3; // domicile is strongest signal
    }
  }

  // Score by component specialty
  if (component && rules.componentVendors[component]) {
    const cv = rules.componentVendors[component];
    for (const [vendor, score] of Object.entries(cv)) {
      scores[vendor] = (scores[vendor] || 0) + score * 2;
    }
  }

  // Score by make preference
  if (make && rules.preferences[make]) {
    const mv = rules.preferences[make];
    for (const [vendor, score] of Object.entries(mv)) {
      scores[vendor] = (scores[vendor] || 0) + score;
    }
  }

  // Pick top vendor
  const sorted = Object.entries(scores).filter(([_, s]) => s > 0).sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {
    return { vendor: null, confidence: 0, reason: 'No learned preference yet' };
  }

  const [topVendor, topScore] = sorted[0];
  const maxPossible = (domicile ? 6 : 0) + (component ? 4 : 0) + (make ? 2 : 0) || 1;
  const confidence = Math.min(1, topScore / (maxPossible * 2));

  const reasons = [];
  if (domicile && rules.domicileVendors[domicile] && rules.domicileVendors[domicile][topVendor] > 0) {
    reasons.push(`preferred at ${domicile}`);
  }
  if (component && rules.componentVendors[component] && rules.componentVendors[component][topVendor] > 0) {
    reasons.push(`strong on ${component}`);
  }
  if (make && rules.preferences[make] && rules.preferences[make][topVendor] > 0) {
    reasons.push(`good with ${make}`);
  }

  return {
    vendor: topVendor,
    confidence: Math.round(confidence * 100),
    reason: reasons.join(', ') || 'learned from past corrections',
    alternatives: sorted.slice(1, 3).map(([v, s]) => v),
  };
}

/**
 * getCorrectionsContext — returns recent corrections as context for AI prompts
 * Helps Orcha avoid repeating mistakes
 */
function getCorrectionsContext(field, limit) {
  const data = loadCorrections();
  const relevant = data.corrections
    .filter(c => !field || c.field === field)
    .slice(-(limit || 10));

  if (relevant.length === 0) return '';

  return relevant.map(c =>
    `${c.field}: suggested "${c.orchaSuggested}" → Z chose "${c.userChose}" (${c.context.domicile || ''} ${c.context.component || ''})`
  ).join('\n');
}

module.exports = {
  recordCorrection,
  suggestVendor,
  getCorrectionsContext,
  loadCorrections,
  loadVendorRules,
};
