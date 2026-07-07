'use strict';
/**
 * partner-wr.js — Incoming Partner Work Request Pipeline
 * 
 * Flow:
 *   1. Partner submits via Microsoft Forms/Google Sheets
 *   2. App polls for new submissions
 *   3. AI auto-classifies → fills complete WR payload
 *   4. Shows in Review queue for user approval
 *   5. One-click approve → auto-submits via AAP API
 */

const store  = require('../store');
const logger = require('../utils/logger')('partner-wr');
const { handle } = require('./_safe');

const REVIEW_KEY = 'partnerWRs_review';
const SCHEDULED_KEY = 'partnerWRs_scheduled';
const PROCESSED_KEY = 'partnerWRs_processed';

function registerPartnerWRHandlers(ctx) {
  const relay = require('../orcha/relay');

  // Get all pending review WRs
  handle('partner:get-review', async () => {
    return store.load(REVIEW_KEY, []);
  });

  // Get scheduled WRs
  handle('partner:get-scheduled', async () => {
    return store.load(SCHEDULED_KEY, []);
  });

  // Save forms config
  handle('partner:save-forms-config', async (_e, config) => {
    store.save('partnerFormsConfig', config || {});
    logger.info('[Partner] Forms config saved:', JSON.stringify(config));
    return { ok: true };
  });

  // Get forms config
  handle('partner:get-forms-config', async () => {
    return store.load('partnerFormsConfig', {});
  });

  // Poll for new form submissions (Google Sheets CSV)
  handle('partner:poll-forms', async (_e, config) => {
    // Renderer does the fetch — this is called with csvText from renderer
    const csvText = config && config.csvText;
    if (!csvText) return { ok: false, error: 'No CSV data received' };
    
    try {
      const rows = parseCSV(csvText);
      if (rows.length <= 1) return { ok: true, newCount: 0 };

      const processed = store.load('partnerWRs_processed', []);
      const review = store.load('partnerWRs_review', []);
      let newCount = 0;

      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i];
        if (!cols[1]) continue;
        const jobId = 'FORM-' + hashRow(cols[0] + cols[1]);
        if (processed.includes(jobId) || review.some(r => r.id === jobId)) continue;

        const rawRequest = {
          id: jobId,
          unit: (cols[1] || '').toUpperCase().trim(),
          site: (cols[2] || '').toUpperCase().trim(),
          issue: (cols[3] || '').trim(),
          reportedBy: (cols[4] || '').trim(),
          phone: (cols[5] || '').trim(),
          photo: (cols[6] || '').trim(),
          createdAt: cols[0] || new Date().toISOString(),
          status: 'classifying'
        };

        // Add immediately so it shows in inbox
        review.push(rawRequest);
        newCount++;
        logger.info('[Partner] New request: ' + rawRequest.unit + ' — ' + rawRequest.issue);
      }

      if (newCount > 0) {
        store.save('partnerWRs_review', review);
      // Background AI classify
      (async () => {
        const r = store.load('partnerWRs_review', []);
        for (let j = 0; j < r.length; j++) {
          if (r[j].status === 'classifying') {
            try {
              const classified = await classifyRequest(r[j], relay);
              r[j] = classified;
              logger.info('[Partner] AI classified: ' + classified.unit + ' → ' + (classified.aiTitle || ''));
            } catch (e) {
              r[j].status = 'pending';
              r[j].aiError = e.message;
              logger.warn('[Partner] AI classify failed: ' + r[j].unit + ' — ' + e.message);
            }
          }
        }
        store.save('partnerWRs_review', r);
        if (ctx.sendToWindow) ctx.sendToWindow('partner:new-requests', { count: r.length });
      })();

        if (ctx.sendToWindow) ctx.sendToWindow('partner:new-requests', { count: newCount });
      }
      return { ok: true, newCount };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Approve and submit a WR
  handle('partner:approve', async (_e, idx) => {
    const review = store.load(REVIEW_KEY, []);
    const wr = review[idx];
    if (!wr || !wr.payload) return { ok: false, error: 'WR not found or no payload' };

    // Find unit data
    const fd = store.load('fleetData', {});
    const unit = (fd.rows || []).find(r => r.equipmentId === wr.payload.unit);
    if (!unit) return { ok: false, error: 'Unit not found: ' + wr.payload.unit };

    // Submit via AAP API
    const { createWorkRequest } = require('../../src/scrapers/aap_create_wr');
    const result = await createWorkRequest(wr.payload, unit, logger.info.bind(logger));

    if (result && result.ok) {
      // Remove from review, mark processed
      review.splice(idx, 1);
      store.save(REVIEW_KEY, review);
      const processed = store.load(PROCESSED_KEY, []);
      processed.push(wr.id);
      if (processed.length > 500) processed.splice(0, processed.length - 500);
      store.save(PROCESSED_KEY, processed);
      logger.info('[Partner] WR approved and submitted: ' + wr.payload.unit + ' → ' + result.workRequestId);
      return { ok: true, workRequestId: result.workRequestId };
    }
    return { ok: false, error: result.error || 'Submit failed' };
  });

  // Decline a WR
  handle('partner:decline', async (_e, idx) => {
    const review = store.load(REVIEW_KEY, []);
    const wr = review[idx];
    if (!wr) return { ok: false };
    review.splice(idx, 1);
    store.save(REVIEW_KEY, review);
    const processed = store.load(PROCESSED_KEY, []);
    processed.push(wr.id);
    store.save(PROCESSED_KEY, processed);
    logger.info('[Partner] WR declined: ' + (wr.unit || ''));
    return { ok: true };
  });

  // Schedule a WR for later
  handle('partner:schedule', async (_e, data) => {
    const { idx, scheduledFor } = data;
    const review = store.load(REVIEW_KEY, []);
    const wr = review[idx];
    if (!wr) return { ok: false };
    review.splice(idx, 1);
    store.save(REVIEW_KEY, review);
    const scheduled = store.load(SCHEDULED_KEY, []);
    scheduled.push({ ...wr, scheduledFor });
    store.save(SCHEDULED_KEY, scheduled);
    return { ok: true };
  });

  // Submit a scheduled WR now
  handle('partner:submit-scheduled', async (_e, idx) => {
    const scheduled = store.load(SCHEDULED_KEY, []);
    const wr = scheduled[idx];
    if (!wr || !wr.payload) return { ok: false, error: 'Not found' };

    const fd = store.load('fleetData', {});
    const unit = (fd.rows || []).find(r => r.equipmentId === wr.payload.unit);
    if (!unit) return { ok: false, error: 'Unit not found' };

    const { createWorkRequest } = require('../../src/scrapers/aap_create_wr');
    const result = await createWorkRequest(wr.payload, unit, logger.info.bind(logger));
    if (result && result.ok) {
      scheduled.splice(idx, 1);
      store.save(SCHEDULED_KEY, scheduled);
      return { ok: true, workRequestId: result.workRequestId };
    }
    return { ok: false, error: result.error };
  });

  logger.info('Partner WR handlers registered');
}

// AI Classification
async function classifyRequest(req, relay) {
  const store = require('../store');
  const fd = store.load('fleetData', {});
  const AREA_SUBS = require('../data/area-subs.json');
  const unit = (fd.rows || []).find(r => r.equipmentId === req.unit);
  const unitContext = unit ? ` (Make: ${unit.manufacturer || ''}, Site: ${unit.domicileSite || ''}, Lifecycle: ${unit.lifecycleState || ''})` : '';

  // Build area list for prompt
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
- Vendor routing by make: Volvo/Mack → "Volvo (ASIST)", Kenworth → "Kenworth (PACCAR)", Peterbilt → "Peterbilt (PACCAR)", Freightliner → "Freightliner (DAIMLER)", International/Navistar → "AMERIT"
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
  "comments": "what we are requesting from vendor — no history, no names, no dollar amounts",
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
    // Try to find closest match
    const areas = Object.keys(AREA_SUBS);
    const match = areas.find(a => a.toUpperCase() === (ai.area || '').toUpperCase());
    if (match) ai.area = match;
  }
  if (AREA_SUBS[ai.area] && !AREA_SUBS[ai.area].includes(ai.subcategory)) {
    // Try closest subcategory match
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


function parseCSV(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const row = [];
    let inQuote = false, cell = '';
    for (let c = 0; c < lines[i].length; c++) {
      const ch = lines[i][c];
      if (ch === '"') inQuote = !inQuote;
      else if ((ch === ',' || ch === '\t') && !inQuote) { row.push(cell.trim()); cell = ''; }
      else cell += ch;
    }
    row.push(cell.trim());
    if (row.some(x => x.length > 0)) rows.push(row);
  }
  return rows;
}

function hashRow(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).toUpperCase().slice(0, 8);
}

module.exports = { registerPartnerWRHandlers };
