'use strict';
/**
 * bedrock.js — Orcha AI via Amazon Bedrock (Claude)
 * Credentials via Amazon-internal Claude Code toolbox (Cecelia shared account 175342148895).
 * Falls back automatically when Orcha WS/CLI transports exhaust their quota.
 */

const { BedrockRuntimeClient, InvokeModelCommand, ConverseCommand } = require('@aws-sdk/client-bedrock-runtime');
const { execFile } = require('child_process');
const path = require('path');
const os   = require('os');
const logger = require('../utils/logger').createLogger('bedrock');

// Claude Code toolbox binary — vends short-lived Cecelia Bedrock credentials
const CLAUDE_BIN = path.join(os.homedir(), 'AppData', 'Local', 'Toolbox', 'bin', 'claude.exe');
const REGION     = 'us-west-2';
const MODEL_ID   = 'us.anthropic.claude-sonnet-4-20250514-v1:0';

// Cached credentials — refreshed 2 min before expiry
let _cachedCreds = null;
let _cacheExpiry = 0;

function _getCredentials() {
  return new Promise((resolve, reject) => {
    // Return cached creds if still valid (with 2 min buffer)
    if (_cachedCreds && Date.now() < _cacheExpiry - 120000) {
      return resolve(_cachedCreds);
    }
    execFile(CLAUDE_BIN, ['default-credential-export'], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error('Claude credential export failed: ' + err.message));
      try {
        const parsed = JSON.parse(stdout.trim().split('\n').filter(l => l.startsWith('{'))[0] || stdout);
        // Output wraps under "Credentials" key
        const creds = parsed.Credentials || parsed;
        _cachedCreds = {
          accessKeyId:     creds.AccessKeyId,
          secretAccessKey: creds.SecretAccessKey,
          sessionToken:    creds.SessionToken,
          expiration:      creds.Expiration ? new Date(creds.Expiration) : undefined,
        };
        _cacheExpiry = creds.Expiration ? new Date(creds.Expiration).getTime() : Date.now() + 3600000;
        resolve(_cachedCreds);
      } catch (e) {
        reject(new Error('Failed to parse claude credentials: ' + e.message));
      }
    });
  });
}

function _makeClient() {
  return new BedrockRuntimeClient({
    region: REGION,
    credentials: _getCredentials,
  });
}

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



  try {
    const client = _makeClient();
    const cmd = new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 200, temperature: 0 },
    });
    const response = await client.send(cmd);
    const text = (response.output && response.output.message && response.output.message.content &&
                  response.output.message.content[0] && response.output.message.content[0].text) || '';

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
 * askBedrock(prompt) — General-purpose AI call via Bedrock Claude (Cecelia shared account).
 * Uses the Converse API which Cecelia's role permits.
 */
async function askBedrock(prompt) {
  const client = _makeClient();
  const cmd = new ConverseCommand({
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 2048 },
  });
  const response = await client.send(cmd);
  return (response.output && response.output.message && response.output.message.content &&
          response.output.message.content[0] && response.output.message.content[0].text) || '';
}

module.exports = {
  askBedrock, suggestDropdowns };
