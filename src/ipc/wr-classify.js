'use strict';
/**
 * wr-classify.js — AI Work Request classification utility
 *
 * Extracted from partner-wr.js (Phase 6) since the classifyRequest function
 * is used by ai.js's Orcha-chat CREATE_WR action independently of the
 * Partner Portal feature (which was removed).
 */

const store  = require('../store');
const logger = require('../utils/logger')('wr-classify');

/**
 * classifyRequest(req, relay) — Uses AI to classify a work request
 * @param {object} req - { unit, issue, site }
 * @param {object} relay - relay module with .ask() method
 * @returns {object} req with .payload, .aiClassified, .aiArea, etc.
 */
async function classifyRequest(req, relay) {
  const fd = store.load('fleetData', {});
  const AREA_SUBS = require('../data/area-subs.json');
  const unit = (fd.rows || []).find(r => r.equipmentId === req.unit);
  const unitContext = unit ? ` (Make: ${unit.manufacturer || ''}, Site: ${unit.domicileSite || ''}, Lifecycle: ${unit.lifecycleState || ''})` : '';

  const areaList = Object.entries(AREA_SUBS).map(([area, subs]) =>
    area + ': ' + subs.join(', ')
  ).join('\n');

  const prompt = `You are a fleet maintenance work request assistant for Amazon Transportation power units.

A partner reported an issue. Classify and generate a complete WR payload.

Unit: ${req.unit}${unitContext}
Issue reported: ${req.issue}
Site: ${req.site || 'unknown'}
${unit && unit.savedNotes ? 'Current repair notes: ' + unit.savedNotes.substring(0, 500) + '\n' : ''}

CRITICAL RULES:
- "Tow event" or "tow to HY" or "tow home" = TOW. Area=TOW, subcategory=ACCIDENT/RECOVERY or MECHANICAL ISSUE. Vendor=FleetNet (FLEETNET). ALWAYS urgent.
- "Tow to dealer" = TOW to a dealer. Area=TOW, subcategory=MECHANICAL ISSUE. Vendor=FleetNet (FLEETNET). ALWAYS urgent.
- For actual repairs: pick the correct Area based on the failure type.
- Vendor routing by make: Volvo/Mack -> "Volvo (ASIST)", Kenworth -> "Kenworth (PACCAR)", Peterbilt -> "Peterbilt (PACCAR)", Freightliner -> "Freightliner (DAIMLER)", International/Navistar -> "AMERIT"
- If TOW: urgent=true, urgencyReason="DEA - Asset Shortage"
- If safety issue (brakes failed, steering locked, fire): urgent=true

VALID AREAS AND SUBCATEGORIES (use EXACTLY these values):
${areaList}

KNOWN LOCATIONS:
- ABE40 (Home Yard): 800 Schadt Ave, Whitehall, PA 18052
- PHL40 (Home Yard): 200 Enterprise Ave, Secaucus, NJ 07094
- EWR45 (Home Yard): 225 Moonachie Ave, Moonachie, NJ 07074
- AVP40 (Home Yard): 500 Oak St, Pittston, PA 18640

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "title": "professional 5-8 word WR title",
  "issue": "2-3 sentence professional issue description for the work request",
  "area": "EXACT area from list above",
  "subcategory": "EXACT subcategory from list above",
  "vendor": "vendor name per routing rules above, or empty string",
  "urgent": false,
  "urgencyReason": "reason if urgent, else empty string",
  "severity": "HIGH or LOW",
  "comments": "what we are requesting from vendor -- no history, no names, no dollar amounts",
  "towTo": "destination address if TOW, else empty string",
  "towFrom": "pickup address if TOW, else empty string"
}`;

  const result = await relay.ask(prompt);
  if (!result) throw new Error('AI returned empty');

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in AI response');

  const ai = JSON.parse(jsonMatch[0]);

  // Validate area/subcategory against known values
  if (!AREA_SUBS[ai.area]) {
    const areas = Object.keys(AREA_SUBS);
    const match = areas.find(a => a.toUpperCase() === (ai.area || '').toUpperCase());
    if (match) ai.area = match;
  }
  if (AREA_SUBS[ai.area] && !AREA_SUBS[ai.area].includes(ai.subcategory)) {
    const subs = AREA_SUBS[ai.area];
    const match = subs.find(s => s.toUpperCase() === (ai.subcategory || '').toUpperCase());
    if (match) ai.subcategory = match;
  }

  req.aiClassified = true;
  req.status = 'ready';
  req.payload = {
    unit: req.unit,
    title: ai.title || req.issue,
    issue: ai.issue || req.issue,
    domicile: req.site || (unit && unit.domicileSite) || '',
    vendor: ai.vendor || '',
    urgent: ai.urgent ? 'Yes' : 'No',
    urgencyReason: ai.urgent ? (ai.urgencyReason || 'DEA - Asset Shortage') : '',
    comments: ai.comments || '',
    areaPairs: ai.areaPairs || [{ area: ai.area || '', subcategory: ai.subcategory || '' }],
    severity: ai.severity || 'HIGH',
    contactName: '',
    contactPhone: '',
    shareWith: 'Internal Only',
    tow: ai.towTo ? { street: ai.towTo, city: '', state: '', zip: '' } : null,
    towFrom: ai.towFrom ? { street: ai.towFrom, city: '', state: '', zip: '' } : null
  };
  req.aiArea = ai.area;
  req.aiSubcategory = ai.subcategory;
  req.aiVendor = ai.vendor;
  req.aiTitle = ai.title;

  return req;
}

module.exports = { classifyRequest };
