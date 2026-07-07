'use strict';
/**
 * bedrock.js — Orcha AI via Amazon Bedrock (Claude)
 * Uses the ada-backed 'zilasant-bedrock' AWS profile.
 * Called from main.js via the ai:suggest IPC handler.
 */

const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
const logger = require('../utils/logger').createLogger('bedrock');

// Use ada credential_process profile — rotates automatically with Midway
const client = new BedrockRuntimeClient({
  region: 'us-east-1',
  credentials: fromNodeProviderChain({ profile: 'zilasant-bedrock' }),
});

const MODEL_ID = 'anthropic.claude-3-5-haiku-20241022-v1:0'; // fast + cheap, perfect for classification

/**
 * suggestDropdowns(unit)
 * @param {Object} unit  — { issue, vendor, atsState, model, fuelType, notes, insights }
 * @returns {Object}     — { ok, primaryComponent, repairStatus, confidence, reason }
 */
async function suggestDropdowns(unit) {
  const prompt = `You are a fleet vehicle classification assistant.

Based ONLY on the unit data below, select the single best match for each field.

PRIMARY_COMPONENT options (pick exactly one):
- CAB/CLIMATE CONTROL/INSTRUMENTATION
- CHASSIS
- ELECTRICAL
- ENGINE/MOTOR SYSTEMS
- ACCESSORIES

REPAIR_STATUS options (pick exactly one):
- AMERIT DIAG
- AMERIT PARTS
- AMERIT REPAIRS IN PROGRESS
- ACCIDENT / CEI
- OSR- PENDING BAY
- OSR- PENDING DIAG
- OSR- PENDING EST
- OSR- PENDING PARTS
- OSR- REPAIRS IN PROGRESS
- TA C/A
- TA PENDING PARTS
- TA REPAIRS IN PROGRESS
- GOODYEAR
- PENDING ESTIMATE APPROVAL
- PENDING PARTNER PICKUP
- PENDING PARTNER DROP OFF
- PENDING TOW
- END OF LIFE
- LEGAL HOLD
- KOONER DIAG
- KOONER PARTS
- KOONER REPAIRS IN PROGRESS
- COX DIAG
- COX PARTS
- COX REPAIR IN PROGRESS

Unit data:
  Issue / fault:   ${unit.issue    || '(none)'}
  Vendor:          ${unit.vendor   || '(none)'}
  ATS state:       ${unit.atsState || '(none)'}
  Model:           ${unit.model    || '(none)'}
  Fuel type:       ${unit.fuelType || '(none)'}
  Uptake insights: ${unit.insights || '(none)'}
  Saved notes:     ${unit.notes    || '(none)'}

Rules:
- For REPAIR_STATUS: if vendor name matches a vendor prefix (AMERIT, OSR, TA, GOODYEAR, KOONER, COX), prefer that vendor's statuses. Use the sub-status (DIAG / PARTS / REPAIRS IN PROGRESS / PENDING BAY etc.) based on the issue description.
- For PRIMARY_COMPONENT: infer from the fault/issue text — engine/motor/transmission/oil → ENGINE/MOTOR SYSTEMS; battery/alternator/wiring/lights/electrical → ELECTRICAL; brake/tire/wheel/axle/suspension/frame → CHASSIS; AC/heat/climate/cab/instrument/dash → CAB/CLIMATE CONTROL/INSTRUMENTATION; accessories/camera/lift → ACCESSORIES.
- confidence: "high" if clear signal, "medium" if inferred, "low" if guessing.

Reply ONLY with a single JSON object, no markdown, no explanation:
{"primaryComponent":"...","repairStatus":"...","confidence":"high|medium|low","reason":"one short sentence"}`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 200,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const cmd = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await client.send(cmd);
    const raw = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const text = (raw.content && raw.content[0] && raw.content[0].text) || '';

    // Extract JSON — Claude sometimes adds a tiny preamble
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) {
      logger.warn('[Bedrock] No JSON in response:', text.slice(0, 200));
      return { ok: false, error: 'No JSON in response', raw: text };
    }

    const parsed = JSON.parse(match[0]);
    logger.info('[Bedrock] Suggest result:', parsed);
    return { ok: true, ...parsed };

  } catch (e) {
    logger.error('[Bedrock] suggestDropdowns error:', e.message);
    return { ok: false, error: e.message };
  }
}


/**
 * askBedrock(prompt) - General-purpose AI call via Bedrock Claude
 * Returns plain text response.
 */
async function askBedrock(prompt) {
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const cmd = new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await client.send(cmd);
  const raw = JSON.parse(Buffer.from(response.body).toString('utf-8'));
  return (raw.content && raw.content[0] && raw.content[0].text) || '';
}

module.exports = {
  askBedrock, suggestDropdowns };
