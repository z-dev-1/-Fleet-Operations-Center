'use strict';
/**
 * rca-infer.js — RCA Code Auto-Inference (Sprint 3+)
 *
 * Parses relay text, vendor notes, and issue summaries to auto-suggest
 * RCA (Root Cause Analysis) failure codes.
 *
 * Uses keyword pattern matching against standard fleet failure codes.
 * Returns top 3 suggestions with confidence scores.
 */

const logger = require('../utils/logger')('rca-infer');

// ── RCA Code Database ────────────────────────────────────────────────────────
const RCA_CODES = [
  { code: 'ENG-001', desc: 'Engine mechanical failure', keywords: ['engine','motor','turbo','piston','cylinder','block','crankshaft','camshaft','head gasket','oil leak','coolant','overheating'] },
  { code: 'ENG-002', desc: 'Engine electrical/sensor', keywords: ['ecm','ecu','sensor','check engine','cel','nox','def','dpf','regen','aftertreatment','egr','injector'] },
  { code: 'TRN-001', desc: 'Transmission failure', keywords: ['transmission','trans','clutch','gearbox','shifting','gear','torque converter'] },
  { code: 'TRN-002', desc: 'Driveline/axle', keywords: ['driveshaft','axle','differential','u-joint','yoke','wheel seal','hub'] },
  { code: 'BRK-001', desc: 'Brake system', keywords: ['brake','abs','air dryer','compressor','caliper','drum','rotor','pad','shoe','slack adjuster'] },
  { code: 'ELC-001', desc: 'Electrical system', keywords: ['battery','alternator','starter','wiring','harness','fuse','relay','light','lamp','netradyne','camera'] },
  { code: 'COL-001', desc: 'Collision/body damage', keywords: ['collision','accident','damage','body','dent','mirror','bumper','windshield','fender'] },
  { code: 'TIR-001', desc: 'Tires/wheels', keywords: ['tire','tyre','flat','blowout','wheel','rim','alignment','balance','lug'] },
  { code: 'SUS-001', desc: 'Suspension/steering', keywords: ['suspension','spring','shock','strut','steering','tie rod','ball joint','king pin','bushing'] },
  { code: 'HVC-001', desc: 'HVAC system', keywords: ['ac','air condition','heat','hvac','blower','compressor','freon','refrigerant','thermostat'] },
  { code: 'FUL-001', desc: 'Fuel system', keywords: ['fuel','tank','pump','filter','line','contamination','diesel','gas'] },
  { code: 'EXH-001', desc: 'Exhaust/emissions', keywords: ['exhaust','muffler','catalytic','scr','dpf','def tank','emissions','regen'] },
  { code: 'PMI-001', desc: 'Preventive maintenance', keywords: ['pm','preventive','scheduled','oil change','service','inspection','dot','annual'] },
  { code: 'RCL-001', desc: 'Recall/campaign', keywords: ['recall','campaign','tsb','bulletin','paccar','freightliner','kenworth','peterbilt'] },
  { code: 'TOW-001', desc: 'Tow/roadside', keywords: ['tow','roadside','breakdown','stranded','fleetnet','disabled','won\'t start','no start'] },
  { code: 'RNT-001', desc: 'Rental/loaner', keywords: ['rental','loaner','substitute','replacement','temp'] },
  { code: 'BDY-001', desc: 'Body/cargo system', keywords: ['liftgate','door','roll-up','cargo','box','trailer','dock'] },
  { code: 'OTH-001', desc: 'Other/unclassified', keywords: ['vandal','theft','repo','storage','awaiting','unknown'] },
];

/**
 * inferRCA(text, context)
 * @param {string} text - Combined relay text + notes + issue summary
 * @param {Object} context - { vendor, component, duration }
 * @returns {{ suggestions: Array<{code, desc, confidence, matches}> }}
 */
function inferRCA(text, context = {}) {
  if (!text || text.length < 3) return { suggestions: [] };

  const lower = text.toLowerCase();
  const scores = [];

  for (const rca of RCA_CODES) {
    let matchCount = 0;
    const matches = [];

    for (const kw of rca.keywords) {
      if (lower.includes(kw)) {
        matchCount++;
        matches.push(kw);
      }
    }

    if (matchCount > 0) {
      // Confidence: based on match count relative to keyword pool
      const baseConf = Math.min(95, 40 + (matchCount / rca.keywords.length) * 60 + matchCount * 8);
      scores.push({
        code: rca.code,
        desc: rca.desc,
        confidence: Math.round(baseConf),
        matches,
        matchCount,
      });
    }
  }

  // Sort by confidence descending, return top 3
  scores.sort((a, b) => b.confidence - a.confidence);
  const suggestions = scores.slice(0, 3);

  if (suggestions.length > 0) {
    logger.info(`RCA inferred: ${suggestions[0].code} (${suggestions[0].confidence}%) from "${text.substring(0, 40)}..."`);
  }

  return { suggestions };
}

/**
 * inferRCAForUnit(row) — convenience wrapper for a merged row
 */
function inferRCAForUnit(row) {
  const text = [
    row.lifecycleReason || '',
    row.issueSummary || '',
    row.savedRepairStatus || '',
    row.savedPrimaryComponent || '',
    row.savedNotes || '',
  ].join(' ');

  return inferRCA(text, {
    vendor: row.vendor,
    component: row.savedPrimaryComponent,
    duration: row.duration,
  });
}

module.exports = { inferRCA, inferRCAForUnit, RCA_CODES };
