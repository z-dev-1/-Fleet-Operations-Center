// tests/fas-agent-coverage-compliance-wiring.test.js
//
// Task #12: prove the agent is actually WIRED to use coverage + compliance —
// the DOT/scope hard rules are in the system prompt, and the assembled prompt
// the AI receives includes Zila's coverage (for an internal sender) plus the
// new research tools in its allowed tool list.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tmpDir = path.join(os.tmpdir(), 'fas-wire-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });
const { setDataDir } = require('../src/config/paths');
setDataDir(tmpDir);

const store = require('../src/store');
const agent = require('../src/orcha/fas/agent');
const relay = require('../src/orcha/relay');
const coverage = require('../src/orcha/fas/coverage');

function seedInternal() {
  store.save('fleetData', { syncedAt: new Date().toISOString(), rows: [
    { equipmentId: '320160', operator: 'TUZR', domicileSite: 'ABE40', lifecycleState: 'Active' },
    { equipmentId: '39461', operator: 'YTSC', domicileSite: 'AVP40', lifecycleState: 'Active' },
  ] });
  store.save('contacts', [{ type: 'slack', slackId: 'U_INT', name: 'Zila', identityType: 'internal', enabled: true }]);
  store.save('slackSenderProfiles', {});
  store.save('fasCases', {});
  store.save('fasConfig', { enabled: true, mode: 'autonomous', maxSteps: 1, retry: { inLoopRetries: 0 } });
  coverage.refresh({ reason: 'test' });
}
function seedCarrier() {
  seedInternal();
  store.save('contacts', [{ type: 'slack', slackId: 'U_CAR', name: 'Carrier', identityType: 'carrier', operators: ['TUZR'], enabled: true }]);
}
beforeEach(() => { seedInternal(); });
afterEach(() => { vi.restoreAllMocks(); try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {} fs.mkdirSync(tmpDir, { recursive: true }); });

describe('SAFETY_RULES include power-unit scope + evidence-gated DOT rules', () => {
  it('states power-unit-only scope and routing of unsupported assets', () => {
    expect(agent.SAFETY_RULES).toMatch(/power units/i);
    expect(agent.SAFETY_RULES).toMatch(/trailers|hostlers|intermodal/i);
    expect(agent.SAFETY_RULES).toMatch(/route/i);
  });
  it('requires GET_COMPLIANCE_REQUIREMENT and forbids fabricated compliance conclusions', () => {
    expect(agent.SAFETY_RULES).toMatch(/GET_COMPLIANCE_REQUIREMENT/);
    expect(agent.SAFETY_RULES).toMatch(/never declare a unit safe, compliant,.*out of service/i);
    expect(agent.SAFETY_RULES).toMatch(/insufficient-evidence/);
  });
  it('mentions coverage awareness + GET_COVERAGE', () => {
    expect(agent.SAFETY_RULES).toMatch(/coverage/i);
    expect(agent.SAFETY_RULES).toMatch(/GET_COVERAGE/);
  });
});

describe('assembled prompt wiring (what the AI actually receives)', () => {
  it('includes Zila coverage (operators + domiciles) for an INTERNAL sender', async () => {
    let seenPrompt = '';
    vi.spyOn(relay, 'ask').mockImplementation(async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: 'ok' });
    });
    await agent.runAgent({ slackId: 'U_INT', senderName: 'Zila', text: 'any update on 320160?', conversation: [] });
    expect(seenPrompt).toMatch(/ZILA COVERAGE/);
    expect(seenPrompt).toMatch(/TUZR/);
    expect(seenPrompt).toMatch(/YTSC/);
    expect(seenPrompt).toMatch(/ABE40/);
    // The new research tools are offered in the allowed tool list.
    expect(seenPrompt).toMatch(/GET_COMPLIANCE_REQUIREMENT/);
    expect(seenPrompt).toMatch(/GET_COVERAGE/);
  });

  it('does NOT leak the full carrier roster to a CARRIER sender', async () => {
    seedCarrier();
    let seenPrompt = '';
    vi.spyOn(relay, 'ask').mockImplementation(async (prompt) => {
      seenPrompt = prompt;
      return JSON.stringify({ decision: 'answer', confidence: 0.9, reason: 'ok', research: [], actions: [], reply: 'ok' });
    });
    await agent.runAgent({ slackId: 'U_CAR', senderName: 'Carrier', text: 'update on 320160?', conversation: [] });
    // The coverage section must not enumerate OTHER carriers (YTSC) to a carrier.
    // (The COVERAGE block is internal-only; a carrier sees their own scope via
    // AUTHORIZATION, not the full roster.)
    const covBlock = (seenPrompt.split('ZILA COVERAGE')[1] || '').split('INCOMING MESSAGE')[0] || '';
    expect(covBlock).not.toMatch(/YTSC/);
  });
});
